import { describe, expect, it } from "vitest";
import {
  classPatternPick,
  HOW_HEARD_CLASS_PATTERNS,
  labelsCompatible,
  pickOptionLabel,
} from "../../src/ats/greenhouse/comboboxFill.js";
import { wizardHeadingOf } from "../../src/applications/workdayWizard.js";
import { matchCanonicalField } from "../../src/applications/fieldNormalization.js";
import { inRePickCooldown, lastPickedAtOf, RE_PICK_COOLDOWN_MS } from "../../src/queue/rePickCooldown.js";

/**
 * Day32 (2026-09-14) walls, pure halves. 125 overnight cycles produced one
 * submission; the live reports named these mechanisms. UNIT_CONFIRMED.
 */

describe("how-did-you-hear class ladder (operator directive 2026-09-14)", () => {
  it("picks any social-media row when LinkedIn is absent, before job boards and the internet", () => {
    // Live PIMCO wd1 shape, once the RIGHT listbox is read.
    const options = ["Select One", "Employee Referral", "Career Fair", "Social Networking Site", "Job Board", "Other"];
    expect(classPatternPick(options, HOW_HEARD_CLASS_PATTERNS)).toBe("Social Networking Site");
    expect(classPatternPick(["Career Fair", "Indeed", "Company Website", "LinkedIn"], HOW_HEARD_CLASS_PATTERNS)).toBe("LinkedIn");
    expect(classPatternPick(["Career Fair", "Facebook", "Job Board"], HOW_HEARD_CLASS_PATTERNS)).toBe("Facebook");
    expect(classPatternPick(["Career Fair", "Online Job Board", "Newspaper"], HOW_HEARD_CLASS_PATTERNS)).toBe("Online Job Board");
    expect(classPatternPick(["Career Fair", "Newspaper", "Company Website"], HOW_HEARD_CLASS_PATTERNS)).toBe("Company Website");
  });

  it("never invents: no class row ⇒ null, and a placeholder row is never picked", () => {
    expect(classPatternPick(["Select One", "Career Fair", "Employee Referral", "Newspaper"], HOW_HEARD_CLASS_PATTERNS)).toBeNull();
    expect(classPatternPick(["Select One", "Please select"], [/select/i])).toBeNull();
  });
});

describe("phone device type: Mobile ↔ Cell (live PIMCO wd1 2026-09-14)", () => {
  it("picks the personal cell row for Mobile and never the business one", () => {
    const options = ["Select One", "Cell - Business", "Cell - Personal", "Home", "Work"];
    const pick = pickOptionLabel(options, "Mobile");
    expect(pick.ok && pick.label).toBe("Cell - Personal");
    const only = pickOptionLabel(["Home", "Work", "Cellular"], "Mobile");
    expect(only.ok && only.label).toBe("Cellular");
  });

  it("verify accepts the committed cell label for an expected Mobile, and still refuses Home", () => {
    expect(labelsCompatible("Mobile", "Cell - Personal")).toBe(true);
    expect(labelsCompatible("Mobile", "Home")).toBe(false);
    expect(labelsCompatible("Work", "Cell - Personal")).toBe(false);
  });

  it("only a value that IS a device type takes the bucket (gate: 'Chicago office' must not key to 'office')", () => {
    expect(pickOptionLabel(["Remote", "New York office", "Chicago"], "Chicago office").ok).toBe(false);
    expect(labelsCompatible("Chicago office", "New York office")).toBe(false);
    expect(pickOptionLabel(["Cell - Personal", "Home"], "mobile phone").ok).toBe(true);
  });
});

