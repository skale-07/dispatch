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

/**
 * #241, second entry point: `requeueAmbiguousField` left the triage park
 * standing, so 12 of 14 FIELD_VERIFICATION applications — every one
 * requeued to prove a fix — were invisible to the picker while the loop
 * idled on an empty queue.
 */
describe("a requeue clears the triage park that was waiting for it", () => {
  it("requeueAmbiguousField dismisses the app's triage park", async () => {
    const [{ openDatabase, migrate, closeDatabase }, { createApplication }, { upsertJobByFingerprint }, reviewItems, resolvers] =
      await Promise.all([
        import("../../src/storage/db/client.js"),
        import("../../src/queue/stateMachine.js"),
        import("../../src/jobs/repository.js"),
        import("../../src/queue/reviewItems.js"),
        import("../../src/queue/reviewResolvers.js"),
      ]);
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const { randomUUID } = await import("node:crypto");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-requeue-"));
    const db = openDatabase(path.join(dir, "app.sqlite"));
    try {
      migrate(db);
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
        applicationUrl: "https://jobs.lever.co/acme/abc/apply",
        company: "Acme",
        role: "SWE Intern",
      });
      const appId = createApplication(db, { jobId: job.id }).id;
      db.prepare("UPDATE applications SET state='AMBIGUOUS_FIELD' WHERE id=?").run(appId);
      const { item: ambiguous } = reviewItems.upsertOpenReviewItem(db, {
        applicationId: appId,
        kind: "AMBIGUOUS_FIELD",
        title: "Fill verification failed",
      });
      reviewItems.upsertOpenReviewItem(db, {
        applicationId: appId,
        kind: "MANUAL",
        title: "Triage: operator decision needed (AMBIGUOUS_FIELD|-|verify_mismatch|jobs.lever.co)",
      });
      expect(reviewItems.listOpenReviewItems(db).filter((i) => i.application_id === appId)).toHaveLength(2);

      resolvers.requeueAmbiguousField(db, { reviewItemId: ambiguous.id, note: "test" });

      const stillOpen = reviewItems.listOpenReviewItems(db).filter((i) => i.application_id === appId);
      expect(stillOpen).toHaveLength(0);
    } finally {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
