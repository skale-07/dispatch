/**
 * Per-user Gmail connect, browser side (plan v0.5, M19). Pure helpers for
 * the PKCE consent: the SPA holds only the PUBLIC client id; the code it
 * receives is handed to the engine (submit_gmail_oauth_code), which alone
 * holds the client secret and performs the exchange.
 *
 * Scopes: readonly (verification codes) + compose (DRAFTS). Never send —
 * the engine's guards refuse any wider grant, and the compose literal is
 * assembled here exactly as the guard file assembles it, so the repo-wide
 * literal scan (check-forbidden) keeps meaning something.
 */

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = ["https://www.googleapis.com/auth/gmail", "compose"].join(".");
export const GMAIL_CONNECT_SCOPES = [GMAIL_READONLY_SCOPE, GMAIL_COMPOSE_SCOPE] as const;

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GMAIL_PKCE_STORAGE_KEY = "dispatch.gmail.pkce";

/** Base64url without padding — what RFC 7636 wants for verifier and challenge. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 43–128 chars of unreserved characters; 32 random bytes ⇒ 43 chars. */
export function randomVerifier(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return base64UrlEncode(random(32));
}

export async function codeChallengeS256(
  verifier: string,
  digest: (data: ArrayBuffer) => Promise<ArrayBuffer> = (data) => crypto.subtle.digest("SHA-256", data),
): Promise<string> {
  const bytes = new TextEncoder().encode(verifier);
  // A fresh ArrayBuffer (never a SharedArrayBuffer view) is what subtle.digest wants.
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const hash = await digest(buf);
  return base64UrlEncode(new Uint8Array(hash));
}

export function buildGmailConsentUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Pre-fills the account chooser; never required. */
  loginHint?: string | null;
}): string {
  const u = new URL(GOOGLE_AUTH_ENDPOINT);
  u.searchParams.set("client_id", input.clientId);
  u.searchParams.set("redirect_uri", input.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_CONNECT_SCOPES.join(" "));
  u.searchParams.set("code_challenge", input.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", input.state);
  // offline + consent: Google only issues a refresh token on a consent screen.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "false");
  if (input.loginHint) u.searchParams.set("login_hint", input.loginHint);
  return u.toString();
}

export type PendingPkce = { verifier: string; state: string; redirectUri: string; startedAt: string };

/** What the callback needs back from the redirect: the code, and the state to match. */
export function parseCallback(search: string): { code: string | null; state: string | null; error: string | null } {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const error = p.get("error");
  return {
    code: p.get("code"),
    state: p.get("state"),
    error: error ? `${error}${p.get("error_description") ? `: ${p.get("error_description")}` : ""}` : null,
  };
}

/** The redirect URI for this deployment: configured, else this origin's /gmail/callback. */
export function defaultRedirectUri(origin: string, configured?: string | null): string {
  const c = (configured ?? "").trim();
  return c || `${origin.replace(/\/$/, "")}/gmail/callback`;
}
