import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  boardEndpoint,
  fetchBoardJobs,
  filterBoardJobs,
  parseAtsBoardRef,
  parseBoardPayload,
  type AtsBoardRef,
  type BoardFetchResult,
} from "../../src/discovery/atsBoards.js";
import {
  loadBoardRegistry,
  runAtsBoardDiscovery,
  type BoardRegistryEntry,
} from "../../src/discovery/atsDiscovery.js";
import {
  closeDatabase,
  migrate,
  openDatabase,
  type Db,
} from "../../src/storage/db/client.js";
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import {
  applyControlledFillEnv,
  useIsolatedFillEnv,
} from "../helpers/fillEnvIsolation.js";

/**
 * D-rev: discovery from the ATSes' own public board APIs. Parsers are
 * pinned against each vendor's real payload shape; the enqueue sweep runs
 * against a temp SQLite with a stubbed fetch — no network, no ambient
 * flags. UNIT_CONFIRMED.
 */

const GH: AtsBoardRef = { ats: "greenhouse", token: "appian" };

describe("parseAtsBoardRef (UNIT_CONFIRMED)", () => {
  it("reads ats:token refs and public board URLs", () => {
    expect(parseAtsBoardRef("greenhouse:appian")).toEqual(GH);
    expect(parseAtsBoardRef("LEVER:Acme")).toEqual({ ats: "lever", token: "acme" });
    expect(
      parseAtsBoardRef("https://job-boards.greenhouse.io/appian/jobs/8041237"),
    ).toEqual(GH);
    expect(parseAtsBoardRef("https://jobs.lever.co/acme")).toEqual({
      ats: "lever",
      token: "acme",
    });
    expect(parseAtsBoardRef("https://jobs.ashbyhq.com/notion")).toEqual({
      ats: "ashby",
      token: "notion",
    });
    expect(parseAtsBoardRef("https://apply.workable.com/acme/j/ABC123/")).toEqual({
      ats: "workable",
      token: "acme",
    });
  });

  it("refuses what it cannot key on", () => {
    expect(parseAtsBoardRef("")).toBeNull();
    expect(parseAtsBoardRef("workday:acme")).toBeNull();
    expect(parseAtsBoardRef("greenhouse:")).toBeNull();
    expect(parseAtsBoardRef("greenhouse:has spaces")).toBeNull();
    expect(parseAtsBoardRef("https://boards.greenhouse.io/embed/job_app")).toBeNull();
    expect(parseAtsBoardRef("https://example.com/acme")).toBeNull();
  });

  it("endpoints hit only the vendors' public APIs", () => {
    expect(boardEndpoint(GH)).toBe(
      "https://boards-api.greenhouse.io/v1/boards/appian/jobs",
    );
    expect(boardEndpoint({ ats: "lever", token: "acme" })).toBe(
      "https://api.lever.co/v0/postings/acme?mode=json",
    );
    expect(boardEndpoint({ ats: "ashby", token: "notion" })).toBe(
      "https://api.ashbyhq.com/posting-api/job-board/notion",
    );
    expect(boardEndpoint({ ats: "workable", token: "acme" })).toBe(
      "https://apply.workable.com/api/v1/widget/accounts/acme",
    );
  });
});

