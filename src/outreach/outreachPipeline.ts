import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import {
  enqueueJobRightJobs,
  type EnqueueJobsReport,
} from "../jobright/enqueueJobs.js";
import { getStoredJobInspectionTargetByApplicationId } from "../jobright/storedJobTarget.js";
import {
  readJobDetailSnapshot,
  type JobDetailSnapshot,
} from "../jobright/jobDetails.js";
import {
  computeJobFingerprint,
  hashJobDescription,
} from "../jobs/fingerprint.js";
import { getApplication } from "../queue/stateMachine.js";
import { listContacts } from "../contacts/repository.js";
import { rankOutreachContacts } from "../contacts/rank.js";
import {
  generateEmailForContact,
  OUTREACH_PROMPT_VERSION,
  type EmailGenerationResult,
} from "../contacts/emailGenerate.js";
import { makeLlmClient, type EmailLlmClient } from "../contacts/emailLlm.js";
import {
  runInsiderTriage,
  type InsiderTriageReport,
} from "../contacts/insiderTriage.js";
import {
  createGmailDraft,
  type GmailDraftResult,
} from "./gmailDrafts.js";

/**
 * Apply-yourself outreach: JobRight link → insider emails → generate →
 * Gmail draft. Does not fill, submit, or send. Does not walk the
 * application into post-submit states (CONTACTS_EXTRACTED / EMAIL_*).
 *
 * Distinct from runOutreachTail (Outlook, CONTACTS_EXTRACTED+ only).
 */

export const MAX_EMAIL_GENERATIONS_PER_APP = 8;

export type OutreachPipelineJobResult = {
  input: string;
  application_id: string | null;
  ok: boolean;
  state: string | null;
  people_checked: number;
  emails_found: number;
  generated: number;
  drafted: number;
  notes: string[];
  error: string | null;
};

export type OutreachPipelineReport = {
  refs: number;
  jobs: OutreachPipelineJobResult[];
};

export type OutreachPipelineDeps = {
  enqueue?: (db: Db, refs: string[]) => EnqueueJobsReport;
  enrichJob?: (input: {
    db: Db;
    applicationId: string;
    headless: boolean;
  }) => Promise<void>;
  triage?: (input: {
    db: Db;
    applicationId: string;
    headless: boolean;
  }) => Promise<InsiderTriageReport>;
  generate?: (input: {
    db: Db;
    applicationId: string;
    contactId: string;
    client: EmailLlmClient;
  }) => Promise<EmailGenerationResult>;
  makeClient?: () => EmailLlmClient;
  createDraft?: (input: {
    db: Db;
    applicationId: string;
    contactId: string;
    headless?: boolean;
  }) => Promise<GmailDraftResult>;
};

/** Same versions_json key the Applications include/exclude toggle uses. */
export function excludeFromAutomation(db: Db, applicationId: string): void {
  const row = db
    .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
    .get(applicationId) as { versions_json: string } | undefined;
  if (!row) return;
  let versions: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.versions_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      versions = parsed as Record<string, unknown>;
    }
  } catch {
    versions = {};
  }
  versions["automation_excluded"] = true;
  db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
    JSON.stringify(versions),
    applicationId,
  );
}

/**
 * Write company / role / description from a JobRight detail snapshot onto
 * the stored job. Manual enqueue leaves "Unknown company (manual enqueue)"
 * until this runs — generation would otherwise name the placeholder.
 */
export function persistJobIdentityFromSnapshot(
  db: Db,
  applicationId: string,
  snapshot: Pick<
    JobDetailSnapshot,
    "company" | "role" | "location" | "description_text"
  >,
): boolean {
  const job = db
    .prepare(
      `SELECT j.id, j.jobright_job_id, j.normalized_application_url, j.company, j.role
       FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(applicationId) as
    | {
        id: string;
        jobright_job_id: string | null;
        normalized_application_url: string | null;
        company: string;
        role: string;
      }
    | undefined;
  if (!job) return false;
  const company = snapshot.company?.trim() || job.company;
  const role = snapshot.role?.trim() || job.role;
  const description = snapshot.description_text?.trim() || null;
  const fingerprint = computeJobFingerprint({
    jobrightJobId: job.jobright_job_id,
    applicationUrl: job.normalized_application_url,
    company,
    role,
  });
  db.prepare(
    `UPDATE jobs SET
       company = ?, role = ?,
       location = COALESCE(?, location),
       description_text = COALESCE(?, description_text),
       description_hash = COALESCE(?, description_hash),
       job_fingerprint = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    company,
    role,
    snapshot.location?.trim() || null,
    description,
    description ? hashJobDescription(description) : null,
    fingerprint,
    new Date().toISOString(),
    job.id,
  );
  return true;
}

