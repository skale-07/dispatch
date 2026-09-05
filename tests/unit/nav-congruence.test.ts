import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import {
  setEmployerApplicationUrl,
  getEmployerApplicationUrl,
} from "../../src/applications/employerUrl.js";
import {
  checkUrlCongruence,
  companyIdentity,
  extractOrgSlug,
  extractOrgCandidates,
  findApplicationsWithEmployerUrl,
} from "../../src/navigation/congruence.js";
import { auditEmployerUrls } from "../../src/navigation/auditEmployerUrls.js";
import { listOpenReviewItems } from "../../src/queue/reviewItems.js";
import { resetConfigCache } from "../../src/config/index.js";

/**
 * Resolution congruence — pinned on the REAL live failure: the nav agent
 * returned the same Cohere Ashby URL for three unrelated jobs (Energy
 * Systems Group, Postman, AMA Legal Solutions), and host-only acceptance
 * persisted all three. Every company/slug pair below is from that session.
 * UNIT_CONFIRMED.
 */
describe("URL congruence (UNIT_CONFIRMED)", () => {
  const COHERE_URL =
    "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application";

  it("rejects the live regression trio against the Cohere URL", () => {
    for (const company of [
      "Energy Systems Group (ESG)",
      "Postman",
      "AMA Legal Solutions ®",
    ]) {
      expect(checkUrlCongruence(company, COHERE_URL).verdict).toBe("mismatch");
    }
  });

  it("accepts the true owners of their own boards", () => {
    expect(checkUrlCongruence("Cohere", COHERE_URL).verdict).toBe("match");
    expect(
      checkUrlCongruence(
        "METR",
        "https://jobs.lever.co/metr/52fca070-da6a-441e-b1d1-8184c51b52e6/apply",
      ).verdict,
    ).toBe("match");
  });

  it("matches acronym slugs via initials and parenthetical aliases", () => {
    // "Energy Systems Group (ESG)" — both routes must reach slug "esg".
    expect(
      checkUrlCongruence(
        "Energy Systems Group (ESG)",
        "https://boards.greenhouse.io/esg/jobs/123",
      ).verdict,
    ).toBe("match");
    expect(
      checkUrlCongruence(
        "Energy Systems Group",
        "https://boards.greenhouse.io/esg/jobs/123",
      ).verdict,
    ).toBe("match");
  });

  it("legal suffixes and punctuation never break a match", () => {
    expect(
      checkUrlCongruence(
        "Postman, Inc.",
        "https://jobs.ashbyhq.com/postman/xyz/application",
      ).verdict,
    ).toBe("match");
    expect(
      checkUrlCongruence(
        "Cohere Health",
        "https://jobs.lever.co/cohere-health/abc",
      ).verdict,
    ).toBe("match");
  });

    it("a URL carrying no employer name at all is 'unknown', never a silent pass", () => {
    // Every label here is a page word, so there is nothing to verify
    // against — the human decides, and we say so.
    const v = checkUrlCongruence(
      "Anything",
      "https://careers.jobs/apply/123",
    );
    expect(v.verdict).toBe("unknown");
    expect(v.detail).toMatch(/no employer name decodable/);
  });

  it("placeholder company names are uncheckable, not a Datadog-vs-Unknown mismatch", () => {
    const datadog =
      "https://job-boards.greenhouse.io/datadog/jobs/8052095";
    expect(
      checkUrlCongruence("Unknown company (manual enqueue)", datadog).verdict,
    ).toBe("unknown");
    expect(checkUrlCongruence("Unknown company", datadog).verdict).toBe(
      "unknown",
    );
    expect(checkUrlCongruence("Datadog", datadog).verdict).toBe("match");
  });

  it("UKG SaaShr shard hosts are unverifiable, not a wrong-employer mismatch", () => {
    // Live 2026-08-14: TRG Apply captured secure7.saashr.com and congruence
    // accused "secure7" of being a different company. Shard labels and the
    // board hostname are not employer names.
    const url = "https://secure7.saashr.com/ta/6123484.careers";
    expect(extractOrgCandidates(url).map((c) => c.value)).not.toContain("secure7");
    const v = checkUrlCongruence("TRG", url);
    expect(v.verdict).toBe("unknown");
    expect(checkUrlCongruence("Cohere", url).verdict).toBe("unknown");
  });

  /**
   * The multi-employer host list only ever grows AFTER a correct URL has
   * been thrown away — gusto, then saashr, then paycom. Recognising the
   * vendor SHAPE means a platform's first appearance costs a review item
   * ("unknown"), not a false mismatch that discards the link.
   */
  describe("HR-vendor domains never name the employer", () => {
    it("Union Home Mortgage on Paycom is unverifiable, not a mismatch", () => {
      // Live 2026-08-14: paycomonline.net carries the employer nowhere in
      // the URL — the portal id is a GUID and the job is a number.
      const url =
        "https://www.paycomonline.net/v4/ats/web.php/portal/8D53302EA22D1C46265D36DBFB59E08C/jobs/327881";
      expect(extractOrgCandidates(url).map((c) => c.value)).not.toContain(
        "paycomonline",
      );
      expect(checkUrlCongruence("Union Home Mortgage", url).verdict).toBe(
        "unknown",
      );
    });

    it("but a tenant host that DOES name the employer still matches", () => {
      // These two are live matches decided on hostname evidence alone.
      // Blanket-suppressing vendor hostnames would have broken both.
      expect(
        checkUrlCongruence(
          "Crowe",
          "https://crowe.wd12.myworkdayjobs.com/external_careers/job/Chicago-IL-USA/AI-Engineering-Intern_R-51782",
        ).verdict,
      ).toBe("match");
      expect(
        checkUrlCongruence(
          "Delta Air Lines",
          "https://delta.avature.net/careers/JobDetail?jobId=33537",
        ).verdict,
      ).toBe("match");
    });
  });

  /**
   * Progressive-overload set, night19 (2026-08-30): the twelve live URLs
   * that produced "Stored application URL belongs to X, not <company>"
   * parks or fill refusals. Five name the employer in a tenant subdomain
   * the decoder ignored; seven name NOTHING and were accused by a page
   * word, a tenant code, a posting id or a job-title slug. Verdict per
   * case is what a human reading the URL would say.
   */
  describe("night19 wrong-employer parks (UNIT_CONFIRMED)", () => {
    const MATCHES: Array<[string, string]> = [
      [
        "Rivian",
        "https://internal-careers-rivian.icims.com/jobs/27486/software-engineering-intern%2c-connected-systems---summer-2026/job",
      ],
      [
        "Charles Schwab",
        "https://career-schwab.icims.com/jobs/126227/technology-2027-intern---data-engineering/job",
      ],
      [
        "Cleveland Research Company",
        "https://clevelandresearch.applytojob.com/apply/zy7WHaTRsu/Hedge-Fund-Sales-Consultant-Intern-Summer-2027",
      ],
      [
        "Atlas",
        "https://oneatlas.hrmdirect.com/employment/job-opening.php?req=3794021&req_loc=1440881&cust_sort1=225852",
      ],
      [
        "Bear Robotics",
        "https://bear-robotics.breezy.hr/p/b8d4995f6d23-software-engineering-intern-developer-productivit",
      ],
      [
        "Barbacane, Thornton & Company",
        "https://btcpa.rec.pro.ukg.net/BEN1022BTLL/JobBoard/702a70c1-c1f7-4971-8626-bb99571a35a2/OpportunityDetail?opportunityId=4d519358-fb57-46be-8018-838c26e1bf4a",
      ],
    ];
    const UNKNOWNS: Array<[string, string]> = [
      [
        "Acuity Insurance",
        "https://recruiting2.ultipro.com/her1001acfin/JobBoard/ab33798a-3521-417b-8db8-a8e435c475fa/OpportunityDetail?opportunityId=3d8a72b0-b464-4ff8-bd58-555a1e640ef7",
      ],
      [
        "RTX",
        "https://globalhr.wd5.myworkdayjobs.com/private_posting_no_tmp/job/US-FL-JUPITER-ADR--17900-Beeline-Hwy--ADR-BLDG/Software-Engineering-Intern--Summer-2027-_01868485",
      ],
      [
        "Vertiv",
        "https://egup.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/20270351",
      ],
      [
        "MicroVention-Terumo",
        "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25987&siteid=5297&PageType=JobDetails&jobid=913456",
      ],
      [
        "iA",
        "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=93fdfc70-37a2-4cde-ba86-0da4925db4c8&jobId=578206&ccId=9200669649151_3",
      ],
      ["Bradesco Bank", "https://www.linkedin.com/jobs/view/4458798591"],
      ["Neuralink", "https://www.linkedin.com/jobs/view/4416715074"],
    ];

    it.each(MATCHES)("%s is named by its tenant subdomain: %s", (company, url) => {
      const v = checkUrlCongruence(company, url);
      expect(v.verdict, v.detail).toBe("match");
    });

    it.each(UNKNOWNS)("%s is not named anywhere in %s — unknown, never accused", (company, url) => {
      const v = checkUrlCongruence(company, url);
      expect(v.verdict, v.detail).toBe("unknown");
    });

    it("a job-title slug, a tenant code or a posting id can never accuse", () => {
      const cands = extractOrgCandidates(
        "https://internal-careers-rivian.icims.com/jobs/27486/software-engineering-intern%2c-connected-systems---summer-2026/job",
      );
      const title = cands.find((c) => c.value.startsWith("softwareengineeringintern"));
      expect(title?.accuser).toBe(false);
      expect(cands.find((c) => c.value === "rivian")?.source).toBe("tenant");
      for (const url of [
        "https://recruiting2.ultipro.com/her1001acfin/JobBoard/x",
        "https://btcpa.rec.pro.ukg.net/BEN1022BTLL/JobBoard/x",
        "https://clevelandresearch.applytojob.com/apply/zy7WHaTRsu/x",
      ]) {
        const accusers = extractOrgCandidates(url).filter((c) => c.accuser);
        for (const a of accusers) expect(a.value, url).not.toMatch(/\d/);
      }
    });

    it("harder — a WRONG tenant on the same board is still a mismatch (accusers keep their teeth)", () => {
      // The Schwab tenant offered for a Rivian job: "schwab" is a clean
      // 6-letter tenant label and must convict.
      const v = checkUrlCongruence(
        "Rivian",
        "https://career-schwab.icims.com/jobs/126227/technology-2027-intern---data-engineering/job",
      );
      expect(v.verdict, v.detail).toBe("mismatch");
      expect(v.slug).toBe("schwab");
      // And the Cohere trio from the original regression is untouched.
      expect(checkUrlCongruence("Postman", COHERE_URL).verdict).toBe("mismatch");
    });

    it("harder — initials-prefix only fires for a short slug that starts with 3+ initials", () => {
      expect(
        checkUrlCongruence("Barbacane, Thornton & Company", "https://btcpa.rec.pro.ukg.net/x").verdict,
      ).toBe("match");
      // "btc" prefix on a LONG unrelated word must not match.
      expect(
        checkUrlCongruence(
          "Barbacane, Thornton & Company",
          "https://btcparticipants.rec.pro.ukg.net/x",
        ).verdict,
      ).not.toBe("match");
    });
  });

  /**
   * Live gap 2026-08-12: four navigations resolved CORRECT employer URLs
   * and every one came back "no org slug decodable from URL (unsupported
   * host)" — the company name was in the hostname or the first path
   * segment the whole time. These are the exact four URLs.
   */
  describe("employer names outside the supported ATS shapes", () => {
    it("reads the employer off a multi-employer board's path", () => {
      const v = checkUrlCongruence(
        "Altamira Technologies Corporation",
        "https://jobs.jobvite.com/altamiracorps/job/oMqCAfw8/apply",
      );
      expect(v.verdict).toBe("match");
      expect(v.detail).toMatch(/from URL path/);
    });

    it("reads the employer off its own hostname", () => {
      expect(
        checkUrlCongruence(
          "Citadel",
          "https://www.citadel.com/careers/details/sector-data-scientist-2027-intern-us/",
        ).verdict,
      ).toBe("match");
    });

    it("does not lose a three-letter company to the TLD trim", () => {
      // careers.ibm.com — a naive "short second-to-last label is a country
      // SLD" rule eats "ibm", which is the case that matters most.
      const v = checkUrlCongruence(
        "IBM",
        "https://careers.ibm.com/en_US/careers/JobDetail?jobId=128497",
      );
      expect(v.verdict).toBe("match");
      expect(v.detail).toMatch(/from URL host/);
    });

    it("skips the board's own name and finds the employer deeper in the path", () => {
      // ycombinator.com is the board, effigov is the employer.
      const v = checkUrlCongruence(
        "EffiGov",
        "https://www.ycombinator.com/companies/effigov/jobs/7XpLidv-swe-intern",
      );
      expect(v.verdict).toBe("match");
      expect(v.slug).toBe("effigov");
    });

    it("still catches a leftover tab pointing at the WRONG employer", () => {
      // The failure this module exists for, now caught off-ATS too.
      const v = checkUrlCongruence(
        "IBM",
        "https://www.citadel.com/careers/details/sector-data-scientist/",
      );
      expect(v.verdict).toBe("mismatch");
      expect(v.detail).toMatch(/citadel/);
    });

    it("a supported-ATS slug still outranks host and path evidence", () => {
      // The ATS slug is authoritative: a miss there is a mismatch even
      // though other candidates exist in the URL.
      const v = checkUrlCongruence(
        "IBM",
        "https://jobs.ashbyhq.com/cohere/36d1f52f/application",
      );
      expect(v.verdict).toBe("mismatch");
      expect(v.slug).toBe("cohere");
    });

    it("page words are never treated as an employer name", () => {
      const cands = extractOrgCandidates(
        "https://careers.acme.com/en_US/jobs/apply/details/12345",
      ).map((c) => c.value);
      expect(cands).toContain("acme");
      for (const junk of ["careers", "enus", "jobs", "apply", "details"]) {
        expect(cands).not.toContain(junk);
      }
    });

    /**
     * The two URLs from the 2026-08-12T23:27 cycle — both resolved
     * correctly by navigation, both reported "no org slug decodable".
     */
    it("verifies the live Tesla and Gesture URLs that reported unverifiable", () => {
      expect(
        checkUrlCongruence(
          "Tesla",
          "https://www.tesla.com/careers/search/job/apply/279763",
        ).verdict,
      ).toBe("match");
      // Gusto's board hosts other companies: the employer is in the path,
      // and "gusto" must never be read as the employer here.
      expect(
        checkUrlCongruence(
          "Gesture",
          "https://jobs.gusto.com/postings/gesture-us-inc-full-stack-engineer-intern-e6b31003/applicants/new",
        ).verdict,
      ).toBe("match");
      // Same board, wrong job — still caught.
      expect(
        checkUrlCongruence(
          "Tesla",
          "https://jobs.gusto.com/postings/gesture-us-inc-full-stack-engineer-intern-e6b31003/applicants/new",
        ).verdict,
      ).toBe("mismatch");
    });

    it("country second-level domains drop both labels", () => {
      expect(
        checkUrlCongruence("Acme", "https://careers.acme.co.uk/jobs/1").verdict,
      ).toBe("match");
    });
  });

  it("greenhouse embed URLs decode the org from ?for=", () => {
    expect(
      extractOrgSlug("https://boards.greenhouse.io/embed/job_app?for=acme&token=1"),
    ).toBe("acme");
  });

  it("companyIdentity strips ®, keeps initials, extracts aliases", () => {
    const id = companyIdentity("Energy Systems Group (ESG) ®");
    expect(id.initials).toBe("esg");
    expect(id.aliases).toContain("esg");
    expect(id.tokens).toEqual(["energy", "systems", "group"]);
  });
});

