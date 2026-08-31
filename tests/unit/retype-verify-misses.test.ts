import { describe, expect, it } from "vitest";
import { retypeEmptyVerifyMisses } from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import type { FormVerificationResult } from "../../src/ats/adapter.js";

/**
 * #66b: ONE keystroke-level retype of verify misses that read EMPTY on
 * text controls — the moment we KNOW React state never took the fill
 * (live tiaa #22n/#22o: DOM held the phone through every fill-time
 * read-back, the saved draft was empty). FIXTURE_CONFIRMED.
 */
const entryOf = (over: Record<string, unknown>) =>
  ({
    field_id: "f_phone",
    label: "Phone Number",
    type: "text",
    canonical_field: "phone",
    action: "fill",
    value: "4805897636",
    reason: "test",
    approved: true,
    ...over,
  }) as never;

const verifyOf = (fields: FormVerificationResult["fields"]): FormVerificationResult => ({
  passed: false,
  fields,
  uploads: [],
  warnings: [],
});

describe("retypeEmptyVerifyMisses (FIXTURE_CONFIRMED)", () => {
  it(
    "keystroke-retypes an empty-observed text miss; keydown-counting inputs receive real key events",
    async () => {
      // The input counts KEYDOWN events — fill() dispatches none, so a
      // successful retype proves keystroke-level entry.
      const html = `<html><body>
        <label for="ph">Phone Number</label>
        <input id="ph" name="phone_number" />
        <script>
          (globalThis).__keys = 0;
          document.getElementById('ph').addEventListener('keydown', () => { (globalThis).__keys += 1; });
        </script>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const meta = new Map([["f_phone", { type: "text", inputId: "ph" }]]);
        const r = await retypeEmptyVerifyMisses(
          page,
          [entryOf({})],
          meta as never,
          verifyOf([
            { canonical_field: "phone", expected: "4805897636", observed: "", match: false },
          ]),
        );
        expect(r.retyped).toEqual(["phone"]);
        expect(await page.locator("#ph").inputValue()).toBe("4805897636");
        expect(
          await page.evaluate(() => (globalThis as unknown as { __keys: number }).__keys),
        ).toBeGreaterThanOrEqual(10);
      });
    },
    45_000,
  );

  it(
    "touches NOTHING else: matched fields, non-empty mismatches, and non-text entries are skipped",
    async () => {
      const html = `<html><body>
        <label for="ph">Phone Number</label><input id="ph" value="kept" />
        <label for="yrs">Years</label><select id="yrs"><option>1</option><option>2</option></select>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const meta = new Map([
          ["f_phone", { type: "text", inputId: "ph" }],
          ["f_years", { type: "select", inputId: "yrs" }],
        ]);
        const r = await retypeEmptyVerifyMisses(
          page,
          [
            entryOf({}),
            entryOf({ field_id: "f_years", label: "Years", type: "select", canonical_field: "years", value: "2" }),
          ],
          meta as never,
          verifyOf([
            // non-empty mismatch: not our class — never overwritten
            { canonical_field: "phone", expected: "4805897636", observed: "kept", match: false },
            // select miss reading empty: not a text control — skipped
            { canonical_field: "years", expected: "2", observed: "", match: false },
          ]),
        );
        expect(r.retyped).toEqual([]);
        expect(await page.locator("#ph").inputValue()).toBe("kept");
      });
    },
    45_000,
  );
});
