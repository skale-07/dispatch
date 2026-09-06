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
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { setEmployerApplicationUrl } from "../../src/pipeline/runPipeline.js";
import { registerResumeMaterial } from "../../src/jobright/materialsRegister.js";
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { armSession, getArmStatus, hashArmToken } from "../../src/automation/armSession.js";
import { runAutomationSession } from "../../src/automation/worker.js";
import { applySafeFillEnv, applyControlledFillEnv, useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const GREENHOUSE_FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "dom.sanitized.html",
);
const SYNTHETIC_PDF = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "ats",
  "greenhouse",
  "sample-resume.pdf",
);

describe("L3 automation worker (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;
  const noSleep = async (): Promise<void> => undefined;

  function seedQueuedApp(withResume = true, withEmployerUrl = true): string {
    const jobNo = Math.floor(Math.random() * 1_000_000);
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: `Acme${jobNo}`,
      role: "SWE",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(`UPDATE applications SET state = 'QUEUED' WHERE id = ?`).run(app.id);
    if (withEmployerUrl) {
      setEmployerApplicationUrl(db, app.id, `https://boards.greenhouse.io/acme/jobs/${jobNo}`);
    }
    if (withResume) {
      registerResumeMaterial({ db, applicationId: app.id, filePath: SYNTHETIC_PDF });
    }
    return app.id;
  }

  function arm(maxSubmits: number, maxApps: number): string {
    return armSession(db, {
      maxSubmits,
      maxApps,
      durationMinutes: 60,
      discoverMax: 0,
      armedByTokenHash: hashArmToken("t"),
    }).arm_run_id!;
  }

  beforeEach(() => {
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-worker-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    applySafeFillEnv();
    delete process.env.DATABASE_PATH;
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    resetConfigCache();
  });

  it(
    "processes the queue, parks a blocked app, stops when drained",
    async () => {
      // Safe env (DRY_RUN) so each app stops cleanly at the fill gate — the
      // worker's selection/park behavior is what's under test, not a real
      // submit. One app carries a review item and must be skipped entirely.
      const a1 = seedQueuedApp();
      const blocked = seedQueuedApp();
      upsertOpenReviewItem(db, {
        applicationId: blocked,
        kind: "MANUAL",
        title: "operator hold",
      });
      const armId = arm(5, 25);

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.stopped_reason).toBe("queue_drained");
      // Only the unblocked app was processed; the held one was never touched.
      expect(report.per_app.map((r) => r.application_id)).toEqual([a1]);
      expect(getApplication(db, a1)?.state).toBe("NATIVE_AUTOFILL_RUNNING");
      expect(getApplication(db, blocked)?.state).toBe("QUEUED");
    },
    60_000,
  );

  it(
    "post-session triage: a duplicate_url park gets one validated decision and an acted requeue",
    async () => {
      applyControlledFillEnv({
        NAVIGATION_ENABLED: "true",
        TRIAGE_LLM_ENABLED: "true",
        TRIAGE_ACT_ENABLED: "true",
      });
      // No employer URL ⇒ the pipeline routes to navigation, whose stub
      // returns a duplicate_url wall ⇒ FAILED_RETRYABLE — a triageable
      // end state for the post-session batch.
      const appId = seedQueuedApp(true, false);
      let llmCalls = 0;
      const report = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        navigationRunner: async (nav) => ({
          run_id: `nav-${randomUUID()}`,
          application_id: nav.applicationId,
          jobright_job_id: null,
          method: null,
          resolved_url: null,
          resolved_ats: null,
          wall: "duplicate_url" as const,
          phase_trace: [],
          agent: null,
          gmail: null,
          need: null,
          session: "ephemeral" as const,
          notes: [],
          congruence: null,
          duplicates: [
            { application_id: "11111111-aaaa", state: "QUEUED", company: "Acme", role: "SWE" },
          ],
          login_wall: null,
        }),
        triageClient: {
          generateJson: async () => {
            llmCalls += 1;
            return {
              text: JSON.stringify({
                action: "requeue_same",
                rationale: "dup evidence weak — one rerun",
                confidence: "medium",
              }),
              model: "stub",
            };
          },
        },
      });
      expect(llmCalls).toBe(1);
      expect(report.triage).toEqual({ decided: 1, executed: 1 });
      expect(getApplication(db, appId)?.state).toBe("QUEUED");
      const row = db
        .prepare(
          "SELECT action, mode, executed FROM triage_decisions WHERE application_id = ?",
        )
        .get(appId) as { action: string; mode: string; executed: number };
      expect(row).toEqual({ action: "requeue_same", mode: "act", executed: 1 });
    },
    60_000,
  );

  it(
    "requeues nav-starved apps ONLY when the agent leg is up",
    async () => {
      // An app parked by an agent-less session: FAILED_RETRYABLE with the
      // budget-nav reason and no review item — invisible to selection.
      const starved = seedQueuedApp();
      const { transitionApplication } = await import(
        "../../src/queue/stateMachine.js"
      );
      transitionApplication(db, {
        applicationId: starved,
        nextState: "FAILED_RETRYABLE",
        reason: "navigation unresolved (budget)",
      });

      // Agent leg DOWN: the app stays parked and the queue drains.
      const down = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        agentLegProbe: async () => false,
      });
      expect(down.per_app).toEqual([]);
      expect(getApplication(db, starved)?.state).toBe("FAILED_RETRYABLE");
      const { disarmSession } = await import("../../src/automation/armSession.js");
      disarmSession(db);

      // Agent leg UP: one requeue, and the session actually processes it.
      const up = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        agentLegProbe: async () => true,
        // Hermetic: without this stub the preflight performs a REAL CDP
        // attach (night20 — the test failed whenever the live debug Chrome
        // was wedged/absent; unit tests must not touch live endpoints).
        cdpAttachProbe: async () => true,
      });
      expect(up.notes.join(" ")).toMatch(/nav requeue: 1 navigation-starved/);
      expect(up.per_app.map((r) => r.application_id)).toEqual([starved]);
    },
    60_000,
  );

  it(
    "respects max_apps: stops with apps_cap after the cap",
    async () => {
      seedQueuedApp();
      seedQueuedApp();
      seedQueuedApp();
      const armId = arm(5, 2); // cap 2 apps

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.stopped_reason).toBe("apps_cap");
      expect(report.apps_started).toBe(2);
      expect(getArmStatus(db).apps_started).toBe(2);
    },
    60_000,
  );

  it(
    "excludes apps flagged automation_excluded in versions_json",
    async () => {
      const keep = seedQueuedApp();
      const skip = seedQueuedApp();
      db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
        JSON.stringify({ automation_excluded: true }),
        skip,
      );
      const armId = arm(5, 25);

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });

      expect(report.per_app.map((r) => r.application_id)).toEqual([keep]);
      expect(getApplication(db, skip)?.state).toBe("QUEUED");
    },
    60_000,
  );

  it(
    "stops as expired when the arm window closes; a disarmed row stops as disarmed",
    async () => {
      seedQueuedApp();
      // Arm, then force the row's armed_until into the past.
      const armId = arm(5, 25);
      const meta = JSON.parse(
        (db.prepare(`SELECT metadata_json AS m FROM automation_runs WHERE id = ?`).get(armId) as {
          m: string;
        }).m,
      ) as Record<string, unknown>;
      meta["armed_until"] = new Date(Date.now() - 1000).toISOString();
      db.prepare(`UPDATE automation_runs SET metadata_json = ? WHERE id = ?`).run(
        JSON.stringify(meta),
        armId,
      );

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
      });
      // First loop check sees the expired row → no app processed.
      expect(report.stopped_reason).toBe("expired");
      expect(report.apps_started).toBe(0);
    },
    60_000,
  );

  it(
    "runs discovery at start via the injected discoveryRunner",
    async () => {
      let discovered = 0;
      const armId = armSession(db, {
        maxSubmits: 5,
        maxApps: 25,
        durationMinutes: 60,
        discoverMax: 10,
        armedByTokenHash: hashArmToken("t"),
      }).arm_run_id!;

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        discoverMax: 10,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        // Discovery enqueues one app on the first call, nothing after.
        discoveryRunner: async () => {
          discovered += 1;
          const id = discovered === 1 ? seedQueuedApp() : null;
          return { jobs_inspected: id ? 1 : 0, applications: id ? [{ application_id: id, eligible: true, dedupe_kind: "CREATED" }] : [] };
        },
      });

      expect(discovered).toBeGreaterThanOrEqual(1);
      expect(report.discover_runs).toBeGreaterThanOrEqual(1);
      // The discovered app was processed.
      expect(report.apps_started).toBe(1);
    },
    60_000,
  );

  it(
    "a discovery failure (empty feed / auth) is a note, not a crash",
    async () => {
      seedQueuedApp();
      const armId = armSession(db, {
        maxSubmits: 5,
        maxApps: 25,
        durationMinutes: 60,
        discoverMax: 10,
        armedByTokenHash: hashArmToken("t"),
      }).arm_run_id!;

      const report = await runAutomationSession({
        db,
        armRunId: armId,
        discoverMax: 10,
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        discoveryRunner: async () => {
          throw new Error("EMPTY_FEED: nothing on the feed");
        },
      });

      // Fresh discovery never falls through to historical queued work.
      expect(report.apps_started).toBe(0);
      expect(report.stopped_reason).toBe("no_fresh_candidate");
      expect(report.notes.some((n) => /empty_feed/.test(n))).toBe(true);
    },
    60_000,
  );

  it("finishes Gmail for the submitted application before the next discovery (UNIT_CONFIRMED)", async () => {
    const events: string[] = [];
    let id = "";
    let discoveries = 0;
    await runAutomationSession({ db, armRunId: arm(5, 2), discoverMax: 1, fixtureHtmlPath: GREENHOUSE_FIXTURE, sleep: noSleep,
      discoveryRunner: async () => {
        events.push("discover");
        if (++discoveries > 1) return { jobs_inspected: 0, applications: [] };
        id = seedQueuedApp();
        return {
          jobs_inspected: 1,
          applications: [{ application_id: id, eligible: true, dedupe_kind: "CREATED" }],
        };
      },
      pipelineRunner: async input => {
        expect(input.applicationId).toBe(id);
        events.push("application");
        db.prepare("INSERT INTO submissions (id, application_id, submission_attempt_number, status, submitted, receipt_json) VALUES (?, ?, 1, 'VERIFIED', 1, '{}')").run(randomUUID(), id);
        return { run_id: "fixture", applications: [{ application_id: id, start_state: "QUEUED", end_state: "COMPLETED", steps: [], stopped: null, stop_reason: null }] };
      },
      gmailRunner: async input => {
        expect(input.applicationId).toBe(id);
        events.push("gmail");
        return { input: id, application_id: id, ok: true, state: "COMPLETED", people_checked: 0, emails_found: 0, generated: 0, drafted: 0, notes: [], error: null };
      },
    });
    expect(events).toEqual(["discover", "application", "gmail", "discover"]);
  }, 30000);

  it(
    "preflight: a wedged CDP attach is repaired BEFORE the first app (night19 #55)",
    async () => {
      seedQueuedApp();
      let restarts = 0;
      const report = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        agentLegProbe: async () => true,
        cdpAttachProbe: async () => false,
        cdpRestarter: async () => {
          restarts += 1;
          return { reachable: true, notes: [] };
        },
      });
      expect(restarts).toBe(1);
      expect(report.notes.join(" ")).toMatch(/preflight: CDP attach failed — debug Chrome restarted/);
      // The queued app still ran normally after the repair.
      expect(report.apps_started).toBe(1);
    },
    60_000,
  );

  const CDP_WALL =
    "Debug Chrome at http://127.0.0.1:9222 is unresponsive (port answers but the CDP session won't attach). Close ALL Chrome windows, re-run chrome:debug:jobright, and retry.";

  it(
    "stops as cdp_unrecoverable when a CDP restart does not recover — the rest of the queue is left alone",
    async () => {
      const first = seedQueuedApp(true, false);
      const second = seedQueuedApp(true, false);
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      let restarts = 0;
      try {
        const report = await runAutomationSession({
          db,
          armRunId: arm(5, 25),
          fixtureHtmlPath: GREENHOUSE_FIXTURE,
          sleep: noSleep,
          navigationRunner: async () => {
            throw new Error(CDP_WALL);
          },
          cdpRestarter: async () => {
            restarts += 1;
            return { reachable: false, notes: ["did not terminate"] };
          },
        });
        expect(report.stopped_reason).toBe("cdp_unrecoverable");
        expect(restarts).toBe(1);
        expect(report.apps_started).toBe(1);
        expect(report.per_app.map((r) => r.application_id)).toEqual([]);
        expect(report.notes.join(" ")).toMatch(/debug Chrome unrecoverable after 1\/3/);
        // Nothing burned: the touched app stays in its pre-nav state (no
        // FAILED_* / attempt cap), the other was never picked. Newest
        // first (operator directive 2026-09-06): `second` is touched.
        expect(getApplication(db, second)?.state).toBe("APPLICATION_OPENING");
        expect(getApplication(db, second)?.attempt).toBe(1);
        expect(getApplication(db, first)?.state).toBe("QUEUED");
      } finally {
        applySafeFillEnv();
      }
    },
    60_000,
  );

  it(
    "appDeadlineMs stops a job at its next step boundary and names the stop `deadline`",
    async () => {
      const slow = seedQueuedApp();
      const next = seedQueuedApp();
      const report = await runAutomationSession({
        db,
        armRunId: arm(5, 25),
        fixtureHtmlPath: GREENHOUSE_FIXTURE,
        sleep: noSleep,
        appDeadlineMs: 1, // already elapsed by the first boundary check
      });
      // The deadline-stopped job is reported with a named reason, keeps a
      // non-terminal state, and the session moves on to the next job.
      const stopped = report.per_app.find((r) => r.application_id === slow);
      expect(stopped?.stopped).toBe("skipped");
      expect(stopped?.stop_reason).toMatch(/^deadline: \d+s elapsed of 0s budget/);
      expect(report.notes.join(" ")).toMatch(new RegExp(`deadline ${slow}: `));
      expect(getApplication(db, slow)?.state).not.toMatch(/^FAILED/);
      // Newest-first pick order (operator directive 2026-09-06).
      expect(report.per_app.map((r) => r.application_id).sort()).toEqual(
        [slow, next].sort(),
      );
      expect(report.stopped_reason).toBe("queue_drained");
    },
    60_000,
  );

  it(
    "stops as cdp_unrecoverable once the restart budget is spent and the wall recurs",
    async () => {
      for (let i = 0; i < 6; i++) seedQueuedApp(true, false);
      applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
      let restarts = 0;
      try {
        const report = await runAutomationSession({
          db,
          armRunId: arm(5, 25),
          fixtureHtmlPath: GREENHOUSE_FIXTURE,
          sleep: noSleep,
          navigationRunner: async () => {
            throw new Error(CDP_WALL);
          },
          // Every restart "recovers" (night18's lie) but the wall comes back.
          cdpRestarter: async () => {
            restarts += 1;
            return { reachable: true, notes: [] };
          },
        });
        expect(restarts).toBe(3);
        // 3 restarts + the 4th failure that exhausts the budget = 4 apps touched, not 6.
        expect(report.apps_started).toBe(4);
        expect(report.stopped_reason).toBe("cdp_unrecoverable");
      } finally {
        applySafeFillEnv();
      }
    },
    60_000,
  );

  it(
    "retries APPLICATION_OPENING apps frozen on an employer sign-in wall when portal creds are set",
    async () => {
      const held = seedQueuedApp();
      upsertOpenReviewItem(db, {
        applicationId: held,
        kind: "MANUAL",
        title: "operator hold",
      });
      const authWall = seedQueuedApp();
      db.prepare(`UPDATE applications SET state = 'APPLICATION_OPENING' WHERE id = ?`).run(
        authWall,
      );
      upsertOpenReviewItem(db, {
        applicationId: authWall,
        kind: "MANUAL",
        title: "Navigation blocked by employer identity wall",
      });

      applyControlledFillEnv({
        PORTAL_LOGIN_EMAIL: "candidate@example.com",
        PORTAL_LOGIN_PASSWORD: "standing-secret",
      });
      try {
        const report = await runAutomationSession({
          db,
          armRunId: arm(5, 25),
          fixtureHtmlPath: GREENHOUSE_FIXTURE,
          sleep: noSleep,
        });
        expect(report.per_app.map((r) => r.application_id)).toEqual([authWall]);
        expect(getApplication(db, held)?.state).toBe("QUEUED");
      } finally {
        applySafeFillEnv();
      }
    },
    60_000,
  );
});
