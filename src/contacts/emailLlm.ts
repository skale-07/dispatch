import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig, type AppConfig } from "../config/index.js";
import { withLlmCallLedger } from "./llmCallLedger.js";

/**
 * One of the sanctioned LLM boundaries in this codebase — all of which
 * reuse this client interface: outreach email generation (here), offline
 * selector-patch PROPOSALS (heal/submitInventoryHealer.ts), screener
 * label→key MAPPING (applications/screenerLlmMap.ts — never answers), and
 * essay DRAFT suggestions into review items (applications/essayDraft.ts —
 * never filled without human approval). Never demographics, never live
 * ATS interaction. Tests use stubs; no test ever calls out.
 *
 * Three providers, one preference order: Anthropic when ANTHROPIC_API_KEY
 * is set (the operator's better-funded account), then OpenAI, then Kimi
 * (Moonshot). LLM_PROVIDER, when set, names the provider explicitly and a
 * missing key for it is a loud refusal — never a silent fallback. Every
 * production call site goes through makeLlmClient()/hasLlmKey() so the
 * preference can never drift per-surface.
 */
export type LlmEffort = "low" | "medium" | "high";

export interface LlmGenerateInput {
  system: string;
  /** The per-call part: the questions, the posting, the contact. */
  user: string;
  /**
   * Stable material the same surface resends call after call (about-me,
   * answer bank, profile facts, the screener registry). Sent AFTER the
   * system prompt and BEFORE `user`, most-stable block first, so a
   * prefix-caching provider serves it at cache-read rates instead of
   * billing it in full every call. Ledger 2026-09-03: predict + essay
   * carried the same ~25K chars 237 times in one day. Providers without
   * caching fold the blocks into the system message verbatim — the model
   * sees identical text either way.
   */
  context?: string[];
  /**
   * Reasoning depth. Constrained pick-from-options tasks want "low";
   * prose that a human reads ("essay", outreach) keeps the provider
   * default when unset. Thinking tokens bill as output, so an unset
   * default on a reasoning model is a hidden line item.
   */
  effort?: LlmEffort;
}

/** Token counts when the provider reports them — cache reads included. */
export type LlmUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  thinking_tokens?: number;
};

export interface LlmGenerateOutput {
  text: string;
  model: string;
  usage?: LlmUsage;
}

export interface EmailLlmClient {
  /** Returns the raw model output string (expected to be JSON). */
  generateJson(input: LlmGenerateInput): Promise<LlmGenerateOutput>;
}

/**
 * Which pipeline a client serves — selects the Anthropic model. Outreach
 * is the default so every existing call site keeps its model; the applier
 * surfaces opt in explicitly.
 */
export type LlmPipeline = "outreach" | "applier";

const JSON_ONLY = "Respond with ONLY the JSON object — no prose, no code fences.";

/** Providers without prefix caching get the context inline, same order. */
function foldContext(system: string, context: string[] | undefined): string {
  if (!context || context.length === 0) return system;
  return `${system}\n\n${context.join("\n\n")}`;
}

export class OpenAiEmailClient implements EmailLlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const cfg = getConfig();
    if (!cfg.openaiApiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set — outreach generation needs it in .env",
      );
    }
    this.client = new OpenAI({ apiKey: cfg.openaiApiKey });
    this.model = cfg.emailLlmModel;
  }

  async generateJson(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: foldContext(input.system, input.context) },
        { role: "user", content: input.user },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    const u = response.usage;
    return {
      text,
      model: response.model ?? this.model,
      ...(u
        ? {
            usage: {
              input_tokens: u.prompt_tokens,
              output_tokens: u.completion_tokens,
              ...(u.prompt_tokens_details?.cached_tokens !== undefined
                ? { cache_read_input_tokens: u.prompt_tokens_details.cached_tokens }
                : {}),
            },
          }
        : {}),
    };
  }
}

/**
 * `output_config.effort` is accepted on the 4.6+ generation and rejected
 * (400) by older ids and Haiku 4.5. Match the ids we would ever configure
 * rather than hoping; an unmatched model just gets the provider default.
 */
export function anthropicModelSupportsEffort(model: string): boolean {
  return /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6)\b/.test(
    model,
  );
}

export class AnthropicLlmClient implements EmailLlmClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(model?: string) {
    const cfg = getConfig();
    if (!cfg.anthropicApiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set — the Anthropic LLM client needs it in .env",
      );
    }
    this.client = new Anthropic({ apiKey: cfg.anthropicApiKey });
    this.model = model ?? cfg.anthropicLlmModel;
  }

  async generateJson(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    // Prefix order is system → messages, so the stable blocks go into the
    // system array behind the surface prompt, each with its own breakpoint:
    // when a later block changes (the bank learned an answer) the earlier
    // ones still hit. The per-call JSON stays in the user turn, after the
    // last breakpoint, where it cannot invalidate anything.
    const system: Anthropic.TextBlockParam[] = [
      // Every consumer's system prompt already demands a JSON object and
      // deterministically re-validates the output; the reinforcement here
      // covers models that would otherwise preface JSON with prose.
      { type: "text", text: `${input.system}\n\n${JSON_ONLY}` },
      ...(input.context ?? []).map(
        (text): Anthropic.TextBlockParam => ({
          type: "text",
          text,
          cache_control: { type: "ephemeral" },
        }),
      ),
    ];
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system,
      messages: [{ role: "user", content: input.user }],
      ...(input.effort && anthropicModelSupportsEffort(this.model)
        ? { output_config: { effort: input.effort } }
        : {}),
    });
    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    const u = response.usage;
    const usage: LlmUsage = {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
    };
    if (u.cache_read_input_tokens != null)
      usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null)
      usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
    if (u.output_tokens_details?.thinking_tokens != null)
      usage.thinking_tokens = u.output_tokens_details.thinking_tokens;
    return {
      text: stripJsonFences(text),
      model: response.model ?? this.model,
      usage,
    };
  }
}

