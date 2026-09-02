import type { Page } from "playwright";
import { performTransition } from "../browser/transition.js";
import { discoverFieldsFromHtml } from "./fieldDiscovery.js";
import { genericSelectorsV1 } from "../ats/generic/selectors.js";
import {
  resolveAdvanceControl,
  resolveSubmitControl,
} from "../ats/shared/submitControl.js";
import { classifyPage } from "../ats/shared/pageClassify.js";
import { readPageValidationErrors } from "./pageErrors.js";
import {
  expandCollapsedSections,
  openSectionEditors,
  saveOpenSectionEditors,
} from "../ats/shared/sectionExpand.js";

/**
 * Generic multi-page forms (Paycom lead-capture "Continue to application",
 * iframe wizards whose Next is type=button). Workday has its own walker;
 * this is the same idea for the generic adapter.
 *
 * After the landing page is filled, if the only CTA is Next/Continue (the
 * submit cascade correctly refuses those names), click it, re-plan, fill.
 * NEVER clicks a control `resolveSubmitControl` would accept — `--submit`
 * owns that. Bounded. Stops on unchanged page, confirmation, or empty form.
 */

export type GenericAdvancePageResult = {
  page: number;
  url: string;
  kind: string;
  fillable: number;
  filled: number;
  verify_passed: boolean;
};

export type GenericAdvanceWalkResult = {
  /** The page the flow should continue on (a popup, if Continue opened one). */
  page: Page;
  pages: GenericAdvancePageResult[];
  verifyFailed: boolean;
  notes: string[];
};

/** Extra pages beyond the landing page. */
export const GENERIC_ADVANCE_PAGE_CAP = 3;

/**
 * #142: the landed page's HTML once its field count stops growing — a
 * hydrating SPA mounts sections over several seconds and an early capture
 * plans a fraction of the form. One stable interval ends the wait; the
 * settle budget bounds it (settleMs 0 ⇒ single fresh read).
 */
async function settledFormHtml(page: Page, timeoutMs: number): Promise<string> {
  let html = await page.content();
  let count = discoverFieldsFromHtml(html).length;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(700);
    const next = await page.content();
    const nextCount = discoverFieldsFromHtml(next).length;
    if (nextCount === count) return next;
    html = next;
    count = nextCount;
  }
  return html;
}

/** Section editors per page — UKG has 8; a runaway Add loop must stop. */
export const SECTION_EDITOR_CAP = 8;

/**
 * #145c (live UKG OpportunityApply, runs 15-16): the application is ONE
 * page of section EDITORS, strictly one open at a time (other pencils are
 * disabled while an editor is open). Cycle: open the next unopened
 * "Edit <Section>"/"Add <Thing>" editor → re-plan+fill the now-visible
 * controls (same closure the page walk uses) → Save (the section commit —
 * never the application submit) → repeat. Bounded, dedupes by accessible
 * name so an Add that re-renders cannot loop.
 */
export async function walkSectionEditors(
  page: Page,
  fillCurrentPage: (input: {
    page: Page;
    html: string;
    url: string;
  }) => Promise<{ fillable: number; filled: number; verifyPassed: boolean }>,
  cfg: {
    trigger: string;
    triggerNamePattern: RegExp;
    save: string;
    saveNamePattern: RegExp;
  },
  options: { settleMs?: number } = {},
): Promise<{ editors: number; notes: string[] }> {
  const notes: string[] = [];
  const settleTimeoutMs =
    options.settleMs === 0 ? 0 : (options.settleMs ?? 8_000);
  const alreadyOpened = new Set<string>();
  let editors = 0;
  for (let i = 0; i < SECTION_EDITOR_CAP; i++) {
    const opened = await openSectionEditors(page, cfg, {
      maxOpens: 1,
      alreadyOpened,
      settleMs: options.settleMs === 0 ? 0 : 500,
    }).catch(() => null);
    if (!opened || opened.clicked === 0) break;
    editors += 1;
    notes.push(...opened.notes);
    const html = await settledFormHtml(page, settleTimeoutMs).catch(() =>
      page.content(),
    );
    const result = await fillCurrentPage({
      page,
      html: await Promise.resolve(html),
      url: page.url(),
    });
    notes.push(
      `section-editor: filled ${result.filled}/${result.fillable} (verify ${result.verifyPassed ? "passed" : "failed"})`,
    );
    const saved = await saveOpenSectionEditors(page, cfg, {
      settleMs: options.settleMs === 0 ? 0 : 600,
    }).catch(() => null);
    if (saved && saved.clicked > 0) notes.push(...saved.notes);
    else notes.push("section-editor: no save control found after fill — editor left open");
    // A Save the section's own validation refuses leaves the editor open
    // — and every other pencil disabled, the page submit blocked. Record
    // the page's reason and release the editor via its Cancel so the walk
    // (and the submit path) can continue; the section keeps its previous
    // saved state, nothing is invented.
    const stillOpen = await page
      .locator(cfg.save)
      .first()
      .isVisible()
      .catch(() => false);
    if (stillOpen) {
      const pageErrors = await readPageValidationErrors(page).catch(() => []);
      notes.push(
        `section-editor: save did not close the editor${
          pageErrors.length > 0 ? ` — page says: ${pageErrors.slice(0, 3).join("; ")}` : ""
        }`,
      );
      const cancel = page.getByRole("button", { name: /^cancel$/i }).first();
      const released = await cancel
        .click({ timeout: 2_000 })
        .then(() => true, () => false);
      notes.push(
        released
          ? "section-editor: released the stuck editor via Cancel"
          : "section-editor: no Cancel control — editor left open",
      );
      if (released && options.settleMs !== 0) await page.waitForTimeout(500);
    }
  }
  if (editors > 0) {
    notes.unshift(`section-editor walk: cycled ${editors} editor(s)`);
  }
  return { editors, notes };
}

