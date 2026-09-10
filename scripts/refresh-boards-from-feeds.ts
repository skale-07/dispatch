/**
 * #230: refresh the ATS board registry from public internship listing feeds.
 *
 * A board registry maintained by hand goes stale the moment a company's
 * hiring moves, and it can only ever contain boards someone thought to add.
 * On night29 a sweep of the curated 47-board registry enqueued 2
 * applications, and 120 hand-guessed candidate slugs yielded 1 more — most
 * were 404s, because a company's board token is not derivable from its name
 * (greenhouse:snowflake, lever:netflix, ashby:xai — all 404).
 *
 * The community internship trackers publish every posting they have seen as
 * `.github/scripts/listings.json`, each row carrying the posting's own
 * `date_posted` and its REAL apply URL. Any apply URL on a Tier-1 board
 * (greenhouse / lever / ashby / workable) names that company's board token
 * exactly. So this reads the feeds, keeps the recent role-fitting US
 * postings, and merges the boards they point at into the registry —
 * discovering tokens instead of guessing them.
 *
 * Nothing downstream changes: `discover:ats --registry` still applies the
 * registry's role terms, the US gate, the 24h posting policy and the
 * per-board cap. The lookback here is for registry MEMBERSHIP only (a board
 * that posted yesterday will post again today); the 24h gate on applying is
 * untouched. Read-only over the network; the only write is the registry.
 *
 * Usage:
 *   npm run boards:refresh                      # report only
 *   npm run boards:refresh -- --write           # merge into the registry
 *   npm run boards:refresh -- --registry <path> --lookback-hours 168
 */
import fs from "node:fs";
import path from "node:path";
import { parseAtsBoardRef, formatBoardRef } from "../src/discovery/atsBoards.js";
import { classifyLocation } from "../src/jobs/locationEligibility.js";

const FEEDS = [
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json",
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
  "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json",
  "https://raw.githubusercontent.com/vanshb03/New-Grad-2027/dev/.github/scripts/listings.json",
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Look back further than the 24h apply policy so a board that posted
 *  yesterday is still in the registry when it posts again today. The 24h
 *  gate itself stays where it belongs — in discovery/worker. */
const BOARD_LOOKBACK_HOURS = Number(argValue("--lookback-hours") ?? 168);
const REGISTRY = path.resolve(argValue("--registry") ?? "private/discovery/boards.json");

type Listing = {
  company_name?: string;
  title?: string;
  url?: string;
  date_posted?: number;
  active?: boolean;
  is_visible?: boolean;
  locations?: string[];
  category?: string;
};

const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8")) as {
  role_terms: string[];
  exclude_terms: string[];
  max_new_per_board: number;
  boards: Array<{ ref: string; company: string; include: string[]; exclude: string[] }>;
};
const roleTerms = registry.role_terms.map((s) => s.toLowerCase());
const excludeTerms = registry.exclude_terms.map((s) => s.toLowerCase());

const now = Date.now() / 1000;
const cutoff = now - BOARD_LOOKBACK_HOURS * 3600;

async function fetchFeed(url: string): Promise<Listing[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as Listing[]) : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function roleFits(title: string): boolean {
  const t = title.toLowerCase();
  if (excludeTerms.some((e) => t.includes(e))) return false;
  return roleTerms.some((r) => t.includes(r));
}

function usOk(locations: string[] | undefined): boolean {
  if (!locations || locations.length === 0) return true;
  // Keep the posting if ANY listed location is not confidently non-US.
  return locations.some((l) => classifyLocation(l).verdict !== "non_us");
}

const seen = new Map<string, { company: string; fresh24: number; recent: number; sample: string }>();
let scanned = 0;
for (const feed of FEEDS) {
  const rows = await fetchFeed(feed);
  for (const row of rows) {
    if (row.active === false || row.is_visible === false) continue;
    if (typeof row.date_posted !== "number" || row.date_posted < cutoff) continue;
    if (typeof row.url !== "string" || typeof row.title !== "string") continue;
    if (!roleFits(row.title)) continue;
    if (!usOk(row.locations)) continue;
    scanned += 1;
    const ref = parseAtsBoardRef(row.url);
    if (!ref) continue;
    const key = formatBoardRef(ref);
    const prev = seen.get(key) ?? {
      company: row.company_name ?? ref.token,
      fresh24: 0,
      recent: 0,
      sample: row.title,
    };
    prev.recent += 1;
    if (now - row.date_posted < 24 * 3600) prev.fresh24 += 1;
    seen.set(key, prev);
  }
}

const existing = new Set(registry.boards.map((b) => b.ref.toLowerCase()));
const additions = [...seen.entries()]
  .filter(([ref]) => !existing.has(ref.toLowerCase()))
  .sort((a, b) => b[1].fresh24 - a[1].fresh24 || b[1].recent - a[1].recent);

console.log(
  JSON.stringify(
    {
      postings_considered: scanned,
      boards_seen: seen.size,
      already_in_registry: seen.size - additions.length,
      additions: additions.length,
      with_fresh_24h: additions.filter(([, v]) => v.fresh24 > 0).length,
    },
    null,
    1,
  ),
);
for (const [ref, v] of additions.slice(0, 60)) {
  console.log(`  ${ref}  fresh24=${v.fresh24} recent=${v.recent}  ${v.company} — ${v.sample.slice(0, 60)}`);
}

if (process.argv.includes("--write")) {
  // Newly-productive boards go FIRST: the sweep's --limit is a cap on new
  // applications, so ordering decides who gets the slots.
  const newEntries = additions.map(([ref, v]) => ({
    ref,
    company: v.company,
    include: ["intern", "new grad", "new-grad", "university", "campus", "graduate", "co-op"],
    exclude: ["senior", "staff", "principal", "manager", "director", "sales", "marketing", "recruiter"],
  }));
  registry.boards = [...newEntries, ...registry.boards];
  fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 1) + "\n", "utf8");
  console.log(`\nwrote ${REGISTRY}: ${registry.boards.length} boards (${newEntries.length} added)`);
}
