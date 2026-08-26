/**
 * Greenhouse's PUBLIC job-board API as an authoritative answer-space
 * source.
 *
 * The DOM harvest (ats/shared/optionHarvest.ts) works on any board, but it
 * pays for that generality: it opens each control one at a time, and a
 * virtualized React-select menu only renders its first window, so a long
 * list can be read incomplete. Greenhouse publishes the same information
 * as JSON, for free, in one unauthenticated request:
 *
 *   GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=true
 *
 * Verified live 2026-08-14 against the exact form that failed (Appian
 * 8041237, run aef17b3e). The payload named all 19 questions and every
 * option, including the four that the run left blank — and it corrected
 * our reading of the failure:
 *
 *   "Are you currently a member of any university organizations, such as
 *    clubs o…"                                   → ["Yes", "No"]
 *   "Are you currently pursuing a Major in one of the following
 *    disciplines: Com…"                          → ["Yes", "No"]
 *   "Have you ever held … any leadership roles…"  → ["Yes", "No"]
 *   "Have you completed at least one internship…" → ["Yes", "No"]
 *   "How did you hear about Appian?"              → 22 options
 *
 * The organizations question is a YES/NO, not a list of organizations. So
 * the planner did not merely pick a wrong organization — it typed an
 * organization name ("Summer Atlantic Capital") into a two-option dropdown
 * whose answer was "Yes". No answer bank could have fixed that; only
 * showing the model the option list can, which is what this and the DOM
 * harvest both do.
 *
 * Read-only, unauthenticated, and fail-open: any error (offline, board
 * moved, shape changed) returns null and the DOM harvest carries the load
 * exactly as before. This never writes and never fills — it only supplies
 * the option lists the existing verbatim-validated tiers choose from.
 */

export type GreenhouseQuestion = {
  label: string;
  required: boolean;
  /** Empty for free-text controls — an OPEN answer space. */
  options: string[];
};

export type GreenhouseQuestionSet = {
  board: string;
  job_id: string;
  questions: GreenhouseQuestion[];
  /** Normalized label → options, for merging onto discovered fields. */
  byLabel: Map<string, string[]>;
};

const API_BASE = "https://boards-api.greenhouse.io/v1/boards";
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Board token + job id from any Greenhouse application URL shape:
 *   job-boards.greenhouse.io/appian/jobs/8041237
 *   boards.greenhouse.io/appian/jobs/8041237
 *   boards.greenhouse.io/embed/job_app?for=appian&token=8041237
 */
export function parseGreenhouseBoardRef(
  rawUrl: string,
): { board: string; jobId: string } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)greenhouse\.io$/i.test(url.hostname)) return null;

  const embedBoard = url.searchParams.get("for");
  const embedToken = url.searchParams.get("token");
  if (embedBoard && embedToken && /^\d+$/.test(embedToken)) {
    return { board: embedBoard, jobId: embedToken };
  }

  const m = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (m && m[1] && m[2] && m[1] !== "embed") {
    return { board: m[1], jobId: m[2] };
  }
  return null;
}

/** Same normalization the field matcher uses, so labels line up. */
export function normalizeQuestionLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/** Narrow the API payload without trusting its shape. */
export function parseQuestionsPayload(
  payload: unknown,
): GreenhouseQuestion[] {
  if (!payload || typeof payload !== "object") return [];
  const questions = (payload as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  const out: GreenhouseQuestion[] = [];
  for (const q of questions) {
    if (!q || typeof q !== "object") continue;
    const label = (q as { label?: unknown }).label;
    if (typeof label !== "string" || label.trim() === "") continue;
    const required = (q as { required?: unknown }).required === true;
    const fields = (q as { fields?: unknown }).fields;
    const options: string[] = [];
    if (Array.isArray(fields)) {
      for (const f of fields) {
        const values = (f as { values?: unknown }).values;
        if (!Array.isArray(values)) continue;
        for (const v of values) {
          const vl = (v as { label?: unknown }).label;
          if (typeof vl === "string" && vl.trim() !== "") {
            options.push(vl.trim());
          }
        }
      }
    }
    out.push({ label: label.trim(), required, options });
  }
  return out;
}

/**
 * G2: one run fetches the same posting's questions at plan time and again
 * at the pre-submit gate. The payload is static for a posting, so
 * successful reads memoize for the process lifetime — the gate never pays
 * a second network round-trip, and a gate-time network blip cannot lose
 * information the plan already had. Failures are NOT memoized (a plan-time
 * blip must not blind the gate). Injected fetchImpl (tests) bypasses the
 * memo entirely. Bounded, not unbounded: oldest entry evicted past the cap.
 */
const questionSetMemo = new Map<string, GreenhouseQuestionSet>();
const MEMO_MAX_ENTRIES = 50;

/** The labels the board itself declares required — [] for null (fail-open). */
export function requiredQuestionLabels(
  set: GreenhouseQuestionSet | null,
): string[] {
  if (!set) return [];
  return set.questions.filter((q) => q.required).map((q) => q.label);
}

/**
 * Fetch the board's declared questions and their option lists. Returns
 * null for a non-Greenhouse URL, a non-200, or any error — every caller
 * treats null as "no extra information" and proceeds.
 */
export async function fetchGreenhouseQuestions(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GreenhouseQuestionSet | null> {
  const ref = parseGreenhouseBoardRef(rawUrl);
  if (!ref) return null;
  const endpoint = `${API_BASE}/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.jobId)}?questions=true`;
  const useMemo = fetchImpl === fetch;
  if (useMemo) {
    const hit = questionSetMemo.get(endpoint);
    if (hit) return hit;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(endpoint, { signal: controller.signal });
    if (!res.ok) return null;
    const questions = parseQuestionsPayload(await res.json());
    if (questions.length === 0) return null;
    const byLabel = new Map<string, string[]>();
    for (const q of questions) {
      if (q.options.length === 0) continue;
      byLabel.set(normalizeQuestionLabel(q.label), q.options);
    }
    const set: GreenhouseQuestionSet = {
      board: ref.board,
      job_id: ref.jobId,
      questions,
      byLabel,
    };
    if (useMemo) {
      if (questionSetMemo.size >= MEMO_MAX_ENTRIES) {
        const oldest = questionSetMemo.keys().next().value;
        if (oldest !== undefined) questionSetMemo.delete(oldest);
      }
      questionSetMemo.set(endpoint, set);
    }
    return set;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
