import { describe, expect, it } from "vitest";
import { describeAuthError, readAuthErrorFromUrl, stripAuthErrorFromUrl } from "../../frontend/src/auth/authError.js";

/**
 * A provider sign-in that fails after the hop comes back as URL params
 * (query for PKCE, hash for implicit). The reader finds either, keeps the
 * provider's words, and the stripper removes only those params so a
 * reload does not repeat the error. UNIT_CONFIRMED. The real shapes seen
 * 2026-09-15: Google's redirect_uri_mismatch, GitHub with a wrong client
 * id — both dashboard misconfigurations the page must be able to SHOW.
 */

describe("readAuthErrorFromUrl (UNIT_CONFIRMED)", () => {
  it("reads the PKCE-flow query form and decodes '+' as spaces", () => {
    const e = readAuthErrorFromUrl({
      search: "?error=server_error&error_code=unexpected_failure&error_description=Error+getting+user+email+from+external+provider",
      hash: "",
    });
    expect(e).toEqual({
      code: "server_error",
      errorCode: "unexpected_failure",
      message: "Error getting user email from external provider",
      carriedIn: "query",
    });
  });

  it("reads the implicit-flow hash form; query wins when both carry an error", () => {
    expect(readAuthErrorFromUrl({ search: "", hash: "#error=access_denied&error_description=The%20user%20denied%20access" })).toEqual({
      code: "access_denied",
      errorCode: null,
      message: "The user denied access",
      carriedIn: "hash",
    });
    expect(readAuthErrorFromUrl({ search: "?error=a", hash: "#error=b" })?.code).toBe("a");
  });

  it("no error param, or an empty one, is null — a normal callback with tokens is never misread", () => {
    expect(readAuthErrorFromUrl({ search: "", hash: "#access_token=x&refresh_token=y&type=magiclink" })).toBeNull();
    expect(readAuthErrorFromUrl({ search: "?code=abc", hash: "" })).toBeNull();
    expect(readAuthErrorFromUrl({ search: "?error=", hash: "" })).toBeNull();
    expect(readAuthErrorFromUrl({ search: "?error_description=only", hash: "" })).toBeNull();
  });

  it("falls back to the code when there is no description", () => {
    expect(readAuthErrorFromUrl({ search: "?error=access_denied", hash: "" })?.message).toBe("access_denied");
  });
});

describe("stripAuthErrorFromUrl (UNIT_CONFIRMED)", () => {
  it("removes only the three error params and keeps the path, other params and the hash", () => {
    expect(
      stripAuthErrorFromUrl({
        pathname: "/onboarding",
        search: "?error=server_error&code=keep&error_code=x&error_description=y",
        hash: "#error=z&step=4",
      }),
    ).toBe("/onboarding?code=keep#step=4");
    expect(stripAuthErrorFromUrl({ pathname: "/signup", search: "", hash: "" })).toBe("/signup");
  });
});

describe("describeAuthError (UNIT_CONFIRMED)", () => {
  it("adds the one hint that fixes each common case, and appends the finer code once", () => {
    const base = { code: "server_error", carriedIn: "query" as const };
    expect(describeAuthError({ ...base, errorCode: null, message: "redirect_uri_mismatch" })).toMatch(/not configured for this site's callback/);
    expect(describeAuthError({ ...base, errorCode: "unexpected_failure", message: "Error getting user email from external provider" })).toBe(
      "Error getting user email from external provider (unexpected_failure) — the provider did not share a verified email address; try the email link instead.",
    );
    expect(describeAuthError({ ...base, errorCode: "server_error", message: "Something else" })).toBe("Something else");
  });
});
