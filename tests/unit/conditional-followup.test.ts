import { describe, expect, it } from "vitest";
import { isConditionalYesFollowUp } from "../../src/applications/essayDetector.js";

/**
 * Night19 #48 (2026-08-30, DV Trading): "If yes, select your most recent
 * proprietary trading firm experience" follows "Do you have relevant
 * internship experience at a proprietary trading firm?" = No. The submit-path
 * re-plan predicted "N/A" for it and the combobox (Jane Street | Citadel …)
 * refused. The follow-up rule only knew "If you said/answered/selected yes".
 */
describe("conditional yes follow-ups (UNIT_CONFIRMED)", () => {
  it.each([
    "If yes, select your most recent proprietary trading firm experience",
    "If yes, please specify",
    "If Yes, which firm?",
    'If "yes", please list the countries',
    "If you answered yes, describe the circumstances",
    "If you selected Yes above, provide details",
  ])("%s is a follow-up", (label) => {
    expect(isConditionalYesFollowUp(label)).toBe(true);
  });

  it.each([
    "If you require sponsorship, when?",
    "Yes, I have read and agree to the privacy policy",
    "If applicable, list your certifications",
    "Ifyes",
  ])("%s is not", (label) => {
    expect(isConditionalYesFollowUp(label)).toBe(false);
  });
});
