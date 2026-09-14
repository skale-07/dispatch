import { describe, expect, it } from "vitest";
import { EMPTY_EMPLOYMENT_ENTRY, EMPTY_PROFILE } from "../../frontend/src/public/contract.js";
import {
  applyResumeToDraft,
  expandDegree,
  findDateRange,
  parseResumeText,
} from "../../frontend/src/public/resumeParse.js";

/**
 * M23 "Fill from resume": the on-device reader. Fixtures are STRUCTURE
 * ONLY — invented names, invented companies — laid out the way the two
 * common student templates lay them out (title-first with the date on
 * the title line; company-first with the location on the company line),
 * plus a resume with no dates at all, because a reader that needs a
 * date to find a role would drop half the world's resumes.
 *
 * No model, no PDF: the PDF → lines step (resumePdf.ts) is browser-only
 * and covered by the build; this pins what the lines become.
 * UNIT_CONFIRMED.
 */

/** Title-first (the "Jake's resume" layout): title + date, then company + location. */
const TITLE_FIRST = `
Ada Example
Baltimore, MD | (410) 555-0199 | ada@example.edu | linkedin.com/in/ada-example | github.com/adaexample

EDUCATION
Johns Hopkins University    Baltimore, MD
Bachelor of Science in Computer Science, Minor in Applied Mathematics    Expected May 2027
GPA: 3.82/4.0

EXPERIENCE
Software Engineer Intern    June 2025 – August 2025
Northwind Traders, Platform Team    Seattle, WA
• Built a Go service that ingests 40M events/day, cutting p99 latency from 900ms to 120ms
• Wrote integration tests with Testcontainers; coverage rose from 41% to 78%
• Led the migration of three cron jobs to Temporal workflows,
  removing a class of duplicate-run incidents
Undergraduate Research Assistant    Sep 2024 – Present
Hopkins Systems Lab    Baltimore, MD
• Prototyped a Rust fuzzer for eBPF verifiers; found two upstream bugs

LEADERSHIP
Treasurer    Fall 2024 – Present
ACM Student Chapter    Remote
• Manage a $6k budget and sponsor outreach for 300 members

TECHNICAL SKILLS
Languages: Python, Go, Rust, TypeScript, SQL
Frameworks: React, Node.js, gRPC
Tools: Docker, Kubernetes (EKS), Git, Temporal
`;

/** Company-first (the Harvard OCS layout): company + location, then title + date. */
const COMPANY_FIRST = `
GRACE SAMPLE
grace.sample@example.com · 617-555-0142 · https://gracesample.dev

Education
Example State University, Columbus, OH
B.A., Economics; Minor: Statistics. GPA 3.6. May 2026
Community College of Example, Columbus, OH
A.S., Mathematics, 2022 – 2024

Professional Experience
Contoso Analytics, Inc.    Boston, MA
Data Analyst Intern    05/2025 – 08/2025
- Built dashboards in Tableau for 12 client accounts
- Automated weekly reporting with Python and SQL, saving 6 hours a week
Fabrikam Foundation    Remote
Grants Assistant    2023 – 2024
- Reviewed 80+ applications per cycle

Skills
Python (pandas, NumPy); SQL; Tableau; R; Excel
`;

/** No dates anywhere, one employer per line with " at ". */
const NO_DATES = `
Sam Nodate
sam@example.org

Experience
Barista at Blue Bean Coffee
Made drinks, opened and closed the store, trained two new hires.
Camp Counselor at Camp Example
Supervised a cabin of ten campers.

Education
Example High School
High School Diploma
`;

describe("resume reader: dates (UNIT_CONFIRMED)", () => {
  it("reads month/season/numeric ranges and never invents a month", () => {
    expect(findDateRange("June 2025 – August 2025")).toMatchObject({
      start: { month: "June", year: "2025" },
      end: { month: "August", year: "2025" },
      current: false,
    });
    expect(findDateRange("Sep 2024 - Present")).toMatchObject({
      start: { month: "September", year: "2024" },
      end: null,
      current: true,
    });
    expect(findDateRange("05/2025 – 08/2025")).toMatchObject({
      start: { month: "May", year: "2025" },
      end: { month: "August", year: "2025" },
    });
    // A season is not a month.
    expect(findDateRange("Summer 2024 – Fall 2024")).toMatchObject({
      start: { month: "", year: "2024" },
      end: { month: "", year: "2024" },
    });
    expect(findDateRange("2023 to 2024")).toMatchObject({
      start: { month: "", year: "2023" },
      end: { month: "", year: "2024" },
    });
    expect(findDateRange("Built 40M events/day pipelines")).toBeNull();
  });

  it("expands degree abbreviations (a conversion, not a guess)", () => {
    expect(expandDegree("B.S.")).toBe("Bachelor of Science");
    expect(expandDegree("BS")).toBe("Bachelor of Science");
    expect(expandDegree("M.S.")).toBe("Master of Science");
    expect(expandDegree("MBA")).toBe("Master of Business Administration");
    expect(expandDegree("Bachelor of science")).toBe("Bachelor of Science");
    expect(expandDegree("High School Diploma")).toBe("High School Diploma");
  });
});

