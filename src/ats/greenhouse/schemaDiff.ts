/**
 * G3: two-way diff between what the DOM discovery saw and what the board's
 * own schema declares.
 *
 * The option pipeline (G1) and the requiredness gate (G2) both consume the
 * Greenhouse job-board API silently — a label that fails to match simply
 * contributes nothing, and the report cannot distinguish "the schema and
 * the page agree" from "half the schema never lined up". This diff makes
 * the reconciliation itself evidence:
 *
 *   - api_only: questions the board declares that DOM discovery never saw.
 *     On a single-page form that is a discovery bug (a control the field
 *     walker missed — exactly the class of failure that previously
 *     surfaced as an unexplained skipped count); on a wizard it usually
 *     means a later page. Either way the operator sees it BEFORE the
 *     submit gate turns it into a refusal.
 *   - dom_only: controls the page renders that the schema does not declare
 *     (injected widgets, cookie fields that leak into discovery, or a
 *     board customization the API predates).
 *   - option_mismatch: both sides have an option list but the counts
 *     disagree — the signature of a virtualized menu read incomplete by
 *     the DOM harvest ("How did you hear about Appian?" renders a window
 *     of its 22 options).
 *
 * Read-only over data already in hand: this never fetches, never touches
 * the page, and label matching is the same normalize + unique-prefix rule
 * applyLabelOptions uses, so the diff reports exactly what the merge did.
 */
import type { DiscoveredField } from "../adapter.js";
import {
  normalizeQuestionLabel,
  type GreenhouseQuestionSet,
} from "./questionsApi.js";

export type SchemaDiff = {
  board: string;
  job_id: string;
  declared_count: number;
  dom_count: number;
  matched: number;
  /** Declared by the board, absent from the DOM discovery. */
  api_only: Array<{ label: string; required: boolean }>;
  /** Rendered by the page, undeclared by the board's schema. */
  dom_only: string[];
  /** Matched, but the two option lists disagree in size. */
  option_mismatches: Array<{
    label: string;
    dom_options: number;
    api_options: number;
  }>;
};

/** Artifact-size guard — a pathological page must not bloat the report. */
const MAX_LISTED = 30;

function matchKey(
  key: string,
  index: Map<string, number>,
  keys: string[],
): number | null {
  if (key.length === 0) return null;
  const exact = index.get(key);
  if (exact !== undefined) return exact;
  if (key.length >= 20) {
    const hits: number[] = [];
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (k.startsWith(key) || key.startsWith(k)) hits.push(i);
    }
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

/**
 * Diff DOM-discovered fields against the declared question set. Call with
 * the fields as discovered — BEFORE mergeDeclaredQuestions overwrites
 * their option lists — or every mismatch reads as agreement.
 */
export function diffDeclaredVsDom(
  fields: DiscoveredField[],
  set: GreenhouseQuestionSet,
): SchemaDiff {
  const declaredKeys = set.questions.map((q) => normalizeQuestionLabel(q.label));
  const declaredIndex = new Map<string, number>();
  declaredKeys.forEach((k, i) => {
    if (k.length > 0 && !declaredIndex.has(k)) declaredIndex.set(k, i);
  });

  const matchedDeclared = new Set<number>();
  const domOnly: string[] = [];
  const optionMismatches: SchemaDiff["option_mismatches"] = [];
  let matched = 0;

  for (const f of fields) {
    const hit = matchKey(
      normalizeQuestionLabel(f.label),
      declaredIndex,
      declaredKeys,
    );
    if (hit === null) {
      if (f.label.trim().length > 0) domOnly.push(f.label);
      continue;
    }
    matched += 1;
    matchedDeclared.add(hit);
    const q = set.questions[hit]!;
    const domCount = f.options?.length ?? 0;
    // Only a disagreement between two REAL lists is a mismatch — a DOM
    // field with no options is the normal React-select case the API merge
    // exists to fix, not a finding.
    if (domCount > 0 && q.options.length > 0 && domCount !== q.options.length) {
      optionMismatches.push({
        label: q.label,
        dom_options: domCount,
        api_options: q.options.length,
      });
    }
  }

  const apiOnly = set.questions
    .filter((_, i) => !matchedDeclared.has(i))
    .map((q) => ({ label: q.label, required: q.required }));

  return {
    board: set.board,
    job_id: set.job_id,
    declared_count: set.questions.length,
    dom_count: fields.length,
    matched,
    api_only: apiOnly.slice(0, MAX_LISTED),
    dom_only: domOnly.slice(0, MAX_LISTED),
    option_mismatches: optionMismatches.slice(0, MAX_LISTED),
  };
}

/** One line for report notes: the counts, and the gaps when there are any. */
export function summarizeSchemaDiff(diff: SchemaDiff): string {
  const parts = [
    `schema diff: ${diff.matched}/${diff.declared_count} declared question(s) matched onto ${diff.dom_count} DOM field(s)`,
  ];
  if (diff.api_only.length > 0) {
    const required = diff.api_only.filter((q) => q.required).length;
    parts.push(
      `${diff.api_only.length} declared-only (${required} required)`,
    );
  }
  if (diff.dom_only.length > 0) parts.push(`${diff.dom_only.length} DOM-only`);
  if (diff.option_mismatches.length > 0) {
    parts.push(`${diff.option_mismatches.length} option-count mismatch(es)`);
  }
  return parts.join("; ");
}
