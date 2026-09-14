import { spawn as nodeSpawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { resolveTenantMasterKey } from "../candidate/sensitiveCrypto.js";
import {
  completeEngineJob,
  pushHandoffTask,
  toEngineJobResult,
  toHandoffTaskRow,
  type EngineJobCompletion,
  type EngineQueueClient,
  type HandoffTaskRow,
} from "../cloud/engineQueue.js";
import { toEngineStatusRow, type EngineState } from "../cloud/syncMapping.js";
import type { OnboardedUser } from "../cloud/syncMapping.js";
import {
  runProfilesPull,
  runReceiptsPush,
  runSupabaseSync,
  type ReceiptsPushResult,
  type SupabaseClientLike,
  type SupabaseSyncResult,
} from "../cloud/syncSupabase.js";
import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { codeVersion } from "../storage/codeVersion.js";
import { closeDatabase, migrate, openDatabase, type Db } from "../storage/db/client.js";
import { composeTenantChildEnv } from "./childEnv.js";
import { deriveHandoffsFromRun } from "./handoff.js";
import { deriveTenantKey } from "./keys.js";
import { tenantPaths, type TenantPaths } from "./paths.js";
import { computeRunBudget, countLocalCompleted, readCloudQuota, type CloudQuota, type RunBudget } from "./quota.js";
import { runReconnectVerify, type ReconnectResult, type ReconnectSeams } from "./reconnect.js";
import { runGmailExchange, type GmailExchangeResult } from "./gmailExchange.js";
import { selectOutreachDraftRows } from "./outreachMirror.js";
import { pushOutreachDrafts } from "../cloud/engineQueue.js";
import { runFieldSignalsPush, type FieldSignalsPushResult } from "../cloud/fieldSignals.js";
import { runFeedSample, type FeedSampleOutcome } from "./feedSample.js";
import { hasSealed, unsealSecret, wipeUnsealed, writeUnsealedStorageState } from "./secrets.js";
import { materializeWorkspace, type MaterializeReport } from "./workspace.js";

/**
 * tenant:run (plan v0.5, M15): one job for one hosted user, end to end, in
 * THIS process's care but never in this process's browser:
 *
 *   gate ─► materialize ─► quota budget ─► sealed JobRight state?
 *     │                                        │ no ⇒ handoff jobright_connect
 *     ▼                                        ▼
 *   unseal ─► spawn `auto:cycle` as a child (workspace env, ceiling-capped,
 *             headless STORAGE_STATE, hard timeout, taskkill /T /F)
 *     ▼
 *   finally wipe every plaintext ─► sync status + receipts + heartbeat
 *     ─► derive handoffs ─► runs/<job>/result.json ─► complete_engine_job
 *
 * Fail-closed at every edge: TENANT_ENGINE_ENABLED off refuses by name;
 * no quota row ⇒ budget 0 ⇒ no child; the child holds no flag the
 * operator's .env lacks and no operator secret; a missing sealed session
 * opens a handoff instead of touching a login page. Attempt caps: one
 * child per job, no in-process retry — the cloud queue's max_attempts is
 * the retry loop.
 */

export const JOBRIGHT_STATE_SECRET = "jobright.storage";

export type TenantJobKind = "apply" | "outreach" | "feed_sample" | "reconnect_verify" | "gmail_exchange";

export type TenantRunOutcome =
  | "completed"
  | "quota_exhausted"
  | "needs_jobright_connect"
  | "unsupported_kind"
  | "child_refused"
  | "child_failed"
  | "child_timeout"
  /** reconnect_verify: the capture did not produce a signed-in session (task reopened or failed). */
  | "capture_failed"
  /** reconnect_verify: the task was not in a state this job can act on. */
  | "refused"
  | "error";

export type ChildLaunchSpec = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  logPath: string;
  timeoutMs: number;
};

export type ChildLaunchResult = { exitCode: number | null; timedOut: boolean; durationMs: number };

export type TenantRunSeams = {
  /** Replaces the child process (tests). Receives the exact spec the real launcher would run. */
  launch?: (spec: ChildLaunchSpec) => Promise<ChildLaunchResult>;
  /** Skip the cloud pull; the caller already has the onboarded user. */
  user?: OnboardedUser;
  tenantKey?: Buffer;
  now?: () => Date;
  /** Skip materialization (the workspace is known-fresh, e.g. a second job in one tick). */
  skipMaterialize?: boolean;
  /** Repo root the child runs from; defaults to process.cwd(). */
  repoRoot?: string;
  /** reconnect_verify: provider + session seam (tests inject fakes). */
  reconnect?: ReconnectSeams;
  /** gmail_exchange: the code exchange (tests inject a fake). */
  gmailExchange?: Parameters<typeof runGmailExchange>[0]["exchange"];
};

