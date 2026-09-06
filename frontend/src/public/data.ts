import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  type ApplicationRowPublic,
  type EducationEntry,
  type JobPreferences,
  type ProfileDraft,
  type ProfileRow,
  type QuotaStatus,
  EMPTY_PROFILE,
  PG_UNIQUE_VIOLATION,
} from "./contract";

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

function splitList(commaSeparated: string): string[] {
  return commaSeparated
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function yearOrNull(text: string): number | null {
  return /^\d{4}$/.test(text.trim()) ? Number(text.trim()) : null;
}

export function rowToDraft(row: ProfileRow): ProfileDraft {
  const edu: EducationEntry | undefined = row.education[0];
  const prefs = row.job_preferences as Partial<JobPreferences>;
  return {
    ...EMPTY_PROFILE,
    full_name: row.full_name ?? "",
    phone: row.phone ?? "",
    location_city: row.location_city ?? "",
    location_region: row.location_region ?? "",
    location_country: row.location_country ?? "",
    linkedin_url: row.linkedin_url ?? "",
    github_url: row.github_url ?? "",
    portfolio_url: row.portfolio_url ?? "",
    school: edu?.school ?? "",
    degree: edu?.degree ?? "",
    field: edu?.field ?? "",
    grad_year: edu?.end_year != null ? String(edu.end_year) : "",
    grad_month: edu?.end_month ?? "",
    start_year: edu?.start_year != null ? String(edu.start_year) : "",
    start_month: edu?.start_month ?? "",
    gpa: edu?.gpa != null ? String(edu.gpa) : "",
    additional_fields: edu?.additional_fields ?? "",
    work_authorization: row.work_authorization ?? "",
    needs_sponsorship:
      row.needs_sponsorship === null ? "" : row.needs_sponsorship ? "yes" : "no",
    about_me: row.about_me ?? "",
    current_company: row.current_company ?? "",
    open_to_relocation:
      row.open_to_relocation === null
        ? ""
        : row.open_to_relocation
          ? "yes"
          : "no",
    resume_object_path: row.resume_object_path,
    resume_filename: row.resume_filename,
    transcript_object_path: row.transcript_object_path,
    transcript_filename: row.transcript_filename,
    titles: (prefs.titles ?? []).join(", "),
    locations: (prefs.locations ?? []).join(", "),
    remote: prefs.remote ?? "",
    employment_types: prefs.employment_types ?? [],
    min_salary_usd:
      typeof prefs.min_salary_usd === "number" ? String(prefs.min_salary_usd) : "",
  };
}

function draftToRow(
  userId: string,
  draft: ProfileDraft,
): Omit<ProfileRow, "created_at" | "updated_at" | "onboarding_completed_at"> {
  const gpa = Number(draft.gpa.trim());
  const education: EducationEntry[] = draft.school.trim()
    ? [
        {
          school: draft.school.trim(),
          degree: draft.degree.trim(),
          field: draft.field.trim(),
          start_year: yearOrNull(draft.start_year),
          end_year: yearOrNull(draft.grad_year),
          // Optional keys are omitted rather than written empty: the
          // engine's take() treats "" as absent anyway, and an absent
          // key reads as "not asked" instead of "answered blank".
          ...(Number.isFinite(gpa) && gpa > 0 ? { gpa } : {}),
          ...(draft.start_month.trim()
            ? { start_month: draft.start_month.trim() }
            : {}),
          ...(draft.grad_month.trim()
            ? { end_month: draft.grad_month.trim() }
            : {}),
          ...(draft.additional_fields.trim()
            ? { additional_fields: draft.additional_fields.trim() }
            : {}),
        },
      ]
    : [];
  const salary = Number(draft.min_salary_usd.replace(/[^0-9]/g, ""));
  const job_preferences: JobPreferences = {
    titles: splitList(draft.titles),
    locations: splitList(draft.locations),
    ...(draft.remote !== "" ? { remote: draft.remote } : {}),
    employment_types: draft.employment_types,
    ...(salary > 0 ? { min_salary_usd: salary } : {}),
  };
  return {
    user_id: userId,
    full_name: draft.full_name.trim() || null,
    phone: draft.phone.trim() || null,
    location_city: draft.location_city.trim() || null,
    location_region: draft.location_region.trim() || null,
    location_country: draft.location_country.trim() || null,
    linkedin_url: draft.linkedin_url.trim() || null,
    github_url: draft.github_url.trim() || null,
    portfolio_url: draft.portfolio_url.trim() || null,
    education,
    work_authorization:
      draft.work_authorization === "" ? null : draft.work_authorization,
    needs_sponsorship:
      draft.needs_sponsorship === "" ? null : draft.needs_sponsorship === "yes",
    about_me: draft.about_me.trim() || null,
    current_company: draft.current_company.trim() || null,
    // "" stays null: an unanswered relocation question is not a "no".
    open_to_relocation:
      draft.open_to_relocation === "" ? null : draft.open_to_relocation === "yes",
    resume_object_path: draft.resume_object_path,
    resume_filename: draft.resume_filename,
    resume_uploaded_at: null, // preserved server-side; set by uploadResume
    transcript_object_path: draft.transcript_object_path,
    transcript_filename: draft.transcript_filename,
    transcript_uploaded_at: null, // set by uploadTranscript
    job_preferences,
  };
}

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
 * The wizard's final save. Writes the whole mapped row AND stamps
 * onboarding_completed_at — the engine ignores profiles until that is
 * non-null (contract), so completing the wizard is exactly what makes
 * the account actionable.
 */
export async function saveMyProfile(draft: ProfileDraft): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was saved");
  // Both *_uploaded_at values are owned by their upload functions; the
  // final save must not overwrite them with the null draftToRow carries.
  const {
    resume_uploaded_at: _keepResume,
    transcript_uploaded_at: _keepTranscript,
    ...row
  } = draftToRow(uid, draft);
  const { error } = await client()
    .from(CONTRACT.profilesTable)
    .upsert(
      { ...row, onboarding_completed_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  if (error) throw new Error(error.message);
}

/* ── resume upload ──────────────────────────────────────────────────── */

const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/**
 * Upload to the private resumes bucket — path MUST start with the
 * user's own uid (storage RLS enforces it) — then record the pointer on
 * the profile row immediately (worked example order), so a successful
 * upload can never become an orphaned object if the user closes the tab
 * before the final save.
 */
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
  const path = `${uid}/${file.name}`;
  const { error } = await client()
    .storage.from(CONTRACT.resumesBucket)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(error.message);
  const { error: recordError } = await client()
    .from(CONTRACT.profilesTable)
    .upsert(
      {
        user_id: uid,
        resume_object_path: path,
        resume_filename: file.name,
        resume_uploaded_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (recordError) {
    throw new Error(
      `uploaded, but recording it on your profile failed: ${recordError.message}`,
    );
  }
  return { path, filename: file.name };
}

/* ── transcript upload ──────────────────────────────────────────────── */

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;

/**
 * Same shape as uploadResume, its own bucket.
 *
 * Worth having at all because the engine already knows what to do with
 * it: src/ats/shared/supplementalMaterials.ts attaches a transcript to
 * transcript-labeled file inputs and otherwise logs "no transcript on
 * file — transcript inputs left alone". Live, that silence cost real
 * submissions (Appian 2026-08-29 bounced off a required unofficial
 * transcript; Databricks 2026-09-01 carried two required sections).
 *
 * 10 MB rather than the resume's 5: an unofficial transcript is often a
 * scanned multi-page PDF, and rejecting a real one would send the user
 * to a PDF compressor instead of an application.
 */
export async function uploadTranscript(
  file: File,
): Promise<{ path: string; filename: string }> {
  if (file.type !== "application/pdf") {
    throw new Error("transcript must be a PDF");
  }
  if (file.size > MAX_TRANSCRIPT_BYTES) {
    throw new Error("transcript PDF is over 10 MB — export a smaller copy");
  }
  const uid = await currentUserId();
  if (!uid) throw new Error("not signed in — nothing was uploaded");
  const path = `${uid}/${file.name}`;
  const { error } = await client()
    .storage.from(CONTRACT.transcriptsBucket)
    .upload(path, file, { upsert: true, contentType: "application/pdf" });
  if (error) throw new Error(error.message);
  const { error: recordError } = await client()
    .from(CONTRACT.profilesTable)
    .upsert(
      {
        user_id: uid,
        transcript_object_path: path,
        transcript_filename: file.name,
        transcript_uploaded_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
  if (recordError) {
    throw new Error(
      `uploaded, but recording it on your profile failed: ${recordError.message}`,
    );
  }
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
