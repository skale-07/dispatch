import { z } from "zod";

export const publicProfileSchema = z.object({
  legal_name: z.object({
    first: z.string(),
    middle: z.string().optional().default(""),
    last: z.string(),
  }),
  preferred_name: z.string().optional().default(""),
  email: z.string().email().or(z.literal("")).or(z.string()),
  phone: z.string().optional().default(""),
  address: z
    .object({
      line1: z.string().optional().default(""),
      line2: z.string().optional().default(""),
      city: z.string().optional().default(""),
      state: z.string().optional().default(""),
      postal_code: z.string().optional().default(""),
      country: z.string().optional().default("United States"),
    })
    .optional(),
  school: z.string().optional().default(""),
  degree: z.string().optional().default(""),
  major: z.string().optional().default(""),
  additional_fields_of_study: z.array(z.string()).optional().default([]),
  graduation_month: z.string().optional().default(""),
  graduation_year: z.union([z.number(), z.string(), z.null()]).optional(),
  /** Education start (optional; empty = field skipped, never invented). */
  start_month: z.string().optional().default(""),
  start_year: z.union([z.number(), z.string(), z.null()]).optional(),
  gpa: z.union([z.number(), z.string(), z.null()]).optional(),
  linkedin_url: z.string().optional().default(""),
  github_url: z.string().optional().default(""),
  personal_website: z.string().optional().default(""),
  work_authorization: z.string().optional().default(""),
  requires_sponsorship: z.union([z.string(), z.boolean()]).optional().default(""),
  relocation: z.string().optional().default(""),
  /** "How did you hear about this job?" — operator fact, not invented. */
  how_heard: z.string().optional().default(""),
  /**
   * Restrictive covenants / non-compete yes-no. Empty = leave blank;
   * never invent "No" for applicants who might be bound.
   */
  restrictive_covenants: z.string().optional().default(""),
  /**
   * Current employer / organization (Lever `org`, "Current company").
   * Prefer explicit value; fall back is not invented from employment_history
   * unless the operator puts it here.
   */
  current_company: z.string().optional().default(""),
  /**
   * #73 (operator directive 2026-08-31): skills for Workday-style Skills
   * multiselects, taken from the RESUME's Technical Skills section —
   * operator-owned facts, ordered by prominence (first N get picked).
   */
  skills: z.array(z.string()).optional().default([]),
  employment_history: z.array(z.unknown()).optional().default([]),
  education_history: z.array(z.unknown()).optional().default([]),
});

export type PublicProfile = z.infer<typeof publicProfileSchema>;

/**
 * Structured history entries (operator directive 2026-09-14: "extract my
 * resumes and do this for me"). Workday's My Experience page requires Job
 * Title / Company / dates / Role Description and School / Degree / Field of
 * Study per row; plain-string entries carry none of that. Both arrays stay
 * `unknown` in the profile schema so legacy string entries still parse —
 * these accessors return only the entries that are structured, in order.
 */
// month "" = the candidate gave only a year (M23 wizard rows): the year
// still reaches text/year-only date fields; a Month/Year widget is left
// as a to-do rather than filled with an invented January.
const monthYearSchema = z.object({
  month: z.string().default(""),
  year: z.number().int().min(1950).max(2100),
});
const historyLocationSchema = z.object({
  city: z.string().default(""),
  state: z.string().default(""),
  country: z.string().default(""),
});
export const employmentEntrySchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  location: historyLocationSchema.optional(),
  remote: z.boolean().optional().default(false),
  start: monthYearSchema.optional(),
  end: monthYearSchema.nullable().optional(),
  current: z.boolean().optional().default(false),
  description: z.string().optional().default(""),
});
export const educationEntrySchema = z.object({
  school: z.string().min(1),
  degree: z.string().optional().default(""),
  field_of_study: z.string().optional().default(""),
  additional_fields_of_study: z.array(z.string()).optional().default([]),
  location: historyLocationSchema.optional(),
  start: monthYearSchema.optional(),
  end: monthYearSchema.nullable().optional(),
  current: z.boolean().optional().default(false),
  gpa: z.number().optional(),
  gpa_scale: z.number().optional(),
});
export type EmploymentEntry = z.infer<typeof employmentEntrySchema>;
export type EducationEntry = z.infer<typeof educationEntrySchema>;

export function structuredEmploymentHistory(profile: PublicProfile): EmploymentEntry[] {
  const out: EmploymentEntry[] = [];
  for (const raw of profile.employment_history) {
    const parsed = employmentEntrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function structuredEducationHistory(profile: PublicProfile): EducationEntry[] {
  const out: EducationEntry[] = [];
  for (const raw of profile.education_history) {
    const parsed = educationEntrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parsePublicProfile(data: unknown): PublicProfile {
  return publicProfileSchema.parse(data);
}

/** Today as MM/DD/YYYY — the shape US application signature blocks expect (#226). */
export function todayUsDate(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${now.getFullYear()}`;
}

/** Resolve dotted canonical keys like legal_name.first from the profile. */
export function getProfileValue(
  profile: PublicProfile,
  canonical: string,
): unknown {
  if (canonical === "legal_name.first") return profile.legal_name.first;
  if (canonical === "legal_name.last") return profile.legal_name.last;
  if (canonical === "legal_name.middle") return profile.legal_name.middle ?? "";
  if (canonical === "email") return profile.email;
  if (canonical === "phone") return profile.phone;
  if (canonical === "school") return profile.school;
  if (canonical === "degree") return profile.degree;
  if (canonical === "major") return profile.major;
  if (canonical === "graduation_year") return profile.graduation_year;
  if (canonical === "graduation_month") return profile.graduation_month;
  if (canonical === "start_year") return profile.start_year;
  if (canonical === "start_month") return profile.start_month;
  if (canonical === "gpa") return profile.gpa;
  if (canonical === "linkedin_url") return profile.linkedin_url;
  if (canonical === "github_url") return profile.github_url;
  if (canonical === "personal_website") return profile.personal_website;
  if (canonical === "work_authorization") return profile.work_authorization;
  if (canonical === "requires_sponsorship") return profile.requires_sponsorship;
  if (canonical === "relocation") return profile.relocation;
  if (canonical === "how_heard") return profile.how_heard;
  if (canonical === "restrictive_covenants") return profile.restrictive_covenants;
  if (canonical === "preferred_name") return profile.preferred_name;
  if (canonical === "current_company") return profile.current_company ?? "";
  if (canonical === "skills") return profile.skills;
  // #226 (operator 2026-09-09: "it couldn't complete a question that asked
  // to plug in today's date"). Acknowledgement/signature blocks ask for a
  // name and the date the applicant signs — both are facts, not answers to
  // invent, so they resolve deterministically here rather than parking for
  // a human. US M/D/YYYY: every ATS seen so far renders these next to a
  // US-format hint, and a date typed as text is compared as text.
  if (canonical === "signature_date") return todayUsDate();
  if (canonical === "signature_name") {
    return [profile.legal_name.first, profile.legal_name.last]
      .filter((p) => String(p ?? "").trim().length > 0)
      .join(" ");
  }

  const parts = canonical.split(".");
  let cur: unknown = profile;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
