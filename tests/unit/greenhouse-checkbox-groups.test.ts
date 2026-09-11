import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverFieldsFromHtml } from "../../src/applications/fieldDiscovery.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  type FieldMeta,
} from "../../src/ats/greenhouse/fill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Progressive-overload set for issue #21 (night19 #40): 12 Neuralink rows
 * parked AMBIGUOUS_FIELD on the same three shapes — an option labeled
 * "LinkedIn" claimed as the LinkedIn URL field, the one-member "I
 * understand … on-site" group never found, and Yes/No groups treated as a
 * single box's state. Fixture is the live job-boards markup.
 */
const HTML = fs.readFileSync(
  path.join(process.cwd(), "tests", "fixtures", "ats", "greenhouse", "checkbox-groups.html"),
  "utf8",
);

const HEARD = "question_16876435003[]";
const AUTH = "question_16876429003[]";
const ONSITE = "question_16876431003[]";

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

describe("greenhouse checkbox groups — discovery (UNIT_CONFIRMED)", () => {
  const fields = discoverFieldsFromHtml(HTML, { preferGreenhouse: true });
  const byId = (id: string) => fields.find((f) => f.id === id);

  it("collapses each question_N[] group into ONE field labeled by the question", () => {
    const heard = byId(HEARD);
    expect(heard?.label).toBe("How did you hear about us?");
    expect(heard?.type).toBe("checkbox");
    expect(heard?.options).toHaveLength(12);
    expect(heard?.options).toContain("LinkedIn");
    expect(heard?.options).toContain("Neuralink Show & Tell");
    expect(heard?.inputId).toBe("question_16876435003[]_104418785003");
    expect(heard?.required).toBe(true);
    expect(fields.filter((f) => f.name === HEARD)).toHaveLength(1);
  });

  it("no field is labeled by an option — 'LinkedIn' cannot be claimed as linkedin_url", () => {
    expect(fields.some((f) => f.label === "LinkedIn")).toBe(false);
    const li = fields.find((f) => f.label === "LinkedIn Profile");
    expect(li?.type).toBe("text");
    expect(li?.inputId).toBe("question_16876426003");
  });

  it("a one-member group is the question with a single 'Yes' option", () => {
    const onsite = byId(ONSITE);
    expect(onsite?.label).toBe("I understand that this position requires me to work on-site.");
    expect(onsite?.options).toEqual(["Yes"]);
    expect(onsite?.inputId).toBe("question_16876431003[]_104418778003");
  });

  it("the aria-hidden required sentinel after a group is never a field (no ghost f_N labeled by the legend)", () => {
    const ghosts = fields.filter(
      (f) => /^f_\d+$/.test(f.id) || (f.type === "text" && /work on-site/.test(f.label)),
    );
    expect(ghosts).toEqual([]);
    expect(fields.filter((f) => /work on-site/.test(f.label))).toHaveLength(1);
  });

  it("harder: a lone consent checkbox outside any fieldset keeps its own label and no options", () => {
    const consent = fields.find((f) => f.inputId === "privacy_consent");
    expect(consent?.label).toBe("I have read and agree to the privacy policy");
    expect(consent?.options).toBeUndefined();
    expect(consent?.id).toBe("privacy_consent");
  });

  it("harder: the legend alone (no description attribute) still names the group", () => {
    const stripped = HTML.replace(/ description="[^"]*"/g, "");
    const f = discoverFieldsFromHtml(stripped, { preferGreenhouse: true });
    expect(f.find((x) => x.id === AUTH)?.label).toBe(
      "Are you currently authorized to work in the United States?",
    );
    expect(f.find((x) => x.id === AUTH)?.options).toEqual(["Yes", "No"]);
  });
});

