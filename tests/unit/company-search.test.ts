import { describe, expect, it } from "vitest";
import {
  cardMatchesCompany,
  companyNameVariants,
  jobRightCompanySearchUrl,
  parseJobRightJobId,
  roleFromCardText,
} from "../../src/jobright/companySearch.js";

/**
 * #242 (night29): twelve verified submits, ZERO Gmail drafts. Every one
 * was board-discovered, so none had a JobRight posting, and #207's
 * stored-company-twin fallback had nothing to borrow — under the 24h
 * posting policy the JobRight feed contributes almost nothing, so the
 * outreach chain had no contact source at all. JobRight's own search
 * resolves any employer; these pin the parsing that decides whether a
 * result card really belongs to the company.
 */
const ROCKET_LAB_CARD =
  "5 hours ago3 school alumniEarly applicantHITL Engineering Intern Summer 2027" +
  "Rocket Lab/Aerospace · Manufacturing · Public CompanyLong Beach, CAInternship" +
  "$28/hr - $28/hrOnsiteInternStart in 2027Why this job is a matchRock";

describe("JobRight company search (#242, UNIT_CONFIRMED)", () => {
  it("builds a US company search URL", () => {
    expect(jobRightCompanySearchUrl("Rocket Lab")).toBe(
      "https://jobright.ai/jobs/search?value=Rocket%20Lab&searchType=job_title&country=US",
    );
  });

  it("accepts a card whose COMPANY slot is the company", () => {
    expect(cardMatchesCompany(ROCKET_LAB_CARD, "Rocket Lab")).toBe(true);
    expect(cardMatchesCompany(ROCKET_LAB_CARD, "rocket lab")).toBe(true);
  });

  it("rejects a card that merely MENTIONS the company in its description", () => {
    const rival =
      "2 hours agoEarly applicantPropulsion InternStoke Space/Aerospace · " +
      "Public CompanyKent, WAInternshipWhy this job is a matchA direct competitor to Rocket Lab in small launch";
    expect(cardMatchesCompany(rival, "Rocket Lab")).toBe(false);
    expect(cardMatchesCompany(rival, "Stoke Space")).toBe(true);
  });

  it("parses the JobRight job id out of a card href, and refuses anything else", () => {
    expect(parseJobRightJobId("https://jobright.ai/jobs/info/6aa1f4ffdbc0e60e37e146e1")).toBe(
      "6aa1f4ffdbc0e60e37e146e1",
    );
    expect(parseJobRightJobId("https://jobright.ai/jobs/recommend")).toBeNull();
    expect(parseJobRightJobId("https://example.com/jobs/info/notahexid")).toBeNull();
  });

  it("recovers the role text that precedes the company slot", () => {
    expect(roleFromCardText(ROCKET_LAB_CARD, "Rocket Lab")).toContain(
      "HITL Engineering Intern Summer 2027",
    );
    // No company slot at all → an honest placeholder, never a wrong role.
    expect(roleFromCardText("nothing useful here", "Rocket Lab")).toBe("role unknown");
  });

  // The two catalogues disagree about the same employer: the board said
  // "Rocket Lab USA", JobRight indexes "Rocket Lab". Only legal-entity and
  // country qualifiers are negotiable.
  it("matches across legal-entity and country qualifiers", () => {
    expect(cardMatchesCompany(ROCKET_LAB_CARD, "Rocket Lab USA")).toBe(true);
    expect(companyNameVariants("Acme, Inc.")).toContain("acme");
    expect(companyNameVariants("Smartly.io")).toContain("smartly");
    expect(companyNameVariants("DV Trading LLC")).toContain("dv trading");
  });

  it("never strips a qualifier that DISTINGUISHES an employer", () => {
    // "Verkada" is not "Verkada Partners" — the exact-match discipline of
    // the stored-twin lookup must survive this widening.
    expect(companyNameVariants("Verkada Partners")).not.toContain("verkada");
    expect(companyNameVariants("Palantir Technologies")).not.toContain("palantir");
    const verkadaPartnersCard = "1 day agoAnalyst InternVerkada Partners/Finance · Private CompanyNY";
    expect(cardMatchesCompany(verkadaPartnersCard, "Verkada")).toBe(false);
  });
});
