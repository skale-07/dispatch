import type { Page } from "playwright";
import {
  historyGroupOf,
  historyKindOfText,
} from "../../applications/fieldNormalization.js";

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
 * #152 (live UKG run 20): the resume-review page carries "Add Experience"
 * / "Add Education" beside rows the resume parse already filled. An Add
 * trigger creates a BLANK history row, and the profile holds one entry of
 * each kind — already on the page — so nothing truthful can complete the
 * new row and the section's own validation then refuses Save. An Add is
 * only useful while its section is EMPTY; read the page for entries of
 * that kind (per-entry Delete/Remove/Edit controls named with an ordinal,
 * or held indexed history controls).
 */
const ADD_TRIGGER_RE = /^add\b/i;

const SECTION_ENTRIES_FN = `(() => {
  const visible = (el) => el.offsetParent !== null;
  const entryNames = [];
  for (const el of Array.from(document.querySelectorAll('button, [role="button"]'))) {
    if (!visible(el)) continue;
    const t = (el.getAttribute('aria-label') || el.textContent || '').replace(/\\s+/g, ' ').trim();
    // A per-entry control: Delete/Remove/Edit naming a 1-based ordinal
    // ("Delete Work Experience 4", "Edit Experience Item 2"). A section
    // pencil ("Edit Contact Information") carries no ordinal.
    if (/^(delete|remove|edit)\\b/i.test(t) && /\\b\\d{1,2}$/.test(t)) entryNames.push(t.slice(0, 60));
  }
  const held = [];
  for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
    if (!visible(el)) continue;
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'hidden' || type === 'file' || type === 'checkbox' || type === 'radio') continue;
    if (String(el.value || '').trim() === '') continue;
    held.push({ id: el.id || '', name: el.getAttribute('name') || '' });
  }
  return { entryNames, held };
})()`;

async function sectionEntryCount(
  page: Page,
  kind: "employment" | "education",
): Promise<number> {
  let scan: { entryNames: string[]; held: Array<{ id: string; name: string }> };
  try {
    scan = (await page.evaluate(SECTION_ENTRIES_FN)) as typeof scan;
  } catch {
    return 0;
  }
  const byEntry = scan.entryNames.filter((n) => historyKindOfText(n) === kind).length;
  const rows = new Set<number>();
  for (const h of scan.held) {
    const group = historyGroupOf({
      ...(h.id ? { inputId: h.id } : {}),
      ...(h.name ? { name: h.name } : {}),
    });
    if (group && group.kind === kind) rows.add(group.index);
  }
  return Math.max(byEntry, rows.size);
}

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
      if (ADD_TRIGGER_RE.test(name)) {
        const kind = historyKindOfText(name);
        const entries = kind ? await sectionEntryCount(page, kind) : 0;
        if (kind && entries > 0) {
          opened.add(name);
          notes.push(
            `section-editor: skipped "${name.slice(0, 44)}" — the ${kind} section already holds ${entries} entry(ies); a new blank row has nothing truthful to fill`,
          );
          continue;
        }
      }
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
    // #152b (live UKG run 20): every closed editor keeps its own hidden
    // Save in the DOM — an unfiltered first() lands on a hidden one and
    // reads "no save control". The visible one is the open editor's.
    const byAttr = page.locator(cfg.save).filter({ visible: true }).first();
    const byName = page
      .getByRole("button", { name: cfg.saveNamePattern })
      .first();
    const target = (await byAttr.isVisible().catch(() => false))
      ? byAttr
      : (await byName.isVisible().catch(() => false))
        ? byName
        : null;
    if (!target) break;
    const handle = await target.elementHandle({ timeout: 1_000 }).catch(() => null);
    const ok = await target
      .click({ timeout: 2_000 })
      .then(() => true, () => false);
    if (!ok) break;
    clicked += 1;
    await page.waitForTimeout(settle);
    // #151: a Save the section's validation REFUSES leaves the very same
    // control on screen — re-clicking it CLICK_CAP times ("saved 12 open
    // editor(s)" on UKG) is noise. A successful save closes its editor,
    // so the next round's Save belongs to a different editor.
    const sameStillVisible = handle
      ? await handle.isVisible().catch(() => false)
      : false;
    if (sameStillVisible) {
      notes.push("section-editor: save control still on screen after the click — the section refused it");
      break;
    }
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
