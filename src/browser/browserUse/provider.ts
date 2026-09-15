import type { RemoteBrowserProvider } from "../remoteBrowser.js";
import { type BrowserUseApi, BrowserUseAmbiguousCreateError, isAmbiguousCreateFailure } from "./api.js";
import { nullLedger, type Ledger } from "./ledger.js";

/**
 * Browser Use Cloud managed browsers as a RemoteBrowserProvider (the same
 * seam Browserbase fills): the web app embeds `liveUrl`, the user signs
 * in there, the engine attaches to the SAME browser over `cdpUrl` through
 * the ordinary session seam (admitted by cdpPolicy only behind
 * REMOTE_BROWSER_ENABLED). A profile is the provider's persisted context
 * (cookies + storage across browsers) — one per tenant, like a Browserbase
 * context.
 *
 * Every browser this engine creates is labelled with metadata so a sweep
 * can tell ours from anything else on the account; CAPTCHA solving is
 * always off (house rule); a browser that comes back unusable is stopped
 * before the error propagates so nothing keeps billing; every create,
 * stop and ambiguous create goes to the ledger.
 */

export const BROWSER_USE_PROVIDER_NAME = "browser_use";
export const BROWSER_USE_ORIGIN_KEY = "origin";
export const BROWSER_USE_ORIGIN_VALUE = "jobright-agent";
export const BROWSER_USE_MAX_TIMEOUT_MIN = 240;
/** Same default lifetime as a Browserbase handoff session (20 min; the task itself expires at 15). */
export const BROWSER_USE_DEFAULT_TIMEOUT_MIN = 20;

/** Provider minutes for a handoff: the requested lifetime, or the configured default; never above the provider cap. */
export function browserTimeoutMinutes(keepAliveSeconds: number | undefined, defaultMinutes: number): number {
  const minutes = keepAliveSeconds === undefined ? defaultMinutes : Math.ceil(keepAliveSeconds / 60);
  return Math.max(1, Math.min(BROWSER_USE_MAX_TIMEOUT_MIN, minutes));
}

export function isEngineBrowser(metadata: Record<string, string>): boolean {
  return metadata[BROWSER_USE_ORIGIN_KEY] === BROWSER_USE_ORIGIN_VALUE;
}

export function browserUseProvider(
  api: BrowserUseApi,
  opts: { defaultTimeoutMinutes?: number; proxy?: boolean; ledger?: Ledger } = {},
): RemoteBrowserProvider {
  const defaultMinutes = opts.defaultTimeoutMinutes ?? BROWSER_USE_DEFAULT_TIMEOUT_MIN;
  const ledger = opts.ledger ?? nullLedger;
  /**
   * cdpUrl is only ever returned by the provider. Remembered for the
   * browsers this process created so a same-process attach needs no
   * read-back; a cold attach (another process, a reconnect) reads the
   * live browser first and only trusts the cache while it is active.
   */
  const cdpByBrowser = new Map<string, string>();

  return {
    name: BROWSER_USE_PROVIDER_NAME,
    async createContext({ userId }) {
      const profile = await api.createProfile({ userId, name: `dispatch:${userId}` });
      return profile.id;
    },
    async createSession({ userId, keepAliveSeconds, contextId }) {
      const timeout = browserTimeoutMinutes(keepAliveSeconds, defaultMinutes);
      let browser;
      try {
        browser = await api.createBrowser({
          profileId: contextId ?? null,
          timeout,
          metadata: { [BROWSER_USE_ORIGIN_KEY]: BROWSER_USE_ORIGIN_VALUE, dispatch_user: userId },
          solveCaptchas: false,
          proxyCountryCode: opts.proxy ? "us" : null,
        });
      } catch (err) {
        if (isAmbiguousCreateFailure(err)) {
          // The provider may have a billing browser we never got the id of: the ledger line is what a sweep reconciles against.
          ledger.append({ kind: "browser", id: "?", action: "create_ambiguous", user_id: userId, timeout_min: timeout, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
          throw new BrowserUseAmbiguousCreateError("browser", err);
        }
        throw err;
      }
      ledger.append({ kind: "browser", id: browser.id, action: "created", user_id: userId, timeout_min: timeout, profile_id: contextId ?? null, expires_at: browser.timeoutAt });
      if (!browser.cdpUrl || !browser.liveUrl) {
        // Unusable for a handoff: release it now rather than let it bill out its timeout.
        await api.stopBrowser(browser.id).catch(() => undefined);
        ledger.append({ kind: "browser", id: browser.id, action: "stopped_unusable", missing: browser.cdpUrl ? "liveUrl" : "cdpUrl" });
        throw new Error(`browser_use create browser ${browser.id} returned no ${browser.cdpUrl ? "liveUrl" : "cdpUrl"}; stopped it`);
      }
      cdpByBrowser.set(browser.id, browser.cdpUrl);
      return {
        provider: BROWSER_USE_PROVIDER_NAME,
        sessionId: browser.id,
        connectUrl: browser.cdpUrl,
        liveViewUrl: browser.liveUrl,
        expiresAt: browser.timeoutAt,
      };
    },
    async liveViewUrl(sessionId) {
      const b = await api.getBrowser(sessionId);
      if (b.status !== "active") {
        cdpByBrowser.delete(sessionId);
        throw new Error(`browser_use browser ${sessionId} is ${b.status}`);
      }
      if (!b.liveUrl) throw new Error(`browser_use browser ${sessionId} has no live view URL`);
      return b.liveUrl;
    },
    async connectUrl(sessionId) {
      const b = await api.getBrowser(sessionId);
      if (b.status !== "active") {
        cdpByBrowser.delete(sessionId);
        throw new Error(`browser_use browser ${sessionId} is ${b.status}; nothing to attach to`);
      }
      const url = b.cdpUrl ?? cdpByBrowser.get(sessionId) ?? null;
      if (!url) throw new Error(`browser_use browser ${sessionId} has no CDP URL`);
      cdpByBrowser.set(sessionId, url);
      return url;
    },
    async endSession(sessionId) {
      cdpByBrowser.delete(sessionId);
      const after = await api.stopBrowser(sessionId);
      ledger.append({ kind: "browser", id: sessionId, action: "stopped", status: after.status, browser_cost: after.browserCost, proxy_cost: after.proxyCost });
    },
  };
}
