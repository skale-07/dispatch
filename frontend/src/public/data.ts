import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  type ApplicationRowPublic,
  type DocumentKind,
  type DocumentRow,
  type EngineControlsRow,
  type EngineJobRow,
  type FeedSampleRow,
  type HandoffKind,
  type HandoffTaskRow,
  type IntegrationProvider,
  type IntegrationRow,
  type MemberStatus,
  type OutreachDraftRow,
  type OnboardingCompletion,
  type PersonaRow,
  type ProfileRow,
  type QuotaStatus,
  type ScreenerAnswerRow,
  PG_UNIQUE_VIOLATION,
} from "./contract";
import { parseSuggestionInputs, type SuggestionInputs } from "./fieldSuggestions";

/**
 * Every Supabase read/write in the public app, in one place, against the
 * launcher-owned schema (names + worked examples:
 * docs/roadmap/cloud-deploy.md §"Frontend ⇄ Supabase contract"). All
 * calls are RLS-scoped to the signed-in user.
 *
 * Error posture matches the rest of this repo: throw the real error and
 * let the page render it — no swallowing, no fake success, no retries
 * without caps.
 */

function client() {
  if (!supabase) {
    throw new Error(
      "account service not configured in this build — nothing was saved",
    );
  }
  return supabase;
}

/**
 * The signed-in user's id from the LOCAL session — auth.getUser() would
 * round-trip to the server, which turns every profile read into a second
 * network dependency and hangs the UI when the service is unreachable.
 * RLS re-checks identity server-side on every query anyway; the id here
 * only builds paths and filters.
 */
async function currentUserId(): Promise<string | null> {
  const { data } = await client().auth.getSession();
  return data.session?.user.id ?? null;
}

/* ── membership (open signup) ───────────────────────────────────────── */

/**
 * Create the signed-in user's app_users row if it does not exist yet
 * (open signup, migration 20260911000100). Idempotent; the server
 * decides `created`. Called once per session by AuthProvider — a failure
 * is surfaced there verbatim, never retried in a loop.
 */
export async function ensureMember(): Promise<MemberStatus> {
  const { data, error } = await client().rpc(CONTRACT.ensureMemberRpc);
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as MemberStatus | null;
  if (!row || typeof row.user_id !== "string") {
    throw new Error("ensure_member returned an unexpected shape");
  }
  return row;
}

/* ── invite redemption across the magic-link hop ─────────────────────
 * The code is entered before the user has a session (magic link goes
 * out, the tab may even be closed). Stash it locally; the first
 * authenticated page attempts redemption exactly once and clears it.
 * Server-side the RPC is atomic and idempotent per user. */

const PENDING_INVITE_KEY = "dispatch.pendingInvite";

export function stashInviteCode(code: string): void {
  window.localStorage.setItem(PENDING_INVITE_KEY, code.trim());
}

export function peekInviteCode(): string | null {
  return window.localStorage.getItem(PENDING_INVITE_KEY);
}

export type InviteRedemption =
  | { outcome: "none" }
  | { outcome: "redeemed"; code: string; maxApplications: number | null }
  | { outcome: "failed"; code: string; reason: string };

/**
 * Redeem a stashed invite code, if any. One attempt per stash (the code
 * is cleared before the call so a server error cannot become an
 * unbounded retry loop; the user can re-enter the code by hand).
 * Server error strings are verbatim contract values (REDEEM_ERRORS:
 * "invalid invite code" | "invite already redeemed" | "not authenticated"
 * | "cannot redeem your own invite" | "already a member") — rendered
 * as-is, never paraphrased into something the server didn't say.
 */
