import { fetchBoardJobs, type BoardAts, type BoardJob } from "../discovery/atsBoards.js";
import { checkUrlCongruence } from "./congruence.js";

/**
 * Aggregator → employer-board hop (#196, live Coinbase 2026-09-08).
 *
 * JobRight's own Apply for a posting can land on a consumer aggregator's
 * job page (linkedin.com/jobs/view, indeed, glassdoor …). That page is a
 * REPOST: its "Easy Apply" is the aggregator's form, not the employer's,
 * and the fill gate rightly refuses it — so the app looped
 * store-aggregator-URL → NAVIGATION_INCOMPLETE → requeue. The employer
 * usually runs a public board with a JSON API (Greenhouse / Lever /
 * Ashby) that lists the same posting. This module finds it
 * deterministically: candidate board slugs from the company name, one
 * read-only GET per (ATS, slug), and the posting whose title matches the
 * job's role — the exact route `discover:ats` already submits through.
 *
 * No model, no browser. Bounded: ≤ MAX_FETCHES requests, one wall-clock
 * deadline. Fail-closed on ambiguity: two postings with the role's title
 * and no location tie-break ⇒ no hop; a board URL whose hostname names a
 * DIFFERENT company ⇒ no hop.
 */

const CONSUMER_AGGREGATOR_HOST_RE =
  /(^|\.)(linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|dice\.com|builtin\.com|wellfound\.com|simplyhired\.com|monster\.com|lensa\.com|jobright\.ai)$/i;

