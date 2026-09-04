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
            answer:
              "I want to work at Frobnicator because its industrial tooling matches the reliable-systems work I already do: I build ML tooling and browser automation as an applied-math undergraduate, and the Machine Intelligence Intern role in Strongsville is exactly where that experience applies. I am drawn to teams that ship dependable software, and everything in the posting suggests that is the standard here. I would bring the same care to this role from day one and grow with the team while contributing to the products customers rely on every single day.",
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

  it("'Second/Third example' follow-ups inherit the parent question and see previous answers (night19 #57)", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    let n = 0;
    const capture: EmailLlmClient = {
      async generateJson(input) {
        payloads.push(modelPayload(input));
        n += 1;
        return { text: JSON.stringify({ answer: n === 3 ? null : `Example number ${n}: I built a reliable ML tooling system as an applied-math undergraduate, and I care about dependable software in everything I ship for teams that rely on it every day. I automated browser workflows end to end, wrote deterministic verification for every fill, and treated every unverified claim as unfinished work until a read-back proved it.` }), model: "stub" };
      },
    };
    const r = await generateEssayAnswers({
      items: [
        { fieldId: "q1", question: "We look for evidence of exceptional ability. Please provide us with 3-4 examples highlighting your exceptional ability." },
        { fieldId: "q2", question: "Second example:" },
        { fieldId: "q3", question: "Third example:" },
      ],
      client: capture,
    });
    // Follow-ups carry the parent question…
    expect(String(payloads[1]!["question"])).toMatch(/exceptional ability.*Second example:/s);
    expect(String(payloads[2]!["question"])).toMatch(/exceptional ability.*Third example:/s);
    // …and the batch's previous answers ride along for distinctness.
    expect(payloads[0]!["previous_answers"]).toBeNull();
    expect((payloads[1]!["previous_answers"] as unknown[]).length).toBe(1);
    expect((payloads[2]!["previous_answers"] as unknown[]).length).toBe(2);
    // The model's abstention (null) is still honored.
    expect(r.answers.map((a) => a.fieldId)).toEqual(["q1", "q2"]);
    expect(r.notes.join(" ")).toMatch(/abstained.*Third example/);
  });
});
