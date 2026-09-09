import type { DiscoveredField, ResolvedApplicationAnswers } from "../ats/adapter.js";
import { isDemographicsField } from "./essayDetector.js";
import type { FillPlanEntry } from "./resolveAnswers.js";
import { isWorkAuthorizationField } from "./resolveAnswers.js";
import { screenerDef } from "../candidate/screeners.js";
import { isConsentCanonical } from "./consentFields.js";

/** Canonical keys safe to auto-fill from the public profile (factual only). */
export const SAFE_FACTUAL_CANONICALS = new Set([
  "legal_name.first",
  "legal_name.middle",
  "legal_name.last",
  "preferred_name",
  "email",
  "phone",
  "school",
  "degree",
  "major",
  "graduation_year",
  "graduation_month",
  "start_year",
  "start_month",
  "gpa",
  "linkedin_url",
  "github_url",
  "personal_website",
  "relocation",
  "work_authorization",
  "requires_sponsorship",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.postal_code",
  "address.country",
  "how_heard",
  "restrictive_covenants",
  "current_company",
  "skills",
  // #226: acknowledgement/signature blocks. Both are facts the profile or
  // the clock already owns — the applicant's legal name and the date they
  // are signing — so they fill like any other profile value.
  "signature_name",
  "signature_date",
]);

/** Operator-supplied EEO / self-ID values (sensitive profile), never invented. */
export const SENSITIVE_FILL_CANONICALS = new Set([
  "gender_identity",
  "gender",
  "race_ethnicity",
  "sexual_orientation",
  "hispanic_latino",
  "transgender",
  "veteran_status",
  "disability_status",
  "pronouns",
]);

/**
 * screener:<key>[:<field_id>] canonicals are allowlisted iff the key's
 * REGISTRY policy permits filling — the registry is code-reviewed, so this
 * stays a curated allowlist, just sourced from screeners.ts. review_required
 * keys (salary, notice period) are structurally unfillable here too.
 */
export function isScreenerFillCanonical(
  canonical: string | null | undefined,
): boolean {
  if (!canonical?.startsWith("screener:")) return false;
  const segments = canonical.slice("screener:".length).split(":");
  const key = segments[0] ?? "";
  // screener:custom:<key> — human-promoted bank entries, profile-fact
  // checkboxes, and plan-time predictions that already passed
  // validatePrediction (option verbatim, or free-text the model returned).
  if (key === "custom") {
    return (segments[1] ?? "").length >= 2;
  }
  const def = screenerDef(key);
  return def?.policy === "auto_fill" || def?.policy === "skip_if_empty";
}

/** Generated essay answers recorded on the plan (about-me + validateDraft). */
export function isEssayGeneratedCanonical(
  canonical: string | null | undefined,
): boolean {
  return Boolean(canonical?.startsWith("essay:generated:"));
}

export function isAllowlistedCanonical(canonical: string | null | undefined): boolean {
  if (!canonical) return false;
  if (isScreenerFillCanonical(canonical)) return true;
  if (isEssayGeneratedCanonical(canonical)) return true;
  if (isConsentCanonical(canonical)) return true;
  return (
    SAFE_FACTUAL_CANONICALS.has(canonical) ||
    SENSITIVE_FILL_CANONICALS.has(canonical)
  );
}

export type ApprovedFillAction = "FILL" | "SKIP" | "REVIEW_REQUIRED";

export type ApprovedFillPlanEntry = {
  field_id: string;
  label: string;
  type: DiscoveredField["type"];
  canonical_field: string | null;
  action: ApprovedFillAction;
  /** True only when action is FILL and the entry passed policy checks. */
  approved: boolean;
  value: unknown;
  reason: string;
};

export type ApprovedFillPlan = {
  entries: ApprovedFillPlanEntry[];
  answers: ResolvedApplicationAnswers;
  fillable_count: number;
  skipped_count: number;
  review_required_count: number;
};

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/**
 * Promote resolveAnswers plan entries into an approved fill plan.
 * Only safe factual public-profile values get action FILL + approved:true.
 * Essays, demographics, empty sponsorship/work-auth, and unmapped fields are not approved.
 */
export function toApprovedFillPlan(entries: FillPlanEntry[]): ApprovedFillPlan {
  const approvedEntries: ApprovedFillPlanEntry[] = [];
  const answers: ResolvedApplicationAnswers = {};

  for (const entry of entries) {
    if (entry.action === "review_required") {
      approvedEntries.push({
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "REVIEW_REQUIRED",
        approved: false,
        value: null,
        reason: entry.reason,
      });
      continue;
    }

    if (entry.action !== "fill") {
      approvedEntries.push({
        field_id: entry.field_id,
        label: entry.label,
        type: entry.type,
        canonical_field: entry.canonical_field,
        action: "SKIP",
        approved: false,
        value: null,
        reason: entry.reason,
      });
      continue;
    }

    const rejected = rejectFillCandidate(entry);
    if (rejected) {
      approvedEntries.push(rejected);
      continue;
    }

    const canonical = entry.canonical_field as string;
    answers[canonical] = entry.value;
    approvedEntries.push({
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: canonical,
      action: "FILL",
      approved: true,
      value: entry.value,
      reason: entry.reason,
    });
  }

  return {
    entries: approvedEntries,
    answers,
    fillable_count: approvedEntries.filter((e) => e.approved).length,
    skipped_count: approvedEntries.filter((e) => e.action === "SKIP").length,
    review_required_count: approvedEntries.filter(
      (e) => e.action === "REVIEW_REQUIRED",
    ).length,
  };
}

