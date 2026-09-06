import type { EmailLlmClient } from "../contacts/emailLlm.js";
import type { TriageEvidenceBundle } from "./evidenceBundle.js";
import { TRIAGE_ACTIONS, type TriageAction } from "./actions.js";

/**
 * The LLM's entire authority here is choosing ONE action from the
 * enumerated set. Set membership is re-checked verbatim after the call
 * (the screenerOptionSelect precedent), forbidden actions are re-checked
 * even though the prompt lists them, and per-action preconditions run
 * before any executor. A parse/validation failure is not an error — it is
 * a `no_action` decision with the failure recorded.
 */

const MAX_RATIONALE_CHARS = 400;

export type TriageChoice = {
  action: TriageAction;
  rationale: string;
  confidence: "high" | "medium" | "low";
  /** Why validation downgraded the model's raw output, when it did. */
  validation_note: string | null;
  raw_text: string;
  model: string;
};

const SYSTEM_PROMPT = [
  "You are the failure-triage layer of a job-application automation system.",
  "An application run failed; you receive the structured evidence and must",
  "choose exactly ONE remediation action from the enumerated list. You are",
  "choosing WHAT to do next, not doing it — every choice is re-validated",
  "and executed by deterministic code with its own safety gates.",
  "",
  "Action meanings:",
  "- no_action: nothing useful to do; leave the application as it is.",
  "- park_for_operator: a human must decide; open a review item.",
  "- requeue_same: the failure looks transient — run the same pipeline again.",
  "- requeue_materials: resume/materials look stale or missing — regenerate, then rerun.",
  "- requeue_reopen_navigation: the stored employer URL looks wrong/stale — clear it and re-resolve navigation.",
  "- abandon_duplicate: the evidence shows this posting is already owned by another application — abandon this one.",
  "- abandon_permanent_wall: the host has repeatedly blocked automation (login/captcha wall) with no path through — abandon.",
  "- engage_agent_leg: deterministic navigation exhausted its tiers — grant the browser agent one bounded attempt on the next run.",
  "",
  "Rules:",
  "- NEVER choose an action listed as forbidden — those were tried for this",
  "  exact failure signature and did not fix it, or were refuted by outcome.",
  "  Repeating them is the blind-retry behavior you exist to eliminate.",
  "- Prefer the cheapest action that plausibly changes the outcome; when",
  "  nothing would, prefer park_for_operator or no_action over a requeue.",
  "- Never invent facts not present in the evidence.",
  'Respond with ONLY a JSON object: {"action": "<one action verbatim>",',
  '"rationale": "<=400 chars", "confidence": "high"|"medium"|"low"}.',
].join("\n");

export function buildTriagePrompt(
  bundle: TriageEvidenceBundle,
  forbiddenActions: TriageAction[],
): { system: string; user: string } {
  const allowed = TRIAGE_ACTIONS.filter((a) => !forbiddenActions.includes(a));
  const user = JSON.stringify(
    {
      allowed_actions: allowed,
      forbidden_actions: forbiddenActions,
      evidence: bundle,
    },
    null,
    1,
  );
  return { system: SYSTEM_PROMPT, user };
}

function fallback(
  note: string,
  rawText: string,
  model: string,
): TriageChoice {
  return {
    action: "no_action",
    rationale: "",
    confidence: "low",
    validation_note: note,
    raw_text: rawText.slice(0, 2000),
    model,
  };
}

export function parseTriageResponse(
  rawText: string,
  model: string,
  forbiddenActions: TriageAction[],
): TriageChoice {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""),
    );
  } catch {
    return fallback("response is not valid JSON", rawText, model);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return fallback("response is not a JSON object", rawText, model);
  }
  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  if (typeof action !== "string") {
    return fallback("missing action", rawText, model);
  }
  if (!(TRIAGE_ACTIONS as readonly string[]).includes(action)) {
    return fallback(`unknown action "${action.slice(0, 60)}"`, rawText, model);
  }
  if (forbiddenActions.includes(action as TriageAction)) {
    return fallback(
      `action "${action}" is forbidden for this signature`,
      rawText,
      model,
    );
  }
  const confidence =
    obj.confidence === "high" || obj.confidence === "medium"
      ? obj.confidence
      : "low";
  const rationale =
    typeof obj.rationale === "string"
      ? obj.rationale.slice(0, MAX_RATIONALE_CHARS)
      : "";
  return {
    action: action as TriageAction,
    rationale,
    confidence,
    validation_note: null,
    raw_text: rawText.slice(0, 2000),
    model,
  };
}

export async function chooseTriageAction(
  client: EmailLlmClient,
  bundle: TriageEvidenceBundle,
  forbiddenActions: TriageAction[],
): Promise<TriageChoice> {
  const { system, user } = buildTriagePrompt(bundle, forbiddenActions);
  let text = "";
  let model = "unknown";
  try {
    const out = await client.generateJson({ system, user, effort: "low" });
    text = out.text;
    model = out.model;
  } catch (err) {
    return fallback(
      `llm call failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`,
      "",
      model,
    );
  }
  return parseTriageResponse(text, model, forbiddenActions);
}