describe("greenhouse checkbox groups — the on-site acknowledgement is a bank-answerable question (UNIT_CONFIRMED)", () => {
  it("'I understand …' / 'I am aware …' statements are capture-worthy checkbox questions", async () => {
    const { isCaptureWorthyQuestion } = await import("../../src/applications/screenerPredictionLlm.js");
    expect(
      isCaptureWorthyQuestion({
        label: "I understand that this position requires me to work on-site.",
        type: "checkbox",
      }),
    ).toBe(true);
    expect(
      isCaptureWorthyQuestion({ label: "I am aware this role requires a security clearance.", type: "checkbox" }),
    ).toBe(true);
    // A bare option label is still not a question.
    expect(isCaptureWorthyQuestion({ label: "Neuralink Show & Tell", type: "checkbox" })).toBe(false);
  });

  // #235 (live DV Trading greenhouse 2026-09-10, twice): a REQUIRED
  // checkbox GROUP whose label is a noun phrase — no "?", no imperative —
  // was rejected by the phrasing rule and skipped "No answer-alias
  // mapping", so the submit gate refused on a question the page's own
  // option list could answer. An option checkbox has no options of its
  // own; the group does, and that is the exact tell.
  it("a checkbox GROUP with its own option list is a question whatever its phrasing", async () => {
    const { isCaptureWorthyQuestion } = await import("../../src/applications/screenerPredictionLlm.js");
    expect(
      isCaptureWorthyQuestion({
        label: "Undergrad Discipline(s)",
        type: "checkbox",
        options: ["Applied Mathematics", "Statistics", "Economics", "Physics"],
      }),
    ).toBe(true);
    // Without a list it is indistinguishable from one option of a group,
    // so the phrasing rule still decides — unchanged behaviour.
    expect(isCaptureWorthyQuestion({ label: "Undergrad Discipline(s)", type: "checkbox" })).toBe(false);
    expect(
      isCaptureWorthyQuestion({ label: "Applied Mathematics", type: "checkbox", options: [] }),
    ).toBe(false);
    // Demographic groups stay excluded even with a full option list.
    expect(
      isCaptureWorthyQuestion({
        label: "Please identify your race",
        type: "checkbox",
        options: ["Asian", "White", "Decline to self-identify"],
      }),
    ).toBe(false);
  });
});

