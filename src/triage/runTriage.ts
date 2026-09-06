import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { redactObject } from "../logging/redaction.js";
import { writeJsonAtomic } from "../storage/atomicJson.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import { buildEvidenceBundle } from "./evidenceBundle.js";
import { isHostScopedSignature } from "./failureSignature.js";
import {
  ACT_ENABLED_ACTIONS,
  TERMINAL_SAFE_ACTIONS,
  TRIAGE_ACTIONS,
  canExecute,
  executeAction,
  type TriageAction,
} from "./actions.js";
import { chooseTriageAction } from "./triageLlm.js";

/**
 * One triage pass over one failed application: signature → dedup/budget
 * gates → evidence bundle → LLM choice → deterministic validation →
 * decision row + artifact → (act mode) execution via existing primitives.
 *
 * Fail-open by design: a triage error is a note on the batch, never a
 * dead session. Fail-closed by flags: TRIAGE_LLM_ENABLED gates deciding,
 * TRIAGE_ACT_ENABLED gates executing (inert without the first).
 */

export const MAX_TRIAGE_ACTS_PER_APP = 3;

export type TriageAppResult = {
  application_id: string;
  decision_id: string | null;
  signature: string | null;
  action: TriageAction | null;
  executed: boolean;
  note: string;
};

function computeForbiddenActions(
  db: Db,
  applicationId: string,
  signature: string,
): TriageAction[] {
  const hostScoped = isHostScopedSignature(signature);
  const rows = (
    hostScoped
      ? db
          .prepare(
            `SELECT DISTINCT action, outcome_status FROM triage_decisions
             WHERE failure_signature = ?`,
          )
          .all(signature)
      : db
          .prepare(
            `SELECT DISTINCT action, outcome_status FROM triage_decisions
             WHERE failure_signature = ? AND application_id = ?`,
          )
          .all(signature, applicationId)
  ) as Array<{ action: string; outcome_status: string }>;

  const forbidden = new Set<TriageAction>();
  for (const row of rows) {
    const action = row.action as TriageAction;
    if (!(TRIAGE_ACTIONS as readonly string[]).includes(action)) continue;
    // Any previously-chosen action for this signature is forbidden on
    // recurrence (retry-differently); REFUTED pairs stay forbidden forever
    // by the same rule. Terminal-safe actions are always allowed so the
    // model always has a legal move — recurrence converges to park/abandon.
    if (TERMINAL_SAFE_ACTIONS.has(action)) continue;
    forbidden.add(action);
  }
  return [...forbidden];
}

function executedActCount(db: Db, applicationId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM triage_decisions
       WHERE application_id = ? AND executed = 1`,
    )
    .get(applicationId) as { n: number };
  return row.n;
}

function hasPendingDecision(
  db: Db,
  applicationId: string,
  signature: string,
): boolean {
  // Only an EXECUTED pending decision is an open loop worth waiting on.
  // A precondition/validation-refused decision changed nothing — blocking
  // re-triage on it gagged the layer for gate-park signatures whose
  // refails write no application_event (night25 #176: the Rivian
  // UNKNOWN_LANDING app re-ground three cycles with a PENDING
  // non-executed decision the sweep could never resolve). The forbidden
  // history already excludes the previously chosen action either way.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM triage_decisions
       WHERE application_id = ? AND failure_signature = ?
         AND outcome_status = 'PENDING' AND executed = 1`,
    )
    .get(applicationId, signature) as { n: number };
  return row.n > 0;
}

