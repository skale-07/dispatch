import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateAtsPortal } from "../../src/verification/portalAuth.js";
import { getAccount, setAccount } from "../../src/accounts/vault.js";
import { startEmployerSandbox } from "../../src/sandbox/server.js";
import { resetConfigCache } from "../../src/config/index.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * Workday W2 — deterministic portal auth. FIXTURE_CONFIRMED via a routed
 * Workday-host page and a stubbed mailbox waiter. The credential-spray
 * guard (host gate) and the evidence gate (no inbox scan without a
 * verification prompt) are the load-bearing rails under test.
 */
const AUTH_HTML = `<!DOCTYPE html><html><body>
  <form>
    <input data-automation-id="email" type="email" />
    <input data-automation-id="password" type="password" />
    <input data-automation-id="verifyPassword" type="password" />
    <input data-automation-id="createAccountCheckbox" type="checkbox" />
    <button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>
  </form>
  <p>Create an account to apply</p>
</body></html>`;

describe("workday portal auth (FIXTURE_CONFIRMED)", () => {
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
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-portal-"));
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

  it("refuses to type credentials on a non-Workday host (credential-spray guard)", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) =>
      route.fulfill({ body: AUTH_HTML, contentType: "text/html" }),
    );
    await page.goto("https://phish.example.com/signin", {
      waitUntil: "domcontentloaded",
    });
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      const r = await authenticateAtsPortal(page, { emailOverride: "c@x.com", settleMs: 0 });
      expect(r.status).toBe("refused");
      expect(r.notes.join(" ")).toMatch(/not a recognized ATS auth host/);
      // Nothing was typed.
      expect(await page.locator("[data-automation-id='email']").inputValue()).toBe("");
    } finally {
      applySafeFillEnv();
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it("creates the account with the candidate email + vault password, no inbox scan without a prompt", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(AUTH_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "0", messageId: "m", pollsUsed: 1 };
          },
        });
        // The form is still present in this fixture (no SPA transition), so
        // the flow reports wall_remains — but the load-bearing facts hold:
        expect(await page.locator("[data-automation-id='email']").inputValue()).toBe(
          "candidate@fixture.test",
        );
        expect(
          (await page.locator("[data-automation-id='password']").inputValue()).length,
        ).toBeGreaterThan(0);
        // No verification input on this page ⇒ mailbox never consulted.
        expect(waiterCalls).toBe(0);
        expect(r.notes.join(" ")).toMatch(/portal auth create/);
        expect(r.diagnosis?.classification).toBe("create_account_form");
        // Password is a secret — it must be offered for scrubbing, never in notes.
        const pw = await page.locator("[data-automation-id='password']").inputValue();
        expect(r.secrets).toContain(pw);
        expect(r.notes.join(" ")).not.toContain(pw);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("escalates to create-account ONLY after the sign-in is rejected", async () => {
    // Live Amazon wall (operator screenshots 2026-08-12): a sign-in page
    // with a "Create an ... account" link. The account is minted only
    // because the portal said the credentials are wrong.
    const REJECT_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign in</button>
        <button id="route" type="button">Create an Example account</button>
      </div>
      <p id="err"></p>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.getElementById('err').textContent =
              'Your email or password is incorrect. Please try again.';
          });
        document.getElementById('route').addEventListener('click', () => {
          (globalThis).__routeClicked = true;
          document.getElementById('err').textContent = '';
          document.getElementById('wall').innerHTML =
            '<input data-automation-id="email" type="email" />' +
            '<input data-automation-id="password" type="password" />' +
            '<input data-automation-id="verifyPassword" type="password" />' +
            '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
          document.querySelector('[data-automation-id=createAccountSubmitButton]')
            .addEventListener('click', () => {
              (globalThis).__created = true;
              document.body.innerHTML = '<p>Welcome, your account is ready.</p>';
            });
        });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    // #64: sign-in-before-create is now the KNOWN-account path; the
    // rejection-gated escalation under test presumes one on record.
    setAccount("interdigital.wd5.myworkdayjobs.com", {
      email: "candidate@fixture.test",
    });
    try {
      await onWorkdayPage(REJECT_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
        });
        expect(r.escalated_to_create).toBe(true);
        expect(r.status).toBe("account_created");
        expect(
          await page.evaluate(() => (globalThis as unknown as { __created?: boolean }).__created),
        ).toBe(true);
        expect(r.notes.join(" ")).toMatch(/sign-in rejected — opened/);
        // The rejection is what authorized the escalation, and it is on record.
        expect(r.notes.join(" ")).toMatch(/credentials_rejected/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("never escalates when the sign-in succeeds (create route left untouched)", async () => {
    const OK_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign in</button>
        <button id="route" type="button">Create an Example account</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.body.innerHTML = '<p>My Applications</p>';
          });
        document.getElementById('route').addEventListener('click', () => {
          (globalThis).__routeClicked = true;
        });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    // #64: a sign-in that can succeed means the account exists — on record.
    setAccount("interdigital.wd5.myworkdayjobs.com", {
      email: "candidate@fixture.test",
    });
    try {
      await onWorkdayPage(OK_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
        });
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __routeClicked?: boolean }).__routeClicked,
          ),
        ).toBeUndefined();
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("scans the mailbox when the landing is already the emailed-code wall", async () => {
    const VERIFY_HTML = `<!DOCTYPE html><html><body>
      <p>We sent a verification code to your email — enter the code to continue.</p>
      <input data-automation-id="verificationCode" autocomplete="one-time-code" />
      <button data-automation-id="verifyButton" type="button">Verify</button>
      <script>
        document.querySelector('[data-automation-id=verifyButton]')
          .addEventListener('click', () => {
            document.body.innerHTML = '<p>My Information</p>';
          });
      </script>
    </body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(VERIFY_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "482193", messageId: "m", pollsUsed: 1 };
          },
        });
        expect(waiterCalls).toBe(1);
        expect(r.verification_used).toBe(true);
        expect(r.status).toBe("signed_in");
        expect(r.secrets).toContain("482193");
        expect(r.notes.join(" ")).toMatch(/emailed code entered/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("a wrong code that leaves the wall is wall_remains, not a cleared form", async () => {
    const OTP_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.getElementById('wall').innerHTML =
              '<p>We sent a verification code to your email — enter the code to continue.</p>' +
              '<input data-automation-id="verificationCode" autocomplete="one-time-code" />' +
              '<button data-automation-id="verifyButton" type="button">Verify</button>';
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(OTP_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => ({
            kind: "code",
            code: "000000",
            messageId: "m",
            pollsUsed: 1,
          }),
        });
        expect(r.verification_used).toBe(true);
        expect(r.status).toBe("wall_remains");
        expect(r.notes.join(" ")).toMatch(/emailed-code wall remains/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("Crowe posting: Apply → Apply Manually → Sign In with standing credentials (FIXTURE_CONFIRMED)", async () => {
    // Operator screenshots 2026-08-14: posting Apply, modal Apply Manually,
    // then Create Account with "Already have an account? Sign In".
    const CROWE_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>AI Engineering Intern</h1>
        <button data-automation-id="adventureButton" type="button">Apply</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=adventureButton]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Start Your Application</h2>' +
              '<button data-automation-id="autofillWithResume" type="button">Autofill with Resume</button>' +
              '<button data-automation-id="applyManually" type="button">Apply Manually</button>' +
              '<button type="button">Use My Last Application</button>';
            document.querySelector('[data-automation-id=applyManually]')
              .addEventListener('click', () => {
                document.getElementById('stage').innerHTML =
                  '<h2>Create Account</h2>' +
                  '<input data-automation-id="email" type="email" />' +
                  '<input data-automation-id="password" type="password" />' +
                  '<input data-automation-id="verifyPassword" type="password" />' +
                  '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>' +
                  '<p>Already have an account? <button data-automation-id="signInLink" type="button">Sign In</button></p>';
                document.querySelector('[data-automation-id=signInLink]')
                  .addEventListener('click', () => {
                    document.getElementById('stage').innerHTML =
                      '<h2>Sign In</h2>' +
                      '<input data-automation-id="email" type="email" />' +
                      '<input data-automation-id="password" type="password" />' +
                      '<button data-automation-id="signInSubmitButton" type="button">Sign In</button>';
                    document.querySelector('[data-automation-id=signInSubmitButton]')
                      .addEventListener('click', () => {
                        document.body.innerHTML = '<p>My Information</p>';
                      });
                  });
                document.querySelector('[data-automation-id=createAccountSubmitButton]')
                  .addEventListener('click', () => {
                    (globalThis).__createdInstead = true;
                  });
              });
            document.querySelector('[data-automation-id=autofillWithResume]')
              .addEventListener('click', () => {
                (globalThis).__autofill = true;
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    // #64: sign-in-first now requires an account on record — this test's
    // premise (operator already has the account) becomes a vault entry.
    setAccount("interdigital.wd5.myworkdayjobs.com", {
      email: "candidate@fixture.test",
      password: "StandingPass1!",
    });
    try {
      await onWorkdayPage(CROWE_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "000000", messageId: "m", pollsUsed: 1 };
          },
        });
        expect(r.notes.join(" ")).toMatch(/clicked "Apply"/);
        expect(r.notes.join(" ")).toMatch(/Apply Manually/);
        expect(r.notes.join(" ")).toMatch(/flipped Create Account → Sign In/);
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(waiterCalls).toBe(0);
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __autofill?: boolean }).__autofill,
          ),
        ).toBeUndefined();
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __createdInstead?: boolean }).__createdInstead,
          ),
        ).toBeUndefined();
        expect(r.secrets).toContain("StandingPass1!");
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("TIAA SSO chooser: Apply Manually renders provider buttons — the email path is taken, never a third party (night20, FIXTURE_CONFIRMED)", async () => {
    // Live tiaa.wd1 2026-08-30: after Apply → Apply Manually the flow
    // rendered signInContent (Apple/Google/LinkedIn/"Sign in with email")
    // with ZERO inputs; the walk waited 15s for a form and parked
    // "no sign-in form on this page". Operator directive 2026-08-30:
    // always click Sign in with email, then the standing credentials.
    const TIAA_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>Churchill Summer Internship</h1>
        <button data-automation-id="adventureButton" type="button">Apply</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=adventureButton]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Start Your Application</h2>' +
              '<button data-automation-id="applyManually" type="button">Apply Manually</button>';
            document.querySelector('[data-automation-id=applyManually]')
              .addEventListener('click', () => {
                document.getElementById('stage').innerHTML =
                  '<div data-automation-id="progressBar">step 1 of 8</div>' +
                  '<div data-automation-id="signInContent">' +
                  '<button data-automation-id="AppleSignInButton" type="button">Sign in with Apple</button>' +
                  '<button data-automation-id="GoogleSignInButton" type="button">Sign in with Google</button>' +
                  '<button data-automation-id="LinkedInSignInButton" type="button">Sign in with LinkedIn</button>' +
                  '<button data-automation-id="SignInWithEmailButton" type="button">Sign in with email</button>' +
                  '</div>';
                for (const id of ['AppleSignInButton','GoogleSignInButton','LinkedInSignInButton']) {
                  document.querySelector('[data-automation-id=' + id + ']')
                    .addEventListener('click', () => { (globalThis).__thirdParty = id; });
                }
                document.querySelector('[data-automation-id=SignInWithEmailButton]')
                  .addEventListener('click', () => {
                    document.getElementById('stage').innerHTML =
                      '<h2>Sign In</h2>' +
                      '<input data-automation-id="email" type="email" />' +
                      '<input data-automation-id="password" type="password" />' +
                      '<button data-automation-id="signInSubmitButton" type="button">Sign In</button>';
                    document.querySelector('[data-automation-id=signInSubmitButton]')
                      .addEventListener('click', () => {
                        document.body.innerHTML = '<p>My Information</p>';
                      });
                  });
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(TIAA_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" ")).toMatch(/SSO chooser — clicked Sign in with email/);
        expect(r.status).toBe("signed_in");
        // No third-party provider button was ever clicked.
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __thirdParty?: string }).__thirdParty,
          ),
        ).toBeUndefined();
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("SILENT sign-in escalates once via the page's Create Account route (TIAA night20 #60b, FIXTURE_CONFIRMED)", async () => {
    // Live tiaa.wd1 2026-08-30: Sign In answered NOTHING — no error text,
    // no navigation — and the run parked "wall remains (sign_in_form)"
    // with a "Don't have an account yet? Create Account" link on screen.
    const SILENT_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h2>Sign In</h2>
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
        <p>Don't have an account yet? <button data-automation-id="createAccountLink" type="button">Create Account</button></p>
      </div>
      <script>
        // Sign In deliberately does NOTHING (the silent tenant).
        document.querySelector('[data-automation-id=createAccountLink]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Create Account</h2>' +
              '<input data-automation-id="email" type="email" />' +
              '<input data-automation-id="password" type="password" />' +
              '<input data-automation-id="verifyPassword" type="password" />' +
              '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
            document.querySelector('[data-automation-id=createAccountSubmitButton]')
              .addEventListener('click', () => {
                document.body.innerHTML = '<p>My Information</p>';
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    // #64: with an account on record the walk still signs in first; this
    // preserves the original #60b coverage (silent sign-in → create route).
    setAccount("interdigital.wd5.myworkdayjobs.com", {
      email: "candidate@fixture.test",
      password: "StandingPass1!",
    });
    try {
      await onWorkdayPage(SILENT_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" ")).toMatch(
          /sign-in answered nothing — taking the page's "Create Account" route/,
        );
        expect(r.status).toBe("account_created");
        expect(r.escalated_to_create).toBe(true);
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("#64 create-before-sign-in: NO account on record ⇒ the page's Create Account route is taken FIRST, sign-in never attempted, creation recorded in the vault", async () => {
    // Operator directive 2026-08-30 night21: "creating an account is
    // necessary unless Workday explicitly tells you that you have an
    // account". First contact = no vault record ⇒ create, don't guess.
    const FIRST_CONTACT_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h2>Sign In</h2>
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
        <p>Don't have an account yet? <button data-automation-id="createAccountLink" type="button">Create Account</button></p>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => { (globalThis).__signInTried = true; });
        document.querySelector('[data-automation-id=createAccountLink]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Create Account</h2>' +
              '<input data-automation-id="email" type="email" />' +
              '<input data-automation-id="password" type="password" />' +
              '<input data-automation-id="verifyPassword" type="password" />' +
              '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
            document.querySelector('[data-automation-id=createAccountSubmitButton]')
              .addEventListener('click', () => {
                document.body.innerHTML = '<p>My Information</p>';
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(FIRST_CONTACT_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" ")).toMatch(
          /no account on record for .+ — taking ".*" first \(create-before-sign-in\)/,
        );
        expect(r.status).toBe("account_created");
        expect(r.escalated_to_create).toBe(true);
        // The sign-in submit was NEVER clicked — create came first.
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __signInTried?: boolean }).__signInTried,
          ),
        ).toBeUndefined();
        // The verified creation is now vault evidence for the next run.
        const rec = getAccount("interdigital.wd5.myworkdayjobs.com");
        expect(rec?.username).toBe("candidate@fixture.test");
        expect(r.notes.join(" ")).toMatch(/created account recorded in the vault/);
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("#136 Auth0 signup route: the form's own Continue submit is the create submit (UKG live shape)", async () => {
    // Live Bennett Thrasher 2026-09-01 (signin-us.ukg.net): Apply lands on
    // Auth0's /u/login (email+password+Continue, "Sign up" link). The
    // create-before-sign-in route click reaches /u/signup whose ONLY
    // submit also says "Continue" — no create-labeled control exists, so
    // the create attempt used to bail with "no create submit control
    // found" and park AUTH_REQUIRED.
    const LOGIN_HTML = `<!DOCTYPE html><html><body>
      <h1>Log in to continue</h1>
      <form action="/u/login" method="post">
        <input name="email" id="email" type="text" inputmode="email" required />
        <input name="password" id="password" type="password" required />
        <button type="submit" name="action">Continue</button>
      </form>
      <p>Don't have an account? <a href="/u/signup?state=x">Sign up</a></p>
    </body></html>`;
    const SIGNUP_HTML = `<!DOCTYPE html><html><body>
      <h1>Create your account</h1>
      <form action="/u/signup" method="post">
        <input name="email" id="email" type="text" inputmode="email" required />
        <input name="password" id="password" type="password" required />
        <button type="submit" name="action">Continue</button>
      </form>
      <p>Already have an account? <a href="/u/login?state=x">Log in</a></p>
    </body></html>`;
    const DONE_HTML = `<html><body><p>Checking your application…</p></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) => {
      const u = new URL(route.request().url());
      const body = u.pathname.startsWith("/u/signup")
        ? route.request().method() === "POST"
          ? DONE_HTML
          : SIGNUP_HTML
        : LOGIN_HTML;
      void route.fulfill({ body, contentType: "text/html" });
    });
    await page.goto("https://signin-us.ukg.net/u/login?state=x", {
      waitUntil: "domcontentloaded",
    });
    try {
      const r = await authenticateAtsPortal(page, { settleMs: 0 });
      expect(r.notes.join(" ")).toMatch(
        /taking "Sign up" first \(create-before-sign-in\)/,
      );
      expect(r.notes.join(" ")).toMatch(
        /signup-route page has no create-labeled submit — using the form's own submit/,
      );
      expect(r.status).toBe("account_created");
    } finally {
      applySafeFillEnv();
      resetConfigCache();
      await context.close().catch(() => undefined);
    }
  }, 30_000);

  it('#64 the portal answering "already exists" is the sanctioned flip to sign-in (signed_in, not account_created)', async () => {
    const EXISTS_HTML = `<!DOCTYPE html><html><body>
      <p id="err"></p>
      <h2>Create Account</h2>
      <form id="create">
        <input id="email" type="email" name="email" />
        <input id="password" type="password" name="password" />
        <input id="verifyPassword" type="password" name="verifyPassword" />
        <button type="submit">Create Account</button>
      </form>
      <h2>Sign In</h2>
      <form id="signin">
        <input id="si_email" type="email" name="email" />
        <input id="si_password" type="password" name="password" />
        <button type="submit">Sign In</button>
      </form>
      <script>
        var accounts = { 'candidate@fixture.test': 'StandingPass1!' };
        document.getElementById('create').addEventListener('submit', function (e) {
          e.preventDefault();
          var email = document.getElementById('email').value.toLowerCase();
          if (accounts[email]) {
            document.getElementById('err').textContent =
              'An account with this email already exists. Sign in instead.';
            return;
          }
          document.body.innerHTML = '<p>Application form</p><input name="first_name" />';
        });
        document.getElementById('signin').addEventListener('submit', function (e) {
          e.preventDefault();
          var email = document.getElementById('si_email').value.toLowerCase();
          var pw = document.getElementById('si_password').value;
          if (accounts[email] !== pw) {
            document.getElementById('err').textContent = 'Invalid email or password.';
            return;
          }
          document.body.innerHTML = '<p>Application form</p><input name="first_name" />';
        });
      </script>
    </body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(EXISTS_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" ")).toMatch(
          /portal says an account already exists for this email — signing in/,
        );
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(await page.locator("input[name='first_name']").count()).toBe(1);
      });
    } finally {
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it('#64 "form cleared" with the signed-OUT Workday header still on the page is wall_remains, never account_created (the TIAA false-positive killer)', async () => {
    // Live tiaa nights 20-21: five runs reported "create: form cleared";
    // no account email ever arrived and probes showed utilityButtonSignIn.
    const GHOST_CREATE_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h2>Create Account</h2>
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <input data-automation-id="verifyPassword" type="password" />
        <button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=createAccountSubmitButton]')
          .addEventListener('click', () => {
            document.body.innerHTML =
              '<button data-automation-id="utilityButtonSignIn">Sign In</button><p>Careers home</p>';
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(GHOST_CREATE_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.status).toBe("wall_remains");
        expect(r.notes.join(" ")).toMatch(
          /form cleared but the header still shows Sign In — NOT signed in/,
        );
        // Nothing was recorded — the vault stays evidence-only.
        expect(getAccount("interdigital.wd5.myworkdayjobs.com")).toBeNull();
      });
    } finally {
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("overlay-guarded Sign In: the click is a NO-OP, the Enter retry submits (TIAA night20 #63c, FIXTURE_CONFIRMED)", async () => {
    // Live tiaa.wd1 22f/22i: the visible Sign In sits on an
    // invisible-captcha overlay; clicking the button does NOTHING — no
    // error, no navigation — even with a valid account. Keyboard Enter
    // from the password field submits.
    const OVERLAY_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h2>Sign In</h2>
        <form id="f">
          <input data-automation-id="email" type="email" />
          <input data-automation-id="password" id="pw" type="password" />
          <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
        </form>
      </div>
      <script>
        // The button click is swallowed (overlay tenant). Only a keyboard
        // submit from the password field advances.
        document.getElementById('pw').addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { document.body.innerHTML = '<p>My Information</p>'; }
        });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(OVERLAY_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 1 });
        expect(r.notes.join(" ")).toMatch(
          /click answered nothing — retried with Enter/,
        );
        expect(r.status).toBe("signed_in");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 45_000);

  /**
   * The fixture above reveals each stage SYNCHRONOUSLY on click, which is
   * why it passed while the live run failed. Live 2026-08-14 (Crowe):
   * Workday rebuilt the page ~seconds after "Apply Manually"; the walk
   * probed 800ms later, found no third button, returned, and reported
   * "portal auth: no sign-in form on this page" with PORTAL_LOGIN_*
   * sitting unused in the env. This is that page, on a delay.
   */
  it("waits for a Workday account form that renders SECONDS after Apply Manually", async () => {
    const DELAYED_HTML = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>AI Engineering Intern</h1>
        <button data-automation-id="adventureButton" type="button">Apply</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=adventureButton]')
          .addEventListener('click', () => {
            document.getElementById('stage').innerHTML =
              '<h2>Start Your Application</h2>' +
              '<button data-automation-id="applyManually" type="button">Apply Manually</button>';
            document.querySelector('[data-automation-id=applyManually]')
              .addEventListener('click', () => {
                // Nothing clickable in the meantime — the old walk gave up here.
                document.getElementById('stage').innerHTML = '<p>Loading…</p>';
                setTimeout(() => {
                  document.getElementById('stage').innerHTML =
                    '<div data-automation-id="progressBar">Create Account/Sign In</div>' +
                    '<h2>Create Account</h2>' +
                    '<input data-automation-id="email" type="email" />' +
                    '<input data-automation-id="password" type="password" />' +
                    '<input data-automation-id="verifyPassword" type="password" />' +
                    '<button data-automation-id="createAccountSubmitButton" type="button">Create Account</button>';
                  document.querySelector('[data-automation-id=createAccountSubmitButton]')
                    .addEventListener('click', () => {
                      (globalThis).__created = true;
                      document.body.innerHTML = '<p>My Information</p>';
                    });
                }, 1500);
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    const prevEmail = process.env.PORTAL_LOGIN_EMAIL;
    const prevPassword = process.env.PORTAL_LOGIN_PASSWORD;
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    try {
      await onWorkdayPage(DELAYED_HTML, async (page) => {
        // settleMs > 0 engages the live poll (0 keeps fixtures synchronous).
        const r = await authenticateAtsPortal(page, { settleMs: 1 });
        expect(r.notes.join(" ")).toMatch(/Apply Manually/);
        // The whole point: the form was found, so the credentials were used.
        expect(r.notes.join(" ")).not.toMatch(/no sign-in form on this page/);
        expect(r.status).not.toBe("not_an_auth_wall");
        expect(
          await page.evaluate(
            () => (globalThis as unknown as { __created?: boolean }).__created,
          ),
        ).toBe(true);
        expect(r.secrets).toContain("StandingPass1!");
        expect(r.notes.join(" ")).not.toContain("StandingPass1!");
      });
    } finally {
      if (prevEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
      else process.env.PORTAL_LOGIN_EMAIL = prevEmail;
      if (prevPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
      else process.env.PORTAL_LOGIN_PASSWORD = prevPassword;
      applySafeFillEnv();
      resetConfigCache();
    }
  }, 30_000);

  it("after sign-in, scans Gmail only when the page asks for a verification code (FIXTURE_CONFIRMED)", async () => {
    const OTP_HTML = `<!DOCTYPE html><html><body>
      <div id="wall">
        <input data-automation-id="email" type="email" />
        <input data-automation-id="password" type="password" />
        <button data-automation-id="signInSubmitButton" type="button">Sign In</button>
      </div>
      <script>
        document.querySelector('[data-automation-id=signInSubmitButton]')
          .addEventListener('click', () => {
            document.getElementById('wall').innerHTML =
              '<p>We sent a verification code to your email — enter the code to continue.</p>' +
              '<input data-automation-id="verificationCode" autocomplete="one-time-code" />' +
              '<button data-automation-id="verifyButton" type="button">Verify</button>';
            document.querySelector('[data-automation-id=verifyButton]')
              .addEventListener('click', () => {
                document.body.innerHTML = '<p>My Information</p>';
              });
          });
      </script></body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      await onWorkdayPage(OTP_HTML, async (page) => {
        let waiterCalls = 0;
        const r = await authenticateAtsPortal(page, {
          emailOverride: "candidate@fixture.test",
          settleMs: 0,
          waiter: async () => {
            waiterCalls += 1;
            return { kind: "code", code: "482193", messageId: "m", pollsUsed: 1 };
          },
        });
        expect(waiterCalls).toBe(1);
        expect(r.verification_used).toBe(true);
        expect(r.status).toBe("signed_in");
        expect(r.secrets).toContain("482193");
        expect(r.notes.join(" ")).toMatch(/emailed code entered/);
        expect(r.notes.join(" ")).not.toContain("482193");
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("dual-form wall: does not POST empty Sign In as a view-flip; creates after sign-in miss (FIXTURE_CONFIRMED)", async () => {
    // Sandbox /portal/auth shape: Create Account and Sign In on one page.
    // Live 2026-08-16: portal auth clicked Sign In (the submit) as if it
    // were Workday's view-switch, then typed into the Create Account
    // fields, then reported wall_remains.
    const DUAL_HTML = `<!DOCTYPE html><html><body>
      <p id="err"></p>
      <h2>Create Account</h2>
      <form id="create">
        <input id="email" type="email" name="email" />
        <input id="password" type="password" name="password" />
        <input id="verifyPassword" type="password" name="verifyPassword" />
        <button type="submit">Create Account</button>
      </form>
      <h2>Sign In</h2>
      <form id="signin">
        <input id="si_email" type="email" name="email" />
        <input id="si_password" type="password" name="password" />
        <button type="submit">Sign In</button>
      </form>
      <script>
        var accounts = {};
        document.getElementById('create').addEventListener('submit', function (e) {
          e.preventDefault();
          var email = document.getElementById('email').value.toLowerCase();
          var pw = document.getElementById('password').value;
          var v = document.getElementById('verifyPassword').value;
          if (!email || !pw || pw !== v) {
            document.getElementById('err').textContent = 'Email and password are required.';
            return;
          }
          if (accounts[email]) {
            document.getElementById('err').textContent =
              'An account with this email already exists. Sign in instead.';
            return;
          }
          accounts[email] = pw;
          document.body.innerHTML = '<p>Application form</p><input name="first_name" />';
        });
        document.getElementById('signin').addEventListener('submit', function (e) {
          e.preventDefault();
          var email = document.getElementById('si_email').value.toLowerCase();
          var pw = document.getElementById('si_password').value;
          if (accounts[email] !== pw) {
            document.getElementById('err').textContent = 'Invalid email or password.';
            return;
          }
          document.body.innerHTML = '<p>Application form</p><input name="first_name" />';
        });
      </script>
    </body></html>`;
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    // #64: the sign-in-first mechanic under test needs an account on record.
    setAccount("interdigital.wd5.myworkdayjobs.com", {
      email: "candidate@fixture.test",
      password: "StandingPass1!",
    });
    try {
      await onWorkdayPage(DUAL_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" ")).not.toMatch(/flipped Create Account → Sign In/);
        expect(r.notes.join(" ")).toMatch(/Sign In form already on this page/);
        expect(r.notes.join(" ")).toMatch(/sign-in rejected/);
        expect(r.status).toBe("account_created");
        expect(await page.locator("input[name='first_name']").count()).toBe(1);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);
});

describe("workday sign-in DIALOG over the create-account form — live huntington.wd12 shape (FIXTURE_CONFIRMED)", () => {
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
    // #64 vault seeding/recording must never touch the real private/ —
    // a fixture password on a live host would hijack live runs.
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-portal-hd-"));
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    await browser.close().catch(() => undefined);
    if (savedPortalEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
    else process.env.PORTAL_LOGIN_EMAIL = savedPortalEmail;
    if (savedPortalPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
    else process.env.PORTAL_LOGIN_PASSWORD = savedPortalPassword;
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  /**
   * Night19 #45 (2026-08-30, huntington.wd12.myworkdayjobs.com, read-only
   * DOM probe after Apply → Apply Manually → Sign In): the Create Account
   * form STAYS in the DOM under a modal [role=dialog] holding the Sign In
   * form. Email inputs are type=text with autocomplete=email +
   * data-automation-id=email (no name/id). The real submit button is
   * aria-hidden; the visible control is <div role=button
   * data-automation-id=click_filter aria-label="Sign In">. A "beecatcher"
   * honeypot input sits next to both forms.
   */
  const HUNTINGTON_HTML = `<!DOCTYPE html><html><body>
    <div data-automation-id="createAccountContent">
      <h3>Create Account</h3>
      <form data-automation-id="signInFormo" id="create">
        <label for="c-email"><span>Email Address<abbr>*</abbr></span></label>
        <input type="text" data-automation-id="email" id="c-email" autocomplete="email" />
        <label for="c-pw"><span>Password</span></label>
        <input type="password" data-automation-id="password" id="c-pw" autocomplete="new-password" />
        <label for="c-vpw"><span>Verify New Password</span></label>
        <input type="password" data-automation-id="verifyPassword" id="c-vpw" autocomplete="new-password" />
        <input id="c-cb" type="checkbox" data-automation-id="createAccountCheckbox" />
        <div role="button" tabindex="0" aria-label="Create Account" data-automation-id="click_filter" id="c-click">Create Account</div>
        <button type="submit" data-automation-id="createAccountSubmitButton" tabindex="-2" aria-hidden="true">Create Account</button>
      </form>
      <button data-automation-id="signInLink">Sign In</button>
      <label for="hp1">Enter website. This input is for robots only, do not enter if you're human.</label>
      <input data-automation-id="beecatcher" id="hp1" name="website" type="text" />
    </div>
    <div role="dialog" aria-modal="true" data-automation-id="popUpDialog" style="position:fixed;top:0;left:0;right:0;bottom:0;background:#fff">
      <div data-automation-id="signInContent">
        <h3 id="authViewTitle">Sign In</h3>
        <div id="err" data-automation-id="errorMessage"></div>
        <form data-automation-id="signInFormo" id="signin">
          <label for="s-email"><span>Email Address<abbr>*</abbr></span></label>
          <input type="text" data-automation-id="email" id="s-email" autocomplete="email" />
          <label for="s-pw"><span>Password</span></label>
          <input type="password" data-automation-id="password" id="s-pw" autocomplete="current-password" />
          <div role="button" tabindex="0" aria-label="Sign In" data-automation-id="click_filter" id="s-click">Sign In</div>
          <button type="submit" data-automation-id="signInSubmitButton" tabindex="-2" aria-hidden="true">Sign In</button>
        </form>
        <div>Don't have an account yet?<button data-automation-id="createAccountLink">Create Account</button></div>
        <button data-automation-id="forgotPasswordLink">Forgot your password?</button>
        <input data-automation-id="beecatcher" id="hp2" name="website" type="text" />
      </div>
    </div>
    <script>
      var accounts = { 'candidate@fixture.test': 'StandingPass1!' };
      function signIn() {
        var email = document.getElementById('s-email').value.toLowerCase();
        var pw = document.getElementById('s-pw').value;
        if (document.getElementById('hp2').value || document.getElementById('hp1').value) {
          document.getElementById('err').textContent = 'Robot detected.'; return;
        }
        if (accounts[email] !== pw) { document.getElementById('err').textContent = 'Invalid email or password.'; return; }
        document.body.innerHTML = '<p>My Information</p><input name="first_name" />';
      }
      document.getElementById('s-click').addEventListener('click', signIn);
      document.getElementById('signin').addEventListener('submit', function (e) { e.preventDefault(); signIn(); });
      document.getElementById('c-click').addEventListener('click', function () {
        document.getElementById('err').textContent = 'Create Account was clicked — wrong form.';
      });
      document.getElementById('create').addEventListener('submit', function (e) {
        e.preventDefault(); document.getElementById('err').textContent = 'Create Account was clicked — wrong form.';
      });
    </script>
  </body></html>`;

  async function onWorkdayPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) => route.fulfill({ body: html, contentType: "text/html" }));
    await page.goto("https://huntington.wd12.myworkdayjobs.com/en-US/hnbcareers/job/x/apply/applyManually", {
      waitUntil: "domcontentloaded",
    });
    try {
      return await fn(page);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  it("diagnoses the DIALOG as a sign_in_form (email=true, no confirm) — not the create form behind it", async () => {
    const { diagnoseLoginWall } = await import("../../src/verification/loginWallDiagnosis.js");
    await onWorkdayPage(HUNTINGTON_HTML, async (page) => {
      const d = await diagnoseLoginWall(page);
      expect(d.classification).toBe("sign_in_form");
      expect(d.fields.email).toBe(true);
      expect(d.fields.password).toBe(true);
      expect(d.fields.confirmPassword).toBe(false);
    });
  }, 30_000);

  it("signs in INSIDE the dialog with standing credentials; the create form and the honeypots are never touched", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    // #64: sign-in-first needs an account on record (huntington's was
    // created live on night19 #8e).
    setAccount("huntington.wd12.myworkdayjobs.com", {
      email: "candidate@fixture.test",
      password: "StandingPass1!",
    });
    try {
      await onWorkdayPage(HUNTINGTON_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" "), r.notes.join(" | ")).toMatch(/targeting the visible auth dialog/);
        expect(r.status).toBe("signed_in");
        expect(r.escalated_to_create).toBe(false);
        expect(await page.locator("input[name='first_name']").count()).toBe(1);
        expect(r.notes.join(" ")).not.toMatch(/wrong form|Robot detected/);
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("create-account: a standing password that fails the page's stated policy is never submitted; the note names the gap", async () => {
    // Live 2026-08-30: Workday's Create Account silently ignores a
    // non-compliant password. The fixture's create handler would flag
    // "wrong form" if anything were submitted.
    // Live sequence: no account at this tenant → sign-in rejected → the
    // dialog's "Create Account" link swaps to the create form (rules listed).
    const CREATE_ONLY = HUNTINGTON_HTML.replace(
      "var accounts = { 'candidate@fixture.test': 'StandingPass1!' };",
      "var accounts = {}; document.querySelector('[data-automation-id=createAccountLink]').addEventListener('click', function () { document.querySelector('[role=dialog]').style.display = 'none'; });",
    ).replace(
      "<h3>Create Account</h3>",
      "<h3>Create Account</h3><p>Password Requirements: A numeric character A minimum of 8 characters A special character A lowercase character An uppercase character</p>",
    );
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "ALL-CAPS-NO-DIGITS!";
    resetConfigCache();
    try {
      await onWorkdayPage(CREATE_ONLY, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.notes.join(" | ")).toMatch(/fails this portal's password policy \(missing: numeric character, lowercase character\)/);
        expect(r.notes.join(" ")).not.toMatch(/wrong form/);
        expect(r.status).toBe("wall_remains");
        expect(await page.locator("#c-pw").inputValue()).toBe("");
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);

  it("harder: a WRONG standing password inside the dialog is credentials_rejected, not a blind create", async () => {
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "WrongPass9!";
    resetConfigCache();
    // #64: known account (wrong password) — sign-in is still first here.
    setAccount("huntington.wd12.myworkdayjobs.com", {
      email: "candidate@fixture.test",
      password: "WrongPass9!",
    });
    try {
      await onWorkdayPage(HUNTINGTON_HTML, async (page) => {
        const r = await authenticateAtsPortal(page, { settleMs: 0 });
        expect(r.status).not.toBe("signed_in");
        expect(await page.locator("input[name='first_name']").count()).toBe(0);
        expect(await page.locator("#hp1").inputValue()).toBe("");
        expect(await page.locator("#hp2").inputValue()).toBe("");
      });
    } finally {
      applySafeFillEnv();
    }
  }, 30_000);
});

describe("employer-sandbox portal auth (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let browser: Browser;
  let privDir: string;
  const savedPriv = process.env.PRIVATE_DIR;

  beforeEach(async () => {
    applySafeFillEnv();
    // #64 records verified creations in the vault — keep it off private/.
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-portal-sbv-"));
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
    browser = await chromium.launch({ headless: true });
  });
  afterEach(async () => {
    await browser.close().catch(() => undefined);
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    fs.rmSync(privDir, { recursive: true, force: true });
    applySafeFillEnv();
    resetConfigCache();
  });

  it("clears /portal/auth with standing credentials when no account exists yet", async () => {
    const outDir = path.join(os.tmpdir(), `jaa-portal-sb-${Date.now()}`);
    // verificationWall off: this test proves the PASSWORD wall clears with
    // standing credentials; the emailed-code wall has its own coverage
    // (hard-sandbox tests) and needs a mailbox this test does not have.
    const sandbox = await startEmployerSandbox({ port: 0, quiet: true, outDir, verificationWall: false });
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    process.env.PORTAL_LOGIN_EMAIL = "candidate@fixture.test";
    process.env.PORTAL_LOGIN_PASSWORD = "StandingPass1!";
    resetConfigCache();
    const page = await browser.newPage();
    try {
      await page.goto(`${sandbox.url}/portal/auth`, {
        waitUntil: "domcontentloaded",
      });
      const r = await authenticateAtsPortal(page, { settleMs: 0 });
      expect(r.notes.join(" ")).not.toMatch(/flipped Create Account → Sign In/);
      expect(["signed_in", "account_created"]).toContain(r.status);
      expect(page.url()).toMatch(/\/portal\/form$/);
    } finally {
      await page.close().catch(() => undefined);
      await sandbox.close();
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 45_000);
});
