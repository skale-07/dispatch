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
    <div aria-label="I accept the WhatsApp terms.">
      <input id="q6bok" type="checkbox" class="painted" data-automation-id="phone-whatsapp-opt-in" aria-label="I accept the WhatsApp terms." />
      <span></span>
      <span>I accept the WhatsApp terms.</span>
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

  it("harder: a STALE discovery id (Workday regenerated it) falls back to label resolution for fill AND verify (live 22h)", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "sms_optin",
        label:
          "I accept the terms above, and would like to receive text (SMS, MMS) messages.",
        type: "checkbox",
        value: "true",
        canonical_field: "screener:custom:sms_opt_in",
      });
      // The id captured at discovery no longer exists on the page.
      const meta = new Map<string, FieldMeta>([
        ["sms_optin", { type: "checkbox", inputId: "deadbeef-regenerated" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#q6boi").isChecked()).toBe(true);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("harder: a PAINTED checkbox with NO label[for] at all still checks via the JS-click tier (live 22g SMS/WhatsApp opt-ins)", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: "q6bok",
        label: "I accept the WhatsApp terms.",
        type: "checkbox",
        value: "true",
        canonical_field: "screener:custom:whatsapp_opt_in",
      });
      const meta = new Map<string, FieldMeta>([
        ["q6bok", { type: "checkbox", inputId: "q6bok" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#q6bok").isChecked()).toBe(true);
    });
  }, 45_000);
});

/**
 * Operator directive (2026-08-31, night22): on a resumed draft (recurrent
 * application — live tiaa), a field that already holds a value verify
 * would accept is VERIFIED IN PLACE, never cleared and retyped. Retyping
 * a correct value risks the re-render wipe classes (#63f/#65) and wastes
 * walk time. Skip fires ONLY when verify's own comparator (valuesMatch)
 * passes the current value; anything else refills exactly as before.
 * FIXTURE_CONFIRMED.
 */
const PREFILLED_HTML = `<!DOCTYPE html><html><body>
  <form>
    <label for="first">First Name</label>
    <input id="first" type="text" value="Shubham" />
    <label for="phone">Phone Number</label>
    <input id="phone" type="text" value="(480) 555-1234" />
    <label for="city">City</label>
    <input id="city" type="text" value="Wrongville" />
  </form>
  <script>
    window.__writes = {};
    for (const el of document.querySelectorAll('input')) {
      el.addEventListener('input', () => {
        window.__writes[el.id] = (window.__writes[el.id] || 0) + 1;
      });
    }
  </script>
</body></html>`;

describe("verify-in-place for prefilled drafts (operator directive, FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("an exact prefilled match is never retyped; a formatted phone variant valuesMatch accepts is never retyped; a WRONG prefill is refilled", async () => {
    await withFixtureHtmlPage(PREFILLED_HTML, async (page) => {
      const entries = [
        entry({ field_id: "first", label: "First Name", value: "Shubham", canonical_field: "legal_name.first" }),
        entry({ field_id: "phone", label: "Phone Number", value: "4805551234", canonical_field: "phone" }),
        entry({ field_id: "city", label: "City", value: "Baltimore", canonical_field: "address.city" }),
      ];
      const meta = new Map<string, FieldMeta>([
        ["first", { type: "text", inputId: "first" }],
        ["phone", { type: "text", inputId: "phone" }],
        ["city", { type: "text", inputId: "city" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, entries, meta);
      expect(fill.errors).toEqual([]);
      const writes = await page.evaluate("window.__writes");
      // Matching prefills: zero input events — verified in place.
      expect((writes as Record<string, number>)["first"]).toBeUndefined();
      expect((writes as Record<string, number>)["phone"]).toBeUndefined();
      expect(await page.locator("#phone").inputValue()).toBe("(480) 555-1234");
      // The wrong prefill WAS rewritten.
      expect(await page.locator("#city").inputValue()).toBe("Baltimore");
      const notes = (fill.field_meta ?? [])
        .flatMap((m) => m.notes ?? [])
        .join(" | ");
      expect(notes).toMatch(/verified in place, not retyped/);
      // All three still count as filled for the plan's bookkeeping.
      expect(fill.filled).toHaveLength(3);
    });
  }, 45_000);
});

/**
 * #101 (live tiaa page 7): the Workday date widget — dateInputWrapper with
 * Month/Day/Year spinbutton inputs. Discovery collapses the trio into ONE
 * legend-labeled field; the fill writes sections focus+keyboard (mouse
 * clicks are swallowed live); verify reads the joined sections and the
 * bank's month-precision "May 2029" accepts any day. FIXTURE_CONFIRMED.
 */