export async function walkGenericFormPages(
  page: Page,
  fillCurrentPage: (input: {
    page: Page;
    html: string;
    url: string;
  }) => Promise<{ fillable: number; filled: number; verifyPassed: boolean }>,
  options: { settleMs?: number } = {},
): Promise<GenericAdvanceWalkResult> {
  const notes: string[] = [];
  const pages: GenericAdvancePageResult[] = [];
  let verifyFailed = false;
  let current = page;
  const settleTimeoutMs =
    options.settleMs === 0 ? 0 : (options.settleMs ?? 10_000);

  for (let extra = 1; extra <= GENERIC_ADVANCE_PAGE_CAP; extra++) {
    const submit = await resolveSubmitControl(
      current,
      genericSelectorsV1.submitCascade,
    );
    if (submit.found) {
      notes.push(
        `form-advance: visible submit after page ${extra} — leaving it for the gated submit path`,
      );
      break;
    }

    const advance = await resolveAdvanceControl(
      current,
      genericSelectorsV1.submitCascade,
    );
    if (!advance.found) {
      notes.push(
        `form-advance: no Next/Continue after page ${extra} — stopping`,
      );
      break;
    }

    const transition = await performTransition(current, advance.control, {
      settleTimeoutMs,
      sweepObstructions: true,
    });
    notes.push(...advance.notes);
    notes.push(...transition.notes.map((n) => `form-advance: ${n}`));
    if (!transition.landed) {
      notes.push(
        `form-advance: page unchanged after Continue/Next on page ${extra} — stopping`,
      );
      break;
    }
    current = transition.page;
    if (transition.adopted_popup) {
      notes.push(
        "form-advance: click opened a tab — continuing on the adopted page",
      );
    }

    // #143: expand collapsed sections BEFORE the settle-and-plan — the
    // landed page's fields include everything behind accordion headers,
    // and the #142 stability poll below then waits for what expansion
    // mounts.
    const expand = await expandCollapsedSections(current).catch(() => null);
    if (expand && expand.clicked > 0) notes.push(...expand.notes);

    // #142 (live UKG OpportunityApply 2026-09-01, same class as #138):
    // transition.html is captured at the FIRST DOM change — the landed
    // SPA renders its sections seconds later, so page 2's plan saw only
    // the two early-mounted name fields while required Job Title/Skills
    // questions were still mounting. A bare form marker matches the early
    // paint too; poll until the DISCOVERED FIELD COUNT is stable across
    // one interval (bounded by the settle budget) and plan from that.
    const html = await settledFormHtml(current, settleTimeoutMs).catch(
      () => transition.html,
    );
    const classification = classifyPage({
      html,
      url: current.url(),
    });
    if (classification.page_class === "confirmation") {
      notes.push(
        "form-advance: landed on a confirmation — no further pages to fill",
      );
      break;
    }
    if (discoverFieldsFromHtml(html).length === 0) {
      notes.push(
        `form-advance: page ${extra + 1} has no fillable fields — stopping`,
      );
      break;
    }

    const result = await fillCurrentPage({
      page: current,
      html,
      url: current.url(),
    });
    pages.push({
      page: extra + 1,
      url: current.url(),
      kind: classification.page_class,
      fillable: result.fillable,
      filled: result.filled,
      verify_passed: result.verifyPassed,
    });
    if (!result.verifyPassed) {
      verifyFailed = true;
      notes.push(
        `form-advance: verify failed on page ${extra + 1} — not advancing further`,
      );
      break;
    }
  }

  if (pages.length > 0) {
    notes.push(
      `form-advance: filled ${pages.length} additional page(s) — ${pages
        .map((p) => `${p.kind}:${p.filled}/${p.fillable}`)
        .join(", ")}`,
    );
  }
  return { page: current, pages, verifyFailed, notes };
}
