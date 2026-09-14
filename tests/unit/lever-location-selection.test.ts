import { describe, expect, it } from "vitest";
import { fillLocationStyleText } from "../../src/ats/greenhouse/fill.js";
import { leverLocationSelectionEmpty } from "../../src/ats/shared/leverLocation.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Live SEP/Lever 2026-09-14 (app 1d730f08): the visible location text
 * survived blur, verify matched it, and the submit click was rejected —
 * "Please select a location from the dropdown menu" — because Lever's
 * hidden `selectedLocation` (set only by a dropdown-row click) was empty.
 * FIXTURE_CONFIRMED.
 */
const LEVER_LOCATION = (rowSetsHidden: boolean) => `<!DOCTYPE html><html><body>
  <div class="application-field">
    <input data-qa="location-input" id="location-input" type="text" name="location" />
    <input id="selected-location" type="hidden" name="selectedLocation" value="" />
    <div class="dropdown-results" id="results" style="display:none">
      <div class="dropdown-location" id="row0">Baltimore, MD, USA</div>
    </div>
  </div>
  <script>
    const input = document.getElementById('location-input');
    const results = document.getElementById('results');
    const hidden = document.getElementById('selected-location');
    input.addEventListener('input', () => { results.style.display = input.value.length > 2 ? 'block' : 'none'; });
    document.getElementById('row0').addEventListener('click', () => {
      input.value = 'Baltimore, MD, USA';
      ${rowSetsHidden ? "hidden.value = JSON.stringify({ name: 'Baltimore, MD, USA', lat: 39.29 });" : "hidden.value = JSON.stringify({ name: '' });"}
      results.style.display = 'none';
    });
  </script>
</body></html>`;

describe("Lever location: the hidden selection is the commit (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  it("a dropdown-row click that registers leaves selectedLocation set and the fill reports it committed", async () => {
    await withFixtureHtmlPage(LEVER_LOCATION(true), async (page) => {
      const r = await fillLocationStyleText(page, page.locator("#location-input"), "Baltimore, Maryland, USA");
      expect(r.notes.join(" | ")).toMatch(/location committed \(blur-stable\)/);
      expect(await leverLocationSelectionEmpty(page)).toBe(false);
      expect(await page.locator("#location-input").inputValue()).toBe("Baltimore, MD, USA");
    });
  }, 60_000);

  it("visible text without a registered selection is NOT a commit — the fill fails by name instead of the submit click", async () => {
    await withFixtureHtmlPage(LEVER_LOCATION(false), async (page) => {
      await expect(
        fillLocationStyleText(page, page.locator("#location-input"), "Baltimore, Maryland, USA"),
      ).rejects.toThrow(/Lever selectedLocation empty/);
      // Negative control for the old read: the visible text alone looked committed.
      expect(await page.locator("#location-input").inputValue()).toBe("Baltimore, MD, USA");
      expect(await leverLocationSelectionEmpty(page)).toBe(true);
    });
  }, 60_000);

  it("pages without the hidden input are not Lever — the read says so", async () => {
    await withFixtureHtmlPage(`<html><body><input id="city" /></body></html>`, async (page) => {
      expect(await leverLocationSelectionEmpty(page)).toBeNull();
    });
  }, 30_000);
});
