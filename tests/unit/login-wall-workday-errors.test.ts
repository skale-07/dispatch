import { describe, expect, it } from "vitest";
import { diagnoseLoginWall } from "../../src/verification/loginWallDiagnosis.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Night19 #45/#46 (2026-08-30, huntington.wd12): Workday's rejection after a
 * sign-in click is `<div data-automation-id="errorMessage">You may have
 * entered the wrong email address or password or your account might be
 * locked.</div>` — none of the old ERROR_RE phrases matched it, so the wall
 * "remained" and the create-account escalation never ran. A genuinely
 * locked account is a different verdict. FIXTURE_CONFIRMED.
 */
const SIGN_IN = (extra: string) => `<!DOCTYPE html><html><body>
  <h3>Sign In</h3>
  ${extra}
  <form data-automation-id="signInFormo">
    <label for="e"><span>Email Address</span></label>
    <input type="text" data-automation-id="email" id="e" autocomplete="email" />
    <label for="p"><span>Password</span></label>
    <input type="password" data-automation-id="password" id="p" autocomplete="current-password" />
    <div role="button" tabindex="0" aria-label="Sign In" data-automation-id="click_filter">Sign In</div>
    <button type="submit" data-automation-id="signInSubmitButton" aria-hidden="true">Sign In</button>
  </form>
  <div>Don't have an account yet?<button data-automation-id="createAccountLink">Create Account</button></div>
  <input data-automation-id="beecatcher" name="website" type="text" />
</body></html>`;

describe("password policy read from the page (UNIT_CONFIRMED)", async () => {
  const { passwordPolicyGaps } = await import("../../src/verification/loginWallDiagnosis.js");
  const WORKDAY_RULES = `Create Account Password Requirements: A numeric character A minimum of 8 characters A special character A lowercase character An uppercase character An alphabetic character Email Address* Password*`;

  it("names every missing class for the live shape (no digit, no lowercase)", () => {
    expect(passwordPolicyGaps(WORKDAY_RULES, "CORRECT-HORSE-BATTERY-STAPLE-MOUNTAIN-TOP!")).toEqual([
      "numeric character",
      "lowercase character",
    ]);
  });

  it("a compliant password has no gaps; a short one reports the minimum", () => {
    expect(passwordPolicyGaps(WORKDAY_RULES, "Standing-Pass1!")).toEqual([]);
    expect(passwordPolicyGaps(WORKDAY_RULES, "Ab1!")).toEqual(["minimum of 8 characters"]);
  });

  // #217 (live redhat.wd5, day28): "minimum of 14 characters" parked the row.
  it("derives a per-host password that satisfies the stated rules from the standing one", async () => {
    const { deriveCompliantPassword } = await import("../../src/verification/loginWallDiagnosis.js");
    const redhat = `${WORKDAY_RULES} A minimum of 14 characters`;
    const derived = deriveCompliantPassword(redhat, "Standing-Pass1!");
    expect(derived).not.toBeNull();
    expect(derived!.startsWith("Standing-Pass1!")).toBe(true);
    expect(derived!.length).toBeGreaterThanOrEqual(14);
    expect(passwordPolicyGaps(redhat, derived!)).toEqual([]);
    // Missing classes are added, not just length.
    const fixed = deriveCompliantPassword(WORKDAY_RULES, "CORRECT-HORSE-BATTERY-STAPLE-MOUNTAIN-TOP!");
    expect(fixed).not.toBeNull();
    expect(passwordPolicyGaps(WORKDAY_RULES, fixed!)).toEqual([]);
    // Already compliant → unchanged; impossible (max shorter than standing) → null.
    expect(deriveCompliantPassword(WORKDAY_RULES, "Standing-Pass1!")).toBe("Standing-Pass1!");
    expect(deriveCompliantPassword("A maximum of 10 characters", "Standing-Pass1!")).toBeNull();
  });

  it("a page that states no rules never blocks", () => {
    expect(passwordPolicyGaps("Sign in to continue. Email Address Password", "ALLCAPS")).toEqual([]);
  });
});

describe("workday sign-in errors (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("the live Workday rejection sentence is credentials_rejected with a create-account route", async () => {
    const html = SIGN_IN(
      `<div data-automation-id="errorMessage">You may have entered the wrong email address or password or your account might be locked.</div>`,
    );
    await withFixtureHtmlPage(html, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("credentials_rejected");
      expect(d.errorText).toMatch(/wrong email address or password/);
      expect(d.fields.email).toBe(true);
      expect(d.createAccountRoute).toBe("Create Account");
      // The honeypot is not counted as a field.
      expect(d.fields.otherVisibleInputs).toBe(2);
    });
  }, 30_000);

  it("a real lock message is account_locked, never credentials_rejected", async () => {
    for (const msg of [
      "Your account has been locked. Please try again in 30 minutes.",
      "Too many failed sign in attempts. Your account is temporarily locked.",
    ]) {
      await withFixtureHtmlPage(SIGN_IN(`<div role="alert">${msg}</div>`), async (page) => {
        const d = await diagnoseLoginWall(page);
        expect(d.classification, msg).toBe("account_locked");
        expect(d.errorText).toMatch(/locked/i);
      });
    }
  }, 30_000);

  it("no error text ⇒ plain sign_in_form (the beecatcher label's 'robots' wording is not an error)", async () => {
    await withFixtureHtmlPage(
      SIGN_IN(`<label>Enter website. This input is for robots only, do not enter if you're human.</label>`),
      async (page) => {
        const d = await diagnoseLoginWall(page);
        expect(d.classification).toBe("sign_in_form");
        expect(d.errorText).toBeNull();
      },
    );
  }, 30_000);
});
