import { getConfig, type AppConfig } from "../../config/index.js";
import { sdkBrowserUseApi, type BrowserUseApi } from "./api.js";
import { fileLedger, type Ledger } from "./ledger.js";
import type { RunPolicy } from "./runs.js";

/**
 * The flag-checked entry points. Everything else in this directory takes
 * an explicit BrowserUseApi so it can be tested against a fake.
 */

/** The production client, or a refusal by name (never a client without a key). */
export function resolveBrowserUseApi(config: AppConfig = getConfig()): BrowserUseApi {
  if (!config.browserUseEnabled) {
    throw new Error("browser_use refused: BROWSER_USE_ENABLED is false (fail-closed default).");
  }
  if (!config.browserUseApiKey) {
    throw new Error("browser_use refused: BROWSER_USE_API_KEY is not set (env.ts refuses this at boot).");
  }
  return sdkBrowserUseApi({ apiKey: config.browserUseApiKey });
}

export function browserUseRunPolicy(config: AppConfig = getConfig()): RunPolicy {
  return {
    agentEnabled: config.browserUseEnabled && config.browserUseAgentEnabled,
    model: config.browserUseModel,
    maxCostUsd: config.browserUseMaxCostUsd,
  };
}

export function browserUseLedger(config: AppConfig = getConfig()): Ledger {
  return fileLedger(config.privateDir);
}

export * from "./api.js";
export * from "./ledger.js";
export * from "./provider.js";
export * from "./runs.js";
