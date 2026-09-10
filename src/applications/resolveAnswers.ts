import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import type { MappedField } from "./fieldNormalization.js";
import { essayFieldsOnly, isConditionalYesFollowUp } from "./essayDetector.js";
import { isDemographicsField } from "./essayDetector.js";
import {
  getProfileValue,
  type PublicProfile,
} from "../candidate/publicProfile.js";
import {
  getSensitiveValue,
  tryLoadSensitiveProfile,
} from "../candidate/sensitiveProfileIO.js";
import { locationTypeaheadQuery, shouldComposeCityTypeahead } from "./locationQuery.js";
import type { ScreenerResolution } from "../candidate/screenerMatch.js";
import { historyGroupOf, normalizeFieldLabel } from "./fieldNormalization.js";
import {
  consentCanonicalFor,
  isApplicationConsentField,
} from "./consentFields.js";

export type FillPlanAction =
  | "fill"
  | "skip_essay"
  | "skip_demographics"
  | "skip_file"
  | "skip_unmapped"
  | "skip_empty"
  | "review_required";

export type FillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  canonical_field: string | null;
  action: FillPlanAction;
  value: unknown;
  reason: string;
};

export type ResolvedFillPlan = {
  answers: ResolvedApplicationAnswers;
  entries: FillPlanEntry[];
  fillable_count: number;
  skipped_count: number;
  review_required_count: number;
};

function precedingYesNo(entries: FillPlanEntry[]): "yes" | "no" | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (String(e.action).toLowerCase() !== "fill") continue;
    const v = String(e.value ?? "")
      .trim()
      .toLowerCase();
    if (v === "yes" || v === "y" || v === "true") return "yes";
    if (v === "no" || v === "n" || v === "false") return "no";
  }
  return null;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/**
 * Normalize an explicit sponsorship value. Never invents Yes/No for empty input.
 */
function normalizeSponsorship(value: unknown): string | unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && value.trim() === "") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "yes" || s === "y" || s === "true" || s === "1") return "Yes";
    if (s === "no" || s === "n" || s === "false" || s === "0") return "No";
  }
  return value;
}

/**
 * True when the canonical key or visible label is sponsorship / work-authorization.
 */
export function isWorkAuthorizationField(
  canonicalOrLabel: string | null | undefined,
): boolean {
  if (!canonicalOrLabel) return false;
  const s = canonicalOrLabel.trim().toLowerCase();
  if (s === "requires_sponsorship" || s === "work_authorization") return true;
  return /sponsor|work[\s_-]?auth|visa|authorized to work|legally authorized|require sponsorship/.test(
    s,
  );
}

function profileFactMatchingCheckbox(
  label: string,
  profile: PublicProfile,
): string | null {
  const n = normalizeFieldLabel(label);
  if (n.length < 4) return null;
  const facts = [
    profile.major,
    profile.degree,
    ...(profile.additional_fields_of_study ?? []),
  ]
    .map((s) => normalizeFieldLabel(String(s ?? "")))
    .filter((s) => s.length >= 4);
  for (const fact of facts) {
    if (n === fact) return fact;
    if (n.length >= 12 && (n.includes(fact) || fact.includes(n))) return fact;
  }
  return null;
}

/**
 * Build a fill plan from mapped fields + public profile.
 * Never auto-fills essays. Skips demographics and file fields (uploads are separate).
 * Never defaults empty requires_sponsorship / work_authorization to Yes/No.
 */
