/**
 * ── PLACEHOLDER CONTRACT — pending the launcher agent's schema ──────
 *
 * The invites/profiles/quota schema (tables, columns, RPCs, storage
 * buckets, and their RLS policies) is OWNED BY THE LAUNCHER agent; the
 * queen relays its contract when it lands. Until then, every name the
 * public app would send to Supabase lives in THIS file and nowhere
 * else, so adopting the real contract is a one-file change (plus any
 * honest field mapping in data.ts).
 *
 * Nothing here invents server behavior: reads/writes that need these
 * names fail with the real error against a backend that doesn't have
 * them yet, and the UI shows that failure — it never pretends.
 */

export const CONTRACT = {
  /** One row per user, keyed by auth.uid(), RLS: owner-only. */
  profilesTable: "profiles",
  /** Invite redemption goes through an RPC so quota rules live server-side. */
  redeemInviteRpc: "redeem_invite",
  /** Read model for the signed-in user's quota. */
  quotaView: "my_quota",
  /** Read model for the signed-in user's applications. */
  applicationsView: "my_applications",
  /** Private storage bucket for resumes; path is `${userId}/${filename}`. */
  resumesBucket: "resumes",
  /** Private storage bucket where submission screenshots live. */
  receiptsBucket: "receipts",
} as const;

/** The consumer profile the onboarding wizard collects. */
export type ProfileDraft = {
  full_name: string;
  phone: string;
  location: string;
  /** Education */
  school: string;
  degree: string;
  major: string;
  graduation_year: string;
  /** Work authorization — the user's OWN explicit answers, never derived. */
  work_authorized_us: "yes" | "no" | "";
  needs_sponsorship: "yes" | "no" | "";
  /** Resume (storage path within resumesBucket after upload). */
  resume_path: string | null;
  resume_filename: string | null;
  /** Job preferences */
  desired_roles: string;
  desired_locations: string;
  work_style: "remote" | "hybrid" | "onsite" | "any" | "";
  earliest_start: string;
};

export type Profile = ProfileDraft & {
  user_id: string;
  updated_at: string;
};

export type QuotaStatus = {
  /** Applications the account is entitled to (invite grants + bonuses). */
  granted: number;
  /** Completed (submitted-with-receipt) applications counted against it. */
  used: number;
};

export type ApplicationRowPublic = {
  id: string;
  company: string | null;
  role: string | null;
  status: string;
  submitted_at: string | null;
  /** Path within receiptsBucket, when a submission screenshot exists. */
  receipt_path: string | null;
};

export const EMPTY_PROFILE: ProfileDraft = {
  full_name: "",
  phone: "",
  location: "",
  school: "",
  degree: "",
  major: "",
  graduation_year: "",
  work_authorized_us: "",
  needs_sponsorship: "",
  resume_path: null,
  resume_filename: null,
  desired_roles: "",
  desired_locations: "",
  work_style: "",
  earliest_start: "",
};
