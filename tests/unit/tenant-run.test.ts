import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATED_FLAG_KEYS } from "../../src/console/flagCeiling.js";
import type { OnboardedUser } from "../../src/cloud/syncMapping.js";
import { loadConfig } from "../../src/config/env.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import { composeTenantChildEnv, flagsAboveCeiling, TENANT_FORCED_OFF } from "../../src/tenants/childEnv.js";
import { currentTenant } from "../../src/tenants/context.js";
import { deriveTenantKey } from "../../src/tenants/keys.js";
import { tenantPaths } from "../../src/tenants/paths.js";
import { computeRunBudget } from "../../src/tenants/quota.js";
import { JOBRIGHT_STATE_SECRET, runTenantJob, type ChildLaunchSpec } from "../../src/tenants/run.js";
import { listUnsealed, sealSecret } from "../../src/tenants/secrets.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * Plan M15 — tenant:run. Everything the runner composes is exercised with
 * a fake cloud client and a fake child launcher that receives the EXACT
 * spec the real launcher would run: the gate, the quota budget, the
 * sealed-session requirement (handoff instead of a login page), the child
 * env ceiling + strips, plaintext lifetime (present during the child,
 * gone after), the result record, the queue completion and the handoff
 * derivation from the tenant's own review items. UNIT_CONFIRMED.
 */

const UID = "11111111-2222-4333-8444-555555555555";
const MASTER = Buffer.alloc(32, 7);
const KEY = deriveTenantKey(MASTER, UID);
const JOB = "9f2c0b6e-1111-4222-8333-444444444444";

function user(): OnboardedUser {
  const profile = {
    user_id: UID, full_name: "Maya Okafor", phone: "+1 412 555 0148",
    location_city: "Pittsburgh", location_region: "PA", location_country: "United States",
    linkedin_url: null, github_url: null, portfolio_url: null,
    work_authorization: "us_citizen", needs_sponsorship: false,
    education: [{ school: "Pitt", degree: "B.S.", field: "CS", start_year: 2023, end_year: 2027 }],
    job_preferences: { titles: ["SWE Intern"] },
    resume_object_path: null, resume_filename: null,
    onboarding_completed_at: "2026-09-12T20:00:00Z",
    about_me: "I build things and verify them.",
    legal_first_name: "Maya", legal_last_name: "Okafor",
  };
  return {
    userId: UID, email: "maya@pitt.edu", fullName: "Maya Okafor", phone: profile.phone,
    location: { city: "Pittsburgh", region: "PA", country: "United States" },
    links: { linkedin: null, github: null, portfolio: null },
    workAuthorization: "us_citizen", needsSponsorship: false,
    education: profile.education, jobPreferences: profile.job_preferences,
    resumeObjectPath: null, resumeFilename: null,
    onboardingCompletedAt: profile.onboarding_completed_at, maxCompletedApplications: 5,
    profile, documents: [], screenerAnswers: [], persona: null, integrations: [],
  };
}

type Call = { table?: string; rpc?: string; args?: Record<string, unknown>; rows?: unknown };

function fakeClient(quotaRow: Record<string, unknown> | null, taskRow: Record<string, unknown> | null = null): { client: any; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    storage: { from: () => ({ download: async () => ({ data: new Blob([Buffer.from("%PDF-x")]), error: null }) }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ rpc: name, args });
      if (name === "complete_engine_job") return { data: { id: args["p_job"], status: args["p_status"] }, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => ({
      upsert: async (rows: unknown) => {
        calls.push({ table, rows });
        return { error: null };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          calls.push({ table, rows: { id, ...patch } });
          return { error: null };
        },
      }),
      delete: () => ({
        eq: async (_col: string, id: string) => {
          calls.push({ table, rows: { deleted: id } });
          return { error: null };
        },
      }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "handoff_tasks" || table === "gmail_oauth_requests" ? taskRow : quotaRow, error: null }) }) }),
    }),
  };
  return { client, calls };
}

