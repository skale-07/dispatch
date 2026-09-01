import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import type { Db } from "../storage/db/client.js";
import {
  chunkRows,
  toStatusMirrorRows,
  type EngineApplicationRow,
  type StatusMirrorRow,
} from "./syncMapping.js";

/**
 * One-way engine → Supabase status mirror (cloud plane v0.5,
 * docs/roadmap/cloud-deploy.md).
 *
 * Fail-closed behind SUPABASE_SYNC_ENABLED and refuses loudly unless all
 * of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SYNC_USER_ID are
 * configured. The read side is the same discipline as the console read
 * models (SELECTs only, aggregate columns); the write side upserts through
 * @supabase/supabase-js with the service-role key, which never leaves this
 * machine. Nothing is ever read back from the cloud into the engine.
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

  // Loaded only after the gate passes: tests (flag always off) never touch
  // the dependency, and no client object exists to leak the key from.
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

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