export async function redeemPendingInvite(): Promise<InviteRedemption> {
  const code = peekInviteCode();
  if (!code) return { outcome: "none" };
  window.localStorage.removeItem(PENDING_INVITE_KEY);
  try {
    const { data, error } = await client().rpc(CONTRACT.redeemInviteRpc, {
      [CONTRACT.redeemInviteArg]: code,
    });
    if (error) return { outcome: "failed", code, reason: error.message };
    // Contract: data = { invite_id, max_completed_applications } (a
    // set-returning function would wrap it in an array — accept both).
    const row = (Array.isArray(data) ? data[0] : data) as
      | { max_completed_applications?: number }
      | null;
    return {
      outcome: "redeemed",
      code,
      maxApplications:
        typeof row?.max_completed_applications === "number"
          ? row.max_completed_applications
          : null,
    };
  } catch (err) {
    return {
      outcome: "failed",
      code,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ── profile row ⇄ wizard draft mapping ─────────────────────────────── */
// The pure mapping lives in profileMapping.ts: the onboarding step
// registry and the node tests import it without the Supabase client.

/* ── profile ────────────────────────────────────────────────────────── */

export async function getMyProfile(): Promise<ProfileRow | null> {
  const uid = await currentUserId();
  if (!uid) return null;
  const { data, error } = await client()
    .from(CONTRACT.profilesTable)
    .select("*")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProfileRow | null) ?? null;
}

/**
 * Save part of the profile row without touching onboarding_completed_at
 * (per-step autosave). Column names are the contract's; unknown columns
 * fail visibly with PostgREST's message rather than being dropped.
 *
 * There is deliberately NO client-side "final save" any more: nothing in
 * the browser writes onboarding_completed_at. Only complete_my_onboarding()
 * (below) can, and the server decides (plan M9, 2026-09-12).
 */
export async function saveProfileStep(
  patch: Partial<Omit<ProfileRow, "user_id" | "created_at" | "updated_at">>,
): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const { onboarding_completed_at: _never, ...rest } = patch;
  const { error } = await client()
    .from(CONTRACT.profilesTable)
    .upsert({ user_id: uid, ...rest }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

/** Resume-later pointer for the wizard shell. */
export async function saveOnboardingProgress(step: string): Promise<void> {
  await saveProfileStep({
    onboarding_progress: { step, updated_at: new Date().toISOString() },
  });
}

/**
 * Server-side completeness (20260911000300). Returns what is missing;
 * stamps onboarding_completed_at only when nothing is. The wizard's
 * Review step is its only caller.
 */
export async function completeMyOnboarding(): Promise<OnboardingCompletion> {
  const { data, error } = await client().rpc(CONTRACT.completeOnboardingRpc);
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as OnboardingCompletion | null;
  if (!row || typeof row.complete !== "boolean" || !Array.isArray(row.missing)) {
    throw new Error("complete_my_onboarding returned an unexpected shape");
  }
  return row;
}

/* ── documents (resume variants + transcript as rows) ───────────────── */

const MAX_DOCUMENT_BYTES: Record<DocumentKind, number> = {
  resume: 5 * 1024 * 1024,
  cover_letter: 5 * 1024 * 1024,
  // An unofficial transcript is often a scanned multi-page PDF.
  transcript: 10 * 1024 * 1024,
};

export async function listMyDocuments(): Promise<DocumentRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.documentsTable)
    .select("*")
    .order("kind", { ascending: true })
    .order("is_default", { ascending: false })
    .order("uploaded_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as DocumentRow[] | null) ?? [];
}

/**
 * Upload one PDF into the kind's bucket under the user's own uid prefix
 * (storage RLS) and record the row. Same (user, kind, variant) replaces
 * the previous file. The first document of a kind becomes the default;
 * pass makeDefault to move the default explicitly.
 */
export async function uploadDocument(input: {
  kind: DocumentKind;
  variant?: string;
  file: File;
  roleFamilies?: string[];
  makeDefault?: boolean;
}): Promise<DocumentRow> {
  const variant = (input.variant ?? "general").trim().toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(variant)) {
    throw new Error("variant must be 1-32 lowercase letters, digits or underscores");
  }
  if (input.file.type !== "application/pdf") {
    throw new Error(`${input.kind.replace("_", " ")} must be a PDF`);
  }
  if (input.file.size > MAX_DOCUMENT_BYTES[input.kind]) {
    const mb = MAX_DOCUMENT_BYTES[input.kind] / (1024 * 1024);
    throw new Error(`${input.kind.replace("_", " ")} PDF is over ${mb} MB — export a smaller copy`);
  }
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was uploaded");
  const bucket = input.kind === "transcript" ? CONTRACT.transcriptsBucket : CONTRACT.resumesBucket;
  const path = `${uid}/${input.kind}/${variant}/${input.file.name}`;
  const { error } = await client()
    .storage.from(bucket)
    .upload(path, input.file, { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(error.message);

  const existing = await listMyDocuments();
  const hasDefault = existing.some((d) => d.kind === input.kind && d.is_default);
  const makeDefault = input.makeDefault === true || !hasDefault;
  if (makeDefault && hasDefault) {
    const { error: clearErr } = await client()
      .from(CONTRACT.documentsTable)
      .update({ is_default: false })
      .eq("user_id", uid)
      .eq("kind", input.kind)
      .eq("is_default", true);
    if (clearErr) throw new Error(clearErr.message);
  }
  const { data, error: rowErr } = await client()
    .from(CONTRACT.documentsTable)
    .upsert(
      {
        user_id: uid,
        kind: input.kind,
        variant,
        bucket,
        object_path: path,
        filename: input.file.name,
        role_families: input.roleFamilies ?? [],
        is_default: makeDefault,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: "user_id,kind,variant" },
    )
    .select("*")
    .single();
  if (rowErr) {
    throw new Error(`uploaded, but recording it failed: ${rowErr.message}`);
  }
  return data as DocumentRow;
}

export async function setDefaultDocument(id: string): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const docs = await listMyDocuments();
  const target = docs.find((d) => d.id === id);
  if (!target) throw new Error("document not found");
  const { error: clearErr } = await client()
    .from(CONTRACT.documentsTable)
    .update({ is_default: false })
    .eq("user_id", uid)
    .eq("kind", target.kind)
    .eq("is_default", true);
  if (clearErr) throw new Error(clearErr.message);
  const { error } = await client()
    .from(CONTRACT.documentsTable)
    .update({ is_default: true })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** Delete the row and the object; a missing object is not an error. */
export async function removeDocument(id: string): Promise<void> {
  const docs = await listMyDocuments();
  const target = docs.find((d) => d.id === id);
  if (!target) throw new Error("document not found");
  const { error } = await client().from(CONTRACT.documentsTable).delete().eq("id", id);
  if (error) throw new Error(error.message);
  await client().storage.from(target.bucket).remove([target.object_path]);
}

/* ── screener answers ───────────────────────────────────────────────── */

export async function getMyScreenerAnswers(): Promise<ScreenerAnswerRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.screenerAnswersTable)
    .select("*")
    .order("key", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ScreenerAnswerRow[] | null) ?? [];
}

/**
 * Upsert answers; blank answers DELETE the row (blank = "ask me per
 * application", which is a legal, honest state — not an empty string on
 * a form). Registry/custom validity is enforced by the table's CHECKs.
 */
export async function saveScreenerAnswers(
  rows: Array<{
    key: string;
    kind: "registry" | "custom";
    answer: string;
    labels?: string[];
    source?: ScreenerAnswerRow["source"];
  }>,
): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const keep = rows.filter((r) => r.answer.trim() !== "");
  const drop = rows.filter((r) => r.answer.trim() === "").map((r) => r.key);
  if (drop.length > 0) {
    const { error } = await client()
      .from(CONTRACT.screenerAnswersTable)
      .delete()
      .eq("user_id", uid)
      .in("key", drop);
    if (error) throw new Error(error.message);
  }
  if (keep.length > 0) {
    const { error } = await client()
      .from(CONTRACT.screenerAnswersTable)
      .upsert(
        keep.map((r) => ({
          user_id: uid,
          key: r.key,
          kind: r.kind,
          answer: r.answer.trim(),
          labels: r.labels ?? [],
          source: r.source ?? "wizard",
        })),
        { onConflict: "user_id,key" },
      );
    if (error) throw new Error(error.message);
  }
}