describe("wizard page identity reads past a constant site heading (live rb.wd5 + PIMCO 2026-09-14)", () => {
  it("includes the step heading, so My Information → Application Questions is an advance", () => {
    const fed1 = `<h1>Federal Reserve System Careers</h1><h2>My Information</h2><label>Phone<input/></label>`;
    const fed3 = `<h1>Federal Reserve System Careers</h1><h2>Application Questions 1 of 3</h2><label>Are you 18?<select/></label>`;
    expect(wizardHeadingOf(fed1)).toBe("Federal Reserve System Careers | My Information");
    expect(wizardHeadingOf(fed3)).not.toBe(wizardHeadingOf(fed1));
    const pimco2 = `<h1>2027 Summer Intern - Technology Analyst</h1><h2>My Experience</h2>`;
    const pimco1 = `<h1>2027 Summer Intern - Technology Analyst</h1><h2>My Information</h2>`;
    expect(wizardHeadingOf(pimco2)).not.toBe(wizardHeadingOf(pimco1));
  });

  it("an identical re-render still reads identical (the #278 cap keeps working)", () => {
    const stuck = `<h2>My Information</h2><p>Error: required</p>`;
    expect(wizardHeadingOf(stuck)).toBe(wizardHeadingOf(stuck + "<p>Error: required (2)</p>"));
    expect(wizardHeadingOf("<p>no headings</p>")).toBe("");
  });
});

describe("a generic discipline word never carries an option match (live rb.wd5 Field of Study 2026-09-14)", () => {
  it('"Computer Science" refuses [Accounting | Actuarial Science] and matches the real row when present', () => {
    expect(pickOptionLabel(["Accounting", "Actuarial Science"], "Computer Science").ok).toBe(false);
    const hit = pickOptionLabel(["Accounting", "Actuarial Science", "Computer Science", "Computer Engineering"], "Computer Science");
    expect(hit.ok && hit.label).toBe("Computer Science");
    // Distinctive-token matches still work for nicknames.
    const math = pickOptionLabel(["Actuarial Science", "Mathematics", "Statistics and Data Science"], "Applied Math & Stats");
    expect(math.ok).toBe(true);
  });
});

describe("Workday legal-name ids outrank slid labels (live rb.wd5 2026-09-14)", () => {
  const f = (id: string, label: string) => ({ id, inputId: id, label, type: "text" as const, required: false });
  it("maps by the control id and never maps the local-script inputs", () => {
    expect(matchCanonicalField(f("name--legalName--firstName", "Last Name"), {})).toBe("legal_name.first");
    expect(matchCanonicalField(f("name--legalName--lastName", "First Name"), {})).toBe("legal_name.last");
    expect(matchCanonicalField(f("name--legalName--middleName", "Middle Name"), {})).toBe("legal_name.middle");
    expect(matchCanonicalField(f("name--legalName--firstNameLocal", "First Name"), {})).toBeNull();
    expect(matchCanonicalField(f("name--legalName--lastNameLocal", "Middle Name"), {})).toBeNull();
  });
});

describe("#279 re-pick cooldown", () => {
  const now = new Date("2026-09-14T12:00:00Z");
  it("holds an in-flight row that was just bumped, releases it after the window", () => {
    expect(inRePickCooldown("NATIVE_AUTOFILL_RUNNING", "2026-09-14T11:50:00Z", now)).toBe(true);
    expect(inRePickCooldown("NATIVE_AUTOFILL_RUNNING", new Date(now.getTime() - RE_PICK_COOLDOWN_MS - 1).toISOString(), now)).toBe(false);
    expect(inRePickCooldown("FIELD_VERIFICATION", "2026-09-14T11:59:59Z", now)).toBe(true);
  });
  it("never delays fresh QUEUED rows, READY_TO_SUBMIT, or rows never handed out", () => {
    expect(inRePickCooldown("QUEUED", "2026-09-14T11:59:59Z", now)).toBe(false);
    expect(inRePickCooldown("READY_TO_SUBMIT", "2026-09-14T11:59:59Z", now)).toBe(false);
    expect(inRePickCooldown("NATIVE_AUTOFILL_RUNNING", null, now)).toBe(false);
    expect(inRePickCooldown("NATIVE_AUTOFILL_RUNNING", "not a date", now)).toBe(false);
  });
  it("reads the picker's stamp from versions_json and nothing else", () => {
    expect(lastPickedAtOf(JSON.stringify({ automation_excluded: false, last_picked_at: "2026-09-14T11:50:00Z" }))).toBe("2026-09-14T11:50:00Z");
    // An operator requeue or a seeded row carries no stamp — never delayed.
    expect(lastPickedAtOf(JSON.stringify({ adapter: "workday" }))).toBeNull();
    expect(lastPickedAtOf("not json")).toBeNull();
    expect(lastPickedAtOf(null)).toBeNull();
  });
});
