import { describe, expect, it } from "vitest";
import { judgePostingAge, parsePostedAgoMinutes } from "../../src/jobs/postingAge.js";

/**
 * #199 — operator directive 2026-09-08: postings older than 24h are not
 * applied to; queued apps older than 24h are not applied to. UNIT_CONFIRMED.
 */
describe("posting-age policy (#199, UNIT_CONFIRMED)", () => {
  it("parses JobRight's relative age text", () => {
    expect(parsePostedAgoMinutes("Daylit · 5 hours ago · Boston")).toBe(300);
    expect(parsePostedAgoMinutes("32 minutes ago")).toBe(32);
    expect(parsePostedAgoMinutes("2 days ago")).toBe(2880);
    expect(parsePostedAgoMinutes("an hour ago")).toBe(60);
    expect(parsePostedAgoMinutes("1 week ago")).toBe(10080);
    expect(parsePostedAgoMinutes("posted today")).toBeNull();
    expect(parsePostedAgoMinutes(null)).toBeNull();
  });

  const now = new Date("2026-09-09T03:00:00Z");

  it("a posting seen 20h ago that was already 5h old is 25h old ⇒ stale", () => {
    const v = judgePostingAge({
      descriptionText: "Company · 5 hours ago",
      jobCreatedAt: "2026-09-08T07:00:00Z",
      appCreatedAt: "2026-09-08T07:00:00Z",
      now,
    });
    expect(v.stale).toBe(true);
    expect(v.posting_age_hours).toBe(25);
    expect(v.reason).toMatch(/published 25h ago \(> 24h/);
  });

  it("a fresh posting in a fresh queue row is not stale", () => {
    const v = judgePostingAge({
      descriptionText: "Company · 3 hours ago",
      jobCreatedAt: "2026-09-09T02:17:00Z",
      appCreatedAt: "2026-09-09T02:17:00Z",
      now,
    });
    expect(v.stale).toBe(false);
    expect(v.posting_age_hours).toBe(3.7);
  });

  it("queue age alone makes a row stale even when posting age is unknown", () => {
    const v = judgePostingAge({
      descriptionText: "no relative time here",
      jobCreatedAt: "2026-09-07T20:00:00Z",
      appCreatedAt: "2026-09-07T20:00:00Z",
      now,
    });
    expect(v.stale).toBe(true);
    expect(v.posting_age_hours).toBeNull();
    expect(v.reason).toMatch(/queued 31h ago/);
  });

  it("unknown posting age with a fresh queue row is NOT stale (fail-open on missing evidence)", () => {
    const v = judgePostingAge({
      descriptionText: null,
      jobCreatedAt: "2026-09-09T02:00:00Z",
      appCreatedAt: "2026-09-09T02:00:00Z",
      now,
    });
    expect(v.stale).toBe(false);
    expect(v.reason).toMatch(/unknown/);
  });

  it("the cap is configurable and inclusive of the boundary", () => {
    const v = judgePostingAge({
      descriptionText: "1 hour ago",
      jobCreatedAt: "2026-09-09T00:00:00Z",
      now,
      maxAgeHours: 4,
    });
    expect(v.stale).toBe(false); // exactly 4h is not > 4h
  });
});
