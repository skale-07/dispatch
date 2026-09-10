import { describe, expect, it } from "vitest";
import {
  isAdvisoryReviewItem,
  isCompletenessUnansweredReview,
  isTriageParkReview,
} from "../../src/queue/reviewItems.js";

/**
 * #241 (night29). The automation picker and the pipeline disagreed about
 * what an open review item MEANS, so 5 of 20 QUEUED applications — every
 * one requeued to prove a fix — were unreachable: the pipeline would have
 * continued them, the picker never handed them over. And the LLM triage's
 * own park outlived `retry --app`, which is the decision it was waiting
 * for, so a requeued application could never be picked again.
 */
describe("which review items actually block an application (#241)", () => {
  const manual = (title: string) => ({ kind: "MANUAL" as const, title });

  it("advisory items want an answer, not a full stop", () => {
    expect(isAdvisoryReviewItem(manual('Answer needed: "Undergrad Discipline(s)"'))).toBe(true);
    expect(isAdvisoryReviewItem(manual("New question learned: salary band"))).toBe(true);
    expect(
      isAdvisoryReviewItem(
        manual("2 required question(s) unanswered — answer via screeners.json, then requeue"),
      ),
    ).toBe(true);
    expect(
      isCompletenessUnansweredReview(
        manual("2 required question(s) unanswered — answer via screeners.json, then requeue"),
      ),
    ).toBe(true);
  });

  it("a triage park is a real stop, and is recognised so a requeue can clear it", () => {
    const park = manual("Triage: operator decision needed (FAILED_RETRYABLE|-|unknown|jobs.ashbyhq.com)");
    expect(isTriageParkReview(park)).toBe(true);
    // It must NOT be advisory — while it stands, the loop leaves the app alone.
    expect(isAdvisoryReviewItem(park)).toBe(false);
  });

  it("real walls stay blocking and are never mistaken for a triage park", () => {
    for (const item of [
      { kind: "AMBIGUOUS_FIELD" as const, title: "Fill verification failed" },
      { kind: "CAPTCHA_REQUIRED" as const, title: "Human challenge" },
      { kind: "AUTH_REQUIRED" as const, title: "Sign-in required" },
      { kind: "UNSUPPORTED_ATS" as const, title: "Unsupported ATS" },
    ]) {
      expect(isAdvisoryReviewItem(item)).toBe(false);
      expect(isTriageParkReview(item)).toBe(false);
    }
    // A MANUAL item that is neither advisory nor a park still blocks.
    const other = manual("Stored application URL belongs to another company");
    expect(isAdvisoryReviewItem(other)).toBe(false);
    expect(isTriageParkReview(other)).toBe(false);
  });
});
