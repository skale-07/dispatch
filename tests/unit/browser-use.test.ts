import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_USE_DEFAULT_MODEL,
  BrowserUseAmbiguousCreateError,
  BrowserUseError,
  isAmbiguousCreateFailure,
  parseUsd,
  type BrowserSession,
  type BrowserUseApi,
  type RunSummary,
} from "../../src/browser/browserUse/api.js";
import { fileLedger, memoryLedger, readLedgerRunIds } from "../../src/browser/browserUse/ledger.js";
import { browserTimeoutMinutes, browserUseProvider, isEngineBrowser } from "../../src/browser/browserUse/provider.js";
import { extractJson, resolveRunRequest, startRun, sweepAbandoned, validateRunResult, waitForRun } from "../../src/browser/browserUse/runs.js";
import { browserUseRunPolicy, resolveBrowserUseApi } from "../../src/browser/browserUse/index.js";
import { nullProvider, resolveRemoteBrowserProvider } from "../../src/browser/remoteBrowser.js";
import { loadConfig } from "../../src/config/env.js";
import { scanTextForSecrets } from "../../src/security/artifactScan.js";
import { TENANT_STRIPPED_KEYS } from "../../src/tenants/childEnv.js";
import { CONTROLLED_FILL_ENV_KEYS } from "../helpers/fillEnvIsolation.js";

