/**
 * The engine side of the cloud work queue (supabase/migrations/
 * 20260911000800_engine_queue.sql).
 *
 * Two halves, deliberately separated:
 *
 *   - PURE MAPPERS. Like `syncMapping.ts`, the field-by-field construction
 *     below IS the engine → cloud data boundary. A feed sample carries a
 *     title, a company and a location; an outreach draft records THAT a
 *     draft exists, never a body; a handoff task carries a reason and a
 *     context, never a credential. Adding a field here needs the same
 *     scrutiny as a new capability flag.
 *
 *   - CLIENT CALLS. Thin wrappers over the RPCs, taking a structurally
 *     typed client so the unit tests drive them with a fake and no key,
 *     no flag and no network exist in the test process.
 *
 * Nothing here reads config or opens a connection: the caller (the tenant
 * scheduler, milestone 18) owns the gate and the client.
 */

import { GMAIL_READONLY_SCOPE } from "../gmail/readonlyGuards.js";

const MAX_TEXT = 300;
/** A feed sample is a teaser, not a feed dump. */
const MAX_SAMPLE_JOBS = 25;

export const ENGINE_JOB_KINDS = [
  "apply",
  "outreach",
  "feed_sample",
  "reconnect_verify",
  "gmail_exchange",
] as const;
export type EngineJobKind = (typeof ENGINE_JOB_KINDS)[number];

export const ENGINE_JOB_STATUSES = ["queued", "leased", "succeeded", "failed", "dead"] as const;
export type EngineJobStatus = (typeof ENGINE_JOB_STATUSES)[number];

/** What `complete_engine_job` accepts — 'failed' is retryable, 'dead' is not. */
export const ENGINE_JOB_COMPLETIONS = ["succeeded", "failed", "dead"] as const;
export type EngineJobCompletion = (typeof ENGINE_JOB_COMPLETIONS)[number];

