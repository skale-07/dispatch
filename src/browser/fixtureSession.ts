import { chromium, type Page } from "playwright";
import { attachDialogGuard } from "./dialogGuard.js";
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
    attachDialogGuard(page.context(), "fixture");
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
  /**
   * When set, open the page as a NEW TAB in the operator's debug Chrome
   * (the same CDP endpoint navigation attaches to) instead of launching a
   * browser. Live 2026-08-30 (Ashby, Quadrillion): even the installed
   * Chrome channel, headed, launched fresh by Playwright was refused as
   * "possible spam" — a profile-less automation-launched browser is what
   * the invisible reCAPTCHA scores, and the operator's real signed-in
   * profile is the project's existing trusted seam. close() closes only
   * the tab we opened and detaches; it never closes the operator's Chrome.
   * Falls back to a launch when the endpoint will not attach.
   */
  cdpUrl?: string;
}): Promise<PublicUrlSession> {
  if (options?.cdpUrl) {
    try {
      const attached = await chromium.connectOverCDP(options.cdpUrl, { timeout: 15_000 });
      const context = attached.contexts()[0] ?? (await attached.newContext());
      const page = await context.newPage();
      // #205: the operator's Chrome — guard while attached, detach on close.
      const detachDialogGuard = attachDialogGuard(context, "public-url");
      let closed = false;
      return {
        page,
        close: async () => {
          if (closed) return;
          closed = true;
          try {
            detachDialogGuard();
          } catch {
            // already-closed context
          }
          await page.close().catch(() => undefined);
          // connectOverCDP: close() only detaches from the operator's browser.
          await attached.close().catch(() => undefined);
        },
      };
    } catch {
      // Endpoint down or wedged — the launched-browser path below still works.
    }
  }
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
  attachDialogGuard(context, "public-url");
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
  options?: {
    headless?: boolean;
    channel?: BrowserChannel;
    cdpUrl?: string;
    /**
     * #212: tried ONCE when the first navigation dies of a transport error
     * (net::ERR_*, ECONNRESET …) — never on an HTTP status or a page that
     * loaded. Callers derive it deterministically (Greenhouse's canonical
     * embed app for a board URL whose redirect the browser cannot follow).
     */
    fallbackUrl?: string | null;
    onFallback?: (note: string) => void;
  },
): Promise<T> {
  const session = await openPublicUrlSession(options);
  try {
    try {
      await session.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const transport = /net::ERR_|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(message);
      if (!transport || !options?.fallbackUrl || options.fallbackUrl === url) throw err;
      options.onFallback?.(
        `navigation to ${url} failed (${message.slice(0, 80)}) — retrying via ${options.fallbackUrl}`,
      );
      await session.page.goto(options.fallbackUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    return await fn(session.page);
  } finally {
    await session.close();
  }
}
