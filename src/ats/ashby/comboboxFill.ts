import type { Locator, Page } from "playwright";
import { labelsCompatible, pickOptionLabel } from "../greenhouse/comboboxFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby combobox commit + read-back. The greenhouse combobox reader keys on
 * React-select shells ("select__control"/"select-shell") and single-value
 * nodes; Ashby renders the committed choice into a sibling display node
 * (span[class*="__selected"] / [data-selected-label]) inside a plain
 * ".ashby-select" container, which that reader cannot see — so commitment
 * and read-back live here, against ashbySelectorsV1. Matching still goes
 * through greenhouse's pickOptionLabel so synonym policy stays uniform
 * across ATSes. Same honesty contract as every fill path: no match → no
 * click, no residue; commitment is confirmed by an independent read of the
 * committed display node, never by trusting the click.
 *
 * #117 (live sierra 2026-09-01, probe-confirmed): the
 * `input-autocomplete` variant opens its listbox only AFTER TYPING —
 * a bare click focuses the input and nothing mounts, and the options are
 * fetched asynchronously (typing "Johns" showed "No results" while the
 * toggle-button browse listed 101 fixed options). The ladder is now:
 * click → (no listbox?) type the expected text → (no/zero options?)
 * clear and browse via the toggle button → pick. When the caller allows
 * it (screener questions only, never demographics), a list that cannot
 * hold the planned value but offers its own "Other" takes that escape
 * hatch — the fill-time mirror of the plan-time policy in
 * applicationFiller.ts (operator directive 2026-08-14).
 */

export type AshbyComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
  /** How pickOptionLabel matched, for fill-outcome telemetry. */
  pickVia?: string | null;
};

export type AshbyComboboxFillOptions = {
  /**
   * Permit the form's own "Other" option when the planned value is not
   * in the list. Callers set this ONLY for screener questions —
   * demographic / EEO fields never take an escape hatch.
   */
  allowOtherFallback?: boolean;
};

const OTHER_OPTION_RE = /^other(\s*\(please specify\))?$/i;

/** Committed display text, or null while the placeholder is showing. */
export async function readAshbyComboboxValue(
  loc: Locator,
): Promise<string | null> {
  type El = {
    closest: (s: string) => El | null;
    parentElement: El | null;
    querySelector: (s: string) => { textContent: string | null } | null;
  };
  const raw = await loc.evaluate((el: El) => {
    const shell = el.closest('[class*="select"]') ?? el.parentElement;
    if (!shell) return null;
    const node = shell.querySelector(
      '[class*="__selected"], [data-selected-label]',
    );
    return node?.textContent ?? null;
  });
  let text = raw === null ? "" : raw.replace(/\s+/g, " ").trim();
  if (text === "" || ashbySelectorsV1.combobox.placeholder.test(text)) {
    // Autocomplete variant: the committed choice lives in the input's own
    // value (there is no __selected sibling). Placeholder text never
    // appears as a value.
    const own = await loc.inputValue({ timeout: 1_000 }).catch(() => "");
    text = own.replace(/\s+/g, " ").trim();
  }
  if (text === "" || ashbySelectorsV1.combobox.placeholder.test(text)) {
    return null;
  }
  return text;
}

/** Bounded harvest of a possibly-virtualized open listbox. */
async function harvestOptions(page: Page, listbox: Locator): Promise<string[]> {
  const seen = new Set<string>();
  const read = async (): Promise<number> => {
    const texts = await page
      .locator(ashbySelectorsV1.combobox.option)
      .filter({ visible: true })
      .allTextContents()
      .catch(() => [] as string[]);
    let added = 0;
    for (const t of texts) {
      const c = t.replace(/\s+/g, " ").trim();
      if (c && c.length < 250 && !seen.has(c)) {
        seen.add(c);
        added += 1;
      }
    }
    return added;
  };
  await read();
  let quiet = 0;
  for (let i = 0; i < 30 && quiet < 2 && seen.size < 400; i++) {
    const moved = await listbox
      .evaluate(
        (el: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
          return el.scrollTop !== before;
        },
        undefined,
        { timeout: 2_000 },
      )
      .catch(() => false);
    await page.waitForTimeout(120);
    const added = await read();
    if (!moved && added === 0) break;
    quiet = added === 0 ? quiet + 1 : 0;
  }
  return [...seen].filter(
    (t) => !/^(no results|no options|loading|searching)\b/i.test(t),
  );
}

/** Wait (bounded) for the async option fetch to settle after typing. */
async function settleOptions(page: Page, listbox: Locator): Promise<string[]> {
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(400);
    const texts = await page
      .locator(ashbySelectorsV1.combobox.option)
      .filter({ visible: true })
      .allTextContents()
      .catch(() => [] as string[]);
    const clean = texts
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);
    if (clean.length > 0) return harvestOptions(page, listbox);
    // Non-waiting read: allTextContents returns [] instantly when the
    // listbox is gone (a waiting textContent() here stalled 30s/loop).
    const listboxTexts = await page
      .locator(ashbySelectorsV1.combobox.listbox)
      .filter({ visible: true })
      .allTextContents()
      .catch(() => [] as string[]);
    if (listboxTexts.some((t) => /no results|no options/i.test(t))) return [];
  }
  return [];
}

