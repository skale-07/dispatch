import { resolveRemoteBrowserProvider, type RemoteBrowserProvider } from "../browser/remoteBrowser.js";
import {
  leaseEngineJobs,
  reapEngineJobLeases,
  type EngineJob,
  type EngineJobKind,
} from "../cloud/engineQueue.js";
import type { SupabaseClientLike } from "../cloud/syncSupabase.js";
import { getConfig, type AppConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import { provisionHandoff, type HandoffClient, type HandoffTaskRecord } from "./capture.js";
import { runTenantJob, type TenantJobKind, type TenantRunResult } from "./run.js";

/**
 * tenant:scheduler (plan v0.5, M18) — the bounded loop that turns the cloud
 * queue into tenant runs. One tick:
 *
 *   1. reap expired leases (a worker that died holding jobs)
 *   2. handoff poller: `requested` JobRight tasks ⇒ provision a remote
 *      session (live view for the user); `live` past expires_at ⇒ expired;
 *      `user_done` ⇒ enqueue a reconnect_verify job
 *   3. planner: for every user with JobRight connected, quota remaining,
 *      not paused, no blocking handoff, no active apply job and no apply
 *      job in the last CADENCE minutes ⇒ enqueue ONE apply job (≤ MAX_NEW
 *      per tick)
 *   4. lease ≤ maxConcurrent jobs (apply, reconnect_verify) and run them
 *      through runTenantJob — each one a child process in its tenant's
 *      workspace, never this process's browser
 *
 * Every read and write to the cloud goes through `SchedulerIo`, one seam
 * with a real implementation (`makeSchedulerIo`) and a fake in tests. The
 * loop is bounded by duration AND a tick cap; SIGINT stops leasing after
 * the current tick (a running job owns its child and finishes or times
 * out on its own). Fail-closed: TENANT_ENGINE_ENABLED off refuses by name;
 * without SUPABASE_SYNC_ENABLED no client exists.
 */

export const APPLY_CADENCE_MINUTES = 60;
export const MAX_NEW_APPLY_PER_TICK = 5;
export const LEASE_KINDS: readonly EngineJobKind[] = ["apply", "reconnect_verify"];
export const JOB_LEASE_SECONDS = 3600;
const ACTIVE_HANDOFF_STATUSES = ["open", "requested", "provisioning", "live", "user_done", "verifying"] as const;
const JOBRIGHT_HANDOFF_KINDS = new Set(["jobright_connect", "jobright_reconnect"]);

export type ApplyJobSummary = { userId: string; status: string; createdAt: string };

export type SchedulerIo = {
  connectedJobrightUsers(): Promise<string[]>;
  quotaRemaining(userIds: string[]): Promise<Map<string, number>>;
  pausedUsers(): Promise<Set<string>>;
  activeHandoffs(): Promise<HandoffTaskRecord[]>;
  applyJobsSince(sinceIso: string): Promise<ApplyJobSummary[]>;
  insertJob(row: { user_id: string; kind: EngineJobKind; payload: Record<string, unknown> }): Promise<"created" | "exists">;
  lease(limit: number, owner: string): Promise<EngineJob[]>;
  reap(): Promise<{ requeued: number; dead: number }>;
  updateTask(id: string, patch: Record<string, unknown>): Promise<void>;
};

// ── pure planner ─────────────────────────────────────────────────────

export type PlanInput = {
  connected: readonly string[];
  quota: Map<string, number>;
  paused: Set<string>;
  /** Users with an active JobRight connect/reconnect task — nothing runs until it resolves. */
  blocking: Set<string>;
  activeApply: Set<string>;
  /** Most recent apply job creation per user (any status). */
  lastApplyAt: Map<string, string>;
  now: Date;
  cadenceMinutes?: number;
  maxNew?: number;
};

export type PlanOutput = { enqueue: string[]; skipped: Array<{ userId: string; reason: string }> };

export function planApplyJobs(input: PlanInput): PlanOutput {
  const cadenceMs = (input.cadenceMinutes ?? APPLY_CADENCE_MINUTES) * 60_000;
  const maxNew = Math.max(0, Math.floor(input.maxNew ?? MAX_NEW_APPLY_PER_TICK));
  const enqueue: string[] = [];
  const skipped: PlanOutput["skipped"] = [];
  for (const userId of [...new Set(input.connected)].sort()) {
    const remaining = input.quota.get(userId);
    if (remaining === undefined) {
      skipped.push({ userId, reason: "no quota row" });
      continue;
    }
    if (remaining <= 0) {
      skipped.push({ userId, reason: "quota_exhausted" });
      continue;
    }
    if (input.paused.has(userId)) {
      skipped.push({ userId, reason: "paused" });
      continue;
    }
    if (input.blocking.has(userId)) {
      skipped.push({ userId, reason: "blocking handoff" });
      continue;
    }
    if (input.activeApply.has(userId)) {
      skipped.push({ userId, reason: "apply job active" });
      continue;
    }
    const last = input.lastApplyAt.get(userId);
    if (last && input.now.getTime() - new Date(last).getTime() < cadenceMs) {
      skipped.push({ userId, reason: "within cadence" });
      continue;
    }
    if (enqueue.length >= maxNew) {
      skipped.push({ userId, reason: "tick cap" });
      continue;
    }
    enqueue.push(userId);
  }
  return { enqueue, skipped };
}

// ── one tick ─────────────────────────────────────────────────────────

export type TickReport = {
  at: string;
  reaped: { requeued: number; dead: number };
  handoffs: { provisioned: number; expired: number; reconnect_enqueued: number; left: number };
  planned: PlanOutput & { created: number };
  leased: number;
  ran: Array<{ job_id: string; user_id: string; kind: string; outcome: string }>;
  notes: string[];
};

export type SchedulerSeams = {
  io?: SchedulerIo;
  provider?: RemoteBrowserProvider;
  runJob?: (job: EngineJob) => Promise<TenantRunResult>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
};

function handoffClientFrom(io: SchedulerIo): HandoffClient {
  return {
    from: () => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          await io.updateTask(id, patch);
          return { error: null };
        },
      }),
    }),
    rpc: async () => ({ data: null, error: { message: "scheduler handoff client has no rpc" } }),
  };
}

