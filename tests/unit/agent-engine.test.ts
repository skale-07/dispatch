import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentEngineCommand } from "../../src/agent/engine.js";
import { runSidecarTask } from "../../src/agent/sidecarRunner.js";
import { agentNavigateResultSchema } from "../../src/agent/contract.js";
import { loadConfig } from "../../src/config/env.js";

/**
 * S-spike: the Stagehand engine rides the SAME contract and seam as the
 * incumbent. What must hold before any desktop comparison runs: the
 * selector defaults to browser_use, the challenger's command points at a
 * real file, and — critically — the challenger FAILS SAFE: with the
 * dependency not installed (true in CI), every task still yields a
 * contract-valid error result, so the orchestrator sees a failed turn,
 * never a crashed phase. UNIT_CONFIRMED.
 */

describe("agent engine selection (UNIT_CONFIRMED)", () => {
  it("browser_use is the default and uses the runner's built-in command", () => {
    expect(loadConfig({ NODE_ENV: "test" }).agentEngine).toBe("browser_use");
    expect(resolveAgentEngineCommand("browser_use")).toBeNull();
  });

  it("stagehand resolves to a node command whose script exists on disk", () => {
    const cmd = resolveAgentEngineCommand("stagehand");
    expect(cmd?.command).toBe("node");
    const script = path.join(process.cwd(), "agent", cmd!.args[0]!);
    expect(fs.existsSync(script)).toBe(true);
  });

  it("AGENT_ENGINE parses both engines and nothing else", () => {
    expect(
      loadConfig({ NODE_ENV: "test", AGENT_ENGINE: "stagehand" }).agentEngine,
    ).toBe("stagehand");
    expect(() =>
      loadConfig({ NODE_ENV: "test", AGENT_ENGINE: "puppeteer" }),
    ).toThrow();
  });
});

describe("stagehand sidecar fails safe on-contract (UNIT_CONFIRMED)", () => {
  const NAV_TASK = {
    task_version: 1,
    task_type: "navigate",
    goal: "reach the application form",
    start_url: "https://jobright.ai/jobs/info/abc",
    cdp_url: "http://127.0.0.1:9222",
    allowed_domains: ["greenhouse.io"],
    max_steps: 10,
    timeout_ms: 30_000,
    credentials: { available: false },
    gmail_available: false,
  };

  it("dependency not installed ⇒ a contract-valid error result naming the install", async () => {
    const stdout = await runSidecarTask({
      task: NAV_TASK,
      timeoutMs: 20_000,
      graceMs: 5_000,
      commandOverride: resolveAgentEngineCommand("stagehand")!,
    });
    const result = agentNavigateResultSchema.parse(JSON.parse(stdout.trim()));
    expect(result.status).toBe("error");
    expect(result.final_url).toBeNull();
    expect(result.reason).toMatch(/stagehand engine not installed|CDP attach failed/);
  }, 30_000);

  it("a non-navigate task is refused on-contract, not crashed", async () => {
    const stdout = await runSidecarTask({
      task: { task_version: 1, task_type: "author", url: "https://x.test" },
      timeoutMs: 20_000,
      graceMs: 5_000,
      commandOverride: resolveAgentEngineCommand("stagehand")!,
    });
    const result = agentNavigateResultSchema.parse(JSON.parse(stdout.trim()));
    expect(result.status).toBe("error");
    expect(result.reason).toContain("not a navigate task");
  }, 30_000);
});
