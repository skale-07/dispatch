import { describe, expect, it } from "vitest";
import {
  MAX_HOP_FETCHES,
  boardSlugCandidates,
  hopToEmployerBoard,
  isConsumerAggregatorUrl,
  matchBoardJob,
} from "../../src/navigation/employerBoardHop.js";
import type { BoardJob } from "../../src/discovery/atsBoards.js";

/**
 * #196 (live Coinbase 2026-09-08): JobRight's Apply popup landed on
 * linkedin.com/jobs/view — LinkedIn Easy Apply, an aggregator repost —
 * which was stored as the employer URL; the fill refused
 * NAVIGATION_INCOMPLETE and triage requeued into the same page. Coinbase's
 * public Greenhouse board lists the exact posting. The hop is read-only,
 * deterministic and bounded (UNIT_CONFIRMED; the live board shape is the
 * real payload recorded that night).
 */

const gh = (jobs: Array<{ id: number; title: string; location: string; url?: string }>) =>
  JSON.stringify({
    jobs: jobs.map((j) => ({
      id: j.id,
      title: j.title,
      location: { name: j.location },
      absolute_url: j.url ?? `https://www.coinbase.com/careers/positions/${j.id}?gh_jid=${j.id}`,
      updated_at: "2026-09-08T00:00:00Z",
    })),
  });

