import type { Db } from "../storage/db/client.js";
import { canTransition } from "../queue/states.js";
import {
  getApplication,
  transitionApplication,
} from "../queue/stateMachine.js";
import { retryFailedApplications } from "../pipeline/runPipeline.js";
import { upsertOpenReviewItem, listOpenReviewItems } from "../queue/reviewItems.js";
import { abandonApplication } from "../queue/reviewResolvers.js";
import { clearEmployerApplicationUrl } from "../applications/employerUrl.js";

/**
 * The ONLY actions triage can take. The LLM picks one verbatim; set
 * membership, forbidden-action history, and the per-action preconditions
 * below are all re-checked deterministically before any executor runs.
 *
 * Deliberately absent (operator doctrine, night25):
 * - anything on UNCERTAIN_SUBMISSION / SUBMISSION_VERIFICATION_FAILED —
 *   confirming a submission requires a human-verified receipt;
 * - reopening AUTH/CAPTCHA walls (requeueAfterWall means "the operator
 *   cleared the wall"; the ByteDance blind-retry is the counterexample);
 * - free-form URL supply — an LLM-minted URL is not an enumerated choice.
 */
export const TRIAGE_ACTIONS = [
  "no_action",
  "park_for_operator",
  "requeue_same",
  "requeue_materials",
  "requeue_reopen_navigation",
  "abandon_duplicate",
  "abandon_permanent_wall",
  "engage_agent_leg",
] as const;

export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

/** Actions that never make a same-signature loop worse — always legal. */
export const TERMINAL_SAFE_ACTIONS: ReadonlySet<TriageAction> = new Set([
  "no_action",
  "park_for_operator",
  "abandon_duplicate",
  "abandon_permanent_wall",
]);

/**
 * Requeue-class actions acted from day one (operator decision 2026-09-05).
 * Abandon-class promoted 2026-09-06 (M4 completion): the read-back sweep
 * ran clean across five live sessions and its first resolved verdict
 * (REFUTED, decision 841134a7) was correct post-#174. The executors keep
 * their own hard guards: duplicate evidence / ≥3 failed host attempts,
 * and abandonApplication's canTransition check is always the last word.
 */
export const ACT_ENABLED_ACTIONS: ReadonlySet<TriageAction> = new Set([
  "no_action",
  "park_for_operator",
  "requeue_same",
  "requeue_materials",
  "requeue_reopen_navigation",
  "abandon_duplicate",
  "abandon_permanent_wall",
  "engage_agent_leg",
]);

/** Mirrors runPipeline's MAX_ATTEMPTS — triage never overrides the cap. */
export const TRIAGE_RETRY_MAX_ATTEMPTS = 3;

export type PreconditionResult = { ok: boolean; reason: string };

function requireState(
  db: Db,
  applicationId: string,
  wanted: string,
): PreconditionResult {
  const app = getApplication(db, applicationId);
  if (!app) return { ok: false, reason: "unknown application" };
  if (app.state !== wanted) {
    return { ok: false, reason: `state is ${app.state}, needs ${wanted}` };
  }
  return { ok: true, reason: "" };
}

/**
 * Gate-stop parks leave apps in these mid-states with no transition (#175,
 * night25 window 3): invisible to `retry` and — before this — to triage.
 * Both have a legal edge to FAILED_RETRYABLE, so a requeue-class executor
 * may DEMOTE first (through the state machine) and then requeue. The set
 * is explicit — QUEUED etc. also have the edge but demoting them would be
 * a wasteful no-op, and the tight set keeps requeue semantics honest.
 */
const DEMOTABLE_GATE_PARK_STATES = new Set([
  "NATIVE_AUTOFILL_RUNNING",
  "READY_TO_SUBMIT",
]);

function requireRequeueableState(
  db: Db,
  applicationId: string,
): PreconditionResult {
  const app = getApplication(db, applicationId);
  if (!app) return { ok: false, reason: "unknown application" };
  if (app.state === "FAILED_RETRYABLE") return { ok: true, reason: "" };
  if (
    DEMOTABLE_GATE_PARK_STATES.has(app.state) &&
    canTransition(app.state as never, "FAILED_RETRYABLE" as never)
  ) {
    return { ok: true, reason: "" };
  }
  return {
    ok: false,
    reason: `state is ${app.state}, needs FAILED_RETRYABLE or a gate-parked mid-state`,
  };
}

