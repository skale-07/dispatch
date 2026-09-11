import { getConfig } from "../config/index.js";
import { logger } from "../logging/logger.js";
import {
  hasLlmKey,
  makeLlmClient,
  type EmailLlmClient,
} from "../contacts/emailLlm.js";
import { llmTraceEvent, postSandboxTrace } from "../sandbox/trace.js";
import {
  MIN_WORDS_BY_SHAPE,
  expectedAnswerShape,
  tryLoadAboutMe,
  validateDraft,
} from "./essayDraft.js";

/**
 * Questions the model must never answer, checked before any call (#221).
 * These fill from the operator's encrypted sensitive profile or stay
 * empty — never from generated prose. Kept deliberately broad: a false
 * positive costs one parked field, a false negative writes an invented
 * demographic or authorization claim to an employer.
 */
/**
 * Questions no model may answer (demographic / authorization / criminal /
 * compensation). Shared with the screener predict tier (#259).
 */
export const SENSITIVE_QUESTION =
  /\b(rac(e|ial)|ethnic(ity)?|hispanic|latino|gender|sex|pronouns?|veteran|disabilit(y|ies)|disabled|sexual orientation|transgender|citizen(ship)?|visa|sponsorship|work authoriz(ation|ed)|authorized to work|felony|convict(ed|ion)|criminal|salary|compensation|pay expectation|desired pay|date of birth|\bage\b)\b/i;

/**
 * Essay autofill (operator directive 2026-08-13: "Essays should be
 * autofilled since the LLM can generate it based on my context. EVERYTHING
 * should be filled on the application… that's a trade off I am willing to
 * make").
 *
 * This CHANGES a documented invariant, so it is written to be inspectable
 * rather than quiet:
 *
 *   - Fail-closed: ESSAY_AUTOFILL_ENABLED or SCREENER_PREDICT_LLM_ENABLED
 *     (operator directive 2026-08-15: essays fill on the same LLM path
 *     already trusted for screeners). Also requires about-me.md. No
 *     context ⇒ nothing is invented; the essay parks with the real reason.
 *   - Generated text passes the SAME validator the review-drafting path
 *     uses (validateDraft: length bounds, no placeholder brackets, no
 *     model self-reference). A rejected draft parks; it never fills.
 *   - Every generated answer is recorded on the fill-plan entry with
 *     action "fill_essay_generated" and lands in the run artifact, so what
 *     was written to an employer is always readable afterwards.
 *
 * The honest risk, stated once: essay prose is what a human reads. A model
 * writing from about-me.md can still phrase a claim more strongly than the
 * source supports, and unlike a dropdown that is not verifiable by
 * read-back. The mitigation is the artifact — check the first few.
 */

const SYSTEM_PROMPT = `You write a job applicant's answer to an application essay question, in their voice, using ONLY the context they provide.

Rules:
- Facts about the CANDIDATE come ONLY from candidate_context. Never invent an employer, a school, a metric, a date, or a project.
- posting_context (when present) is text taken from the employer's own posting and application pages — the company name, the role, what the team does. Use it to know who the employer is and to connect the candidate's real background to the role ("why us" reasoning). Never invent employer facts beyond it.
- If neither context supports an answer, return null. A missing answer is far better than an invented one.
- PREFERENCE and CHOICE questions are different from factual ones: ranking an employer's offices, which team or track interests you, an earliest start date, "why this company". The candidate context will not state these, and returning null leaves a REQUIRED field blank and blocks the application. Answer them: pick a reasonable position grounded in what candidate_context does show (where they live, what they study, what they have built) and state it plainly, with no hedging about how mild the preference is. Return null only when answering would require inventing a fact about their history, credentials, or authorization.
- Match the length the question asks for. A ranking, a date, or a single choice is one sentence — never pad it to reach a word count.
- You receive EVERY question on one application form together. Answer each one, and make them work as a set: never reuse the same project or anecdote twice, and for "Second/Third example" style follow-ups give genuinely different material from the sibling answers in the same response.
- Each question carries an "expects" hint: "short" means a ranking, date or single choice — answer in one sentence; "essay" means prose.
- Write first person, plain and specific. No preamble, no sign-off, no headings.
- 90-200 words for an essay question; far less for a preference, ranking, date, or single-choice question.
- Do not mention being an AI, and do not use bracketed placeholders.

Respond with JSON only, one entry per question, each key copied verbatim from the question it answers:
{"answers":[{"key":"q1","answer":"<text>"},{"key":"q2","answer":null}]}`;

