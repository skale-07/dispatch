import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateAtsPortal } from "../../src/verification/portalAuth.js";
import { setAccount } from "../../src/accounts/vault.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * #163 account-verification walls that carry NO code input.
 *
 * Split out of portal-auth.test.ts on purpose: that file already runs a
 * dozen multi-second routed-browser cases, and adding four more pushed its
 * slowest ones past their timeouts. Same harness, own process budget.
 *
 * No test contacts a real mailbox — the waiter is a seam.
 */
describe("#163 verification-link wall (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let browser: Browser;
  let privDir: string;
  const savedPriv = process.env.PRIVATE_DIR;
  let savedPortalEmail: string | undefined;
  let savedPortalPassword: string | undefined;

  beforeEach(async () => {
    applySafeFillEnv();
    savedPortalEmail = process.env.PORTAL_LOGIN_EMAIL;
    savedPortalPassword = process.env.PORTAL_LOGIN_PASSWORD;
    delete process.env.PORTAL_LOGIN_EMAIL;
    delete process.env.PORTAL_LOGIN_PASSWORD;
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-verify-"));
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close().catch(() => undefined);
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    if (savedPortalEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
    else process.env.PORTAL_LOGIN_EMAIL = savedPortalEmail;
    if (savedPortalPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
    else process.env.PORTAL_LOGIN_PASSWORD = savedPortalPassword;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  async function onWorkdayPage<T>(
    html: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) =>
      route.fulfill({ body: html, contentType: "text/html" }),
    );
    await page.goto(
      "https://interdigital.wd5.myworkdayjobs.com/en-US/Careers/login",
      { waitUntil: "domcontentloaded" },
    );
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  /**
   * #163 (operator screenshot 2026-09-03, Alcon "2027 Summer Software,
   * Data & AI Engineering"): an account-verification wall with NO code
   * input. The sign-in page carries a banner — "Verify your account before
   * you sign in or request a verification email" — and a "Resend Account
   * Verification" link; the email holds a LINK, not a code. The
   * emailed-code handler required a visible code input, so this wall was
   * never worked at all. FIXTURE_CONFIRMED.
   */
  const ALCON_HTML = `<!DOCTYPE html><html><body>
    <h1>Sign In</h1>
    <div role="alert">Verify your account before you sign in or request a verification email.</div>
    <p>Still can't sign in? Be sure to check your spam folder, your account may need verification</p>
    <a id="resendLink" href="/portal/resend">Resend Account Verification</a>
    <form>
      <input data-automation-id="email" type="email" />
      <input data-automation-id="password" type="password" />
      <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
    </form>
    <a href="/create">Create Account</a>
    <a href="/forgot">Forgot your password?</a>
  </body></html>`;

  it("#163 opens the emailed LINK on a verification wall that has no code input", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(ALCON_HTML, async (page) => {
        // The verified page the link lands on: banner gone.
        await page.context().route("**/verify-token**", (route) =>
          route.fulfill({
            body: "<html><body><p>Your account is now active. My Information</p></body></html>",
            contentType: "text/html",
          }),
        );
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return {
              kind: "link",
              url: "https://interdigital.wd5.myworkdayjobs.com/verify-token?t=abc",
              messageId: "m",
              pollsUsed: 1,
            };
          },
        });
        expect(waiterCalls).toBe(1);
        expect(r.verification_used).toBe(true);
        expect(r.notes.join(" ")).toMatch(/no code input — the email carries a link/);
        expect(r.notes.join(" ")).toMatch(/emailed verification link opened/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("#163 clicks Resend ONCE when the mailbox has nothing, then polls again", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(ALCON_HTML, async (page) => {
        await page.context().route("**/verify-token**", (route) =>
          route.fulfill({
            body: "<html><body><p>Your account is now active.</p></body></html>",
            contentType: "text/html",
          }),
        );
        const calls: string[] = [];
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            calls.push("poll");
            return calls.length === 1
              ? { kind: "timeout", pollsUsed: 1 }
              : {
                  kind: "link",
                  url: "https://interdigital.wd5.myworkdayjobs.com/verify-token?t=abc",
                  messageId: "m",
                  pollsUsed: 1,
                };
          },
        });
        // Exactly two polls: one before the resend, one after. Never a loop.
        expect(calls.length).toBe(2);
        expect(r.notes.join(" ")).toMatch(/clicking the page's own Resend once/);
        expect(r.verification_used).toBe(true);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("#163 a code with nowhere to type it is wall_remains, never a false success", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(ALCON_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => ({
            kind: "code",
            code: "482193",
            messageId: "m",
            pollsUsed: 1,
          }),
        });
        expect(r.status).toBe("wall_remains");
        expect(r.notes.join(" ")).toMatch(/has no code input — needs the link/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  /**
   * Live alcon.wd5 shape (replay 2026-09-03): the banner is NOT on the page
   * until the Sign In click answers; it lands in Workday's own
   * data-automation-id="errorMessage" container next to a
   * <button data-automation-id="informationalBlurbButton">Resend Account
   * Verification</button>. The first live run never saw it: ERROR_RE did
   * not match "Verify your account …", the poll ran out, the sign-in was
   * called silent and the Create Account route was taken instead.
   */
  const ALCON_LIVE_HTML = `<!DOCTYPE html><html><body>
    <h1>Sign In</h1>
    <div id="slot"></div>
    <form data-automation-id="signInFormo">
      <input data-automation-id="email" type="text" autocomplete="email" />
      <input data-automation-id="password" type="password" />
      <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
    </form>
    <p>Don't have an account yet? <a href="/create">Create Account</a></p>
    <a href="/forgot">Forgot your password?</a>
    <script>
      document.querySelector("button[data-automation-id='signInSubmitButton']").addEventListener("click", () => {
        document.getElementById("slot").innerHTML =
          '<div data-automation-id="errorMessage" role="alert"><p>Verify your account before you sign in or request a verification email.</p></div>' +
          '<div><span data-automation-id="informationalBlurbText">Still can\\'t sign in? Be sure to check your spam folder, your account may need verification</span>' +
          '<button data-automation-id="informationalBlurbButton">Resend Account Verification</button></div>';
      });
    </script>
  </body></html>`;
  /** The page the emailed link lands on: verified, but still a sign-in form. */
  const VERIFIED_SIGNIN_HTML = `<!DOCTYPE html><html><body>
    <h1>Sign In</h1>
    <p>Your account has been verified. Please sign in.</p>
    <form>
      <input data-automation-id="email" type="text" autocomplete="email" />
      <input data-automation-id="password" type="password" />
      <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
    </form>
    <script>
      document.querySelector("button[data-automation-id='signInSubmitButton']").addEventListener("click", () => {
        document.querySelector("form").remove();
        document.body.insertAdjacentHTML("beforeend", "<p>My Information</p>");
      });
    </script>
  </body></html>`;

  it("#163 live shape: banner answers the sign-in click, the link is opened, then ONE sign-in clears the wall", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      // Live: the account was created by an earlier run, so the vault knows
      // the host and the run signs in (no create-before-sign-in).
      setAccount("interdigital.wd5.myworkdayjobs.com", {
        email: "candidate@fixture.test",
        password: "Fixture#Pass1",
        runId: "fixture",
      });
      await onWorkdayPage(ALCON_LIVE_HTML, async (page) => {
        await page.context().route("**/verify-token**", (route) =>
          route.fulfill({ body: VERIFIED_SIGNIN_HTML, contentType: "text/html" }),
        );
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return {
              kind: "link",
              url: "https://interdigital.wd5.myworkdayjobs.com/verify-token?t=abc",
              messageId: "m",
              pollsUsed: 1,
            };
          },
        });
        const joined = r.notes.join(" ");
        expect(joined).toMatch(/sign-in refused until the account is verified/);
        expect(joined).not.toMatch(/taking the page's "Create Account" route/);
        expect(waiterCalls).toBe(1);
        expect(joined).toMatch(/link opened onto a sign-in form — signing in once/);
        expect(r.status).toBe("signed_in");
        expect(r.verification_used).toBe(true);
        expect(r.escalated_to_create).toBe(false);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("#163 a plain sign-in page with no verification banner never touches the mailbox", async () => {
    const PLAIN = `<!DOCTYPE html><html><body>
      <h1>Sign In</h1>
      <form>
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
      </form>
      <a href="/forgot">Forgot your password?</a>
    </body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(PLAIN, async (page) => {
        let waiterCalls = 0;
        await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "timeout", pollsUsed: 1 };
          },
        });
        expect(waiterCalls).toBe(0);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);
});
