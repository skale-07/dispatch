import { describe, expect, it } from "vitest";
import {
  domainLabel,
  isFreeMail,
  recipientMatchesCompany,
} from "../../src/outreach/recipientCompanyMatch.js";

/**
 * #248 (found 2026-09-10 while checking a subagent's Zipline report).
 * JobRight's insider panel is not one list: alongside people at the target
 * employer it shows "From Your School" and "From Your Previous Company" —
 * people the CANDIDATE knows, who often work somewhere else. The extractor
 * treated all of them as insiders, so drafts went to strangers about a job
 * at a company they do not work for. These were already in the operator's
 * Drafts folder:
 *
 *   Zipline         -> ghao@zoox.com, aweinstein@zoox.com  (both DRAFTED)
 *   Coinbase        -> vincent@usage.ai
 *   American Equity -> nathans@pdhi.com
 */
describe("outreach recipients must work at the company we applied to (#248)", () => {
  it("catches every wrong-company draft that actually shipped", () => {
    for (const [email, company] of [
      ["ghao@zoox.com", "Zipline"],
      ["aweinstein@zoox.com", "Zipline"],
      ["vincent@usage.ai", "Coinbase"],
      ["nathans@pdhi.com", "American Equity"],
    ] as Array<[string, string]>) {
      const v = recipientMatchesCompany(email, company);
      expect(v.verdict, `${email} @ ${company}`).toBe("mismatch");
      expect(v.reason).toMatch(/appears to work somewhere else/);
    }
  });

  it("keeps every legitimate recipient that shipped the same nights", () => {
    for (const [email, company] of [
      ["a.lambert@rocketlabusa.com", "Rocket Lab"],
      ["t.bowdish@rocketlabusa.com", "Rocket Lab USA"],
      ["akarr@dvtrading.co", "DV Trading LLC"],
      ["qi.wang@drw.com", "DRW"],
      ["nfu@drwholdings.com", "DRW"],
      ["moleary@drwholdings.com", "DRW"],
      ["ryan.turner@american-equity.com", "American Equity"],
      ["seth.ebner@kensho.com", "Kensho Technologies"],
      ["yuan.tian@coinbase.com", "Coinbase"],
    ] as Array<[string, string]>) {
      expect(recipientMatchesCompany(email, company).verdict, `${email} @ ${company}`).toBe(
        "match",
      );
    }
  });

  it("never drops a personal mailbox — a real insider may use one", () => {
    for (const email of ["grace.hao@gmail.com", "someone@outlook.com", "x@icloud.com"]) {
      expect(recipientMatchesCompany(email, "Zipline").verdict).toBe("unknown");
      expect(isFreeMail(email)).toBe(true);
    }
  });

  it("stays UNKNOWN rather than mismatching when it cannot tell", () => {
    expect(recipientMatchesCompany("", "Zipline").verdict).toBe("unknown");
    expect(recipientMatchesCompany("a@b.com", null).verdict).toBe("unknown");
    expect(recipientMatchesCompany("a@corp.com", "Inc LLC").verdict).toBe("unknown");
    // Only the caller decides what to do with unknown — it is never a drop.
    expect(recipientMatchesCompany("x@nomatch.com", "Zipline").verdict).toBe("mismatch");
  });

  it("reads the registrable label through subdomains and suffixes", () => {
    expect(domainLabel("a@mail.rocketlabusa.com")).toBe("rocketlabusa");
    expect(domainLabel("a@drw.com")).toBe("drw");
    expect(domainLabel("a@american-equity.com")).toBe("american-equity");
    expect(domainLabel("no-at-sign")).toBeNull();
  });

  // A placeholder is not an employer. enqueueJobRightJobs stores
  // "Unknown company (manual enqueue)" when the name was never resolved;
  // treating that as real would mismatch EVERY corporate address and drop
  // every recipient on those applications.
  it("never mismatches against a placeholder company name", () => {
    for (const co of ["Unknown company (manual enqueue)", "Unknown", "unknown company"]) {
      expect(recipientMatchesCompany("pat@acme.test", co).verdict).toBe("unknown");
    }
  });

  // The label is read positionally, so an unfamiliar TLD is not mistaken
  // for the company (".test", ".de", ".ventures" were all returning the
  // TLD itself before).
  it("reads the registrable label under any TLD", () => {
    expect(domainLabel("pat@acme.test")).toBe("acme");
    expect(domainLabel("a@example.co.uk")).toBe("example");
    expect(domainLabel("a@team.acme.ventures")).toBe("acme");
    expect(recipientMatchesCompany("pat@acme.test", "Acme Robotics").verdict).toBe("match");
  });
});
