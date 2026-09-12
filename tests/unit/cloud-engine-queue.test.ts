import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT } from "../../frontend/src/public/contract.js";
import { GMAIL_READONLY_SCOPE } from "../../src/gmail/readonlyGuards.js";
import { EXPECTED_RPCS, RPC_PROBE_ARGS } from "../../src/cloud/schema.js";
import { ENGINE_STATUS_COLUMNS, toEngineStatusRow } from "../../src/cloud/syncMapping.js";
import {
  completeEngineJob,
  type EngineQueueClient,
  leaseEngineJobs,
  reapEngineJobLeases,
  toEngineJobResult,
  toFeedSampleRow,
  toHandoffTaskRow,
  toOutreachDraftRow,
  toUserIntegrationsRow,
} from "../../src/cloud/engineQueue.js";

/**
 * Engine queue (migration 20260911000800 + src/cloud/engineQueue.ts).
 * UNIT_CONFIRMED — the SQL is proven live by `cloud:schema -- apply/verify`.
 *
 * What must never rot:
 *   1. the queue cannot hand one job to two workers, and a failing job
 *      cannot retry forever (house rule: attempt caps on every retry loop);
 *   2. a client can read its own rows and request exactly one kind of work
 *      — everything that spends quota is the planner's decision;
 *   3. the mappers are the engine → cloud data boundary: a feed sample is
 *      titles, an outreach draft has no body, a handoff carries no secret.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const FILE = "20260911000800_engine_queue.sql";
const SQL = fs.readFileSync(path.join(ROOT, "supabase", "migrations", FILE), "utf8");

/** The body of one `create or replace function`, by name. */
function fn(name: string): string {
  const re = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const body = re.exec(SQL)?.[0] ?? "";
  expect(body, `${name} is not defined in ${FILE}`).not.toBe("");
  return body;
}

describe("engine queue SQL — leasing and retry caps (UNIT_CONFIRMED)", () => {
  it("leases with FOR UPDATE SKIP LOCKED so two schedulers cannot claim one job", () => {
    const lease = fn("lease_engine_jobs");
    expect(lease).toMatch(/for update skip locked/);
    expect(lease).toMatch(/status = 'leased'/);
    // A lease must be attributable and time-boxed, or the reaper cannot work.
    expect(lease).toMatch(/lease_owner = p_owner/);
    expect(lease).toMatch(/lease_until = now\(\) \+ make_interval/);
    expect(lease).toMatch(/attempts = j\.attempts \+ 1/);
    // Refuses before any write, so the read-only schema probe is safe.
    expect(lease.indexOf("raise exception 'lease owner required'")).toBeLessThan(
      lease.indexOf("update public.engine_jobs"),
    );
  });

  it("a queued/leased job is unique per (user, kind) so a double-enqueue cannot double-spend quota", () => {
    expect(SQL).toMatch(
      /create unique index if not exists engine_jobs_one_active_per_kind[\s\S]*?on public\.engine_jobs \(user_id, kind\)[\s\S]*?where status in \('queued', 'leased'\)/,
    );
  });

  it("completion buries a job at the attempt cap instead of retrying forever", () => {
    const complete = fn("complete_engine_job");
    expect(complete).toMatch(/v_job\.attempts >= v_job\.max_attempts/);
    expect(complete).toMatch(/v_next := 'dead'/);
    // Only a failure under the cap goes back to the queue, and with backoff.
    expect(complete).toMatch(/v_next := 'queued'/);
    expect(complete).toMatch(/run_after = case when v_next = 'queued' then now\(\) \+ make_interval/);
    expect(complete.indexOf("raise exception 'unknown job'")).toBeLessThan(
      complete.indexOf("update public.engine_jobs"),
    );
  });

  it("the reaper returns an expired lease to the queue, or buries it at the cap", () => {
    const reap = fn("reap_engine_job_leases");
    expect(reap).toMatch(/lease_until < now\(\)/);
    expect(reap).toMatch(/case when e\.attempts >= e\.max_attempts then 'dead' else 'queued' end/);
    expect(reap).toMatch(/for update skip locked/);
  });

  it("max_attempts defaults to 3 and the table checks its own status vocabulary", () => {
    expect(SQL).toMatch(/max_attempts integer not null default 3/);
    expect(SQL).toMatch(
      /status text not null default 'queued'[\s\S]*?check \(status in \('queued', 'leased', 'succeeded', 'failed', 'dead'\)\)/,
    );
  });
});

