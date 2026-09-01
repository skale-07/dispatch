import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { scanRequiredCompleteness } from "../../src/ats/shared/requiredCompleteness.js";
import { redactObject } from "../../src/logging/redaction.js";

/**
 * The pre-click completeness gate, shaped on the real Cohere failure: a
 * filled form whose required Additional Questions were untouched clicked
 * Submit into client-side validation and ended UNCERTAIN. The scan names
 * every required-but-unanswered control BEFORE any click. FIXTURE_CONFIRMED.
 */
describe("required-completeness scan (FIXTURE_CONFIRMED)", () => {
  it("catches required EMPTY file inputs (transcript / cover letter), never resume", async () => {
    // 2026-08-29: 2 of the first 3 clicks bounced off required uploads the
    // scan skipped (type=file was excluded wholesale). Resume/CV inputs
    // stay excluded — the dedicated upload guard owns them and boards
    // clear input.files after chip-style success.
    const html = `
      <form>
        <label for="tr">Please upload a copy of an unofficial undergraduate transcript</label>
        <input type="file" id="tr" required style="display:none" />
        <label for="cl">Cover Letter</label>
        <input type="file" id="cl" required style="display:none" />
        <label for="resume">Resume/CV</label>
        <input type="file" id="resume" required style="display:none" />
        <label for="opt">Portfolio (optional)</label>
        <input type="file" id="opt" style="display:none" />
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const files = scan.unanswered.filter((u) => u.control === "file");
      const labels = files.map((u) => u.label);
      expect(labels).toContain(
        "Please upload a copy of an unofficial undergraduate transcript",
      );
      expect(labels).toContain("Cover Letter");
      expect(labels).not.toContain("Resume/CV");
      // The optional portfolio is not DOM-required — absent from `sure`.
      expect(labels).not.toContain("Portfolio (optional)");
    });
  }, 45_000);

  it("a required file input WITH a file selected is answered", async () => {
    const html = `
      <form>
        <label for="tr">Transcript</label>
        <input type="file" id="tr" required />
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      await page.setInputFiles("#tr", {
        name: "t.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.1"),
      });
      const scan = await scanRequiredCompleteness(page);
      expect(scan.unanswered.filter((u) => u.control === "file")).toEqual([]);
    });
  }, 45_000);

  it("LIVE neuralink shape: a required checkbox GROUP is one question, answered by any member (night19 #42)", async () => {
    const html = fs.readFileSync(
      path.join(process.cwd(), "tests", "fixtures", "ats", "greenhouse", "checkbox-groups.html"),
      "utf8",
    );
    await withFixtureHtmlPage(html, async (page) => {
      const before = await scanRequiredCompleteness(page);
      const groups = before.unanswered.filter((u) => u.control === "checkbox_group");
      // Three groups, named by their legends — never 15 member boxes.
      expect(groups.map((g) => g.label.replace(/\s*\*\s*$/, ""))).toEqual([
        "Are you currently authorized to work in the United States?",
        "I understand that this position requires me to work on-site.",
        "How did you hear about us?",
      ]);
      expect(before.unanswered.filter((u) => u.control === "checkbox")).toEqual([]);
      // Answer one member of each group (the way the fill does).
      await page.locator('[id="question_16876429003[]_104418776003"]').check();
      await page.locator('[id="question_16876431003[]_104418778003"]').check();
      await page.locator('[id="question_16876435003[]_104418791003"]').check();
      const after = await scanRequiredCompleteness(page);
      expect(after.unanswered.filter((u) => u.control === "checkbox_group")).toEqual([]);
      expect(after.unanswered.filter((u) => u.control === "checkbox")).toEqual([]);
      // The unchecked "No" / other how-did-you-hear members never reappear.
      expect(after.unanswered.map((u) => u.label)).not.toContain("No");
      expect(after.unanswered.map((u) => u.label)).not.toContain("YouTube");
    });
  }, 45_000);

  it("LIVE mastercard shape (#114): nameless Workday id-suffix checkbox group satisfied by one checked member", async () => {
    // Members share only the id SUFFIX ("<hex>-ethnicityMulti"), no name,
    // no fieldset/legend; one is checked and Workday itself is satisfied —
    // the scan must not name the remaining aria-required members.
    const html = `<form>
      <div>Please identify your race or ethnicity.</div>
      <div><input id="40a306eb-ethnicityMulti" type="checkbox" aria-required="true"><label for="40a306eb-ethnicityMulti">American Indian or Alaska Native</label></div>
      <div><input id="9d68a3a2-ethnicityMulti" type="checkbox" aria-required="true" checked><label for="9d68a3a2-ethnicityMulti">Asian (Not Hispanic or Latino)</label></div>
      <div><input id="00b90f77-ethnicityMulti" type="checkbox" aria-required="true"><label for="00b90f77-ethnicityMulti">White (Not Hispanic or Latino)</label></div>
      <div><input id="cd9a04db-ethnicityMulti" type="checkbox" aria-required="true"><label for="cd9a04db-ethnicityMulti">Prefer Not To Self Identify</label></div>
    </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const r = await scanRequiredCompleteness(page);
      expect(r.unanswered.filter((u) => u.control === "checkbox")).toEqual([]);
      expect(r.unanswered.filter((u) => u.control === "checkbox_group")).toEqual([]);
      // The UNANSWERED variant still reports (as one group, not members).
      await page.locator('[id="9d68a3a2-ethnicityMulti"]').uncheck();
      const empty = await scanRequiredCompleteness(page);
      expect(empty.unanswered.filter((u) => u.control === "checkbox_group")).toHaveLength(1);
      expect(empty.unanswered.filter((u) => u.control === "checkbox")).toEqual([]);
    });
  }, 45_000);

  it("catches the Cohere shape: untouched required radios, select, and essay", async () => {
    const html = `
      <form>
        <label for="n">Name</label><input id="n" required value="Shubham" />
        <fieldset>
          <legend>Are you available for a full-time internship?</legend>
          <label><input type="radio" name="avail" required value="Yes" />Yes</label>
          <label><input type="radio" name="avail" required value="No" />No</label>
        </fieldset>
        <fieldset>
          <legend>Please select the current level of education you are pursuing</legend>
          <label><input type="radio" name="edu" required value="Undergrad" />Undergrad</label>
          <label><input type="radio" name="edu" required value="PhD" />PhD</label>
        </fieldset>
        <label for="fit">What makes you a good fit for Cohere?</label>
        <textarea id="fit" required></textarea>
        <label for="heard">How did you hear about this role?</label>
        <select id="heard" required>
          <option value="">Start typing...</option>
          <option>JobRight</option>
        </select>
        <button type="button">Submit application</button>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels).toContain("Are you available for a full-time internship?");
      expect(labels).toContain(
        "Please select the current level of education you are pursuing",
      );
      expect(labels).toContain("What makes you a good fit for Cohere?");
      expect(labels).toContain("How did you hear about this role?");
      // The filled name field must NOT appear.
      expect(labels).not.toContain("Name");
      expect(scan.unanswered.map((u) => u.control)).toEqual(
        expect.arrayContaining(["radio_group", "textarea", "select"]),
      );
    });
  }, 30_000);

  it("catches the LIVE Ashby shape: asterisk-labeled role=radio groups with no aria-required", async () => {
    // The real submit gate refused only the essay textarea while two blank
    // required radio groups sailed past — Ashby marks required with ONLY a
    // trailing asterisk on the label, no [aria-required].
    const html = `
      <form>
        <div class="_fieldEntry_x1">
          <label id="l1">Are you able to work full time for the duration of the internship?<span>*</span></label>
          <div role="radiogroup" aria-labelledby="l1">
            <div role="radio" aria-checked="false" tabindex="0">Yes</div>
            <div role="radio" aria-checked="false" tabindex="-1">No</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l2">Please select the current level of education you are pursuing *</label>
          <div role="radiogroup" aria-labelledby="l2">
            <div role="radio" aria-checked="false">Undergraduate</div>
            <div role="radio" aria-checked="false">PhD</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l3">Which office is closest to you? *</label>
          <div role="radiogroup" aria-labelledby="l3">
            <div role="radio" aria-checked="true">Toronto</div>
            <div role="radio" aria-checked="false">London</div>
          </div>
        </div>
        <div class="_fieldEntry_x1">
          <label id="l4">Anything else you want to share? (optional)</label>
          <div role="radiogroup" aria-labelledby="l4">
            <div role="radio" aria-checked="false">Yes</div>
            <div role="radio" aria-checked="false">No</div>
          </div>
        </div>
        <button type="button">Submit application</button>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels.join(" | ")).toMatch(/work full time/);
      expect(labels.join(" | ")).toMatch(/level of education/);
      // Answered group: not flagged. Unmarked optional group: not flagged.
      expect(labels.join(" | ")).not.toMatch(/closest to you/);
      expect(labels.join(" | ")).not.toMatch(/Anything else/);
      expect(
        scan.unanswered.filter((u) => u.control === "radio_group").length,
      ).toBe(2);
    });
  }, 30_000);

  it("LIVE Exa shape: NATIVE radios in a legendless fieldset, requiredness only as a class token on the question label (night20 #58)", async () => {
    // The real 2026-08-30 miss: Ashby's native radio group carries no
    // [required]/aria-required/asterisk anywhere — only `_required_…` in
    // the question label's class — and hides the inputs behind painted
    // circles. The scan filed the group as optional under an OPTION's
    // label and the click sailed into "missing entry for required field".
    // Fixture is one level harder than live: hidden inputs, a decoy
    // `notrequired` class, an answered required group, an optional group.
    const html = `
      <style>input[type=radio]{display:none}</style>
      <form>
        <fieldset>
          <label class="_heading_a _required_f7cvd_91 _label_b" for="q1">Are you based in San Francisco or open to relocating?</label>
          <div><input type="radio" id="q1-r0" name="grp_q1" /><label for="q1-r0">San Francisco based</label></div>
          <div><input type="radio" id="q1-r1" name="grp_q1" /><label for="q1-r1">Open to relocating</label></div>
        </fieldset>
        <fieldset>
          <label class="_heading_a _required_zz9 _label_b" for="q2">Are you authorized to work in the US?</label>
          <div><input type="radio" id="q2-r0" name="grp_q2" checked /><label for="q2-r0">Yes</label></div>
          <div><input type="radio" id="q2-r1" name="grp_q2" /><label for="q2-r1">No</label></div>
        </fieldset>
        <fieldset>
          <label class="_heading_a _notrequired_x1 _label_b" for="q3">Preferred T-shirt size</label>
          <div><input type="radio" id="q3-r0" name="grp_q3" /><label for="q3-r0">S</label></div>
          <div><input type="radio" id="q3-r1" name="grp_q3" /><label for="q3-r1">M</label></div>
        </fieldset>
        <button type="button">Submit application</button>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      const groups = scan.unanswered.filter((u) => u.control === "radio_group");
      // The QUESTION label, never an option label.
      expect(groups.map((g) => g.label)).toEqual([
        "Are you based in San Francisco or open to relocating?",
      ]);
      expect(scan.unanswered.map((u) => u.label)).not.toContain("San Francisco based");
      // Answered required group and decoy-class optional group stay clear.
      expect(scan.unanswered.map((u) => u.label)).not.toContain(
        "Are you authorized to work in the US?",
      );
      expect(scan.unanswered.map((u) => u.label)).not.toContain("Preferred T-shirt size");
    });
  }, 30_000);

  it("a fully answered form passes clean", async () => {
    const html = `
      <form>
        <label for="n">Name</label><input id="n" required value="S" />
        <fieldset>
          <legend>Available?</legend>
          <label><input type="radio" name="a" required value="Yes" checked />Yes</label>
          <label><input type="radio" name="a" required value="No" />No</label>
        </fieldset>
        <label for="s">Source</label>
        <select id="s" required><option value="">--</option><option selected>JobRight</option></select>
        <label for="t">Essay</label><textarea id="t" required>done</textarea>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.scanned).toBe(true);
      expect(scan.unanswered).toEqual([]);
    });
  }, 30_000);

  it("optional fields never block, hidden required fields never block", async () => {
    const html = `
      <form>
        <label for="opt">Optional referral</label><input id="opt" value="" />
        <input type="hidden" required value="" />
        <div style="display:none"><label for="h">Ghost</label><input id="h" required value="" /></div>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.unanswered).toEqual([]);
    });
  }, 30_000);

  it("ARIA radiogroup and combobox widgets (Ashby-style) are covered", async () => {
    const html = `
      <div role="radiogroup" aria-required="true" aria-label="Education level">
        <div role="radio" aria-checked="false">Undergrad</div>
        <div role="radio" aria-checked="false">PhD</div>
      </div>
      <input role="combobox" aria-required="true" aria-label="How did you hear about this role?" placeholder="Start typing..." value="" />
      <div role="radiogroup" aria-required="true" aria-label="Answered group">
        <div role="radio" aria-checked="true">Yes</div>
      </div>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      const labels = scan.unanswered.map((u) => u.label);
      expect(labels).toContain("Education level");
      expect(labels).toContain("How did you hear about this role?");
      expect(labels).not.toContain("Answered group");
    });
  }, 30_000);

  it("Greenhouse React-select: a picked option is answered even when the filter input is empty", async () => {
    const html = `<!DOCTYPE html><html><body>
      <form>
        <label for="country">Country*</label>
        <div class="select__control">
          <span class="select__placeholder">Select...</span>
          <input id="country" name="country" type="text" required
                 role="combobox" aria-required="true" aria-haspopup="listbox"
                 aria-autocomplete="list" value="" />
        </div>
        <label for="city">Location (City)*</label>
        <div class="select__control">
          <span class="select__placeholder">Select...</span>
          <input id="city" name="city" type="text" required
                 role="combobox" aria-required="true" aria-haspopup="listbox"
                 aria-autocomplete="list" value="" />
        </div>
      </form>
      <script>
        document.querySelectorAll(".select__control").forEach((control) => {
          const input = control.querySelector("input");
          control.addEventListener("click", () => {
            let single = control.querySelector(".select__single-value");
            if (!single) {
              single = document.createElement("span");
              single.className = "select__single-value";
              control.insertBefore(single, input);
            }
            single.textContent = input.id === "country" ? "United States" : "Baltimore";
            control.querySelector(".select__placeholder").hidden = true;
            input.value = "";
          });
        });
      </script>
    </body></html>`;
    await withFixtureHtmlPage(html, async (page) => {
      const before = await scanRequiredCompleteness(page);
      expect(before.unanswered.map((u) => u.control)).toEqual(["combobox", "combobox"]);
      expect(before.unanswered.map((u) => u.label).join(" ")).toMatch(/Country/);
      expect(before.unanswered.some((u) => u.control === "text")).toBe(false);

      await page.locator("#country").click();
      await page.locator("#city").click();
      const after = await scanRequiredCompleteness(page);
      expect(after.unanswered).toEqual([]);
    });
  }, 30_000);
});

describe("board-API declared requiredness (G2, FIXTURE_CONFIRMED)", () => {
  // The live gap this closes: Greenhouse renders screener questions with
  // no [required], no aria-required, and no trailing asterisk — the DOM
  // heuristics see them as optional and the click sails into client-side
  // validation. The board's own API says `required: true`; feeding those
  // labels in makes the same control a pre-click refusal.
  const HTML = `
    <form>
      <label for="essay">Why do you want to work here?</label>
      <textarea id="essay" required></textarea>
      <label for="heard">How did you hear about this opportunity?</label>
      <select id="heard">
        <option value="">Select...</option>
        <option>LinkedIn</option>
      </select>
      <label for="site">Personal website</label>
      <input id="site" value="" />
      <label for="ok">Are you authorized to work in the US?</label>
      <select id="ok">
        <option value="">Select...</option>
        <option selected>Yes</option>
      </select>
    </form>`;

  it("without a declared list the DOM heuristics stand alone — exact pre-G2 behavior", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const scan = await scanRequiredCompleteness(page);
      expect(scan.unanswered.map((u) => u.label)).toEqual([
        "Why do you want to work here?",
      ]);
      expect(scan.unanswered[0]!.source).toBe("dom");
    });
  }, 30_000);

  it("a declared-required control the DOM saw as optional blocks, naming the API", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const scan = await scanRequiredCompleteness(page, {
        declaredRequired: [
          "Why do you want to work here?",
          "How did you hear about this opportunity?",
          // Answered on the page — must not be flagged just because the
          // API declares it required.
          "Are you authorized to work in the US?",
        ],
      });
      expect(scan.unanswered).toEqual([
        {
          label: "Why do you want to work here?",
          control: "textarea",
          source: "dom",
        },
        {
          label: "How did you hear about this opportunity?",
          control: "select",
          source: "board_api",
        },
      ]);
      // The truly optional unanswered text input stays unflagged.
      expect(scan.unanswered.map((u) => u.label)).not.toContain("Personal website");
    });
  }, 30_000);

  it("matches a DOM label the board truncated (unique prefix, ≥20 chars) and refuses short prefixes", async () => {
    const html = `
      <form>
        <label for="a">Are you currently pursuing a Major in one of the following disciplines: Com</label>
        <select id="a"><option value="">Select...</option><option>Yes</option></select>
        <label for="b">Country</label>
        <select id="b"><option value="">Select...</option><option>US</option></select>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const scan = await scanRequiredCompleteness(page, {
        declaredRequired: [
          "Are you currently pursuing a Major in one of the following disciplines: Computer Science, Computer Engineering?",
          // Short generic label: exact match only, no prefix creep — a
          // false requiredness flag is a wrong refusal.
          "Country of residence",
        ],
      });
      expect(scan.unanswered).toEqual([
        {
          label:
            "Are you currently pursuing a Major in one of the following disciplines: Com",
          control: "select",
          source: "board_api",
        },
      ]);
    });
  }, 30_000);

  it("an unanswered optional Greenhouse-style combobox widget promotes too", async () => {
    // Greenhouse React-selects reach the widget pass (role=combobox); when
    // the board omits aria-required AND the asterisk, only the API knows.
    const html = `
      <form>
        <label for="pron">How did you hear about Appian?</label>
        <div class="select__control">
          <input id="pron" type="text" role="combobox" aria-haspopup="listbox"
                 aria-autocomplete="list" value="" />
        </div>
      </form>`;
    await withFixtureHtmlPage(html, async (page) => {
      const bare = await scanRequiredCompleteness(page);
      expect(bare.unanswered).toEqual([]);
      const scan = await scanRequiredCompleteness(page, {
        declaredRequired: ["How did you hear about Appian?"],
      });
      expect(scan.unanswered).toEqual([
        {
          label: "How did you hear about Appian?",
          control: "combobox",
          source: "board_api",
        },
      ]);
    });
  }, 30_000);
});

describe("redaction word-guard (UNIT_CONFIRMED)", () => {
  it("phase_trace survives; demographic keys still redact", () => {
    const out = redactObject({
      phase_trace: [{ phase: "A", outcome: "ok" }],
      trace_id: "abc",
      race_ethnicity: "x",
      race: "x",
      gender_identity: "x",
      agenda: "standup notes",
      phone: "555",
    });
    expect(Array.isArray(out["phase_trace"])).toBe(true);
    expect(out["trace_id"]).toBe("abc");
    expect(out["race_ethnicity"]).toBe("[REDACTED]");
    expect(out["race"]).toBe("[REDACTED]");
    expect(out["gender_identity"]).toBe("[REDACTED]");
    expect(out["agenda"]).toBe("standup notes");
    expect(out["phone"]).toBe("[REDACTED]");
  });
});
