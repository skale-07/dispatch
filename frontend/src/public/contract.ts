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
  /**
   * Open signup (20260911000100): idempotent membership for the signed-in
   * user, called once per session. No invite needed; an invite redeemed
   * later still ADDS its quota.
   */
  ensureMemberRpc: "ensure_member",
  /**
   * Server-side completeness (20260911000300): returns { complete,
   * missing[] } and stamps onboarding_completed_at only when nothing is
   * missing. Never raises for incompleteness.
   */
  completeOnboardingRpc: "complete_my_onboarding",
  /** Resume variants + transcript as rows (20260911000300); own rows. */
  documentsTable: "user_documents",
  /** Per-user screener answer bank (20260911000400); own rows. */
  screenerAnswersTable: "user_screener_answers",
  /** The 22 registry keys, from the database (drift-tested vs the engine). */
  screenerRegistryKeysRpc: "screener_registry_keys",
  /** Outreach persona (20260911000600); own rows. */
  personasTable: "user_personas",
  /** Integrations read model (20260911000700) — never a secret column. */
  integrationsView: "my_integrations",
  /** User-side integration writes: only { premium } and { disconnect }. */
  setIntegrationRpc: "set_my_integration",
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

/** employment_history entry (20260911000200). */
export type EmploymentEntry = {
  company: string;
  title: string;
  location?: string;
  start_month?: string;
  start_year?: number | null;
  end_month?: string;
  end_year?: number | null;
  current?: boolean;
  summary?: string;
};

