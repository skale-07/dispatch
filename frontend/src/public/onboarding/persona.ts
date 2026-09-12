import { z } from "zod";
import type { PersonaRow, ProfileDraft } from "../contract.js";
import { splitList, yearOrNull } from "../profileMapping.js";

/**
 * Step 10 — the outreach persona (user_personas, 20260911000600). The
 * persona is the ONLY source of project claims a referral draft may
 * make, so it is written explicitly on Next (a partial autosave could
 * not satisfy the row's own CHECKs) and a placeholder project name
 * (REPLACE_*) is refused exactly as the engine's loader refuses it.
 *
 * A user with no headline and no projects has no persona; the engine then
 * drafts no outreach for them and says so — never a generic email.
 */

export type PersonaProjectForm = {
  name: string;
  summary: string;
  /** Comma-separated in the form; text[] in the row. */
  tools: string;
  relevance_tags: string;
};

export type PersonaForm = {
  headline: string;
  school: string;
  class_year: string;
  /** Comma-separated. */
  majors: string;
  projects: PersonaProjectForm[];
  skills: string;
  interests: string;
};

export const EMPTY_PROJECT: PersonaProjectForm = { name: "", summary: "", tools: "", relevance_tags: "" };

/** personas.ts PLACEHOLDER_PROJECT_NAME — mirrored by the table's CHECK. */
export const PLACEHOLDER_PROJECT = /^REPLACE_[A-Z0-9_]*$/;

const text = (max: number) => z.string().max(max, `keep this under ${max} characters`);

const projectSchema = z.object({
  name: text(120).refine((v) => !PLACEHOLDER_PROJECT.test(v.trim()), "give the project its real name"),
  summary: text(600),
  tools: text(300),
  relevance_tags: text(300),
});

export const personaLenient = z.object({
  headline: text(200),
  school: text(200),
  class_year: z.string().regex(/^\s*(\d{4})?\s*$/, "a 4-digit year, e.g. 2027"),
  majors: text(300),
  projects: z.array(projectSchema).max(8, "eight projects at most"),
  skills: text(1000),
  interests: text(500),
});

/**
 * Strict = what the engine's own personaSchema (src/candidate/personas.ts)
 * demands once there IS a persona: a headline, a school and at least one
 * major, at least one project, and a name + summary on every project.
 * Anything looser would write a row the engine loader rejects as "no
 * persona" while the UI said "saved". An entirely blank form is legal —
 * it means "no persona".
 */
export const personaStrict = personaLenient.superRefine((v, ctx) => {
  if (personaIsBlank(v)) return;
  const issue = (path: (string | number)[], message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  if (!v.headline.trim()) issue(["headline"], "a one-line headline — referral drafts open with it");
  if (!v.school.trim()) issue(["school"], "the school a draft may mention");
  if (splitList(v.majors).length === 0) issue(["majors"], "at least one major");
  const projects = v.projects.filter((p) => !projectIsBlank(p));
  if (projects.length === 0) issue(["headline"], "at least one project — a draft has nothing to claim without one");
  v.projects.forEach((p, i) => {
    if (projectIsBlank(p)) return;
    if (!p.name.trim()) issue(["projects", i, "name"], "name the project");
    if (!p.summary.trim()) issue(["projects", i, "summary"], "one or two sentences on what it does and what you did");
  });
});

export function projectIsBlank(p: PersonaProjectForm): boolean {
  return !p.name.trim() && !p.summary.trim() && !p.tools.trim() && !p.relevance_tags.trim();
}

/**
 * A blank form = no persona (the row is deleted, outreach stays off).
 * School/majors/skills prefilled from the profile do not count — they
 * are not the user's decision to have a persona.
 */
export function personaIsBlank(form: Pick<PersonaForm, "headline" | "projects" | "interests">): boolean {
  return !form.headline.trim() && !form.interests.trim() && form.projects.every(projectIsBlank);
}

/**
 * Prefill: the saved persona when there is one, else what the profile
 * already knows (school, class year, majors, skills) — never invented.
 */
export function personaFormFrom(row: PersonaRow | null, draft: ProfileDraft): PersonaForm {
  if (row) {
    return {
      headline: row.headline ?? "",
      school: row.education?.school ?? "",
      class_year: row.education?.class_year != null ? String(row.education.class_year) : "",
      majors: (row.education?.majors ?? []).join(", "),
      projects: (row.projects ?? []).map((p) => ({
        name: p.name ?? "",
        summary: p.summary ?? "",
        tools: (p.tools ?? []).join(", "),
        relevance_tags: (p.relevance_tags ?? []).join(", "),
      })),
      skills: (row.skills ?? []).join(", "),
      interests: (row.interests ?? []).join(", "),
    };
  }
  return {
    headline: "",
    school: draft.school,
    class_year: draft.grad_year,
    majors: [draft.field, draft.additional_fields].map((s) => s.trim()).filter(Boolean).join(", "),
    projects: [],
    skills: draft.skills,
    interests: "",
  };
}

/** Form → row body for saveMyPersona; null when the form is blank. */
export function personaRowFrom(
  form: PersonaForm,
): Omit<PersonaRow, "user_id" | "persona_id" | "updated_at"> | null {
  if (personaIsBlank(form)) return null;
  const classYear = yearOrNull(form.class_year);
  const majors = splitList(form.majors);
  return {
    headline: form.headline.trim(),
    education: {
      ...(form.school.trim() ? { school: form.school.trim() } : {}),
      ...(classYear !== null ? { class_year: classYear } : {}),
      ...(majors.length > 0 ? { majors } : {}),
    },
    projects: form.projects
      .filter((p) => !projectIsBlank(p))
      .map((p) => ({
        name: p.name.trim(),
        summary: p.summary.trim(),
        tools: splitList(p.tools),
        relevance_tags: splitList(p.relevance_tags),
      })),
    skills: splitList(form.skills),
    interests: splitList(form.interests),
  };
}