export const HANDOFF_KINDS = [
  "jobright_connect",
  "jobright_reconnect",
  "ats_login",
  "captcha",
  "gmail_connect",
  "gmail_reconnect",
] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const HANDOFF_STATUSES = [
  "open",
  "requested",
  "provisioning",
  "live",
  "user_done",
  "verifying",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** The engine_status.state values added by 20260911000800. */
export const ENGINE_STATES = ["idle", "running", "parked", "quota_exhausted"] as const;
export type EngineState = (typeof ENGINE_STATES)[number];

export type EngineJob = {
  id: string;
  user_id: string;
  kind: EngineJobKind;
  status: EngineJobStatus;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

function clampText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
}

function nonNegInt(n: number | null | undefined): number {
  return Number.isFinite(n) && (n as number) > 0 ? Math.floor(n as number) : 0;
}

// ── pure mappers ─────────────────────────────────────────────────────

export type EngineJobResult = {
  p_job: string;
  p_status: EngineJobCompletion;
  p_result: Record<string, unknown>;
  p_retry_after_s: number;
};

/**
 * Arguments for `complete_engine_job`. The result object is intentionally
 * small and fixed-shape: a run's artifacts stay on the engine box, and the
 * dashboard only needs to say what happened.
 */
export function toEngineJobResult(input: {
  jobId: string;
  status: EngineJobCompletion;
  applied?: number;
  submitted?: number;
  error?: string | null;
  note?: string | null;
  retryAfterSeconds?: number;
}): EngineJobResult {
  if (input.jobId.trim() === "") throw new Error("engine job result requires a job id");
  if (!ENGINE_JOB_COMPLETIONS.includes(input.status)) {
    throw new Error(`unknown engine job completion: ${input.status}`);
  }
  return {
    p_job: input.jobId,
    p_status: input.status,
    p_result: {
      applied: nonNegInt(input.applied),
      submitted: nonNegInt(input.submitted),
      error: clampText(input.error),
      note: clampText(input.note),
    },
    // The SQL clamps too; mirroring it here keeps the retry cap visible
    // on the engine side (house rule: attempt caps on every retry loop).
    p_retry_after_s: Math.min(Math.max(nonNegInt(input.retryAfterSeconds) || 300, 10), 86_400),
  };
}

export type HandoffTaskRow = {
  user_id: string;
  kind: HandoffKind;
  status: HandoffStatus;
  reason: string | null;
  context: Record<string, unknown>;
  live_view_url: string | null;
  provider_session_id: string | null;
  expires_at: string | null;
};

/**
 * A handoff the engine opens or advances. `context` is whitelisted to the
 * three things the dashboard shows — a host, the application it blocks,
 * and the ATS — so a caller cannot smuggle page content or credentials
 * into a client-readable column.
 */
export function toHandoffTaskRow(input: {
  userId: string;
  kind: HandoffKind;
  status: HandoffStatus;
  reason?: string | null;
  host?: string | null;
  engineApplicationId?: string | null;
  ats?: string | null;
  liveViewUrl?: string | null;
  providerSessionId?: string | null;
  expiresAt?: Date | null;
}): HandoffTaskRow {
  if (input.userId.trim() === "") throw new Error("handoff task requires a cloud user id");
  if (!HANDOFF_KINDS.includes(input.kind)) throw new Error(`unknown handoff kind: ${input.kind}`);
  if (!HANDOFF_STATUSES.includes(input.status)) {
    throw new Error(`unknown handoff status: ${input.status}`);
  }

  const context: Record<string, unknown> = {};
  const host = clampText(input.host);
  const applicationId = clampText(input.engineApplicationId);
  const ats = clampText(input.ats);
  if (host !== null) context.host = host;
  if (applicationId !== null) context.engine_application_id = applicationId;
  if (ats !== null) context.ats = ats;

  return {
    user_id: input.userId,
    kind: input.kind,
    status: input.status,
    reason: clampText(input.reason),
    context,
    live_view_url: clampText(input.liveViewUrl),
    provider_session_id: clampText(input.providerSessionId),
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
  };
}

export type FeedSampleJob = { title: string; company: string; location: string };

export type FeedSampleRow = {
  user_id: string;
  sampled_at: string;
  jobs: FeedSampleJob[];
  count: number;
  note: string | null;
};

/**
 * Proof the user's own JobRight filters produce a workable feed. Each entry
 * is rebuilt from exactly three fields — a posting's description, url, id
 * and salary cannot survive this function even if the caller passes them.
 */
export function toFeedSampleRow(input: {
  userId: string;
  now: Date;
  jobs: ReadonlyArray<{ title?: string | null; company?: string | null; location?: string | null }>;
  totalCount?: number;
  note?: string | null;
}): FeedSampleRow {
  if (input.userId.trim() === "") throw new Error("feed sample requires a cloud user id");
  const jobs = input.jobs.slice(0, MAX_SAMPLE_JOBS).map((j) => ({
    title: clampText(j.title) ?? "",
    company: clampText(j.company) ?? "",
    location: clampText(j.location) ?? "",
  }));
  return {
    user_id: input.userId,
    sampled_at: input.now.toISOString(),
    jobs,
    // The sample is truncated; the count is how many the feed actually had,
    // which is the untruncated input length unless the caller knows better.
    count: input.totalCount === undefined ? input.jobs.length : nonNegInt(input.totalCount),
    note: clampText(input.note),
  };
}

export type OutreachDraftRow = {
  user_id: string;
  engine_application_id: string;
  company: string | null;
  contact_name: string | null;
  subject: string | null;
  gmail_draft_id: string | null;
};

/**
 * Records THAT a referral draft is waiting in the user's own Gmail Drafts.
 * There is deliberately no body field: the draft's text never leaves the
 * engine box, and the dashboard links to Gmail instead of re-rendering it.
 */
export function toOutreachDraftRow(input: {
  userId: string;
  engineApplicationId: string;
  company?: string | null;
  contactName?: string | null;
  subject?: string | null;
  gmailDraftId?: string | null;
}): OutreachDraftRow {
  if (input.userId.trim() === "") throw new Error("outreach draft requires a cloud user id");
  if (input.engineApplicationId.trim() === "") {
    throw new Error("outreach draft requires an engine application id");
  }
  return {
    user_id: input.userId,
    engine_application_id: input.engineApplicationId,
    company: clampText(input.company),
    contact_name: clampText(input.contactName),
    subject: clampText(input.subject),
    gmail_draft_id: clampText(input.gmailDraftId),
  };
}

export type UserIntegrationsRow = {
  user_id: string;
  provider: "jobright" | "gmail";
  status: "disconnected" | "pending_handoff" | "connected" | "expired" | "revoked";
  account_email: string | null;
  scopes: string[];
  expires_at: string | null;
  last_error: string | null;
};

/**
 * The Gmail scopes the engine may record — sourced from the safety
 * boundary, never spelled out here. Today that is readonly and only
 * readonly: `compose` is still a forbidden identifier repo-wide
 * (src/gmail/readonlyGuards.ts, enforced by scripts/check-forbidden.ts).
 * When per-user drafting lands, `readonlyGuards` widens once — with the
 * send-endpoint bans that must accompany it — and this filter follows
 * automatically rather than drifting ahead of the guard.
 */
const STORABLE_GMAIL_SCOPES: readonly string[] = [GMAIL_READONLY_SCOPE];

/**
 * The non-secret half of an integration row. The secret itself never goes
 * through here — it moves via `engine_store_integration_secret`, which
 * encrypts in-DB. A grant wider than the product's own scopes is dropped
 * rather than stored.
 */
export function toUserIntegrationsRow(input: {
  userId: string;
  provider: "jobright" | "gmail";
  status: UserIntegrationsRow["status"];
  accountEmail?: string | null;
  scopes?: readonly string[];
  expiresAt?: Date | null;
  error?: string | null;
}): UserIntegrationsRow {
  if (input.userId.trim() === "") throw new Error("integration row requires a cloud user id");
  const scopes =
    input.provider === "gmail"
      ? (input.scopes ?? []).filter((s) => STORABLE_GMAIL_SCOPES.includes(s))
      : [];
  return {
    user_id: input.userId,
    provider: input.provider,
    status: input.status,
    account_email: clampText(input.accountEmail),
    scopes,
    expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
    last_error: clampText(input.error),
  };
}

// ── client calls ─────────────────────────────────────────────────────

type RpcResult = { data: unknown; error: { message: string } | null };
type UpsertResult = { error: { message: string } | null };

/**
 * Structural subset of supabase-js. Declared here so this module imports
 * no dependency and the tests can pass a hand-written fake.
 */
export type EngineQueueClient = {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
  from(table: string): {
    upsert(rows: unknown, options?: { onConflict?: string }): PromiseLike<UpsertResult>;
  };
};

/** Ceiling on one lease call — the scheduler runs bounded, never greedy. */
export const MAX_LEASE_BATCH = 50;

export async function leaseEngineJobs(
  client: EngineQueueClient,
  options: { owner: string; limit?: number; kinds?: readonly EngineJobKind[]; leaseSeconds?: number },
): Promise<EngineJob[]> {
  if (options.owner.trim() === "") throw new Error("lease requires an owner");
  const { data, error } = await client.rpc("lease_engine_jobs", {
    p_owner: options.owner,
    p_limit: Math.min(Math.max(options.limit ?? 1, 1), MAX_LEASE_BATCH),
    p_kinds: options.kinds && options.kinds.length > 0 ? [...options.kinds] : null,
    p_lease_s: options.leaseSeconds ?? 900,
  });
  if (error) throw new Error(`lease_engine_jobs failed: ${error.message}`);
  return Array.isArray(data) ? (data as EngineJob[]) : [];
}

export async function completeEngineJob(
  client: EngineQueueClient,
  result: EngineJobResult,
): Promise<{ id: string; status: string }> {
  const { data, error } = await client.rpc("complete_engine_job", { ...result });
  if (error) throw new Error(`complete_engine_job failed: ${error.message}`);
  return data as { id: string; status: string };
}

export async function reapEngineJobLeases(
  client: EngineQueueClient,
): Promise<{ requeued: number; dead: number }> {
  const { data, error } = await client.rpc("reap_engine_job_leases");
  if (error) throw new Error(`reap_engine_job_leases failed: ${error.message}`);
  const row = (data ?? {}) as { requeued?: number; dead?: number };
  return { requeued: nonNegInt(row.requeued), dead: nonNegInt(row.dead) };
}

export async function pushHandoffTask(
  client: EngineQueueClient,
  row: HandoffTaskRow,
): Promise<void> {
  const { error } = await client.from("handoff_tasks").upsert(row, { onConflict: "user_id,kind" });
  if (error) throw new Error(`handoff_tasks upsert failed: ${error.message}`);
}

export async function pushFeedSample(
  client: EngineQueueClient,
  row: FeedSampleRow,
): Promise<void> {
  const { error } = await client
    .from("jobright_feed_samples")
    .upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(`jobright_feed_samples upsert failed: ${error.message}`);
}

export async function pushOutreachDrafts(
  client: EngineQueueClient,
  rows: OutreachDraftRow[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await client
    .from("outreach_drafts")
    .upsert(rows, { onConflict: "user_id,engine_application_id,gmail_draft_id" });
  if (error) throw new Error(`outreach_drafts upsert failed: ${error.message}`);
  return rows.length;
}
