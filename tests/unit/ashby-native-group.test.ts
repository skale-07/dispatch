import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ashbyDiscoverFields } from "../../src/ats/ashby/discovery.js";
import {
  fillNativeGroup,
  locateNativeGroup,
  readNativeGroupOptions,
  readNativeGroupValue,
} from "../../src/ats/ashby/nativeGroupFill.js";
import { withFixtureHtmlPage } from "../../src/browser/fixtureSession.js";
import { isDemographicsField } from "../../src/applications/essayDetector.js";

/**
 * #116/#117 (live sierra 2026-09-01): Ashby renders choice questions as
 * NATIVE input[type=radio]/[type=checkbox] fieldsets addressed only by
 * their wrapper's data-field-path, and autocomplete questions as an
 * id-less/name-less input whose question caption points at that same
 * uuid. Fixture captured from the live DOM.
 */

const fixtureHtml = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "ashby-native-groups",
    "dom.sanitized.html",
  ),
  "utf8",
);

const RADIO_FIELD = "267e8226-bb2f-4e41-91ac-f3900f3018fb";
const CHECKBOX_FIELD = "a63b6f87-d090-40f0-a462-bf5bb03f5e45";
const AUTOCOMPLETE_FIELD = "80177901-416f-48ee-9fea-1d3684620c8c";

describe("Ashby native fieldset groups (#116)", () => {
  it("locates radio and checkbox groups by data-field-path, not a 1-checkbox consent (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const radio = await locateNativeGroup(page, RADIO_FIELD);
      expect(radio?.kind).toBe("radio");
      expect(radio?.optionCount).toBe(3);
      const checkbox = await locateNativeGroup(page, CHECKBOX_FIELD);
      expect(checkbox?.kind).toBe("checkbox");
      expect(checkbox?.optionCount).toBe(3);
      // The autocomplete wrapper holds no boxes — not a native group.
      expect(await locateNativeGroup(page, AUTOCOMPLETE_FIELD)).toBeNull();
      expect(await locateNativeGroup(page, "_systemfield_name")).toBeNull();
      expect(await locateNativeGroup(page, "nope-nope")).toBeNull();
    });
  });

  it("reads option labels from label[for] and name fallback (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const probe = await locateNativeGroup(page, RADIO_FIELD);
      const options = await readNativeGroupOptions(probe!.group);
      expect(options.map((o) => o.label)).toEqual([
        "San Francisco office",
        "New York office",
        "No preference",
      ]);
      expect(options.every((o) => !o.checked)).toBe(true);
    });
  });

  it("fills a radio group by option label and confirms by read-back (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const probe = await locateNativeGroup(page, RADIO_FIELD);
      const result = await fillNativeGroup(page, probe!.group, "No preference");
      expect(result.committed).toBe(true);
      expect(result.selectedLabel).toBe("No preference");
      expect(await readNativeGroupValue(probe!.group)).toBe("No preference");
    });
  });

  it("bridges synonyms: Heterosexual → 'Heterosexual / straight' checkbox (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const probe = await locateNativeGroup(page, CHECKBOX_FIELD);
      const result = await fillNativeGroup(page, probe!.group, "Heterosexual");
      expect(result.committed).toBe(true);
      expect(result.selectedLabel).toBe("Heterosexual / straight");
      expect(await readNativeGroupValue(probe!.group)).toBe(
        "Heterosexual / straight",
      );
    });
  });

  it("refuses without residue when no option matches (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const probe = await locateNativeGroup(page, RADIO_FIELD);
      const result = await fillNativeGroup(
        page,
        probe!.group,
        "Chicago office",
      );
      expect(result.committed).toBe(false);
      expect(result.selectedLabel).toBeNull();
      expect(await readNativeGroupValue(probe!.group)).toBeNull();
    });
  });
});

