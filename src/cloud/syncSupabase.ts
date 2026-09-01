import fs from "node:fs";
import path from "node:path";
import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import {
  chunkRows,
  joinOnboardedUsers,
  toReceiptUpload,
  toStatusMirrorRows,
  type CloudAppUserRow,
  type CloudProfileRow,
  type EngineApplicationRow,
  type EngineSubmissionRow,
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

/** Loud, specific refusals — a half-configured sync must never half-run. */
export function assertSyncConfigured(config: AppConfig): {
  url: string;
  serviceRoleKey: string;
  userId: string;
} {
  if (!config.supabaseSyncEnabled) {
    throw new Error(
      "SUPABASE_SYNC_ENABLED is false (fail-closed default). Set it in .env to mirror status to Supabase.",
    );
  }
  const missing: string[] = [];
  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!config.supabaseSyncUserId) missing.push("SUPABASE_SYNC_USER_ID");
  if (missing.length > 0) {
    throw new Error(
      `Supabase sync is enabled but unconfigured — missing ${missing.join(", ")}. ` +
        "All three live in the engine .env; the service-role key must never be deployed anywhere else.",
    );
  }
  return {
    url: config.supabaseUrl!,
    serviceRoleKey: config.supabaseServiceRoleKey!,
    userId: config.supabaseSyncUserId!,
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

type SupabaseClientLike = Awaited<ReturnType<typeof makeClient>>;

export async function runSupabaseSync(options: {
  db: Db;
  now?: () => Date;
}): Promise<SupabaseSyncResult> {
  const started = Date.now();
  const config = getConfig();
  const { url, serviceRoleKey, userId } = assertSyncConfigured(config);

  const engineRows = selectEngineApplicationRows(options.db);
  const rows: StatusMirrorRow[] = toStatusMirrorRows(
    engineRows,
    userId,
    (options.now ?? (() => new Date()))(),
  );

  const client = await makeClient(url, serviceRoleKey);

  let upserted = 0;
  const batches = chunkRows(rows, SYNC_BATCH_SIZE);
  for (const batch of batches) {
    const { error } = await client
      .from("application_status_mirror")
      .upsert(batch, { onConflict: "user_id,engine_application_id" });
    if (error) {
      // error.message is Supabase's own text — never the key.
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }
    upserted += batch.length;
  }

  const result: SupabaseSyncResult = {
    attempted: rows.length,
    upserted,
    batches: batches.length,
    duration_ms: Date.now() - started,
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
}): Promise<ReceiptsPushResult> {
  const started = Date.now();
  const config = getConfig();
  const { url, serviceRoleKey, userId } = assertSyncConfigured(config);
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
      : path.join(config.artifactsDir, receipt.localScreenshotPath);
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
}): Promise<ProfilesPullResult & { users: OnboardedUser[] }> {
  const started = Date.now();
  const config = getConfig();
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
