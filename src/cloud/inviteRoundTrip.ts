import type { AppConfig } from "../config/env.js";
import type { MintedInvite } from "./invites.js";
import type { FetchLike } from "./schema.js";

/**
 * Invite lifecycle against the REAL Supabase project, driven from the
 * engine machine with the service-role key (docs/roadmap/cloud-deploy.md,
 * docs/roadmap/invite-round-trip-2026-09-02.md).
 *
 * Two capabilities, both behind SUPABASE_SYNC_ENABLED (the one flag that
 * lets this process write to the cloud plane):
 *
 * - `loadInvitesToSupabase` — the `--load` half of `npm run invites:mint`:
 *   POSTs minted codes into `public.invites` (idempotent on `code`).
 * - `runInviteRoundTrip` — `npm run invites:roundtrip`: a self-cleaning
 *   proof that redeem -> quota-decrement -> quota-exhausted works on the
 *   live project. It mints ONE throwaway invite, creates throwaway auth
 *   users (`invite-roundtrip-*@example.com`), redeems as a real user JWT
 *   (so RLS + the SECURITY DEFINER RPC are exercised exactly as the SPA
 *   would), counts COMPLETED mirror rows against the quota, proves a
 *   second account is refused, and deletes everything it created.
 *
 * Open signup (20260911000100) is covered too: B joins with ensure_member
 * (no invite, free quota only) before redeeming A's referral, which then
 * ADDS to the free allowance.
 *
 * Every step is recorded with a deterministic read-back; the result's
 * `validation_level` is LIVE_MUTATION_CONFIRMED only when every read-back
 * matched. No step touches the local SQLite database.
 */

export type RoundTripStep = {
  step: string;
  ok: boolean;
  detail: string;
};

export type RoundTripResult = {
  ok: boolean;
  validation_level: "LIVE_MUTATION_CONFIRMED" | "UNVERIFIED";
  invite_code: string;
  quota: number;
  steps: RoundTripStep[];
  cleanup: RoundTripStep[];
};

export type CloudWriteTarget = { url: string; serviceRoleKey: string };

/** Refuses loudly by name; a half-configured cloud write must never half-run. */
export function assertCloudWriteConfigured(config: AppConfig): CloudWriteTarget {
  if (!config.supabaseSyncEnabled) {
    throw new Error(
      "SUPABASE_SYNC_ENABLED is false (fail-closed default). Set it in .env to write invites to Supabase.",
    );
  }
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `SUPABASE_SYNC_ENABLED is true but ${missing.join(", ")} missing — both live in the engine .env only.`,
    );
  }
  return { url: config.supabaseUrl!, serviceRoleKey: config.supabaseServiceRoleKey! };
}

type Json = Record<string, unknown>;

class RestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    context: string,
  ) {
    super(`${context}: HTTP ${status} ${truncate(body)}`);
  }
}

function truncate(s: string): string {
  return s.length > 240 ? `${s.slice(0, 240)}…` : s;
}

function isSchemaMissing(err: unknown): boolean {
  return err instanceof RestError && err.status === 404 && /PGRST20[25]/.test(err.body);
}

/** Thin JSON client over the project's REST/Auth APIs; injectable for tests. */
class ProjectClient {
  private readonly base: string;
  private readonly f: FetchLike;

