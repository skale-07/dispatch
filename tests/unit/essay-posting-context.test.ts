import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  extractPostingContext,
  generateEssayAnswers,
  mergePostingContext,
  MAX_POSTING_CONTEXT_CHARS,
} from "../../src/applications/essayAutofill.js";
import { fillHardOuterPage } from "../../src/sandbox/hardPages.js";
import type {
  EmailLlmClient,
  LlmGenerateInput,
} from "../../src/contacts/emailLlm.js";
import { resetConfigCache } from "../../src/config/index.js";
import { useIsolatedFillEnv } from "../helpers/fillEnvIsolation.js";

/**
 * What the model actually sees. The payload is split across cacheable
 * context blocks (candidate + posting, stable across a batch) and the
 * per-call user turn (question, sibling answers); these assertions care
 * that the FIELD reaches the model, not which block carries it.
 */
function modelPayload(input: LlmGenerateInput): Record<string, unknown> {
  return [...(input.context ?? []), input.user].reduce<Record<string, unknown>>(
    (acc, block) => Object.assign(acc, JSON.parse(block) as object),
    {},
  );
}

/**
 * Posting context for essays (live artifacts 1787010568814/1787010626392):
 * "Why Frobnicator?" was asked with company=null, role=null, and no
 * posting text — the model abstained per its grounding rules and the
 * essay went to the employer BLANK, even though the pages the flow walked
 * named the company, role, and location. These tests pin the harvest and
 * the payload channel that close that gap.
 */
describe("extractPostingContext (UNIT_CONFIRMED)", () => {
  it("harvests title, headings, meta description, and paragraphs", () => {
    const html = `<html><head>
      <title>Careers at Frobnicator</title>
      <meta name="description" content="Frobnicator builds industrial widget tooling." />
      </head><body>
      <h1>Machine Intelligence Intern</h1>
      <p>Frobnicator Industries — Strongsville, OH. Hybrid.</p>
      <form><label>First Name</label><input/><p>form commentary stays out</p></form>
    </body></html>`;
    const out = extractPostingContext(html);
    expect(out).toContain("Careers at Frobnicator");
    expect(out).toContain("Machine Intelligence Intern");
    expect(out).toContain("Strongsville, OH");
    expect(out).toContain("industrial widget tooling");
    // Form internals are questionnaire chrome, not posting copy.
    expect(out).not.toContain("form commentary");
    expect(out).not.toContain("First Name");
  });

  it("the sandbox fillhard OUTER page names the company the embed does not", () => {
    const out = extractPostingContext(fillHardOuterPage());
    expect(out).toContain("Frobnicator");
  });

  it("is bounded and dedupes across merged pages", () => {
    const big = `<h1>${"x".repeat(5000)}</h1>`;
    expect(extractPostingContext(big).length).toBeLessThanOrEqual(
      MAX_POSTING_CONTEXT_CHARS,
    );
    const a = "Careers at Frobnicator\nMachine Intelligence Intern";
    const b = "machine intelligence intern\nStrongsville, OH";
    const merged = mergePostingContext(a, b, null, undefined);
    expect(merged.split("\n")).toEqual([
      "Careers at Frobnicator",
      "Machine Intelligence Intern",
      "Strongsville, OH",
    ]);
  });
});