const DATE_HTML = `<!DOCTYPE html><html><body>
  <div data-automation-id="formField-gradDate">
    <fieldset>
      <legend><div data-automation-id="richText"><p><b>What is your expected date of graduation?</b><abbr title="required" class="requiredAsterisk">*</abbr></p></div></legend>
      <div id="secondaryQuestionnaire--gd1" role="group" data-automation-id="dateInputWrapper">
        <input role="spinbutton" aria-label="Month" id="secondaryQuestionnaire--gd1-dateSectionMonth-input" data-automation-id="dateSectionMonth-input" value="" />
        <input role="spinbutton" aria-label="Day" id="secondaryQuestionnaire--gd1-dateSectionDay-input" data-automation-id="dateSectionDay-input" value="" />
        <input role="spinbutton" aria-label="Year" id="secondaryQuestionnaire--gd1-dateSectionYear-input" data-automation-id="dateSectionYear-input" value="" />
      </div>
    </fieldset>
  </div>
</body></html>`;

describe("#101 workday date widget (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  it("discovery collapses the spinbutton trio into one legend-labeled required field", async () => {
    const { discoverFieldsFromHtml } = await import(
      "../../src/applications/fieldDiscovery.js"
    );
    const fields = discoverFieldsFromHtml(DATE_HTML);
    const date = fields.filter((f) =>
      /expected date of graduation/i.test(String(f.label)),
    );
    expect(date).toHaveLength(1);
    expect(date[0]!.inputId).toBe("secondaryQuestionnaire--gd1");
    expect(date[0]!.required).toBe(true);
    expect(fields.filter((f) => /^(Month|Day|Year)$/.test(String(f.label)))).toEqual([]);
  });

  it('parseDateParts: "May 2029" month-precision; "05/01/2029"; "2029-05-15"; junk refused', async () => {
    const { parseDateParts } = await import("../../src/ats/greenhouse/fill.js");
    expect(parseDateParts("May 2029")).toEqual({ month: 5, day: null, year: 2029 });
    expect(parseDateParts("05/01/2029")).toEqual({ month: 5, day: 1, year: 2029 });
    expect(parseDateParts("2029-05-15")).toEqual({ month: 5, day: 15, year: 2029 });
    expect(parseDateParts("3.7")).toBeNull();
    expect(parseDateParts("Bachelor of Science")).toBeNull();
  });

  it('fills "May 2029" as 05/01/2029 into the sections (day defaulted, noted) and verify accepts month-precision', async () => {
    await withFixtureHtmlPage(DATE_HTML, async (page) => {
      const e = entry({
        field_id: "secondaryQuestionnaire--gd1",
        label: "What is your expected date of graduation?",
        value: "May 2029",
        canonical_field: "screener:custom:expected_graduation_date",
      });
      const meta = new Map<string, FieldMeta>([
        ["secondaryQuestionnaire--gd1", { type: "text", inputId: "secondaryQuestionnaire--gd1" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(
        await page.locator("#secondaryQuestionnaire--gd1-dateSectionMonth-input").inputValue(),
      ).toBe("05");
      expect(
        await page.locator("#secondaryQuestionnaire--gd1-dateSectionYear-input").inputValue(),
      ).toBe("2029");
      const notes = (fill.field_meta ?? []).flatMap((m) => m.notes ?? []).join(" | ");
      expect(notes).toMatch(/day not on file — 01/);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.passed).toBe(true);
    });
  }, 45_000);

  it("a date widget already holding the planned month/year is verified in place, not retyped", async () => {
    const prefilled = DATE_HTML.replace(
      'id="secondaryQuestionnaire--gd1-dateSectionMonth-input" data-automation-id="dateSectionMonth-input" value=""',
      'id="secondaryQuestionnaire--gd1-dateSectionMonth-input" data-automation-id="dateSectionMonth-input" value="05"',
    )
      .replace(
        'id="secondaryQuestionnaire--gd1-dateSectionDay-input" data-automation-id="dateSectionDay-input" value=""',
        'id="secondaryQuestionnaire--gd1-dateSectionDay-input" data-automation-id="dateSectionDay-input" value="15"',
      )
      .replace(
        'id="secondaryQuestionnaire--gd1-dateSectionYear-input" data-automation-id="dateSectionYear-input" value=""',
        'id="secondaryQuestionnaire--gd1-dateSectionYear-input" data-automation-id="dateSectionYear-input" value="2029"',
      );
    await withFixtureHtmlPage(prefilled, async (page) => {
      const e = entry({
        field_id: "secondaryQuestionnaire--gd1",
        label: "What is your expected date of graduation?",
        value: "May 2029",
        canonical_field: "screener:custom:expected_graduation_date",
      });
      const meta = new Map<string, FieldMeta>([
        ["secondaryQuestionnaire--gd1", { type: "text", inputId: "secondaryQuestionnaire--gd1" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      const notes = (fill.field_meta ?? []).flatMap((m) => m.notes ?? []).join(" | ");
      expect(notes).toMatch(/already holds the planned date — verified in place/);
      // Day 15 untouched — the walk never rewrote sections.
      expect(
        await page.locator("#secondaryQuestionnaire--gd1-dateSectionDay-input").inputValue(),
      ).toBe("15");
    });
  }, 45_000);
});
