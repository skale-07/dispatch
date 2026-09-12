import {
  EMPTY_EDUCATION_ENTRY,
  EMPTY_EMPLOYMENT_ENTRY,
  EMPTY_PROFILE,
  type EducationDraft,
  type EducationEntry,
  type EmploymentDraft,
  type EmploymentEntry,
  type JobPreferences,
  type ProfileDraft,
  type ProfileRow,
// Extension-qualified: the repo-root tsconfig typechecks this file under
// node16 resolution when tests/unit/onboarding-steps.test.ts imports it.
} from "./contract.js";

/**
 * Profile row ⇄ wizard draft mapping. Pure on purpose — no Supabase
 * client, no DOM — so node tests and the onboarding step registry
 * (onboarding/steps.ts) can import it; data.ts does the I/O.
 */

export function splitList(commaSeparated: string): string[] {
  return commaSeparated
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function yearOrNull(text: string): number | null {
  return /^\d{4}$/.test(text.trim()) ? Number(text.trim()) : null;
}

function educationToDraft(e: EducationEntry): EducationDraft {
  return {
    ...EMPTY_EDUCATION_ENTRY,
    school: e.school ?? "",
    degree: e.degree ?? "",
    field: e.field ?? "",
    grad_year: e.end_year != null ? String(e.end_year) : "",
    grad_month: e.end_month ?? "",
    start_year: e.start_year != null ? String(e.start_year) : "",
    start_month: e.start_month ?? "",
    gpa: e.gpa != null ? String(e.gpa) : "",
    additional_fields: e.additional_fields ?? "",
  };
}

function employmentToDraft(e: EmploymentEntry): EmploymentDraft {
  return {
    ...EMPTY_EMPLOYMENT_ENTRY,
    company: e.company ?? "",
    title: e.title ?? "",
    location: e.location ?? "",
    start_month: e.start_month ?? "",
    start_year: e.start_year != null ? String(e.start_year) : "",
    end_month: e.end_month ?? "",
    end_year: e.end_year != null ? String(e.end_year) : "",
    current: e.current === true,
    summary: e.summary ?? "",
  };
}

export function rowToDraft(row: ProfileRow): ProfileDraft {
  const edu: EducationEntry | undefined = row.education[0];
  const prefs = row.job_preferences as Partial<JobPreferences>;
  return {
    ...EMPTY_PROFILE,
    full_name: row.full_name ?? "",
    legal_first_name: row.legal_first_name ?? "",
    legal_middle_name: row.legal_middle_name ?? "",
    legal_last_name: row.legal_last_name ?? "",
    preferred_name: row.preferred_name ?? "",
    contact_email: row.contact_email ?? "",
    address_line1: row.address_line1 ?? "",
    address_line2: row.address_line2 ?? "",
    postal_code: row.postal_code ?? "",
    how_heard: row.how_heard ?? "",
    how_heard_fallbacks: (row.how_heard_fallbacks ?? []).join(", "),
    restrictive_covenants: row.restrictive_covenants ?? "",
    skills: (row.skills ?? []).join(", "),
    more_education: (Array.isArray(row.education) ? row.education.slice(1) : []).map(
      educationToDraft,
    ),
    employment_history: (Array.isArray(row.employment_history)
      ? row.employment_history
      : []
    ).map(employmentToDraft),
    phone: row.phone ?? "",
    location_city: row.location_city ?? "",
    location_region: row.location_region ?? "",
    location_country: row.location_country ?? "",
    linkedin_url: row.linkedin_url ?? "",
    github_url: row.github_url ?? "",
    portfolio_url: row.portfolio_url ?? "",
    school: edu?.school ?? "",
    degree: edu?.degree ?? "",
    field: edu?.field ?? "",
    grad_year: edu?.end_year != null ? String(edu.end_year) : "",
    grad_month: edu?.end_month ?? "",
    start_year: edu?.start_year != null ? String(edu.start_year) : "",
    start_month: edu?.start_month ?? "",
    gpa: edu?.gpa != null ? String(edu.gpa) : "",
    additional_fields: edu?.additional_fields ?? "",
    work_authorization: row.work_authorization ?? "",
    needs_sponsorship:
      row.needs_sponsorship === null ? "" : row.needs_sponsorship ? "yes" : "no",
    about_me: row.about_me ?? "",
    current_company: row.current_company ?? "",
    open_to_relocation:
      row.open_to_relocation === null
        ? ""
        : row.open_to_relocation
          ? "yes"
          : "no",
    resume_object_path: row.resume_object_path,
    resume_filename: row.resume_filename,
    transcript_object_path: row.transcript_object_path,
    transcript_filename: row.transcript_filename,
    titles: (prefs.titles ?? []).join(", "),
    locations: (prefs.locations ?? []).join(", "),
    remote: prefs.remote ?? "",
    employment_types: prefs.employment_types ?? [],
    min_salary_usd:
      typeof prefs.min_salary_usd === "number" ? String(prefs.min_salary_usd) : "",
  };
}

function educationEntryFromDraft(d: EducationDraft): EducationEntry | null {
  if (!d.school.trim()) return null;
  const gpa = Number(d.gpa.trim());
  return {
    school: d.school.trim(),
    degree: d.degree.trim(),
    field: d.field.trim(),
    start_year: yearOrNull(d.start_year),
    end_year: yearOrNull(d.grad_year),
    // Optional keys are omitted rather than written empty: the engine's
    // take() treats "" as absent anyway, and an absent key reads as "not
    // asked" instead of "answered blank".
    ...(Number.isFinite(gpa) && gpa > 0 ? { gpa } : {}),
    ...(d.start_month.trim() ? { start_month: d.start_month.trim() } : {}),
    ...(d.grad_month.trim() ? { end_month: d.grad_month.trim() } : {}),
    ...(d.additional_fields.trim()
      ? { additional_fields: d.additional_fields.trim() }
      : {}),
  };
}

function employmentEntryFromDraft(d: EmploymentDraft): EmploymentEntry | null {
  if (!d.company.trim() && !d.title.trim()) return null;
  return {
    company: d.company.trim(),
    title: d.title.trim(),
    ...(d.location.trim() ? { location: d.location.trim() } : {}),
    ...(d.start_month.trim() ? { start_month: d.start_month.trim() } : {}),
    start_year: yearOrNull(d.start_year),
    ...(d.end_month.trim() ? { end_month: d.end_month.trim() } : {}),
    end_year: yearOrNull(d.end_year),
    ...(d.current ? { current: true } : {}),
    ...(d.summary.trim() ? { summary: d.summary.trim() } : {}),
  };
}

export function draftToRow(
  userId: string,
  draft: ProfileDraft,
): Omit<ProfileRow, "created_at" | "updated_at" | "onboarding_completed_at"> {
  // education[0] is the PRIMARY entry (the flat draft keys); additional
  // schools follow in the order the user listed them.
  const primary = educationEntryFromDraft({
    school: draft.school,
    degree: draft.degree,
    field: draft.field,
    grad_year: draft.grad_year,
    grad_month: draft.grad_month,
    start_year: draft.start_year,
    start_month: draft.start_month,
    gpa: draft.gpa,
    additional_fields: draft.additional_fields,
  });
  const education: EducationEntry[] = [
    ...(primary ? [primary] : []),
    ...draft.more_education
      .map(educationEntryFromDraft)
      .filter((e): e is EducationEntry => e !== null),
  ];
  const employment_history: EmploymentEntry[] = draft.employment_history
    .map(employmentEntryFromDraft)
    .filter((e): e is EmploymentEntry => e !== null);
  const legalFirst = draft.legal_first_name.trim();
  const legalLast = draft.legal_last_name.trim();
  // The greeting name follows the legal name once that is filled in;
  // until then it is whatever the user typed as full_name.
  const fullName =
    legalFirst && legalLast ? `${legalFirst} ${legalLast}` : draft.full_name.trim();
  const salary = Number(draft.min_salary_usd.replace(/[^0-9]/g, ""));
  const job_preferences: JobPreferences = {
    titles: splitList(draft.titles),
    locations: splitList(draft.locations),
    ...(draft.remote !== "" ? { remote: draft.remote } : {}),
    employment_types: draft.employment_types,
    ...(salary > 0 ? { min_salary_usd: salary } : {}),
  };
  return {
    user_id: userId,
    full_name: fullName || null,
    legal_first_name: legalFirst || null,
    legal_middle_name: draft.legal_middle_name.trim() || null,
    legal_last_name: legalLast || null,
    preferred_name: draft.preferred_name.trim() || null,
    contact_email: draft.contact_email.trim().toLowerCase() || null,
    address_line1: draft.address_line1.trim() || null,
    address_line2: draft.address_line2.trim() || null,
    postal_code: draft.postal_code.trim() || null,
    how_heard: draft.how_heard.trim() || null,
    how_heard_fallbacks: splitList(draft.how_heard_fallbacks),
    // "" stays null: an unanswered non-compete question is not a "no".
    restrictive_covenants:
      draft.restrictive_covenants === "" ? null : draft.restrictive_covenants,
    skills: splitList(draft.skills),
    employment_history,
    onboarding_progress: null, // owned by saveOnboardingProgress
    phone: draft.phone.trim() || null,
    location_city: draft.location_city.trim() || null,
    location_region: draft.location_region.trim() || null,
    location_country: draft.location_country.trim() || null,
    linkedin_url: draft.linkedin_url.trim() || null,
    github_url: draft.github_url.trim() || null,
    portfolio_url: draft.portfolio_url.trim() || null,
    education,
    work_authorization:
      draft.work_authorization === "" ? null : draft.work_authorization,
    needs_sponsorship:
      draft.needs_sponsorship === "" ? null : draft.needs_sponsorship === "yes",
    about_me: draft.about_me.trim() || null,
    current_company: draft.current_company.trim() || null,
    // "" stays null: an unanswered relocation question is not a "no".
    open_to_relocation:
      draft.open_to_relocation === "" ? null : draft.open_to_relocation === "yes",
    resume_object_path: draft.resume_object_path,
    resume_filename: draft.resume_filename,
    // Legacy pointers (read fallback for one release); documents now live
    // as user_documents rows and no step writes these columns.
    resume_uploaded_at: null,
    transcript_object_path: draft.transcript_object_path,
    transcript_filename: draft.transcript_filename,
    transcript_uploaded_at: null,
    job_preferences,
  };
}
