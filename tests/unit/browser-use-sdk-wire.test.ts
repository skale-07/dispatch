import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_USE_API_V4, BrowserUseError, sdkBrowserUseApi } from "../../src/browser/browserUse/api.js";

/**
 * The real `browser-use-sdk` v4 client against a stubbed global fetch:
 * what actually goes on the wire — header name, paths, verbs, the body
 * carrying maxCostUsd and solveCaptchas:false, the stop action — and
 * that a transport failure on a create is thrown after ONE request.
 * UNIT_CONFIRMED (mocked transport; live shapes UNVERIFIED).
 */

const KEY = "bu_TESTKEYTESTKEYTESTKEYTESTKEY000";
type Req = { url: string; method: string; headers: Record<string, string>; body: unknown };

function stubFetch(routes: Record<string, { status: number; body?: unknown } | Error>): Req[] {
  const reqs: Req[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    reqs.push({ url, method, headers, body });
    const key = `${method} ${new URL(url).pathname}`;
    const r = routes[key];
    if (!r) return new Response(JSON.stringify({ detail: `no route ${key}` }), { status: 404, headers: { "content-type": "application/json" } });
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return reqs;
}

describe("browser-use-sdk wire format (UNIT_CONFIRMED, transport stubbed)", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("runs: create carries task/model/maxCostUsd under the API-key header; status, get, cancel, list hit the v4 paths", async () => {
    const reqs = stubFetch({
      "POST /api/v4/runs": { status: 200, body: { id: "run_1", status: "queued", model: "gpt-5.6-luna", sessionId: "s1", workspaceId: "w1", eventsUrl: "e" } },
      "GET /api/v4/runs/run_1/status": { status: 200, body: { status: "running" } },
      "GET /api/v4/runs/run_1": { status: 200, body: { id: "run_1", status: "completed", task: "t", model: "gpt-5.6-luna", result: "ok", error: null, sessionId: "s1", totalCostUsd: "0.02", totalInputTokens: 1, totalOutputTokens: 1, createdAt: "2026-09-15T10:00:00Z", updatedAt: "2026-09-15T10:01:00Z" } },
      "POST /api/v4/runs/run_1/cancel": { status: 200, body: { id: "run_1", status: "cancelled", task: "t", model: "gpt-5.6-luna", result: null, error: null, sessionId: "s1", totalCostUsd: "0.01", totalInputTokens: 1, totalOutputTokens: 0, createdAt: "2026-09-15T10:00:00Z", updatedAt: "2026-09-15T10:01:00Z" } },
      "GET /api/v4/runs": { status: 200, body: { runs: [{ id: "run_1", status: "completed", totalCostUsd: "0.02" }], nextCursor: "c2", hasMore: true } },
    });
    const api = sdkBrowserUseApi({ apiKey: KEY });
    const created = await api.createRun({ task: "find x", model: "gpt-5.6-luna", maxCostUsd: 0.5 });
    expect(created).toEqual({ id: "run_1", status: "queued", sessionId: "s1", model: "gpt-5.6-luna" });
    expect(reqs[0]).toMatchObject({ method: "POST", url: `${BROWSER_USE_API_V4}/runs`, body: { task: "find x", model: "gpt-5.6-luna", maxCostUsd: 0.5 } });
    expect(reqs[0]!.headers["x-browser-use-api-key"]).toBe(KEY);
    expect(reqs[0]!.url).not.toContain(KEY);

    expect(await api.runStatus("run_1")).toBe("running");
    expect(reqs[1]).toMatchObject({ method: "GET", url: `${BROWSER_USE_API_V4}/runs/run_1/status` });
    const summary = await api.getRun("run_1");
    expect(summary).toMatchObject({ id: "run_1", status: "completed", result: "ok", totalCostUsd: "0.02" });
    expect((await api.cancelRun("run_1")).status).toBe("cancelled");
    expect(reqs[3]).toMatchObject({ method: "POST", url: `${BROWSER_USE_API_V4}/runs/run_1/cancel` });
    const list = await api.listRuns({ limit: 5 });
    expect(list.nextCursor).toBe("c2");
    expect(list.runs[0]!.id).toBe("run_1");
    expect(reqs[4]!.url).toBe(`${BROWSER_USE_API_V4}/runs?limit=5`);
  });

  it("browsers: create sends solveCaptchas:false + labels; stop PATCHes {action:'stop'}; get/list/profiles use the same header", async () => {
    const view = { id: "br_1", status: "active", liveUrl: "https://live/x", cdpUrl: "wss://cdp/x?token=T", timeoutAt: "2026-09-15T10:20:00Z", startedAt: "2026-09-15T10:00:00Z", finishedAt: null, metadata: { origin: "jobright-agent" } };
    const reqs = stubFetch({
      "POST /api/v4/browsers": { status: 201, body: view },
      "PATCH /api/v4/browsers/br_1": { status: 200, body: { ...view, status: "stopped", cdpUrl: null, browserCost: "0.0034" } },
      "GET /api/v4/browsers/br_1": { status: 200, body: view },
      "GET /api/v4/browsers": { status: 200, body: { items: [view], totalItems: 1, pageNumber: 1, pageSize: 50 } },
      "POST /api/v4/profiles": { status: 200, body: { id: "prof_1", userId: "u", name: "n", createdAt: "x", updatedAt: "x" } },
    });
    const api = sdkBrowserUseApi({ apiKey: KEY });
    const b = await api.createBrowser({ timeout: 20, solveCaptchas: false, metadata: { origin: "jobright-agent" }, proxyCountryCode: null });
    expect(b).toMatchObject({ id: "br_1", status: "active", cdpUrl: "wss://cdp/x?token=T", metadata: { origin: "jobright-agent" } });
    expect(reqs[0]).toMatchObject({ method: "POST", url: `${BROWSER_USE_API_V4}/browsers`, body: { timeout: 20, solveCaptchas: false, profileId: null, proxyCountryCode: null, metadata: { origin: "jobright-agent" } } });

    const stopped = await api.stopBrowser("br_1");
    expect(stopped.status).toBe("stopped");
    expect(reqs[1]).toMatchObject({ method: "PATCH", url: `${BROWSER_USE_API_V4}/browsers/br_1`, body: { action: "stop" } });

    expect((await api.getBrowser("br_1")).liveUrl).toBe("https://live/x");
    expect(reqs[2]).toMatchObject({ method: "GET", url: `${BROWSER_USE_API_V4}/browsers/br_1` });
    expect(reqs[2]!.headers["x-browser-use-api-key"]).toBe(KEY);
    const list = await api.listBrowsers({ active: true, pageSize: 50 });
    expect(list.totalItems).toBe(1);
    expect(reqs[3]!.url).toBe(`${BROWSER_USE_API_V4}/browsers?pageSize=50&pageNumber=1&filterBy=active`);
    expect(await api.createProfile({ userId: "u", name: "n" })).toEqual({ id: "prof_1" });
    expect(reqs[4]).toMatchObject({ method: "POST", url: `${BROWSER_USE_API_V4}/profiles`, body: { userId: "u", name: "n" } });
  });

  it("a provider refusal surfaces its status and text without the key; a transport failure on a create is thrown after ONE request", async () => {
    const reqs = stubFetch({
      "POST /api/v4/runs": { status: 402, body: { detail: "Insufficient credits" } },
      "POST /api/v4/browsers": new Error("fetch failed: ECONNRESET"),
      "GET /api/v4/browsers/nope": { status: 404, body: { detail: "not found" } },
    });
    const api = sdkBrowserUseApi({ apiKey: KEY });
    const err = await api.createRun({ task: "t", model: "gpt-5.6-luna", maxCostUsd: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserUseError);
    expect((err as BrowserUseError).statusCode).toBe(402);
    expect((err as Error).message).toMatch(/Insufficient credits/);
    expect((err as Error).message).not.toContain(KEY);
    expect(reqs.filter((r) => r.url.endsWith("/runs"))).toHaveLength(1);

    await expect(api.createBrowser({ timeout: 5, solveCaptchas: false })).rejects.toThrow(/ECONNRESET/);
    expect(reqs.filter((r) => r.url.endsWith("/browsers"))).toHaveLength(1);

    const raw = await api.getBrowser("nope").catch((e: unknown) => e);
    expect(raw).toBeInstanceOf(BrowserUseError);
    expect((raw as BrowserUseError).statusCode).toBe(404);
    expect((raw as Error).message).not.toContain(KEY);
  });

  it("refuses to build a client without a key", () => {
    expect(() => sdkBrowserUseApi({ apiKey: "" })).toThrow(/no API key/);
  });

  it("the plain-fetch shim is time-capped like the SDK client (a stalled GET /browsers/{id} aborts)", async () => {
    vi.stubGlobal("fetch", (_input: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted")));
      }),
    );
    const api = sdkBrowserUseApi({ apiKey: KEY, timeoutMs: 20 });
    await expect(api.getBrowser("br_1")).rejects.toThrow(/GET \/browsers\/br_1: timed out after 20ms/);
  });
});
