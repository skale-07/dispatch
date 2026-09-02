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

/**
 * #145: open every section EDITOR before planning (UKG Pro live
 * 2026-09-01: sections are read-only displays until their "Edit <Section>"
 * / "Add <Thing>" button mounts the real controls; probe showed editors
 * coexist, each with its own Save). Vendor-blind guard: the trigger must
 * be visible, enabled, and accessible-named Edit/Add — never Delete/
 * Remove (an "Add" that mutates data is only reachable through the fill's
 * own gated execution path, same as any typing).
 */
export async function openSectionEditors(
  page: Page,
  cfg: {
    trigger: string;
    triggerNamePattern: RegExp;
  },
  options: {
    settleMs?: number;
    /**
     * #145c (live UKG run 16): sections are strictly ONE-editor-at-a-time
     * — while an editor is open every other pencil is disabled (Knockout
     * `enable:` binding), so a blanket open pass can only ever open the
     * first. Callers loop open → fill → save instead; maxOpens=1 with the
     * caller's own `alreadyOpened` name set drives that cycle.
     */
    maxOpens?: number;
    alreadyOpened?: Set<string>;
  } = {},
): Promise<SectionExpandResult> {
  const settle = options.settleMs ?? 500;
  const maxOpens = options.maxOpens ?? CLICK_CAP;
  const opened = options.alreadyOpened ?? new Set<string>();
  const notes: string[] = [];
  let clicked = 0;
  for (let round = 0; round < CLICK_CAP && clicked < maxOpens; round++) {
    const candidates = page.locator(cfg.trigger);
    const n = Math.min(await candidates.count().catch(() => 0), 16);
    let clickedThisRound = false;
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      if (await c.isDisabled().catch(() => false)) continue;
      const name =
        ((await c.getAttribute("aria-label").catch(() => null)) ??
          (await c.innerText().catch(() => "")) ??
          "")
          .replace(/\s+/g, " ")
          .trim();
      if (!cfg.triggerNamePattern.test(name)) continue;
      if (opened.has(name)) continue;
      const ok = await c.click({ timeout: 2_000 }).then(() => true, () => false);
      if (!ok) continue;
      opened.add(name);
      clicked += 1;
      clickedThisRound = true;
      notes.push(`section-editor: opened "${name.slice(0, 44)}"`);
      await page.waitForTimeout(settle);
      break; // re-query — the DOM just changed
    }
    if (!clickedThisRound) break;
  }
  return { clicked, notes };
}

/**
 * #145: commit every open section editor after fill+verify. Save is a
 * SECTION commit (persists the profile data the fill just typed), not the
 * application submit — the gated submit path still owns btn-submit.
 */
export async function saveOpenSectionEditors(
  page: Page,
  cfg: { save: string; saveNamePattern: RegExp },
  options: { settleMs?: number } = {},
): Promise<SectionExpandResult> {
  const settle = options.settleMs ?? 600;
  const notes: string[] = [];
  let clicked = 0;
  // Saves collapse their editor and re-render — re-query each round.
  for (let round = 0; round < CLICK_CAP; round++) {
    const byAttr = page.locator(cfg.save).first();
    const byName = page
      .getByRole("button", { name: cfg.saveNamePattern })
      .first();
    const target = (await byAttr.isVisible().catch(() => false))
      ? byAttr
      : (await byName.isVisible().catch(() => false))
        ? byName
        : null;
    if (!target) break;
    const ok = await target
      .click({ timeout: 2_000 })
      .then(() => true, () => false);
    if (!ok) break;
    clicked += 1;
    await page.waitForTimeout(settle);
  }
  if (clicked > 0) {
    notes.push(`section-editor: saved ${clicked} open editor(s)`);
  }
  return { clicked, notes };
}

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
