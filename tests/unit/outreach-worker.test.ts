import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, migrate, openDatabase, type Db } from "../../src/storage/db/client.js";
import { enqueueJobRightJobs } from "../../src/jobright/enqueueJobs.js";
import { persistJobIdentityFromSnapshot } from "../../src/outreach/outreachPipeline.js";
import {
  GMAIL_TAIL_MAX_ATTEMPTS,
  listPendingGmailTail,
  readGmailTailRecord,
  recordGmailTailOutcome,
  runOutreachWorkerPass,
} from "../../src/outreach/outreachWorker.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Operator directive 2026-09-09: the Gmail tail ALWAYS runs after a submit,
 * in a process parallel to the apply loop. The worker picks verified
 * submissions, records each outcome in versions_json.gmail_tail, retries
 * transient failures up to a cap, and never retries a terminal one.
 * UNIT_CONFIRMED — stubbed runner, temp SQLite, no flags, no network.
 */
describe("outreach worker (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;
  const now = new Date("2026-09-09T15:00:00Z");
  const since = new Date("2026-09-09T03:00:00Z");

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-ow-${randomUUID()}.sqlite`);
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    delete process.env.DATABASE_PATH;
    resetConfigCache();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  const seedSubmitted = (jobId: string, submittedAt: string, status = "VERIFIED"): string => {
    const appId = enqueueJobRightJobs(db, [jobId]).applications[0]!.application_id!;
    persistJobIdentityFromSnapshot(db, appId, { company: "Acme", role: "Software Intern", location: null, description_text: "x" });
    db.prepare("UPDATE applications SET state = 'COMPLETED' WHERE id = ?").run(appId);
    db.prepare(
      "INSERT INTO submissions (id, application_id, submission_attempt_number, status, submitted, submitted_at, receipt_json) VALUES (?, ?, 1, ?, 1, ?, '{}')",
    ).run(randomUUID(), appId, status, submittedAt);
    return appId;
  };

  it("lists verified submissions newer than `since`, newest first, and skips done / capped / old / unverified ones", () => {
    const fresh = seedSubmitted("6a76229767a1ad0bc53c8e01", "2026-09-09T14:30:00Z");
    const fresher = seedSubmitted("6a76229767a1ad0bc53c8e02", "2026-09-09T14:45:00Z");
    seedSubmitted("6a76229767a1ad0bc53c8e03", "2026-09-08T10:00:00Z"); // older than since
    seedSubmitted("6a76229767a1ad0bc53c8e04", "2026-09-09T14:50:00Z", "UNCERTAIN");
    const done = seedSubmitted("6a76229767a1ad0bc53c8e05", "2026-09-09T14:40:00Z");
    recordGmailTailOutcome(db, done, { ok: true, generated: 1, drafted: 1, error: null }, now);
    const capped = seedSubmitted("6a76229767a1ad0bc53c8e06", "2026-09-09T14:41:00Z");
    for (let i = 0; i < GMAIL_TAIL_MAX_ATTEMPTS; i++) {
      recordGmailTailOutcome(db, capped, { ok: false, generated: 0, drafted: 0, error: "Gmail page timed out" }, now);
    }
    const pending = listPendingGmailTail(db, { since });
    expect(pending.map((p) => p.application_id)).toEqual([fresher, fresh]);
    expect(pending[0]?.company).toBe("Acme");
    expect(readGmailTailRecord(db, capped)?.terminal_reason).toMatch(/attempt cap/);
  });

  it("a pass runs the tail for each pending row and records success as done", async () => {
    const a = seedSubmitted("6a76229767a1ad0bc53c8e11", "2026-09-09T14:30:00Z");
    const calls: string[] = [];
    const report = await runOutreachWorkerPass({
      db,
      since,
      now: () => now,
      runner: async ({ applicationId }) => {
        calls.push(applicationId);
        return { input: applicationId, application_id: applicationId, ok: true, state: "COMPLETED", people_checked: 3, emails_found: 1, generated: 1, drafted: 1, notes: [], error: null };
      },
    });
    expect(calls).toEqual([a]);
    expect(report.pending).toBe(1);
    expect(report.processed[0]).toMatchObject({ application_id: a, ok: true, done: true, drafted: 1 });
    expect(readGmailTailRecord(db, a)).toMatchObject({ attempts: 1, ok: true, done: true, drafted: 1 });
    // A second pass finds nothing — no duplicate drafts.
    const again = await runOutreachWorkerPass({ db, since, now: () => now, runner: async () => { throw new Error("must not run"); } });
    expect(again.pending).toBe(0);
  });

  it("a transient failure stays pending (attempt counted); a terminal 'no JobRight job id' failure is done at once", async () => {
    const transient = seedSubmitted("6a76229767a1ad0bc53c8e21", "2026-09-09T14:30:00Z");
    const boardRow = seedSubmitted("6a76229767a1ad0bc53c8e22", "2026-09-09T14:35:00Z");
    const fail = (id: string, error: string) => ({ input: id, application_id: id, ok: false, state: "COMPLETED", people_checked: 0, emails_found: 0, generated: 0, drafted: 0, notes: [], error });
    await runOutreachWorkerPass({
      db,
      since,
      now: () => now,
      runner: async ({ applicationId }) =>
        applicationId === boardRow
          ? fail(applicationId, `Cannot resolve stored job: Application ${applicationId} has no JobRight job id`)
          : fail(applicationId, "insider triage: JobRight session lost"),
    });
    expect(readGmailTailRecord(db, transient)).toMatchObject({ attempts: 1, ok: false, done: false, terminal_reason: null });
    expect(readGmailTailRecord(db, boardRow)).toMatchObject({ attempts: 1, ok: false, done: true });
    expect(readGmailTailRecord(db, boardRow)?.terminal_reason).toMatch(/no JobRight job/);
    const pending = listPendingGmailTail(db, { since });
    expect(pending.map((p) => p.application_id)).toEqual([transient]);
    expect(pending[0]?.attempts).toBe(1);
  });

  it("is a no-op without GMAIL_DRAFTS_ENABLED when no runner seam is supplied", async () => {
    seedSubmitted("6a76229767a1ad0bc53c8e31", "2026-09-09T14:30:00Z");
    const report = await runOutreachWorkerPass({ db, since, now: () => now });
    expect(report.pending).toBe(0);
    expect(report.notes[0]).toMatch(/GMAIL_DRAFTS_ENABLED/);
  });
});
