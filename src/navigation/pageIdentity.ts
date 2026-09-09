import { PlaywrightServiceSession } from "../auth/serviceSession.js";
import { pageNamesCompany } from "./congruence.js";
import { probeCdpEndpoint } from "./runNavigation.js";

/**
 * #197 (live Daylit 2026-09-08): page-level employer identity, read-only.
 *
 * The fill gate refuses a stored URL whose slug names a different company
 * — the wrong-employer defense. But a slug is a label the ATS assigned
 * once: jobs.polymer.co/lendica/41094 is titled "… at Daylit (Formerly
 * Lendica)" and is Daylit's live form. Before refusing on a URL-only
 * mismatch, read the page itself: title, headings, and the first few KB
 * of visible text. A page that names the company clears the gate with the
 * evidence recorded; a page that does not still parks. One page load,
 * no mutation, in the operator's CDP Chrome when it is up (Cloudflare
 * interstitials clear there; a cold headless browser rarely gets past).
 */

export type PageIdentityRead = { title: string; text: string; final_url: string };

export type EmployerPageIdentity = {
  named: boolean;
  hit: string | null;
  title: string | null;
  final_url: string | null;
  error: string | null;
};

const INTERSTITIAL_TITLE_RE = /just a moment|attention required|verify you are human|checking your browser/i;
const INTERSTITIAL_WAIT_MS = 10_000;
const TEXT_CAP = 6_000;

async function readPageWithSession(input: {
  url: string;
  cdpUrl: string;
  headless: boolean;
}): Promise<PageIdentityRead> {
  const useCdp = await probeCdpEndpoint(input.cdpUrl);
  const session = new PlaywrightServiceSession({
    service: "jobright",
    ...(useCdp ? { mode: "CDP_ATTACH" as const } : {}),
    headless: useCdp ? true : input.headless,
  });
  await session.open();
  try {
    const page = await session.newPage({ purpose: "employer_identity" });
    try {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const deadline = Date.now() + INTERSTITIAL_WAIT_MS;
      let title = await page.title().catch(() => "");
      while (INTERSTITIAL_TITLE_RE.test(title) && Date.now() < deadline) {
        await page.waitForTimeout(1_000);
        title = await page.title().catch(() => "");
      }
      await page.waitForTimeout(1_500);
      title = await page.title().catch(() => title);
      const headings = await page
        .locator("h1, h2, [role='heading']")
        .allInnerTexts()
        .catch(() => [] as string[]);
      const body = await page
        .evaluate<string>("document.body ? document.body.innerText : ''")
        .catch(() => "");
      return {
        title,
        text: `${headings.join(" ")} ${body}`.slice(0, TEXT_CAP),
        final_url: page.url(),
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Does the page at `url` name `company`? Never throws; errors are reported as not named. */
export async function confirmEmployerOnPage(input: {
  url: string;
  company: string;
  cdpUrl: string;
  headless?: boolean;
  /** Test seam: supply the page read instead of opening a browser. */
  readPage?: (url: string) => Promise<PageIdentityRead>;
}): Promise<EmployerPageIdentity> {
  try {
    const read = input.readPage
      ? await input.readPage(input.url)
      : await readPageWithSession({
          url: input.url,
          cdpUrl: input.cdpUrl,
          headless: input.headless ?? true,
        });
    if (INTERSTITIAL_TITLE_RE.test(read.title)) {
      return {
        named: false,
        hit: null,
        title: read.title,
        final_url: read.final_url,
        error: "page stayed on a bot-check interstitial",
      };
    }
    const verdict = pageNamesCompany(input.company, `${read.title} ${read.text}`);
    return { ...verdict, title: read.title, final_url: read.final_url, error: null };
  } catch (err) {
    return {
      named: false,
      hit: null,
      title: null,
      final_url: null,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  }
}
