import { assertScopesAllowed, GOOGLE_TOKEN_ENDPOINT, type TokenFetch } from "./accessToken.js";
import { GMAIL_READONLY_SCOPE, GmailWriteForbiddenError } from "./readonlyGuards.js";

/**
 * Authorization-code exchange for a HOSTED user's Gmail (plan v0.5, M19).
 *
 * The web app ran the consent with PKCE against Dispatch's own Web OAuth
 * client and handed the code + verifier to the engine
 * (submit_gmail_oauth_code, 20260914000100). Only the engine holds the
 * client secret. The exchange is refused unless the granted scopes are a
 * subset of {readonly, compose} AND include readonly (verification codes
 * are the reason Gmail is required at all); a grant without a refresh
 * token is refused too (the consent must ask for offline access).
 */

export const GMAIL_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

export type ExchangedGrant = {
  refreshToken: string;
  scopes: string[];
  accountEmail: string | null;
  obtainedAt: string;
};

export async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: TokenFetch;
  now?: () => Date;
}): Promise<ExchangedGrant> {
  const fetchImpl = input.fetchImpl ?? (fetch as unknown as TokenFetch);
  const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: string; error_description?: string };
      detail = body.error ? ` ${body.error}${body.error_description ? `: ${body.error_description}` : ""}` : "";
    } catch {
      detail = "";
    }
    throw new Error(`Gmail code exchange failed (HTTP ${res.status}${detail})`);
  }
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; scope?: string };
  const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean);
  if (scopes.length === 0) {
    throw new GmailWriteForbiddenError("Gmail code exchange returned no scope — cannot verify the grant; refusing to store.");
  }
  assertScopesAllowed(scopes, "Gmail grant");
  if (!scopes.includes(GMAIL_READONLY_SCOPE)) {
    throw new Error("Gmail grant lacks gmail.readonly — verification codes need it; refusing to store a compose-only grant.");
  }
  if (!body.refresh_token) {
    throw new Error("Gmail code exchange returned no refresh_token — the consent must use access_type=offline and prompt=consent.");
  }

  let accountEmail: string | null = null;
  if (body.access_token) {
    try {
      const prof = await fetchImpl(GMAIL_PROFILE_ENDPOINT, { headers: { Authorization: `Bearer ${body.access_token}` } });
      if (prof.ok) {
        const p = (await prof.json()) as { emailAddress?: string };
        accountEmail = typeof p.emailAddress === "string" && p.emailAddress.includes("@") ? p.emailAddress : null;
      }
    } catch {
      accountEmail = null;
    }
  }
  return {
    refreshToken: body.refresh_token,
    scopes: scopes.sort(),
    accountEmail,
    obtainedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}
