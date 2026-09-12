/**
 * Pure mapping from engine-plane application rows to cloud mirror rows
 * (`application_status_mirror` in supabase/migrations). This module is the
 * DATA BOUNDARY: the explicit field-by-field construction below is the
 * complete list of what may cross engine → cloud. No candidate PII, no
 * answers, no artifacts, no credentials — adding a field here needs the
 * same scrutiny as a new capability flag (see docs/roadmap/cloud-deploy.md).
 *
 * Kept free of config/db/network imports so the unit tests exercise it
 * without any flag or key existing.
 */

export type EngineApplicationRow = {
  id: string;
  state: string;
  route: string | null;
  created_at: string | null;
  updated_at: string | null;
  company: string | null;
  role: string | null;
  source_ats: string | null;
};

export type StatusMirrorRow = {
  user_id: string;
  engine_application_id: string;
  company: string | null;
  role: string | null;
  state: string;
  route: string | null;
  source_ats: string | null;
  engine_created_at: string | null;
  engine_updated_at: string | null;
  last_synced_at: string;
};

/** Exact upsert column set — asserted in tests so the boundary cannot drift. */
export const MIRROR_COLUMNS = [
  "user_id",
  "engine_application_id",
  "company",
  "role",
  "state",
  "route",
  "source_ats",
  "engine_created_at",
  "engine_updated_at",
  "last_synced_at",
] as const;

const MAX_TEXT = 300;

function clampText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
}

/** SQLite timestamps are ISO strings already; anything unparsable ⇒ null. */
function toTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function toStatusMirrorRow(
  row: EngineApplicationRow,
  userId: string,
  now: Date,
): StatusMirrorRow {
  if (row.id.trim() === "") {
    throw new Error("engine application row has an empty id");
  }
  if (userId.trim() === "") {
    throw new Error("mirror rows require a cloud user id");
  }
  return {
    user_id: userId,
    engine_application_id: row.id,
    company: clampText(row.company),
    role: clampText(row.role),
    state: row.state,
    route: clampText(row.route),
    source_ats: clampText(row.source_ats),
    engine_created_at: toTimestamp(row.created_at),
    engine_updated_at: toTimestamp(row.updated_at),
    last_synced_at: now.toISOString(),
  };
}

export function toStatusMirrorRows(
  rows: EngineApplicationRow[],
  userId: string,
  now: Date,
): StatusMirrorRow[] {
  return rows.map((row) => toStatusMirrorRow(row, userId, now));
}

// ── Engine heartbeat (engine_status, migration 20260902000500) ────────
// Written on EVERY sync tick so the dashboard's "engine running" is a
// real signal. Timestamps, counts, a git short-sha — nothing else.

export type EngineStatusRow = {
  user_id: string;
  last_seen_at: string;
  engine_version: string | null;
  last_sync_attempted: number;
  last_sync_upserted: number;
  last_sync_duration_ms: number;
  last_error: string | null;
  state: EngineState;
  paused_reason: string | null;
  current_job_id: string | null;
};

/**
 * What the worker is doing right now (20260911000800). `parked` means a
 * handoff is blocking it — the dashboard turns that into a prompt rather
 * than an error.
 */
export const ENGINE_STATES = ["idle", "running", "parked", "quota_exhausted"] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

/** Exact upsert column set — asserted in tests so the boundary cannot drift. */
export const ENGINE_STATUS_COLUMNS = [
  "user_id",
  "last_seen_at",
  "engine_version",
  "last_sync_attempted",
  "last_sync_upserted",
  "last_sync_duration_ms",
  "last_error",
  "state",
  "paused_reason",
  "current_job_id",
] as const;

export function toEngineStatusRow(input: {
  userId: string;
  now: Date;
  engineVersion: string | null | undefined;
  attempted: number;
  upserted: number;
  durationMs: number;
  error: string | null | undefined;
  state?: EngineState;
  pausedReason?: string | null;
  currentJobId?: string | null;
}): EngineStatusRow {
  if (input.userId.trim() === "") throw new Error("engine status requires a cloud user id");
  const nonNegInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  const state = input.state ?? "idle";
  if (!ENGINE_STATES.includes(state)) throw new Error(`unknown engine state: ${state}`);
  return {
    user_id: input.userId,
    last_seen_at: input.now.toISOString(),
    engine_version: clampText(input.engineVersion),
    last_sync_attempted: nonNegInt(input.attempted),
    last_sync_upserted: nonNegInt(input.upserted),
    last_sync_duration_ms: nonNegInt(input.durationMs),
    last_error: clampText(input.error),
    state,
    // Only a parked engine explains itself; the column is noise otherwise.
    paused_reason: state === "parked" ? clampText(input.pausedReason) : null,
    current_job_id: state === "running" ? (clampText(input.currentJobId) ?? null) : null,
  };
}

