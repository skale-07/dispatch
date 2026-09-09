/**
 * Internet-outage guard for the automation worker (issue #203, day28).
 *
 * On 2026-09-09 15:00–15:15 UTC the box lost its uplink for ~12 minutes.
 * Every cycle in that window picked the next queued application, opened a
 * browser, hit `net::ERR_INTERNET_DISCONNECTED`, and moved on — thirteen
 * applications burned an attempt against a wall that had nothing to do
 * with them. The failure is ATS-agnostic: no page, employer, or adapter is
 * involved, so the fix lives here, above the pipeline, and never inspects
 * a form.
 *
 * Two seams, both bounded:
 *  - `isNetworkOutageError` names the Chromium/Node transport errors that
 *    mean "the network is gone", as opposed to a site that is down.
 *  - `waitForConnectivity` probes a couple of well-known hosts a capped
 *    number of times; the worker stops the session (queue untouched) when
 *    the cap is spent, and continues when the link comes back.
 */

/** Chromium + Node transport failures that indicate the uplink is gone. */
const OUTAGE_PATTERN =
  /net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|CONNECTION_(RESET|REFUSED|TIMED_OUT|CLOSED)|PROXY_CONNECTION_FAILED)|\b(ENOTFOUND|ENETUNREACH|EAI_AGAIN|ECONNRESET|ETIMEDOUT)\b/;

export function isNetworkOutageError(message: string): boolean {
  return OUTAGE_PATTERN.test(message);
}

/** Small, cache-busting, always-up targets; ANY answer (any status) = online. */
const PROBE_URLS = [
  "https://www.gstatic.com/generate_204",
  "https://www.cloudflare.com/cdn-cgi/trace",
];

/**
 * True when at least one probe host answers within `timeoutMs`. A 4xx/5xx
 * still counts — the question is "is there a network", not "is this host
 * healthy". Never throws.
 */
export async function probeInternet(timeoutMs = 5_000): Promise<boolean> {
  const attempts = PROBE_URLS.map(async (url) => {
    try {
      // Query-string bust instead of `cache: "no-store"` (not in Node's
      // RequestInit typings); the probe must reach the wire every time.
      await fetch(`${url}?t=${Date.now()}`, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  });
  const results = await Promise.all(attempts);
  return results.some(Boolean);
}

export type ConnectivityWait = {
  /** Number of probes before giving up (attempt cap — never unbounded). */
  attempts: number;
  /** Pause between probes; the worker passes its own sleep seam. */
  intervalMs: number;
  probe?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
};

export const DEFAULT_CONNECTIVITY_WAIT = { attempts: 8, intervalMs: 15_000 } as const;

export type ConnectivityWaitResult = {
  online: boolean;
  probes: number;
  waited_ms: number;
};

/**
 * Probe until online or the attempt cap is spent. First probe is immediate,
 * so a healthy link costs one round-trip and no sleep.
 */
export async function waitForConnectivity(
  opts: ConnectivityWait,
): Promise<ConnectivityWaitResult> {
  const probe = opts.probe ?? (() => probeInternet());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, Math.floor(opts.attempts));
  let waited = 0;
  for (let i = 1; i <= attempts; i++) {
    if (await probe()) return { online: true, probes: i, waited_ms: waited };
    if (i < attempts) {
      await sleep(opts.intervalMs);
      waited += opts.intervalMs;
    }
  }
  return { online: false, probes: attempts, waited_ms: waited };
}
