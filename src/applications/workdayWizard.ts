import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { getConfig } from "../config/index.js";
import { workdaySelectorsV1 } from "../ats/workday/selectors.js";
import { classifyWorkdayPage } from "../ats/workday/pageKind.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import { scanRequiredCompleteness } from "../ats/shared/requiredCompleteness.js";
import { performTransition } from "../browser/transition.js";
import { recordTransitionOutcome } from "../storage/transitionOutcomes.js";

/**
 * Workday multi-page wizard walk (Crowe live 2026-08-14: a 7-step wizard
 * got only its landing page filled; every later page's required questions
 * were never even seen, so submit refused on "unanswered questions").
 *
 * The walk clicks Next through the shared transition primitive (bounded
 * change-detection, obstruction retry, popup adoption) and hands each new
 * page to the caller's filler. It NEVER clicks the submit button — the
 * gated submit path owns that click.
 *
 * Two diagnoses replace silent stops:
 *   - Next DISABLED → the required-completeness scan names the exact
 *     fields blocking it ("blocked by: Phone Device Type, Country").
 *   - Landing on an auth wall mid-walk (session expired between pages) →
 *     the caller's onAuthWall seam may sign back in ONCE; the walk then
 *     resumes instead of stopping.
 */
export type WizardPageResult = {
  page: number;
  url: string;
  kind: string;
  fillable: number;
  filled: number;
  verify_passed: boolean;
};

export type WizardWalkResult = {
  pages: WizardPageResult[];
  /** True when any walked page failed its verify (demotes the run level). */
  verifyFailed: boolean;
  notes: string[];
};

const NEXT_NAME_RE = /^(next|save and continue|continue)$/i;
/**
 * Additional pages beyond the landing page — hard cap, never unbounded.
 * 8, not 5 (#99, live tiaa): a 7-step wizard (My Information … Review)
 * needs 6 clean Nexts to reach Review — the submit button lives ONLY
 * there, and the 5-page cap made "workday final submit control not
 * found" structural. The loop still self-terminates at Review ("no Next
 * control") and on errors, so the cap is head-room, not a target.
 */
export const WIZARD_PAGE_CAP = 8;

/**
 * #278: how many consecutive non-advancing Next clicks the walk tolerates
 * before stopping. Two — the first can be a slow SPA swap the next pass rides
 * out; a second identical page is the page saying it will not move.
 */
export const MAX_NO_PROGRESS_PAGES = 2;

