import { describe, expect, it } from "vitest";
import {
  findCustomScreenerMatch,
  isPageWidgetLabel,
  screenerKeyLabelIncompatible,
} from "../../src/candidate/screenerMatch.js";

/**
 * Topic fence, night19 #42: the internship LENGTH entry ("12 or 16 weeks")
 * had the neuralink SEASON question attached by the paraphrase loop, so a
 * duration was fed to a "Fall 2026 | Winter 2027" combobox three times.
 */
describe("length ↔ season topic fence", () => {
  it.each([
    ["internship_length", "What intern season are you interested in?"],
    ["internship_length", "What internship season are you interested in?"],
    ["preferred_duration_weeks", "Which term are you applying for?"],
    ["internship_length", "Which cohort would you like to join?"],
    ["internship_season", "How long of an internship are you looking for?"],
    ["internship_term", "Please indicate what length of internship you are interested in."],
  ])("%s never takes label %s", (key, label) => {
    expect(screenerKeyLabelIncompatible(key, label)).toBe(true);
  });

  it.each([
    ["internship_length", "Please indicate what length of internship you are interested in."],
    ["internship_season", "What intern season are you interested in?"],
    ["graduation_year", "What year will you graduate?"],
  ])("%s still accepts its own label %s", (key, label) => {
    expect(screenerKeyLabelIncompatible(key, label)).toBe(false);
  });
});
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
