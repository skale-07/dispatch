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
    // Workday: "Add" mounts the first row (with an "Add Another" beneath);
    // each "Add Another" mounts one more row with a fresh index.
    let nextRow = 6;
    function mountRow() {
      const n = nextRow++;
      const rows = document.getElementById('work-rows');
      rows.insertAdjacentHTML('beforeend',
        '<div><label for="workExperience-' + n + '--jobTitle">Job Title</label><input id="workExperience-' + n + '--jobTitle" type="text" />' +
        '<label for="workExperience-' + n + '--companyName">Company</label><input id="workExperience-' + n + '--companyName" type="text" /></div>');
      let another = document.getElementById('add-another-work');
      if (!another) {
        another = document.createElement('button');
        another.id = 'add-another-work';
        another.setAttribute('data-automation-id', 'add-button');
        another.textContent = 'Add Another';
        another.addEventListener('click', mountRow);
        rows.parentElement.appendChild(another);
      }
    }
    document.getElementById('add-work').addEventListener('click', () => {
      document.getElementById('add-work').remove();
      mountRow();
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

/** Operator directive 2026-09-14: one row per entry — "Add Another" for the rest. */
const THREE_JOBS = parsePublicProfile({
  legal_name: { first: "Shubham", last: "Kale" },
  email: "s@example.test",
  phone: "1",
  employment_history: [
    { company: "Summer Atlantic Capital", title: "Software Engineer", start: { month: "June", year: 2026 }, current: true },
    { company: "ClarityAtlas", title: "Co-Founder", start: { month: "September", year: 2025 }, end: { month: "May", year: 2026 } },
    { company: "SnapSort", title: "Founder", start: { month: "January", year: 2024 }, end: { month: "August", year: 2025 } },
  ],
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
      expect(r.notes.join(" | ")).toMatch(/opened employment row 1 of 1 \(Add\)/);
      expect(r.notes.join(" | ")).toMatch(/education section is empty and the profile has no structured education entry/);
      // A second pass leaves the now-populated section alone (one entry ⇒ one row, never "Add Another").
      const again = await openWorkdayHistoryRows(page, PROFILE, { settleMs: 100 });
      expect(again.clicked).toBe(0);
      expect(await page.locator("[id^='workExperience-'][id$='--jobTitle']").count()).toBe(1);
    });
  }, 60_000);

  it('opens one row per structured entry: "Add" for the first, "Add Another" for each further one (operator directive 2026-09-14)', async () => {
    await withFixtureHtmlPage(MY_EXPERIENCE, async (page) => {
      const r = await openWorkdayHistoryRows(page, THREE_JOBS, { settleMs: 100 });
      expect(r.clicked).toBe(3);
      expect(await page.locator("[id^='workExperience-'][id$='--jobTitle']").count()).toBe(3);
      expect(r.notes.join(" | ")).toMatch(/row 1 of 3 \(Add\)/);
      expect(r.notes.join(" | ")).toMatch(/row 3 of 3 \(Add Another\)/);
      // Idempotent: rows match entries, nothing more is added.
      const again = await openWorkdayHistoryRows(page, THREE_JOBS, { settleMs: 100 });
      expect(again.clicked).toBe(0);
      expect(again.notes.join(" | ")).toMatch(/shows 3 row\(s\) for 3 structured entries — nothing to add/);
    });
  }, 60_000);

  it("the wizard walk plans an empty page once the hook mounts rows, instead of stopping (live PIMCO cycle 144)", async () => {
    const { walkWorkdayWizard } = await import("../../src/applications/workdayWizard.js");
    // Page 1 has a field; Next swaps in an EMPTY My Experience (only Add).
    const html = `<!DOCTYPE html><html><body>
      <div data-automation-id="progressBar">steps</div>
      <div id="stage">
        <h2>My Information</h2>
        <label>First Name<input data-automation-id="legalNameSection_firstName" name="firstName" /></label>
        <button data-automation-id="bottom-navigation-next-button" type="button">Next</button>
      </div>
      <script>
        document.addEventListener("click", function (e) {
          var t = e.target;
          if (!(t instanceof HTMLElement) || t.getAttribute("data-automation-id") !== "bottom-navigation-next-button") return;
          document.getElementById("stage").innerHTML =
            '<h2>My Experience</h2>' +
            '<div role="group" aria-labelledby="Work-Experience-section"><h4 id="Work-Experience-section">Work Experience</h4>' +
            '<button data-automation-id="add-button" id="add-work">Add</button><div id="work-rows"></div></div>';
          document.getElementById("add-work").addEventListener("click", function () {
            document.getElementById("work-rows").innerHTML =
              '<label for="workExperience-6--jobTitle">Job Title</label><input id="workExperience-6--jobTitle" type="text" />';
          });
        });
      </script></body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const planned: string[] = [];
      const walk = await walkWorkdayWizard(
        page,
        async ({ html: pageHtml }) => {
          planned.push(/workExperience-6--jobTitle/.test(pageHtml) ? "rows" : "none");
          return { fillable: 1, filled: 1, verifyPassed: true };
        },
        {
          settleMs: 0,
          onEmptyPage: async (p) => (await openWorkdayHistoryRows(p, PROFILE, { settleMs: 100 })).clicked > 0,
        },
      );
      expect(planned).toEqual(["rows"]);
      expect(await page.locator("[id^='workExperience-'][id$='--jobTitle']").count()).toBe(1);
      expect(walk.notes.join(" | ")).toMatch(/rows mounted on an empty page — planning it/);
      expect(walk.notes.join(" | ")).not.toMatch(/no fillable fields — stopping/);
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
