import { z } from "zod";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBrowserChannel,
  type BrowserChannel,
} from "../browser/launchOptions.js";

/**
 * Repo-root `.env` is the operator switchboard. `override: true` so a
 * leftover PowerShell `$env:NAVIGATION_ENABLED=false` cannot mask the
 * file. Flags still default off when the key is absent. Tests wipe the
 * gated keys after this load (fillEnvIsolation).
 *
 * Hosted/PaaS escape hatch (docs/roadmap/cloud-deploy.md): platforms
 * deliver configuration AS process env, so `override: true` would let a
 * stray baked-in `.env` silently beat the platform. Set
 * `DOTENV_OVERRIDE=false` there and already-set process env always wins;
 * unset (local default) keeps today's behavior exactly.
 */
export const DOTENV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".env",
);

const dotenvOverride =
  (process.env["DOTENV_OVERRIDE"] ?? "").trim().toLowerCase() !== "false";

dotenv.config({ path: DOTENV_PATH, override: dotenvOverride });

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  });

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  DATABASE_PATH: z.string().default("data/app.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DRY_RUN: boolFromEnv.default(true),
  FORM_FILL_ENABLED: boolFromEnv.default(false),
  SUBMIT_ENABLED: boolFromEnv.default(false),
  SUBMIT_REQUIRES_LOCAL_CONFIRMATION: boolFromEnv.default(true),
  MAX_UNATTENDED_SUBMISSIONS_PER_RUN: z.coerce.number().int().nonnegative().default(0),
  OUTLOOK_DRAFTS_ENABLED: boolFromEnv.default(false),
  LINKEDIN_ENRICHMENT_ENABLED: boolFromEnv.default(false),
  JOBRIGHT_AUTOFILL_ENABLED: boolFromEnv.default(false),
  NATIVE_AUTOFILL_ENABLED: boolFromEnv.default(false),
  /** Phase 5.6H: generating/downloading a resume mutates JobRight. Fail closed. */
  MATERIALS_DOWNLOAD_ENABLED: boolFromEnv.default(false),
  /** Nav clicks Apply on live JobRight (mutates applied-state). Fail closed. */
  NAVIGATION_ENABLED: boolFromEnv.default(false),
  /** Gmail readonly OTP/magic-link retrieval during navigation. Fail closed. */
  GMAIL_VERIFICATION_ENABLED: boolFromEnv.default(false),
  /**
   * Read-only Outlook web mailbox scan for submit verification codes.
   * Navigation + DOM reads in the operator's session only — never
   * compose/send (sendGuards). Fail closed.
   */
  OUTLOOK_VERIFICATION_ENABLED: boolFromEnv.default(false),
  /**
   * Hard-stop inspection/pipeline on heuristic essay fields (`needs_essay` /
   * `ESSAY_REQUIRED`). Default off — the label heuristics false-positive on
   * EEO/combobox copy (e.g. "describe your race"). Free-text is still never
   * auto-filled (textarea refusal in approvedFillPlan). When enabled, only
   * REQUIRED essay fields stop the pipeline — optional textareas never block.
   */
  ESSAY_REQUIRED_GATE_ENABLED: boolFromEnv.default(false),
  /** Outreach email generation calls the OpenAI API (spend). Fail closed. */
  EMAIL_GENERATION_ENABLED: boolFromEnv.default(false),
  /**
   * Create Gmail DRAFTS via the operator's signed-in web session (drafts
   * only, exactly like OUTLOOK_DRAFTS_ENABLED: the Send control is a
   * forbidden selector, never a click target — Gmail autosaves on
   * Save & close). Mailbox mutation ⇒ fail closed.
   */
  GMAIL_DRAFTS_ENABLED: boolFromEnv.default(false),
  /** OpenAI key for outreach generation only. Never logged or artifacted. */
  OPENAI_API_KEY: z.string().optional(),
  /** Operator-confirmed OpenAI model id for outreach generation. */
  EMAIL_LLM_MODEL: z.string().default("gpt-5-mini"),
  /**
   * Anthropic key. When set it is the PREFERRED provider at every LLM
   * boundary (text generation and the nav sidecar); OpenAI becomes the
   * fallback. Never logged or artifacted.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Anthropic model id used when the Anthropic provider is active. */
  ANTHROPIC_LLM_MODEL: z.string().default("claude-opus-5"),
  /**
   * Anthropic model for the APPLIER's LLM surfaces (screener classify /
   * option-map / predict, essay draft + autofill). Ledger 2026-09-03: those
   * surfaces were 97% of input tokens (338 of 349 calls), every one a
   * constrained JSON task that validatePrediction / validateDraft / the
   * option-membership gate re-checks deterministically — the mid tier
   * holds there at ~40% of the Opus rate. Outreach email (operator-facing
   * prose, 11 calls/day) stays on ANTHROPIC_LLM_MODEL.
   *
   * DEFAULTS TO ANTHROPIC_LLM_MODEL — the split is opt-in. A cheaper tier
   * here is a quality tradeoff on answers that go into real applications,
   * so it is the operator's call to make in `.env`, never ours to default
   * on (same principle as the capability flags).
   */
  ANTHROPIC_APPLIER_MODEL: z.string().optional(),
  /**
   * Moonshot AI key for the Kimi provider (OpenAI-compatible API at
   * api.moonshot.ai). Third in the default preference order; select it
   * explicitly with LLM_PROVIDER=kimi. Never logged or artifacted.
   */
  MOONSHOT_API_KEY: z.string().optional(),
  /** Kimi model id used when the Kimi provider is active. */
  KIMI_LLM_MODEL: z.string().default("kimi-k3"),
  /**
   * Explicit provider override. Unset ⇒ key-presence order (anthropic →
   * openai → kimi). Set ⇒ exactly that provider; a missing key for it is a
   * loud refusal, never a silent fallback to another provider.
   */
  LLM_PROVIDER: z.enum(["anthropic", "openai", "kimi"]).optional(),
  /**
   * Chrome Web Store id of the JobRight extension (optional). When set,
   * the extension preflight matches CDP targets by exact id instead of a
   * /jobright/i title heuristic. Plain setting, not a capability flag.
   */
  JOBRIGHT_EXTENSION_ID: z.string().optional(),
  /** Phase 6 J1: browser-use authoring sidecar. Fail closed. */
  AGENT_AUTHORING_ENABLED: boolFromEnv.default(false),
  SCREENER_LLM_MATCH_ENABLED: boolFromEnv.default(false),
  SCREENER_PREDICT_LLM_ENABLED: boolFromEnv.default(false),
  ARTIFACT_AUTOPUSH_ENABLED: boolFromEnv.default(false),
  ESSAY_DRAFT_ENABLED: boolFromEnv.default(false),
  ESSAY_AUTOFILL_ENABLED: boolFromEnv.default(false),
  /** Phase 6a': sidecar escalation when the in-process healer fails. Fail closed. */
  AGENT_FALLBACK_ENABLED: boolFromEnv.default(false),
  /**
   * LLM failure triage (night25): after a run fails, the model chooses ONE
   * remediation from an enumerated action set; every choice is re-validated
   * deterministically and executed only through existing state-machine
   * primitives. TRIAGE_LLM_ENABLED gates deciding+recording;
   * TRIAGE_ACT_ENABLED gates executing validated decisions (inert without
   * the first). Both fail closed.
   */
  TRIAGE_LLM_ENABLED: boolFromEnv.default(false),
  TRIAGE_ACT_ENABLED: boolFromEnv.default(false),
  /**
   * D-rev: multi-source discovery from the ATSes' own PUBLIC board APIs
   * (Greenhouse/Lever/Ashby/Workable, unauthenticated GETs) into the local
   * queue. Read-only against the network, but it creates jobs +
   * applications autonomously — that queue mutation is why it is a
   * capability flag. Fail closed.
   */
  ATS_DISCOVERY_ENABLED: boolFromEnv.default(false),
  /**
   * L3 kill switch. The console automation worker (unattended apply while
   * armed) is refused unless this is set — regardless of any arm. Fail closed.
   */
  AUTOMATION_ENABLED: boolFromEnv.default(false),
  /** CDP endpoint of the operator-started debug Chrome (see chrome:debug:jobright). */
  AGENT_CDP_URL: z.string().default("http://127.0.0.1:9222"),
  /**
   * S-spike: which sidecar drives agent navigation turns. Plain setting,
   * not a capability flag — AGENT_FALLBACK_ENABLED still gates whether any
   * agent runs at all. "stagehand" requires `npm install` inside
   * agent/stagehand once; see docs/agent-engine-decision.md for the
   * pre-registered comparison protocol and promotion bar.
   */
  AGENT_ENGINE: z.enum(["browser_use", "stagehand"]).default("browser_use"),
  /**
   * STANDING portal credentials (operator directive 2026-08-12): the one
   * email + password the operator uses for every employer job portal, so
   * signing in is never a per-site chore. Set both and any employer login
   * wall the apply flow reaches is answered automatically; leave the
   * password unset and portal auth falls back to per-host vault entries
   * only (fail-closed by absence). SECRETS: never logged, never
   * artifacted, never persisted outside private/.
   */
  PORTAL_LOGIN_EMAIL: z.string().optional(),
  PORTAL_LOGIN_PASSWORD: z.string().optional(),
  /**
   * Which mailbox to scan FIRST for verification codes. Normally derived
   * from PORTAL_LOGIN_EMAIL's domain; set this to force it (e.g. an
   * Outlook inbox reached at a custom-domain address).
   */
  VERIFICATION_MAILBOX: z.enum(["gmail", "outlook"]).optional(),

  /**
   * Hands-off cycle may LAUNCH the debug Chrome itself when the CDP
   * endpoint is unreachable (same executable + persistent profile as
   * chrome:debug:jobright, so logins survive). Fail closed — an
   * unattended process starting a browser is a mutation capability.
   */
  CDP_AUTOLAUNCH_ENABLED: boolFromEnv.default(false),
  DASHBOARD_HOST: z.string().default("127.0.0.1"),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(8788),
  /** Operator console (frontend + guarded mutation API). Localhost only. */
  CONSOLE_HOST: z.string().default("127.0.0.1"),
  CONSOLE_PORT: z.coerce.number().int().positive().default(8899),
  /**
   * Hosted console (docs/roadmap/cloud-deploy.md "Hosted-auth design").
   * Off (default): local security model byte-for-byte — loopback bind
   * assertion, Host pin, per-boot token. On: the console may bind a
   * public interface; EVERY /api request needs a Supabase Auth JWT
   * (verified against the project JWKS) whose `sub` is allowlisted, the
   * Host header must match CONSOLE_HOSTED_ALLOWED_HOSTS, and mutations
   * are refused (read-only). Requires SUPABASE_URL + both lists below;
   * refuses to boot otherwise.
   */
  CONSOLE_HOSTED_MODE_ENABLED: boolFromEnv.default(false),
  /** Comma-separated deployed hostnames accepted in the Host header (hosted mode). */
  CONSOLE_HOSTED_ALLOWED_HOSTS: z.string().default(""),
  /** Comma-separated auth.users UUIDs allowed to read this console (hosted mode). */
  CONSOLE_HOSTED_ALLOWED_USER_IDS: z.string().default(""),
  CANDIDATE_DATA_KEY_NAME: z
    .string()
    .default("jobright-application-agent/candidate-data-key"),
  ARTIFACTS_DIR: z.string().default("artifacts"),
  PRIVATE_DIR: z.string().default("private"),
  /**
   * Fallback resume auto-attached to an application that reaches the
   * materials stage with none registered (used by unattended L3 sessions
   * so a fresh discovery does not dead-end on a missing resume). Plain
   * path, not a capability flag; auto-attach is a no-op when the file is
   * absent.
   */
  DEFAULT_RESUME_PATH: z.string().default("private/candidate/resumes/default.pdf"),
  JSONL_EVENTS_PATH: z.string().default("data/events/applications.jsonl"),
  /** chrome = system Google Chrome (needed for Google OAuth). chromium = bundled. */
  BROWSER_CHANNEL: z.string().default("chrome"),
  /**
   * Cloud plane (split-plane v0.5, docs/roadmap/cloud-deploy.md): one-way
   * upsert of aggregate application status to Supabase. Network mutation
   * of the operator's cloud project ⇒ fail closed. Requires the three
   * SUPABASE_* settings below; refuses loudly without them.
   */
  SUPABASE_SYNC_ENABLED: boolFromEnv.default(false),
  /** Supabase project URL (https://<ref>.supabase.co). Plain setting. */
  SUPABASE_URL: z.string().optional(),
  /**
   * Service-role key. SECRET: never logged, never artifacted, never
   * shipped to any frontend — it exists only on the engine machine.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** auth.users UUID of the cloud account these engine rows belong to. */
  SUPABASE_SYNC_USER_ID: z.string().optional(),
  /**
   * Supabase personal access token (Account → Access Tokens). SECRET, used
   * only by `npm run cloud:schema -- apply` to run supabase/migrations/
   * through the Management API. Never logged; engine machine only.
   */
  SUPABASE_ACCESS_TOKEN: z.string().optional(),
});

