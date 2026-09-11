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
  issued_by: string | null;
};

/** Mirrors referral_settings() in 20260902000300 + 20260911000100 (open signup). */
const SETTINGS = {
  max_active_referral_codes: 3,
  referral_code_quota: 5,
  activation_completed_applications: 5,
  inviter_bonus_per_activation: 10,
  inviter_bonus_cap: 100,
  free_signup_quota: 5,
};

/**
 * In-memory stand-in for the slice of PostgREST + GoTrue the round trip
 * touches, with the RLS/RPC/trigger semantics of supabase/migrations
 * encoded (invites, redeem_invite, referral mint/view, bonus trigger,
 * engine_status). It proves the RUNNER's read-backs, not the SQL — the
 * SQL is proven live by `invites:roundtrip` once applied.
 */
function fakeProject(opts: { schema: boolean } = { schema: true }) {
  const invites: Invite[] = [];
  const users = new Map<string, string>(); // id -> email
  // code is null for an open-signup member (ensure_member) until they redeem.
  const appUsers = new Map<string, { code: string | null; bonus: number }>();
  const mirror: Array<{ user_id: string; state: string; engine_application_id: string }> = [];
  const bonuses: Array<{ invitee: string; inviter: string; bonus: number }> = [];
  const engineStatus = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  let nextUser = 1;
  let nextCode = 0;

  const reply = (status: number, body: unknown) => ({
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const missing = () =>
    reply(404, { code: "PGRST205", message: "Could not find the table in the schema cache" });
  // Same alphabet as generate_invite_code() (no 0/O/1/I/L/U).
  const newCode = () => `JRA-${String(2222 + nextCode++).replace(/[01]/g, "7")}-ABCD`;

  // grant_referral_bonus_if_activated(p_invitee)
  const grantBonus = (invitee: string): void => {
    if (bonuses.some((b) => b.invitee === invitee)) return;
    const completed = mirror.filter((m) => m.user_id === invitee && m.state === "COMPLETED").length;
    if (completed < SETTINGS.activation_completed_applications) return;
    const au = appUsers.get(invitee);
    const inv = au?.code ? invites.find((i) => i.code === au.code) : undefined;
    const inviter = inv?.issued_by ?? null;
    if (!inviter || inviter === invitee) return;
    const current = bonuses.filter((b) => b.inviter === inviter).reduce((s, b) => s + b.bonus, 0);
    const bonus = Math.min(SETTINGS.inviter_bonus_per_activation, SETTINGS.inviter_bonus_cap - current);
    if (bonus <= 0) return;
    bonuses.push({ invitee, inviter, bonus });
    appUsers.get(inviter)!.bonus += bonus;
  };

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
      // 20260902000600: invites.redeemed_by cascades; issued_by sets null.
      for (let i = invites.length - 1; i >= 0; i -= 1) if (invites[i]!.redeemed_by === id) invites.splice(i, 1);
      for (const i of invites) if (i.issued_by === id) i.issued_by = null;
      users.delete(id);
      appUsers.delete(id);
      engineStatus.delete(id);
      for (let i = mirror.length - 1; i >= 0; i -= 1) if (mirror[i]!.user_id === id) mirror.splice(i, 1);
      for (let i = bonuses.length - 1; i >= 0; i -= 1) {
        if (bonuses[i]!.invitee === id || bonuses[i]!.inviter === id) bonuses.splice(i, 1);
      }
      return reply(200, {});
    }

    if (!opts.schema && u.pathname.startsWith("/rest/v1/")) return missing();

    // --- rpcs ---
    if (u.pathname === "/rest/v1/rpc/referral_settings") return reply(200, SETTINGS);
    if (u.pathname === "/rest/v1/rpc/ensure_member") {
      if (!asUser) return reply(400, { message: "not authenticated" });
      const created = !appUsers.has(asUser);
      if (created) appUsers.set(asUser, { code: null, bonus: 0 });
      return reply(200, {
        user_id: asUser,
        created,
        invite_id: appUsers.get(asUser)!.code ? "x" : null,
        free_signup_quota: SETTINGS.free_signup_quota,
      });
    }
    if (u.pathname === "/rest/v1/rpc/mint_referral_invite") {
      if (!asUser) return reply(400, { message: "not authenticated" });
      if (!appUsers.has(asUser)) return reply(400, { message: "not a member yet" });
      const active = invites.filter((i) => i.issued_by === asUser && i.redeemed_by === null).length;
      if (active >= SETTINGS.max_active_referral_codes) return reply(400, { message: "referral cap reached" });
      const inv: Invite = {
        code: newCode(),
        issuer: asUser,
        max_completed_applications: SETTINGS.referral_code_quota,
        note: "referral",
        redeemed_by: null,
        redeemed_at: null,
        issued_by: asUser,
      };
      invites.push(inv);
      return reply(200, {
        code: inv.code,
        max_completed_applications: inv.max_completed_applications,
        redeemed_at: null,
        created_at: "2026-09-02T00:00:00Z",
        active_unredeemed: active + 1,
        max_active_referral_codes: SETTINGS.max_active_referral_codes,
      });
    }
    if (u.pathname === "/rest/v1/rpc/redeem_invite") {
      if (!asUser) return reply(400, { message: "not authenticated" });
      const inv = invites.find((i) => i.code === String(body.invite_code).toUpperCase());
      if (!inv) return reply(400, { message: "invalid invite code" });
      if (inv.redeemed_by && inv.redeemed_by !== asUser) {
        return reply(400, { message: "invite already redeemed" });
      }
      if (!inv.redeemed_by) {
        if (inv.issued_by === asUser) return reply(400, { message: "cannot redeem your own invite" });
        // 'already a member' keys on invite_id, not on the row (open signup).
        if (appUsers.get(asUser)?.code) return reply(400, { message: "already a member" });
        inv.redeemed_by = asUser;
        inv.redeemed_at = "2026-09-02T00:00:00Z";
        appUsers.set(asUser, { code: inv.code, bonus: appUsers.get(asUser)?.bonus ?? 0 });
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
          const inv = { ...row, redeemed_by: null, redeemed_at: null, issued_by: null };
          invites.push(inv);
          inserted.push(inv);
        }
        return reply(201, inserted);
      }
      const codeEq = u.searchParams.get("code") ?? "";
      const issuedEq = u.searchParams.get("issued_by") ?? "";
      const redeemedEq = u.searchParams.get("redeemed_by") ?? "";
      let rows = invites;
      if (codeEq.startsWith("eq.")) rows = rows.filter((i) => i.code === codeEq.slice(3));
      if (codeEq.startsWith("in.(")) {
        const set = new Set(codeEq.slice(4, -1).split(",").map((c) => c.replace(/"/g, "")));
        rows = rows.filter((i) => set.has(i.code));
      }
      if (issuedEq.startsWith("eq.")) rows = rows.filter((i) => i.issued_by === issuedEq.slice(3));
      if (redeemedEq === "is.null") rows = rows.filter((i) => i.redeemed_by === null);
      // RLS: "own redeemed invite" OR "own issued invites"
      if (asUser) rows = rows.filter((i) => i.redeemed_by === asUser || i.issued_by === asUser);
      if (method === "DELETE") {
        if (!isService) return reply(401, "permission denied");
        // app_users.invite_id -> invites is NO ACTION: a member's invite cannot go first.
        const referenced = rows.find((r) => [...appUsers.values()].some((au) => au.code === r.code));
        if (referenced) return reply(409, { code: "23503", message: `app_users.invite_id references ${referenced.code}` });
        for (const r of rows) invites.splice(invites.indexOf(r), 1);
        return reply(204, "");
      }
      return reply(200, rows);
    }

    // --- my_referral_invites (security_invoker) ---
    if (u.pathname === "/rest/v1/my_referral_invites") {
      const rows = invites
        .filter((i) => asUser !== null && i.issued_by === asUser)
        .map((i) => ({ code: i.code, max_completed_applications: i.max_completed_applications, redeemed_at: i.redeemed_at }));
      return reply(200, rows);
    }

    // --- mirror (+ bonus trigger) ---
    if (u.pathname === "/rest/v1/application_status_mirror" && method === "POST") {
      if (!isService) return reply(401, "permission denied");
      mirror.push(body);
      if (body.state === "COMPLETED") grantBonus(body.user_id);
      return reply(201, "");
    }

    // --- quota view (security_invoker: only the caller's own app_users row;
    //     20260911000100: left join invites, free + invite + bonus) ---
    if (u.pathname === "/rest/v1/user_quota_status") {
      const rows = [...appUsers.entries()]
        .filter(([uid]) => isService || uid === asUser)
        .map(([uid, au]) => {
          const inv = au.code ? invites.find((i) => i.code === au.code) : undefined;
          const base = inv?.max_completed_applications ?? 0;
          const completed = mirror.filter((m) => m.user_id === uid && m.state === "COMPLETED").length;
          const max = SETTINGS.free_signup_quota + base + au.bonus;
          return {
            user_id: uid,
            max_completed_applications: max,
            completed_applications: completed,
            remaining: Math.max(max - completed, 0),
            base_max_completed_applications: base,
            bonus_completed_applications: au.bonus,
            free_completed_applications: SETTINGS.free_signup_quota,
            has_invite: inv !== undefined,
          };
        });
      return reply(200, rows);
    }

    // --- referral_bonuses (RLS: inviter's own) ---
    if (u.pathname === "/rest/v1/referral_bonuses") {
      return reply(200, bonuses.filter((b) => isService || b.inviter === asUser).map((b) => ({ bonus: b.bonus })));
    }

    // --- engine_status ---
    if (u.pathname === "/rest/v1/engine_status") {
      if (method === "POST") {
        if (!isService) return reply(401, "permission denied");
        engineStatus.set(body.user_id, body);
        return reply(201, "");
      }
      const rows = [...engineStatus.entries()]
        .filter(([uid]) => isService || uid === asUser)
        .map(([, r]) => ({ last_seen_at: r["last_seen_at"], engine_version: r["engine_version"] }));
      return reply(200, rows);
    }
    return reply(404, { code: "PGRST205", message: `unknown ${u.pathname}` });
  };

  return { fetch, invites, users, mirror, bonuses, engineStatus, calls };
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

  it("proves redeem -> decrement -> exhausted -> refused -> open signup -> referral -> bonus -> cap -> heartbeat, then cleans up", async () => {
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
      // invite quota 2 + free 5 = 7 decrements
      ...Array.from({ length: 7 }, (_, i) => `quota_after_completed_${i + 1}`),
      "quota_exhausted_clamps_at_zero",
      "redeem_again_as_a_idempotent",
      "redeem_as_b_refused",
      "open_signup_ensure_member_as_b",
      "ensure_member_idempotent",
      "free_quota_without_invite",
      "rls_hides_other_users_rows",
      "referral_settings",
      "referral_mint_as_a",
      "referral_view_as_a",
      "referral_view_hidden_from_b",
      "referral_self_redeem_refused",
      "referral_redeem_as_b",
      "redeem_after_free_signup_adds_quota",
      "referral_view_shows_redeemed",
      "referral_bonus_granted_to_inviter",
      "referral_bonus_idempotent",
      "referral_bonus_row_visible_to_inviter",
      "referral_cap_enforced",
      "engine_status_own_row_only",
    ]);
    expect(r.steps.find((s) => s.step === "quota_after_redeem")?.detail).toContain("(invite 2 + free 5)");
    expect(r.steps.find((s) => s.step === "quota_after_completed_7")?.detail).toContain('"remaining":0');
    expect(r.steps.find((s) => s.step === "redeem_as_b_refused")?.detail).toContain("invite already redeemed");
    expect(r.steps.find((s) => s.step === "free_quota_without_invite")?.detail).toContain('"hasInvite":false');
    expect(r.steps.find((s) => s.step === "redeem_after_free_signup_adds_quota")?.detail).toBe(
      "B max 5 -> 10 (expected free 5 + invite 5)",
    );
    // A's max = invite 2 + free 5 = 7 before the bonus.
    expect(r.steps.find((s) => s.step === "referral_bonus_granted_to_inviter")?.detail).toBe("A max 7 -> 17 (expected +10)");
    expect(r.steps.find((s) => s.step === "referral_cap_enforced")?.detail).toContain("referral cap reached");
    // Cleanup in FK order: unredeemed issued codes, then both users
    // (cascade takes the redeemed invites), then the loaded code (no-op).
    expect(r.cleanup.map((c) => [c.step, c.ok])).toEqual([
      ["delete_issued_invites", true],
      ["delete_issued_invites", true],
      ["delete_user", true],
      ["delete_user", true],
      ["delete_invite", true],
    ]);
    expect(p.invites).toEqual([]);
    expect(p.users.size).toBe(0);
    expect(p.mirror).toEqual([]);
    expect(p.bonuses).toEqual([]);
    expect(p.engineStatus.size).toBe(0);
    // Redeem + quota reads went through the USER's JWT, not the service role.
    expect(p.calls.filter((c) => c.includes("rpc/redeem_invite")).length).toBe(5);
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

  it("models the FK cycle the cascade migration resolves: a member's invite cannot be deleted first", async () => {
    const p = fakeProject();
    const [invite] = mintInvites({ count: 1, quota: 2, baseUrl: "https://x.example" });
    await loadInvitesToSupabase({ target, invites: [invite!], fetch: p.fetch });
    const created = await p.fetch(`${URL}/auth/v1/admin/users`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      body: JSON.stringify({ email: "m@example.com" }),
    });
    const { id } = JSON.parse(await created.text()) as { id: string };
    await p.fetch(`${URL}/rest/v1/rpc/redeem_invite`, {
      method: "POST",
      headers: { apikey: SERVICE, Authorization: `Bearer jwt-${id}` },
      body: JSON.stringify({ invite_code: invite!.code }),
    });
    const first = await p.fetch(`${URL}/rest/v1/invites?code=eq.${invite!.code}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    expect(first.status).toBe(409); // app_users.invite_id is NO ACTION
    const user = await p.fetch(`${URL}/auth/v1/admin/users/${id}`, {
      method: "DELETE",
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
    });
    expect(user.status).toBe(200); // redeemed_by cascades (20260902000600)
    expect(p.invites).toEqual([]);
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
