import type { Page } from "playwright";

/**
 * Lever's location widget keeps TWO values: the visible `#location-input`
 * text and a hidden `input[name="selectedLocation"]` that only a click on
 * a dropdown row sets (JSON with a `name`). The form validates the hidden
 * one — "Please select a location from the dropdown menu and try again".
 *
 * Live SEP/Lever 2026-09-14 (app 1d730f08): the fill read "location
 * committed (blur-stable): Baltimore, MD, USA", verify matched the visible
 * text, the #262c post-parse re-commit ran, and the submit click was still
 * rejected — the hidden selection was empty and nothing read it. This is
 * the one read both the fill and the pre-click gate use.
 *
 * Returns null when the page has no such hidden input (not Lever).
 */
export const LEVER_SELECTED_LOCATION_SELECTOR = 'input[type="hidden"][name="selectedLocation"]';

export async function leverLocationSelectionEmpty(page: Page): Promise<boolean | null> {
  const hidden = page.locator(LEVER_SELECTED_LOCATION_SELECTOR).first();
  if ((await hidden.count().catch(() => 0)) === 0) return null;
  const value = ((await hidden.inputValue().catch(() => "")) ?? "").trim();
  if (value === "") return true;
  return /"name"\s*:\s*""/.test(value);
}
