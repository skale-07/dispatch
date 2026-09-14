import { describe, expect, it } from "vitest";
import { parseScreenerBank } from "../../src/candidate/screeners.js";
import {
  DECLINE_TO_SELF_IDENTIFY,
  canonicalMonth,
  historyLocation,
  materializeTenant,
  mirroredScreenerAnswers,
  toAboutMe,
  toDocumentTargets,
  toEducationPolicy,
  toEngineEducation,
  toEngineEmployment,
  toPersona,
  toPublicProfile,
  toScreenerBank,
  toSensitiveProfile,
} from "../../src/cloud/tenantMaterializer.js";
import type { CloudProfileRow, OnboardedUser } from "../../src/cloud/syncMapping.js";
import {
  educationEntrySchema,
  employmentEntrySchema,
  structuredEducationHistory,
  structuredEmploymentHistory,
} from "../../src/candidate/publicProfile.js";

/**
 * Plan M14 — cloud rows → the engine's own files, pure. The two things
 * that must never happen are pinned: an invented value (a blank on the
 * row is "" in the file) and a self-ID answer coming from anywhere but
 * the user's opt-in plaintext. UNIT_CONFIRMED.
 */

const UID = "11111111-2222-4333-8444-555555555555";

const PROFILE: CloudProfileRow = {
  user_id: UID,
  full_name: "Maya Okafor",
  phone: "+1 412 555 0148",
  location_city: "Pittsburgh",
  location_region: "PA",
  location_country: "United States",
  linkedin_url: "https://linkedin.com/in/mayaokafor",
  github_url: "",
  portfolio_url: null,
  work_authorization: "us_citizen",
  needs_sponsorship: false,
  education: [
    { school: "University of Pittsburgh", degree: "B.S.", field: "Computer Science", start_year: 2023, end_year: 2027, end_month: "May", gpa: 3.7, additional_fields: "Statistics, Math" },
    { school: "CCAC", degree: "A.S.", field: "Math", start_year: 2021, end_year: 2023 },
  ],
  job_preferences: { titles: ["Software Engineer Intern"], locations: ["NYC"], employment_types: ["internship"] },
  resume_object_path: null,
  resume_filename: null,
  onboarding_completed_at: "2026-09-12T20:00:00Z",
  about_me: "I build tooling for browser automation and like shipping small, verified pieces.",
  current_company: "",
  open_to_relocation: null,
  legal_first_name: "Maya",
  legal_middle_name: "",
  legal_last_name: "Okafor",
  preferred_name: "",
  contact_email: null,
  address_line1: "123 Forbes Ave",
  address_line2: null,
  postal_code: "15213",
  how_heard: "LinkedIn",
  how_heard_fallbacks: ["Job board"],
  restrictive_covenants: null,
  skills: ["Python", "SQL"],
  employment_history: [{ company: "Acme", title: "Intern", start_year: 2025, current: true }],
};

