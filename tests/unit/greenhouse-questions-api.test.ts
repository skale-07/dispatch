import { describe, expect, it } from "vitest";
import {
  fetchGreenhouseQuestions,
  normalizeQuestionLabel,
  parseGreenhouseBoardRef,
  parseQuestionsPayload,
} from "../../src/ats/greenhouse/questionsApi.js";
import {
  applyLabelOptions,
  mergeDeclaredQuestions,
} from "../../src/ats/shared/optionHarvest.js";
import type { DiscoveredField } from "../../src/ats/adapter.js";

/**
 * Greenhouse publishes each posting's questions AND their complete option
 * lists as unauthenticated JSON. That is a better answer-space source than
 * opening controls one at a time: one request instead of eight, and it
 * cannot be truncated by a virtualized menu's scroll position.
 *
 * The live payload for the form that failed (Appian 8041237, run aef17b3e)
 * also corrected our reading of the failure. "Are you currently a member of
 * any university organizations…" is a YES/NO question — so the run did not
 * pick a wrong organization, it typed an organization name into a
 * two-option dropdown whose answer was "Yes". No answer bank fixes that;
 * only showing the model the option list does.
 */
describe("greenhouse board-ref parsing (UNIT_CONFIRMED)", () => {
  it("reads board + job id from every Greenhouse URL shape", () => {
    expect(
      parseGreenhouseBoardRef("https://job-boards.greenhouse.io/appian/jobs/8041237"),
    ).toEqual({ board: "appian", jobId: "8041237" });
    expect(
      parseGreenhouseBoardRef("https://boards.greenhouse.io/appian/jobs/8041237"),
    ).toEqual({ board: "appian", jobId: "8041237" });
    // The embed shape the live nav report captured.
    expect(
      parseGreenhouseBoardRef(
        "https://boards.greenhouse.io/embed/job_app?for=appian&token=8041237&utm_source=jobright",
      ),
    ).toEqual({ board: "appian", jobId: "8041237" });
  });

  it("refuses anything that is not a Greenhouse posting", () => {
    expect(parseGreenhouseBoardRef("https://jobs.lever.co/acme/123")).toBeNull();
    expect(parseGreenhouseBoardRef("https://greenhouse.io.evil.test/a/jobs/1")).toBeNull();
    expect(parseGreenhouseBoardRef("not a url")).toBeNull();
    expect(parseGreenhouseBoardRef("https://boards.greenhouse.io/appian")).toBeNull();
  });
});

describe("greenhouse questions payload (UNIT_CONFIRMED)", () => {
  const PAYLOAD = {
    questions: [
      { label: "First Name", required: true, fields: [{ type: "input_text" }] },
      {
        label: "Are you currently a member of any university organizations?",
        required: true,
        fields: [
          {
            type: "multi_value_single_select",
            values: [
              { label: "Yes", value: 1 },
              { label: "No", value: 0 },
            ],
          },
        ],
      },
    ],
  };

  it("extracts labels, requiredness, and option lists", () => {
    const qs = parseQuestionsPayload(PAYLOAD);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ label: "First Name", required: true, options: [] });
    expect(qs[1]?.options).toEqual(["Yes", "No"]);
  });

  it("never throws on a shape it does not recognize", () => {
    expect(parseQuestionsPayload(null)).toEqual([]);
    expect(parseQuestionsPayload({})).toEqual([]);
    expect(parseQuestionsPayload({ questions: "nope" })).toEqual([]);
    expect(parseQuestionsPayload({ questions: [{ nolabel: 1 }] })).toEqual([]);
  });

  it("fetch is fail-open: a non-200 yields null, not an exception", async () => {
    const notFound = (async () =>
      new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(
      await fetchGreenhouseQuestions(
        "https://boards.greenhouse.io/appian/jobs/1",
        notFound,
      ),
    ).toBeNull();
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(
      await fetchGreenhouseQuestions(
        "https://boards.greenhouse.io/appian/jobs/1",
        boom,
      ),
    ).toBeNull();
  });

  it("builds a normalized label index for merging onto DOM fields", async () => {
    const ok = (async () =>
      new Response(JSON.stringify(PAYLOAD), { status: 200 })) as unknown as typeof fetch;
    const set = await fetchGreenhouseQuestions(
      "https://boards.greenhouse.io/appian/jobs/8041237",
      ok,
    );
    expect(set?.board).toBe("appian");
    expect(
      set?.byLabel.get(
        normalizeQuestionLabel("Are you currently a member of any university organizations?"),
      ),
    ).toEqual(["Yes", "No"]);
    // Free-text questions contribute no option list — they are OPEN.
    expect(set?.byLabel.has(normalizeQuestionLabel("First Name"))).toBe(false);
  });
});

