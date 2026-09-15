import {
  BROWSER_USE_MODELS,
  BrowserUseAmbiguousCreateError,
  TERMINAL_RUN_STATUSES,
  isAmbiguousCreateFailure,
  parseUsd,
  type BrowserUseApi,
  type RunCreateInput,
  type RunCreated,
  type RunSummary,
} from "./api.js";
import { isEngineBrowser } from "./provider.js";
import { nullLedger, type Ledger } from "./ledger.js";

/**
 * Hosted agent runs (Browser Use v4 `/runs`): start behind the agent
 * flag with a hard per-run cost cap, poll the cheap status endpoint until
 * terminal (attempt-capped; an abandoned wait cancels the run so it stops
 * billing), validate the result deterministically, and sweep what a dead
 * process left behind. Nothing in here retries a create.
 */

export type RunPolicy = {
  /** BROWSER_USE_AGENT_ENABLED — creating a run spends credits. */
  agentEnabled: boolean;
  /** BROWSER_USE_MODEL */
  model: string;
  /** BROWSER_USE_MAX_COST_USD — the ceiling any request may ask for. */
  maxCostUsd: number;
};

export type RunRequest = {
  task: string;
  model?: string;
  maxCostUsd?: number;
  sessionId?: string;
  profileId?: string | null;
  proxy?: boolean;
  judgeContext?: string;
};

/** Pure: the request the provider will see, or a refusal naming the policy line it breaks. */
export function resolveRunRequest(req: RunRequest, policy: RunPolicy): RunCreateInput {
  const task = req.task.trim();
  if (!task) throw new Error("browser_use run refused: empty task");
  const model = req.model ?? policy.model;
  if (!(BROWSER_USE_MODELS as readonly string[]).includes(model)) {
    throw new Error(`browser_use run refused: model "${model}" is not in the v4 model list (${BROWSER_USE_MODELS.join(", ")})`);
  }
  const maxCostUsd = req.maxCostUsd ?? policy.maxCostUsd;
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new Error("browser_use run refused: maxCostUsd must be a positive number");
  if (maxCostUsd > policy.maxCostUsd + 1e-9) {
    throw new Error(`browser_use run refused: maxCostUsd ${maxCostUsd} exceeds BROWSER_USE_MAX_COST_USD=${policy.maxCostUsd}`);
  }
  const browserSettings: RunCreateInput["browserSettings"] = {};
  if (req.profileId !== undefined) browserSettings.profileId = req.profileId;
  if (req.proxy === false) browserSettings.proxyCountryCode = null;
  return {
    task,
    model,
    maxCostUsd,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    ...(Object.keys(browserSettings).length > 0 ? { browserSettings } : {}),
    ...(req.judgeContext !== undefined ? { judge: { context: req.judgeContext } } : {}),
  };
}

