import { describe, expect, it } from "vitest";
import { matchCanonicalField } from "../../src/applications/fieldNormalization.js";
import { getSensitiveValue } from "../../src/candidate/sensitiveProfileIO.js";
import { parseSensitiveProfile } from "../../src/candidate/sensitiveProfile.js";
import { SENSITIVE_FILL_CANONICALS } from "../../src/applications/approvedFillPlan.js";

/**
 * Night19 (2026-08-30, DV Trading): a REQUIRED "What are your preferred
 * pronouns?" combobox had no canonical, so the demographic path had nothing
 * to look up and the click was blocked. Pronouns are operator-supplied only
 * (sensitive profile) — never predicted, never defaulted. UNIT_CONFIRMED.
 */
describe("phone extension is never the phone number (night19 #54)", () => {
  it.each(["Phone Extension", "Phone Ext.", "Telephone extension", "Ext"])("%s → unmapped", (label) => {
    expect(matchCanonicalField({ id: "q", label, type: "text", required: false }, { phone: ["Phone", "Phone Number"] })).toBeNull();
  });
  it("plain phone labels still map", () => {
    expect(matchCanonicalField({ id: "q", label: "Phone Number", type: "text", required: false }, { phone: ["Phone", "Phone Number"] })).toBe("phone");
  });
});

describe("pronouns as a sensitive-profile canonical", () => {
  it.each([
    "What are your preferred pronouns?",
    "Pronouns",
    "Preferred Pronouns (optional)",
    "What pronouns do you use?",
  ])("%s → pronouns", (label) => {
    expect(matchCanonicalField({ id: "q", label, type: "text", required: true }, {})).toBe("pronouns");
  });

  it("is in the sensitive allowlist and resolves only from the profile (empty ⇒ empty, never invented)", () => {
    expect(SENSITIVE_FILL_CANONICALS.has("pronouns")).toBe(true);
    expect(getSensitiveValue(parseSensitiveProfile({}), "pronouns")).toBe("");
    expect(getSensitiveValue(parseSensitiveProfile({ pronouns: "They/Them" }), "pronouns")).toBe("They/Them");
  });
});
