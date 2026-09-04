import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config/index.js";
import type { EmailLlmClient, LlmUsage } from "./emailLlm.js";

/**
 * #154 LLM call ledger — where the minutes go. Live plan phases run 5-16
 * minutes (UKG run 20-22, 2026-09-02) and nothing recorded which call
 * took how long: sandbox traces exist only for sandbox URLs. Every
 * production client is wrapped here; each call appends one line to
 * `artifacts/llm/calls-YYYY-MM-DD.jsonl` — provider, model, the system
 * prompt's first characters (our own code, names the surface), sizes,
 * duration, outcome. Never the prompt bodies or the response: those hold
 * the operator's about-me and answer bank.
 */
export type LlmCallRecord = {
  ts: string;
  provider: string;
  model: string;
  surface: string;
  input_chars: number;
  output_chars: number;
  duration_ms: number;
  ok: boolean;
  error?: string;
  /**
   * Billed tokens as the provider reported them (absent when it did not).
   * `cache_read_input_tokens` is the whole point of the context split —
   * zero across a run means the prefix is not caching; `thinking_tokens`
   * is what effort controls. Chars above are our estimate; these are the
   * invoice.
   */
  usage?: LlmUsage;
};

const SURFACE_CHARS = 72;

export function ledgerPathFor(date = new Date()): string {
  return path.join(
    getConfig().artifactsDir,
    "llm",
    `calls-${date.toISOString().slice(0, 10)}.jsonl`,
  );
}

export function appendLlmCallRecord(record: LlmCallRecord): void {
  try {
    const file = ledgerPathFor(new Date(record.ts));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // the ledger is telemetry — never a reason for a plan to fail
  }
}

/**
 * Wrap a client so every generateJson lands in the ledger.
 *
 * A Proxy, not a plain object literal: the factory's contract is "you get
 * the client for the provider that was chosen", and `email-llm-provider`
 * asserts that with `toBeInstanceOf`. A literal wrapper silently broke all
 * six of those tests — a Proxy forwards getPrototypeOf to the target, so
 * telemetry stays invisible to every caller including `instanceof`.
 */
export function withLlmCallLedger(
  client: EmailLlmClient,
  provider: string,
  fallbackModel: string,
): EmailLlmClient {
  const generateJson: EmailLlmClient["generateJson"] = async (input) => {
    const startedAt = Date.now();
    const base = {
      ts: new Date(startedAt).toISOString(),
      provider,
      surface: input.system.replace(/\s+/g, " ").trim().slice(0, SURFACE_CHARS),
      input_chars:
        input.system.length +
        input.user.length +
        (input.context ?? []).reduce((n, block) => n + block.length, 0),
    };
    try {
      const out = await client.generateJson(input);
      appendLlmCallRecord({
        ...base,
        model: out.model,
        output_chars: out.text.length,
        duration_ms: Date.now() - startedAt,
        ok: true,
        ...(out.usage ? { usage: out.usage } : {}),
      });
      return out;
    } catch (err) {
      appendLlmCallRecord({
        ...base,
        model: fallbackModel,
        output_chars: 0,
        duration_ms: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 160) : String(err),
      });
      throw err;
    }
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "generateJson") return generateJson;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
