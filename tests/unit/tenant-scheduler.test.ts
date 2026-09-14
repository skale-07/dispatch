import { describe, expect, it } from "vitest";
import type { EngineJob } from "../../src/cloud/engineQueue.js";
import { loadConfig } from "../../src/config/env.js";
import type { HandoffTaskRecord } from "../../src/tenants/capture.js";
import type { TenantRunResult } from "../../src/tenants/run.js";
import { planApplyJobs, runTenantScheduler, schedulerTick, type SchedulerIo } from "../../src/tenants/scheduler.js";

/**
 * Plan M18 — the tenant scheduler with no cloud and no child: the pure
 * planner's every refusal reason, one tick against a fake io (reap →
 * handoff poller → planner → lease → run), and the bounded loop.
 * UNIT_CONFIRMED; the real io's query shapes are typechecked against the
 * supabase client and LIVE_MUTATION-verified only by the tenant-zero run.
 */

const A = "aaaaaaaa-1111-4222-8333-444444444444";
const B = "bbbbbbbb-1111-4222-8333-444444444444";
const C = "cccccccc-1111-4222-8333-444444444444";
const NOW = new Date("2026-09-14T06:00:00Z");

describe("planApplyJobs (UNIT_CONFIRMED)", () => {
  it("enqueues only connected users with quota, not paused, not blocked, no active or recent apply — bounded per tick", () => {
    const users = [A, B, C, "dddddddd-1111-4222-8333-444444444444", "eeeeeeee-1111-4222-8333-444444444444", "ffffffff-1111-4222-8333-444444444444", "99999999-1111-4222-8333-444444444444"];
    const plan = planApplyJobs({
      connected: users,
      quota: new Map([[A, 3], [B, 0], [C, 5], [users[3]!, 2], [users[4]!, 2], [users[5]!, 2]]),
      paused: new Set([C]),
      blocking: new Set([users[3]!]),
      activeApply: new Set([users[4]!]),
      lastApplyAt: new Map([[users[5]!, "2026-09-14T05:30:00Z"], [A, "2026-09-14T04:00:00Z"]]),
      now: NOW,
    });
    // A: quota 3, last apply 2 h ago ⇒ planned. Everyone else has a reason.
    expect(plan.enqueue).toEqual([A]);
    expect(plan.skipped).toEqual(
      expect.arrayContaining([
        { userId: B, reason: "quota_exhausted" },
        { userId: C, reason: "paused" },
        { userId: users[3], reason: "blocking handoff" },
        { userId: users[4], reason: "apply job active" },
        { userId: users[5], reason: "within cadence" },
        { userId: users[6], reason: "no quota row" },
      ]),
    );
    expect(plan.skipped).toHaveLength(6);
  });

  it("no quota row ⇒ skipped; the per-tick cap holds", () => {
    const many = Array.from({ length: 7 }, (_, i) => `${String(i).repeat(8)}-1111-4222-8333-444444444444`);
    const plan = planApplyJobs({
      connected: many,
      quota: new Map(many.slice(0, 6).map((u) => [u, 1])),
      paused: new Set(), blocking: new Set(), activeApply: new Set(), lastApplyAt: new Map(), now: NOW,
    });
    expect(plan.enqueue).toHaveLength(5);
    expect(plan.skipped).toEqual(expect.arrayContaining([{ userId: many[5], reason: "tick cap" }, { userId: many[6], reason: "no quota row" }]));
  });
});

type Rec = { insertJob: Array<Record<string, unknown>>; updateTask: Array<{ id: string; patch: Record<string, unknown> }>; lease: number[]; reaped: number };

function fakeIo(state: { handoffs: HandoffTaskRecord[]; connected: string[]; quota: Map<string, number>; jobs: EngineJob[]; existing?: Set<string> }): { io: SchedulerIo; rec: Rec } {
  const rec: Rec = { insertJob: [], updateTask: [], lease: [], reaped: 0 };
  const io: SchedulerIo = {
    connectedJobrightUsers: async () => state.connected,
    quotaRemaining: async () => state.quota,
    pausedUsers: async () => new Set(),
    activeHandoffs: async () => state.handoffs,
    applyJobsSince: async () => [],
    insertJob: async (row) => {
      rec.insertJob.push(row);
      return state.existing?.has(`${row.user_id}:${row.kind}`) ? "exists" : "created";
    },
    lease: async (limit) => {
      rec.lease.push(limit);
      return state.jobs.slice(0, limit);
    },
    reap: async () => {
      rec.reaped += 1;
      return { requeued: 1, dead: 0 };
    },
    updateTask: async (id, patch) => {
      rec.updateTask.push({ id, patch });
    },
  };
  return { io, rec };
}

