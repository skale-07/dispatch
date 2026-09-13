import { describe, expect, it, vi } from "vitest";
import {
  INLINE_PROFILE_COLUMNS,
  applySuggestionAnswer,
  suggestionAction,
  suggestionTitle,
} from "../../frontend/src/public/dashboard/applySuggestion.js";
import { EMPTY_PROFILE } from "../../frontend/src/public/contract.js";

/**
 * How a suggestion card is answered (plan M11): which targets get an
 * inline mini-form, which deep-link to their onboarding step, and where
 * an inline answer is written. Self-identification is never inline.
 * UNIT_CONFIRMED.
 */

describe("suggestion actions (UNIT_CONFIRMED)", () => {
  it("plain profile text columns are inline; every inline column is a real draft field", () => {
    for (const col of INLINE_PROFILE_COLUMNS) {
      expect(col in EMPTY_PROFILE, col).toBe(true);
      expect(suggestionAction({ store: "profile", key: col })).toEqual({ mode: "inline", kind: "text" });
    }
  });

  it("profile facts with rules go to their step, never inline", () => {
    expect(suggestionAction({ store: "profile", key: "work_authorization" })).toMatchObject({ mode: "navigate", to: "/onboarding/eligibility" });
    expect(suggestionAction({ store: "profile", key: "needs_sponsorship" })).toMatchObject({ mode: "navigate", to: "/onboarding/eligibility" });
    expect(suggestionAction({ store: "profile", key: "restrictive_covenants" })).toMatchObject({ mode: "navigate", to: "/onboarding/eligibility" });
    expect(suggestionAction({ store: "profile", key: "job_preferences.willing_to_relocate" })).toMatchObject({ mode: "navigate", to: "/onboarding/preferences" });
    expect(suggestionAction({ store: "profile", key: "no_such_column" })).toMatchObject({ mode: "unsupported" });
  });

  it("screeners: yes/no registry keys are boolean, others text with the registry's suggestions; custom keys are text", () => {
    expect(suggestionAction({ store: "screener", key: "age_over_18" })).toEqual({ mode: "inline", kind: "boolean" });
    expect(suggestionAction({ store: "screener", key: "internship_term" })).toMatchObject({ mode: "inline", kind: "text", suggestions: expect.arrayContaining(["Summer 2027"]) });
    expect(suggestionAction({ store: "screener", key: "q_0123456789ab", kind: "text", labels: ["Which languages?"] })).toEqual({ mode: "inline", kind: "text" });
    expect(suggestionTitle({ store: "screener", key: "hours_per_week" })).toBe("Hours per week you can commit");
    expect(suggestionTitle({ store: "screener", key: "q_0123456789ab", labels: ["Which languages?"] })).toBe("Which languages?");
  });

  it("structured stores deep-link to their step; self-ID is never answered inline", () => {
    expect(suggestionAction({ store: "education", key: "gpa" })).toMatchObject({ mode: "navigate", to: "/onboarding/education" });
    expect(suggestionAction({ store: "employment", key: "company" })).toMatchObject({ mode: "navigate", to: "/onboarding/experience" });
    expect(suggestionAction({ store: "documents", key: "transcript" })).toMatchObject({ mode: "navigate", to: "/onboarding/documents", label: "upload a transcript" });
    expect(suggestionAction({ store: "documents", key: "resume", variant: "ds_ai" })).toMatchObject({ label: "add a ds_ai resume" });
    expect(suggestionAction({ store: "integrations", key: "gmail" })).toMatchObject({ mode: "navigate", to: "/onboarding/integrations" });
    expect(suggestionAction({ store: "self_id" })).toMatchObject({ mode: "navigate", to: "/onboarding/self-id" });
  });

  it("writes an inline answer to the right store, verbatim; blank writes nothing", async () => {
    const saveProfile = vi.fn(async () => undefined);
    const saveScreener = vi.fn(async () => undefined);
    const savers = { saveProfile, saveScreener };

    expect(await applySuggestionAnswer({ store: "profile", key: "contact_email" }, "  Maya@Pitt.EDU ", savers)).toBe(true);
    expect(saveProfile).toHaveBeenCalledWith({ contact_email: "maya@pitt.edu" });

    expect(await applySuggestionAnswer({ store: "screener", key: "age_over_18" }, "Yes", savers)).toBe(true);
    expect(saveScreener).toHaveBeenLastCalledWith([{ key: "age_over_18", kind: "registry", answer: "Yes", source: "suggestion" }]);

    expect(
      await applySuggestionAnswer({ store: "screener", key: "q_0123456789ab", labels: ["Which languages have you shipped?"] }, "TypeScript, Python", savers),
    ).toBe(true);
    expect(saveScreener).toHaveBeenLastCalledWith([
      { key: "q_0123456789ab", kind: "custom", answer: "TypeScript, Python", labels: ["Which languages have you shipped?"], source: "suggestion" },
    ]);

    expect(await applySuggestionAnswer({ store: "profile", key: "phone" }, "   ", savers)).toBe(false);
    expect(saveProfile).toHaveBeenCalledTimes(1);

    await expect(applySuggestionAnswer({ store: "self_id" }, "x", savers)).rejects.toThrow(/not answered inline/);
    await expect(applySuggestionAnswer({ store: "profile", key: "work_authorization" }, "us_citizen", savers)).rejects.toThrow(/not answered inline/);
  });
});