async function clickOptionByLabel(
  page: Page,
  listbox: Locator,
  label: string,
  notes: string[],
): Promise<boolean> {
  // Exact accessible-name match first — substring hasText would happily
  // click "Not sure" when the pick is "No". Virtualized lists may need a
  // scroll-to-row pass before the row exists.
  for (let i = 0; i < 35; i++) {
    let option = page
      .getByRole("option", { name: label, exact: true })
      .filter({ visible: true })
      .first();
    if ((await option.count()) === 0) {
      option = page
        .locator(ashbySelectorsV1.combobox.option)
        .filter({ visible: true })
        .filter({ hasText: label })
        .first();
      if ((await option.count()) > 0 && i === 0) {
        notes.push("exact option name not found; substring fallback");
      }
    }
    if ((await option.count()) > 0) {
      await option.click({ timeout: 5_000 });
      return true;
    }
    const moved = await listbox
      .evaluate(
        (el: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
          return el.scrollTop !== before;
        },
        undefined,
        { timeout: 2_000 },
      )
      .catch(() => false);
    if (!moved) return false;
    await page.waitForTimeout(120);
  }
  return false;
}

export async function fillAshbyCombobox(
  page: Page,
  loc: Locator,
  expected: unknown,
  opts: AshbyComboboxFillOptions = {},
): Promise<AshbyComboboxFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  const listbox = page
    .locator(ashbySelectorsV1.combobox.listbox)
    .filter({ visible: true })
    .first();
  const listboxOpen = async (timeout: number): Promise<boolean> => {
    try {
      await listbox.waitFor({ state: "visible", timeout });
      return true;
    } catch {
      return false;
    }
  };

  await loc.click({ timeout: 10_000 });
  let options: string[] = [];
  if (await listboxOpen(1_500)) {
    // Classic select-like: list mounts on click; type to filter.
    try {
      await loc.fill(expectedText, { timeout: 3_000 });
      options = await settleOptions(page, listbox);
      if (options.length === 0) {
        await loc.fill("", { timeout: 2_000 }).catch(() => undefined);
        options = await settleOptions(page, listbox);
        notes.push("filter yielded no options; re-collected unfiltered");
      }
    } catch {
      options = await harvestOptions(page, listbox);
      notes.push("control not typeable; using unfiltered options");
    }
  } else {
    // #117 autocomplete variant: nothing mounts on click — type first.
    try {
      await loc.fill(expectedText, { timeout: 3_000 });
    } catch {
      notes.push("listbox did not open after click; control not typeable");
      return { committed: false, selectedLabel: null, notes };
    }
    if (await listboxOpen(5_000)) {
      notes.push("listbox opened after typing");
      options = await settleOptions(page, listbox);
    } else {
      notes.push("listbox did not open after click or typing");
      return { committed: false, selectedLabel: null, notes };
    }
  }

  let pick = pickOptionLabel(options, expectedText);
  if (!pick.ok) {
    // Typed search found nothing usable — browse the full list via the
    // control's toggle button (probe: the same input that says
    // "No results" for the typed text lists 101 options when browsed).
    const toggle = loc
      .locator(
        'xpath=ancestor::*[contains(@class,"inputContainer") or contains(@class,"select")][1]',
      )
      .locator("button")
      .first();
    if ((await toggle.count().catch(() => 0)) > 0) {
      await loc.fill("", { timeout: 2_000 }).catch(() => undefined);
      await toggle.click({ timeout: 3_000 }).catch(() => undefined);
      if (await listboxOpen(3_000)) {
        const browsed = await harvestOptions(page, listbox);
        if (browsed.length > 0) {
          notes.push(`browsed full list via toggle (${browsed.length} options)`);
          options = browsed;
          pick = pickOptionLabel(options, expectedText);
        }
      }
    }
  }
  if (!pick.ok && opts.allowOtherFallback) {
    const other = options.find((o) => OTHER_OPTION_RE.test(o));
    if (other) {
      notes.push(
        `planned "${expectedText}" not in list; taking the form's own "${other}" (screener escape hatch)`,
      );
      pick = { ok: true, label: other, via: "other_fallback" };
    }
  }
  if (!pick.ok) {
    notes.push(pick.reason);
    // Close without committing — no invented values, no filter residue.
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("", { timeout: 1_500 }).catch(() => undefined);
    return { committed: false, selectedLabel: null, notes };
  }

  const clicked = await clickOptionByLabel(page, listbox, pick.label, notes);
  if (!clicked) {
    notes.push(`picked "${pick.label}" but no clickable option row found`);
    await page.keyboard.press("Escape").catch(() => undefined);
    await loc.fill("", { timeout: 1_500 }).catch(() => undefined);
    return { committed: false, selectedLabel: null, notes };
  }
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(() => notes.push("listbox still visible after pick"));
  await page.waitForTimeout(200);

  const committedLabel = await readAshbyComboboxValue(loc);
  const committed =
    committedLabel !== null && labelsCompatible(pick.label, committedLabel);
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  return { committed, selectedLabel: committedLabel, notes, pickVia: pick.via };
}
