import type { Db } from "../storage/db/client.js";
import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  runPipeline,
  type PipelineAppReport,
  type PipelineOptions,
} from "../pipeline/runPipeline.js";
import { runJobRightDiscovery } from "../jobright/discoveryRun.js";
import { runPostSubmitGmail, type OutreachPipelineJobResult } from "../outreach/outreachPipeline.js";
import { recordGmailTailOutcome } from "../outreach/outreachWorker.js";
import { getApplication, transitionApplication } from "../queue/stateMachine.js";
import { judgePostingAge } from "../jobs/postingAge.js";
import {
  isRetryablePortalAuthWall,
  listOpenReviewItems,
  upsertOpenReviewItem,
} from "../queue/reviewItems.js";
import { generateEssayDraftBatch } from "../applications/essayDraft.js";
import { runTriageBatch } from "../triage/runTriage.js";
import { verifyTriageOutcomes } from "../triage/verifyOutcomes.js";
import { generateScreenerPredictions } from "../applications/screenerPredictionLlm.js";
import { autopushArtifacts } from "./artifactAutopush.js";
import {
  requeueNavStarvedApplications,
  reviveUnsupportedAtsApplications,
} from "./navRequeue.js";
import { clearSkipRequest, isSkipRequested } from "./skipRequests.js";
import { probeCdpAttach, restartCdpChrome } from "./cdpChrome.js";
import {
  DEFAULT_CONNECTIVITY_WAIT,
  isNetworkOutageError,
  waitForConnectivity,
} from "./connectivity.js";
import { auditEmployerUrls } from "../navigation/auditEmployerUrls.js";
import { probeCdpEndpoint, type NavSession } from "../navigation/runNavigation.js";
import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import {
  runOutreachTail,
  OUTREACH_TAIL_STATES,
  type DraftRunner,
  type DraftVerifier,
  type OutreachTailResult,
} from "../outreach/outreachTail.js";
import type { EmailLlmClient } from "../contacts/emailLlm.js";
import {
  getActiveArmSession,
  consumeArmApplication,
  touchArmHeartbeat,
  noteArmError,
} from "./armSession.js";

/**
 * The L3 autonomous worker: while an armed session is live and under its
 * app cap, discover/process/fill/submit one application at a time, parking
 * walls and continuing the queue. It owns no capability of its own — every
 * gate still runs inside runPipeline/runAtsSubmission, and submits are
 * unattended only because the armed child env relaxed the confirmation
 * (A4) and the arm row carries the budget. The worker adds no unbounded
 * loops: caps live in nav/submit/heal already, and this loop is bounded by
 * the arm's app cap, its expiry, and the queue running dry.
 */

export { runOutreachTail, type OutreachTailResult } from "../outreach/outreachTail.js";

/**
 * Between-app pause. Was [15s, 45s] — measured at ~50% of session
 * wall-clock (run 8bcff01c: ~45–55s per app, most of it this sleep).
 * The pause exists to avoid hammering JobRight, but between apps the
 * system is not touching JobRight at all — discovery runs every
 * REDISCOVER_EVERY apps and has its own pacing. A short breath is enough.
 * Operators can still widen it per-arm via delayMsRange.
 */
const DEFAULT_DELAY_MS: [number, number] = [2_000, 5_000];
/** dfb007f8: the attach failure recurs — one restart was not enough. */
const MAX_CDP_RESTARTS_PER_SESSION = 3;

export type AutomationStopReason =
  | "disarmed"
  | "expired"
  | "apps_cap"
  | "queue_drained"
  | "no_fresh_candidate"
  /**
   * The debug Chrome would not attach and the bounded in-session restarts
   * either failed or were exhausted. Night18 (2026-08-30) burned 40+ apps
   * against a wedged Chrome after the cap; the queue is left for the next
   * cycle instead.
   */
  | "cdp_unrecoverable"
  /**
   * The box has no internet (issue #203, day28 2026-09-09: a 12-minute
   * uplink drop burned 13 queued apps, one per cycle, against
   * `net::ERR_INTERNET_DISCONNECTED`). Detected by a bounded probe before
   * the first pick and again when an app dies of a transport error; the
   * queue is left for the next cycle. ATS-agnostic by construction.
   */
  | "network_unreachable"
  | "error";

export type AutomationAppResult = {
  application_id: string;
  end_state: string;
  stopped: string | null;
  stop_reason: string | null;
  submitted: boolean;
  /**
   * Referral-tail outcome for this app, or null when the tail never ran.
   * The first live L3 session reported emails_generated: 0 with no way to
   * tell "no verified submit" from "flag off" from "no contacts" — every
   * skip now names itself.
   */
  outreach: {
    email_status: OutreachTailResult["email_status"];
    draft_status: OutreachTailResult["draft_status"];
    skip_reason: string | null;
  } | null;
  gmail?: OutreachPipelineJobResult;
};

export type AutomationSessionReport = {
  arm_run_id: string;
  apps_started: number;
  submits_used: number;
  stopped_reason: AutomationStopReason;
  discover_runs: number;
  emails_generated: number;
  drafts_saved: number;
  /** Essay suggestion drafts generated into review items (UNVERIFIED). */
  essay_drafts_generated: number;
  /** New-question predictions opened as review items (UNVERIFIED). */
  screener_predictions_generated: number;
  /** Post-session LLM failure triage (TRIAGE_LLM_ENABLED). */
  triage?: { decided: number; executed: number };
  /** Stage-1 loop: artifacts committed+pushed after the session. */
  artifact_autopush?: { pushed: boolean; commit: string | null; files_staged: number };
  /** Session-start employer-URL audit (wrong-company/duplicate repair). */
  nav_audit?: { checked: number; repaired: number; parked: number };
  notes: string[];
  per_app: AutomationAppResult[];
};

