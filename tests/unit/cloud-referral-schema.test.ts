import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMigrationFiles } from "../../src/cloud/schema.js";

/**
 * Static invariants of the referral / heartbeat migrations. There is no
 * Postgres in the unit gate, so this guards the CONTRACT the frontend and
 * the sync worker depend on (names, columns, grants, constants) against
 * drift; behaviour is proven live by `invites:roundtrip` + `cloud:schema`
 * once the schema is applied (docs/roadmap/invite-round-trip-2026-09-02.md).
 */
const MIGRATIONS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../supabase/migrations",
);

function read(name: string): string {
  const f = listMigrationFiles(MIGRATIONS).find((m) => m.name === name);
  if (!f) throw new Error(`migration ${name} not found`);
  // Checkouts with core.autocrlf hand back CRLF; the markers below assume LF.
  return fs.readFileSync(f.path, "utf8").replace(/\r\n/g, "\n");
}

describe("referral invites migration (UNIT_CONFIRMED — static contract)", () => {
  const sql = read("referral_invites");

  it("keeps every loop constant in referral_settings(), readable by the app", () => {
    expect(sql).toMatch(/'max_active_referral_codes', 3/);
    expect(sql).toMatch(/'referral_code_quota', 5/);
    expect(sql).toMatch(/'activation_completed_applications', 5/);
    expect(sql).toMatch(/'inviter_bonus_per_activation', 10/);
    expect(sql).toMatch(/'inviter_bonus_cap', 100/);
    expect(sql).toMatch(/grant execute on function public\.referral_settings\(\) to anon, authenticated/);
  });

  it("issued_by survives account deletion (set null) and is the only new invites column", () => {
    expect(sql).toMatch(/add column issued_by uuid references auth\.users \(id\) on delete set null/);
    expect(sql.match(/add column/g)?.length).toBe(1);
  });

  it("my_referral_invites exposes exactly what frontend/src/public/referral.ts reads, own rows only", () => {
    const view = /create view public\.my_referral_invites[\s\S]*?;/.exec(sql)?.[0] ?? "";
    expect(view).toContain("security_invoker = true");
    for (const col of ["i.code", "i.max_completed_applications", "i.redeemed_at", "i.created_at"]) {
      expect(view).toContain(col);
    }
    expect(view).toMatch(/where i\.issued_by = auth\.uid\(\)/);
    expect(sql).toMatch(/create policy "own issued invites"[\s\S]*?using \(issued_by = auth\.uid\(\)\)/);
    expect(sql).toMatch(/grant select on public\.my_referral_invites to authenticated/);
    expect(sql).toMatch(/revoke all on public\.my_referral_invites from anon/);
  });

  it("mint_referral_invite() is member-only, capped, issuer = caller, authenticated-only", () => {
    const fn = /create or replace function public\.mint_referral_invite\(\)[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    expect(fn).toContain("security definer");
    expect(fn).toMatch(/raise exception 'not authenticated'/);
    expect(fn).toMatch(/raise exception 'not a member yet'/);
    expect(fn).toMatch(/raise exception 'referral cap reached'/);
    expect(fn).toMatch(/where issued_by = auth\.uid\(\) and redeemed_by is null/);
    expect(fn).toMatch(/pg_advisory_xact_lock/);
    expect(fn).toMatch(/values \(v_code, auth\.uid\(\)::text, v_quota, auth\.uid\(\), 'referral'\)/);
    expect(fn).toMatch(/v_attempt >= 5/); // bounded uniqueness retry
    expect(sql).toMatch(/revoke all on function public\.mint_referral_invite\(\) from anon/);
    expect(sql).toMatch(/grant execute on function public\.mint_referral_invite\(\) to authenticated/);
    // Server-side code shape matches src/cloud/invites.ts exactly.
    expect(sql).toContain("'23456789ABCDEFGHJKMNPQRSTVWXYZ'");
  });

  it("redeem_invite refuses self-redemption and second memberships, keeps the original strings", () => {
    const fn = /create or replace function public\.redeem_invite\(invite_code text\)[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    for (const msg of [
      "not authenticated",
      "invalid invite code",
      "invite already redeemed",
      "cannot redeem your own invite",
      "already a member",
    ]) {
      expect(fn).toContain(`raise exception '${msg}'`);
    }
    expect(fn).toMatch(/for update/);
  });
});

describe("referral bonus migration (UNIT_CONFIRMED — static contract)", () => {
  const sql = read("referral_bonus");

  it("grants once per invitee (primary key), cascades on deletion, RLS own-rows read only", () => {
    expect(sql).toMatch(/invitee_user_id uuid primary key references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/alter table public\.referral_bonuses enable row level security/);
    expect(sql).toMatch(/revoke insert, update, delete on public\.referral_bonuses from authenticated/);
    expect(sql).toMatch(/using \(inviter_user_id = auth\.uid\(\)\)/);
  });

  it("user_quota_status keeps its first four columns in order and appends base + bonus", () => {
    const view = /create or replace view public\.user_quota_status[\s\S]*?group by[^;]*;/.exec(sql)?.[0] ?? "";
    const order = ["as user_id", "as max_completed_applications", "as completed_applications", "as remaining", "as base_max_completed_applications", "u.bonus_completed_applications\n"];
    let last = -1;
    for (const marker of order) {
      const idx = view.indexOf(marker);
      expect(idx, marker).toBeGreaterThan(last);
      last = idx;
    }
    expect(view).toContain("security_invoker = true");
    expect(view).toMatch(/i\.max_completed_applications \+ u\.bonus_completed_applications/);
  });

  it("the grant function is threshold-gated, cap-limited, idempotent, and only the trigger may call it", () => {
    const fn = /create or replace function public\.grant_referral_bonus_if_activated\(p_invitee uuid\)[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    expect(fn).toMatch(/if v_completed < v_threshold then/);
    expect(fn).toMatch(/v_inviter is null or v_inviter = p_invitee/); // no self-referral bonus
    expect(fn).toMatch(/least\(v_per, v_cap - v_current\)/);
    expect(fn).toMatch(/on conflict \(invitee_user_id\) do nothing/);
    expect(fn).toMatch(/pg_advisory_xact_lock/);
    expect(sql).toMatch(/revoke all on function public\.grant_referral_bonus_if_activated\(uuid\) from anon, authenticated/);
    expect(sql).toMatch(/after insert or update of state on public\.application_status_mirror/);
    expect(sql).toMatch(/when \(new\.state = 'COMPLETED'\)/);
  });
});

describe("invites.redeemed_by cascade migration (UNIT_CONFIRMED — static contract)", () => {
  const sql = read("invites_redeemed_by_cascade").replace(/^\s*--.*$/gm, "");

  it("replaces the NO ACTION constraint with ON DELETE CASCADE and nothing else", () => {
    expect(sql).toMatch(/drop constraint invites_redeemed_by_fkey/);
    expect(sql).toMatch(/add constraint invites_redeemed_by_fkey\s+foreign key \(redeemed_by\) references auth\.users \(id\) on delete cascade/);
    expect(sql).not.toMatch(/set null/i);
    expect(sql.match(/^alter table/gm)?.length).toBe(2);
  });
});

describe("engine_status migration (UNIT_CONFIRMED — static contract)", () => {
  const sql = read("engine_status");

  it("is one row per user, own-row readable, client-unwritable, and carries only the heartbeat columns", () => {
    expect(sql).toMatch(/user_id uuid primary key references auth\.users \(id\) on delete cascade/);
    for (const col of [
      "last_seen_at timestamptz not null",
      "engine_version text",
      "last_sync_attempted integer",
      "last_sync_upserted integer",
      "last_sync_duration_ms integer",
      "last_error text",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toMatch(/alter table public\.engine_status enable row level security/);
    expect(sql).toMatch(/revoke insert, update, delete on public\.engine_status from authenticated/);
    expect(sql).toMatch(/using \(user_id = auth\.uid\(\)\)/);
    // Column set matches the worker's whitelist (syncMapping.ENGINE_STATUS_COLUMNS).
    const cols = [...sql.matchAll(/^\s{2}([a-z_]+) (?:uuid|timestamptz|text|integer)/gm)].map((m) => m[1]);
    expect(cols).toEqual([
      "user_id",
      "last_seen_at",
      "engine_version",
      "last_sync_attempted",
      "last_sync_upserted",
      "last_sync_duration_ms",
      "last_error",
    ]);
  });
});