export type AppConfig = {
  nodeEnv: string;
  databasePath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  dryRun: boolean;
  formFillEnabled: boolean;
  submitEnabled: boolean;
  submitRequiresLocalConfirmation: boolean;
  maxUnattendedSubmissionsPerRun: number;
  outlookDraftsEnabled: boolean;
  gmailDraftsEnabled: boolean;
  linkedinEnrichmentEnabled: boolean;
  jobrightAutofillEnabled: boolean;
  nativeAutofillEnabled: boolean;
  materialsDownloadEnabled: boolean;
  navigationEnabled: boolean;
  gmailVerificationEnabled: boolean;
  outlookVerificationEnabled: boolean;
  essayRequiredGateEnabled: boolean;
  emailGenerationEnabled: boolean;
  /** Present only when the operator configured it; consumers must not log it. */
  openaiApiKey: string | undefined;
  emailLlmModel: string;
  /** Present only when the operator configured it; consumers must not log it. */
  anthropicApiKey: string | undefined;
  anthropicLlmModel: string;
  anthropicApplierModel: string;
  /** Present only when the operator configured it; consumers must not log it. */
  moonshotApiKey: string | undefined;
  kimiLlmModel: string;
  llmProvider: "anthropic" | "openai" | "kimi" | undefined;
  jobrightExtensionId: string | undefined;
  agentAuthoringEnabled: boolean;
  screenerLlmMatchEnabled: boolean;
  screenerPredictLlmEnabled: boolean;
  artifactAutopushEnabled: boolean;
  essayDraftEnabled: boolean;
  /** Generate essay answers from about-me.md and FILL them. Also unlocked by SCREENER_PREDICT_LLM_ENABLED. */
  essayAutofillEnabled: boolean;
  agentFallbackEnabled: boolean;
  /** LLM failure triage: decide+record (fail closed). */
  triageLlmEnabled: boolean;
  /** LLM failure triage: execute validated decisions (fail closed; inert without triageLlmEnabled). */
  triageActEnabled: boolean;
  /** Enqueue from the ATSes' own public board APIs (D-rev). Fail closed. */
  atsDiscoveryEnabled: boolean;
  automationEnabled: boolean;
  agentCdpUrl: string;
  agentEngine: "browser_use" | "stagehand";
  cdpAutolaunchEnabled: boolean;
  verificationMailbox?: "gmail" | "outlook" | undefined;
  portalLoginEmail?: string | undefined;
  portalLoginPassword?: string | undefined;
  dashboardHost: string;
  dashboardPort: number;
  consoleHost: string;
  consolePort: number;
  /** Hosted console: Supabase-JWT auth + host allowlist + read-only. Fail closed. */
  consoleHostedModeEnabled: boolean;
  consoleHostedAllowedHosts: string[];
  consoleHostedAllowedUserIds: string[];
  candidateDataKeyName: string;
  artifactsDir: string;
  privateDir: string;
  defaultResumePath: string;
  jsonlEventsPath: string;
  browserChannel: BrowserChannel;
  /** One-way status mirror to Supabase (cloud plane). Fail closed. */
  supabaseSyncEnabled: boolean;
  supabaseUrl: string | undefined;
  /** Present only when the operator configured it; consumers must not log it. */
  supabaseServiceRoleKey: string | undefined;
  supabaseSyncUserId: string | undefined;
  /** Present only when the operator configured it; consumers must not log it. */
  supabaseAccessToken: string | undefined;
  /** Always false — no send capability exists. */
  emailSendEnabled: false;
};

