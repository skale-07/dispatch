import fs from "node:fs";
import path from "node:path";
import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import { codeVersion } from "../storage/codeVersion.js";
import {
  chunkRows,
  INTEGRATION_PUBLIC_COLUMNS,
  joinOnboardedUsers,
  toCloudIntegrationRow,
  toEngineStatusRow,
  toReceiptUpload,
  toStatusMirrorRows,
  type CloudAppUserRow,
  type CloudProfileRow,
  type EngineApplicationRow,
  type EngineSubmissionRow,
  type CloudDocumentRow,
  type CloudPersonaRow,
  type CloudScreenerAnswerRow,
  type OnboardedUser,
  type StatusMirrorRow,
} from "./syncMapping.js";

/**
 * Engine ⇄ Supabase sync (cloud plane v0, docs/roadmap/cloud-deploy.md).
 *
 * Fail-closed behind SUPABASE_SYNC_ENABLED and refuses loudly unless all
 * of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SYNC_USER_ID are
 * configured. Three bounded operations, all behind the same flag:
 *
 *   PUSH status   — aggregate application rows → application_status_mirror
 *   PUSH receipts — submission screenshots + metadata → `receipts` bucket
 *                   + application_receipts (the user's OWN evidence)
 *   PULL profiles — onboarded users' wizard data → a snapshot under
 *                   private/cloud/users/ for the engine to act on
 *
 * The permitted surfaces are the whitelist mappers in syncMapping.ts. The
 * service-role key never leaves this machine. What never crosses upward:
 * the operator's private/ contents, ATS credentials, vault entries.
 */

export const SYNC_BATCH_SIZE = 200;

export type SupabaseSyncResult = {
  attempted: number;
  upserted: number;
  batches: number;
  duration_ms: number;
  /** engine_status heartbeat written for this tick (true on every tick that reached the cloud). */
  heartbeat: boolean;
};

/**
 * The exact engine-side read: one row per application, joined to job
 * identity. Mirrors listApplicationRowsPaged's shape minus review/version
 * details — nothing here is candidate data.
 */
export function selectEngineApplicationRows(db: Db): EngineApplicationRow[] {
  return db
    .prepare(
      `SELECT a.id, a.state, a.route, a.created_at, a.updated_at,
              j.company, j.role, j.source_ats
       FROM applications a JOIN jobs j ON j.id = a.job_id
       ORDER BY a.updated_at DESC`,
    )
    .all() as EngineApplicationRow[];
}

/**
 * Loud, specific refusals — a half-configured sync must never half-run.
 * `userId` names the cloud account the rows belong to: the operator's own
 * SUPABASE_SYNC_USER_ID by default, or an explicit tenant id (plan v0.5 —
 * a tenant run syncs its OWN user's rows and never needs the operator's).
 */
export function assertSyncConfigured(
  config: AppConfig,
  opts: { userId?: string } = {},
): {
  url: string;
  serviceRoleKey: string;
  userId: string;
} {
  if (!config.supabaseSyncEnabled) {
    throw new Error(
      "SUPABASE_SYNC_ENABLED is false (fail-closed default). Set it in .env to mirror status to Supabase.",
    );
  }
  const userId = opts.userId?.trim() || config.supabaseSyncUserId;
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!userId) missing.push("SUPABASE_SYNC_USER_ID");
  if (missing.length > 0) {
    throw new Error(
      `Supabase sync is enabled but unconfigured — missing ${missing.join(", ")}. ` +
        "All three live in the engine .env; the service-role key must never be deployed anywhere else.",
    );
  }
  return {
    url: config.supabaseUrl!,
    serviceRoleKey: config.supabaseServiceRoleKey!,
    userId: userId!,
  };
}

/** Newest submitted attempts with evidence; bounded like every sync read. */
export function selectSubmittedRows(db: Db): EngineSubmissionRow[] {
  return db
    .prepare(
      `SELECT application_id, submission_attempt_number, submitted_at,
              confirmation_url, application_identifier, screenshot_path
       FROM submissions
       WHERE submitted = 1
       ORDER BY submitted_at DESC
       LIMIT 500`,
    )
    .all() as EngineSubmissionRow[];
}

