import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ashbyDiscoverFields } from "../../src/ats/ashby/discovery.js";
import { mapDiscoveredFields } from "../../src/applications/fieldNormalization.js";
import { buildFillPlan } from "../../src/applications/resolveAnswers.js";
import { parsePublicProfile } from "../../src/candidate/publicProfile.js";
import {
  educationBlockLocator,
  isEducationBlockField,
} from "../../src/ats/shared/educationBlock.js";

vi.mock("../../src/candidate/sensitiveProfileIO.js", () => ({
  tryLoadSensitiveProfile: () => null,
  getSensitiveValue: () => undefined,
  loadSensitiveProfile: () => {
    throw new Error("loadSensitiveProfile not available in this test");
  },
}));

/**
 * #271-#273, live ashby 2026-09-12: two applications (Commure 80e6a0fc and
 * 04394211) parked AMBIGUOUS_FIELD on the SAME block in one evening. The
 * fixture is the real rendered DOM of Ashby's education block.
 */
const HTML = fs.readFileSync(
  path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "ats",
    "ashby",
    "education-block.commure.html",
  ),
  "utf8",
);

const BASE = "_systemfield_education_history";

/** Aliases the operator's real file also carries for these three facts. */
const ALIASES: Record<string, string[]> = {
  school: ["School"],
  degree: ["Degree"],
  major: ["Field of Study"],
};

const PROFILE = parsePublicProfile({
  legal_name: { first: "Ada", last: "Lovelace" },
  email: "ada@example.com",
  school: "Johns Hopkins University",
  degree: "Bachelor of Science",
  major: "Applied Mathematics and Statistics",
  start_month: "August",
  start_year: 2025,
  graduation_month: "May",
  graduation_year: 2029,
});

function planFor(html = HTML) {
  const fields = ashbyDiscoverFields(html);
  return { fields, plan: buildFillPlan(mapDiscoveredFields(fields, ALIASES), PROFILE) };
}

describe("ashby education block — discovery (#271/#272)", () => {
  it("drops the group-path twins that named the whole block", () => {
    const { fields } = planFor();
    // The wrapper path itself resolved to the SCHOOL combobox and carried
    // the group label "Education History"; the index-suffixed siblings
    // (#17..#20 live) were the four id-less month/year selects. Both shapes
    // fed the screener bank / LLM predict and neither could be filled.
    const ids = fields.map((f) => f.id);
    expect(ids).not.toContain(BASE);
    expect(ids.filter((id) => id.startsWith(`${BASE}#`))).toEqual([]);
    expect(fields.filter((f) => f.label === "Education History")).toEqual([]);
  });

  it("rebuilds the four date controls as one field per select", () => {
    const { fields } = planFor();
    const byId = new Map(fields.map((f) => [f.id, f]));
    for (const part of ["startDate", "endDate"] as const) {
      const month = byId.get(`${BASE}-${part}-month`);
      const year = byId.get(`${BASE}-${part}-year`);
      expect(month, `${part} month`).toBeDefined();
      expect(year, `${part} year`).toBeDefined();
      expect(month?.type).toBe("select");
      expect(month?.options).toContain("May");
      expect(month?.options).toContain("August");
      // The "Month..." / "Year..." placeholders are not offers.
      expect(month?.options).not.toContain("Month...");
      expect(year?.options).not.toContain("Year...");
      // Live Commure: the year list stops at 2027 in BOTH pairs.
      expect(year?.options?.[0]).toBe("2027");
      expect(year?.options).not.toContain("2029");
      // Only School is required in this block.
      expect(month?.required).toBe(false);
      expect(year?.required).toBe(false);
    }
  });

  it("keeps School as the required autocomplete question", () => {
    const { fields } = planFor();
    const school = fields.find((f) => f.id === `${BASE}-school`);
    expect(school).toBeDefined();
    expect(school?.label).toBe("School");
    expect(school?.required).toBe(true);
  });
});

describe("ashby education block — canonical mapping (#272)", () => {
  it("maps each date select by its structural id, not the group label", () => {
    const { fields } = planFor();
    const mapped = mapDiscoveredFields(fields, ALIASES);
    const canonical = (id: string): string | null =>
      mapped.find((f) => f.id === id)?.canonical_field ?? null;
    expect(canonical(`${BASE}-startDate-month`)).toBe("start_month");
    expect(canonical(`${BASE}-startDate-year`)).toBe("start_year");
    expect(canonical(`${BASE}-endDate-month`)).toBe("graduation_month");
    expect(canonical(`${BASE}-endDate-year`)).toBe("graduation_year");
    expect(canonical(`${BASE}-school`)).toBe("school");
  });

  it("never lends an education canonical to a WORK-history date pair", () => {
    const mapped = mapDiscoveredFields(
      [
        {
          id: "_systemfield_work_history-startDate-month",
          label: "Start Date",
          type: "select",
          required: false,
          options: ["January", "May"],
        },
      ],
      {},
    );
    expect(mapped[0]?.canonical_field).not.toBe("start_month");
  });
});

