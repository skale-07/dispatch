import { describe, expect, it } from "vitest";
import type { Page } from "playwright";
import { pageContentWithRetry } from "../../src/browser/pageContent.js";

/**
 * Regression for session 1b93205e: app 7d6c2811 died as a pipeline_error on
 * "page.content: Unable to retrieve content because the page is navigating
 * and changing the content" — a transient race a bounded retry absorbs.
 */

function fakePage(behaviors: Array<string | Error>): Page {
  let i = 0;
  return {
    content: async () => {
      const b = behaviors[Math.min(i++, behaviors.length - 1)]!;
      if (b instanceof Error) throw b;
      return b;
    },
    waitForLoadState: async () => undefined,
  } as unknown as Page;
}

const NAVIGATING = new Error(
  "page.content: Unable to retrieve content because the page is navigating and changing the content.",
);

describe("pageContentWithRetry", () => {
  it("retries through the mid-navigation race and returns the DOM (UNIT_CONFIRMED)", async () => {
    const page = fakePage([NAVIGATING, NAVIGATING, "<html>ok</html>"]);
    await expect(pageContentWithRetry(page)).resolves.toBe("<html>ok</html>");
  });

  it("gives up after the bounded attempts with the original error", async () => {
    const page = fakePage([NAVIGATING]);
    await expect(
      pageContentWithRetry(page, { attempts: 3, delayMs: 1 }),
    ).rejects.toThrow(/navigating and changing the content/);
  });

  it("rethrows non-transient errors immediately, no retry", async () => {
    let calls = 0;
    const page = {
      content: async () => {
        calls++;
        throw new Error("Target closed");
      },
      waitForLoadState: async () => undefined,
    } as unknown as Page;
    await expect(pageContentWithRetry(page)).rejects.toThrow(/Target closed/);
    expect(calls).toBe(1);
  });
});
