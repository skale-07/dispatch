import type { Page } from "playwright";
import {
  structuredEducationHistory,
  structuredEmploymentHistory,
  type PublicProfile,
} from "../../candidate/publicProfile.js";

/**
 * Workday "My Experience": Work Experience / Education sections that start
 * EMPTY show only an "Add" button (live rb.wd5 2026-09-14, app 02302b66 —
 * the page planned zero fields and the walk stopped at "no fillable
 * fields"); PIMCO wd1 rendered one blank row per section up front. Row
 * controls only exist after Add, so this opens ONE row per empty section
 * BEFORE the page is planned, and only when the profile has a structured
 * entry to put in it (operator directive 2026-09-14). Sections that
 * already hold a row are left alone (#152: a blank extra row has nothing
 * truthful to fill); "Add Another" is never clicked.
 *
 * Workday's shape: `<div role="group" aria-labelledby="Work-Experience-
 * section">` wrapping `[data-automation-id="add-button"]`; the row inputs
 * carry `workExperience-N--*` / `education-N--*` ids once mounted.
 */
export type ExperienceSectionsResult = { clicked: number; notes: string[] };

const SECTIONS: ReadonlyArray<{
  kind: "employment" | "education";
  heading: RegExp;
  rowInput: string;
}> = [
  { kind: "employment", heading: /work[\s-]*experience|employment/i, rowInput: "[id^='workExperience-']" },
  { kind: "education", heading: /^education/i, rowInput: "[id^='education-']" },
];

export async function openWorkdayHistoryRows(
  page: Page,
  profile: PublicProfile,
  options: { settleMs?: number } = {},
): Promise<ExperienceSectionsResult> {
  const settle = options.settleMs ?? 800;
  const notes: string[] = [];
  let clicked = 0;
  const available = {
    employment: structuredEmploymentHistory(profile).length,
    education: structuredEducationHistory(profile).length,
  };
  const groups = page.locator("[role='group'][aria-labelledby]");
  const n = Math.min(await groups.count().catch(() => 0), 12);
  for (let i = 0; i < n; i++) {
    const group = groups.nth(i);
    const labelledBy = (await group.getAttribute("aria-labelledby").catch(() => null)) ?? "";
    const headingText = labelledBy
      ? ((await page.locator(`[id="${labelledBy.replace(/"/g, '\\"')}"]`).first().textContent().catch(() => null)) ?? labelledBy)
      : "";
    const section = SECTIONS.find((s) => s.heading.test(headingText.trim()) || s.heading.test(labelledBy.replace(/-/g, " ")));
    if (!section) continue;
    const wanted = available[section.kind];
    const rowsPresent = async (): Promise<number> => countRows(group, section.rowInput);
    let rows = await rowsPresent();
    if (wanted === 0) {
      if (rows === 0) {
        notes.push(`experience sections: ${section.kind} section is empty and the profile has no structured ${section.kind} entry — left empty`);
      }
      continue;
    }
    if (rows >= wanted) {
      notes.push(`experience sections: ${section.kind} shows ${rows} row(s) for ${wanted} structured entr${wanted === 1 ? "y" : "ies"} — nothing to add`);
      continue;
    }
    // Operator directive 2026-09-14: "usually you have to click 'Add
    // Another'". One row per structured entry: "Add" mounts the first row
    // of an empty section, "Add Another" each further one. Bounded by the
    // entry count and a hard cap; every click is read back as a row count.
    for (let guard = 0; rows < wanted && guard < MAX_ROWS_PER_SECTION; guard++) {
      const wantAnother = rows > 0;
      const add = group
        .locator("[data-automation-id='add-button'], button")
        .filter({ hasText: wantAnother ? /^\s*add\s+another\s*$/i : /^\s*add\s*$/i })
        .last();
      if (!(await add.isVisible().catch(() => false))) {
        notes.push(
          `experience sections: ${section.kind} section has no "${wantAnother ? "Add Another" : "Add"}" control (rows ${rows} of ${wanted})`,
        );
        break;
      }
      const ok = await add.click({ timeout: 3_000 }).then(() => true, () => false);
      if (!ok) {
        notes.push(`experience sections: "${wantAnother ? "Add Another" : "Add"}" click failed on the ${section.kind} section`);
        break;
      }
      await page.waitForTimeout(settle);
      const after = await rowsPresent();
      if (after <= rows) {
        notes.push(`experience sections: "${wantAnother ? "Add Another" : "Add"}" mounted no new ${section.kind} row — stopping`);
        break;
      }
      clicked += 1;
      rows = after;
      notes.push(
        `experience sections: opened ${section.kind} row ${rows} of ${wanted} (${wantAnother ? "Add Another" : "Add"})`,
      );
    }
  }
  return { clicked, notes };
}

/** Hard cap on rows opened per section, whatever the profile holds. */
export const MAX_ROWS_PER_SECTION = 6;

/** Distinct row ids (`workExperience-N--`) present under a section. */
async function countRows(group: import("playwright").Locator, rowInput: string): Promise<number> {
  const ids = await group
    .locator(rowInput)
    .evaluateAll((els: Array<{ id: string }>) => els.map((el) => el.id))
    .catch(() => [] as string[]);
  const rows = new Set<string>();
  for (const id of ids) {
    const m = id.match(/^([A-Za-z]+-\d+)--/);
    if (m) rows.add(m[1]!);
  }
  return rows.size;
}
