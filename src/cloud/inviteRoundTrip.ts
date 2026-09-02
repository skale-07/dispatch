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

async function readQuota(
  client: ProjectClient,
  bearer: string,
): Promise<{ max: number; completed: number; remaining: number } | null> {
  const res = await client.call(
    "/rest/v1/user_quota_status?select=max_completed_applications,completed_applications,remaining",
    { bearer },
    "read user_quota_status",
  );
  const row = Array.isArray(res.json) ? (res.json[0] as Json | undefined) : undefined;
  if (!row) return null;
  return {
    max: Number(row["max_completed_applications"]),
    completed: Number(row["completed_applications"]),
    remaining: Number(row["remaining"]),
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

    const q0 = await readQuota(client, a.accessToken);
    const q0Ok = q0 !== null && q0.max === quota && q0.completed === 0 && q0.remaining === quota;
    record("quota_after_redeem", q0Ok, `user_quota_status=${JSON.stringify(q0)}`);
    if (!q0Ok) throw new Error("quota view did not show the full quota after redeem");

    // 5. Decrement: one COMPLETED mirror row at a time (service role, as
    //    the sync worker would write them), reading the view as A each time.
    for (let n = 1; n <= quota; n += 1) {
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
      const ok = q !== null && q.completed === n && q.remaining === quota - n;
      record(`quota_after_completed_${n}`, ok, `user_quota_status=${JSON.stringify(q)}`);
      if (!ok) throw new Error(`quota did not decrement to ${quota - n}`);
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
    const exhaustedOk = qx !== null && qx.completed === quota + 1 && qx.remaining === 0;
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

    // 9. RLS: B cannot see A's invite or A's quota.
    const bInv = await client.call(
      `/rest/v1/invites?select=code&code=eq.${code}`,
      { bearer: b.accessToken },
      "invites as B",
    );
    const bQuota = await readQuota(client, b.accessToken);
    const rlsOk = Array.isArray(bInv.json) && bInv.json.length === 0 && bQuota === null;
    record("rls_hides_other_users_rows", rlsOk, `B sees invites=${Array.isArray(bInv.json) ? bInv.json.length : "?"} quota_rows=${bQuota === null ? 0 : 1}`);
  } catch (err) {
    record("aborted", false, err instanceof Error ? err.message : String(err));
  } finally {
    // Cleanup in FK order: mirror rows + app_users cascade from the user,
    // but invites.redeemed_by has no cascade, so the invite goes first.
    if (loaded) {
      try {
        await client.call(`/rest/v1/invites?code=eq.${code}`, { method: "DELETE" }, "delete invite");
        cleanup.push({ step: "delete_invite", ok: true, detail: code });
      } catch (err) {
        cleanup.push({ step: "delete_invite", ok: false, detail: String(err) });
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
