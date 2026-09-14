import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pushFeedSample, pushHandoffTask, toFeedSampleRow, toHandoffTaskRow, type EngineQueueClient } from "../cloud/engineQueue.js";
import type { AppConfig } from "../config/index.js";
import { GATED_FLAG_KEYS } from "../console/flagCeiling.js";
import { composeTenantChildEnv } from "./childEnv.js";
import type { FeedSampleFile } from "./feedSampleCli.js";
import type { TenantPaths } from "./paths.js";
import type { ChildLaunchResult, ChildLaunchSpec } from "./run.js";
import { hasSealed, unsealSecret, wipeUnsealed, writeUnsealedStorageState } from "./secrets.js";

/**
 * Feed sample, parent side (plan v0.5, M20): the soft "your JobRight
 * filters produce a feed" check the user may request from the dashboard.
 * Needs the tenant's sealed JobRight session; without one it opens a
 * jobright_connect handoff instead of a browser. Runs the child under the
 * tenant env (every gated flag off — a sample fills nothing), wipes the
 * unsealed state in finally, and pushes titles/companies/locations only.
 * An auth wall in the child ⇒ jobright_reconnect handoff + the
 * integration marked expired; the sample row still says why.
 */

export const JOBRIGHT_STATE_SECRET = "jobright.storage";
const SAMPLE_TIMEOUT_MS = 4 * 60_000;

export type FeedSampleOutcome = {
  outcome: "sampled" | "empty_feed" | "auth_required" | "needs_jobright_connect" | "child_failed";
  count: number;
  note: string | null;
  handoff: "jobright_connect" | "jobright_reconnect" | null;
};

function tsxCli(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("tsx/cli");
  } catch {
    return path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  }
}

export async function runFeedSample(input: {
  client: EngineQueueClient & { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }> };
  config: AppConfig;
  paths: TenantPaths;
  email: string;
  tenantKey: Buffer;
  runDir: string;
  launch: (spec: ChildLaunchSpec) => Promise<ChildLaunchResult>;
  now?: () => Date;
  repoRoot?: string;
  max?: number;
}): Promise<FeedSampleOutcome> {
  const now = input.now ?? (() => new Date());
  const userId = input.paths.userId;

  if (!hasSealed(input.paths, JOBRIGHT_STATE_SECRET)) {
    await pushHandoffTask(input.client, toHandoffTaskRow({ userId, kind: "jobright_connect", status: "open", reason: "Connect your JobRight account to sample your feed" }));
    await pushFeedSample(input.client, toFeedSampleRow({ userId, now: now(), jobs: [], note: "JobRight is not connected yet" }));
    return { outcome: "needs_jobright_connect", count: 0, note: "no sealed JobRight session", handoff: "jobright_connect" };
  }

  const state = unsealSecret<unknown>(input.paths, JOBRIGHT_STATE_SECRET, input.tenantKey);
  if (!state) throw new Error("sealed JobRight session vanished between check and unseal");
  const outFile = path.join(input.runDir, "feed-sample.json");
  writeUnsealedStorageState(input.paths, "jobright", state);
  let launched: ChildLaunchResult;
  try {
    const env = composeTenantChildEnv({ paths: input.paths, email: input.email, maxSubmits: 0, kind: "feed_sample", tenantsRoot: input.config.tenantsRoot });
    // A sample fills nothing: every gated flag off regardless of the ceiling, dry run on.
    for (const key of GATED_FLAG_KEYS) env[key] = "false";
    env["DRY_RUN"] = "true";
    launched = await input.launch({
      command: process.execPath,
      args: [tsxCli(), path.join("src", "tenants", "feedSampleCli.ts"), "--out", outFile, "--max", String(Math.max(1, Math.min(input.max ?? 10, 25)))],
      env,
      cwd: input.repoRoot ?? process.cwd(),
      logPath: path.join(input.runDir, "feed-sample.log"),
      timeoutMs: SAMPLE_TIMEOUT_MS,
    });
  } finally {
    wipeUnsealed(input.paths);
  }

  let file: FeedSampleFile | null = null;
  if (fs.existsSync(outFile)) {
    try {
      file = JSON.parse(fs.readFileSync(outFile, "utf8")) as FeedSampleFile;
    } catch {
      file = null;
    }
  }
  if (!file) {
    const note = launched.timedOut ? "feed sample timed out" : `feed sample child exited ${launched.exitCode ?? "null"} without a result`;
    await pushFeedSample(input.client, toFeedSampleRow({ userId, now: now(), jobs: [], note }));
    return { outcome: "child_failed", count: 0, note, handoff: null };
  }
  if (file.reason === "auth_required") {
    await pushHandoffTask(input.client, toHandoffTaskRow({ userId, kind: "jobright_reconnect", status: "open", reason: "JobRight signed you out — reconnect to keep applying" }));
    const { error } = await input.client.rpc("engine_set_integration_status", { p_user: userId, p_provider: "jobright", p_status: "expired", p_meta: { last_error: "session expired at the feed" } });
    if (error) throw new Error(`engine_set_integration_status failed: ${error.message}`);
    await pushFeedSample(input.client, toFeedSampleRow({ userId, now: now(), jobs: [], note: "JobRight session expired — reconnect" }));
    return { outcome: "auth_required", count: 0, note: "JobRight session expired", handoff: "jobright_reconnect" };
  }
  const note = file.ok ? null : file.reason === "empty_feed" ? (file.cards_attached ? "the feed rendered but no cards parsed" : "the feed showed no jobs — check your JobRight filters") : "feed sample failed";
  await pushFeedSample(input.client, toFeedSampleRow({ userId, now: now(), jobs: file.jobs, note }));
  return { outcome: file.ok ? "sampled" : file.reason === "empty_feed" ? "empty_feed" : "child_failed", count: file.jobs.length, note, handoff: null };
}
