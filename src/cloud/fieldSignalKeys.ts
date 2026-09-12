/**
 * The field-signal vocabulary (supabase/migrations/20260911000900), mirrored
 * engine-side so the drift tests can hold the two in lockstep and the
 * signals push (`cloud:sync`) can filter BEFORE a row ever reaches the
 * database's own whitelist.
 *
 * Kept free of imports: the frontend's ranking module and the engine's
 * push both read it, and the unit tests need no flag or key.
 */

/**
 * Canonical (profile-backed) field keys the engine maps forms onto — MINUS
 * every demographic canonical. `gender`, `race_ethnicity`, `veteran_status`,
 * `disability_status` and friends exist in the alias file so the fill can
 * recognise them and route them to the opt-in sensitive profile; they are
 * never a signal, because "how popular is this EEO question" must not
 * become a reason to ask it. Equals `canonical_field_keys()` in SQL.
 */
export const CANONICAL_FIELD_KEYS = [
  "legal_name.first",
  "legal_name.middle",
  "legal_name.last",
  "preferred_name",
  "email",
  "phone",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.postal_code",
  "address.country",
  "linkedin_url",
  "github_url",
  "personal_website",
  "school",
  "degree",
  "major",
  "gpa",
  "graduation_month",
  "graduation_year",
  "start_month",
  "start_year",
  "current_company",
  "current_job_title",
  "work_authorization",
  "requires_sponsorship",
  "relocation",
  "how_heard",
  "restrictive_covenants",
] as const;
export type CanonicalFieldKey = (typeof CANONICAL_FIELD_KEYS)[number];

/** What a user's own engine run can say about a field. Equals the SQL CHECK. */
export const FIELD_EVENT_KINDS = [
  "unanswered_required",
  "skip_unmapped",
  "skip_empty_profile",
  "review_item",
  "transcript_required",
  "essay_required",
] as const;
export type FieldEventKind = (typeof FIELD_EVENT_KINDS)[number];

/** Where a suggestion's answer is written. Equals the seeded targets' stores. */
export const SUGGESTION_STORES = [
  "profile",
  "screener",
  "education",
  "employment",
  "documents",
  "integrations",
  "self_id",
] as const;
export type SuggestionStore = (typeof SUGGESTION_STORES)[number];

/** canonical:<key> | screener:<registry key> | label:<12-hex fingerprint> */
export const SIGNAL_KEY_RE = /^(canonical:[a-z0-9_.]+|screener:[a-z0-9_]+|label:[a-f0-9]{12})$/;

export function canonicalSignalKey(key: CanonicalFieldKey): string {
  return `canonical:${key}`;
}
export function screenerSignalKey(registryKey: string): string {
  return `screener:${registryKey}`;
}
export function labelSignalKey(fingerprint12: string): string {
  if (!/^[a-f0-9]{12}$/.test(fingerprint12)) {
    throw new Error("label signal needs a 12-hex fingerprint");
  }
  return `label:${fingerprint12}`;
}