// ── Receipts push (v0 public app, operator direction 2026-09-01) ──────
// A submitted application's screenshot receipt + submission metadata are
// the USER'S OWN application evidence — permitted engine → cloud. The
// object path convention matches the storage RLS policies:
//   receipts/{user_id}/{engine_application_id}/attempt-{n}.png

export type EngineSubmissionRow = {
  application_id: string;
  submission_attempt_number: number | null;
  submitted_at: string | null;
  confirmation_url: string | null;
  application_identifier: string | null;
  screenshot_path: string | null;
};

export type ReceiptRow = {
  user_id: string;
  engine_application_id: string;
  submission_attempt: number;
  object_path: string;
  submitted_at: string | null;
  confirmation_url: string | null;
  application_identifier: string | null;
};

export type ReceiptUpload = {
  row: ReceiptRow;
  /** Path inside the `receipts` bucket (no bucket prefix). */
  objectPath: string;
  /** Engine-local screenshot path, relative to artifactsDir. */
  localScreenshotPath: string;
};

export function toReceiptUpload(
  sub: EngineSubmissionRow,
  userId: string,
): ReceiptUpload | null {
  if (userId.trim() === "") throw new Error("receipts require a cloud user id");
  if (sub.application_id.trim() === "") {
    throw new Error("submission row has an empty application_id");
  }
  const shot = sub.screenshot_path?.trim();
  if (shot === undefined || shot === "") return null; // no evidence, no receipt
  const attempt =
    Number.isInteger(sub.submission_attempt_number) &&
    (sub.submission_attempt_number as number) > 0
      ? (sub.submission_attempt_number as number)
      : 1;
  const objectPath = `${userId}/${sub.application_id}/attempt-${attempt}.png`;
  return {
    row: {
      user_id: userId,
      engine_application_id: sub.application_id,
      submission_attempt: attempt,
      object_path: objectPath,
      submitted_at: sub.submitted_at ?? null,
      confirmation_url: clampText(sub.confirmation_url),
      application_identifier: clampText(sub.application_identifier),
    },
    objectPath,
    localScreenshotPath: shot,
  };
}

// ── Profiles pull (two-way sync, same fail-closed flag) ───────────────
// USER-SUBMITTED onboarding data flowing cloud → engine so the engine can
// act on it. Only users who FINISHED onboarding are returned; the join is
// pure so it is unit-testable without a client.

export type CloudAppUserRow = {
  id: string;
  email: string;
  invite_id: string | null;
  max_completed_applications?: number | null;
};

/**
 * The user_profiles row as the cloud returns it. Columns added after the
 * original wizard (20260903000100 about_me/transcript/current_company/
 * open_to_relocation; 20260911000200 legal names, address, how-heard,
 * covenants, skills, employment) are optional here so older snapshots
 * and fixtures still type-check; the materializer treats absent and
 * null alike (nothing invented).
 */
export type CloudProfileRow = {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  location_city: string | null;
  location_region: string | null;
  location_country: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  work_authorization: string | null;
  needs_sponsorship: boolean | null;
  education: unknown;
  job_preferences: unknown;
  resume_object_path: string | null;
  resume_filename: string | null;
  onboarding_completed_at: string | null;
  // 20260903000100
  about_me?: string | null;
  transcript_object_path?: string | null;
  transcript_filename?: string | null;
  current_company?: string | null;
  open_to_relocation?: boolean | null;
  // 20260911000200
  legal_first_name?: string | null;
  legal_middle_name?: string | null;
  legal_last_name?: string | null;
  preferred_name?: string | null;
  contact_email?: string | null;
  address_line1?: string | null;
  address_line2?: string | null;
  postal_code?: string | null;
  how_heard?: string | null;
  how_heard_fallbacks?: string[] | null;
  restrictive_covenants?: string | null;
  skills?: string[] | null;
  employment_history?: unknown;
};

/** user_documents (20260911000300). */
export type CloudDocumentRow = {
  id: string;
  user_id: string;
  kind: string;
  variant: string;
  bucket: string;
  object_path: string;
  filename: string;
  role_families: string[];
  is_default: boolean;
  uploaded_at: string | null;
};

/** user_screener_answers (20260911000400). */
export type CloudScreenerAnswerRow = {
  user_id: string;
  key: string;
  kind: string;
  answer: string;
  labels: string[];
  source: string;
  updated_at: string | null;
};

/** user_personas (20260911000600). */
export type CloudPersonaRow = {
  user_id: string;
  persona_id: string;
  headline: string;
  education: unknown;
  projects: unknown;
  skills: string[];
  interests: string[];
};

