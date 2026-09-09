import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { runPostSubmitGmail, type OutreachPipelineJobResult } from "./outreachPipeline.js";

/**
 * Parallel post-submit outreach worker (operator directive 2026-09-09:
 * "after the app is submitted the gmail pipeline always runs" and "you can
 * do parallel processing since running the gmail pipeline doesn't
 * interfere with the job app pipeline").
 *
 * The apply loop used to run the Gmail tail INLINE after every verified
 * submit, so an armed window paid for insider triage + drafting between
 * applications. This worker decouples them: the apply loop (with
 * `--defer-gmail`) only submits; this process finds every verified
 * submission whose tail has not completed and runs `runPostSubmitGmail`
 * on it. The two never touch the same application row — the apply loop
 * picks non-terminal rows, this worker picks rows with a VERIFIED
 * submission — and the Gmail tail is drafts-only by construction.
 *
 * Bookkeeping lives in `applications.versions_json.gmail_tail` (metadata,
 * not a state transition): attempts, last outcome, and `done`. A tail is
 * done when it succeeded, when its failure is terminal (no JobRight job to
 * read insiders from — board-discovered rows), or when the attempt cap is
 * reached. Every retry loop here is capped.
 */

export const GMAIL_TAIL_MAX_ATTEMPTS = 3;
/** Default lookback: submissions older than this are never picked up unasked. */
export const GMAIL_TAIL_DEFAULT_SINCE_HOURS = 12;

export type GmailTailRecord = {
  attempts: number;
  last_at: string;
  ok: boolean;
  done: boolean;
  generated: number;
  drafted: number;
  error: string | null;
  /** Why a not-ok tail is nevertheless finished (never retried). */
  terminal_reason: string | null;
};

export type PendingGmailTail = {
  application_id: string;
  state: string;
  submitted_at: string | null;
  company: string | null;
  role: string | null;
  jobright_job_id: string | null;
  attempts: number;
};

export type OutreachWorkerPassReport = {
  since: string;
  pending: number;
  processed: Array<{
    application_id: string;
    company: string | null;
    role: string | null;
    ok: boolean;
    done: boolean;
    generated: number;
    drafted: number;
    error: string | null;
  }>;
  notes: string[];
};

const TERMINAL_ERROR = /has no JobRight job id|Malformed jobright job id|no jobright session/i;

