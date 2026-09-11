import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  MINT_ERRORS,
  type MintedReferralInvite,
  type ReferralBonusRow,
  type ReferralInviteRow,
  type ReferralSettings,
} from "./contract";

/**
 * ── Referral surface (launcher contract, shipped 2026-09-02) ─────────
 *
 * Source of truth: docs/roadmap/cloud-deploy.md §9 and
 * supabase/migrations/20260902000300_referral_invites.sql /
 * 20260902000400_referral_bonus.sql. A member mints their OWN codes
 * (capped server-side), reads them back through an own-rows view, and
 * earns quota when an invitee activates. Every number in the copy comes
 * from referral_settings() — nothing here hardcodes "3 codes" or "+10".
 *
 * Error posture: one read, no retry; the server's verbatim error is the
 * reason the UI shows. No invented codes, ever.
 */

function client() {
  if (!supabase) {
    throw new Error("account service not configured in this build");
  }
  return supabase;
}

export type ReferralInvite = ReferralInviteRow & {
  /** Absolute link a friend can open on their phone. */
  url: string;
};

export type ReferralInvites =
  | { available: true; invites: ReferralInvite[] }
  | { available: false; reason: string };

export type MintOutcome =
  | { ok: true; invite: ReferralInvite; activeUnredeemed: number; cap: number }
  | { ok: false; reason: string; kind: "not-member" | "cap" | "other" };

/** Contract: minted links are /redeem?code=JRA-XXXX-XXXX. */
export const REDEEM_PATH = "/redeem";

export function inviteUrl(code: string, origin = window.location.origin): string {
  return `${origin}${REDEEM_PATH}?code=${encodeURIComponent(code)}`;
}

/** The loop's constants — immutable on the server, anon-callable. */
export async function getReferralSettings(): Promise<ReferralSettings> {
  const { data, error } = await client().rpc(CONTRACT.referralSettingsRpc);
  if (error) throw new Error(error.message);
  const s = (Array.isArray(data) ? data[0] : data) as ReferralSettings | null;
  if (!s || typeof s.max_active_referral_codes !== "number") {
    throw new Error("referral settings came back in an unexpected shape");
  }
  return s;
}

/** Own issued codes, unredeemed first. */
export async function listMyReferralInvites(): Promise<ReferralInvites> {
  if (!supabase) {
    return { available: false, reason: "account service not configured" };
  }
  const { data, error } = await supabase
    .from(CONTRACT.referralInvitesView)
    .select("code, max_completed_applications, redeemed_at, created_at")
    .order("redeemed_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: false });
  if (error) return { available: false, reason: error.message };
  const rows = (data as ReferralInviteRow[] | null) ?? [];
  return { available: true, invites: rows.map(withUrl) };
}

function withUrl(r: ReferralInviteRow): ReferralInvite {
  return { ...r, url: inviteUrl(r.code) };
}

/**
 * Mint one code for the signed-in member. The server enforces membership
 * and the cap; the three verbatim error strings are classified so the
 * panel can disable the button with the real reason.
 */
export async function mintReferralInvite(): Promise<MintOutcome> {
  try {
    const { data, error } = await client().rpc(CONTRACT.mintReferralInviteRpc);
    if (error) return { ok: false, reason: error.message, kind: classify(error.message) };
    const row = (Array.isArray(data) ? data[0] : data) as MintedReferralInvite | null;
    if (!row || typeof row.code !== "string") {
      return { ok: false, reason: "mint returned no code", kind: "other" };
    }
    return {
      ok: true,
      invite: withUrl(row),
      activeUnredeemed: row.active_unredeemed,
      cap: row.max_active_referral_codes,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason, kind: classify(reason) };
  }
}

function classify(message: string): "not-member" | "cap" | "other" {
  if (message === MINT_ERRORS.notMember) return "not-member";
  if (message === MINT_ERRORS.capReached) return "cap";
  return "other";
}

/** Bonuses the signed-in user earned as inviter (one row per activated friend). */
export async function listMyReferralBonuses(): Promise<ReferralBonusRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.referralBonusesTable)
    .select("invitee_user_id, inviter_user_id, invite_id, bonus, granted_at")
    .order("granted_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as ReferralBonusRow[] | null) ?? [];
}

/* ── share text ──────────────────────────────────────────────────── */

/**
 * What lands in a group chat. Two variants because there are two
 * truths: with a personal code the friend gets the code's quota on top
 * of the free allowance; without one the honest offer is the free
 * signup itself (open since 2026-09-11). Both quote only what the
 * product actually does (receipts, real employer sites) — no user
 * counts, no "join 10,000 students". `freeSignupQuota` comes from
 * referral_settings(); when the caller has not loaded it the copy says
 * "free" without a number rather than inventing one.
 */
export function shareText(opts: {
  invite: ReferralInvite | null;
  origin?: string;
  freeSignupQuota?: number;
}): { title: string; text: string; url: string } {
  const origin = opts.origin ?? window.location.origin;
  if (opts.invite) {
    return {
      title: "An invite to Dispatch",
      text:
        `I've had an agent doing my job applications — it fills the forms on real employer sites ` +
        `and keeps a screenshot receipt for every one. This invite covers ` +
        `${opts.invite.max_completed_applications} applications: ${opts.invite.code}`,
      url: opts.invite.url,
    };
  }
  const free =
    typeof opts.freeSignupQuota === "number"
      ? `${opts.freeSignupQuota} free applications to start`
      : "free applications to start";
  return {
    title: "Dispatch — job applications, done with receipts",
    text:
      "I've had an agent doing my job applications — it fills the forms on real employer sites " +
      `and keeps a screenshot receipt for every one. Anyone can sign up (${free}):`,
    url: `${origin}/signup`,
  };
}
