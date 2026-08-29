import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import type {
  FieldFillMeta,
  FillResult,
  FormResetResult,
  FormVerificationResult,
  UploadVerification,
} from "../adapter.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  detectUploadCommit,
  resolveResumeFileInput,
} from "../shared/uploadResolve.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  locatorForField,
  type ExecutableFillEntry,
  type FieldMeta,
} from "../greenhouse/fill.js";
import {
  detectControlKind,
  pickOptionLabel,
} from "../greenhouse/comboboxFill.js";
import {
  fillAshbyCombobox,
  readAshbyComboboxValue,
} from "./comboboxFill.js";
import {
  detectButtonGroup,
  fillButtonGroup,
  readButtonGroupValue,
} from "./buttonGroupFill.js";
import { ashbySelectorsV1 } from "./selectors.js";

/**
 * Ashby fill executor. Three-way dispatch:
 * - radio-typed entries are Ashby button groups (role=radiogroup +
 *   <button> children — the generic executor's radio branch expects
 *   input[type=radio] and cannot handle them) → ./buttonGroupFill.ts;
 * - live combobox-kind controls → ./comboboxFill.ts, because the
 *   greenhouse combobox reader keys on React-select shells and cannot see
 *   Ashby's committed-value display node (span[class*="__selected"]);
 * - everything else delegates to the generic executor in
 *   ../greenhouse/fill.ts.
 * The full guard chain (assertFormFillAllowed →
 * assertExecutableApprovedEntry, which rejects textarea/demographics/
 * unapproved) runs on both local paths here and inside the generic
 * executor for the rest.
 */

