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
import { getApplication } from "../../src/queue/stateMachine.js";
import { upsertContact } from "../../src/contacts/repository.js";
import {
  excludeFromAutomation,
  persistJobIdentityFromSnapshot,
  runOutreachPipeline,
  runPostSubmitGmail,
} from "../../src/outreach/outreachPipeline.js";
import { enqueueJobRightJobs } from "../../src/jobright/enqueueJobs.js";
import type { InsiderTriageReport } from "../../src/contacts/insiderTriage.js";
import {
  OUTREACH_PROMPT_VERSION,
  type EmailGenerationResult,
} from "../../src/contacts/emailGenerate.js";
import type { GmailDraftResult } from "../../src/outreach/gmailDrafts.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import { resetConfigCache } from "../../src/config/index.js";

const JOB_ID = "6a76229767a1ad0bc53c8e9f";

const emptyTriage = (overrides?: Partial<InsiderTriageReport>): InsiderTriageReport => ({
  emails: [],
  contacts: [],
  people_checked: 0,
  found: 0,
  not_found: 0,
  skipped_reason: "no Insider Connection people in the school/beyond panels — triage skipped",
  per_person: [],
  notes: [],
  registry: "test",
  ...overrides,
});

function stubClient(): EmailLlmClient {
  return { generateJson: async () => ({ text: "{}", model: "stub" }) };
}

