import fs from "node:fs";
import path from "node:path";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { redactObject } from "../logging/redaction.js";
import { listOpenReviewItems } from "../queue/reviewItems.js";
import {
  buildFailureSignature,
  hostFromUrl,
} from "./failureSignature.js";

/**
 * Read-only evidence bundle for one failed application: everything the
 * triage prompt (and the decision artifact) sees. Hard truncation caps on
 * every list/string so the prompt stays bounded, and `redactObject` runs
 * over the whole assembly before it can reach a prompt or artifact.
 */

const MAX_EVENTS = 15;
const MAX_NOTES = 12;
const MAX_NOTE_CHARS = 300;
const MAX_BRIEF_ITEMS = 8;

function clip(s: unknown, max = MAX_NOTE_CHARS): string {
  const text = typeof s === "string" ? s : JSON.stringify(s ?? null);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type TriageEvidenceBundle = {
  application_id: string;
  company: string | null;
  role: string | null;
  state: string;
  attempt: number;
  failure_signature: string;
  end_host: string | null;
  recent_events: Array<{ from: string | null; to: string; reason: string; at: string }>;
  nav: {
    wall: string;
    method: string | null;
    notes: string[];
    congruence: unknown;
    duplicates: unknown;
    login_wall: unknown;
    phase_trace: unknown;
  } | null;
  submit: { outcome: string; reason: string; brief_items: unknown[] } | null;
  fill_gate: {
    failure_code: string | null;
    page_class: string | null;
    verify_passed: boolean | null;
  } | null;
  open_review_items: Array<{ kind: string; title: string }>;
  prior_decisions: Array<{
    action: string;
    failure_signature: string;
    outcome_status: string;
    created_at: string;
  }>;
  failed_host_attempts: number;
  prior_agent_leg_decision: boolean;
};

type AppRow = {
  id: string;
  state: string;
  attempt: number;
  company: string | null;
  role: string | null;
  employer_url: string | null;
};

function loadApp(db: Db, applicationId: string): AppRow | null {
  const row = db
    .prepare(
      `SELECT a.id, a.state, a.attempt, j.company, j.role,
              json_extract(j.raw_json, '$.employer_application_url') AS employer_url
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.id = ?`,
    )
    .get(applicationId) as AppRow | undefined;
  return row ?? null;
}

function loadNavReport(db: Db, applicationId: string) {
  const nav = db
    .prepare(
      `SELECT run_id, method, wall, end_host, report_artifact_relpath
       FROM navigation_attempts WHERE application_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(applicationId) as
    | { run_id: string; method: string | null; wall: string; end_host: string | null; report_artifact_relpath: string | null }
    | undefined;
  if (!nav) return { nav: null, endHost: null };

  let report: Record<string, unknown> = {};
  const relpath =
    nav.report_artifact_relpath ??
    path.join("navigation", nav.run_id, "report.json");
  try {
    const abs = path.isAbsolute(relpath)
      ? relpath
      : path.join(getConfig().artifactsDir, relpath);
    report = JSON.parse(fs.readFileSync(abs, "utf8")) as Record<string, unknown>;
  } catch {
    // Missing/corrupt report is evidence too — proceed with the DB row.
  }
  const notes = Array.isArray(report.notes)
    ? (report.notes as unknown[]).slice(-MAX_NOTES).map((n) => clip(n))
    : [];
  return {
    endHost: nav.end_host,
    nav: {
      wall: nav.wall,
      method: nav.method,
      notes,
      congruence: report.congruence ?? null,
      duplicates: report.duplicates ?? null,
      login_wall: report.login_wall ?? null,
      phase_trace: report.phase_trace ?? null,
    },
  };
}

function loadSubmit(db: Db, applicationId: string) {
  const row = db
    .prepare(
      `SELECT outcome, reason, report_artifact_relpath
       FROM submit_attempts WHERE application_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(applicationId) as
    | { outcome: string; reason: string | null; report_artifact_relpath: string | null }
    | undefined;
  if (!row) return null;
  let briefItems: unknown[] = [];
  try {
    if (row.report_artifact_relpath) {
      const abs = path.isAbsolute(row.report_artifact_relpath)
        ? row.report_artifact_relpath
        : path.join(getConfig().artifactsDir, row.report_artifact_relpath);
      const report = JSON.parse(fs.readFileSync(abs, "utf8")) as {
        operator_brief?: { items?: unknown[] };
      };
      briefItems = (report.operator_brief?.items ?? []).slice(0, MAX_BRIEF_ITEMS);
    }
  } catch {
    // brief unavailable — the outcome/reason row still stands.
  }
  return {
    outcome: row.outcome,
    reason: clip(row.reason ?? ""),
    brief_items: briefItems,
  };
}

function loadFillGate(db: Db, applicationId: string) {
  const row = db
    .prepare(
      `SELECT verify_passed, report_artifact_relpath FROM fill_runs
       WHERE application_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(applicationId) as
    | { verify_passed: number | null; report_artifact_relpath: string | null }
    | undefined;
  if (!row) return null;
  let failureCode: string | null = null;
  let pageClass: string | null = null;
  try {
    if (row.report_artifact_relpath) {
      const abs = path.isAbsolute(row.report_artifact_relpath)
        ? row.report_artifact_relpath
        : path.join(getConfig().artifactsDir, row.report_artifact_relpath);
      const report = JSON.parse(fs.readFileSync(abs, "utf8")) as {
        gate?: { failure_code?: string | null; page_class?: string | null };
      };
      failureCode = report.gate?.failure_code ?? null;
      pageClass = report.gate?.page_class ?? null;
    }
  } catch {
    // gate detail unavailable — verify_passed still tells the story.
  }
  return {
    failure_code: failureCode,
    page_class: pageClass,
    verify_passed: row.verify_passed === null ? null : row.verify_passed === 1,
  };
}

export function buildEvidenceBundle(
  db: Db,
  applicationId: string,
  input: { stopReason?: string | null } = {},
): TriageEvidenceBundle | null {
  const app = loadApp(db, applicationId);
  if (!app) return null;

  const events = (
    db
      .prepare(
        `SELECT previous_state, next_state, reason, timestamp
         FROM application_events WHERE application_id = ?
         ORDER BY timestamp DESC LIMIT ?`,
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

  const { nav, endHost } = loadNavReport(db, applicationId);
  const submit = loadSubmit(db, applicationId);
  const fillGate = loadFillGate(db, applicationId);
  const host = endHost ?? hostFromUrl(app.employer_url);

  const stopReason =
    input.stopReason ??
    events.find((e) => e.reason.length > 0)?.reason ??
    null;
  const signature = buildFailureSignature({
    endState: app.state,
    wall: nav === null || nav.wall === "none" ? null : nav.wall,
    stopReason,
    host,
  });

  const openItems = listOpenReviewItems(db)
    .filter((i) => i.application_id === applicationId)
    .map((i) => ({ kind: i.kind as string, title: clip(i.title, 160) }));

  const priorDecisions = (
    db
      .prepare(
        `SELECT action, failure_signature, outcome_status, created_at
         FROM triage_decisions WHERE application_id = ?
         ORDER BY created_at DESC LIMIT 10`,
      )
      .all(applicationId) as Array<{
      action: string;
      failure_signature: string;
      outcome_status: string;
      created_at: string;
    }>
  ).map((d) => ({
    action: d.action,
    failure_signature: d.failure_signature,
    outcome_status: d.outcome_status,
    created_at: d.created_at,
  }));

  const failedHostAttempts = host
    ? (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM navigation_attempts
             WHERE end_host = ? AND resolved = 0`,
          )
          .get(host) as { n: number }
      ).n
    : 0;

  const bundle: TriageEvidenceBundle = {
    application_id: app.id,
    company: app.company,
    role: app.role,
    state: app.state,
    attempt: Number(app.attempt ?? 1),
    failure_signature: signature,
    end_host: host,
    recent_events: events,
    nav,
    submit,
    fill_gate: fillGate,
    open_review_items: openItems,
    prior_decisions: priorDecisions,
    failed_host_attempts: failedHostAttempts,
    prior_agent_leg_decision: priorDecisions.some(
      (d) => d.action === "engage_agent_leg",
    ),
  };
  return redactObject(bundle) as TriageEvidenceBundle;
}