async function makeClient(url: string, serviceRoleKey: string) {
  // Loaded only after the gate passes: tests (flag always off) never touch
  // the dependency, and no client object exists to leak the key from.
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type SupabaseClientLike = Awaited<ReturnType<typeof makeClient>>;

/** A service-role client for callers outside this module (tenant tooling); same gate, same key rules. */
export async function makeSyncClient(
  config: AppConfig = getConfig(),
  opts: { userId?: string } = {},
): Promise<SupabaseClientLike> {
  const { url, serviceRoleKey } = assertSyncConfigured(config, opts);
  return makeClient(url, serviceRoleKey);
}

export async function runSupabaseSync(options: {
  db: Db;
  now?: () => Date;
  /** The cloud account the rows belong to; defaults to SUPABASE_SYNC_USER_ID. */
  userId?: string;
  /** Injected by tenant runs and tests; defaults to the process config. */
  config?: AppConfig;
  client?: SupabaseClientLike;
}): Promise<SupabaseSyncResult> {
  const started = Date.now();
  const config = options.config ?? getConfig();
  const { url, serviceRoleKey, userId } = assertSyncConfigured(config, {
    ...(options.userId ? { userId: options.userId } : {}),
  });

  const engineRows = selectEngineApplicationRows(options.db);
  const rows: StatusMirrorRow[] = toStatusMirrorRows(
    engineRows,
    userId,
    (options.now ?? (() => new Date()))(),
  );

  const client = options.client ?? (await makeClient(url, serviceRoleKey));

  let upserted = 0;
  let pushError: string | null = null;
  const batches = chunkRows(rows, SYNC_BATCH_SIZE);
  for (const batch of batches) {
    const { error } = await client
      .from("application_status_mirror")
      .upsert(batch, { onConflict: "user_id,engine_application_id" });
    if (error) {
      // error.message is Supabase's own text — never the key.
      pushError = `Supabase upsert failed: ${error.message}`;
      break;
    }
    upserted += batch.length;
  }

  // Heartbeat on EVERY tick, success or not: the dashboard's "engine
  // running" indicator reads engine_status.last_seen_at. Written after
  // the push so the counts describe this tick; a failed push is
  // recorded in last_error rather than hidden by an early throw.
  const heartbeat = toEngineStatusRow({
    userId,
    now: new Date(),
    engineVersion: codeVersion(),
    attempted: rows.length,
    upserted,
    durationMs: Date.now() - started,
    error: pushError,
  });
  const { error: hbError } = await client
    .from("engine_status")
    .upsert(heartbeat, { onConflict: "user_id" });
  if (hbError) {
    throw new Error(
      `${pushError ? `${pushError}; ` : ""}engine_status heartbeat failed: ${hbError.message}`,
    );
  }
  if (pushError) throw new Error(pushError);

  const result: SupabaseSyncResult = {
    attempted: rows.length,
    upserted,
    batches: batches.length,
    duration_ms: Date.now() - started,
    heartbeat: true,
  };
  logger.info("supabase status mirror synced", {
    service: "cloud",
    action: "sync",
    metadata: { ...result },
  });
  return result;
}

export type ReceiptsPushResult = {
  candidates: number;
  uploaded: number;
  rows_upserted: number;
  skipped_missing_file: number;
  duration_ms: number;
};

/**
 * Upload each submitted application's screenshot receipt to the private
 * `receipts` bucket ({uid}/{app}/attempt-N.png) and upsert its metadata
 * row. Idempotent: storage upsert + row unique key make re-runs safe.
 */
export async function runReceiptsPush(options: {
  db: Db;
  client?: SupabaseClientLike;
  /** The cloud account the receipts belong to; defaults to SUPABASE_SYNC_USER_ID. */
  userId?: string;
  config?: AppConfig;
  /** Where relative screenshot paths resolve; defaults to the config's artifacts dir. */
  artifactsDir?: string;
}): Promise<ReceiptsPushResult> {
  const started = Date.now();
  const config = options.config ?? getConfig();
  const { url, serviceRoleKey, userId } = assertSyncConfigured(config, {
    ...(options.userId ? { userId: options.userId } : {}),
  });
  const artifactsDir = options.artifactsDir ?? config.artifactsDir;
  const client = options.client ?? (await makeClient(url, serviceRoleKey));

  const subs = selectSubmittedRows(options.db);
  let uploaded = 0;
  let rowsUpserted = 0;
  let skippedMissing = 0;
  let candidates = 0;

  for (const sub of subs) {
    const receipt = toReceiptUpload(sub, userId);
    if (receipt === null) continue;
    candidates += 1;
    const localPath = path.isAbsolute(receipt.localScreenshotPath)
      ? receipt.localScreenshotPath
      : path.join(artifactsDir, receipt.localScreenshotPath);
    if (!fs.existsSync(localPath)) {
      skippedMissing += 1;
      continue;
    }
    const bytes = fs.readFileSync(localPath);
    const { error: uploadError } = await client.storage
      .from("receipts")
      .upload(receipt.objectPath, bytes, {
        contentType: "image/png",
        upsert: true,
      });
    if (uploadError) {
      throw new Error(`receipt upload failed (${receipt.objectPath}): ${uploadError.message}`);
    }
    uploaded += 1;
    const { error: rowError } = await client
      .from("application_receipts")
      .upsert([receipt.row], {
        onConflict: "user_id,engine_application_id,submission_attempt",
      });
    if (rowError) {
      throw new Error(`receipt row upsert failed: ${rowError.message}`);
    }
    rowsUpserted += 1;
  }

  const result: ReceiptsPushResult = {
    candidates,
    uploaded,
    rows_upserted: rowsUpserted,
    skipped_missing_file: skippedMissing,
    duration_ms: Date.now() - started,
  };
  logger.info("supabase receipts pushed", {
    service: "cloud",
    action: "receipts_push",
    metadata: { ...result },
  });
  return result;
}

export type ProfilesPullResult = {
  onboarded_users: number;
  snapshot_path: string;
  duration_ms: number;
};

/**
 * Pull every ONBOARDED user's wizard profile + preferences down to a
 * snapshot under private/cloud/users/ (gitignored — user PII belongs in
 * private/, never artifacts/). This is the sanctioned cloud → engine read;
 * it feeds operator-run engine sessions, never the cloud tables back.
 */
export async function runProfilesPull(options: {
  client?: SupabaseClientLike;
  now?: () => Date;
  config?: AppConfig;
}): Promise<ProfilesPullResult & { users: OnboardedUser[] }> {
  const started = Date.now();
  const config = options.config ?? getConfig();
  // The pull reads every onboarded user, so no per-user id is involved;
  // the operator's SUPABASE_SYNC_USER_ID requirement stays as the gate.
  const { url, serviceRoleKey } = assertSyncConfigured(config);
  const client = options.client ?? (await makeClient(url, serviceRoleKey));

  const usersRes = await client
    .from("app_users")
    .select("id, email, invite_id, invites(max_completed_applications)")
    .limit(1000);
  if (usersRes.error) {
    throw new Error(`app_users select failed: ${usersRes.error.message}`);
  }
  const profilesRes = await client
    .from("user_profiles")
    .select("*")
    .not("onboarding_completed_at", "is", null)
    .limit(1000);
  if (profilesRes.error) {
    throw new Error(`user_profiles select failed: ${profilesRes.error.message}`);
  }

  // Per-store tables (20260911000300-000700). user_integrations is read
  // by NAMED non-secret columns — never `*` — so ciphertext can never
  // land in the snapshot; user_sensitive_profiles is never read here at
  // all (the workspace runner fetches it through its own RPC straight
  // into an encrypted file).
  const [docsRes, answersRes, personasRes, integrationsRes] = await Promise.all([
    client.from("user_documents").select("*").limit(5000),
    client.from("user_screener_answers").select("*").limit(20000),
    client.from("user_personas").select("*").limit(1000),
    client.from("user_integrations").select(INTEGRATION_PUBLIC_COLUMNS.join(",")).limit(2000),
  ]);
  for (const [name, res] of [
    ["user_documents", docsRes],
    ["user_screener_answers", answersRes],
    ["user_personas", personasRes],
    ["user_integrations", integrationsRes],
  ] as const) {
    if (res.error) throw new Error(`${name} select failed: ${res.error.message}`);
  }

  const userRows: CloudAppUserRow[] = (
    (usersRes.data ?? []) as Array<Record<string, unknown>>
  ).map((u) => ({
    id: String(u["id"]),
    email: String(u["email"] ?? ""),
    invite_id: (u["invite_id"] as string | null) ?? null,
    max_completed_applications:
      (u["invites"] as { max_completed_applications?: number } | null)
        ?.max_completed_applications ?? null,
  }));
  const users = joinOnboardedUsers(
    userRows,
    (profilesRes.data ?? []) as CloudProfileRow[],
    {
      documents: (docsRes.data ?? []) as CloudDocumentRow[],
      screenerAnswers: (answersRes.data ?? []) as CloudScreenerAnswerRow[],
      personas: (personasRes.data ?? []) as CloudPersonaRow[],
      // A joined column list types as a string error in supabase-js; the
      // rows are plain objects, whitelisted by toCloudIntegrationRow.
      integrations: ((integrationsRes.data ?? []) as unknown as Array<Record<string, unknown>>).map(
        toCloudIntegrationRow,
      ),
    },
  );

  const outDir = path.join(config.privateDir, "cloud", "users");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = (options.now ?? (() => new Date()))()
    .toISOString()
    .replace(/[:.]/g, "-");
  const snapshotPath = path.join(outDir, `onboarded-${stamp}.json`);
  fs.writeFileSync(snapshotPath, `${JSON.stringify(users, null, 2)}\n`, "utf8");

  const result: ProfilesPullResult = {
    onboarded_users: users.length,
    snapshot_path: snapshotPath,
    duration_ms: Date.now() - started,
  };
  logger.info("supabase profiles pulled", {
    service: "cloud",
    action: "profiles_pull",
    // Counts and path only — never profile contents in logs.
    metadata: { ...result },
  });
  return { ...result, users };
}