const USER: OnboardedUser = {
  userId: UID,
  email: "maya@pitt.edu",
  fullName: "Maya Okafor",
  phone: PROFILE.phone,
  location: { city: "Pittsburgh", region: "PA", country: "United States" },
  links: { linkedin: PROFILE.linkedin_url, github: null, portfolio: null },
  workAuthorization: "us_citizen",
  needsSponsorship: false,
  education: PROFILE.education as unknown[],
  jobPreferences: PROFILE.job_preferences as Record<string, unknown>,
  resumeObjectPath: null,
  resumeFilename: null,
  onboardingCompletedAt: "2026-09-12T20:00:00Z",
  maxCompletedApplications: 5,
  profile: PROFILE,
  documents: [
    { id: "d1", user_id: UID, kind: "resume", variant: "general", bucket: "resumes", object_path: `${UID}/resume/general/Maya.pdf`, filename: "Maya.pdf", role_families: [], is_default: true, uploaded_at: "2026-09-12T19:00:00Z" },
    { id: "d2", user_id: UID, kind: "resume", variant: "ds_ai", bucket: "resumes", object_path: `${UID}/resume/ds_ai/Maya-DS.pdf`, filename: "Maya-DS.pdf", role_families: ["ds"], is_default: false, uploaded_at: "2026-09-12T19:00:00Z" },
    { id: "d3", user_id: UID, kind: "transcript", variant: "general", bucket: "transcripts", object_path: `${UID}/transcript/general/T.pdf`, filename: "T.pdf", role_families: [], is_default: true, uploaded_at: null },
    // Another user's path smuggled into this user's rows: refused.
    { id: "d4", user_id: UID, kind: "resume", variant: "evil", bucket: "resumes", object_path: `66666666-7777-4888-9999-aaaaaaaaaaaa/resume/evil/x.pdf`, filename: "x.pdf", role_families: [], is_default: false, uploaded_at: null },
    // Own uid but a bucket the schema never assigns to this kind: refused.
    { id: "d5", user_id: UID, kind: "resume", variant: "odd_bucket", bucket: "receipts", object_path: `${UID}/resume/odd_bucket/y.pdf`, filename: "y.pdf", role_families: [], is_default: false, uploaded_at: null },
  ],
  screenerAnswers: [
    { user_id: UID, key: "age_over_18", kind: "registry", answer: "Yes", labels: [], source: "wizard", updated_at: null },
    { user_id: UID, key: "salary_expectations", kind: "registry", answer: "Open to the posted range", labels: [], source: "wizard", updated_at: null },
    { user_id: UID, key: "q_0123456789ab", kind: "custom", answer: "TypeScript, Python", labels: ["Which languages have you shipped?"], source: "suggestion", updated_at: null },
    { user_id: UID, key: "notice_period", kind: "registry", answer: "   ", labels: [], source: "wizard", updated_at: null },
  ],
  persona: {
    user_id: UID,
    persona_id: "default",
    headline: "CS junior building ML tooling",
    education: { school: "University of Pittsburgh", class_year: 2027, majors: ["Computer Science"] },
    projects: [{ name: "Dispatch", summary: "an agent for forms", tools: ["TypeScript"], relevance_tags: ["automation"] }],
    skills: ["Python"],
    interests: ["climate"],
  },
  integrations: [
    { user_id: UID, provider: "jobright", status: "connected", account_email: "maya@pitt.edu", premium: true, scopes: [], connected_at: null, expires_at: null, last_checked_at: null, last_error: null },
  ],
};

describe("public profile (UNIT_CONFIRMED)", () => {
  it("maps every wizard fact to the engine's key and invents nothing", () => {
    const p = toPublicProfile(USER);
    expect(p.legal_name).toEqual({ first: "Maya", middle: "", last: "Okafor" });
    expect(p.email).toBe("maya@pitt.edu"); // contact_email null ⇒ the sign-in email
    expect(p.address).toEqual({ line1: "123 Forbes Ave", line2: "", city: "Pittsburgh", state: "PA", postal_code: "15213", country: "United States" });
    expect(p.school).toBe("University of Pittsburgh");
    expect(p.major).toBe("Computer Science");
    expect(p.additional_fields_of_study).toEqual(["Statistics", "Math"]);
    expect(p.graduation_month).toBe("May");
    expect(p.graduation_year).toBe(2027);
    expect(p.gpa).toBe(3.7);
    expect(p.work_authorization).toBe("U.S. citizen");
    expect(p.requires_sponsorship).toBe("no");
    // Unanswered ⇒ "" — never "no".
    expect(p.relocation).toBe("");
    expect(p.restrictive_covenants).toBe("");
    expect(p.current_company).toBe("");
    expect(p.personal_website).toBe("");
    expect(p.skills).toEqual(["Python", "SQL"]);
    expect(p.education_history).toHaveLength(2);
    expect(p.employment_history).toHaveLength(1);
  });

  it("a row with no country stays blank instead of taking the schema's American default", () => {
    const p = toPublicProfile({ ...USER, profile: { ...PROFILE, location_country: null } });
    expect(p.address?.country).toBe("");
  });

  it("legal names win; the greeting name is only a fallback split", () => {
    const p = toPublicProfile({ ...USER, profile: { ...PROFILE, legal_first_name: null, legal_last_name: null, full_name: "Ana Maria Silva" } });
    expect(p.legal_name).toEqual({ first: "Ana", middle: "", last: "Maria Silva" });
  });
});

