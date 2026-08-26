/**
 * S-spike: engine selection for the navigate sidecar. Two engines speak
 * the SAME stdin/stdout contract (src/agent/contract.ts) over the SAME
 * operator-CDP seam:
 *
 *   browser_use — the incumbent Python sidecar (agent/jobright_agent),
 *                 sidecarRunner's default command; and
 *   stagehand   — a Node sidecar (agent/stagehand/navigate.mjs) driving
 *                 Stagehand's DOM agent, installed separately so the main
 *                 package.json's three-dependency stance is untouched.
 *
 * The selector is a plain setting (AGENT_ENGINE), not a capability flag:
 * whether ANY agent runs is still gated by AGENT_FALLBACK_ENABLED, and
 * the contract validation + final_url rejection in navigate.ts apply to
 * both engines identically — an engine's self-report is never trusted.
 * Promotion from spike to default follows the pre-registered bar in
 * docs/agent-engine-decision.md, never a vibe.
 */

export type AgentEngine = "browser_use" | "stagehand";

/**
 * Command override for the chosen engine, or null to use sidecarRunner's
 * default (the Python browser_use sidecar). Paths are relative to the
 * runner's cwd, which is agent/.
 */
export function resolveAgentEngineCommand(
  engine: AgentEngine,
): { command: string; args: string[] } | null {
  if (engine === "stagehand") {
    return { command: "node", args: ["stagehand/navigate.mjs"] };
  }
  return null;
}