let cached: AppConfig | undefined;

/** Comma/whitespace-separated list → trimmed, lowercased, de-duplicated. */
function splitList(raw: string): string[] {
  return [...new Set(raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  if (parsed.DASHBOARD_HOST !== "127.0.0.1" && parsed.DASHBOARD_HOST !== "localhost") {
    throw new Error(
      `DASHBOARD_HOST must be 127.0.0.1 or localhost (got ${parsed.DASHBOARD_HOST})`,
    );
  }
  const hostedAllowedHosts = splitList(parsed.CONSOLE_HOSTED_ALLOWED_HOSTS);
  const hostedAllowedUserIds = splitList(parsed.CONSOLE_HOSTED_ALLOWED_USER_IDS);
  if (!parsed.CONSOLE_HOSTED_MODE_ENABLED) {
    // Local mode: the loopback assertion, unchanged.
    if (parsed.CONSOLE_HOST !== "127.0.0.1" && parsed.CONSOLE_HOST !== "localhost") {
      throw new Error(
        `CONSOLE_HOST must be 127.0.0.1 or localhost (got ${parsed.CONSOLE_HOST})`,
      );
    }
  } else {
    // Hosted mode is additive and fail-closed: a public bind with any of
    // its inputs missing must not boot at all.
    const missing: string[] = [];
    if (!parsed.SUPABASE_URL) missing.push("SUPABASE_URL");
    if (hostedAllowedHosts.length === 0) missing.push("CONSOLE_HOSTED_ALLOWED_HOSTS");
    if (hostedAllowedUserIds.length === 0) missing.push("CONSOLE_HOSTED_ALLOWED_USER_IDS");
    if (missing.length > 0) {
      throw new Error(
        `CONSOLE_HOSTED_MODE_ENABLED=true requires ${missing.join(", ")} (hosted console is fail-closed)`,
      );
    }
  }

  const forbiddenSendFlag = ["EMAIL", "SEND", "ENABLED"].join("_");
  if (env[forbiddenSendFlag] !== undefined) {
    throw new Error(
      `${forbiddenSendFlag} is forbidden. Outlook supports drafts only.`,
    );
  }
  const forbiddenGmailFlag = ["GMAIL", "SEND", "ENABLED"].join("_");
  if (env[forbiddenGmailFlag] !== undefined) {
    throw new Error(
      `${forbiddenGmailFlag} is forbidden. Gmail is readonly verification only.`,
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    databasePath: path.resolve(parsed.DATABASE_PATH),
    logLevel: parsed.LOG_LEVEL,
    dryRun: parsed.DRY_RUN,
    formFillEnabled: parsed.FORM_FILL_ENABLED,
    submitEnabled: parsed.SUBMIT_ENABLED,
    submitRequiresLocalConfirmation: parsed.SUBMIT_REQUIRES_LOCAL_CONFIRMATION,
    maxUnattendedSubmissionsPerRun: parsed.MAX_UNATTENDED_SUBMISSIONS_PER_RUN,
    outlookDraftsEnabled: parsed.OUTLOOK_DRAFTS_ENABLED,
    gmailDraftsEnabled: parsed.GMAIL_DRAFTS_ENABLED,
    linkedinEnrichmentEnabled: parsed.LINKEDIN_ENRICHMENT_ENABLED,
    jobrightAutofillEnabled: parsed.JOBRIGHT_AUTOFILL_ENABLED,
    nativeAutofillEnabled: parsed.NATIVE_AUTOFILL_ENABLED,
    materialsDownloadEnabled: parsed.MATERIALS_DOWNLOAD_ENABLED,
    navigationEnabled: parsed.NAVIGATION_ENABLED,
    gmailVerificationEnabled: parsed.GMAIL_VERIFICATION_ENABLED,
    outlookVerificationEnabled: parsed.OUTLOOK_VERIFICATION_ENABLED,
    essayRequiredGateEnabled: parsed.ESSAY_REQUIRED_GATE_ENABLED,
    emailGenerationEnabled: parsed.EMAIL_GENERATION_ENABLED,
    openaiApiKey: parsed.OPENAI_API_KEY,
    emailLlmModel: parsed.EMAIL_LLM_MODEL,
    anthropicApiKey: parsed.ANTHROPIC_API_KEY,
    anthropicLlmModel: parsed.ANTHROPIC_LLM_MODEL,
    anthropicApplierModel:
      parsed.ANTHROPIC_APPLIER_MODEL ?? parsed.ANTHROPIC_LLM_MODEL,
    moonshotApiKey: parsed.MOONSHOT_API_KEY,
    kimiLlmModel: parsed.KIMI_LLM_MODEL,
    llmProvider: parsed.LLM_PROVIDER,
    jobrightExtensionId: parsed.JOBRIGHT_EXTENSION_ID,
    agentAuthoringEnabled: parsed.AGENT_AUTHORING_ENABLED,
    screenerLlmMatchEnabled: parsed.SCREENER_LLM_MATCH_ENABLED,
    screenerPredictLlmEnabled: parsed.SCREENER_PREDICT_LLM_ENABLED,
    artifactAutopushEnabled: parsed.ARTIFACT_AUTOPUSH_ENABLED,
    essayDraftEnabled: parsed.ESSAY_DRAFT_ENABLED,
    essayAutofillEnabled: parsed.ESSAY_AUTOFILL_ENABLED,
    agentFallbackEnabled: parsed.AGENT_FALLBACK_ENABLED,
    triageLlmEnabled: parsed.TRIAGE_LLM_ENABLED,
    triageActEnabled: parsed.TRIAGE_ACT_ENABLED,
    atsDiscoveryEnabled: parsed.ATS_DISCOVERY_ENABLED,
    automationEnabled: parsed.AUTOMATION_ENABLED,
    agentCdpUrl: parsed.AGENT_CDP_URL,
    agentEngine: parsed.AGENT_ENGINE,
    cdpAutolaunchEnabled: parsed.CDP_AUTOLAUNCH_ENABLED,
    verificationMailbox: parsed.VERIFICATION_MAILBOX,
    portalLoginEmail: parsed.PORTAL_LOGIN_EMAIL,
    portalLoginPassword: parsed.PORTAL_LOGIN_PASSWORD,
    dashboardHost: parsed.DASHBOARD_HOST,
    dashboardPort: parsed.DASHBOARD_PORT,
    consoleHost: parsed.CONSOLE_HOST,
    consolePort: parsed.CONSOLE_PORT,
    consoleHostedModeEnabled: parsed.CONSOLE_HOSTED_MODE_ENABLED,
    consoleHostedAllowedHosts: hostedAllowedHosts,
    consoleHostedAllowedUserIds: hostedAllowedUserIds,
    candidateDataKeyName: parsed.CANDIDATE_DATA_KEY_NAME,
    artifactsDir: path.resolve(parsed.ARTIFACTS_DIR),
    privateDir: path.resolve(parsed.PRIVATE_DIR),
    defaultResumePath: path.resolve(parsed.DEFAULT_RESUME_PATH),
    jsonlEventsPath: path.resolve(parsed.JSONL_EVENTS_PATH),
    browserChannel: parseBrowserChannel(parsed.BROWSER_CHANNEL),
    supabaseSyncEnabled: parsed.SUPABASE_SYNC_ENABLED,
    supabaseUrl: parsed.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    supabaseSyncUserId: parsed.SUPABASE_SYNC_USER_ID,
    supabaseAccessToken: parsed.SUPABASE_ACCESS_TOKEN,
    emailSendEnabled: false,
  };
}

export function getConfig(): AppConfig {
  if (!cached) {
    cached = loadConfig();
  }
  return cached;
}

export function resetConfigCache(): void {
  cached = undefined;
}

export function deriveRolloutStage(config: AppConfig): 1 | 2 | 3 | 4 | 5 {
  if (!config.formFillEnabled) return 1;
  if (!config.submitEnabled) return 2;
  if (config.submitRequiresLocalConfirmation) return 3;
  if (config.maxUnattendedSubmissionsPerRun > 0) return 4;
  return 5;
}