const provider = (released: string[]) => ({
  name: "fake",
  createSession: async () => ({ provider: "fake", sessionId: "s-new", connectUrl: "wss://c?apiKey=k", liveViewUrl: "https://live/new", expiresAt: null }),
  liveViewUrl: async () => "https://live/new",
  connectUrl: (id: string) => `wss://c?sessionId=${id}`,
  endSession: async (id: string) => { released.push(id); },
});

const task = (over: Partial<HandoffTaskRecord>): HandoffTaskRecord => ({
  id: "t", user_id: A, kind: "jobright_connect", status: "open", attempts: 0, provider_session_id: null, expires_at: null, ...over,
});

describe("schedulerTick (UNIT_CONFIRMED)", () => {
  it("reaps, provisions requested JobRight tasks, expires stale live ones, enqueues reconnect for user_done, plans apply jobs, leases and runs", async () => {
    const released: string[] = [];
    const { io, rec } = fakeIo({
      handoffs: [
        task({ id: "t-req", user_id: A, status: "requested" }),
        task({ id: "t-live", user_id: B, kind: "jobright_reconnect", status: "live", provider_session_id: "s-old", expires_at: "2026-09-14T05:00:00Z" }),
        task({ id: "t-done", user_id: C, kind: "jobright_reconnect", status: "user_done", provider_session_id: "s-done" }),
        task({ id: "t-ats", user_id: "dddddddd-1111-4222-8333-444444444444", kind: "ats_login", status: "requested" }),
      ],
      connected: [A, B, C, "dddddddd-1111-4222-8333-444444444444"],
      quota: new Map([[A, 2], [B, 2], [C, 2], ["dddddddd-1111-4222-8333-444444444444", 2]]),
      jobs: [
        { id: "j1", user_id: "dddddddd-1111-4222-8333-444444444444", kind: "apply", status: "leased", attempts: 1, max_attempts: 3, payload: { planned_by: "scheduler" } },
        { id: "j2", user_id: C, kind: "reconnect_verify", status: "leased", attempts: 1, max_attempts: 3, payload: { task_id: "t-done" } },
      ],
    });
    const ran: EngineJob[] = [];
    const report = await schedulerTick({
      io,
      provider: provider(released),
      runJob: async (job) => {
        ran.push(job);
        return { outcome: job.kind === "apply" ? "completed" : "capture_failed" } as TenantRunResult;
      },
      maxConcurrent: 2,
      owner: "test",
      now: () => NOW,
    });

    expect(rec.reaped).toBe(1);
    expect(report.reaped).toEqual({ requeued: 1, dead: 0 });
    // requested ⇒ provisioning ⇒ live with the provider handle and +15 min.
    const forReq = rec.updateTask.filter((u) => u.id === "t-req").map((u) => u.patch);
    expect(forReq.map((p) => p["status"])).toEqual(["provisioning", "live"]);
    expect(forReq[1]).toMatchObject({ live_view_url: "https://live/new", provider_session_id: "s-new", expires_at: "2026-09-14T06:15:00.000Z" });
    // live past expiry ⇒ expired, provider session released.
    expect(rec.updateTask.find((u) => u.id === "t-live")!.patch).toMatchObject({ status: "expired", provider_session_id: null });
    expect(released).toEqual(["s-old"]);
    // user_done ⇒ a reconnect_verify job carrying the task id.
    expect(rec.insertJob).toContainEqual({ user_id: C, kind: "reconnect_verify", payload: { task_id: "t-done" } });
    expect(report.handoffs).toEqual({ provisioned: 1, expired: 1, reconnect_enqueued: 1, left: 1 });
    // planner: A/B/C all have a blocking JobRight task; only D is planned.
    expect(report.planned.enqueue).toEqual(["dddddddd-1111-4222-8333-444444444444"]);
    expect(rec.insertJob).toContainEqual({ user_id: "dddddddd-1111-4222-8333-444444444444", kind: "apply", payload: { planned_by: "scheduler", max_submits: 1 } });
    expect(report.planned.created).toBe(1);
    // lease bounded by maxConcurrent, both jobs run, outcomes recorded.
    expect(rec.lease).toEqual([2]);
    expect(ran.map((j) => j.id)).toEqual(["j1", "j2"]);
    expect(report.ran).toEqual([
      { job_id: "j1", user_id: "dddddddd-1111-4222-8333-444444444444", kind: "apply", outcome: "completed" },
      { job_id: "j2", user_id: C, kind: "reconnect_verify", outcome: "capture_failed" },
    ]);
    expect(report.notes).toEqual([]);
  });

  it("an existing active job is not double-enqueued; a throwing job is recorded, not fatal", async () => {
    const { io, rec } = fakeIo({
      handoffs: [],
      connected: [A],
      quota: new Map([[A, 1]]),
      jobs: [{ id: "j9", user_id: A, kind: "apply", status: "leased", attempts: 1, max_attempts: 3, payload: {} }],
      existing: new Set([`${A}:apply`]),
    });
    const report = await schedulerTick({
      io, provider: provider([]), runJob: async () => { throw new Error("boom"); }, maxConcurrent: 1, owner: "test", now: () => NOW,
    });
    expect(rec.insertJob).toHaveLength(1);
    expect(report.planned.created).toBe(0);
    expect(report.ran).toEqual([{ job_id: "j9", user_id: A, kind: "apply", outcome: "error" }]);
    expect(report.notes[0]).toMatch(/job j9 threw: boom/);
  });
});

