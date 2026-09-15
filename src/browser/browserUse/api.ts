import { BrowserUse, BrowserUseError } from "browser-use-sdk/v4";

/**
 * Browser Use Cloud (API v4) — the narrow surface this engine uses, as an
 * interface so every caller can be tested against a fake without a key or
 * the network.
 *
 * Production goes through the official `browser-use-sdk` (runs + managed
 * browsers); the three endpoints the SDK's v4 client does not expose yet
 * (GET /browsers/{id}, GET /browsers, POST /profiles) use the same header
 * over a plain fetch. The key is sent as a header only — never logged,
 * never returned, never put in a URL. Error text from the provider is
 * clipped; the key is never in it.
 *
 * Creates are NEVER retried here: a timeout or a 5xx on POST /runs or
 * POST /browsers may have created (and started billing) a resource, so
 * the caller gets a typed ambiguous-create error and reconciles by
 * listing, never by re-creating. The SDK's own retry loop re-sends only
 * on HTTP 429 (the server refused before doing anything — a definite
 * outcome); a transport error or timeout is thrown after ONE request.
 *
 * Tests stub the global fetch (the SDK reads it at call time); there is
 * deliberately no per-client fetch option, so no path can half-honour it.
 */

export const BROWSER_USE_API_V4 = "https://api.browser-use.com/api/v4";
export const BROWSER_USE_DEFAULT_MODEL = "gpt-5.6-luna";

/** RunCreateRequest.model enum, openapi v4 (2026-09-15). */
export const BROWSER_USE_MODELS = [
  "glm-5.2",
  "grok-4.5",
  "grok-4.6",
  "glm-5.3-flash",
  "deepseek-v4-flash-vision",
  "kimi-k3",
  "minimax-m3",
  "claude-opus-4.7",
  "claude-opus-4.8",
  "claude-opus-5",
  "claude-fable-5",
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro",
  "gemini-3-flash",
] as const;

export type RunStatus = "queued" | "dispatching" | "running" | "completed" | "failed" | "cancelled";
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export type RunBrowserSettings = {
  profileId?: string | null;
  /** null ⇒ no proxy; omitted ⇒ provider default (US). */
  proxyCountryCode?: string | null;
  record?: boolean | null;
};

export type RunCreateInput = {
  task: string;
  model: string;
  /** Hard spend cap for this run, forwarded verbatim as maxCostUsd. */
  maxCostUsd: number;
  sessionId?: string;
  browserSettings?: RunBrowserSettings;
  /** Presence turns the provider's post-run judge on (billed to the run). */
  judge?: { context?: string | null };
};

export type RunCreated = { id: string; status: RunStatus; sessionId: string; model: string };

export type RunSummary = {
  id: string;
  status: RunStatus;
  task: string;
  model: string;
  result: string | null;
  error: string | null;
  sessionId: string;
  totalCostUsd: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  createdAt: string;
  updatedAt: string;
  judgement?: unknown;
};

export type BrowserSession = {
  id: string;
  status: "active" | "stopped";
  liveUrl: string | null;
  /** SECRET (carries an access token). */
  cdpUrl: string | null;
  timeoutAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  metadata: Record<string, string>;
  /** Set when the provider spawned this browser for one of its own agent runs. */
  agentSessionId: string | null;
  browserCost: string | null;
  proxyCost: string | null;
};

export type BrowserCreateInput = {
  profileId?: string | null;
  /** Minutes, provider max 240; billed upfront, unused time refunded on stop. */
  timeout: number;
  metadata?: Record<string, string>;
  /** House rule: the engine never bypasses CAPTCHAs — always false. */
  solveCaptchas: false;
  proxyCountryCode?: string | null;
  enableRecording?: boolean;
};