describe("Ashby autocomplete caption discovery (#117)", () => {
  it("labels the autocomplete by its question title, not the placeholder (UNIT_CONFIRMED)", () => {
    const fields = ashbyDiscoverFields(fixtureHtml);
    const auto = fields.find((f) => f.id === AUTOCOMPLETE_FIELD);
    expect(auto).toBeDefined();
    expect(auto?.label).toBe("What University do you currently attend?");
    expect(auto?.type).toBe("text");
    expect(auto?.required).toBe(true);
    // The placeholder-labeled synthetic twin is suppressed.
    expect(
      fields.find((f) => /^start typing/i.test(f.label)),
    ).toBeUndefined();
  });

  it("does not swallow a real field whose label is also a group OPTION text (#119, UNIT_CONFIRMED)", () => {
    const fields = ashbyDiscoverFields(fixtureHtml);
    // "LinkedIn" is an option of "How did you hear…" AND a URL question.
    const linkedin = fields.find(
      (f) => f.label === "LinkedIn" && f.type === "text",
    );
    expect(linkedin).toBeDefined();
    expect(linkedin?.id).toBe("a41eb23d-a977-4c96-b557-c7d89dfc38d4");
    const howHeard = fields.find(
      (f) => f.label === "How did you hear about this opportunity?",
    );
    expect(howHeard?.options).toEqual(["LinkedIn", "Search engine"]);
    // The member radios themselves stay suppressed.
    expect(
      fields.filter((f) => /-labeled-radio-\d+$/.test(f.id)),
    ).toEqual([]);
  });

  it("still emits one select field per fieldset group (UNIT_CONFIRMED)", () => {
    const fields = ashbyDiscoverFields(fixtureHtml);
    const office = fields.find((f) => f.id === RADIO_FIELD);
    expect(office?.type).toBe("select");
    expect(office?.options).toEqual([
      "San Francisco office",
      "New York office",
      "No preference",
    ]);
  });
});

describe("Ashby yes/no button pairs (#132)", () => {
  const YESNO_FIELD = "ea7319ab-ea6d-431e-a182-3907d9970c17";

  it("discovers the pair by its question title, suppresses the plumbing checkbox (UNIT_CONFIRMED)", () => {
    const fields = ashbyDiscoverFields(fixtureHtml);
    const q = fields.find((f) => f.id === YESNO_FIELD);
    expect(q?.label).toBe(
      "Are you authorized to work for any employer in the United States of America?",
    );
    expect(q?.type).toBe("select");
    expect(q?.options).toEqual(["Yes", "No"]);
    expect(q?.required).toBe(true);
    // The hidden checkbox twin (uuid-labeled) is suppressed.
    expect(
      fields.filter((f) => f.id === YESNO_FIELD || f.name === YESNO_FIELD),
    ).toHaveLength(1);
  });

  it("locates, fills Yes via the aria-pressed button, and reads back (FIXTURE_CONFIRMED)", async () => {
    await withFixtureHtmlPage(fixtureHtml, async (page) => {
      const probe = await locateNativeGroup(page, YESNO_FIELD);
      expect(probe?.kind).toBe("yesno");
      const result = await fillNativeGroup(page, probe!.group, "Yes", probe!.kind);
      expect(result.committed).toBe(true);
      expect(result.selectedLabel).toBe("Yes");
      expect(await readNativeGroupValue(probe!.group, probe!.kind)).toBe("Yes");
    });
  });
});

describe("demographics classifier pronoun boundary (#118)", () => {
  const field = (label: string) => ({
    id: "x",
    label,
    type: "text" as const,
    required: false,
  });
  it("a phonetic name-pronunciation screener is NOT demographics (UNIT_CONFIRMED)", () => {
    // Sierra live 2026-09-01 spells it "pronounciation" — contains "pronoun".
    expect(isDemographicsField(field("Name pronounciation"))).toBe(false);
    expect(isDemographicsField(field("Name pronunciation"))).toBe(false);
  });
  it("real pronoun questions still classify as demographics (UNIT_CONFIRMED)", () => {
    expect(isDemographicsField(field("What pronouns do you use?"))).toBe(true);
    expect(isDemographicsField(field("Pronouns"))).toBe(true);
    expect(isDemographicsField(field("Preferred pronoun"))).toBe(true);
  });
  it("#144 a camelCase disability NAME with a boilerplate label is demographics (UNIT_CONFIRMED)", () => {
    // UKG live 2026-09-01: the ADA self-ID radio group is named
    // AreYouDisabled while its visible label is generic — it must be
    // fenced onto the sensitive-profile path, never the predict tier.
    expect(
      isDemographicsField({
        id: "x",
        label: "Please choose one of the options below",
        name: "AreYouDisabled",
        type: "radio" as const,
        required: true,
      } as never),
    ).toBe(true);
    expect(
      isDemographicsField({
        id: "x",
        label: "Do you consider yourself disabled?",
        type: "radio" as const,
        required: false,
      } as never),
    ).toBe(true);
  });
});