export async function walkWorkdayWizard(
  page: Page,
  fillCurrentPage: (input: {
    html: string;
    url: string;
  }) => Promise<{ fillable: number; filled: number; verifyPassed: boolean }>,
  options: {
    settleMs?: number;
    /**
     * Mid-walk auth recovery (used at most once): return true when the
     * wall was cleared and the walk may resume. Absent ⇒ auth stops the
     * walk, as before.
     */
    onAuthWall?: (page: Page) => Promise<boolean>;
    applicationId?: string | null;
  } = {},
): Promise<WizardWalkResult> {
  const notes: string[] = [];
  const pages: WizardPageResult[] = [];
  let verifyFailed = false;
  let authRecoveryUsed = false;
  /** #278: consecutive Next clicks that did not reach a different page. */
  let noProgressPages = 0;
  const settleTimeoutMs = options.settleMs === 0 ? 0 : (options.settleMs ?? 10_000);

  for (let extra = 1; extra <= WIZARD_PAGE_CAP; extra++) {
    const bySelector = page.locator(workdaySelectorsV1.wizard.nextButton).first();
    const next =
      (await bySelector.count().catch(() => 0)) > 0 &&
      (await bySelector.isVisible().catch(() => false))
        ? bySelector
        : page.getByRole("button", { name: NEXT_NAME_RE }).first();
    if (
      (await next.count().catch(() => 0)) === 0 ||
      !(await next.isVisible().catch(() => false))
    ) {
      notes.push(`wizard: no Next control after page ${extra} — review/summary reached`);
      break;
    }

    // Workday DISABLES Next while required fields are empty. Clicking a
    // disabled button "fails" as an unchanged page — diagnose it up front
    // and name the blockers instead.
    const nextDisabled =
      (await next.isDisabled().catch(() => false)) ||
      (await next.getAttribute("aria-disabled").catch(() => null)) === "true";
    if (nextDisabled) {
      const scan = await scanRequiredCompleteness(page).catch(() => null);
      const blockers =
        scan?.unanswered.map((u) => u.label).filter(Boolean).slice(0, 8) ?? [];
      notes.push(
        blockers.length > 0
          ? `wizard: Next disabled on page ${extra} — blocked by: ${blockers.join(", ")}`
          : `wizard: Next disabled on page ${extra} — no unanswered required fields found (control-level block)`,
      );
      verifyFailed = true;
      break;
    }

    // #74 (live #22w/#22x): fingerprint THIS page's fields before Next —
    // the transition's readyMarker matches any Workday chrome, so its
    // html snapshot can be the OLD page and every per-page plan was one
    // page stale. Fingerprint by LABELS, not ids: Workday regenerates
    // its random ids on every re-render (#63b), which made the first
    // id-based poll break instantly on the SAME page.
    const headingOf = (h: string): string =>
      (h.match(/<h[123]\b[^>]*>([\s\S]{1,200}?)<\/h[123]>/i)?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    const fieldPrint = (h: string): string =>
      headingOf(h) +
      "::" +
      discoverFieldsFromHtml(h)
        .map((f) => f.label)
        .sort()
        .join("|");
    const beforeContent = await page.content().catch(() => "");
    const beforePrint = fieldPrint(beforeContent);
    const beforeHeading = headingOf(beforeContent);
    const transition = await performTransition(page, next, {
      settleTimeoutMs,
      readyMarker: workdaySelectorsV1.formMarkers,
      // The caller is already inside the fill mutation gate.
      sweepObstructions: true,
    });
    notes.push(...transition.notes.map((n) => `wizard: ${n}`));
    recordTransitionOutcome({
      seam: "workday_wizard_next",
      host: safeHost(page.url()),
      result: transition,
      applicationId: options.applicationId ?? null,
    });
    if (transition.adopted_popup) {
      // Workday never legitimately continues its wizard in a new tab.
      notes.push("wizard: click opened a tab — not a wizard page, stopping the walk");
      break;
    }
    if (!transition.landed) {
      notes.push(`wizard: page unchanged after Next on page ${extra} — stopping the walk`);
      break;
    }

    let html = transition.html;
    /**
     * #278: did Next actually reach a DIFFERENT page? Only meaningful on a
     * live walk (settleTimeoutMs 0 skips the poll entirely, and fixtures must
     * keep walking on the transition snapshot).
     */
    let advancedThisPage = settleTimeoutMs === 0;
    // #74: poll for the NEW page's DOM — done when the field set differs
    // from the page we just filled (bounded by settleTimeoutMs; tests at
    // settleMs 0 stay synchronous on the transition snapshot).
    if (settleTimeoutMs > 0) {
      // #74c (live #22y): a single differing read can be TRANSITIONAL
      // flap (open popups, error banners, half-rendered swaps) — the
      // poll accepted page-1 content while the SPA hadn't swapped, and
      // later a mid-transition blank ("no fillable fields"). Done only
      // when two consecutive reads AGREE with each other AND differ
      // from the pre-Next print; deadline falls back to the last read.
      const deadline = Date.now() + settleTimeoutMs;
      let prevPrint: string | null = null;
      for (;;) {
        const fresh = await page.content().catch(() => "");
        const print = fresh ? fieldPrint(fresh) : "";
        // #74d (live #22z): beforePrint can be POLLUTED (popup open,
        // banner) right after the fill, making settled page-1 reads
        // "differ" and the poll accept the old page. When the pre-Next
        // page had a heading, the NEW page's heading must actually
        // CHANGE ("My Information" → "My Experience"); the print diff
        // is the fallback for headingless pages.
        const headingNow = fresh ? headingOf(fresh) : "";
        const advanced = beforeHeading
          ? headingNow !== "" && headingNow !== beforeHeading
          : print !== beforePrint;
        if (print && print === prevPrint && advanced) {
          html = fresh;
          advancedThisPage = true;
          break;
        }
        if (Date.now() >= deadline) {
          html = fresh || html;
          notes.push(
            `wizard: page ${extra + 1} never settled on a NEW page (heading still "${headingNow || "?"}") — planning on the current DOM`,
          );
          break;
        }
        prevPrint = print;
        await page.waitForTimeout(600);
      }
    }
    // #76 instrumentation: three runs of note-reading contradicted each
    // other — pixels arbitrate. One screenshot per walked page, heading
    // + url in the note.
    if (settleTimeoutMs > 0) {
      try {
        const dir = path.join(getConfig().artifactsDir, "ats-fill", "workday-live");
        fs.mkdirSync(dir, { recursive: true });
        const shot = path.join(dir, `wizard-page-${extra + 1}-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => undefined);
        notes.push(
          `wizard: page ${extra + 1} heading="${headingOf(html).slice(0, 40)}" url…${page.url().slice(-25)} shot=${path.basename(shot)}`,
        );
      } catch {
        // instrumentation must never break the walk
      }
    }
    // #278 (live Merck msd.wd5 2026-09-12, app 07fa81a1): Workday answers a
    // Next it will not honour by RE-RENDERING the same page with a field-level
    // error — so `transition.landed` is true, Next is not disabled, and the
    // existing error-banner guard missed the phrasing ("Error: The field How
    // Did You Hear About Us? is required and must have a value."). The walk
    // therefore re-planned and re-filled the IDENTICAL page eight times
    // (pages 2-9, all 14 fillable / 11 filled, same heading, same URL),
    // burning ~12 minutes of a 300s-deadline cycle before giving up.
    //
    // A cap on no-progress iterations is the phrasing-independent guard (house
    // rule: attempt caps on every retry loop). Two tries, because the first
    // non-advance can be a genuine slow SPA swap that the next pass rides out;
    // a second identical page is the page telling us it will not move.
    if (!advancedThisPage) {
      noProgressPages += 1;
      if (noProgressPages >= MAX_NO_PROGRESS_PAGES) {
        notes.push(
          `wizard: page ${extra + 1} did not advance ${noProgressPages}x in a row ` +
            `(heading "${headingOf(html).slice(0, 40)}") — stopping the walk; ` +
            `the page is refusing Next, so its unanswered fields park for review (#278)`,
        );
        verifyFailed = true;
        break;
      }
    } else {
      noProgressPages = 0;
    }
    if (
      /data-automation-id=["']errorBanner|please fix the errors|required information is missing/i.test(
        html,
      )
    ) {
      notes.push(
        `wizard: Workday flagged errors on page ${extra} — stopping the walk (fields park for review)`,
      );
      verifyFailed = true;
      break;
    }

    let kind = classifyWorkdayPage(html);
    if (kind === "auth") {
      // Session expired between pages. One recovery, then resume.
      if (options.onAuthWall && !authRecoveryUsed) {
        authRecoveryUsed = true;
        notes.push("wizard: auth wall mid-walk — attempting portal sign-in");
        const cleared = await options.onAuthWall(page).catch(() => false);
        if (!cleared) {
          notes.push("wizard: auth wall not cleared — stopping the walk");
          verifyFailed = true;
          break;
        }
        html = await page.content().catch(() => "");
        kind = classifyWorkdayPage(html);
        notes.push(`wizard: signed back in — page kind now ${kind}`);
        if (kind === "auth") {
          verifyFailed = true;
          break;
        }
      } else {
        notes.push("wizard: auth wall mid-walk — stopping the walk");
        verifyFailed = true;
        break;
      }
    }

    if (discoverFieldsFromHtml(html).length === 0) {
      notes.push(`wizard page ${extra + 1} (${kind}): no fillable fields — stopping the walk`);
      break;
    }
    const result = await fillCurrentPage({ html, url: page.url() });
    pages.push({
      page: extra + 1,
      url: page.url(),
      kind,
      fillable: result.fillable,
      filled: result.filled,
      verify_passed: result.verifyPassed,
    });
    if (!result.verifyPassed) verifyFailed = true;
  }
  if (pages.length > 0) {
    notes.push(
      `wizard: filled ${pages.length} additional page(s) — ${pages
        .map((p) => `${p.kind}:${p.filled}/${p.fillable}`)
        .join(", ")}`,
    );
  }
  return { pages, verifyFailed, notes };
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
