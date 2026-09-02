import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { mintInvites } from "../../src/cloud/invites.js";
import {
  assertCloudWriteConfigured,
  loadInvitesToSupabase,
  runInviteRoundTrip,
} from "../../src/cloud/inviteRoundTrip.js";
import type { FetchLike } from "../../src/cloud/schema.js";

const SERVICE = "sb_secret_test";
const URL = "https://proj.supabase.co";

type Invite = {
  code: string;
  issuer: string;
  max_completed_applications: number;
  note: string | null;
  redeemed_by: string | null;
  redeemed_at: string | null;
};

/**
 * In-memory stand-in for the slice of PostgREST + GoTrue the round trip
 * touches, with the RLS/RPC semantics of supabase/migrations encoded.
 */
function fakeProject(opts: { schema: boolean } = { schema: true }) {
  const invites: Invite[] = [];
  const users = new Map<string, string>(); // id -> email
  const appUsers = new Map<string, string>(); // user id -> invite code
  const mirror: Array<{ user_id: string; state: string; engine_application_id: string }> = [];
  const calls: string[] = [];
  let nextUser = 1;

  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const missing = () =>
    reply(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });

  const fetch: FetchLike = async (input, init) => {
    const u = new globalThis.URL(input);
    const method = init?.method ?? "GET";
    const bearer = (init?.headers?.["Authorization"] ?? "").replace(/^Bearer /, "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (init?.headers?.["apikey"] !== SERVICE) return reply(401, "bad apikey");
    const asUser = bearer.startsWith("jwt-") ? bearer.slice(4) : null;
    const isService = bearer === SERVICE;

    // --- auth admin ---
    if (u.pathname === "/auth/v1/admin/users" && method === "POST") {
      const id = `user-${nextUser++}`;
      users.set(id, body.email);
      return reply(200, { id, email: body.email });
    }
    if (u.pathname === "/auth/v1/admin/generate_link") {
      return reply(200, { hashed_token: `hash:${body.email}` });
    }
    if (u.pathname === "/auth/v1/verify") {
      const email = String(body.token_hash).replace(/^hash:/, "");
      const id = [...users.entries()].find(([, e]) => e === email)?.[0];
      return id ? reply(200, { access_token: `jwt-${id}` }) : reply(401, "bad token");
    }
    const del = u.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (del && method === "DELETE") {
      const id = del[1]!;
      if (invites.some((i) => i.redeemed_by === id)) {
        return reply(500, "FK violation: invites.redeemed_by references this user");
      }
      users.delete(id);
      appUsers.delete(id);
      for (let i = mirror.length - 1; i >= 0; i -= 1) if (mirror[i]!.user_id === id) mirror.splice(i, 1);
      return reply(200, {});
    }

    if (!opts.schema && u.pathname.startsWith("/rest/v1/")) return missing();

    // --- rpc ---
    if (u.pathname === "/rest/v1/rpc/redeem_invite") {
      if (!asUser) return reply(400, { message: "not authenticated" });
      const inv = invites.find((i) => i.code === String(body.invite_code).toUpperCase());
      if (!inv) return reply(400, { message: "invalid invite code" });
      if (inv.redeemed_by && inv.redeemed_by !== asUser) {
        return reply(400, { message: "invite already redeemed" });
      }
      if (!inv.redeemed_by) {
        inv.redeemed_by = asUser;
        inv.redeemed_at = "2026-09-02T00:00:00Z";
        appUsers.set(asUser, inv.code);
      }
      return reply(200, { invite_id: "x", max_completed_applications: inv.max_completed_applications });
    }

    // --- invites ---
    if (u.pathname === "/rest/v1/invites") {
      if (method === "POST") {
        if (!isService) return reply(401, "permission denied");
        const inserted: unknown[] = [];
        for (const row of body as Invite[]) {
          if (invites.some((i) => i.code === row.code)) continue;
          const inv = { ...row, redeemed_by: null, redeemed_at: null };
          invites.push(inv);
          inserted.push(inv);
        }
        return reply(201, inserted);
      }
      const codeEq = u.searchParams.get("code") ?? "";
      let rows = invites;
      if (codeEq.startsWith("eq.")) rows = rows.filter((i) => i.code === codeEq.slice(3));
      if (codeEq.startsWith("in.(")) {
        const set = new Set(codeEq.slice(4, -1).split(",").map((c) => c.replace(/"/g, "")));
        rows = rows.filter((i) => set.has(i.code));
      }
      if (asUser) rows = rows.filter((i) => i.redeemed_by === asUser); // RLS "own redeemed invite"
      if (method === "DELETE") {
        if (!isService) return reply(401, "permission denied");
        for (const r of rows) invites.splice(invites.indexOf(r), 1);
        return reply(204, "");
      }
      return reply(200, rows);
    }

    // --- mirror ---
    if (u.pathname === "/rest/v1/application_status_mirror" && method === "POST") {
      if (!isService) return reply(401, "permission denied");
      mirror.push(body);
      return reply(201, "");
    }

    // --- quota view (security_invoker: only the caller's own app_users row) ---
    if (u.pathname === "/rest/v1/user_quota_status") {
      const rows = [...appUsers.entries()]
        .filter(([uid]) => isService || uid === asUser)
        .map(([uid, code]) => {
          const inv = invites.find((i) => i.code === code)!;
          const completed = mirror.filter((m) => m.user_id === uid && m.state === "COMPLETED").length;
          return {
            max_completed_applications: inv.max_completed_applications,
            completed_applications: completed,
            remaining: Math.max(inv.max_completed_applications - completed, 0),
          };
        });
      return reply(200, rows);
    }
    return reply(404, { code: "PGRST205", message: `unknown ${u.pathname}` });
  };

  return { fetch, invites, users, mirror, calls };
}

const target = { url: URL, serviceRoleKey: SERVICE };

describe("invite round trip (UNIT_CONFIRMED against an in-memory project)", () => {
  it("loads minted invites idempotently and reads them back", async () => {
    const p = fakeProject();
    const minted = mintInvites({ count: 3, baseUrl: "https://x.example" });
    const first = await loadInvitesToSupabase({ target, invites: minted, fetch: p.fetch });
    expect(first).toEqual({ attempted: 3, inserted: 3, skipped_existing: 0, read_back_ok: true });
    const again = await loadInvitesToSupabase({ target, invites: minted, fetch: p.fetch });
    expect(again).toEqual({ attempted: 3, inserted: 0, skipped_existing: 3, read_back_ok: true });
    expect(p.invites.map((i) => i.code).sort()).toEqual(minted.map((i) => i.code).sort());
  });

  it("names the missing schema instead of a raw 404 when invites does not exist", async () => {
    const p = fakeProject({ schema: false });
    const minted = mintInvites({ count: 1, baseUrl: "https://x.example" });
    await expect(
      loadInvitesToSupabase({ target, invites: minted, fetch: p.fetch }),
    ).rejects.toThrow(/public\.invites does not exist.*cloud:schema/);
  });

  it("proves redeem -> decrement -> exhausted -> refused, then cleans up", async () => {
    const p = fakeProject();
    const [invite] = mintInvites({ count: 1, quota: 2, baseUrl: "https://x.example" });
    const r = await runInviteRoundTrip({ target, invite: invite!, fetch: p.fetch, now: () => 1 });
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.validation_level).toBe("LIVE_MUTATION_CONFIRMED");
    expect(r.steps.map((s) => s.step)).toEqual([
      "load_invite",
      "create_user_a",
      "redeem_as_a",
      "invite_marked_redeemed",
      "quota_after_redeem",
      "quota_after_completed_1",
      "quota_after_completed_2",
      "quota_exhausted_clamps_at_zero",
      "redeem_again_as_a_idempotent",
      "redeem_as_b_refused",
      "rls_hides_other_users_rows",
    ]);
    expect(r.steps.find((s) => s.step === "quota_after_completed_2")?.detail).toContain('"remaining":0');
    expect(r.steps.find((s) => s.step === "redeem_as_b_refused")?.detail).toContain("invite already redeemed");
    // Cleanup: invite deleted first (FK), then both users; nothing left behind.
    expect(r.cleanup.map((c) => [c.step, c.ok])).toEqual([
      ["delete_invite", true],
      ["delete_user", true],
      ["delete_user", true],
    ]);
    expect(p.invites).toEqual([]);
    expect(p.users.size).toBe(0);
    expect(p.mirror).toEqual([]);
    // Redeem + quota reads went through the USER's JWT, not the service role.
    expect(p.calls.filter((c) => c.includes("rpc/redeem_invite")).length).toBe(3);
  });

  it("demotes to UNVERIFIED and still cleans up when a read-back fails", async () => {
    const p = fakeProject();
    // Break the quota view: report remaining one too high.
    const broken: FetchLike = async (input, init) => {
      const res = await p.fetch(input, init);
      if (!input.includes("user_quota_status")) return res;
      const rows = JSON.parse(await res.text()) as Array<{ remaining: number }>;
      return { status: 200, text: async () => JSON.stringify(rows.map((r) => ({ ...r, remaining: r.remaining + 1 }))) };
    };
    const [invite] = mintInvites({ count: 1, quota: 2, baseUrl: "https://x.example" });
    const r = await runInviteRoundTrip({ target, invite: invite!, fetch: broken, now: () => 2 });
    expect(r.ok).toBe(false);
    expect(r.validation_level).toBe("UNVERIFIED");
    expect(r.steps.at(-1)?.step).toBe("aborted");
    expect(r.cleanup.every((c) => c.ok)).toBe(true);
    expect(p.invites).toEqual([]);
    expect(p.users.size).toBe(0);
  });

  it("refuses without the flag, and by name without the keys (fail-closed)", () => {
    const base = { SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE };
    expect(() => assertCloudWriteConfigured(loadConfig({ ...base }))).toThrow(/SUPABASE_SYNC_ENABLED is false/);
    expect(() =>
      assertCloudWriteConfigured(loadConfig({ SUPABASE_SYNC_ENABLED: "true", SUPABASE_URL: URL })),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY missing/);
    const ok = assertCloudWriteConfigured(loadConfig({ SUPABASE_SYNC_ENABLED: "true", ...base }));
    expect(ok).toEqual({ url: URL, serviceRoleKey: SERVICE });
  });
});
