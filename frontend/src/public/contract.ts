/**
 * ── The launcher-owned Supabase contract, ADOPTED (final) ───────────
 *
 * Source of truth: docs/roadmap/cloud-deploy.md §"Frontend ⇄ Supabase
 * contract" and supabase/migrations/ (schema owner: launcher; relayed
 * final by the queen 2026-09-01). Every table/view/RPC/bucket name the
 * public app sends to Supabase lives in THIS file and nowhere else.
 * If the schema ever changes, it changes here first.
 *
 * All access is anon-key + RLS (own rows only); receipts and the
 * application mirror are engine-written and user-read-only by design.
 */

export const CONTRACT = {
  /** One row per user, keyed by auth.uid(); RLS: own row, no delete. */
  profilesTable: "user_profiles",
  /** Atomic, idempotent-per-user invite redemption. Arg name matters. */
  redeemInviteRpc: "redeem_invite",
  redeemInviteArg: "invite_code",
  /** View: max/completed/remaining, quota counts COMPLETED applications. */
  quotaView: "user_quota_status",
  /** View: own applications with the latest receipt attached. */
  applicationsView: "my_applications",
  /** Private bucket; object path MUST start with the user's own uid. */
  resumesBucket: "resumes",
  /**
   * Private bucket, same own-uid path rule (migration 20260903000100).
   * Its own bucket rather than a prefix inside `resumes` because storage
   * policies are per-bucket — "a transcript is not a resume" stays true
   * at the policy layer, not by convention.
   */
  transcriptsBucket: "transcripts",
  /** Private bucket, engine-written; read via createSignedUrl. */
  receiptsBucket: "receipts",
  /** Insert-only mailbox for students without an invite (anon may insert; nobody client-side may read). */
  waitlistTable: "waitlist",

  /* ── referral loop (migrations 20260902000300/400) ──────────────── */
  /** Immutable constants the loop runs on; anon-callable. Render copy from these, never literals. */
  referralSettingsRpc: "referral_settings",
  /** View: codes the signed-in user ISSUED (operator-minted codes never appear). */
  referralInvitesView: "my_referral_invites",
  /** RPC, no args: mint one code for the caller; member-only, capped server-side. */
  mintReferralInviteRpc: "mint_referral_invite",
  /** Ledger of bonuses the signed-in user EARNED as inviter; read-only. */
  referralBonusesTable: "referral_bonuses",

  /* ── engine heartbeat (migration 20260902000500) ────────────────── */
  /** One row per user, written by the engine's sync worker every tick; own row, read-only. */
  engineStatusTable: "engine_status",
} as const;

/** Postgres unique-violation SQLSTATE — the waitlist's "already on it" signal. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Verbatim server error strings from redeem_invite (match, don't paraphrase). */
export const REDEEM_ERRORS = {
  invalid: "invalid invite code",
  alreadyRedeemed: "invite already redeemed",
  notAuthenticated: "not authenticated",
  /** 20260902000300: a member cannot burn one of their own referral codes. */
  ownInvite: "cannot redeem your own invite",
  /** 20260902000300: one redemption per account; quota comes from ONE invite. */
  alreadyMember: "already a member",
} as const;

/** Verbatim server error strings from mint_referral_invite. */
export const MINT_ERRORS = {
  notAuthenticated: "not authenticated",
  notMember: "not a member yet",
  capReached: "referral cap reached",
} as const;

/* ── user_profiles row shapes (migration 20260902000100) ───────────── */

export type WorkAuthorization =
  | "us_citizen"
  | "permanent_resident"
  | "visa_holder"
  | "needs_sponsorship"
  | "other";

/**
 * Months stay free text on purpose: "May", "Spring 2027" and "expected"
 * are all answers real employer forms accept, and coercing them to an
 * integer would discard what the user actually said. The engine's own
 * profile facts are strings for the same reason.
 */
export type EducationEntry = {
  school: string;
  degree: string;
  field: string;
  start_year: number | null;
  end_year: number | null;
  gpa?: number;
  /** Engine reads these as start_month / graduation_month. */
  start_month?: string;
  end_month?: string;
  /** Minors and second majors — engine key additional_fields_of_study. */
  additional_fields?: string;
};

export type RemotePreference = "remote" | "hybrid" | "onsite" | "any";

export type JobPreferences = {
  titles: string[];
  locations: string[];
  remote?: RemotePreference;
  employment_types: string[];
  min_salary_usd?: number;
};

export type ProfileRow = {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  location_city: string | null;
  location_region: string | null;
  location_country: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  education: EducationEntry[];
  /** SELF-REPORTED in the wizard; null until the user answers. */
  work_authorization: WorkAuthorization | null;
  needs_sponsorship: boolean | null;
  resume_object_path: string | null;
  resume_filename: string | null;
  resume_uploaded_at: string | null;
  /** 20260903000100 — the engine already attaches these to ATS forms. */
  transcript_object_path: string | null;
  transcript_filename: string | null;
  transcript_uploaded_at: string | null;
  /**
   * Free-text narrative in the user's own voice (≤8000, enforced by the
   * column). Essay autofill and screener prediction both ground on it and
   * both abstain without it — this is the highest-value field on the row.
   */
  about_me: string | null;
  current_company: string | null;
  open_to_relocation: boolean | null;
  job_preferences: JobPreferences | Record<string, never>;
  /** Set by the wizard's FINAL save; engine ignores profiles until non-null. */
  onboarding_completed_at: string | null;
  created_at?: string;
  updated_at?: string;
};

