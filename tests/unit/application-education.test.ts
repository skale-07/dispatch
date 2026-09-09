import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectEducationPolicy, educationProfile, educationBank, resumeVariantForRole, baselineResumeForRole, type ApplicationEducationPolicy } from "../../src/candidate/applicationEducation.js";
import { publicProfileSchema } from "../../src/candidate/publicProfile.js";
import { openDatabase, migrate, closeDatabase, type Db } from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { ensureResumeForApplication } from "../../src/jobright/materialsRegister.js";
import { planApplicationFill } from "../../src/applications/applicationFiller.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

const pdf = path.resolve("tests/fixtures/ats/greenhouse/sample-resume.pdf");
const policy: ApplicationEducationPolicy = { version: 1, graduation_year: 2028, graduation_month: "May", academic_standing: "Sophomore", statement: "I am a sophomore graduating early in May 2028.", resumes: { general: pdf, ds_ai: pdf } };
const profile = publicProfileSchema.parse({ legal_name: { first: "Test", last: "Applicant" }, email: "candidate@example.test", graduation_month: "May", graduation_year: 2029 });

// #228 (operator directive 2026-09-09): DS/ML/AI roles take the DS resume,
// everything else the SWE one — at the baseline graduation year too, not
// only when a posting forces the 2028 variants.
describe("resume family by role (UNIT_CONFIRMED)", () => {
  it.each([
    "Data Science Intern",
    "Data Scientist, Summer 2027",
    "Machine Learning Engineer Intern",
    "ML Engineer (Intern)",
    "Artificial Intelligence Intern",
    "AI Ecosystem Intern",
    "Applied Scientist Intern",
    "Deep Learning Research Intern",
    "Data Analytics Intern",
    "NLP Engineer Intern",
    "Computer Vision Intern",
  ])("routes %s to the DS/AI resume", (role) => {
    expect(resumeVariantForRole(role)).toBe("ds_ai");
  });

  it.each([
    "Software Engineer Intern",
    "Backend Software Engineering Intern",
    "Frontend Engineer, New Grad",
    "Embedded Software Engineering Intern",
    "Security Software Engineering Intern",
    "Full Stack Developer Intern",
  ])("routes %s to the general/SWE resume", (role) => {
    expect(resumeVariantForRole(role)).toBe("general");
  });

  it("the same split drives the 2028 selection, so one role can never get two families", () => {
    const ds = selectEducationPolicy(policy, { role: "Data Science Intern", description: "Required: expected graduation in May 2028." })!;
    const swe = selectEducationPolicy(policy, { role: "Software Engineer Intern", description: "Required: expected graduation in May 2028." })!;
    expect(ds.variant).toBe(resumeVariantForRole("Data Science Intern"));
    expect(swe.variant).toBe(resumeVariantForRole("Software Engineer Intern"));
  });

  it("baseline picks the configured per-role resume, and falls through for general", () => {
    const withBaseline: ApplicationEducationPolicy = { ...policy, baseline_resumes: { general: pdf, ds_ai: pdf } };
    expect(baselineResumeForRole("Data Science Intern", withBaseline)).toBe(path.resolve(pdf));
    expect(baselineResumeForRole("Software Engineer Intern", withBaseline)).toBe(path.resolve(pdf));
    // No baseline map: general defers to the configured default (null here),
    // so existing behaviour for SWE roles is unchanged.
    expect(baselineResumeForRole("Software Engineer Intern", policy)).toBeNull();
  });
});

describe("conditional education (UNIT_CONFIRMED)", () => {
  it.each(["Summer 2028 internship", "Graduation dates between May 2028 and May 2029", "Graduation in 2028 preferred", "Work on the 2028 roadmap"])('does not override from %s', description => {
    expect(selectEducationPolicy(policy, { role: "SWE Intern", description })).toBeNull();
  });
  it("selects the role variant and leaves baseline facts untouched", () => {
    const selection = selectEducationPolicy(policy, { role: "Machine Learning Intern", description: "Required: expected graduation in May 2028." })!;
    expect(selection.variant).toBe("ds_ai");
    expect(educationProfile(profile, selection).graduation_year).toBe(2028);
    expect(profile.graduation_year).toBe(2029);
    const bank = { version: 1 as const, answers: {}, custom: { grad: { answer: "May 2029", labels: ["Expected Graduation Date"], promoted_at: "test" } } };
    expect(educationBank(bank, selection)?.custom.grad?.answer).toBe("May 2028");
    expect(bank.custom.grad.answer).toBe("May 2029");
  });
});

describe("education plan and resume consistency (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv();
  let root: string;
  let db: Db;
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-education-"));
    previous = Object.fromEntries(["PRIVATE_DIR", "ARTIFACTS_DIR"].map(k => [k, process.env[k]]));
    process.env.PRIVATE_DIR = root;
    process.env.ARTIFACTS_DIR = path.join(root, "artifacts");
    resetConfigCache();
    fs.mkdirSync(path.join(root, "candidate"));
    fs.writeFileSync(path.join(root, "candidate/answer-aliases.json"), JSON.stringify({ graduation_year: ["Expected Graduation Date"] }));
    fs.writeFileSync(path.join(root, "candidate/application-education-policy.json"), JSON.stringify(policy));
    fs.writeFileSync(path.join(root, "candidate/screeners.json"), JSON.stringify({ version: 1, answers: {}, custom: { start: { labels: ["Available start date"], answer: "2027-01-01", promoted_at: "test" } } }));
    db = openDatabase(path.join(root, "db.sqlite"));
    migrate(db);
  });
  afterEach(() => {
    closeDatabase(db);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it("registers 2028 material and plans sophomore / May 2028 while preserving availability", async () => {
    const job = upsertJobByFingerprint(db, { company: "Acme", role: "Software Intern", applicationUrl: "https://jobs.ashbyhq.com/acme/test", descriptionText: "Must graduate in 2028." });
    const app = createApplication(db, { jobId: job.id });
    expect(ensureResumeForApplication(db, app.id)).toBe("attached");
    expect(ensureResumeForApplication(db, app.id)).toBe("already");
    const result = await planApplicationFill({ url: "https://jobs.ashbyhq.com/acme/test", profile, capture: { db, applicationId: app.id }, html: '<div data-field-path="grad"><label for="grad">Expected Graduation Date</label><input type="text" placeholder="Pick date..." required></div><label for="year">Academic standing</label><select id="year" required><option>Sophomore</option><option>Junior</option></select><label for="start">Available start date</label><input id="start" type="text" required>' });
    const answers = result.approvedPlan.entries;
    expect(answers.find(a => a.field_id === "grad")?.value).toBe("May 2028");
    expect(answers.find(a => a.field_id === "year")?.value).toBe("Sophomore");
    expect(answers.find(a => a.field_id === "start")?.value).toBe("2027-01-01");
  });
});
