import {
  PROFILE_MIRRORED_SCREENER_KEYS,
  SCREENER_QUESTIONS,
  type ProfileDraft,
  type ProfileRow,
// Extension-qualified: tests/unit/onboarding-steps.test.ts imports this
// file, so the repo-root tsconfig (node16 resolution) typechecks it.
} from "../contract.js";
import { draftToRow } from "../profileMapping.js";

/**
 * The onboarding wizard's step registry — the one place that says which
 * step asks for what. Pure (no React, no Supabase) so the coverage gate
 * can prove every engine fact has exactly one step that asks for it.
 *
 * A step edits `fields` (draft keys, the form state), and its save
 * writes `columns` (profile-row columns derived from those fields by
 * draftToRow) plus its `screeners` (registry keys, stored verbatim in
 * user_screener_answers). Documents write their own rows on upload.
 * Steps 9–11 own no draft field either: self-identification is the
 * encrypted RPC store (selfId.ts), the persona is user_personas, and
 * integrations are user_integrations + handoff tasks.
 */

export type StepSlug =
  | "identity"
  | "contact"
  | "education"
  | "experience"
  | "documents"
  | "eligibility"
  | "compensation"
  | "about"
  | "self-id"
  | "persona"
  | "integrations"
  | "preferences"
  | "review";

export type ProfileColumn = Exclude<
  keyof ProfileRow,
  "user_id" | "created_at" | "updated_at" | "onboarding_completed_at" | "onboarding_progress"
>;

export type OnboardingStep = {
  slug: StepSlug;
  title: string;
  fields: readonly (keyof ProfileDraft)[];
  columns: readonly ProfileColumn[];
  screeners: readonly string[];
};

const MIRRORED = new Set<string>(PROFILE_MIRRORED_SCREENER_KEYS);

/** Registry screener keys a step asks, in SCREENER_QUESTIONS order. */
function screenersOn(step: "eligibility" | "compensation"): string[] {
  return SCREENER_QUESTIONS.filter((q) => q.step === step && !MIRRORED.has(q.key)).map(
    (q) => q.key,
  );
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    slug: "identity",
    title: "Identity",
    fields: [
      "legal_first_name",
      "legal_middle_name",
      "legal_last_name",
      "preferred_name",
      "full_name",
      "contact_email",
      "linkedin_url",
      "github_url",
      "portfolio_url",
    ],
    columns: [
      "legal_first_name",
      "legal_middle_name",
      "legal_last_name",
      "preferred_name",
      "full_name",
      "contact_email",
      "linkedin_url",
      "github_url",
      "portfolio_url",
    ],
    screeners: [],
  },
  {
    slug: "contact",
    title: "Contact & address",
    fields: [
      "phone",
      "address_line1",
      "address_line2",
      "location_city",
      "location_region",
      "postal_code",
      "location_country",
    ],
    columns: [
      "phone",
      "address_line1",
      "address_line2",
      "location_city",
      "location_region",
      "postal_code",
      "location_country",
    ],
    screeners: [],
  },
  {
    slug: "education",
    title: "Education",
    fields: [
      "school",
      "degree",
      "field",
      "start_month",
      "start_year",
      "grad_month",
      "grad_year",
      "gpa",
      "additional_fields",
      "more_education",
    ],
    columns: ["education"],
    screeners: [],
  },
  {
    slug: "experience",
    title: "Experience & skills",
    fields: ["current_company", "employment_history", "skills"],
    columns: ["current_company", "employment_history", "skills"],
    screeners: [],
  },
  { slug: "documents", title: "Documents", fields: [], columns: [], screeners: [] },
  {
    slug: "eligibility",
    title: "Work eligibility",
    fields: [
      "work_authorization",
      "needs_sponsorship",
      "open_to_relocation",
      "restrictive_covenants",
    ],
    columns: [
      "work_authorization",
      "needs_sponsorship",
      "open_to_relocation",
      "restrictive_covenants",
    ],
    screeners: screenersOn("eligibility"),
  },
  {
    slug: "compensation",
    title: "Compensation & how-heard",
    fields: ["how_heard", "how_heard_fallbacks"],
    columns: ["how_heard", "how_heard_fallbacks"],
    screeners: screenersOn("compensation"),
  },
  { slug: "about", title: "About you", fields: ["about_me"], columns: ["about_me"], screeners: [] },
  { slug: "self-id", title: "Self-identification", fields: [], columns: [], screeners: [] },
  { slug: "persona", title: "Outreach persona", fields: [], columns: [], screeners: [] },
  { slug: "integrations", title: "Integrations", fields: [], columns: [], screeners: [] },
  {
    slug: "preferences",
    title: "Preferences",
    fields: ["titles", "locations", "remote", "employment_types", "min_salary_usd"],
    columns: ["job_preferences"],
    screeners: [],
  },
  { slug: "review", title: "Review", fields: [], columns: [], screeners: [] },
];

/**
 * Draft keys no step edits: the legacy single-resume/transcript pointers,
 * written only by the old upload helpers. Documents now live as
 * user_documents rows (the documents step).
 */
export const LEGACY_UPLOAD_KEYS = [
  "resume_object_path",
  "resume_filename",
  "transcript_object_path",
  "transcript_filename",
] as const satisfies readonly (keyof ProfileDraft)[];

export function stepBySlug(slug: string | undefined): OnboardingStep | null {
  return ONBOARDING_STEPS.find((s) => s.slug === slug) ?? null;
}

export function stepNumber(slug: StepSlug): number {
  return ONBOARDING_STEPS.findIndex((s) => s.slug === slug) + 1;
}

export function neighbours(slug: StepSlug): { prev: StepSlug | null; next: StepSlug | null } {
  const i = ONBOARDING_STEPS.findIndex((s) => s.slug === slug);
  return {
    prev: i > 0 ? ONBOARDING_STEPS[i - 1]!.slug : null,
    next: i >= 0 && i < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[i + 1]!.slug : null,
  };
}

/** Where "/onboarding" lands: the saved resume-later step, else step 1. */
export function resumeSlug(progress: { step: string } | null): StepSlug {
  return stepBySlug(progress?.step)?.slug ?? "identity";
}

export function pickDraft(
  draft: ProfileDraft,
  keys: readonly (keyof ProfileDraft)[],
): Partial<ProfileDraft> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = draft[k];
  return out as unknown as Partial<ProfileDraft>;
}

export function pickAnswers(
  all: Record<string, string>,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, all[k] ?? ""]));
}

/**
 * The profile-row patch a step's save writes: exactly its own columns,
 * mapped the same way the full row is. Never onboarding_completed_at
 * (only complete_my_onboarding() stamps that) and never the progress
 * pointer (saveOnboardingProgress owns it).
 */
export function stepPatch(
  step: OnboardingStep,
  draft: ProfileDraft,
): Partial<Omit<ProfileRow, "user_id" | "created_at" | "updated_at" | "onboarding_completed_at">> {
  const row = draftToRow("", draft);
  const patch: Record<string, unknown> = {};
  for (const c of step.columns) patch[c] = row[c];
  return patch as unknown as Partial<ProfileRow>;
}

/**
 * Screener rows for a step's save. A blank answer is kept (as "") so the
 * data layer deletes the stored row — blank means "ask me per
 * application", never an empty string typed onto a form.
 */
export function screenerRows(
  step: OnboardingStep,
  answers: Record<string, string>,
): Array<{ key: string; kind: "registry"; answer: string }> {
  return step.screeners.map((key) => ({ key, kind: "registry", answer: answers[key] ?? "" }));
}
