import { getConfig, type AppConfig } from "../config/index.js";
import { sdkBrowserUseApi } from "./browserUse/api.js";
import { fileLedger } from "./browserUse/ledger.js";
import { browserUseProvider } from "./browserUse/provider.js";

/**
 * Remote browser provider seam (plan v0.5, M17).
 *
 * A hosted user connects their JobRight account by driving a browser we
 * host: the engine creates a session, the web app embeds its live view,
 * the user signs in, then the engine attaches to the SAME session over
 * CDP (through the ordinary session seam, gated by
 * src/auth/cdpPolicy.ts) and captures the storageState.
 *
 * Only the provider's HTTP API lives here — no browser is launched or
 * attached in this module. Keys are sent as headers and never logged or
 * returned; connect URLs carry the key and are therefore treated as a
 * secret too (never persisted, never put on a cloud row).
 *
 * Browserbase is the first implementation (sessions API v1). Its exact
 * response shapes are UNVERIFIED until the M16 spike runs with a real
 * account; every field this module reads is optional and a missing one
 * is a loud failure, never a guess.
 */

export type RemoteBrowserSession = {
  provider: string;
  sessionId: string;
  /** CDP endpoint for the engine. SECRET (carries the key). */
  connectUrl: string;
  /** What the user sees in the web app (iframe / new tab). Not secret. */
  liveViewUrl: string;
  /** Provider-side expiry, if it reports one. */
  expiresAt: string | null;
};

export type RemoteBrowserProvider = {
  readonly name: string;
  /**
   * A session, optionally on a persisted browser context (cookies and
   * storage carried between sessions — the "sign in once" hedge from the
   * spike doc, and what lets a reconnect start already signed in).
   */
  createSession(input: { userId: string; keepAliveSeconds?: number; contextId?: string }): Promise<RemoteBrowserSession>;
  /** A new persisted context for a user (Browserbase Contexts API); optional for providers without one. */
  createContext?(input: { userId: string }): Promise<string>;
  /** Live view URL for an existing session (refreshable; the debug URL can rotate). */
  liveViewUrl(sessionId: string): Promise<string>;
  /**
   * CDP endpoint for an existing session — SECRET, never stored on a row.
   * Browserbase derives it from the key; Browser Use only ever returns it,
   * so a cold reconnect may have to read it back (hence the Promise).
   */
  connectUrl(sessionId: string): string | Promise<string>;
  endSession(sessionId: string): Promise<void>;
};

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** Refuses by name — the provider selected when REMOTE_BROWSER_ENABLED is off. */
export const nullProvider: RemoteBrowserProvider = {
  name: "none",
  async createSession() {
    throw new Error("remote browser refused: REMOTE_BROWSER_ENABLED is false (fail-closed default) — no provider is configured.");
  },
  async liveViewUrl() {
    throw new Error("remote browser refused: REMOTE_BROWSER_ENABLED is false (fail-closed default).");
  },
  connectUrl() {
    throw new Error("remote browser refused: REMOTE_BROWSER_ENABLED is false (fail-closed default).");
  },
  async endSession() {
    // nothing was ever created
  },
};

