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
import { buildInsightsView } from "../../src/console/insights.js";
import { enqueueJobRightJobs } from "../../src/jobright/enqueueJobs.js";

/**
 * U3: the Insights read model feeds the console's charts. Aggregates
 * only — states, hosts, providers, counts. UNIT_CONFIRMED against a
 * temp SQLite plus a fake artifacts dir.
 */
describe("buildInsightsView (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let artifactsDir: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-ins-${randomUUID()}.sqlite`);
    db = openDatabase(dbPath);
    migrate(db);
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-ins-art-"));
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("aggregates fill runs, pipeline states, sources, and captcha incidents", () => {
    enqueueJobRightJobs(db, ["6a76229767a1ad0bc53c8e9f"]);
    db.prepare(
      `INSERT INTO fill_runs (
         id, created_at, mode, source, ats, job_url, job_host, company, role,
         mutation_attempted, validation_level, verify_passed, fillable_count,
         skipped_count, schema_version, code_version
       ) VALUES (?, ?, 'execute', 'test', 'greenhouse', 'https://x.test', 'x.test',
                 'Acme', 'SWE', 1, 'UNVERIFIED', ?, 3, 1, 1, 'test')`,
    ).run(randomUUID(), "2026-08-25T10:00:00.000Z", 1);
    db.prepare(
      `INSERT INTO fill_runs (
         id, created_at, mode, source, ats, job_url, job_host, company, role,
         mutation_attempted, validation_level, verify_passed, fillable_count,
         skipped_count, schema_version, code_version
       ) VALUES (?, ?, 'execute', 'test', 'greenhouse', 'https://x.test', 'x.test',
                 'Acme', 'SWE', 1, 'UNVERIFIED', ?, 3, 1, 1, 'test')`,
    ).run(randomUUID(), "2026-08-25T11:00:00.000Z", 0);

    const reportDir = path.join(artifactsDir, "ats-fill", "generic-live");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(reportDir, "live-refused-1.json"),
      JSON.stringify({
        ats: "greenhouse",
        captcha_incident: {
          host: "job-boards.greenhouse.io",
          provider: "turnstile",
          paused: true,
          cleared: true,
          waited_ms: 12000,
        },
      }),
    );
    fs.writeFileSync(
      path.join(reportDir, "live-refused-2.json"),
      JSON.stringify({ ats: "lever", notes: ["no incident here"] }),
    );
    fs.writeFileSync(path.join(reportDir, "broken.json"), "{not json");

    const view = buildInsightsView(db, artifactsDir);

    expect(view.fill_runs_daily).toEqual([
      { date: "2026-08-25", attempted: 2, verified: 1, failed: 1 },
    ]);
    expect(view.pipeline_states.find((s) => s.state === "QUEUED")?.count).toBe(1);
    const jr = view.discovery_sources.find((s) => s.source === "jobright");
    expect(jr).toMatchObject({ jobs: 1, applications: 1, completed: 0 });
    expect(view.captcha_incidents).toEqual([
      {
        host: "job-boards.greenhouse.io",
        provider: "turnstile",
        count: 1,
        cleared: 1,
      },
    ]);
    expect(view.captcha_files_scanned).toBe(3);
  });

  it("fails open on an empty database and a missing artifacts dir", () => {
    const view = buildInsightsView(db, path.join(artifactsDir, "nope"));
    expect(view.fill_runs_daily).toEqual([]);
    expect(view.pipeline_states).toEqual([]);
    expect(view.captcha_incidents).toEqual([]);
  });
});
