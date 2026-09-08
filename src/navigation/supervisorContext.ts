import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { redactObject } from "../logging/redaction.js";

/**
 * Job context handed to the navigation supervisor (the LLM that decides
 * the next navigation action). Before 2026-09-07 the model saw only
 * {company, role, url}; live cycles showed it landing on the wrong route
 * or repeating an approach that an earlier attempt had already exhausted.
 * This bundle adds what a human operator would read first: the posting's
 * location / employment type / description excerpt (to recognise the
 * right job on a multi-posting careers site), the source posting URL, and
 * the prior navigation attempts + state events for THIS application
 * (walls hit, hosts reached, notes). Read-only, hard-capped, redacted.
 * Everything here is evidence for the model — never instructions, and
 * never a value that reaches a form field.
 */

const MAX_DESCRIPTION_CHARS = 700;
const MAX_PRIOR_NAV = 3;
const MAX_NAV_NOTES = 4;
const MAX_EVENTS = 6;
const MAX_NOTE_CHARS = 200;

export type SupervisorJobContext = {
  company?: string;
  role?: string;
  url: string;
  location?: string | null;
  employment_type?: string | null;
  source_ats?: string | null;
  /** The JobRight posting URL the application was discovered from. */
  posting_url?: string | null;
  description_excerpt?: string | null;
  attempt?: number;
  prior_navigation?: Array<{
    at: string;
    method: string | null;
    wall: string;
    end_host: string | null;
    resolved: boolean;
    notes: string[];
  }>;
  recent_events?: Array<{ from: string | null; to: string; reason: string; at: string }>;
};

function clip(s: unknown, max = MAX_NOTE_CHARS): string {
  const text = typeof s === "string" ? s : JSON.stringify(s ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function navNotes(runId: string, relpath: string | null): string[] {
  const rel = relpath ?? path.join("navigation", runId, "report.json");
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(getConfig().artifactsDir, rel);
    const report = JSON.parse(fs.readFileSync(abs, "utf8")) as { notes?: unknown };
    return Array.isArray(report.notes)
      ? (report.notes as unknown[]).slice(-MAX_NAV_NOTES).map((n) => clip(n))
      : [];
  } catch {
    return []; // a missing report is not an error — the DB row still stands
  }
}

/**
 * Build the supervisor's job context for one application. Fails open to
 * the bare {url} when the application is unknown — the supervisor still
 * runs, it just knows less (exactly the pre-2026-09-07 behaviour).
 */
export function buildSupervisorJobContext(
  db: Db,
  applicationId: string,
  url: string,
): SupervisorJobContext {
  const job = db
    .prepare(
      `SELECT a.attempt, j.company, j.role, j.location, j.employment_type, j.source_ats,
              j.description_text, json_extract(j.raw_json, '$.job_url') AS posting_url
       FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    )
    .get(applicationId) as
    | {
        attempt: number;
        company: string | null;
        role: string | null;
        location: string | null;
        employment_type: string | null;
        source_ats: string | null;
        description_text: string | null;
        posting_url: string | null;
      }
    | undefined;
  if (!job) return { url };

  const priorNav = (
    db
      .prepare(
        `SELECT created_at, run_id, method, wall, end_host, resolved, report_artifact_relpath
         FROM navigation_attempts WHERE application_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(applicationId, MAX_PRIOR_NAV) as Array<{
      created_at: string;
      run_id: string;
      method: string | null;
      wall: string;
      end_host: string | null;
      resolved: number;
      report_artifact_relpath: string | null;
    }>
  ).map((r) => ({
    at: r.created_at,
    method: r.method,
    wall: r.wall,
    end_host: r.end_host,
    resolved: r.resolved === 1,
    notes: navNotes(r.run_id, r.report_artifact_relpath),
  }));

  const events = (
    db
      .prepare(
        `SELECT previous_state, next_state, reason, timestamp
         FROM application_events WHERE application_id = ?
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(applicationId, MAX_EVENTS) as Array<{
      previous_state: string | null;
      next_state: string;
      reason: string | null;
      timestamp: string;
    }>
  ).map((e) => ({
    from: e.previous_state,
    to: e.next_state,
    reason: clip(e.reason ?? ""),
    at: e.timestamp,
  }));

  const context: SupervisorJobContext = {
    ...(job.company ? { company: job.company } : {}),
    ...(job.role ? { role: job.role } : {}),
    url,
    location: job.location,
    employment_type: job.employment_type,
    source_ats: job.source_ats,
    posting_url: job.posting_url,
    description_excerpt: job.description_text
      ? clip(job.description_text.replace(/\s+/g, " ").trim(), MAX_DESCRIPTION_CHARS)
      : null,
    attempt: job.attempt,
    prior_navigation: priorNav,
    recent_events: events,
  };
  return redactObject(context) as SupervisorJobContext;
}