/**
 * Kimi K3 (Moonshot AI) via its OpenAI-compatible chat-completions API.
 * K3 specifics honored here: sampling params (temperature/top_p) are fixed
 * server-side and must be omitted; reasoning is always on, so effort is
 * pinned LOW — every consumer sends short structured-JSON tasks where max
 * (the default) only burns paid reasoning tokens; reasoning arrives in a
 * separate `reasoning_content` field, so `message.content` is already the
 * clean answer (fence-stripping kept as cheap defense).
 */
export class KimiLlmClient implements EmailLlmClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    const cfg = getConfig();
    if (!cfg.moonshotApiKey) {
      throw new Error(
        "MOONSHOT_API_KEY is not set — the Kimi LLM client needs it in .env",
      );
    }
    this.client = new OpenAI({
      apiKey: cfg.moonshotApiKey,
      baseURL: "https://api.moonshot.ai/v1",
    });
    this.model = cfg.kimiLlmModel;
  }

  async generateJson(input: LlmGenerateInput): Promise<LlmGenerateOutput> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content: foldContext(`${input.system}\n\n${JSON_ONLY}`, input.context),
        },
        { role: "user", content: input.user },
      ],
    });
    const text = response.choices[0]?.message?.content ?? "";
    const u = response.usage;
    return {
      text: stripJsonFences(text),
      model: response.model ?? this.model,
      ...(u
        ? {
            usage: {
              input_tokens: u.prompt_tokens,
              output_tokens: u.completion_tokens,
            },
          }
        : {}),
    };
  }
}

/** Models sometimes fence JSON despite instructions; unwrap deterministically. */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * True when ANY provider key is configured — the shared precondition every
 * flag-gated LLM surface checks before constructing a client.
 */
export function hasLlmKey(
  cfg?: Pick<AppConfig, "anthropicApiKey" | "openaiApiKey" | "moonshotApiKey">,
): boolean {
  const c = cfg ?? getConfig();
  return Boolean(c.anthropicApiKey ?? c.openaiApiKey ?? c.moonshotApiKey);
}

/** Human-readable name of what hasLlmKey() looks for, for skip notes. */
export const LLM_KEY_HINT =
  "ANTHROPIC_API_KEY, OPENAI_API_KEY, or MOONSHOT_API_KEY";

/**
 * The one production client factory. LLM_PROVIDER, when set, wins and its
 * key must exist (loud refusal otherwise — a forced provider silently
 * swapped for another would falsify every artifact's model attribution).
 * Unset: Anthropic preferred, then OpenAI, then Kimi. Throws when no key
 * is configured (callers gate with hasLlmKey()).
 *
 * `pipeline` picks the Anthropic model only: "applier" (screener + essay
 * surfaces) runs ANTHROPIC_APPLIER_MODEL, "outreach" (the default, so an
 * unqualified call keeps today's behavior) runs ANTHROPIC_LLM_MODEL. The
 * OpenAI and Kimi providers have one model each.
 */
export function makeLlmClient(pipeline: LlmPipeline = "outreach"): EmailLlmClient {
  const cfg = getConfig();
  const anthropicModel =
    pipeline === "applier" ? cfg.anthropicApplierModel : cfg.anthropicLlmModel;
  const ledger = (client: EmailLlmClient, provider: string, model: string) =>
    withLlmCallLedger(client, provider, model);
  if (cfg.llmProvider === "anthropic")
    return ledger(new AnthropicLlmClient(anthropicModel), "anthropic", anthropicModel);
  if (cfg.llmProvider === "openai")
    return ledger(new OpenAiEmailClient(), "openai", cfg.emailLlmModel);
  if (cfg.llmProvider === "kimi")
    return ledger(new KimiLlmClient(), "kimi", cfg.kimiLlmModel);
  if (cfg.anthropicApiKey)
    return ledger(new AnthropicLlmClient(anthropicModel), "anthropic", anthropicModel);
  if (cfg.openaiApiKey)
    return ledger(new OpenAiEmailClient(), "openai", cfg.emailLlmModel);
  if (cfg.moonshotApiKey)
    return ledger(new KimiLlmClient(), "kimi", cfg.kimiLlmModel);
  throw new Error(
    `no LLM provider key configured — set ${LLM_KEY_HINT} in .env`,
  );
}
