import { getConfig } from "../config/index.js";

/**
 * Where the engine may attach over CDP (plan v0.5, M17).
 *
 * Loopback — the operator's own debug Chrome on 127.0.0.1 / localhost /
 * [::1] — is always allowed. Anything else is a REMOTE browser (the
 * Browserbase handoff session a hosted user drives) and requires
 * REMOTE_BROWSER_ENABLED, which itself refuses to boot without a
 * provider. Called once in serviceSession.ts before the existing
 * `connectOverCDP`, so no new chromium.* call site exists anywhere.
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackCdpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOOPBACK_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function assertCdpUrlAllowed(url: string, remoteBrowserEnabled = getConfig().remoteBrowserEnabled): void {
  if (isLoopbackCdpUrl(url)) return;
  if (remoteBrowserEnabled) return;
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // unparsable — refuse with the raw text, key material never appears in a hostname
  }
  throw new Error(
    `Refusing to attach to a non-loopback CDP endpoint (${host}): REMOTE_BROWSER_ENABLED is false (fail-closed default).`,
  );
}