/**
 * user_integrations WITHOUT its secret columns (20260911000700). The
 * pull selects these names explicitly; toCloudIntegrationRow() is a
 * whitelist so a `select *` regression can never carry ciphertext into
 * a snapshot on disk.
 */
export type CloudIntegrationRow = {
  user_id: string;
  provider: string;
  status: string;
  account_email: string | null;
  premium: boolean | null;
  scopes: string[];
  connected_at: string | null;
  expires_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
};

export const INTEGRATION_PUBLIC_COLUMNS = [
  "user_id",
  "provider",
  "status",
  "account_email",
  "premium",
  "scopes",
  "connected_at",
  "expires_at",
  "last_checked_at",
  "last_error",
] as const;

export function toCloudIntegrationRow(row: Record<string, unknown>): CloudIntegrationRow {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    user_id: String(row["user_id"] ?? ""),
    provider: String(row["provider"] ?? ""),
    status: String(row["status"] ?? ""),
    account_email: str(row["account_email"]),
    premium: typeof row["premium"] === "boolean" ? row["premium"] : null,
    scopes: Array.isArray(row["scopes"]) ? row["scopes"].map(String) : [],
    connected_at: str(row["connected_at"]),
    expires_at: str(row["expires_at"]),
    last_checked_at: str(row["last_checked_at"]),
    last_error: str(row["last_error"]),
  };
}

export type OnboardedUserExtras = {
  documents?: CloudDocumentRow[];
  screenerAnswers?: CloudScreenerAnswerRow[];
  personas?: CloudPersonaRow[];
  integrations?: CloudIntegrationRow[];
};

export type OnboardedUser = {
  userId: string;
  email: string;
  fullName: string | null;
  phone: string | null;
  location: { city: string | null; region: string | null; country: string | null };
  links: { linkedin: string | null; github: string | null; portfolio: string | null };
  workAuthorization: string | null;
  needsSponsorship: boolean | null;
  education: unknown[];
  jobPreferences: Record<string, unknown>;
  resumeObjectPath: string | null;
  resumeFilename: string | null;
  onboardingCompletedAt: string;
  maxCompletedApplications: number | null;
  /** The whole row, for the materializer (20260911000200 columns included). */
  profile: CloudProfileRow;
  documents: CloudDocumentRow[];
  screenerAnswers: CloudScreenerAnswerRow[];
  persona: CloudPersonaRow | null;
  integrations: CloudIntegrationRow[];
};

function groupByUser<T extends { user_id: string }>(rows: T[] | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows ?? []) {
    const list = m.get(r.user_id) ?? [];
    list.push(r);
    m.set(r.user_id, list);
  }
  return m;
}

export function joinOnboardedUsers(
  users: CloudAppUserRow[],
  profiles: CloudProfileRow[],
  extras: OnboardedUserExtras = {},
): OnboardedUser[] {
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  const docs = groupByUser(extras.documents);
  const answers = groupByUser(extras.screenerAnswers);
  const personas = groupByUser(extras.personas);
  const integrations = groupByUser(extras.integrations);
  const out: OnboardedUser[] = [];
  for (const user of users) {
    const p = byId.get(user.id);
    if (!p || !p.onboarding_completed_at) continue; // half-finished ⇒ never acted on
    out.push({
      userId: user.id,
      email: user.email,
      fullName: p.full_name,
      phone: p.phone,
      location: {
        city: p.location_city,
        region: p.location_region,
        country: p.location_country,
      },
      links: {
        linkedin: p.linkedin_url,
        github: p.github_url,
        portfolio: p.portfolio_url,
      },
      workAuthorization: p.work_authorization,
      needsSponsorship: p.needs_sponsorship,
      education: Array.isArray(p.education) ? p.education : [],
      jobPreferences:
        p.job_preferences !== null &&
        typeof p.job_preferences === "object" &&
        !Array.isArray(p.job_preferences)
          ? (p.job_preferences as Record<string, unknown>)
          : {},
      resumeObjectPath: p.resume_object_path,
      resumeFilename: p.resume_filename,
      onboardingCompletedAt: p.onboarding_completed_at,
      maxCompletedApplications: user.max_completed_applications ?? null,
      profile: p,
      documents: docs.get(user.id) ?? [],
      screenerAnswers: answers.get(user.id) ?? [],
      persona:
        (personas.get(user.id) ?? []).find((x) => x.persona_id === "default") ??
        (personas.get(user.id) ?? [])[0] ??
        null,
      integrations: integrations.get(user.id) ?? [],
    });
  }
  return out;
}

/** Bounded batches for upserts — no single giant network payload. */
export function chunkRows<T>(rows: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer (got ${size})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}
