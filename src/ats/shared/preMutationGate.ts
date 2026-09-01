import type { Page } from "playwright";
import { detectBlockingCaptcha } from "../greenhouse/captchaDetection.js";
import { detectLoginWall } from "../greenhouse/loginWallDetection.js";
import { discoverFieldsFromHtml } from "../../applications/fieldDiscovery.js";
import { classifyPage } from "./pageClassify.js";

/**
 * Generic pre-mutation page gate for ATSes without an identity-verification
 * equivalent. DELIBERATELY WEAKER than greenhouse's verifyPageBeforeMutation:
 * Lever/Ashby URLs carry no board-token/job-id pair to cross-check against
 * the rendered page, so this gate can only prove we are on a trusted host,
 * were not redirected off it, are not behind a login wall or blocking
 * CAPTCHA, and that an application form is actually present. The layered
 * defenses above it (flag gates, approved plan, verify-before-click, human
 * confirmation) are unchanged.
 */
/**
 * Same posting path, tolerating what a site's canonical redirect changes
 * without changing the posting: letter CASE of the slug (live Philips
 * 2026-08-30: /na/en/job/PHILUS590567ENNA/graduate-level-co-op-… →
 * …/Graduate-Level-Co-op-…, same job id), percent-encoding, and trailing
 * slashes. A different id or a different slug is still a mismatch — a
 * redirected posting is never filled.
 */