/** Create ONE run. A definite refusal (4xx) is thrown as-is; anything else is ambiguous and never re-sent. */
export async function startRun(api: BrowserUseApi, req: RunRequest, policy: RunPolicy, ledger: Ledger = nullLedger): Promise<RunCreated> {
  if (!policy.agentEnabled) {
    throw new Error("browser_use run refused: BROWSER_USE_AGENT_ENABLED is false (fail-closed default) — hosted agent runs spend credits.");
  }
  const input = resolveRunRequest(req, policy);
  let created: RunCreated;
  try {
    created = await api.createRun(input);
  } catch (err) {
    if (isAmbiguousCreateFailure(err)) {
      // The provider may hold a billing run we never got the id of; this line is what `runs` is reconciled against.
      ledger.append({ kind: "run", id: "?", action: "create_ambiguous", model: input.model, max_cost_usd: input.maxCostUsd, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      throw new BrowserUseAmbiguousCreateError("run", err);
    }
    throw err;
  }
  ledger.append({ kind: "run", id: created.id, action: "created", model: created.model, max_cost_usd: input.maxCostUsd, session_id: created.sessionId });
  return created;
}

export type WaitOptions = {
  timeoutMs?: number;
  intervalMs?: number;
  /** Hard cap on status polls; defaults to what the timeout allows (+1), never above MAX_POLLS. */
  maxPolls?: number;
  /** Consecutive poll failures tolerated before the wait gives up (and cancels). */
  maxPollErrors?: number;
  /** Past the deadline (or the error budget) the run is cancelled (default) so an abandoned run stops billing. */
  cancelOnTimeout?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type WaitStop = "terminal" | "deadline" | "poll_cap" | "poll_errors";

export type WaitOutcome = {
  summary: RunSummary;
  /** True unless the run reached a terminal state on its own. */
  timedOut: boolean;
  stoppedBy: WaitStop;
  polls: number;
  /** The last poll failure, when the wait ended on errors. */
  lastError: string | null;
};

const DEFAULT_WAIT = { timeoutMs: 10 * 60_000, intervalMs: 2_000, maxPollErrors: 3 };
/** Absolute ceiling on status polls in one wait (4 h at the 2 s interval — the provider's own run limit). */
export const MAX_POLLS = 7_200;

/**
 * Poll `status` (tiny) until terminal, then fetch the summary once.
 * Attempt-capped by time AND count; a poll failure never leaves a billing
 * run behind — after the error budget the run is cancelled like a timeout.
 */
export async function waitForRun(api: BrowserUseApi, runId: string, opts: WaitOptions = {}, ledger: Ledger = nullLedger): Promise<WaitOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT.timeoutMs;
  const intervalMs = Math.max(1, opts.intervalMs ?? DEFAULT_WAIT.intervalMs);
  const maxPolls = Math.min(MAX_POLLS, opts.maxPolls ?? Math.ceil(timeoutMs / intervalMs) + 1);
  const maxPollErrors = opts.maxPollErrors ?? DEFAULT_WAIT.maxPollErrors;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let polls = 0;
  let errors = 0;
  let lastError: string | null = null;
  let stoppedBy: WaitStop = "poll_cap";
  while (polls < maxPolls) {
    polls += 1;
    try {
      const status = await api.runStatus(runId);
      errors = 0;
      if (TERMINAL_RUN_STATUSES.has(status)) {
        const summary = await api.getRun(runId);
        ledger.append({ kind: "run", id: runId, action: "terminal", status: summary.status, total_cost_usd: summary.totalCostUsd, polls });
        return { summary, timedOut: false, stoppedBy: "terminal", polls, lastError: null };
      }
    } catch (err) {
      errors += 1;
      lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      if (errors >= maxPollErrors) {
        stoppedBy = "poll_errors";
        break;
      }
    }
    if (now() >= deadline) {
      stoppedBy = "deadline";
      break;
    }
    await sleep(intervalMs);
  }

  const finish = async (action: string): Promise<RunSummary> => {
    // A run that went terminal between the last poll and now is returned as-is (cancel is idempotent);
    // if even the cancel fails, the summary is still fetched so the caller sees the real state.
    try {
      return await api.cancelRun(runId);
    } catch (err) {
      lastError = err instanceof Error ? err.message.slice(0, 200) : String(err);
      ledger.append({ kind: "run", id: runId, action: `${action}_cancel_failed`, error: lastError, polls });
      return api.getRun(runId);
    }
  };
  if (opts.cancelOnTimeout ?? true) {
    const summary = await finish("cancelled_after_wait");
    ledger.append({ kind: "run", id: runId, action: "cancelled_after_wait", status: summary.status, total_cost_usd: summary.totalCostUsd, polls, stopped_by: stoppedBy });
    return { summary, timedOut: true, stoppedBy, polls, lastError };
  }
  const summary = await api.getRun(runId);
  ledger.append({ kind: "run", id: runId, action: "wait_abandoned", status: summary.status, polls, stopped_by: stoppedBy });
  return { summary, timedOut: true, stoppedBy, polls, lastError };
}

export type ResultSchema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { message: string } } };

export type RunValidation<T = unknown> = {
  ok: boolean;
  status: RunSummary["status"];
  reasons: string[];
  costUsd: number | null;
  overCap: boolean;
  /** The parsed output when a schema was given and passed; else the raw result text. */
  output: T | string | null;
};

/** Find the JSON an agent wrapped in prose or a code fence; null when there is none. */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.unshift(fence[1].trim());
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    const close = trimmed[start] === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end > start) candidates.push(trimmed.slice(start, end + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c) as unknown;
    } catch {
      // next candidate
    }
  }
  return null;
}

/** Deterministic read-back of a finished run: completed + non-empty + within the cap (+ schema when given). */
export function validateRunResult<T = unknown>(summary: RunSummary, opts: { maxCostUsd: number; schema?: ResultSchema<T> }): RunValidation<T> {
  const reasons: string[] = [];
  if (summary.status !== "completed") reasons.push(`run ${summary.status}${summary.error ? `: ${summary.error.slice(0, 200)}` : ""}`);
  const result = summary.result?.trim() ?? "";
  if (summary.status === "completed" && result === "") reasons.push("run completed with an empty result");
  const costUsd = parseUsd(summary.totalCostUsd);
  const overCap = costUsd !== null && costUsd > opts.maxCostUsd + 1e-9;
  if (overCap) reasons.push(`totalCostUsd ${costUsd} exceeds the run cap ${opts.maxCostUsd}`);
  let output: T | string | null = result === "" ? null : result;
  if (opts.schema && summary.status === "completed" && result !== "") {
    const json = extractJson(result);
    if (json === null) {
      reasons.push("result is not JSON");
    } else {
      const parsed = opts.schema.safeParse(json);
      if (parsed.success) output = parsed.data;
      else reasons.push(`result does not match the schema: ${parsed.error.message.slice(0, 200)}`);
    }
  }
  return { ok: reasons.length === 0, status: summary.status, reasons, costUsd, overCap, output };
}

