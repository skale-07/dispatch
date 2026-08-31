import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import {
  detectControlKind,
  fillComboboxControl,
  readComboboxValue,
} from "../../src/ats/greenhouse/comboboxFill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * #67 progressive-overload — Workday listbox-button dropdowns and
 * multiselect search widgets (live tiaa.wd1 shapes, one level harder:
 * decoys, chips-as-listbox, virtualized options, attr-order trap).
 * FIXTURE_CONFIRMED.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "ats", "workday", "listbox-multiselect.html"),
  "utf8",
);

describe("workday widget discovery (#67, FIXTURE_CONFIRMED)", () => {
  it("discovers the listbox BUTTON as a labeled select; page-chrome listbox buttons are never fields", () => {
    const fields = discoverFieldsFromHtml(FIXTURE);
    const phoneType = fields.find((f) => f.inputId === "phoneNumber--phoneType");
    expect(phoneType?.label).toBe("Phone Device Type");
    expect(phoneType?.type).toBe("select");
    expect(phoneType?.required).toBe(true);
    // The settings gear (aria-haspopup=listbox, no label[for]) is chrome.
    expect(fields.find((f) => f.inputId === "settingsSelectorButton")).toBeUndefined();
  });

  it("#67a getAttr boundary: aria-invalid before id no longer yields id=\"false\" — the multiselect is labeled by its label[for], not its placeholder", () => {
    const fields = discoverFieldsFromHtml(FIXTURE);
    const source = fields.find((f) => f.inputId === "source--source");
    expect(source?.label).toBe("How Did You Hear About Us?");
    expect(source?.type).toBe("select");
    expect(fields.filter((f) => f.id === "false")).toEqual([]);
    expect(fields.filter((f) => f.label === "Search")).toEqual([]);
  });
});

describe("workday widget fill/verify (#67, FIXTURE_CONFIRMED)", () => {
  it("listbox button: detected as combobox; open → pick → button text is the committed read-back", async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const btn = page.locator("#phoneNumber--phoneType");
      expect(await detectControlKind(btn)).toBe("combobox");
      const r = await fillComboboxControl(page, btn, "Landline");
      expect(r.committed).toBe(true);
      expect(r.selectedLabel).toBe("Landline");
      expect(await readComboboxValue(btn)).toBe("Landline");
    });
  }, 45_000);

  it("multiselect: virtualized options surface via the typed filter; the pick lands a chip; chips are the read-back and the chips list is never mistaken for the options popup", async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const input = page.locator("#source--source");
      // "LinkedIn" is OUTSIDE the first virtualization window (first 3).
      const r = await fillComboboxControl(page, input, "LinkedIn");
      expect(r.committed).toBe(true);
      expect(await readComboboxValue(input)).toBe("LinkedIn");
      expect(
        await page
          .locator("#ms-source [data-automation-id='selectedItem']")
          .textContent(),
      ).toBe("LinkedIn");
    });
  }, 45_000);

  it("a PRESELECTED multiselect (chips already present) reads back its chip and is left alone by the already-committed check", async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const cpc = page.locator("#phoneNumber--countryPhoneCode");
      expect(await readComboboxValue(cpc)).toBe("United States of America (+1)");
      const r = await fillComboboxControl(page, cpc, "United States of America (+1)");
      expect(r.committed).toBe(true);
      expect(r.notes.join(" ")).toMatch(/already committed/);
    });
  }, 45_000);
});
