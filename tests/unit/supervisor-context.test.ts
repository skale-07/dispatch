import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, migrate, openDatabase, type Db } from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication, transitionApplication } from "../../src/queue/stateMachine.js";
import { recordNavigationAttempt } from "../../src/storage/navSubmitOutcomes.js";
import { resetConfigCache } from "../../src/config/index.js";
import { buildSupervisorJobContext } from "../../src/navigation/supervisorContext.js";

/**
 * The navigation supervisor's job context: posting details plus this
 * application's prior navigation attempts and state events, hard-capped
 * and redacted. UNIT_CONFIRMED.
 */
describe("supervisor job context (UNIT_CONFIRMED)", () => {
  let dir: string;
  let db: Db;
  const prevDb = process.env["DATABASE_PATH"];
  const prevArtifacts = process.env["ARTIFACTS_DIR"];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "supctx-"));
    process.env["DATABASE_PATH"] = path.join(dir, "app.sqlite");
    process.env["ARTIFACTS_DIR"] = path.join(dir, "artifacts");
    resetConfigCache();
    db = openDatabase();
    migrate(db);
  });
  afterEach(() => {
    closeDatabase(db);
    if (prevDb === undefined) delete process.env["DATABASE_PATH"]; else process.env["DATABASE_PATH"] = prevDb;
    if (prevArtifacts === undefined) delete process.env["ARTIFACTS_DIR"]; else process.env["ARTIFACTS_DIR"] = prevArtifacts;
    resetConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls open to the bare url for an unknown application", () => {
    expect(buildSupervisorJobContext(db, "nope", "https://x.test/apply")).toEqual({ url: "https://x.test/apply" });
  });

  it("carries posting details, prior navigation walls, and recent events, all capped", () => {
    const job = upsertJobByFingerprint(db, {
      company: "Acme Robotics",
      role: "Software Engineer Intern",
      location: "Austin, TX",
      employmentType: "Internship",
      descriptionText: `Build ${"robots ".repeat(400)}`,
      jobrightJobId: "jr-1",
      raw: { job_url: "https://jobright.ai/jobs/info/jr-1" },
    });
    const app = createApplication(db, { jobId: job.id, state: "QUEUED" });
    transitionApplication(db, { applicationId: app.id, nextState: "MATERIALS_GENERATING", reason: "picked" });
    transitionApplication(db, { applicationId: app.id, nextState: "FAILED_RETRYABLE", reason: "navigation wall: auth on careers.acme.test" });
    for (let i = 0; i < 5; i++) {
      recordNavigationAttempt(
        {
          report: {
            run_id: `nav-${i}`,
            application_id: app.id,
            jobright_job_id: "jr-1",
            method: i === 4 ? "apply_click_popup" : null,
            resolved_url: null,
            resolved_ats: null,
            wall: i === 4 ? "auth" : "budget",
            phase_trace: [],
            agent: null,
            gmail: null,
            need: null,
            session: "cdp",
            notes: [`attempt ${i}`, "login wall at careers.acme.test"],
            congruence: null,
            duplicates: null,
            login_wall: null,
          } as never,
          startUrl: "https://jobright.ai/jobs/info/jr-1",
          durationMs: 10,
        },
        { db },
      );
    }

    const ctx = buildSupervisorJobContext(db, app.id, "https://careers.acme.test/jobs/1");
    expect(ctx.company).toBe("Acme Robotics");
    expect(ctx.role).toBe("Software Engineer Intern");
    expect(ctx.url).toBe("https://careers.acme.test/jobs/1");
    expect(ctx.location).toBe("Austin, TX");
    expect(ctx.employment_type).toBe("Internship");
    expect(ctx.posting_url).toBe("https://jobright.ai/jobs/info/jr-1");
    expect(ctx.description_excerpt!.length).toBeLessThanOrEqual(701);
    expect(ctx.prior_navigation).toHaveLength(3);
    expect(ctx.prior_navigation![0]!.wall).toBe("auth");
    expect(ctx.prior_navigation![0]!.method).toBe("apply_click_popup");
    expect(ctx.recent_events!.length).toBeGreaterThanOrEqual(2);
    expect(ctx.recent_events![0]!.to).toBe("FAILED_RETRYABLE");
    expect(ctx.recent_events![0]!.reason).toMatch(/auth on careers/);
    // Bounded: the whole bundle stays a small prompt payload.
    expect(JSON.stringify(ctx).length).toBeLessThan(6000);
  });
});
