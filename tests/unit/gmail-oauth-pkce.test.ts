import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_CONNECT_SCOPES,
  base64UrlEncode,
  buildGmailConsentUrl,
  codeChallengeS256,
  defaultRedirectUri,
  parseCallback,
  randomVerifier,
} from "../../frontend/src/public/gmailOauth.js";
import { GMAIL_ALLOWED_SCOPES } from "../../src/gmail/readonlyGuards.js";

/**
 * Plan M19 — the browser half of the Gmail connect, pure: the consent URL
 * asks for exactly the two scopes the engine will accept (drift-tested
 * against the guard file), PKCE is S256 with a spec-shaped verifier, and
 * the callback parser hands back code/state/error without inventing any.
 * UNIT_CONFIRMED.
 */

describe("gmail PKCE consent (UNIT_CONFIRMED)", () => {
  it("requests exactly the engine's allowed scopes, offline + consent, S256, with state", async () => {
    expect([...GMAIL_CONNECT_SCOPES].sort()).toEqual([...GMAIL_ALLOWED_SCOPES].sort());
    expect(GMAIL_COMPOSE_SCOPE.endsWith(".compose")).toBe(true);
    const verifier = randomVerifier((n: number) => webcrypto.getRandomValues(new Uint8Array(n)));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sha = (d: ArrayBuffer): Promise<ArrayBuffer> => webcrypto.subtle.digest("SHA-256", d);
    const challenge = await codeChallengeS256(verifier, sha);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // RFC 7636 appendix B vector.
    const vector = await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", sha);
    expect(vector).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const url = new URL(buildGmailConsentUrl({ clientId: "web-id", redirectUri: "https://app/gmail/callback", state: "st", codeChallenge: challenge, loginHint: "maya@pitt.edu" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")!.split(" ").sort()).toEqual([...GMAIL_ALLOWED_SCOPES].sort());
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("login_hint")).toBe("maya@pitt.edu");
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it("parses the callback honestly and derives the redirect from the origin", () => {
    expect(parseCallback("?code=4%2Fabc&state=st&scope=x")).toEqual({ code: "4/abc", state: "st", error: null });
    expect(parseCallback("?error=access_denied&error_description=The%20user%20denied")).toEqual({ code: null, state: null, error: "access_denied: The user denied" });
    expect(defaultRedirectUri("https://dispatch.example/", "")).toBe("https://dispatch.example/gmail/callback");
    expect(defaultRedirectUri("https://dispatch.example", "https://other/cb")).toBe("https://other/cb");
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe("-_8");
  });
});
