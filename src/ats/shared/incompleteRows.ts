import type { Page } from "playwright";
import { historyGroupOf } from "../../applications/fieldNormalization.js";

/**
 * #151 (live UKG run 18, resume-review page): the resume parser emitted a
 * FRAGMENT work-experience row — employer "Gloria", no job title — and the
 * page's own validation refused Save with "Experience job title must not
 * be empty." Nothing truthful can fill that title (the profile holds one
 * job, the bank must never invent), and the #145d Cancel release then
 * discards the WHOLE review form, including the rows that were right.
 *
 * A history row the form cannot save and we cannot complete is a parse
 * artifact: remove that ROW with the page's own per-row Delete/Remove
 * control (the resume itself stays attached, and every other parsed row
 * stands), then let the caller retry Save once. Bounded, and only rows
 * that (a) hold an EMPTY REQUIRED control, (b) belong to an indexed
 * history group (historyGroupOf), and (c) expose a row-scoped
 * Delete/Remove button named with that row's 1-based number.
 */

export const INCOMPLETE_ROW_REMOVAL_CAP = 3;

/** Browser-side: visible, required, empty text-like controls (id/name). */
const EMPTY_REQUIRED_FN = `(() => {
  const out = [];
  for (const el of Array.from(document.querySelectorAll("input, select, textarea"))) {
    if (el.offsetParent === null) continue;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "hidden" || type === "file" || type === "checkbox" || type === "radio") continue;
    const required = el.required || el.getAttribute("aria-required") === "true";
    if (!required) continue;
    if (String(el.value || "").trim() !== "") continue;
    out.push({ id: el.id || "", name: el.getAttribute("name") || "" });
  }
  return out;
})()`;

export async function removeIncompleteHistoryRows(
  page: Page,
  options: { settleMs?: number } = {},
): Promise<{ removed: number; notes: string[] }> {
  const notes: string[] = [];
  let removed = 0;
  let empties: Array<{ id: string; name: string }>;
  try {
    empties = (await page.evaluate(EMPTY_REQUIRED_FN)) as Array<{ id: string; name: string }>;
  } catch {
    return { removed, notes: ["incomplete-row: could not read the page's required controls"] };
  }
  // One entry per row, in ascending index order, so a removal that
  // renumbers later rows is handled by re-reading before each click.
  const rows = new Map<string, { kind: "employment" | "education"; index: number }>();
  for (const e of empties) {
    const group = historyGroupOf({
      ...(e.id ? { inputId: e.id } : {}),
      ...(e.name ? { name: e.name } : {}),
    });
    if (!group) continue;
    rows.set(`${group.kind}:${group.index}`, group);
  }
  if (rows.size === 0) return { removed, notes };
  // Highest index first: deleting row 3 does not renumber rows 0-2.
  const ordered = Array.from(rows.values()).sort((a, b) => b.index - a.index);
  for (const row of ordered) {
    if (removed >= INCOMPLETE_ROW_REMOVAL_CAP) {
      notes.push(`incomplete-row: cap of ${INCOMPLETE_ROW_REMOVAL_CAP} removals reached`);
      break;
    }
    const ordinal = row.index + 1;
    const pattern = new RegExp(`^(delete|remove)\\b.*\\b${ordinal}$`, "i");
    const button = page.getByRole("button", { name: pattern }).first();
    const present = await button.isVisible().catch(() => false);
    if (!present) {
      notes.push(
        `incomplete-row: ${row.kind} row ${row.index} has an empty required control but no row Delete/Remove control — left as is`,
      );
      continue;
    }
    const label = (
      (await button.getAttribute("aria-label").catch(() => null)) ??
      (await button.textContent().catch(() => "")) ??
      ""
    ).trim();
    const clicked = await button.click({ timeout: 3_000 }).then(() => true, () => false);
    if (!clicked) {
      notes.push(`incomplete-row: could not click "${label}"`);
      continue;
    }
    removed += 1;
    notes.push(
      `incomplete-row: removed ${row.kind} row ${row.index} via "${label}" — a required control was empty and nothing truthful could fill it (resume parse fragment; the resume itself stays attached)`,
    );
    if (options.settleMs !== 0) await page.waitForTimeout(options.settleMs ?? 600);
  }
  return { removed, notes };
}
