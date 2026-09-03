import { describe, expect, it } from "vitest";
import {
  discoverFieldsFromHtml,
  isJobSearchChrome,
  isUninformativeLabel,
} from "../../src/applications/fieldDiscovery.js";
import { classifyPage } from "../../src/ats/shared/pageClassify.js";

/**
 * #157 (live internal-careers-rivian.icims.com 2026-09-03): the POSTING
 * page's only two inputs were the site's own job-search box, so the page
 * classified as `form`, the screener bank answered one and an LLM call
 * invented "United States" for the other. Both read back empty and the run
 * stopped AMBIGUOUS_FIELD without ever opening the application.
 *
 * The shape below is the live one, i18n keys included. FIXTURE_CONFIRMED.
 */
const RIVIAN_POSTING_HTML = `
<html><body>
  <header>
    <input id="keyword-search" name="keyword-search" type="text"
           placeholder="JOBS.KEYWORD_SEARCH_PLACEHOLDER">
    <input id="location-search" name="location-search" type="text"
           placeholder="JOBS.LOCATION_SEARCH_PLACEHOLDER">
  </header>
  <main>
    <h1>Software Engineering Intern, Connected Systems</h1>
    <a class="btn" href="/jobs/27486/login">Apply for this job online</a>
  </main>
</body></html>`;

/** A real application form that also ships a Workday-style option picker. */
const WORKDAY_FORM_HTML = `
<html><body><form>
  <label for="fn">First Name</label>
  <input id="fn" name="firstName" type="text">
  <label for="em">Email</label>
  <input id="em" name="email" type="email">
  <label for="skills">Skills</label>
  <input id="skills" name="skills" type="text" placeholder="Search"
         data-uxi-widget-type="selectinput">
</form></body></html>`;

describe("#157 job-board search chrome is not an application field", () => {
  it("drops the listing page's keyword/location search inputs", () => {
    const fields = discoverFieldsFromHtml(RIVIAN_POSTING_HTML);
    expect(fields).toHaveLength(0);
  });

  it("makes the posting classify as a posting, so Apply gets clicked", () => {
    const result = classifyPage({
      html: RIVIAN_POSTING_HTML,
      url: "https://internal-careers-rivian.icims.com/jobs/27486/software-engineering-intern/job",
    });
    expect(result.page_class).toBe("posting");
    expect(result.field_count).toBe(0);
  });

  it("keeps a real application form, including a Workday option picker", () => {
    const fields = discoverFieldsFromHtml(WORKDAY_FORM_HTML);
    const names = fields.map((f) => f.name);
    expect(names).toContain("firstName");
    expect(names).toContain("email");
    // #67: placeholder "Search" on a selectinput is an option picker.
    expect(names).toContain("skills");
  });

  it("treats an untranslated i18n key as an uninformative label", () => {
    expect(isUninformativeLabel("JOBS.KEYWORD_SEARCH_PLACEHOLDER")).toBe(true);
    expect(isUninformativeLabel("SEARCH.LOCATION")).toBe(true);
    // Real questions are never this shape.
    expect(isUninformativeLabel("Are you legally authorized to work?")).toBe(
      false,
    );
    expect(isUninformativeLabel("LinkedIn Profile")).toBe(false);
    expect(isUninformativeLabel("U.S. Citizen")).toBe(false);
  });

  it("requires the job-board pairing — bare 'search' is never enough", () => {
    // Workday's own option picker says placeholder="Search" (#67).
    expect(
      isJobSearchChrome({
        label: "Search",
        name: "skills",
        attrs: 'data-uxi-widget-type="selectinput"',
      }),
    ).toBe(false);
    expect(isJobSearchChrome({ label: "Search", name: "research_interest" })).toBe(
      false,
    );
    // A real question that merely contains the word.
    expect(
      isJobSearchChrome({
        label: "How did you hear about this job search?",
        name: "how_heard",
      }),
    ).toBe(false);

    expect(isJobSearchChrome({ label: "", name: "keyword-search" })).toBe(true);
    expect(isJobSearchChrome({ label: "", name: "location_search" })).toBe(true);
    expect(isJobSearchChrome({ label: "", inputId: "search-jobs" })).toBe(true);
    expect(
      isJobSearchChrome({ label: "Search by job title, ID, or keyword" }),
    ).toBe(true);
    expect(
      isJobSearchChrome({ label: "City, state, or country/region" }),
    ).toBe(true);
  });
});