describe("parseBoardPayload (UNIT_CONFIRMED)", () => {
  it("greenhouse: jobs[] with absolute_url + location.name", () => {
    const jobs = parseBoardPayload(GH, {
      jobs: [
        {
          id: 8041237,
          title: "Solution Engineer Intern",
          absolute_url: "https://job-boards.greenhouse.io/appian/jobs/8041237",
          location: { name: "McLean, VA" },
          updated_at: "2026-08-01T00:00:00Z",
          departments: [{ name: "Engineering" }],
        },
        { title: "No URL, dropped" },
      ],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      ats: "greenhouse",
      board: "appian",
      external_id: "8041237",
      title: "Solution Engineer Intern",
      location: "McLean, VA",
      department: "Engineering",
      apply_url: "https://job-boards.greenhouse.io/appian/jobs/8041237",
    });
  });

  it("lever: top-level array; applyUrl preferred, hostedUrl/apply fallback", () => {
    const ref: AtsBoardRef = { ats: "lever", token: "acme" };
    const jobs = parseBoardPayload(ref, [
      {
        id: "a1",
        text: "Software Engineer Intern",
        hostedUrl: "https://jobs.lever.co/acme/a1",
        categories: { location: "NYC", team: "Platform" },
        createdAt: 1754006400000,
      },
      {
        id: "a2",
        text: "SRE",
        applyUrl: "https://jobs.lever.co/acme/a2/apply",
        categories: {},
      },
    ]);
    expect(jobs[0]?.apply_url).toBe("https://jobs.lever.co/acme/a1/apply");
    expect(jobs[0]?.department).toBe("Platform");
    expect(jobs[0]?.posted_at).toMatch(/^2025|^2026/);
    expect(jobs[1]?.apply_url).toBe("https://jobs.lever.co/acme/a2/apply");
  });

  it("ashby: unlisted postings never surface", () => {
    const ref: AtsBoardRef = { ats: "ashby", token: "notion" };
    const jobs = parseBoardPayload(ref, {
      jobs: [
        {
          id: "j1",
          title: "Product Engineer",
          jobUrl: "https://jobs.ashbyhq.com/notion/j1",
          applyUrl: "https://jobs.ashbyhq.com/notion/j1/application",
          location: "SF",
          isListed: true,
        },
        {
          id: "j2",
          title: "Hidden role",
          jobUrl: "https://jobs.ashbyhq.com/notion/j2",
          isListed: false,
        },
      ],
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.apply_url).toBe("https://jobs.ashbyhq.com/notion/j1/application");
  });

  it("workable: widget jobs get a real apply URL from url or shortcode", () => {
    const ref: AtsBoardRef = { ats: "workable", token: "acme" };
    const jobs = parseBoardPayload(ref, {
      name: "Acme",
      jobs: [
        {
          title: "Data Intern",
          shortcode: "AB12CD",
          url: "https://apply.workable.com/acme/j/AB12CD",
          city: "Berlin",
          country: "Germany",
          department: "Data",
          published_on: "2026-08-10",
        },
        { title: "Shortcode only", shortcode: "ZZ99" },
      ],
    });
    expect(jobs[0]?.apply_url).toBe("https://apply.workable.com/acme/j/AB12CD/apply/");
    expect(jobs[0]?.location).toBe("Berlin, Germany");
    expect(jobs[1]?.apply_url).toBe("https://apply.workable.com/acme/j/ZZ99/apply/");
  });

  it("never throws on unrecognized shapes", () => {
    expect(parseBoardPayload(GH, null)).toEqual([]);
    expect(parseBoardPayload(GH, { jobs: "nope" })).toEqual([]);
    expect(parseBoardPayload({ ats: "lever", token: "x" }, { not: "array" })).toEqual([]);
  });

  it("fetch is fail-open: non-200 and thrown errors become per-board results", async () => {
    const notFound = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    const r1 = await fetchBoardJobs(GH, { fetchImpl: notFound, hostIntervalMs: 0 });
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain("404");
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r2 = await fetchBoardJobs(GH, { fetchImpl: boom, hostIntervalMs: 0 });
    expect(r2.ok).toBe(false);
    expect(r2.jobs).toEqual([]);
  });
});

describe("filterBoardJobs (UNIT_CONFIRMED)", () => {
  const job = (title: string) => ({
    ats: "greenhouse" as const,
    board: "b",
    external_id: null,
    title,
    location: null,
    department: null,
    apply_url: "https://boards.greenhouse.io/b/jobs/1",
    posted_at: null,
  });

  it("include keeps any match, exclude wins, empty include keeps all", () => {
    const jobs = [job("Software Engineer Intern"), job("Senior SWE"), job("Data Intern")];
    const out = filterBoardJobs(jobs, { include: ["intern"], exclude: ["senior"] });
    expect(out.kept.map((j) => j.title)).toEqual([
      "Software Engineer Intern",
      "Data Intern",
    ]);
    expect(out.dropped).toBe(1);
    expect(filterBoardJobs(jobs, { include: [], exclude: [] }).kept).toHaveLength(3);
    expect(
      filterBoardJobs([job("Senior Intern")], {
        include: ["intern"],
        exclude: ["senior"],
      }).kept,
    ).toEqual([]);
  });

  it("matches on word boundaries — intern is not Internal (live 2026-08-28)", () => {
    const jobs = [
      job("Internal Audit Data Analytics Lead"),
      job("International Accounting Lead"),
      job("Software Engineer, Intern (Summer)"),
      job("Intern - Data Platform"),
      job("Software Engineering Internship"),
    ];
    const out = filterBoardJobs(jobs, { include: ["intern"], exclude: [] });
    expect(out.kept.map((j) => j.title)).toEqual([
      "Software Engineer, Intern (Summer)",
      "Intern - Data Platform",
    ]);
    // Strict boundaries both ends: "internship" is its own term.
    expect(
      filterBoardJobs(jobs, { include: ["internship"], exclude: [] }).kept.map(
        (j) => j.title,
      ),
    ).toEqual(["Software Engineering Internship"]);
    // Exclude uses the same boundary rule.
    expect(
      filterBoardJobs([job("Senior Engineer"), job("Seniority Model Analyst")], {
        include: [],
        exclude: ["senior"],
      }).kept.map((j) => j.title),
    ).toEqual(["Seniority Model Analyst"]);
  });
});

describe("loadBoardRegistry (UNIT_CONFIRMED)", () => {
  it("reads entries, defaults company to the token, reports bad refs", () => {
    const p = path.join(os.tmpdir(), `jaa-boards-${randomUUID()}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify({
        boards: [
          { ref: "greenhouse:appian", company: "Appian", include: ["intern"] },
          { ref: "lever:acme" },
          { ref: "workday:nope" },
        ],
      }),
    );
    try {
      const loaded = loadBoardRegistry(p);
      expect(loaded.entries).toHaveLength(2);
      expect(loaded.entries[0]).toMatchObject({
        company: "Appian",
        include: ["intern"],
        exclude: [],
      });
      expect(loaded.entries[1]?.company).toBe("acme");
      expect(loaded.errors.join(" ")).toContain("workday:nope");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("an unreadable or shapeless file is errors, not a throw", () => {
    expect(loadBoardRegistry("/nope/missing.json").errors[0]).toContain("unreadable");
    const p = path.join(os.tmpdir(), `jaa-boards-${randomUUID()}.json`);
    fs.writeFileSync(p, JSON.stringify({ nope: [] }));
    try {
      expect(loadBoardRegistry(p).errors[0]).toContain('no "boards" array');
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("runAtsBoardDiscovery (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `jaa-disc-${randomUUID()}.sqlite`);
    db = openDatabase(dbPath);
    migrate(db);
  });

  afterEach(() => {
    closeDatabase(db);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  const entry = (over?: Partial<BoardRegistryEntry>): BoardRegistryEntry => ({
    ref: GH,
    company: "Appian",
    include: [],
    exclude: [],
    ...over,
  });

  const stubFetch =
    (jobs: Array<{ title: string; url: string }>) =>
    async (ref: AtsBoardRef): Promise<BoardFetchResult> => ({
      ref,
      ok: true,
      jobs: jobs.map((j, i) => ({
        ats: ref.ats,
        board: ref.token,
        external_id: String(i + 1),
        title: j.title,
        location: null,
        department: null,
        apply_url: j.url,
        posted_at: null,
      })),
      error: null,
    });

  // #209 (day28): `include: ["intern"]` alone let one board enqueue nine
  // finance/ops internships; the registry-wide role gate is ANDed on top.
  it("role terms are ANDed after include/exclude; a per-board cap leaves room for later boards", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const jobsFor = (token: string, titles: string[]) =>
      titles.map((t, i) => ({ title: t, url: `https://job-boards.greenhouse.io/${token}/jobs/${i + 1}` }));
    const deps = {
      fetchBoard: async (ref: AtsBoardRef): Promise<BoardFetchResult> => {
        const titles =
          ref.token === "appian"
            ? ["Accounting Intern", "Software Engineer Intern", "Data Science Intern", "FP&A Intern", "Machine Learning Engineer Intern"]
            : ["Backend Engineer Intern", "Credit Risk Intern"];
        return (await stubFetch(jobsFor(ref.token, titles))(ref));
      },
    };
    const second: BoardRegistryEntry = {
      ref: { ats: "greenhouse", token: "acme" },
      company: "Acme",
      include: ["intern"],
      exclude: [],
    };
    const report = await runAtsBoardDiscovery({
      db,
      entries: [entry({ include: ["intern"] }), second],
      roleTerms: ["software", "engineer", "data", "machine learning"],
      maxNewPerBoard: 2,
      maxNewApplications: 10,
      deps,
    });
    const enqueued = report.applications.filter((a) => a.outcome === "enqueued").map((a) => `${a.company}:${a.role}`);
    // Appian: 3 role-fit titles, capped at 2; Acme: its 1 role-fit title still lands.
    expect(enqueued).toEqual([
      "Appian:Software Engineer Intern",
      "Appian:Data Science Intern",
      "Acme:Backend Engineer Intern",
    ]);
    expect(report.applications.filter((a) => a.outcome === "capped").map((a) => a.detail)).toEqual([
      "per-board cap (2) reached — next sweep continues",
    ]);
    // Finance/ops titles never reached the queue.
    expect(report.boards.map((b) => [b.company, b.filtered_out])).toEqual([["Appian", 2], ["Acme", 1]]);
    expect(report.notes.join(" ")).toMatch(/greenhouse:appian: 2 posting\(s\) outside role terms skipped/);
  });

  it("registry top-level role_terms / max_new_per_board are parsed; absent = no gate", () => {
    const p = path.join(os.tmpdir(), `jaa-reg-${randomUUID()}.json`);
    fs.writeFileSync(
      p,
      JSON.stringify({
        role_terms: ["software", " data ", 7, ""],
        max_new_per_board: 3.7,
        boards: [{ ref: "greenhouse:appian", company: "Appian", include: ["intern"] }],
      }),
    );
    try {
      const loaded = loadBoardRegistry(p);
      expect(loaded.roleTerms).toEqual(["software", " data "]);
      expect(loaded.maxNewPerBoard).toBe(3);
      fs.writeFileSync(p, JSON.stringify({ boards: [] }));
      const bare = loadBoardRegistry(p);
      expect(bare.roleTerms).toEqual([]);
      expect(bare.maxNewPerBoard).toBeNull();
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("refuses when ATS_DISCOVERY_ENABLED is off — fail closed", async () => {
    await expect(
      runAtsBoardDiscovery({
        db,
        entries: [entry()],
        deps: {
          fetchBoard: async () => {
            throw new Error("must not fetch");
          },
        },
      }),
    ).rejects.toThrow(/ATS_DISCOVERY_ENABLED/);
  });

  it("enqueues to QUEUED with employer URL provenance; a re-run reuses, never duplicates", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const deps = {
      fetchBoard: stubFetch([
        {
          title: "Solutions Intern",
          url: "https://job-boards.greenhouse.io/appian/jobs/111",
        },
        {
          title: "Senior Staff Architect",
          url: "https://job-boards.greenhouse.io/appian/jobs/222",
        },
      ]),
    };
    const first = await runAtsBoardDiscovery({
      db,
      entries: [entry({ include: ["intern"] })],
      deps,
    });
    expect(first.boards[0]).toMatchObject({
      ref: "greenhouse:appian",
      ok: true,
      fetched: 2,
      filtered_out: 1,
      considered: 1,
    });
    expect(first.enqueued).toBe(1);
    const app = first.applications[0]!;
    expect(app.outcome).toBe("enqueued");
    expect(app.state).toBe("QUEUED");
    expect(getApplication(db, app.application_id!)?.state).toBe("QUEUED");

    const jobRow = db
      .prepare(
        `SELECT j.company, j.role, j.source_ats, j.raw_json FROM jobs j
         JOIN applications a ON a.job_id = j.id WHERE a.id = ?`,
      )
      .get(app.application_id) as {
      company: string;
      role: string;
      source_ats: string;
      raw_json: string;
    };
    expect(jobRow.company).toBe("Appian");
    expect(jobRow.role).toBe("Solutions Intern");
    expect(jobRow.source_ats).toBe("greenhouse");
    const raw = JSON.parse(jobRow.raw_json) as Record<string, unknown>;
    expect(raw["source"]).toBe("ats_board_discovery");
    expect(raw["employer_application_ats"]).toBe("greenhouse");
    expect(String(raw["employer_application_url"])).toContain("appian/jobs/111");

    const second = await runAtsBoardDiscovery({
      db,
      entries: [entry({ include: ["intern"] })],
      deps,
    });
    expect(second.enqueued).toBe(0);
    expect(second.reused).toBe(1);
    expect(second.applications[0]?.application_id).toBe(app.application_id);
  });

  it("a posting already submitted through JobRight is blocked, and a live JobRight twin is reused (2026-09-08 Databricks)", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    // JobRight-sourced job: keyed on the card URL, employer URL only in raw_json.
    const seed = (jobrightId: string, employerUrl: string, state: "COMPLETED" | "QUEUED") => {
      const job = upsertJobByFingerprint(db, {
        jobrightJobId: jobrightId,
        applicationUrl: `https://jobright.ai/jobs/info/${jobrightId}`,
        company: "Appian",
        role: "Solutions Intern",
        raw: { employer_application_url: employerUrl },
      });
      return createApplication(db, { jobId: job.id, state });
    };
    const done = seed("jr-done", "https://boards.greenhouse.io/appian/jobs/111", "COMPLETED");
    const live = seed("jr-live", "https://boards.greenhouse.io/appian/jobs/333", "QUEUED");
    const out = await runAtsBoardDiscovery({
      db,
      entries: [entry({ include: ["intern"] })],
      deps: {
        fetchBoard: stubFetch([
          { title: "Solutions Intern", url: "https://job-boards.greenhouse.io/appian/jobs/111" },
          { title: "Solutions Intern", url: "https://job-boards.greenhouse.io/appian/jobs/333" },
          { title: "Platform Intern", url: "https://job-boards.greenhouse.io/appian/jobs/444" },
        ]),
      },
    });
    expect(out.enqueued).toBe(1);
    expect(out.blocked).toBe(1);
    expect(out.reused).toBe(1);
    const byUrl = Object.fromEntries(out.applications.map((a) => [a.apply_url, a]));
    expect(byUrl["https://job-boards.greenhouse.io/appian/jobs/111"]).toMatchObject({
      outcome: "blocked",
      application_id: done.id,
      state: "COMPLETED",
    });
    expect(byUrl["https://job-boards.greenhouse.io/appian/jobs/333"]).toMatchObject({
      outcome: "reused",
      application_id: live.id,
      state: "QUEUED",
    });
    expect(byUrl["https://job-boards.greenhouse.io/appian/jobs/444"]?.outcome).toBe("enqueued");
    // No second application row for the submitted posting.
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM applications`).get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it("US only: non-US postings are skipped and named; unknown locations still enqueue (2026-09-07 directive)", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const out = await runAtsBoardDiscovery({
      db,
      entries: [entry({ ref: { ats: "greenhouse", token: "stripe" }, company: "Stripe", include: ["intern"] })],
      deps: {
        fetchBoard: async (ref) => ({
          ref,
          ok: true,
          error: null,
          jobs: [
            { title: "Software Engineer, Intern", location: "Dublin", url: "https://boards.greenhouse.io/stripe/jobs/8097801" },
            { title: "Software Engineer, Intern", location: "Toronto", url: "https://boards.greenhouse.io/stripe/jobs/8130805" },
            { title: "Software Engineer, Intern", location: "Bengaluru", url: "https://boards.greenhouse.io/stripe/jobs/8031833" },
            { title: "Software Engineer, Intern", location: "Seattle, WA", url: "https://boards.greenhouse.io/stripe/jobs/9000001" },
            { title: "Software Engineer, Intern", location: "Remote", url: "https://boards.greenhouse.io/stripe/jobs/9000002" },
            { title: "Software Engineer, Intern", location: null, url: "https://boards.greenhouse.io/stripe/jobs/9000003" },
          ].map((j, i) => ({
            ats: ref.ats,
            board: ref.token,
            external_id: String(i + 1),
            title: j.title,
            location: j.location,
            department: null,
            apply_url: j.url,
            posted_at: null,
          })),
        }),
      },
    });
    expect(out.boards[0]).toMatchObject({ fetched: 6, filtered_out: 3, considered: 3 });
    expect(out.enqueued).toBe(3);
    expect(out.applications.map((a) => a.apply_url).sort()).toEqual([
      "https://boards.greenhouse.io/stripe/jobs/9000001",
      "https://boards.greenhouse.io/stripe/jobs/9000002",
      "https://boards.greenhouse.io/stripe/jobs/9000003",
    ]);
    expect(out.notes.join("\n")).toMatch(/3 non-US posting\(s\) skipped/);
    expect(out.notes.join("\n")).toMatch(/Dublin/);
  });

  it("caps new applications and marks the overflow, not silently", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const report = await runAtsBoardDiscovery({
      db,
      entries: [entry()],
      maxNewApplications: 2,
      deps: {
        fetchBoard: stubFetch(
          [1, 2, 3, 4].map((n) => ({
            title: `Role ${n}`,
            url: `https://job-boards.greenhouse.io/appian/jobs/${n}`,
          })),
        ),
      },
    });
    expect(report.enqueued).toBe(2);
    expect(report.capped).toBe(2);
    expect(
      report.applications.filter((a) => a.outcome === "capped")[0]?.detail,
    ).toContain("cap (2) reached");
  });

  it("a board posting older than 24h is skipped as stale, never enqueued (#199 on the board side)", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const old = new Date(Date.now() - 30 * 36e5).toISOString();
    const recent = new Date(Date.now() - 2 * 36e5).toISOString();
    const report = await runAtsBoardDiscovery({
      db,
      entries: [entry()],
      deps: {
        fetchBoard: async (ref) => ({
          ref,
          ok: true,
          error: null,
          jobs: [
            { title: "Old Intern", url: "https://job-boards.greenhouse.io/appian/jobs/1", posted: old },
            { title: "New Intern", url: "https://job-boards.greenhouse.io/appian/jobs/2", posted: recent },
            { title: "Undated Intern", url: "https://job-boards.greenhouse.io/appian/jobs/3", posted: null },
          ].map((j, i) => ({
            ats: ref.ats,
            board: ref.token,
            external_id: String(i + 1),
            title: j.title,
            location: null,
            department: null,
            apply_url: j.url,
            posted_at: j.posted,
          })),
        }),
      },
    });
    expect(report.enqueued).toBe(2);
    expect(report.stale).toBe(1);
    expect(report.boards[0]?.stale).toBe(1);
    const staleRow = report.applications.find((a) => a.outcome === "stale");
    expect(staleRow?.role).toBe("Old Intern");
    expect(staleRow?.detail).toMatch(/published 30h ago \(> 24h/);
    expect(report.notes.join("\n")).toMatch(/1 posting\(s\) older than 24h skipped/);
    expect(db.prepare(`SELECT COUNT(*) c FROM jobs`).get()).toMatchObject({ c: 2 });
  });

  it("an apply URL that fails ATS validation is rejected, named, and not enqueued", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const report = await runAtsBoardDiscovery({
      db,
      entries: [entry()],
      deps: {
        fetchBoard: stubFetch([
          { title: "Evil", url: "https://greenhouse.io.evil.test/x/jobs/1" },
        ]),
      },
    });
    expect(report.enqueued).toBe(0);
    expect(report.applications[0]?.outcome).toBe("rejected_url");
    expect(db.prepare(`SELECT COUNT(*) c FROM jobs`).get()).toMatchObject({ c: 0 });
  });

  it("canonicalizes company-hosted greenhouse embeds via gh_jid (live 2026-08-28: stripe/databricks)", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const boardJob = (over: { external_id: string | null; url: string; title: string }) => ({
      ats: "greenhouse" as const,
      board: "appian",
      external_id: over.external_id,
      title: over.title,
      location: null,
      department: null,
      apply_url: over.url,
      posted_at: null,
    });
    const report = await runAtsBoardDiscovery({
      db,
      entries: [entry()],
      deps: {
        fetchBoard: async (ref) => ({
          ref,
          ok: true,
          error: null,
          jobs: [
            boardJob({
              external_id: "8031833",
              title: "Software Engineer, Intern",
              url: "https://stripe.example/jobs/search?gh_jid=8031833",
            }),
            boardJob({
              // gh_jid disagreeing with the payload's own id stays refused.
              external_id: "999",
              title: "Mismatched",
              url: "https://stripe.example/jobs/search?gh_jid=123",
            }),
            boardJob({
              // No gh_jid — the original anomaly path, still refused.
              external_id: "777",
              title: "Anomalous",
              url: "https://stripe.example/jobs/search",
            }),
          ],
        }),
      },
    });
    expect(report.enqueued).toBe(1);
    expect(report.applications.map((a) => a.outcome)).toEqual([
      "enqueued",
      "rejected_url",
      "rejected_url",
    ]);
    const app = report.applications[0]!;
    const jobRow = db
      .prepare(
        `SELECT j.raw_json FROM jobs j JOIN applications a ON a.job_id = j.id
         WHERE a.id = ?`,
      )
      .get(app.application_id) as { raw_json: string };
    const raw = JSON.parse(jobRow.raw_json) as Record<string, unknown>;
    // The pipeline navigates to the vendor-hosted form, never the company page.
    expect(String(raw["employer_application_url"])).toContain(
      "greenhouse.io/appian/jobs/8031833",
    );
  });

  it("a failed board is reported and the sweep continues", async () => {
    applyControlledFillEnv({ ATS_DISCOVERY_ENABLED: "true" });
    const report = await runAtsBoardDiscovery({
      db,
      entries: [
        entry(),
        entry({ ref: { ats: "lever", token: "acme" }, company: "Acme" }),
      ],
      deps: {
        fetchBoard: async (ref) =>
          ref.ats === "greenhouse"
            ? { ref, ok: false, jobs: [], error: "HTTP 404" }
            : stubFetch([
                {
                  title: "Intern",
                  url: "https://jobs.lever.co/acme/f9c95dbc-4a8b-4237-9d18-8fb4b9d67302/apply",
                },
              ])(ref),
      },
    });
    expect(report.boards[0]?.ok).toBe(false);
    expect(report.boards[1]?.ok).toBe(true);
    expect(report.enqueued).toBe(1);
  });
});
