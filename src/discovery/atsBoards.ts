/**
 * D-rev / D1a: structured job enumeration from the ATSes' OWN public
 * board APIs.
 *
 * JobRight is one lens on the market; the boards themselves are the
 * source of truth. All four Tier-1 ATSes publish every open posting on a
 * company's board as unauthenticated JSON — the same documents their own
 * public career pages render from:
 *
 *   greenhouse  GET boards-api.greenhouse.io/v1/boards/{token}/jobs
 *   lever       GET api.lever.co/v0/postings/{token}?mode=json
 *   ashby       GET api.ashbyhq.com/posting-api/job-board/{token}
 *   workable    GET apply.workable.com/api/v1/widget/accounts/{token}
 *
 * One GET per board replaces a browser session per posting: no rendering,
 * no scraping heuristics, no ToS gray zone — these endpoints exist to be
 * consumed. Everything here is READ-ONLY against the network; turning a
 * fetched posting into a queued application happens in atsDiscovery.ts,
 * behind ATS_DISCOVERY_ENABLED.
 *
 * Fail-open per board: a moved board, an offline network, or a changed
 * payload shape yields an error string on that board's result and an
 * empty job list — never a throw that kills the sweep. Attempt cap is 1
 * request per board per run (no retry loop); a per-host throttle spaces
 * consecutive requests so a long registry cannot hammer one API.
 */

export type BoardAts = "greenhouse" | "lever" | "ashby" | "workable";

export type AtsBoardRef = {
  ats: BoardAts;
  /** The board token / site slug / account subdomain the ATS keys on. */
  token: string;
};

export type BoardJob = {
  ats: BoardAts;
  board: string;
  /** The ATS's own posting id, when the payload carries one. */
  external_id: string | null;
  title: string;
  location: string | null;
  department: string | null;
  /** The candidate-facing application URL — what the pipeline navigates to. */
  apply_url: string;
  posted_at: string | null;
};

export type BoardFetchResult = {
  ref: AtsBoardRef;
  ok: boolean;
  jobs: BoardJob[];
  error: string | null;
};

const REQUEST_TIMEOUT_MS = 10_000;
/** Runaway guard — one board should not flood the queue pipeline. */
const MAX_JOBS_PER_BOARD = 500;

/**
 * Parse "greenhouse:appian" style refs, plus the board URLs an operator
 * is more likely to have in the clipboard.
 */
export function parseAtsBoardRef(raw: string): AtsBoardRef | null {
  const input = raw.trim();
  if (!input) return null;

  const m = input.match(/^(greenhouse|lever|ashby|workable):(.+)$/i);
  if (m) {
    const token = sanitizeToken(m[2]!);
    return token ? { ats: m[1]!.toLowerCase() as BoardAts, token } : null;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter((s) => s.length > 0);
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const token = sanitizeToken(seg[0] === "embed" ? "" : (seg[0] ?? ""));
    return token ? { ats: "greenhouse", token } : null;
  }
  if (host === "jobs.lever.co") {
    const token = sanitizeToken(seg[0] ?? "");
    return token ? { ats: "lever", token } : null;
  }
  if (host === "jobs.ashbyhq.com") {
    const token = sanitizeToken(seg[0] ?? "");
    return token ? { ats: "ashby", token } : null;
  }
  if (host === "apply.workable.com") {
    const token = sanitizeToken(seg[0] === "api" ? "" : (seg[0] ?? ""));
    return token ? { ats: "workable", token } : null;
  }
  return null;
}

function sanitizeToken(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  // Board tokens are URL path segments; anything else is a parse error,
  // not something to encode around.
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(token)) return null;
  return token;
}

export function formatBoardRef(ref: AtsBoardRef): string {
  return `${ref.ats}:${ref.token}`;
}