export const BROWSERBASE_API = "https://api.browserbase.com/v1";
export const BROWSERBASE_CONNECT = "wss://connect.browserbase.com";
/** Default provider-side lifetime of a handoff session (the task expires at 15 min). */
export const DEFAULT_HANDOFF_SESSION_SECONDS = 20 * 60;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function browserbaseProvider(input: {
  apiKey: string;
  projectId: string;
  fetch?: FetchLike;
  apiBase?: string;
  /** Route the session through the provider's residential proxy pool (the datacenter-IP hedge). */
  proxies?: boolean;
}): RemoteBrowserProvider {
  const doFetch: FetchLike = input.fetch ?? ((url, init) => fetch(url, init));
  const base = (input.apiBase ?? BROWSERBASE_API).replace(/\/$/, "");
  const headers = { "x-bb-api-key": input.apiKey, "content-type": "application/json" };

  async function call(method: string, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}${pathname}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      // The provider's own error text, clipped; the key is in a header, never in the body we echo.
      throw new Error(`browserbase ${method} ${pathname} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`browserbase ${method} ${pathname}: non-JSON response`);
    }
  }

  function connectUrlFor(sessionId: string): string {
    const u = new URL(BROWSERBASE_CONNECT);
    u.searchParams.set("apiKey", input.apiKey);
    u.searchParams.set("sessionId", sessionId);
    return u.toString();
  }

  async function liveView(sessionId: string): Promise<string> {
    const debug = await call("GET", `/sessions/${encodeURIComponent(sessionId)}/debug`);
    const url = str(debug["debuggerFullscreenUrl"]) ?? str(debug["debuggerUrl"]);
    if (!url) throw new Error("browserbase debug endpoint returned no live-view URL");
    return url;
  }

  return {
    name: "browserbase",
    async createContext({ userId }) {
      const created = await call("POST", "/contexts", { projectId: input.projectId });
      const id = str(created["id"]);
      if (!id) throw new Error("browserbase create context returned no id");
      void userId; // the context is bound to the tenant by where the engine stores its id, not by the provider
      return id;
    },
    async createSession({ userId, keepAliveSeconds, contextId }) {
      const created = await call("POST", "/sessions", {
        projectId: input.projectId,
        // A handoff outlives the user's clicks for a while but never forever.
        timeout: Math.max(60, Math.min(keepAliveSeconds ?? DEFAULT_HANDOFF_SESSION_SECONDS, 6 * 3600)),
        keepAlive: false,
        ...(input.proxies ? { proxies: true } : {}),
        // persist: true writes the session's cookies/storage back into the
        // context when it ends, so the next session on it starts signed in.
        ...(contextId ? { browserSettings: { context: { id: contextId, persist: true } } } : {}),
        userMetadata: { dispatch_user: userId },
      });
      const sessionId = str(created["id"]);
      if (!sessionId) throw new Error("browserbase create session returned no id");
      const connectUrl = str(created["connectUrl"]) ?? connectUrlFor(sessionId);
      const liveViewUrl = await liveView(sessionId);
      return {
        provider: "browserbase",
        sessionId,
        connectUrl,
        liveViewUrl,
        expiresAt: str(created["expiresAt"]),
      };
    },
    liveViewUrl: liveView,
    connectUrl: connectUrlFor,
    async endSession(sessionId) {
      await call("POST", `/sessions/${encodeURIComponent(sessionId)}`, {
        projectId: input.projectId,
        status: "REQUEST_RELEASE",
      });
    },
  };
}

/**
 * The provider this process may use behind REMOTE_BROWSER_ENABLED —
 * REMOTE_BROWSER_PROVIDER picks Browserbase (default) or Browser Use
 * (which also needs BROWSER_USE_ENABLED + its key); otherwise the
 * refusing one. env.ts already refuses a missing credential at boot.
 */
export function resolveRemoteBrowserProvider(config: AppConfig = getConfig(), fetchImpl?: FetchLike): RemoteBrowserProvider {
  if (!config.remoteBrowserEnabled) return nullProvider;
  if (config.remoteBrowserProvider === "browser_use") {
    if (!config.browserUseEnabled || !config.browserUseApiKey) return nullProvider;
    // The SDK reads the global fetch at call time; a per-call fetch cannot be honoured, so it is refused rather than half-applied.
    if (fetchImpl) throw new Error("resolveRemoteBrowserProvider: the browser_use provider takes no fetch override (stub the global fetch instead)");
    return browserUseProvider(sdkBrowserUseApi({ apiKey: config.browserUseApiKey }), {
      defaultTimeoutMinutes: config.browserUseBrowserTimeoutMin,
      ledger: fileLedger(config.privateDir),
    });
  }
  if (!config.browserbaseApiKey || !config.browserbaseProjectId) return nullProvider;
  return browserbaseProvider({
    apiKey: config.browserbaseApiKey,
    projectId: config.browserbaseProjectId,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** Strip a connect URL down to something loggable (host only — the key rides the query). */
export function redactConnectUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "<unparsable connect url>";
  }
}