describe("ashby education block — plan values (#273)", () => {
  it("fills the dates the page offers and skips the year it does not", () => {
    const { plan } = planFor();
    const entry = (id: string) => plan.entries.find((e) => e.field_id === id);

    expect(entry(`${BASE}-startDate-month`)).toMatchObject({
      action: "fill",
      value: "August",
    });
    expect(entry(`${BASE}-startDate-year`)).toMatchObject({
      action: "fill",
      value: "2025",
    });
    expect(entry(`${BASE}-endDate-month`)).toMatchObject({
      action: "fill",
      value: "May",
    });
    // graduation_year 2029 is NOT in the page's list (it stops at 2027). A
    // factual year is never traded for a nearby option — skipped, with the
    // real reason, and the page's own completeness scan decides the submit.
    const gradYear = entry(`${BASE}-endDate-year`);
    expect(gradYear?.action).toBe("skip_empty");
    expect(gradYear?.value).toBeNull();
    expect(gradYear?.reason).toMatch(/page does not offer "2029"/);
    expect(JSON.stringify(plan.entries)).not.toContain("2027");
  });

  it("does not compose 'May 2029' into a pure year select", () => {
    // Both year lists, so the END date pair is the one that changes too.
    const offersGraduationYear = HTML.replaceAll(
      '<option value="[SCRUBBED]">2027</option>',
      '<option value="[SCRUBBED]">2029</option>',
    );
    const { plan } = planFor(offersGraduationYear);
    expect(plan.entries.find((e) => e.field_id === `${BASE}-endDate-year`)).toMatchObject({
      action: "fill",
      value: "2029",
    });
  });

  it("leaves a COMPOSED seasonal graduation date to the combobox synonyms", () => {
    // The #273 skip must not claim this shape: a lone seasonal combobox gets
    // the composed "May 2029", which the fill's own option matching turns
    // into the page's "Spring 2029". Skipping it here would have silently
    // stopped answering every seasonal graduation-date question.
    const mapped = mapDiscoveredFields(
      [
        {
          id: "grad-season",
          label: "Expected graduation date",
          type: "select",
          required: true,
          options: ["Winter 2028", "Spring 2029", "Fall 2029"],
        },
      ],
      { graduation_year: ["Expected graduation date"] },
    );
    const plan = buildFillPlan(mapped, PROFILE);
    expect(plan.entries[0]).toMatchObject({
      action: "fill",
      value: "May 2029",
    });
  });

  it("no education control takes a screener-bank or predicted answer", () => {
    const { plan } = planFor();
    const educationEntries = plan.entries.filter((e) =>
      e.field_id.startsWith(BASE),
    );
    expect(educationEntries.length).toBeGreaterThan(0);
    for (const e of educationEntries) {
      expect(e.canonical_field ?? "").not.toMatch(/^screener:/);
    }
  });
});

describe("educationBlockLocator", () => {
  it("recognizes only the block's own sub-controls", () => {
    expect(isEducationBlockField(`${BASE}-school`)).toBe(true);
    expect(isEducationBlockField(`${BASE}-startDate-year`)).toBe(true);
    expect(isEducationBlockField(`${BASE}-degree`)).toBe(false);
    expect(isEducationBlockField("_systemfield_work_history-startDate-year")).toBe(
      false,
    );
  });

  it("anchors on the wrapper data-field-path and picks month vs year by index", () => {
    const calls: string[] = [];
    const node = {
      locator: (sel: string) => {
        calls.push(`locator:${sel}`);
        return node;
      },
      first: () => {
        calls.push("first");
        return node;
      },
      nth: (n: number) => {
        calls.push(`nth:${n}`);
        return node;
      },
    };
    const page = {
      locator: (sel: string) => {
        calls.push(`page:${sel}`);
        return node;
      },
    } as never;

    educationBlockLocator(page, `${BASE}-school`);
    expect(calls).toContain(`page:[data-field-path="${BASE}"]`);
    expect(calls).toContain(
      "locator:input.ashby-application-form-input-autocomplete",
    );

    calls.length = 0;
    educationBlockLocator(page, `${BASE}-endDate-year`);
    expect(calls).toContain(`locator:[id="${BASE}-endDate"]`);
    expect(calls).toContain("locator:select");
    expect(calls).toContain("nth:1");

    calls.length = 0;
    educationBlockLocator(page, `${BASE}-startDate-month`);
    expect(calls).toContain("nth:0");
  });

  it("returns null for a date CONTAINER id — not a control", () => {
    expect(educationBlockLocator({} as never, `${BASE}-startDate`)).toBeNull();
  });
});