export async function schedulerTick(input: {
  io: SchedulerIo;
  provider: RemoteBrowserProvider;
  runJob: (job: EngineJob) => Promise<TenantRunResult>;
  maxConcurrent: number;
  owner: string;
  now?: () => Date;
}): Promise<TickReport> {
  const now = input.now ?? (() => new Date());
  const t = now();
  const notes: string[] = [];
  const report: TickReport = {
    at: t.toISOString(),
    reaped: { requeued: 0, dead: 0 },
    handoffs: { provisioned: 0, expired: 0, reconnect_enqueued: 0, left: 0 },
    planned: { enqueue: [], skipped: [], created: 0 },
    leased: 0,
    ran: [],
    notes,
  };

  // 1. reap
  try {
    report.reaped = await input.io.reap();
  } catch (err) {
    notes.push(`reap failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. handoff poller
  const active = await input.io.activeHandoffs();
  const blocking = new Set<string>();
  const handoffClient = handoffClientFrom(input.io);
  for (const task of active) {
    if (JOBRIGHT_HANDOFF_KINDS.has(task.kind)) blocking.add(task.user_id);
    try {
      if (task.status === "live" && task.expires_at && new Date(task.expires_at).getTime() < t.getTime()) {
        await input.io.updateTask(task.id, { status: "expired", live_view_url: null, provider_session_id: null });
        if (task.provider_session_id) await input.provider.endSession(task.provider_session_id).catch(() => undefined);
        report.handoffs.expired += 1;
      } else if (task.status === "requested" && JOBRIGHT_HANDOFF_KINDS.has(task.kind)) {
        const r = await provisionHandoff({ client: handoffClient, provider: input.provider, task, now });
        if (r.status === "live") report.handoffs.provisioned += 1;
        else notes.push(`provision failed for ${task.user_id.slice(0, 8)}: ${r.reason}`);
      } else if (task.status === "user_done" && JOBRIGHT_HANDOFF_KINDS.has(task.kind)) {
        const created = await input.io.insertJob({ user_id: task.user_id, kind: "reconnect_verify", payload: { task_id: task.id } });
        if (created === "created") report.handoffs.reconnect_enqueued += 1;
      } else {
        // ats_login / captcha / gmail_* requested: their remote-browser
        // resolution is a later milestone — the task stays visible, unchanged.
        report.handoffs.left += 1;
      }
    } catch (err) {
      notes.push(`handoff ${task.id.slice(0, 8)} (${task.kind}/${task.status}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. planner
  try {
    const connected = await input.io.connectedJobrightUsers();
    const quota = connected.length > 0 ? await input.io.quotaRemaining(connected) : new Map<string, number>();
    const paused = await input.io.pausedUsers();
    const since = new Date(t.getTime() - APPLY_CADENCE_MINUTES * 60_000).toISOString();
    const recent = await input.io.applyJobsSince(since);
    const activeApply = new Set(recent.filter((j) => j.status === "queued" || j.status === "leased").map((j) => j.userId));
    const lastApplyAt = new Map<string, string>();
    for (const j of recent) {
      const prev = lastApplyAt.get(j.userId);
      if (!prev || prev < j.createdAt) lastApplyAt.set(j.userId, j.createdAt);
    }
    const plan = planApplyJobs({ connected, quota, paused, blocking, activeApply, lastApplyAt, now: t });
    let created = 0;
    for (const userId of plan.enqueue) {
      const r = await input.io.insertJob({ user_id: userId, kind: "apply", payload: { planned_by: "scheduler", max_submits: 1 } });
      if (r === "created") created += 1;
    }
    report.planned = { ...plan, created };
  } catch (err) {
    notes.push(`planner failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. lease + run (bounded by maxConcurrent, all in this tick)
  const limit = Math.max(1, Math.floor(input.maxConcurrent));
  let jobs: EngineJob[] = [];
  try {
    jobs = await input.io.lease(limit, input.owner);
  } catch (err) {
    notes.push(`lease failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  report.leased = jobs.length;
  const settled = await Promise.allSettled(jobs.map((job) => input.runJob(job)));
  settled.forEach((s, i) => {
    const job = jobs[i]!;
    if (s.status === "fulfilled") {
      report.ran.push({ job_id: job.id, user_id: job.user_id, kind: job.kind, outcome: s.value.outcome });
    } else {
      report.ran.push({ job_id: job.id, user_id: job.user_id, kind: job.kind, outcome: "error" });
      notes.push(`job ${job.id.slice(0, 8)} threw: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
    }
  });

  logger.info("tenant scheduler tick", {
    service: "tenants",
    action: "scheduler_tick",
    metadata: {
      reaped: report.reaped,
      handoffs: report.handoffs,
      planned: report.planned.enqueue.length,
      created: report.planned.created,
      leased: report.leased,
      ran: report.ran.map((r) => `${r.kind}:${r.outcome}`),
      notes: notes.length,
    },
  });
  return report;
}

// ── the real io ──────────────────────────────────────────────────────

export function makeSchedulerIo(client: SupabaseClientLike): SchedulerIo {
  const fail = (what: string, error: { message: string } | null): void => {
    if (error) throw new Error(`${what} failed: ${error.message}`);
  };
  return {
    async connectedJobrightUsers() {
      const { data, error } = await client
        .from("user_integrations")
        .select("user_id")
        .eq("provider", "jobright")
        .eq("status", "connected")
        .limit(1000);
      fail("user_integrations select", error);
      return ((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
    },
    async quotaRemaining(userIds) {
      const { data, error } = await client.from("user_quota_status").select("user_id, remaining").in("user_id", userIds);
      fail("user_quota_status select", error);
      return new Map(((data ?? []) as Array<{ user_id: string; remaining: number }>).map((r) => [r.user_id, Number(r.remaining) || 0]));
    },
    async pausedUsers() {
      const { data, error } = await client.from("user_engine_controls").select("user_id").eq("paused", true).limit(1000);
      fail("user_engine_controls select", error);
      return new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    },
    async activeHandoffs() {
      const { data, error } = await client
        .from("handoff_tasks")
        .select("id, user_id, kind, status, attempts, provider_session_id, expires_at")
        .in("status", [...ACTIVE_HANDOFF_STATUSES])
        .limit(1000);
      fail("handoff_tasks select", error);
      return (data ?? []) as HandoffTaskRecord[];
    },
    async applyJobsSince(sinceIso) {
      const { data, error } = await client
        .from("engine_jobs")
        .select("user_id, status, created_at")
        .eq("kind", "apply")
        .gte("created_at", sinceIso)
        .limit(5000);
      fail("engine_jobs select", error);
      return ((data ?? []) as Array<{ user_id: string; status: string; created_at: string }>).map((r) => ({
        userId: r.user_id,
        status: r.status,
        createdAt: r.created_at,
      }));
    },
    async insertJob(row) {
      const { error } = await client.from("engine_jobs").insert(row);
      if (error) {
        // engine_jobs_one_active_per_kind: an active job already exists — the planner is idempotent.
        if (/duplicate key|unique|23505/i.test(error.message)) return "exists";
        throw new Error(`engine_jobs insert failed: ${error.message}`);
      }
      return "created";
    },
    async lease(limit, owner) {
      return leaseEngineJobs(client as unknown as Parameters<typeof leaseEngineJobs>[0], {
        owner,
        limit,
        kinds: LEASE_KINDS,
        leaseSeconds: JOB_LEASE_SECONDS,
      });
    },
    async reap() {
      return reapEngineJobLeases(client as unknown as Parameters<typeof reapEngineJobLeases>[0]);
    },
    async updateTask(id, patch) {
      const { error } = await client.from("handoff_tasks").update(patch).eq("id", id);
      fail("handoff_tasks update", error);
    },
  };
}

// ── the loop ─────────────────────────────────────────────────────────

export type SchedulerReport = {
  started_at: string;
  finished_at: string;
  ticks: TickReport[];
  stopped: "duration" | "tick_cap" | "once" | "interrupted";
};

export async function runTenantScheduler(input: {
  client: SupabaseClientLike;
  config?: AppConfig;
  durationMinutes?: number;
  intervalSeconds?: number;
  maxConcurrent?: number;
  once?: boolean;
  seams?: SchedulerSeams;
}): Promise<SchedulerReport> {
  const config = input.config ?? getConfig();
  if (!config.tenantEngineEnabled) {
    throw new Error("TENANT_ENGINE_ENABLED is false (fail-closed default) — refusing to run the tenant scheduler.");
  }
  const seams = input.seams ?? {};
  const now = seams.now ?? (() => new Date());
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const io = seams.io ?? makeSchedulerIo(input.client);
  const provider = seams.provider ?? resolveRemoteBrowserProvider(config);
  const runJob =
    seams.runJob ??
    ((job: EngineJob) =>
      runTenantJob({
        userId: job.user_id,
        kind: job.kind as TenantJobKind,
        jobId: job.id,
        payload: job.payload,
        client: input.client,
        config,
      }));
  const owner = seams.owner ?? `scheduler:${process.pid}`;
  const durationMs = Math.max(1, Math.floor(input.durationMinutes ?? 60)) * 60_000;
  const intervalMs = Math.max(5, Math.floor(input.intervalSeconds ?? 60)) * 1000;
  const maxConcurrent = Math.max(1, Math.min(input.maxConcurrent ?? config.tenantMaxConcurrent, 8));
  const tickCap = Math.ceil(durationMs / intervalMs) + 1;

  const started = now();
  const ticks: TickReport[] = [];
  let stopped: SchedulerReport["stopped"] = "duration";
  let interrupted = false;
  const onSignal = (): void => {
    interrupted = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (let i = 0; i < tickCap; i += 1) {
      ticks.push(await schedulerTick({ io, provider, runJob, maxConcurrent, owner, now }));
      if (input.once) {
        stopped = "once";
        break;
      }
      if (interrupted) {
        stopped = "interrupted";
        break;
      }
      if (now().getTime() - started.getTime() >= durationMs) {
        stopped = "duration";
        break;
      }
      if (i === tickCap - 1) {
        stopped = "tick_cap";
        break;
      }
      await sleep(intervalMs);
      if (interrupted) {
        stopped = "interrupted";
        break;
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return { started_at: started.toISOString(), finished_at: now().toISOString(), ticks, stopped };
}
