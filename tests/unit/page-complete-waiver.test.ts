import { describe, expect, it } from "vitest";
import {
  observedIsEmpty,
  pageCompleteWaiver,
} from "../../src/applications/pageCompleteWaiver.js";

/**
 * #240 (night29). Three otherwise-complete applications were abandoned on
 * a plan-vs-page difference about a control the page itself was content to
 * leave EMPTY (Saronic's phantom child control, Barnes' phone entry whose
 * locator resolved to a radio group, ICD's empty essay textarea). The
 * page's own required-completeness scan is the authority on whether an
 * application may be submitted; a control it does not require, showing
 * nothing, is a note.
 *
 * These tests pin the FAIL-CLOSED half just as hard as the waiving half —
 * the whole value of the rule is that it cannot let a wrong value through.
 */
const clean = { scanned: true, unanswered: [] as Array<{ label: string }> };

describe("page-complete waiver (#240, UNIT_CONFIRMED)", () => {
  it("waives a planned value the page left empty and does not require", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [
        { canonical_field: "school", match: false, observed: "" },
        { canonical_field: "email", match: true, observed: "ada@example.com" },
      ],
      fillErrors: [
        '_systemfield_education_history-school: control not found on the page (label "School")',
      ],
      uploadOk: true,
      completeness: clean,
      pageValidationErrors: [],
    });
    expect(w.waive).toBe(true);
    expect(w.waived.join(" ")).toMatch(/school \(left empty\)/);
    expect(w.blocked_by).toBeNull();
  });

  it("REFUSES when a control holds a different non-empty value than planned", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [
        { canonical_field: "gender", match: false, observed: "Asian" },
      ],
      fillErrors: [],
      uploadOk: true,
      completeness: clean,
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/different value than planned/);
  });

  it("REFUSES when the page still requires an unanswered question", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [{ canonical_field: "school", match: false, observed: "" }],
      fillErrors: [],
      uploadOk: true,
      completeness: { scanned: true, unanswered: [{ label: "Undergrad Discipline(s)" }] },
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/unanswered/);
  });

  it("REFUSES when the completeness scan could not run (fail closed)", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [{ canonical_field: "school", match: false, observed: "" }],
      fillErrors: [],
      uploadOk: true,
      completeness: { scanned: false, unanswered: [] },
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/did not run/);
  });

  it("REFUSES when the upload did not verify — a missing resume is never waivable", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [{ canonical_field: "school", match: false, observed: "" }],
      fillErrors: [],
      uploadOk: false,
      completeness: clean,
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/upload/);
  });

  it("REFUSES when the page paints its own validation error", () => {
    const w = pageCompleteWaiver({
      verifyPassed: false,
      verifyFields: [{ canonical_field: "school", match: false, observed: "" }],
      fillErrors: [],
      uploadOk: true,
      completeness: clean,
      pageValidationErrors: ["This field is required."],
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/validation error/);
  });

  it("REFUSES a fill error that could have written a stray value", () => {
    const w = pageCompleteWaiver({
      verifyPassed: true,
      verifyFields: [],
      // Not in the non-mutating vocabulary: something may have been typed.
      fillErrors: ["typed 3 chars but the widget re-rendered mid-keystroke"],
      uploadOk: true,
      completeness: clean,
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toMatch(/may have written a value/);
  });

  it("waives the live non-mutating vocabulary the adapters actually emit", () => {
    for (const err of [
      'd242bb2e: native radio group option not committed: no option matches "4805897636"',
      "communicationConsent: button group not found by data-field-id or accessible name",
      "fe82a98a: date input requires an approved month and year",
      'checkbox group has no option matching "Washington, DC" (no labeled group found around the control)',
    ]) {
      const w = pageCompleteWaiver({
        verifyPassed: true,
        verifyFields: [],
        fillErrors: [err],
        uploadOk: true,
        completeness: clean,
      });
      expect(w.waive, err).toBe(true);
    }
  });

  it("is a no-op when nothing failed at all", () => {
    const w = pageCompleteWaiver({
      verifyPassed: true,
      verifyFields: [{ canonical_field: "email", match: true, observed: "a@b.c" }],
      fillErrors: [],
      uploadOk: true,
      completeness: clean,
    });
    expect(w.waive).toBe(false);
    expect(w.blocked_by).toBeNull();
  });

  it("reads emptiness through the adapters' {value,label} read-back shape", () => {
    expect(observedIsEmpty("")).toBe(true);
    expect(observedIsEmpty(null)).toBe(true);
    expect(observedIsEmpty({ value: "", label: "" })).toBe(true);
    expect(observedIsEmpty({ value: "No", label: "No" })).toBe(false);
    expect(observedIsEmpty("(empty)")).toBe(false);
    // A checked boolean is a real answer, never "empty".
    expect(observedIsEmpty(true)).toBe(false);
    expect(observedIsEmpty(false)).toBe(false);
  });
});
