import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetConfigCache } from "../../src/config/index.js";
import type { EmailLlmClient } from "../../src/contacts/emailLlm.js";
import {
  ledgerPathFor,
  withLlmCallLedger,
} from "../../src/contacts/llmCallLedger.js";

/**
 * #154 ledger + #155 regression: the wrapper must record every call AND
 * stay invisible to callers. Its first version was an object literal, which
 * silently broke the six `toBeInstanceOf` assertions in the provider
 * factory tests — telemetry is never allowed to change what a factory
 * appears to return. No test calls a real model. UNIT_CONFIRMED.
 */
class FakeLlmClient implements EmailLlmClient {
  readonly calls: { system: string; user: string }[] = [];

  async generateJson(input: { system: string; user: string }): Promise<{
    text: string;
    model: string;
  }> {
    this.calls.push(input);
    if (input.user === "boom") throw new Error("upstream refused the call");
    return { text: '{"ok":true}', model: "fake-model-v1" };
  }
}

function readLedger(): Record<string, unknown>[] {
  const file = ledgerPathFor();
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("LLM call ledger (UNIT_CONFIRMED)", () => {
  let artifactsDir: string;
  let savedArtifactsDir: string | undefined;

  beforeEach(() => {
    savedArtifactsDir = process.env.ARTIFACTS_DIR;
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-"));
    process.env.ARTIFACTS_DIR = artifactsDir;
    resetConfigCache();
  });

  afterEach(() => {
    if (savedArtifactsDir === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = savedArtifactsDir;
    resetConfigCache();
    fs.rmSync(artifactsDir, { recursive: true, force: true });
  });

  it("stays instanceof the wrapped client — telemetry is invisible", () => {
    const wrapped = withLlmCallLedger(
      new FakeLlmClient(),
      "anthropic",
      "fallback-model",
    );
    expect(wrapped).toBeInstanceOf(FakeLlmClient);
  });

  it("records a successful call with the model the client reported", async () => {
    const wrapped = withLlmCallLedger(
      new FakeLlmClient(),
      "anthropic",
      "fallback-model",
    );

    const out = await wrapped.generateJson({
      system: "  You  are   the outreach   writer.  ",
      user: "write it",
    });

    expect(out).toEqual({ text: '{"ok":true}', model: "fake-model-v1" });
    const records = readLedger();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "anthropic",
      model: "fake-model-v1",
      ok: true,
      output_chars: '{"ok":true}'.length,
    });
    // Surface is our own system prompt, whitespace-collapsed — never the
    // user prompt, which carries the operator's about-me and answer bank.
    const record = records[0];
    expect(record?.surface).toBe("You are the outreach writer.");
    expect(record?.input_chars).toBe(
      "  You  are   the outreach   writer.  ".length + "write it".length,
    );
    expect(typeof record?.duration_ms).toBe("number");
  });

  it("records a failed call under the fallback model and rethrows", async () => {
    const wrapped = withLlmCallLedger(
      new FakeLlmClient(),
      "kimi",
      "fallback-model",
    );

    await expect(
      wrapped.generateJson({ system: "sys", user: "boom" }),
    ).rejects.toThrow("upstream refused the call");

    const records = readLedger();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "kimi",
      model: "fallback-model",
      ok: false,
      output_chars: 0,
      error: "upstream refused the call",
    });
  });

  it("forwards the call through to the wrapped client unchanged", async () => {
    const inner = new FakeLlmClient();
    const wrapped = withLlmCallLedger(inner, "openai", "fallback-model");

    await wrapped.generateJson({ system: "sys", user: "hello" });

    expect(inner.calls).toEqual([{ system: "sys", user: "hello" }]);
  });
});
