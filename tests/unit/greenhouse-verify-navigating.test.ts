import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { greenhouseVerifySubmission } from "../../src/ats/greenhouse/submission.js";

/**
 * #193 (live Astera Labs 2026-09-08): right after the submit click,
 * page.content() throws "Unable to retrieve content because the page is
 * navigating and changing the content" while the receipt page loads. The
 * verifier must wait and read again instead of calling a real submission
 * uncertain. UNIT_CONFIRMED with a scripted page.
 */
function scriptedPage(contents: Array<string | Error>): Page {
  let calls = 0;
  const page = {
    url: () => "https://job-boards.greenhouse.io/asteralabs/jobs/4724488005/confirmation",
    content: async () => {
      const next = contents[Math.min(calls, contents.length - 1)]!;
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
  };
  return page as unknown as Page;
}

const RECEIPT = `<html><body><div id="application_confirmation"><h1>Thank you for applying.</h1></div></body></html>`;

describe("greenhouse verify tolerates an in-flight navigation (#193, UNIT_CONFIRMED)", () => {
  it("retries content() after the navigating error and confirms the receipt", async () => {
    const page = scriptedPage([
      new Error("page.content: Unable to retrieve content because the page is navigating and changing the content."),
      new Error("page.content: Unable to retrieve content because the page is navigating and changing the content."),
      RECEIPT,
    ]);
    const receipt = await greenhouseVerifySubmission(page, { screenshotPath: "unused.png", timeoutMs: 5_000 });
    expect(receipt.submitted).toBe(true);
    expect(receipt.confirmation_text).toMatch(/thank you for applying/i);
  });

  it("still surfaces unrelated content() failures", async () => {
    const page = scriptedPage([new Error("Target page, context or browser has been closed")]);
    await expect(
      greenhouseVerifySubmission(page, { screenshotPath: "unused.png", timeoutMs: 2_000 }),
    ).rejects.toThrow(/closed/);
  });
});