export type BrowserUseApi = {
  createRun(input: RunCreateInput): Promise<RunCreated>;
  runStatus(runId: string): Promise<RunStatus>;
  getRun(runId: string): Promise<RunSummary>;
  cancelRun(runId: string): Promise<RunSummary>;
  listRuns(params?: { limit?: number; cursor?: string | null }): Promise<{ runs: RunSummary[]; nextCursor: string | null }>;
  createBrowser(input: BrowserCreateInput): Promise<BrowserSession>;
  getBrowser(browserId: string): Promise<BrowserSession>;
  stopBrowser(browserId: string): Promise<BrowserSession>;
  listBrowsers(params?: { active?: boolean; pageSize?: number; pageNumber?: number }): Promise<{ items: BrowserSession[]; totalItems: number }>;
  createProfile(input: { userId: string; name?: string }): Promise<{ id: string }>;
};

/** A create whose outcome the caller cannot know (timeout / transport / 5xx): never re-sent. */
export class BrowserUseAmbiguousCreateError extends Error {
  readonly resource: "run" | "browser";
  constructor(resource: "run" | "browser", cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(
      `browser_use create ${resource} outcome unknown (${why}). Not retried: the provider may have created it — reconcile with \`npm run browseruse -- ${resource === "run" ? "runs" : "browsers"}\` before creating again.`,
    );
    this.name = "BrowserUseAmbiguousCreateError";
    this.resource = resource;
  }
}

/** A 4xx is a definite refusal; anything else after a create is ambiguous. */
export function isAmbiguousCreateFailure(err: unknown): boolean {
  if (err instanceof BrowserUseError) return err.statusCode >= 500;
  return true;
}

/** Provider decimals arrive as strings ("0.1234"); a missing/garbage value is null, never 0. */
export function parseUsd(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function need(v: unknown, what: string): string {
  const s = str(v);
  if (!s) throw new Error(`browser_use response missing ${what}`);
  return s;
}

function runStatusOf(v: unknown): RunStatus {
  const s = str(v);
  if (s === "queued" || s === "dispatching" || s === "running" || s === "completed" || s === "failed" || s === "cancelled") return s;
  throw new Error(`browser_use response has an unknown run status: ${JSON.stringify(v)}`);
}

function toRunSummary(r: Record<string, unknown>): RunSummary {
  return {
    id: need(r["id"], "run id"),
    status: runStatusOf(r["status"]),
    task: typeof r["task"] === "string" ? r["task"] : "",
    model: typeof r["model"] === "string" ? r["model"] : "",
    result: str(r["result"]),
    error: str(r["error"]),
    sessionId: typeof r["sessionId"] === "string" ? r["sessionId"] : "",
    totalCostUsd: typeof r["totalCostUsd"] === "string" ? r["totalCostUsd"] : String(r["totalCostUsd"] ?? ""),
    totalInputTokens: typeof r["totalInputTokens"] === "number" ? r["totalInputTokens"] : 0,
    totalOutputTokens: typeof r["totalOutputTokens"] === "number" ? r["totalOutputTokens"] : 0,
    createdAt: typeof r["createdAt"] === "string" ? r["createdAt"] : "",
    updatedAt: typeof r["updatedAt"] === "string" ? r["updatedAt"] : "",
    judgement: r["judgement"],
  };
}

function toBrowserSession(b: Record<string, unknown>): BrowserSession {
  const status = str(b["status"]);
  if (status !== "active" && status !== "stopped") throw new Error(`browser_use response has an unknown browser status: ${JSON.stringify(b["status"])}`);
  const meta = b["metadata"];
  const metadata: Record<string, string> = {};
  if (meta && typeof meta === "object") {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) if (typeof v === "string") metadata[k] = v;
  }
  return {
    id: need(b["id"], "browser id"),
    status,
    liveUrl: str(b["liveUrl"]),
    cdpUrl: str(b["cdpUrl"]),
    timeoutAt: str(b["timeoutAt"]),
    startedAt: str(b["startedAt"]),
    finishedAt: str(b["finishedAt"]),
    metadata,
    agentSessionId: str(b["agentSessionId"]),
    browserCost: str(b["browserCost"]),
    proxyCost: str(b["proxyCost"]),
  };
}

export type SdkApiOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Per-request cap for the SDK client and the shim alike. */
  timeoutMs?: number;
};

