/**
 * #240 — "the page's own rules decide whether an application is complete."
 *
 * Night29 lost a run of otherwise-finished applications to a plan-vs-page
 * difference on a control the page itself was content to leave EMPTY:
 *
 *   Saronic (ashby)  a phantom child control — `control not found`
 *   Barnes (ashby)   a phone entry whose locator resolved to a radio
 *                    group, so nothing was typed anywhere
 *   ICD Portal       an essay textarea that read back empty
 *
 * In each, the form satisfied its own validation; only our plan disagreed
 * with the page, and the disagreement was always "we wanted to write
 * something here and did not". Blocking there costs a complete application
 * and buys nothing: the required-completeness scan already checks every
 * required question against three independent sources (DOM required,
 * asterisk, board schema), and it is the authority the page itself uses.
 *
 * So this waiver fires ONLY when all of the following hold:
 *
 *   - the completeness scan actually ran and named nothing unanswered;
 *   - the upload stage is clean (a missing resume is never waivable);
 *   - every verify mismatch reads EMPTY on the page — a control showing a
 *     DIFFERENT non-empty value means something wrong was written, which
 *     is precisely what verification exists to catch, and still blocks;
 *   - every fill error's own message proves nothing was written (the
 *     control was never found, an option was never committed, a value was
 *     refused before typing). Any other failure could have left a stray
 *     value on a control outside the plan — which verify cannot see — so
 *     those still block.
 *
 * It never fills, approves, or invents a value, and it does not touch the
 * approved-plan gate, SUBMIT_ENABLED, or the operator confirmation. What
 * it changes is only which side of "complete" a page-empty control lands
 * on. Every waived field is named in the report so a submit that went
 * through with gaps stays auditable.
 */

export type WaiverVerifyField = {
  canonical_field: string;
  match: boolean;
  observed?: unknown;
};

export type PageCompleteWaiver = {
  waive: boolean;
  /** Human-readable list of what the plan wanted and the page left empty. */
  waived: string[];
  /** Why the waiver did NOT fire (empty when it did). */
  blocked_by: string | null;
};

/**
 * A fill error whose message proves the control was never written to.
 * Anchored to the failure vocabulary the adapters actually emit.
 */
const NON_MUTATING_FILL_ERROR =
  /control not found|not found by data-field-id|no option match(?:es|ing)|option not committed|requires an approved|refus(?:ed|ing)|no labeled group found/i;

export function observedIsEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (typeof v === "boolean") return false;
  if (typeof v === "object") {
    const label = (v as { label?: unknown }).label;
    const value = (v as { value?: unknown }).value;
    if (label !== undefined || value !== undefined) {
      return (
        String(label ?? "").trim() === "" && String(value ?? "").trim() === ""
      );
    }
  }
  return false;
}

export function pageCompleteWaiver(input: {
  verifyPassed: boolean;
  verifyFields: WaiverVerifyField[];
  fillErrors: string[];
  uploadOk: boolean;
  /** From scanRequiredCompleteness — fail closed when it did not run. */
  completeness: { scanned: boolean; unanswered: Array<{ label: string }> };
  /** Visible validation errors the page itself painted, when read. */
  pageValidationErrors?: string[];
}): PageCompleteWaiver {
  const none: PageCompleteWaiver = { waive: false, waived: [], blocked_by: null };
  if (input.verifyPassed && input.fillErrors.length === 0) return none;
  if (!input.uploadOk) return { ...none, blocked_by: "upload did not verify" };
  if (!input.completeness.scanned) {
    return { ...none, blocked_by: "required-completeness scan did not run" };
  }
  if (input.completeness.unanswered.length > 0) {
    return {
      ...none,
      blocked_by: `page requires ${input.completeness.unanswered.length} unanswered question(s)`,
    };
  }
  const pageErrors = input.pageValidationErrors ?? [];
  if (pageErrors.length > 0) {
    return { ...none, blocked_by: `page shows its own validation error(s)` };
  }
  const wrongValue = input.verifyFields.filter(
    (f) => !f.match && !observedIsEmpty(f.observed),
  );
  if (wrongValue.length > 0) {
    return {
      ...none,
      blocked_by: `${wrongValue.length} field(s) hold a different value than planned (${wrongValue
        .map((f) => f.canonical_field)
        .slice(0, 4)
        .join(", ")})`,
    };
  }
  const mutating = input.fillErrors.filter(
    (e) => !NON_MUTATING_FILL_ERROR.test(String(e)),
  );
  if (mutating.length > 0) {
    return {
      ...none,
      blocked_by: `${mutating.length} fill error(s) may have written a value: ${mutating[0]!.slice(0, 90)}`,
    };
  }
  const waived = [
    ...input.verifyFields
      .filter((f) => !f.match)
      .map((f) => `${f.canonical_field} (left empty)`),
    ...input.fillErrors.map((e) => String(e).slice(0, 120)),
  ];
  if (waived.length === 0) return none;
  return { waive: true, waived, blocked_by: null };
}