describe("runOutreachPipeline (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-or-${randomUUID()}.sqlite`);
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

  it("refuses an empty ref list before enqueue", async () => {
    await expect(
      runOutreachPipeline({ db, refs: [], deps: { enqueue: () => {
        throw new Error("enqueue must not run");
      } } }),
    ).rejects.toThrow(/at least one JobRight/);
  });

  it("requires a verified submission before the Gmail tail touches any service", async () => {
    const appId = enqueueJobRightJobs(db, [JOB_ID]).applications[0]!.application_id!;
    const result = await runPostSubmitGmail({ db, applicationId: appId, deps: {
      enqueue: () => { throw new Error("must not enqueue"); },
      enrichJob: async () => { throw new Error("must not enrich"); },
    } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/verified submission/);
  });

  it("runs Gmail for a COMPLETED application without re-enqueueing or changing its identity", async () => {
    const appId = enqueueJobRightJobs(db, [JOB_ID]).applications[0]!.application_id!;
    persistJobIdentityFromSnapshot(db, appId, { company: "Acme", role: "Software Intern", location: null, description_text: "Build software" });
    db.prepare("UPDATE applications SET state = 'COMPLETED' WHERE id = ?").run(appId);
    db.prepare("INSERT INTO submissions (id, application_id, submission_attempt_number, status, submitted, receipt_json) VALUES (?, ?, 1, 'VERIFIED', 1, '{}')").run(randomUUID(), appId);
    const result = await runPostSubmitGmail({ db, applicationId: appId, deps: {
      enqueue: () => { throw new Error("must not enqueue"); },
      enrichJob: async () => {}, triage: async () => emptyTriage(),
      makeClient: () => { throw new Error("no contacts needs no LLM"); },
    } });
    expect(result.ok).toBe(true);
    expect(result.drafted).toBe(0);
    expect(getApplication(db, appId)?.state).toBe("COMPLETED");
    expect(JSON.parse(getApplication(db, appId)!.versions_json)).not.toHaveProperty("automation_excluded");
    expect(db.prepare("SELECT company, role FROM jobs WHERE id = ?").get(getApplication(db, appId)!.job_id)).toEqual({ company: "Acme", role: "Software Intern" });
    expect((db.prepare("SELECT count(*) n FROM applications").get() as { n: number }).n).toBe(1);
  });

  it("fails loud when every ref is unparseable", async () => {
    await expect(
      runOutreachPipeline({ db, refs: ["not-a-job", "also-bad"] }),
    ).rejects.toThrow(/no JobRight jobs enqueued/);
  });

  it("enqueues, excludes from auto-apply, generates and drafts without leaving QUEUED", async () => {
    const generated: string[] = [];
    const drafted: string[] = [];
    const report = await runOutreachPipeline({
      db,
      refs: [JOB_ID],
      headless: true,
      deps: {
        enrichJob: async ({ db: d, applicationId }) => {
          persistJobIdentityFromSnapshot(d, applicationId, {
            company: "Acme Robotics",
            role: "SWE Intern",
            location: "NYC",
            description_text: "Build robots.",
          });
        },
        triage: async ({ db: d, applicationId }) => {
          upsertContact(d, {
            applicationId,
            email: "alex@acme.test",
            name: null,
            sourceCategory: "email",
          });
          return emptyTriage({
            emails: ["alex@acme.test"],
            contacts: [{ name: null, email: "alex@acme.test" }],
            people_checked: 1,
            found: 1,
            skipped_reason: null,
          });
        },
        makeClient: stubClient,
        generate: async ({ db: d, applicationId, contactId }) => {
          generated.push(contactId);
          d.prepare(
            `INSERT INTO email_generations (
               id, application_id, contact_id, prompt_version, model, subject,
               body_text, body_html, payload_json, validation_status, created_at
             ) VALUES (?, ?, ?, ?, 'stub', 'Subj',
                       'Hi there,\nbody', NULL, '{}', 'VALIDATED', ?)`,
          ).run(
            randomUUID(),
            applicationId,
            contactId,
            OUTREACH_PROMPT_VERSION,
            new Date().toISOString(),
          );
          const row: EmailGenerationResult = {
            email_generation_id: randomUUID(),
            contact_id: contactId,
            validation_status: "VALIDATED",
            subject: "Hopkins sophomore interested in Acme Robotics SWE Intern",
            body_text: "Hi there,\n\nbody that is long enough to pass.",
            model: "stub",
            violations: [],
            review_item_id: null,
            application_state: "QUEUED",
          };
          return row;
        },
        createDraft: async ({ contactId }) => {
          drafted.push(contactId);
          const row: GmailDraftResult = {
            gmail_draft_id: randomUUID(),
            recipient_email: "alex@acme.test",
            subject: "subj",
            status: "DRAFTED",
            verified: true,
            notes: [],
          };
          return row;
        },
      },
    });

    expect(report.jobs).toHaveLength(1);
    const job = report.jobs[0]!;
    expect(job.ok).toBe(true);
    expect(job.emails_found).toBe(1);
    expect(job.generated).toBe(1);
    expect(job.drafted).toBe(1);
    expect(generated).toHaveLength(1);
    expect(drafted).toHaveLength(1);
    expect(job.state).toBe("QUEUED");
    expect(getApplication(db, job.application_id!)?.state).toBe("QUEUED");

    const versions = JSON.parse(
      (
        db
          .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
          .get(job.application_id) as { versions_json: string }
      ).versions_json,
    ) as { automation_excluded?: boolean };
    expect(versions.automation_excluded).toBe(true);

    const stored = db
      .prepare(
        `SELECT company, role FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
      )
      .get(job.application_id) as { company: string; role: string };
    expect(stored.company).toBe("Acme Robotics");
    expect(stored.role).toBe("SWE Intern");
  });

  it("writes a VALIDATED generation so the draft step runs, and continues past a bad second ref", async () => {
    const drafted: string[] = [];
    const report = await runOutreachPipeline({
      db,
      refs: [JOB_ID, "not-a-job"],
      deps: {
        enrichJob: async () => undefined,
        triage: async ({ db: d, applicationId }) => {
          const c = upsertContact(d, {
            applicationId,
            email: "pat@acme.test",
            name: "Pat Lee",
            sourceCategory: "school",
          });
          d.prepare(
            `INSERT INTO email_generations (
               id, application_id, contact_id, prompt_version, model, subject,
               body_text, body_html, payload_json, validation_status, created_at
             ) VALUES (?, ?, ?, ?, 'stub', 'Subj',
                       'Hi Pat,\nbody', NULL, '{}', 'VALIDATED', ?)`,
          ).run(
            randomUUID(),
            applicationId,
            c.id,
            OUTREACH_PROMPT_VERSION,
            new Date().toISOString(),
          );
          return emptyTriage({
            emails: ["pat@acme.test"],
            contacts: [{ name: "Pat Lee", email: "pat@acme.test" }],
            people_checked: 1,
            found: 1,
            skipped_reason: null,
          });
        },
        makeClient: stubClient,
        generate: async ({ contactId }) => ({
          email_generation_id: randomUUID(),
          contact_id: contactId,
          validation_status: "VALIDATED",
          subject: "s",
          body_text: "b",
          model: "stub",
          violations: [],
          review_item_id: null,
          application_state: "QUEUED",
        }),
        createDraft: async ({ contactId }) => {
          drafted.push(contactId);
          return {
            gmail_draft_id: randomUUID(),
            recipient_email: "pat@acme.test",
            subject: "s",
            status: "DRAFTED" as const,
            verified: true,
            notes: [],
          };
        },
      },
    });
    expect(report.jobs).toHaveLength(2);
    expect(report.jobs[0]!.ok).toBe(true);
    expect(report.jobs[0]!.drafted).toBe(1);
    expect(report.jobs[1]!.ok).toBe(false);
    expect(report.jobs[1]!.error).toMatch(/Malformed jobright job id|Not a JobRight/);
    expect(drafted).toHaveLength(1);
  });

  it("records a per-job error and keeps going when enrich throws", async () => {
    const report = await runOutreachPipeline({
      db,
      refs: [JOB_ID],
      deps: {
        // The pipeline builds its LLM client eagerly (a keyless run must
        // refuse loudly before touching any job) — so even this
        // enrich-only test has to stub it, or the gate needs a real key.
        makeClient: stubClient,
        enrichJob: async () => {
          throw new Error("AUTH_REQUIRED: JobRight session expired");
        },
        triage: async () => {
          throw new Error("triage must not run");
        },
      },
    });
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]!.ok).toBe(false);
    expect(report.jobs[0]!.error).toMatch(/AUTH_REQUIRED/);
    expect(report.jobs[0]!.state).toBe("QUEUED");
  });
});

describe("persistJobIdentityFromSnapshot + excludeFromAutomation (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-or-id-${randomUUID()}.sqlite`);
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  it("overwrites the manual-enqueue placeholder company/role", () => {
    const enq = enqueueJobRightJobs(db, [JOB_ID]);
    const appId = enq.applications[0]!.application_id!;
    expect(
      persistJobIdentityFromSnapshot(db, appId, {
        company: "Jump Trading",
        role: "Quant Intern",
        location: null,
        description_text: "Trade things.",
      }),
    ).toBe(true);
    const row = db
      .prepare(
        `SELECT company, role, description_text FROM jobs j
         JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
      )
      .get(appId) as { company: string; role: string; description_text: string };
    expect(row.company).toBe("Jump Trading");
    expect(row.role).toBe("Quant Intern");
    expect(row.description_text).toBe("Trade things.");
  });

  it("excludeFromAutomation sets the versions_json flag", () => {
    const enq = enqueueJobRightJobs(db, [JOB_ID]);
    const appId = enq.applications[0]!.application_id!;
    excludeFromAutomation(db, appId);
    excludeFromAutomation(db, appId);
    const versions = JSON.parse(
      (
        db
          .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
          .get(appId) as { versions_json: string }
      ).versions_json,
    ) as { automation_excluded: boolean; manual_enqueue?: boolean };
    expect(versions.automation_excluded).toBe(true);
    expect(versions.manual_enqueue).toBe(true);
  });
});
