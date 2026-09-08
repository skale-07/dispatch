import { describe, expect, it } from "vitest";
import { normalizeEmployerUrlForDedupe } from "../../src/navigation/congruence.js";

/**
 * One Greenhouse posting has three URL shapes; duplicate detection must see
 * one identity (live 2026-09-08: a board-API sweep re-enqueued a posting
 * already COMPLETED via JobRight because the hosts differed). UNIT_CONFIRMED.
 */
describe("Greenhouse posting identity for dedupe (UNIT_CONFIRMED)", () => {
  const canonical = "https://boards.greenhouse.io/stripe/jobs/8130805";

  it("collapses boards / job-boards / embed forms to one URL", () => {
    expect(normalizeEmployerUrlForDedupe("https://boards.greenhouse.io/stripe/jobs/8130805/")).toBe(canonical);
    expect(normalizeEmployerUrlForDedupe("https://job-boards.greenhouse.io/stripe/jobs/8130805?gh_src=abc")).toBe(
      `${canonical}?gh_src=abc`,
    );
    expect(
      normalizeEmployerUrlForDedupe("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130805"),
    ).toBe(canonical);
  });

  it("keeps different postings on the same board distinct", () => {
    expect(normalizeEmployerUrlForDedupe("https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=8130807")).not.toBe(
      canonical,
    );
    expect(normalizeEmployerUrlForDedupe("https://boards.greenhouse.io/stripe/jobs/8097801")).not.toBe(canonical);
  });

  it("leaves non-Greenhouse hosts alone (query ids on vendor hosts still count)", () => {
    expect(normalizeEmployerUrlForDedupe("https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?jobid=907868&utm_source=x")).toBe(
      "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?jobid=907868",
    );
  });
});