function isApprovedExecutable(
  entry: ExecutableFillEntry,
): entry is ApprovedFillPlanEntry & { approved: true; action: "FILL" } {
  return (
    "approved" in entry && entry.approved === true && entry.action === "FILL"
  );
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * 2026-08 variant wrapper (see selectors.fieldWrapper): the question wrapper
 * carries data-field-path=<field id> or data-field-entry-id=<uuid>_<field id>.
 * The wrapper is the only stable handle when the question's <label for>
 * targets an id no control carries (live session 1b93205e: gender, race,
 * veteran, sponsorship, how-heard, and the react-datepicker all failed
 * label lookup while sitting right there in the DOM).
 */
async function ashbyFieldWrapper(
  page: Page,
  fieldId: string,
): Promise<Locator | null> {
  if (fieldId === "") return null;
  const esc = escapeAttr(fieldId);
  const byPath = page
    .locator(`[${ashbySelectorsV1.fieldWrapper.pathAttr}="${esc}"]`)
    .first();
  if ((await byPath.count()) > 0) return byPath;
  const byEntry = page
    .locator(`[${ashbySelectorsV1.fieldWrapper.entryAttr}$="_${esc}"]`)
    .first();
  if ((await byEntry.count()) > 0) return byEntry;
  return null;
}

/**
 * Locate a button group by data-field-id, then by the 2026-08 field wrapper
 * (whose fieldset holds native option inputs), falling back to the group's
 * accessible name (aria-label / aria-labelledby): discovery emits synthetic
 * ids (button_group_N) for groups without data-field-id, and those never
 * exist in the DOM — the entry's label is the stable handle then.
 */
async function buttonGroupLocator(
  page: Page,
  fieldId: string,
  label: string,
): Promise<Locator | null> {
  const byId = page
    .locator(
      `${ashbySelectorsV1.buttonGroup.container}[data-field-id="${escapeAttr(fieldId)}"]`,
    )
    .first();
  if ((await byId.count()) > 0) return byId;
  const wrapper = await ashbyFieldWrapper(page, fieldId);
  if (wrapper !== null) {
    const fieldset = wrapper
      .locator(ashbySelectorsV1.inputGroup.fieldset)
      .first();
    if ((await fieldset.count()) > 0) return fieldset;
    const roleGroup = wrapper
      .locator(ashbySelectorsV1.buttonGroup.container)
      .first();
    if ((await roleGroup.count()) > 0) return roleGroup;
  }
  const byName = page
    .getByRole("radiogroup", { name: label, exact: false })
    .first();
  if ((await byName.count()) > 0) return byName;
  return null;
}

function isRadioEntry(
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
): boolean {
  return (fieldMeta.get(entry.field_id)?.type ?? entry.type) === "radio";
}

/**
 * Live classification: the plan's type is advisory (session 1b93205e planned
 * Ashby fieldset groups as select/checkbox), so an entry whose wrapper holds
 * a native input group is a group entry regardless of planned type.
 */
async function isGroupEntry(
  page: Page,
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
): Promise<boolean> {
  if (isRadioEntry(entry, fieldMeta)) return true;
  const wrapper = await ashbyFieldWrapper(page, entry.field_id);
  if (wrapper === null) return false;
  const fieldset = wrapper
    .locator(ashbySelectorsV1.inputGroup.fieldset)
    .first();
  if ((await fieldset.count()) === 0) return false;
  return (
    (await fieldset
      .locator(ashbySelectorsV1.inputGroup.optionInput)
      .count()) > 0
  );
}

/**
 * A single plain control (input/textarea) inside the entry's wrapper, for
 * entries the label path cannot reach (e.g. the react-datepicker whose
 * planned label is its placeholder "Pick date..."). Only offered when the
 * legacy locator finds nothing — resolution order stays byte-compatible for
 * every field that resolved before.
 */
async function wrapperOnlyControl(
  page: Page,
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
): Promise<Locator | null> {
  if ((await entryLocator(page, entry, fieldMeta).count()) > 0) return null;
  const wrapper = await ashbyFieldWrapper(page, entry.field_id);
  if (wrapper === null) return null;
  const controls = wrapper.locator(
    'input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), textarea',
  );
  if ((await controls.count()) !== 1) return null;
  return controls.first();
}

function entryLocator(
  page: Page,
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
) {
  const meta = fieldMeta.get(entry.field_id);
  return locatorForField(page, {
    field_id: entry.field_id,
    label: entry.label,
    ...(meta?.name ? { name: meta.name } : {}),
    ...(meta?.inputId ? { inputId: meta.inputId } : {}),
  });
}

/** Live probe: only text/select-typed entries can be combobox widgets. */
async function isComboboxEntry(
  page: Page,
  entry: ExecutableFillEntry,
  fieldMeta: Map<string, FieldMeta>,
): Promise<boolean> {
  const type = fieldMeta.get(entry.field_id)?.type ?? entry.type;
  if (type !== "text" && type !== "select") return false;
  try {
    const loc = entryLocator(page, entry, fieldMeta);
    // Unresolvable locator ⇒ not a combobox — probing it would hang in
    // locator.evaluate for the full 30s timeout (session 1b93205e burned
    // that stall once per unresolvable text entry).
    if ((await loc.count()) === 0) return false;
    return (await detectControlKind(loc)) === "combobox";
  } catch {
    return false;
  }
}

function isVerifiableFill(entry: ExecutableFillEntry): boolean {
  return (
    (entry.action === "fill" || entry.action === "FILL") &&
    (!("approved" in entry) || entry.approved === true)
  );
}

export async function ashbyFillFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FillResult> {
  assertFormFillAllowed("ashby.fill");

  const groupEntries: ExecutableFillEntry[] = [];
  const rest: ExecutableFillEntry[] = [];
  for (const e of entries) {
    if (await isGroupEntry(page, e, fieldMeta)) groupEntries.push(e);
    else rest.push(e);
  }
  const comboboxEntries: ExecutableFillEntry[] = [];
  const wrapperTextEntries: Array<{
    entry: ExecutableFillEntry;
    control: Locator;
  }> = [];
  const delegateEntries: ExecutableFillEntry[] = [];
  for (const e of rest) {
    if (isApprovedExecutable(e) && (await isComboboxEntry(page, e, fieldMeta))) {
      comboboxEntries.push(e);
      continue;
    }
    const control = isApprovedExecutable(e)
      ? await wrapperOnlyControl(page, e, fieldMeta)
      : null;
    if (control !== null) wrapperTextEntries.push({ entry: e, control });
    else delegateEntries.push(e);
  }

  const base = await greenhouseFillFromPlan(page, delegateEntries, fieldMeta);
  const filled = [...base.filled];
  const skipped = [...base.skipped];
  const errors = [...base.errors];
  const field_meta: FieldFillMeta[] = [...(base.field_meta ?? [])];

  for (const { entry, control } of wrapperTextEntries) {
    try {
      assertExecutableApprovedEntry(entry as ApprovedFillPlanEntry);
      await control.fill(String(entry.value), { timeout: 5_000 });
      const observed = (await control.inputValue()).trim();
      if (observed !== String(entry.value).trim()) {
        throw new Error(
          `wrapper control did not commit (observed "${observed.slice(0, 60)}")`,
        );
      }
      field_meta.push({
        field_id: entry.field_id,
        canonical_field: entry.canonical_field,
        control_kind: "wrapper_text",
        selected_option: null,
        match_via: null,
        notes: ["resolved via data-field wrapper (label lookup found nothing)"],
      });
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const entry of comboboxEntries) {
    try {
      assertExecutableApprovedEntry(entry as ApprovedFillPlanEntry);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    try {
      const result = await fillAshbyCombobox(
        page,
        entryLocator(page, entry, fieldMeta),
        entry.value,
      );
      field_meta.push({
        field_id: entry.field_id,
        canonical_field: entry.canonical_field,
        control_kind: "combobox",
        selected_option: result.selectedLabel,
        match_via: result.pickVia ?? null,
        notes: result.notes,
      });
      if (!result.committed) {
        throw new Error(
          `combobox option not committed: ${result.notes.join("; ")}`,
        );
      }
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const entry of groupEntries) {
    if (!isApprovedExecutable(entry)) {
      if (
        entry.action === "fill" ||
        entry.action === "FILL" ||
        ("approved" in entry && entry.approved)
      ) {
        errors.push(
          `${entry.field_id}: rejected — entry is not an approved FILL action`,
        );
      } else {
        skipped.push(entry.field_id);
      }
      continue;
    }
    try {
      assertExecutableApprovedEntry(entry);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    try {
      const group = await buttonGroupLocator(page, entry.field_id, entry.label);
      if (group === null) {
        throw new Error(
          "button group not found by data-field-id or accessible name",
        );
      }
      if (!(await detectButtonGroup(group))) {
        throw new Error("located element is not a button group");
      }
      const result = await fillButtonGroup(group, entry.value);
      field_meta.push({
        field_id: entry.field_id,
        canonical_field: entry.canonical_field,
        control_kind: "button_group",
        selected_option: result.selectedLabel,
        notes: result.notes,
      });
      if (!result.committed) {
        throw new Error(
          `button group option not committed: ${result.notes.join("; ")}`,
        );
      }
      filled.push(entry.canonical_field ?? entry.field_id);
    } catch (err) {
      errors.push(
        `${entry.field_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { filled, skipped, errors, field_meta };
}

export async function ashbyVerifyFromPlan(
  page: Page,
  entries: ExecutableFillEntry[],
  fieldMeta: Map<string, FieldMeta>,
): Promise<FormVerificationResult> {
  const groupEntries: ExecutableFillEntry[] = [];
  const rest: ExecutableFillEntry[] = [];
  for (const e of entries) {
    if (await isGroupEntry(page, e, fieldMeta)) groupEntries.push(e);
    else rest.push(e);
  }
  const comboboxEntries: ExecutableFillEntry[] = [];
  const wrapperTextEntries: Array<{
    entry: ExecutableFillEntry;
    control: Locator;
  }> = [];
  const delegateEntries: ExecutableFillEntry[] = [];
  for (const e of rest) {
    if (isVerifiableFill(e) && (await isComboboxEntry(page, e, fieldMeta))) {
      comboboxEntries.push(e);
      continue;
    }
    const control = isVerifiableFill(e)
      ? await wrapperOnlyControl(page, e, fieldMeta)
      : null;
    if (control !== null) wrapperTextEntries.push({ entry: e, control });
    else delegateEntries.push(e);
  }

  const base = await greenhouseVerifyFromPlan(page, delegateEntries, fieldMeta);
  const fields = [...base.fields];
  const warnings = [...base.warnings];

  for (const { entry, control } of wrapperTextEntries) {
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const observed = (await control.inputValue()).trim();
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed,
        match: observed === String(entry.value).trim(),
      });
    } catch (err) {
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  for (const entry of comboboxEntries) {
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const observed = await readAshbyComboboxValue(
        entryLocator(page, entry, fieldMeta),
      );
      const match =
        observed !== null && pickOptionLabel([observed], String(entry.value)).ok;
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed,
        match,
      });
    } catch (err) {
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  const fillable = groupEntries.filter(
    (e) =>
      (e.action === "fill" || e.action === "FILL") &&
      (!("approved" in e) || e.approved === true),
  );
  for (const entry of fillable) {
    const canonical = entry.canonical_field ?? entry.field_id;
    try {
      const group = await buttonGroupLocator(page, entry.field_id, entry.label);
      if (group === null) {
        throw new Error("button group not found");
      }
      const observed = await readButtonGroupValue(group);
      // pickOptionLabel gives Yes/No synonym + case-insensitive equivalence.
      const match =
        observed !== null &&
        pickOptionLabel([observed], String(entry.value)).ok;
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed,
        match,
      });
    } catch (err) {
      warnings.push(
        `verify ${canonical}: ${err instanceof Error ? err.message : String(err)}`,
      );
      fields.push({
        canonical_field: canonical,
        expected: entry.value,
        observed: null,
        match: false,
      });
    }
  }

  return {
    passed:
      fields.length > 0 && fields.every((f) => f.match) && warnings.length === 0,
    fields,
    uploads: base.uploads,
    warnings,
  };
}

export async function ashbyUploadFile(
  page: Page,
  kind: "resume",
  filePath: string,
): Promise<UploadVerification> {
  assertFormFillAllowed(`ashby.upload.${kind}`);
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    return {
      field: kind,
      path: abs,
      filename: path.basename(abs),
      size_bytes: 0,
      verified: false,
      evidence: "file missing",
    };
  }
  const stat = fs.statSync(abs);
  const filename = path.basename(abs);
  // Resolve with wait + keyword/lone-input fallback + one retry — a
  // one-shot count() against Ashby's late-mounting dropzone is exactly the
  // "sometimes the resume doesn't upload" bug. Misses carry the file-input
  // inventory as evidence.
  const resolution = await resolveResumeFileInput(page, {
    css: ashbySelectorsV1.resume,
  });
  if (!resolution.found) {
    return {
      field: kind,
      path: abs,
      filename,
      size_bytes: stat.size,
      verified: false,
      evidence: `resume file input not found; ${resolution.notes.join("; ")}; inventory: ${JSON.stringify(resolution.inventory)}`,
    };
  }
  const input = resolution.input;
  // setInputFiles works on CSS-hidden (display:none) inputs behind
  // Ashby's drag-drop zone — visibility is not required.
  await input.setInputFiles(abs);
  // Chip-accepting commit check: Ashby dropzones may replace the input with
  // a filename chip; requiring input.files to persist reads success as fail.
  const commit = await detectUploadCommit(page, input, {
    filename,
    sizeBytes: stat.size,
  });
  return {
    field: kind,
    path: abs,
    filename,
    size_bytes: stat.size,
    verified: commit.verified,
    evidence: `${commit.evidence}; resolved via ${resolution.via}`,
  };
}

/**
 * Honest failure: Ashby's controlled React inputs do not respond to
 * HTMLFormElement.reset(). The fixture's uncontrolled inputs would make a
 * reset() look green here while lying about live behavior, so this reports
 * reset:false unconditionally — a page reload is the only reliable reset.
 */
export async function ashbyResetForm(page: Page): Promise<FormResetResult> {
  assertFormFillAllowed("ashby.resetForm");
  void page;
  return {
    reset: false,
    notes: [
      "Ashby SPA: controlled inputs do not respond to form.reset(); reload the page to reset",
    ],
  };
}