describe("screener bank (UNIT_CONFIRMED)", () => {
  it("mirrors only unambiguous profile facts; the user's explicit bank answer wins; blanks and custom rows are handled", () => {
    expect(mirroredScreenerAnswers(PROFILE)).toEqual({ work_authorization: "Yes", requires_sponsorship: "No", how_heard: "LinkedIn" });
    // A visa holder's authorization today is not knowable from the wizard.
    expect(mirroredScreenerAnswers({ ...PROFILE, work_authorization: "visa_holder" })).not.toHaveProperty("work_authorization");
    expect(mirroredScreenerAnswers({ ...PROFILE, work_authorization: "needs_sponsorship", needs_sponsorship: true })).toMatchObject({ requires_sponsorship: "Yes" });
    expect(mirroredScreenerAnswers({ ...PROFILE, restrictive_covenants: "no", open_to_relocation: true })).toMatchObject({ non_compete: "No", willing_to_relocate: "Yes" });

    const bank = toScreenerBank(USER);
    expect(bank.answers["age_over_18"]).toBe("Yes");
    expect(bank.answers["salary_expectations"]).toBe("Open to the posted range");
    expect(bank.answers["work_authorization"]).toBe("Yes");
    expect(bank.answers).not.toHaveProperty("notice_period"); // whitespace answer ⇒ absent
    expect(bank.custom["q_0123456789ab"]).toEqual({ answer: "TypeScript, Python", labels: ["Which languages have you shipped?"], promoted_at: "" });
    // Round-trips through the engine's own parser.
    expect(parseScreenerBank(JSON.parse(JSON.stringify(bank)))).toEqual(bank);
  });

  it("no demographic key can enter the bank (the registry has none, and custom keys colliding with it are refused)", () => {
    const bank = toScreenerBank({
      ...USER,
      screenerAnswers: [{ user_id: UID, key: "age_over_18", kind: "custom", answer: "Yes", labels: ["x"], source: "wizard", updated_at: null }],
    });
    expect(bank.custom).toEqual({});
    expect(JSON.stringify(bank)).not.toMatch(/gender|race|veteran|disabilit|pronoun/i);
  });
});

describe("about-me, persona, documents, policy (UNIT_CONFIRMED)", () => {
  it("about-me = narrative + an Application facts section built only from present facts", () => {
    const text = toAboutMe(USER)!;
    expect(text.startsWith("I build tooling")).toBe(true);
    expect(text).toContain("## Application facts");
    expect(text).toContain("- Work authorization: U.S. citizen");
    expect(text).toContain("- Needs visa sponsorship: No");
    expect(text).toContain("- Salary expectations: Open to the posted range");
    expect(text).toContain("- Education: B.S., Computer Science, University of Pittsburgh (graduating May 2027)");
    expect(text).not.toContain("Open to relocation"); // unanswered ⇒ no line
    expect(text).not.toContain("Current employer");
    expect(toAboutMe({ ...USER, screenerAnswers: [], profile: { ...PROFILE, about_me: null, work_authorization: null, needs_sponsorship: null, location_city: null, location_region: null, location_country: null, education: [] } })).toBeNull();
  });

  it("persona: the engine's schema or a reason; placeholders refused", () => {
    expect(toPersona(USER).persona?.headline).toBe("CS junior building ML tooling");
    expect(toPersona({ ...USER, persona: null })).toEqual({ persona: null, reason: expect.stringMatching(/no persona row/) });
    const thin = toPersona({ ...USER, persona: { ...USER.persona!, projects: [] } });
    expect(thin.persona).toBeNull();
    expect(thin.reason).toMatch(/projects/);
    const placeholder = toPersona({ ...USER, persona: { ...USER.persona!, projects: [{ name: "REPLACE_ME", summary: "x", tools: [], relevance_tags: [] }] } });
    expect(placeholder.reason).toMatch(/placeholder/);
  });

  it("documents: per-variant resume targets + transcript; foreign object paths refused; legacy pointer only as a fallback", () => {
    const docs = toDocumentTargets(USER);
    expect(docs.map((d) => d.relativeTarget)).toEqual(["resumes/general.pdf", "resumes/ds_ai.pdf", "transcript.pdf"]);
    expect(docs.find((d) => d.variant === "general")?.isDefault).toBe(true);
    expect(docs.some((d) => d.variant === "evil")).toBe(false);
    expect(docs.some((d) => d.variant === "odd_bucket")).toBe(false);
    const legacy = toDocumentTargets({ ...USER, documents: [], resumeObjectPath: `${UID}/Maya.pdf`, resumeFilename: "Maya.pdf" });
    expect(legacy).toEqual([expect.objectContaining({ variant: "general", relativeTarget: "resumes/general.pdf", objectPath: `${UID}/Maya.pdf` })]);
    expect(toDocumentTargets({ ...USER, documents: [], resumeObjectPath: "someone-else/x.pdf" })).toEqual([]);
  });

  it("education policy only when early_graduation carries everything the engine's schema needs", () => {
    expect(toEducationPolicy(USER, ["general"])).toBeNull();
    const eg = { graduation_year: 2028, graduation_month: "May", academic_standing: "Junior", statement: "I can graduate early." };
    const withEg = { ...USER, jobPreferences: { ...USER.jobPreferences, early_graduation: eg } };
    expect(toEducationPolicy(withEg, ["general"])).toEqual({
      version: 1, graduation_year: 2028, graduation_month: "May", academic_standing: "Junior", statement: "I can graduate early.",
      resumes: { general: "resumes/general.pdf", ds_ai: "resumes/general.pdf" },
      baseline_resumes: { general: "resumes/general.pdf", ds_ai: "resumes/general.pdf" },
    });
    expect(toEducationPolicy(withEg, ["general", "ds_ai"])?.resumes.ds_ai).toBe("resumes/ds_ai.pdf");
    expect(toEducationPolicy({ ...USER, jobPreferences: { early_graduation: { graduation_year: 2028 } } }, [])).toBeNull();
  });
});