describe("greenhouse checkbox groups — fill + verify (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  const metaFor = (fieldId: string, inputId: string): Map<string, FieldMeta> =>
    new Map([[fieldId, { type: "checkbox", inputId, name: fieldId }]]);

  // #262 (live Palantir/Lever, night30): Lever's location rows are DIVs
  // (div.dropdown-results > div.dropdown-location). The fill never saw them,
  // fell back to ArrowDown+Enter, and the hidden selectedLocation stayed
  // empty — the form rejected the submit.
  it("Lever location typeahead: clicks a div.dropdown-location row so selectedLocation is set (#262)", async () => {
    const lever = `<!DOCTYPE html><html><body><form>
      <li class="application-question"><label>Current location ✱
        <input id="location-input" name="location" type="text" />
        <input id="selected-location" name="selectedLocation" type="hidden" value="" />
        <div class="dropdown-container" id="dd"></div>
      </label></li></form>
      <script>
        const input = document.getElementById('location-input');
        input.addEventListener('input', () => {
          const q = input.value.toLowerCase();
          setTimeout(() => {
            const dd = document.getElementById('dd');
            dd.innerHTML = q.startsWith('balt')
              ? '<div class="dropdown-results"><div class="dropdown-location">Baltimore, MD, USA</div><div class="dropdown-location">Baltimore, Cork, IRL</div></div>'
              : '<div class="dropdown-no-results">No location found</div>';
            dd.querySelectorAll('.dropdown-location').forEach((row) => row.addEventListener('click', () => {
              input.value = row.textContent;
              document.getElementById('selected-location').value = JSON.stringify({ name: row.textContent, id: 'x1' });
              dd.innerHTML = '';
            }));
          }, 300);
        });
      </script></body></html>`;
    await withFixtureHtmlPage(lever, async (page) => {
      const e = entry({ field_id: "location-input", label: "location", type: "text", value: "Baltimore", canonical_field: "address.city" });
      const meta = new Map<string, FieldMeta>([["location-input", { type: "text", inputId: "location-input", name: "location" }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator("#selected-location").inputValue()).toContain("Baltimore, MD, USA");
    });
  }, 45_000);

  // #254 (live Palantir/Lever, night30): card checkboxes carry only the
  // shared name and a per-box value — no id. The label matched and the
  // id-only targeting refused it as "no option matching".
  it("an id-less shared-name group (Lever cards) checks the matching member by name+value (#254)", async () => {
    const NAME = "cards[a69a985a][field0]";
    const lever = `<!DOCTYPE html><html><body><form>
      <div class="application-question custom-question">
        <div class="application-label"><div class="text">Language Skill(s) (Check all that apply)</div></div>
        <ul data-qa="checkboxes">
          <li><label><input type="checkbox" name="${NAME}" value="English (ENG)"><span>English (ENG)</span></label></li>
          <li><label><input type="checkbox" name="${NAME}" value="Spanish (SPA)"><span>Spanish (SPA)</span></label></li>
          <li><label><input type="checkbox" name="${NAME}" value="French (FRA)"><span>French (FRA)</span></label></li>
        </ul>
      </div></form></body></html>`;
    await withFixtureHtmlPage(lever, async (page) => {
      const e = entry({
        field_id: NAME,
        label: "Language Skill(s) (Check all that apply)",
        type: "checkbox",
        value: "English (ENG)",
        canonical_field: "screener:custom:language_skills",
      });
      const meta = new Map<string, FieldMeta>([[NAME, { type: "checkbox", name: NAME }]]);
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator(`input[name="${NAME}"][value="English (ENG)"]`).isChecked()).toBe(true);
      expect(await page.locator(`input[name="${NAME}"][value="Spanish (SPA)"]`).isChecked()).toBe(false);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("'Yes' on the one-member on-site acknowledgement checks its only box", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: ONSITE,
        label: "I understand that this position requires me to work on-site.",
        type: "checkbox",
        value: "Yes",
        canonical_field: "screener:custom:onsite_ack",
      });
      const meta = metaFor(ONSITE, "question_16876431003[]_104418778003");
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator('[id="question_16876431003[]_104418778003"]').isChecked()).toBe(true);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("harder: 'No' on the Yes|No work-authorization group checks the NO member (never unchecks 'Yes')", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: AUTH,
        label: "Are you currently authorized to work in the United States?",
        type: "checkbox",
        value: "No",
        canonical_field: "work_authorization",
      });
      const meta = metaFor(AUTH, "question_16876429003[]_104418776003");
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator('[id="question_16876429003[]_104418777003"]').isChecked()).toBe(true);
      expect(await page.locator('[id="question_16876429003[]_104418776003"]').isChecked()).toBe(false);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      expect(verify.fields[0]?.match).toBe(true);
      expect(verify.fields[0]?.observed).not.toBe(true);
    });
  }, 45_000);

  // #236 (live Rocket Lab greenhouse 2026-09-10, three apps parked
  // AMBIGUOUS_FIELD with `Expected "No"; page shows "true"`). The FILL
  // decides option-vs-state with `isCheckboxBooleanValue(value) &&
  // !multiMember`; the READ-BACK tested only the first half, so it
  // reported this box's raw checked state. Whether that read `true` or
  // `false` depended on which group member the field locator happened to
  // resolve to — here, the member that the fill correctly checks.
  it("read-back of a Yes|No group reports the LABEL even when the locator resolves to the checked member", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const e = entry({
        field_id: AUTH,
        label: "Are you currently authorized to work in the United States?",
        type: "checkbox",
        value: "No",
        canonical_field: "work_authorization",
      });
      // The NO member — the one the fill checks.
      const meta = metaFor(AUTH, "question_16876429003[]_104418777003");
      const fill = await greenhouseFillFromPlan(page, [e], meta);
      expect(fill.errors).toEqual([]);
      const verify = await greenhouseVerifyFromPlan(page, [e], meta);
      // The observed value is the checked member's LABEL, never `true`.
      expect(verify.fields[0]?.observed).toMatchObject({ label: "No" });
      expect(verify.fields[0]?.observed).not.toBe(true);
      expect(verify.fields[0]?.match).toBe(true);
    });
  }, 45_000);

  it("'LinkedIn' as the how-did-you-hear answer checks the LinkedIn OPTION, and the LinkedIn Profile text stays a text fill", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const heard = entry({
        field_id: HEARD,
        label: "How did you hear about us?",
        type: "checkbox",
        value: "LinkedIn",
        canonical_field: "screener:custom:how_heard_source",
      });
      const li = entry({
        field_id: "question_16876426003",
        label: "LinkedIn Profile",
        type: "text",
        value: "https://www.linkedin.com/in/ada",
        canonical_field: "linkedin_url",
      });
      const meta = new Map<string, FieldMeta>([
        [HEARD, { type: "checkbox", inputId: "question_16876435003[]_104418785003", name: HEARD }],
        ["question_16876426003", { type: "text", inputId: "question_16876426003" }],
      ]);
      const fill = await greenhouseFillFromPlan(page, [heard, li], meta);
      expect(fill.errors).toEqual([]);
      expect(await page.locator('[id="question_16876435003[]_104418791003"]').isChecked()).toBe(true);
      expect(await page.locator('[id="question_16876435003[]_104418785003"]').isChecked()).toBe(false);
      expect(await page.locator('[id="question_16876426003"]').inputValue()).toBe(
        "https://www.linkedin.com/in/ada",
      );
      const verify = await greenhouseVerifyFromPlan(page, [heard, li], meta);
      expect(verify.fields.every((f) => f.match)).toBe(true);
    });
  }, 45_000);

  it("an answer that matches no member refuses by name and checks nothing", async () => {
    await withFixtureHtmlPage(HTML, async (page) => {
      const heard = entry({
        field_id: HEARD,
        label: "How did you hear about us?",
        type: "checkbox",
        value: "Online Job Board",
        canonical_field: "screener:custom:how_heard_source",
      });
      const meta = metaFor(HEARD, "question_16876435003[]_104418785003");
      const fill = await greenhouseFillFromPlan(page, [heard], meta);
      expect(fill.errors.join(" ")).toMatch(/no option matching "Online Job Board"/);
      expect(await page.locator('fieldset[id="question_16876435003[]"] input:checked').count()).toBe(0);
    });
  }, 45_000);
});
