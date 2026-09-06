import { describe, expect, it } from "vitest";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { locatorForField, greenhouseFillFromPlan, greenhouseVerifyFromPlan } from "../../src/ats/greenhouse/fill.js";
import { toApprovedFillPlan } from "../../src/applications/approvedFillPlan.js";
import { useIsolatedFillEnv, applyControlledFillEnv } from "../helpers/fillEnvIsolation.js";

const HTML = `<div data-field-path="graduation"><label for="graduation">Expected Graduation Date</label>
  <div><div><input type="text" placeholder="Pick date..." class="ashby-application-form-input-date" required></div></div></div>
  <div data-field-path="start"><label for="start">Available start date</label><input placeholder="Pick date..."></div>`;
describe("wrapped date identity (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv();
  it("keeps graduation separate from availability despite identical placeholders", async () => {
    const fields = discoverFieldsFromHtml(HTML);
    expect(fields.map(f => [f.id, f.label])).toEqual([["graduation", "Expected Graduation Date"], ["start", "Available start date"]]);
    await withFixtureHtmlPage(HTML, async page => {
      const loc = locatorForField(page, { field_id: fields[0]!.id, label: fields[0]!.label });
      expect(await loc.count()).toBe(1);
      await loc.fill("05/01/2028");
      expect(await page.locator('[data-field-path="start"] input').inputValue()).toBe("");
    });
  }, 30000);
  it("fills and verifies a month-precision graduation date using the approved plan", async () => {
    applyControlledFillEnv({ FORM_FILL_ENABLED: "true", DRY_RUN: "false" });
    await withFixtureHtmlPage(HTML, async page => {
      const plan = toApprovedFillPlan([{ field_id: "graduation", label: "Expected Graduation Date", type: "text", canonical_field: "graduation_year", action: "fill", value: "May 2028", reason: "operator-approved early graduation" }]);
      const meta = new Map([["graduation", { type: "text" as const }]]);
      const filled = await greenhouseFillFromPlan(page, plan.entries, meta);
      expect(filled.filled).toContain("graduation_year");
      expect(await page.locator('[data-field-path="graduation"] input').inputValue()).toBe("05/01/2028");
      const verified = await greenhouseVerifyFromPlan(page, plan.entries, meta);
      expect(verified.passed).toBe(true);
      expect(await page.locator('[data-field-path="start"] input').inputValue()).toBe("");
    });
  }, 30000);
});