export async function runTriageForApplication(
  db: Db,
  applicationId: string,
  options: {
    client?: EmailLlmClient | undefined;
    act?: boolean | undefined;
    armRunId?: string | null | undefined;
    stopReason?: string | null | undefined;
  } = {},
): Promise<TriageAppResult> {
  const cfg = getConfig();
  const base: TriageAppResult = {
    application_id: applicationId,
    decision_id: null,
    signature: null,
    action: null,
    executed: false,
    note: "",
  };
  if (!cfg.triageLlmEnabled) {
    return { ...base, note: "TRIAGE_LLM_ENABLED is off" };
  }
  const client = options.client ?? (hasLlmKey(cfg) ? makeLlmClient("applier") : null);
  if (!client) {
    return { ...base, note: "no LLM key configured" };
  }

  const bundle = buildEvidenceBundle(db, applicationId, {
    stopReason: options.stopReason ?? null,
  });
  if (!bundle) return { ...base, note: "unknown application" };
  const signature = bundle.failure_signature;

  if (hasPendingDecision(db, applicationId, signature)) {
    return { ...base, signature, note: "pending decision exists for this signature" };
  }

  const forbidden = computeForbiddenActions(db, applicationId, signature);
  const actsUsed = executedActCount(db, applicationId);
  if (actsUsed >= MAX_TRIAGE_ACTS_PER_APP) {
    // Budget spent: only terminal-safe moves remain choosable.
    for (const a of TRIAGE_ACTIONS) {
      if (!TERMINAL_SAFE_ACTIONS.has(a) && !forbidden.includes(a)) forbidden.push(a);
    }
  }

  const choice = await chooseTriageAction(client, bundle, forbidden);

  // Deterministic precondition gate — a choice that cannot execute is
  // recorded as-is but demoted to non-executed with the reason.
  const precondition = canExecute(db, applicationId, choice.action, {
    hasDuplicateEvidence:
      Array.isArray(bundle.nav?.duplicates) && bundle.nav.duplicates.length > 0,
    failedHostAttempts: bundle.failed_host_attempts,
    priorAgentLegDecision: bundle.prior_agent_leg_decision,
    navWall: bundle.nav?.wall ?? null,
  });

  const actAllowed =
    options.act === true &&
    cfg.triageActEnabled &&
    ACT_ENABLED_ACTIONS.has(choice.action);
  const willExecute =
    precondition.ok && actAllowed && choice.validation_note === null;

  const decisionId = randomUUID();
  const mode = actAllowed ? "act" : "shadow";
  const artifactRel = path.join("triage", decisionId, "decision.json");

  db.prepare(
    `INSERT INTO triage_decisions
       (id, created_at, application_id, arm_run_id, failure_signature,
        evidence_relpath, action, forbidden_actions_json, rationale,
        confidence, mode, llm_model, executed, execution_result_json,
        outcome_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'PENDING')`,
  ).run(
    decisionId,
    new Date().toISOString(),
    applicationId,
    options.armRunId ?? null,
    signature,
    artifactRel,
    choice.action,
    JSON.stringify(forbidden),
    choice.rationale,
    choice.confidence,
    mode,
    choice.model,
  );

  let executionDetail: string | null = null;
  let executed = false;
  if (willExecute) {
    try {
      const result = executeAction(db, applicationId, choice.action, {
        decisionId,
        rationale: choice.rationale,
        signature,
      });
      executed = result.executed;
      executionDetail = result.detail;
    } catch (err) {
      executionDetail = `executor threw: ${
        err instanceof Error ? err.message.slice(0, 300) : "unknown"
      }`;
    }
    db.prepare(
      `UPDATE triage_decisions SET executed = ?, execution_result_json = ?
       WHERE id = ?`,
    ).run(executed ? 1 : 0, JSON.stringify({ detail: executionDetail }), decisionId);
  } else {
    const why = !precondition.ok
      ? `precondition failed: ${precondition.reason}`
      : choice.validation_note
        ? `validation: ${choice.validation_note}`
        : !actAllowed
          ? "shadow mode (act not enabled for this action)"
          : "not executed";
    executionDetail = why;
    db.prepare(
      `UPDATE triage_decisions SET execution_result_json = ? WHERE id = ?`,
    ).run(JSON.stringify({ detail: why }), decisionId);
  }

  try {
    writeJsonAtomic(
      path.join(getConfig().artifactsDir, artifactRel),
      redactObject({
        decision_id: decisionId,
        application_id: applicationId,
        signature,
        forbidden_actions: forbidden,
        bundle,
        raw_model_text: choice.raw_text,
        parsed_action: choice.action,
        validation_note: choice.validation_note,
        precondition,
        mode,
        executed,
        execution_detail: executionDetail,
        rationale_unverified: choice.rationale,
      }),
    );
  } catch {
    // artifact write failure is a note, never a failed decision
  }

  logger.info("triage decision", {
    service: "triage",
    action: "decision",
    application_id: applicationId,
    metadata: {
      decision_id: decisionId,
      signature,
      chosen: choice.action,
      mode,
      executed,
      detail: executionDetail,
    },
  });

  return {
    application_id: applicationId,
    decision_id: decisionId,
    signature,
    action: choice.action,
    executed,
    note: executionDetail ?? "",
  };
}

export async function runTriageBatch(input: {
  db: Db;
  applicationIds: string[];
  client?: EmailLlmClient;
  act?: boolean;
  armRunId?: string | null;
  stopReasons?: Map<string, string | null>;
}): Promise<{ results: TriageAppResult[]; notes: string[] }> {
  const notes: string[] = [];
  const results: TriageAppResult[] = [];
  const cfg = getConfig();
  if (!cfg.triageLlmEnabled) {
    notes.push("triage skipped: TRIAGE_LLM_ENABLED off");
    return { results, notes };
  }
  for (const appId of input.applicationIds) {
    try {
      const result = await runTriageForApplication(input.db, appId, {
        client: input.client,
        act: input.act,
        armRunId: input.armRunId ?? null,
        stopReason: input.stopReasons?.get(appId) ?? null,
      });
      results.push(result);
    } catch (err) {
      notes.push(
        `triage failed for ${appId.slice(0, 8)}: ${
          err instanceof Error ? err.message.slice(0, 200) : "unknown"
        }`,
      );
    }
  }
  return { results, notes };
}