export async function enrichJobFromJobRightPage(input: {
  db: Db;
  applicationId: string;
  headless: boolean;
}): Promise<void> {
  const resolved = getStoredJobInspectionTargetByApplicationId(
    input.db,
    input.applicationId,
  );
  if (!resolved.ok) {
    throw new Error(`Cannot resolve stored job: ${resolved.message}`);
  }
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: input.headless,
    slowMoMs: 40,
  });
  await session.open();
  try {
    const page = await session.newPage({ purpose: "outreach_enrich" });
    try {
      await page.goto(resolved.target.jobUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(1_500);
      if (await detectAuthLossOnPage(page, "jobright")) {
        throw new Error("AUTH_REQUIRED: JobRight session expired");
      }
      const snapshot = await readJobDetailSnapshot(page);
      persistJobIdentityFromSnapshot(input.db, input.applicationId, snapshot);
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close();
  }
}

export async function runOutreachPipeline(input: {
  db: Db;
  refs: string[];
  headless?: boolean;
  deps?: OutreachPipelineDeps;
}): Promise<OutreachPipelineReport> {
  const refs = input.refs.map((r) => r.trim()).filter((r) => r.length > 0);
  if (refs.length === 0) {
    throw new Error(
      "outreach requires at least one JobRight URL or hex job id",
    );
  }

  const enqueue = input.deps?.enqueue ?? enqueueJobRightJobs;
  const enrichJob = input.deps?.enrichJob ?? enrichJobFromJobRightPage;
  const triage = input.deps?.triage ?? runInsiderTriage;
  const generate = input.deps?.generate ?? generateEmailForContact;
  const makeClient = input.deps?.makeClient ?? makeLlmClient;
  const createDraft = input.deps?.createDraft ?? createGmailDraft;
  const headless = input.headless ?? true;

  const enqueued = enqueue(input.db, refs);
  const okItems = enqueued.applications.filter(
    (a) => a.ok && typeof a.application_id === "string",
  );
  if (okItems.length === 0) {
    const reasons = enqueued.applications
      .map((a) => a.error ?? "enqueue failed")
      .join("; ");
    throw new Error(`no JobRight jobs enqueued: ${reasons}`);
  }

  const client = makeClient();
  const jobs: OutreachPipelineJobResult[] = [];

  for (const item of enqueued.applications) {
    if (!item.ok || !item.application_id) {
      jobs.push({
        input: item.input,
        application_id: item.application_id,
        ok: false,
        state: item.state,
        people_checked: 0,
        emails_found: 0,
        generated: 0,
        drafted: 0,
        notes: [],
        error: item.error ?? "enqueue failed",
      });
      continue;
    }

    const applicationId = item.application_id;
    const result: OutreachPipelineJobResult = {
      input: item.input,
      application_id: applicationId,
      ok: true,
      state: null,
      people_checked: 0,
      emails_found: 0,
      generated: 0,
      drafted: 0,
      notes: [],
      error: null,
    };

    try {
      excludeFromAutomation(input.db, applicationId);
      result.notes.push("excluded from auto-apply");
      await enrichJob({ db: input.db, applicationId, headless });
      const triageReport = await triage({
        db: input.db,
        applicationId,
        headless,
      });
      result.people_checked = triageReport.people_checked;
      result.emails_found = triageReport.emails.length;
      if (triageReport.skipped_reason) {
        result.notes.push(triageReport.skipped_reason);
      }

      const jobRole = (
        input.db
          .prepare(
            `SELECT j.role FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
          )
          .get(applicationId) as { role: string } | undefined
      )?.role;
      const contacts = rankOutreachContacts(
        listContacts(input.db, applicationId),
        jobRole,
      ).slice(0, MAX_EMAIL_GENERATIONS_PER_APP);

      for (const contact of contacts) {
        const existing = input.db
          .prepare(
            `SELECT validation_status FROM email_generations
             WHERE application_id = ? AND contact_id = ? AND prompt_version = ?`,
          )
          .get(applicationId, contact.id, OUTREACH_PROMPT_VERSION) as
          | { validation_status: string }
          | undefined;
        if (existing?.validation_status === "VALIDATED") {
          result.generated += 1;
          result.notes.push(`contact ${contact.id}: already_validated`);
          continue;
        }
        const gen = await generate({
          db: input.db,
          applicationId,
          contactId: contact.id,
          client,
        });
        if (gen.validation_status === "VALIDATED") result.generated += 1;
        else {
          result.notes.push(
            `contact ${contact.id}: REJECTED (${gen.violations.join("; ").slice(0, 200)})`,
          );
        }
      }

      for (const contact of contacts) {
        const validated = input.db
          .prepare(
            `SELECT id FROM email_generations
             WHERE application_id = ? AND contact_id = ? AND validation_status = 'VALIDATED'`,
          )
          .get(applicationId, contact.id);
        if (!validated) continue;
        const draft = await createDraft({
          db: input.db,
          applicationId,
          contactId: contact.id,
          headless,
        });
        if (draft.status === "DRAFTED") result.drafted += 1;
        else {
          result.notes.push(
            `contact ${contact.id}: draft ${draft.status} (${draft.notes.join("; ").slice(0, 200)})`,
          );
        }
      }
    } catch (err) {
      result.ok = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    result.state = getApplication(input.db, applicationId)?.state ?? item.state;
    jobs.push(result);
    logger.info("outreach pipeline job finished", {
      service: "outreach",
      action: "outreach_pipeline_job",
      metadata: {
        application_id: applicationId,
        ok: result.ok,
        generated: result.generated,
        drafted: result.drafted,
        error: result.error,
      },
    });
  }

  return { refs: refs.length, jobs };
}