describe("tenant:run (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");
  let root: string;
  let operatorPrivate: string;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-tenant-run-"));
    operatorPrivate = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-operator-"));
    fs.mkdirSync(path.join(operatorPrivate, "candidate"), { recursive: true });
    config = loadConfig({
      NODE_ENV: "test",
      DATABASE_PATH: "data/test.sqlite",
      TENANT_ENGINE_ENABLED: "true",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      TENANTS_ROOT: root,
      PRIVATE_DIR: operatorPrivate,
    });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(operatorPrivate, { recursive: true, force: true });
  });

  const quotaOk = { max_completed_applications: 5, completed_applications: 1, remaining: 4 };

  it("refuses by name with the flag off; nothing is written", async () => {
    const off = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", TENANTS_ROOT: root });
    const { client } = fakeClient(quotaOk);
    await expect(runTenantJob({ userId: UID, kind: "apply", client, config: off, seams: { user: user(), tenantKey: KEY } })).rejects.toThrow(
      /TENANT_ENGINE_ENABLED is false/,
    );
    expect(fs.existsSync(tenantPaths(UID, root).root)).toBe(false);
  });

  it("no quota row ⇒ quota_exhausted: no child, job succeeded with the reason, engine_status quota_exhausted", async () => {
    const { client, calls } = fakeClient(null);
    let launched = 0;
    const r = await runTenantJob({
      userId: UID, kind: "apply", jobId: JOB, client, config,
      seams: { user: user(), tenantKey: KEY, launch: async () => { launched += 1; return { exitCode: 0, timedOut: false, durationMs: 1 }; } },
    });
    expect(launched).toBe(0);
    expect(r.outcome).toBe("quota_exhausted");
    expect(r.budget).toEqual({ maxSubmits: 0, unmirrored: 0, reason: "quota_missing" });
    expect(r.engine_state).toBe("quota_exhausted");
    const done = calls.find((c) => c.rpc === "complete_engine_job")!;
    expect(done.args!["p_status"]).toBe("succeeded");
    expect((done.args!["p_result"] as Record<string, unknown>)["note"]).toBe("quota_exhausted");
    const hb = calls.filter((c) => c.table === "engine_status").at(-1)!.rows as Record<string, unknown>;
    expect(hb["state"]).toBe("quota_exhausted");
    expect(fs.existsSync(r.result_path)).toBe(true);
  });

  it("no sealed JobRight session ⇒ a jobright_connect handoff, no child, job failed-retryable, engine parked", async () => {
    const { client, calls } = fakeClient(quotaOk);
    let launched = 0;
    const r = await runTenantJob({
      userId: UID, kind: "apply", jobId: JOB, client, config,
      seams: { user: user(), tenantKey: KEY, launch: async () => { launched += 1; return { exitCode: 0, timedOut: false, durationMs: 1 }; } },
    });
    expect(launched).toBe(0);
    expect(r.outcome).toBe("needs_jobright_connect");
    expect(r.handoffs).toEqual(["jobright_connect"]);
    const task = calls.find((c) => c.table === "handoff_tasks")!.rows as Record<string, unknown>;
    expect(task["kind"]).toBe("jobright_connect");
    expect(task["status"]).toBe("open");
    expect(task["user_id"]).toBe(UID);
    const done = calls.find((c) => c.rpc === "complete_engine_job")!;
    expect(done.args!["p_status"]).toBe("failed");
    expect(done.args!["p_retry_after_s"]).toBe(3600);
    expect(r.engine_state).toBe("parked");
    expect(listUnsealed(tenantPaths(UID, root))).toEqual([]);
  });

  it("with a sealed session: plaintext exists only while the child runs, the child env is ceiling-capped and stripped, the run is recorded and completed", async () => {
    const paths = tenantPaths(UID, root);
    fs.mkdirSync(paths.secretsDir, { recursive: true });
    sealSecret(paths, JOBRIGHT_STATE_SECRET, { cookies: [{ name: "sid", value: "s3cret" }], origins: [] }, KEY);
    // A wall from a previous run on the tenant's OWN database: an Ashby login the engine cannot do headlessly.
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const seed = openDatabase(paths.dbPath);
    migrate(seed);
    upsertOpenReviewItem(seed, { kind: "AUTH_REQUIRED", title: "Sign in required at jobs.ashbyhq.com", payload: { service: "ats", url: "https://jobs.ashbyhq.com/acme/login", ats: "ashby" } });
    closeDatabase(seed);

    const { client, calls } = fakeClient(quotaOk);
    let seen: { spec: ChildLaunchSpec; plaintextDuring: string[]; storageDuring: string } | null = null;
    const r = await runTenantJob({
      userId: UID, kind: "apply", jobId: JOB, client, config, maxSubmits: 3,
      seams: {
        user: user(), tenantKey: KEY,
        launch: async (spec) => {
          const storagePath = path.join(paths.authDir, "jobright.storage.json");
          seen = { spec, plaintextDuring: listUnsealed(paths), storageDuring: fs.readFileSync(storagePath, "utf8") };
          // The child writes its cycle report where auto-cycle always writes it — inside the tenant's artifacts.
          const dir = path.join(spec.env["ARTIFACTS_DIR"]!, "console", "auto-cycle");
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, "cycle-2026-09-14T03-00-00-000Z.json"), JSON.stringify({
            outcome: "completed",
            notes: ["discover skipped (jobright_auth)"],
            preflight: { ok: true, notes: [] },
            session: { apps_started: 2, submits_used: 1, stopped_reason: "apps_cap", notes: [] },
          }));
          return { exitCode: 0, timedOut: false, durationMs: 5 };
        },
      },
    });

    expect(seen).not.toBeNull();
    const { spec, plaintextDuring, storageDuring } = seen!;
    // Plaintext lifetime.
    expect(plaintextDuring).toEqual(["private/auth/jobright.storage.json"]);
    expect(storageDuring).toContain("s3cret");
    expect(listUnsealed(paths)).toEqual([]);
    expect(r.plaintext_wiped).toBe(1);
    // The child: the repo CLI, the tenant's workspace, the budget, no operator secret, no flag above the ceiling.
    expect(spec.args.join(" ")).toMatch(/cli[\\/]index\.ts auto:\S+ --no-update --defer-gmail --duration 45 --max-apps 3 --max-submits 3 --app-deadline 300$/);
    expect(spec.env["PRIVATE_DIR"]).toBe(paths.privateDir);
    expect(spec.env["DATABASE_PATH"]).toBe(paths.dbPath);
    expect(spec.env["ARTIFACTS_DIR"]).toBe(paths.artifactsDir);
    expect(spec.env["CANDIDATE_KEY_PROVIDER"]).toBe("tenant");
    expect(spec.env["TENANT_USER_ID"]).toBe(UID);
    expect(spec.env["TENANTS_ROOT"]).toBe(root);
    expect(spec.env["SUPABASE_SYNC_USER_ID"]).toBe(UID);
    expect(spec.env["SUPABASE_SYNC_ENABLED"]).toBe("false");
    expect(spec.env["PORTAL_LOGIN_EMAIL"]).toBe("maya@pitt.edu");
    expect(spec.env["MAX_UNATTENDED_SUBMISSIONS_PER_RUN"]).toBe("3");
    expect(spec.env["SUBMIT_REQUIRES_LOCAL_CONFIRMATION"]).toBe("false");
    for (const k of ["PORTAL_LOGIN_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ACCESS_TOKEN", "TENANT_ENGINE_ENABLED", "ALLOW_INSECURE_CANDIDATE_KEY", "CANDIDATE_DATA_KEY"]) {
      expect(spec.env, k).not.toHaveProperty(k);
    }
    for (const k of TENANT_FORCED_OFF) expect(spec.env[k], k).toBe("false");
    expect(flagsAboveCeiling(process.env, spec.env)).toEqual([]);
    expect(spec.timeoutMs).toBe(45 * 60_000 + 10 * 60_000);
    // Recorded and completed.
    expect(r.outcome).toBe("completed");
    expect(r.cycle).toMatchObject({ outcome: "completed", apps_started: 2, submits_used: 1, error_codes: ["jobright_auth"] });
    const done = calls.find((c) => c.rpc === "complete_engine_job")!;
    expect(done.args!["p_status"]).toBe("succeeded");
    expect(done.args!["p_result"]).toMatchObject({ applied: 2, submitted: 1 });
    // Handoffs from the tenant's own walls + the run signal, one per kind, engine parked on them.
    expect(r.handoffs.sort()).toEqual(["ats_login", "jobright_reconnect"]);
    const ats = calls.filter((c) => c.table === "handoff_tasks").map((c) => c.rows as Record<string, unknown>).find((t) => t["kind"] === "ats_login")!;
    expect(ats["context"]).toEqual({ host: "jobs.ashbyhq.com", ats: "ashby" });
    expect(r.engine_state).toBe("parked");
    expect(r.notes).toContain("sync skipped: SUPABASE_SYNC_ENABLED off");
    const saved = JSON.parse(fs.readFileSync(r.result_path, "utf8")) as Record<string, unknown>;
    expect(saved["job_id"]).toBe(JOB);
    expect(r.result_path.startsWith(path.join(paths.runsDir, JOB))).toBe(true);
  });

  it("a child that overruns is killed: plaintext still wiped, job failed-retryable", async () => {
    const paths = tenantPaths(UID, root);
    sealSecret(paths, JOBRIGHT_STATE_SECRET, { cookies: [], origins: [] }, KEY);
    const { client, calls } = fakeClient(quotaOk);
    const r = await runTenantJob({
      userId: UID, kind: "apply", jobId: JOB, client, config,
      seams: { user: user(), tenantKey: KEY, launch: async () => ({ exitCode: null, timedOut: true, durationMs: 99 }) },
    });
    expect(r.outcome).toBe("child_timeout");
    expect(listUnsealed(paths)).toEqual([]);
    expect(calls.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("failed");
  });

  it("reconnect_verify: captures the user_done task's session, seals it, connects the integration, requeues the parked application, job succeeded", async () => {
    const paths = tenantPaths(UID, root);
    fs.mkdirSync(paths.dataDir, { recursive: true });
    const seed = openDatabase(paths.dbPath);
    migrate(seed);
    const job = upsertJobByFingerprint(seed, { company: "Acme", role: "SWE Intern", applicationUrl: "https://jobs.lever.co/acme/1" });
    const parked = createApplication(seed, { jobId: job.id, state: "AUTH_REQUIRED" });
    upsertOpenReviewItem(seed, { kind: "AUTH_REQUIRED", title: "jobright authentication required", payload: { service: "jobright" } });
    closeDatabase(seed);

    const TASK = "7a7a7a7a-1111-4222-8333-444444444444";
    const { client, calls } = fakeClient(quotaOk, { id: TASK, user_id: UID, kind: "jobright_reconnect", status: "user_done", attempts: 0, provider_session_id: "sess_9", expires_at: null });
    const released: string[] = [];
    const openedWith: string[] = [];
    const r = await runTenantJob({
      userId: UID, kind: "reconnect_verify", jobId: JOB, payload: { task_id: TASK }, client, config,
      seams: {
        user: user(), tenantKey: KEY,
        reconnect: {
          provider: {
            name: "fake",
            createSession: async () => { throw new Error("not used"); },
            liveViewUrl: async () => "x",
            connectUrl: (id) => `wss://c?sessionId=${id}`,
            endSession: async (id) => { released.push(id); },
          },
          openSession: (url) => {
            openedWith.push(url);
            return {
              open: async () => undefined,
              validate: async () => ({ ok: true, status: "AUTHENTICATED", url: "https://jobright.ai/jobs/recommend", reason: "app shell", checkedAt: "2026-09-14T06:00:00.000Z" }),
              getContext: () => ({ storageState: async () => ({ cookies: [{ name: "sid", value: "v" }], origins: [] }) }),
              newPage: async () => ({ goto: async () => undefined, locator: () => ({ count: async () => 0 }), close: async () => undefined }),
              close: async () => undefined,
            };
          },
        },
      },
    });
    expect(r.outcome).toBe("completed");
    expect(openedWith).toEqual(["wss://c?sessionId=sess_9"]);
    expect(released).toEqual(["sess_9"]);
    expect(fs.existsSync(path.join(paths.secretsDir, `${JOBRIGHT_STATE_SECRET}.enc`))).toBe(true);
    expect(r.reconnect).toMatchObject({ outcome: "completed", parks: { resolved: 1, requeued: 1 } });
    const check = openDatabase(paths.dbPath);
    try {
      expect(getApplication(check, parked.id)!.state).toBe("APPLICATION_OPENING");
    } finally {
      closeDatabase(check);
    }
    expect(calls.find((c) => c.rpc === "engine_set_integration_status")!.args).toMatchObject({ p_user: UID, p_provider: "jobright", p_status: "connected" });
    const statuses = calls.filter((c) => c.table === "handoff_tasks").map((c) => (c.rows as Record<string, unknown>)["status"]);
    expect(statuses).toEqual(["verifying", "completed"]);
    expect(calls.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("succeeded");
    expect(listUnsealed(paths)).toEqual([]);
  });

  it("reconnect_verify refuses a task that is not user_done (no browser, job failed-retryable)", async () => {
    const { client, calls } = fakeClient(quotaOk, { id: "t", user_id: UID, kind: "jobright_connect", status: "live", attempts: 0, provider_session_id: "s", expires_at: null });
    const r = await runTenantJob({ userId: UID, kind: "reconnect_verify", jobId: JOB, payload: { task_id: "t" }, client, config, seams: { user: user(), tenantKey: KEY, reconnect: { openSession: () => { throw new Error("must not open"); } } } });
    expect(r.outcome).toBe("refused");
    expect(r.reconnect?.reason).toMatch(/is live, not user_done/);
    expect(calls.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("failed");
  });

  it("gmail_exchange: exchanges the pending code, seals the grant, marks the job succeeded; a refused grant kills the job", async () => {
    const withCreds = loadConfig({
      NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", TENANT_ENGINE_ENABLED: "true",
      SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", TENANTS_ROOT: root, PRIVATE_DIR: operatorPrivate,
      GMAIL_OAUTH_CLIENT_ID: "web-id", GMAIL_OAUTH_CLIENT_SECRET: "web-secret",
    });
    const request = { user_id: UID, code: "4/abc", code_verifier: "ver", redirect_uri: "https://app/gmail/callback", created_at: new Date().toISOString() };
    const { client, calls } = fakeClient(quotaOk, request);
    const r = await runTenantJob({
      userId: UID, kind: "gmail_exchange", jobId: JOB, client, config: withCreds,
      seams: { user: user(), tenantKey: KEY, gmailExchange: async () => ({ refreshToken: "rt", scopes: ["https://www.googleapis.com/auth/gmail.readonly"], accountEmail: "maya@gmail.com", obtainedAt: "2026-09-14T07:00:00.000Z" }) },
    });
    expect(r.outcome).toBe("completed");
    expect(r.gmail?.outcome).toBe("connected");
    expect(fs.existsSync(path.join(tenantPaths(UID, root).secretsDir, "gmail.oauth.enc"))).toBe(true);
    expect(calls.find((c) => c.rpc === "engine_store_integration_secret")).toBeTruthy();
    expect(calls.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("succeeded");

    const { client: c2, calls: calls2 } = fakeClient(quotaOk, request);
    const refused = await runTenantJob({
      userId: UID, kind: "gmail_exchange", jobId: JOB, client: c2, config: withCreds,
      seams: { user: user(), tenantKey: KEY, gmailExchange: async () => { throw new Error("Gmail grant carries scopes outside readonly+compose (x) — drafts only; refusing."); } },
    });
    expect(refused.outcome).toBe("refused");
    expect(calls2.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("dead");
  });

  it("kinds that have no engine yet are refused as dead, without materializing anything", async () => {
    const { client, calls } = fakeClient(quotaOk);
    const r = await runTenantJob({ userId: UID, kind: "outreach", jobId: JOB, client, config, seams: { user: user(), tenantKey: KEY } });
    expect(r.outcome).toBe("unsupported_kind");
    expect(calls.find((c) => c.rpc === "complete_engine_job")!.args!["p_status"]).toBe("dead");
    expect(fs.existsSync(tenantPaths(UID, root).candidateDir)).toBe(false);
  });
});

describe("child env ceiling (UNIT_CONFIRMED)", () => {
  const paths = tenantPaths(UID, "C:/tmp/tenants");
  const base = { paths, email: "t@x.io", maxSubmits: 2, kind: "apply" as const, tenantsRoot: "C:/tmp/tenants" };

  it("a child never holds a gated flag the parent lacks, forced-offs stay off even when the parent has them, secrets are stripped", () => {
    const allOn: NodeJS.ProcessEnv = Object.fromEntries(GATED_FLAG_KEYS.map((k) => [k, "true"]));
    allOn["DRY_RUN"] = "false";
    allOn["PORTAL_LOGIN_PASSWORD"] = "pw";
    allOn["SUPABASE_ACCESS_TOKEN"] = "tok";
    allOn["SESSION_MODE_JOBRIGHT"] = "CDP_ATTACH";
    const child = composeTenantChildEnv({ ...base, env: allOn });
    expect(flagsAboveCeiling(allOn, child)).toEqual([]);
    expect(child["FORM_FILL_ENABLED"]).toBe("true");
    expect(child["SUBMIT_ENABLED"]).toBe("true");
    expect(child["DRY_RUN"]).toBe("false");
    for (const k of TENANT_FORCED_OFF) expect(child[k], k).toBe("false");
    expect(child).not.toHaveProperty("PORTAL_LOGIN_PASSWORD");
    expect(child).not.toHaveProperty("SUPABASE_ACCESS_TOKEN");
    expect(child).not.toHaveProperty("SESSION_MODE_JOBRIGHT");
    expect(child["MAX_UNATTENDED_SUBMISSIONS_PER_RUN"]).toBe("2");

    const none: NodeJS.ProcessEnv = {};
    const dark = composeTenantChildEnv({ ...base, env: none });
    for (const k of GATED_FLAG_KEYS) expect(dark[k], k).toBe("false");
    expect(dark["DRY_RUN"]).toBe("true");
    expect(dark["DEFAULT_RESUME_PATH"]).toBe(path.join(paths.candidateDir, "resumes", "default.pdf"));
  });
});

describe("run budget (UNIT_CONFIRMED)", () => {
  it("missing row ⇒ 0; remaining minus local completions the cloud has not seen; capped per run", () => {
    expect(computeRunBudget({ quota: { present: false, maxCompletedApplications: 0, completedApplications: 0, remaining: 0 }, localCompleted: 0 })).toEqual({ maxSubmits: 0, unmirrored: 0, reason: "quota_missing" });
    const q = { present: true, maxCompletedApplications: 5, completedApplications: 2, remaining: 3 };
    expect(computeRunBudget({ quota: q, localCompleted: 2, cap: 10 })).toEqual({ maxSubmits: 3, unmirrored: 0, reason: "ok" });
    expect(computeRunBudget({ quota: q, localCompleted: 4, cap: 10 })).toEqual({ maxSubmits: 1, unmirrored: 2, reason: "ok" });
    expect(computeRunBudget({ quota: q, localCompleted: 5, cap: 10 })).toEqual({ maxSubmits: 0, unmirrored: 3, reason: "quota_exhausted" });
    expect(computeRunBudget({ quota: q, localCompleted: 0 })).toEqual({ maxSubmits: 1, unmirrored: 0, reason: "ok" });
  });
});

describe("currentTenant (UNIT_CONFIRMED)", () => {
  it("null in the operator's own process; the manifest's eligibility in a tenant child", () => {
    expect(currentTenant({})).toBeNull();
    expect(currentTenant({ CANDIDATE_KEY_PROVIDER: "dpapi", TENANT_USER_ID: UID })).toBeNull();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-"));
    try {
      const p = tenantPaths(UID, root);
      fs.mkdirSync(p.root, { recursive: true });
      fs.writeFileSync(p.manifestPath, JSON.stringify({ email: "t@x.io", eligibility: { jobright_status: "connected", jobright_premium: true, gmail_status: "connected", outreach_eligible: true } }));
      const ctx = currentTenant({ CANDIDATE_KEY_PROVIDER: "tenant", TENANT_USER_ID: UID, TENANTS_ROOT: root })!;
      expect(ctx.userId).toBe(UID);
      expect(ctx.email).toBe("t@x.io");
      expect(ctx.eligibility?.outreach_eligible).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