export function buildFillPlan(
  mapped: MappedField[],
  profile: PublicProfile,
  opts: {
    /**
     * Screener resolutions for otherwise-unmapped fields, keyed by field
     * id (built by planApplicationFill from the operator's answer bank —
     * see screenerMatch.ts for the accuracy contract). Only consulted on
     * the skip_unmapped branch: profile mappings, essay/demographic/file
     * routing, and every existing behavior are untouched.
     */
    screenerResolutions?: Map<string, ScreenerResolution>;
    /**
     * Essay answers generated from the operator's own about-me context and
     * already validated (essayAutofill.ts), keyed by field id.
     */
    essayAnswers?: Map<string, string>;
    /** Why an essay field has no generated answer — shown on skip_essay. */
    essaySkipReason?: string;
    /** Why an unmapped field has no predict/bank answer — shown on skip_unmapped. */
    unmappedReasons?: Map<string, string>;
  } = {},
): ResolvedFillPlan {
  const essayIds = new Set(
    essayFieldsOnly(mapped)
      .filter((e) => e.is_essay)
      .map((e) => e.field_id),
  );

  const answers: ResolvedApplicationAnswers = {};
  const entries: FillPlanEntry[] = [];

  for (const field of mapped) {
    // #243 (live Shield AI lever 2026-09-10): Lever renders a multi-select
    // question as N checkbox inputs that all share ONE control name, and
    // discovery emits one field per MEMBER. "Which degrees have you
    // already completed" produced 6 identical plan entries and "Are you a
    // member of any of the following student groups" 9 — same id, same
    // label, same planned answer — so the fill attempted the identical
    // write 6 and 9 times, logged 15 identical refusals, and compounded
    // the canonical on every pass
    // (`screener:custom:predicted:cards[…]:cards[…]`).
    //
    // Two fields with the SAME id are the same control by definition. The
    // first entry owns it; the group fill already picks the right member
    // out of the group.
    const sameControl = entries.find((e) => e.field_id === field.id);
    if (sameControl) {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: `duplicate of the same control (${field.id}) — answered once`,
      });
      continue;
    }
    // #239 (live Saronic ashby 2026-09-10, three apps): Ashby's education
    // block exposes ONE datum through two ids — the widget
    // `_systemfield_education_history` (labelled "College/University") and
    // a child input `_systemfield_education_history-school` (labelled
    // "School"). Both map to canonical `school`. The widget fills fine;
    // by the time the fill reaches the child the block has re-rendered
    // into its committed state and the child id is gone, so the run ends
    // `control not found on the page (label "School")` — a hard fill
    // error that blocks an otherwise complete submit.
    //
    // A child id that is the parent's id plus a suffix, carrying the SAME
    // canonical, is the same question asked twice by one composite
    // widget. Answer it once, through the parent. Structural and
    // ATS-general: it needs a shared canonical AND an id that is literally
    // scoped under the earlier control's, so two genuinely different
    // fields can never collapse into one.
    const compositeParent = entries.find(
      (e) =>
        e.canonical_field !== null &&
        e.canonical_field === field.canonical_field &&
        field.id.startsWith(`${e.field_id}-`),
    );
    if (compositeParent) {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: `same datum as "${compositeParent.label}" (${compositeParent.field_id}) — one composite control, answered once`,
      });
      continue;
    }
    if (
      isConditionalYesFollowUp(field.label) &&
      precedingYesNo(entries) === "no"
    ) {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: "conditional follow-up skipped — parent answer is No",
      });
      continue;
    }

    // #150 (live UKG run 17): the resume parse populates the history rows
    // (five work-experience entries, each with its own title/employer/
    // dates). The plan then re-answered them from the ONE profile job and
    // the "Job Title" bank entry — the submit-stage verify refused on 13
    // mismatches against the parsed values. A history row that already
    // holds a value is the resume's own datum: kept. Rows after the first
    // never take a bank/predict answer either (the profile has one job).
    const historyGroup = historyGroupOf(field);
    if (historyGroup) {
      const held = String(field.currentValue ?? "").trim();
      const heldReal =
        held !== "" && !/^(select( one)?|choose|please select|--|—|none)$/i.test(held);
      const screenerHit = opts.screenerResolutions?.get(field.id);
      if (heldReal) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "skip_unmapped",
          value: null,
          reason: `${historyGroup.kind} row ${historyGroup.index} already holds "${held.slice(0, 40)}" (resume parse) — kept`,
        });
        continue;
      }
      if (historyGroup.index >= 1 && !field.canonical_field && screenerHit?.status === "fill") {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: null,
          action: "skip_unmapped",
          value: null,
          reason: `${historyGroup.kind} row ${historyGroup.index} — the profile holds one entry; not answered from the bank`,
        });
        continue;
      }
    }

    if (essayIds.has(field.id) || field.type === "textarea") {
      const generated = opts.essayAnswers?.get(field.id);
      if (generated) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: `essay:generated:${field.id}`,
          action: "fill",
          value: generated,
          reason: "Essay generated from the operator's about-me context",
        });
        continue;
      }
      // #100 (live tiaa page 7): Workday renders NUMBER boxes as
      // textareas — "What is your cumulative GPA?" (canonical gpa) and
      // "What is your GPA in your major?" (bank screener) were
      // skip_essay'd here on every run, upstream of the #87 approval
      // rescue that only ever sees action:"fill". A SHORT factual
      // answer (safe factual canonical, or a resolved screener fill)
      // is a fact, not an essay: fall through to normal resolution.
      // (getProfileValue only answers public-profile facts; the approval
      // layer's SAFE_FACTUAL allowlist stays the strict authority —
      // importing the Set here would cycle with approvedFillPlan.)
      const screenerHit = opts.screenerResolutions?.get(field.id);
      const profileFact = field.canonical_field
        ? getProfileValue(profile, field.canonical_field)
        : undefined;
      const shortFactAvailable =
        (!isEmptyValue(profileFact) && String(profileFact).length <= 80) ||
        (screenerHit?.status === "fill" &&
          String(screenerHit.value ?? "").length <= 80 &&
          !isEmptyValue(screenerHit.value));
      if (!shortFactAvailable) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "skip_essay",
          value: null,
          reason: opts.essaySkipReason ?? "Essay generation produced no answer",
        });
        continue;
      }
    }

    if (isDemographicsField(field)) {
      const sensitive = tryLoadSensitiveProfile();
      const demoCanon = field.canonical_field;
      let demValue: unknown = undefined;
      if (sensitive && demoCanon) {
        demValue = getSensitiveValue(sensitive, demoCanon);
      }
      if (!sensitive || !demoCanon || isEmptyValue(demValue)) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "skip_demographics",
          value: null,
          reason: "Demographics deferred to sensitive-profile policy path",
        });
        continue;
      }
      answers[demoCanon] = demValue;
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: demoCanon,
        action: "fill",
        value: demValue,
        reason: "Mapped from sensitive profile (operator-supplied)",
      });
      continue;
    }

    if (field.type === "file") {
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_file",
        value: null,
        reason: "File uploads handled via uploadResume/uploadCoverLetter",
      });
      continue;
    }

    if (isApplicationConsentField(field)) {
      const canonical = consentCanonicalFor(field.id);
      answers[canonical] = true;
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: canonical,
        action: "fill",
        value: true,
        reason: "Application terms/confirmation checkbox",
      });
      continue;
    }

    if (field.type === "checkbox") {
      const fact = profileFactMatchingCheckbox(field.label, profile);
      if (fact) {
        const canonical = `screener:custom:profile_fact:${field.id}`;
        answers[canonical] = true;
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: canonical,
          action: "fill",
          value: true,
          reason: `Checkbox matches profile fact (${fact})`,
        });
        continue;
      }
    }

    if (!field.canonical_field) {
      const screener = opts.screenerResolutions?.get(field.id);
      // #71 (live tiaa #22t): the predict tier answered a PREFILLED
      // "Phone Device Type" select ("Mobile" already committed on the
      // form) with country-code nonsense. Prediction exists for
      // UNANSWERED fields; a select that already holds a committed
      // non-placeholder value is answered — leave it alone.
      const current = String(field.currentValue ?? "").trim();
      const alreadyAnswered =
        field.type === "select" &&
        current !== "" &&
        !/^(select( one)?|choose|please select|--|—|none)$/i.test(current);
      if (
        screener &&
        screener.status === "fill" &&
        alreadyAnswered &&
        (screener.basis === "llm_predict" || screener.basis === "other_option")
      ) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: null,
          action: "skip_unmapped",
          value: null,
          reason: `already answered on the form ("${current.slice(0, 40)}") — prediction not applied`,
        });
        continue;
      }
      if (screener) {
        const canonical = `screener:${screener.key}`;
        if (screener.status === "fill") {
          // Unique canonical per field: two fields may share a key.
          const unique = canonical in answers ? `${canonical}:${field.id}` : canonical;
          answers[unique] = screener.value;
          entries.push({
            field_id: field.id,
            label: field.label,
            type: field.type,
            canonical_field: unique,
            action: "fill",
            value: screener.value,
            reason:
              screener.basis === "llm_predict" || screener.basis === "other_option"
                ? `Predicted from operator context (${screener.basis})${
                    screener.rationale ? `: ${screener.rationale}` : ""
                  }`
                : `Screener bank answer (${screener.basis})${
                    screener.rationale ? `: ${screener.rationale}` : ""
                  }`,
          });
          continue;
        }
        if (screener.status === "review") {
          entries.push({
            field_id: field.id,
            label: field.label,
            type: field.type,
            canonical_field: canonical,
            action: "review_required",
            value: null,
            reason: screener.reason,
          });
          continue;
        }
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: canonical,
          action: "skip_empty",
          value: null,
          reason: screener.reason,
        });
        continue;
      }
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: null,
        action: "skip_unmapped",
        value: null,
        reason:
          opts.unmappedReasons?.get(field.id) ?? "No answer-alias mapping",
      });
      continue;
    }

    let value = getProfileValue(profile, field.canonical_field);
    if (field.canonical_field === "requires_sponsorship") {
      value = normalizeSponsorship(value);
    }
    if (
      field.canonical_field === "address.city" &&
      typeof value === "string" &&
      shouldComposeCityTypeahead(mapped)
    ) {
      // Lone location typeaheads want "Baltimore, Maryland, USA".
      // Split City/State/Country forms keep the bare city.
      value = locationTypeaheadQuery(
        value,
        profile.address?.state ?? "",
        profile.address?.country ?? "",
      );
    }
    if (
      (field.canonical_field === "graduation_year" ||
        field.canonical_field === "start_year") &&
      value != null
    ) {
      value = String(value);
      // Year-only text boxes stay a year. Seasonal comboboxes (Jump:
      // Winter/Spring/Fall 2029) need the profile month to pick one option.
      if (
        field.canonical_field === "graduation_year" &&
        (field.type === "select" || field.type === "radio" ||
          /graduation.*(?:date|month)|when.*graduat|date.*complete.*degree/i.test(field.label))
      ) {
        const month = (profile.graduation_month ?? "").trim();
        const year = String(value);
        if (month && !/\d{4}/.test(month) && /^(20\d{2}|19\d{2})$/.test(year)) {
          value = `${month} ${year}`;
        }
      }
    }

    if (isEmptyValue(value)) {
      const workAuth =
        isWorkAuthorizationField(field.canonical_field) ||
        isWorkAuthorizationField(field.label);
      if (workAuth && field.required) {
        entries.push({
          field_id: field.id,
          label: field.label,
          type: field.type,
          canonical_field: field.canonical_field,
          action: "review_required",
          value: null,
          reason: `Required ${field.canonical_field} missing from profile — human review`,
        });
        continue;
      }
      entries.push({
        field_id: field.id,
        label: field.label,
        type: field.type,
        canonical_field: field.canonical_field,
        action: "skip_empty",
        value: null,
        reason: `Profile value empty for ${field.canonical_field}`,
      });
      continue;
    }

    answers[field.canonical_field] = value;
    entries.push({
      field_id: field.id,
      label: field.label,
      type: field.type,
      canonical_field: field.canonical_field,
      action: "fill",
      value,
      reason: "Mapped from public profile",
    });
  }

  return {
    answers,
    entries,
    fillable_count: entries.filter((e) => e.action === "fill").length,
    skipped_count: entries.filter(
      (e) => e.action !== "fill" && e.action !== "review_required",
    ).length,
    review_required_count: entries.filter((e) => e.action === "review_required")
      .length,
  };
}

export function fillEntriesForAnswers(plan: ResolvedFillPlan): FillPlanEntry[] {
  return plan.entries.filter((e) => e.action === "fill");
}
