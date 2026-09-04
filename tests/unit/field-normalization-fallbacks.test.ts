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

  // Live stripe 0a2dbfa6 (2026-08-31, #110): "Third location preference"
  // is an office CHOICE, not the candidate's city — bare "Location"
  // claimed it and the fill typed Baltimore at a dynamic-option widget.
  // Identity facts never answer preference/ranking questions; short labels
  // keep matching.
  it("single-word aliases never claim preference/ranking questions (#110)", () => {
    const aliases = { "address.city": ["City", "Location", "Current location"] };
    const field = (label: string) => ({
      id: "q1",
      label,
      type: "select" as const,
      required: true,
      name: "",
    });
    expect(matchCanonicalField(field("Third location preference"), aliases)).toBeNull();
    expect(matchCanonicalField(field("First location preference"), aliases)).toBeNull();
    expect(matchCanonicalField(field("Location ranking"), aliases)).toBeNull();
    // Plain labels still map.
    expect(matchCanonicalField(field("Location"), aliases)).toBe("address.city");
    expect(matchCanonicalField(field("Current location"), aliases)).toBe("address.city");
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

// Live UKG Pro run 16 (2026-09-01): "Secondary Phone" took the primary
// number, "Address 2" took the street (bare "Address" alias), and the
// Hispanic/Latino select ("Ethnic Origin", id HispanicOrigin) stayed
// unmapped. Twins of a contact fact are different data; line 2 is line 2;
// the hispanic id is the deterministic tell.
describe("#148 contact twins, address line 2, hispanic id hint", () => {
  const aliases = {
    phone: ["Phone", "Phone Number", "Primary Phone"],
    email: ["Email", "Email Address"],
    "address.line1": ["Address", "Street address", "Address line 1"],
    "address.line2": ["Address line 2", "Apt"],
  };
  const text = (id: string, label: string) => ({
    id,
    label,
    type: "text" as const,
    required: false,
    name: id,
  });
  it("secondary/alternate contact twins stay unmapped; primaries still map", () => {
    expect(matchCanonicalField(text("Phone", "Primary Phone"), aliases)).toBe("phone");
    expect(matchCanonicalField(text("SecondaryPhone", "Secondary Phone"), aliases)).toBeNull();
    expect(matchCanonicalField(text("AltEmail", "Alternate Email Address"), aliases)).toBeNull();
    expect(matchCanonicalField(text("Email", "Email Address"), aliases)).toBe("email");
  });
  it("Address 2 is address.line2, Address 1 stays line1", () => {
    expect(matchCanonicalField(text("AddressLine1", "Address 1"), aliases)).toBe("address.line1");
    expect(matchCanonicalField(text("AddressLine2", "Address 2"), aliases)).toBe("address.line2");
    expect(matchCanonicalField(text("a2", "Street Address Line 2"), aliases)).toBe("address.line2");
  });
  it("a HispanicOrigin id/name maps the 'Ethnic Origin' select to hispanic_latino", () => {
    expect(
      matchCanonicalField(
        { id: "HispanicOrigin", label: "Ethnic Origin", type: "select", required: true, name: "" },
        aliases,
      ),
    ).toBe("hispanic_latino");
    // A race select keeps its own canonical.
    expect(
      matchCanonicalField(
        { id: "EthnicOrigin", label: "Race", type: "select", required: true, name: "" },
        aliases,
      ),
    ).toBe("race_ethnicity");
  });
});

describe("#85c gpa never claims option controls", () => {
  it("a Yes/No select asking about GPA threshold is not canonical gpa; text GPA fields still map", () => {
    const aliases = { gpa: ["GPA", "cumulative GPA"] };
    expect(
      matchCanonicalField(
        { id: "q", label: "Is your current cumulative GPA 3.0 or above?", type: "select", required: true },
        aliases,
      ),
    ).toBeNull();
    expect(
      matchCanonicalField(
        { id: "g", label: "What is your cumulative GPA?", type: "text", required: true },
        aliases,
      ),
    ).toBe("gpa");
  });
});

// Live Five Rings greenhouse 2026-09-03 (application 8399a8f4): the board's
// own question_17808225008 — "Please specify the grading scale used by your
// current school." with FOUR options — matched the alias "Current school"
// (multi-word and >=12 chars, so the short-alias guard let it through by
// plain containment) and the plan carried "Johns Hopkins University" into a
// grading-scale list. The form's own School control is where that fact goes.
describe("#164 a history fact never answers the ATS's own custom question", () => {
  const aliases = {
    school: ["School", "University", "College", "Current school", "School name"],
    degree: ["Degree", "Degree type"],
    major: ["Discipline", "Major", "Field of study"],
    current_company: ["Current company", "Employer"],
    linkedin_url: ["LinkedIn", "LinkedIn Profile"],
  };

  it("greenhouse question_N asking ABOUT school does not claim canonical school", () => {
    expect(
      matchCanonicalField(
        {
          id: "q17808225008",
          label: "Please specify the grading scale used by your current school.",
          type: "select",
          required: true,
          name: "question_17808225008",
        },
        aliases,
      ),
    ).toBeNull();
  });

  it("the education section's own School / Degree / Discipline controls still map", () => {
    expect(
      matchCanonicalField(
        { id: "school--0", label: "School", type: "select", required: true, name: "school--0" },
        aliases,
      ),
    ).toBe("school");
    expect(
      matchCanonicalField(
        { id: "degree--0", label: "Degree", type: "select", required: true, name: "degree--0" },
        aliases,
      ),
    ).toBe("degree");
    expect(
      matchCanonicalField(
        { id: "discipline--0", label: "Discipline", type: "select", required: true, name: "discipline--0" },
        aliases,
      ),
    ).toBe("major");
  });

  it("the answers_attributes shape is caught too, and non-history canonicals are untouched", () => {
    expect(
      matchCanonicalField(
        {
          id: "a3",
          label: "Which employer did you most recently work for?",
          type: "text",
          required: false,
          name: "job_application_answers_attributes_3_text_value",
        },
        aliases,
      ),
    ).toBeNull();
    // linkedin_url is not a singular history fact — boards routinely ask
    // for it as a custom question and that mapping must survive.
    expect(
      matchCanonicalField(
        {
          id: "q99",
          label: "LinkedIn Profile",
          type: "text",
          required: false,
          name: "question_17808299008",
        },
        aliases,
      ),
    ).toBe("linkedin_url");
  });
});