/** Demote a gate-parked mid-state to FAILED_RETRYABLE (legal edge) so the
 * ordinary requeue primitives apply. No-op when already there. */
function demoteGateParkIfNeeded(
  db: Db,
  applicationId: string,
  signature: string,
): void {
  const app = getApplication(db, applicationId);
  if (!app || app.state === "FAILED_RETRYABLE") return;
  transitionApplication(db, {
    applicationId,
    nextState: "FAILED_RETRYABLE",
    reason: `triage: demoting gate-parked ${app.state} for requeue (${signature})`,
  });
}

function requireAttemptBudget(db: Db, applicationId: string): PreconditionResult {
  const app = getApplication(db, applicationId);
  if (!app) return { ok: false, reason: "unknown application" };
  const attempt = Number(app.attempt ?? 1);
  if (attempt >= TRIAGE_RETRY_MAX_ATTEMPTS) {
    return {
      ok: false,
      reason: `attempt ${attempt}/${TRIAGE_RETRY_MAX_ATTEMPTS} — retry cap reached`,
    };
  }
  return { ok: true, reason: "" };
}

function openItemForApp(
  db: Db,
  applicationId: string,
  titlePattern: RegExp,
): { id: string } | null {
  const items = listOpenReviewItems(db).filter(
    (i) =>
      (i as { application_id?: string | null }).application_id === applicationId &&
      titlePattern.test((i as { title: string }).title),
  );
  return items.length > 0 ? { id: (items[0] as { id: string }).id } : null;
}

const DUP_ITEM_TITLE = /duplicate posting/i;
const WALL_ITEM_TITLE = /identity wall|captcha|auth/i;

/**
 * Deterministic gate per action. `evidence` carries the bits the executor
 * cannot re-derive from the DB (duplicates list, wall host history).
 */
export function canExecute(
  db: Db,
  applicationId: string,
  action: TriageAction,
  evidence: {
    hasDuplicateEvidence?: boolean;
    failedHostAttempts?: number;
    priorAgentLegDecision?: boolean;
    /** Latest nav attempt's wall ("none" = resolved). */
    navWall?: string | null;
  } = {},
): PreconditionResult {
  switch (action) {
    case "no_action":
    case "park_for_operator":
      return { ok: true, reason: "" };
    case "requeue_same": {
      const state = requireRequeueableState(db, applicationId);
      if (!state.ok) return state;
      return requireAttemptBudget(db, applicationId);
    }
    case "requeue_materials": {
      const state = requireRequeueableState(db, applicationId);
      if (!state.ok) return state;
      if (!canTransition("FAILED_RETRYABLE" as never, "MATERIALS_GENERATING" as never)) {
        return { ok: false, reason: "no FAILED_RETRYABLE→MATERIALS_GENERATING edge" };
      }
      return requireAttemptBudget(db, applicationId);
    }
    case "requeue_reopen_navigation": {
      const state = requireRequeueableState(db, applicationId);
      if (!state.ok) return state;
      if (!canTransition("FAILED_RETRYABLE" as never, "APPLICATION_OPENING" as never)) {
        return { ok: false, reason: "no FAILED_RETRYABLE→APPLICATION_OPENING edge" };
      }
      return requireAttemptBudget(db, applicationId);
    }
    case "abandon_duplicate": {
      if (!evidence.hasDuplicateEvidence) {
        return { ok: false, reason: "no duplicate evidence in the bundle" };
      }
      const app = getApplication(db, applicationId);
      if (!app) return { ok: false, reason: "unknown application" };
      if (!canTransition(app.state as never, "FAILED_FINAL" as never)) {
        return { ok: false, reason: `no FAILED_FINAL edge from ${app.state}` };
      }
      return { ok: true, reason: "" };
    }
    case "abandon_permanent_wall": {
      if ((evidence.failedHostAttempts ?? 0) < 3) {
        return {
          ok: false,
          reason: `only ${evidence.failedHostAttempts ?? 0} failed host attempts (needs ≥3)`,
        };
      }
      const app = getApplication(db, applicationId);
      if (!app) return { ok: false, reason: "unknown application" };
      if (!canTransition(app.state as never, "FAILED_FINAL" as never)) {
        return { ok: false, reason: `no FAILED_FINAL edge from ${app.state}` };
      }
      return { ok: true, reason: "" };
    }
    case "engage_agent_leg": {
      if (evidence.priorAgentLegDecision) {
        return { ok: false, reason: "agent leg already engaged once for this app" };
      }
      // Live lesson (night25 cycle 13, Barclays): the override is consumed
      // at navigation's hostPolicy gate — an app whose stored URL is fine
      // never re-navigates, so granting it for a submit-stage failure just
      // burns a requeue. The action requires a NAV wall in evidence.
      if (!evidence.navWall || evidence.navWall === "none") {
        return {
          ok: false,
          reason: "no navigation wall in evidence — agent leg only helps nav-walled apps",
        };
      }
      const state = requireState(db, applicationId, "FAILED_RETRYABLE");
      if (!state.ok) return state;
      return requireAttemptBudget(db, applicationId);
    }
  }
}

