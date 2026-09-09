/**
 * D-rev / D2: turn fetched board postings into queued applications.
 *
 * This is where discovery becomes a MUTATION (of the local queue only —
 * nothing on the network is ever written), so the whole run sits behind
 * ATS_DISCOVERY_ENABLED, fail closed, checked before the first request.
 *
 * Provenance is the trust model, same as manual enqueue: the apply URL
 * comes from the ATS's own board API for a board the operator listed, is
 * re-validated by detectAtsFromUrl at ingestion, and is stored as
 * employer_application_url so the pipeline can go straight to the form —
 * no JobRight navigation leg needed for these jobs. Every new application
 * walks the same legal state edges manual enqueue walks; dedupe is the
 * existing fingerprint + one-active-per-job machinery, so re-running a
 * sweep is idempotent and a board job that matches an already-submitted
 * application is blocked, not re-applied.
 */
import fs from "node:fs";
import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { upsertJobByFingerprint } from "../jobs/repository.js";
import { getOrCreateApplicationForJob } from "../jobs/applicationDedupe.js";
import { transitionApplication } from "../queue/stateMachine.js";
import { detectAtsFromUrl } from "../ats/shared/urlValidationDispatch.js";
import { findApplicationsWithEmployerUrl } from "../navigation/congruence.js";
import { classifyLocation } from "../jobs/locationEligibility.js";
import { judgePostingAge, MAX_POSTING_AGE_HOURS } from "../jobs/postingAge.js";
import {
  fetchBoardJobs,
  filterBoardJobs,
  formatBoardRef,
  parseAtsBoardRef,
  type AtsBoardRef,
  type BoardFetchResult,
  type DiscoveryTitleFilter,
} from "./atsBoards.js";

/** A registry cannot sweep more boards than this in one run. */
const MAX_BOARDS_PER_RUN = 50;
/** Default cap on NEW applications one sweep may create. */
const DEFAULT_MAX_NEW_APPLICATIONS = 25;

export type BoardRegistryEntry = {
  ref: AtsBoardRef;
  /** Display company name for the queue; falls back to the board token. */
  company: string;
  include: string[];
  exclude: string[];
};

export type BoardRegistryLoad = {
  entries: BoardRegistryEntry[];
  errors: string[];
  /**
   * #209 (day28): registry-wide role fit — a title must contain one of
   * these (word-boundary) on top of each board's own include/exclude.
   * `include: ["intern"]` alone let one Greenhouse board hand the queue
   * nine finance/ops internships in a single sweep. Empty = no gate.
   */
  roleTerms: string[];
  /**
   * #209: registry-wide drops applied to every board (word-boundary,
   * exclude wins) — "People Analytics Intern" passed `role_terms` on
   * "analytics", "User Research Intern" on "research".
   */
  excludeTerms: string[];
  /** #180/#209: max NEW applications one board may add per sweep (null = unlimited). */
  maxNewPerBoard: number | null;
};

/**
 * Operator-reviewed board registry (D1b's import lands into this file):
 *   { "boards": [ { "ref": "greenhouse:appian", "company": "Appian",
 *                   "include": ["intern"], "exclude": ["senior"] } ] }
 * Lives under private/ by default — a list of watched employers is the
 * operator's data, not the repo's.
 */
