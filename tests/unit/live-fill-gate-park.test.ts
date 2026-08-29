import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import {
  createApplication,
  getApplication,
} from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  runPipeline,
  setEmployerApplicationUrl,
} from "../../src/pipeline/runPipeline.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * Regression for session 1b93205e: 6 applications whose live fill was
 * refused at the binding gate (FORM_NOT_REACHED / FORM_NOT_FOUND /
 * NO_APPLICATION_FORM / UNKNOWN_LANDING) ended the session still in
 * NATIVE_AUTOFILL_RUNNING — the worker re-picks running states, so a
 * deterministic refusal looped instead of parking. A refused gate must
 * park FAILED_RETRYABLE with the refusal as the reason. (Flag gates —
 * FORM_FILL_ENABLED off / DRY_RUN — still leave the state untouched;
 * pipeline-run.test.ts pins that.)
 */

vi.mock("../../src/applications/atsLiveFill.js", () => ({
  runAtsLiveFill: async () => ({
    ats: "lever",
    url: "https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000",
    requested_url:
      "https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000",
    mode: "executed",
    gate: {
      ok: false,
      failure_code: "FORM_NOT_REACHED",
      reason: "posting page: no application form after advance",
      final_url: null,
    },
    plan_summary: {
      fillable_count: 0,
      skipped_count: 0,
      review_required_count: 0,
    },
    plan_fields: [],
    fill: null,
    verify: null,
    uploads: [],
    validation_level: "LIVE_READ_ONLY_CONFIRMED",
    submit_attempted: false,
    notes: [],
  }),
}));

describe("live fill gate refusal parks the application (was: stuck running)", () => {
  let dbPath: string;
  let artifactsDir: string;
  let db: Db;

  beforeEach(() => {
    applySafeFillEnv();
    dbPath = path.join(os.tmpdir(), `jaa-gatepark-${randomUUID()}.sqlite`);
    artifactsDir = path.join(os.tmpdir(), `jaa-gatepark-art-${randomUUID()}`);
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artifactsDir;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    applySafeFillEnv();
    resetConfigCache();
    closeDatabase(db);
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("NATIVE_AUTOFILL_RUNNING + live gate refusal → FAILED_RETRYABLE, stop gate (UNIT_CONFIRMED)", async () => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      company: "Acme",
      role: "SWE Intern",
    });
    const app = createApplication(db, { jobId: job.id });
    db.prepare(
      `UPDATE applications SET state = 'NATIVE_AUTOFILL_RUNNING' WHERE id = ?`,
    ).run(app.id);
    setEmployerApplicationUrl(
      db,
      app.id,
      "https://jobs.lever.co/acme/00000000-0000-0000-0000-000000000000",
    );
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "true",
      DRY_RUN: "false",
      SUBMIT_ENABLED: "false",
    });

    const report = await runPipeline({ db, applicationId: app.id });
    const appRep = report.applications[0]!;

    expect(appRep.stopped).toBe("gate");
    expect(appRep.stop_reason).toMatch(/live fill refused: FORM_NOT_REACHED/);
    expect(getApplication(db, app.id)?.state).toBe("FAILED_RETRYABLE");
  }, 30_000);
});