export type ExecutionResult = {
  executed: boolean;
  detail: string;
};

/**
 * Executors only ever call existing legal primitives; illegal transitions
 * still throw inside the state machine (assertTransition is the backstop
 * if the app moved between evidence-read and execution).
 */
export function executeAction(
  db: Db,
  applicationId: string,
  action: TriageAction,
  context: { decisionId: string; rationale: string; signature: string },
): ExecutionResult {
  switch (action) {
    case "no_action":
      return { executed: true, detail: "recorded only" };
    case "park_for_operator": {
      const { item, created } = upsertOpenReviewItem(db, {
        applicationId,
        kind: "MANUAL",
        title: `Triage: operator decision needed (${context.signature})`,
        payload: {
          source: "triage_llm",
          triage_decision_id: context.decisionId,
          rationale_unverified: context.rationale,
        },
      });
      return {
        executed: true,
        detail: `review item ${created ? "created" : "already open"}: ${item.id}`,
      };
    }
    case "requeue_same": {
      demoteGateParkIfNeeded(db, applicationId, context.signature);
      const results = retryFailedApplications(db, { applicationId });
      const first = results[0];
      return {
        executed: first !== undefined,
        detail: first
          ? `${first.action} at attempt ${first.attempt}`
          : "retry helper made no change",
      };
    }
    case "requeue_materials": {
      demoteGateParkIfNeeded(db, applicationId, context.signature);
      const app = getApplication(db, applicationId);
      transitionApplication(db, {
        applicationId,
        nextState: "MATERIALS_GENERATING",
        reason: `triage: regenerate materials (${context.signature})`,
        attempt: Number(app?.attempt ?? 1) + 1,
      });
      return { executed: true, detail: "→ MATERIALS_GENERATING" };
    }
    case "requeue_reopen_navigation": {
      // Same recipe as auditEmployerUrls' reroute for FAILED_RETRYABLE:
      // clear the (suspect) stored URL, re-enter at navigation depth.
      demoteGateParkIfNeeded(db, applicationId, context.signature);
      clearEmployerApplicationUrl(db, applicationId);
      const app = getApplication(db, applicationId);
      transitionApplication(db, {
        applicationId,
        nextState: "APPLICATION_OPENING",
        reason: `triage: cleared employer URL, re-resolving (${context.signature})`,
        attempt: Number(app?.attempt ?? 1) + 1,
      });
      return { executed: true, detail: "URL cleared, → APPLICATION_OPENING" };
    }
    case "abandon_duplicate":
    case "abandon_permanent_wall": {
      const pattern = action === "abandon_duplicate" ? DUP_ITEM_TITLE : WALL_ITEM_TITLE;
      let item = openItemForApp(db, applicationId, pattern);
      if (!item) {
        item = upsertOpenReviewItem(db, {
          applicationId,
          kind: "MANUAL",
          title:
            action === "abandon_duplicate"
              ? "Duplicate posting — triage abandon"
              : "Permanent wall — triage abandon",
          payload: { source: "triage_llm", triage_decision_id: context.decisionId },
        }).item;
      }
      const result = abandonApplication(db, {
        reviewItemId: item.id,
        note: `triage ${action}: ${context.rationale}`.slice(0, 400),
      });
      const skipped = (result as { transition_skipped?: string | null })
        .transition_skipped;
      return {
        executed: !skipped,
        detail: skipped ?? "abandoned to FAILED_FINAL",
      };
    }
    case "engage_agent_leg": {
      // The decision row itself is the one-shot marker; runNavigation
      // consumes it as a hostPolicy override (wired in milestone M4).
      const results = retryFailedApplications(db, { applicationId });
      return {
        executed: results.length > 0,
        detail:
          results.length > 0
            ? `requeued with agent-leg override marker (decision ${context.decisionId})`
            : "retry helper made no change",
      };
    }
  }
}