export type TenantRunInput = {
  userId: string;
  kind: TenantJobKind;
  /** The engine_jobs row this run answers; absent for an operator-driven run. */
  jobId?: string | null;
  /** The engine_jobs payload (reconnect_verify reads `task_id`). */
  payload?: Record<string, unknown> | null;
  client: SupabaseClientLike;
  config?: AppConfig;
  /** Per-run submission ceiling before the quota is applied (default 1). */
  maxSubmits?: number;
  maxApps?: number;
  durationMinutes?: number;
  appDeadlineSeconds?: number;
  seams?: TenantRunSeams;
};

export type CycleSummary = {
  outcome: string;
  apps_started: number;
  submits_used: number;
  stopped_reason: string | null;
  error_codes: string[];
  notes: string[];
};

export type TenantRunResult = {
  user_id: string;
  kind: TenantJobKind;
  job_id: string | null;
  started_at: string;
  finished_at: string;
  outcome: TenantRunOutcome;
  materialized: Pick<MaterializeReport, "written" | "downloaded" | "sensitiveProfile" | "persona"> | null;
  quota: CloudQuota | null;
  budget: RunBudget | null;
  child: (ChildLaunchResult & { log_path: string; args: string[] }) | null;
  cycle: CycleSummary | null;
  handoffs: string[];
  sync: SupabaseSyncResult | null;
  receipts: ReceiptsPushResult | null;
  reconnect: ReconnectResult | null;
  gmail: GmailExchangeResult | null;
  outreach_drafts_pushed: number;
  signals: FieldSignalsPushResult | null;
  feed_sample: FeedSampleOutcome | null;
  engine_state: EngineState;
  job_completion: EngineJobCompletion | null;
  plaintext_wiped: number;
  result_path: string;
  notes: string[];
};

const DEFAULT_DURATION_MIN = 45;
const DEFAULT_MAX_APPS = 3;
const DEFAULT_APP_DEADLINE_S = 300;
/** Grace beyond the arm duration before the child is killed. */
const CHILD_GRACE_MS = 10 * 60_000;

function tsxCliPath(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve("tsx/cli");
  } catch {
    return path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  }
}

function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** The real launcher: node + tsx/cli + the repo CLI, stdout/stderr to the run log, hard timeout. */
export async function launchChild(spec: ChildLaunchSpec): Promise<ChildLaunchResult> {
  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
  const started = Date.now();
  const log = fs.openSync(spec.logPath, "a");
  try {
    return await new Promise<ChildLaunchResult>((resolve) => {
      const child = nodeSpawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", log, log],
        windowsHide: true,
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) killTree(child.pid);
      }, spec.timeoutMs);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut, durationMs: Date.now() - started });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut, durationMs: Date.now() - started });
      });
    });
  } finally {
    fs.closeSync(log);
  }
}