export type ProfileRow = {
  user_id: string;
  /** Display/greeting name; the wizard writes legal first + last here. */
  full_name: string | null;
  /** 20260911000200 — engine legal_name.{first,middle,last}. */
  legal_first_name: string | null;
  legal_middle_name: string | null;
  legal_last_name: string | null;
  preferred_name: string | null;
  /** null = the auth email. */
  contact_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  postal_code: string | null;
  /** "How did you hear about us" answer + user-approved fallbacks. */
  how_heard: string | null;
  how_heard_fallbacks: string[];
  /** Non-compete yes/no; null = unanswered (never invented). */
  restrictive_covenants: "yes" | "no" | null;
  skills: string[];
  employment_history: EmploymentEntry[];
  /** Wizard resume pointer; UI-only. */
  onboarding_progress: { step: string; updated_at: string } | null;
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

/* ── per-store rows (20260911000300–000700) ────────────────────────── */

export type DocumentKind = "resume" | "transcript" | "cover_letter";

export type DocumentRow = {
  id: string;
  user_id: string;
  kind: DocumentKind;
  /** 'general' | 'ds_ai' are what the engine understands today. */
  variant: string;
  bucket: "resumes" | "transcripts";
  object_path: string;
  filename: string;
  role_families: string[];
  is_default: boolean;
  uploaded_at: string;
};

export type ScreenerAnswerRow = {
  user_id: string;
  key: string;
  kind: "registry" | "custom";
  /** Literal string the engine types or picks. */
  answer: string;
  labels: string[];
  source: "wizard" | "suggestion" | "engine_promote";
  created_at?: string;
  updated_at?: string;
};

export type PersonaProject = {
  name: string;
  summary: string;
  tools: string[];
  relevance_tags: string[];
};

export type PersonaRow = {
  user_id: string;
  persona_id: string;
  headline: string;
  education: { school?: string; class_year?: number; majors?: string[] };
  projects: PersonaProject[];
  skills: string[];
  interests: string[];
  updated_at?: string;
};

export type IntegrationProvider = "jobright" | "gmail";
export type IntegrationStatus =
  | "disconnected"
  | "pending_handoff"
  | "connected"
  | "expired"
  | "revoked";

/** A my_integrations row — never carries a secret. */
export type IntegrationRow = {
  user_id: string;
  provider: IntegrationProvider;
  status: IntegrationStatus;
  account_email: string | null;
  /** jobright: self-reported Premium (engine may confirm, never demote). */
  premium: boolean | null;
  scopes: string[];
  connected_at: string | null;
  expires_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  updated_at: string;
};

/** complete_my_onboarding() result. */
export type OnboardingCompletion = { complete: boolean; missing: string[] };

/* ── read models ───────────────────────────────────────────────────── */

export type QuotaStatus = {
  user_id: string;
  /**
   * EFFECTIVE quota = free signup allowance + the invite's own quota (0
   * without one) + referral bonus (counts COMPLETED, not submitted).
   * `remaining` is computed from this number.
   */
  max_completed_applications: number;
  completed_applications: number;
  remaining: number;
  /** The invite's own quota, 0 for a free signup (20260902000400 appended these two). */
  base_max_completed_applications: number;
  /** Earned via friends who activated; folded into max_completed_applications. */
  bonus_completed_applications: number;
  /** Every account's free allowance (20260911000100 appended these two). */
  free_completed_applications: number;
  /** Whether an invite code has been redeemed on this account. */
  has_invite: boolean;
};

/** ensure_member() result (20260911000100). */
export type MemberStatus = {
  user_id: string;
  /** True on the call that created the app_users row. */
  created: boolean;
  invite_id: string | null;
  free_signup_quota: number;
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
  /** Completed applications every new account starts with (open signup, 2026-09-11). */
  free_signup_quota: number;
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

/** One additional school (education[1..]); the primary stays flat on the draft. */
export type EducationDraft = {
  school: string;
  degree: string;
  field: string;
  grad_year: string;
  grad_month: string;
  start_year: string;
  start_month: string;
  gpa: string;
  additional_fields: string;
};

export const EMPTY_EDUCATION_ENTRY: EducationDraft = {
  school: "",
  degree: "",
  field: "",
  grad_year: "",
  grad_month: "",
  start_year: "",
  start_month: "",
  gpa: "",
  additional_fields: "",
};

export type EmploymentDraft = {
  company: string;
  title: string;
  location: string;
  start_month: string;
  start_year: string;
  end_month: string;
  end_year: string;
  current: boolean;
  summary: string;
};

export const EMPTY_EMPLOYMENT_ENTRY: EmploymentDraft = {
  company: "",
  title: "",
  location: "",
  start_month: "",
  start_year: "",
  end_month: "",
  end_year: "",
  current: false,
  summary: "",
};

export type ProfileDraft = {
  full_name: string;
  /** 20260911000200 — engine legal_name.{first,middle,last}. */
  legal_first_name: string;
  legal_middle_name: string;
  legal_last_name: string;
  preferred_name: string;
  /** "" = use the sign-in email. */
  contact_email: string;
  address_line1: string;
  address_line2: string;
  postal_code: string;
  how_heard: string;
  /** Comma-separated in the form; text[] in the row. */
  how_heard_fallbacks: string;
  /** "" = unanswered (row null) — never invented. */
  restrictive_covenants: "yes" | "no" | "";
  /** Comma-separated in the form; text[] in the row. */
  skills: string;
  /** Additional schools; education[0] stays on the flat keys below. */
  more_education: EducationDraft[];
  employment_history: EmploymentDraft[];
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
  legal_first_name: "",
  legal_middle_name: "",
  legal_last_name: "",
  preferred_name: "",
  contact_email: "",
  address_line1: "",
  address_line2: "",
  postal_code: "",
  how_heard: "",
  how_heard_fallbacks: "",
  restrictive_covenants: "",
  skills: "",
  more_education: [],
  employment_history: [],
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

/* ── screener questions the wizard asks (mirror of SCREENER_REGISTRY) ─ */

export type ScreenerKind = "yes_no" | "option" | "short_text" | "url";

export type ScreenerQuestion = {
  /** Registry key — must equal src/candidate/screeners.ts (drift-tested). */
  key: string;
  prompt: string;
  kind: ScreenerKind;
  /** Where the wizard asks it. */
  step: "eligibility" | "compensation";
  hint?: string;
  /** For option/short_text: common literal answers; the user may type another. */
  suggestions?: string[];
};

/**
 * The engine's fixed screener keys, with the question each one stands
 * for. Answers are stored VERBATIM (user_screener_answers.answer) and
 * placed onto forms by choosing from the page's own options. Facts that
 * live on the profile row (work authorization, sponsorship, relocation,
 * how-heard, non-compete) are asked there instead and mirrored by the
 * engine — so those five keys are listed here only for completeness
 * tests and are NOT rendered as separate questions.
 */
export const PROFILE_MIRRORED_SCREENER_KEYS = [
  "work_authorization",
  "requires_sponsorship",
  "willing_to_relocate",
  "how_heard",
  "non_compete",
] as const;

export const SCREENER_QUESTIONS: ScreenerQuestion[] = [
  { key: "consent_agreement", prompt: "Agree to application terms / privacy notices when a form requires it?", kind: "yes_no", step: "eligibility", hint: "Almost every form has one; \"Yes\" is what lets Dispatch submit." },
  { key: "availability_full_time", prompt: "Are you available to work full-time?", kind: "yes_no", step: "eligibility" },
  { key: "requires_sponsorship", prompt: "Will you now or in the future require sponsorship?", kind: "yes_no", step: "eligibility", hint: "Answered on the work-eligibility step (profile)." },
  { key: "work_authorization", prompt: "Are you authorized to work in the United States?", kind: "yes_no", step: "eligibility", hint: "Answered on the work-eligibility step (profile)." },
  { key: "education_level", prompt: "Highest level of education (completed or in progress)", kind: "option", step: "eligibility", suggestions: ["High school", "Associate's", "Bachelor's", "Master's", "Doctorate"] },
  { key: "closest_location", prompt: "Which office / location is closest to you, when a form asks?", kind: "option", step: "eligibility", hint: "Type the city you'd pick; Dispatch matches it against the form's list." },
  { key: "how_heard", prompt: "How did you hear about this role?", kind: "short_text", step: "compensation", hint: "Answered on the compensation & how-heard step (profile)." },
  { key: "referral_name", prompt: "Name of an employee who referred you, if forms ask", kind: "short_text", step: "compensation", hint: "Leave blank unless you have a standing referrer." },
  { key: "willing_to_relocate", prompt: "Willing to relocate?", kind: "yes_no", step: "eligibility", hint: "Answered on the work-eligibility step (profile)." },
  { key: "remote_or_onsite", prompt: "Remote, hybrid, or on-site preference when a form asks", kind: "option", step: "eligibility", suggestions: ["Remote", "Hybrid", "On-site", "No preference"] },
  { key: "start_availability", prompt: "Earliest start date / availability to begin", kind: "short_text", step: "eligibility", suggestions: ["Immediately", "Two weeks' notice", "May 2027", "Summer 2027"] },
  { key: "internship_term", prompt: "Which internship term are you applying for?", kind: "option", step: "eligibility", suggestions: ["Summer 2027", "Fall 2026", "Spring 2027", "Winter 2027"] },
  { key: "hours_per_week", prompt: "Hours per week you can commit", kind: "short_text", step: "eligibility", suggestions: ["40", "20", "10-15"] },
  { key: "previously_applied_or_worked", prompt: "Have you previously applied to or worked for the company?", kind: "yes_no", step: "eligibility", hint: "Dispatch answers the same for every company; leave blank to have it asked per application." },
  { key: "age_over_18", prompt: "Are you at least 18 years old?", kind: "yes_no", step: "eligibility" },
  { key: "non_compete", prompt: "Are you bound by a non-compete or other restrictive covenant?", kind: "yes_no", step: "eligibility", hint: "Answered on the work-eligibility step (profile)." },
  { key: "government_employment", prompt: "Are you a current or former government employee?", kind: "yes_no", step: "eligibility" },
  { key: "security_clearance", prompt: "Do you hold an active security clearance?", kind: "yes_no", step: "eligibility" },
  { key: "twitter_url", prompt: "Twitter / X profile URL", kind: "url", step: "compensation", hint: "Optional." },
  { key: "portfolio_url", prompt: "Portfolio or other website URL (when a form has a separate field)", kind: "url", step: "compensation", hint: "Optional; your main website is on the identity step." },
  { key: "salary_expectations", prompt: "Expected salary / compensation, in your own words", kind: "short_text", step: "compensation", hint: "Dispatch never goes below a posting's stated pay and never invents a precise figure.", suggestions: ["Open to the posted range", "$70,000-$85,000", "$35/hour"] },
  { key: "notice_period", prompt: "Notice period with your current employer", kind: "short_text", step: "compensation", suggestions: ["None - available now", "Two weeks", "One month"] },
];

/** Common "how did you hear about us" answers that appear on real forms. */
export const HOW_HEARD_SUGGESTIONS = [
  "LinkedIn",
  "Company website",
  "Job board",
  "Handshake",
  "Indeed",
  "Referral",
  "University career fair",
  "Other",
] as const;
