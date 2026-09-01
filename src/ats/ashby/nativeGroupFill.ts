import type { Locator, Page } from "playwright";
import { pickOptionLabel } from "../greenhouse/comboboxFill.js";

/**
 * Ashby NATIVE fieldset groups (live sierra 2026-09-01, #116): choice
 * questions render as a `data-field-path="<field id>"` wrapper holding a
 * plain <fieldset> of `input[type=radio]` / `input[type=checkbox]`
 * members (opacity-0 painted inputs, one `<label for>` per option).
 * Discovery emits ONE type:"select" field per fieldset
 * (discoverAshbyFieldsetGroups), but nothing on the fill side handled
 * that shape: the entries fell into the combobox ladder, which clicked a
 * radio and waited for a listbox that can never open — every choice
 * question on the Sierra form failed with "listbox did not open after
 * click". These groups are not button groups either (role=radiogroup
 * with <button> children — buttonGroupFill.ts); they are classic form
 * controls addressed only by the wrapper's data-field-path.
 *
 * Same honesty contract as every fill path: no pickOptionLabel match →
 * no click, no residue; commitment is confirmed by re-reading the
 * member's checked state, never by trusting the click.
 */

export type NativeGroupKind = "radio" | "checkbox" | "yesno";

export type NativeGroupProbe = {
  group: Locator;
  kind: NativeGroupKind;
  optionCount: number;
};

export type NativeGroupOption = {
  index: number;
  label: string;
  checked: boolean;
  inputId: string | null;
};

export type NativeGroupFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
  pickVia?: string | null;
};

/**
 * The wrapper for a plan field id, when it holds a native choice group.
 * A single checkbox is consent, not a choice — the generic checkbox path
 * owns it (mirrors the `options.length < 2` gate in discovery).
 */
export async function locateNativeGroup(
  page: Page,
  fieldId: string,
): Promise<NativeGroupProbe | null> {
  if (!fieldId) return null;
  const esc = fieldId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const group = page.locator(`[data-field-path="${esc}"]`).first();
  if ((await group.count().catch(() => 0)) === 0) return null;
  // #132 (live valon 2026-09-01): Ashby's yes/no BUTTON PAIR
  // (ashby-application-form-input-yesno: two aria-pressed buttons with
  // data-option="yes|no" + one hidden uuid-named checkbox). The hidden
  // checkbox is plumbing; the buttons are the control.
  const yesno = await group
    .locator('[class*="input-yesno"] button[data-option]')
    .count()
    .catch(() => 0);
  if (yesno >= 2) return { group, kind: "yesno", optionCount: yesno };
  const radios = await group
    .locator('input[type="radio"]')
    .count()
    .catch(() => 0);
  if (radios >= 2) return { group, kind: "radio", optionCount: radios };
  const checks = await group
    .locator('input[type="checkbox"]')
    .count()
    .catch(() => 0);
  if (checks >= 2) return { group, kind: "checkbox", optionCount: checks };
  return null;
}

/** Yes/No button pair: read pressed state. */
async function readYesNoOptions(group: Locator): Promise<NativeGroupOption[]> {
  type Btn = {
    querySelectorAll: (s: string) => ArrayLike<{
      getAttribute: (n: string) => string | null;
      textContent: string | null;
    }>;
  };
  return await group.evaluate((el: Btn) => {
    const out: {
      index: number;
      label: string;
      checked: boolean;
      inputId: string | null;
    }[] = [];
    const btns = el.querySelectorAll('[class*="input-yesno"] button[data-option]');
    for (let i = 0; i < btns.length; i++) {
      const b = btns[i]!;
      out.push({
        index: i,
        label: (b.textContent ?? "").replace(/\s+/g, " ").trim(),
        checked: b.getAttribute("aria-pressed") === "true",
        inputId: null,
      });
    }
    return out;
  });
}

/**
 * Option inventory with live checked state. Label resolution mirrors the
 * two DOM shapes discovery documented: radio members carry the option
 * text in `<label for="…-labeled-radio-N">`; checkbox members carry it
 * in BOTH the label and their own name attribute (name="Bisexual").
 */