export function boardEndpoint(ref: AtsBoardRef): string {
  const token = encodeURIComponent(ref.token);
  switch (ref.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`;
    case "lever":
      return `https://api.lever.co/v0/postings/${token}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${token}`;
    case "workable":
      return `https://apply.workable.com/api/v1/widget/accounts/${token}`;
  }
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;

/** Narrow each ATS's payload without trusting its shape. */
export function parseBoardPayload(ref: AtsBoardRef, payload: unknown): BoardJob[] {
  const out: BoardJob[] = [];
  const push = (job: Omit<BoardJob, "ats" | "board">): void => {
    if (out.length >= MAX_JOBS_PER_BOARD) return;
    out.push({ ats: ref.ats, board: ref.token, ...job });
  };

  if (ref.ats === "greenhouse") {
    const jobs = (payload as { jobs?: unknown })?.jobs;
    if (!Array.isArray(jobs)) return out;
    for (const j of jobs) {
      const title = text((j as { title?: unknown }).title);
      const url = text((j as { absolute_url?: unknown }).absolute_url);
      if (!title || !url) continue;
      const id = (j as { id?: unknown }).id;
      push({
        external_id:
          typeof id === "number" || typeof id === "string" ? String(id) : null,
        title,
        location: text(
          (j as { location?: { name?: unknown } }).location?.name,
        ),
        department: text(
          (j as { departments?: Array<{ name?: unknown }> }).departments?.[0]
            ?.name,
        ),
        apply_url: url,
        posted_at: text((j as { updated_at?: unknown }).updated_at),
      });
    }
    return out;
  }

  if (ref.ats === "lever") {
    if (!Array.isArray(payload)) return out;
    for (const j of payload) {
      const title = text((j as { text?: unknown }).text);
      const url =
        text((j as { applyUrl?: unknown }).applyUrl) ??
        (text((j as { hostedUrl?: unknown }).hostedUrl)
          ? `${text((j as { hostedUrl?: unknown }).hostedUrl)}/apply`
          : null);
      if (!title || !url) continue;
      const createdAt = (j as { createdAt?: unknown }).createdAt;
      const cats = (j as { categories?: Record<string, unknown> }).categories;
      push({
        external_id: text((j as { id?: unknown }).id),
        title,
        location: text(cats?.["location"]),
        department: text(cats?.["team"]) ?? text(cats?.["department"]),
        apply_url: url,
        posted_at:
          typeof createdAt === "number"
            ? new Date(createdAt).toISOString()
            : null,
      });
    }
    return out;
  }

  if (ref.ats === "ashby") {
    const jobs = (payload as { jobs?: unknown })?.jobs;
    if (!Array.isArray(jobs)) return out;
    for (const j of jobs) {
      if ((j as { isListed?: unknown }).isListed === false) continue;
      const title = text((j as { title?: unknown }).title);
      const url =
        text((j as { applyUrl?: unknown }).applyUrl) ??
        text((j as { jobUrl?: unknown }).jobUrl);
      if (!title || !url) continue;
      push({
        external_id: text((j as { id?: unknown }).id),
        title,
        location: text((j as { location?: unknown }).location),
        department: text((j as { department?: unknown }).department),
        apply_url: url,
        posted_at: text((j as { publishedAt?: unknown }).publishedAt),
      });
    }
    return out;
  }

  // workable widget payload
  const jobs = (payload as { jobs?: unknown })?.jobs;
  if (!Array.isArray(jobs)) return out;
  for (const j of jobs) {
    const title = text((j as { title?: unknown }).title);
    const shortcode = text((j as { shortcode?: unknown }).shortcode);
    const url =
      text((j as { application_url?: unknown }).application_url) ??
      (text((j as { url?: unknown }).url)
        ? `${text((j as { url?: unknown }).url)!.replace(/\/+$/, "")}/apply/`
        : shortcode
          ? `https://apply.workable.com/${ref.token}/j/${shortcode}/apply/`
          : null);
    if (!title || !url) continue;
    const city = text((j as { city?: unknown }).city);
    const country = text((j as { country?: unknown }).country);
    push({
      external_id: shortcode,
      title,
      location: city && country ? `${city}, ${country}` : (city ?? country),
      department: text((j as { department?: unknown }).department),
      apply_url: url,
      posted_at: text((j as { published_on?: unknown }).published_on),
    });
  }
  return out;
}

/** Consecutive requests to the same host wait this long apart. */
const HOST_MIN_INTERVAL_MS = 500;
const lastRequestAt = new Map<string, number>();

async function throttleHost(host: string, intervalMs: number): Promise<void> {
  if (intervalMs <= 0) return;
  const last = lastRequestAt.get(host);
  const now = Date.now();
  if (last !== undefined && now - last < intervalMs) {
    await new Promise((r) => setTimeout(r, intervalMs - (now - last)));
  }
  lastRequestAt.set(host, Date.now());
}

export async function fetchBoardJobs(
  ref: AtsBoardRef,
  options: {
    fetchImpl?: typeof fetch;
    /** Test seam; production callers keep the default spacing. */
    hostIntervalMs?: number;
  } = {},
): Promise<BoardFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = boardEndpoint(ref);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await throttleHost(
      new URL(endpoint).host,
      options.hostIntervalMs ?? HOST_MIN_INTERVAL_MS,
    );
    const res = await fetchImpl(endpoint, { signal: controller.signal });
    if (!res.ok) {
      return {
        ref,
        ok: false,
        jobs: [],
        error: `HTTP ${res.status} from ${new URL(endpoint).host}`,
      };
    }
    const jobs = parseBoardPayload(ref, await res.json());
    return { ref, ok: true, jobs, error: null };
  } catch (err) {
    return {
      ref,
      ok: false,
      jobs: [],
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type DiscoveryTitleFilter = {
  /** Keep a job only if its title contains ANY of these (empty = keep all). */
  include: string[];
  /** Drop a job if its title contains ANY of these. Exclude wins. */
  exclude: string[];
};

export function filterBoardJobs(
  jobs: BoardJob[],
  filter: DiscoveryTitleFilter,
): { kept: BoardJob[]; dropped: number } {
  const inc = filter.include.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const exc = filter.exclude.map((s) => s.trim().toLowerCase()).filter(Boolean);
  const kept = jobs.filter((j) => {
    const t = j.title.toLowerCase();
    if (exc.some((e) => titleHasTerm(t, e))) return false;
    if (inc.length === 0) return true;
    return inc.some((i) => titleHasTerm(t, i));
  });
  return { kept, dropped: jobs.length - kept.length };
}

/**
 * Word-boundary term match: "intern" must not catch "Internal Audit Lead"
 * or "International Accounting". Boundaries are strict on both ends, so
 * "internship" needs its own term — an operator lists both, rather than
 * substring matching silently flooding the queue with wrong roles.
 */
function titleHasTerm(lowerTitle: string, lowerTerm: string): boolean {
  const escaped = lowerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(lowerTitle);
}