export function samePostingPath(finalPath: string, expectedPath: string): boolean {
  const norm = (p: string): string => {
    let s = p;
    try {
      s = decodeURIComponent(p);
    } catch {
      // keep raw
    }
    return (
      s
        .replace(/\/+$/, "")
        .toLowerCase()
        // #81 (live stryker 2026-08-31): Workday's apply flow keeps the
        // SAME posting while adding a locale segment (/en-US), turning
        // "Portage-Michigan" into "Portage,-Michigan", and appending
        // /apply(/applyManually). Locale prefixes, commas, and the apply
        // suffix are presentation, not identity; the requisition id +
        // slug (compared below) still convict a real mismatch.
        // #113 (live mastercard 2026-08-31): same class, apostrophes —
        // the validated slug says "OFallon-Missouri", the apply flow
        // renders "O'Fallon,-Missouri". Slug punctuation is presentation.
        .replace(/^\/[a-z]{2}[-_][a-z]{2}(?=\/)/, "")
        .replace(/\/apply(\/[a-z]+)?$/, "")
        .replace(/[,'’.]/g, "")
    );
  };
  const a = norm(finalPath);
  const b = norm(expectedPath);
  if (a === b) return true;
  // #129 (live gem 2026-09-01): the STORED slug arrived truncated by one
  // character ("…-developer-productivit" vs the page's "…-productivity")
  // — same /p/<id>- posting id, refused on a storage artifact. When one
  // normalized path is a strict PREFIX of the other and the shorter side
  // is long enough to be a real slug (id + words, ≥30 chars), they are
  // the same posting; different ids still diverge inside the prefix.
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 30 && longer.startsWith(shorter);
}

/**
 * #120 (live bosch 2026-09-01): SmartRecruiters redirects the validated
 * slug URL (/BoschGroup/744000146546699-calibration-…) to its "Easy
 * apply" flow at /oneclick-ui/company/BoschGroup/publication/<uuid> — a
 * path that can never string-match the slug, so the path gate refused a
 * page we navigated to OURSELVES from the validated posting. The rescue
 * is deliberately tight, per the #81 doctrine (the requisition id
 * convicts): same company segment, oneclick shape, AND the validated
 * posting's requisition id (the ≥9-digit slug prefix) present in the
 * rendered page (probe: the id appears in the oneclick HTML alongside
 * the exact title). No req id in the expected slug ⇒ no rescue.
 */
export function oneclickContinuationConvicted(
  finalPath: string,
  expectedPath: string,
  html: string,
): boolean {
  const expSegs = expectedPath.split("/").filter((s) => s.length > 0);
  const company = expSegs[0];
  const slug = expSegs[1] ?? "";
  const reqId = slug.match(/^(\d{9,})/)?.[1];
  if (!company || !reqId) return false;
  const m = finalPath.match(
    /^\/oneclick-ui\/company\/([^/]+)\/publication\/[0-9a-f-]+$/i,
  );
  if (!m || m[1]?.toLowerCase() !== company.toLowerCase()) return false;
  return html.includes(reqId);
}

export type GenericPreMutationGateResult = {
  ok: boolean;
  finalUrl: string;
  html: string;
  title: string;
  failureCode: string | null;
  reason: string | null;
};

/**
 * Poll page content until the marker matches or the deadline passes —
 * SPAs (Ashby) render the form well after domcontentloaded, so a single
 * immediate read would classify every live page as form-less. Bounded:
 * at most timeoutMs / intervalMs reads.
 */
export async function waitForRenderedContent(
  page: Page,
  marker: RegExp,
  timeoutMs = 10_000,
  intervalMs = 500,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let html = await page.content();
  while (!marker.test(html) && Date.now() < deadline) {
    await page.waitForTimeout(intervalMs);
    html = await page.content();
  }
  return html;
}

export async function verifyPageBeforeMutationGeneric(
  page: Page,
  options: {
    isTrustedHost: (url: string) => boolean;
    formMarkers: RegExp;
    /**
     * Validated posting URL. When set, the final pathname must match it —
     * a redirect to a different posting (closed job → board page, another
     * job's form) must not be filled. Weaker than greenhouse's identity
     * gate but preserves the same invariant the URL can carry.
     */
    expectedUrl?: string;
    renderTimeoutMs?: number;
  },
): Promise<GenericPreMutationGateResult> {
  const htmlImmediate = await page.content();
  // A listing page will never grow a <form> if we wait. Burning the SPA
  // render timeout here is what made /portal look like a hang before the
  // run refused NO_APPLICATION_FORM. Skip the wait when the first paint
  // is already a posting; unknown/empty first paints still wait.
  // A form-class page without a <form> tag (Paylocity) also never grows
  // one — waiting the full timeout is a 10s stall on a page we can fill.
  const firstClass = classifyPage({
    html: htmlImmediate,
    url: page.url(),
  }).page_class;
  const html0 =
    firstClass === "posting" || firstClass === "form"
      ? htmlImmediate
      : await waitForRenderedContent(
          page,
          options.formMarkers,
          options.renderTimeoutMs ?? 10_000,
        );
  const finalUrl = page.url();
  const html = html0;
  const title = await page.title().catch(() => "");

  const fail = (
    failureCode: string,
    reason: string,
  ): GenericPreMutationGateResult => ({
    ok: false,
    finalUrl,
    html,
    title,
    failureCode,
    reason,
  });

  if (!options.isTrustedHost(finalUrl)) {
    return fail(
      "UNTRUSTED_FINAL_HOST",
      `navigation ended on an untrusted host: ${finalUrl}`,
    );
  }
  if (options.expectedUrl) {
    try {
      const finalPath = new URL(finalUrl).pathname.replace(/\/+$/, "");
      const expectedPath = new URL(options.expectedUrl).pathname.replace(
        /\/+$/,
        "",
      );
      if (
        !samePostingPath(finalPath, expectedPath) &&
        !oneclickContinuationConvicted(finalPath, expectedPath, html)
      ) {
        return fail(
          "POSTING_MISMATCH",
          `final path ${finalPath} is not the validated posting ${expectedPath} — redirected posting is never filled`,
        );
      }
    } catch {
      return fail("POSTING_MISMATCH", "final URL could not be parsed");
    }
  }
  const loginWall = detectLoginWall({ finalUrl, html, title });
  if (loginWall.detected) {
    return fail("LOGIN_WALL", `login wall detected: ${loginWall.signals.join(",")}`);
  }
  const formDetected = options.formMarkers.test(html);
  const discovered = discoverFieldsFromHtml(html);
  const captcha = detectBlockingCaptcha({
    finalUrl,
    html,
    title,
    formDetected,
    fieldCount: discovered.length,
  });
  if (captcha.detected) {
    return fail(
      "BLOCKING_CAPTCHA",
      `blocking CAPTCHA detected: ${captcha.signals.join(",")}`,
    );
  }
  if (!formDetected && discovered.length === 0) {
    return fail(
      "NO_APPLICATION_FORM",
      "application form markers not found on the final page",
    );
  }
  // Markers are not enough. Live 2026-08-14 (Crowe, first Workday fill): a
  // POSTING page passed this gate because Workday stamps
  // data-automation-id on every page, so the fill "succeeded" with 0 fields
  // planned, 0 filled, and a verify failure that read like a selector bug
  // instead of "this is the job description, not the form". A form you
  // cannot type into is not a form, and a silent 0-field fill is worse than
  // a refusal — it burns an attempt and reports a failure nobody can
  // diagnose. Vendor-blind on purpose: every adapter shares this gate.
  //
  // Paylocity (live 2026-08-19): 32 fields, no wrapping <form> tag. The
  // marker regex is not the form. Field count is.
  if (discovered.length === 0) {
    // #106 (live tiaa, the walk's finish line): a Workday REVIEW page has
    // ZERO inputs by design — its one control is the FINAL submit button.
    // A page carrying that explicit control is the submit destination,
    // not a posting (postings carry adventureButton/continueButton, never
    // bottom-navigation-submit). Tight positive signal; everything else
    // with 0 fields still refuses exactly as before (Crowe posting hole
    // stays closed).
    if (
      /data-automation-id=["'](?:bottom-navigation-submit-button|pageFooterSubmitButton)["']/i.test(
        html,
      ) ||
      // #106b (live tiaa): this tenant REUSES pageFooterNextButton for the
      // Review page's Submit — the id never changes, only the text. A
      // footer button reading exactly "Submit" is the submit destination.
      /<button[^>]*data-automation-id=["']pageFooter\w*["'][^>]*>\s*Submit\s*<\/button>/i.test(
        html,
      )
    ) {
      return { ok: true, finalUrl, html, title, failureCode: null, reason: null };
    }
    return fail(
      "NO_APPLICATION_FORM",
      "form markers matched but the page has no fillable fields — this is a posting/description page, not the application form",
    );
  }
  return { ok: true, finalUrl, html, title, failureCode: null, reason: null };
}
