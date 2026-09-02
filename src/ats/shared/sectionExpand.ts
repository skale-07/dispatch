import type { Page } from "playwright";

/**
 * #143 (live UKG Pro OpportunityApply 2026-09-01): the application is one
 * page of Bootstrap-style collapsible panels — Contact Information, Work
 * Experience, Skills… render collapsed (`div.collapse` display:none), so
 * 13 planned fills timed out "waiting for element to be visible" while a
 * human would simply click each section header first.
 *
 * Vendor-blind expansion pass: click visible collapsed-section toggles
 * (aria-expanded=false controls, data-toggle=collapse headers, panel-title
 * headings that wrap a collapsed chevron). Guarded: never clicks a control
 * whose text names an action (submit/apply/delete/sign out/…), bounded by
 * cap and rounds, and a click that collapses something back is left alone
 * (round 2 only clicks still-collapsed toggles).
 */

const TOGGLE_SELECTOR = [
  '[data-toggle="collapse"]',
  '[data-bs-toggle="collapse"]',
  'button[aria-expanded="false"]',
  '[role="button"][aria-expanded="false"]',
  ".collapsible-panel-title",
].join(", ");

const DANGEROUS_TEXT_RE =
  /\b(submit|apply|delete|remove|withdraw|sign ?out|log ?out|cancel|save|upload|attach|browse|next|continue|back|previous)\b/i;

const CLICK_CAP = 12;

export type SectionExpandResult = {
  clicked: number;
  notes: string[];
};

export async function expandCollapsedSections(
  page: Page,
  options: { settleMs?: number } = {},
): Promise<SectionExpandResult> {
  const settle = options.settleMs ?? 300;
  const notes: string[] = [];
  let clicked = 0;
  for (let round = 0; round < 2 && clicked < CLICK_CAP; round++) {
    const candidates = page.locator(TOGGLE_SELECTOR);
    const n = Math.min(await candidates.count().catch(() => 0), 30);
    let clickedThisRound = 0;
    for (let i = 0; i < n && clicked < CLICK_CAP; i++) {
      const c = candidates.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      // Still collapsed? The toggle itself or a descendant carries
      // aria-expanded; headers without any expansion state are accepted
      // only when they visibly wrap a collapsed chevron.
      const collapsed = await c
        .evaluate(
          (el: {
            getAttribute: (n: string) => string | null;
            querySelector: (
              s: string,
            ) => { getAttribute: (n: string) => string | null } | null;
            parentElement: {
              querySelector: (
                s: string,
              ) => { getAttribute: (n: string) => string | null } | null;
            } | null;
          }) => {
            const own = el.getAttribute("aria-expanded");
            if (own !== null) return own === "false";
            const inner = el.querySelector("[aria-expanded]");
            if (inner) return inner.getAttribute("aria-expanded") === "false";
            // UKG live: the chevron <i aria-expanded> is a SIBLING of the
            // h2.collapsible-panel-title, not a descendant — look one
            // container up before giving up.
            const near = el.parentElement?.querySelector("[aria-expanded]");
            if (near) return near.getAttribute("aria-expanded") === "false";
            return false;
          },
        )
        .catch(() => false);
      if (!collapsed) continue;
      const text = ((await c.innerText().catch(() => "")) ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (DANGEROUS_TEXT_RE.test(text)) {
        notes.push(`section-expand: skipped "${text.slice(0, 40)}" (action-named)`);
        continue;
      }
      const ok = await c
        .click({ timeout: 2_000 })
        .then(() => true, () => false);
      if (!ok) continue;
      clicked += 1;
      clickedThisRound += 1;
      if (text) notes.push(`section-expand: expanded "${text.slice(0, 40)}"`);
      await page.waitForTimeout(settle);
    }
    if (clickedThisRound === 0) break;
  }
  if (clicked > 0) {
    notes.unshift(`section-expand: expanded ${clicked} collapsed section(s)`);
  }
  return { clicked, notes };
}
