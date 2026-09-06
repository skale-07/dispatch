import { getConfig } from "../config/index.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";

/**
 * M6 of the LLM decision layer: when phase A harvested candidate apply
 * hrefs but none passed deterministically AND phase B's Apply click also
 * resolved nothing, the model may PROMOTE one already-harvested candidate.
 * It cannot mint URLs: the choice is validated by exact set membership,
 * and the promoted URL flows through the unchanged downstream pipe
 * (congruence recorded, duplicate gate, ATS detection, store policy).
 * Gated by NAV_LLM_ASSIST_ENABLED (fail closed).
 */

const MAX_CANDIDATES = 8;

export type AnchorAdjudication = {
  /** Exactly one of the candidate URLs, verbatim — or null (abstain). */
  choice: string | null;
  rationale: string;
  note: string;
};

const SYSTEM_PROMPT = [
  "You choose which link on a job posting page is the employer's own",
  "application link. You receive the company, the role, and a candidate",
  "list of external URLs harvested from the page (with the deterministic",
  "identity check's verdict per URL). Choose the single URL most likely",
  "to be the employer's application page for THIS job, or null when none",
  "plausibly is (news articles, social profiles, aggregator reposts are",
  "never the answer). You may only choose from the candidates array,",
  "returned EXACTLY as it appears there.",
  'Respond with ONLY JSON: {"choice": "<candidate URL verbatim>" | null,',
  '"rationale": "<=200 chars"}.',
].join("\n");

export async function adjudicateAnchorCandidates(input: {
  company: string | null;
  role: string | null;
  candidates: Array<{ url: string; congruence: string | null; detail: string | null }>;
  client?: EmailLlmClient | undefined;
}): Promise<AnchorAdjudication> {
  const cfg = getConfig();
  if (!cfg.navLlmAssistEnabled) {
    return { choice: null, rationale: "", note: "NAV_LLM_ASSIST_ENABLED off" };
  }
  const candidates = input.candidates.slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { choice: null, rationale: "", note: "no candidates to adjudicate" };
  }
  const client = input.client ?? (hasLlmKey(cfg) ? makeLlmClient("applier") : null);
  if (!client) {
    return { choice: null, rationale: "", note: "no LLM key configured" };
  }

  let text = "";
  try {
    const out = await client.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(
        { company: input.company, role: input.role, candidates },
        null,
        1,
      ),
      effort: "low",
    });
    text = out.text;
  } catch (err) {
    return {
      choice: null,
      rationale: "",
      note: `anchor adjudication llm failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    return { choice: null, rationale: "", note: "anchor adjudication: invalid JSON" };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.slice(0, 200) : "";
  if (obj.choice === null || obj.choice === undefined) {
    return { choice: null, rationale, note: "anchor adjudication: model abstained" };
  }
  // Verbatim set membership — the model can only promote a harvested href.
  const member = candidates.find((c) => c.url === obj.choice);
  if (!member) {
    return {
      choice: null,
      rationale,
      note: "anchor adjudication: choice not in the candidate set — rejected",
    };
  }
  return {
    choice: member.url,
    rationale,
    note: `anchor adjudication: promoted ${new URL(member.url).hostname}`,
  };
}
