import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertCdpUrlAllowed, isLoopbackCdpUrl } from "../../src/auth/cdpPolicy.js";
import { browserbaseProvider, nullProvider, redactConnectUrl, resolveRemoteBrowserProvider } from "../../src/browser/remoteBrowser.js";
import { readEncryptedFile } from "../../src/candidate/sensitiveCrypto.js";
import { loadConfig } from "../../src/config/env.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { listOpenReviewItems, upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { createApplication, getApplication } from "../../src/queue/stateMachine.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";
import {
  assessPremiumText,
  captureHandoff,
  HANDOFF_MAX_ATTEMPTS,
  JOBRIGHT_STATE_SECRET,
  provisionHandoff,
  resolveJobrightAuthParks,
  type CaptureSession,
  type HandoffTaskRecord,
} from "../../src/tenants/capture.js";
import { deriveTenantKey } from "../../src/tenants/keys.js";
import { tenantPaths } from "../../src/tenants/paths.js";

/**
 * Plan M17 — the remote-browser handoff, engine side, with no browser and
 * no network: the CDP policy (loopback always, remote only behind the
 * flag), the Browserbase provider against a fake fetch (headers, shapes,
 * release, the key never echoed), provisioning and capture as state
 * transitions on the task row, the sealed storageState under the tenant
 * key, the premium probe's honesty, and the post-reconnect requeue through
 * the legal state edge. UNIT_CONFIRMED; the provider's live shapes stay
 * UNVERIFIED until the M16 spike runs with an account.
 */

const UID = "11111111-2222-4333-8444-555555555555";
const KEY = deriveTenantKey(Buffer.alloc(32, 3), UID);

describe("cdp policy (UNIT_CONFIRMED)", () => {
  it("loopback is always allowed; a remote endpoint needs REMOTE_BROWSER_ENABLED and is refused by name otherwise", () => {
    for (const u of ["http://127.0.0.1:9333", "http://localhost:9223", "ws://[::1]:9333/devtools", "http://127.0.0.1:9223/json"]) {
      expect(isLoopbackCdpUrl(u), u).toBe(true);
      expect(() => assertCdpUrlAllowed(u, false)).not.toThrow();
    }
    const remote = "wss://connect.browserbase.com?apiKey=bb_secret&sessionId=abc";
    expect(isLoopbackCdpUrl(remote)).toBe(false);
    expect(() => assertCdpUrlAllowed(remote, false)).toThrow(/REMOTE_BROWSER_ENABLED is false/);
    expect(() => assertCdpUrlAllowed(remote, false)).not.toThrow(/bb_secret/);
    expect(() => assertCdpUrlAllowed(remote, true)).not.toThrow();
    expect(() => assertCdpUrlAllowed("not a url", false)).toThrow(/non-loopback/);
  });
});

