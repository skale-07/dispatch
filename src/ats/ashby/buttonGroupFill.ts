import type { Locator } from "playwright";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby renders choice questions in two live variants:
 * - segmented button groups (role=radiogroup holding <button> children,
 *   selection carried in aria-pressed) — the original path below;
 * - fieldset input groups (2026-08 variant: a <fieldset> with NATIVE
 *   radio/checkbox inputs, each labelled by its own sibling <label for>).
 * Same contract for both: options are collected from the real DOM, matching
 * goes through pickOptionLabel (no invented values, ambiguous → refuse), and
 * commitment is confirmed by an independent read-back — a click that didn't
 * stick reports committed:false instead of trusting the click.
 */

export type ButtonGroupFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
};

export async function detectButtonGroup(loc: Locator): Promise<boolean> {
  try {
    return await loc.evaluate(
      (
        el: {
          getAttribute: (n: string) => string | null;
          closest: (s: string) => unknown;
          matches: (s: string) => boolean;
          querySelector: (s: string) => unknown;
        },
        sel: { fieldset: string; optionInput: string },
      ) =>
        el.getAttribute("role") === "radiogroup" ||
        el.closest('[role="radiogroup"]') !== null ||
        // 2026-08 variant: fieldset input group (the locator may be the
        // fieldset itself or the data-field-path wrapper around it).
        ((el.matches(sel.fieldset) || el.querySelector(sel.fieldset) !== null) &&
          el.querySelector(sel.optionInput) !== null),
      {
        fieldset: ashbySelectorsV1.inputGroup.fieldset,
        optionInput: ashbySelectorsV1.inputGroup.optionInput,
      },
    );
  } catch {
    return false;
  }
}

/** Structural shape of a native option input inside evaluate (no DOM lib). */
type NativeOptionEl = {
  id: string;
  checked: boolean;
  closest: (s: string) => {
    querySelector: (s: string) => { textContent: string | null } | null;
  } | null;
  ownerDocument: {
    querySelector: (s: string) => { textContent: string | null } | null;
  };
};

/**
 * Page-context walk over the native variant's option inputs. The option
 * label is the <label for=<input id>>, falling back to the label inside the
 * option container. checkedOnly narrows to the selected option(s).
 */
async function nativeGroupLabels(
  groupLoc: Locator,
  checkedOnly: boolean,
): Promise<string[]> {
  return groupLoc
    .evaluate(
      (
        el: { querySelectorAll: (s: string) => ArrayLike<NativeOptionEl> },
        arg: { optionInput: string; checkedOnly: boolean },
      ) => {
        const inputs = el.querySelectorAll(arg.optionInput);
        const labels: string[] = [];
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i] as NativeOptionEl;
          if (arg.checkedOnly && !input.checked) continue;
          let text = "";
          if (input.id !== "") {
            const esc = input.id
              .replace(/\\/g, "\\\\")
              .replace(/"/g, '\\"');
            const lab = input.ownerDocument.querySelector(
              `label[for="${esc}"]`,
            );
            if (lab) text = lab.textContent ?? "";
          }
          if (text === "") {
            const lab = input
              .closest("div, li, span")
              ?.querySelector("label");
            if (lab) text = lab.textContent ?? "";
          }
          text = text.replace(/\s+/g, " ").trim();
          if (text !== "") labels.push(text);
        }
        return labels;
      },
      {
        optionInput: ashbySelectorsV1.inputGroup.optionInput,
        checkedOnly,
      },
    )
    .catch(() => []);
}

/** Checked native options' labels, comma-joined. */
async function nativeGroupChecked(groupLoc: Locator): Promise<string | null> {
  const labels = await nativeGroupLabels(groupLoc, true);
  return labels.length > 0 ? labels.join(", ") : null;
}

/** Text of the pressed button / checked native option, or null. */
export async function readButtonGroupValue(
  groupLoc: Locator,
): Promise<string | null> {
  const pressed = groupLoc.locator(ashbySelectorsV1.buttonGroup.pressed);
  if ((await pressed.count()) > 0) {
    const text = (await pressed.first().textContent()) ?? "";
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned !== "") return cleaned;
  }
  if (
    (await groupLoc
      .locator(ashbySelectorsV1.inputGroup.optionInput)
      .count()) > 0
  ) {
    return nativeGroupChecked(groupLoc);
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function fillButtonGroup(
  groupLoc: Locator,
  expected: unknown,
): Promise<ButtonGroupFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);

  let options = (await groupLoc.locator("button").allTextContents())
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
  let variant: "button" | "native" = "button";
  if (options.length === 0) {
    options = await nativeGroupLabels(groupLoc, false);
    variant = "native";
  }
  if (options.length === 0) {
    notes.push("button group has no options");
    return { committed: false, selectedLabel: null, notes };
  }

  const pick = pickOptionLabel(options, expectedText);
  if (!pick.ok) {
    notes.push(pick.reason);
    return { committed: false, selectedLabel: null, notes };
  }

  if (variant === "button") {
    await groupLoc
      .getByRole("button", { name: pick.label, exact: true })
      .first()
      .click({ timeout: 5_000 });
  } else {
    // Native variant: click the option's own <label> — the browser toggles
    // the associated input, matching what a human click does.
    await groupLoc
      .locator("label")
      .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(pick.label)}\\s*$`) })
      .first()
      .click({ timeout: 5_000 });
  }
  notes.push(`clicked "${pick.label}" (${pick.via}, ${variant})`);

  const observed = await readButtonGroupValue(groupLoc);
  const committed = observed !== null && observed === pick.label;
  if (!committed) {
    notes.push(
      `commit not confirmed: pressed state shows ${observed === null ? "nothing" : `"${observed}"`}`,
    );
  }
  return { committed, selectedLabel: observed, notes };
}
