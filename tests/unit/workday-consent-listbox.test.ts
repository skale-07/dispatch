import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import {
  fillComboboxControl,
  readComboboxValue,
} from "../../src/ats/greenhouse/comboboxFill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";

/**
 * #97 progressive-overload — Workday questionnaire CONSENT listbox buttons
 * (live tiaa.wd1 Application Questions shape, one level harder: ~190-char
 * sentence options, a popup that TOGGLES on every button click, and an
 * ambiguous two-yes option set). FIXTURE_CONFIRMED.
 *
 * Live failure chain this pins down (night22 job #1): the 80/120-char
 * junk caps dropped the sentence options, the reopen branch toggled the
 * open popup shut, and the final pick then timed out on invisible
 * options — three required questionnaire fields never filled.
 */
const FIXTURE = fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "ats", "workday", "consent-listbox.html"),
  "utf8",
);

describe("workday consent listbox (#97, FIXTURE_CONFIRMED)", () => {
  it("discovers the legend-labeled consent button as a required select", () => {
    const fields = discoverFieldsFromHtml(FIXTURE);
    const q = fields.find((f) => f.inputId === "primaryQuestionnaire--cons01");
    expect(q?.label).toMatch(/^TIAA Talent Acquisition uses an interview scheduling tool/);
    expect(q?.type).toBe("select");
    expect(q?.required).toBe(true);
  });

  it('expected "Yes" picks the yes-leading SENTENCE option from the open popup (no filter typing on a button)', async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const btn = page.locator("#primaryQuestionnaire--cons01");
      const r = await fillComboboxControl(page, btn, "Yes");
      expect(r.committed).toBe(true);
      expect(r.selectedLabel).toMatch(/^Yes, I hereby Consent and/);
      expect(await readComboboxValue(btn)).toMatch(/^Yes, I hereby Consent and/);
    });
  }, 45_000);

  it('expected "No" picks the no-leading sentence, never the placeholder or the Yes row', async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const btn = page.locator("#primaryQuestionnaire--cons01");
      const r = await fillComboboxControl(page, btn, "No");
      expect(r.committed).toBe(true);
      expect(r.selectedLabel).toMatch(/^No, I hereby Do Not Consent/);
    });
  }, 45_000);

  it("TWO yes-leading options is ambiguous: refuses with NOTHING committed (drill scan must not click sentence rows as categories)", async () => {
    await withFixtureHtmlPage(FIXTURE, async (page) => {
      const btn = page.locator("#primaryQuestionnaire--cons02");
      const r = await fillComboboxControl(page, btn, "Yes");
      expect(r.committed).toBe(false);
      // The button must still show its placeholder — no stray commit.
      expect(await btn.innerText()).toBe("Select One");
      expect(r.notes.join(" | ")).toMatch(/drill scan skipped|ambiguous/i);
    });
  }, 45_000);
});
