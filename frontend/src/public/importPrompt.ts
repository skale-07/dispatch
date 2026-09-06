import {
  EMPTY_PROFILE,
  EMPLOYMENT_TYPE_OPTIONS,
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
 * 2. NO EEO / DEMOGRAPHIC FIELDS. The wizard collects none (directive
 *    2026-09-01) and this must not become the side door that reintroduces
 *    them. The prompt says so out loud, and the parser only ever reads
 *    keys on its own allowlist.
 * 3. NOTHING IS INVENTED. The prompt tells the model to leave a field out
 *    rather than guess it, because a plausible-but-wrong graduation year
 *    reaches a real employer under the user's name.
 */

/** The exact keys importDraft() will read. Anything else is ignored. */
const IMPORTABLE = [
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
] as const;

type ImportableKey = (typeof IMPORTABLE)[number];

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
  "current_company": "where I work now, if anywhere",
  "about_me": "see below",
  "titles": "job titles I should be applying to, comma separated",
  "locations": "cities I want to work in, comma separated",
  "remote": "one of: remote, hybrid, onsite, any",
  "employment_types": ["one or more of: internship, full_time, part_time, contract"],
  "min_salary_usd": "a number only, no symbols, if I have said one"
}

RULES — these matter more than completeness:

1. Do not invent anything. If my resume does not say it, leave the key out entirely. A missing field is fine; a wrong one goes to a real employer under my name.
2. Do NOT include work authorization, visa status, or sponsorship. I answer those myself.
3. Do NOT include gender, race, ethnicity, veteran status, disability, or pronouns. Never ask me for them either.
4. "about_me" is the important one. Write 150-250 words in MY first-person voice, as if I were telling an interviewer about myself. Ground every sentence in my resume: what I have actually built, the tools I actually used, what I am looking for next. Plain and specific — no adjectives I did not earn, no "passionate", no summary-speak. This text is what gets used to answer open-ended application questions, so it should sound like me on a good day, not like a cover letter.

My resume:
[PASTE YOUR RESUME HERE]`;

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

  if (filled.length === 0) {
    return {
      ok: false,
      reason:
        "that JSON had none of the expected fields — check you copied the reply to this prompt",
    };
  }
  return { ok: true, draft, filled, ignored };
}