describe("resume reader: title-first layout (UNIT_CONFIRMED)", () => {
  const r = parseResumeText(TITLE_FIRST);

  it("finds every heading and one role per dated block, keeping every bullet", () => {
    expect(r.headings).toEqual(["EDUCATION", "EXPERIENCE", "LEADERSHIP", "TECHNICAL SKILLS"]);
    expect(r.employment.map((e) => [e.title, e.company])).toEqual([
      ["Software Engineer Intern", "Northwind Traders, Platform Team"],
      ["Undergraduate Research Assistant", "Hopkins Systems Lab"],
      ["Treasurer", "ACM Student Chapter"],
    ]);
    const first = r.employment[0]!;
    expect(first).toMatchObject({
      location: "Seattle, WA",
      remote: false,
      start_month: "June",
      start_year: "2025",
      end_month: "August",
      end_year: "2025",
      current: false,
      section: "EXPERIENCE",
    });
    // Three bullets, the wrapped third one re-joined; nothing shortened.
    expect(first.summary.split("\n")).toHaveLength(3);
    expect(first.summary).toContain("cutting p99 latency from 900ms to 120ms");
    expect(first.summary).toContain("removing a class of duplicate-run incidents");
    expect(r.employment[1]).toMatchObject({ current: true, end_year: "", location: "Baltimore, MD" });
    expect(r.employment[2]).toMatchObject({
      section: "LEADERSHIP",
      location: "Remote",
      remote: true,
      start_month: "", // "Fall 2024": the year, not an invented month
      start_year: "2024",
      current: true,
    });
  });

  it("reads the school, degree, major, minor, GPA and expected graduation", () => {
    expect(r.education).toHaveLength(1);
    expect(r.education[0]).toMatchObject({
      school: "Johns Hopkins University",
      degree: "Bachelor of Science",
      field: "Computer Science",
      additional_fields: "Applied Mathematics",
      gpa: "3.82",
      grad_month: "May",
      grad_year: "2027",
    });
  });

  it("splits skills by category, comma and parenthetical", () => {
    expect(r.skills).toEqual(
      expect.arrayContaining(["Python", "Go", "Rust", "TypeScript", "SQL", "React", "Node.js", "gRPC", "Docker", "Kubernetes", "EKS", "Git", "Temporal"]),
    );
    expect(r.skills).not.toContain("Languages");
    expect(r.skills).not.toContain("Tools");
  });

  it("reads the contact header", () => {
    expect(r.contact).toMatchObject({
      full_name: "Ada Example",
      phone: "(410) 555-0199",
      linkedin_url: "https://linkedin.com/in/ada-example",
      github_url: "https://github.com/adaexample",
    });
    expect(r.contact.portfolio_url).toBeUndefined();
  });
});

