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
  /** Private bucket, engine-written; read via createSignedUrl. */
  receiptsBucket: "receipts",
  /** Insert-only mailbox for students without an invite (anon may insert; nobody client-side may read). */
  waitlistTable: "waitlist",
} as const;

/** Postgres unique-violation SQLSTATE — the waitlist's "already on it" signal. */
export const PG_UNIQUE_VIOLATION = "23505";

/** Verbatim server error strings from redeem_invite (match, don't paraphrase). */
export const REDEEM_ERRORS = {
  invalid: "invalid invite code",
  alreadyRedeemed: "invite already redeemed",
  notAuthenticated: "not authenticated",
} as const;

/* ── user_profiles row shapes (migration 20260902000100) ───────────── */

export type WorkAuthorization =
  | "us_citizen"
  | "permanent_resident"
  | "visa_holder"
  | "needs_sponsorship"
  | "other";

export type EducationEntry = {
  school: string;
  degree: string;
  field: string;
  start_year: number | null;
  end_year: number | null;
  gpa?: number;
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
  job_preferences: JobPreferences | Record<string, never>;
  /** Set by the wizard's FINAL save; engine ignores profiles until non-null. */
  onboarding_completed_at: string | null;
  created_at?: string;
  updated_at?: string;
};

/* ── read models ───────────────────────────────────────────────────── */

export type QuotaStatus = {
  user_id: string;
  /** Applications the invite covers (counts COMPLETED, not submitted). */
  max_completed_applications: number;
  completed_applications: number;
  remaining: number;
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
  /** "" = unanswered (row null) — the user's own explicit choice only. */
  work_authorization: WorkAuthorization | "";
  needs_sponsorship: "yes" | "no" | "";
  resume_object_path: string | null;
  resume_filename: string | null;
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
  work_authorization: "",
  needs_sponsorship: "",
  resume_object_path: null,
  resume_filename: null,
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