function readVersions(db: Db, applicationId: string): Record<string, unknown> {
  const row = db
    .prepare(`SELECT versions_json FROM applications WHERE id = ?`)
    .get(applicationId) as { versions_json: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.versions_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readGmailTailRecord(db: Db, applicationId: string): GmailTailRecord | null {
  const raw = readVersions(db, applicationId)["gmail_tail"];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<GmailTailRecord>;
  return {
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    last_at: typeof r.last_at === "string" ? r.last_at : "",
    ok: r.ok === true,
    done: r.done === true,
    generated: typeof r.generated === "number" ? r.generated : 0,
    drafted: typeof r.drafted === "number" ? r.drafted : 0,
    error: typeof r.error === "string" ? r.error : null,
    terminal_reason: typeof r.terminal_reason === "string" ? r.terminal_reason : null,
  };
}

/**
 * Record one tail outcome. Idempotent bookkeeping only — never a state
 * write. `done` is decided here so both the inline path and this worker
 * agree on when a tail stops being retried.
 */
export function recordGmailTailOutcome(
  db: Db,
  applicationId: string,
  result: Pick<OutreachPipelineJobResult, "ok" | "generated" | "drafted" | "error">,
  now: Date = new Date(),
): GmailTailRecord {
  const prev = readGmailTailRecord(db, applicationId);
  const attempts = (prev?.attempts ?? 0) + 1;
  const terminal = !result.ok && result.error !== null && TERMINAL_ERROR.test(result.error);
  const record: GmailTailRecord = {
    attempts,
    last_at: now.toISOString(),
    ok: result.ok,
    done: result.ok || terminal || attempts >= GMAIL_TAIL_MAX_ATTEMPTS,
    generated: result.generated,
    drafted: result.drafted,
    error: result.error ? result.error.slice(0, 300) : null,
    terminal_reason: result.ok
      ? null
      : terminal
        ? "no JobRight job to read insider contacts from"
        : attempts >= GMAIL_TAIL_MAX_ATTEMPTS
          ? `attempt cap ${GMAIL_TAIL_MAX_ATTEMPTS} reached`
          : null,
  };
  const versions = readVersions(db, applicationId);
  versions["gmail_tail"] = record;
  db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(
    JSON.stringify(versions),
    applicationId,
  );
  return record;
}

/**
 * Verified submissions newer than `since` whose Gmail tail is not done,
 * newest first. Pure read.
 */
export function listPendingGmailTail(
  db: Db,
  input: { since: Date; limit?: number },
): PendingGmailTail[] {
  const rows = db
    .prepare(
      `SELECT a.id AS application_id, a.state, s.submitted_at,
              j.company, j.role, j.jobright_job_id
       FROM submissions s
       JOIN applications a ON a.id = s.application_id
       LEFT JOIN jobs j ON j.id = a.job_id
       WHERE s.status = 'VERIFIED' AND s.submitted = 1
         AND COALESCE(s.submitted_at, a.updated_at) >= ?
       GROUP BY a.id
       ORDER BY COALESCE(s.submitted_at, a.updated_at) DESC`,
    )
    .all(input.since.toISOString()) as Array<Omit<PendingGmailTail, "attempts">>;
  const out: PendingGmailTail[] = [];
  for (const row of rows) {
    const record = readGmailTailRecord(db, row.application_id);
    if (record?.done) continue;
    if ((record?.attempts ?? 0) >= GMAIL_TAIL_MAX_ATTEMPTS) continue;
    out.push({ ...row, attempts: record?.attempts ?? 0 });
    if (input.limit !== undefined && out.length >= input.limit) break;
  }
  return out;
}

/**
 * One pass: run the Gmail tail for every pending verified submission.
 * Failures are recorded and retried on a later pass up to the cap; the
 * submission itself is never touched.
 */
export async function runOutreachWorkerPass(input: {
  db: Db;
  since?: Date;
  limit?: number;
  headless?: boolean;
  /** Test seam: replaces runPostSubmitGmail. */
  runner?: (args: { db: Db; applicationId: string; headless?: boolean }) => Promise<OutreachPipelineJobResult>;
  now?: () => Date;
}): Promise<OutreachWorkerPassReport> {
  const now = input.now ?? (() => new Date());
  const since =
    input.since ?? new Date(now().getTime() - GMAIL_TAIL_DEFAULT_SINCE_HOURS * 36e5);
  const report: OutreachWorkerPassReport = {
    since: since.toISOString(),
    pending: 0,
    processed: [],
    notes: [],
  };
  const cfg = getConfig();
  if (!cfg.gmailDraftsEnabled && !input.runner) {
    report.notes.push("GMAIL_DRAFTS_ENABLED is off — outreach worker is a no-op");
    return report;
  }
  const pending = listPendingGmailTail(input.db, { since, ...(input.limit !== undefined ? { limit: input.limit } : {}) });
  report.pending = pending.length;
  const run = input.runner ?? runPostSubmitGmail;
  for (const item of pending) {
    logger.info("outreach worker: gmail tail begin", {
      service: "outreach",
      action: "worker_tail_begin",
      application_id: item.application_id,
      metadata: { attempt: item.attempts + 1, has_jobright_job: item.jobright_job_id !== null },
    });
    const result = await run({
      db: input.db,
      applicationId: item.application_id,
      ...(input.headless !== undefined ? { headless: input.headless } : {}),
    });
    const record = recordGmailTailOutcome(input.db, item.application_id, result, now());
    report.processed.push({
      application_id: item.application_id,
      company: item.company,
      role: item.role,
      ok: result.ok,
      done: record.done,
      generated: result.generated,
      drafted: result.drafted,
      error: result.error,
    });
    logger.info("outreach worker: gmail tail end", {
      service: "outreach",
      action: "worker_tail_end",
      application_id: item.application_id,
      metadata: {
        ok: result.ok,
        done: record.done,
        generated: result.generated,
        drafted: result.drafted,
        error: result.error,
        terminal_reason: record.terminal_reason,
      },
    });
  }
  return report;
}
