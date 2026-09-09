import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resetConfigCache } from "../../src/config/index.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { getOrCreateApplicationForJob } from "../../src/jobs/applicationDedupe.js";
import { transitionApplication } from "../../src/queue/stateMachine.js";
import { runJobRightDiscovery } from "../../src/jobright/discoveryRun.js";
import { acquireLease, releaseLease, LeaseError } from "../../src/queue/leases.js";

const feedFixture = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "jobright",
  "job-feed",
  "dom.sanitized.html",
);

describe("Phase 5.5 application dedupe", () => {
  let dbPath: string;
  let prevDb: string | undefined;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-dedupe-${randomUUID()}.sqlite`);
    prevDb = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = dbPath;
    resetConfigCache();
  });

  afterEach(() => {
    if (prevDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDb;
    resetConfigCache();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(`${dbPath}-wal`);
      fs.unlinkSync(`${dbPath}-shm`);
    } catch {
      // ignore
    }
  });

  it("creates one application then reuses on second discovery", async () => {
    const first = await runJobRightDiscovery({
      feedHtmlPath: feedFixture,
      maxJobs: 3,
    });
    expect(first.applications.length).toBeGreaterThan(0);
    const created = first.applications.filter((a) => a.dedupe_kind === "CREATED");
    expect(created.length).toBeGreaterThan(0);

    const second = await runJobRightDiscovery({
      feedHtmlPath: feedFixture,
      maxJobs: 3,
    });
    expect(second.jobs_reused).toBeGreaterThan(0);
    expect(second.applications.every((a) => a.dedupe_kind !== "CREATED")).toBe(
      true,
    );

    const db = openDatabase(dbPath);
    migrate(db);
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as { n: number }
    ).n;
    closeDatabase(db);
    expect(count).toBe(first.applications.length);
  });

  it("fresh discovery skips previously queued feed cards and reads requirements for one new eligible job (UNIT_CONFIRMED)", async () => {
    const first = await runJobRightDiscovery({ feedHtmlPath: feedFixture, maxJobs: 1, freshOnly: true, detailReader: async () => "Undergraduate internship." });
    expect(first.jobs_eligible).toBe(1);
    const read: string[] = [];
    const next = await runJobRightDiscovery({ feedHtmlPath: feedFixture, maxJobs: 1, freshOnly: true, detailReader: async card => { read.push(card.jobright_job_id); return "Undergraduate internship."; } });
    expect(next.jobs_eligible).toBeLessThanOrEqual(1);
    expect(next.applications.every(a => a.application_id !== first.applications[0]!.application_id)).toBe(true);
    expect(read).not.toContain(first.applications[0]!.jobright_job_id);
    const db = openDatabase(dbPath);
    for (const app of next.applications) {
      expect((db.prepare("SELECT description_text FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?").get(app.application_id) as { description_text: string }).description_text).toBe("Undergraduate internship.");
    }
    closeDatabase(db);
  });

  it("getOrCreateApplicationForJob returns EXISTING_ACTIVE", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const job = upsertJobByFingerprint(db, {
      company: "Acme",
      role: "Intern",
      jobrightJobId: "abc123",
      applicationUrl: "https://example.com/jobs/1",
    });
    const a = getOrCreateApplicationForJob(db, { jobId: job.id });
    expect(a.kind).toBe("CREATED");
    const b = getOrCreateApplicationForJob(db, { jobId: job.id });
    expect(b.kind).toBe("EXISTING_ACTIVE");
    expect(b.applicationId).toBe(a.applicationId);
    closeDatabase(db);
  });

  // #209 (day28): a posting abandoned by an operator/policy decision must
  // not be re-created by the next sweep; a pipeline failure still may.
  it("POLICY_ABANDONED blocks re-creation after an operator/policy abandon; an ordinary FAILED_FINAL does not", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const abandonedJob = upsertJobByFingerprint(db, {
      company: "Acme", role: "People Analytics Intern", jobrightJobId: "pol001", applicationUrl: "https://example.com/jobs/2",
    });
    const a = getOrCreateApplicationForJob(db, { jobId: abandonedJob.id });
    expect(a.kind).toBe("CREATED");
    transitionApplication(db, {
      applicationId: a.applicationId,
      nextState: "FAILED_FINAL",
      reason: "day28 #209: non-engineering intern posting — operator scope is software/AI",
    });
    const again = getOrCreateApplicationForJob(db, { jobId: abandonedJob.id });
    expect(again.kind).toBe("POLICY_ABANDONED");
    expect(again.applicationId).toBe(a.applicationId);

    const failedJob = upsertJobByFingerprint(db, {
      company: "Acme", role: "SWE Intern", jobrightJobId: "fail001", applicationUrl: "https://example.com/jobs/3",
    });
    const f = getOrCreateApplicationForJob(db, { jobId: failedJob.id });
    transitionApplication(db, {
      applicationId: f.applicationId,
      nextState: "FAILED_FINAL",
      reason: "retry cap reached (3/3)",
    });
    expect(getOrCreateApplicationForJob(db, { jobId: failedJob.id }).kind).toBe("CREATED");
    closeDatabase(db);
  });

  it("lease blocks duplicate worker", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    acquireLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-a",
      ttlMs: 60_000,
    });
    expect(() =>
      acquireLease(db, {
        resourceType: "application",
        resourceId: "app1:fill",
        holderRunId: "worker-b",
        ttlMs: 60_000,
      }),
    ).toThrow(LeaseError);
    releaseLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-a",
    });
    const again = acquireLease(db, {
      resourceType: "application",
      resourceId: "app1:fill",
      holderRunId: "worker-b",
      ttlMs: 60_000,
    });
    expect(again.holder_run_id).toBe("worker-b");
    closeDatabase(db);
  });
});