export type AutomationProgress = {
  apps_started: number;
  submits_used: number;
  last_error_code: string | null;
};

type DiscoveryRunner = (maxJobs: number) => Promise<{
  jobs_inspected: number;
  jobs_eligible?: number;
  jobs_reused?: number;
  jobs_filtered_out?: number;
  jobs_skipped_submitted?: number;
  applications?: Array<{ application_id: string; eligible: boolean; dedupe_kind: string }>;
}>;

export type AutomationSessionInput = {
  db: Db;
  armRunId: string;
  headless?: boolean;
  /**
   * Operator 2026-09-09: leave the post-submit Gmail tail to the parallel
   * `outreach:worker` process instead of running it inline between
   * applications. The tail still ALWAYS runs — just not in this process.
   */
  deferGmail?: boolean;
  /** 0 disables discovery entirely (process only the existing queue). */
  discoverMax?: number;
  /** Fresh feed only when discovery is enabled; backlog requires explicit selection. */
  queueMode?: "fresh" | "backlog";
  rediscoverEvery?: number;
  /** [min,max] ms slept between apps; test seams pass a tiny range. */
  delayMsRange?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  /** Test seams forwarded to each runPipeline call. */
  fixtureHtmlPath?: string;
  navigationRunner?: PipelineOptions["navigationRunner"];
  /** Test seam for the operator Skip signal; production reads the DB marker. */
  shouldSkip?: PipelineOptions["shouldSkip"];
  /**
   * Per-application wall-clock budget (operator directive 2026-08-30: 3 min
   * discovery→submit, then stop and diagnose instead of grinding). Enforced
   * at pipeline step boundaries through the same cooperative skip seam the
   * console's Skip button uses — never mid-click. The app keeps whatever
   * state it reached; the stop is named `deadline` in the session notes.
   */
  appDeadlineMs?: number;
  contactsFixtureHtmlPath?: string;
  /** Test seam replacing live discovery. */
  discoveryRunner?: DiscoveryRunner;
  /** Test seam: is the nav agent leg (flag + CDP Chrome) available? */
  agentLegProbe?: () => Promise<boolean>;
  /** Test seam: preflight REAL CDP attach check (HTTP probes lie on a wedged Chrome). */
  cdpAttachProbe?: () => Promise<boolean>;
  /** Test seam: replaces the mid-session debug-Chrome restart. */
  cdpRestarter?: () => Promise<{ reachable: boolean; notes: string[] }>;
  /**
   * Test seam: replaces the internet probe (#203). Production probes two
   * well-known hosts; the wait between probes goes through `sleep`.
   */
  connectivityProbe?: () => Promise<boolean>;
  /** Test seams for the post-submit outreach tail (drafts only, never send). */
  emailClient?: EmailLlmClient;
  /** Test seam for the post-session essay draft batch. */
  essayDraftClient?: EmailLlmClient;
  /** Test seam: stub LLM for the post-session failure-triage batch. */
  triageClient?: EmailLlmClient;
  draftRunner?: DraftRunner;
  draftVerifier?: DraftVerifier;
  gmailRunner?: typeof runPostSubmitGmail;
  /** Offline orchestration seam; production always runs the gated pipeline. */
  pipelineRunner?: typeof runPipeline;
  /** Progress sink (the runner turns this into SSE frames). */
  onProgress?: (p: AutomationProgress) => void;
  /** Deterministic jitter for tests (default Math.random via index). */
  nextDelayMs?: (range: [number, number], index: number) => number;
};

/**
 * Next QUEUED (else any advanceable) app with no open review, not excluded,
 * and not already processed this session. The seen-set matters because a
 * single runPipeline call takes an app as far as it can go; if it stops at
 * a gate (e.g. submit not allowed → parks at READY_TO_SUBMIT) with no
 * review item, re-picking it would loop forever on the same result.
 */
