import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { detectAuthLossOnPage } from "../auth/authLossDetect.js";
import {
  enqueueJobRightJobs,
  type EnqueueJobsReport,
} from "../jobright/enqueueJobs.js";
import { getStoredJobInspectionTargetByApplicationId } from "../jobright/storedJobTarget.js";
import { ensureCompanyTwinJob } from "../jobright/companySearch.js";
import {
  readJobDetailSnapshot,
  type JobDetailSnapshot,
} from "../jobright/jobDetails.js";
import {
  computeJobFingerprint,
  hashJobDescription,
} from "../jobs/fingerprint.js";
import { getApplication } from "../queue/stateMachine.js";
import { listContacts, type ContactRow } from "../contacts/repository.js";
import { rankOutreachContacts } from "../contacts/rank.js";
import { recipientMatchesCompany } from "./recipientCompanyMatch.js";

/** One outreach email per person per window, across every application (#214). */
export const OUTREACH_DEDUPE_WINDOW_DAYS = 30;

export type AlreadyContacted = {
  contact: ContactRow;
  priorApplicationId: string;
  priorAt: string;
};

/**
 * Drop contacts whose email address already has a saved Gmail draft (any
 * application, any company) inside the dedupe window. The address is the
 * identity — the same insider is a different `contacts` row per
 * application. Contacts without an email are kept (they cannot be
 * drafted anyway and the tail reports them). Order is preserved so the
 * ranking still decides who fills the per-app cap.
 */
export function filterAlreadyContacted(
  db: Db,
  contacts: ContactRow[],
  applicationId: string,
  now: Date = new Date(),
): { kept: ContactRow[]; skipped: AlreadyContacted[] } {
  const since = new Date(now.getTime() - OUTREACH_DEDUPE_WINDOW_DAYS * 86_400_000).toISOString();
  const lookup = db.prepare(
    `SELECT application_id, created_at FROM gmail_drafts
     WHERE lower(recipient_email) = lower(?) AND status = 'DRAFTED'
       AND application_id <> ? AND created_at >= ?
     ORDER BY created_at ASC LIMIT 1`,
  );
  const kept: ContactRow[] = [];
  const skipped: AlreadyContacted[] = [];
  const seenThisRun = new Set<string>();
  for (const contact of contacts) {
    const email = contact.email?.trim().toLowerCase();
    if (!email) {
      kept.push(contact);
      continue;
    }
    // Two contact rows with the same address inside one application.
    if (seenThisRun.has(email)) continue;
    seenThisRun.add(email);
    const prior = lookup.get(email, applicationId, since) as
      | { application_id: string; created_at: string }
      | undefined;
    if (prior) {
      skipped.push({ contact, priorApplicationId: prior.application_id, priorAt: prior.created_at });
      continue;
    }
    kept.push(contact);
  }
  return { kept, skipped };
}
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
  drafts_verified?: number;
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

/**
 * #242: give a board-discovered application a JobRight job to read people
 * through. No-op (and no browser) when the app already has its own
 * JobRight id or a stored company twin. Returns a note, or null when
 * nothing was needed.
 */