export type SweepOptions = {
  now?: () => Date;
  /**
   * Runs this engine created (the ledger's `created` ids). Only these may
   * be cancelled — the account key may also serve the dashboard or another
   * tool. Omitted ⇒ no run is cancelled, only counted.
   */
  knownRunIds?: ReadonlySet<string>;
  /** A known non-terminal run older than this is cancelled. */
  runMaxAgeMs?: number;
  /** An ENGINE browser (origin label) still active past this is stopped. */
  browserMaxAgeMs?: number;
  dryRun?: boolean;
  /** Bound on cancels + stops per sweep. */
  maxActions?: number;
  maxPages?: number;
};

export type SweepReport = {
  dry_run: boolean;
  runs_seen: number;
  runs_cancelled: string[];
  /** Non-terminal runs past the age that are not in knownRunIds — reported, never cancelled. */
  foreign_stale_runs: number;
  browsers_seen: number;
  browsers_stopped: string[];
  /** Active browsers the provider spawned for its own agent runs (agentSessionId set) — the run's cancel ends them. */
  run_owned_active_browsers: number;
  /** Other active browsers on the account this engine did not create — reported, never touched. */
  foreign_active_browsers: number;
  errors: string[];
  capped: boolean;
};

const DEFAULT_SWEEP = { runMaxAgeMs: 30 * 60_000, browserMaxAgeMs: 30 * 60_000, maxActions: 50, maxPages: 5 };

function ageMs(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? now.getTime() - t : null;
}

/** Cancel runs and stop engine browsers that outlived any live wait. Bounded by pages and actions. */
export async function sweepAbandoned(api: BrowserUseApi, opts: SweepOptions = {}, ledger: Ledger = nullLedger): Promise<SweepReport> {
  const now = (opts.now ?? (() => new Date()))();
  const runMaxAgeMs = opts.runMaxAgeMs ?? DEFAULT_SWEEP.runMaxAgeMs;
  const browserMaxAgeMs = opts.browserMaxAgeMs ?? DEFAULT_SWEEP.browserMaxAgeMs;
  const maxActions = opts.maxActions ?? DEFAULT_SWEEP.maxActions;
  const maxPages = opts.maxPages ?? DEFAULT_SWEEP.maxPages;
  const dryRun = opts.dryRun ?? false;
  const report: SweepReport = {
    dry_run: dryRun,
    runs_seen: 0,
    runs_cancelled: [],
    foreign_stale_runs: 0,
    browsers_seen: 0,
    browsers_stopped: [],
    run_owned_active_browsers: 0,
    foreign_active_browsers: 0,
    errors: [],
    capped: false,
  };
  let actions = 0;
  const budgetLeft = (): boolean => {
    if (actions >= maxActions) {
      report.capped = true;
      return false;
    }
    return true;
  };

  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const { runs, nextCursor } = await api.listRuns({ limit: 50, ...(cursor ? { cursor } : {}) });
    report.runs_seen += runs.length;
    for (const run of runs) {
      if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
      const age = ageMs(run.createdAt, now);
      if (age === null || age < runMaxAgeMs) continue;
      if (!opts.knownRunIds?.has(run.id)) {
        report.foreign_stale_runs += 1;
        continue;
      }
      if (!budgetLeft()) break;
      actions += 1;
      if (dryRun) {
        report.runs_cancelled.push(run.id);
        continue;
      }
      try {
        const after = await api.cancelRun(run.id);
        report.runs_cancelled.push(run.id);
        ledger.append({ kind: "run", id: run.id, action: "swept_cancel", status: after.status, total_cost_usd: after.totalCostUsd, age_ms: age });
      } catch (err) {
        report.errors.push(`cancel ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!nextCursor || report.capped) break;
    cursor = nextCursor;
  }

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const { items, totalItems } = await api.listBrowsers({ active: true, pageSize: 50, pageNumber });
    report.browsers_seen += items.length;
    for (const b of items) {
      if (b.status !== "active") continue;
      if (!isEngineBrowser(b.metadata)) {
        if (b.agentSessionId) report.run_owned_active_browsers += 1;
        else report.foreign_active_browsers += 1;
        continue;
      }
      const age = ageMs(b.startedAt, now);
      if (age === null || age < browserMaxAgeMs) continue;
      if (!budgetLeft()) break;
      actions += 1;
      if (dryRun) {
        report.browsers_stopped.push(b.id);
        continue;
      }
      try {
        const after = await api.stopBrowser(b.id);
        report.browsers_stopped.push(b.id);
        ledger.append({ kind: "browser", id: b.id, action: "swept_stop", status: after.status, browser_cost: after.browserCost, age_ms: age });
      } catch (err) {
        report.errors.push(`stop ${b.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (items.length === 0 || report.browsers_seen >= totalItems || report.capped) break;
  }
  return report;
}
