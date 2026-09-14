import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { runFeedSample } from "../../src/tenants/feedSample.js";
import { deriveTenantKey } from "../../src/tenants/keys.js";
import { tenantPaths } from "../../src/tenants/paths.js";
import { listUnsealed, sealSecret } from "../../src/tenants/secrets.js";

/**
 * Plan M20 — the feed sample as a tenant job, with a fake child: the
 * sealed-session requirement (handoff instead of a browser), the exact
 * child spec (every gated flag off, dry run, the tenant workspace), the
 * plaintext lifetime, titles/companies/locations only on the cloud row,
 * and an auth wall ⇒ jobright_reconnect + integration expired.
 * UNIT_CONFIRMED.
 */

const UID = "11111111-2222-4333-8444-555555555555";
const KEY = deriveTenantKey(Buffer.alloc(32, 4), UID);

type Call = { table?: string; rows?: unknown; rpc?: string; args?: Record<string, unknown> };
function fakeClient() {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({ upsert: async (rows: unknown) => { calls.push({ table, rows }); return { error: null }; } }),
    rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ rpc: fn, args }); return { data: null, error: null }; },
  };
  return { client, calls };
}

describe("tenant feed sample (UNIT_CONFIRMED)", () => {
  let root: string;
  const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", TENANT_ENGINE_ENABLED: "true", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-feed-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("no sealed session ⇒ jobright_connect handoff + an honest empty sample; no child", async () => {
    const paths = tenantPaths(UID, root);
    const { client, calls } = fakeClient();
    let launched = 0;
    const r = await runFeedSample({ client, config, paths, email: "t@x.io", tenantKey: KEY, runDir: path.join(paths.runsDir, "j"), launch: async () => { launched += 1; return { exitCode: 0, timedOut: false, durationMs: 1 }; } });
    expect(launched).toBe(0);
    expect(r).toMatchObject({ outcome: "needs_jobright_connect", handoff: "jobright_connect" });
    expect((calls.find((c) => c.table === "handoff_tasks")!.rows as Record<string, unknown>)["kind"]).toBe("jobright_connect");
    expect((calls.find((c) => c.table === "jobright_feed_samples")!.rows as Record<string, unknown>)["jobs"]).toEqual([]);
  });

  it("sealed session ⇒ the child runs with every gated flag off in the workspace, plaintext only during the child, titles only pushed", async () => {
    const paths = tenantPaths(UID, root);
    sealSecret(paths, "jobright.storage", { cookies: [{ name: "sid", value: "s" }], origins: [] }, KEY);
    const { client, calls } = fakeClient();
    let seen: { env: NodeJS.ProcessEnv; args: string[]; during: string[] } | null = null;
    const r = await runFeedSample({
      client, config, paths, email: "t@x.io", tenantKey: KEY, runDir: path.join(paths.runsDir, "j"),
      now: () => new Date("2026-09-14T08:00:00Z"),
      launch: async (spec) => {
        seen = { env: spec.env, args: spec.args, during: listUnsealed(paths) };
        const out = spec.args[spec.args.indexOf("--out") + 1]!;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ ok: true, reason: null, cards_attached: true, sampled_at: "x", jobs: [
          { title: "SWE Intern", company: "Acme", location: "Pittsburgh, PA", description: "never" },
          { title: "Data Intern", company: "Beta", location: null },
        ] }));
        return { exitCode: 0, timedOut: false, durationMs: 5 };
      },
    });
    expect(r).toMatchObject({ outcome: "sampled", count: 2, handoff: null });
    const { env, args, during } = seen!;
    expect(during).toEqual(["private/auth/jobright.storage.json"]);
    expect(listUnsealed(paths)).toEqual([]);
    expect(args.join(" ")).toMatch(/tenants[\\/]feedSampleCli\.ts --out .* --max 10$/);
    expect(env["PRIVATE_DIR"]).toBe(paths.privateDir);
    expect(env["DRY_RUN"]).toBe("true");
    expect(env["FORM_FILL_ENABLED"]).toBe("false");
    expect(env["SUBMIT_ENABLED"]).toBe("false");
    expect(env["CANDIDATE_KEY_PROVIDER"]).toBe("tenant");
    const row = calls.find((c) => c.table === "jobright_feed_samples")!.rows as Record<string, unknown>;
    expect(row["jobs"]).toEqual([{ title: "SWE Intern", company: "Acme", location: "Pittsburgh, PA" }, { title: "Data Intern", company: "Beta", location: "" }]);
    expect(row["count"]).toBe(2);
    expect(JSON.stringify(row)).not.toContain("never");
    expect(calls.some((c) => c.table === "handoff_tasks")).toBe(false);
  });

  it("an auth wall in the child ⇒ jobright_reconnect handoff, integration expired, sample says why", async () => {
    const paths = tenantPaths(UID, root);
    sealSecret(paths, "jobright.storage", { cookies: [], origins: [] }, KEY);
    const { client, calls } = fakeClient();
    const r = await runFeedSample({
      client, config, paths, email: "t@x.io", tenantKey: KEY, runDir: path.join(paths.runsDir, "j2"),
      launch: async (spec) => {
        const out = spec.args[spec.args.indexOf("--out") + 1]!;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ ok: false, reason: "auth_required", cards_attached: false, sampled_at: "x", jobs: [] }));
        return { exitCode: 1, timedOut: false, durationMs: 5 };
      },
    });
    expect(r).toMatchObject({ outcome: "auth_required", handoff: "jobright_reconnect" });
    expect((calls.find((c) => c.table === "handoff_tasks")!.rows as Record<string, unknown>)["kind"]).toBe("jobright_reconnect");
    expect(calls.find((c) => c.rpc === "engine_set_integration_status")!.args).toMatchObject({ p_provider: "jobright", p_status: "expired" });
    expect((calls.find((c) => c.table === "jobright_feed_samples")!.rows as Record<string, unknown>)["note"]).toMatch(/expired/);
    expect(listUnsealed(paths)).toEqual([]);
  });
});
