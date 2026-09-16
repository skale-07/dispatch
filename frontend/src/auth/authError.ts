/**
 * When a provider sign-in fails AFTER the hop (GitHub or Google refused,
 * the Supabase callback could not read an email, the redirect was not on
 * the allowlist…), Supabase Auth sends the user back to the app with the
 * failure in the URL — `?error=…&error_code=…&error_description=…` for
 * the PKCE flow, `#error=…&error_description=…` for the implicit one —
 * and no session. Without reading it the app would bounce a signed-out
 * user to /signup with nothing to say (observed 2026-09-15 while the
 * GitHub provider had its app NAME pasted as the client id).
 *
 * Pure: takes the two URL parts, returns the message or null, and says
 * which params to strip so a reload does not show the error twice.
 */

export type AuthUrlError = {
  /** Provider / gateway code, e.g. `access_denied`, `server_error`. */
  code: string;
  /** Supabase's finer code when present, e.g. `unexpected_failure`. */
  errorCode: string | null;
  /** Human text, decoded; falls back to the code. */
  message: string;
  /** Where the error was carried, for the cleanup. */
  carriedIn: "query" | "hash";
};

const ERROR_KEYS = ["error", "error_code", "error_description"] as const;

function decode(v: string | null): string | null {
  if (v === null) return null;
  // GoTrue encodes spaces as '+' in error_description.
  const s = v.replace(/\+/g, " ").trim();
  return s === "" ? null : s;
}

export function readAuthErrorFromUrl(parts: { search: string; hash: string }): AuthUrlError | null {
  const query = new URLSearchParams(parts.search.startsWith("?") ? parts.search.slice(1) : parts.search);
  const hash = new URLSearchParams(parts.hash.startsWith("#") ? parts.hash.slice(1) : parts.hash);
  const from: Array<{ params: URLSearchParams; carriedIn: AuthUrlError["carriedIn"] }> = [
    { params: query, carriedIn: "query" },
    { params: hash, carriedIn: "hash" },
  ];
  for (const { params, carriedIn } of from) {
    const code = decode(params.get("error"));
    if (!code) continue;
    const errorCode = decode(params.get("error_code"));
    const description = decode(params.get("error_description"));
    return { code, errorCode, message: description ?? code, carriedIn };
  }
  return null;
}

/** The same URL with the error params removed (other params and the path untouched). */
export function stripAuthErrorFromUrl(parts: { pathname: string; search: string; hash: string }): string {
  const query = new URLSearchParams(parts.search.startsWith("?") ? parts.search.slice(1) : parts.search);
  const hash = new URLSearchParams(parts.hash.startsWith("#") ? parts.hash.slice(1) : parts.hash);
  for (const k of ERROR_KEYS) {
    query.delete(k);
    hash.delete(k);
  }
  const q = query.toString();
  const h = hash.toString();
  return `${parts.pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`;
}

/** What the signup page shows: the provider's words, plus the one hint that fixes the common case. */
export function describeAuthError(e: AuthUrlError): string {
  const base = e.errorCode && e.errorCode !== e.code ? `${e.message} (${e.errorCode})` : e.message;
  if (/redirect_uri_mismatch|redirect/i.test(e.message)) {
    return `${base} — the sign-in provider is not configured for this site's callback yet.`;
  }
  if (/email/i.test(e.message)) {
    return `${base} — the provider did not share a verified email address; try the email link instead.`;
  }
  return base;
}