describe("employer-URL audit + duplicate detection (UNIT_CONFIRMED)", () => {
  let dbPath: string;
  let db: Db;
  let artDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ["DATABASE_PATH", "ARTIFACTS_DIR"]) savedEnv[k] = process.env[k];
    resetConfigCache();
    dbPath = path.join(os.tmpdir(), `jaa-navaudit-${randomUUID()}.sqlite`);
    artDir = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-navaudit-art-"));
    process.env.DATABASE_PATH = dbPath;
    process.env.ARTIFACTS_DIR = artDir;
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(artDir, { recursive: true, force: true });
    resetConfigCache();
  });

  const seedApp = (company: string, employerUrl?: string): string => {
    const job = upsertJobByFingerprint(db, {
      jobrightJobId: `jr-${randomUUID().slice(0, 8)}`,
      applicationUrl: `https://jobright.ai/jobs/info/${randomUUID().slice(0, 12)}`,
      company,
      role: "Intern",
    });
    const appId = createApplication(db, { jobId: job.id }).id;
    if (employerUrl) setEmployerApplicationUrl(db, appId, employerUrl);
    return appId;
  };

  it("findApplicationsWithEmployerUrl sees other holders, not itself", () => {
    const url = "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application";
    const a = seedApp("Cohere", url);
    const b = seedApp("Postman");
    expect(findApplicationsWithEmployerUrl(db, url, b).map((d) => d.application_id)).toEqual([a]);
    expect(findApplicationsWithEmployerUrl(db, url, a)).toEqual([]);
  });

  it("query-string job ids distinguish postings — live MicroVention/Brassring regression 2026-09-05 (#171)", () => {
    // Three MicroVention roles on sjobs.brassring.com differ ONLY in the
    // query string (?...&jobid=NNNNNN). The old comparator stripped the
    // whole query, so every Brassring posting collapsed into one "URL"
    // and sibling roles parked as duplicates of each other.
    const base =
      "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=25987&siteid=5297&PageType=JobDetails";
    const supplyChain = seedApp("MicroVention-Terumo", `${base}&jobid=907868`);
    const manufacturing = seedApp("MicroVention-Terumo");
    // A DIFFERENT jobid is not a duplicate.
    expect(
      findApplicationsWithEmployerUrl(db, `${base}&jobid=907900`, manufacturing),
    ).toEqual([]);
    // The SAME jobid still is — even with reordered params, a fragment,
    // and tracking noise.
    const noisy = `https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?jobid=907868&PageType=JobDetails&siteid=5297&partnerid=25987&utm_source=jobright&gclid=abc123#apply`;
    expect(
      findApplicationsWithEmployerUrl(db, noisy, manufacturing).map(
        (d) => d.application_id,
      ),
    ).toEqual([supplyChain]);
  });

  it("dead siblings never block a URL — live IBM regression 2026-08-14", () => {
    // nav-74302483: an IBM app parked duplicate_url because its only
    // "holders" were a FAILED_FINAL and an UNSUPPORTED_ATS twin from
    // earlier JobRight re-listings — the one app that could still proceed
    // was the one that got blocked.
    const url = "https://ibmglobal.avature.net/en_US/careers/JobDetail?jobId=128526";
    const dead1 = seedApp("IBM", url);
    const dead2 = seedApp("IBM", url);
    const live = seedApp("IBM", url);
    const fresh = seedApp("IBM");
    db.prepare(`UPDATE applications SET state = 'FAILED_FINAL' WHERE id = ?`).run(dead1);
    db.prepare(`UPDATE applications SET state = 'UNSUPPORTED_ATS' WHERE id = ?`).run(dead2);
    // Only the live holder counts.
    expect(
      findApplicationsWithEmployerUrl(db, url, fresh).map((d) => d.application_id),
    ).toEqual([live]);
    // A SUBMITTED holder still blocks — that posting was really applied to.
    db.prepare(`UPDATE applications SET state = 'SUBMITTED' WHERE id = ?`).run(live);
    expect(findApplicationsWithEmployerUrl(db, url, fresh)).toHaveLength(1);
  });

  it("audit repairs the live poison shape: wrong-employer URL cleared, app re-navigates", () => {
    // Postman app wrongly holding Cohere's URL (the real bug).
    const poisoned = seedApp(
      "Postman",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );
    const healthy = seedApp(
      "Cohere",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );

    const report = auditEmployerUrls(db);
    expect(report.mismatches_found).toBe(1);
    expect(report.repaired).toBe(1);

    // Poisoned app: URL gone; it will re-navigate on its natural path.
    expect(getEmployerApplicationUrl(db, poisoned)).toBeNull();
    // The rightful owner keeps its URL untouched.
    expect(getEmployerApplicationUrl(db, healthy)).not.toBeNull();
  });

  it("audit parks duplicates: same congruent URL on two apps keeps the oldest", () => {
    const url = "https://jobs.lever.co/metr/52fca070-da6a-441e-b1d1-8184c51b52e6/apply";
    const first = seedApp("METR", url);
    const second = seedApp("METR", url);
    const report = auditEmployerUrls(db);
    expect(report.duplicates_parked).toBe(1);
    const items = listOpenReviewItems(db);
    const dupItem = items.find((i) => i.application_id === second);
    expect(dupItem?.title).toMatch(/Duplicate posting/);
    expect(items.some((i) => i.application_id === first)).toBe(false);
  });

  it("a FAILED_FINAL predecessor does not park a legal re-enqueue for the same URL", () => {
    // Re-discovery convention (2026-08-29): samsara re-enqueues were
    // re-parked every session by their own dead predecessors' URL claims.
    const url = "https://jobs.lever.co/metr/52fca070-da6a-441e-b1d1-8184c51b52e6/apply";
    const dead = seedApp("METR", url);
    db.prepare(`UPDATE applications SET state = 'FAILED_FINAL' WHERE id = ?`).run(dead);
    const fresh = seedApp("METR", url);
    const report = auditEmployerUrls(db);
    expect(report.duplicates_parked).toBe(0);
    expect(listOpenReviewItems(db).some((i) => i.application_id === fresh)).toBe(false);
  });

  it("a COMPLETED predecessor still parks a duplicate for the same URL", () => {
    const url = "https://jobs.lever.co/metr/62fca070-da6a-441e-b1d1-8184c51b52e7/apply";
    const done = seedApp("METR", url);
    db.prepare(`UPDATE applications SET state = 'COMPLETED' WHERE id = ?`).run(done);
    const dup = seedApp("METR", url);
    const report = auditEmployerUrls(db);
    expect(report.duplicates_parked).toBe(1);
    expect(
      listOpenReviewItems(db).find((i) => i.application_id === dup)?.title,
    ).toMatch(/Duplicate posting/);
  });

  it("audit never auto-repairs past submit — it parks for a human", () => {
    const appId = seedApp(
      "Postman",
      "https://jobs.ashbyhq.com/cohere/36d1f52f-8270-4652-adf5-5303a0ff341b/application",
    );
    // Walk the app to SUBMITTED via legal edges (raw SQL keeps the test
    // honest about guarding on state, not on how it got there).
    db.prepare(`UPDATE applications SET state = 'SUBMITTED' WHERE id = ?`).run(appId);

    const report = auditEmployerUrls(db);
    expect(report.repaired).toBe(0);
    expect(report.parked).toBe(1);
    // URL intentionally NOT cleared — evidence for the human.
    expect(getEmployerApplicationUrl(db, appId)).not.toBeNull();
    const item = listOpenReviewItems(db).find((i) => i.application_id === appId);
    expect(item?.title).toMatch(/needs human review/);
  });
});

describe("#91 brand abbreviations open long slugs", () => {
  it('"WD" matches tenant "westerndigital" as evidence; unrelated short tokens do not', async () => {
    const { checkUrlCongruence } = await import("../../src/navigation/congruence.js");
    const wd = checkUrlCongruence("WD", "https://westerndigital.wd1.myworkdayjobs.com/jobs/123");
    expect(wd.verdict).not.toBe("mismatch");
  });
});