describe("browserbase provider (UNIT_CONFIRMED against a fake fetch; live shapes UNVERIFIED)", () => {
  type Req = { url: string; method: string; headers: Record<string, string>; body: unknown };
  function fakeFetch(responses: Record<string, { status: number; body: unknown }>) {
    const reqs: Req[] = [];
    const fetchImpl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      reqs.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : null });
      const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
      const r = responses[key] ?? { status: 404, body: { error: "no route " + key } };
      return { ok: r.status < 400, status: r.status, text: async () => JSON.stringify(r.body) };
    };
    return { fetchImpl, reqs };
  }

  it("creates a session with the key in a header, reads the live view, builds the connect URL, releases", async () => {
    const { fetchImpl, reqs } = fakeFetch({
      "POST /v1/sessions": { status: 201, body: { id: "sess_1", status: "RUNNING", connectUrl: "wss://connect.browserbase.com?apiKey=bb_k&sessionId=sess_1" } },
      "GET /v1/sessions/sess_1/debug": { status: 200, body: { debuggerFullscreenUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=x", debuggerUrl: "https://www.browserbase.com/devtools/inspector.html?wss=x" } },
      "POST /v1/sessions/sess_1": { status: 200, body: { id: "sess_1", status: "REQUEST_RELEASE" } },
    });
    const p = browserbaseProvider({ apiKey: "bb_k", projectId: "proj", fetch: fetchImpl, proxies: true });
    const s = await p.createSession({ userId: UID, keepAliveSeconds: 5 });
    expect(s).toEqual({
      provider: "browserbase",
      sessionId: "sess_1",
      connectUrl: "wss://connect.browserbase.com?apiKey=bb_k&sessionId=sess_1",
      liveViewUrl: "https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=x",
      expiresAt: null,
    });
    expect(reqs[0]!.headers["x-bb-api-key"]).toBe("bb_k");
    expect(reqs[0]!.body).toMatchObject({ projectId: "proj", timeout: 60, keepAlive: false, proxies: true, userMetadata: { dispatch_user: UID } });
    await p.endSession("sess_1");
    expect(reqs.at(-1)).toMatchObject({ method: "POST", body: { projectId: "proj", status: "REQUEST_RELEASE" } });
    expect(redactConnectUrl(s.connectUrl)).toBe("wss://connect.browserbase.com/…");
  });

  it("an HTTP failure names the status and the provider's text, never the key; a missing id is loud", async () => {
    const { fetchImpl } = fakeFetch({ "POST /v1/sessions": { status: 402, body: { message: "plan limit reached" } } });
    const p = browserbaseProvider({ apiKey: "bb_k", projectId: "proj", fetch: fetchImpl });
    await expect(p.createSession({ userId: UID })).rejects.toThrow(/HTTP 402: .*plan limit reached/);
    await expect(p.createSession({ userId: UID })).rejects.not.toThrow(/bb_k/);
    const { fetchImpl: noId } = fakeFetch({ "POST /v1/sessions": { status: 201, body: { status: "RUNNING" } } });
    await expect(browserbaseProvider({ apiKey: "k", projectId: "p", fetch: noId }).createSession({ userId: UID })).rejects.toThrow(/no id/);
  });

  it("with the flag off the resolved provider refuses by name", async () => {
    const off = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite" });
    const p = resolveRemoteBrowserProvider(off);
    expect(p).toBe(nullProvider);
    await expect(p.createSession({ userId: UID })).rejects.toThrow(/REMOTE_BROWSER_ENABLED is false/);
    const on = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", REMOTE_BROWSER_ENABLED: "true", BROWSERBASE_API_KEY: "k", BROWSERBASE_PROJECT_ID: "p" });
    expect(resolveRemoteBrowserProvider(on).name).toBe("browserbase");
  });
});

type Update = { table: string; patch: Record<string, unknown>; id: string };
function fakeHandoffClient() {
  const updates: Update[] = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client = {
    from: (table: string) => ({
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ table, patch, id });
          return { error: null };
        },
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return { data: null, error: null };
    },
  };
  return { client, updates, rpcs };
}

const task = (over: Partial<HandoffTaskRecord> = {}): HandoffTaskRecord => ({
  id: "task-1", user_id: UID, kind: "jobright_connect", status: "requested", attempts: 0, provider_session_id: null, expires_at: null, ...over,
});