export type EssayAutofillItem = {
  fieldId: string;
  question: string;
};

/** Bounded: posting context is a grounding aid, not a document dump. */
export const MAX_POSTING_CONTEXT_CHARS = 900;

/**
 * Deterministically harvest "who is this employer / what is this role" text
 * from a page the flow has already seen: title, headings, meta description,
 * and short paragraphs. No LLM, no network — string extraction only. Form
 * chrome (labels, options, buttons) is excluded so the result reads like a
 * posting, not like the questionnaire we are about to answer.
 *
 * Live artifact 1787010568814/1787010626392: "Why Frobnicator?" was asked
 * with company=null, role=null and no posting text — the model (correctly,
 * per its grounding rules) abstained, and the essay went to the employer
 * BLANK even though the pages the flow walked named the company, the role,
 * and the location. This function is that missing channel.
 */
export function extractPostingContext(html: string): string {
  const stripTags = (s: string): string =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&nbsp;/gi, " ")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  // Drop scripts/styles first, then form internals — a <p> INSIDE the form
  // is fill-machinery commentary, not posting copy.
  const page = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | undefined): void => {
    const text = stripTags(raw ?? "");
    if (text.length < 3) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };
  push(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(page)?.[1]);
  push(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i.exec(
      page,
    )?.[1],
  );
  for (const m of page.matchAll(/<h[123][^>]*>([\s\S]*?)<\/h[123]>/gi)) {
    push(m[1]);
  }
  for (const m of page.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    push(m[1]);
  }
  return parts.join("\n").slice(0, MAX_POSTING_CONTEXT_CHARS);
}

/** Merge page extracts gathered along the flow (posting → outer → form). */
export function mergePostingContext(
  ...extracts: Array<string | null | undefined>
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const e of extracts) {
    for (const line of (e ?? "").split("\n")) {
      const t = line.trim();
      if (t.length < 3) continue;
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(t);
    }
  }
  return lines.join("\n").slice(0, MAX_POSTING_CONTEXT_CHARS);
}

export type EssayAutofillResult = {
  fieldId: string;
  question: string;
  answer: string;
};

/** Bounded: a form with 20 essays is a form a human should look at. */
const MAX_ESSAYS = 6;

export function essayAutofillAvailable(): { ok: boolean; reason: string } {
  const cfg = getConfig();
  if (!cfg.essayAutofillEnabled && !cfg.screenerPredictLlmEnabled) {
    return {
      ok: false,
      reason:
        "ESSAY_AUTOFILL_ENABLED and SCREENER_PREDICT_LLM_ENABLED are both off",
    };
  }
  if (!tryLoadAboutMe()) {
    return {
      ok: false,
      reason:
        "private/candidate/about-me.md missing or too short — nothing to write from",
    };
  }
  if (!hasLlmKey(cfg)) {
    return { ok: false, reason: "no LLM provider key configured" };
  }
  return { ok: true, reason: "ok" };
}

