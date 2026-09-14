import { GMAIL_ALLOWED_SCOPES, GmailWriteForbiddenError } from "./readonlyGuards.js";

/**
 * Refresh-token → access-token, shared by the readonly client and the
 * drafts-only API transport. Any scope the refresh response reports
 * outside the two the product uses is refused before the token is used.
 */

export type TokenFetch = (
  url: string | URL,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export function assertScopesAllowed(scopes: readonly string[], what: string): void {
  const beyond = scopes.filter((s) => !(GMAIL_ALLOWED_SCOPES as readonly string[]).includes(s));
  if (beyond.length > 0) {
    throw new GmailWriteForbiddenError(
      `${what} carries scopes outside readonly+compose (${beyond.join(", ")}) — drafts only; refusing.`,
    );
  }
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: TokenFetch;
}): Promise<{ accessToken: string; scopes: string[] }> {
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as TokenFetch);
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) {
    // 400 invalid_grant is the "token revoked / expired (7-day Testing mode)" signal.
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ? ` ${body.error}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Gmail token refresh failed (HTTP ${res.status}${detail})`);
  }
  const body = (await res.json()) as { access_token?: string; scope?: string };
  if (!body.access_token) throw new Error("Gmail token refresh returned no access_token");
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  assertScopesAllowed(scopes, "Gmail refresh response");
  return { accessToken: body.access_token, scopes };
}
