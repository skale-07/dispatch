import { describe, expect, it } from "vitest";
import { samePostingPath } from "../../src/ats/shared/preMutationGate.js";

/**
 * Night19 #51 (2026-08-30, Philips careers): the site canonicalised the
 * slug's letter case on load and the redirect guard called it a different
 * posting (POSTING_MISMATCH) although the job id and every word matched.
 */
describe("samePostingPath (UNIT_CONFIRMED)", () => {
  it("case-only, encoding-only and trailing-slash differences are the same posting", () => {
    expect(
      samePostingPath(
        "/na/en/job/PHILUS590567ENNA/Graduate-Level-Co-op-Data-Scientist-Plymouth-MN-January-2027",
        "/na/en/job/PHILUS590567ENNA/graduate-level-co-op-data-scientist-plymouth-mn-january-2027",
      ),
    ).toBe(true);
    expect(samePostingPath("/jobs/27486/software-engineering-intern%2c-connected-systems/job", "/jobs/27486/software-engineering-intern,-connected-systems/job/")).toBe(true);
  });

  it("a different job id or a different slug is still a mismatch", () => {
    expect(samePostingPath("/na/en/job/PHILUS590568ENNA/graduate-level-co-op", "/na/en/job/PHILUS590567ENNA/graduate-level-co-op")).toBe(false);
    expect(samePostingPath("/jobs/1/senior-engineer", "/jobs/1/intern")).toBe(false);
    expect(samePostingPath("/careers", "/careers/jobs/1")).toBe(false);
  });
});

describe("#81 workday apply-flow presentation differences", () => {
  it("locale prefix, encoded comma, and /apply suffix are the same posting; different requisition ids still mismatch", async () => {
    const { samePostingPath } = await import("../../src/ats/shared/preMutationGate.js");
    expect(
      samePostingPath(
        "/en-US/strykercareers/job/Portage%2C-Michigan/Summer-2027-Internship---Data-Analytics---Michigan_R572601/apply",
        "/strykercareers/job/Portage-Michigan/Summer-2027-Internship---Data-Analytics---Michigan_R572601",
      ),
    ).toBe(true);
    expect(
      samePostingPath(
        "/en-US/strykercareers/job/Portage-Michigan/Other-Role_R999999/apply",
        "/strykercareers/job/Portage-Michigan/Summer-2027-Internship---Data-Analytics---Michigan_R572601",
      ),
    ).toBe(false);
    expect(
      samePostingPath(
        "/en-US/board/job/City/Role_R1/apply/applyManually",
        "/board/job/City/Role_R1",
      ),
    ).toBe(true);
  });
});

describe("#90b underscore locales (Avature en_US)", () => {
  it("an en_US prefix is presentation; a different jobId path still mismatches", async () => {
    const { samePostingPath } = await import("../../src/ats/shared/preMutationGate.js");
    expect(samePostingPath("/en_US/careers/JobDetail", "/careers/JobDetail")).toBe(true);
    expect(samePostingPath("/en_US/careers/OtherPage", "/careers/JobDetail")).toBe(false);
  });
});