/**
 * Browser Use Cloud integration with NO key and NO network: the flags
 * (fail-closed, documented everywhere the house rules demand), the
 * managed-browser provider against a fake API, hosted runs (cap, model,
 * one create, ambiguous never re-sent, capped wait that cancels,
 * deterministic result validation) and the bounded sweep. UNIT_CONFIRMED;
 * live shapes are UNVERIFIED until a guarded run spends real credit.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const BASE: NodeJS.ProcessEnv = { NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite" };
const UID = "11111111-2222-4333-8444-555555555555";
const FAKE_KEY = "bu_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0000";

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run_1",
    status: "completed",
    task: "find the top HN post",
    model: BROWSER_USE_DEFAULT_MODEL,
    result: '{"title":"Show HN","points":42}',
    error: null,
    sessionId: "sess_1",
    totalCostUsd: "0.1234",
    totalInputTokens: 10,
    totalOutputTokens: 5,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:01:00.000Z",
    ...over,
  };
}

function browser(over: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: "br_1",
    status: "active",
    liveUrl: "https://live.browser-use.com/x",
    cdpUrl: "wss://cdp.browser-use.com/x?token=SECRET",
    timeoutAt: "2026-09-15T10:20:00.000Z",
    startedAt: "2026-09-15T10:00:00.000Z",
    finishedAt: null,
    metadata: { origin: "jobright-agent", dispatch_user: UID },
    agentSessionId: null,
    browserCost: "0.0067",
    proxyCost: "0",
    ...over,
  };
}

type Call = { op: string; args: unknown[] };
function fakeApi(over: Partial<BrowserUseApi> = {}): BrowserUseApi & { calls: Call[] } {
  const calls: Call[] = [];
  const rec = <T>(op: string, impl: (...a: never[]) => Promise<T>) =>
    (async (...args: unknown[]) => {
      calls.push({ op, args });
      return impl(...(args as never[]));
    }) as never;
  const api: BrowserUseApi & { calls: Call[] } = {
    calls,
    createRun: rec("createRun", async () => ({ id: "run_1", status: "queued" as const, sessionId: "sess_1", model: BROWSER_USE_DEFAULT_MODEL })),
    runStatus: rec("runStatus", async () => "completed" as const),
    getRun: rec("getRun", async () => run()),
    cancelRun: rec("cancelRun", async () => run({ status: "cancelled", result: null })),
    listRuns: rec("listRuns", async () => ({ runs: [], nextCursor: null })),
    createBrowser: rec("createBrowser", async () => browser()),
    getBrowser: rec("getBrowser", async () => browser()),
    stopBrowser: rec("stopBrowser", async () => browser({ status: "stopped", finishedAt: "2026-09-15T10:05:00.000Z" })),
    listBrowsers: rec("listBrowsers", async () => ({ items: [], totalItems: 0 })),
    createProfile: rec("createProfile", async () => ({ id: "prof_1" })),
    ...over,
  };
  // Re-wrap overrides so they are recorded too.
  for (const [k, v] of Object.entries(over)) (api as unknown as Record<string, unknown>)[k] = rec(k, v as never);
  return api;
}

describe("browser use flags (UNIT_CONFIRMED)", () => {
  it("default off; the settings default to the documented values", () => {
    const c = loadConfig(BASE);
    expect(c.browserUseEnabled).toBe(false);
    expect(c.browserUseAgentEnabled).toBe(false);
    expect(c.browserUseApiKey).toBeUndefined();
    expect(c.browserUseModel).toBe("gpt-5.6-luna");
    expect(c.browserUseMaxCostUsd).toBe(1);
    expect(c.browserUseBrowserTimeoutMin).toBe(20);
    expect(c.remoteBrowserProvider).toBe("browserbase");
  });

  it("BROWSER_USE_ENABLED=true refuses to boot without the key (blank counts as missing); the cap cannot exceed $1", () => {
    expect(() => loadConfig({ ...BASE, BROWSER_USE_ENABLED: "true" })).toThrow(/BROWSER_USE_ENABLED=true requires BROWSER_USE_API_KEY/);
    expect(() => loadConfig({ ...BASE, BROWSER_USE_ENABLED: "true", BROWSER_USE_API_KEY: "   " })).toThrow(/requires BROWSER_USE_API_KEY/);
    const ok = loadConfig({ ...BASE, BROWSER_USE_ENABLED: "true", BROWSER_USE_API_KEY: FAKE_KEY, BROWSER_USE_MAX_COST_USD: "0.5" });
    expect(ok.browserUseEnabled).toBe(true);
    expect(ok.browserUseMaxCostUsd).toBe(0.5);
    expect(() => loadConfig({ ...BASE, BROWSER_USE_MAX_COST_USD: "2" })).toThrow();
    expect(() => loadConfig({ ...BASE, BROWSER_USE_MAX_COST_USD: "0" })).toThrow();
    expect(() => loadConfig({ ...BASE, BROWSER_USE_BROWSER_TIMEOUT_MIN: "241" })).toThrow();
  });

  it("REMOTE_BROWSER_PROVIDER=browser_use needs the Browser Use flag + key; browserbase keeps its own check", () => {
    expect(() => loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true", REMOTE_BROWSER_PROVIDER: "browser_use" })).toThrow(
      /REMOTE_BROWSER_PROVIDER=browser_use requires BROWSER_USE_ENABLED, BROWSER_USE_API_KEY/,
    );
    expect(() => loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true" })).toThrow(/requires BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID/);
    const ok = loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true", REMOTE_BROWSER_PROVIDER: "browser_use", BROWSER_USE_ENABLED: "true", BROWSER_USE_API_KEY: FAKE_KEY });
    expect(ok.remoteBrowserProvider).toBe("browser_use");
    expect(() => loadConfig({ ...BASE, REMOTE_BROWSER_PROVIDER: "other" })).toThrow();
  });

  it("both flags are in the env-isolation set, the child strip list, the house-rules list, .env.example, the graph and the operator guide", () => {
    for (const flag of ["BROWSER_USE_ENABLED", "BROWSER_USE_AGENT_ENABLED"] as const) {
      expect(CONTROLLED_FILL_ENV_KEYS).toContain(flag);
      expect(TENANT_STRIPPED_KEYS).toContain(flag);
      for (const file of ["CLAUDE.md", ".cursor/rules/house-rules.mdc", ".env.example", "docs/knowledge-graph/graph.json", "docs/operator-guide.md"]) {
        expect(fs.readFileSync(path.join(ROOT, file), "utf8"), `${flag} in ${file}`).toContain(flag);
      }
      expect(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")).toMatch(new RegExp(`^${flag}=false`, "m"));
    }
    expect(TENANT_STRIPPED_KEYS).toContain("BROWSER_USE_API_KEY");
    // The two house-rules files stay identical in their flag list.
    const flags = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8").match(/`[A-Z_]+_ENABLED`/g) ?? [];
    expect(flags("CLAUDE.md")).toEqual(flags(".cursor/rules/house-rules.mdc"));
  });

  it("the secret scanner recognises a Browser Use key", () => {
    expect(scanTextForSecrets(`token ${FAKE_KEY}`)).toContain("browser_use_key");
    expect(scanTextForSecrets("bu_short")).not.toContain("browser_use_key");
  });

  it("resolveBrowserUseApi and the run policy refuse by name with the flags off", () => {
    expect(() => resolveBrowserUseApi(loadConfig(BASE))).toThrow(/BROWSER_USE_ENABLED is false/);
    const policy = browserUseRunPolicy(loadConfig({ ...BASE, BROWSER_USE_ENABLED: "true", BROWSER_USE_API_KEY: FAKE_KEY, BROWSER_USE_AGENT_ENABLED: "true" }));
    expect(policy).toEqual({ agentEnabled: true, model: "gpt-5.6-luna", maxCostUsd: 1 });
    // Agent flag without the base flag is inert.
    expect(browserUseRunPolicy(loadConfig({ ...BASE, BROWSER_USE_AGENT_ENABLED: "true" })).agentEnabled).toBe(false);
  });

  it("resolveRemoteBrowserProvider picks Browser Use only behind both flags", () => {
    expect(resolveRemoteBrowserProvider(loadConfig({ ...BASE, REMOTE_BROWSER_PROVIDER: "browser_use" }))).toBe(nullProvider);
    const on = loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true", REMOTE_BROWSER_PROVIDER: "browser_use", BROWSER_USE_ENABLED: "true", BROWSER_USE_API_KEY: FAKE_KEY });
    expect(resolveRemoteBrowserProvider(on).name).toBe("browser_use");
    // A fetch override cannot reach the SDK, so it is refused rather than half-applied.
    expect(() => resolveRemoteBrowserProvider(on, async () => ({ ok: true, status: 200, text: async () => "{}" }))).toThrow(/no fetch override/);
    const bb = loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true", BROWSERBASE_API_KEY: "k", BROWSERBASE_PROJECT_ID: "p" });
    expect(resolveRemoteBrowserProvider(bb).name).toBe("browserbase");
  });
});

describe("managed-browser provider (UNIT_CONFIRMED against a fake API)", () => {
  it("creates a labelled browser with CAPTCHA solving OFF, hands back live + cdp, stops on end, ledgers both", async () => {
    const api = fakeApi();
    const ledger = memoryLedger(() => new Date("2026-09-15T10:00:00Z"));
    const p = browserUseProvider(api, { defaultTimeoutMinutes: 20, ledger });
    const s = await p.createSession({ userId: UID, keepAliveSeconds: 5 * 60 });
    expect(s).toEqual({
      provider: "browser_use",
      sessionId: "br_1",
      connectUrl: "wss://cdp.browser-use.com/x?token=SECRET",
      liveViewUrl: "https://live.browser-use.com/x",
      expiresAt: "2026-09-15T10:20:00.000Z",
    });
    expect(api.calls[0]).toMatchObject({ op: "createBrowser", args: [{ timeout: 5, solveCaptchas: false, profileId: null, metadata: { origin: "jobright-agent", dispatch_user: UID } }] });
    // An attach always checks the browser is still alive first (one cheap GET).
    expect(await p.connectUrl("br_1")).toBe(s.connectUrl);
    expect(api.calls.filter((c) => c.op === "getBrowser")).toHaveLength(1);
    await p.endSession("br_1");
    expect(api.calls.at(-1)).toMatchObject({ op: "stopBrowser", args: ["br_1"] });
    expect(ledger.entries.map((e) => e.action)).toEqual(["created", "stopped"]);
    expect(ledger.entries[0]).toMatchObject({ kind: "browser", id: "br_1", user_id: UID, timeout_min: 5, profile_id: null });
    expect(ledger.entries[1]).toMatchObject({ kind: "browser", id: "br_1", status: "stopped", browser_cost: "0.0067" });
    expect(JSON.stringify(ledger.entries)).not.toContain("SECRET"); // never the cdpUrl
  });

  it("a profile is the persisted context; a session on it passes profileId", async () => {
    const api = fakeApi();
    const p = browserUseProvider(api);
    expect(await p.createContext!({ userId: UID })).toBe("prof_1");
    expect(api.calls[0]).toMatchObject({ op: "createProfile", args: [{ userId: UID, name: `dispatch:${UID}` }] });
    await p.createSession({ userId: UID, contextId: "prof_1" });
    expect(api.calls[1]).toMatchObject({ op: "createBrowser", args: [{ profileId: "prof_1", timeout: 20 }] });
  });

  it("an unusable browser (no cdpUrl) is stopped before the error; a cold connectUrl reads back and refuses a stopped one", async () => {
    const api = fakeApi({ createBrowser: async () => browser({ cdpUrl: null }) });
    const ledger = memoryLedger();
    await expect(browserUseProvider(api, { ledger }).createSession({ userId: UID })).rejects.toThrow(/no cdpUrl; stopped it/);
    expect(api.calls.map((c) => c.op)).toEqual(["createBrowser", "stopBrowser"]);
    expect(ledger.entries.map((e) => e.action)).toEqual(["created", "stopped_unusable"]);

    const cold = browserUseProvider(fakeApi());
    expect(await cold.connectUrl("br_1")).toBe("wss://cdp.browser-use.com/x?token=SECRET");
    const stopped = browserUseProvider(fakeApi({ getBrowser: async () => browser({ status: "stopped", cdpUrl: null }) }));
    await expect(stopped.connectUrl("br_1")).rejects.toThrow(/is stopped/);
    await expect(stopped.liveViewUrl("br_1")).rejects.toThrow(/is stopped/);

    // A live browser whose read-back omits cdpUrl still attaches through the value this process was given at create.
    let reads = 0;
    const partial = fakeApi({ getBrowser: async () => { reads += 1; return browser({ cdpUrl: null }); } });
    const p = browserUseProvider(partial);
    await p.createSession({ userId: UID });
    expect(await p.connectUrl("br_1")).toBe("wss://cdp.browser-use.com/x?token=SECRET");
    expect(reads).toBe(1);
    await expect(browserUseProvider(partial).connectUrl("br_1")).rejects.toThrow(/has no CDP URL/);
  });

  it("an ambiguous create (transport / 5xx) is typed, ledgered and not retried; a 4xx passes through", async () => {
    const net = fakeApi({ createBrowser: async () => { throw new Error("fetch failed"); } });
    const ledger = memoryLedger();
    await expect(browserUseProvider(net, { ledger }).createSession({ userId: UID })).rejects.toBeInstanceOf(BrowserUseAmbiguousCreateError);
    expect(net.calls.filter((c) => c.op === "createBrowser")).toHaveLength(1);
    expect(ledger.entries).toEqual([expect.objectContaining({ kind: "browser", id: "?", action: "create_ambiguous", user_id: UID, error: "fetch failed" })]);
    const refused = fakeApi({ createBrowser: async () => { throw new BrowserUseError(402, "Insufficient credits"); } });
    await expect(browserUseProvider(refused).createSession({ userId: UID })).rejects.toThrow(/Insufficient credits/);
    await expect(browserUseProvider(refused).createSession({ userId: UID })).rejects.not.toBeInstanceOf(BrowserUseAmbiguousCreateError);
  });

  it("timeout minutes are bounded by the provider cap; engine browsers are told apart by the origin label", () => {
    expect(browserTimeoutMinutes(undefined, 20)).toBe(20);
    expect(browserTimeoutMinutes(90, 20)).toBe(2);
    expect(browserTimeoutMinutes(10, 20)).toBe(1);
    expect(browserTimeoutMinutes(999_999, 20)).toBe(240);
    expect(isEngineBrowser({ origin: "jobright-agent" })).toBe(true);
    expect(isEngineBrowser({ origin: "someone-else" })).toBe(false);
    expect(isEngineBrowser({})).toBe(false);
  });
});

describe("hosted runs (UNIT_CONFIRMED against a fake API)", () => {
  const policy = { agentEnabled: true, model: BROWSER_USE_DEFAULT_MODEL, maxCostUsd: 1 };

  it("resolveRunRequest: defaults to gpt-5.6-luna and the $1 cap; refuses over-cap, unknown model, empty task", () => {
    expect(resolveRunRequest({ task: " find x " }, policy)).toEqual({ task: "find x", model: "gpt-5.6-luna", maxCostUsd: 1 });
    expect(resolveRunRequest({ task: "t", maxCostUsd: 0.25, model: "claude-sonnet-5", proxy: false, sessionId: "s" }, policy)).toEqual({
      task: "t", model: "claude-sonnet-5", maxCostUsd: 0.25, sessionId: "s", browserSettings: { proxyCountryCode: null },
    });
    expect(() => resolveRunRequest({ task: "t", maxCostUsd: 1.5 }, policy)).toThrow(/exceeds BROWSER_USE_MAX_COST_USD=1/);
    expect(() => resolveRunRequest({ task: "t", maxCostUsd: 0.8 }, { ...policy, maxCostUsd: 0.5 })).toThrow(/exceeds BROWSER_USE_MAX_COST_USD=0.5/);
    expect(() => resolveRunRequest({ task: "t", model: "gpt-9" }, policy)).toThrow(/not in the v4 model list/);
    expect(() => resolveRunRequest({ task: "  " }, policy)).toThrow(/empty task/);
    expect(() => resolveRunRequest({ task: "t", maxCostUsd: 0 }, policy)).toThrow(/positive/);
  });

  it("startRun: refused by name without the agent flag; exactly one create; ambiguous typed, 4xx plain", async () => {
    const api = fakeApi();
    await expect(startRun(api, { task: "t" }, { ...policy, agentEnabled: false })).rejects.toThrow(/BROWSER_USE_AGENT_ENABLED is false/);
    expect(api.calls).toEqual([]);

    const ledger = memoryLedger(() => new Date("2026-09-15T10:00:00Z"));
    const created = await startRun(api, { task: "t", maxCostUsd: 0.5 }, policy, ledger);
    expect(created.id).toBe("run_1");
    expect(api.calls).toEqual([{ op: "createRun", args: [{ task: "t", model: "gpt-5.6-luna", maxCostUsd: 0.5 }] }]);
    expect(ledger.entries).toEqual([{ at: "2026-09-15T10:00:00.000Z", kind: "run", id: "run_1", action: "created", model: "gpt-5.6-luna", max_cost_usd: 0.5, session_id: "sess_1" }]);

    const timeout = fakeApi({ createRun: async () => { throw new Error("The operation was aborted"); } });
    const ambiguous = memoryLedger();
    await expect(startRun(timeout, { task: "t" }, policy, ambiguous)).rejects.toThrow(/outcome unknown.*Not retried.*browseruse -- runs/);
    expect(timeout.calls.filter((c) => c.op === "createRun")).toHaveLength(1);
    expect(ambiguous.entries).toEqual([expect.objectContaining({ kind: "run", id: "?", action: "create_ambiguous", model: "gpt-5.6-luna", max_cost_usd: 1, error: "The operation was aborted" })]);
    const five = fakeApi({ createRun: async () => { throw new BrowserUseError(502, "bad gateway"); } });
    await expect(startRun(five, { task: "t" }, policy)).rejects.toBeInstanceOf(BrowserUseAmbiguousCreateError);
    const four = fakeApi({ createRun: async () => { throw new BrowserUseError(422, "model not allowed"); } });
    await expect(startRun(four, { task: "t" }, policy)).rejects.toThrow(/model not allowed/);
    expect(isAmbiguousCreateFailure(new BrowserUseError(429, "slow down"))).toBe(false);
  });

  it("waitForRun polls the cheap status until terminal, then fetches the summary once", async () => {
    const statuses = ["queued", "running", "running", "completed"] as const;
    let i = 0;
    const api = fakeApi({ runStatus: async () => statuses[Math.min(i++, statuses.length - 1)]! });
    const slept: number[] = [];
    const r = await waitForRun(api, "run_1", { intervalMs: 7, sleep: async (ms) => { slept.push(ms); } });
    expect(r.timedOut).toBe(false);
    expect(r.stoppedBy).toBe("terminal");
    expect(r.lastError).toBeNull();
    expect(r.polls).toBe(4);
    expect(slept).toEqual([7, 7, 7]);
    expect(api.calls.filter((c) => c.op === "getRun")).toHaveLength(1);
    expect(api.calls.filter((c) => c.op === "cancelRun")).toHaveLength(0);
    expect(r.summary.status).toBe("completed");
  });

  it("a wait that runs out of time CANCELS the run (so it stops billing); the poll count is capped too", async () => {
    let t = 0;
    const api = fakeApi({ runStatus: async () => "running" as const });
    const ledger = memoryLedger();
    const r = await waitForRun(api, "run_1", { timeoutMs: 100, intervalMs: 50, now: () => (t += 60), sleep: async () => {} }, ledger);
    expect(r.timedOut).toBe(true);
    expect(r.stoppedBy).toBe("deadline");
    expect(r.summary.status).toBe("cancelled");
    expect(api.calls.filter((c) => c.op === "cancelRun")).toHaveLength(1);
    expect(ledger.entries.at(-1)).toMatchObject({ action: "cancelled_after_wait", status: "cancelled", stopped_by: "deadline" });

    const capped = fakeApi({ runStatus: async () => "running" as const });
    const r2 = await waitForRun(capped, "run_1", { maxPolls: 3, timeoutMs: 1e9, sleep: async () => {}, cancelOnTimeout: false });
    expect(r2.polls).toBe(3);
    expect(r2.timedOut).toBe(true);
    expect(r2.stoppedBy).toBe("poll_cap");
    expect(capped.calls.filter((c) => c.op === "cancelRun")).toHaveLength(0);
    expect(capped.calls.filter((c) => c.op === "getRun")).toHaveLength(1);

    // The default poll cap follows the timeout (never silently shorter than it): 10 s at 2 s ⇒ 6 polls.
    const derived = fakeApi({ runStatus: async () => "running" as const });
    const r3 = await waitForRun(derived, "run_1", { timeoutMs: 10_000, intervalMs: 2_000, now: () => 0, sleep: async () => {} });
    expect(r3.polls).toBe(6);
    expect(r3.stoppedBy).toBe("poll_cap");
  });

  it("poll failures never leave a billing run behind: after the error budget the run is cancelled; a failed cancel still reads the real state", async () => {
    const flaky = fakeApi({ runStatus: async () => { throw new BrowserUseError(502, "bad gateway"); } });
    const ledger = memoryLedger();
    const r = await waitForRun(flaky, "run_1", { sleep: async () => {}, now: () => 0 }, ledger);
    expect(r.timedOut).toBe(true);
    expect(r.stoppedBy).toBe("poll_errors");
    expect(r.lastError).toBe("bad gateway");
    expect(r.polls).toBe(3);
    expect(flaky.calls.filter((c) => c.op === "cancelRun")).toHaveLength(1);
    expect(r.summary.status).toBe("cancelled");

    // A transient failure is forgiven when the next poll succeeds.
    let n = 0;
    const once = fakeApi({ runStatus: async () => { n += 1; if (n === 1) throw new Error("blip"); return "completed" as const; } });
    const ok = await waitForRun(once, "run_1", { sleep: async () => {}, now: () => 0 });
    expect(ok.stoppedBy).toBe("terminal");
    expect(once.calls.filter((c) => c.op === "cancelRun")).toHaveLength(0);

    const cancelFails = fakeApi({
      runStatus: async () => "running" as const,
      cancelRun: async () => { throw new BrowserUseError(409, "already terminal"); },
      getRun: async () => run({ status: "failed", error: "provider error", result: null }),
    });
    const l2 = memoryLedger();
    const r2 = await waitForRun(cancelFails, "run_1", { maxPolls: 1, sleep: async () => {}, now: () => 0 }, l2);
    expect(r2.summary.status).toBe("failed");
    expect(r2.lastError).toBe("already terminal");
    expect(l2.entries.map((e) => e.action)).toEqual(["cancelled_after_wait_cancel_failed", "cancelled_after_wait"]);
  });

  it("validateRunResult: completed + non-empty + within cap (+ schema) is ok; each failure names itself", () => {
    const schema = { safeParse: (v: unknown) => (v && typeof v === "object" && "title" in v ? { success: true as const, data: v as { title: string } } : { success: false as const, error: { message: "no title" } }) };
    const ok = validateRunResult(run(), { maxCostUsd: 1, schema });
    expect(ok).toEqual({ ok: true, status: "completed", reasons: [], costUsd: 0.1234, overCap: false, output: { title: "Show HN", points: 42 } });
    expect(validateRunResult(run(), { maxCostUsd: 1 }).output).toBe('{"title":"Show HN","points":42}');

    expect(validateRunResult(run({ status: "failed", error: "boom", result: null }), { maxCostUsd: 1 }).reasons).toEqual(["run failed: boom"]);
    expect(validateRunResult(run({ status: "cancelled", result: null }), { maxCostUsd: 1 }).reasons).toEqual(["run cancelled"]);
    expect(validateRunResult(run({ result: "  " }), { maxCostUsd: 1 }).reasons).toEqual(["run completed with an empty result"]);
    const over = validateRunResult(run({ totalCostUsd: "1.25" }), { maxCostUsd: 1 });
    expect(over.overCap).toBe(true);
    expect(over.reasons).toEqual(["totalCostUsd 1.25 exceeds the run cap 1"]);
    expect(validateRunResult(run({ result: "no json here" }), { maxCostUsd: 1, schema }).reasons).toEqual(["result is not JSON"]);
    expect(validateRunResult(run({ result: '{"points":1}' }), { maxCostUsd: 1, schema }).reasons).toEqual(["result does not match the schema: no title"]);
    // An unparseable cost is unknown, never zero.
    expect(validateRunResult(run({ totalCostUsd: "" }), { maxCostUsd: 1 }).costUsd).toBeNull();
    expect(parseUsd("abc")).toBeNull();
    expect(parseUsd(0.5)).toBe(0.5);
  });

  it("extractJson finds the JSON an agent wrapped in prose or a fence", () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({ a: 1 });
    expect(extractJson('The answer is {"a":[1,2]} as requested')).toEqual({ a: [1, 2] });
    expect(extractJson("[1,2,3]")).toEqual([1, 2, 3]);
    expect(extractJson("nothing structured")).toBeNull();
  });

  it("sweepAbandoned cancels old non-terminal runs THIS engine created and stops old ENGINE browsers only; dry-run acts on nothing; actions are capped", async () => {
    const now = () => new Date("2026-09-15T11:00:00Z");
    const oldRun = run({ id: "old_running", status: "running", createdAt: "2026-09-15T09:00:00Z", result: null });
    const foreignRun = run({ id: "dashboard_running", status: "running", createdAt: "2026-09-15T08:00:00Z", result: null });
    const youngRun = run({ id: "young_running", status: "running", createdAt: "2026-09-15T10:55:00Z", result: null });
    const doneRun = run({ id: "old_done", status: "completed", createdAt: "2026-09-15T08:00:00Z" });
    const ours = browser({ id: "ours_old", startedAt: "2026-09-15T09:00:00Z" });
    const oursYoung = browser({ id: "ours_young", startedAt: "2026-09-15T10:58:00Z" });
    const foreign = browser({ id: "foreign_old", startedAt: "2026-09-15T01:00:00Z", metadata: {} });
    const runOwned = browser({ id: "run_owned_old", startedAt: "2026-09-15T01:00:00Z", metadata: {}, agentSessionId: "sess_9" });
    const api = fakeApi({
      listRuns: async () => ({ runs: [oldRun, foreignRun, youngRun, doneRun], nextCursor: null }),
      listBrowsers: async () => ({ items: [ours, oursYoung, foreign, runOwned], totalItems: 4 }),
    });
    const knownRunIds = new Set(["old_running", "young_running"]);
    const ledger = memoryLedger(now);
    const report = await sweepAbandoned(api, { now, knownRunIds, runMaxAgeMs: 30 * 60_000, browserMaxAgeMs: 30 * 60_000 }, ledger);
    expect(report).toEqual({
      dry_run: false,
      runs_seen: 4,
      runs_cancelled: ["old_running"],
      foreign_stale_runs: 1,
      browsers_seen: 4,
      browsers_stopped: ["ours_old"],
      run_owned_active_browsers: 1,
      foreign_active_browsers: 1,
      errors: [],
      capped: false,
    });
    expect(api.calls.filter((c) => c.op === "cancelRun").map((c) => c.args[0])).toEqual(["old_running"]);
    expect(api.calls.filter((c) => c.op === "stopBrowser").map((c) => c.args[0])).toEqual(["ours_old"]);
    expect(ledger.entries.map((e) => e.action)).toEqual(["swept_cancel", "swept_stop"]);

    // No ledger ⇒ no run is ever cancelled (the key may serve the dashboard too); browsers still are.
    const noLedger = fakeApi({ listRuns: api.listRuns, listBrowsers: api.listBrowsers });
    const noLedgerReport = await sweepAbandoned(noLedger, { now });
    expect(noLedgerReport.runs_cancelled).toEqual([]);
    expect(noLedgerReport.foreign_stale_runs).toBe(2);
    expect(noLedgerReport.browsers_stopped).toEqual(["ours_old"]);

    const dry = fakeApi({ listRuns: api.listRuns, listBrowsers: api.listBrowsers });
    const dryReport = await sweepAbandoned(dry, { now, knownRunIds, dryRun: true });
    expect(dryReport.runs_cancelled).toEqual(["old_running"]);
    expect(dryReport.browsers_stopped).toEqual(["ours_old"]);
    expect(dry.calls.filter((c) => c.op === "cancelRun" || c.op === "stopBrowser")).toEqual([]);

    const cappedApi = fakeApi({ listRuns: api.listRuns, listBrowsers: api.listBrowsers });
    const cappedReport = await sweepAbandoned(cappedApi, { now, knownRunIds, maxActions: 1 });
    expect(cappedReport.capped).toBe(true);
    expect(cappedReport.runs_cancelled).toEqual(["old_running"]);
    expect(cappedReport.browsers_stopped).toEqual([]);

    // A failing cancel is an error line, not an abort.
    const flaky = fakeApi({ listRuns: api.listRuns, listBrowsers: api.listBrowsers, cancelRun: async () => { throw new BrowserUseError(502, "bad gateway"); } });
    const flakyReport = await sweepAbandoned(flaky, { now, knownRunIds });
    expect(flakyReport.runs_cancelled).toEqual([]);
    expect(flakyReport.errors).toEqual(["cancel old_running: bad gateway"]);
    expect(flakyReport.browsers_stopped).toEqual(["ours_old"]);
  });

  it("sweep pages are bounded", async () => {
    let pages = 0;
    const api = fakeApi({
      listRuns: async () => { pages += 1; return { runs: [], nextCursor: "more" }; },
      listBrowsers: async () => ({ items: [], totalItems: 0 }),
    });
    await sweepAbandoned(api, { maxPages: 2 });
    expect(pages).toBe(2);
  });
});

describe("ledger (UNIT_CONFIRMED)", () => {
  it("appends one JSON line per action under private/browser-use/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bu-ledger-"));
    try {
      const l = fileLedger(dir, () => new Date("2026-09-15T10:00:00Z"));
      l.append({ kind: "run", id: "r1", action: "created", max_cost_usd: 1 });
      l.append({ kind: "browser", id: "b1", action: "stopped" });
      const lines = fs.readFileSync(path.join(dir, "browser-use", "ledger.jsonl"), "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(lines).toEqual([
        { at: "2026-09-15T10:00:00.000Z", kind: "run", id: "r1", action: "created", max_cost_usd: 1 },
        { at: "2026-09-15T10:00:00.000Z", kind: "browser", id: "b1", action: "stopped" },
      ]);
      // Only runs this engine CREATED count for the sweep; a torn last line (crash mid-write) is ignored.
      l.append({ kind: "run", id: "?", action: "create_ambiguous" });
      l.append({ kind: "run", id: "r2", action: "created" });
      fs.appendFileSync(path.join(dir, "browser-use", "ledger.jsonl"), '{"kind":"run","id":"r3","action":"crea');
      expect([...readLedgerRunIds(dir)].sort()).toEqual(["r1", "r2"]);
      expect(readLedgerRunIds(path.join(dir, "nowhere")).size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
