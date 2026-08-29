import type { Page } from "playwright";

/**
 * page.content() throws while the page is mid-navigation ("Unable to
 * retrieve content because the page is navigating and changing the
 * content") — session 1b93205e lost app 7d6c2811 to exactly that race as a
 * pipeline_error. Reading the DOM a moment later is the correct response;
 * every other error still throws immediately. Bounded: 3 attempts, no
 * unbounded polling.
 */
const TRANSIENT_CONTENT_ERROR =
  /navigating and changing the content|Execution context was destroyed/i;

export async function pageContentWithRetry(
  page: Page,
  opts?: { attempts?: number; delayMs?: number },
): Promise<string> {
  const attempts = Math.max(1, opts?.attempts ?? 3);
  const delayMs = opts?.delayMs ?? 300;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await page.content();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!TRANSIENT_CONTENT_ERROR.test(msg)) throw err;
      lastErr = err;
      if (attempt === attempts) break;
      await page
        .waitForLoadState("domcontentloaded", { timeout: delayMs * 4 })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