describe("applyLabelOptions (UNIT_CONFIRMED)", () => {
  const f = (label: string): DiscoveredField => ({
    id: label.slice(0, 6),
    label,
    type: "select",
    required: true,
  });

  it("matches a DOM label that the board truncated", () => {
    // The DOM shows the label cut short; the API returns it whole.
    const fields = [
      f("Are you currently pursuing a Major in one of the following disciplines: Com"),
    ];
    const byLabel = new Map([
      [
        normalizeQuestionLabel(
          "Are you currently pursuing a Major in one of the following disciplines: Computer Science, Computer Engineering?",
        ),
        ["Yes", "No"],
      ],
    ]);
    const out = applyLabelOptions(fields, byLabel);
    expect(out.matched).toBe(1);
    expect(out.fields[0]?.options).toEqual(["Yes", "No"]);
  });

  it("a short generic label never prefix-collides", () => {
    const out = applyLabelOptions(
      [f("Country")],
      new Map([[normalizeQuestionLabel("Country of residence"), ["US", "UK"]]]),
    );
    // Under 20 chars, so exact match only — a wrong option list is worse
    // than none, because the tiers below trust it verbatim.
    expect(out.matched).toBe(0);
  });

  it("refuses an ambiguous prefix rather than picking one", () => {
    const long = "Have you completed at least one internship or comparable";
    const out = applyLabelOptions(
      [f(long)],
      new Map([
        [normalizeQuestionLabel(`${long} work experience in software?`), ["Yes"]],
        [normalizeQuestionLabel(`${long} work experience in hardware?`), ["No"]],
      ]),
    );
    expect(out.matched).toBe(0);
  });

  it("leaves fields alone when the board declared nothing", () => {
    const fields = [f("Anything")];
    expect(applyLabelOptions(fields, new Map()).fields).toBe(fields);
  });
});

describe("demographic sections never enter (UNIT_CONFIRMED)", () => {
  it("parses only `questions` — demographic, compliance, and location sections are dropped at the boundary", () => {
    // The live payload can carry EEOC/demographic sections alongside the
    // application questions. Those must never reach the planner: the house
    // rule is that demographic fields fill ONLY from the operator's own
    // encrypted sensitive profile — never from any schema, never inferred.
    // This test pins the parse boundary so a future "read more of the
    // payload" change cannot silently widen it.
    const payload = {
      questions: [
        {
          label: "How did you hear about us?",
          required: true,
          fields: [{ values: [{ label: "LinkedIn" }, { label: "Referral" }] }],
        },
      ],
      location_questions: [
        {
          label: "City",
          required: true,
          fields: [{ values: [{ label: "Baltimore" }] }],
        },
      ],
      demographic_questions: {
        header: "Voluntary Self-Identification",
        questions: [
          {
            label: "Gender",
            required: false,
            fields: [{ values: [{ label: "Male" }, { label: "Female" }] }],
          },
        ],
      },
      compliance: [
        {
          questions: [
            {
              label: "Veteran Status",
              required: false,
              fields: [{ values: [{ label: "I am a veteran" }] }],
            },
          ],
        },
      ],
    };
    const parsed = parseQuestionsPayload(payload);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.label).toBe("How did you hear about us?");
    const labels = parsed.map((q) => q.label.toLowerCase()).join(" ");
    expect(labels).not.toContain("gender");
    expect(labels).not.toContain("veteran");
  });
});

describe("mergeDeclaredQuestions (G1, UNIT_CONFIRMED)", () => {
  const field = (id: string, label: string, options?: string[]): DiscoveredField => ({
    id,
    label,
    type: "select",
    required: false,
    ...(options ? { options } : {}),
  });

  it("returns the liveOptions/answerSpace maps a plan_only run can consume", () => {
    const byLabel = new Map<string, string[]>([
      [normalizeQuestionLabel("How did you hear about us?"), ["LinkedIn", "Referral", "Other"]],
    ]);
    const merged = mergeDeclaredQuestions(
      [field("f1", "How did you hear about us?"), field("f2", "Portfolio URL")],
      byLabel,
    );
    expect(merged.matched).toBe(1);
    expect(merged.options.get("f1")).toEqual(["LinkedIn", "Referral", "Other"]);
    expect(merged.answerSpace.get("f1")).toBe("closed");
    // The unmatched free-text field stays out of both maps — its answer
    // space is unknown, not closed.
    expect(merged.options.has("f2")).toBe(false);
    expect(merged.answerSpace.has("f2")).toBe(false);
  });

  it("keeps a native select's own markup options when the API has no match", () => {
    const merged = mergeDeclaredQuestions(
      [field("f1", "Season", ["Summer", "Fall"])],
      new Map(),
    );
    expect(merged.matched).toBe(0);
    // Markup options are still a closed space the planner may trust.
    expect(merged.options.get("f1")).toEqual(["Summer", "Fall"]);
    expect(merged.answerSpace.get("f1")).toBe("closed");
  });
});
