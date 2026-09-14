import type { ApplicationEducationPolicy } from "../candidate/applicationEducation.js";
import { personaSchema, type Persona } from "../candidate/personas.js";
import { parsePublicProfile, type PublicProfile } from "../candidate/publicProfile.js";
import { parseScreenerBank, SCREENER_REGISTRY, type ScreenerAnswerBank } from "../candidate/screeners.js";
import { parseSensitiveProfile, type SensitiveProfile } from "../candidate/sensitiveProfile.js";
import type { CloudDocumentRow, CloudProfileRow, OnboardedUser } from "./syncMapping.js";

/**
 * Cloud rows → the files the engine already reads (plan v0.5, M14). Pure:
 * no I/O, no config, so every mapping is unit-tested and the workspace
 * writer (src/tenants/workspace.ts) only copies bytes.
 *
 * Rules, all inherited from how the operator's own files work:
 *   - NOTHING IS INVENTED. A missing fact is "" (the engine's "skip this
 *     field / ask per application"), never a plausible default.
 *   - Work authorization and sponsorship are the user's OWN wizard
 *     answers. The verbatim wizard label goes on the profile; the yes/no
 *     screener mirror is filled only where the mapping is unambiguous.
 *   - Self-identification is mapped from the RPC plaintext the runner
 *     fetches separately; it never rides in the pull snapshot. answer →
 *     the verbatim value, prefer_not → the decline phrase every board's
 *     option matcher already recognises, skip → "" (blank; a per-
 *     application to-do).
 *   - The persona is whatever the engine's own personaSchema accepts;
 *     anything less is "no persona" with the reason, never a generic email.
 */

export const WORK_AUTH_LABELS: Record<string, string> = {
  us_citizen: "U.S. citizen",
  permanent_resident: "Permanent resident (green card)",
  visa_holder: "Visa holder",
  needs_sponsorship: "Will need sponsorship",
  other: "Other",
};

/** The engine's decline option for a self-ID question the user declines. */
export const DECLINE_TO_SELF_IDENTIFY = "Decline to self-identify";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((x) => x !== "") : [];
const yesNo = (v: unknown): "Yes" | "No" | "" => (v === true ? "Yes" : v === false ? "No" : "");
const lowerYesNo = (v: unknown): "yes" | "no" | "" => (v === true ? "yes" : v === false ? "no" : "");
const numOrStr = (v: unknown): number | string | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() ? v.trim() : null;

type EducationEntry = {
  school?: unknown;
  degree?: unknown;
  field?: unknown;
  start_year?: unknown;
  end_year?: unknown;
  gpa?: unknown;
  start_month?: unknown;
  end_month?: unknown;
  additional_fields?: unknown;
};

function primaryEducation(row: CloudProfileRow): EducationEntry {
  return Array.isArray(row.education) && row.education[0] && typeof row.education[0] === "object"
    ? (row.education[0] as EducationEntry)
    : {};
}

/* ── M23: wizard history rows → the engine's structured entries ──────── */

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Sep" / "september" / "9" → "September"; anything else → "" (never a guess). */
export function canonicalMonth(v: unknown): string {
  const t = str(v).toLowerCase().replace(/\./g, "");
  if (!t) return "";
  if (/^\d{1,2}$/.test(t)) {
    const n = Number(t);
    return n >= 1 && n <= 12 ? MONTH_NAMES[n - 1]! : "";
  }
  return MONTH_NAMES.find((m) => m.toLowerCase().startsWith(t.slice(0, 3))) ?? "";
}

const yearInt = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : /^\d{4}$/.test(str(v)) ? Number(str(v)) : NaN;
  return Number.isInteger(n) && n >= 1950 && n <= 2100 ? n : null;
};

/** {month, year} when the row has a year; a month without a year is nothing (the engine's date schema needs the year). */
function monthYear(month: unknown, year: unknown): { month: string; year: number } | undefined {
  const y = yearInt(year);
  return y === null ? undefined : { month: canonicalMonth(month), year: y };
}

type HomeLocation = { city: string; state: string; country: string };

/**
 * "Baltimore, MD" / "Columbus, Ohio, United States" / "Remote" → the
 * engine's location object. An unknown or remote location takes the
 * candidate's HOME city (operator 2026-09-14: "if you don't know location
 * assume Baltimore, Maryland" — i.e. their own), because Workday's
 * location field is required per row and the home city is the honest
 * answer for where a remote or unlocated role was worked from.
 */