export async function readNativeGroupOptions(
  group: Locator,
  kind: NativeGroupKind = "radio",
): Promise<NativeGroupOption[]> {
  if (kind === "yesno") return readYesNoOptions(group);
  type El = {
    querySelectorAll: (s: string) => ArrayLike<{
      getAttribute: (n: string) => string | null;
      checked?: boolean;
    }>;
    querySelector: (s: string) => { textContent: string | null } | null;
  };
  const raw = await group.evaluate((el: El) => {
    const out: {
      index: number;
      label: string;
      checked: boolean;
      inputId: string | null;
    }[] = [];
    const inputs = el.querySelectorAll(
      'input[type="radio"], input[type="checkbox"]',
    );
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i]!;
      const id = inp.getAttribute("id");
      let text = "";
      if (id) {
        const lab = el.querySelector(
          'label[for="' + id.replace(/"/g, '\\"') + '"]',
        );
        if (lab && lab.textContent) text = lab.textContent;
      }
      if (!text) text = inp.getAttribute("name") || "";
      out.push({
        index: i,
        label: text.replace(/\s+/g, " ").trim(),
        checked: inp.checked === true,
        inputId: id,
      });
    }
    return out;
  });
  return raw;
}

/** Labels of the checked members, "; "-joined; null while none checked. */
export async function readNativeGroupValue(
  group: Locator,
  kind: NativeGroupKind = "radio",
): Promise<string | null> {
  const options = await readNativeGroupOptions(group, kind);
  const checked = options.filter((o) => o.checked && o.label);
  if (checked.length === 0) return null;
  return checked.map((o) => o.label).join("; ");
}

export async function fillNativeGroup(
  page: Page,
  group: Locator,
  expected: unknown,
  kind: NativeGroupKind = "radio",
): Promise<NativeGroupFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);
  const options = await readNativeGroupOptions(group, kind);
  const labels = options.map((o) => o.label).filter((l) => l.length > 0);
  if (labels.length === 0) {
    notes.push("native group has no labeled options");
    return { committed: false, selectedLabel: null, notes };
  }

  const pick = pickOptionLabel(labels, expectedText);
  if (!pick.ok) {
    // No match → no click, no residue.
    notes.push(pick.reason);
    return { committed: false, selectedLabel: null, notes };
  }
  const target = options.find((o) => o.label === pick.label);
  if (!target) {
    notes.push(`picked "${pick.label}" but no member carries that label`);
    return { committed: false, selectedLabel: null, notes };
  }

  if (target.checked) {
    notes.push(`already checked "${target.label}"`);
    return {
      committed: true,
      selectedLabel: target.label,
      notes,
      pickVia: pick.via,
    };
  }

  if (kind === "yesno") {
    // The visible aria-pressed button IS the control (#132).
    await group
      .locator('[class*="input-yesno"] button[data-option]')
      .nth(target.index)
      .click({ timeout: 5_000 });
    notes.push(`picked "${pick.label}" (${pick.via})`);
    await page.waitForTimeout(150);
    const after = await readNativeGroupOptions(group, kind);
    const member = after.find((o) => o.index === target.index);
    const committed = member?.checked === true;
    if (!committed) {
      notes.push("commit not confirmed: button not aria-pressed after click");
    }
    return {
      committed,
      selectedLabel: committed ? target.label : null,
      notes,
      pickVia: pick.via,
    };
  }
  // Click the option LABEL — the visible element a person clicks; the
  // input itself is a 24×24 opacity-0 paint target. Fall back to a
  // forced input click when the label is missing.
  if (target.inputId) {
    const esc = target.inputId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await group.locator(`label[for="${esc}"]`).first().click({ timeout: 5_000 });
  } else {
    await group
      .locator('input[type="radio"], input[type="checkbox"]')
      .nth(target.index)
      .click({ timeout: 5_000, force: true });
  }
  notes.push(`picked "${pick.label}" (${pick.via})`);
  await page.waitForTimeout(150);

  // Independent read-back — the member must now be checked.
  const after = await readNativeGroupOptions(group, kind);
  const member = after.find((o) => o.index === target.index);
  const committed = member?.checked === true;
  if (!committed) {
    notes.push("commit not confirmed: member not checked after click");
  }
  return {
    committed,
    selectedLabel: committed ? target.label : null,
    notes,
    pickVia: pick.via,
  };
}