function pickNextApplication(db: Db, seen: Set<string>, scope?: Set<string>): string | null {
  const standingPortalPassword = getConfig().portalLoginPassword;
  const blockedByReview = new Set(
    listOpenReviewItems(db)
      .filter(
        (it) =>
          it.application_id !== null &&
          !isRetryablePortalAuthWall(it, standingPortalPassword),
      )
      .map((it) => it.application_id as string),
  );

  type PickRow = {
    id: string;
    versions_json: string;
    state: string;
    app_created_at: string;
    job_created_at: string | null;
    description_text: string | null;
    raw_json: string | null;
  };
  // Board-discovered rows carry the ATS's own timestamp in raw_json
  // (posted_at); JobRight rows carry only the relative text.
  const postedAtOf = (raw: string | null): string | null => {
    if (!raw) return null;
    try {
      const v = (JSON.parse(raw) as { posted_at?: unknown }).posted_at;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  };
  const query = (states: string) =>
    db
      .prepare(
        // NEWEST first (operator directive 2026-09-06: jobs at the top of
        // the discovery page are prioritized — recency is the proxy).
        // The old ASC order made backlog cycles grind the STALEST parked
        // apps (5-day-old Rivian) while fresh enqueues waited.
        `SELECT a.id, a.versions_json, a.state, a.created_at AS app_created_at,
                j.created_at AS job_created_at, j.description_text, j.raw_json
         FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
         WHERE a.state IN (${states})
         ORDER BY a.created_at DESC`,
      )
      .all() as PickRow[];

  const firstEligible = (rows: PickRow[]): string | null => {
    for (const row of rows) {
      if (scope && !scope.has(row.id)) continue;
      if (seen.has(row.id)) continue;
      if (blockedByReview.has(row.id)) continue;
      let excluded = false;
      try {
        const v = JSON.parse(row.versions_json) as { automation_excluded?: unknown };
        excluded = v.automation_excluded === true;
      } catch {
        excluded = false;
      }
      if (excluded) continue;
      // #199 (operator directive 2026-09-08): a QUEUED row whose posting
      // was published, or which was enqueued, more than 24h ago is not
      // applied to. Abandoned through the state machine with the policy
      // named, so it never re-enters a pick; in-flight states are the
      // pipeline's to finish.
      if (row.state === "QUEUED") {
        const age = judgePostingAge({
          descriptionText: row.description_text,
          jobCreatedAt: row.job_created_at,
          appCreatedAt: row.app_created_at,
          postedAt: postedAtOf(row.raw_json),
        });
        if (age.stale) {
          seen.add(row.id);
          try {
            transitionApplication(db, {
              applicationId: row.id,
              nextState: "FAILED_FINAL",
              reason: `automation: skipped — ${age.reason}`,
            });
          } catch (err) {
            logger.warn("stale-posting abandon failed", {
              service: "automation",
              action: "stale_skip_error",
              application_id: row.id,
              metadata: { error: err instanceof Error ? err.message.slice(0, 160) : String(err) },
            });
            continue;
          }
          logger.info("automation skipped a stale posting", {
            service: "automation",
            action: "stale_skip",
            application_id: row.id,
            metadata: {
              posting_age_hours: age.posting_age_hours,
              queue_age_hours: age.queue_age_hours,
              reason: age.reason,
            },
          });
          continue;
        }
      }
      return row.id;
    }
    return null;
  };

  // QUEUED first, then anything else the pipeline can still advance.
  const queued = firstEligible(query("'QUEUED'"));
  if (queued) return queued;
  return firstEligible(
    query(
      `'MATERIALS_GENERATING','RESUME_DOWNLOADED','APPLICATION_OPENING',` +
        `'ATS_DETECTION','APPLICATION_INSPECTION','NATIVE_AUTOFILL_RUNNING',` +
        // X2: an app crashed mid-extension-first-fill resumes safely — the
        // VERIFICATION handler treats a missing in-memory outcome as
        // "run the full native fill".
        `'JOBRIGHT_AUTOFILL_RUNNING','JOBRIGHT_AUTOFILL_VERIFICATION','FORM_RESETTING',` +
        `'FIELD_VERIFICATION','READY_TO_SUBMIT'`,
    ),
  );
}


export async function runAutomationSession(
  input: AutomationSessionInput,
): Promise<AutomationSessionReport> {
  const { db, armRunId } = input;
  const discoverMax = Math.max(0, input.discoverMax ?? 0);
  const freshOnly = (input.queueMode ?? (discoverMax > 0 ? "fresh" : "backlog")) === "fresh";
  let freshIds: string[] = [];
  const rediscoverEvery = Math.max(1, input.rediscoverEvery ?? 5);
  const delayRange = input.delayMsRange ?? DEFAULT_DELAY_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const discover: DiscoveryRunner =
    input.discoveryRunner ??
    (async (maxJobs) => runJobRightDiscovery({ maxJobs, freshOnly, headless: input.headless ?? true }));

  const report: AutomationSessionReport = {
    arm_run_id: armRunId,
    apps_started: 0,
    submits_used: 0,
    stopped_reason: "queue_drained",
    discover_runs: 0,
    emails_generated: 0,
    drafts_saved: 0,
    essay_drafts_generated: 0,
    screener_predictions_generated: 0,
    notes: [],
    per_app: [],
  };
  let lastErrorCode: string | null = null;
  /** Record the code for progress frames AND the arm row (Overview card). */
  const noteError = (code: string): void => {
    lastErrorCode = code;
    noteArmError(db, armRunId, code);
  };

  const emit = (): void =>
    input.onProgress?.({
      apps_started: report.apps_started,
      submits_used: report.submits_used,
      last_error_code: lastErrorCode,
    });

  /** Feed touch that never kills the loop: discovery throws on empty/auth. */
  const tryDiscover = async (): Promise<void> => {
    if (discoverMax <= 0) {
      logger.info("automation discover skipped (discover_max=0)", {
        service: "automation",
        action: "discover_skip",
        metadata: { arm_run_id: armRunId },
      });
      return;
    }
    logger.info("automation discover starting", {
      service: "automation",
      action: "discover_begin",
      metadata: { arm_run_id: armRunId, discover_max: discoverMax },
    });
    try {
      const r = await discover(freshOnly ? 1 : discoverMax);
      freshIds = (r.applications ?? []).filter(a => a.eligible && a.dedupe_kind === "CREATED").map(a => a.application_id);
      report.discover_runs += 1;
      // Session edc4d38f: "8 inspected" twice hid that every job was
      // already known — say what the inspection actually produced.
      report.notes.push(
        `discover: ${r.jobs_inspected} inspected, ${r.jobs_eligible ?? 0} eligible, ` +
          `${r.jobs_reused ?? 0} already known, ${r.jobs_filtered_out ?? 0} filtered out, ` +
          `${r.jobs_skipped_submitted ?? 0} already submitted`,
      );
      logger.info("automation discover finished", {
        service: "automation",
        action: "discover_end",
        metadata: {
          arm_run_id: armRunId,
          jobs_inspected: r.jobs_inspected,
          discover_runs: report.discover_runs,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      noteError(
        /AUTH_REQUIRED/.test(message)
          ? "jobright_auth"
          : /EMPTY_FEED/.test(message)
            ? "empty_feed"
            : "discover_error",
      );
      report.notes.push(`discover skipped (${lastErrorCode})`);
      logger.warn("automation discover failed", {
        service: "automation",
        action: "discover_error",
        metadata: {
          arm_run_id: armRunId,
          code: lastErrorCode,
          error: message.slice(0, 500),
        },
      });
    }
  };

  logger.info("automation session begin", {
    service: "automation",
    action: "session_begin",
    metadata: {
      arm_run_id: armRunId,
      headless: input.headless ?? true,
      discover_max: discoverMax,
      rediscover_every: rediscoverEvery,
      delay_ms_range: delayRange,
    },
  });

  // Self-healing sweep before any application is touched: stored employer
  // URLs that contradict their job's company are cleared and re-routed to
  // navigation; duplicates park. Fail-open — an audit error is a note,
  // never a dead session.
  try {
    // The audit runs in BOTH modes (operator decision 2026-09-06): it is
    // the layer that parks duplicate applications and repairs poisoned
    // URLs — cheap, and losing it silently in the default (fresh) mode
    // reduced dedupe to the JobRight-job-id fingerprint alone.
    const audit = auditEmployerUrls(db);
    report.nav_audit = {
      checked: audit.applications_checked,
      repaired: audit.repaired,
      parked: audit.parked + audit.duplicates_parked,
    };
    if (audit.mismatches_found > 0 || audit.duplicates_parked > 0) {
      report.notes.push(
        `nav audit: ${audit.repaired} wrong-employer URL(s) cleared for re-navigation, ${audit.parked + audit.duplicates_parked} parked for review`,
      );
    }
  } catch (err) {
    report.notes.push(
      `nav audit failed (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
  }

  // Triage outcome sweep: last session's PENDING triage decisions are
  // confirmed/refuted from what application_events actually did since —
  // the read-back that feeds the retry-differently forbidden memory.
  // Fail-open; a sweep error is a note, never a dead session.
  if (getConfig().triageLlmEnabled) {
    try {
      const sweep = verifyTriageOutcomes(db);
      if (sweep.checked > 0) {
        report.notes.push(
          `triage sweep: ${sweep.confirmed} confirmed, ${sweep.refuted} refuted, ${sweep.expired} expired of ${sweep.checked} pending`,
        );
      }
    } catch (err) {
      report.notes.push(
        `triage sweep failed (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
      );
    }
  }

  // Second-chance sweep: apps parked as "navigation unresolved (budget)"
  // by an agent-less session get ONE requeue when this session has the
  // agent leg (session edc4d38f drained an "empty" queue past seven of
  // them). Fail-open; the once-per-app marker makes loops impossible.
  let cdpRestarts = 0;
  let cdpDead = false;
  let agentLegUp = false;
  try {
    agentLegUp = await (input.agentLegProbe ??
      (async () => {
        const cfg = getConfig();
        return cfg.agentFallbackEnabled && (await probeCdpEndpoint(cfg.agentCdpUrl));
      }))();
    // The HTTP probe lies about a wedged Chrome (night19: 4 wedges, each
    // one burned the session's first app before the in-loop restart ran).
    // Verify a REAL attach up front and repair before any app is picked.
    if (agentLegUp) {
      const attached = await (input.cdpAttachProbe ??
        (() => probeCdpAttach(getConfig().agentCdpUrl)))();
      if (!attached) {
        cdpRestarts += 1;
        const restart = await (input.cdpRestarter ?? restartCdpChrome)().catch(
          (e) => ({ reachable: false, notes: [String(e).slice(0, 160)] }),
        );
        report.notes.push(
          restart.reachable
            ? `preflight: CDP attach failed — debug Chrome restarted and attach-verified before the first app (${cdpRestarts}/${MAX_CDP_RESTARTS_PER_SESSION})`
            : `preflight: CDP attach failed and the restart did not recover: ${restart.notes.join("; ").slice(0, 160)}`,
        );
        if (!restart.reachable) {
          agentLegUp = false;
          cdpDead = true;
        }
      }
    }
    if (agentLegUp && !freshOnly) {
      const rq = requeueNavStarvedApplications(db);
      if (rq.requeued > 0) {
        report.notes.push(
          `nav requeue: ${rq.requeued} navigation-starved app(s) requeued (agent leg available)`,
        );
      }
      report.notes.push(...rq.notes);
    } else if (freshOnly) {
      report.notes.push("nav requeue skipped (fresh mode — backlog untouched)");
    }
  } catch (err) {
    report.notes.push(
      `nav requeue failed (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
  }

  // Revival sweep: UNSUPPORTED_ATS apps whose stored URL an adapter now
  // claims (the generic adapter losing its flag turned the whole long tail
  // fillable at once). Fail-open, capped, once per app.
  try {
    const rv = freshOnly
      ? { revived: 0, notes: ["unsupported-ATS revival skipped (fresh mode — backlog untouched)"] }
      : reviveUnsupportedAtsApplications(db);
    if (rv.revived > 0) {
      report.notes.push(
        `unsupported-ATS revival: ${rv.revived} app(s) re-opened — an adapter now claims their URL`,
      );
    }
    report.notes.push(...rv.notes);
  } catch (err) {
    report.notes.push(
      `unsupported-ATS revival failed (continuing): ${err instanceof Error ? err.message.slice(0, 160) : String(err)}`,
    );
  }

  // Uplink preflight (#203): with no internet every pick is a guaranteed
  // burn, so no application is touched until a bounded probe says the
  // network is there. Same seam re-runs when an app dies of a transport
  // error mid-session (see the catch below).
  let networkDead = false;
  const waitForNetwork = async (): Promise<boolean> => {
    const r = await waitForConnectivity({
      ...DEFAULT_CONNECTIVITY_WAIT,
      ...(input.connectivityProbe ? { probe: input.connectivityProbe } : {}),
      sleep,
    });
    if (!r.online) {
      networkDead = true;
      noteError("network_unreachable");
      report.notes.push(
        `network unreachable after ${r.probes} probe(s) over ${Math.round(r.waited_ms / 1000)}s — session stopped, queue left for the next cycle`,
      );
    }
    return r.online;
  };
  /** Names the stop and logs it; the loop head and the app catch both use it. */
  const stopForNetwork = (): void => {
    report.stopped_reason = "network_unreachable";
    logger.warn("automation loop exit: internet unreachable", {
      service: "automation",
      action: "session_stop",
      metadata: {
        arm_run_id: armRunId,
        stopped_reason: report.stopped_reason,
        apps_started: report.apps_started,
      },
    });
  };
  // Discovery is a network read too — skip it offline; the loop head below
  // then exits through the same post-session path every other stop uses.
  if (await waitForNetwork()) await tryDiscover();
  let appsSinceDiscover = 0;
  // Each app is attempted at most once per session (see pickNextApplication).
  const seen = new Set<string>();
  /** Verified-submit apps whose referral tail runs after the loop (batch). */
  const tailQueue: Array<{ appId: string; appResult: AutomationAppResult }> = [];

  // ONE JobRight browser session for the whole loop (run 8bcff01c paid a
  // fresh open+validate per app, ~4–6s each). Lazy: only created when an
  // app actually reaches live navigation (never under the navigationRunner
  // test seam), recreated at most once per app on failure, closed in the
  // session-level finally below.
  let sharedNavSession: NavSession | null = null;
  const getNavSession = async (): Promise<NavSession | undefined> => {
    if (input.navigationRunner) return undefined; // offline tests: no browser
    if (!sharedNavSession) {
      const s = new PlaywrightServiceSession({
        service: "jobright",
        ...(agentLegUp ? { mode: "CDP_ATTACH" as const } : {}),
        headless: input.headless ?? true,
        slowMoMs: 40,
      });
      await s.open();
      sharedNavSession = s;
    }
    return sharedNavSession;
  };
  const dropNavSession = async (): Promise<void> => {
    const s = sharedNavSession;
    sharedNavSession = null;
    if (s) await s.close().catch(() => undefined);
  };

  try {
  // The active-arm helper both validates status+expiry and lazily sweeps an
  // expired row, so it is the single source of truth for "still armed".
  for (let iter = 0; ; iter++) {
    if (networkDead) {
      stopForNetwork();
      break;
    }
    emit();
    // Liveness ping: a scheduled auto:cycle uses this to tell a working
    // session apart from a row left RUNNING by a killed process.
    touchArmHeartbeat(db, armRunId);
    const active = getActiveArmSession(db);
    if (!active || active.row.id !== armRunId) {
      // Distinguish expiry from an operator disarm by the armed_until in the
      // row's metadata — getActiveArmSession may have just swept an expired
      // row to COMPLETED, so status alone cannot tell them apart.
      const row = db
        .prepare(`SELECT metadata_json AS m FROM automation_runs WHERE id = ?`)
        .get(armRunId) as { m: string } | undefined;
      let expired = false;
      if (row) {
        try {
          const until = Date.parse(
            (JSON.parse(row.m) as { armed_until?: string }).armed_until ?? "",
          );
          expired = Number.isFinite(until) && Date.now() >= until;
        } catch {
          expired = false;
        }
      }
      report.stopped_reason = expired ? "expired" : "disarmed";
      logger.info("automation loop exit: arm inactive", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          stopped_reason: report.stopped_reason,
          apps_started: report.apps_started,
        },
      });
      break;
    }

    if (discoverMax > 0 && appsSinceDiscover >= (freshOnly ? 1 : rediscoverEvery)) {
      await tryDiscover();
      appsSinceDiscover = 0;
    }

    const submitsLeft =
      active.row.max_unattended_submissions - active.row.unattended_submissions_count;
    const allowSubmit = submitsLeft > 0;

    let appId = pickNextApplication(db, seen, freshOnly ? new Set(freshIds) : undefined);
    if (!appId && discoverMax > 0 && !freshOnly) {
      // Queue drained — one more discovery before giving up.
      await tryDiscover();
      appsSinceDiscover = 0;
      appId = pickNextApplication(db, seen);
    }
    if (!appId) {
      report.stopped_reason = freshOnly ? "no_fresh_candidate" : "queue_drained";
      if (freshOnly) report.notes.push("no fresh eligible candidate within the feed scan — backlog untouched");
      logger.info("automation loop exit: queue drained", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          seen_count: seen.size,
          apps_started: report.apps_started,
        },
      });
      break;
    }

    if (!consumeArmApplication(db, armRunId)) {
      report.stopped_reason = "apps_cap";
      logger.info("automation loop exit: apps cap", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          apps_started: report.apps_started,
          max_apps: active.meta.max_apps,
        },
      });
      break;
    }
    seen.add(appId);
    report.apps_started += 1;

    const appRow = getApplication(db, appId);
    logger.info("automation processing app", {
      service: "automation",
      action: "app_begin",
      application_id: appId,
      metadata: {
        arm_run_id: armRunId,
        start_state: appRow?.state ?? null,
        allow_submit: allowSubmit,
        submits_left: submitsLeft,
        apps_started: report.apps_started,
        max_apps: active.meta.max_apps,
        headless: input.headless ?? true,
      },
    });

    try {
      // Shared-session failures must not kill the loop: if the browser
      // died since the last app, drop it and retry ONCE with a fresh one.
      let navSession = await getNavSession().catch(() => undefined);
      const appStartedAt = Date.now();
      const deadlineMs = input.appDeadlineMs;
      const deadlineHit = (): boolean =>
        deadlineMs !== undefined && deadlineMs > 0 && Date.now() - appStartedAt >= deadlineMs;
      const operatorSkip: NonNullable<PipelineOptions["shouldSkip"]> =
        input.shouldSkip ?? ((id) => isSkipRequested(db, id));
      const runOnce = () =>
        (input.pipelineRunner ?? runPipeline)({
          db,
          applicationId: appId,
          submit: allowSubmit,
          assumeYes: true,
          automationRunId: armRunId,
          headless: input.headless ?? true,
          ...(navSession ? { navSession } : {}),
          ...(input.fixtureHtmlPath ? { fixtureHtmlPath: input.fixtureHtmlPath } : {}),
          ...(input.contactsFixtureHtmlPath
            ? { contactsFixtureHtmlPath: input.contactsFixtureHtmlPath }
            : {}),
          ...(input.navigationRunner ? { navigationRunner: input.navigationRunner } : {}),
          // The console's Skip button writes a marker; the pipeline reads
          // it between steps and stops working this app. Tests override.
          shouldSkip: (id) => operatorSkip(id) || deadlineHit(),
        });
      let pipelineReport;
      try {
        pipelineReport = await runOnce();
      } catch (pipelineErr) {
        if (!navSession) throw pipelineErr;
        report.notes.push(
          `shared nav session dropped after error on ${appId}: ${
            pipelineErr instanceof Error ? pipelineErr.message.slice(0, 120) : String(pipelineErr)
          }`,
        );
        await dropNavSession();
        navSession = await getNavSession().catch(() => undefined);
        pipelineReport = await runOnce();
      }
      const appReport: PipelineAppReport | undefined = pipelineReport.applications[0];
      if (appReport) {
        const appResult = toAppResult(db, appReport);
        report.per_app.push(appResult);
        logger.info("automation app pipeline result", {
          service: "automation",
          action: "app_end",
          application_id: appId,
          metadata: {
            start_state: appReport.start_state,
            end_state: appReport.end_state,
            stopped: appReport.stopped,
            stop_reason: appReport.stop_reason,
            submitted: toAppResult(db, appReport).submitted,
            steps: appReport.steps.map((s) => `${s.from}→${s.to ?? "—"}: ${s.note}`),
          },
        });
        if (appReport.stopped == null) {
          noteError("anomaly_no_stop");
          report.notes.push(`anomaly: ${appId} stopped with no reason`);
        }
        if (appReport.stopped === "skipped" && deadlineHit() && !operatorSkip(appId)) {
          appResult.stop_reason = `deadline: ${Math.round((Date.now() - appStartedAt) / 1000)}s elapsed of ${Math.round((deadlineMs ?? 0) / 1000)}s budget — stopped at step boundary in ${appReport.end_state}`;
          report.notes.push(
            `deadline ${appId}: ${Math.round((Date.now() - appStartedAt) / 1000)}s > ${Math.round((deadlineMs ?? 0) / 1000)}s budget — stopped in ${appReport.end_state} (diagnose, do not grind)`,
          );
        } else if (appReport.stopped === "skipped") {
          // Acted on — clear the pending marker so it does not re-fire, but
          // KEEP the exclusion: the operator said not this one, and only
          // the operator says otherwise (via the include toggle).
          clearSkipRequest(db, appId);
          report.notes.push(
            `skipped ${appId} on operator request — moving to the next job`,
          );
        }
        if (appResult.submitted && input.deferGmail) {
          // The parallel outreach worker picks this up from the VERIFIED
          // submission row; nothing here to wait on.
          appResult.outreach = { email_status: null, draft_status: null, skip_reason: "deferred to outreach:worker" };
          report.notes.push(`gmail ${appId}: deferred to outreach:worker`);
        } else if (appResult.submitted && (getConfig().gmailDraftsEnabled || input.gmailRunner)) {
          // Complete Gmail before the next feed read, including COMPLETED/no-contact apps.
          await dropNavSession();
          const gmail = await (input.gmailRunner ?? runPostSubmitGmail)({ db, applicationId: appId, headless: input.headless ?? true });
          recordGmailTailOutcome(db, appId, gmail);
          appResult.gmail = gmail;
          report.emails_generated += gmail.generated;
          report.drafts_saved += gmail.drafted;
          appResult.outreach = { email_status: gmail.generated ? "generated" : "skipped", draft_status: gmail.drafted ? "saved" : "skipped", skip_reason: gmail.error ?? gmail.notes[0] ?? null };
          if (!gmail.ok) {
            report.notes.push(`gmail ${appId}: ${gmail.error ?? "failed"}`);
            upsertOpenReviewItem(db, { kind: "MANUAL", title: "Post-submit Gmail pipeline failed", payload: { application_id: appId, gmail } });
          }
          for (const note of gmail.notes) report.notes.push(`gmail ${appId}: ${note}`);
        } else {
        // Post-submit outreach tail (drafts only, never send). Only states a
        // verified submit can reach; failures are review items, not stops.
        if (appResult.submitted && !OUTREACH_TAIL_STATES.has(appReport.end_state)) {
          // Verified submit but the pipeline never reached a tail state —
          // contacts extraction didn't run (flag off, extraction failed, or
          // the pipeline stopped earlier). Name it instead of a silent 0.
          appResult.outreach = {
            email_status: null,
            draft_status: null,
            skip_reason: `tail unreachable from end_state ${appReport.end_state} — contacts extraction did not run`,
          };
          report.notes.push(
            `outreach ${appId}: skipped — end_state ${appReport.end_state} (no contacts extracted)`,
          );
        }
        if (OUTREACH_TAIL_STATES.has(appReport.end_state)) {
          // Batched: the tail (text API + Outlook browser) runs AFTER the
          // session loop, so an armed window is spent on applications, not
          // on waiting for a drafting model between them.
          tailQueue.push({ appId, appResult });
          report.notes.push(`outreach ${appId}: queued for post-session batch`);
        }
        }
      } else {
        logger.warn("automation pipeline returned no app report", {
          service: "automation",
          action: "app_end",
          application_id: appId,
          metadata: { run_id: pipelineReport.run_id },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const netWall = isNetworkOutageError(message);
      noteError(
        /lease/i.test(message)
          ? "lease_held"
          : /AUTH_REQUIRED/.test(message)
            ? "jobright_auth"
            : netWall
              ? "network_unreachable"
              : "pipeline_error",
      );
      report.notes.push(`app ${appId} error (${lastErrorCode}): ${message.slice(0, 200)}`);
      logger.warn("automation worker: app error, continuing", {
        service: "automation",
        action: "app_error",
        application_id: appId,
        metadata: {
          code: lastErrorCode,
          error: message.slice(0, 500),
          stack:
            err instanceof Error
              ? err.stack?.split("\n").slice(0, 8).join(" | ")
              : undefined,
        },
      });
      // Mid-session CDP degradation (cc02e067 killed 7/13 apps at 02:50):
      // /json/version answers but attach fails. Bounded in-session repair —
      // dfb007f8 proved one restart works but the failure RECURS, so a
      // single try left 8 later apps dead. restartCdpChrome is fail-closed
      // behind CDP_AUTOLAUNCH_ENABLED; without the operator's standing
      // opt-in this only writes a note.
      const cdpWall = /CDP session won't attach|Debug Chrome .* unresponsive/i.test(message);
      if (cdpWall && cdpRestarts < MAX_CDP_RESTARTS_PER_SESSION) {
        cdpRestarts += 1;
        try {
          const restart = await (input.cdpRestarter ?? restartCdpChrome)();
          report.notes.push(
            restart.reachable
              ? `CDP restart ${cdpRestarts}/${MAX_CDP_RESTARTS_PER_SESSION}: debug Chrome relaunched and attach-verified — continuing session`
              : `CDP restart ${cdpRestarts}/${MAX_CDP_RESTARTS_PER_SESSION} did not recover: ${restart.notes.join("; ").slice(0, 200)}`,
          );
          if (!restart.reachable) cdpDead = true;
        } catch (restartErr) {
          report.notes.push(
            `CDP restart failed: ${restartErr instanceof Error ? restartErr.message.slice(0, 160) : String(restartErr)}`,
          );
          cdpDead = true;
        }
      } else if (cdpWall) {
        // Restart budget spent and the wall is back: every further app would
        // die the same way. Stop the session; the apps keep their state.
        cdpDead = true;
      } else if (netWall) {
        // Transport error, not a page: the app keeps its pre-nav state.
        // Wait (bounded) for the link; continue only if it comes back.
        if (await waitForNetwork()) {
          report.notes.push(
            `transient network error on ${appId} — connectivity verified, continuing`,
          );
        }
      }
    }

    if (networkDead) {
      stopForNetwork();
      break;
    }

    if (cdpDead) {
      report.stopped_reason = "cdp_unrecoverable";
      report.notes.push(
        `session stopped: debug Chrome unrecoverable after ${cdpRestarts}/${MAX_CDP_RESTARTS_PER_SESSION} restart(s) — remaining queue left for the next cycle`,
      );
      logger.warn("automation loop exit: CDP unrecoverable", {
        service: "automation",
        action: "session_stop",
        metadata: {
          arm_run_id: armRunId,
          stopped_reason: report.stopped_reason,
          apps_started: report.apps_started,
          cdp_restarts: cdpRestarts,
        },
      });
      break;
    }

    // Refresh the submit counter straight from the arm row (not via
    // getActiveArmSession, which returns nothing once the row is swept —
    // that would undercount a submit made just before expiry).
    const counts = db
      .prepare(
        `SELECT unattended_submissions_count AS n FROM automation_runs WHERE id = ?`,
      )
      .get(armRunId) as { n: number } | undefined;
    if (counts) report.submits_used = counts.n;

    appsSinceDiscover += 1;
    const ms = input.nextDelayMs
      ? input.nextDelayMs(delayRange, iter)
      : delayRange[0] + Math.floor((delayRange[1] - delayRange[0]) * ((iter % 3) / 3));
    await sleep(ms);
  }
  } finally {
    // The shared JobRight session outlived every app on purpose — this is
    // the one place it closes (CDP mode only disconnects, never closes the
    // operator's tabs — serviceSession.close() semantics).
    await dropNavSession();
  }

  // Post-session referral batch: drafts only, never send; failures are
  // review items. Runs even when the arm expired mid-loop — drafting does
  // not require an armed session, only its own flags.
  for (const { appId, appResult } of tailQueue) {
    logger.info("automation outreach tail begin (batched)", {
      service: "automation",
      action: "outreach_begin",
      application_id: appId,
      metadata: { batch_size: tailQueue.length },
    });
    const tail = await runOutreachTail({
      db,
      applicationId: appId,
      headless: input.headless ?? true,
      ...(input.emailClient ? { emailClient: input.emailClient } : {}),
      ...(input.draftRunner ? { draftRunner: input.draftRunner } : {}),
      ...(input.draftVerifier ? { draftVerifier: input.draftVerifier } : {}),
    });
    appResult.outreach = {
      email_status: tail.email_status,
      draft_status: tail.draft_status,
      skip_reason:
        tail.email_status === "skipped" || tail.draft_status === "skipped"
          ? (tail.notes[0] ?? "skipped")
          : null,
    };
    if (tail.email_status === "generated") report.emails_generated += 1;
    if (tail.draft_status === "verified" || tail.draft_status === "saved") {
      report.drafts_saved += 1;
    }
    for (const n of tail.notes) report.notes.push(`outreach ${appId}: ${n}`);
    logger.info("automation outreach tail end (batched)", {
      service: "automation",
      action: "outreach_end",
      application_id: appId,
      metadata: {
        email_status: tail.email_status,
        draft_status: tail.draft_status,
        notes: tail.notes,
      },
    });
  }

  // Post-session essay draft batch: the deterministic ladder parked these
  // questions (essays are the one field class it can never answer), so the
  // AI drafts suggestions into their review items automatically — the
  // operator's remaining act is edit/approve, not compose. Fail-open.
  if (seen.size > 0) {
    const essayBatch = await generateEssayDraftBatch({
      db,
      applicationIds: [...seen],
      ...(input.essayDraftClient ? { client: input.essayDraftClient } : {}),
    });
    report.essay_drafts_generated = essayBatch.drafts_generated;
    for (const n of essayBatch.notes) report.notes.push(n);
  }

  // Post-session screener prediction batch: questions the whole ladder
  // (registry, custom entries, LLM mapping, profile rules) couldn't
  // answer were queued at plan time; the LLM now proposes answers from
  // the operator's own context into review items with one-click promote.
  // Fail-open, and predictions never fill anything themselves.
  try {
    const predictBatch = await generateScreenerPredictions({
      db,
      ...(input.essayDraftClient ? { client: input.essayDraftClient } : {}),
    });
    report.screener_predictions_generated = predictBatch.predicted;
    for (const n of predictBatch.notes) report.notes.push(n);
  } catch (err) {
    report.notes.push(
      `screener predictions failed (continuing): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    );
  }

  // Post-session LLM failure triage: apps this session left in a parked/
  // failed state get one enumerated-action decision each (validated
  // deterministically; executed only when TRIAGE_ACT_ENABLED and the
  // action class is act-enabled). Post-session because the session's
  // `seen` set means a requeue wouldn't be re-picked this session anyway.
  // Fail-open — a triage error is a note, never a dead session.
  if (getConfig().triageLlmEnabled) {
    try {
      const TRIAGEABLE_END_STATES = new Set([
        "FAILED_RETRYABLE",
        "AUTH_REQUIRED",
        "CAPTCHA_REQUIRED",
        "UNSUPPORTED_ATS",
        "AMBIGUOUS_FIELD",
      ]);
      // #175: gate-stop parks leave the app mid-state with no transition —
      // invisible to `retry` and previously to triage. They are failures
      // too; the requeue executors demote through the legal edge first.
      const GATE_PARK_STATES = new Set([
        "NATIVE_AUTOFILL_RUNNING",
        "READY_TO_SUBMIT",
      ]);
      const targets = report.per_app.filter(
        (a) =>
          !a.submitted &&
          (TRIAGEABLE_END_STATES.has(a.end_state ?? "") ||
            (a.stopped === "gate" && GATE_PARK_STATES.has(a.end_state ?? ""))),
      );
      if (targets.length > 0) {
        const stopReasons = new Map<string, string | null>(
          targets.map((a) => [a.application_id, a.stop_reason ?? null]),
        );
        const triage = await runTriageBatch({
          db,
          applicationIds: targets.map((a) => a.application_id),
          act: getConfig().triageActEnabled,
          armRunId,
          stopReasons,
          ...(input.triageClient ? { client: input.triageClient } : {}),
        });
        report.triage = {
          decided: triage.results.filter((r) => r.decision_id !== null).length,
          executed: triage.results.filter((r) => r.executed).length,
        };
        for (const n of triage.notes) report.notes.push(n);
        for (const r of triage.results) {
          if (r.action !== null) {
            report.notes.push(
              `triage ${r.application_id.slice(0, 8)}: ${r.action}${r.executed ? " (executed)" : ""} — ${r.note}`,
            );
          }
        }
      }
    } catch (err) {
      report.notes.push(
        `triage batch failed (continuing): ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      );
    }
  }

  // Stage-1 improvement loop, courier leg: ship this session's artifacts
  // to the remote so the analysis agent sees fresh run data. Fail-open;
  // the pre-commit secret gate is never bypassed.
  if (getConfig().artifactAutopushEnabled) {
    const push = await autopushArtifacts({ armRunId });
    report.artifact_autopush = {
      pushed: push.pushed,
      commit: push.commit,
      files_staged: push.files_staged,
    };
    for (const n of push.notes) report.notes.push(n);
  }

  emit();
  logger.info("automation session finished", {
    service: "automation",
    action: "session_end",
    metadata: {
      arm_run_id: armRunId,
      apps_started: report.apps_started,
      submits_used: report.submits_used,
      stopped_reason: report.stopped_reason,
      discover_runs: report.discover_runs,
      emails_generated: report.emails_generated,
      drafts_saved: report.drafts_saved,
      essay_drafts_generated: report.essay_drafts_generated,
      screener_predictions_generated: report.screener_predictions_generated,
      notes: report.notes,
      per_app: report.per_app.map((a) => ({
        application_id: a.application_id,
        end_state: a.end_state,
        stopped: a.stopped,
        stop_reason: a.stop_reason,
        submitted: a.submitted,
      })),
    },
  });
  return report;
}

function toAppResult(db: Db, appReport: PipelineAppReport): AutomationAppResult {
  const submitted =
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM submissions
           WHERE application_id = ? AND status = 'VERIFIED' AND submitted = 1`,
        )
        .get(appReport.application_id) as { n: number }
    ).n > 0;
  return {
    application_id: appReport.application_id,
    end_state: appReport.end_state,
    stopped: appReport.stopped,
    stop_reason: appReport.stop_reason,
    submitted,
    outreach: null,
  };
}
