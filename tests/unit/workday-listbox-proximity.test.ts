import { describe, expect, it } from "vitest";
import {
  clickPastStrayPopup,
  fillComboboxControl,
  HOW_HEARD_CLASS_PATTERNS,
} from "../../src/ats/greenhouse/comboboxFill.js";
import { comboboxAlternates } from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Day32 Workday walls, browser halves. FIXTURE_CONFIRMED.
 *
 * #277 (live Leidos 2026-09-12, PIMCO wd1 2026-09-14): Workday renders
 * popups in portals, so "first visible listbox in document order" returned
 * the phone COUNTRY-CODE list for `source--source` — how-did-you-hear
 * harvested "United States of America (+1)" and the last-resort rung
 * picked it. The fixture puts a stale listbox FIRST in the DOM, far from
 * the control; the control's own popup opens directly beneath it.
 *
 * Negative control: with the proximity rule removed, the stale list is
 * read, no social-media row exists there, and the pick is "United States
 * of America (+1)" (the operator-directive first-option rung) — this test
 * then fails on the label.
 */
const PORTAL_LISTBOXES = `<!DOCTYPE html><html><body style="margin:0">
  <ul id="stale" role="listbox" style="position:absolute;top:0;left:0;width:300px;background:#eee;list-style:none;margin:0;padding:4px">
    <li role="option">United States of America (+1)</li>
    <li role="option">Uruguay (+598)</li>
  </ul>
  <div style="height:420px"></div>
  <div data-automation-id="formField-source" style="position:relative;width:320px">
    <button id="source--source" type="button" aria-haspopup="listbox" aria-expanded="false"
      style="width:300px;height:36px">Select One</button>
  </div>
  <ul id="src-list" role="listbox" style="display:none;position:absolute;top:470px;left:0;width:300px;background:#fff;list-style:none;margin:0;padding:4px">
    <li role="option">Select One</li>
    <li role="option">Employee Referral</li>
    <li role="option">Career Fair</li>
    <li role="option">Social Networking Site</li>
    <li role="option">Job Board</li>
  </ul>
  <script>
    const btn = document.getElementById('source--source');
    const list = document.getElementById('src-list');
    btn.addEventListener('click', () => {
      const open = list.style.display !== 'none';
      list.style.display = open ? 'none' : 'block';
      btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    });
    for (const li of list.querySelectorAll('li')) {
      li.addEventListener('click', () => {
        btn.textContent = li.textContent;
        list.style.display = 'none';
        btn.setAttribute('aria-expanded', 'false');
      });
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') list.style.display = 'none'; });
  </script>
</body></html>`;

/**
 * Live rb.wd5 2026-09-14 (app 02302b66): a country popper stayed open
 * (`data-popper-reference-hidden`) over the name/address inputs, every
 * click timed out ("<div>Uruguay</div> … intercepts pointer events") and
 * six fields failed verify. Escape closes the real popper; the fixture
 * does the same.
 */
const STRAY_POPPER = `<!DOCTYPE html><html><body style="margin:0">
  <div style="height:80px"></div>
  <label>First Name <input id="name--legalName--firstName" style="width:240px;height:30px" /></label>
  <div id="popper" data-popper-placement="bottom" data-popper-reference-hidden=""
       style="position:absolute;top:60px;left:0;width:400px;height:120px;background:#ddd"><div>Uruguay</div></div>
  <script>
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.getElementById('popper')?.remove();
    });
  </script>
</body></html>`;

describe("Workday listbox targeting + stray popups (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("reads the control's OWN popup, not the first listbox in the DOM, and picks a social-media row for LinkedIn", async () => {
    await withFixtureHtmlPage(PORTAL_LISTBOXES, async (page) => {
      const btn = page.locator("#source--source");
      const r = await fillComboboxControl(page, btn, "LinkedIn", {
        alternates: comboboxAlternates("how_heard", "LinkedIn"),
        classPatterns: HOW_HEARD_CLASS_PATTERNS,
        allowOtherFallback: true,
        lastResortFirstOption: true,
      });
      expect(r.notes.join(" | ")).not.toMatch(/United States/);
      expect(r.selectedLabel).toBe("Social Networking Site");
      expect(r.committed).toBe(true);
      expect(await btn.textContent()).toBe("Social Networking Site");
    });
  }, 60_000);

  it("a click intercepted by a stray popper is retried once after dismissing it", async () => {
    await withFixtureHtmlPage(STRAY_POPPER, async (page) => {
      const input = page.locator("#name--legalName--firstName");
      // Negative control: the plain click cannot land.
      await expect(input.click({ timeout: 1_000 })).rejects.toThrow(/Timeout|intercepts/);
      const r = await clickPastStrayPopup(page, input, { timeoutMs: 1_500 });
      expect(r.recovered).toBe(true);
      expect(await page.locator("#popper").count()).toBe(0);
      await input.fill("Shubham");
      expect(await input.inputValue()).toBe("Shubham");
    });
  }, 60_000);
});
