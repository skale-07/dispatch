import { describe, expect, it } from "vitest";
import { openWorkdayHistoryRows } from "../../src/ats/workday/experienceSections.js";
import { closeWorkdayHeaderMenus } from "../../src/ats/workday/fill.js";
import { clickPastStrayPopup } from "../../src/ats/greenhouse/comboboxFill.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Live rb.wd5 (Federal Reserve) 2026-09-14, app 02302b66. FIXTURE_CONFIRMED.
 *
 * (1) My Experience with EMPTY sections: only "Add" buttons, so the page
 *     planned zero fields and the walk stopped. One row is opened per
 *     section that the profile can actually fill.
 * (2) The header's account submenu survived Escape + heading click and
 *     intercepted every text-field click ("<ul role=menu …> subtree
 *     intercepts pointer events"). Its own toggle closes it.
 */

const MY_EXPERIENCE = `<!DOCTYPE html><html><body>
  <h2>My Experience</h2>
  <div data-automation-id="applyFlowMyExpPage">
    <div role="group" aria-labelledby="Work-Experience-section">
      <h4 id="Work-Experience-section">Work Experience</h4>
      <div><button data-automation-id="add-button" id="add-work">Add</button></div>
      <div id="work-rows"></div>
    </div>
    <div role="group" aria-labelledby="Education-section">
      <h4 id="Education-section">Education</h4>
      <div><button data-automation-id="add-button" id="add-edu">Add</button></div>
      <div id="edu-rows"></div>
    </div>
    <div role="group" aria-labelledby="Skills-section">
      <h4 id="Skills-section">Skills</h4>
      <div><button data-automation-id="add-button" id="add-skill">Add</button></div>
    </div>
  </div>
  <script>
    document.getElementById('add-work').addEventListener('click', () => {
      document.getElementById('work-rows').innerHTML =
        '<label for="workExperience-6--jobTitle">Job Title</label><input id="workExperience-6--jobTitle" type="text" />' +
        '<label for="workExperience-6--companyName">Company</label><input id="workExperience-6--companyName" type="text" />' +
        '<button data-automation-id="add-button">Add Another</button>';
    });
    document.getElementById('add-edu').addEventListener('click', () => {
      document.getElementById('edu-rows').innerHTML =
        '<label for="education-7--schoolName">School or University</label><input id="education-7--schoolName" type="text" />';
    });
    window.__skillAdds = 0;
    document.getElementById('add-skill').addEventListener('click', () => { window.__skillAdds += 1; });
  </script>
</body></html>`;

const HEADER_MENU = `<!DOCTYPE html><html><body style="margin:0">
  <div data-automation-id="header" style="position:relative;height:60px;background:#333">
    <button id="account-submenu-button" aria-expanded="true" style="position:absolute;right:8px;top:8px">Account</button>
    <ul role="menu" aria-labelledby="account-submenu-button" id="menu"
        style="position:absolute;top:60px;left:0;width:100%;height:400px;background:#eee;list-style:none;margin:0;padding:0">
      <li role="menuitem">Candidate Home</li>
    </ul>
  </div>
  <h1>My Information</h1>
  <label>First Name <input id="name--legalName--firstName" style="width:200px;height:28px" /></label>
  <script>
    const btn = document.getElementById('account-submenu-button');
    const menu = document.getElementById('menu');
    // Escape and neutral clicks do NOT close this menu; only its toggle does.
    btn.addEventListener('click', () => { menu.remove(); btn.setAttribute('aria-expanded', 'false'); });
  </script>
</body></html>`;

const PROFILE = parsePublicProfile({
  legal_name: { first: "Shubham", last: "Kale" },
  email: "s@example.test",
  phone: "1",
  employment_history: [{ company: "SnapSort", title: "Founder", start: { month: "January", year: 2024 }, end: { month: "August", year: 2025 } }],
  education_history: [],
});

describe("Workday My Experience sections + header menu (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("opens one row for an empty section the profile can fill, and only that section", async () => {
    await withFixtureHtmlPage(MY_EXPERIENCE, async (page) => {
      const r = await openWorkdayHistoryRows(page, PROFILE, { settleMs: 100 });
      expect(r.clicked).toBe(1);
      expect(await page.locator("#workExperience-6--jobTitle").count()).toBe(1);
      // No structured education entry ⇒ its Add is never clicked; Skills is not a history section.
      expect(await page.locator("#education-7--schoolName").count()).toBe(0);
      expect(await page.evaluate(() => (globalThis as unknown as { __skillAdds: number }).__skillAdds)).toBe(0);
      expect(r.notes.join(" | ")).toMatch(/opened a employment row \(2 control\(s\) mounted\)/);
      expect(r.notes.join(" | ")).toMatch(/education section is empty and the profile has no structured education entry/);
      // A second pass leaves the now-populated section alone (never "Add Another").
      const again = await openWorkdayHistoryRows(page, PROFILE, { settleMs: 100 });
      expect(again.clicked).toBe(0);
      expect(await page.locator("#workExperience-6--jobTitle").count()).toBe(1);
    });
  }, 60_000);

  it("closes a header menu that ignores Escape via its own toggle, and the stray-popup click recovery does the same", async () => {
    await withFixtureHtmlPage(HEADER_MENU, async (page) => {
      const input = page.locator("#name--legalName--firstName");
      await expect(input.click({ timeout: 1_000 })).rejects.toThrow(/Timeout|intercepts/);
      const r = await clickPastStrayPopup(page, input, { timeoutMs: 1_500 });
      expect(r.recovered).toBe(true);
      expect(await page.locator("#menu").count()).toBe(0);
    });
    await withFixtureHtmlPage(HEADER_MENU, async (page) => {
      const r = await closeWorkdayHeaderMenus(page);
      expect(r.closed).toBe(true);
      expect(r.notes.join(" | ")).toMatch(/closed via its own toggle button/);
    });
  }, 60_000);
});