export function loadBoardRegistry(filePath: string): BoardRegistryLoad {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return {
      entries: [],
      errors: [
        `registry unreadable at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ],
      roleTerms: [],
      excludeTerms: [],
      maxNewPerBoard: null,
    };
  }
  const boards = (parsed as { boards?: unknown })?.boards;
  if (!Array.isArray(boards)) {
    return { entries: [], errors: [`registry has no "boards" array`], roleTerms: [], excludeTerms: [], maxNewPerBoard: null };
  }
  const top = parsed as { role_terms?: unknown; exclude_terms?: unknown; max_new_per_board?: unknown };
  const termList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  const roleTerms = termList(top.role_terms);
  const excludeTerms = termList(top.exclude_terms);
  const maxNewPerBoard =
    typeof top.max_new_per_board === "number" && Number.isFinite(top.max_new_per_board) && top.max_new_per_board > 0
      ? Math.floor(top.max_new_per_board)
      : null;
  const entries: BoardRegistryEntry[] = [];
  for (const [i, b] of boards.entries()) {
    const rawRef = (b as { ref?: unknown }).ref;
    const ref = typeof rawRef === "string" ? parseAtsBoardRef(rawRef) : null;
    if (!ref) {
      errors.push(`boards[${i}]: unparseable ref ${JSON.stringify(rawRef)}`);
      continue;
    }
    const company = (b as { company?: unknown }).company;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    entries.push({
      ref,
      company:
        typeof company === "string" && company.trim() !== ""
          ? company.trim()
          : ref.token,
      include: strings((b as { include?: unknown }).include),
      exclude: strings((b as { exclude?: unknown }).exclude),
    });
  }
  return { entries, errors, roleTerms, excludeTerms, maxNewPerBoard };
}

export type DiscoveredApplication = {
  board: string;
  company: string;
  role: string;
  apply_url: string;
  outcome: "enqueued" | "reused" | "blocked" | "capped" | "rejected_url" | "stale";
  application_id: string | null;
  state: string | null;
  detail: string | null;
};

export type AtsDiscoveryReport = {
  enabled: true;
  boards: Array<{
    ref: string;
    company: string;
    ok: boolean;
    error: string | null;
    fetched: number;
    filtered_out: number;
    considered: number;
    /** Postings older than the 24h cap (#199), skipped before enqueue. */
    stale: number;
  }>;
  enqueued: number;
  reused: number;
  blocked: number;
  capped: number;
  stale: number;
  max_new_applications: number;
  applications: DiscoveredApplication[];
  notes: string[];
};

export type AtsDiscoveryDeps = {
  fetchBoard?: typeof fetchBoardJobs;
};

export async function runAtsBoardDiscovery(input: {
  db: Db;
  entries: BoardRegistryEntry[];
  /** Extra title filter ANDed onto every entry's own (CLI --match/--drop). */
  globalFilter?: DiscoveryTitleFilter;
  maxNewApplications?: number;
  /** #209: title must contain ANY of these (word-boundary), on top of include/exclude. */
  roleTerms?: string[];
  /** #180/#209: cap on NEW applications per board per sweep. */
  maxNewPerBoard?: number;
  deps?: AtsDiscoveryDeps;
}): Promise<AtsDiscoveryReport> {
  const cfg = getConfig();
  if (!cfg.atsDiscoveryEnabled) {
    throw new Error(
      "ATS_DISCOVERY_ENABLED is not enabled — board-API discovery creates queue entries and is off by default (.env)",
    );
  }
  if (input.entries.length === 0) {
    throw new Error("ats discovery needs at least one board ref");
  }
  const entries = input.entries.slice(0, MAX_BOARDS_PER_RUN);
  const fetchBoard = input.deps?.fetchBoard ?? fetchBoardJobs;
  const maxNew = Math.max(
    1,
    Math.floor(input.maxNewApplications ?? DEFAULT_MAX_NEW_APPLICATIONS),
  );
  const roleTerms = (input.roleTerms ?? []).map((s) => s.trim()).filter(Boolean);
  const maxPerBoard =
    input.maxNewPerBoard !== undefined && Number.isFinite(input.maxNewPerBoard) && input.maxNewPerBoard > 0
      ? Math.floor(input.maxNewPerBoard)
      : null;

  const report: AtsDiscoveryReport = {
    enabled: true,
    boards: [],
    enqueued: 0,
    reused: 0,
    blocked: 0,
    capped: 0,
    stale: 0,
    max_new_applications: maxNew,
    applications: [],
    notes: [],
  };
  if (input.entries.length > entries.length) {
    report.notes.push(
      `registry truncated to ${MAX_BOARDS_PER_RUN} boards (${input.entries.length} listed)`,
    );
  }

  for (const entry of entries) {
    const fetched: BoardFetchResult = await fetchBoard(entry.ref);
    const merged: DiscoveryTitleFilter = {
      include: [...entry.include, ...(input.globalFilter?.include ?? [])],
      exclude: [...entry.exclude, ...(input.globalFilter?.exclude ?? [])],
    };
    const first = filterBoardJobs(fetched.jobs, merged);
    // #209: the registry-wide role gate is ANDed after include/exclude —
    // "intern" says it is an internship, the role terms say it is one the
    // operator applies to (software/data/AI …), never finance/ops.
    const roleFit =
      roleTerms.length > 0
        ? filterBoardJobs(first.kept, { include: roleTerms, exclude: [] })
        : { kept: first.kept, dropped: 0 };
    const titleKept = roleFit.kept;
    const dropped = first.dropped + roleFit.dropped;
    if (roleFit.dropped > 0) {
      report.notes.push(
        `${formatBoardRef(entry.ref)}: ${roleFit.dropped} posting(s) outside role terms skipped (#209)`,
      );
    }
    let enqueuedThisBoard = 0;
    // Operator directive 2026-09-07 ("US only"): six non-US Stripe intern
    // postings were submitted because the sweep only looked at titles. A
    // confident non-US location drops the posting here; unknown passes.
    const nonUs = titleKept.filter(
      (j) => classifyLocation(j.location).verdict === "non_us",
    );
    const kept = titleKept.filter((j) => !nonUs.includes(j));
    if (nonUs.length > 0) {
      report.notes.push(
        `${formatBoardRef(entry.ref)}: ${nonUs.length} non-US posting(s) skipped — ` +
          nonUs
            .slice(0, 6)
            .map((j) => `"${j.title.slice(0, 40)}" (${j.location ?? "?"})`)
            .join(", ") +
          (nonUs.length > 6 ? ", …" : ""),
      );
    }
    let stale = 0;
    const boardRow = {
      ref: formatBoardRef(entry.ref),
      company: entry.company,
      ok: fetched.ok,
      error: fetched.error,
      fetched: fetched.jobs.length,
      filtered_out: dropped + nonUs.length,
      considered: kept.length,
      stale: 0,
    };
    report.boards.push(boardRow);

    for (const job of kept) {
      // #199 (operator directive 2026-09-08) applies to every discovery
      // source: a board posting whose own timestamp is older than the cap
      // is not enqueued. Boards give an absolute time (Greenhouse
      // `updated_at` is the closest it exposes); a missing one is unknown
      // and passes, same fail-open rule as the JobRight side.
      const age = judgePostingAge({
        descriptionText: null,
        jobCreatedAt: null,
        postedAt: job.posted_at,
      });
      if (age.stale) {
        stale += 1;
        report.applications.push({
          board: formatBoardRef(entry.ref),
          company: entry.company,
          role: job.title,
          apply_url: job.apply_url,
          outcome: "stale",
          application_id: null,
          state: null,
          detail: age.reason,
        });
        continue;
      }
      if (report.enqueued >= maxNew) {
        report.capped += 1;
        report.applications.push({
          board: formatBoardRef(entry.ref),
          company: entry.company,
          role: job.title,
          apply_url: job.apply_url,
          outcome: "capped",
          application_id: null,
          state: null,
          detail: `new-application cap (${maxNew}) reached — re-run to continue`,
        });
        continue;
      }
      // #180/#209: one board must not monopolise the sweep (Stripe took
      // 7/8 on night26, Coinbase 12/12 on day28). Later boards still get
      // their share; the next sweep continues this one.
      if (maxPerBoard !== null && enqueuedThisBoard >= maxPerBoard) {
        report.capped += 1;
        report.applications.push({
          board: formatBoardRef(entry.ref),
          company: entry.company,
          role: job.title,
          apply_url: job.apply_url,
          outcome: "capped",
          application_id: null,
          state: null,
          detail: `per-board cap (${maxPerBoard}) reached — next sweep continues`,
        });
        continue;
      }
      report.applications.push(
        enqueueBoardJob(input.db, entry, job.title, job.apply_url, {
          external_id: job.external_id,
          location: job.location,
          department: job.department,
          posted_at: job.posted_at,
        }),
      );
      const last = report.applications[report.applications.length - 1]!;
      if (last.outcome === "enqueued") {
        report.enqueued += 1;
        enqueuedThisBoard += 1;
      } else if (last.outcome === "reused") report.reused += 1;
      else if (last.outcome === "blocked") report.blocked += 1;
    }
    boardRow.stale = stale;
    if (stale > 0) {
      report.stale += stale;
      report.notes.push(
        `${formatBoardRef(entry.ref)}: ${stale} posting(s) older than ${MAX_POSTING_AGE_HOURS}h skipped (operator policy 2026-09-08)`,
      );
    }
  }
  return report;
}

