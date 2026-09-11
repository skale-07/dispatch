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

  // #227 (operator directive 2026-09-09): "require work authorization" is
  // the SPONSORSHIP question (answer No); "are you authorized" is the
  // status question (answer Yes). They share vocabulary and invert.
  it("splits 'do you require work authorization' from 'are you authorized to work'", () => {
    const q = (label: string) => ({ id: "f1", label, type: "select" as const, required: true, name: "" });
    // The REQUIRE form -> sponsorship (profile answers "No").
    for (const label of [
      "Do you require work authorization?",
      "Will you now or in the future require work authorization?",
      "Do you require sponsorship for employment visa status?",
      "Will you require visa sponsorship now or in the future?",
      "Do you need employment authorization sponsorship?",
    ]) {
      expect(matchCanonicalField(q(label), {})).toBe("requires_sponsorship");
    }
    // The STATUS form -> work authorization (profile answers "Yes"),
    // including the phrasing that mentions sponsorship in passing.
    for (const label of [
      "Are you legally authorized to work in the United States?",
      "Are you authorized to work for any employer in the U.S.?",
      "Are you authorized to work in the US without requiring sponsorship?",
      "Are you eligible to work lawfully in the United States?",
    ]) {
      expect(matchCanonicalField(q(label), {})).toBe("work_authorization");
    }
  });

  // #226b (night30): with REAL alias lists the reverse-containment branch
  // let bare "Date" claim "Expected graduation date" (→ "2029" typed at a
  // signature date) and bare "Name" claim "First name". The #226 test above
  // used empty aliases and never saw it.
  it("bare Date / signature Name win over alias reverse-containment (#226b)", () => {
    const aliases = {
      graduation_year: ["Expected graduation date", "End date year"],
      "legal_name.first": ["First name"],
    };
    const f = (label: string, name = "") => ({ id: name || "f1", label, type: "text" as const, required: true, name });
    expect(matchCanonicalField(f("Date"), aliases)).toBe("signature_date");
    expect(matchCanonicalField(f("Expected graduation date"), aliases)).toBe("graduation_year");
    // A bare "Name" that is an ATS custom question is a signature line…
    expect(matchCanonicalField(f("Name", "cards[5f1c][field0]"), aliases)).toBe("signature_name");
    expect(matchCanonicalField(f("Name", "question_68482530"), aliases)).toBe("signature_name");
    // …the form's own primary name field keeps its mapping (Lever composes it).
    expect(matchCanonicalField(f("Name", "name"), aliases)).toBe("legal_name.first");
  });

  // #261 (live Palantir/Lever night30): the disability self-ID form's
  // signature controls appear once the disability answer is given, are
  // required, and were deferred as "demographics" (their names carry eeo /
  // disability) — the application could never submit.
  it("self-ID signature controls map by name and are not demographics (#261)", async () => {
    const { isDemographicsField } = await import("../../src/applications/essayDetector.js");
    const aliases = { "legal_name.first": ["First name", "Full name"] };
    const sig = { id: "s1", label: "Enter your full name", type: "text" as const, required: true, name: "eeo[disabilitySignature]" };
    const sigDate = { id: "s2", label: "MM/DD/YYYY", type: "text" as const, required: true, name: "eeo[disabilitySignatureDate]" };
    expect(matchCanonicalField(sig, aliases)).toBe("signature_name");
    expect(matchCanonicalField(sigDate, aliases)).toBe("signature_date");
    expect(isDemographicsField(sig)).toBe(false);
    expect(isDemographicsField(sigDate)).toBe(false);
    // The disability QUESTION itself stays demographic (sensitive profile only).
    expect(
      isDemographicsField({ id: "d", label: "Disability status", type: "select", required: false, name: "eeo[disability]" }),
    ).toBe(true);
  });

  // #255 (live Exegy/Ashby night30): the visa-expiry DATE question was
  // claimed by the alias "authorized to work" and fed the yes/no status.
  it("a question about WHEN an authorization expires is never the status or sponsorship field (#255)", () => {
    const aliases = { work_authorization: ["Authorized to work", "Work authorization"] };
    const f = (label: string, type: "text" | "date" = "text") => ({ id: "f1", label, type, required: false, name: "" });
    expect(
      matchCanonicalField(
        f("If you are currently authorized to work on a visa or other work permit, when does that work authorization expire?"),
        aliases,
      ),
    ).toBeNull();
    expect(matchCanonicalField(f("Work authorization expiration date"), aliases)).toBeNull();
    expect(matchCanonicalField(f("Work authorization", "date"), aliases)).toBeNull();
    // The plain status question through the same alias is unchanged.
    expect(matchCanonicalField(f("Work authorization"), aliases)).toBe("work_authorization");
  });

  // #226 (live Palantir 2026-09-09; operator: "it couldn't complete a
  // question that asked to plug in today's date").
  it("a bare signature-block Date/Signature maps; dated questions with their own meaning do not", async () => {
    const { todayUsDate } = await import("../../src/candidate/publicProfile.js");
    const text = (label: string) => ({ id: "f1", label, type: "text" as const, required: true, name: "" });
    expect(matchCanonicalField(text("Date"), {})).toBe("signature_date");
    expect(matchCanonicalField(text("Today's Date"), {})).toBe("signature_date");
    expect(matchCanonicalField(text("Date Signed"), {})).toBe("signature_date");
    expect(matchCanonicalField(text("Signature"), {})).toBe("signature_name");
    // Dates that mean something else keep their own mapping — and date of
    // birth is sensitive, never auto-filled from here.
    expect(matchCanonicalField(text("Graduation Date"), {})).not.toBe("signature_date");
    expect(matchCanonicalField(text("Start Date"), {})).not.toBe("signature_date");
    expect(matchCanonicalField(text("Date of Birth"), {})).not.toBe("signature_date");
    // The value is today, in the US format these blocks print beside them.
    expect(todayUsDate(new Date("2026-09-09T12:00:00"))).toBe("09/09/2026");
    expect(todayUsDate(new Date("2026-12-25T12:00:00"))).toBe("12/25/2026");
  });

  // #213 (live roblox 2026-09-09): EEO race question phrased as an adjective.
  it("racial/ethnic-background phrasing maps to race_ethnicity (sensitive-profile path)", () => {
    const q = (label: string) => ({ id: "q1", label, type: "select" as const, required: true, name: "" });
    expect(
      matchCanonicalField(q("How would you describe your racial/ethnic background? (mark all that apply)"), {}),
    ).toBe("race_ethnicity");
    expect(matchCanonicalField(q("Ethnicity"), {})).toBe("race_ethnicity");
    // Unrelated words that contain "race" stay unmapped.
    expect(matchCanonicalField(q("Trace ID"), {})).toBeNull();
  });

  // #204 (live cisco 2026-09-09, Phenom): the referrer's name/email is a
  // third-person question — an identity alias must never claim it.
  it("third-person / referred-by free-text fields never map to the candidate's identity", () => {
    const aliases: Record<string, string[]> = {
      email: ["Email", "Email address", "Email Address"],
      "legal_name.first": ["First name", "Name"],
      how_heard: ["How did you hear about us?", "Referral source"],
    };
    const text = (label: string, id = "f1", name = "") => ({
      id,
      label,
      type: "text" as const,
      required: false,
      name,
    });
    // Label says "their" — the referrer, not the applicant.
    expect(
      matchCanonicalField(text("What's their name or email address?", "referredBy"), aliases),
    ).toBeNull();
    // Machine name alone is the tell when the label is generic.
    expect(matchCanonicalField(text("Email address", "referrer_email"), aliases)).toBeNull();
    expect(matchCanonicalField(text("Name", "f9", "referredByName"), aliases)).toBeNull();
    expect(matchCanonicalField(text("Referred by", "f2"), aliases)).toBeNull();
    // The applicant's own fields still map.
    expect(matchCanonicalField(text("Email address", "email"), aliases)).toBe("email");
    // A SELECT "Referral source" is a how-did-you-hear question and keeps its alias.
    expect(
      matchCanonicalField(
        { id: "src", label: "Referral source", type: "select", required: false, name: "source" },
        aliases,
      ),
    ).toBe("how_heard");
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

// #231 (live Smartly.io greenhouse 2026-09-10): two REQUIRED self-ID
// questions in the board's own wording matched nothing, so the submit was
// withheld on "What gender do you identify as?*; Are you a person with a
// disability?*". Demographic canonicals fill ONLY from the operator's
// encrypted sensitive profile, so recognising the topic cannot invent an
// answer — an unmatched one is simply skipped.
describe("demographic self-ID questions map by topic, not by one board's phrasing", () => {
  const q = (label: string) => ({
    id: "f1",
    label,
    type: "select" as const,
    required: true,
    name: "",
  });

  it("maps gender / disability / veteran self-ID wording with no alias phrases", () => {
    for (const label of ["What gender do you identify as?*", "Gender", "Gender (select one)"]) {
      expect(matchCanonicalField(q(label), {})).toBe("gender");
    }
    // The longer phrase keeps its own canonical and its own stored value.
    for (const label of [
      "Gender identity (voluntary self-identification)",
      "Please select your gender identity",
    ]) {
      expect(matchCanonicalField(q(label), {})).toBe("gender_identity");
    }
    for (const label of [
      "Are you a person with a disability?*",
      "Disability Status",
      "Do you have a disability?",
      "Voluntary Self-Identification of Disability",
    ]) {
      expect(matchCanonicalField(q(label), {})).toBe("disability_status");
    }
    for (const label of [
      "Are you a protected veteran?*",
      "Veteran Status",
      "Have you served in the United States Armed Forces?",
    ]) {
      expect(matchCanonicalField(q(label), {})).toBe("veteran_status");
    }
  });

  // Live Crest Industries lever, same night: Lever's EEO block hands the
  // RACE control a label beginning "Gender Select ... Male Female Decline
  // to self-identify". Read as a label it is a gender question — the
  // control NAME is the fact, and every eeo[...] rule must decide first.
  it("a control NAMED eeo[race] stays race even when its label reads as gender", () => {
    expect(
      matchCanonicalField(
        {
          id: "eeo[race]",
          label: "Gender Select ... Male Female Decline to self-identify",
          type: "select",
          required: true,
          name: "eeo[race]",
        },
        {},
      ),
    ).toBe("race_ethnicity");
    expect(
      matchCanonicalField(
        { id: "eeo[veteran]", label: "Gender", type: "select", required: true, name: "eeo[veteran]" },
        {},
      ),
    ).toBe("veteran_status");
  });

  it("keeps pronouns and race on their own canonicals", () => {
    expect(matchCanonicalField(q("What are your preferred pronouns?"), {})).toBe("pronouns");
    expect(matchCanonicalField(q("How would you describe your racial/ethnic background?"), {})).toBe(
      "race_ethnicity",
    );
  });
});

// #265 (live Palantir night30): a high-school / year question borrowed the
// university from the "School" alias and landed on the form's "Other".
describe("school never answers a high-school or year question (#265)", () => {
  it("keeps plain school labels, drops high-school and year labels", () => {
    const aliases = { school: ["School", "University"] };
    const f = (label: string, type: "text" | "select" = "select") => ({ id: "f1", label, type, required: true, name: "" });
    expect(matchCanonicalField(f("School"), aliases)).toBe("school");
    expect(matchCanonicalField(f("University"), aliases)).toBe("school");
    expect(matchCanonicalField(f("Year of High School Graduation"), aliases)).toBeNull();
    expect(matchCanonicalField(f("High School Name", "text"), aliases)).toBeNull();
    expect(matchCanonicalField(f("School graduation date"), aliases)).toBeNull();
  });
});
