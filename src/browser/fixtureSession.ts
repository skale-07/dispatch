import { chromium, type Page } from "playwright";
import { browserLaunchOptions, type BrowserChannel } from "./launchOptions.js";

/**
 * Headless Chromium for offline HTML fixtures via page.setContent.
 * Does NOT load JobRight auth, storage state, or persistent profiles.
 *
 * This is the only allowlisted fixture launcher besides PlaywrightServiceSession
 * and loginFlow (which are auth/session paths).
 */
export async function withFixtureHtmlPage<T>(
  html: string,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.launch(
    browserLaunchOptions({ headless: true, channel: "chromium", slowMoMs: 0 }),
  );
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export type PublicUrlSession = {
  page: Page;
  close: () => Promise<void>;
};

/**
 * Caller-owned public Chromium (no JobRight/LinkedIn storage). Pipeline
 * `--submit` holds this across fill → click so a verified form is not
 * thrown away for a cold re-fill. Caller MUST close.
 */
export async function openPublicUrlSession(options?: {
  headless?: boolean;
  /**
   * Browser binary. Default stays the bundled Chromium (offline tests,
   * read-only inspection). LIVE fill/submit callers pass the operator's
   * BROWSER_CHANNEL: live 2026-08-30 Ashby's invisible reCAPTCHA scored the
   * headless bundled Chromium as a bot and refused the submission as
   * "possible spam" — a real installed Chrome, headed, is a supported
   * browser, not stealth.
   */
  channel?: BrowserChannel;
}): Promise<PublicUrlSession> {
  const browser = await chromium.launch(
    browserLaunchOptions({
      headless: options?.headless ?? true,
      channel: options?.channel ?? "chromium",
      slowMoMs: 0,
    }),
  );
  const context = await browser.newContext({
    acceptDownloads: false,
  });
  const page = await context.newPage();
  let closed = false;
  return {
    page,
    close: async () => {
      if (closed) return;
      closed = true;
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Ephemeral Chromium context for public ATS pages (no JobRight/LinkedIn storage).
 * Used for Greenhouse read-only live inspection.
 */
export async function withPublicUrlPage<T>(
  url: string,
  fn: (page: Page) => Promise<T>,
  options?: { headless?: boolean; channel?: BrowserChannel },
): Promise<T> {
  const session = await openPublicUrlSession(options);
  try {
    await session.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    return await fn(session.page);
  } finally {
    await session.close();
  }
}