export function historyLocation(text: unknown, home: HomeLocation): HomeLocation {
  const t = str(text);
  if (!t || /^(?:remote|work from home|wfh)$/i.test(t)) return { ...home };
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  const city = parts[0] ?? "";
  const state = parts[1] ?? "";
  const country = parts[2] ?? (state ? home.country : "");
  return { city, state, country };
}

type WizardEmployment = {
  company?: unknown; title?: unknown; location?: unknown; remote?: unknown;
  start_month?: unknown; start_year?: unknown; end_month?: unknown; end_year?: unknown;
  current?: unknown; summary?: unknown; description?: unknown;
};
type WizardEducation = {
  school?: unknown; degree?: unknown; field?: unknown; additional_fields?: unknown;
  start_month?: unknown; start_year?: unknown; end_month?: unknown; end_year?: unknown; gpa?: unknown;
};

/** A wizard employment row → employmentEntrySchema input; null without a company (the engine's row needs one). */
export function toEngineEmployment(raw: unknown, home: HomeLocation): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as WizardEmployment;
  const company = str(e.company);
  const title = str(e.title);
  if (!company || !title) return null;
  const current = e.current === true;
  const start = monthYear(e.start_month, e.start_year);
  const end = current ? null : monthYear(e.end_month, e.end_year);
  return {
    company,
    title,
    location: historyLocation(e.location, home),
    remote: e.remote === true || /^(?:remote|work from home|wfh)$/i.test(str(e.location)),
    ...(start ? { start } : {}),
    ...(end !== undefined ? { end } : {}),
    current,
    description: str(e.summary) || str(e.description),
  };
}

/** A wizard education row → educationEntrySchema input; null without a school. */
export function toEngineEducation(raw: unknown, home: HomeLocation): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as WizardEducation;
  const school = str(e.school);
  if (!school) return null;
  const start = monthYear(e.start_month, e.start_year);
  const end = monthYear(e.end_month, e.end_year);
  const gpa = typeof e.gpa === "number" ? e.gpa : Number(str(e.gpa));
  const endYear = yearInt(e.end_year);
  return {
    school,
    degree: str(e.degree),
    field_of_study: str(e.field),
    additional_fields_of_study: str(e.additional_fields).split(",").map((s) => s.trim()).filter(Boolean),
    location: historyLocation(undefined, home),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    // Still enrolled = the graduation year is in the future (an expected date).
    current: endYear !== null && endYear > new Date().getUTCFullYear(),
    ...(Number.isFinite(gpa) && gpa > 0 ? { gpa } : {}),
  };
}

/** Legal first/last from the wizard; the greeting name is only a fallback split. */
function legalName(row: CloudProfileRow): { first: string; middle: string; last: string } {
  const first = str(row.legal_first_name);
  const last = str(row.legal_last_name);
  if (first || last) return { first, middle: str(row.legal_middle_name), last };
  const parts = str(row.full_name).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", middle: "", last: "" };
  return { first: parts[0]!, middle: "", last: parts.slice(1).join(" ") };
}

/** public-profile.json — validated by the engine's own schema before it is returned. */
export function toPublicProfile(user: OnboardedUser): PublicProfile {
  const row = user.profile;
  const edu = primaryEducation(row);
  const additional = str(edu.additional_fields)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const home: HomeLocation = {
    city: str(row.location_city),
    state: str(row.location_region),
    country: str(row.location_country),
  };
  const candidate = {
    legal_name: legalName(row),
    preferred_name: str(row.preferred_name),
    email: str(row.contact_email) || str(user.email),
    phone: str(row.phone),
    address: {
      line1: str(row.address_line1),
      line2: str(row.address_line2),
      city: str(row.location_city),
      state: str(row.location_region),
      postal_code: str(row.postal_code),
      // "" on purpose: the schema's "United States" default applies only
      // to an ABSENT key, and an unknown country is not an American one.
      country: str(row.location_country),
    },
    school: str(edu.school),
    degree: str(edu.degree),
    major: str(edu.field),
    additional_fields_of_study: additional,
    graduation_month: str(edu.end_month),
    graduation_year: numOrStr(edu.end_year),
    start_month: str(edu.start_month),
    start_year: numOrStr(edu.start_year),
    gpa: numOrStr(edu.gpa),
    linkedin_url: str(row.linkedin_url),
    github_url: str(row.github_url),
    personal_website: str(row.portfolio_url),
    work_authorization: row.work_authorization ? (WORK_AUTH_LABELS[row.work_authorization] ?? str(row.work_authorization)) : "",
    requires_sponsorship: lowerYesNo(row.needs_sponsorship),
    relocation: lowerYesNo(row.open_to_relocation),
    how_heard: str(row.how_heard),
    restrictive_covenants: row.restrictive_covenants === "yes" || row.restrictive_covenants === "no" ? row.restrictive_covenants : "",
    current_company: str(row.current_company),
    skills: strList(row.skills),
    // M23: wizard rows are mapped to the engine's structured entries
    // (historyRows.ts / Workday My Experience); a row the schema cannot
    // take (no company, no title) is left out rather than half-filled.
    employment_history: (Array.isArray(row.employment_history) ? row.employment_history : [])
      .map((r) => toEngineEmployment(r, home))
      .filter((r): r is Record<string, unknown> => r !== null),
    education_history: (Array.isArray(row.education) ? row.education : [])
      .map((r) => toEngineEducation(r, home))
      .filter((r): r is Record<string, unknown> => r !== null),
  };
  return parsePublicProfile(candidate);
}

