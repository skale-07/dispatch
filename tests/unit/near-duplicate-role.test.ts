import { describe, expect, it } from "vitest";
import {
  isNearDuplicateRole,
  normalizeRoleForDedupe,
} from "../../src/jobs/nearDuplicateRole.js";

/**
 * #249 (operator 2026-09-10: "ensure your not sending duplicate
 * applications. youve sent so many apps to verkada").
 *
 * The audit found no TRUE duplicates — every submission is a distinct
 * posting URL and each company's submit count equals its distinct-posting
 * count. What it did find is term variants of one job: eight Rocket Lab
 * applications covering five real roles, because Systems Engineering,
 * Fluid Systems and Flight Software were each posted for Spring AND
 * Summer 2027. To the person reading them that is one candidate applying
 * twice to the same job.
 */
describe("near-duplicate roles (#249)", () => {
  it("reduces a posting title to the job it actually names", () => {
    expect(normalizeRoleForDedupe("Systems Engineering Intern Summer 2027")).toBe(
      "systems engineering",
    );
    expect(normalizeRoleForDedupe("Systems Engineering Intern Spring 2027")).toBe(
      "systems engineering",
    );
    expect(normalizeRoleForDedupe("Software Engineer, Intern (Summer 2026)")).toBe(
      "software engineer",
    );
    expect(normalizeRoleForDedupe("Flight Software Intern Spring 2027")).toBe("flight software");
  });

  it("catches the exact Rocket Lab pairs that shipped tonight", () => {
    const applied = [
      "Systems Engineering Intern Summer 2027",
      "Fluid Systems Intern Summer 2027",
      "Flight Software Intern Summer 2027",
      "Avionics Engineering Intern Summer 2027",
      "HITL Engineering Intern Summer 2027",
    ];
    for (const spring of [
      "Systems Engineering Intern Spring 2027",
      "Fluid Systems Intern Spring 2027",
      "Flight Software Intern Spring 2027",
    ]) {
      const v = isNearDuplicateRole(spring, applied);
      expect(v.duplicate, spring).toBe(true);
      expect(v.matched).toContain("Summer");
    }
  });

  it("still applies to genuinely different roles at the same company", () => {
    const applied = ["Systems Engineering Intern Summer 2027"];
    for (const other of [
      "Fluid Systems Intern Summer 2027",
      "Flight Software Intern Summer 2027",
      "Avionics Engineering Intern Summer 2027",
      "Manufacturing Engineering Intern",
    ]) {
      expect(isNearDuplicateRole(other, applied).duplicate, other).toBe(false);
    }
  });

  it("never dedupes across companies, and never on a boilerplate-only title", () => {
    // The caller only ever passes roles from the SAME company, but the
    // key must still be specific enough to be worth comparing.
    expect(isNearDuplicateRole("Intern", ["Summer Intern 2027"]).duplicate).toBe(false);
    expect(normalizeRoleForDedupe("Summer Internship 2027")).toBe("");
  });

  // The 2026-09-07 US-only directive expects Stripe's three same-titled
  // US postings (Seattle / Remote / unlisted) to ALL enqueue. Identical
  // titles are separate location reqs; only a title that differs yet
  // collapses to the same key is one job posted for two terms.
  it("leaves identical titles alone — those are per-location reqs", () => {
    const applied = ["Software Engineer, Intern"];
    expect(isNearDuplicateRole("Software Engineer, Intern", applied).duplicate).toBe(false);
    // But the term variant of that same role IS caught.
    expect(
      isNearDuplicateRole("Software Engineer, Intern (Summer 2027)", applied).duplicate,
    ).toBe(true);
  });
});
