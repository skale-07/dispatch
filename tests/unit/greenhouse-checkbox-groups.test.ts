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

describe("greenhouse checkbox groups — fill + verify (FIXTURE_CONFIRMED)", () => {
  useIsolatedFillEnv("fixture_fill");

  const metaFor = (fieldId: string, inputId: string): Map<string, FieldMeta> =>
    new Map([[fieldId, { type: "checkbox", inputId, name: fieldId }]]);

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
