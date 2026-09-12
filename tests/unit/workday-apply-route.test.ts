import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateAtsPortal } from "../../src/verification/portalAuth.js";
import { resetConfigCache } from "../../src/config/index.js";
import { workdaySelectorsV1 } from "../../src/ats/workday/selectors.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * #275 (operator directive 2026-09-12): "experiment with Workday's OWN
 * Autofill with Resume path instead of always clicking Apply Manually …
 * keep the route behind a flag or an explicit option so the manual path
 * stays the default."
 *
 * Under test: the chooser takes the route it is given, the autofill leg
 * actually hands the file to the page, and EVERY unhappy shape degrades back
 * to Apply Manually rather than stalling. FIXTURE_CONFIRMED — a routed
 * Workday-host page, not a live tenant.
 */

/**
 * Workday's Start Your Application chooser, both methods present. Shaped
 * like the real one: the autofill click reveals a CSS-HIDDEN file input
 * inside a drop zone, and the account form paints only after the file lands
 * (Workday parses server-side, so the form is never there on the click).
 */
const CHOOSER_HTML = `<!DOCTYPE html><html><body>
  <h1>Start Your Application</h1>
  <button data-automation-id="autofillWithResume" type="button">Autofill with Resume</button>
  <button data-automation-id="applyManually" type="button">Apply Manually</button>
  <div id="zone"></div>
  <div id="after"></div>
<script>
  function paintAuthForm() {
    var f = document.createElement('form');
    var e = document.createElement('input');
    e.setAttribute('data-automation-id', 'email');
    e.type = 'email';
    var p = document.createElement('input');
    p.setAttribute('data-automation-id', 'password');
    p.type = 'password';
    f.appendChild(e);
    f.appendChild(p);
    document.getElementById('after').appendChild(f);
  }
  var autofillBtn = document.querySelector('[data-automation-id="autofillWithResume"]');
  if (autofillBtn) autofillBtn
    .addEventListener('click', function () {
      var zone = document.createElement('div');
      zone.setAttribute('data-automation-id', 'fileUpload');
      var input = document.createElement('input');
      input.type = 'file';
      input.setAttribute('data-automation-id', 'file-upload-input-ref');
      input.style.display = 'none';
      input.addEventListener('change', function () {
        window.__parsed = this.files[0] ? this.files[0].name : null;
        setTimeout(paintAuthForm, 20);
      });
      zone.appendChild(input);
      document.getElementById('zone').appendChild(zone);
    });
  document.querySelector('[data-automation-id="applyManually"]')
    .addEventListener('click', function () {
      window.__manual = true;
      paintAuthForm();
    });
</script>
</body></html>`;

/**
 * A tenant whose chooser offers only the manual method. Dropping the button
 * is enough — the script above guards its own wiring.
 */
const MANUAL_ONLY_HTML = CHOOSER_HTML.replace(
  /<button data-automation-id="autofillWithResume"[\s\S]*?<\/button>/,
  "",
);