/**
 * The Greenhouse embed id from a company-hosted apply URL's ?gh_jid=<id>
 * (also seen URL-encoded inside a wrapper param). Null when absent or
 * non-numeric — absence is what separates a legitimate embed URL from an
 * anomalous payload, which stays refused.
 */
function readGreenhouseEmbedJid(applyUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(applyUrl);
  } catch {
    return null;
  }
  const jid = url.searchParams.get("gh_jid");
  if (jid && /^\d+$/.test(jid.trim())) return jid.trim();
  return null;
}

/** A holder in any submitted / post-submit / unresolved-submission state. */
const POST_SUBMIT_HOLDER_STATE =
  /^(SUBMITTED|COMPLETED|UNCERTAIN_SUBMISSION|SUBMISSION_VERIFICATION_FAILED|CONTACTS_|LINKEDIN_|EMAIL_|OUTLOOK_|GMAIL_)/;

function enqueueBoardJob(
  db: Db,
  entry: BoardRegistryEntry,
  title: string,
  applyUrl: string,
  extra: {
    external_id: string | null;
    location: string | null;
    department: string | null;
    posted_at: string | null;
  },
): DiscoveredApplication {
  const base = {
    board: formatBoardRef(entry.ref),
    company: entry.company,
    role: title,
    apply_url: applyUrl,
  };
  // Ingestion re-validates the URL the board handed us, STRICTER than
  // manual enqueue: a Greenhouse board's apply URL must validate as
  // Greenhouse. The generic adapter would accept any https URL, which is
  // right for operator-vouched links but wrong here — a board payload
  // whose URL doesn't match its own ATS is a real anomaly, refused loudly.
  //
  // One shape is legitimate, not an anomaly: Greenhouse boards whose
  // absolute_url is the company's own careers page with a ?gh_jid=<id>
  // embed param (stripe.com/jobs/search?gh_jid=…). The gh_jid IS the
  // Greenhouse posting id, so the vendor-hosted form is derivable from
  // operator-listed token + that id. We navigate ONLY to the derived
  // boards.greenhouse.io URL — never to the company-hosted one — and only
  // when the embedded id is consistent with the payload's own posting id.
  let detected = detectAtsFromUrl(applyUrl);
  if (detected.ats !== entry.ref.ats && entry.ref.ats === "greenhouse") {
    const ghJid = readGreenhouseEmbedJid(applyUrl);
    if (ghJid && (extra.external_id === null || ghJid === extra.external_id)) {
      const canonical = `https://boards.greenhouse.io/${encodeURIComponent(
        entry.ref.token,
      )}/jobs/${encodeURIComponent(ghJid)}`;
      const redetected = detectAtsFromUrl(canonical);
      if (redetected.ats === "greenhouse") {
        detected = redetected;
      }
    }
  }
  if (detected.ats !== entry.ref.ats) {
    return {
      ...base,
      outcome: "rejected_url",
      application_id: null,
      state: null,
      detail: `apply URL did not validate as ${entry.ref.ats} (got ${detected.ats ?? "none"}): ${applyUrl.slice(0, 96)}`,
    };
  }
  const employerUrl = detected.normalizedUrl;

  // Same POSTING already owned through another discovery source. A
  // JobRight-sourced job row keys on the JobRight card URL and carries the
  // employer URL only in raw_json, so the fingerprint/URL upsert below never
  // sees the twin. Live 2026-09-08: Databricks 8732364002 was re-enqueued
  // although COMPLETED via JobRight; only the later nav audit parked it.
  // Operator rule (2026-09-07): dedupe is per posting, never per company.
  const holders = findApplicationsWithEmployerUrl(db, employerUrl, "");
  const submitted = holders.find((h) => POST_SUBMIT_HOLDER_STATE.test(h.state));
  if (submitted) {
    return {
      ...base,
      outcome: "blocked",
      application_id: submitted.application_id,
      state: submitted.state,
      detail: `posting already submitted by application ${submitted.application_id.slice(0, 8)} (${submitted.state}, other discovery source)`,
    };
  }
  const live = holders[0];
  if (live) {
    return {
      ...base,
      outcome: "reused",
      application_id: live.application_id,
      state: live.state,
      detail: `posting already owned by application ${live.application_id.slice(0, 8)} (${live.state}, other discovery source)`,
    };
  }

  const job = upsertJobByFingerprint(db, {
    applicationUrl: employerUrl,
    company: entry.company,
    role: title,
    location: extra.location,
    sourceAts: entry.ref.ats,
    raw: {
      source: "ats_board_discovery",
      board_ref: formatBoardRef(entry.ref),
      board_external_id: extra.external_id,
      department: extra.department,
      posted_at: extra.posted_at,
      employer_application_url: employerUrl,
      employer_application_ats: detected.ats,
      discovered_at: new Date().toISOString(),
    },
  });

  const dedupe = getOrCreateApplicationForJob(db, {
    jobId: job.id,
    versions: {
      discovery_source: "ats_board",
      board_ref: formatBoardRef(entry.ref),
    },
  });

  if (dedupe.kind === "CREATED") {
    // Same legal edge walk as manual enqueue — never an ad-hoc status write.
    transitionApplication(db, {
      applicationId: dedupe.applicationId,
      nextState: "DUPLICATE_CHECK",
      reason: "ats board discovery: dedupe pass",
    });
    transitionApplication(db, {
      applicationId: dedupe.applicationId,
      nextState: "ELIGIBILITY_CHECK",
      reason: "ats board discovery: operator-listed board, title filter passed",
    });
    const app = transitionApplication(db, {
      applicationId: dedupe.applicationId,
      nextState: "QUEUED",
      reason: "ats board discovery: ready for materials/pipeline",
    });
    return {
      ...base,
      outcome: "enqueued",
      application_id: dedupe.applicationId,
      state: app.state,
      detail: null,
    };
  }
  if (dedupe.kind === "EXISTING_ACTIVE") {
    return {
      ...base,
      outcome: "reused",
      application_id: dedupe.applicationId,
      state: dedupe.application.state,
      detail: "active application already exists for this job",
    };
  }
  return {
    ...base,
    outcome: "blocked",
    application_id: dedupe.applicationId,
    state: dedupe.application.state,
    detail:
      dedupe.kind === "ALREADY_VERIFIED_SUBMITTED"
        ? "job already has a verified submission"
        : dedupe.kind === "POLICY_ABANDONED"
          ? "posting abandoned by operator/policy — not re-enqueued (#209)"
          : "job has an uncertain submission pending resolution",
  };
}
