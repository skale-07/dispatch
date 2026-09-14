import { describe, expect, it } from "vitest";
import { EMPTY_PROFILE } from "../../frontend/src/public/contract.js";
import {
  IMPORT_PROMPT,
  RESUME_PLACEHOLDER,
  buildImportPrompt,
  importDraft,
} from "../../frontend/src/public/importPrompt.js";

/**
 * The bring-your-own-LLM onboarding import. This is the one path where a
 * model's output lands in a user's own profile and travels to a real
 * employer under their name, so the parser is tested adversarially: the
 * question is never "does the happy path work", it is "what happens when
 * the model volunteers something it was told not to".
 *
 * No test calls a model. UNIT_CONFIRMED.
 */
describe("onboarding import prompt (UNIT_CONFIRMED)", () => {
  it("the prompt never asks for work authorization or demographics", () => {
    // The prompt is the contract with the user's own assistant; if it
    // asks, some model somewhere will answer.
    for (const forbidden of [
      /"work_authorization"/,
      /"needs_sponsorship"/,
      /"gender"/,
      /"race"/,
      /"ethnicity"/,
      /"veteran/,
      /"disability"/,
      /"pronouns"/,
    ]) {
      expect(IMPORT_PROMPT).not.toMatch(forbidden);
    }
    // …and it says so explicitly, so a model that pattern-matches the
    // shape of a profile form does not helpfully add them.
    expect(IMPORT_PROMPT).toMatch(/Do NOT include work authorization/);
    expect(IMPORT_PROMPT).toMatch(/Do NOT include gender, race/);
    expect(IMPORT_PROMPT).toMatch(/Do not invent anything/);
  });

  it("fills a draft from a clean reply", () => {
    const out = importDraft(
      JSON.stringify({
        full_name: "Alex Rivera",
        school: "Johns Hopkins University",
        degree: "Bachelor of Science",
        field: "Applied Mathematics",
        grad_month: "May",
        grad_year: "2027",
        gpa: "3.7",
        about_me: "I build ML tooling and browser automation.",
        titles: ["Software Engineer", "ML Engineer"],
        remote: "hybrid",
        employment_types: ["internship", "full_time"],
        min_salary_usd: "$70,000",
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.full_name).toBe("Alex Rivera");
    expect(out.draft.school).toBe("Johns Hopkins University");
    expect(out.draft.grad_month).toBe("May");
    expect(out.draft.gpa).toBe("3.7");
    // A list may arrive as an array; the form holds comma-separated text.
    expect(out.draft.titles).toBe("Software Engineer, ML Engineer");
    expect(out.draft.remote).toBe("hybrid");
    expect(out.draft.employment_types).toEqual(["internship", "full_time"]);
    // "$70,000" is what a model returns; the form wants digits.
    expect(out.draft.min_salary_usd).toBe("70000");
  });

  it("DROPS work authorization and demographics a model volunteers anyway", () => {
    const out = importDraft(
      JSON.stringify({
        full_name: "Alex Rivera",
        work_authorization: "us_citizen",
        needs_sponsorship: false,
        gender: "female",
        veteran_status: "not a veteran",
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Never inferred — the wizard asks the user directly, and an unset
    // draft value is the legal "they have not answered yet" state.
    expect(out.draft.work_authorization).toBe("");
    expect(out.draft.needs_sponsorship).toBe("");
    // Not silently swallowed either: the user is told what was ignored.
    expect(out.ignored).toContain("work_authorization");
    expect(out.ignored).toContain("gender");
    expect(out.ignored).toContain("veteran_status");
    expect(JSON.stringify(out.draft)).not.toMatch(/female|veteran/i);
  });

  it("rejects an enum value that is not one of ours", () => {
    const out = importDraft(
      JSON.stringify({
        full_name: "Alex Rivera",
        remote: "flexible-ish",
        employment_types: ["freelance", "internship"],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.remote).toBe("");
    // "freelance" is not on our list; "internship" is.
    expect(out.draft.employment_types).toEqual(["internship"]);
  });

  it("merges over an existing draft instead of blanking it", () => {
    const base = { ...EMPTY_PROFILE, full_name: "Alex Rivera", phone: "555-0100" };
    const out = importDraft(JSON.stringify({ school: "JHU" }), base);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.school).toBe("JHU");
    // An omitted key means "I could not answer", never "clear it".
    expect(out.draft.full_name).toBe("Alex Rivera");
    expect(out.draft.phone).toBe("555-0100");
  });

  it("unwraps a fenced reply and one wrapped in prose", () => {
    const fenced = importDraft('```json\n{"school":"JHU"}\n```');
    expect(fenced.ok).toBe(true);
    if (fenced.ok) expect(fenced.draft.school).toBe("JHU");

    const chatty = importDraft(
      'Sure! Here is the JSON:\n{"school":"JHU"}\nLet me know if you need changes.',
    );
    expect(chatty.ok).toBe(true);
    if (chatty.ok) expect(chatty.draft.school).toBe("JHU");
  });

  it("refuses non-JSON, an array, and a reply with no known fields", () => {
    expect(importDraft("I cannot help with that.").ok).toBe(false);
    expect(importDraft("[]").ok).toBe(false);
    expect(importDraft("").ok).toBe(false);
    const noFields = importDraft(JSON.stringify({ favourite_colour: "blue" }));
    expect(noFields.ok).toBe(false);
    if (!noFields.ok) expect(noFields.reason).toMatch(/none of the expected fields/);
  });

  it("ignores a nested object where text belongs — a bad paste is not a fill", () => {
    const out = importDraft(
      JSON.stringify({
        full_name: { first: "Alex", last: "Rivera" },
        school: "JHU",
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.full_name).toBe("");
    expect(out.draft.school).toBe("JHU");
  });
});

describe("onboarding import: structured history (M23, UNIT_CONFIRMED)", () => {
  it("the prompt asks for detailed roles, flat skills and other schools — and still never for authorization", () => {
    expect(IMPORT_PROMPT).toMatch(/"employment_history": \[/);
    expect(IMPORT_PROMPT).toMatch(/"education": \[/);
    expect(IMPORT_PROMPT).toMatch(/"skills": \[/);
    expect(IMPORT_PROMPT).toMatch(/DETAIL BEATS BREVITY/);
    expect(IMPORT_PROMPT).toMatch(/Never guess a month/);
    expect(IMPORT_PROMPT).not.toMatch(/"work_authorization"|"needs_sponsorship"|"gender"|"race"/);
    // The placeholder is what buildImportPrompt() fills.
    expect(IMPORT_PROMPT.endsWith(RESUME_PLACEHOLDER)).toBe(true);
    const built = buildImportPrompt("ADA EXAMPLE\nEXPERIENCE\nIntern – Acme");
    expect(built).not.toContain(RESUME_PLACEHOLDER);
    expect(built.endsWith("Intern – Acme")).toBe(true);
    expect(buildImportPrompt("   ")).toBe(IMPORT_PROMPT);
  });

  it("validates each role field by field: strings, 4-digit years, real booleans; nameless objects are dropped", () => {
    const out = importDraft(
      JSON.stringify({
        skills: ["Python", "pandas", "SQL"],
        employment_history: [
          {
            company: "Northwind Traders",
            title: "Software Engineer Intern",
            location: "Seattle, WA",
            start_month: "June",
            start_year: 2025,
            end_month: "August",
            end_year: "2025",
            current: "no", // not a boolean ⇒ false
            description: "Built a Go service that ingests 40M events/day\nWrote integration tests with Testcontainers",
          },
          { company: "Hopkins Systems Lab", title: "Research Assistant", start_year: "24", current: true, location: "Remote" },
          { description: "no company, no title" },
          "not an object",
        ],
        education: [
          { school: "Johns Hopkins University", degree: "Bachelor of Science", field: "Computer Science", grad_month: "May", grad_year: "2027", gpa: "3.82" },
          { school: "Community College of Example", degree: "A.S.", major: "Mathematics", end_year: 2024, gpa: "high" },
          { degree: "no school" },
        ],
      }),
      { ...EMPTY_PROFILE, skills: "SQL, Excel" },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.filled).toEqual(expect.arrayContaining(["skills", "employment_history", "current_company", "school", "education"]));
    expect(out.draft.skills).toBe("SQL, Excel, Python, pandas");
    expect(out.draft.employment_history).toHaveLength(2);
    expect(out.draft.employment_history[0]).toMatchObject({
      company: "Northwind Traders",
      title: "Software Engineer Intern",
      location: "Seattle, WA",
      start_month: "June",
      start_year: "2025",
      end_month: "August",
      end_year: "2025",
      current: false,
      remote: false,
    });
    expect(out.draft.employment_history[0]!.summary).toContain("Testcontainers");
    // "24" is not a year; "Remote" as the location marks the role remote.
    expect(out.draft.employment_history[1]).toMatchObject({ start_year: "", current: true, remote: true });
    expect(out.draft.current_company).toBe("Hopkins Systems Lab");
    // No flat school in the reply ⇒ the first object is the primary school.
    expect(out.draft.school).toBe("Johns Hopkins University");
    expect(out.draft.gpa).toBe("3.82");
    expect(out.draft.more_education).toHaveLength(1);
    expect(out.draft.more_education[0]).toMatchObject({ school: "Community College of Example", field: "Mathematics", grad_year: "2024", gpa: "" });
  });

  it("a flat school stays primary; a matching education[] entry is not duplicated", () => {
    const out = importDraft(
      JSON.stringify({
        school: "JHU",
        education: [{ school: "jhu" }, { school: "Elsewhere College" }],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.draft.school).toBe("JHU");
    expect(out.draft.more_education.map((e) => e.school)).toEqual(["Elsewhere College"]);
  });
});
