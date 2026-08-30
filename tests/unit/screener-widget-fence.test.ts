import { describe, expect, it } from "vitest";
import {
  findCustomScreenerMatch,
  isPageWidgetLabel,
} from "../../src/candidate/screenerMatch.js";
import type { ScreenerAnswerBank } from "../../src/candidate/screeners.js";

/**
 * Progressive-overload set (issue #39, 2026-08-30): the zipline.com
 * ?gh_jid= listing shell exposed its "Search roles" boxes as the only
 * inputs; the fill ran on them and the predictor persisted
 * `search_roles_query_2 = "Software Engineer Intern"` into the bank. Page
 * chrome must never be learned as a screener, and a poisoned entry that
 * already exists must never be reused. UNIT_CONFIRMED.
 */
describe("page-widget labels are fenced out of the screener bank", () => {
  it.each([
    "Search roles",
    "Search jobs",
    "Search",
    "Keywords",
    "Keyword",
    "Search by keyword",
    "Job title or keywords",
    "Filter by location",
    "Sort by",
    "Email me jobs",
  ])("%s is a page widget, not a question", (label) => {
    expect(isPageWidgetLabel(label)).toBe(true);
  });

  it.each([
    "How did you hear about this role?",
    "Which roles are you interested in?",
    "Search engine experience (years)",
    "Describe a search algorithm you implemented",
    "Preferred location",
    "What keywords describe your ideal team?",
  ])("%s is a real question", (label) => {
    expect(isPageWidgetLabel(label)).toBe(false);
  });

  it("an already-poisoned bank entry is never matched again", () => {
    const bank: ScreenerAnswerBank = {
      version: 1,
      answers: {},
      custom: {
        search_roles_query_2: {
          answer: "Software Engineer Intern",
          labels: ["Search roles"],
        },
        role_interest: {
          answer: "Backend",
          labels: ["Which roles are you interested in?"],
        },
      },
    } as unknown as ScreenerAnswerBank;
    expect(findCustomScreenerMatch("Search roles", bank)).toBeNull();
    expect(findCustomScreenerMatch("Which roles are you interested in?", bank)?.key).toBe(
      "role_interest",
    );
  });
});
