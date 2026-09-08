import { describe, expect, it } from "vitest";
import { classifyLocation } from "../../src/jobs/locationEligibility.js";
import { evaluateEligibility } from "../../src/jobright/eligibility.js";

/** Operator directive 2026-09-07: US postings only. UNIT_CONFIRMED. */
describe("location eligibility — US only (UNIT_CONFIRMED)", () => {
  it("the six Stripe postings submitted on 2026-09-08 are all non-US", () => {
    for (const loc of ["Dublin", "Toronto", "Bucharest", "Bengaluru", "Singapore", "London", "Mexico City, Mexico"]) {
      expect(classifyLocation(loc).verdict, loc).toBe("non_us");
    }
  });

  it("recognises US postings by country, state name, abbreviation, and US-remote", () => {
    for (const loc of [
      "San Francisco, CA",
      "New York, NY 10001",
      "Austin, Texas",
      "Seattle, WA, United States",
      "Remote - US",
      "US Remote",
      "Remote (USA)",
      "Baltimore, Maryland, United States",
      "Washington, District of Columbia",
      "San Juan, PR",
    ]) {
      expect(classifyLocation(loc).verdict, loc).toBe("us");
    }
  });

  it("a US signal wins over a foreign-looking token (Paris, TX; Dublin, OH; Toronto, OH)", () => {
    expect(classifyLocation("Paris, TX").verdict).toBe("us");
    expect(classifyLocation("Dublin, OH").verdict).toBe("us");
    expect(classifyLocation("Toronto, Ohio").verdict).toBe("us");
  });

  it("unknown is not a rejection: empty, bare Remote, or an unplaceable city", () => {
    expect(classifyLocation(null).verdict).toBe("unknown");
    expect(classifyLocation("").verdict).toBe("unknown");
    expect(classifyLocation("Remote").verdict).toBe("unknown");
    expect(classifyLocation("Baltimore").verdict).toBe("unknown");
    expect(classifyLocation("Lakeland, FL").verdict).toBe("us");
  });

  it("JobRight eligibility rejects a non-US posting and warns on an unplaceable one", () => {
    const nonUs = evaluateEligibility({ role: "Software Engineer, Intern", employmentType: "Internship", location: "Toronto" });
    expect(nonUs.eligible).toBe(false);
    expect(nonUs.checks.find((c) => c.name === "location_us")).toMatchObject({ result: false });

    const us = evaluateEligibility({ role: "Software Engineer, Intern", employmentType: "Internship", location: "Austin, TX" });
    expect(us.eligible).toBe(true);

    const vague = evaluateEligibility({ role: "Software Engineer, Intern", employmentType: "Internship", location: "Remote" });
    expect(vague.eligible).toBe(true);
    expect(vague.warnings.some((w) => /Location not confidently US/.test(w))).toBe(true);

    const none = evaluateEligibility({ role: "Software Engineer, Intern", employmentType: "Internship" });
    expect(none.eligible).toBe(true);
    expect(none.warnings.some((w) => /Location/.test(w))).toBe(false);
  });

  it("does not misread words that merely contain a token", () => {
    expect(classifyLocation("Indianapolis, IN").verdict).toBe("us"); // "india" inside Indianapolis
    expect(classifyLocation("Georgetown, DE").verdict).toBe("us");
    expect(classifyLocation("Vancouver, WA").verdict).toBe("us");
  });
});
