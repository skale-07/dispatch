import {
  EDUCATION_MAX_EXTRA,
  EMPLOYMENT_MAX_ROLES,
  EMPLOYMENT_SUMMARY_MAX,
  EMPTY_EDUCATION_ENTRY,
  EMPTY_EMPLOYMENT_ENTRY,
  EMPTY_PROFILE,
  EMPLOYMENT_TYPE_OPTIONS,
  type EducationDraft,
  type EmploymentDraft,
  type ProfileDraft,
// Extension-qualified (unlike its siblings) because the repo-root
// tsconfig — which typechecks tests/ under node16 resolution — pulls this
// file in via tests/unit/import-prompt.test.ts. Vite and the frontend's
// bundler resolution both accept it; extensionless does not typecheck
// from the root.
} from "./contract.js";

/**
 * ── The bring-your-own-LLM fast path ────────────────────────────────
 *
 * Onboarding asks for things the user has already written down: their
 * resume says where they studied, what they built, when they graduate.
 * Retyping it into a six-step wizard is the exact drudgery this product
 * exists to delete, so we hand them a prompt instead: paste it into
 * whatever assistant they already use, together with their resume, and
 * paste the JSON it returns back here.
 *
 * Two properties make this worth doing rather than calling a model
 * ourselves:
 *   - It costs us nothing. The user spends their own tokens on the one
 *     input that is genuinely expensive to produce — a written personal
 *     narrative — and we never see their resume.
 *   - It degrades honestly. A refusal, a bad paste, or a model that
 *     invents fields lands in a DRAFT the user reviews step by step. It
 *     is never a save.
 *
 * Three hard rules, each inherited from a rule the engine already has:
 *
 * 1. WORK AUTHORIZATION IS NEVER IMPORTED. The engine's standing rule is
 *    that visa status is the candidate's own explicit answer — never
 *    inferred, never defaulted. A model guessing "US citizen" off a
 *    university name is precisely the failure that rule exists to stop,
 *    so the prompt does not ask and the parser drops the key if a model
 *    volunteers it anyway.
 * 2. NO EEO / DEMOGRAPHIC FIELDS. Self-identification is a separate,
 *    opt-in, encrypted step the user answers by hand (selfId.ts,
 *    decision 2026-09-11); a model must never populate it from a resume.
 *    The prompt says so out loud, and the parser only ever reads keys on
 *    its own allowlist.
 * 3. NOTHING IS INVENTED. The prompt tells the model to leave a field out
 *    rather than guess it, because a plausible-but-wrong graduation year
 *    reaches a real employer under the user's name.
 */

/** The exact keys importDraft() will read. Anything else is ignored. */
export const IMPORTABLE = [
  "full_name",
  "phone",
  "location_city",
  "location_region",
  "location_country",
  "linkedin_url",
  "github_url",
  "portfolio_url",
  "school",
  "degree",
  "field",
  "additional_fields",
  "grad_month",
  "grad_year",
  "start_month",
  "start_year",
  "gpa",
  "current_company",
  "about_me",
  "titles",
  "locations",
  "remote",
  "employment_types",
  "min_salary_usd",
  // M23: structured history — one object per role / school, plus the
  // skills list. Detailed on purpose (operator 2026-09-14).
  "skills",
  "employment_history",
  "education",
] as const;

type ImportableKey = (typeof IMPORTABLE)[number];

/** Where the resume goes in the prompt; buildImportPrompt() fills it. */
export const RESUME_PLACEHOLDER = "[PASTE YOUR RESUME HERE]";

/**
 * The prompt the user copies. Written for a general assistant, not for
 * one vendor: it asks for a bare JSON object and nothing else, because
 * the paste target is a textarea, not a parser we control.
 */