describe("self-identification plaintext → engine file (UNIT_CONFIRMED)", () => {
  it("answer → verbatim, prefer_not → the decline option, skip → blank; no consent ⇒ no file", () => {
    expect(toSensitiveProfile(null)).toBeNull();
    expect(toSensitiveProfile({ consent: false, fields: { gender: { choice: "answer", value: "Female" } } })).toBeNull();
    const s = toSensitiveProfile({
      consent: true,
      fields: {
        gender: { choice: "prefer_not", value: null },
        veteran_status: { choice: "answer", value: "I am not a protected veteran" },
        race_ethnicity: { choice: "answer", value: ["Asian", "White"] },
        pronouns: { choice: "skip", value: null },
        hispanic_latino: { choice: "prefer_not", value: null },
      },
    })!;
    expect(s.gender).toBe(DECLINE_TO_SELF_IDENTIFY);
    expect(s.veteran_status).toBe("I am not a protected veteran");
    expect(s.race_ethnicity).toEqual(["Asian", "White"]);
    expect(s.pronouns).toBe("");
    expect(s.disability_status).toBe("");
    expect(s.hispanic_latino).toBe(DECLINE_TO_SELF_IDENTIFY);
    expect(s.self_identification_preferences).toEqual({});
  });
});

describe("materializeTenant (UNIT_CONFIRMED)", () => {
  it("assembles the manifest from real rows: eligibility is premium AND gmail connected", () => {
    const m = materializeTenant(USER, new Date("2026-09-12T21:00:00Z"));
    expect(m.manifest.user_id).toBe(UID);
    expect(m.manifest.quota_max_completed_applications).toBe(5);
    expect(m.manifest.eligibility).toEqual({ jobright_status: "connected", jobright_premium: true, gmail_status: "disconnected", outreach_eligible: false });
    expect(m.manifest.documents.map((d) => d.target)).toEqual(["resumes/general.pdf", "resumes/ds_ai.pdf", "transcript.pdf"]);
    expect(m.manifest.persona).toBe("present");
    expect(m.manifest.about_me).toBe("present");
    expect(m.educationPolicy).toBeNull();
    // Nothing sensitive rides in a materialization built from the pull.
    expect(JSON.stringify(m)).not.toMatch(/gender|race_ethnicity|veteran|disabilit|pronoun/i);
  });
});

