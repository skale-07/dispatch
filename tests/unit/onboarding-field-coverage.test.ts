import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT,
  EMPTY_EDUCATION_ENTRY,
  EMPTY_PROFILE,
  EMPTY_SENSITIVE,
  PREFER_NOT_LABEL,
  PROFILE_MIRRORED_SCREENER_KEYS,
  SCREENER_QUESTIONS,
  SENSITIVE_FIELDS,
} from "../../frontend/src/public/contract.js";
import { IMPORTABLE } from "../../frontend/src/public/importPrompt.js";
import { ONBOARDING_STEPS } from "../../frontend/src/public/onboarding/steps.js";

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
 * contract, AND a wizard step that asks for that source (plan M9: the
 * step registry in onboarding/steps.ts is the map). Add a key to
 * tryLoadProfileFacts() and this fails until the wizard can supply it —
 * the same "the map cannot rot" trick the knowledge-graph test plays.
 * UNIT_CONFIRMED.
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
  return [...(fn?.[0] ?? "").matchAll(/take\("([a-z0-9_]+)"/g)].map((m) => m[1]!);
}

/** SCREENER_REGISTRY keys, parsed from the engine source, not imported. */
function engineRegistryKeys(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src", "candidate", "screeners.ts"), "utf8");
  const start = src.indexOf("export const SCREENER_REGISTRY");
  const end = src.indexOf("];", start);
  return [...src.slice(start, end).matchAll(/^\s*key:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!);
}

/**
 * Where each engine fact comes from on the onboarding side. Three forms:
 *   "key"             a field on the wizard draft, asked by one step
 *   "education[].key" a per-school field (EducationDraft); the primary
 *                     school's copy is flat on the draft, extra schools
 *                     ride more_education
 *   "screener:key"    a registry screener answer (user_screener_answers)
 * Nothing may map to "we guess" — that is the point of the gate.
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

/**
 * Registry keys the engine mirrors from profile facts rather than the
 * screener bank (contract: PROFILE_MIRRORED_SCREENER_KEYS) → the draft
 * field a step asks instead.
 */
const MIRROR: Record<(typeof PROFILE_MIRRORED_SCREENER_KEYS)[number], string> = {
  work_authorization: "work_authorization",
  requires_sponsorship: "needs_sponsorship",
  willing_to_relocate: "open_to_relocation",
  how_heard: "how_heard",
  non_compete: "restrictive_covenants",
};

const draftFieldsAsked = new Set(ONBOARDING_STEPS.flatMap((s) => s.fields as readonly string[]));
const screenersAsked = new Set(ONBOARDING_STEPS.flatMap((s) => s.screeners));

/** Resolve a SOURCE value to the thing a step must ask for. */
function resolve(source: string): { kind: "draft" | "screener"; key: string; exists: boolean } {
  if (source.startsWith("screener:")) {
    const key = source.slice("screener:".length);
    return { kind: "screener", key, exists: SCREENER_QUESTIONS.some((q) => q.key === key) };
  }
  if (source.startsWith("education[].")) {
    const key = source.slice("education[].".length);
    return {
      kind: "draft",
      key,
      exists: key in EMPTY_EDUCATION_ENTRY && key in EMPTY_PROFILE && draftFieldsAsked.has("more_education"),
    };
  }
  return { kind: "draft", key: source, exists: source in EMPTY_PROFILE };
}

describe("onboarding covers what the engine reads (UNIT_CONFIRMED)", () => {
  it("every profile fact the predictor reads has an onboarding source", () => {
    const unmapped = engineProfileFactKeys().filter((k) => !(k in SOURCE));
    expect(
      unmapped,
      "engine facts with nowhere to come from — add the question to the " +
        "wizard and map it in SOURCE, or stop reading the fact",
    ).toEqual([]);
  });

  it("every mapped source is a real field on the wizard draft (or a registry screener)", () => {
    const missing = Object.entries(SOURCE)
      .filter(([, source]) => !resolve(source).exists)
      .map(([fact, source]) => `${fact} → ${source}`);
    expect(missing).toEqual([]);
  });

  it("every source is asked by a wizard step — a fact with a draft key but no step is still a gap", () => {
    const orphaned = Object.entries(SOURCE)
      .filter(([, source]) => {
        const r = resolve(source);
        return r.kind === "screener" ? !screenersAsked.has(r.key) : !draftFieldsAsked.has(r.key);
      })
      .map(([fact, source]) => `${fact} → ${source}`);
    expect(orphaned, "no step asks for").toEqual([]);
  });

  it("every SCREENER_REGISTRY key is a wizard question, asked by a step or mirrored from a profile field", () => {
    const registry = engineRegistryKeys();
    expect(registry.length).toBeGreaterThanOrEqual(20);
    const questions = new Set(SCREENER_QUESTIONS.map((q) => q.key));
    for (const key of registry) {
      expect(questions.has(key), `${key} has no SCREENER_QUESTIONS entry`).toBe(true);
      const mirroredTo = (MIRROR as Record<string, string | undefined>)[key];
      if (mirroredTo) {
        expect(draftFieldsAsked.has(mirroredTo), `${key} mirrors ${mirroredTo}, which no step asks`).toBe(true);
        expect(screenersAsked.has(key), `${key} is mirrored AND asked as a screener`).toBe(false);
      } else {
        expect(screenersAsked.has(key), `${key} is asked by no step`).toBe(true);
      }
    }
    expect(Object.keys(MIRROR).sort()).toEqual([...PROFILE_MIRRORED_SCREENER_KEYS].sort());
  });

  it("the wizard collects the two documents the engine attaches", () => {
    // supplementalMaterials.ts attaches a transcript; materials handling
    // attaches the resume. Both are user_documents rows now (the
    // documents step); the legacy pointers stay on the row as the read
    // fallback for one release.
    expect(ONBOARDING_STEPS.some((s) => s.slug === "documents")).toBe(true);
    expect(CONTRACT.documentsTable).toBe("user_documents");
    expect(CONTRACT.resumesBucket).toBeTruthy();
    expect(CONTRACT.transcriptsBucket).toBeTruthy();
    expect(EMPTY_PROFILE).toHaveProperty("resume_object_path");
    expect(EMPTY_PROFILE).toHaveProperty("transcript_object_path");
  });

  it("the wizard collects the narrative the LLM surfaces ground on", () => {
    // essayAutofill and screenerPredictionLlm both abstain without it.
    expect(EMPTY_PROFILE).toHaveProperty("about_me");
    expect(ONBOARDING_STEPS.find((s) => s.slug === "about")?.fields).toContain("about_me");
  });

  // Self-identification (decision 2026-09-11, reversing 2026-09-01): the
  // cloud DOES hold EEO answers — opt-in, encrypted, RPC-only — but never
  // on the profile draft, the import allowlist, the screener bank, or any
  // wizard step other than its own.
  const EEO = [/gender/i, /\brace\b/i, /ethnicit/i, /veteran/i, /disabilit/i, /pronoun/i];

  it("EEO never lives on the profile draft, the import allowlist, the screener questions, or a step's fields", () => {
    const surfaces = [
      Object.keys(EMPTY_PROFILE).join(" "),
      IMPORTABLE.join(" "),
      SCREENER_QUESTIONS.map((q) => q.key).join(" "),
      ONBOARDING_STEPS.flatMap((s) => [...s.fields, ...s.screeners]).join(" "),
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