export const IMPORT_PROMPT = `You are helping me fill in a job-application profile. I will paste my resume below.

Read it and reply with ONE JSON object and nothing else — no explanation, no code fence, no commentary.

Use exactly these keys, and OMIT any key you cannot answer from what I gave you:

{
  "full_name": "",
  "phone": "",
  "location_city": "",
  "location_region": "state or province",
  "location_country": "",
  "linkedin_url": "",
  "github_url": "",
  "portfolio_url": "",
  "school": "the school I am attending or most recently attended",
  "degree": "e.g. Bachelor of Science",
  "field": "my primary major",
  "additional_fields": "minors or second majors, comma separated",
  "start_month": "month I started, e.g. August",
  "start_year": "e.g. 2023",
  "grad_month": "month I graduate or graduated, e.g. May",
  "grad_year": "e.g. 2027",
  "gpa": "only if it is written on the resume",
  "education": [
    {
      "school": "every OTHER school on the resume gets its own object here (transfers, study abroad, an earlier degree)",
      "degree": "e.g. Associate of Science",
      "field": "",
      "additional_fields": "minors, comma separated",
      "start_month": "",
      "start_year": "",
      "grad_month": "",
      "grad_year": "",
      "gpa": "only if written"
    }
  ],
  "current_company": "where I work now, if anywhere",
  "skills": ["every language, framework, tool, platform and method named anywhere on the resume — one string each, nothing grouped"],
  "employment_history": [
    {
      "company": "",
      "title": "",
      "location": "City, ST — or Remote",
      "remote": false,
      "start_month": "e.g. June",
      "start_year": "e.g. 2024",
      "end_month": "",
      "end_year": "",
      "current": false,
      "description": "see rule 5"
    }
  ],
  "about_me": "see rule 4",
  "titles": "job titles I should be applying to, comma separated",
  "locations": "cities I want to work in, comma separated",
  "remote": "one of: remote, hybrid, onsite, any",
  "employment_types": ["one or more of: internship, full_time, part_time, contract"],
  "min_salary_usd": "a number only, no symbols, if I have said one"
}

RULES — these matter more than completeness:

1. Do not invent anything. If my resume does not say it, leave the key out entirely (inside a role, leave the field out). A missing field is fine; a wrong one goes to a real employer under my name. Never guess a month: "Summer 2024" is start_year 2024 with no start_month.
2. Do NOT include work authorization, visa status, or sponsorship. I answer those myself.
3. Do NOT include gender, race, ethnicity, veteran status, disability, or pronouns. I answer self-identification questions myself in a separate, encrypted step — never include them here, and never ask me for them.
4. "about_me": write 150-250 words in MY first-person voice, as if I were telling an interviewer about myself. Ground every sentence in my resume: what I have actually built, the tools I actually used, what I am looking for next. Plain and specific — no adjectives I did not earn, no "passionate", no summary-speak. This text is what gets used to answer open-ended application questions, so it should sound like me on a good day, not like a cover letter.
5. "employment_history" is the other important one, and DETAIL BEATS BREVITY. One object per job, internship, research position, teaching role, or leadership role, most recent first. "description" is one line per accomplishment from the resume, in my words, keeping every number, tool, and outcome — do not shorten, merge, or paraphrase away specifics; application forms have a large description box and this is what goes in it. A degree line under a role is not a role.
6. "skills": list them all, flat. "Python (pandas, NumPy)" is three skills.

My resume:
${RESUME_PLACEHOLDER}`;

/**
 * The prompt with the resume text already in it — the copy button in the
 * "Fill from resume" dialog uses this once the PDF has been read on
 * device, so the user pastes ONE thing into their assistant. The text
 * never leaves the browser except by the user's own paste.
 */
export function buildImportPrompt(resumeText?: string): string {
  const text = resumeText?.trim();
  return text ? IMPORT_PROMPT.replace(RESUME_PLACEHOLDER, text) : IMPORT_PROMPT;
}

export type ImportOutcome =
  | { ok: true; draft: ProfileDraft; filled: string[]; ignored: string[] }
  | { ok: false; reason: string };

/** Models fence JSON despite instructions; unwrap before parsing. */
function stripFence(text: string): string {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fenced?.[1]) return fenced[1].trim();
  // Some assistants prepend a sentence — take the outermost object.
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  return first >= 0 && last > first ? t.slice(first, last + 1) : t;
}

