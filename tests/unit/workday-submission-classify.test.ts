import { describe, expect, it } from "vitest";
import { detectWorkdaySubmission } from "../../src/ats/workday/submission.js";

/**
 * Post-submit page classification for Workday. The live Intel wd1 receipt
 * (2026-09-15, e52e2060) is Candidate Home with an "Application Submitted"
 * modal and the application row "We Are Reviewing Your Application"; the
 * word "Reviewing" tripped the wizard's bare "Review" page marker and a
 * real submission was parked as uncertain. UNIT_CONFIRMED.
 */

const CANDIDATE_HOME_RECEIPT = `
<html><body>
<h1>Welcome, Ada Example</h1>
<div role="dialog"><h2>Application Submitted</h2><a>Search for More Jobs</a><p>You have no more tasks.</p></div>
<section><h2>My Applications</h2>
<table><tr><td>AI Solutions Engineering Undergraduate Intern</td><td>JR0286629</td><td>We Are Reviewing Your Application</td><td>September 14, 2026</td></tr></table>
</section>
</body></html>`;

const WIZARD_REVIEW_PAGE = `
<html><body>
<div data-automation-id="progressBar">current step 6 of 6</div>
<h2>Review</h2>
<p>Please review your application before submitting.</p>
<button data-automation-id="bottom-navigation-submit-button">Submit</button>
</body></html>`;

const WIZARD_WITH_ERROR = `
<html><body>
<div data-automation-id="progressBar">current step 3 of 6</div>
<h2>Application Questions</h2>
<div data-automation-id="errorMessage">The field 4) is required and must have a value.</div>
<button data-automation-id="pageFooterNextButton">Save and Continue</button>
</body></html>`;

describe("detectWorkdaySubmission (UNIT_CONFIRMED)", () => {
  it("a receipt on Candidate Home is confirmed even though the page says 'Reviewing'", () => {
    expect(detectWorkdaySubmission(CANDIDATE_HOME_RECEIPT, "https://x.wd1.myworkdayjobs.com/en-US/External/userHome")).toBe("confirmed");
  });

  it("the wizard's Review page (progress bar present) is still on the form, never a confirmation", () => {
    expect(detectWorkdaySubmission(WIZARD_REVIEW_PAGE, "https://x.wd1.myworkdayjobs.com/apply")).toBe("still_on_form");
    expect(detectWorkdaySubmission(WIZARD_WITH_ERROR, "https://x.wd1.myworkdayjobs.com/apply")).toBe("still_on_form");
  });

  it("confirmation words inside a page that still carries the progress bar do not count", () => {
    const tricky = WIZARD_REVIEW_PAGE.replace("<p>Please review", "<p>Thank you for applying — please review");
    expect(detectWorkdaySubmission(tricky, "https://x.wd1.myworkdayjobs.com/apply")).toBe("still_on_form");
  });
});
