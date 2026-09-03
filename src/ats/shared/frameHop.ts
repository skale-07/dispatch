import type { Page } from "playwright";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { isLoopbackUrl } from "../generic/urlValidation.js";
import { classifyPage } from "./pageClassify.js";

/**
 * Iframe-hosted application forms.
 *
 * `page.content()` NEVER includes iframe content, and the fill path has no
 * frameLocator — so a company page embedding its form in an iframe
 * (Greenhouse embeds, Paycom-style portals) discovered ZERO fields and
 * refused NO_APPLICATION_FORM while a human plainly saw a form.
 *
 * The hop converts the iframe problem into the already-solved page
 * problem: find the child frame whose own document carries fillable
 * fields, and NAVIGATE the page to that frame's URL — embedded ATS forms
 * are standalone pages (a Greenhouse embed is a full page at
 * boards.greenhouse.io). Everything downstream (gate, plan, fill, verify,
 * submit) then runs against a normal top-level document.
 *
 * Read-only: this module only inspects frames; the caller does the goto
 * and re-gates, so every pre-mutation check runs again on the hopped page.
 *
 * Greenhouse company-domain boards load `embed/job_app` in a cross-origin
 * iframe. First paint is often `about:blank` or a document Playwright
 * cannot parse yet — waiting for fillable fields never fires, and submit
 * then treats the outer posting as FORM_NOT_FOUND. A Greenhouse embed URL
 * is hopable even at fieldCount 0; random https iframes are not.
 */
export async function findApplicationFrameUrl(
  page: Page,
): Promise<{ url: string; fieldCount: number } | null> {
  let best: { url: string; fieldCount: number } | null = null;
  let greenhouseEmbed: { url: string; fieldCount: number } | null = null;
  let postingFrame: { url: string; fieldCount: number } | null = null;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const url = frame.url();
    if (!isHopableFrameUrl(url)) continue;
    if (!greenhouseEmbed && isGreenhouseEmbedUrl(url)) {
      greenhouseEmbed = { url, fieldCount: 0 };
    }
    const html = await frame.content().catch(() => null);
    if (!html) continue;
    const fields = discoverFieldsFromHtml(html);
    if (fields.length === 0) {
      // #159 (live internal-careers-rivian.icims.com 2026-09-03): iCIMS
      // serves the POSTING — headline, description and the "Apply for
      // this job online" link — from a same-origin child frame. The top
      // document holds no fields and no Apply CTA (its only "apply" is
      // inside a <script src=".../apply.js">, which classifyPage strips),
      // so three apps parked UNKNOWN_LANDING with the real application
      // never opened. A posting frame carries no fields by definition, so
      // the field test above skipped it.
      //
      // Ranked BELOW any field-bearing frame and below a Greenhouse
      // embed: a form is always the better hop. Same-origin only — the
      // hop is a real navigation, and a cross-origin ad/tracker frame
      // (doubleclick, live philips) must never become the page.
      if (
        !postingFrame &&
        isSameOrigin(url, page.url()) &&
        !isSelfHop(url, page.url()) &&
        classifyPage({ html, url }).page_class === "posting"
      ) {
        postingFrame = { url, fieldCount: 0 };
      }
      continue;
    }
    if (!best || fields.length > best.fieldCount) {
      best = { url, fieldCount: fields.length };
    }
  }
  return best ?? greenhouseEmbed ?? postingFrame;
}

/** A hop must change the document — never re-navigate to where we are. */
function isSelfHop(frameUrl: string, pageUrl: string): boolean {
  const norm = (u: string): string => {
    try {
      const parsed = new URL(u);
      return `${parsed.origin}${decodeURIComponent(parsed.pathname).replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return u;
    }
  };
  return norm(frameUrl) === norm(pageUrl);
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** `/embed` or `/job_app` — not the board posting URL in an iframe. */
export function isGreenhouseEmbedUrl(url: string): boolean {
  return /greenhouse\.io\/(embed\/|job_app\b)/i.test(url);
}

/**
 * Live embeds are https. The operator sandbox is loopback http — the
 * same hop must see `/fillhard/embed` or the outer zero-field page
 * parks as UNKNOWN_LANDING. Arbitrary http frames stay ignored.
 */
function isHopableFrameUrl(url: string): boolean {
  if (!url || url === "about:blank") return false;
  if (url.startsWith("https://")) return true;
  return isLoopbackUrl(url);
}
