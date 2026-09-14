#!/usr/bin/env node
import { makeSyncClient, runProfilesPull } from "../cloud/syncSupabase.js";
import { getConfig } from "../config/index.js";
import { assertTenantId } from "./paths.js";
import { runTenantJob, type TenantJobKind } from "./run.js";
import { runTenantScheduler } from "./scheduler.js";
import { inspectWorkspace, listWorkspaces, materializeWorkspace } from "./workspace.js";

/**
 * Tenant tooling (plan v0.5):
 *
 *   npm run tenant:materialize -- --user <uuid> [--force] [--skip-sensitive]
 *   npm run tenant:materialize -- --all [--force]
 *   npm run tenant:status [-- --user <uuid>]
 *   npm run tenant:run -- --user <uuid> --kind apply [--job <id>]
 *                         [--max-submits N] [--max-apps N] [--duration <min>] [--app-deadline <sec>]
 *   npm run tenant:run -- --user <uuid> --kind reconnect_verify --task <handoff task id> [--job <id>]
 *   npm run tenant:scheduler -- [--duration <min>] [--interval <sec>] [--max-concurrent N] [--once]
 *
 * materialize: pull the onboarded user(s) from the cloud plane and write
 * their workspace(s) under TENANTS_ROOT. Behind TENANT_ENGINE_ENABLED and
 * SUPABASE_SYNC_ENABLED (refuses by name). status: read-only, lists each
 * workspace's files, sealed secrets and any stale unsealed plaintext.
 * run: one job for one tenant (materialize → quota → unseal → child
 * auto:cycle → wipe → sync → handoffs); same two gates.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(name);
function num(name: string): number | undefined {
  const v = arg(name);
  return v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
}

async function run(): Promise<void> {
  const config = getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error("TENANT_ENGINE_ENABLED is false (fail-closed default). Set it in .env to run tenant jobs.");
  }
  const userId = arg("--user");
  if (!userId) throw new Error("tenant:run needs --user <uuid>");
  const kind = (arg("--kind") ?? "apply") as TenantJobKind;
  if (!["apply", "outreach", "feed_sample", "reconnect_verify"].includes(kind)) {
    throw new Error(`--kind must be apply|outreach|feed_sample|reconnect_verify (got "${kind}")`);
  }
  const client = await makeSyncClient(config);
  const result = await runTenantJob({
    userId: assertTenantId(userId),
    kind,
    jobId: arg("--job") ?? null,
    ...(arg("--task") ? { payload: { task_id: arg("--task") } } : {}),
    client,
    config,
    ...(num("--max-submits") !== undefined ? { maxSubmits: num("--max-submits")! } : {}),
    ...(num("--max-apps") !== undefined ? { maxApps: num("--max-apps")! } : {}),
    ...(num("--duration") !== undefined ? { durationMinutes: num("--duration")! } : {}),
    ...(num("--app-deadline") !== undefined ? { appDeadlineSeconds: num("--app-deadline")! } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== "completed" && result.outcome !== "quota_exhausted") process.exitCode = 1;
}

async function scheduler(): Promise<void> {
  const config = getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error("TENANT_ENGINE_ENABLED is false (fail-closed default). Set it in .env to run the tenant scheduler.");
  }
  const client = await makeSyncClient(config);
  const report = await runTenantScheduler({
    client,
    config,
    once: has("--once"),
    ...(num("--duration") !== undefined ? { durationMinutes: num("--duration")! } : {}),
    ...(num("--interval") !== undefined ? { intervalSeconds: num("--interval")! } : {}),
    ...(num("--max-concurrent") !== undefined ? { maxConcurrent: num("--max-concurrent")! } : {}),
  });
  console.log(JSON.stringify(report, null, 2));
}

async function materialize(): Promise<void> {
  const config = getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error("TENANT_ENGINE_ENABLED is false (fail-closed default). Set it in .env to materialize tenant workspaces.");
  }
  const only = arg("--user") ? assertTenantId(arg("--user")!) : null;
  if (!only && !has("--all")) throw new Error("tenant:materialize needs --user <uuid> or --all");
  const client = await makeSyncClient(config);
  const { users } = await runProfilesPull({ client, config });
  const targets = only ? users.filter((u) => u.userId === only) : users;
  if (only && targets.length === 0) {
    throw new Error(`user ${only} is not an onboarded user (no user_profiles row with onboarding_completed_at)`);
  }
  for (const user of targets) {
    const report = await materializeWorkspace(user, {
      client,
      config,
      force: has("--force"),
      skipSensitive: has("--skip-sensitive"),
    });
    console.log(JSON.stringify(report, null, 2));
  }
  console.log(`tenant:materialize: ${targets.length} workspace(s) under ${config.tenantsRoot}`);
}

function status(): void {
  const config = getConfig();
  const ids = arg("--user") ? [assertTenantId(arg("--user")!)] : listWorkspaces(config.tenantsRoot);
  if (ids.length === 0) {
    console.log(`tenant:status: no workspaces under ${config.tenantsRoot}`);
    return;
  }
  for (const id of ids) {
    const s = inspectWorkspace(id, config.tenantsRoot);
    const m = s.manifest ?? {};
    console.log(
      JSON.stringify(
        {
          user_id: s.userId,
          email: m["email"] ?? null,
          materialized_at: m["materialized_at"] ?? null,
          eligibility: m["eligibility"] ?? null,
          files: s.files.length,
          sealed: s.sealed,
          database: s.hasDatabase,
          stale_unsealed: s.staleUnsealed,
        },
        null,
        2,
      ),
    );
    if (s.staleUnsealed.length > 0) {
      console.error(`WARNING: ${s.userId} has ${s.staleUnsealed.length} unsealed plaintext file(s) left from a run — wipe them.`);
    }
  }
}

const cmd = process.argv[2];
(async () => {
  if (cmd === "materialize") await materialize();
  else if (cmd === "status") status();
  else if (cmd === "run") await run();
  else if (cmd === "scheduler") await scheduler();
  else {
    console.error("usage: tenant cli <materialize|status|run|scheduler> [--user <uuid>] [--all] [--force] [--skip-sensitive] [--kind apply] [--job <id>] [--duration <min>] [--interval <sec>] [--max-concurrent N] [--once]");
    process.exit(2);
  }
})().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