describe("provisionHandoff (UNIT_CONFIRMED)", () => {
  it("requested → provisioning → live with the live view, the provider handle and a 15-minute expiry; provider failure ⇒ failed with the reason", async () => {
    const { client, updates } = fakeHandoffClient();
    const provider = {
      name: "fake",
      createSession: async () => ({ provider: "fake", sessionId: "s1", connectUrl: "wss://x?apiKey=k", liveViewUrl: "https://live/x", expiresAt: null }),
      liveViewUrl: async () => "https://live/x",
      connectUrl: (id: string) => `wss://x?apiKey=k&sessionId=${id}`,
      endSession: async () => undefined,
    };
    const now = new Date("2026-09-14T05:00:00Z");
    const r = await provisionHandoff({ client, provider, task: task(), now: () => now });
    expect(r).toEqual({ status: "live", liveViewUrl: "https://live/x", providerSessionId: "s1", expiresAt: "2026-09-14T05:15:00.000Z", reason: null });
    expect(updates.map((u) => u.patch["status"])).toEqual(["provisioning", "live"]);
    const live = updates[1]!.patch;
    expect(live).toMatchObject({ live_view_url: "https://live/x", provider_session_id: "s1", expires_at: "2026-09-14T05:15:00.000Z" });
    expect(JSON.stringify(updates)).not.toContain("apiKey"); // the connect URL never reaches a row

    const { client: c2, updates: u2 } = fakeHandoffClient();
    const broken = { ...provider, createSession: async () => { throw new Error("HTTP 402: plan limit"); } };
    const f = await provisionHandoff({ client: c2, provider: broken, task: task() });
    expect(f.status).toBe("failed");
    expect(u2.at(-1)!.patch).toMatchObject({ status: "failed", reason: expect.stringMatching(/remote browser unavailable: HTTP 402/) });
  });
});

describe("captureHandoff (UNIT_CONFIRMED)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-capture-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function fakeSession(input: { ok: boolean; state?: unknown; log: string[] }): CaptureSession {
    return {
      open: async () => { input.log.push("open"); },
      validate: async () => ({ ok: input.ok, status: input.ok ? "AUTHENTICATED" : "UNAUTHENTICATED", url: "https://jobright.ai/jobs/recommend", reason: input.ok ? "app shell" : "Login surface text", checkedAt: "2026-09-14T05:01:00.000Z" }),
      getContext: () => ({ storageState: async () => input.state ?? { cookies: [{ name: "sid", value: "v" }], origins: [] } }),
      newPage: async () => ({ goto: async () => undefined, locator: () => ({ count: async () => 0 }), close: async () => undefined }),
      close: async () => { input.log.push("close"); },
    };
  }
  const released: string[] = [];
  const provider = {
    name: "fake",
    createSession: async () => { throw new Error("not used"); },
    liveViewUrl: async () => "x",
    connectUrl: (id: string) => `wss://c?sessionId=${id}`,
    endSession: async (id: string) => { released.push(id); },
  };

  it("signed in ⇒ storageState sealed under the tenant key, task completed, integration connected (premium promoted only on evidence), session released", async () => {
    const paths = tenantPaths(UID, root);
    const { client, updates, rpcs } = fakeHandoffClient();
    const log: string[] = [];
    const seenUrls: string[] = [];
    const r = await captureHandoff({
      client, provider, task: task({ status: "user_done", provider_session_id: "s1" }), paths, tenantKey: KEY,
      connectUrl: "wss://connect?apiKey=k&sessionId=s1",
      openSession: (url) => { seenUrls.push(url); return fakeSession({ ok: true, log }); },
      probeText: async () => "Welcome back — Turbo member since May",
    });
    expect(r.status).toBe("completed");
    expect(r.premium).toBe("present");
    expect(seenUrls).toEqual(["wss://connect?apiKey=k&sessionId=s1"]);
    expect(log).toEqual(["open", "close"]);
    expect(released).toContain("s1");
    const sealed = readEncryptedFile<{ cookies: Array<{ name: string }> }>(r.sealedPath!, KEY);
    expect(sealed.cookies[0]!.name).toBe("sid");
    expect(r.sealedPath).toBe(path.join(paths.secretsDir, `${JOBRIGHT_STATE_SECRET}.enc`));
    expect(fs.readFileSync(r.sealedPath!, "utf8")).not.toContain("sid");
    expect(updates.map((u) => u.patch["status"])).toEqual(["verifying", "completed"]);
    expect(updates.at(-1)!.patch).toMatchObject({ live_view_url: null, provider_session_id: null, result: { premium: "present" } });
    expect(rpcs).toEqual([{ fn: "engine_set_integration_status", args: { p_user: UID, p_provider: "jobright", p_status: "connected", p_meta: { premium: true } } }]);
    expect(JSON.stringify(updates)).not.toContain("apiKey");
  });

  it("not signed in ⇒ reopened with the reason while attempts remain, failed at the cap; a malformed state never seals", async () => {
    const paths = tenantPaths(UID, root);
    const { client, updates, rpcs } = fakeHandoffClient();
    const r = await captureHandoff({
      client, provider, task: task({ status: "user_done", provider_session_id: "s2" }), paths, tenantKey: KEY,
      connectUrl: "wss://c", openSession: () => fakeSession({ ok: false, log: [] }),
    });
    expect(r.status).toBe("open");
    expect(r.attempts).toBe(1);
    expect(updates.at(-1)!.patch).toMatchObject({ status: "open", reason: expect.stringMatching(/did not look signed in/), result: { attempts: 1 } });
    expect(rpcs).toEqual([]);
    expect(fs.existsSync(path.join(paths.secretsDir, `${JOBRIGHT_STATE_SECRET}.enc`))).toBe(false);

    const { client: c2, updates: u2 } = fakeHandoffClient();
    const capped = await captureHandoff({
      client: c2, provider, task: task({ status: "user_done", attempts: HANDOFF_MAX_ATTEMPTS - 1 }), paths, tenantKey: KEY,
      connectUrl: "wss://c", openSession: () => fakeSession({ ok: false, log: [] }),
    });
    expect(capped.status).toBe("failed");
    expect(u2.at(-1)!.patch["status"]).toBe("failed");

    const { client: c3 } = fakeHandoffClient();
    const bad = await captureHandoff({
      client: c3, provider, task: task({ status: "user_done" }), paths, tenantKey: KEY,
      connectUrl: "wss://c", openSession: () => fakeSession({ ok: true, state: { nope: true }, log: [] }),
    });
    expect(bad.status).toBe("open");
    expect(bad.reason).toMatch(/capture failed: captured storageState is not a Playwright state/);
    expect(fs.existsSync(path.join(paths.secretsDir, `${JOBRIGHT_STATE_SECRET}.enc`))).toBe(false);
  });
});