/* ── persona ────────────────────────────────────────────────────────── */

export async function getMyPersona(): Promise<PersonaRow | null> {
  const { data, error } = await client()
    .from(CONTRACT.personasTable)
    .select("*")
    .eq("persona_id", "default")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PersonaRow | null) ?? null;
}

export async function saveMyPersona(
  persona: Omit<PersonaRow, "user_id" | "persona_id" | "updated_at">,
): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const { error } = await client()
    .from(CONTRACT.personasTable)
    .upsert(
      { user_id: uid, persona_id: "default", ...persona },
      { onConflict: "user_id,persona_id" },
    );
  if (error) throw new Error(error.message);
}

export async function deleteMyPersona(): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was deleted");
  const { error } = await client()
    .from(CONTRACT.personasTable)
    .delete()
    .eq("user_id", uid)
    .eq("persona_id", "default");
  if (error) throw new Error(error.message);
}

/* ── integrations (read model + the two user-side writes) ───────────── */

export async function getMyIntegrations(): Promise<IntegrationRow[]> {
  const { data, error } = await client().from(CONTRACT.integrationsView).select("*");
  if (error) throw new Error(error.message);
  return (data as IntegrationRow[] | null) ?? [];
}

/** Only { premium } and { disconnect } are accepted server-side. */
export async function setMyIntegration(
  provider: IntegrationProvider,
  patch: { premium?: boolean; disconnect?: boolean },
): Promise<void> {
  const { error } = await client().rpc(CONTRACT.setIntegrationRpc, {
    p_provider: provider,
    p_patch: patch,
  });
  if (error) throw new Error(error.message);
}