/** The newest auto-cycle report the child wrote into the tenant's artifacts, if any. */
export function readLatestCycleReport(artifactsDir: string, notBefore: Date): CycleSummary | null {
  const dir = path.join(artifactsDir, "console", "auto-cycle");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^cycle-.*\.json$/.test(f))
    .map((f) => path.join(dir, f))
    .filter((f) => fs.statSync(f).mtimeMs >= notBefore.getTime() - 1000)
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  try {
    const r = JSON.parse(fs.readFileSync(latest, "utf8")) as {
      outcome?: string;
      notes?: string[];
      preflight?: { notes?: string[] };
      session?: { apps_started?: number; submits_used?: number; stopped_reason?: string; notes?: string[] } | null;
    };
    const notes = [...(r.preflight?.notes ?? []), ...(r.notes ?? []), ...(r.session?.notes ?? [])];
    const codes = new Set<string>();
    for (const n of notes) {
      const m = /\((jobright_auth|empty_feed|discover_error|lease_held|network_unreachable|pipeline_error)\)/.exec(n);
      if (m?.[1]) codes.add(m[1]);
    }
    if (r.session?.stopped_reason === "cdp_unrecoverable") codes.add("cdp_unrecoverable");
    return {
      outcome: r.outcome ?? "unknown",
      apps_started: r.session?.apps_started ?? 0,
      submits_used: r.session?.submits_used ?? 0,
      stopped_reason: r.session?.stopped_reason ?? null,
      error_codes: [...codes].sort(),
      notes: notes.slice(0, 40),
    };
  } catch {
    return null;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function heartbeat(
  client: SupabaseClientLike,
  input: { userId: string; state: EngineState; jobId: string | null; reason?: string | null; error?: string | null },
): Promise<void> {
  const row = toEngineStatusRow({
    userId: input.userId,
    now: new Date(),
    engineVersion: codeVersion(),
    attempted: 0,
    upserted: 0,
    durationMs: 0,
    error: input.error ?? null,
    state: input.state,
    pausedReason: input.reason ?? null,
    currentJobId: input.jobId,
  });
  const { error } = await client.from("engine_status").upsert(row, { onConflict: "user_id" });
  if (error) throw new Error(`engine_status upsert failed: ${error.message}`);
}

export async function runTenantJob(input: TenantRunInput): Promise<TenantRunResult> {
  const config = input.config ?? getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error("TENANT_ENGINE_ENABLED is false (fail-closed default) — refusing to run a tenant job on this machine.");
  }
  const seams = input.seams ?? {};
  const now = seams.now ?? (() => new Date());
  const started = now();
  const paths = tenantPaths(input.userId, config.tenantsRoot);
  const jobId = input.jobId ?? null;
  const runDir = path.join(paths.runsDir, jobId ?? `manual-${started.toISOString().replace(/[:.]/g, "-")}`);
  const resultPath = path.join(runDir, "result.json");
  const notes: string[] = [];

  const result: TenantRunResult = {
    user_id: paths.userId,
    kind: input.kind,
    job_id: jobId,
    started_at: started.toISOString(),
    finished_at: started.toISOString(),
    outcome: "error",
    materialized: null,
    quota: null,
    budget: null,
    child: null,
    cycle: null,
    handoffs: [],
    sync: null,
    receipts: null,
    reconnect: null,
    gmail: null,
    outreach_drafts_pushed: 0,
    signals: null,
    feed_sample: null,
    engine_state: "idle",
    job_completion: null,
    plaintext_wiped: 0,
    result_path: resultPath,
    notes,
  };

  const client = input.client;
  const queue = client as unknown as EngineQueueClient;
  let db: Db | null = null;
  let plaintextWritten = false;

  const finish = async (outcome: TenantRunOutcome, completion: EngineJobCompletion | null, extra: { retryAfterSeconds?: number; error?: string | null } = {}): Promise<TenantRunResult> => {
    result.outcome = outcome;
    result.finished_at = now().toISOString();
    result.job_completion = completion;
    // Completion is reported to the queue LAST so a crash in reporting never loses the local record.
    writeJson(resultPath, result);
    if (jobId && completion) {
      try {
        await completeEngineJob(
          queue,
          toEngineJobResult({
            jobId,
            status: completion,
            applied: result.cycle?.apps_started ?? 0,
            submitted: result.cycle?.submits_used ?? 0,
            error: extra.error ?? null,
            note: outcome,
            ...(extra.retryAfterSeconds !== undefined ? { retryAfterSeconds: extra.retryAfterSeconds } : {}),
          }),
        );
      } catch (err) {
        notes.push(`complete_engine_job failed: ${err instanceof Error ? err.message : String(err)}`);
        writeJson(resultPath, result);
      }
    }
    logger.info("tenant job finished", {
      service: "tenants",
      action: "run",
      metadata: {
        user_id: paths.userId,
        kind: input.kind,
        job_id: jobId,
        outcome,
        applied: result.cycle?.apps_started ?? 0,
        submitted: result.cycle?.submits_used ?? 0,
        handoffs: result.handoffs,
        engine_state: result.engine_state,
      },
    });
    return result;
  };

  try {
    // ── reconnect_verify: capture the session the user just signed in to ──
    if (input.kind === "reconnect_verify") {
      const key = seams.tenantKey ?? deriveTenantKey(resolveTenantMasterKey(config.tenantsRoot), paths.userId);
      db = openDatabase(paths.dbPath);
      migrate(db);
      const taskId = typeof input.payload?.["task_id"] === "string" ? (input.payload["task_id"] as string) : null;
      const r = await runReconnectVerify({
        client: client as unknown as Parameters<typeof runReconnectVerify>[0]["client"],
        config,
        userId: paths.userId,
        taskId,
        paths,
        tenantKey: key,
        db,
        ...(seams.reconnect ? { seams: seams.reconnect } : {}),
      });
      result.reconnect = r;
      if (r.outcome === "completed") {
        notes.push(`JobRight session sealed; ${r.parks?.resolved ?? 0} park(s) resolved, ${r.parks?.requeued ?? 0} application(s) requeued`);
        result.engine_state = "idle";
        try {
          await heartbeat(client, { userId: paths.userId, state: "idle", jobId: null });
        } catch (err) {
          notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return await finish("completed", "succeeded");
      }
      notes.push(r.reason ?? "capture did not complete");
      return await finish(r.outcome === "refused" ? "refused" : "capture_failed", "failed", { retryAfterSeconds: 600, error: r.reason });
    }

    // ── gmail_exchange: the user consented in the web app; exchange the code ──
    if (input.kind === "gmail_exchange") {
      const key = seams.tenantKey ?? deriveTenantKey(resolveTenantMasterKey(config.tenantsRoot), paths.userId);
      fs.mkdirSync(paths.secretsDir, { recursive: true });
      const g = await runGmailExchange({
        client: client as unknown as Parameters<typeof runGmailExchange>[0]["client"],
        config,
        userId: paths.userId,
        paths,
        tenantKey: key,
        ...(seams.gmailExchange ? { exchange: seams.gmailExchange } : {}),
        now,
      });
      result.gmail = g;
      if (g.outcome === "connected") {
        notes.push(`Gmail connected (${g.scopes.join(" ")})`);
        return await finish("completed", "succeeded");
      }
      notes.push(g.reason ?? g.outcome);
      // A refused or stale grant is final for this request: the user must consent again.
      return await finish(g.outcome === "exchange_failed" ? "error" : "refused", g.outcome === "exchange_failed" ? "failed" : "dead", { retryAfterSeconds: 600, error: g.reason });
    }

    // ── feed_sample: the soft "your filters produce a feed" check (plan M20) ──
    if (input.kind === "feed_sample") {
      let user = seams.user ?? null;
      if (!user) {
        const pulled = await runProfilesPull({ client, config });
        user = pulled.users.find((u) => u.userId === paths.userId) ?? null;
        if (!user) throw new Error(`user ${paths.userId} is not an onboarded user`);
      }
      const key = seams.tenantKey ?? deriveTenantKey(resolveTenantMasterKey(config.tenantsRoot), paths.userId);
      const fs_ = await runFeedSample({
        client: client as unknown as Parameters<typeof runFeedSample>[0]["client"],
        config,
        paths,
        email: user.email,
        tenantKey: key,
        runDir,
        launch: seams.launch ?? launchChild,
        now,
        ...(seams.repoRoot ? { repoRoot: seams.repoRoot } : {}),
      });
      result.feed_sample = fs_;
      if (fs_.handoff) result.handoffs = [fs_.handoff];
      result.engine_state = fs_.handoff ? "parked" : "idle";
      try {
        await heartbeat(client, { userId: paths.userId, state: result.engine_state, jobId: null, reason: fs_.handoff });
      } catch (err) {
        notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (fs_.note) notes.push(fs_.note);
      // A sample that ran is a success either way — the row on the dashboard says what it saw.
      if (fs_.outcome === "sampled" || fs_.outcome === "empty_feed") return await finish("completed", "succeeded");
      if (fs_.outcome === "needs_jobright_connect" || fs_.outcome === "auth_required") {
        return await finish("needs_jobright_connect", "failed", { retryAfterSeconds: 3600, error: fs_.note });
      }
      return await finish("child_failed", "failed", { retryAfterSeconds: 900, error: fs_.note });
    }

    // ── only `apply` runs today; outreach arrives with its milestone ──
    if (input.kind !== "apply") {
      notes.push("outreach for tenants lands with the per-user Gmail transport switch (follow-up to plan M19)");
      return await finish("unsupported_kind", "dead");
    }

    // ── materialize (cloud rows → workspace) ─────────────────────────────
    let user = seams.user ?? null;
    if (!user) {
      const pulled = await runProfilesPull({ client, config });
      user = pulled.users.find((u) => u.userId === paths.userId) ?? null;
      if (!user) throw new Error(`user ${paths.userId} is not an onboarded user (no user_profiles row with onboarding_completed_at)`);
    }
    if (!seams.skipMaterialize) {
      const m = await materializeWorkspace(user, {
        client,
        config,
        ...(seams.tenantKey ? { tenantKey: seams.tenantKey } : {}),
        now: started,
      });
      result.materialized = { written: m.written, downloaded: m.downloaded, sensitiveProfile: m.sensitiveProfile, persona: m.persona };
    }

    // ── quota budget ────────────────────────────────────────────────────
    db = openDatabase(paths.dbPath);
    migrate(db);
    result.quota = await readCloudQuota(client as unknown as Parameters<typeof readCloudQuota>[0], paths.userId);
    result.budget = computeRunBudget({
      quota: result.quota,
      localCompleted: countLocalCompleted(db),
      cap: input.maxSubmits ?? 1,
    });
    if (result.budget.maxSubmits === 0) {
      notes.push(
        result.budget.reason === "quota_missing"
          ? "no user_quota_status row — not a member; nothing runs"
          : `quota exhausted (remaining ${result.quota.remaining}, unmirrored local completions ${result.budget.unmirrored})`,
      );
      result.engine_state = "quota_exhausted";
      try {
        await heartbeat(client, { userId: paths.userId, state: "quota_exhausted", jobId: null });
      } catch (err) {
        notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return await finish("quota_exhausted", "succeeded");
    }

    // ── the tenant's own JobRight session, sealed ────────────────────────
    if (!hasSealed(paths, JOBRIGHT_STATE_SECRET)) {
      const connect: HandoffTaskRow = toHandoffTaskRow({
        userId: paths.userId,
        kind: "jobright_connect",
        status: "open",
        reason: "Connect your JobRight account so Dispatch can read your recommended jobs",
      });
      try {
        await pushHandoffTask(queue, connect);
        result.handoffs = ["jobright_connect"];
      } catch (err) {
        notes.push(`handoff push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      result.engine_state = "parked";
      try {
        await heartbeat(client, { userId: paths.userId, state: "parked", jobId: null, reason: "needs_jobright_connect" });
      } catch (err) {
        notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      notes.push("no sealed JobRight session for this tenant — opened a jobright_connect handoff; nothing was opened in a browser");
      return await finish("needs_jobright_connect", "failed", { retryAfterSeconds: 3600 });
    }

    // ── unseal for the run, spawn, wipe ─────────────────────────────────
    const key = seams.tenantKey ?? deriveTenantKey(resolveTenantMasterKey(config.tenantsRoot), paths.userId);
    const state = unsealSecret<unknown>(paths, JOBRIGHT_STATE_SECRET, key);
    if (!state) throw new Error("sealed JobRight session vanished between check and unseal");
    writeUnsealedStorageState(paths, "jobright", state);
    plaintextWritten = true;

    const durationMinutes = Math.max(1, Math.floor(input.durationMinutes ?? DEFAULT_DURATION_MIN));
    const maxApps = Math.max(1, Math.floor(input.maxApps ?? DEFAULT_MAX_APPS));
    const appDeadline = Math.max(30, Math.floor(input.appDeadlineSeconds ?? DEFAULT_APP_DEADLINE_S));
    const repoRoot = seams.repoRoot ?? process.cwd();
    const spec: ChildLaunchSpec = {
      command: process.execPath,
      args: [
        tsxCliPath(),
        path.join("src", "cli", "index.ts"),
        "auto:cycle",
        "--no-update",
        "--defer-gmail",
        "--duration",
        String(durationMinutes),
        "--max-apps",
        String(maxApps),
        "--max-submits",
        String(result.budget.maxSubmits),
        "--app-deadline",
        String(appDeadline),
      ],
      env: composeTenantChildEnv({
        paths,
        email: user.email,
        maxSubmits: result.budget.maxSubmits,
        kind: "apply",
        tenantsRoot: config.tenantsRoot,
      }),
      cwd: repoRoot,
      logPath: path.join(runDir, "child.log"),
      timeoutMs: durationMinutes * 60_000 + CHILD_GRACE_MS,
    };

    // The child opens the same SQLite; hand it over cleanly.
    closeDatabase(db);
    db = null;
    try {
      await heartbeat(client, { userId: paths.userId, state: "running", jobId });
    } catch (err) {
      notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    let launched: ChildLaunchResult;
    try {
      launched = await (seams.launch ?? launchChild)(spec);
    } finally {
      result.plaintext_wiped = wipeUnsealed(paths);
      plaintextWritten = false;
    }
    result.child = { ...launched, log_path: spec.logPath, args: spec.args.slice(2) };
    result.cycle = readLatestCycleReport(paths.artifactsDir, started);

    // ── post-run: sync the tenant's OWN rows, derive handoffs ────────────
    db = openDatabase(paths.dbPath);
    migrate(db);
    if (config.supabaseSyncEnabled) {
      try {
        result.sync = await runSupabaseSync({ db, userId: paths.userId, config, client });
      } catch (err) {
        notes.push(`status sync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        result.receipts = await runReceiptsPush({ db, userId: paths.userId, config, client, artifactsDir: paths.artifactsDir });
      } catch (err) {
        notes.push(`receipts push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        // THAT a referral draft exists (company, contact, subject, draft id) — never a body.
        result.outreach_drafts_pushed = await pushOutreachDrafts(queue, selectOutreachDraftRows(db, paths.userId));
      } catch (err) {
        notes.push(`outreach_drafts push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        // WHICH questions the tenant's forms asked and how often unanswered — never an answer.
        result.signals = await runFieldSignalsPush({ db, userId: paths.userId, config, client });
      } catch (err) {
        notes.push(`field signals push failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      notes.push("sync skipped: SUPABASE_SYNC_ENABLED off");
    }

    const handoffs = deriveHandoffsFromRun({
      userId: paths.userId,
      db,
      signals: { errorCodes: result.cycle?.error_codes ?? [], notes: result.cycle?.notes ?? [] },
    });
    for (const h of handoffs) {
      try {
        await pushHandoffTask(queue, h);
        result.handoffs.push(h.kind);
      } catch (err) {
        notes.push(`handoff push failed (${h.kind}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    result.engine_state = handoffs.length > 0 ? "parked" : "idle";
    if (handoffs.some((h) => h.kind === "jobright_reconnect")) {
      // Auth expiry → handoff → (after capture) resume: the dashboard's
      // integration row says "expired" until reconnect_verify seals a new session.
      try {
        const { error } = await client.rpc("engine_set_integration_status", {
          p_user: paths.userId,
          p_provider: "jobright",
          p_status: "expired",
          p_meta: { last_error: "JobRight session expired during a run" },
        });
        if (error) throw new Error(error.message);
      } catch (err) {
        notes.push(`integration status update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      await heartbeat(client, {
        userId: paths.userId,
        state: result.engine_state,
        jobId: null,
        reason: handoffs.length > 0 ? handoffs.map((h) => h.kind).join(",") : null,
      });
    } catch (err) {
      notes.push(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (launched.timedOut) {
      notes.push(`child exceeded ${Math.round(spec.timeoutMs / 60_000)} min and was killed (queue left for the next job)`);
      return await finish("child_timeout", "failed", { retryAfterSeconds: 900, error: "child timeout" });
    }
    if (result.cycle?.outcome === "refused") {
      notes.push("auto:cycle refused in the child (see cycle preflight notes) — a flag the operator .env lacks, most likely");
      return await finish("child_refused", "failed", { retryAfterSeconds: 3600, error: result.cycle.notes.find((n) => /^refusing:/.test(n)) ?? "refused" });
    }
    if (launched.exitCode !== 0 || !result.cycle) {
      notes.push(`child exited ${launched.exitCode ?? "null"} with ${result.cycle ? `outcome ${result.cycle.outcome}` : "no cycle report"}`);
      return await finish("child_failed", "failed", { retryAfterSeconds: 900, error: `exit ${launched.exitCode ?? "null"}` });
    }
    return await finish("completed", "succeeded");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    notes.push(`run error: ${message}`);
    return await finish("error", jobId ? "failed" : null, { retryAfterSeconds: 900, error: message });
  } finally {
    if (plaintextWritten) result.plaintext_wiped += wipeUnsealed(paths);
    if (db) closeDatabase(db);
  }
}

/** Convenience for the CLI / scheduler: the workspace paths a run would use. */
export function tenantRunPaths(userId: string, config: AppConfig = getConfig()): TenantPaths {
  return tenantPaths(userId, config.tenantsRoot);
}