describe("premium probe text (UNIT_CONFIRMED)", () => {
  it("present only on a member signal, absent only on an upgrade prompt, unknown otherwise", () => {
    expect(assessPremiumText("Turbo member · settings")).toBe("present");
    expect(assessPremiumText("Upgrade to Turbo for unlimited matches")).toBe("absent");
    expect(assessPremiumText("Recommended jobs for you")).toBe("unknown");
    expect(assessPremiumText("")).toBe("unknown");
  });
});

describe("resolveJobrightAuthParks (UNIT_CONFIRMED)", () => {
  it("resolves only JobRight AUTH_REQUIRED reviews and requeues parked applications through the legal edge", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-parks-"));
    const db = openDatabase(path.join(dir, "app.sqlite"));
    try {
      migrate(db);
      const job1 = upsertJobByFingerprint(db, { company: "Acme", role: "SWE Intern", applicationUrl: "https://jobs.ashbyhq.com/acme/1" });
      const job2 = upsertJobByFingerprint(db, { company: "Beta", role: "Data Intern", applicationUrl: "https://jobs.lever.co/beta/2" });
      const parked = createApplication(db, { jobId: job1.id, state: "AUTH_REQUIRED" });
      const queued = createApplication(db, { jobId: job2.id, state: "QUEUED" });
      upsertOpenReviewItem(db, { kind: "AUTH_REQUIRED", title: "jobright authentication required", payload: { service: "jobright" } });
      upsertOpenReviewItem(db, { kind: "AUTH_REQUIRED", title: "Sign in required at Workday", payload: { service: "ats", url: "https://acme.wd5.myworkdayjobs.com" } });
      const r = resolveJobrightAuthParks(db);
      expect(r).toEqual({ resolved: 1, requeued: 1 });
      expect(getApplication(db, parked.id)!.state).toBe("APPLICATION_OPENING");
      expect(getApplication(db, queued.id)!.state).toBe("QUEUED");
      const open = listOpenReviewItems(db);
      expect(open).toHaveLength(1);
      expect(open[0]!.title).toMatch(/Workday/);
    } finally {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