/** Scalars only: an object or array where text belongs is a bad paste. */
function asText(value: unknown): string | null {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const yearText = (value: unknown): string => {
  const t = asText(value) ?? "";
  return /^\d{4}$/.test(t) ? t : "";
};

/** One role object from the model → a wizard row; null when it names neither company nor title. */
function employmentFromModel(value: unknown): EmploymentDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const company = asText(o["company"]) ?? "";
  const title = asText(o["title"]) ?? "";
  if (!company && !title) return null;
  // Models write "description" (the prompt's word) or "summary" (the wizard's); either is the same field.
  const description = asText(o["description"]) ?? asText(o["summary"]) ?? "";
  const location = asText(o["location"]) ?? "";
  return {
    ...EMPTY_EMPLOYMENT_ENTRY,
    company,
    title,
    location,
    start_month: asText(o["start_month"]) ?? "",
    start_year: yearText(o["start_year"]),
    end_month: asText(o["end_month"]) ?? "",
    end_year: yearText(o["end_year"]),
    current: o["current"] === true,
    remote: o["remote"] === true || /^remote$/i.test(location),
    summary: description.slice(0, EMPLOYMENT_SUMMARY_MAX),
  };
}

/** One school object from the model → a wizard row; null without a school name. */
function educationFromModel(value: unknown): EducationDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const school = asText(o["school"]) ?? "";
  if (!school) return null;
  const gpa = asText(o["gpa"]) ?? "";
  return {
    ...EMPTY_EDUCATION_ENTRY,
    school,
    degree: asText(o["degree"]) ?? "",
    field: asText(o["field"]) ?? asText(o["major"]) ?? "",
    additional_fields: asText(o["additional_fields"]) ?? asText(o["minors"]) ?? "",
    start_month: asText(o["start_month"]) ?? "",
    start_year: yearText(o["start_year"]),
    grad_month: asText(o["grad_month"]) ?? asText(o["end_month"]) ?? "",
    grad_year: yearText(o["grad_year"]) || yearText(o["end_year"]),
    gpa: /^\d(?:\.\d{1,3})?$/.test(gpa) ? gpa : "",
  };
}

/**
 * Parse a pasted reply into a draft, merged over what the user already
 * has. Returns which keys were filled and which were ignored, because
 * the user is entitled to know what a model just put in their form —
 * silence here would be the same sin as an unverified fill.
 */
