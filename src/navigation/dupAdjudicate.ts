import { getConfig } from "../config/index.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";

/**
 * M7 of the LLM decision layer: when the duplicate gate fires and the
 * holder's (company, role) text differs from this job's identity (the
 * night25 btcpa case — one real UKG job attributed to two CPA firms by
 * JobRight), record a same-job/different-job judgment as EVIDENCE on the
 * report and review payload. It never unblocks anything by itself: a
 * `same_job` verdict feeds the (shadow-first) abandon_duplicate triage
 * action; `different_job`/`unsure` park exactly as before, one glance
 * instead of an investigation for the operator.
 * Gated by NAV_LLM_ASSIST_ENABLED (fail closed).
 */

export type DupAdjudication = {
  verdict: "same_job" | "different_job" | "unsure";
  rationale: string;
};

const SYSTEM_PROMPT = [
  "Two job-application records resolved to the same employer application",
  "URL. Decide whether they are the SAME real-world job posting listed",
  "twice (aggregators often re-attribute one posting to similarly-named",
  "companies) or genuinely different jobs that happen to share a portal",
  "URL. Company-name similarity, identical role titles, and a shared ATS",
  "tenant are the signals. When the evidence is thin, say unsure.",
  'Respond with ONLY JSON: {"verdict": "same_job" | "different_job" |',
  '"unsure", "rationale": "<=200 chars"}.',
].join("\n");

export async function adjudicateDuplicate(input: {
  company: string | null;
  role: string | null;
  url: string;
  holders: Array<{ company: string; role: string; state: string }>;
  client?: EmailLlmClient | undefined;
}): Promise<{ adjudication: DupAdjudication | null; note: string }> {
  const cfg = getConfig();
  if (!cfg.navLlmAssistEnabled) {
    return { adjudication: null, note: "NAV_LLM_ASSIST_ENABLED off" };
  }
  const client = input.client ?? (hasLlmKey(cfg) ? makeLlmClient("applier") : null);
  if (!client) {
    return { adjudication: null, note: "no LLM key configured" };
  }

  let text = "";
  try {
    const out = await client.generateJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify(
        {
          this_job: { company: input.company, role: input.role },
          shared_url: input.url,
          holders: input.holders.slice(0, 5),
        },
        null,
        1,
      ),
      effort: "low",
    });
    text = out.text;
  } catch (err) {
    return {
      adjudication: null,
      note: `dup adjudication llm failed: ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(
      text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    return { adjudication: null, note: "dup adjudication: invalid JSON" };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const rationale =
    typeof obj.rationale === "string" ? obj.rationale.slice(0, 200) : "";
  // Set membership; anything unexpected demotes to unsure — the verdict is
  // evidence, and "unsure" changes nothing downstream.
  const verdict =
    obj.verdict === "same_job" || obj.verdict === "different_job"
      ? obj.verdict
      : "unsure";
  return {
    adjudication: { verdict, rationale },
    note: `dup adjudication: ${verdict}`,
  };
}
