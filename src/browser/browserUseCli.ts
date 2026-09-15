#!/usr/bin/env node
import fs from "node:fs";
import { getConfig } from "../config/index.js";
import {
  browserUseLedger,
  browserUseRunPolicy,
  isEngineBrowser,
  readLedgerRunIds,
  resolveBrowserUseApi,
  startRun,
  sweepAbandoned,
  validateRunResult,
  waitForRun,
  type BrowserUseApi,
} from "./browserUse/index.js";
import { redactConnectUrl } from "./remoteBrowser.js";

/**
 * Operator surface for Browser Use Cloud (behind BROWSER_USE_ENABLED +
 * BROWSER_USE_API_KEY; `run` also needs BROWSER_USE_AGENT_ENABLED):
 *
 *   npm run browseruse -- run --task "<text>" [--model m] [--max-cost 0.5]
 *                              [--session <id>] [--wait [--timeout-min 10]]
 *                              [--schema file.json]
 *   npm run browseruse -- status --run <id>
 *   npm run browseruse -- result --run <id> [--schema file.json] [--max-cost 1]
 *   npm run browseruse -- cancel --run <id>
 *   npm run browseruse -- runs [--limit 20]
 *   npm run browseruse -- browsers
 *   npm run browseruse -- stop --browser <id>
 *   npm run browseruse -- sweep [--older-than-min 30] [--dry-run]
 *
 * Every command prints one JSON report. Keys and CDP URLs never appear in
 * it (CDP URLs are redacted to their host). `run` creates exactly one run;
 * an ambiguous create is reported, never re-sent. `sweep` cancels only
 * runs this engine created (per the ledger) and stops only engine-labelled
 * browsers. A hosted run's browser is the provider's own — its CAPTCHA
 * handling is not under this engine's control (see the operator guide).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}
function num(name: string): number | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function loadSchema(file: string | undefined): { safeParse(v: unknown): { success: true; data: unknown } | { success: false; error: { message: string } } } | undefined {
  if (!file) return undefined;
  // A JSON "shape": every top-level key listed must be present and of the
  // named type ("string" | "number" | "boolean" | "array" | "object").
  const shape = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  return {
    safeParse(v) {
      if (!v || typeof v !== "object" || Array.isArray(v)) return { success: false, error: { message: "not an object" } };
      const o = v as Record<string, unknown>;
      for (const [k, t] of Object.entries(shape)) {
        const actual = Array.isArray(o[k]) ? "array" : o[k] === null ? "null" : typeof o[k];
        if (!(k in o)) return { success: false, error: { message: `missing ${k}` } };
        if (actual !== t) return { success: false, error: { message: `${k}: expected ${t}, got ${actual}` } };
      }
      return { success: true, data: v };
    },
  };
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const config = getConfig();
  const api: BrowserUseApi = resolveBrowserUseApi(config);
  const policy = browserUseRunPolicy(config);
  const ledger = browserUseLedger(config);
  const out = (report: unknown): void => console.log(JSON.stringify(report, null, 2));

  switch (cmd) {
    case "run": {
      const task = arg("--task");
      if (!task) throw new Error("run needs --task");
      const req = {
        task,
        ...(arg("--model") ? { model: arg("--model")! } : {}),
        ...(num("--max-cost") !== undefined ? { maxCostUsd: num("--max-cost")! } : {}),
        ...(arg("--session") ? { sessionId: arg("--session")! } : {}),
      };
      const created = await startRun(api, req, policy, ledger);
      if (!flag("--wait")) {
        out({ run_id: created.id, status: created.status, model: created.model, session_id: created.sessionId, note: "not waited; `status --run <id>` / `result --run <id>`" });
        return;
      }
      const timeoutMin = num("--timeout-min") ?? 10;
      const waited = await waitForRun(api, created.id, { timeoutMs: timeoutMin * 60_000 }, ledger);
      const schema = loadSchema(arg("--schema"));
      const validation = validateRunResult(waited.summary, { maxCostUsd: req.maxCostUsd ?? policy.maxCostUsd, ...(schema ? { schema } : {}) });
      ledger.append({ kind: "run", id: created.id, action: "validated", ok: validation.ok, reasons: validation.reasons });
      out({ run_id: created.id, timed_out: waited.timedOut, stopped_by: waited.stoppedBy, polls: waited.polls, last_error: waited.lastError, status: waited.summary.status, total_cost_usd: waited.summary.totalCostUsd, validation });
      if (!validation.ok) process.exitCode = 1;
      return;
    }
    case "status": {
      const id = arg("--run");
      if (!id) throw new Error("status needs --run");
      out({ run_id: id, status: await api.runStatus(id) });
      return;
    }
    case "result": {
      const id = arg("--run");
      if (!id) throw new Error("result needs --run");
      const summary = await api.getRun(id);
      const schema = loadSchema(arg("--schema"));
      const validation = validateRunResult(summary, { maxCostUsd: num("--max-cost") ?? policy.maxCostUsd, ...(schema ? { schema } : {}) });
      ledger.append({ kind: "run", id, action: "validated", ok: validation.ok, reasons: validation.reasons });
      out({ run_id: id, status: summary.status, total_cost_usd: summary.totalCostUsd, tokens: { in: summary.totalInputTokens, out: summary.totalOutputTokens }, error: summary.error, validation });
      if (!validation.ok) process.exitCode = 1;
      return;
    }
    case "cancel": {
      const id = arg("--run");
      if (!id) throw new Error("cancel needs --run");
      const after = await api.cancelRun(id);
      ledger.append({ kind: "run", id, action: "cancelled", status: after.status, total_cost_usd: after.totalCostUsd });
      out({ run_id: id, status: after.status, total_cost_usd: after.totalCostUsd });
      return;
    }
    case "runs": {
      const { runs, nextCursor } = await api.listRuns({ limit: num("--limit") ?? 20 });
      out({
        runs: runs.map((r) => ({ id: r.id, status: r.status, model: r.model, total_cost_usd: r.totalCostUsd, created_at: r.createdAt, task: r.task.slice(0, 80) })),
        next_cursor: nextCursor,
      });
      return;
    }
    case "browsers": {
      const { items, totalItems } = await api.listBrowsers({ active: true, pageSize: 50 });
      out({
        total_active: totalItems,
        browsers: items.map((b) => ({
          id: b.id,
          status: b.status,
          engine_owned: isEngineBrowser(b.metadata),
          run_owned: Boolean(b.agentSessionId),
          started_at: b.startedAt,
          timeout_at: b.timeoutAt,
          live_url: b.liveUrl,
          cdp: b.cdpUrl ? redactConnectUrl(b.cdpUrl) : null,
          metadata: b.metadata,
        })),
      });
      return;
    }
    case "stop": {
      const id = arg("--browser");
      if (!id) throw new Error("stop needs --browser");
      const after = await api.stopBrowser(id);
      ledger.append({ kind: "browser", id, action: "stopped", status: after.status, browser_cost: after.browserCost });
      out({ browser_id: id, status: after.status, browser_cost: after.browserCost, proxy_cost: after.proxyCost });
      return;
    }
    case "sweep": {
      const olderThanMin = num("--older-than-min") ?? 30;
      const report = await sweepAbandoned(
        api,
        { knownRunIds: readLedgerRunIds(config.privateDir), runMaxAgeMs: olderThanMin * 60_000, browserMaxAgeMs: olderThanMin * 60_000, dryRun: flag("--dry-run") },
        ledger,
      );
      out(report);
      if (report.errors.length > 0) process.exitCode = 1;
      return;
    }
    default:
      throw new Error("usage: browseruse <run|status|result|cancel|runs|browsers|stop|sweep> (see the header of src/browser/browserUseCli.ts)");
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
