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
    if ((await group.locator(section.rowInput).count().catch(() => 0)) > 0) {
      notes.push(`experience sections: ${section.kind} already shows a row — Add not clicked`);
      continue;
    }
    if (available[section.kind] === 0) {
      notes.push(`experience sections: ${section.kind} section is empty and the profile has no structured ${section.kind} entry — left empty`);
      continue;
    }
    const add = group
      .locator("[data-automation-id='add-button'], button")
      .filter({ hasText: /^\s*add\s*$/i })
      .first();
    if (!(await add.isVisible().catch(() => false))) {
      notes.push(`experience sections: ${section.kind} section has no Add control`);
      continue;
    }
    const ok = await add.click({ timeout: 3_000 }).then(() => true, () => false);
    if (!ok) {
      notes.push(`experience sections: Add click failed on the ${section.kind} section`);
      continue;
    }
    await page.waitForTimeout(settle);
    const mounted = await group.locator(section.rowInput).count().catch(() => 0);
    clicked += 1;
    notes.push(
      `experience sections: opened a ${section.kind} row (${mounted} control(s) mounted) for structured entry 1 of ${available[section.kind]}`,
    );
  }
  return { clicked, notes };
}
