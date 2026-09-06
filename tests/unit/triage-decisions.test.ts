import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  createApplication,
  transitionApplication,
  getApplication,
} from "../../src/queue/stateMachine.js";
import { resetConfigCache } from "../../src/config/index.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import {
  buildFailureSignature,
  classifyReason,
  isHostScopedSignature,
} from "../../src/triage/failureSignature.js";
import { parseTriageResponse } from "../../src/triage/triageLlm.js";
import {
  TRIAGE_ACTIONS,
  canExecute,
  executeAction,
} from "../../src/triage/actions.js";
import {
  runTriageForApplication,
  MAX_TRIAGE_ACTS_PER_APP,
} from "../../src/triage/runTriage.js";
import { verifyTriageOutcomes } from "../../src/triage/verifyOutcomes.js";

/**
 * The LLM decision layer's safety story, pinned on night25's real
 * failures: the model only ever picks from the enumerated action set,
 * forbidden actions (retry-differently) are enforced deterministically,
 * caps hold, and outcome verdicts come only from the read-back sweep.
 * UNIT_CONFIRMED.
 */

const stub = (payload: unknown): EmailLlmClient => ({
  generateJson: async () => ({ text: JSON.stringify(payload), model: "stub" }),
});

describe("failure signatures (UNIT_CONFIRMED)", () => {
  it("classifies night25's real stop reasons into the right buckets", () => {
    expect(classifyReason("navigation refused: duplicate employer URL")).toBe(
      "duplicate_url",
    );
    expect(classifyReason("posting closed on JobRight")).toBe("closed");
    expect(
      classifyReason(
        "submission not verified: FAILED_BEFORE_CLICK — Page failed identity gate (UNTRUSTED_FINAL_HOST): navigation ended on an untrusted host",
      ),
    ).toBe("login_wall");
    expect(
      classifyReason("no verified resume material and no default resume to auto-attach"),
    ).toBe("config_stale");
    expect(
      classifyReason(
        "Refusing to click submit: field verification or upload did not pass",
      ),
    ).toBe("verify_mismatch");
    expect(classifyReason(null)).toBe("unknown");
  });

  it("builds a stable signature and host-scopes wall classes", () => {
    const sig = buildFailureSignature({
      endState: "FAILED_RETRYABLE",
      wall: null,
      stopReason: "navigation ended on an untrusted host: https://jobs.bytedance.com/en/login",
      host: "jobs.bytedance.com",
    });
    expect(sig).toBe("FAILED_RETRYABLE|-|login_wall|jobs.bytedance.com");
    expect(isHostScopedSignature(sig)).toBe(true);
    expect(
      isHostScopedSignature("FAILED_RETRYABLE|-|duplicate_url|x.example.com"),
    ).toBe(false);
  });
});

describe("triage response validation (UNIT_CONFIRMED)", () => {
  it("rejects malformed JSON, unknown actions, and forbidden actions to no_action", () => {
    expect(parseTriageResponse("not json at all", "m", []).action).toBe("no_action");
    expect(
      parseTriageResponse(JSON.stringify({ action: "reboot_the_host" }), "m", [])
        .action,
    ).toBe("no_action");
    const forbidden = parseTriageResponse(
      JSON.stringify({ action: "requeue_same", rationale: "again" }),
      "m",
      ["requeue_same"],
    );
    expect(forbidden.action).toBe("no_action");
    expect(forbidden.validation_note).toMatch(/forbidden/);
  });

  it("accepts a valid enumerated choice verbatim and clamps rationale", () => {
    const ok = parseTriageResponse(
      JSON.stringify({
        action: "requeue_reopen_navigation",
        rationale: "x".repeat(1000),
        confidence: "high",
      }),
      "m",
      [],
    );
    expect(ok.action).toBe("requeue_reopen_navigation");
    expect(ok.validation_note).toBeNull();
    expect(ok.rationale.length).toBeLessThanOrEqual(400);
  });
});