describe("runTenantScheduler (UNIT_CONFIRMED)", () => {
  const base = { NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite" };
  const on = loadConfig({ ...base, TENANT_ENGINE_ENABLED: "true", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });

  it("refuses by name with the flag off", async () => {
    await expect(runTenantScheduler({ client: {} as never, config: loadConfig(base) })).rejects.toThrow(/TENANT_ENGINE_ENABLED is false/);
  });

  it("--once runs exactly one tick; otherwise the loop is bounded by duration and a tick cap even with a frozen clock", async () => {
    const { io } = fakeIo({ handoffs: [], connected: [], quota: new Map(), jobs: [] });
    const sleeps: number[] = [];
    const seams = { io, provider: provider([]), runJob: async () => ({ outcome: "completed" }) as TenantRunResult, now: () => NOW, sleep: async (ms: number) => { sleeps.push(ms); } };
    const once = await runTenantScheduler({ client: {} as never, config: on, once: true, seams });
    expect(once.ticks).toHaveLength(1);
    expect(once.stopped).toBe("once");

    const capped = await runTenantScheduler({ client: {} as never, config: on, durationMinutes: 1, intervalSeconds: 10, seams });
    expect(capped.stopped).toBe("tick_cap");
    expect(capped.ticks).toHaveLength(7); // ceil(60s / 10s) + 1
    expect(sleeps.every((ms) => ms === 10_000)).toBe(true);
  });
});

describe("schedulerTick: Gmail handoffs (decision 2026-09-14, UNIT_CONFIRMED)", () => {
  it("a requested gmail_connect is provisioned like JobRight's, user_done enqueues the same verify job, and a Gmail task never blocks applying", async () => {
    const released: string[] = [];
    const { io, rec } = fakeIo({
      handoffs: [
        task({ id: "g-req", user_id: A, kind: "gmail_connect", status: "requested" }),
        task({ id: "g-done", user_id: B, kind: "gmail_reconnect", status: "user_done", provider_session_id: "s-g" }),
      ],
      connected: [A, B],
      quota: new Map([[A, 2], [B, 2]]),
      jobs: [],
    });
    const report = await schedulerTick({
      io,
      provider: provider(released),
      runJob: async () => ({ outcome: "completed" }) as TenantRunResult,
      maxConcurrent: 1,
      owner: "test",
      now: () => NOW,
    });
    expect(rec.updateTask.filter((u) => u.id === "g-req").map((u) => u.patch["status"])).toEqual(["provisioning", "live"]);
    expect(rec.insertJob).toContainEqual({ user_id: B, kind: "reconnect_verify", payload: { task_id: "g-done" } });
    expect(report.handoffs).toMatchObject({ provisioned: 1, reconnect_enqueued: 1, left: 0 });
    // Only a JobRight handoff blocks the planner; both users still get apply jobs.
    expect([...report.planned.enqueue].sort()).toEqual([A, B].sort());
  });
});
