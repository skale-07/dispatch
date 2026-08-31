import { describe, expect, it } from "vitest";
import { readPageValidationErrors } from "../../src/applications/pageErrors.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * #66a: platform-neutral validation-error reader. FIXTURE_CONFIRMED
 * against synthetic DOMs shaped like the live evidence (Workday's
 * "N errors found" banner + inline aria messages; generic alert/error
 * markup on other platforms).
 */
describe("readPageValidationErrors (FIXTURE_CONFIRMED)", () => {
  it(
    "reads alerts, aria-invalid fields (with described-by text), and error-classed nodes; hidden errors excluded",
    async () => {
      const html = `<html><body>
        <div role="alert">Error: 2 errors found on this page</div>
        <label for="ph">Phone Number</label>
        <input id="ph" aria-invalid="true" aria-describedby="ph-err" />
        <span id="ph-err">Phone Number is required.</span>
        <div class="field-error">Postal code must be 5 digits.</div>
        <div class="error" style="display:none">Old hidden error</div>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const errors = await readPageValidationErrors(page);
        const joined = errors.join(" | ");
        expect(joined).toContain("Error: 2 errors found on this page");
        expect(joined).toContain('field "Phone Number": Phone Number is required.');
        expect(joined).toContain("Postal code must be 5 digits.");
        expect(joined).not.toContain("Old hidden error");
      });
    },
    45_000,
  );

  it(
    "vendor extras from a registry are read; a page-wide error-classed section does not flood the output",
    async () => {
      const longText = "x".repeat(300);
      const html = `<html><body>
        <div data-automation-id="errorBanner">Your information contains 1 error</div>
        <section class="error-layout">${longText}</section>
        <p>clean content</p>
      </body></html>`;
      await withFixtureHtmlPage(html, async (page) => {
        const withExtras = await readPageValidationErrors(page, {
          extraSelectors: ["[data-automation-id='errorBanner']"],
        });
        expect(withExtras.join(" ")).toContain("Your information contains 1 error");
        // The 300-char section is length-filtered out.
        expect(withExtras.join(" ")).not.toContain("xxxx");
        // Without the vendor hook the banner div (no generic marker) is not read.
        const without = await readPageValidationErrors(page);
        expect(without.join(" ")).not.toContain("Your information contains 1 error");
      });
    },
    45_000,
  );

  it(
    "a clean page returns no errors",
    async () => {
      await withFixtureHtmlPage(
        `<html><body><form><input name="email" /><button>Apply</button></form></body></html>`,
        async (page) => {
          expect(await readPageValidationErrors(page)).toEqual([]);
        },
      );
    },
    45_000,
  );
});