/* ── read models ───────────────────────────────────────────────────── */

export type QuotaStatus = {
  user_id: string;
  /**
   * EFFECTIVE quota = the invite's own quota + referral bonus (counts
   * COMPLETED, not submitted). `remaining` is computed from this number.
   */
  max_completed_applications: number;
  completed_applications: number;
  remaining: number;
  /** The invite's own quota (20260902000400 appended these two). */
  base_max_completed_applications: number;
  /** Earned via friends who activated; folded into max_completed_applications. */
  bonus_completed_applications: number;
};

/* ── referral loop read models ─────────────────────────────────────── */

/** referral_settings(): every constant the loop depends on, from one place. */
export type ReferralSettings = {
  /** Unredeemed codes a member may hold at once (mint refuses past this). */
  max_active_referral_codes: number;
  /** Completed applications each referral code grants the invitee. */
  referral_code_quota: number;
  /** Invitee completions that count as an activation. */
  activation_completed_applications: number;
  /** Inviter's quota bonus per activated invitee. */
  inviter_bonus_per_activation: number;
  /** Lifetime cap on bonus quota per inviter. */
  inviter_bonus_cap: number;
};

/** A row of my_referral_invites (own issued codes). */
export type ReferralInviteRow = {
  code: string;
  max_completed_applications: number;
  redeemed_at: string | null;
  created_at: string;
};

/** mint_referral_invite() result: the new row plus where the cap stands. */
export type MintedReferralInvite = ReferralInviteRow & {
  redeemed_at: null;
  active_unredeemed: number;
  max_active_referral_codes: number;
};

/** A referral_bonuses row where the signed-in user is the inviter. */
export type ReferralBonusRow = {
  invitee_user_id: string;
  inviter_user_id: string;
  /** SET NULL when the invitee's account (and its invite) is deleted. */
  invite_id: string | null;
  bonus: number;
  granted_at: string;
};

/* ── engine heartbeat read model ───────────────────────────────────── */

/** engine_status row: timestamps, counts and a short sha — never candidate data. */
export type EngineStatusRow = {
  user_id: string;
  /** When the sync worker last completed a tick for this user. */
  last_seen_at: string;
  engine_version: string | null;
  last_sync_attempted: number;
  last_sync_upserted: number;
  last_sync_duration_ms: number;
  /** Error text when the tick failed AFTER the heartbeat. */
  last_error: string | null;
};

export type ApplicationRowPublic = {
  id: string;
  company: string | null;
  role: string | null;
  status: string;
  route: string | null;
  source_ats: string | null;
  engine_updated_at: string | null;
  submitted_at: string | null;
  /** Path within receiptsBucket for the latest submission screenshot. */
  receipt_path: string | null;
};

/* ── the wizard's working draft (form state; mapped in data.ts) ────── */

export type ProfileDraft = {
  full_name: string;
  phone: string;
  location_city: string;
  location_region: string;
  location_country: string;
  linkedin_url: string;
  github_url: string;
  portfolio_url: string;
  /** v0 wizard edits one education entry (education[0] in the row). */
  school: string;
  degree: string;
  field: string;
  grad_year: string;
  grad_month: string;
  start_year: string;
  start_month: string;
  gpa: string;
  additional_fields: string;
  /** "" = unanswered (row null) — the user's own explicit choice only. */
  work_authorization: WorkAuthorization | "";
  needs_sponsorship: "yes" | "no" | "";
  about_me: string;
  current_company: string;
  /** "" = unanswered; the row stores null so nothing is assumed. */
  open_to_relocation: "yes" | "no" | "";
  resume_object_path: string | null;
  resume_filename: string | null;
  transcript_object_path: string | null;
  transcript_filename: string | null;
  /** Comma-separated in the form; arrays in the row. */
  titles: string;
  locations: string;
  remote: RemotePreference | "";
  employment_types: string[];
  min_salary_usd: string;
};

export const EMPTY_PROFILE: ProfileDraft = {
  full_name: "",
  phone: "",
  location_city: "",
  location_region: "",
  location_country: "",
  linkedin_url: "",
  github_url: "",
  portfolio_url: "",
  school: "",
  degree: "",
  field: "",
  grad_year: "",
  grad_month: "",
  start_year: "",
  start_month: "",
  gpa: "",
  additional_fields: "",
  work_authorization: "",
  needs_sponsorship: "",
  about_me: "",
  current_company: "",
  open_to_relocation: "",
  resume_object_path: null,
  resume_filename: null,
  transcript_object_path: null,
  transcript_filename: null,
  titles: "",
  locations: "",
  remote: "",
  employment_types: [],
  min_salary_usd: "",
};

/** Options the wizard renders for work authorization, in display order. */
export const WORK_AUTH_OPTIONS: Array<{
  value: WorkAuthorization;
  label: string;
}> = [
  { value: "us_citizen", label: "U.S. citizen" },
  { value: "permanent_resident", label: "Permanent resident (green card)" },
  { value: "visa_holder", label: "Visa holder" },
  { value: "needs_sponsorship", label: "Will need sponsorship" },
  { value: "other", label: "Other" },
];

export const EMPLOYMENT_TYPE_OPTIONS = [
  "internship",
  "full_time",
  "part_time",
  "contract",
] as const;
