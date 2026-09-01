import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  type ApplicationRowPublic,
  type Profile,
  type ProfileDraft,
  type QuotaStatus,
} from "./contract";

/**
 * Every Supabase read/write in the public app, in one place, all under
 * the launcher-owned schema (names in contract.ts — placeholder until
 * its contract lands). All calls are RLS-scoped to the signed-in user;
 * nothing here can read anyone else's rows even if it wanted to.
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

/* ── invite redemption across the magic-link hop ─────────────────────
 * The code is entered before the user has a session (magic link goes
 * out, the tab may even be closed). Stash it locally; the first
 * authenticated page attempts redemption exactly once and clears it. */

const PENDING_INVITE_KEY = "dispatch.pendingInvite";

export function stashInviteCode(code: string): void {
  window.localStorage.setItem(PENDING_INVITE_KEY, code.trim());
}

export function peekInviteCode(): string | null {
  return window.localStorage.getItem(PENDING_INVITE_KEY);
}

export type InviteRedemption =
  | { outcome: "none" }
  | { outcome: "redeemed"; code: string }
  | { outcome: "failed"; code: string; reason: string };

/**
 * Redeem a stashed invite code, if any. One attempt per stash (the code
 * is cleared before the call so a server error cannot become an
 * unbounded retry loop; the user can re-enter the code by hand).
 */
export async function redeemPendingInvite(): Promise<InviteRedemption> {
  const code = peekInviteCode();
  if (!code) return { outcome: "none" };
  window.localStorage.removeItem(PENDING_INVITE_KEY);
  try {
    const { error } = await client().rpc(CONTRACT.redeemInviteRpc, {
      code,
    });
    if (error) return { outcome: "failed", code, reason: error.message };
    return { outcome: "redeemed", code };
  } catch (err) {
    return {
      outcome: "failed",
      code,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ── profile ────────────────────────────────────────────────────────── */

export async function getMyProfile(): Promise<Profile | null> {
  const uid = await currentUserId();
  if (!uid) return null;
  const { data, error } = await client()
    .from(CONTRACT.profilesTable)
    .select("*")
    .eq("user_id", uid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as Profile | null) ?? null;
}

export async function saveMyProfile(draft: ProfileDraft): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  const { error } = await client()
    .from(CONTRACT.profilesTable)
    .upsert({ user_id: uid, ...draft }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
}

/* ── resume upload ──────────────────────────────────────────────────── */

const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export async function uploadResume(
  file: File,
): Promise<{ path: string; filename: string }> {
  if (file.type !== "application/pdf") {
    throw new Error("resume must be a PDF");
  }
  if (file.size > MAX_RESUME_BYTES) {
    throw new Error("resume PDF is over 5 MB — export a smaller copy");
  }
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was uploaded");
  // One canonical path per user: re-upload replaces, never accumulates.
  const path = `${uid}/resume.pdf`;
  const { error } = await client()
    .storage.from(CONTRACT.resumesBucket)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(error.message);
  return { path, filename: file.name };
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
    .order("submitted_at", { ascending: false, nullsFirst: false });
  if (error) throw new Error(error.message);
  return (data as ApplicationRowPublic[]) ?? [];
}

/** Short-lived signed URL for a receipt screenshot (private bucket). */
export async function receiptUrl(path: string): Promise<string> {
  const { data, error } = await client()
    .storage.from(CONTRACT.receiptsBucket)
    .createSignedUrl(path, 60 * 10);
  if (error) throw new Error(error.message);
  return data.signedUrl;
}