/**
 * The yes/no screener mirrors of profile facts, filled only where the
 * wizard answer maps without a guess. "Are you authorized to work in the
 * US?" is Yes for a citizen or permanent resident; a visa holder's or a
 * sponsorship-needing applicant's authorization TODAY is not knowable
 * from the wizard, so those stay blank (per-application to-do).
 */
export function mirroredScreenerAnswers(row: CloudProfileRow): Record<string, string> {
  const out: Record<string, string> = {};
  if (row.work_authorization === "us_citizen" || row.work_authorization === "permanent_resident") {
    out["work_authorization"] = "Yes";
  }
  const spons = yesNo(row.needs_sponsorship);
  if (spons) out["requires_sponsorship"] = spons;
  const reloc = yesNo(row.open_to_relocation);
  if (reloc) out["willing_to_relocate"] = reloc;
  if (str(row.how_heard)) out["how_heard"] = str(row.how_heard);
  if (row.restrictive_covenants === "yes") out["non_compete"] = "Yes";
  if (row.restrictive_covenants === "no") out["non_compete"] = "No";
  return out;
}

/** screeners.json — the user's own bank plus the profile mirrors, parsed by the engine's parser. */
export function toScreenerBank(user: OnboardedUser): ScreenerAnswerBank {
  const registryKeys = new Set(SCREENER_REGISTRY.map((d) => d.key));
  const answers: Record<string, string> = { ...mirroredScreenerAnswers(user.profile) };
  const custom: Record<string, { answer: string; labels: string[]; promoted_at: string }> = {};
  for (const a of user.screenerAnswers) {
    const answer = str(a.answer);
    if (!answer) continue;
    if (a.kind === "registry" && registryKeys.has(a.key)) {
      // An explicit bank answer beats a mirror (the user typed it for this key).
      answers[a.key] = answer;
    } else if (a.kind === "custom" && !registryKeys.has(a.key)) {
      const labels = strList(a.labels);
      // promoted_at: when the user answered it (the wizard/suggestion row's
      // timestamp) — the engine's promote resolver stamps the same field.
      if (labels.length > 0) custom[a.key] = { answer, labels, promoted_at: str(a.updated_at) };
    }
  }
  return parseScreenerBank({ version: 1, answers, custom });
}

/**
 * about-me.md: the narrative in the user's words, then a generated
 * "Application facts" section built ONLY from facts present on the row or
 * in the bank (authorization, sponsorship, relocation, salary, notice,
 * start availability, location, graduation, current employer). null when
 * there is nothing at all to write.
 */
export function toAboutMe(user: OnboardedUser): string | null {
  const row = user.profile;
  const bank = new Map(user.screenerAnswers.map((a) => [a.key, str(a.answer)] as const));
  const facts: string[] = [];
  const add = (label: string, value: string): void => {
    if (value) facts.push(`- ${label}: ${value}`);
  };
  add("Work authorization", row.work_authorization ? (WORK_AUTH_LABELS[row.work_authorization] ?? row.work_authorization) : "");
  add("Needs visa sponsorship", yesNo(row.needs_sponsorship));
  add("Open to relocation", yesNo(row.open_to_relocation));
  add("Location", [row.location_city, row.location_region, row.location_country].map(str).filter(Boolean).join(", "));
  const edu = primaryEducation(row);
  add(
    "Education",
    [str(edu.degree), str(edu.field), str(edu.school)].filter(Boolean).join(", ") +
      (numOrStr(edu.end_year) !== null ? ` (graduating ${[str(edu.end_month), String(numOrStr(edu.end_year))].filter(Boolean).join(" ")})` : ""),
  );
  add("Current employer", str(row.current_company));
  add("Salary expectations", bank.get("salary_expectations") ?? "");
  add("Notice period", bank.get("notice_period") ?? "");
  add("Earliest start", bank.get("start_availability") ?? "");
  const narrative = str(row.about_me);
  if (!narrative && facts.length === 0) return null;
  const parts: string[] = [];
  if (narrative) parts.push(narrative);
  if (facts.length > 0) {
    parts.push(
      "## Application facts",
      "<!-- generated from the onboarding profile; facts only, never inferred -->",
      ...facts,
    );
  }
  return `${parts.join("\n\n")}\n`;
}