/** The production BrowserUseApi: the official SDK plus a plain-fetch shim for what it lacks. */
export function sdkBrowserUseApi(opts: SdkApiOptions): BrowserUseApi {
  if (!opts.apiKey) throw new Error("browser_use: no API key (BROWSER_USE_API_KEY)");
  const base = (opts.baseUrl ?? BROWSER_USE_API_V4).replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const client = new BrowserUse({ apiKey: opts.apiKey, baseUrl: base, timeout: timeoutMs });

  async function raw(method: string, pathname: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<Record<string, unknown>> {
    const u = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: { ok: boolean; status: number; text(): Promise<string> };
    let text: string;
    try {
      res = await fetch(u.toString(), {
        method,
        headers: { "X-Browser-Use-API-Key": opts.apiKey, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`browser_use ${method} ${pathname}: ${controller.signal.aborted ? `timed out after ${timeoutMs}ms` : why}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new BrowserUseError(res.status, `browser_use ${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`browser_use ${method} ${pathname}: non-JSON response`);
    }
  }

  return {
    async createRun(input) {
      const created = (await client.runs.create({
        task: input.task,
        // The SDK's model union (3.11.3) lags the live v4 enum; the list
        // above is the spec's and resolveRunRequest already validated it.
        model: input.model as never,
        maxCostUsd: input.maxCostUsd,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        // proxyCountryCode is a 250-value ISO enum in the SDK; ours is a plain string the server validates.
        ...(input.browserSettings ? { browserSettings: input.browserSettings as never } : {}),
        ...(input.judge ? { judge: input.judge } : {}),
      })) as unknown as Record<string, unknown>;
      return {
        id: need(created["id"], "run id"),
        status: runStatusOf(created["status"]),
        sessionId: typeof created["sessionId"] === "string" ? created["sessionId"] : "",
        model: typeof created["model"] === "string" ? created["model"] : input.model,
      };
    },
    async runStatus(runId) {
      const r = (await client.runs.status(runId)) as unknown as Record<string, unknown>;
      return runStatusOf(r["status"]);
    },
    async getRun(runId) {
      return toRunSummary((await client.runs.get(runId)) as unknown as Record<string, unknown>);
    },
    async cancelRun(runId) {
      return toRunSummary((await client.runs.cancel(runId)) as unknown as Record<string, unknown>);
    },
    async listRuns(params) {
      const r = (await client.runs.list({
        ...(params?.limit !== undefined ? { limit: params.limit } : {}),
        ...(params?.cursor ? { cursor: params.cursor } : {}),
      })) as unknown as Record<string, unknown>;
      const runs = Array.isArray(r["runs"]) ? (r["runs"] as Record<string, unknown>[]).map(toRunSummary) : [];
      return { runs, nextCursor: str(r["nextCursor"]) };
    },
    async createBrowser(input) {
      const created = (await client.browsers.create({
        profileId: input.profileId ?? null,
        timeout: input.timeout,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        solveCaptchas: false,
        ...(input.proxyCountryCode !== undefined ? { proxyCountryCode: input.proxyCountryCode as never } : {}),
        ...(input.enableRecording !== undefined ? { enableRecording: input.enableRecording } : {}),
      })) as unknown as Record<string, unknown>;
      return toBrowserSession(created);
    },
    async getBrowser(browserId) {
      return toBrowserSession(await raw("GET", `/browsers/${encodeURIComponent(browserId)}`));
    },
    async stopBrowser(browserId) {
      return toBrowserSession((await client.browsers.stop(browserId)) as unknown as Record<string, unknown>);
    },
    async listBrowsers(params) {
      const r = await raw("GET", "/browsers", {
        pageSize: params?.pageSize ?? 50,
        pageNumber: params?.pageNumber ?? 1,
        filterBy: params?.active === undefined ? undefined : params.active ? "active" : "stopped",
      });
      const items = Array.isArray(r["items"]) ? (r["items"] as Record<string, unknown>[]).map(toBrowserSession) : [];
      return { items, totalItems: typeof r["totalItems"] === "number" ? r["totalItems"] : items.length };
    },
    async createProfile(input) {
      const p = await raw("POST", "/profiles", undefined, { userId: input.userId, ...(input.name ? { name: input.name } : {}) });
      return { id: need(p["id"], "profile id") };
    },
  };
}

export { BrowserUseError };