describe("essay generation receives posting context (UNIT_CONFIRMED)", () => {
  useIsolatedFillEnv("safe");

  let privDir: string;
  let priorPrivate: string | undefined;
  beforeEach(() => {
    process.env.ESSAY_AUTOFILL_ENABLED = "true";
    priorPrivate = process.env.PRIVATE_DIR;
    privDir = path.join(os.tmpdir(), `essayctx-priv-${randomUUID()}`);
    fs.mkdirSync(path.join(privDir, "candidate"), { recursive: true });
    fs.writeFileSync(
      path.join(privDir, "candidate", "about-me.md"),
      "I am an applied-math undergraduate who builds ML tooling and browser automation; I care about reliable systems.",
    );
    process.env.PRIVATE_DIR = privDir;
    resetConfigCache();
  });
  afterEach(() => {
    if (priorPrivate === undefined) delete process.env.PRIVATE_DIR;
    else process.env.PRIVATE_DIR = priorPrivate;
    fs.rmSync(privDir, { recursive: true, force: true });
    resetConfigCache();
  });

  it("posting_context lands in the model payload (null when absent)", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const capture: EmailLlmClient = {
      async generateJson(input) {
        payloads.push(modelPayload(input));
        return {
          text: JSON.stringify({
            answers: [
              {
                key: "q1",
                answer:
                  "I want to work at Frobnicator because its industrial tooling matches the reliable-systems work I already do: I build ML tooling and browser automation as an applied-math undergraduate, and the Machine Intelligence Intern role in Strongsville is exactly where that experience applies. I am drawn to teams that ship dependable software, and everything in the posting suggests that is the standard here. I would bring the same care to this role from day one and grow with the team while contributing to the products customers rely on every single day.",
              },
            ],
          }),
          model: "stub",
        };
      },
    };

    const withCtx = await generateEssayAnswers({
      items: [{ fieldId: "q_why", question: "Why Frobnicator?" }],
      postingContext:
        "Careers at Frobnicator\nMachine Intelligence Intern\nFrobnicator Industries — Strongsville, OH. Hybrid.",
      client: capture,
    });
    expect(withCtx.answers).toHaveLength(1);
    expect(payloads[0]!["posting_context"]).toContain("Frobnicator Industries");

    const withoutCtx = await generateEssayAnswers({
      items: [{ fieldId: "q_why", question: "Why Frobnicator?" }],
      client: capture,
    });
    expect(withoutCtx.answers).toHaveLength(1);
    expect(payloads[1]!["posting_context"]).toBeNull();
  });

  const LONG = (n: number) =>
    `Example number ${n}: I built a reliable ML tooling system as an applied-math undergraduate, and I care about dependable software in everything I ship for teams that rely on it every day. I automated browser workflows end to end, wrote deterministic verification for every fill, and treated every unverified claim as unfinished work until a read-back proved it.`;

  // #222 (operator directive 2026-09-09): one call for the whole form, not
  // one per question. Follow-ups still inherit their parent question, and
  // the model sees its siblings directly instead of a replayed transcript.
  it("sends every question in ONE call; follow-ups inherit the parent question; abstentions are honored", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let calls = 0;
    const capture: EmailLlmClient = {
      async generateJson(input) {
        calls += 1;
        payloads.push(modelPayload(input));
        return {
          text: JSON.stringify({
            answers: [
              { key: "q1", answer: LONG(1) },
              { key: "q2", answer: LONG(2) },
              { key: "q3", answer: null },
            ],
          }),
          model: "stub",
        };
      },
    };
    const r = await generateEssayAnswers({
      items: [
        { fieldId: "f1", question: "We look for evidence of exceptional ability. Please provide us with 3-4 examples highlighting your exceptional ability." },
        { fieldId: "f2", question: "Second example:" },
        { fieldId: "f3", question: "Third example:" },
      ],
      client: capture,
    });
    expect(calls).toBe(1);
    const asked = payloads[0]!["questions"] as Array<{ key: string; question: string }>;
    expect(asked.map((q) => q.key)).toEqual(["q1", "q2", "q3"]);
    expect(asked[1]!.question).toMatch(/exceptional ability.*Second example:/s);
    expect(asked[2]!.question).toMatch(/exceptional ability.*Third example:/s);
    expect(r.answers.map((a) => a.fieldId)).toEqual(["f1", "f2"]);
    expect(r.notes.join(" ")).toMatch(/abstained.*Third example/);
  });

  // #221: a ranking is a one-line answer; the 40-word essay floor used to
  // reject every correct response to it (live DRW 2026-09-09).
  it("a short-answer question keeps its one-line answer, and the model is told what shape to write", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const capture: EmailLlmClient = {
      async generateJson(input) {
        payloads.push(modelPayload(input));
        return {
          text: JSON.stringify({
            answers: [{ key: "q1", answer: "Chicago, New York, Austin, Houston, Greenwich." }],
          }),
          model: "stub",
        };
      },
    };
    const r = await generateEssayAnswers({
      items: [{ fieldId: "loc", question: "Please rank your location preference in order of most to least preferred: Austin, Chicago, Greenwich, Houston, New York" }],
      client: capture,
    });
    const asked = payloads[0]!["questions"] as Array<{ expects: string }>;
    expect(asked[0]!.expects).toBe("short");
    expect(r.answers).toHaveLength(1);
    expect(r.answers[0]!.answer).toBe("Chicago, New York, Austin, Houston, Greenwich.");
  });

  // House rule: "Demographic / EEO / pronoun fields never take this path."
  // #268 (operator directive 2026-09-11): authorization and compensation
  // are model-answered now (from about-me's application facts) — they reach
  // the model; demographic and criminal-history questions still never do.
  it("never sends a demographic or criminal-history question to the model; authorization and pay do reach it (#221, #268)", async () => {
    const seen: string[] = [];
    const capture: EmailLlmClient = {
      async generateJson(input: { user: string }) {
        seen.push(input.user);
        return { text: JSON.stringify({ answers: [] }), model: "stub" };
      },
    };
    const r = await generateEssayAnswers({
      items: [
        { fieldId: "eeo", question: "How would you describe your racial/ethnic background? (mark all that apply)" },
        { fieldId: "crim", question: "Have you ever been convicted of a felony? Please explain." },
        { fieldId: "vis", question: "Will you now or in the future require visa sponsorship? Please explain." },
        { fieldId: "pay", question: "What is your desired pay for this role?" },
      ],
      client: capture,
    });
    expect(r.notes.filter((n) => /never model-answered/.test(n))).toHaveLength(2);
    const sent = seen.join("\n");
    expect(sent).not.toMatch(/racial\/ethnic background/);
    expect(sent).not.toMatch(/convicted of a felony/);
    expect(sent).toMatch(/visa sponsorship/);
    expect(sent).toMatch(/desired pay/);
  });
});