/**
 * Per-user Gmail (20260914000100): hand the PKCE code + verifier to the
 * engine, which exchanges it with the client secret only it holds and
 * refuses any grant wider than readonly + compose. Returns the job id the
 * dashboard can watch; the integration row reads `pending_handoff` until
 * the engine connects it.
 */
export async function submitGmailOauthCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ jobId: string | null }> {
  const { data, error } = await client().rpc(CONTRACT.submitGmailOauthCodeRpc, {
    p_code: input.code,
    p_code_verifier: input.codeVerifier,
    p_redirect_uri: input.redirectUri,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { job_id?: string } | null;
  return { jobId: typeof row?.job_id === "string" ? row.job_id : null };
}

/* ── handoff tasks (the human steps the engine cannot do headlessly) ── */

export async function listMyHandoffTasks(): Promise<HandoffTaskRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.handoffTasksView)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as HandoffTaskRow[] | null) ?? [];
}

/** "I'm ready — open the browser." Idempotent: an active task of the kind is returned. */
export async function requestHandoff(
  kind: HandoffKind,
  context: Record<string, unknown> = {},
): Promise<{ id: string; kind: HandoffKind; status: string }> {
  const { data, error } = await client().rpc(CONTRACT.handoffRequestRpc, {
    p_kind: kind,
    p_context: context,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; kind?: HandoffKind; status?: string } | null;
  if (!row || typeof row.id !== "string") throw new Error("handoff_task_request returned an unexpected shape");
  return { id: row.id, kind: row.kind ?? kind, status: row.status ?? "requested" };
}

/** "I finished in the browser." The engine verifies before believing it. */
export async function handoffUserDone(id: string): Promise<void> {
  const { error } = await client().rpc(CONTRACT.handoffUserDoneRpc, { p_task: id });
  if (error) throw new Error(error.message);
}

export async function handoffCancel(id: string): Promise<void> {
  const { error } = await client().rpc(CONTRACT.handoffCancelRpc, { p_task: id });
  if (error) throw new Error(error.message);
}

/* ── engine jobs + the one requestable kind ─────────────────────────── */

export async function listMyEngineJobs(): Promise<EngineJobRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.engineJobsView)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as EngineJobRow[] | null) ?? [];
}

/** Ask for a feed sample; the server dedupes an active one. */
export async function requestFeedSample(): Promise<{ id: string; created: boolean }> {
  const { data, error } = await client().rpc(CONTRACT.requestEngineJobRpc, {
    p_kind: CONTRACT.requestableJobKind,
  });
  if (error) throw new Error(error.message);
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; created?: boolean } | null;
  if (!row || typeof row.id !== "string") throw new Error("request_engine_job returned an unexpected shape");
  return { id: row.id, created: row.created === true };
}

