import { describe, expect, it } from "vitest";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { historyOrdinals, historyRowAnswer } from "../../src/applications/historyRows.js";
import type { MappedField } from "../../src/applications/fieldNormalization.js";
import { parsePublicProfile, structuredEmploymentHistory } from "../../src/candidate/publicProfile.js";

/**
 * Operator directive 2026-09-14: Workday "My Experience" rows fill from the
 * profile's structured employment/education entries (extracted from the
 * resumes). Field ids and labels below are the live PIMCO wd1 page
 * (artifacts wizard-page-2 snapshot, app fd529364). UNIT_CONFIRMED.
 */

const PROFILE = parsePublicProfile({
  legal_name: { first: "Shubham", last: "Kale" },
  email: "s@example.test",
  phone: "4805550100",
  employment_history: [
    {
      company: "Summer Atlantic Capital LLC & SAC Nexus",
      title: "Software Engineer, Product Development Team",
      location: { city: "Baltimore", state: "Maryland", country: "United States" },
      start: { month: "June", year: 2026 },
      end: null,
      current: true,
      description: "Built and shipped a compliance-scoring layer across 4 financial-risk workflows.",
    },
    {
      company: "SnapSort",
      title: "Founder & Engineering Lead",
      location: { city: "Phoenix", state: "Arizona", country: "United States" },
      start: { month: "January", year: 2024 },
      end: { month: "August", year: 2025 },
      current: false,
      description: "Led a team of 4.",
    },
    "Gates Foundation", // legacy string entry — ignored, never invented from
  ],
  education_history: [
    {
      school: "Johns Hopkins University",
      degree: "Bachelor of Science",
      field_of_study: "Computer Science",
      start: { month: "August", year: 2025 },
      end: { month: "May", year: 2029 },
      current: true,
      gpa: 3.7,
    },
  ],
});

const f = (id: string, label: string, type: MappedField["type"] = "text", extra: Partial<MappedField> = {}): MappedField => ({
  id,
  label,
  type,
  required: true,
  inputId: id,
  canonical_field: null,
  mapping_confidence: "none",
  ...extra,
});

/** The live PIMCO My Experience page: Workday numbers its rows 6 and 7. */
const PIMCO_ROWS: MappedField[] = [
  f("workExperience-6--jobTitle", "Job Title"),
  f("workExperience-6--companyName", "Company"),
  f("workExperience-6--location", "Location"),
  f("workExperience-6--currentlyWorkHere", "I currently work here", "checkbox"),
  f("workExperience-6--startDate", "From"),
  f("workExperience-6--endDate", "To"),
  f("workExperience-6--roleDescription", "Role Description", "textarea"),
  f("education-7--schoolName", "School or University"),
  f("education-7--degree", "Degree", "select"),
  f("education-7--fieldOfStudy", "Field of Study"),
  f("education-7--gradeAverage", "Overall Result (GPA)"),
];

describe("structured history entries", () => {
  it("parses the structured entries and ignores legacy strings", () => {
    const jobs = structuredEmploymentHistory(PROFILE);
    expect(jobs.map((j) => j.company)).toEqual(["Summer Atlantic Capital LLC & SAC Nexus", "SnapSort"]);
  });

  it("orders rows by first appearance, not by Workday's row numbers", () => {
    const ordinals = historyOrdinals([
      f("workExperience-13--jobTitle", "Job Title"),
      f("workExperience-6--jobTitle", "Job Title"),
      f("education-7--schoolName", "School"),
      f("workExperience-13--companyName", "Company"),
    ]);
    expect(ordinals.get("employment:13")).toBe(0);
    expect(ordinals.get("employment:6")).toBe(1);
    expect(ordinals.get("education:7")).toBe(0);
  });
});