export async function generateEssayAnswers(input: {
  items: EssayAutofillItem[];
  job?: { company: string; role: string } | null;
  /** Page-derived employer/role text (extractPostingContext / merge). */
  postingContext?: string;
  client?: EmailLlmClient;
  traceUrl?: string;
  approvedContext?: string;
}): Promise<{ answers: EssayAutofillResult[]; notes: string[] }> {
  const notes: string[] = [];
  const items = input.items.slice(0, MAX_ESSAYS);
  if (items.length === 0) return { answers: [], notes };

  const available = essayAutofillAvailable();
  if (!available.ok && !input.client) {
    notes.push(`essay autofill skipped: ${available.reason}`);
    return { answers: [], notes };
  }
  const about = tryLoadAboutMe();
  if (!about) {
    notes.push("essay autofill skipped: no about-me context");
    return { answers: [], notes };
  }

  const client = input.client ?? makeLlmClient("applier");
  const answers: EssayAutofillResult[] = [];
  // #222 (operator directive 2026-09-09: "send the questions in batches …
  // so you're not sending a bunch of prompts and only sending one"): ONE
  // call carries every answerable question on this form. Beyond the token
  // saving (the about-me block was resent per question), the model sees
  // the whole questionnaire at once — which is what actually makes a
  // "Second example:" follow-up different from its sibling. The old loop
  // had to replay previous answers to approximate that.
  //
  // Follow-up shape (live neuralink 2026-08-30): "We look for evidence of
  // exceptional ability… 3-4 examples" then bare "Second example:" /
  // "Third example:" — a bare follow-up still carries its parent question
  // so the model knows what is being asked.
  const askable: Array<{ key: string; item: EssayAutofillItem; question: string }> = [];
  let parentQuestion: string | null = null;
  for (const [index, item] of items.entries()) {
    // #221 safety (house rule: "Demographic / EEO / pronoun fields never
    // take this path"). Essay items are the questions FIELD MAPPING could
    // not claim, so a mis-mapped demographic question can arrive here —
    // #213 was exactly that ("How would you describe your racial/ethnic
    // background?" went unmapped). Those are answered from the operator's
    // encrypted sensitive profile or not at all; the model never sees
    // them, so this is a deterministic skip BEFORE the call, not a prompt
    // rule. Same for work authorization, salary, age and criminal history.
    if (SENSITIVE_QUESTION.test(item.question)) {
      notes.push(
        `essay skipped (never model-answered): ${item.question.slice(0, 80)} — demographic/authorization/compensation questions fill only from the sensitive profile`,
      );
      continue;
    }
    const isFollowUp = /^(first|second|third|fourth|fifth|next|another)?\s*(example|answer|response)\s*:?\s*$/i.test(
      item.question.trim(),
    );
    if (!isFollowUp && item.question.trim().length >= 40) {
      parentQuestion = item.question.trim();
    }
    askable.push({
      key: `q${index + 1}`,
      item,
      question:
        isFollowUp && parentQuestion
          ? `${parentQuestion} — ${item.question.trim()}`
          : item.question,
    });
  }

  if (askable.length > 0) {
    // about-me is identical for every question in every application, and
    // the posting is stable across one application's questions — both ride
    // as cacheable context blocks, so only the question list varies.
    // Effort is left at the provider default: this is prose a human reads,
    // and validateDraft cannot catch a weak answer.
    const context = [
      JSON.stringify({ candidate_context: about }),
      JSON.stringify({
        company: input.job?.company ?? null,
        role: input.job?.role ?? null,
        posting_context: input.postingContext?.trim() || null,
      }),
    ];
    if (input.approvedContext) {
      context.push(JSON.stringify({ approved_application_context: input.approvedContext }));
    }
    const payload = {
      questions: askable.map((a) => ({
        key: a.key,
        question: a.question,
        expects: expectedAnswerShape(a.question),
      })),
    };
    try {
      const { text } = await client.generateJson({
        system: SYSTEM_PROMPT,
        context,
        user: JSON.stringify(payload),
      });
      if (input.traceUrl) {
        await postSandboxTrace(
          input.traceUrl,
          llmTraceEvent({
            surface: "essay",
            system: SYSTEM_PROMPT,
            user: [...context, JSON.stringify(payload)].join("\n"),
            response: text,
          }),
        );
      }
      const parsed = JSON.parse(text) as {
        answers?: Array<{ key?: unknown; answer?: unknown }>;
      };
      const byKey = new Map(askable.map((a) => [a.key, a]));
      const seen = new Set<string>();
      for (const row of parsed.answers ?? []) {
        if (typeof row?.key !== "string") continue;
        const target = byKey.get(row.key);
        // A key the model invented answers no field on this form.
        if (!target || seen.has(row.key)) continue;
        seen.add(row.key);
        if (row.answer === null || row.answer === undefined) {
          notes.push(
            `essay not answered (model abstained): ${target.item.question.slice(0, 80)}`,
          );
          continue;
        }
        // Same validator as the human-review drafting path — a generated
        // answer good enough to fill must be good enough to show a human.
        // #221: the word floor follows the question's shape, so a correct
        // one-line ranking is no longer rejected as "too short".
        const check = validateDraft(row.answer, {
          minWords: MIN_WORDS_BY_SHAPE[expectedAnswerShape(target.question)],
        });
        if (!check.ok) {
          notes.push(
            `essay draft rejected (${check.reason}): ${target.item.question.slice(0, 80)}`,
          );
          continue;
        }
        answers.push({
          fieldId: target.item.fieldId,
          question: target.item.question,
          answer: (row.answer as string).trim(),
        });
      }
      for (const a of askable) {
        if (!seen.has(a.key)) {
          notes.push(
            `essay not returned by the model: ${a.item.question.slice(0, 80)}`,
          );
        }
      }
    } catch (err) {
      notes.push(
        `essay generation failed (parks as before): ${err instanceof Error ? err.message.slice(0, 140) : String(err)}`,
      );
    }
  }
  logger.info("essay autofill", {
    service: "essays",
    action: "autofill",
    metadata: { asked: items.length, answered: answers.length },
  });
  return { answers, notes };
}