export async function getMyFeedSample(): Promise<FeedSampleRow | null> {
  const { data, error } = await client().from(CONTRACT.feedSamplesTable).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FeedSampleRow | null) ?? null;
}

export async function listMyOutreachDrafts(): Promise<OutreachDraftRow[]> {
  const { data, error } = await client()
    .from(CONTRACT.outreachDraftsTable)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as OutreachDraftRow[] | null) ?? [];
}

export async function getMyEngineControls(): Promise<EngineControlsRow | null> {
  const { data, error } = await client().from(CONTRACT.engineControlsTable).select("*").maybeSingle();
  if (error) throw new Error(error.message);
  return (data as EngineControlsRow | null) ?? null;
}

/**
 * The stop button: the planner honors `paused` before enqueuing anything.
 * Update-then-insert rather than upsert: the table grants authenticated
 * `insert (user_id, paused)` and `update (paused)` only, and PostgREST's
 * upsert SETs every payload column (user_id included), which those
 * column grants refuse.
 */
export async function setEnginePaused(paused: boolean): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const { data, error } = await client()
    .from(CONTRACT.engineControlsTable)
    .update({ paused })
    .eq("user_id", uid)
    .select("user_id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length > 0) return;
  const { error: insertError } = await client()
    .from(CONTRACT.engineControlsTable)
    .insert({ user_id: uid, paused });
  if (!insertError) return;
  // Two tabs racing to create the row: the loser retries the update once.
  if (insertError.code === PG_UNIQUE_VIOLATION) {
    const { error: retryError } = await client()
      .from(CONTRACT.engineControlsTable)
      .update({ paused })
      .eq("user_id", uid);
    if (retryError) throw new Error(retryError.message);
    return;
  }
  throw new Error(insertError.message);
}

/* ── field-surfacing intelligence (20260911000900) ──────────────────── */

/**
 * Everything the suggestion ranker needs in one call: community
 * aggregates (tenant ids summed away), pins, the user's own events,
 * rules, targets and answered-ness. Parsed defensively — an odd payload
 * ranks as "nothing to suggest", never a crash.
 */
export async function getFieldSuggestionInputs(): Promise<SuggestionInputs> {
  const { data, error } = await client().rpc(CONTRACT.fieldSuggestionInputsRpc);
  if (error) throw new Error(error.message);
  return parseSuggestionInputs(data);
}

/* ── dashboard reads ────────────────────────────────────────────────── */

export async function getMyQuota(): Promise<QuotaStatus | null> {
  const { data, error } = await client()
    .from(CONTRACT.quotaView)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as QuotaStatus | null) ?? null;
}

export async function listMyApplications(): Promise<ApplicationRowPublic[]> {
  const { data, error } = await client()
    .from(CONTRACT.applicationsView)
    .select("*")
    .order("engine_updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as ApplicationRowPublic[]) ?? [];
}

/* ── waitlist (signed-out, anon insert) ─────────────────────────────── */

export type WaitlistOutcome = "joined" | "already";

/**
 * Join the waitlist. Anon may insert and nothing client-side may read
 * the table (RLS), so the only two honest outcomes are "row written" and
 * "that address is already there" (the unique constraint). Any other
 * error is thrown verbatim.
 */
export async function joinWaitlist(email: string): Promise<WaitlistOutcome> {
  const addr = email.trim().toLowerCase();
  const { error } = await client()
    .from(CONTRACT.waitlistTable)
    .insert({ email: addr });
  if (!error) return "joined";
  if (error.code === PG_UNIQUE_VIOLATION) return "already";
  throw new Error(error.message);
}

/** Short-lived signed URL for a receipt screenshot (private bucket). */
export async function receiptUrl(path: string): Promise<string> {
  const { data, error } = await client()
    .storage.from(CONTRACT.receiptsBucket)
    .createSignedUrl(path, 60 * 10);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
