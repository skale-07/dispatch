import { supabase } from "../lib/supabaseClient";
import {
  CONTRACT,
  type ApplicationRowPublic,
  type DocumentKind,
  type DocumentRow,
  type EducationDraft,
  type EducationEntry,
  type EmploymentDraft,
  type EmploymentEntry,
  type IntegrationProvider,
  type IntegrationRow,
  type JobPreferences,
  type MemberStatus,
  type OnboardingCompletion,
  type PersonaRow,
  type ProfileDraft,
  type ProfileRow,
  type QuotaStatus,
  type ScreenerAnswerRow,
  EMPTY_EDUCATION_ENTRY,
  EMPTY_EMPLOYMENT_ENTRY,
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

function splitList(commaSeparated: string): string[] {
  return commaSeparated
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function yearOrNull(text: string): number | null {
  return /^\d{4}$/.test(text.trim()) ? Number(text.trim()) : null;
}

function educationToDraft(e: EducationEntry): EducationDraft {
  return {
    ...EMPTY_EDUCATION_ENTRY,
    school: e.school ?? "",
    degree: e.degree ?? "",
    field: e.field ?? "",
    grad_year: e.end_year != null ? String(e.end_year) : "",
    grad_month: e.end_month ?? "",
    start_year: e.start_year != null ? String(e.start_year) : "",
    start_month: e.start_month ?? "",
    gpa: e.gpa != null ? String(e.gpa) : "",
    additional_fields: e.additional_fields ?? "",
  };
}

function employmentToDraft(e: EmploymentEntry): EmploymentDraft {
  return {
    ...EMPTY_EMPLOYMENT_ENTRY,
    company: e.company ?? "",
    title: e.title ?? "",
    location: e.location ?? "",
    start_month: e.start_month ?? "",
    start_year: e.start_year != null ? String(e.start_year) : "",
    end_month: e.end_month ?? "",
    end_year: e.end_year != null ? String(e.end_year) : "",
    current: e.current === true,
    summary: e.summary ?? "",
  };
}

export function rowToDraft(row: ProfileRow): ProfileDraft {
  const edu: EducationEntry | undefined = row.education[0];
  const prefs = row.job_preferences as Partial<JobPreferences>;
  return {
    ...EMPTY_PROFILE,
    full_name: row.full_name ?? "",
    legal_first_name: row.legal_first_name ?? "",
    legal_middle_name: row.legal_middle_name ?? "",
    legal_last_name: row.legal_last_name ?? "",
    preferred_name: row.preferred_name ?? "",
    contact_email: row.contact_email ?? "",
    address_line1: row.address_line1 ?? "",
    address_line2: row.address_line2 ?? "",
    postal_code: row.postal_code ?? "",
    how_heard: row.how_heard ?? "",
    how_heard_fallbacks: (row.how_heard_fallbacks ?? []).join(", "),
    restrictive_covenants: row.restrictive_covenants ?? "",
    skills: (row.skills ?? []).join(", "),
    more_education: (Array.isArray(row.education) ? row.education.slice(1) : []).map(
      educationToDraft,
    ),
    employment_history: (Array.isArray(row.employment_history)
      ? row.employment_history
      : []
    ).map(employmentToDraft),
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

function educationEntryFromDraft(d: EducationDraft): EducationEntry | null {
  if (!d.school.trim()) return null;
  const gpa = Number(d.gpa.trim());
  return {
    school: d.school.trim(),
    degree: d.degree.trim(),
    field: d.field.trim(),
    start_year: yearOrNull(d.start_year),
    end_year: yearOrNull(d.grad_year),
    // Optional keys are omitted rather than written empty: the engine's
    // take() treats "" as absent anyway, and an absent key reads as "not
    // asked" instead of "answered blank".
    ...(Number.isFinite(gpa) && gpa > 0 ? { gpa } : {}),
    ...(d.start_month.trim() ? { start_month: d.start_month.trim() } : {}),
    ...(d.grad_month.trim() ? { end_month: d.grad_month.trim() } : {}),
    ...(d.additional_fields.trim()
      ? { additional_fields: d.additional_fields.trim() }
      : {}),
  };
}

function employmentEntryFromDraft(d: EmploymentDraft): EmploymentEntry | null {
  if (!d.company.trim() && !d.title.trim()) return null;
  return {
    company: d.company.trim(),
    title: d.title.trim(),
    ...(d.location.trim() ? { location: d.location.trim() } : {}),
    ...(d.start_month.trim() ? { start_month: d.start_month.trim() } : {}),
    start_year: yearOrNull(d.start_year),
    ...(d.end_month.trim() ? { end_month: d.end_month.trim() } : {}),
    end_year: yearOrNull(d.end_year),
    ...(d.current ? { current: true } : {}),
    ...(d.summary.trim() ? { summary: d.summary.trim() } : {}),
  };
}

function draftToRow(
  userId: string,
  draft: ProfileDraft,
): Omit<ProfileRow, "created_at" | "updated_at" | "onboarding_completed_at"> {
  // education[0] is the PRIMARY entry (the flat draft keys); additional
  // schools follow in the order the user listed them.
  const primary = educationEntryFromDraft({
    school: draft.school,
    degree: draft.degree,
    field: draft.field,
    grad_year: draft.grad_year,
    grad_month: draft.grad_month,
    start_year: draft.start_year,
    start_month: draft.start_month,
    gpa: draft.gpa,
    additional_fields: draft.additional_fields,
  });
  const education: EducationEntry[] = [
    ...(primary ? [primary] : []),
    ...draft.more_education
      .map(educationEntryFromDraft)
      .filter((e): e is EducationEntry => e !== null),
  ];
  const employment_history: EmploymentEntry[] = draft.employment_history
    .map(employmentEntryFromDraft)
    .filter((e): e is EmploymentEntry => e !== null);
  const legalFirst = draft.legal_first_name.trim();
  const legalLast = draft.legal_last_name.trim();
  // The greeting name follows the legal name once that is filled in;
  // until then it is whatever the user typed as full_name.
  const fullName =
    legalFirst && legalLast ? `${legalFirst} ${legalLast}` : draft.full_name.trim();
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
    full_name: fullName || null,
    legal_first_name: legalFirst || null,
    legal_middle_name: draft.legal_middle_name.trim() || null,
    legal_last_name: legalLast || null,
    preferred_name: draft.preferred_name.trim() || null,
    contact_email: draft.contact_email.trim().toLowerCase() || null,
    address_line1: draft.address_line1.trim() || null,
    address_line2: draft.address_line2.trim() || null,
    postal_code: draft.postal_code.trim() || null,
    how_heard: draft.how_heard.trim() || null,
    how_heard_fallbacks: splitList(draft.how_heard_fallbacks),
    // "" stays null: an unanswered non-compete question is not a "no".
    restrictive_covenants:
      draft.restrictive_covenants === "" ? null : draft.restrictive_covenants,
    skills: splitList(draft.skills),
    employment_history,
    onboarding_progress: null, // owned by saveOnboardingProgress
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
    onboarding_progress: _keepProgress,
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

/**
 * Save part of the profile row without touching onboarding_completed_at
 * (per-step autosave). Column names are the contract's; unknown columns
 * fail visibly with PostgREST's message rather than being dropped.
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
 * stamps onboarding_completed_at only when nothing is. The new wizard's
 * Review step calls this; saveMyProfile above still stamps directly for
 * the current 6-step wizard until that step lands.
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
  await recordLegacyDocument(uid, "resume", CONTRACT.resumesBucket, path, file.name);
  return { path, filename: file.name };
}

/**
 * The legacy single-file uploads above keep writing the profile columns
 * for one release AND record the same object as the 'general' document
 * row (20260911000300), so the engine's per-variant reader sees it.
 */
async function recordLegacyDocument(
  uid: string,
  kind: DocumentKind,
  bucket: string,
  objectPath: string,
  filename: string,
): Promise<void> {
  const { error } = await client()
    .from(CONTRACT.documentsTable)
    .upsert(
      {
        user_id: uid,
        kind,
        variant: "general",
        bucket,
        object_path: objectPath,
        filename,
        is_default: true,
        uploaded_at: new Date().toISOString(),
      },
      { onConflict: "user_id,kind,variant" },
    );
  if (error) {
    throw new Error(`uploaded, but recording the document row failed: ${error.message}`);
  }
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
  await recordLegacyDocument(uid, "transcript", CONTRACT.transcriptsBucket, path, file.name);
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