describe("engine queue SQL — what a client may touch (UNIT_CONFIRMED)", () => {
  const TABLES = [
    "engine_jobs",
    "handoff_tasks",
    "jobright_feed_samples",
    "outreach_drafts",
    "user_engine_controls",
  ];

  it("every new table has RLS on, no anon grant, and an own-row select policy", () => {
    for (const t of TABLES) {
      expect(SQL, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(SQL, t).toMatch(new RegExp(`revoke all on public\\.${t} from anon`));
      expect(SQL, t).toMatch(new RegExp(`on public\\.${t} for select[\\s\\S]*?user_id = auth\\.uid\\(\\)`));
    }
  });

  it("the engine's lease bookkeeping and job payloads are not granted to a client", () => {
    // `[^)]*` so the capture cannot start at an EARLIER table's grant and
    // swallow the DDL in between (which names every column).
    const grant = /grant select \(([^)]*)\) on public\.engine_jobs to authenticated/.exec(SQL)?.[1] ?? "";
    expect(grant).not.toBe("");
    for (const col of ["lease_owner", "lease_until", "payload"]) {
      expect(grant, col).not.toContain(col);
    }
    // ...and the view the dashboard actually reads omits them too.
    const view = /create or replace view public\.my_engine_jobs[\s\S]*?where user_id = auth\.uid\(\);/.exec(SQL)?.[0] ?? "";
    expect(view).toMatch(/security_invoker = true/);
    for (const col of ["lease_owner", "lease_until", "payload"]) {
      expect(view, col).not.toContain(col);
    }
  });

  it("the remote-browser session handle never reaches a client", () => {
    const grant = /grant select \(([^)]*)\) on public\.handoff_tasks to authenticated/.exec(SQL)?.[1] ?? "";
    expect(grant).not.toBe("");
    expect(grant).not.toContain("provider_session_id");
    const view = /create or replace view public\.my_handoff_tasks[\s\S]*?where user_id = auth\.uid\(\);/.exec(SQL)?.[0] ?? "";
    expect(view).not.toContain("provider_session_id");
    // The live view URL is the whole point of the handoff, so it does.
    expect(view).toContain("live_view_url");
  });

  it("a user may request a feed sample and nothing else, and never twice at once", () => {
    const request = fn("request_engine_job");
    expect(request.indexOf("raise exception 'not authenticated'")).toBeLessThan(
      request.indexOf("insert into public.engine_jobs"),
    );
    expect(request).toMatch(/p_kind is distinct from 'feed_sample'/);
    expect(request).toMatch(/raise exception 'only feed_sample may be requested'/);
    // Deduped: an in-flight sample returns the existing id.
    expect(request).toMatch(/status in \('queued', 'leased'\)/);
    expect(request).toMatch(/'created', false/);
  });

  it("the three handoff RPCs check auth before reading or writing a row", () => {
    for (const name of ["handoff_task_request", "handoff_task_user_done", "handoff_task_cancel"]) {
      const body = fn(name);
      const auth = body.indexOf("raise exception 'not authenticated'");
      expect(auth, name).toBeGreaterThan(-1);
      // Compare against the first real statement — a `%rowtype` declaration
      // in the DECLARE block names the table without touching a row.
      const firstAccess = body.search(/\b(select \* into|insert into|update public)\b/);
      expect(auth, name).toBeLessThan(firstAccess);
    }
  });

  it("user_done cannot mark a task completed — only the engine's verification can", () => {
    const body = fn("handoff_task_user_done");
    expect(body).toMatch(/set status = 'user_done'/);
    expect(body).not.toMatch(/status = 'completed'/);
    // And it only applies to a task that is actually on screen.
    expect(body).toMatch(/status not in \('live', 'provisioning'\)/);
  });

  it("one live handoff per (user, kind) — a second prompt on screen is always a bug", () => {
    expect(SQL).toMatch(
      /create unique index if not exists handoff_tasks_one_active_per_kind[\s\S]*?where status in \('open', 'requested', 'provisioning', 'live', 'user_done', 'verifying'\)/,
    );
  });

  it("a client may flip `paused` but cannot backdate paused_at", () => {
    expect(SQL).toMatch(/grant update \(paused\) on public\.user_engine_controls to authenticated/);
    const stamp = fn("stamp_engine_controls_paused_at");
    expect(stamp).toMatch(/new\.paused_at := now\(\)/);
    expect(SQL).toMatch(/before insert or update on public\.user_engine_controls/);
  });

  it("every engine RPC revokes public and authenticated, then grants only the service role", () => {
    for (const name of ["lease_engine_jobs", "complete_engine_job", "reap_engine_job_leases"]) {
      expect(SQL, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public`));
      expect(SQL, name).toMatch(
        new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from anon, authenticated`),
      );
      expect(SQL, name).toMatch(
        new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`),
      );
    }
  });

  it("engine_status gains a checked state, and the backfill leaves no null behind", () => {
    expect(SQL).toMatch(/add column if not exists state text/);
    expect(SQL).toMatch(/update public\.engine_status set state = 'idle' where state is null/);
    expect(SQL).toMatch(/check \(state in \('idle', 'running', 'parked', 'quota_exhausted'\)\)/);
    // The backfill must precede NOT NULL or the migration fails on re-run.
    expect(SQL.indexOf("update public.engine_status set state")).toBeLessThan(
      SQL.indexOf("alter column state set not null"),
    );
  });
});

describe("engine queue is registered with the schema probe and the SPA (UNIT_CONFIRMED)", () => {
  const NEW_RPCS = [
    "lease_engine_jobs",
    "complete_engine_job",
    "reap_engine_job_leases",
    "request_engine_job",
    "handoff_task_request",
    "handoff_task_user_done",
    "handoff_task_cancel",
  ];

  it("every new RPC is expected by the read-back and carries probe arguments", () => {
    for (const name of NEW_RPCS) {
      expect(EXPECTED_RPCS, name).toContain(name);
      expect(Object.keys(RPC_PROBE_ARGS), name).toContain(name);
    }
  });

  it("the probe's arguments are the ones each function refuses on", () => {
    // An empty owner and a nil job id are what make the probe a no-op.
    expect(RPC_PROBE_ARGS.lease_engine_jobs.p_owner).toBe("");
    expect(RPC_PROBE_ARGS.complete_engine_job.p_status).toBe("succeeded");
    expect(RPC_PROBE_ARGS.request_engine_job.p_kind).toBe("feed_sample");
  });

  it("the SPA names the views and RPCs the migration actually creates", () => {
    expect(SQL).toContain(`create or replace view public.${CONTRACT.engineJobsView}`);
    expect(SQL).toContain(`create or replace view public.${CONTRACT.handoffTasksView}`);
    expect(NEW_RPCS).toContain(CONTRACT.requestEngineJobRpc);
    expect(NEW_RPCS).toContain(CONTRACT.handoffRequestRpc);
    expect(CONTRACT.requestableJobKind).toBe("feed_sample");
  });
});

describe("engine → cloud mappers are the data boundary (UNIT_CONFIRMED)", () => {
  it("a feed sample carries title, company and location — and drops everything else", () => {
    const row = toFeedSampleRow({
      userId: "u1",
      now: new Date("2026-09-12T00:00:00.000Z"),
      jobs: [
        {
          title: "Data Analyst",
          company: "Acme",
          location: "Columbus, OH",
          // A caller passing a whole posting must not leak it.
          ...({ description: "SECRET", url: "https://x", salary: "$1" } as Record<string, unknown>),
        },
      ],
      totalCount: 42,
    });
    expect(Object.keys(row.jobs[0]!).sort()).toEqual(["company", "location", "title"]);
    expect(JSON.stringify(row)).not.toContain("SECRET");
    // The sample is truncated; the count is what the feed really had.
    expect(row.count).toBe(42);
  });

  it("a feed sample is capped so it stays a teaser, not a feed dump", () => {
    const jobs = Array.from({ length: 100 }, (_, i) => ({
      title: `t${i}`,
      company: "c",
      location: "l",
    }));
    const row = toFeedSampleRow({ userId: "u1", now: new Date(), jobs });
    expect(row.jobs.length).toBe(25);
    expect(row.count).toBe(100);
  });

  it("an outreach draft records that a draft exists, never its body", () => {
    const row = toOutreachDraftRow({
      userId: "u1",
      engineApplicationId: "app-1",
      company: "Acme",
      contactName: "A. Recruiter",
      subject: "Referral request",
      gmailDraftId: "r-123",
    });
    expect(Object.keys(row).sort()).toEqual([
      "company",
      "contact_name",
      "engine_application_id",
      "gmail_draft_id",
      "subject",
      "user_id",
    ]);
    // There is no body column to fill, in the type or the table.
    expect(SQL).not.toMatch(/^\s*body\b/m);
  });

  it("a handoff task's context is whitelisted — a caller cannot smuggle page content in", () => {
    const row = toHandoffTaskRow({
      userId: "u1",
      kind: "jobright_reconnect",
      status: "open",
      reason: "JobRight session expired",
      host: "jobright.ai",
      engineApplicationId: "app-9",
      ats: "workday",
      ...({ password: "hunter2" } as Record<string, unknown>),
    });
    expect(Object.keys(row.context).sort()).toEqual(["ats", "engine_application_id", "host"]);
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  it("the mappers refuse a missing user id rather than writing an orphan row", () => {
    expect(() => toHandoffTaskRow({ userId: " ", kind: "captcha", status: "open" })).toThrow(
      /cloud user id/,
    );
    expect(() => toFeedSampleRow({ userId: "", now: new Date(), jobs: [] })).toThrow(/cloud user id/);
    expect(() => toOutreachDraftRow({ userId: "", engineApplicationId: "a" })).toThrow(
      /cloud user id/,
    );
    expect(() => toOutreachDraftRow({ userId: "u", engineApplicationId: " " })).toThrow(
      /engine application id/,
    );
  });

  it("an unknown handoff kind or status is a throw, not a row the CHECK will reject later", () => {
    expect(() =>
      toHandoffTaskRow({ userId: "u", kind: "sso_login" as never, status: "open" }),
    ).toThrow(/unknown handoff kind/);
    expect(() =>
      toHandoffTaskRow({ userId: "u", kind: "captcha", status: "done" as never }),
    ).toThrow(/unknown handoff status/);
  });

  it("a completion result is small, fixed-shape, and clamps its own backoff", () => {
    const r = toEngineJobResult({
      jobId: "j1",
      status: "failed",
      applied: 3,
      submitted: 1,
      error: "portal timeout",
      retryAfterSeconds: 5,
    });
    expect(Object.keys(r.p_result).sort()).toEqual(["applied", "error", "note", "submitted"]);
    expect(r.p_retry_after_s).toBe(10);
    expect(toEngineJobResult({ jobId: "j", status: "dead", retryAfterSeconds: 10 ** 9 }).p_retry_after_s).toBe(86_400);
    expect(() => toEngineJobResult({ jobId: "j", status: "leased" as never })).toThrow(
      /unknown engine job completion/,
    );
  });

  it("a Gmail grant wider than the product's own scopes is dropped, not stored", () => {
    const row = toUserIntegrationsRow({
      userId: "u1",
      provider: "gmail",
      status: "connected",
      // A consent screen can return more than was asked for; only what the
      // safety boundary sanctions may be recorded. The wider scopes are
      // built here rather than written out, because several of them are
      // forbidden identifiers repo-wide (src/gmail/readonlyGuards.ts).
      scopes: [
        GMAIL_READONLY_SCOPE,
        ["https://www.googleapis.com/auth/gmail", "compose"].join("."),
        "https://mail.google.com/",
      ],
    });
    expect(row.scopes).toEqual([GMAIL_READONLY_SCOPE]);
    // jobright has no OAuth scopes at all.
    expect(
      toUserIntegrationsRow({ userId: "u1", provider: "jobright", status: "connected" }).scopes,
    ).toEqual([]);
  });

  it("engine_status carries the live state, and explains itself only when parked", () => {
    const base = {
      userId: "u1",
      now: new Date("2026-09-12T00:00:00.000Z"),
      engineVersion: "abc1234",
      attempted: 1,
      upserted: 1,
      durationMs: 10,
      error: null,
    };
    const running = toEngineStatusRow({ ...base, state: "running", currentJobId: "job-1" });
    expect(running.state).toBe("running");
    expect(running.current_job_id).toBe("job-1");
    expect(running.paused_reason).toBeNull();

    const parked = toEngineStatusRow({
      ...base,
      state: "parked",
      pausedReason: "JobRight sign-in needed",
      currentJobId: "job-1",
    });
    expect(parked.paused_reason).toBe("JobRight sign-in needed");
    // A parked engine is not running a job.
    expect(parked.current_job_id).toBeNull();

    expect(toEngineStatusRow(base).state).toBe("idle");
    expect(Object.keys(toEngineStatusRow(base)).sort()).toEqual([...ENGINE_STATUS_COLUMNS].sort());
    expect(() => toEngineStatusRow({ ...base, state: "burning" as never })).toThrow(
      /unknown engine state/,
    );
  });
});

describe("engine queue client (UNIT_CONFIRMED)", () => {
  function fakeClient(
    rpcImpl: (fn: string, args?: Record<string, unknown>) => { data: unknown; error: { message: string } | null },
  ): { client: EngineQueueClient; calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> } {
    const calls: Array<{ fn: string; args: Record<string, unknown> | undefined }> = [];
    return {
      calls,
      client: {
        rpc: (fn, args) => {
          calls.push({ fn, args });
          return Promise.resolve(rpcImpl(fn, args));
        },
        from: () => ({ upsert: () => Promise.resolve({ error: null }) }),
      },
    };
  }

  it("clamps the lease batch and passes null kinds rather than an empty filter", async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    await leaseEngineJobs(client, { owner: "worker-1", limit: 9999, kinds: [] });
    expect(calls[0]!.args!.p_limit).toBe(50);
    // An empty array would match nothing; null means "any kind".
    expect(calls[0]!.args!.p_kinds).toBeNull();

    await leaseEngineJobs(client, { owner: "worker-1", limit: 0, kinds: ["apply"] });
    expect(calls[1]!.args!.p_limit).toBe(1);
    expect(calls[1]!.args!.p_kinds).toEqual(["apply"]);
  });

  it("refuses to lease without an owner, before any call is made", async () => {
    const { client, calls } = fakeClient(() => ({ data: [], error: null }));
    await expect(leaseEngineJobs(client, { owner: "  " })).rejects.toThrow(/owner/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the database's own message and returns [] for a non-array answer", async () => {
    const failing = fakeClient(() => ({ data: null, error: { message: "permission denied" } }));
    await expect(leaseEngineJobs(failing.client, { owner: "w" })).rejects.toThrow(
      /lease_engine_jobs failed: permission denied/,
    );
    const empty = fakeClient(() => ({ data: null, error: null }));
    expect(await leaseEngineJobs(empty.client, { owner: "w" })).toEqual([]);
  });

  it("completion forwards exactly the mapper's argument names", async () => {
    const { client, calls } = fakeClient(() => ({ data: { id: "j1", status: "succeeded" }, error: null }));
    const result = toEngineJobResult({ jobId: "j1", status: "succeeded", applied: 2 });
    await completeEngineJob(client, result);
    expect(calls[0]!.fn).toBe("complete_engine_job");
    expect(Object.keys(calls[0]!.args!).sort()).toEqual([
      "p_job",
      "p_result",
      "p_retry_after_s",
      "p_status",
    ]);
  });

  it("the reaper's counts are normalised even when the row comes back empty", async () => {
    const { client } = fakeClient(() => ({ data: {}, error: null }));
    expect(await reapEngineJobLeases(client)).toEqual({ requeued: 0, dead: 0 });
  });
});