function rejectFillCandidate(entry: FillPlanEntry): ApprovedFillPlanEntry | null {
  if (entry.type === "textarea") {
    if (
      isEssayGeneratedCanonical(entry.canonical_field) &&
      !isEmptyValue(entry.value)
    ) {
      return null;
    }
    // #87 (live stryker ×3, deterministic): Workday renders its NUMBER
    // boxes as textareas — "What is your current cumulative GPA?" was
    // silently SKIPped as "essay/textarea" on every run and the click
    // refused on the unanswered required question. A safe factual
    // canonical (gpa, phone, urls…) with a short value is a fact, not an
    // essay; long values keep the essay gate.
    if (
      entry.canonical_field &&
      SAFE_FACTUAL_CANONICALS.has(entry.canonical_field) &&
      !isEmptyValue(entry.value) &&
      String(entry.value).length <= 80
    ) {
      return null;
    }
    // #100 (live tiaa page 7): "What is your GPA in your major?" is a
    // Workday NUMBER box rendered as a textarea; its answer lives in the
    // operator's screener bank (major_gpa = "3.5"). A SHORT resolved
    // screener answer is a fact, exactly the #87 class — the essay gate
    // is for prose. Long values keep the essay gate; demographics never
    // map to screener canonicals (fenced upstream).
    if (
      entry.canonical_field &&
      isScreenerFillCanonical(entry.canonical_field) &&
      !isEmptyValue(entry.value) &&
      String(entry.value).length <= 80
    ) {
      return null;
    }
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Essay/textarea never approved for auto-fill",
    };
  }

  if (
    isDemographicsField({
      id: entry.field_id,
      label: entry.label,
      type: entry.type,
      required: false,
    })
  ) {
    const demoCanon = entry.canonical_field;
    if (
      demoCanon &&
      SENSITIVE_FILL_CANONICALS.has(demoCanon) &&
      !isEmptyValue(entry.value)
    ) {
      // Value already resolved from sensitive profile — allow.
      return null;
    }
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Demographics not approved without sensitive-profile mapping",
    };
  }

  const canonical = entry.canonical_field;
  if (!canonical || !isAllowlistedCanonical(canonical)) {
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: "SKIP",
      approved: false,
      value: null,
      reason: "Canonical field not in safe factual allowlist",
    };
  }

  if (isEmptyValue(entry.value)) {
    const workAuth =
      isWorkAuthorizationField(canonical) ||
      isWorkAuthorizationField(entry.label);
    return {
      field_id: entry.field_id,
      label: entry.label,
      type: entry.type,
      canonical_field: entry.canonical_field,
      action: workAuth ? "REVIEW_REQUIRED" : "SKIP",
      approved: false,
      value: null,
      reason: workAuth
        ? "Empty sponsorship/work-authorization — not approved; human review"
        : "Empty value not approved for fill",
    };
  }

  return null;
}

export function approvedFillEntries(
  plan: ApprovedFillPlan,
): Array<ApprovedFillPlanEntry & { approved: true; action: "FILL" }> {
  return plan.entries.filter(
    (e): e is ApprovedFillPlanEntry & { approved: true; action: "FILL" } =>
      e.approved === true && e.action === "FILL",
  );
}

/**
 * Runtime guard for the Greenhouse executor — reject anything that is not an
 * approved FILL entry (essays, demographics, unapproved, review-required).
 */
export function assertExecutableApprovedEntry(
  entry: ApprovedFillPlanEntry,
): void {
  if (!entry.approved || entry.action !== "FILL") {
    throw new Error(
      `Refusing fill for ${entry.field_id}: not approved (action=${entry.action})`,
    );
  }
  if (
    entry.type === "textarea" &&
    !isEssayGeneratedCanonical(entry.canonical_field) &&
    // #87/#100 mirror (live tiaa page 7): toApprovedFillPlan approves a
    // SHORT factual answer on a Workday number-box textarea (safe
    // factual canonical, or an operator-bank/validated screener value);
    // this guard kept refusing the same entries at execution. The essay
    // fence stays: no canonical provenance or a long value still throws.
    !(
      entry.canonical_field &&
      (SAFE_FACTUAL_CANONICALS.has(entry.canonical_field) ||
        isScreenerFillCanonical(entry.canonical_field)) &&
      !isEmptyValue(entry.value) &&
      String(entry.value).length <= 80
    )
  ) {
    throw new Error(`Refusing fill for ${entry.field_id}: textarea/essay`);
  }
  if (
    isDemographicsField({
      id: entry.field_id,
      label: entry.label,
      type: entry.type,
      required: false,
    }) &&
    !(
      entry.canonical_field &&
      SENSITIVE_FILL_CANONICALS.has(entry.canonical_field) &&
      !isEmptyValue(entry.value)
    )
  ) {
    throw new Error(`Refusing fill for ${entry.field_id}: demographics`);
  }
  if (
    !entry.canonical_field ||
    !isAllowlistedCanonical(entry.canonical_field)
  ) {
    throw new Error(
      `Refusing fill for ${entry.field_id}: canonical not in safe factual allowlist`,
    );
  }
  if (isEmptyValue(entry.value)) {
    throw new Error(`Refusing fill for ${entry.field_id}: empty value`);
  }
}
