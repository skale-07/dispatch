import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  buildApplyQuery,
  classifyRestProbe,
  EXPECTED_BUCKETS,
  EXPECTED_RPCS,
  EXPECTED_TABLES,
  EXPECTED_VIEWS,
  RPC_PROBE_ARGS,
  listMigrationFiles,
  MANAGEMENT_API_BASE,
  managementQuery,
  parseMigrationFilename,
  probeSchema,
  projectRefFromUrl,
  type FetchLike,
} from "../../src/cloud/schema.js";

const REPO_MIGRATIONS = path.resolve(__dirname, "..", "..", "supabase", "migrations");

type Call = { url: string; method: string; body?: string; auth?: string };

function fakeFetch(
  respond: (url: string, init?: { method?: string; body?: string }) => {
    status: number;
    body: string;
  },
  calls: Call[] = [],
): { fetch: FetchLike; calls: Call[] } {
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { body: init.body } : {}),
      ...(init?.headers?.["Authorization"] !== undefined
        ? { auth: init.headers["Authorization"] }
        : {}),
    });
    const r = respond(url, init);
    return { status: r.status, text: async () => r.body };
  };
  return { fetch, calls };
}

describe("cloud schema tooling (UNIT_CONFIRMED)", () => {
  it("parses migration filenames and rejects everything else", () => {
    expect(parseMigrationFilename("20260901000100_invites_users_waitlist.sql")).toEqual({
      version: "20260901000100",
      name: "invites_users_waitlist",
    });
    expect(parseMigrationFilename("README.md")).toBeNull();
    expect(parseMigrationFilename("2026_notes.sql")).toBeNull();
  });

  it("lists the repo migrations in version order and every expected object is named in them", () => {
    const files = listMigrationFiles(REPO_MIGRATIONS);
    expect(files.length).toBeGreaterThanOrEqual(5);
    const versions = files.map((f) => f.version);
    expect([...versions].sort()).toEqual(versions);
    const sql = files.map((f) => fs.readFileSync(f.path, "utf8")).join("\n");
    for (const t of EXPECTED_TABLES) expect(sql).toMatch(new RegExp(`create table public\\.${t}\\b`));
    for (const v of EXPECTED_VIEWS) expect(sql).toMatch(new RegExp(`create view public\\.${v}\\b`));
    for (const fn of EXPECTED_RPCS) expect(sql).toMatch(new RegExp(`function public\\.${fn}\\(`));
    for (const b of EXPECTED_BUCKETS) expect(sql).toContain(`('${b}', '${b}', false)`);
  });

  it("extracts the project ref from a Supabase URL only", () => {
    expect(projectRefFromUrl("https://qqcmgsoscbvcivlhtlgc.supabase.co")).toBe(
      "qqcmgsoscbvcivlhtlgc",
    );
    expect(projectRefFromUrl("https://qqcmgsoscbvcivlhtlgc.supabase.co/")).toBe(
      "qqcmgsoscbvcivlhtlgc",
    );
    expect(projectRefFromUrl("http://127.0.0.1:54321")).toBeNull();
    expect(projectRefFromUrl("https://evil.example/qqcmgsoscbvcivlhtlgc.supabase.co")).toBeNull();
  });

  it("classifies PostgREST answers: 2xx present, PGRST205/202 absent, refused-but-defined present", () => {
    expect(classifyRestProbe(200, "[]")).toBe("present");
    expect(classifyRestProbe(404, '{"code":"PGRST205","message":"Could not find the table"}')).toBe(
      "absent",
    );
    expect(classifyRestProbe(404, '{"code":"PGRST202","message":"no function"}')).toBe("absent");
    expect(classifyRestProbe(400, '{"message":"not authenticated"}')).toBe("present");
    expect(classifyRestProbe(500, "boom")).toBe("error");
    expect(classifyRestProbe(404, "<html>not found</html>")).toBe("error");
  });

  it("probeSchema reads back every expected object and reports completeness", async () => {
    const present = new Set<string>(["invites", "app_users", "redeem_invite"]);
    const { fetch, calls } = fakeFetch((url, init) => {
      if (url.includes("/storage/v1/bucket")) {
        return { status: 200, body: JSON.stringify([{ id: "resumes", name: "resumes" }]) };
      }
      const m = /\/rest\/v1\/(?:rpc\/)?([a-z_]+)/.exec(url);
      const name = m?.[1] ?? "";
      if (init?.method === "POST") {
        return present.has(name)
          ? { status: 400, body: '{"message":"not authenticated"}' }
          : { status: 404, body: '{"code":"PGRST202"}' };
      }
      return present.has(name)
        ? { status: 200, body: "[]" }
        : { status: 404, body: '{"code":"PGRST205"}' };
    });
    const probe = await probeSchema({
      url: "https://abc.supabase.co/",
      serviceRoleKey: "sb_secret_test",
      fetch,
    });
    expect(probe.complete).toBe(false);
    expect(probe.tables["invites"]).toBe("present");
    expect(probe.tables["waitlist"]).toBe("absent");
    expect(probe.rpcs["redeem_invite"]).toBe("present");
    expect(probe.buckets).toEqual({
      resumes: "present",
      receipts: "absent",
      transcripts: "absent",
    });
    expect(probe.errors).toEqual({});
    // Read-only by construction: selects carry limit=0, the RPC probe uses an impossible code.
    for (const c of calls.filter((c) => c.url.includes("/rest/v1/") && c.method === "GET")) {
      expect(c.url).toContain("limit=0");
    }
    const rpc = calls.find((c) => c.method === "POST");
    expect(rpc?.body).toContain("JRA-PROBE-ONLY");
    // Every RPC is probed with its declared read-only arguments (zero-arg
    // functions get {} — a stray invite_code would answer PGRST202).
    for (const fn of EXPECTED_RPCS) {
      const call = calls.find((c) => c.method === "POST" && c.url.endsWith(`/rpc/${fn}`));
      expect(JSON.parse(call?.body ?? "null")).toEqual(RPC_PROBE_ARGS[fn]);
    }
    expect(calls.every((c) => c.auth === "Bearer sb_secret_test")).toBe(true);
  });

  it("probeSchema reports complete=true only when everything answers", async () => {
    const { fetch } = fakeFetch((url) =>
      url.includes("/storage/v1/bucket")
        ? {
            status: 200,
            body: JSON.stringify([
              { id: "resumes" },
              { id: "receipts" },
              { id: "transcripts" },
            ]),
          }
        : { status: 200, body: "[]" },
    );
    const probe = await probeSchema({ url: "https://abc.supabase.co", serviceRoleKey: "k", fetch });
    expect(probe.complete).toBe(true);
  });

  it("managementQuery posts to the project query endpoint and surfaces Supabase's message, never the token", async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.endsWith("/database/query")
        ? { status: 400, body: '{"message":"syntax error at or near \\"creat\\""}' }
        : { status: 500, body: "" },
    );
    await expect(
      managementQuery({ projectRef: "abc", accessToken: "sbp_secret", query: "creat table", fetch }),
    ).rejects.toThrow(/HTTP 400: syntax error/);
    expect(calls[0]?.url).toBe(`${MANAGEMENT_API_BASE}/v1/projects/abc/database/query`);
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ query: "creat table" });
    let thrown = "";
    try {
      await managementQuery({ projectRef: "abc", accessToken: "sbp_secret", query: "x", fetch });
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    expect(thrown).not.toContain("sbp_secret");
  });

  it("buildApplyQuery ships the migration and its ledger row together", () => {
    const q = buildApplyQuery(
      { version: "20260901000100", name: "it's_a_name", path: "/x.sql" },
      "create table public.t (id int);",
    );
    expect(q.startsWith("create table public.t (id int);")).toBe(true);
    expect(q).toContain("insert into supabase_migrations.schema_migrations");
    expect(q).toContain("'20260901000100', 'it''s_a_name'");
    expect(q).toContain("on conflict (version) do nothing");
  });

  describe("applyMigrations", () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-schema-"));
      fs.writeFileSync(path.join(dir, "20260901000100_a.sql"), "create table public.a (id int);");
      fs.writeFileSync(path.join(dir, "20260901000200_b.sql"), "create table public.b (id int);");
      fs.writeFileSync(path.join(dir, "20260901000300_c.sql"), "create table public.c (id int);");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("creates the ledger, skips applied versions, applies the rest in order", async () => {
      const queries: string[] = [];
      const { fetch } = fakeFetch((_url, init) => {
        const q = (JSON.parse(init?.body ?? "{}") as { query: string }).query;
        queries.push(q);
        if (q.startsWith("select version")) {
          return { status: 200, body: JSON.stringify([{ version: "20260901000100" }]) };
        }
        return { status: 201, body: "[]" };
      });
      const result = await applyMigrations({
        projectRef: "abc",
        accessToken: "sbp_x",
        migrations: listMigrationFiles(dir),
        fetch,
      });
      expect(result).toEqual({
        project_ref: "abc",
        already_applied: ["20260901000100"],
        applied: ["20260901000200", "20260901000300"],
        failed: null,
      });
      expect(queries[0]).toContain("create table if not exists supabase_migrations.schema_migrations");
      expect(queries[2]).toContain("create table public.b");
      expect(queries[3]).toContain("create table public.c");
      expect(queries.some((q) => q.includes("create table public.a"))).toBe(false);
    });

    it("stops at the first failing migration and reports it", async () => {
      const { fetch } = fakeFetch((_url, init) => {
        const q = (JSON.parse(init?.body ?? "{}") as { query: string }).query;
        if (q.startsWith("select version")) return { status: 200, body: "[]" };
        if (q.includes("public.b")) return { status: 400, body: '{"message":"relation b exists"}' };
        return { status: 201, body: "[]" };
      });
      const result = await applyMigrations({
        projectRef: "abc",
        accessToken: "sbp_x",
        migrations: listMigrationFiles(dir),
        fetch,
      });
      expect(result.applied).toEqual(["20260901000100"]);
      expect(result.failed).toEqual({
        version: "20260901000200",
        message: "Management API HTTP 400: relation b exists",
      });
    });
  });
});
