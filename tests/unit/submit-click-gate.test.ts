import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { CLICK_WITHHELD_NOTE } from "../../src/ats/adapter.js";
import { ashbySubmit } from "../../src/ats/ashby/submission.js";
import { greenhouseSubmit } from "../../src/ats/greenhouse/submission.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const submitEnv = () =>
  applyControlledFillEnv({
    FORM_FILL_ENABLED: "true",
    DRY_RUN: "false",
    SUBMIT_ENABLED: "true",
  });

/**
 * The click-commit gate (issue: a FAILED_BEFORE_CLICK burned an unattended
 * submission slot). beforeClick fires only after a control is resolved,
 * visible, and enabled — so budget is consumed exactly at the moment a
 * click is actually possible, and a refusal withholds the click entirely.
 * FIXTURE_CONFIRMED.
 */
describe("submit click-commit gate (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv();

  const FORM = `
    <form>
      <input name="_systemfield_name" />
      <button type="button" onclick="document.body.dataset.clicked='yes'">Submit application</button>
    </form>`;

  it("beforeClick=false withholds the click and says so", async () => {
    submitEnv();
    await withFixtureHtmlPage(FORM, async (page) => {
      let calls = 0;
      const attempt = await ashbySubmit(page, {
        beforeClick: () => {
          calls++;
          return false;
        },
      });
      expect(attempt.clicked).toBe(false);
      expect(attempt.notes).toContain(CLICK_WITHHELD_NOTE);
      expect(calls).toBe(1);
      const clicked = await page.locator("body").getAttribute("data-clicked");
      expect(clicked).toBeNull();
    });
  }, 30_000);

  it("beforeClick=true allows exactly one click", async () => {
    submitEnv();
    await withFixtureHtmlPage(FORM, async (page) => {
      let calls = 0;
      const attempt = await ashbySubmit(page, {
        beforeClick: () => {
          calls++;
          return true;
        },
      });
      expect(attempt.clicked).toBe(true);
      expect(calls).toBe(1);
      const clicked = await page.locator("body").getAttribute("data-clicked");
      expect(clicked).toBe("yes");
    });
  }, 30_000);

  it("beforeClick is NOT consulted when the control cannot be resolved", async () => {
    submitEnv();
    const html = `<form><input name="_systemfield_name" /><button type="button">Next</button></form>`;
    await withFixtureHtmlPage(html, async (page) => {
      let calls = 0;
      const attempt = await ashbySubmit(page, {
        beforeClick: () => {
          calls++;
          return true;
        },
      });
      expect(attempt.clicked).toBe(false);
      expect(calls).toBe(0); // no budget question ever asked — nothing clickable
      expect(attempt.notes.join(" ")).toMatch(/not found/);
    });
  }, 30_000);

  it("greenhouse path honors the same gate", async () => {
    submitEnv();
    const html = `<form><input type="submit" value="Submit application" onclick="document.body.dataset.clicked='yes'; return false;" /></form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const attempt = await greenhouseSubmit(page, { beforeClick: () => false });
      expect(attempt.clicked).toBe(false);
      expect(attempt.notes).toContain(CLICK_WITHHELD_NOTE);
      const clicked = await page.locator("body").getAttribute("data-clicked");
      expect(clicked).toBeNull();
    });
  }, 30_000);

  it("greenhouse finds a typeless 'Submit application' button via the text fallback", async () => {
    // Live 2026-08-29 samsara embed: verified form, submit refused with
    // "submit control not found" — the button carried no type=submit.
    submitEnv();
    const html = `<form><input name="first_name" /><button onclick="document.body.dataset.clicked='yes'; event.preventDefault();">Submit application</button></form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const attempt = await greenhouseSubmit(page);
      expect(attempt.clicked).toBe(true);
      expect(await page.locator("body").getAttribute("data-clicked")).toBe(
        "yes",
      );
    });
  }, 30_000);

  it("greenhouse finds the submit control inside a child iframe", async () => {
    submitEnv();
    const inner =
      `<form><input name='first_name'/><button type='submit' onclick='document.body.dataset.clicked="yes"; event.preventDefault();'>Submit application</button></form>`;
    const html = `<div id="grnhse_app"><iframe srcdoc="${inner.replace(/"/g, "&quot;")}"></iframe></div>`;
    await withFixtureHtmlPage(html, async (page) => {
      await page.waitForLoadState("domcontentloaded");
      const attempt = await greenhouseSubmit(page);
      expect(attempt.clicked).toBe(true);
      expect(attempt.notes.join(" ")).toMatch(/frame\/text fallback/);
    });
  }, 30_000);
});
