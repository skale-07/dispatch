import { describe, expect, it } from "vitest";
import { matchCanonicalField } from "../../src/applications/fieldNormalization.js";

describe("matchCanonicalField name/id fallbacks", () => {
  it("maps Lever location-input and org without relying on alias phrase alone", () => {
    expect(
      matchCanonicalField(
        { id: "location-input", label: "location", type: "text", required: false, name: "location" },
        {},
      ),
    ).toBe("address.city");
    expect(
      matchCanonicalField(
        { id: "org", label: "org", type: "text", required: false, name: "org" },
        {},
      ),
    ).toBe("current_company");
  });

  // Live 2026-08-29 (Stripe 420e19f5): bare "University"/"Degree" aliases
  // hijacked verbose screener questions, and the fill typed profile values
  // into an internship-length dropdown. Single-word aliases claim labels,
  // not sentences; multi-word phrases still match inside long questions.
  it("short aliases do not claim long screener questions; phrase aliases still do", () => {
    const aliases = {
      school: ["School", "University", "School name"],
      degree: ["Degree", "Degree type"],
      requires_sponsorship: [
        "Will you now or in the future require sponsorship?",
        "require sponsorship",
        "visa sponsorship",
      ],
    };
    const field = (label: string) => ({
      id: "f1",
      label,
      type: "select" as const,
      required: true,
      name: "",
    });
    expect(
      matchCanonicalField(
        field(
          "Please indicate what length of internship you are interested in. Please note, 6 month internship requests will only be considered if it is a requirement from your University for academic credit purposes.",
        ),
        aliases,
      ),
    ).toBeNull();
    expect(
      matchCanonicalField(
        field(
          "Are you currently enrolled in a degree programme, or did you complete a degree within the last 12 months?",
        ),
        aliases,
      ),
    ).toBeNull();
    // Multi-word intent phrases keep matching inside long questions.
    expect(
      matchCanonicalField(
        field(
          "Will you now or at any time in the future require sponsorship for employment visa status (e.g. H1B, OPT)?",
        ),
        aliases,
      ),
    ).toBe("requires_sponsorship");
    // Short labels keep their noun aliases.
    expect(matchCanonicalField(field("University name"), aliases)).toBe("school");
    expect(matchCanonicalField(field("Degree type"), aliases)).toBe("degree");
  });

  // Live tiaa.wd1 2026-08-30 (#22g): Workday's "I have a preferred name"
  // is a reveal TOGGLE checkbox; preferred_name mapped onto it and the
  // fill tried to "check" the profile's name into it. Checkbox-typed
  // preferred-name labels never map; the revealed TEXT field still does.
  it("'I have a preferred name' checkbox is a toggle, not the preferred-name field", () => {
    const aliases = { preferred_name: ["Preferred Name", "preferred name"] };
    expect(
      matchCanonicalField(
        {
          id: "name--preferredCheck",
          label: "I have a preferred name",
          type: "checkbox",
          required: false,
          name: "preferredCheck",
        },
        aliases,
      ),
    ).toBeNull();
    expect(
      matchCanonicalField(
        { id: "pn", label: "Preferred Name", type: "text", required: false, name: "" },
        aliases,
      ),
    ).toBe("preferred_name");
  });

  it("maps eeo[race]/eeo[veteran] ids to sensitive canonicals", () => {
    expect(
      matchCanonicalField(
        { id: "eeo[race]", label: "eeo[race]", type: "select", required: false, name: "eeo[race]" },
        {},
      ),
    ).toBe("race_ethnicity");
    expect(
      matchCanonicalField(
        { id: "eeo[veteran]", label: "eeo[veteran]", type: "select", required: false, name: "eeo[veteran]" },
        {},
      ),
    ).toBe("veteran_status");
  });
});

describe("#70 phone never claims option controls (live tiaa #22s)", () => {
  // "Phone Device Type" (a SELECT) mapped canonical `phone` via the label
  // substring AND the name hint — the plan then tried to pick the phone
  // NUMBER from [Mobile|Fax|Landline], and the wrong-target writes
  // re-rendered the section, wiping the real number.
  const aliases = { phone: ["Phone", "Phone Number", "Mobile Number"] };
  it("select/radio/checkbox controls never map phone; text controls still do", () => {
    expect(
      matchCanonicalField(
        { id: "phoneNumber--phoneType", label: "Phone Device Type", type: "select", required: true, name: "phoneType" },
        aliases,
      ),
    ).toBeNull();
    expect(
      matchCanonicalField(
        { id: "x", label: "Phone", type: "radio", required: false },
        aliases,
      ),
    ).toBeNull();
    expect(
      matchCanonicalField(
        { id: "phoneNumber--phoneNumber", label: "Phone Number", type: "text", required: true, name: "phoneNumber" },
        aliases,
      ),
    ).toBe("phone");
    // The name-hint fallback is fenced too.
    expect(
      matchCanonicalField(
        { id: "y", label: "Device kind", type: "select", required: false, name: "phoneType" },
        aliases,
      ),
    ).toBeNull();
  });
});

describe("#73 skills label mapping", () => {
  it("tight Skills labels map; sentences mentioning skills do not", () => {
    expect(
      matchCanonicalField({ id: "sk", label: "Skills", type: "select", required: false }, {}),
    ).toBe("skills");
    expect(
      matchCanonicalField({ id: "sk2", label: "Technical Skills", type: "select", required: false }, {}),
    ).toBe("skills");
    expect(
      matchCanonicalField(
        { id: "q", label: "Describe the skills you would bring to this role", type: "textarea", required: false },
        {},
      ),
    ).toBeNull();
  });
});