describe("Workday My Experience rows (live PIMCO wd1 2026-09-14)", () => {
  it("fills every required row control from the first structured entry and approves them", () => {
    const plan = buildFillPlan(PIMCO_ROWS, PROFILE);
    const byId = new Map(plan.entries.map((e) => [e.field_id, e]));
    expect(byId.get("workExperience-6--jobTitle")).toMatchObject({ action: "fill", value: "Software Engineer, Product Development Team", canonical_field: "history:employment[0].title" });
    expect(byId.get("workExperience-6--companyName")).toMatchObject({ action: "fill", value: "Summer Atlantic Capital LLC & SAC Nexus" });
    expect(byId.get("workExperience-6--location")).toMatchObject({ action: "fill", value: "Baltimore, Maryland" });
    expect(byId.get("workExperience-6--currentlyWorkHere")).toMatchObject({ action: "fill", value: true });
    expect(byId.get("workExperience-6--startDate")).toMatchObject({ action: "fill", value: "June 2026" });
    // Current position: the end date is deliberately left empty, with the reason.
    expect(byId.get("workExperience-6--endDate")).toMatchObject({ action: "skip_empty" });
    expect(byId.get("workExperience-6--endDate")?.reason).toMatch(/current position, no end date/);
    expect(byId.get("workExperience-6--roleDescription")).toMatchObject({ action: "fill", canonical_field: "history:employment[0].description" });
    expect(byId.get("education-7--schoolName")).toMatchObject({ action: "fill", value: "Johns Hopkins University" });
    expect(byId.get("education-7--degree")).toMatchObject({ action: "fill", value: "Bachelor of Science" });
    expect(byId.get("education-7--fieldOfStudy")).toMatchObject({ action: "fill", value: "Computer Science" });
    expect(byId.get("education-7--gradeAverage")).toMatchObject({ action: "fill", value: "3.7" });

    // The approved plan keeps them — including the Role Description textarea
    // (a resume fact, not an essay).
    const approved = toApprovedFillPlan(plan.entries);
    const desc = approved.entries.find((e) => e.field_id === "workExperience-6--roleDescription");
    expect(desc?.approved).toBe(true);
    expect(approved.entries.filter((e) => e.approved).length).toBe(10);
  });

  it("a second row takes the second entry; a row past the profile stays empty with the reason", () => {
    const second = f("workExperience-9--companyName", "Company");
    const plan = buildFillPlan([...PIMCO_ROWS, second, f("workExperience-11--companyName", "Company")], PROFILE);
    const byId = new Map(plan.entries.map((e) => [e.field_id, e]));
    expect(byId.get("workExperience-9--companyName")).toMatchObject({ action: "fill", value: "SnapSort", canonical_field: "history:employment[1].company" });
    const third = byId.get("workExperience-11--companyName");
    expect(third?.action).not.toBe("fill");
  });

  it("a row the resume parse already filled is kept (#150), never overwritten", () => {
    const plan = buildFillPlan([f("workExperience-6--jobTitle", "Job Title", "text", { currentValue: "Quant Intern" })], PROFILE);
    expect(plan.entries[0]).toMatchObject({ action: "skip_unmapped" });
    expect(plan.entries[0]?.reason).toMatch(/already holds/);
  });

  it("a plain-string profile answers nothing (nothing is invented)", () => {
    const legacy = parsePublicProfile({ legal_name: { first: "A", last: "B" }, email: "a@b.test", phone: "1", employment_history: ["Summer Atlantic Capital"] });
    const r = historyRowAnswer(f("workExperience-6--jobTitle", "Job Title"), 0, legacy);
    expect(r.answer).toBeNull();
    expect(r.reasonWhenEmpty).toMatch(/0 structured employment entries/);
  });

  it("names the datum by label when the id carries no structure (board shapes)", () => {
    const r = historyRowAnswer(f("job_application[employments_attributes][0][title]", "Title"), 0, PROFILE);
    expect(r.answer?.value).toBe("Software Engineer, Product Development Team");
    const e = historyRowAnswer(f("job_application[educations_attributes][0][school_name_id]", "School"), 0, PROFILE);
    expect(e.answer?.value).toBe("Johns Hopkins University");
  });
});
