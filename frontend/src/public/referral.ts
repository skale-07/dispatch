import { supabase } from "../lib/supabaseClient";

/**
 * ── Referral surface: the part of the invite contract that does not
 *    exist yet ──────────────────────────────────────────────────────
 *
 * The launcher contract (supabase/migrations, docs/roadmap/cloud-deploy.md)
 * mints invites by hand: a user can read only the invite THEY redeemed,
 * and nothing lets a user issue codes to friends. The referral loop in
 * docs/marketing/college-launch.md §4 needs exactly that, so this file
 * names the seam and fails closed until the launcher ships it.
 *
 * STUB CONTRACT (proposed; the ask is in the storefront report):
 *   view  my_referral_invites — own-rows RLS —
 *         code, url_path, max_completed_applications, redeemed_at
 *   (or an RPC `mint_referral_invite()` capped per user server-side)
 *
 * Until the view exists, listMyReferralInvites() reports `available:
 * false` with the server's own reason and the panel falls back to a
 * plain share (landing + waitlist) — no invented codes, ever.
 */

export const REFERRAL_CONTRACT = {
  /** NOT in the launcher contract yet — see the header. */
  myReferralInvitesView: "my_referral_invites",
  /** Contract: minted links are /redeem?code=JRA-XXXX-XXXX. */
  redeemPath: "/redeem",
} as const;

export type ReferralInvite = {
  code: string;
  /** Absolute link a friend can open on their phone. */
  url: string;
  max_completed_applications: number;
  redeemed_at: string | null;
};

export type ReferralInvites =
  | { available: true; invites: ReferralInvite[] }
  | { available: false; reason: string };

type ReferralRow = {
  code: string;
  max_completed_applications: number;
  redeemed_at: string | null;
};

export function inviteUrl(code: string, origin = window.location.origin): string {
  return `${origin}${REFERRAL_CONTRACT.redeemPath}?code=${encodeURIComponent(code)}`;
}

/**
 * One read, no retry. A missing view is the EXPECTED outcome today
 * (PostgREST answers 404 / PGRST205); it is reported, not hidden, so
 * the panel can say honestly that personal codes are not live yet.
 */
export async function listMyReferralInvites(): Promise<ReferralInvites> {
  if (!supabase) {
    return { available: false, reason: "account service not configured" };
  }
  const { data, error } = await supabase
    .from(REFERRAL_CONTRACT.myReferralInvitesView)
    .select("code, max_completed_applications, redeemed_at")
    .order("redeemed_at", { ascending: true, nullsFirst: true });
  if (error) return { available: false, reason: error.message };
  const rows = (data as ReferralRow[] | null) ?? [];
  return {
    available: true,
    invites: rows.map((r) => ({
      code: r.code,
      url: inviteUrl(r.code),
      max_completed_applications: r.max_completed_applications,
      redeemed_at: r.redeemed_at,
    })),
  };
}

/* ── share text ──────────────────────────────────────────────────── */

/**
 * What lands in a group chat. Two variants because there are two
 * truths: with a personal code the friend can sign up right now; without
 * one the honest offer is the waitlist. Both quote only what the product
 * actually does (receipts, real employer sites) — no user counts, no
 * "join 10,000 students".
 */
export function shareText(opts: {
  invite: ReferralInvite | null;
  origin?: string;
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
  return {
    title: "Dispatch — job applications, done with receipts",
    text:
      "I've had an agent doing my job applications — it fills the forms on real employer sites " +
      "and keeps a screenshot receipt for every one. It's invite-only right now; the waitlist is here:",
    url: `${origin}/#waitlist`,
  };
}