describe("triage decisions end-to-end (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let artDir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "DATABASE_PATH",
    "ARTIFACTS_DIR",
    "TRIAGE_LLM_ENABLED",
    "TRIAGE_ACT_ENABLED",
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-triage-${randomUUID()}.sqlite`);
    artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-triage-art-"));
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artDir;
    process.env.TRIAGE_LLM_ENABLED = "true";
    process.env.TRIAGE_ACT_ENABLED = "true";
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const seedFailedApp = (company = "ByteDance"): string => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().slice(0, 12)}`,
      company,
      role: "Intern",
    });
    const appId = createApplication(db, { jobId: job.id }).id;
    for (const [nextState, reason] of [
      ["DUPLICATE_CHECK", "dedupe"],
      ["ELIGIBILITY_CHECK", "eligibility"],
      ["QUEUED", "queued"],
      ["MATERIALS_GENERATING", "materials stage entered"],
      [
        "FAILED_RETRYABLE",
        "submission not verified: navigation ended on an untrusted host: https://jobs.example.com/login",
      ],
    ] as const) {
      transitionApplication(db, { applicationId: appId, nextState, reason });
    }
    return appId;
  };

  it("flags off ⇒ no LLM call, no decision rows", async () => {
    process.env.TRIAGE_LLM_ENABLED = "false";
    resetConfigCache();
    const appId = seedFailedApp();
    let called = 0;
    const client: EmailLlmClient = {
      generateJson: async () => {
        called += 1;
        return { text: "{}", model: "stub" };
      },
    };
    const result = await runTriageForApplication(db, appId, { client, act: true });
    expect(result.note).toMatch(/TRIAGE_LLM_ENABLED/);
    expect(called).toBe(0);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM triage_decisions").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it("acts on a valid requeue_same choice and records the decision + artifact", async () => {
    const appId = seedFailedApp();
    const result = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_same", rationale: "transient", confidence: "medium" }),
      act: true,
    });
    expect(result.action).toBe("requeue_same");
    expect(result.executed).toBe(true);
    expect(getApplication(db, appId)?.state).toBe("QUEUED");
    const artifact = path.join(artDir, "triage", result.decision_id!, "decision.json");
    expect(fs.existsSync(artifact)).toBe(true);
  });

  it("ByteDance repeat-wall: the same signature forbids the previous action (retry-differently)", async () => {
    const appId = seedFailedApp();
    const first = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_same", rationale: "try again" }),
      act: true,
    });
    expect(first.executed).toBe(true);

    // The retry hits the identical wall: same end state, same reason class.
    transitionApplication(db, {
      applicationId: appId,
      nextState: "MATERIALS_GENERATING",
      reason: "materials stage entered",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "FAILED_RETRYABLE",
      reason:
        "submission not verified: navigation ended on an untrusted host: https://jobs.example.com/login",
    });
    // Read-back sweep marks the first decision REFUTED before the next pass.
    const sweep = verifyTriageOutcomes(db);
    expect(sweep.refuted).toBe(1);

    // A stub that stubbornly repeats the forbidden action gets demoted.
    const second = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_same", rationale: "again!" }),
      act: true,
    });
    expect(second.action).toBe("no_action");
    expect(second.note).toMatch(/forbidden|validation/);
    expect(getApplication(db, appId)?.state).toBe("FAILED_RETRYABLE");
  });

  it("executed-acts cap: beyond MAX_TRIAGE_ACTS_PER_APP only terminal-safe actions remain", async () => {
    const appId = seedFailedApp();
    for (let i = 0; i < MAX_TRIAGE_ACTS_PER_APP; i++) {
      db.prepare(
        `INSERT INTO triage_decisions
           (id, created_at, application_id, failure_signature, action,
            mode, executed, outcome_status)
         VALUES (?, ?, ?, ?, ?, 'act', 1, 'EXPIRED')`,
      ).run(
        randomUUID(),
        new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        appId,
        `FAILED_RETRYABLE|-|budget|host-${i}`,
        "requeue_same",
      );
    }
    const result = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_materials", rationale: "one more" }),
      act: true,
    });
    expect(result.action).toBe("no_action");
    expect(getApplication(db, appId)?.state).toBe("FAILED_RETRYABLE");
  });

  it("abandon-class stays shadow at launch: valid choice recorded but NOT executed", async () => {
    const appId = seedFailedApp();
    // Give the app duplicate evidence via a nav attempt + report on disk.
    const navRunId = `nav-${randomUUID()}`;
    db.prepare(
      `INSERT INTO navigation_attempts
         (id, created_at, run_id, application_id, session_kind, wall, resolved, end_host)
       VALUES (?, ?, ?, ?, 'cdp', 'duplicate_url', 0, 'sjobs.brassring.com')`,
    ).run(randomUUID(), new Date().toISOString(), navRunId, appId);
    const reportDir = path.join(artDir, "navigation", navRunId);
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "report.json"),
      JSON.stringify({
        wall: "duplicate_url",
        notes: [],
        duplicates: [{ application_id: "other", company: "X", role: "Y", state: "QUEUED" }],
      }),
    );
    const result = await runTriageForApplication(db, appId, {
      client: stub({ action: "abandon_duplicate", rationale: "same posting twice" }),
      act: true,
    });
    expect(result.action).toBe("abandon_duplicate");
    expect(result.executed).toBe(false);
    expect(result.note).toMatch(/shadow/);
    expect(getApplication(db, appId)?.state).toBe("FAILED_RETRYABLE");
  });

  it("preconditions gate executors: requeue on a non-FAILED_RETRYABLE app records but does not act", async () => {
    const appId = seedFailedApp();
    transitionApplication(db, {
      applicationId: appId,
      nextState: "QUEUED",
      reason: "operator requeued",
    });
    const result = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_same", rationale: "go" }),
      act: true,
    });
    expect(result.executed).toBe(false);
    expect(result.note).toMatch(/precondition/);
  });

  it("verifyOutcomes CONFIRMs an executed decision whose app later reaches a better state", async () => {
    const appId = seedFailedApp();
    const result = await runTriageForApplication(db, appId, {
      client: stub({ action: "requeue_same", rationale: "transient" }),
      act: true,
    });
    expect(result.executed).toBe(true);
    // Simulate the rerun succeeding all the way to READY_TO_SUBMIT.
    transitionApplication(db, {
      applicationId: appId,
      nextState: "MATERIALS_GENERATING",
      reason: "materials stage entered",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "RESUME_DOWNLOADED",
      reason: "verified resume material found",
    });
    const sweep = verifyTriageOutcomes(db);
    expect(sweep.checked).toBe(1);
    // RESUME_DOWNLOADED is not a confirm state yet — still pending.
    expect(sweep.confirmed + sweep.refuted + sweep.expired).toBe(0);
    transitionApplication(db, {
      applicationId: appId,
      nextState: "APPLICATION_OPENING",
      reason: "opening employer application",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "ATS_DETECTION",
      reason: "url validated",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "APPLICATION_INSPECTION",
      reason: "inspection",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "NATIVE_AUTOFILL_RUNNING",
      reason: "fill",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "FIELD_VERIFICATION",
      reason: "verify",
    });
    transitionApplication(db, {
      applicationId: appId,
      nextState: "READY_TO_SUBMIT",
      reason: "verified",
    });
    const sweep2 = verifyTriageOutcomes(db);
    expect(sweep2.confirmed).toBe(1);
  });

  it("canExecute exposes every enumerated action without throwing", () => {
    const appId = seedFailedApp();
    for (const action of TRIAGE_ACTIONS) {
      const verdict = canExecute(db, appId, action, {});
      expect(typeof verdict.ok).toBe("boolean");
    }
  });

  it("engage_agent_leg requires a nav wall in evidence (Barclays cycle-13 lesson)", () => {
    const appId = seedFailedApp();
    // Submit-stage failure (no nav wall) ⇒ the action cannot execute.
    const withoutWall = canExecute(db, appId, "engage_agent_leg", {
      navWall: null,
    });
    expect(withoutWall.ok).toBe(false);
    expect(withoutWall.reason).toMatch(/navigation wall/);
    const resolvedWall = canExecute(db, appId, "engage_agent_leg", {
      navWall: "none",
    });
    expect(resolvedWall.ok).toBe(false);
    // A real nav wall ⇒ preconditions pass (state + attempt budget hold).
    const withWall = canExecute(db, appId, "engage_agent_leg", {
      navWall: "budget",
    });
    expect(withWall.ok).toBe(true);
  });

  it("engage_agent_leg override is one-shot: consumed once, refused after", async () => {
    const { consumeAgentLegOverride } = await import(
      "../../src/triage/agentLegOverride.js"
    );
    const appId = seedFailedApp();
    // No decision yet ⇒ no override.
    expect(consumeAgentLegOverride(db, appId)).toBe(false);
    db.prepare(
      `INSERT INTO triage_decisions
         (id, created_at, application_id, failure_signature, action,
          mode, executed, execution_result_json, outcome_status)
       VALUES (?, ?, ?, 'FAILED_RETRYABLE|-|budget|h', 'engage_agent_leg',
               'act', 1, '{"detail":"requeued"}', 'PENDING')`,
    ).run(randomUUID(), new Date().toISOString(), appId);
    expect(consumeAgentLegOverride(db, appId)).toBe(true);
    expect(consumeAgentLegOverride(db, appId)).toBe(false);
  });

  it("park_for_operator opens exactly one MANUAL review item", () => {
    const appId = seedFailedApp();
    const first = executeAction(db, appId, "park_for_operator", {
      decisionId: randomUUID(),
      rationale: "needs a human",
      signature: "FAILED_RETRYABLE|-|unknown|-",
    });
    expect(first.executed).toBe(true);
    const second = executeAction(db, appId, "park_for_operator", {
      decisionId: randomUUID(),
      rationale: "needs a human",
      signature: "FAILED_RETRYABLE|-|unknown|-",
    });
    expect(second.detail).toMatch(/already open/);
  });
});
