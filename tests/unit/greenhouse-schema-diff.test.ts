import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fetchGreenhouseQuestions,
  parseQuestionsPayload,
  type GreenhouseQuestionSet,
} from "../../src/ats/greenhouse/questionsApi.js";
import {
  diffDeclaredVsDom,
  summarizeSchemaDiff,
} from "../../src/ats/greenhouse/schemaDiff.js";
import type { DiscoveredField } from "../../src/ats/adapter.js";

/**
 * G3: the DOM↔schema diff turns the silent reconciliation between what
 * the page renders and what the board's API declares into report
 * evidence. The fixture payload mirrors the live Appian 8041237 response
 * (run aef17b3e) — including the demographic/compliance sections that
 * must never cross the parse boundary. UNIT_CONFIRMED.
 */

const FIXTURE = path.join(
  process.cwd(),
  "tests",
  "fixtures",
  "greenhouse-board-api",
  "appian-8041237.questions.json",
);

async function loadFixtureSet(): Promise<GreenhouseQuestionSet> {
  const payload = fs.readFileSync(FIXTURE, "utf8");
  const stub = (async () =>
    new Response(payload, { status: 200 })) as unknown as typeof fetch;
  const set = await fetchGreenhouseQuestions(
    "https://job-boards.greenhouse.io/appian/jobs/8041237",
    stub,
  );
  if (!set) throw new Error("fixture payload failed to parse");
  return set;
}

const field = (
  id: string,
  label: string,
  options?: string[],
): DiscoveredField => ({
  id,
  label,
  type: options ? "select" : "text",
  required: false,
  ...(options ? { options } : {}),
});

describe("greenhouse board-api fixture (UNIT_CONFIRMED)", () => {
  it("parses the recorded shape: 8 application questions, demographic sections dropped", async () => {
    const set = await loadFixtureSet();
    expect(set.board).toBe("appian");
    expect(set.job_id).toBe("8041237");
    expect(set.questions).toHaveLength(8);
    const labels = set.questions.map((q) => q.label.toLowerCase()).join(" | ");
    expect(labels).not.toContain("gender");
    expect(labels).not.toContain("veteran");
    expect(labels).not.toContain("city");
    // The virtualization victim: 22 options, complete.
    expect(
      set.questions.find((q) => q.label === "How did you hear about Appian?")
        ?.options,
    ).toHaveLength(22);
  });

  it("parseQuestionsPayload reads the raw fixture identically (no fetch layer drift)", () => {
    const parsed = parseQuestionsPayload(
      JSON.parse(fs.readFileSync(FIXTURE, "utf8")),
    );
    expect(parsed).toHaveLength(8);
    expect(parsed.filter((q) => q.required)).toHaveLength(8);
  });
});

describe("diffDeclaredVsDom (G3, UNIT_CONFIRMED)", () => {
  it("a page that renders the whole schema diffs clean", async () => {
    const set = await loadFixtureSet();
    const fields = set.questions.map((q, i) =>
      field(`f${i}`, q.label, q.options.length > 0 ? q.options : undefined),
    );
    const diff = diffDeclaredVsDom(fields, set);
    expect(diff.matched).toBe(8);
    expect(diff.api_only).toEqual([]);
    expect(diff.dom_only).toEqual([]);
    expect(diff.option_mismatches).toEqual([]);
    expect(summarizeSchemaDiff(diff)).toBe(
      "schema diff: 8/8 declared question(s) matched onto 8 DOM field(s)",
    );
  });

  it("names the three gap classes: declared-only, DOM-only, option-count mismatch", async () => {
    const set = await loadFixtureSet();
    const fields = [
      field("f1", "First Name"),
      field("f2", "Last Name"),
      field("f3", "Email"),
      // Truncated label, unique prefix ≥20 chars — must still match.
      field("f4", "Are you currently a member of any university organizations, such as clubs o", [
        "Yes",
        "No",
      ]),
      // The virtualized menu read incomplete: 5 of 22 options.
      field("f5", "How did you hear about Appian?", [
        "LinkedIn",
        "Indeed",
        "Glassdoor",
        "Handshake",
        "JobRight",
      ]),
      // Not in the schema — an injected control.
      field("f6", "Newsletter opt-in"),
    ];
    const diff = diffDeclaredVsDom(fields, set);
    expect(diff.matched).toBe(5);
    // Missing from the DOM: resume upload, the majors screener, sponsorship.
    expect(diff.api_only.map((q) => q.label)).toEqual([
      "Resume/CV",
      "Are you currently pursuing a Major in one of the following disciplines: Computer Science, Computer Engineering?",
      "Will you now or in the future require sponsorship for employment visa status?",
    ]);
    expect(diff.api_only.every((q) => q.required)).toBe(true);
    expect(diff.dom_only).toEqual(["Newsletter opt-in"]);
    expect(diff.option_mismatches).toEqual([
      {
        label: "How did you hear about Appian?",
        dom_options: 5,
        api_options: 22,
      },
    ]);
    const summary = summarizeSchemaDiff(diff);
    expect(summary).toContain("5/8");
    expect(summary).toContain("3 declared-only (3 required)");
    expect(summary).toContain("1 DOM-only");
    expect(summary).toContain("1 option-count mismatch(es)");
  });

  it("a DOM field with no options is not a mismatch — that is the case the merge fixes", async () => {
    const set = await loadFixtureSet();
    const diff = diffDeclaredVsDom(
      [field("f1", "How did you hear about Appian?")],
      set,
    );
    expect(diff.matched).toBe(1);
    expect(diff.option_mismatches).toEqual([]);
  });

  it("short labels never prefix-match a longer declared question", async () => {
    const set = await loadFixtureSet();
    // "Email" must not prefix-creep; an unrelated short label stays DOM-only.
    const diff = diffDeclaredVsDom(
      [field("f1", "Email"), field("f2", "How did")],
      set,
    );
    expect(diff.matched).toBe(1);
    expect(diff.dom_only).toEqual(["How did"]);
  });
});