function fakeFetch(routes: Record<string, { status: number; body: string }>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const status = hit ? hit[1].status : 404;
    const body = hit ? hit[1].body : "";
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const job = (title: string, location: string | null, id = 1): BoardJob => ({
  ats: "greenhouse",
  board: "x",
  external_id: String(id),
  title,
  location,
  department: null,
  apply_url: `https://boards.greenhouse.io/x/jobs/${id}`,
  posted_at: null,
});

describe("aggregator → employer-board hop (#196, UNIT_CONFIRMED)", () => {
  it("names consumer aggregators, never ATS vendors or employer sites", () => {
    expect(isConsumerAggregatorUrl("https://www.linkedin.com/jobs/view/4464900528?jr_id=x")).toBe(true);
    expect(isConsumerAggregatorUrl("https://www.indeed.com/viewjob?jk=abc")).toBe(true);
    expect(isConsumerAggregatorUrl("https://boards.greenhouse.io/coinbase/jobs/8175462")).toBe(false);
    expect(isConsumerAggregatorUrl("https://www.coinbase.com/careers/positions/8175462")).toBe(false);
    expect(isConsumerAggregatorUrl("https://jobs.lever.co/acme/1")).toBe(false);
    expect(isConsumerAggregatorUrl("not a url")).toBe(false);
  });

  it("derives bounded board slugs from the company name", () => {
    expect(boardSlugCandidates("Coinbase")).toEqual(["coinbase"]);
    expect(boardSlugCandidates("Jump Trading, LLC")).toEqual(["jumptrading", "jump-trading", "jump"]);
    expect(boardSlugCandidates("The Co.")).toEqual(["the"]);
    expect(boardSlugCandidates("")).toEqual([]);
    expect(boardSlugCandidates("Databricks Inc.")).toEqual(["databricks"]);
  });

  it("matches the role by exact title, tie-breaks by location, refuses ambiguity", () => {
    const one = matchBoardJob([job("Data Science Intern", "Hybrid - San Francisco, CA")], {
      role: "Data Science Intern",
      location: "San Francisco, CA",
    });
    expect(one.job?.title).toBe("Data Science Intern");
    expect((one as { basis: string }).basis).toBe("exact title");

    const tie = matchBoardJob(
      [job("Software Engineer", "New York, NY", 1), job("Software Engineer", "Seattle, WA", 2)],
      { role: "Software Engineer", location: "Seattle, Washington" },
    );
    expect(tie.job?.external_id).toBe("2");

    const ambiguous = matchBoardJob(
      [job("Software Engineer", "New York, NY", 1), job("Software Engineer", "Seattle, WA", 2)],
      { role: "Software Engineer", location: "Chicago, IL" },
    );
    expect(ambiguous.job).toBeNull();
    expect((ambiguous as { reason: string }).reason).toMatch(/ambiguous/);

    const contains = matchBoardJob(
      [job("Data Science Intern (Summer 2027)", "Remote", 3), job("Platform Engineer", "Remote", 4)],
      { role: "Data Science Intern", location: null },
    );
    expect(contains.job?.external_id).toBe("3");

    const none = matchBoardJob([job("Platform Engineer", "Remote", 4)], {
      role: "Data Science Intern",
      location: null,
    });
    expect(none.job).toBeNull();
  });

  it("Coinbase shape: LinkedIn repost → the posting on boards-api.greenhouse.io", async () => {
    const { impl, calls } = fakeFetch({
      "boards-api.greenhouse.io/v1/boards/coinbase/jobs": {
        status: 200,
        body: gh([
          { id: 8175462, title: "Data Science Intern", location: "Hybrid - San Francisco, CA" },
          { id: 8000001, title: "Software Engineer, Backend", location: "Remote - USA" },
        ]),
      },
    });
    const r = await hopToEmployerBoard({
      company: "Coinbase",
      role: "Data Science Intern",
      location: "San Francisco, CA",
      fetchImpl: impl,
      hostIntervalMs: 0,
    });
    expect(r.hit?.url).toBe("https://www.coinbase.com/careers/positions/8175462?gh_jid=8175462");
    expect(r.hit?.ats).toBe("greenhouse");
    expect(r.hit?.external_id).toBe("8175462");
    expect(r.fetches).toBe(1);
    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/coinbase/jobs"]);
    expect(r.notes.join(" ")).toMatch(/employer's own route taken over the aggregator/);
  });

  it("no board anywhere ⇒ null with the reasons, never more than the request cap", async () => {
    const { impl, calls } = fakeFetch({});
    const r = await hopToEmployerBoard({
      company: "Jump Trading",
      role: "Quant Intern",
      location: null,
      fetchImpl: impl,
      hostIntervalMs: 0,
    });
    expect(r.hit).toBeNull();
    expect(calls.length).toBeLessThanOrEqual(MAX_HOP_FETCHES);
    expect(r.notes.at(-1)).toMatch(/no public greenhouse\/lever\/ashby board found for "Jump Trading"/);
  });

  it("a board that answers but lacks the role stops that ATS and moves on; ambiguity is refused", async () => {
    const { impl, calls } = fakeFetch({
      "boards-api.greenhouse.io/v1/boards/acme/jobs": {
        status: 200,
        body: gh([
          { id: 1, title: "Software Engineer", location: "New York, NY", url: "https://boards.greenhouse.io/acme/jobs/1" },
          { id: 2, title: "Software Engineer", location: "Austin, TX", url: "https://boards.greenhouse.io/acme/jobs/2" },
        ]),
      },
    });
    const r = await hopToEmployerBoard({
      company: "Acme",
      role: "Software Engineer",
      location: "Chicago, IL",
      fetchImpl: impl,
      hostIntervalMs: 0,
    });
    expect(r.hit).toBeNull();
    expect(r.notes.join(" ")).toMatch(/2 postings titled "Software Engineer".*ambiguous/);
    // Greenhouse answered for "acme": the other greenhouse slug spellings are
    // not retried; lever and ashby still get their turn.
    expect(calls.filter((c) => c.includes("greenhouse")).length).toBe(1);
    expect(calls.some((c) => c.includes("api.lever.co"))).toBe(true);
    expect(calls.some((c) => c.includes("api.ashbyhq.com"))).toBe(true);
  });

  it("refuses a matched posting whose URL names a different company", async () => {
    const { impl } = fakeFetch({
      "boards-api.greenhouse.io/v1/boards/apple/jobs": {
        status: 200,
        body: gh([
          { id: 9, title: "Data Science Intern", location: "Cupertino, CA", url: "https://www.orangeworks.com/careers/9" },
        ]),
      },
    });
    const r = await hopToEmployerBoard({
      company: "Apple",
      role: "Data Science Intern",
      location: "Cupertino, CA",
      fetchImpl: impl,
      hostIntervalMs: 0,
    });
    expect(r.hit).toBeNull();
    expect(r.notes.join(" ")).toMatch(/names "orangeworks", not Apple — refused/);
  });

  it("no company or role on record ⇒ no requests at all", async () => {
    const { impl, calls } = fakeFetch({});
    const r = await hopToEmployerBoard({ company: null, role: "X", location: null, fetchImpl: impl, hostIntervalMs: 0 });
    expect(r.hit).toBeNull();
    expect(calls).toEqual([]);
  });
});
