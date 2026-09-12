import type { Locator, Page } from "playwright";

/**
 * Ashby's built-in education block, addressed structurally (#271/#272 —
 * live Commure 2026-09-12 app 80e6a0fc and sibling app 04394211, both
 * parked AMBIGUOUS_FIELD in one evening).
 *
 * The block is a single wrapper:
 *
 *   <div data-field-path="_systemfield_education_history">
 *     <label for="_systemfield_education_history">Education History</label>
 *     <label for="…-school">School</label>
 *     <input class="… ashby-application-form-input-autocomplete">   <-- NO id
 *     <label for="…-degree">Degree</label>  <input id="…-degree">   <-- real id
 *     <label for="…-major">Field of Study</label> <input id="…-major">
 *     <label for="…-startDate">Start Date</label>
 *     <div id="…-startDate"><select>Month…</select><select>Year…</select></div>
 *     <label for="…-endDate">End Date</label>
 *     <div id="…-endDate"><select>Month…</select><select>Year…</select></div>
 *
 * Only Degree and Field of Study actually carry their label's `for` id as a
 * real element id. School's control has none, and the date pairs are id-less
 * `<select>`s whose container div owns the id. So every locatorForField tier
 * missed them: the runs ended `control not found on the page (label
 * "School")` / `(label "Education History")` with a stray year committed
 * into the school combobox.
 *
 * The wrapper's `data-field-path` is the one anchor the DOM does give us,
 * and inside it these shapes are unambiguous. Scoping to the wrapper also
 * stops a second education entry ("+ Add Education") from stealing the
 * first entry's controls.
 *
 * Ashby-shaped but kept here rather than in the adapter because the control
 * that resolves it is the SHARED locator ladder, which both the ashby-local
 * combobox/verify path and the delegated generic fill go through.
 */
const EDUCATION_SUB_RE =
  /^(?<base>.*_systemfield_education_history)-(?<part>school|startDate|endDate)(?:-(?<unit>month|year))?$/;

/** True when this field id names a sub-control of the education block. */
export function isEducationBlockField(fieldId: string): boolean {
  return EDUCATION_SUB_RE.test(fieldId);
}

function cssEsc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Locator for an education sub-control, or null when the id is not one (or
 * names a date CONTAINER with no month/year suffix — that is not a control,
 * so the normal tiers should report it honestly rather than guess).
 */
export function educationBlockLocator(
  page: Page,
  fieldId: string,
): Locator | null {
  const groups = EDUCATION_SUB_RE.exec(fieldId)?.groups;
  if (!groups) return null;
  const base = groups["base"] ?? "";
  const part = groups["part"] ?? "";
  const unit = groups["unit"];
  // Decide there is a target BEFORE touching the page: a date id with no
  // month/year suffix names the container, which is not a control.
  if (part !== "school" && unit !== "month" && unit !== "year") return null;
  const wrap = page.locator(`[data-field-path="${cssEsc(base)}"]`).first();
  if (part === "school") {
    return wrap
      .locator("input.ashby-application-form-input-autocomplete")
      .first();
  }
  return wrap
    .locator(`[id="${cssEsc(`${base}-${part}`)}"]`)
    .first()
    .locator("select")
    .nth(unit === "month" ? 0 : 1);
}
