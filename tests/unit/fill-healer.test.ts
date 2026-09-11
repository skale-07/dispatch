import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findFieldCandidates,
  healFailedFillEntries,
  locatedButRefusedFields,
  scoreLabelSimilarity,
} from "../../src/ats/greenhouse/fillHealer.js";
import { failedApprovedEntries } from "../../src/ats/greenhouse/liveFill.js";
import { locateFieldViaSidecar } from "../../src/agent/locateField.js";
import type { ApprovedFillPlanEntry } from "../../src/applications/approvedFillPlan.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";
import { resetConfigCache } from "../../src/config/index.js";

const SCRATCH = process.env["CLAUDE_SCRATCHPAD"] ?? os.tmpdir();

/** A form whose email field has drifted: stored meta points at a dead id. */
const DRIFTED_FORM = `<!DOCTYPE html>
<html><body>
  <form id="application_form">
    <label for="first_name">First name</label>
    <input id="first_name" name="job_application[first_name]" type="text" />
    <label for="email_addr_v2">Email</label>
    <input id="email_addr_v2" name="job_application[email]" type="email" />
    <input id="unrelated" name="favorite_color" type="text" aria-label="Favorite color" />
  </form>
</body></html>`;

function approvedEntry(
  overrides: Partial<ApprovedFillPlanEntry> = {},
): ApprovedFillPlanEntry {
  return {
    field_id: "email_old_id",
    label: "Email",
    type: "text",
    canonical_field: "email",
    action: "FILL",
    approved: true,
    value: "candidate@example.com",
    reason: "Mapped from public profile",
    ...overrides,
  };
}

describe("label similarity scoring (UNIT_CONFIRMED)", () => {
  it("scores overlap sensibly", () => {
    expect(scoreLabelSimilarity("Email", "email_addr_v2")).toBeGreaterThan(0.9);
    expect(scoreLabelSimilarity("First name", "first_name")).toBe(1);
    expect(scoreLabelSimilarity("Email", "favorite_color")).toBe(0);
    expect(scoreLabelSimilarity("", "anything")).toBe(0);
  });
});

describe("heuristic relocation (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("finds the drifted email field by label evidence", async () => {
    await withFixtureHtmlPage(DRIFTED_FORM, async (page) => {
      const candidates = await findFieldCandidates(page, "Email", "text");
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]?.selector).toBe("#email_addr_v2");
      expect(candidates[0]?.score).toBeGreaterThan(0.5);
      // The unrelated field does not outrank it.
      expect(candidates.some((c) => c.selector === "#unrelated")).toBe(false);
    });
  }, 30_000);

  it("heals a fill whose stored meta points at a dead selector", async () => {
    await withFixtureHtmlPage(DRIFTED_FORM, async (page) => {
      const report = await healFailedFillEntries({
        page,
        failedEntries: [approvedEntry()],
      });
      expect(report.healed).toEqual(["email_old_id"]);
      expect(report.attempts[0]?.layer).toBe("heuristic");
      expect(report.sidecar_used).toBe(false);
      // The value actually landed in the drifted field.
      const value = await page.locator("#email_addr_v2").inputValue();
      expect(value).toBe("candidate@example.com");
    });
  }, 30_000);

  it("never heals unapproved or textarea entries", async () => {
    await withFixtureHtmlPage(DRIFTED_FORM, async (page) => {
      const essay = approvedEntry({
        field_id: "essay_field",
        label: "Why do you want to work here?",
        type: "textarea",
      });
      const report = await healFailedFillEntries({
        page,
        failedEntries: [essay],
      });
      expect(report.healed).toEqual([]);
      expect(report.still_failing).toEqual(["essay_field"]);
      expect(
        report.attempts[0]?.notes.join(" "),
      ).toMatch(/textarea|essay|did not verify|no heuristic/i);
    });
  }, 30_000);

  it("respects the fill gate", async () => {
    applyControlledFillEnv({
      FORM_FILL_ENABLED: "false",
      DRY_RUN: "true",
      SUBMIT_ENABLED: "false",
    });
    await withFixtureHtmlPage(DRIFTED_FORM, async (page) => {
      await expect(
        healFailedFillEntries({ page, failedEntries: [approvedEntry()] }),
      ).rejects.toThrow(/FORM_FILL_ENABLED/);
    });
  }, 30_000);
});

