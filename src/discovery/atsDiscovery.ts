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
    };
  }
  const boards = (parsed as { boards?: unknown })?.boards;
  if (!Array.isArray(boards)) {
    return { entries: [], errors: [`registry has no "boards" array`] };
  }
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
  return { entries, errors };
}

export type DiscoveredApplication = {
  board: string;
  company: string;
  role: string;
  apply_url: string;
  outcome: "enqueued" | "reused" | "blocked" | "capped" | "rejected_url";
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
  }>;
  enqueued: number;
  reused: number;
  blocked: number;
  capped: number;
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

  const report: AtsDiscoveryReport = {
    enabled: true,
    boards: [],
    enqueued: 0,
    reused: 0,
    blocked: 0,
    capped: 0,
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
    const { kept, dropped } = filterBoardJobs(fetched.jobs, merged);
    report.boards.push({
      ref: formatBoardRef(entry.ref),
      company: entry.company,
      ok: fetched.ok,
      error: fetched.error,
      fetched: fetched.jobs.length,
      filtered_out: dropped,
      considered: kept.length,
    });

    for (const job of kept) {
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
      report.applications.push(
        enqueueBoardJob(input.db, entry, job.title, job.apply_url, {
          external_id: job.external_id,
          location: job.location,
          department: job.department,
          posted_at: job.posted_at,
        }),
      );
      const last = report.applications[report.applications.length - 1]!;
      if (last.outcome === "enqueued") report.enqueued += 1;
      else if (last.outcome === "reused") report.reused += 1;
      else if (last.outcome === "blocked") report.blocked += 1;
    }
  }
  return report;
}

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
  const detected = detectAtsFromUrl(applyUrl);
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
        : "job has an uncertain submission pending resolution",
  };
}