/** A job page on a consumer aggregator — a repost, never the employer's own application. */
export function isConsumerAggregatorUrl(url: string): boolean {
  try {
    return CONSUMER_AGGREGATOR_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** ATSes with a public, unauthenticated board API the pipeline already fills through. */
const HOP_ATS: readonly BoardAts[] = ["greenhouse", "lever", "ashby"];
const MAX_SLUGS = 3;
/** Attempt cap: 3 ATSes × 3 slugs. */
export const MAX_HOP_FETCHES = 9;
const HOP_DEADLINE_MS = 20_000;

const LEGAL_SUFFIX_RE =
  /\b(inc|incorporated|llc|corp|corporation|ltd|limited|plc|co|company|holdings|group)\b/g;

/**
 * Board slugs a company is likely keyed under: "Jump Trading" →
 * jumptrading, jump-trading, jump. Legal suffixes dropped. The lone first
 * word is only tried for multi-word names and only when it is long enough
 * to be a name rather than an article.
 */
export function boardSlugCandidates(company: string): string[] {
  const words = company
    .toLowerCase()
    .replace(/[’'.,&]/g, " ")
    .replace(LEGAL_SUFFIX_RE, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return [];
  const out: string[] = [];
  const push = (s: string): void => {
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };
  push(words.join(""));
  push(words.join("-"));
  if (words.length > 1 && words[0]!.length >= 4) push(words[0]!);
  return out.slice(0, MAX_SLUGS);
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const LOCATION_STOPWORDS = new Set([
  "hybrid", "remote", "onsite", "on", "site", "united", "states", "us", "usa",
  "america", "or", "and", "the", "of", "office", "in",
]);
const locationTokens = (s: string | null): Set<string> =>
  new Set(norm(s ?? "").split(" ").filter((t) => t.length >= 2 && !LOCATION_STOPWORDS.has(t)));

export type BoardMatch = { job: BoardJob; basis: string };

/**
 * The one posting on a board that IS this job. Exact normalized title
 * first; a unique containment match second; several exact titles are
 * tie-broken by a shared location token (city/state) and otherwise
 * refused — the caller must never guess between two "Software Engineer"
 * reqs.
 */
export function matchBoardJob(
  jobs: readonly BoardJob[],
  job: { role: string; location: string | null },
): BoardMatch | { job: null; reason: string } {
  const role = norm(job.role);
  if (!role) return { job: null, reason: "job has no role on record" };
  const exact = jobs.filter((j) => norm(j.title) === role);
  if (exact.length === 1) return { job: exact[0]!, basis: "exact title" };
  if (exact.length === 0) {
    const loose = jobs.filter((j) => {
      const t = norm(j.title);
      return t.length >= 6 && (t.includes(role) || role.includes(t));
    });
    if (loose.length === 1) return { job: loose[0]!, basis: "title contains" };
    return {
      job: null,
      reason:
        loose.length === 0
          ? `no posting titled "${job.role}" among ${jobs.length}`
          : `${loose.length} postings loosely match "${job.role}" — ambiguous`,
    };
  }
  const want = locationTokens(job.location);
  if (want.size > 0) {
    const byCity = exact.filter((j) => {
      const have = locationTokens(j.location);
      for (const t of want) if (have.has(t)) return true;
      return false;
    });
    if (byCity.length === 1) return { job: byCity[0]!, basis: "exact title + location" };
  }
  return {
    job: null,
    reason: `${exact.length} postings titled "${job.role}" (${exact
      .map((j) => j.location ?? "no location")
      .join("; ")}) — ambiguous`,
  };
}

export type EmployerBoardHop = {
  url: string;
  ats: BoardAts;
  board: string;
  external_id: string | null;
  title: string;
  location: string | null;
  basis: string;
};

export type EmployerBoardHopResult = {
  hit: EmployerBoardHop | null;
  notes: string[];
  fetches: number;
};

/**
 * Find this job on the employer's own public board. Read-only; bounded;
 * returns null (with the reasons) rather than a guess.
 */
export async function hopToEmployerBoard(input: {
  company: string | null;
  role: string | null;
  location: string | null;
  fetchImpl?: typeof fetch;
  /** Test seam; production keeps the board module's default spacing. */
  hostIntervalMs?: number;
  deadlineMs?: number;
}): Promise<EmployerBoardHopResult> {
  const notes: string[] = [];
  let fetches = 0;
  if (!input.company || !input.role) {
    notes.push("board hop: job has no company/role on record — skipped");
    return { hit: null, notes, fetches };
  }
  const slugs = boardSlugCandidates(input.company);
  if (slugs.length === 0) {
    notes.push(`board hop: no board slug derivable from "${input.company}"`);
    return { hit: null, notes, fetches };
  }
  const deadline = Date.now() + (input.deadlineMs ?? HOP_DEADLINE_MS);
  for (const ats of HOP_ATS) {
    for (const slug of slugs) {
      if (fetches >= MAX_HOP_FETCHES || Date.now() > deadline) {
        notes.push(`board hop: budget exhausted (${fetches} requests)`);
        return { hit: null, notes, fetches };
      }
      fetches++;
      const r = await fetchBoardJobs(
        { ats, token: slug },
        {
          ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
          ...(input.hostIntervalMs !== undefined ? { hostIntervalMs: input.hostIntervalMs } : {}),
        },
      );
      if (!r.ok || r.jobs.length === 0) continue;
      // A board that answers WITH postings is this slug's board — the
      // remaining slugs on this ATS are alternative spellings, not
      // alternative employers. Decide here.
      const m = matchBoardJob(r.jobs, { role: input.role, location: input.location });
      if (!m.job) {
        notes.push(`board hop: ${ats}:${slug} answered ${r.jobs.length} postings — ${m.reason}`);
        break;
      }
      const cong = checkUrlCongruence(input.company, m.job.apply_url);
      if (cong.verdict === "mismatch") {
        notes.push(
          `board hop: ${ats}:${slug} has "${m.job.title}" but its URL names "${cong.slug ?? "?"}", not ${input.company} — refused`,
        );
        break;
      }
      notes.push(
        `board hop: ${ats}:${slug} lists "${m.job.title}" (${m.job.location ?? "no location"}; ${m.basis}) — employer's own route taken over the aggregator`,
      );
      return {
        hit: {
          url: m.job.apply_url,
          ats,
          board: slug,
          external_id: m.job.external_id,
          title: m.job.title,
          location: m.job.location,
          basis: m.basis,
        },
        notes,
        fetches,
      };
    }
  }
  notes.push(
    `board hop: no public ${HOP_ATS.join("/")} board found for "${input.company}" (${slugs.join(", ")}; ${fetches} requests)`,
  );
  return { hit: null, notes, fetches };
}
