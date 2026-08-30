import { describe, expect, it } from "vitest";
import { reachGreenhouseApplicationForm } from "../../src/ats/greenhouse/liveFill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

const REQUESTED =
  "https://job-boards.greenhouse.io/jumptrading/jobs/8003019";

const FORM_HTML = `<form id="application_form">
  <label>First Name<input name="first_name" id="first_name"/></label>
  <label>Email<input type="email" name="email" id="email"/></label>
</form>`;

describe("reachGreenhouseApplicationForm (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("clicks Apply on a posting shell and re-gates on the revealed form", async () => {
    const html = `<!DOCTYPE html><html><body>
      <div id="stage">
        <h1>Campus UI Software Engineer</h1>
        <p>About the role.</p>
        <button id="apply">Apply</button>
      </div>
      <script>
        document.getElementById('apply').addEventListener('click', () => {
          document.getElementById('stage').innerHTML = ${JSON.stringify(FORM_HTML)};
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.gate.failureCode).toBeNull();
      expect(r.gate.html).toContain("application_form");
      expect(r.notes.join(" ")).toMatch(/landed on a posting|unknown landing/);
    });
  }, 45_000);

  it("a PASSING gate on identity-free chrome still runs the Apply recovery (samsara shell)", async () => {
    // Live 2026-08-29: samsara's ?gh_jid= landing carried form markers and
    // two footer "Select region" pickers — the gate passed, the fill
    // "verified" the pickers, and READY_TO_SUBMIT was junk until the
    // upload guard refused. A passing gate without applicant-identity
    // fields must be treated as a posting shell.
    const html = `<!DOCTYPE html><html><body>
      <div id="application_form">
        <h1>Software Engineer I (New Grad)</h1>
        <label>Region<select id="v-0-0-0-3-68" name="select-region"><option>US</option></select></label>
        <label>Language<select id="v-0-0-0-3-148" name="select-region"><option>EN</option></select></label>
        <button id="apply">Apply Now</button>
      </div>
      <div id="real"></div>
      <script>
        document.getElementById('apply').addEventListener('click', () => {
          document.getElementById('real').innerHTML = ${JSON.stringify(FORM_HTML)};
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.notes.join(" ")).toMatch(/no applicant-identity fields/);
      expect(r.gate.ok).toBe(true);
      expect(r.gate.html).toMatch(/first_name/);
    });
  }, 45_000);

  it("refuses a listing shell with no Apply, no iframe and no embed fallback instead of filling its search boxes (zipline shape)", async () => {
    // Live 2026-08-30: www.zipline.com/open-roles?gh_jid=… — the only
    // inputs are the site's "Search roles" boxes; Apply and hop both miss.
    // With no board token to build the canonical embed URL from, the reach
    // must REFUSE (FORM_NOT_FOUND) rather than hand chrome to the fill.
    const html = `<!DOCTYPE html><html><body>
      <div id="application_form">
        <h1>Open roles</h1>
        <label>Search roles<input id="s1" name="search" type="text"/></label>
        <label>Search roles<input id="s2" name="search-mobile" type="text"/></label>
        <ul><li>Electrical Project Engineer Intern</li><li>Software Engineer Intern</li></ul>
      </div>
    </body></html>`;
    // Embed URL without ?for= — no board token, so no fallback navigation
    // (tests must never leave the fixture page).
    const requested = "https://job-boards.greenhouse.io/embed/job_app?token=7980874003";
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, requested, requested);
      expect(r.gate.ok).toBe(false);
      expect(r.gate.failureCode).toBe("FORM_NOT_FOUND");
      expect(r.gate.reason).toMatch(/posting shell/);
      expect(r.notes.join(" ")).toMatch(/refusing to fill page chrome/);
    });
  }, 45_000);

  it("does not click Apply when the landing is already a Greenhouse form", async () => {
    const html = `<!DOCTYPE html><html><body>${FORM_HTML}</body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.notes).toEqual([]);
      expect(await page.locator("#application_form").count()).toBe(1);
    });
  }, 45_000);

  it("hops a Greenhouse embed despite listing search chrome and no Apply button", async () => {
    const embedUrl =
      "https://job-boards.greenhouse.io/embed/job_app?for=test&token=8003019";
    const outer = `<!DOCTYPE html><html><body>
      <h1>Campus UI Software Engineer</h1>
      <p>Apply now for this role.</p>
      <label>Search jobs<input name="q" placeholder="Search by job title"/></label>
      <iframe src="${embedUrl}"></iframe>
    </body></html>`;
    await withFixtureHtmlPage("<html><body></body></html>", async (page) => {
      await page.context().route("**/*", (route) =>
        route.fulfill({
          body: route.request().url().includes("/embed/job_app")
            ? `<!DOCTYPE html><html><body>${FORM_HTML}</body></html>`
            : outer,
          contentType: "text/html",
        }),
      );
      await page.goto(REQUESTED, { waitUntil: "domcontentloaded" });
      const r = await reachGreenhouseApplicationForm(page, REQUESTED, REQUESTED);
      expect(r.gate.ok).toBe(true);
      expect(r.notes.join(" ")).toMatch(/hopping to/);
      expect(await page.locator("#application_form").count()).toBe(1);
    });
  }, 45_000);
});