  constructor(
    readonly target: CloudWriteTarget,
    fetchImpl?: FetchLike,
  ) {
    this.base = target.url.replace(/\/+$/, "");
    this.f = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async call(
    path: string,
    init: {
      method?: string;
      bearer?: string;
      body?: unknown;
      prefer?: string;
    } = {},
    context = path,
  ): Promise<{ status: number; json: unknown; text: string }> {
    const headers: Record<string, string> = {
      apikey: this.target.serviceRoleKey,
      Authorization: `Bearer ${init.bearer ?? this.target.serviceRoleKey}`,
      "Content-Type": "application/json",
    };
    if (init.prefer) headers["Prefer"] = init.prefer;
    const res = await this.f(`${this.base}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RestError(res.status, text, context);
    }
    return { status: res.status, json, text };
  }
}

export type LoadResult = {
  attempted: number;
  inserted: number;
  /** Codes already present cloud-side (re-load is harmless). */
  skipped_existing: number;
  /** Deterministic read-back: every attempted code exists afterwards. */
  read_back_ok: boolean;
};

/**
 * Loads minted invites into `public.invites`. Idempotent: an existing code
 * is left untouched (`on_conflict=code`, ignore-duplicates). Read-back
 * selects the codes with the service role — unredeemed codes are secrets,
 * so nothing here is ever logged beyond counts.
 */
export async function loadInvitesToSupabase(input: {
  target: CloudWriteTarget;
  invites: MintedInvite[];
  fetch?: FetchLike;
}): Promise<LoadResult> {
  const client = new ProjectClient(input.target, input.fetch);
  const rows = input.invites.map((inv) => ({
    code: inv.code,
    issuer: inv.issuer,
    max_completed_applications: inv.maxCompletedApplications,
    note: inv.note,
  }));
  let inserted = 0;
  try {
    const res = await client.call(
      "/rest/v1/invites?on_conflict=code",
      {
        method: "POST",
        body: rows,
        prefer: "resolution=ignore-duplicates,return=representation",
      },
      "insert invites",
    );
    inserted = Array.isArray(res.json) ? res.json.length : 0;
  } catch (err) {
    if (isSchemaMissing(err)) {
      throw new Error(
        "public.invites does not exist on the project — apply the schema first (npm run cloud:schema -- apply, or paste supabase/migrations/ in the SQL editor).",
      );
    }
    throw err;
  }
  const codes = rows.map((r) => r.code);
  const back = await client.call(
    `/rest/v1/invites?select=code&code=in.(${codes.map((c) => `"${c}"`).join(",")})`,
    {},
    "read back invites",
  );
  const found = new Set(
    (Array.isArray(back.json) ? back.json : []).map((r) => (r as Json)["code"]),
  );
  return {
    attempted: rows.length,
    inserted,
    skipped_existing: rows.length - inserted,
    read_back_ok: codes.every((c) => found.has(c)),
  };
}

function throwawayEmail(tag: string, now: number): string {
  return `invite-roundtrip-${tag}-${now}@example.com`;
}

/**
 * Creates a confirmed throwaway auth user and returns a real session JWT
 * for it (magic-link hashed_token -> verify), the same token shape the SPA
 * holds after sign-in. Admin API only; no email is ever sent.
 */
async function createUserWithSession(
  client: ProjectClient,
  email: string,
): Promise<{ userId: string; accessToken: string }> {
  const created = await client.call(
    "/auth/v1/admin/users",
    { method: "POST", body: { email, email_confirm: true } },
    "admin create user",
  );
  const userId = String((created.json as Json)["id"] ?? "");
  if (!userId) throw new Error("admin create user: no id in response");

  const link = await client.call(
    "/auth/v1/admin/generate_link",
    { method: "POST", body: { type: "magiclink", email } },
    "admin generate_link",
  );
  const linkJson = link.json as Json;
  const hashed =
    (linkJson["hashed_token"] as string | undefined) ??
    ((linkJson["properties"] as Json | undefined)?.["hashed_token"] as string | undefined);
  if (!hashed) throw new Error("admin generate_link: no hashed_token in response");

  const session = await client.call(
    "/auth/v1/verify",
    { method: "POST", body: { type: "magiclink", token_hash: hashed } },
    "verify magic link",
  );
  const accessToken = String((session.json as Json)["access_token"] ?? "");
  if (!accessToken) throw new Error("verify magic link: no access_token in response");
  return { userId, accessToken };
}

type QuotaRead = {
  max: number;
  completed: number;
  remaining: number;
  /** Appended by 20260911000100 (open signup); null on an older schema. */
  free: number | null;
  hasInvite: boolean | null;
};

async function readQuota(client: ProjectClient, bearer: string): Promise<QuotaRead | null> {
  const res = await client.call(
    "/rest/v1/user_quota_status?select=*",
    { bearer },
    "read user_quota_status",
  );
  const row = Array.isArray(res.json) ? (res.json[0] as Json | undefined) : undefined;
  if (!row) return null;
  return {
    max: Number(row["max_completed_applications"]),
    completed: Number(row["completed_applications"]),
    remaining: Number(row["remaining"]),
    free:
      typeof row["free_completed_applications"] === "number"
        ? row["free_completed_applications"]
        : null,
    hasInvite: typeof row["has_invite"] === "boolean" ? row["has_invite"] : null,
  };
}

export async function runInviteRoundTrip(input: {
  target: CloudWriteTarget;
  invite: MintedInvite;
  fetch?: FetchLike;
  now?: () => number;
}): Promise<RoundTripResult> {
  const client = new ProjectClient(input.target, input.fetch);
  const now = (input.now ?? Date.now)();
  const quota = input.invite.maxCompletedApplications;
  const code = input.invite.code;
  const steps: RoundTripStep[] = [];
  const cleanup: RoundTripStep[] = [];
  const createdUserIds: string[] = [];
  let loaded = false;

  const record = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
  };

  try {
    // 1. Load the throwaway invite.
    const load = await loadInvitesToSupabase({
      target: input.target,
      invites: [input.invite],
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    loaded = true;
    record("load_invite", load.read_back_ok, `inserted=${load.inserted} read_back_ok=${load.read_back_ok}`);
    if (!load.read_back_ok) throw new Error("invite not readable after load");

    // 2. Throwaway user A with a real session JWT.
    const a = await createUserWithSession(client, throwawayEmail("a", now));
    createdUserIds.push(a.userId);
    record("create_user_a", true, `user_id=${a.userId} session=jwt`);

    // 3. Redeem as A (authenticated role via JWT; RPC is SECURITY DEFINER).
    const redeem = await client.call(
      "/rest/v1/rpc/redeem_invite",
      { method: "POST", bearer: a.accessToken, body: { invite_code: code } },
      "redeem_invite as A",
    );
    const redeemJson = redeem.json as Json;
    const redeemOk = Number(redeemJson["max_completed_applications"]) === quota;
    record("redeem_as_a", redeemOk, `rpc returned max_completed_applications=${redeemJson["max_completed_applications"]}`);
    if (!redeemOk) throw new Error("redeem_invite returned unexpected quota");

    // 4. Read-back: invite row marks A; app_users has A; quota view = quota.
    const inv = await client.call(
      `/rest/v1/invites?select=redeemed_by,redeemed_at&code=eq.${code}`,
      {},
      "read back invite",
    );
    const invRow = (Array.isArray(inv.json) ? inv.json[0] : undefined) as Json | undefined;
    const invOk = invRow?.["redeemed_by"] === a.userId && typeof invRow?.["redeemed_at"] === "string";
    record("invite_marked_redeemed", invOk, `redeemed_by matches A: ${invOk}`);
    if (!invOk) throw new Error("invite row not marked redeemed by A");

    // Open signup (20260911000100): every member also holds the free
    // allowance, so A's effective quota is invite + free. `total` is the
    // number every later decrement step counts down from.
    const q0 = await readQuota(client, a.accessToken);
    const free = q0?.free ?? 0;
    const total = quota + free;
    const q0Ok =
      q0 !== null && q0.max === total && q0.completed === 0 && q0.remaining === total &&
      q0.hasInvite !== false;
    record(
      "quota_after_redeem",
      q0Ok,
      `user_quota_status=${JSON.stringify(q0)} (invite ${quota} + free ${free})`,
    );
    if (!q0Ok) throw new Error("quota view did not show invite + free quota after redeem");

    // 5. Decrement: one COMPLETED mirror row at a time (service role, as
    //    the sync worker would write them), reading the view as A each time.
    for (let n = 1; n <= total; n += 1) {
      await client.call(
        "/rest/v1/application_status_mirror",
        {
          method: "POST",
          body: {
            user_id: a.userId,
            engine_application_id: `roundtrip-${now}-${n}`,
            company: "Round Trip Co",
            role: `Proof ${n}`,
            state: "COMPLETED",
          },
          prefer: "return=minimal",
        },
        `mirror COMPLETED #${n}`,
      );
      const q = await readQuota(client, a.accessToken);
      const ok = q !== null && q.completed === n && q.remaining === total - n;
      record(`quota_after_completed_${n}`, ok, `user_quota_status=${JSON.stringify(q)}`);
      if (!ok) throw new Error(`quota did not decrement to ${total - n}`);
    }

    // 6. Exhausted: one more COMPLETED must not go negative.
    await client.call(
      "/rest/v1/application_status_mirror",
      {
        method: "POST",
        body: {
          user_id: a.userId,
          engine_application_id: `roundtrip-${now}-overflow`,
          company: "Round Trip Co",
          role: "Overflow",
          state: "COMPLETED",
        },
        prefer: "return=minimal",
      },
      "mirror COMPLETED overflow",
    );
    const qx = await readQuota(client, a.accessToken);
    const exhaustedOk = qx !== null && qx.completed === total + 1 && qx.remaining === 0;
    record("quota_exhausted_clamps_at_zero", exhaustedOk, `user_quota_status=${JSON.stringify(qx)}`);
    if (!exhaustedOk) throw new Error("exhausted quota did not clamp at 0");

    // 7. Same user re-redeeming is idempotent.
    const again = await client.call(
      "/rest/v1/rpc/redeem_invite",
      { method: "POST", bearer: a.accessToken, body: { invite_code: code } },
      "redeem_invite again as A",
    );
    const againOk = Number((again.json as Json)["max_completed_applications"]) === quota;
    record("redeem_again_as_a_idempotent", againOk, "same user, same code: success without a second row");

    // 8. A second account must be refused.
    const b = await createUserWithSession(client, throwawayEmail("b", now));
    createdUserIds.push(b.userId);
    let refused = false;
    let refusedDetail = "";
    try {
      await client.call(
        "/rest/v1/rpc/redeem_invite",
        { method: "POST", bearer: b.accessToken, body: { invite_code: code } },
        "redeem_invite as B",
      );
      refusedDetail = "B was allowed to redeem an already-redeemed code";
    } catch (err) {
      refused = err instanceof RestError && /invite already redeemed/.test(err.body);
      refusedDetail = err instanceof RestError ? `HTTP ${err.status} ${truncate(err.body)}` : String(err);
    }
    record("redeem_as_b_refused", refused, refusedDetail);
    if (!refused) throw new Error("second account was not refused");

    // 8b. Open signup (20260911000100): B becomes a member with NO invite.
    //     ensure_member is idempotent; the quota view shows the free
    //     allowance alone, has_invite=false.
    const em1 = await client.call(
      "/rest/v1/rpc/ensure_member",
      { method: "POST", bearer: b.accessToken, body: {} },
      "ensure_member as B",
    );
    const em1Json = em1.json as Json;
    const freeB = Number(em1Json["free_signup_quota"]);
    const em1Ok = em1Json["created"] === true && em1Json["user_id"] === b.userId &&
      em1Json["invite_id"] === null && Number.isFinite(freeB);
    record("open_signup_ensure_member_as_b", em1Ok, `created=${em1Json["created"]} invite_id=${em1Json["invite_id"]} free_signup_quota=${em1Json["free_signup_quota"]}`);
    if (!em1Ok) throw new Error("ensure_member did not create B's membership");
    const em2 = await client.call(
      "/rest/v1/rpc/ensure_member",
      { method: "POST", bearer: b.accessToken, body: {} },
      "ensure_member again as B",
    );
    record("ensure_member_idempotent", (em2.json as Json)["created"] === false, `second call created=${(em2.json as Json)["created"]}`);
    const qb0 = await readQuota(client, b.accessToken);
    const qb0Ok = qb0 !== null && qb0.max === freeB && qb0.remaining === freeB && qb0.hasInvite === false;
    record("free_quota_without_invite", qb0Ok, `user_quota_status=${JSON.stringify(qb0)}`);
    if (!qb0Ok) throw new Error("free-signup member did not get the free quota row");

    // 9. RLS: B cannot see A's invite, and B's quota row is B's own (the
    //    view is security_invoker), never A's numbers.
    const bInv = await client.call(
      `/rest/v1/invites?select=code&code=eq.${code}`,
      { bearer: b.accessToken },
      "invites as B",
    );
    const bQuotaRows = await client.call(
      "/rest/v1/user_quota_status?select=user_id",
      { bearer: b.accessToken },
      "user_quota_status rows as B",
    );
    const bRows = Array.isArray(bQuotaRows.json) ? (bQuotaRows.json as Json[]) : [];
    const rlsOk = Array.isArray(bInv.json) && bInv.json.length === 0 &&
      bRows.length === 1 && bRows[0]?.["user_id"] === b.userId;
    record("rls_hides_other_users_rows", rlsOk, `B sees invites=${Array.isArray(bInv.json) ? bInv.json.length : "?"} quota_rows=${bRows.length} (own only)`);
    if (!rlsOk) throw new Error("RLS leaked another user's rows");

    // ── Referral loop (migrations 20260902000300/400/500) ────────────
    // 10. A (a member) mints a referral code; B (not a member) sees nothing.
    const settingsRes = await client.call("/rest/v1/rpc/referral_settings", { method: "POST", body: {} }, "referral_settings");
    const settings = settingsRes.json as Json;
    const refQuota = Number(settings["referral_code_quota"]);
    const activation = Number(settings["activation_completed_applications"]);
    const bonusPer = Number(settings["inviter_bonus_per_activation"]);
    const refCap = Number(settings["max_active_referral_codes"]);
    record("referral_settings", [refQuota, activation, bonusPer, refCap].every(Number.isFinite), JSON.stringify(settings));

    const minted = await client.call(
      "/rest/v1/rpc/mint_referral_invite",
      { method: "POST", bearer: a.accessToken, body: {} },
      "mint_referral_invite as A",
    );
    const mintedJson = minted.json as Json;
    const refCode = String(mintedJson["code"] ?? "");
    const mintOk = /^JRA-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/.test(refCode) &&
      Number(mintedJson["max_completed_applications"]) === refQuota;
    record("referral_mint_as_a", mintOk, `code shape ok=${/^JRA-/.test(refCode)} quota=${mintedJson["max_completed_applications"]}`);
    if (!mintOk) throw new Error("mint_referral_invite returned an unexpected shape");

    const viewA = await client.call(
      "/rest/v1/my_referral_invites?select=code,max_completed_applications,redeemed_at",
      { bearer: a.accessToken },
      "my_referral_invites as A",
    );
    const viewARows = Array.isArray(viewA.json) ? (viewA.json as Json[]) : [];
    const viewAOk = viewARows.length === 1 && viewARows[0]?.["code"] === refCode && viewARows[0]?.["redeemed_at"] === null;
    record("referral_view_as_a", viewAOk, `rows=${viewARows.length}`);
    const viewB = await client.call("/rest/v1/my_referral_invites?select=code", { bearer: b.accessToken }, "my_referral_invites as B");
    record("referral_view_hidden_from_b", Array.isArray(viewB.json) && viewB.json.length === 0, `rows=${Array.isArray(viewB.json) ? viewB.json.length : "?"}`);

    // 11. Self-redemption refused; B redeems A's code.
    let selfRefused = false;
    let selfDetail = "";
    try {
      await client.call("/rest/v1/rpc/redeem_invite", { method: "POST", bearer: a.accessToken, body: { invite_code: refCode } }, "self-redeem as A");
      selfDetail = "A redeemed their own code";
    } catch (err) {
      selfRefused = err instanceof RestError && /cannot redeem your own invite/.test(err.body);
      selfDetail = err instanceof RestError ? `HTTP ${err.status} ${truncate(err.body)}` : String(err);
    }
    record("referral_self_redeem_refused", selfRefused, selfDetail);

    const bRedeem = await client.call(
      "/rest/v1/rpc/redeem_invite",
      { method: "POST", bearer: b.accessToken, body: { invite_code: refCode } },
      "redeem referral as B",
    );
    const bRedeemOk = Number((bRedeem.json as Json)["max_completed_applications"]) === refQuota;
    record("referral_redeem_as_b", bRedeemOk, `max_completed_applications=${(bRedeem.json as Json)["max_completed_applications"]}`);
    if (!bRedeemOk) throw new Error("B could not redeem A's referral code");
    // A free-signup member's ONE later invite adds to the free allowance.
    const qb1 = await readQuota(client, b.accessToken);
    const qb1Ok = qb1 !== null && qb1.max === freeB + refQuota && qb1.hasInvite === true;
    record("redeem_after_free_signup_adds_quota", qb1Ok, `B max ${qb0?.max} -> ${qb1?.max} (expected free ${freeB} + invite ${refQuota})`);
    if (!qb1Ok) throw new Error("redeeming after a free signup did not add the invite quota");

    const viewA2 = await client.call("/rest/v1/my_referral_invites?select=redeemed_at", { bearer: a.accessToken }, "my_referral_invites as A (after)");
    const viewA2Rows = Array.isArray(viewA2.json) ? (viewA2.json as Json[]) : [];
    record("referral_view_shows_redeemed", viewA2Rows.length === 1 && typeof viewA2Rows[0]?.["redeemed_at"] === "string", JSON.stringify(viewA2Rows));

    // 12. Bonus: B activates (activation COMPLETED rows) => A's quota +bonusPer, once.
    const qaBefore = await readQuota(client, a.accessToken);
    for (let n = 1; n <= activation; n += 1) {
      await client.call(
        "/rest/v1/application_status_mirror",
        {
          method: "POST",
          body: { user_id: b.userId, engine_application_id: `roundtrip-${now}-b-${n}`, company: "Round Trip Co", role: `Invitee ${n}`, state: "COMPLETED" },
          prefer: "return=minimal",
        },
        `mirror COMPLETED for B #${n}`,
      );
    }
    const qaAfter = await readQuota(client, a.accessToken);
    const bonusOk = qaBefore !== null && qaAfter !== null && qaAfter.max === qaBefore.max + bonusPer;
    record("referral_bonus_granted_to_inviter", bonusOk, `A max ${qaBefore?.max} -> ${qaAfter?.max} (expected +${bonusPer})`);
    if (!bonusOk) throw new Error("inviter bonus not granted");

    await client.call(
      "/rest/v1/application_status_mirror",
      {
        method: "POST",
        body: { user_id: b.userId, engine_application_id: `roundtrip-${now}-b-extra`, company: "Round Trip Co", role: "Invitee extra", state: "COMPLETED" },
        prefer: "return=minimal",
      },
      "mirror COMPLETED for B extra",
    );
    const qaAgain = await readQuota(client, a.accessToken);
    record("referral_bonus_idempotent", qaAgain !== null && qaAfter !== null && qaAgain.max === qaAfter.max, `A max stays ${qaAgain?.max}`);
    const bonuses = await client.call("/rest/v1/referral_bonuses?select=bonus", { bearer: a.accessToken }, "referral_bonuses as A");
    record("referral_bonus_row_visible_to_inviter", Array.isArray(bonuses.json) && bonuses.json.length === 1, JSON.stringify(bonuses.json));

    // 13. Cap: A may hold at most refCap unredeemed codes (the first one is redeemed now).
    for (let n = 1; n <= refCap; n += 1) {
      await client.call("/rest/v1/rpc/mint_referral_invite", { method: "POST", bearer: a.accessToken, body: {} }, `mint #${n}`);
    }
    let capped = false;
    let capDetail = "";
    try {
      await client.call("/rest/v1/rpc/mint_referral_invite", { method: "POST", bearer: a.accessToken, body: {} }, "mint past cap");
      capDetail = "mint succeeded past the cap";
    } catch (err) {
      capped = err instanceof RestError && /referral cap reached/.test(err.body);
      capDetail = err instanceof RestError ? `HTTP ${err.status} ${truncate(err.body)}` : String(err);
    }
    record("referral_cap_enforced", capped, capDetail);

    // 14. engine_status heartbeat is own-row readable only (the sync worker writes it).
    await client.call(
      "/rest/v1/engine_status?on_conflict=user_id",
      { method: "POST", body: { user_id: a.userId, last_seen_at: new Date(now).toISOString(), engine_version: "roundtrip" }, prefer: "resolution=merge-duplicates,return=minimal" },
      "engine_status upsert",
    );
    const hbA = await client.call("/rest/v1/engine_status?select=last_seen_at,engine_version", { bearer: a.accessToken }, "engine_status as A");
    const hbB = await client.call("/rest/v1/engine_status?select=last_seen_at", { bearer: b.accessToken }, "engine_status as B");
    const hbOk = Array.isArray(hbA.json) && hbA.json.length === 1 && Array.isArray(hbB.json) && hbB.json.length === 0;
    record("engine_status_own_row_only", hbOk, `A rows=${Array.isArray(hbA.json) ? hbA.json.length : "?"} B rows=${Array.isArray(hbB.json) ? hbB.json.length : "?"}`);
  } catch (err) {
    record("aborted", false, err instanceof Error ? err.message : String(err));
  } finally {
    // Cleanup in FK order (20260902000600 makes invites.redeemed_by cascade):
    //  1. UNREDEEMED codes the throwaway users issued — nothing references
    //     them, and deleting the issuer would only SET NULL issued_by and
    //     orphan them.
    //  2. the users — cascades app_users, mirror rows, engine_status,
    //     referral_bonuses and every invite they redeemed (the loaded code
    //     and A's referral code redeemed by B).
    //  3. the loaded invite — a no-op after (2) unless the run aborted
    //     before A redeemed it.
    for (const id of createdUserIds) {
      try {
        await client.call(`/rest/v1/invites?issued_by=eq.${id}&redeemed_by=is.null`, { method: "DELETE" }, "delete issued invites");
        cleanup.push({ step: "delete_issued_invites", ok: true, detail: id });
      } catch (err) {
        cleanup.push({ step: "delete_issued_invites", ok: false, detail: `${id}: ${String(err)}` });
      }
    }
    for (const id of createdUserIds) {
      try {
        await client.call(`/auth/v1/admin/users/${id}`, { method: "DELETE" }, "delete user");
        cleanup.push({ step: "delete_user", ok: true, detail: id });
      } catch (err) {
        cleanup.push({ step: "delete_user", ok: false, detail: `${id}: ${String(err)}` });
      }
    }
    if (loaded) {
      try {
        await client.call(`/rest/v1/invites?code=eq.${code}`, { method: "DELETE" }, "delete invite");
        cleanup.push({ step: "delete_invite", ok: true, detail: code });
      } catch (err) {
        cleanup.push({ step: "delete_invite", ok: false, detail: String(err) });
      }
    }
  }

  const ok = steps.length > 0 && steps.every((s) => s.ok) && cleanup.every((c) => c.ok);
  return {
    ok,
    validation_level: ok ? "LIVE_MUTATION_CONFIRMED" : "UNVERIFIED",
    invite_code: code,
    quota,
    steps,
    cleanup,
  };
}