describe("M23: wizard history rows → engine structured entries (UNIT_CONFIRMED)", () => {
  const HOME = { city: "Pittsburgh", state: "PA", country: "United States" };

  it("maps a full wizard role to every key the engine's schema has", () => {
    const row = {
      company: "Northwind Traders",
      title: "Software Engineer Intern",
      location: "Seattle, WA",
      start_month: "Jun",
      start_year: 2025,
      end_month: "8",
      end_year: 2025,
      current: false,
      remote: false,
      summary: "Built a Go service\nWrote integration tests",
    };
    const mapped = employmentEntrySchema.parse(toEngineEmployment(row, HOME));
    expect(mapped).toEqual({
      company: "Northwind Traders",
      title: "Software Engineer Intern",
      location: { city: "Seattle", state: "WA", country: "United States" },
      remote: false,
      start: { month: "June", year: 2025 },
      end: { month: "August", year: 2025 },
      current: false,
      description: "Built a Go service\nWrote integration tests",
    });
    // Every schema key has a wizard source — the M23 coverage gate.
    expect(Object.keys(employmentEntrySchema.shape).sort()).toEqual(Object.keys(mapped).sort());
  });

  it("an unknown or remote location takes the HOME city; a year-only date keeps the year with a blank month; current ⇒ end null", () => {
    const remote = employmentEntrySchema.parse(
      toEngineEmployment({ company: "Fabrikam", title: "Grants Assistant", location: "Remote", start_year: "2023", current: true }, HOME),
    );
    expect(remote.location).toEqual(HOME);
    expect(remote.remote).toBe(true);
    expect(remote.start).toEqual({ month: "", year: 2023 });
    expect(remote.end).toBeNull();
    const blank = employmentEntrySchema.parse(toEngineEmployment({ company: "Acme", title: "Intern" }, HOME));
    expect(blank.location).toEqual(HOME);
    expect(blank.start).toBeUndefined();
    expect(blank.end).toBeUndefined();
    // A month with no year is nothing, never a guessed year.
    expect(toEngineEmployment({ company: "Acme", title: "Intern", start_month: "May" }, HOME)).not.toHaveProperty("start");
    // No company or no title: the engine's row cannot be filled — dropped, not half-made.
    expect(toEngineEmployment({ title: "Intern" }, HOME)).toBeNull();
    expect(toEngineEmployment({ company: "Acme" }, HOME)).toBeNull();
    expect(toEngineEmployment("junk", HOME)).toBeNull();
  });

  it("maps a wizard school to the engine's education entry, minors split, GPA numeric, enrolled = future graduation", () => {
    const mapped = educationEntrySchema.parse(
      toEngineEducation(
        { school: "University of Pittsburgh", degree: "B.S.", field: "Computer Science", additional_fields: "Statistics, Music", start_month: "August", start_year: 2023, end_month: "May", end_year: 2099, gpa: 3.7 },
        HOME,
      ),
    );
    expect(mapped).toMatchObject({
      school: "University of Pittsburgh",
      degree: "B.S.",
      field_of_study: "Computer Science",
      additional_fields_of_study: ["Statistics", "Music"],
      location: HOME,
      start: { month: "August", year: 2023 },
      end: { month: "May", year: 2099 },
      current: true,
      gpa: 3.7,
    });
    // gpa_scale is the one engine key with no wizard source, on purpose:
    // a scale the user did not state is not assumed to be 4.0.
    expect(Object.keys(educationEntrySchema.shape).filter((k) => k !== "gpa_scale").sort()).toEqual(Object.keys(mapped).sort());
    expect(toEngineEducation({ degree: "B.S." }, HOME)).toBeNull();
    expect(educationEntrySchema.parse(toEngineEducation({ school: "CCAC", end_year: 2020 }, HOME)).current).toBe(false);
  });

  it("the materialized profile's rows parse with the engine's own readers (no more raw pass-through)", () => {
    const p = toPublicProfile({
      ...USER,
      profile: {
        ...PROFILE,
        employment_history: [
          { company: "Acme", title: "Intern", start_year: 2025, current: true, summary: "Did things" },
          { company: "Nameless", start_year: 2024 }, // no title ⇒ dropped
        ],
      },
    });
    expect(structuredEmploymentHistory(p)).toHaveLength(1);
    expect(structuredEmploymentHistory(p)[0]).toMatchObject({ company: "Acme", description: "Did things", location: { city: "Pittsburgh", state: "PA" } });
    expect(structuredEducationHistory(p)).toHaveLength(2);
    expect(structuredEducationHistory(p)[0]).toMatchObject({ school: "University of Pittsburgh", field_of_study: "Computer Science", end: { month: "May", year: 2027 } });
  });

  it("helpers: months canonicalise, never guess; locations split on commas and default the country to home", () => {
    expect(canonicalMonth("sep")).toBe("September");
    expect(canonicalMonth("9")).toBe("September");
    expect(canonicalMonth("Sept.")).toBe("September");
    expect(canonicalMonth("Summer")).toBe("");
    expect(canonicalMonth("")).toBe("");
    expect(historyLocation("Columbus, Ohio, USA", HOME)).toEqual({ city: "Columbus", state: "Ohio", country: "USA" });
    expect(historyLocation("Baltimore, MD", HOME)).toEqual({ city: "Baltimore", state: "MD", country: "United States" });
    expect(historyLocation("Berlin", HOME)).toEqual({ city: "Berlin", state: "", country: "" });
    expect(historyLocation("wfh", HOME)).toEqual(HOME);
  });
});