export function importDraft(
  pasted: string,
  base: ProfileDraft = EMPTY_PROFILE,
): ImportOutcome {
  if (!pasted.trim()) return { ok: false, reason: "nothing pasted" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(pasted));
  } catch {
    return {
      ok: false,
      reason:
        "that does not look like JSON — copy the whole reply, starting at { and ending at }",
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "expected a single JSON object" };
  }

  const src = parsed as Record<string, unknown>;
  const allow = new Set<string>(IMPORTABLE);
  const draft: ProfileDraft = { ...base };
  const filled: string[] = [];
  // Anything off the allowlist is reported, not silently dropped — this
  // is how the user finds out a model volunteered work authorization.
  const ignored = Object.keys(src).filter((k) => !allow.has(k));

  const setText = (key: ImportableKey, target: keyof ProfileDraft): void => {
    const v = asText(src[key]);
    if (v) {
      (draft[target] as string) = v;
      filled.push(key);
    }
  };

  for (const k of [
    "full_name",
    "phone",
    "location_city",
    "location_region",
    "location_country",
    "linkedin_url",
    "github_url",
    "portfolio_url",
    "school",
    "degree",
    "field",
    "additional_fields",
    "grad_month",
    "grad_year",
    "start_month",
    "start_year",
    "gpa",
    "current_company",
    "about_me",
    "titles",
    "locations",
  ] as const) {
    setText(k, k);
  }

  // Lists may arrive as an array or as the comma-separated string the
  // prompt's own example shows; both are the user's intent.
  const joinList = (value: unknown): string | null =>
    Array.isArray(value)
      ? value.map(asText).filter((s): s is string => Boolean(s)).join(", ")
      : asText(value);
  for (const k of ["titles", "locations"] as const) {
    const joined = joinList(src[k]);
    if (joined) {
      draft[k] = joined;
      if (!filled.includes(k)) filled.push(k);
    }
  }

  // Enumerated fields are matched against our own option lists, never
  // taken verbatim — the same rule the engine applies to a model's
  // choice among a page's options.
  const remote = asText(src["remote"])?.toLowerCase();
  if (remote === "remote" || remote === "hybrid" || remote === "onsite" || remote === "any") {
    draft.remote = remote;
    filled.push("remote");
  }

  const types = Array.isArray(src["employment_types"])
    ? src["employment_types"]
        .map((t) => asText(t)?.toLowerCase().replace(/[\s-]+/g, "_"))
        .filter((t): t is string =>
          (EMPLOYMENT_TYPE_OPTIONS as readonly string[]).includes(t ?? ""),
        )
    : [];
  if (types.length > 0) {
    draft.employment_types = [...new Set(types)];
    filled.push("employment_types");
  }

  const salary = asText(src["min_salary_usd"])?.replace(/[^0-9]/g, "");
  if (salary) {
    draft.min_salary_usd = salary;
    filled.push("min_salary_usd");
  }

  // Skills: a flat list (or the comma string a model may still send),
  // unioned with what the user already typed, never replacing it.
  const skills = joinList(src["skills"]);
  if (skills) {
    const have = base.skills.split(",").map((s) => s.trim()).filter(Boolean);
    const seen = new Set(have.map((s) => s.toLowerCase()));
    for (const s of skills.split(",").map((x) => x.trim()).filter(Boolean)) {
      if (!seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        have.push(s);
      }
    }
    draft.skills = have.join(", ").slice(0, 2000);
    filled.push("skills");
  }

  // Roles: each object is validated field by field — a string where a
  // string belongs, a 4-digit year, a real boolean — and anything else
  // in it is dropped, not coerced. Replaces the draft's roles (a re-import
  // is a redo, not a duplicate), capped at the wizard's limit.
  const roles = Array.isArray(src["employment_history"])
    ? src["employment_history"].map(employmentFromModel).filter((r): r is EmploymentDraft => r !== null)
    : [];
  if (roles.length > 0) {
    draft.employment_history = roles.slice(0, EMPLOYMENT_MAX_ROLES);
    filled.push("employment_history");
    if (!draft.current_company.trim()) {
      const current = roles.find((r) => r.current && r.company);
      if (current) {
        draft.current_company = current.company;
        if (!filled.includes("current_company")) filled.push("current_company");
      }
    }
  }

  // Other schools: the flat keys stay the primary school; every object
  // here whose school is not the primary lands in more_education. When
  // the model sent no flat school, the first object becomes the primary.
  const schools = Array.isArray(src["education"])
    ? src["education"].map(educationFromModel).filter((e): e is EducationDraft => e !== null)
    : [];
  if (schools.length > 0) {
    let rest = schools;
    if (!draft.school.trim()) {
      const primary = schools[0]!;
      Object.assign(draft, {
        school: primary.school,
        degree: primary.degree,
        field: primary.field,
        additional_fields: primary.additional_fields,
        start_month: primary.start_month,
        start_year: primary.start_year,
        grad_month: primary.grad_month,
        grad_year: primary.grad_year,
        gpa: primary.gpa,
      });
      if (!filled.includes("school")) filled.push("school");
      rest = schools.slice(1);
    }
    const more = rest.filter((e) => e.school.trim().toLowerCase() !== draft.school.trim().toLowerCase());
    if (more.length > 0) {
      draft.more_education = more.slice(0, EDUCATION_MAX_EXTRA);
      filled.push("education");
    }
  }

  if (filled.length === 0) {
    return {
      ok: false,
      reason:
        "that JSON had none of the expected fields — check you copied the reply to this prompt",
    };
  }
  return { ok: true, draft, filled, ignored };
}