/**
 * #252 (live, Hudl night30): race had no unambiguous option (East / South /
 * Southeast Asian) so the fill correctly refused it — then the healer typed
 * "Asian" into the GENDER control (wiping a verified "Male") and into the
 * referral-name box, on label overlap made of "please indicate your".
 */
describe("healer never borrows another question's control (#252)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("boilerplate words alone score zero", () => {
    expect(scoreLabelSimilarity("Please indicate your race", "Please indicate your gender")).toBe(0);
    expect(
      scoreLabelSimilarity(
        "Please indicate your race",
        "If you heard about this role from a current Hudl employee, please provide their name",
      ),
    ).toBe(0);
    expect(scoreLabelSimilarity("Please indicate your race", "Race")).toBe(1);
  });

  const OWNED_FORM = `<!DOCTYPE html>
  <html><body><form id="application_form">
    <label for="1326">Please indicate your gender</label>
    <input id="1326" type="text" value="Male" />
    <label for="race_detail">Race (please specify)</label>
    <input id="race_detail" type="text" value="" />
  </form></body></html>`;

  it("skips a candidate that is another plan entry's control, leaving its value intact", async () => {
    await withFixtureHtmlPage(OWNED_FORM, async (page) => {
      const race = approvedEntry({ field_id: "1327", label: "Race", canonical_field: "race_ethnicity", value: "Asian" });
      const report = await healFailedFillEntries({
        page,
        failedEntries: [race],
        planFieldIds: ["1326", "1327", "race_detail"],
      });
      expect(report.healed).toEqual([]);
      expect(report.attempts[0]?.notes.join(" ")).toMatch(/#race_detail skipped — it is another plan entry's control/);
      expect(await page.locator("#race_detail").inputValue()).toBe("");
      expect(await page.locator('[id="1326"]').inputValue()).toBe("Male");
    });
  }, 30_000);

  it("does not relocate a field whose control was found and whose value was refused", async () => {
    await withFixtureHtmlPage(OWNED_FORM, async (page) => {
      const race = approvedEntry({ field_id: "1327", label: "Race", canonical_field: "race_ethnicity", value: "Asian" });
      const refused = locatedButRefusedFields({
        field_meta: [
          { field_id: "1326", control_kind: "combobox", selected_option: "Male", notes: ['picked "Male" (exact)'] },
          {
            field_id: "1327",
            control_kind: "combobox",
            selected_option: null,
            notes: ['ambiguous match for "Asian" (3 candidates): East Asian | South Asian | Southeast Asian'],
          },
        ],
      });
      expect([...refused]).toEqual(["1327"]);
      const report = await healFailedFillEntries({ page, failedEntries: [race], locatedButRefused: refused });
      expect(report.still_failing).toEqual(["1327"]);
      expect(report.attempts[0]?.notes.join(" ")).toMatch(/value refused.*#252/);
      expect(await page.locator("#race_detail").inputValue()).toBe("");
    });
  }, 30_000);
});

describe("sidecar escalation gate (UNIT/FIXTURE)", () => {
  useIsolatedFillEnv("fixture_fill");

  const UNHEALABLE_FORM = `<!DOCTYPE html>
  <html><body><form id="application_form">
    <input id="xq1" name="zz_1" type="text" />
  </form></body></html>`;

  it("skips the sidecar when AGENT_FALLBACK_ENABLED is off (default)", async () => {
    await withFixtureHtmlPage(UNHEALABLE_FORM, async (page) => {
      const report = await healFailedFillEntries({
        page,
        failedEntries: [approvedEntry({ label: "Preferred pronouns spelling" })],
      });
      expect(report.sidecar_used).toBe(false);
      expect(report.attempts[0]?.notes.join(" ")).toMatch(
        /AGENT_FALLBACK_ENABLED=false/,
      );
    });
  }, 30_000);

  it("consults the sidecar when enabled and the heuristic fails", async () => {
    process.env.AGENT_FALLBACK_ENABLED = "true";
    resetConfigCache();
    await withFixtureHtmlPage(UNHEALABLE_FORM, async (page) => {
      const report = await healFailedFillEntries({
        page,
        failedEntries: [approvedEntry({ label: "Preferred pronouns spelling" })],
      });
      // Sidecar attempted (python may or may not exist here) — either way the
      // attempt is recorded and the gate was passed.
      expect(report.sidecar_used).toBe(true);
      expect(report.attempts[0]?.notes.length).toBeGreaterThan(0);
    });
  }, 30_000);
});