describe("resume reader: company-first layout (UNIT_CONFIRMED)", () => {
  const r = parseResumeText(COMPANY_FIRST);

  it("puts the company on the location line and the title on the date line", () => {
    expect(r.employment.map((e) => [e.title, e.company, e.location])).toEqual([
      ["Data Analyst Intern", "Contoso Analytics, Inc.", "Boston, MA"],
      ["Grants Assistant", "Fabrikam Foundation", "Remote"],
    ]);
    expect(r.employment[0]).toMatchObject({ start_month: "May", start_year: "2025", end_month: "August", end_year: "2025" });
    expect(r.employment[0]!.summary).toContain("saving 6 hours a week");
    expect(r.employment[1]).toMatchObject({ remote: true, start_year: "2023", end_year: "2024", start_month: "" });
  });

  it("reads two schools with abbreviations expanded", () => {
    expect(r.education.map((e) => e.school)).toEqual(["Example State University", "Community College of Example"]);
    expect(r.education[0]).toMatchObject({
      degree: "Bachelor of Arts",
      field: "Economics",
      additional_fields: "Statistics",
      gpa: "3.6",
      grad_month: "May",
      grad_year: "2026",
    });
    expect(r.education[1]).toMatchObject({ degree: "Associate of Science", field: "Mathematics", start_year: "2022", grad_year: "2024" });
  });

  it("reads a personal site but not the email's domain", () => {
    expect(r.contact).toMatchObject({ full_name: "Grace Sample", portfolio_url: "https://gracesample.dev", phone: "617-555-0142" });
    expect(r.skills).toEqual(expect.arrayContaining(["Python", "pandas", "NumPy", "SQL", "Tableau", "R", "Excel"]));
  });
});

describe("resume reader: no dates (UNIT_CONFIRMED)", () => {
  it("still returns roles from 'title at company' lines, with blank dates", () => {
    const r = parseResumeText(NO_DATES);
    expect(r.employment.map((e) => [e.title, e.company])).toEqual([
      ["Barista", "Blue Bean Coffee"],
      ["Camp Counselor", "Camp Example"],
    ]);
    expect(r.employment[0]).toMatchObject({ start_year: "", end_year: "", current: false });
    expect(r.employment[0]!.summary).toContain("trained two new hires");
    expect(r.education[0]).toMatchObject({ school: "Example High School", degree: "High School Diploma" });
  });

  it("an empty text layer is reported, not parsed into nonsense", () => {
    const r = parseResumeText("");
    expect(r).toMatchObject({ employment: [], education: [], skills: [], lineCount: 0 });
  });
});

describe("applying a parsed resume to the draft (UNIT_CONFIRMED)", () => {
  const parsed = parseResumeText(TITLE_FIRST);

  it("adds roles, fills a blank primary school, unions skills, fills blank contact — and never overwrites a filled scalar", () => {
    const base = { ...EMPTY_PROFILE, skills: "Python, Excel", full_name: "Keep Me", phone: "" };
    const { draft, filled } = applyResumeToDraft(base, parsed);
    expect(draft.employment_history).toHaveLength(3);
    expect(draft.employment_history[0]!.summary).toContain("Testcontainers");
    expect(draft.school).toBe("Johns Hopkins University");
    expect(draft.gpa).toBe("3.82");
    expect(draft.more_education).toEqual([]);
    expect(draft.skills.startsWith("Python, Excel, Go, Rust")).toBe(true);
    expect(draft.full_name).toBe("Keep Me"); // filled already ⇒ untouched
    expect(draft.phone).toBe("(410) 555-0199");
    // A current role names the current employer only when that is blank.
    expect(draft.current_company).toBe("Hopkins Systems Lab");
    expect(filled).toEqual(expect.arrayContaining(["employment_history", "current_company", "school", "skills", "phone"]));
    expect(filled).not.toContain("full_name");
  });

  it("honours the review choices: picked roles only, replace vs add, no skills, no contact", () => {
    const base = {
      ...EMPTY_PROFILE,
      employment_history: [{ ...EMPTY_EMPLOYMENT_ENTRY, company: "Old Co", title: "Old Title" }],
      school: "Already Filled U",
    };
    const added = applyResumeToDraft(base, parsed, { roles: [0], skills: false, contact: false });
    expect(added.draft.employment_history.map((e) => e.company)).toEqual(["Old Co", "Northwind Traders, Platform Team"]);
    expect(added.draft.skills).toBe("");
    expect(added.draft.phone).toBe("");
    // A filled primary school stays; the resume's school becomes an extra one.
    expect(added.draft.school).toBe("Already Filled U");
    expect(added.draft.more_education.map((e) => e.school)).toEqual(["Johns Hopkins University"]);

    const replaced = applyResumeToDraft(base, parsed, { roles: [0, 2], replaceRoles: true });
    expect(replaced.draft.employment_history.map((e) => e.title)).toEqual(["Software Engineer Intern", "Treasurer"]);
  });

  it("the parsed rows carry no authorization or demographic keys at all", () => {
    expect(JSON.stringify(parsed)).not.toMatch(/work_authorization|sponsorship|gender|race|veteran|disabilit|ethnicit/i);
  });
});
