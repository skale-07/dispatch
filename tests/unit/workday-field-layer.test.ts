import { describe, expect, it } from "vitest";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  type FieldMeta,
} from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Progressive-overload set for night20 #61 — the Workday wizard field
 * layer, shaped on the LIVE tiaa.wd1 walk (fill_run 2edb5eb8) and one
 * level harder:
 *   - a RADIO group the plan typed "text" (previousWorker): fill("No")
 *     crashed live; must route to the member whose label matches;
 *   - PAINTED members: the native inputs are display-hidden behind
 *     styled spans (harder: display:none, not just opacity) — check()
 *     can never succeed, the <label for> click must;
 *   - a HIDDEN decoy input document-BEFORE the real visible control
 *     carrying a hex token ("Phone" hung 30s live; verify then read the
 *     token): the visible-first ladder must pick the real input for
 *     both fill and verify.
 * FIXTURE_CONFIRMED.
 */
const HTML = `<!DOCTYPE html><html><body>
  <style>.painted { display: none; }</style>
  <form>
    <div data-automation-id="formField-candidateIsPreviousWorker">
      <fieldset>
        <legend><label id="radio-label6">Have you previously been an employee of TIAA?<abbr aria-hidden="true">*</abbr></label></legend>
        <div name="candidateIsPreviousWorker" aria-labelledby="radio-label6" id="previousWorker--candidateIsPreviousWorker" aria-required="true">
          <div><input id="q6bof" name="candidateIsPreviousWorker" type="radio" value="true" class="painted"><span></span><label for="q6bof">Yes</label></div>
          <div><input id="q6bog" name="candidateIsPreviousWorker" type="radio" value="false" class="painted"><span></span><label for="q6bog">No</label></div>
        </div>
      </fieldset>
    </div>
    <div data-automation-id="formField-phoneNumber">
      <label for="phone-decoy">Phone Number</label>
      <input id="phone-decoy" type="text" value="0959caecc755017829c438a5ba007f07" style="display:none" />
      <label for="phone-real">Phone Number</label>
      <input id="phone-real" type="text" value="" />
    </div>
    <div>
      <input id="q6boi" type="checkbox" class="painted" data-automation-id="phone-sms-opt-in" />
      <span></span>
      <label for="q6boi">I accept the terms above, and would like to receive text (SMS, MMS) messages.</label>
    </div>
  </form>
</body></html>`;

const entry = (over: Record<string, unknown>) =>
  ({
    field_id: "x",
    label: "X",
    type: "text",
    required: false,
    action: "FILL",
    approved: true,
    value: "v",
    canonical_field: null,
    reason: "test",
    ...over,
  }) as never;

describe("workday field layer (night20 #61, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("a radio group the plan typed 'text' routes to the matching PAINTED member via its label", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "f_3",
        label: "Have you previously been an employee of TIAA?",
        type: "text",
        value: "No",
        canonical_field: "screener:previously_applied_or_worked",
      });
      const meta = new Map<string, FieldMeta>([["f_3", { type: "text" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#q6bog").isChecked()).toBe(true);
      expect(await page.locator("#q6bof").isChecked()).toBe(false);
      const fm = fill.field_meta?.find((m) => m.field_id === "f_3");
      expect(fm?.selected_option).toBe("No");
    });
  }, 45_000);

  it("a mismatching answer on that radio group still parks with the real reason — never a guess", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "f_3",
        label: "Have you previously been an employee of TIAA?",
        type: "text",
        value: "Occasionally",
        canonical_field: "screener:previously_applied_or_worked",
      });
      const meta = new Map<string, FieldMeta>([["f_3", { type: "text" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors.join(" ")).toMatch(/No radio option for "Occasionally"/);
      expect(await page.locator("#q6bof").isChecked()).toBe(false);
      expect(await page.locator("#q6bog").isChecked()).toBe(false);
    });
  }, 45_000);

  it("the HIDDEN decoy never wins: fill and verify both land on the visible Phone input", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "f_13",
        label: "Phone Number",
        type: "text",
        value: "4805551234",
        canonical_field: "phone",
      });
      const meta = new Map<string, FieldMeta>([["f_13", { type: "text" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#phone-real").inputValue()).toBe("4805551234");
      // The decoy keeps its token — untouched.
      expect(await page.locator("#phone-decoy").inputValue()).toBe(
        "0959caecc755017829c438a5ba007f07",
      );
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("a PAINTED consent checkbox is checked through its label and verifies from its own state", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "q6boi",
        label:
          "I accept the terms above, and would like to receive text (SMS, MMS) messages.",
        type: "checkbox",
        value: "true",
        canonical_field: "screener:custom:sms_opt_in",
      });
      const meta = new Map<string, FieldMeta>([
        ["q6boi", { type: "checkbox", inputId: "q6boi" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#q6boi").isChecked()).toBe(true);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);
});