export type PersonaOutcome = { persona: Persona; reason: null } | { persona: null; reason: string };

/** personas/default.json — exactly what the engine's loader accepts, or the reason it would refuse. */
export function toPersona(user: OnboardedUser): PersonaOutcome {
  const p = user.persona;
  if (!p) return { persona: null, reason: "no persona row — the user skipped the outreach step" };
  const parsed = personaSchema.safeParse({
    persona_id: p.persona_id || "default",
    headline: p.headline,
    education: p.education,
    projects: p.projects,
    skills: p.skills,
    interests: p.interests,
  });
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".") || "persona").slice(0, 4).join(", ");
    return { persona: null, reason: `persona incomplete for the engine loader: ${missing}` };
  }
  if (parsed.data.projects.some((pr) => /^REPLACE_[A-Z0-9_]*$/.test(pr.name))) {
    return { persona: null, reason: "persona has a placeholder project name" };
  }
  return { persona: parsed.data, reason: null };
}

/** The RPC plaintext (save_my_sensitive_profile contract) as the engine's file. */
export type SensitivePlain = {
  consent?: boolean;
  fields?: Record<string, { choice?: string; value?: unknown } | null | undefined>;
  self_identification_preferences?: Record<string, unknown>;
};

export function toSensitiveProfile(plain: SensitivePlain | null): SensitiveProfile | null {
  if (!plain || plain.consent !== true) return null;
  const fields = plain.fields ?? {};
  const single = (key: string): string => {
    const f = fields[key];
    if (!f) return "";
    if (f.choice === "prefer_not") return DECLINE_TO_SELF_IDENTIFY;
    if (f.choice === "answer") return str(f.value);
    return "";
  };
  const multi = (key: string): string[] => {
    const f = fields[key];
    if (!f) return [];
    if (f.choice === "prefer_not") return [DECLINE_TO_SELF_IDENTIFY];
    if (f.choice === "answer") return strList(f.value);
    return [];
  };
  return parseSensitiveProfile({
    gender_identity: single("gender_identity"),
    gender: single("gender"),
    race_ethnicity: multi("race_ethnicity"),
    sexual_orientation: single("sexual_orientation"),
    hispanic_latino: single("hispanic_latino"),
    transgender: single("transgender"),
    veteran_status: single("veteran_status"),
    disability_status: single("disability_status"),
    pronouns: single("pronouns"),
    self_identification_preferences: plain.self_identification_preferences ?? {},
  });
}

export type DocumentTarget = {
  kind: "resume" | "transcript" | "cover_letter";
  variant: string;
  bucket: string;
  objectPath: string;
  filename: string;
  isDefault: boolean;
  /** Where the bytes land, relative to the tenant's candidate/ dir. */
  relativeTarget: string;
  uploadedAt: string | null;
};

const VARIANT_RE = /^[a-z0-9_]{1,32}$/;

/** The only buckets a document may come from, by kind (mirrors the 20260911000300 CHECK). */
const BUCKET_FOR_KIND: Record<string, string> = { resume: "resumes", cover_letter: "resumes", transcript: "transcripts" };

/**
 * Which documents to download and where. Resume variants become
 * resumes/<variant>.pdf (the engine's per-variant reader); the default
 * resume is also resumes/default.pdf; the transcript is transcript.pdf.
 * Object paths must be the user's own (uid prefix) inside the bucket the
 * schema assigns to that kind — anything else is refused, never fetched.
 */
