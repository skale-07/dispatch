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
import {
  comboboxAlternates,
  dedupeAnchorlessCanonicalTwins,
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
} from "../../src/ats/greenhouse/fill.js";

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

describe("#68 overlaid radios + how_heard class fallbacks (FIXTURE_CONFIRMED)", () => {
  it("a VISIBLE radio under a pointer-intercepting overlay is checked via the label[for] tier, not a 30s hang", async () => {
    // Live tiaa #22q: candidateIsPreviousWorker — visible, enabled,
    // stable, and a painted div swallowed every click for 30s.
    const html = `<html><body>
      <fieldset data-automation-id="formField-candidateIsPreviousWorker">
        <legend><label>Have you previously been an employee of TIAA?</label></legend>
        <div style="position:relative">
          <input type="radio" name="candidateIsPreviousWorker" id="prev-yes" value="true" />
          <label for="prev-yes">Yes</label>
          <input type="radio" name="candidateIsPreviousWorker" id="prev-no" value="false" />
          <label for="prev-no">No</label>
          <div style="position:absolute;top:0;left:0;width:100%;height:100%;background:transparent"></div>
        </div>
      </fieldset>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const meta = new Map([
        ["candidateIsPreviousWorker", { type: "radio", name: "candidateIsPreviousWorker" }],
      ]);
      const r = await greenhouseFillFromPlan(
        page,
        [
          {
            field_id: "candidateIsPreviousWorker",
            label: "Have you previously been an employee of TIAA?",
            type: "radio",
            canonical_field: "screener:previously_applied_or_worked",
            action: "FILL",
            value: "No",
            reason: "test",
            approved: true,
          } as never,
        ],
        meta as never,
      );
      expect(r.errors).toEqual([]);
      expect(await page.locator("#prev-no").isChecked()).toBe(true);
    });
  }, 45_000);

  it('how_heard "LinkedIn" on a class-only option list falls back to the FIRST offered class alternate, noted; without alternates it still refuses', async () => {
    const html = `<html><body>
      <label for="src">How did you hear about us?</label>
      <div data-automation-id="multiSelectContainer" id="ms">
        <input placeholder="Search" data-uxi-widget-type="selectinput" id="src" value="">
        <ul role="listbox" data-automation-id="selectedItemList"></ul>
      </div>
      <div role="listbox" id="opts" style="display:none"></div>
      <script>
        const OPTIONS = ['College Event', 'Contacted by Recruiter', 'Corporate Website', 'Job Board', 'Military/Veterans', 'Social Media'];
        const input = document.getElementById('src');
        const popup = document.getElementById('opts');
        const chips = document.querySelector('#ms [data-automation-id=selectedItemList]');
        function render(filter) {
          popup.innerHTML = '';
          for (const s of OPTIONS.filter((o) => !filter || o.toLowerCase().includes(filter.toLowerCase()))) {
            const d = document.createElement('div');
            d.setAttribute('role', 'option');
            d.textContent = s;
            d.addEventListener('click', () => {
              const pill = document.createElement('div');
              pill.setAttribute('data-automation-id', 'selectedItem');
              chips.appendChild(pill);
              pill.textContent = s;
              popup.style.display = 'none';
              input.value = '';
            });
            popup.appendChild(d);
          }
          popup.style.display = 'block';
        }
        input.addEventListener('click', () => render(''));
        input.addEventListener('input', () => render(input.value));
        input.addEventListener('keyup', () => render(input.value));
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const input = page.locator("#src");
      const withAlts = await fillComboboxControl(page, input, "LinkedIn", {
        alternates: comboboxAlternates("how_heard", "LinkedIn"),
      });
      expect(withAlts.committed).toBe(true);
      // Order preference: "Social Media" (most accurate for LinkedIn)
      // beats "Job Board" even though both are offered.
      expect(withAlts.selectedLabel).toBe("Social Media");
      expect(withAlts.notes.join(" ")).toMatch(
        /not offered — class fallback picked|picked "Social Media" \(drill scan\)/,
      );
    });
    await withFixtureHtmlPage(html, async (page) => {
      const bare = await fillComboboxControl(page, page.locator("#src"), "LinkedIn");
      expect(bare.committed).toBe(false);
    });
  }, 45_000);

  it("comboboxAlternates is SCOPED: nothing for other canonicals or unknown values", () => {
    expect(comboboxAlternates("address.state", "LinkedIn")).toEqual([]);
    expect(comboboxAlternates("how_heard", "My Neighbor")).toEqual([]);
    expect(comboboxAlternates(null, "LinkedIn")).toEqual([]);
  });

  it('#71 two-level prompt list: drills into "Job Board" and picks the stored "LinkedIn" LEAF verbatim (live tiaa shape)', async () => {
    const html = `<html><body>
      <label for="src">How did you hear about us?</label>
      <div data-automation-id="multiSelectContainer" id="ms">
        <input placeholder="Search" data-uxi-widget-type="selectinput" id="src" value="">
        <ul role="listbox" data-automation-id="selectedItemList"></ul>
      </div>
      <div role="listbox" id="opts" style="display:none"></div>
      <script>
        const TREE = {
          'College Event': ['Career Fair', 'Other'],
          'Job Board': ['Glassdoor', 'Indeed', 'LinkedIn', 'Other'],
          'Social Network': ['Facebook', 'Other'],
        };
        const input = document.getElementById('src');
        const popup = document.getElementById('opts');
        const chips = document.querySelector('#ms [data-automation-id=selectedItemList]');
        function render(items, leaf) {
          popup.innerHTML = '';
          for (const s of items) {
            const d = document.createElement('div');
            d.setAttribute('role', 'option');
            d.textContent = s;
            d.addEventListener('click', () => {
              if (!leaf) { render(TREE[s], true); return; }
              const pill = document.createElement('div');
              pill.setAttribute('data-automation-id', 'selectedItem');
              pill.textContent = s;
              chips.appendChild(pill);
              popup.style.display = 'none';
            });
            popup.appendChild(d);
          }
          popup.style.display = 'block';
        }
        // typing does NOTHING on this widget (live tiaa shape)
        input.addEventListener('click', () => render(Object.keys(TREE), false));
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await fillComboboxControl(page, page.locator("#src"), "LinkedIn", {
        alternates: comboboxAlternates("how_heard", "LinkedIn"),
      });
      expect(r.committed).toBe(true);
      expect(r.selectedLabel).toBe("LinkedIn");
      expect(r.notes.join(" ")).toMatch(/drilled into "Job Board" and picked leaf "LinkedIn"/);
    });
  }, 45_000);

  it("#73 skills multiselect: each resume skill picked option-verified; unoffered skills named; chips-subset verify passes", async () => {
    const html = `<html><body>
      <label for="sk">Skills</label>
      <div data-automation-id="multiSelectContainer" id="ms">
        <input placeholder="Search" data-uxi-widget-type="selectinput" id="sk" value="">
        <ul role="listbox" data-automation-id="selectedItemList"></ul>
      </div>
      <div role="listbox" id="opts" style="display:none"></div>
      <script>
        const TAXONOMY = ['Java', 'JavaScript', 'Python', 'React', 'SQL', 'TypeScript'];
        const input = document.getElementById('sk');
        const popup = document.getElementById('opts');
        const chips = document.querySelector('#ms [data-automation-id=selectedItemList]');
        function render(filter) {
          popup.innerHTML = '';
          for (const s of TAXONOMY.filter((o) => !filter || o.toLowerCase().includes(filter.toLowerCase()))) {
            const d = document.createElement('div');
            d.setAttribute('role', 'option');
            d.textContent = s;
            d.addEventListener('click', () => {
              const li = document.createElement('li');
              const pill = document.createElement('div');
              pill.setAttribute('data-automation-id', 'selectedItem');
              pill.textContent = s;
              const charm = document.createElement('span');
              charm.setAttribute('data-automation-id', 'DELETE_charm');
              charm.addEventListener('click', () => li.remove());
              pill.appendChild(charm);
              li.appendChild(pill);
              chips.appendChild(li);
              popup.style.display = 'none';
              input.value = '';
            });
            popup.appendChild(d);
          }
          popup.style.display = 'block';
        }
        input.addEventListener('click', () => render(input.value));
        input.addEventListener('input', () => render(input.value));
        input.addEventListener('keyup', () => render(input.value));
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const meta = new Map([["sk", { type: "select", inputId: "sk" }]]);
      const entries = [
        {
          field_id: "sk",
          label: "Skills",
          type: "select",
          canonical_field: "skills",
          action: "FILL",
          approved: true,
          value: ["Python", "TypeScript", "Quantum Basketry"],
          reason: "t",
        } as never,
      ];
      const r = await greenhouseFillFromPlan(page, entries, meta as never);
      expect(r.errors).toEqual([]);
      const chips = await page
        .locator("#ms [data-automation-id='selectedItem']")
        .allTextContents();
      expect(chips).toEqual(["Python", "TypeScript"]);
      expect(
        (r.field_meta ?? [])
          .find((m: { field_id: string }) => m.field_id === "sk")
          ?.notes?.join(" "),
      ).toMatch(/not offered by the page: Quantum Basketry/);
      const v = await greenhouseVerifyFromPlan(page, entries, meta as never);
      expect(v.passed).toBe(true);
    });
  }, 60_000);

  it("#78 a select-planned question that is really an Ashby hidden-radio FIELDSET fills painted-safe and verifies via the checked member (live exa shape)", async () => {
    const html = `<html><body>
      <fieldset>
        <label>Are you based in San Francisco or open to relocating?</label>
        <input type="radio" name="q1" id="o1" value="a" style="display:none" />
        <label for="o1">San Francisco based</label>
        <input type="radio" name="q1" id="o2" value="b" style="display:none" />
        <label for="o2">Open to relocating</label>
      </fieldset>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const meta = new Map([["3a52e1c2", { type: "select" }]]);
      const entries = [
        {
          field_id: "3a52e1c2",
          label: "Are you based in San Francisco or open to relocating?",
          type: "select",
          canonical_field: "screener:willing_to_relocate",
          action: "FILL",
          approved: true,
          value: "Open to relocating",
          reason: "t",
        } as never,
      ];
      const r = await greenhouseFillFromPlan(page, entries, meta as never);
      expect(r.errors).toEqual([]);
      expect(await page.locator("#o2").isChecked()).toBe(true);
      expect(await page.locator("#o1").isChecked()).toBe(false);
      const v = await greenhouseVerifyFromPlan(page, entries, meta as never);
      expect(v.passed).toBe(true);
    });
  }, 45_000);

  it("#69 ghost dedupe: an anchorless FILL twin of an anchored canonical is dropped; lone anchorless entries survive", () => {
    const mk = (field_id: string, canonical: string) =>
      ({ field_id, label: field_id, type: "text", canonical_field: canonical, action: "FILL", approved: true, value: "x", reason: "t" }) as never;
    const meta = new Map([
      ["phoneNumber--phoneNumber", { type: "text", inputId: "phoneNumber--phoneNumber" }],
      // f_13: no inputId, no name — the live tiaa ghost
      ["f_13", { type: "text" }],
      ["f_20", { type: "text" }],
    ]);
    const r = dedupeAnchorlessCanonicalTwins(
      [mk("phoneNumber--phoneNumber", "phone"), mk("f_13", "phone"), mk("f_20", "essay_1")],
      meta as never,
    );
    expect(r.dropped).toEqual(["f_13 (phone)"]);
    expect(r.entries.map((e: { field_id: string }) => e.field_id)).toEqual([
      "phoneNumber--phoneNumber",
      "f_20",
    ]);
  });
});
