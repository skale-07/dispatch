import { describe, expect, it } from "vitest";
import {
  cardCompanySlot,
  cardMatchesCompany,
  classifyCardCompany,
  companyNameVariants,
  jobRightCompanySearchUrl,
  parseJobRightJobId,
  roleFromCardText,
} from "../../src/jobright/companySearch.js";
import { recipientMatchesCompany } from "../../src/outreach/recipientCompanyMatch.js";

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

  it("the stored-twin lookup still never strips a distinguishing qualifier", () => {
    // `companyNameVariants` feeds findCompanyTwinJob, where an exact match
    // is the whole discipline: "Verkada" must not read "Verkada Partners".
    expect(companyNameVariants("Verkada Partners")).not.toContain("verkada");
    expect(companyNameVariants("Palantir Technologies")).not.toContain("palantir");
  });

  /**
   * A deliberate, bounded relaxation — decided 2026-09-10 on live evidence,
   * and its limits stated honestly.
   *
   * Strict slot matching cost 8 of 22 submits their entire contact lookup:
   * JobRight indexes "Saronic Technologies" and "Lexington Medical, Inc"
   * for what the board calls "Saronic" and "Lexington Medical". Accepting a
   * generic corporate tail fixes that — and it necessarily also lets
   * "Verkada" reach a "Verkada Partners" card, because the two shapes are
   * identical. Nothing downstream can tell them apart either:
   * `recipientMatchesCompany("a@verkadapartners.com", "Verkada")` MATCHES,
   * since the domain does contain the company token.
   *
   * So this is a real residual risk, not a covered one. What bounds it is
   * ordering: an EXACT card always wins, so the ambiguous match only
   * decides when the page offers nothing better.
   */
  it("classifies exact vs generic-tail, and an exact card is preferred", () => {
    const saronic =
      "15 hours agoForward Deployed Engineer Intern (Summer 2027)" +
      "Saronic Technologies / Artificial Intelligence (AI) · Austin, TX";
    expect(classifyCardCompany(saronic, "Saronic Technologies")).toBe("exact");
    expect(classifyCardCompany(saronic, "Saronic")).toBe("generic_tail");
    expect(classifyCardCompany(ROCKET_LAB_CARD, "Rocket Lab")).toBe("exact");
    expect(classifyCardCompany(ROCKET_LAB_CARD, "Zipline")).toBe("none");
  });

  it("documents the residual ambiguity rather than pretending it is covered", () => {
    const verkadaPartnersCard = "1 day agoAnalyst InternVerkada Partners/Finance · Private CompanyNY";
    // Same shape as Saronic Technologies, so it matches — at the weaker tier.
    expect(classifyCardCompany(verkadaPartnersCard, "Verkada")).toBe("generic_tail");
    // And #248 does NOT catch the consequence: the domain carries the token.
    expect(recipientMatchesCompany("a@verkadapartners.com", "Verkada").verdict).toBe("match");
    // The only real protection is that an exact card outranks it.
    expect(classifyCardCompany("Analyst InternVerkada/Security · CA", "Verkada")).toBe("exact");
  });

  // Live 2026-09-10: 8 of 22 submits got NO contact lookup because the
  // search verified nothing. Two reasons, both here:
  //   - JobRight indexes "Saronic Technologies" where the board said
  //     "Saronic", and "Lexington Medical, Inc" for "Lexington Medical";
  //   - that card separates with " / " (spaces) while Rocket Lab's uses
  //     "/" bare, so a `name + "/"` test could not match either.
  it("matches when the catalogue appends a generic corporate word", () => {
    const saronic =
      "15 hours ago1 school alumEarly applicantForward Deployed Engineer Intern (Summer 2027)" +
      "Saronic Technologies / Artificial Intelligence (AI) · Transportation · Late StageAustin, TX";
    expect(cardCompanySlot(saronic)).toContain("Saronic Technologies");
    expect(cardMatchesCompany(saronic, "Saronic")).toBe(true);

    const lexington =
      "17 hours ago1 school alumEarly applicantElectrical EngineerLexington Medical, Inc/Healthcare · Bedford, MA";
    expect(cardMatchesCompany(lexington, "Lexington Medical")).toBe(true);
  });

  it("still reads the bare-slash card, and still rejects a different employer", () => {
    expect(cardMatchesCompany(ROCKET_LAB_CARD, "Rocket Lab")).toBe(true);
    // A generic tail is stripped from the END only — "Rocket" alone is not
    // the company, and an unrelated employer never matches.
    expect(cardMatchesCompany(ROCKET_LAB_CARD, "Zipline")).toBe(false);
    const other = "2 hours agoPropulsion InternStoke Space / Aerospace · Public CompanyKent, WA";
    expect(cardMatchesCompany(other, "Rocket Lab")).toBe(false);
    expect(cardMatchesCompany(other, "Stoke Space")).toBe(true);
  });
});
