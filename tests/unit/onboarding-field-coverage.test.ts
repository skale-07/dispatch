import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EMPTY_PROFILE,
  EMPTY_SENSITIVE,
  PREFER_NOT_LABEL,
  SCREENER_QUESTIONS,
  SENSITIVE_FIELDS,
} from "../../frontend/src/public/contract.js";
import { IMPORTABLE } from "../../frontend/src/public/importPrompt.js";

/**
 * The cloud plane must ask for what the engine actually reads.
 *
 * This gate exists because the gap was real and expensive. Before
 * 2026-09-03 the wizard collected nine of the sixteen facts
 * tryLoadProfileFacts() reads, asked for no transcript at all while
 * src/ats/shared/supplementalMaterials.ts was already attaching one, and
 * never collected the about-me narrative that essay autofill and screener
 * prediction both abstain without. Nothing failed loudly; applications
 * just went out thinner than they had to.
 *
 * So: every fact the engine reads must have a source in the onboarding
 * contract. Add a key to tryLoadProfileFacts() and this fails until the
 * wizard can supply it — the same "the map cannot rot" trick the
 * knowledge-graph test plays. UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");

/** The engine-side reader, parsed rather than imported: this test must
 *  fail on a change to THAT file, not on whatever it happens to export. */
function engineProfileFactKeys(): string[] {
  const src = fs.readFileSync(
    path.join(ROOT, "src", "applications", "screenerPredictionLlm.ts"),
    "utf8",
  );
  const fn = /export function tryLoadProfileFacts[\s\S]*?\n}/.exec(src);
  expect(fn, "tryLoadProfileFacts not found — did it move?").toBeTruthy();
  return [...(fn?.[0] ?? "").matchAll(/take\("([a-z_]+)"/g)].map((m) => m[1]!);
}

/**
 * Where each engine fact comes from on the onboarding side. A draft key
 * means the wizard asks for it directly; a note means the value is
 * derived from fields the wizard does collect. Nothing may map to
 * "we guess" — that is the point of the gate.
 */
const SOURCE: Record<string, string> = {
  school: "school",
  degree: "degree",
  major: "field",
  additional_fields_of_study: "additional_fields",
  graduation_month: "grad_month",
  graduation_year: "grad_year",
  start_month: "start_month",
  start_year: "start_year",
  gpa: "gpa",
  work_authorization: "work_authorization",
  requires_sponsorship: "needs_sponsorship",
  relocation: "open_to_relocation",
  current_company: "current_company",
  city: "location_city",
  state: "location_region",
  country: "location_country",
};

describe("onboarding covers what the engine reads (UNIT_CONFIRMED)", () => {
  it("every profile fact the predictor reads has an onboarding source", () => {
    const unmapped = engineProfileFactKeys().filter((k) => !(k in SOURCE));
    expect(
      unmapped,
      "engine facts with nowhere to come from — add the question to the " +
        "wizard and map it in SOURCE, or stop reading the fact",
    ).toEqual([]);
  });

  it("every mapped source is a real field on the wizard draft", () => {
    const missing = Object.entries(SOURCE)
      .filter(([, source]) => !(source in EMPTY_PROFILE))
      .map(([fact, source]) => `${fact} → ${source}`);
    expect(missing).toEqual([]);
  });

  it("the wizard collects the two documents the engine attaches", () => {
    // supplementalMaterials.ts attaches a transcript; materials handling
    // attaches the resume. Both need a pointer on the profile row.
    expect(EMPTY_PROFILE).toHaveProperty("resume_object_path");
    expect(EMPTY_PROFILE).toHaveProperty("transcript_object_path");
  });

  it("the wizard collects the narrative the LLM surfaces ground on", () => {
    // essayAutofill and screenerPredictionLlm both abstain without it.
    expect(EMPTY_PROFILE).toHaveProperty("about_me");
  });

  // Self-identification (decision 2026-09-11, reversing 2026-09-01): the
  // cloud DOES hold EEO answers — opt-in, encrypted, RPC-only — but never
  // on the profile draft, the import allowlist, or the screener bank.
  const EEO = [/gender/i, /\brace\b/i, /ethnicit/i, /veteran/i, /disabilit/i, /pronoun/i];

  it("EEO never lives on the profile draft, the import allowlist, or the screener questions", () => {
    const surfaces = [
      Object.keys(EMPTY_PROFILE).join(" "),
      IMPORTABLE.join(" "),
      SCREENER_QUESTIONS.map((q) => q.key).join(" "),
    ];
    for (const s of surfaces) for (const forbidden of EEO) expect(s).not.toMatch(forbidden);
  });

  it("the self-ID step covers exactly the engine's sensitive fields", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "candidate", "sensitiveProfile.ts"), "utf8");
    const block = /sensitiveProfileSchema = z\.object\(\{([\s\S]*?)\n\}\)/.exec(src)?.[1] ?? "";
    const engineKeys = [...block.matchAll(/^\s*([a-z_]+):\s*z\./gm)]
      .map((m) => m[1]!)
      .filter((k) => k !== "self_identification_preferences");
    expect(engineKeys.length).toBeGreaterThanOrEqual(9);
    expect(SENSITIVE_FIELDS.map((f) => f.key).sort()).toEqual([...engineKeys].sort());
  });

  it("self-ID is opt-in: consent off, every field skipped by default, prefer-not always offered", () => {
    expect(EMPTY_SENSITIVE.consent).toBe(false);
    for (const f of SENSITIVE_FIELDS) {
      expect(EMPTY_SENSITIVE.fields[f.key].choice).toBe("skip");
      expect(f.options.length).toBeGreaterThan(0);
      // The option lists are the forms' vocabularies; "prefer not" is a
      // separate CHOICE, rendered for every field, never a list entry
      // the model could pick.
      expect(f.options).not.toContain(PREFER_NOT_LABEL);
    }
    expect(PREFER_NOT_LABEL).toMatch(/prefer not/i);
  });
});