describe("workday apply-method route (#275, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let browser: Browser;
  let privDir: string;
  let resumePath: string;
  const savedPriv = process.env.PRIVATE_DIR;
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;

  beforeEach(async () => {
    applySafeFillEnv();
    savedEmail = process.env.PORTAL_LOGIN_EMAIL;
    savedPassword = process.env.PORTAL_LOGIN_PASSWORD;
    delete process.env.PORTAL_LOGIN_EMAIL;
    delete process.env.PORTAL_LOGIN_PASSWORD;
    privDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-wd-route-"));
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    resumePath = path.join(privDir, "candidate", "resume.pdf");
    fs.writeFileSync(resumePath, "%PDF-1.4\n% fixture resume\n");
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    await browser.close().catch(() => undefined);
    if (savedPriv === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = savedPriv;
    if (savedEmail === undefined) delete process.env.PORTAL_LOGIN_EMAIL;
    else process.env.PORTAL_LOGIN_EMAIL = savedEmail;
    if (savedPassword === undefined) delete process.env.PORTAL_LOGIN_PASSWORD;
    else process.env.PORTAL_LOGIN_PASSWORD = savedPassword;
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
    applyControlledFillEnv({ NAVIGATION_ENABLED: "true" });
    resetConfigCache();
    try {
      return await fn(page);
    } finally {
      applySafeFillEnv();
      await context.close().catch(() => undefined);
    }
  }

  it("defaults to Apply Manually when no route is passed (today's behaviour)", async () => {
    await onWorkdayPage(CHOOSER_HTML, async (page) => {
      const r = await authenticateAtsPortal(page, {
        emailOverride: "candidate@example.com",
        settleMs: 20,
      });
      expect(r.notes.join(" | ")).toMatch(/clicked Apply Manually/);
      expect(r.notes.join(" | ")).not.toMatch(/Autofill with Resume/);
      expect(await page.evaluate(() => (globalThis as unknown as { __manual?: boolean }).__manual)).toBe(true);
    });
  }, 60_000);

  it("takes Autofill with Resume on the autofill route and hands over the file", async () => {
    await onWorkdayPage(CHOOSER_HTML, async (page) => {
      const r = await authenticateAtsPortal(page, {
        emailOverride: "candidate@example.com",
        settleMs: 20,
        workdayRoute: "autofill",
        resumePath,
      });
      const notes = r.notes.join(" | ");
      expect(notes).toMatch(/clicked Autofill with Resume \(#275\)/);
      expect(notes).toMatch(/handed Workday resume\.pdf to parse/);
      // The page really received the file, and the parse reached the form.
      expect(
        await page.evaluate(() => (globalThis as unknown as { __parsed?: string }).__parsed),
      ).toBe("resume.pdf");
      expect(notes).toMatch(/autofill parse reached the account form in \d+ms/);
      // Apply Manually was never needed.
      expect(notes).not.toMatch(/clicked Apply Manually/);
    });
  }, 60_000);

  it("degrades to Apply Manually when the tenant offers no autofill control", async () => {
    await onWorkdayPage(MANUAL_ONLY_HTML, async (page) => {
      const r = await authenticateAtsPortal(page, {
        emailOverride: "candidate@example.com",
        settleMs: 20,
        workdayRoute: "autofill",
        resumePath,
      });
      const notes = r.notes.join(" | ");
      expect(notes).toMatch(
        /autofill route degraded to manual — no Autofill with Resume control/,
      );
      expect(notes).toMatch(/clicked Apply Manually/);
    });
  }, 60_000);

  it("degrades to Apply Manually when the resume is not on disk", async () => {
    await onWorkdayPage(CHOOSER_HTML, async (page) => {
      const r = await authenticateAtsPortal(page, {
        emailOverride: "candidate@example.com",
        settleMs: 20,
        workdayRoute: "autofill",
        resumePath: path.join(privDir, "candidate", "absent.pdf"),
      });
      const notes = r.notes.join(" | ");
      expect(notes).toMatch(/autofill route degraded to manual — no resume at absent\.pdf/);
      expect(notes).toMatch(/clicked Apply Manually/);
      // Nothing was uploaded.
      expect(
        await page.evaluate(() => (globalThis as unknown as { __parsed?: string }).__parsed),
      ).toBeUndefined();
    });
  }, 60_000);

  it("degrades to Apply Manually when the route is autofill but no resume path is given", async () => {
    await onWorkdayPage(CHOOSER_HTML, async (page) => {
      const r = await authenticateAtsPortal(page, {
        emailOverride: "candidate@example.com",
        settleMs: 20,
        workdayRoute: "autofill",
      });
      const notes = r.notes.join(" | ");
      expect(notes).toMatch(/autofill route degraded to manual — no resume path passed/);
      expect(notes).toMatch(/clicked Apply Manually/);
    });
  }, 60_000);

  it("keeps the autofill selectors in the versioned registry, not inline", () => {
    const m = workdaySelectorsV1.applyMethods;
    expect(m.autofillWithResume).toMatch(/autofillWithResume/);
    expect(m.autofillFileInput).toMatch(/input\[type='file'\]/);
    expect(m.autofillDropZone).toMatch(/fileUpload|quickApplyResumeUpload/);
    expect(m.autofillUploadedItem).toMatch(/file-upload-item|attachment-item/);
    expect(m.autofillContinue).toMatch(/continue/i);
  });
});
