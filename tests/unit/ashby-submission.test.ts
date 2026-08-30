import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Page } from "playwright";
import {
  ashbySubmit,
  ashbyVerifySubmission,
  detectSubmissionUncertainty,
  extractApplicationIdentifier,
  SubmissionUncertainError,
} from "../../src/ats/ashby/submission.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyControlledFillEnv,
  applySafeFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

const FIXTURE_DIR = path.join(process.cwd(), "tests", "fixtures", "ats");

function fixtureHtml(name: string): string {
  return fs.readFileSync(
    path.join(FIXTURE_DIR, name, "dom.sanitized.html"),
    "utf8",
  );
}

// Ashby never navigates on submit — the application URL is also the
// confirmation URL.
const APPLICATION_URL =
  "https://jobs.ashbyhq.com/acme/9b1e0c2a-1234-4abc-8def-1234567890ab/application";

function scratchScreenshotPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ashby-submit-test-"));
  return path.join(dir, "receipt.png");
}

describe("Ashby submission (M6)", () => {
  useIsolatedFillEnv("safe");

  beforeEach(() => {
    applySafeFillEnv();
  });

  describe("detectSubmissionUncertainty (UNIT_CONFIRMED)", () => {
    it("confirms on the in-page success panel with an unchanged URL", () => {
      expect(
        detectSubmissionUncertainty(
          fixtureHtml("ashby-confirmation"),
          APPLICATION_URL,
        ),
      ).toBe("confirmed");
    });

    it("classifies the application form as still_on_form", () => {
      expect(
        detectSubmissionUncertainty(fixtureHtml("ashby"), APPLICATION_URL),
      ).toBe("still_on_form");
    });

    // Live 2026-08-30 (Quadrillion 23d64c04): Ashby replaced the form with
    // its spam banner; the classifier read "unknown" and parked UNCERTAIN.
    const SPAM_BANNER = `<html><body><div class="ashby-job-posting"><h1>Software Engineering Intern</h1>
      <div role="alert"><p>We couldn't submit your application</p>
      <p>Your application submission was flagged as possible spam. If you believe this was a mistake, please submit your application again.</p></div>
      <h2>Try these steps</h2><ul><li>Turn off your VPN or proxy</li><li>Pause browser extensions</li></ul></div></body></html>`;

    it("classifies Ashby's 'flagged as possible spam' banner as rejected (form gone)", () => {
      expect(detectSubmissionUncertainty(SPAM_BANNER, APPLICATION_URL)).toBe("rejected");
    });

    it("rejected wins even when the form is still rendered underneath the banner", () => {
      const withForm = fixtureHtml("ashby").replace(
        "<body>",
        `<body><div role="alert">We couldn't submit your application — flagged as possible spam.</div>`,
      );
      expect(detectSubmissionUncertainty(withForm, APPLICATION_URL)).toBe("rejected");
    });

    it("the bare word spam (e.g. a screener about spam filters) is not a rejection", () => {
      const html = fixtureHtml("ashby").replace(
        "<body>",
        "<body><p>Have you built spam detection systems before?</p>",
      );
      expect(detectSubmissionUncertainty(html, APPLICATION_URL)).toBe("still_on_form");
    });

    it("verifySubmission fast-fails on the rejection with the refusal text as evidence", async () => {
      const shot = scratchScreenshotPath();
      const started = Date.now();
      await withFixtureHtmlPage(SPAM_BANNER, async (page) => {
        let caught: unknown;
        try {
          await ashbyVerifySubmission(page, { screenshotPath: shot, timeoutMs: 8000 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SubmissionUncertainError);
        const e = caught as SubmissionUncertainError;
        expect(e.evidence["classification"]).toBe("rejected");
        expect(String(e.evidence["validation_error"])).toMatch(/couldn't submit your application/i);
        expect(e.message).toMatch(/rejected by the form/);
      });
      // Did not burn the full window waiting for a confirmation that cannot come.
      expect(Date.now() - started).toBeLessThan(7000);
      fs.rmSync(shot, { force: true });
    }, 30_000);

    // Live 2026-08-30 (Composio d607b204) and 2026-08-11 (Quadrillion): the
    // corrections banner names the field inside a link. The old regex knew
    // "field is required" but not this phrasing, so the run burned the 15s
    // window and parked UNCERTAIN instead of naming the missing answer.
    const CORRECTIONS_BANNER =
      `<div role="alert"><p>Your form needs corrections</p><ul><li>Missing entry for required field:
        <a href="#_systemfield_takehome">Complete the Takehome</a></li></ul></div>`;

    it("verifySubmission fast-fails on Ashby's corrections banner and names the field", async () => {
      const shot = scratchScreenshotPath();
      const html = fixtureHtml("ashby").replace("<body>", `<body>${CORRECTIONS_BANNER}`);
      const started = Date.now();
      await withFixtureHtmlPage(html, async (page) => {
        let caught: unknown;
        try {
          await ashbyVerifySubmission(page, { screenshotPath: shot, timeoutMs: 8000 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(SubmissionUncertainError);
        const e = caught as SubmissionUncertainError;
        expect(e.evidence["classification"]).toBe("still_on_form");
        expect(e.evidence["validation_error"]).toBe(
          "missing entry for required field: Complete the Takehome",
        );
      });
      expect(Date.now() - started).toBeLessThan(7000);
      fs.rmSync(shot, { force: true });
    }, 30_000);

    it("classifies a blank page as unknown", () => {
      expect(
        detectSubmissionUncertainty(
          "<html><body></body></html>",
          APPLICATION_URL,
        ),
      ).toBe("unknown");
    });

    it("confirms success even when SPA script blobs still carry _systemfield_ strings", () => {
      // Review finding: the broad formMarkers hit embedded JSON, which
      // would have classified every real success still_on_form forever.
      const successWithScripts =
        fixtureHtml("ashby-confirmation").replace(
          "</body>",
          `<script>window.__appData = {"fields":[{"name":"_systemfield_name"}]};</script></body>`,
        );
      expect(
        detectSubmissionUncertainty(successWithScripts, APPLICATION_URL),
      ).toBe("confirmed");
      // A rendered input, by contrast, keeps it still_on_form.
      const successWithRenderedForm =
        fixtureHtml("ashby-confirmation").replace(
          "</body>",
          `<input name="_systemfield_name" type="text"></body>`,
        );
      expect(
        detectSubmissionUncertainty(successWithRenderedForm, APPLICATION_URL),
      ).toBe("still_on_form");
    });

    it("extracts the confirmation identifier", () => {
      expect(
        extractApplicationIdentifier(fixtureHtml("ashby-confirmation")),
      ).toBe("AB-3315-CONF");
    });
  });

  describe("guard refusal (UNIT_CONFIRMED)", () => {
    it("refuses with all flags off, before any page interaction", async () => {
      await expect(ashbySubmit(null as unknown as Page)).rejects.toThrow(
        /FORM_FILL_ENABLED=false/,
      );
    });

    it("refuses with fill enabled but SUBMIT_ENABLED=false", async () => {
      applyControlledFillEnv({
        FORM_FILL_ENABLED: "true",
        DRY_RUN: "false",
        SUBMIT_ENABLED: "false",
      });
      try {
        await expect(ashbySubmit(null as unknown as Page)).rejects.toThrow(
          /SUBMIT_ENABLED=false/,
        );
      } finally {
        applySafeFillEnv();
      }
    });
  });

  describe("fixture submit flow (FIXTURE_CONFIRMED)", () => {
    it(
      "clicks submit, sees the in-place success panel, and returns a receipt",
      async () => {
        applyControlledFillEnv({
          FORM_FILL_ENABLED: "true",
          DRY_RUN: "false",
          SUBMIT_ENABLED: "true",
        });
        const screenshotPath = scratchScreenshotPath();
        try {
          await withFixtureHtmlPage(
            fixtureHtml("ashby-submitflow"),
            async (page) => {
              const attempt = await ashbySubmit(page);
              expect(attempt.clicked).toBe(true);

              const receipt = await ashbyVerifySubmission(page, {
                screenshotPath,
                timeoutMs: 5_000,
              });
              expect(receipt.submitted).toBe(true);
              expect(receipt.application_identifier).toBe("AB-3315-CONF");
              expect(receipt.confirmation_text).toMatch(
                /application has been submitted/i,
              );
              expect(fs.existsSync(screenshotPath)).toBe(true);
            },
          );
        } finally {
          applySafeFillEnv();
        }
      },
      45_000,
    );

    it(
      "throws SubmissionUncertainError when the form never confirms, with screenshot evidence",
      async () => {
        const screenshotPath = scratchScreenshotPath();
        await withFixtureHtmlPage(fixtureHtml("ashby"), async (page) => {
          await expect(
            ashbyVerifySubmission(page, {
              screenshotPath,
              timeoutMs: 1_500,
            }),
          ).rejects.toThrow(SubmissionUncertainError);
          expect(fs.existsSync(screenshotPath)).toBe(true);
        });
      },
      45_000,
    );
  });
});
