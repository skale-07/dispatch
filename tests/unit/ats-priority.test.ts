import { describe, expect, it } from "vitest";
import { applicationAtsTier } from "../../src/automation/worker.js";

/**
 * #228 (operator directive 2026-09-09): "prioritise apps from lever,
 * greenhouse, ashby, that are super easy to fill out. then apply to
 * workday apps." Lower tier is picked first.
 */
describe("applicationAtsTier (UNIT_CONFIRMED)", () => {
  const url = (u: string) => ({ versions_json: JSON.stringify({ employer_application_url: u }) });

  it("puts the vendor-hosted easy forms first", () => {
    for (const ats of ["greenhouse", "lever", "ashby", "workable"]) {
      expect(applicationAtsTier({ source_ats: ats })).toBe(0);
    }
    // Case and padding from the discovery column must not change the tier.
    expect(applicationAtsTier({ source_ats: " Greenhouse " })).toBe(0);
  });

  it("orders unresolved above Workday, and bespoke sites last", () => {
    expect(applicationAtsTier({ source_ats: null, versions_json: null })).toBe(1);
    expect(applicationAtsTier({ source_ats: "workday" })).toBe(2);
    expect(applicationAtsTier({ source_ats: "phenom" })).toBe(3);
    // The ordering the directive asks for, end to end.
    const tiers = ["greenhouse", null, "workday", "icims"].map((a) =>
      applicationAtsTier({ source_ats: a }),
    );
    expect(tiers).toEqual([0, 1, 2, 3]);
    expect([...tiers].sort((x, y) => x - y)).toEqual(tiers);
  });

  it("falls back to the stored employer URL when discovery recorded no ATS", () => {
    expect(applicationAtsTier(url("https://job-boards.greenhouse.io/verkada/jobs/1"))).toBe(0);
    expect(applicationAtsTier(url("https://jobs.ashbyhq.com/replit/abc"))).toBe(0);
    expect(applicationAtsTier(url("https://jobs.lever.co/acme/123"))).toBe(0);
    expect(applicationAtsTier(url("https://spgi.wd5.myworkdayjobs.com/spgi_careers/job/x"))).toBe(2);
    // A resolved employer URL on a company's own site IS the bespoke case.
    expect(applicationAtsTier(url("https://careers.example.com/job/1"))).toBe(3);
  });

  it("never throws on malformed stored state", () => {
    expect(applicationAtsTier({ source_ats: null, versions_json: "not json" })).toBe(1);
    expect(applicationAtsTier({})).toBe(1);
    expect(applicationAtsTier({ versions_json: JSON.stringify({}) })).toBe(1);
  });
});
