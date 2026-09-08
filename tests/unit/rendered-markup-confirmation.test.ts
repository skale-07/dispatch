import { describe, expect, it } from "vitest";
import { classifyPage, renderedMarkup } from "../../src/ats/shared/pageClassify.js";
import { detectSubmissionUncertainty as greenhouseClassify } from "../../src/ats/greenhouse/submission.js";
import { classifyGenericSubmission } from "../../src/ats/generic/submission.js";

/**
 * #182 (live Stripe 2026-09-07): Greenhouse's job-boards embed carries the
 * posting's post-submit "Thank you for applying." inside its Remix
 * bootstrap <script> on the blank, unsubmitted form. Confirmation markers
 * must never read script/style bodies. UNIT_CONFIRMED.
 */
const JOB_BOARDS_FORM = `<!DOCTYPE html><html><head><title>Job Application for Software Engineer, Intern at Stripe</title>
<style>.x{content:"thank you for applying"}</style></head><body>
<form id="application_form" action="/embed/job_app?for=stripe&token=8130805" method="post">
  <h1>Apply for this job</h1>
  <label for="first_name">First Name *</label><input id="first_name" name="job_application[first_name]" type="text" />
  <label for="last_name">Last Name *</label><input id="last_name" name="job_application[last_name]" type="text" />
  <label for="email">Email *</label><input id="email" name="job_application[email]" type="email" />
  <label for="phone">Phone *</label><input id="phone" name="job_application[phone]" type="tel" />
  <label for="resume">Resume/CV *</label><input id="resume" name="job_application[resume]" type="file" />
  <button type="submit">Submit application</button>
</form>
<script>window.__remixContext = {"state":{"loaderData":{"routes/embed.job_app":{"job":{"job_post_location":"Toronto","company_name":"Stripe","confirmation_message":"\\u003ch1\\u003eThank you for applying.\\u003c/h1\\u003e\\n\\u003cp\\u003eYour application has been received.\\u003c/p\\u003e"}}}}};</script>
<noscript>Thank you for applying.</noscript>
</body></html>`;

const JOB_BOARDS_RECEIPT = `<!DOCTYPE html><html><body>
<div id="application_confirmation"><h1>Thank you for applying.</h1>
<p>Thank you for submitting your application to Stripe.</p></div>
<script>window.__remixContext = {"state":{"job":{"confirmation_message":"Thank you for applying."}}};</script>
</body></html>`;

describe("confirmation markers read rendered markup only (#182, UNIT_CONFIRMED)", () => {
  it("strips script, style, noscript and template bodies", () => {
    const out = renderedMarkup(JOB_BOARDS_FORM);
    expect(out).not.toMatch(/thank you for applying/i);
    expect(out).toMatch(/application_form/);
    expect(out).toMatch(/first_name/);
    expect(renderedMarkup(`<template><p>application received</p></template><p>Apply</p>`)).toBe("<p>Apply</p>");
  });

  it("classifies the unsubmitted Greenhouse job-boards form as a form, not a confirmation", () => {
    const c = classifyPage({
      html: JOB_BOARDS_FORM,
      url: "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130805",
    });
    expect(c.page_class).toBe("form");
  });

  it("still recognises a real receipt whose thank-you is rendered markup", () => {
    const c = classifyPage({
      html: JOB_BOARDS_RECEIPT,
      url: "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130805",
    });
    expect(c.page_class).toBe("confirmation");
  });

  it("greenhouse submit verifier never confirms on the blank job-boards form", () => {
    expect(greenhouseClassify(JOB_BOARDS_FORM, "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130805")).toBe("still_on_form");
    expect(greenhouseClassify(JOB_BOARDS_RECEIPT, "https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130805")).toBe("confirmed");
  });

  it("generic submit verifier ignores script-only confirmation text", () => {
    const html = `<html><body><p>Search jobs</p><script>var msg = "Thank you for applying";</script></body></html>`;
    expect(classifyGenericSubmission(html, "https://careers.example.com/x", { preClickFingerprint: ["a", "b"] })).not.toBe("confirmed");
  });
});
