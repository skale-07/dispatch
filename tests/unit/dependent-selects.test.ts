import { describe, expect, it } from "vitest";
import {
  fillRevealedProfileSelects,
  REVEALED_SELECT_CAP,
} from "../../src/ats/shared/dependentSelects.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

// Live UKG run 17 (2026-09-02, #149): "State / Province" is hidden with a
// lone placeholder until Country is chosen, then offers 59 options. The
// plan never saw an answer space; Save refused with "Please select a
// state/province." — a value the profile holds.
const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  phone: "555-0100",
  address: {
    line1: "1 Main St",
    city: "Baltimore",
    state: "Maryland",
    postal_code: "21218",
    country: "United States",
  },
});

const ALIASES = {
  "address.state": ["State", "State/Province", "Province"],
  "address.country": ["Country"],
  gender: ["Gender"],
  how_heard: ["How did you hear about us"],
};

describe("#149 revealed dependent selects (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("picks the profile value on a select the parent pick revealed; leaves answered, unmatched and demographic selects alone", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="Country">Country</label>
      <select id="Country" name="Country">
        <option value="">Choose...</option>
        <option value="us" selected>United States</option>
        <option value="ca">Canada</option>
      </select>
      <label for="State">State / Province</label>
      <select id="State" required>
        <option value="">Choose...</option>
        <option value="md">Maryland</option>
        <option value="va">Virginia</option>
        <option value="ny">New York</option>
      </select>
      <label for="Gender">Gender</label>
      <select id="Gender">
        <option value="">Choose...</option>
        <option value="f">Female</option>
        <option value="m">Male</option>
      </select>
      <label for="Source">How did you hear about us</label>
      <select id="Source">
        <option value="">Choose...</option>
        <option value="li">LinkedIn</option>
        <option value="jb">Job board</option>
      </select>
      <label for="Hidden">State</label>
      <select id="Hidden" style="display:none">
        <option value="">Choose...</option>
        <option value="md">Maryland</option>
        <option value="va">Virginia</option>
      </select>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const result = await fillRevealedProfileSelects({
        page,
        profile: PROFILE,
        aliases: ALIASES,
      });
      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0]).toMatchObject({
        field_id: "State",
        canonical_field: "address.state",
        chose: "Maryland",
        verified: true,
      });
      expect(await page.locator("#State").inputValue()).toBe("md");
      // Answered by the page already — never re-chosen.
      expect(await page.locator("#Country").inputValue()).toBe("us");
      // Demographic select untouched (sensitive-profile path only).
      expect(await page.locator("#Gender").inputValue()).toBe("");
      // Profile has no how_heard — nothing invented.
      expect(await page.locator("#Source").inputValue()).toBe("");
      // Hidden control is not "revealed".
      expect(await page.locator("#Hidden").inputValue()).toBe("");
      expect(result.notes.join(" ")).toMatch(/State \/ Province.*address\.state.*Maryland/);
    });
  }, 30_000);

  it("reports a profile value the revealed list cannot hold instead of guessing", async () => {
    const html = `<!DOCTYPE html><html><body>
      <label for="State">State</label>
      <select id="State">
        <option value="">Choose...</option>
        <option value="on">Ontario</option>
        <option value="qc">Quebec</option>
      </select>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const result = await fillRevealedProfileSelects({
        page,
        profile: PROFILE,
        aliases: ALIASES,
      });
      expect(result.outcomes).toHaveLength(0);
      expect(await page.locator("#State").inputValue()).toBe("");
      expect(result.notes.join(" ")).toMatch(/offers no option for the profile value/);
    });
  }, 30_000);

  it("is bounded", () => {
    expect(REVEALED_SELECT_CAP).toBeLessThanOrEqual(8);
  });
});
