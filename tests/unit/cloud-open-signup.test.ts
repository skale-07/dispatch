import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT } from "../../frontend/src/public/contract.js";
import { EXPECTED_RPCS, RPC_PROBE_ARGS } from "../../src/cloud/schema.js";

/**
 * Open signup (operator decision 2026-09-11): membership no longer
 * requires an invite. These are text-level assertions on the migration —
 * the SQL itself is proven live by `cloud:schema -- apply/verify` and by
 * the open-signup steps of `invites:roundtrip`. UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const MIGRATION = path.join(
  ROOT,
  "supabase",
  "migrations",
  "20260911000100_open_signup.sql",
);

function sql(): string {
  return fs.readFileSync(MIGRATION, "utf8");
}

describe("open signup migration (UNIT_CONFIRMED)", () => {
  it("adds free_signup_quota to referral_settings() and keeps it anon-callable", () => {
    const s = sql();
    expect(s).toMatch(/'free_signup_quota',\s*5/);
    expect(s).toMatch(
      /grant execute on function public\.referral_settings\(\) to anon, authenticated/,
    );
  });

  it("ensure_member() refuses before touching a row, inserts idempotently, and is authenticated-only", () => {
    const s = sql();
    const fn =
      /create or replace function public\.ensure_member\(\)[\s\S]*?\nend;\n\$\$;/.exec(s)?.[0] ?? "";
    expect(fn, "ensure_member body not found").not.toBe("");
    const authCheck = fn.indexOf("auth.uid() is null");
    const insert = fn.indexOf("insert into public.app_users");
    expect(authCheck).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(authCheck);
    expect(fn).toContain("on conflict (id) do nothing");
    expect(fn).toContain("security definer");
    expect(s).toMatch(/revoke all on function public\.ensure_member\(\) from anon/);
    expect(s).toMatch(/grant execute on function public\.ensure_member\(\) to authenticated/);
  });

  it("user_quota_status left-joins invites, folds the free allowance in, and only APPENDS columns", () => {
    const s = sql();
    const start = s.indexOf("create or replace view public.user_quota_status");
    expect(start).toBeGreaterThan(-1);
    const view = s.slice(start);
    expect(view).toContain("left join public.invites i on i.id = u.invite_id");
    expect(view).not.toMatch(/\n\s*join public\.invites/);
    // create-or-replace requires the original six output columns in their
    // original order; the two new ones must come after.
    const order = [
      "as user_id",
      "as max_completed_applications",
      "as completed_applications",
      "as remaining",
      "as base_max_completed_applications",
      "u.bonus_completed_applications,",
      "as free_completed_applications",
      "as has_invite",
    ].map((needle) => view.indexOf(needle));
    expect(order.every((i) => i > -1), `column markers missing: ${order}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(view).toMatch(/security_invoker = true/);
    expect(view).toMatch(/coalesce\(i\.max_completed_applications, 0\)/);
  });

  it("the manifest probes ensure_member with no arguments (service role => 'not authenticated' => present)", () => {
    expect(EXPECTED_RPCS).toContain("ensure_member");
    expect(RPC_PROBE_ARGS.ensure_member).toEqual({});
  });

  it("the frontend contract names the RPC", () => {
    expect(CONTRACT.ensureMemberRpc).toBe("ensure_member");
  });
});
