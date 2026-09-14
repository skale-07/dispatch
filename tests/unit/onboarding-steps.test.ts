import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE,
  PROFILE_MIRRORED_SCREENER_KEYS,
  SCREENER_QUESTIONS,
  WORK_AUTH_OPTIONS,
  type ProfileRow,
} from "../../frontend/src/public/contract.js";
import {
  ABOUT_MIN,
  STEP_SCHEMAS,
  WORK_AUTH_VALUES,
} from "../../frontend/src/public/onboarding/schema.js";
import {
  LEGACY_UPLOAD_KEYS,
  ONBOARDING_STEPS,
  neighbours,
  resumeSlug,
  screenerRows,
  stepBySlug,
  stepPatch,
} from "../../frontend/src/public/onboarding/steps.js";
import { draftToRow, rowToDraft } from "../../frontend/src/public/profileMapping.js";

/**
 * The onboarding wizard's step registry and per-step schemas (plan M9).
 * Pure modules, tested without a DOM: which step asks what, what each
 * step's save may write, and that no schema invents an answer.
 * UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");

const askedBy = new Map<string, string[]>();
for (const s of ONBOARDING_STEPS) {
  for (const f of s.fields) askedBy.set(f, [...(askedBy.get(f) ?? []), s.slug]);
}

describe("onboarding step registry (UNIT_CONFIRMED)", () => {
  it("the plan's 13 steps, in order, with unique slugs", () => {
    expect(ONBOARDING_STEPS.map((s) => s.slug)).toEqual([
      "identity",
      "contact",
      "education",
      "experience",
      "documents",
      "eligibility",
      "compensation",
      "about",
      "self-id",
      "persona",
      "integrations",
      "preferences",
      "review",
    ]);
  });

  it("every draft field is asked by exactly one step (legacy upload pointers excepted)", () => {
    const legacy = new Set<string>(LEGACY_UPLOAD_KEYS);
    for (const k of Object.keys(EMPTY_PROFILE)) {
      if (legacy.has(k)) {
        expect(askedBy.has(k), `${k} is a legacy pointer, no step asks it`).toBe(false);
        continue;
      }
      expect(askedBy.get(k) ?? [], `${k} asked by`).toHaveLength(1);
    }
  });

  it("every registry screener is asked by exactly one step; profile-mirrored keys never as a screener", () => {
    const mirrored = new Set<string>(PROFILE_MIRRORED_SCREENER_KEYS);
    const where = new Map<string, number>();
    for (const s of ONBOARDING_STEPS) for (const k of s.screeners) where.set(k, (where.get(k) ?? 0) + 1);
    for (const q of SCREENER_QUESTIONS) {
      expect(where.get(q.key) ?? 0, q.key).toBe(mirrored.has(q.key) ? 0 : 1);
    }
    for (const k of where.keys()) {
      expect(SCREENER_QUESTIONS.some((q) => q.key === k), `${k} is not a registry question`).toBe(true);
    }
  });

  it("a step's save writes exactly its own columns — never completion, never the progress pointer", () => {
    const draft = {
      ...EMPTY_PROFILE,
      legal_first_name: "Maya",
      legal_last_name: "Chen",
      phone: "555-0100",
      school: "Pitt",
      titles: "Software Engineer Intern",
    };
    for (const s of ONBOARDING_STEPS) {
      const patch = stepPatch(s, draft);
      expect(Object.keys(patch).sort(), s.slug).toEqual([...s.columns].sort());
      expect(patch).not.toHaveProperty("onboarding_completed_at");
      expect(patch).not.toHaveProperty("onboarding_progress");
      expect(patch).not.toHaveProperty("user_id");
    }
    const identity = stepPatch(stepBySlug("identity")!, draft) as Partial<ProfileRow>;
    expect(identity.full_name).toBe("Maya Chen");
    const education = stepPatch(stepBySlug("education")!, draft) as Partial<ProfileRow>;
    expect(education.education?.[0]?.school).toBe("Pitt");
    const prefs = stepPatch(stepBySlug("preferences")!, draft) as Partial<ProfileRow>;
    expect(prefs.job_preferences).toEqual({
      titles: ["Software Engineer Intern"],
      locations: [],
      employment_types: [],
    });
  });

  it("every column a step writes is one draftToRow produces", () => {
    const row = draftToRow("u", EMPTY_PROFILE);
    for (const s of ONBOARDING_STEPS) {
      for (const c of s.columns) expect(c in row, `${s.slug}.${c}`).toBe(true);
    }
  });

  it("blank screener answers are kept in the save so the stored row is deleted (blank = ask me)", () => {
    const rows = screenerRows(stepBySlug("eligibility")!, { age_over_18: "Yes" });
    expect(rows.find((r) => r.key === "age_over_18")?.answer).toBe("Yes");
    expect(rows.find((r) => r.key === "security_clearance")?.answer).toBe("");
    expect(rows.every((r) => r.kind === "registry")).toBe(true);
  });

  it("navigation: first step has no back, review has no next, an unknown bookmark lands on step 1", () => {
    expect(neighbours("identity").prev).toBeNull();
    expect(neighbours("review").next).toBeNull();
    expect(neighbours("documents")).toEqual({ prev: "experience", next: "eligibility" });
    expect(resumeSlug(null)).toBe("identity");
    expect(resumeSlug({ step: "nope" })).toBe("identity");
    expect(resumeSlug({ step: "about" })).toBe("about");
    expect(stepBySlug(undefined)).toBeNull();
  });

  it("row → draft → row keeps what the user wrote", () => {
    const draft = {
      ...EMPTY_PROFILE,
      legal_first_name: "Maya",
      legal_last_name: "Chen",
      school: "Pitt",
      grad_year: "2027",
      gpa: "3.7",
      needs_sponsorship: "no" as const,
      restrictive_covenants: "" as const,
      skills: "Python, SQL",
      employment_history: [
        {
          company: "Acme",
          title: "Intern",
          location: "",
          start_month: "June",
          start_year: "2025",
          end_month: "",
          end_year: "",
          current: true,
          remote: false,
          summary: "",
        },
      ],
    };
    const row = draftToRow("u", draft);
    // "" stays null: an unanswered non-compete question is not a "no".
    expect(row.restrictive_covenants).toBeNull();
    const back = rowToDraft({ ...row, onboarding_completed_at: null } as ProfileRow);
    expect(back.legal_first_name).toBe("Maya");
    expect(back.school).toBe("Pitt");
    expect(back.grad_year).toBe("2027");
    expect(back.gpa).toBe("3.7");
    expect(back.needs_sponsorship).toBe("no");
    expect(back.restrictive_covenants).toBe("");
    expect(back.skills).toBe("Python, SQL");
    expect(back.employment_history[0]?.current).toBe(true);
  });
});

describe("onboarding step schemas (UNIT_CONFIRMED)", () => {
  it("every step with fields has a schema whose lenient shape is exactly those fields (+ screeners)", () => {
    for (const s of ONBOARDING_STEPS) {
      const schemas = STEP_SCHEMAS[s.slug];
      if (s.fields.length === 0) {
        expect(schemas, `${s.slug} has no form`).toBeUndefined();
        continue;
      }
      expect(schemas, s.slug).toBeDefined();
      const keys = Object.keys(schemas!.lenient.shape).sort();
      const want = [...s.fields, ...(s.screeners.length > 0 ? ["screeners"] : [])].sort();
      expect(keys, s.slug).toEqual(want);
    }
  });

  it("no schema invents an answer: no .default( and no .catch(", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "frontend", "src", "public", "onboarding", "schema.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\.default\(/);
    expect(src).not.toMatch(/\.catch\(/);
  });

  it("work-authorization values mirror WORK_AUTH_OPTIONS plus unanswered", () => {
    expect([...WORK_AUTH_VALUES].sort()).toEqual(
      [...WORK_AUTH_OPTIONS.map((o) => o.value), ""].sort(),
    );
  });

  it("lenient saves a half-finished step; strict refuses what the server will refuse", () => {
    const identity = STEP_SCHEMAS.identity!;
    const blank = {
      full_name: "",
      legal_first_name: "",
      legal_middle_name: "",
      legal_last_name: "",
      preferred_name: "",
      contact_email: "",
      linkedin_url: "",
      github_url: "",
      portfolio_url: "",
    };
    expect(identity.lenient.safeParse(blank).success).toBe(true);
    expect(identity.strict.safeParse(blank).success).toBe(false);
    expect(
      identity.strict.safeParse({ ...blank, legal_first_name: "Maya", legal_last_name: "Chen" }).success,
    ).toBe(true);
    // Shape errors block even the autosave: a typo never reaches a form.
    expect(identity.lenient.safeParse({ ...blank, contact_email: "not-an-email" }).success).toBe(false);
    expect(identity.lenient.safeParse({ ...blank, linkedin_url: "linkedin.com/in/x" }).success).toBe(false);

    const eligibility = STEP_SCHEMAS.eligibility!;
    const unset = {
      work_authorization: "",
      needs_sponsorship: "",
      open_to_relocation: "",
      restrictive_covenants: "",
      screeners: {},
    };
    expect(eligibility.lenient.safeParse(unset).success).toBe(true);
    const refused = eligibility.strict.safeParse(unset);
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.issues.map((i) => i.path[0]).sort()).toEqual([
        "needs_sponsorship",
        "work_authorization",
      ]);
    }
    expect(
      eligibility.strict.safeParse({ ...unset, work_authorization: "us_citizen", needs_sponsorship: "no" })
        .success,
    ).toBe(true);
    // Not one of ours ⇒ rejected, never coerced.
    expect(eligibility.lenient.safeParse({ ...unset, work_authorization: "citizen" }).success).toBe(false);

    const about = STEP_SCHEMAS.about!;
    expect(about.strict.safeParse({ about_me: "short" }).success).toBe(false);
    expect(about.strict.safeParse({ about_me: "x".repeat(ABOUT_MIN) }).success).toBe(true);

    const education = STEP_SCHEMAS.education!;
    const entry = {
      school: "Pitt",
      degree: "",
      field: "",
      start_month: "",
      start_year: "",
      grad_month: "",
      grad_year: "27",
      gpa: "",
      additional_fields: "",
      more_education: [],
    };
    expect(education.lenient.safeParse(entry).success).toBe(false);
    expect(education.lenient.safeParse({ ...entry, grad_year: "2027" }).success).toBe(true);
    expect(education.strict.safeParse({ ...entry, school: "", grad_year: "" }).success).toBe(false);
  });
});
