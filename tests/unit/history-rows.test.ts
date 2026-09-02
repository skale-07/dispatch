import { describe, expect, it } from "vitest";
import {
  historyGroupOf,
  mapDiscoveredFields,
  matchCanonicalField,
} from "../../src/applications/fieldNormalization.js";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { readLiveHtml } from "../../src/browser/liveHtml.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

// Live UKG run 17 (2026-09-02, #150): the resume parse rendered five
// work-experience rows; bare "Company"/"Month" in rows 1-4 claimed the
// profile's one current_company / graduation_month, row 0's parsed start
// month was overwritten with the graduation month, and the "Job Title"
// bank entry was typed into every empty row. Submit-stage verify refused
// on 13 mismatches against the parsed values.

const ALIASES = {
  current_company: ["Company", "Organization", "Employer"],
  graduation_month: ["Graduation month", "Month of graduation"],
  start_month: ["Start month"],
  school: ["School", "University"],
  degree: ["Degree"],
  legal_name: ["Full name"],
  email: ["Email"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  current_company: "Analytical Engines Ltd",
  school: "Johns Hopkins University",
  degree: "Master of Science",
  graduation_month: "May",
  graduation_year: "2027",
});

const text = (id: string, label: string, extra: Record<string, unknown> = {}) => ({
  id,
  inputId: id,
  label,
  type: "text" as const,
  required: false,
  ...extra,
});

describe("#150 historyGroupOf", () => {
  it("reads the row index from UKG / Greenhouse history ids and ignores screener rows", () => {
    expect(historyGroupOf({ inputId: "NewWorkExperience_JobTitle3" })).toEqual({
      kind: "employment",
      index: 3,
    });
    expect(historyGroupOf({ inputId: "NewEducation_SchoolId0" })).toEqual({
      kind: "education",
      index: 0,
    });
    expect(
      historyGroupOf({ name: "job_application[educations_attributes][1][school_name_id]" }),
    ).toEqual({ kind: "education", index: 1 });
    // Greenhouse custom questions and Lever cards are screeners, not history.
    expect(historyGroupOf({ inputId: "job_application_answers_attributes_3_text_value" })).toBeNull();
    expect(historyGroupOf({ name: "cards[631785a2-1c8f][field1]" })).toBeNull();
    expect(historyGroupOf({ inputId: "f_58" })).toBeNull();
    expect(historyGroupOf({ inputId: "first_name" })).toBeNull();
  });
});

describe("#150 history facts never claim later rows or the wrong group", () => {
  it("row 0 maps; rows 1+ do not; employment dates never take education facts", () => {
    expect(matchCanonicalField(text("NewWorkExperience_Organization0", "Company"), ALIASES)).toBe(
      "current_company",
    );
    expect(matchCanonicalField(text("NewWorkExperience_Organization4", "Company"), ALIASES)).toBeNull();
    // Bare "Month" reverse-contains "graduation month" — but the row is employment.
    expect(
      matchCanonicalField(
        { ...text("NewWorkExperience_FromMonth0", "Month"), type: "select", options: ["Jan", "Feb"] },
        ALIASES,
      ),
    ).toBeNull();
    expect(matchCanonicalField(text("NewEducation_SchoolId0", "School"), ALIASES)).toBe("school");
    expect(matchCanonicalField(text("NewEducation_SchoolId1", "School"), ALIASES)).toBeNull();
    // Identity facts are not history: they still map anywhere.
    expect(matchCanonicalField(text("NewWorkExperience_Email0", "Email"), ALIASES)).toBe("email");
  });
});

describe("#150 plan keeps resume-parsed history rows", () => {
  it("skips a held row instead of re-answering it, and never types a bank answer into rows 1+", () => {
    const fields = [
      text("NewWorkExperience_Organization0", "Company", {
        currentValue: "Summer Atlantic Capital LLC",
      }),
      text("NewWorkExperience_JobTitle1", "Job Title"),
      text("NewWorkExperience_Organization2", "Company"),
      text("NewEducation_SchoolId0", "School"),
    ];
    const mapped = mapDiscoveredFields(fields, ALIASES);
    const plan = buildFillPlan(mapped, PROFILE, {
      screenerResolutions: new Map([
        [
          "NewWorkExperience_JobTitle1",
          {
            key: "custom:current_job_title",
            status: "fill",
            value: "Machine Learning Engineer Intern",
            basis: "label",
          } as never,
        ],
      ]),
    });
    const byId = new Map(plan.entries.map((e) => [e.field_id, e]));
    expect(byId.get("NewWorkExperience_Organization0")).toMatchObject({
      action: "skip_unmapped",
      reason: expect.stringMatching(/employment row 0 already holds "Summer Atlantic Capital LLC"/),
    });
    expect(byId.get("NewWorkExperience_JobTitle1")).toMatchObject({
      action: "skip_unmapped",
      reason: expect.stringMatching(/employment row 1 — the profile holds one entry/),
    });
    expect(byId.get("NewWorkExperience_Organization2")).toMatchObject({ action: "skip_unmapped" });
    // The empty first education row still fills from the profile.
    expect(byId.get("NewEducation_SchoolId0")).toMatchObject({
      action: "fill",
      value: "Johns Hopkins University",
    });
  });
});

describe("#150 discovery reads what a control already holds", () => {
  it("captures value attributes and <option selected>, ignoring placeholders", () => {
    const html = `<form>
      <label for="a">Company</label><input id="a" value="Analytical Engines Ltd">
      <label for="b">Job Title</label><input id="b" value="">
      <label for="c">Month</label>
      <select id="c"><option value="">Choose...</option><option value="6" selected>Jun</option></select>
      <label for="d">State</label>
      <select id="d"><option value="" selected>Select one</option><option value="md">Maryland</option></select>
    </form>`;
    const byId = new Map(discoverFieldsFromHtml(html).map((f) => [f.id, f]));
    expect(byId.get("a")?.currentValue).toBe("Analytical Engines Ltd");
    expect(byId.get("b")?.currentValue).toBeUndefined();
    expect(byId.get("c")?.currentValue).toBe("Jun");
    expect(byId.get("d")?.currentValue).toBeUndefined();
  });
});

describe("#150 readLiveHtml (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("serializes script-set values without touching the live DOM", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="t">Job Title</label><input id="t" type="text">
      <label for="m">Month</label>
      <select id="m"><option value="">Choose...</option><option value="6">Jun</option><option value="8">Aug</option></select>
      <label for="k">Consent</label><input id="k" type="checkbox">
      <label for="e">Essay</label><textarea id="e"></textarea>
      <script>
        document.getElementById("t").value = "Software Engineer, Product Development Team";
        document.getElementById("m").value = "8";
        document.getElementById("k").checked = true;
        document.getElementById("e").value = "typed later";
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const attrOnly = await page.content();
      expect(attrOnly).toMatch(/<input id="t" type="text">/);
      const live = await readLiveHtml(page);
      const fields = new Map(discoverFieldsFromHtml(live).map((f) => [f.id, f]));
      expect(fields.get("t")?.currentValue).toBe("Software Engineer, Product Development Team");
      expect(fields.get("m")?.currentValue).toBe("Aug");
      expect(live).toMatch(/<input id="k" type="checkbox" checked="checked">/);
      expect(live).toMatch(/<textarea id="e">typed later<\/textarea>/);
      // The live page is unchanged: attributes were written to a clone.
      expect(await page.locator("#t").getAttribute("value")).toBeNull();
      expect(await page.locator("#t").inputValue()).toBe(
        "Software Engineer, Product Development Team",
      );
    });
  }, 30_000);
});
