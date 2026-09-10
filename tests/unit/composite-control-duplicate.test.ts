import { describe, expect, it } from "vitest";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";

const profile = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  school: "Johns Hopkins University",
});

function mapped(
  partial: Partial<MappedField> & Pick<MappedField, "id" | "label" | "type">,
): MappedField {
  return {
    required: false,
    name: "",
    canonical_field: null,
    mapping_confidence: "none",
    ...partial,
  } as MappedField;
}

/**
 * #239 (live Saronic ashby 2026-09-10, three applications).
 *
 * Ashby's education block exposes ONE datum through two ids: the widget
 * `_systemfield_education_history` ("College/University") and a child
 * input `_systemfield_education_history-school` ("School"). Both map to
 * canonical `school`. The widget fills; by the time the fill reaches the
 * child, the block has re-rendered into its committed state and the child
 * id is gone, so the run ends with a hard
 * `control not found on the page (label "School")` and an otherwise
 * complete application never reaches submit.
 */
describe("composite control duplicates are answered once (UNIT_CONFIRMED)", () => {
  const parent = mapped({
    id: "_systemfield_education_history",
    label: "College/University",
    type: "text",
    canonical_field: "school",
    mapping_confidence: "high",
  });
  const child = mapped({
    id: "_systemfield_education_history-school",
    label: "School",
    type: "text",
    canonical_field: "school",
    mapping_confidence: "high",
  });

  it("fills the parent widget and skips the id-scoped child with a truthful reason", () => {
    const plan = buildFillPlan([parent, child], profile);
    const parentEntry = plan.entries.find((e) => e.field_id === parent.id)!;
    const childEntry = plan.entries.find((e) => e.field_id === child.id)!;

    expect(parentEntry.action).toBe("fill");
    expect(parentEntry.value).toBe("Johns Hopkins University");
    expect(childEntry.action).toBe("skip_empty");
    expect(childEntry.value).toBeNull();
    expect(childEntry.reason).toMatch(/one composite control, answered once/);
    expect(childEntry.reason).toContain("College/University");
  });

  it("needs BOTH the shared canonical and the id-scoping — neither alone collapses a field", () => {
    // Same canonical, unrelated ids: two real controls, both answered.
    const twin = mapped({
      id: "school_name_other",
      label: "School",
      type: "text",
      canonical_field: "school",
      mapping_confidence: "high",
    });
    const a = buildFillPlan([parent, twin], profile);
    expect(a.entries.find((e) => e.field_id === twin.id)!.action).toBe("fill");

    // Id-scoped but a DIFFERENT datum: the child keeps its own answer path.
    const scopedDifferent = mapped({
      id: "_systemfield_education_history-degree",
      label: "Degree",
      type: "text",
      canonical_field: "degree",
      mapping_confidence: "high",
    });
    const b = buildFillPlan([parent, scopedDifferent], profile);
    expect(
      b.entries.find((e) => e.field_id === scopedDifferent.id)!.reason,
    ).not.toMatch(/one composite control/);
  });

  it("an unmapped child is untouched — the rule only fires on a shared canonical", () => {
    const unmappedChild = mapped({
      id: "_systemfield_education_history-note",
      label: "Anything else about your education?",
      type: "text",
    });
    const plan = buildFillPlan([parent, unmappedChild], profile);
    expect(
      plan.entries.find((e) => e.field_id === unmappedChild.id)!.reason,
    ).not.toMatch(/one composite control/);
  });
});