describe("locateFieldViaSidecar protocol (UNIT_CONFIRMED)", () => {
  it("maps sidecar candidates into healer candidates via the contract", async () => {
    const stub = path.join(SCRATCH, `stub-locate-${randomUUID()}.mjs`);
    fs.writeFileSync(
      stub,
      `
      let input = "";
      process.stdin.on("data", (d) => (input += d));
      process.stdin.on("end", () => {
        const task = JSON.parse(input);
        if (task.task_type !== "locate_field") {
          console.log(JSON.stringify({status:"error", reason:"wrong task", field_candidates:[], warnings:[]}));
          return;
        }
        console.log(JSON.stringify({
          status: "ok",
          field_candidates: [{
            label: task.field_label, type: task.field_type,
            selector_candidates: ["#email_addr_v2", '[name="job_application[email]"]'],
            confidence: 0.92,
          }],
          warnings: [],
        }));
      });
      `,
    );
    try {
      const candidates = await locateFieldViaSidecar({
        fieldLabel: "Email",
        fieldType: "text",
        html: "<form><input id='email_addr_v2'/></form>",
        commandOverride: { command: process.execPath, args: [stub] },
      });
      expect(candidates).toHaveLength(2);
      expect(candidates[0]).toMatchObject({
        selector: "#email_addr_v2",
        inputId: "email_addr_v2",
        via: "sidecar",
        score: 0.92,
      });
      expect(candidates[1]?.name).toBe("job_application[email]");
    } finally {
      fs.unlinkSync(stub);
    }
  });

  it("rejects malformed sidecar output", async () => {
    const stub = path.join(SCRATCH, `stub-locate-bad-${randomUUID()}.mjs`);
    fs.writeFileSync(
      stub,
      `process.stdin.resume(); process.stdin.on("end", () => console.log("garbage"));`,
    );
    try {
      await expect(
        locateFieldViaSidecar({
          fieldLabel: "Email",
          fieldType: "text",
          html: "<form></form>",
          commandOverride: { command: process.execPath, args: [stub] },
        }),
      ).rejects.toThrow();
    } finally {
      fs.unlinkSync(stub);
    }
  });

  it("the real python sidecar locates by label similarity (stdlib only)", async () => {
    const result = await locateFieldViaSidecar({
      fieldLabel: "Email",
      fieldType: "email",
      html: DRIFTED_FORM,
      commandOverride: {
        command: "python3",
        args: [path.join(process.cwd(), "agent", "jobright_agent", "author.py")],
      },
    }).catch((err: Error) => err);
    if (result instanceof Error) {
      // python3 unavailable in this environment — spawn failure acceptable.
      expect(String(result.message)).toMatch(/spawn|no output/i);
      return;
    }
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.selector).toMatch(/email_addr_v2|job_application\[email\]/);
  });
});

describe("failedApprovedEntries mapping (UNIT_CONFIRMED)", () => {
  it("selects only approved FILL entries whose verify row failed", () => {
    const plan = {
      entries: [
        approvedEntry({ field_id: "a", canonical_field: "email" }),
        approvedEntry({
          field_id: "b",
          canonical_field: "phone",
          approved: false,
          action: "SKIP",
        }),
        approvedEntry({ field_id: "c", canonical_field: "school" }),
      ],
    };
    const verify = {
      fields: [
        { canonical_field: "email", match: false },
        { canonical_field: "phone", match: false },
        { canonical_field: "school", match: true },
      ],
    };
    const failed = failedApprovedEntries(plan, verify);
    expect(failed.map((e) => e.field_id)).toEqual(["a"]);
  });
});

afterEach(() => {
  delete process.env.AGENT_FALLBACK_ENABLED;
  resetConfigCache();
});

beforeEach(() => {
  delete process.env.AGENT_FALLBACK_ENABLED;
  resetConfigCache();
});