async function ensureCompanyTwin(input: {
  db: Db;
  applicationId: string;
  headless: boolean;
}): Promise<string | null> {
  const already = getStoredJobInspectionTargetByApplicationId(
    input.db,
    input.applicationId,
  );
  if (already.ok) return null;
  const row = input.db
    .prepare(
      `SELECT j.company FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
    )
    .get(input.applicationId) as { company: string | null } | undefined;
  if (!row?.company) return null;
  const session = new PlaywrightServiceSession({
    service: "jobright",
    headless: input.headless,
    slowMoMs: 40,
  });
  let opened = false;
  try {
    await session.open();
    opened = true;
    const outcome = await ensureCompanyTwinJob({
      db: input.db,
      company: row.company,
      openPage: () => session.newPage({ purpose: "outreach_company_search" }),
    });
    return `company twin (#242): ${outcome.note}`;
  } catch (err) {
    return `company twin (#242) unavailable: ${
      err instanceof Error ? err.message.slice(0, 140) : String(err)
    }`;
  } finally {
    if (opened) await session.close().catch(() => undefined);
  }
}

export async function runOutreachPipeline(input: {
  db: Db;
  refs: string[];
  /** Existing verified submission; never re-enqueue or exclude this application. */
  postSubmitApplicationId?: string;
  headless?: boolean;
  deps?: OutreachPipelineDeps;
}): Promise<OutreachPipelineReport> {
  const refs = input.refs.map((r) => r.trim()).filter((r) => r.length > 0);
  if (refs.length === 0 && !input.postSubmitApplicationId) {
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

  let enqueued: EnqueueJobsReport;
  if (input.postSubmitApplicationId) {
    const app = getApplication(input.db, input.postSubmitApplicationId);
    const verified = input.db.prepare(
      `SELECT id FROM submissions WHERE application_id = ? AND status = 'VERIFIED' AND submitted = 1 LIMIT 1`,
    ).get(input.postSubmitApplicationId);
    if (!app || !verified) throw new Error("Post-submit Gmail requires a verified submission for this application");
    enqueued = { enqueued: 0, reused: 1, blocked: 0, failed: 0, applications: [{
      input: app.id, ok: true, application_id: app.id, state: app.state,
      jobright_job_id: null, job_url: null, job_db_id: app.job_id,
      dedupe_kind: "VERIFIED_EXISTING", error: null,
    }] };
  } else {
    enqueued = enqueue(input.db, refs);
  }
  const okItems = enqueued.applications.filter(
    (a) => a.ok && typeof a.application_id === "string",
  );
  if (okItems.length === 0) {
    const reasons = enqueued.applications
      .map((a) => a.error ?? "enqueue failed")
      .join("; ");
    throw new Error(`no JobRight jobs enqueued: ${reasons}`);
  }

  let client: EmailLlmClient | undefined;
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
      if (!input.postSubmitApplicationId) {
        excludeFromAutomation(input.db, applicationId);
        result.notes.push("excluded from auto-apply");
      }
      // #242: a board-discovered application has no JobRight posting, so
      // every step below — enrich, insider triage, contacts — has nothing
      // to read. #207 borrows a STORED JobRight job of the same employer;
      // when there is none, JobRight's own search resolves the company
      // (live: 373 results for "Rocket Lab", including the very intern
      // postings this run had just applied to through the board). Without
      // it, night29 produced ZERO drafts against twelve verified submits.
      // Fail-open: no hit, or a search that errors, leaves the run exactly
      // as it was and the tail reports the honest reason.
      const twin = await ensureCompanyTwin({
        db: input.db,
        applicationId,
        headless,
      });
      if (twin) result.notes.push(twin);
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
      // #214 (operator 2026-09-09 19:53 UTC: "a lot of duplicate emails
      // for each internship"): 7 Verkada submits × the same 4 insiders =
      // 28 drafts to 4 people. One person gets ONE email per company per
      // window, whichever posting reached them first; later postings for
      // the same employer skip that person before any model call.
      const ranked = rankOutreachContacts(listContacts(input.db, applicationId), jobRole);
      const { kept: contacts, skipped: duplicateContacts } = filterAlreadyContacted(
        input.db,
        ranked,
        applicationId,
      );
      for (const dup of duplicateContacts) {
        result.notes.push(
          `contact ${dup.contact.id} (${dup.contact.email ?? "no email"}): already drafted via application ${dup.priorApplicationId.slice(0, 8)} on ${dup.priorAt.slice(0, 10)} — duplicate outreach skipped (#214)`,
        );
      }
      if (duplicateContacts.length > 0) {
        result.notes.push(`${duplicateContacts.length} duplicate recipient(s) skipped (#214)`);
      }
      // #248: JobRight's insider panel also lists "From Your School" and
      // "From Your Previous Company" — people the CANDIDATE knows, who
      // often work somewhere else. Drafting a "I applied to <company>"
      // email to them writes to a stranger about a job they have nothing
      // to do with. Three such drafts were already in the operator's
      // mailbox when this was found (Zipline -> two @zoox.com addresses,
      // Coinbase -> @usage.ai, American Equity -> @pdhi.com).
      //
      // A corporate address names the employer; a personal one says
      // nothing and is always allowed through. Only a corporate domain
      // sharing nothing with the company is dropped, and it is reported
      // by name so the miss is visible rather than silent.
      const companyName = (
        input.db
          .prepare(
            `SELECT j.company FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
          )
          .get(applicationId) as { company: string | null } | undefined
      )?.company ?? null;
      const wrongCompany: string[] = [];
      const onCompany = contacts.filter((c) => {
        const verdict = recipientMatchesCompany(c.email, companyName);
        if (verdict.verdict !== "mismatch") return true;
        wrongCompany.push(`${c.email ?? c.id}: ${verdict.reason}`);
        return false;
      });
      for (const note of wrongCompany) {
        result.notes.push(`recipient skipped — ${note} (#248)`);
      }
      const contactsCapped = onCompany.slice(0, MAX_EMAIL_GENERATIONS_PER_APP);

      for (const contact of contactsCapped) {
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
          client: client ??= makeClient(),
        });
        if (gen.validation_status === "VALIDATED") result.generated += 1;
        else {
          result.notes.push(
            `contact ${contact.id}: REJECTED (${gen.violations.join("; ").slice(0, 200)})`,
          );
        }
      }

      for (const contact of contactsCapped) {
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
        if (draft.status === "DRAFTED") {
          result.drafted += 1;
          if (draft.verified) result.drafts_verified = (result.drafts_verified ?? 0) + 1;
          else result.notes.push(`contact ${contact.id}: draft saved but read-back unverified`);
        }
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

/** Gmail tail for an existing application, including a COMPLETED app with no contacts yet. */
export async function runPostSubmitGmail(input: {
  db: Db;
  applicationId: string;
  headless?: boolean;
  deps?: OutreachPipelineDeps;
}): Promise<OutreachPipelineJobResult> {
  try {
    const report = await runOutreachPipeline({
      db: input.db, refs: [], postSubmitApplicationId: input.applicationId,
      ...(input.headless !== undefined ? { headless: input.headless } : {}),
      ...(input.deps ? { deps: input.deps } : {}),
    });
    return report.jobs[0]!;
  } catch (err) {
    return { input: input.applicationId, application_id: input.applicationId, ok: false,
      state: getApplication(input.db, input.applicationId)?.state ?? null,
      people_checked: 0, emails_found: 0, generated: 0, drafted: 0, notes: [],
      error: err instanceof Error ? err.message : String(err) };
  }
}