export function toDocumentTargets(user: OnboardedUser): DocumentTarget[] {
  const out: DocumentTarget[] = [];
  const legit = (d: CloudDocumentRow): boolean =>
    d.object_path.split("/")[0] === user.userId &&
    BUCKET_FOR_KIND[d.kind] === d.bucket &&
    VARIANT_RE.test(d.variant) &&
    d.filename.trim() !== "";
  for (const d of user.documents) {
    if (!legit(d)) continue;
    if (d.kind === "resume") {
      out.push({
        kind: "resume",
        variant: d.variant,
        bucket: d.bucket,
        objectPath: d.object_path,
        filename: d.filename,
        isDefault: d.is_default,
        relativeTarget: `resumes/${d.variant}.pdf`,
        uploadedAt: d.uploaded_at,
      });
    } else if (d.kind === "transcript") {
      out.push({
        kind: "transcript",
        variant: d.variant,
        bucket: d.bucket,
        objectPath: d.object_path,
        filename: d.filename,
        isDefault: d.is_default,
        relativeTarget: "transcript.pdf",
        uploadedAt: d.uploaded_at,
      });
    }
  }
  // Legacy pointer (pre-20260911000300) when no document row exists.
  if (!out.some((d) => d.kind === "resume") && user.resumeObjectPath && user.resumeObjectPath.split("/")[0] === user.userId) {
    out.push({
      kind: "resume",
      variant: "general",
      bucket: "resumes",
      objectPath: user.resumeObjectPath,
      filename: user.resumeFilename ?? "resume.pdf",
      isDefault: true,
      relativeTarget: "resumes/general.pdf",
      uploadedAt: null,
    });
  }
  return out;
}

/**
 * application-education-policy.json — only when the user set
 * job_preferences.early_graduation with everything the engine's policy
 * schema needs. Resume paths point at the materialized variants; the
 * ds_ai side falls back to the general resume when no variant exists.
 */
export function toEducationPolicy(user: OnboardedUser, resumeVariants: string[]): ApplicationEducationPolicy | null {
  const eg = user.jobPreferences["early_graduation"];
  if (!eg || typeof eg !== "object" || Array.isArray(eg)) return null;
  const o = eg as Record<string, unknown>;
  const year = typeof o["graduation_year"] === "number" ? o["graduation_year"] : Number.NaN;
  const month = str(o["graduation_month"]);
  const standing = str(o["academic_standing"]);
  const statement = str(o["statement"]);
  if (!Number.isInteger(year) || !month || !standing || !statement) return null;
  const general = "resumes/general.pdf";
  const dsAi = resumeVariants.includes("ds_ai") ? "resumes/ds_ai.pdf" : general;
  return {
    version: 1,
    graduation_year: year,
    graduation_month: month,
    academic_standing: standing,
    statement,
    resumes: { general, ds_ai: dsAi },
    baseline_resumes: { general, ds_ai: dsAi },
  };
}

export type TenantManifest = {
  version: 1;
  user_id: string;
  email: string;
  materialized_at: string;
  onboarding_completed_at: string;
  quota_max_completed_applications: number | null;
  eligibility: {
    jobright_status: string;
    jobright_premium: boolean;
    gmail_status: string;
    /** Referral drafting runs only when both are true. */
    outreach_eligible: boolean;
  };
  documents: Array<{ kind: string; variant: string; target: string; is_default: boolean }>;
  persona: "present" | "absent";
  persona_reason: string | null;
  about_me: "present" | "absent";
};

export type MaterializedTenant = {
  publicProfile: PublicProfile;
  screenerBank: ScreenerAnswerBank;
  aboutMe: string | null;
  persona: PersonaOutcome;
  documents: DocumentTarget[];
  educationPolicy: ApplicationEducationPolicy | null;
  manifest: TenantManifest;
};

/** Everything but the bytes: one call per tenant, pure. */
export function materializeTenant(user: OnboardedUser, now: Date = new Date()): MaterializedTenant {
  const publicProfile = toPublicProfile(user);
  const screenerBank = toScreenerBank(user);
  const aboutMe = toAboutMe(user);
  const persona = toPersona(user);
  const documents = toDocumentTargets(user);
  const variants = documents.filter((d) => d.kind === "resume").map((d) => d.variant);
  const educationPolicy = toEducationPolicy(user, variants);
  const jobright = user.integrations.find((i) => i.provider === "jobright");
  const gmail = user.integrations.find((i) => i.provider === "gmail");
  const premium = jobright?.premium === true;
  const gmailConnected = gmail?.status === "connected";
  const manifest: TenantManifest = {
    version: 1,
    user_id: user.userId,
    email: user.email,
    materialized_at: now.toISOString(),
    onboarding_completed_at: user.onboardingCompletedAt,
    quota_max_completed_applications: user.maxCompletedApplications,
    eligibility: {
      jobright_status: jobright?.status ?? "disconnected",
      jobright_premium: premium,
      gmail_status: gmail?.status ?? "disconnected",
      outreach_eligible: premium && gmailConnected,
    },
    documents: documents.map((d) => ({ kind: d.kind, variant: d.variant, target: d.relativeTarget, is_default: d.isDefault })),
    persona: persona.persona ? "present" : "absent",
    persona_reason: persona.reason,
    about_me: aboutMe ? "present" : "absent",
  };
  return { publicProfile, screenerBank, aboutMe, persona, documents, educationPolicy, manifest };
}
