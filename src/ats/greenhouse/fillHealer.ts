import type { Page } from "playwright";
import { getConfig, resetConfigCache } from "../../config/index.js";
import { logger } from "../../logging/logger.js";
import { assertFormFillAllowed } from "../../applications/formFillGuards.js";
import {
  assertExecutableApprovedEntry,
  type ApprovedFillPlanEntry,
} from "../../applications/approvedFillPlan.js";
import {
  greenhouseFillFromPlan,
  greenhouseVerifyFromPlan,
  type FieldMeta,
} from "./fill.js";
import { locateFieldViaSidecar } from "../../agent/locateField.js";

/**
 * Phase 6a′ — selector healing for read-back failures.
 *
 * Escalation ladder (one-way, bounded):
 *   1. deterministic in-process relocation: rescan the live page for the
 *      field by label evidence and retry through the normal fill path;
 *   2. sidecar `locate_field` on the page HTML — ONLY when
 *      AGENT_FALLBACK_ENABLED=true;
 *   3. give up: the caller parks the field exactly as before this module
 *      existed (AMBIGUOUS_FIELD / refuse-to-click).
 *
 * What never changes: values come from the approved plan and re-pass
 * assertExecutableApprovedEntry on every retry; success is decided by the
 * same deterministic read-back verify, never by anything's self-report.
 */

export type FieldCandidate = {
  selector: string;
  via: string;
  score: number;
  inputId?: string;
  name?: string;
};

export type HealAttempt = {
  field_id: string;
  layer: "heuristic" | "sidecar" | null;
  candidate: FieldCandidate | null;
  healed: boolean;
  notes: string[];
};

export type HealReport = {
  attempted: number;
  healed: string[];
  still_failing: string[];
  attempts: HealAttempt[];
  sidecar_used: boolean;
};

/**
 * #252: question boilerplate carries no identity. "Please indicate your
 * race" scored 0.75 against "Please indicate your gender" and 0.5 against
 * "If you heard about this role …, please provide their name" on these
 * words alone (live, Hudl night30) — the healer then typed the race answer
 * into both. Only the words that name the question count.
 */
const LABEL_STOPWORDS = new Set([
  "please", "indicate", "select", "enter", "provide", "choose", "specify",
  "your", "you", "are", "is", "do", "does", "the", "an", "of", "to", "in",
  "on", "for", "and", "or", "if", "what", "which", "how", "this", "that",
  "with", "any", "have", "has", "will", "would", "be", "as", "at", "by",
]);

/** Pure scoring shared with tests: token overlap of normalized strings. */
export function scoreLabelSimilarity(wanted: string, evidence: string): number {
  const tok = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !LABEL_STOPWORDS.has(t)),
    );
  const w = tok(wanted);
  if (w.size === 0) return 0;
  const e = tok(evidence);
  let hit = 0;
  for (const t of w) if (e.has(t)) hit++;
  return hit / w.size;
}

/**
 * Rescan the live page for controls whose label evidence resembles the
 * entry's label. Deterministic; no LLM, no sidecar.
 */
export async function findFieldCandidates(
  page: Page,
  label: string,
  fieldType: string,
): Promise<FieldCandidate[]> {
  type ScannedControl = {
    id: string;
    name: string;
    ariaLabel: string;
    placeholder: string;
    labelText: string;
    elType: string;
  };
  // Browser runtime only — structural types because this tsconfig has no DOM lib.
  const scan = await page.evaluate((): ScannedControl[] => {
    type El = {
      tagName: string;
      textContent: string | null;
      getAttribute: (n: string) => string | null;
      closest: (s: string) => El | null;
    };
    const doc = (
      globalThis as unknown as {
        document: {
          querySelectorAll: (s: string) => ArrayLike<El>;
          querySelector: (s: string) => El | null;
        };
      }
    ).document;
    const out: ScannedControl[] = [];
    const controls = doc.querySelectorAll("input, textarea, select");
    for (let i = 0; i < controls.length; i++) {
      const el = controls[i] as El;
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (["hidden", "submit", "button", "image"].includes(type)) continue;
      let labelText = "";
      const id = el.getAttribute("id") ?? "";
      if (id) {
        const lab = doc.querySelector(`label[for="${id}"]`);
        if (lab?.textContent) labelText = lab.textContent.trim();
      }
      if (!labelText) {
        const parentLabel = el.closest("label");
        if (parentLabel?.textContent) labelText = parentLabel.textContent.trim();
      }
      out.push({
        id,
        name: el.getAttribute("name") ?? "",
        ariaLabel: el.getAttribute("aria-label") ?? "",
        placeholder: el.getAttribute("placeholder") ?? "",
        labelText,
        elType:
          el.tagName === "TEXTAREA"
            ? "textarea"
            : el.tagName === "SELECT"
              ? "select"
              : type || "text",
      });
    }
    return out;
  });

  const candidates: FieldCandidate[] = [];
  for (const c of scan) {
    const evidences: Array<[string, string]> = [
      ["label_text", c.labelText],
      ["aria_label", c.ariaLabel],
      ["placeholder", c.placeholder],
      ["name", c.name],
      ["id", c.id],
    ];
    let best = 0;
    let via = "";
    for (const [kind, text] of evidences) {
      if (!text) continue;
      const s = scoreLabelSimilarity(label, text);
      if (s > best) {
        best = s;
        via = kind;
      }
    }
    if (best < 0.5) continue;
    const typeBonus = c.elType === fieldType ? 0.1 : 0;
    const selector = c.id
      ? /^[A-Za-z_][\w-]*$/.test(c.id)
        ? `#${c.id}`
        : `[id="${c.id.replace(/"/g, '\\"')}"]`
      : c.name
        ? `[name="${c.name}"]`
        : null;
    if (!selector) continue;
    candidates.push({
      selector,
      via,
      score: Math.min(1, best + typeBonus),
      ...(c.id ? { inputId: c.id } : {}),
      ...(c.name ? { name: c.name } : {}),
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}

async function retryEntryWithCandidate(
  page: Page,
  entry: ApprovedFillPlanEntry,
  candidate: FieldCandidate,
): Promise<boolean> {
  // Values re-pass the approved-plan guard on every retry.
  assertExecutableApprovedEntry(entry);
  const meta = new Map<string, FieldMeta>([
    [
      entry.field_id,
      {
        type: entry.type,
        ...(candidate.inputId ? { inputId: candidate.inputId } : {}),
        ...(candidate.name ? { name: candidate.name } : {}),
      },
    ],
  ]);
  const fill = await greenhouseFillFromPlan(page, [entry], meta);
  if (fill.errors.length > 0) return false;
  const verify = await greenhouseVerifyFromPlan(page, [entry], meta);
  return verify.passed;
}

/**
 * #252: fields the fill FOUND and operated, then refused on the value —
 * the option list had no unambiguous match (comboboxFill's own reasons).
 * A locator miss is what healing exists for; this is not one.
 */
export function locatedButRefusedFields(fill: {
  field_meta?: ReadonlyArray<{
    field_id: string;
    control_kind?: string | null;
    selected_option?: string | null;
    notes?: readonly string[];
  }>;
}): Set<string> {
  const out = new Set<string>();
  for (const m of fill.field_meta ?? []) {
    if (!m.control_kind || m.selected_option) continue;
    const notes = (m.notes ?? []).join("; ");
    if (/ambiguous match for "|no option matches "/.test(notes)) out.add(m.field_id);
  }
  return out;
}

/**
 * Heal the entries whose read-back verification failed. Caller passes only
 * approved FILL entries; anything else is refused by the per-retry guard.
 */
export async function healFailedFillEntries(input: {
  page: Page;
  failedEntries: ApprovedFillPlanEntry[];
  maxSidecarCalls?: number;
  /**
   * #252: every control the plan already names (all entries, whatever
   * their action). A candidate that IS another entry's control is never
   * tried — the healer typed a race answer into the gender control (wiping
   * a verified "Male") and into a referral-name box.
   */
  planFieldIds?: readonly string[];
  /**
   * #252: field ids whose control WAS located and operated but whose value
   * was refused (ambiguous / unmatched option). Relocation cannot fix a
   * value refusal — it can only put the value somewhere else.
   */
  locatedButRefused?: ReadonlySet<string>;
}): Promise<HealReport> {
  assertFormFillAllowed("greenhouse.fillHealer");
  resetConfigCache();
  const cfg = getConfig();

  const report: HealReport = {
    attempted: input.failedEntries.length,
    healed: [],
    still_failing: [],
    attempts: [],
    sidecar_used: false,
  };
  let sidecarBudget = input.maxSidecarCalls ?? 3;

  for (const entry of input.failedEntries) {
    const attempt: HealAttempt = {
      field_id: entry.field_id,
      layer: null,
      candidate: null,
      healed: false,
      notes: [],
    };

    if (input.locatedButRefused?.has(entry.field_id)) {
      attempt.notes.push(
        "control was located and the value refused (no unambiguous option) — relocation cannot fix that; not healed (#252)",
      );
      report.still_failing.push(entry.field_id);
      report.attempts.push(attempt);
      continue;
    }
    const othersControls = new Set(
      (input.planFieldIds ?? []).filter((id) => id !== entry.field_id),
    );
    const ownedByAnother = (c: FieldCandidate): boolean =>
      (c.inputId !== undefined && othersControls.has(c.inputId)) ||
      (c.name !== undefined && othersControls.has(c.name));

    // Layer 1 — deterministic in-process relocation.
    try {
      const found = await findFieldCandidates(
        input.page,
        entry.label,
        entry.type,
      );
      const candidates = found.filter((c) => !ownedByAnother(c));
      for (const c of found.filter(ownedByAnother)) {
        attempt.notes.push(
          `heuristic candidate ${c.selector} skipped — it is another plan entry's control (#252)`,
        );
      }
      for (const candidate of candidates) {
        if (await retryEntryWithCandidate(input.page, entry, candidate)) {
          attempt.layer = "heuristic";
          attempt.candidate = candidate;
          attempt.healed = true;
          break;
        }
        attempt.notes.push(
          `heuristic candidate ${candidate.selector} (${candidate.score}) did not verify`,
        );
      }
      if (candidates.length === 0) {
        attempt.notes.push("no heuristic candidates scored >= 0.5");
      }
    } catch (err) {
      attempt.notes.push(
        `heuristic layer error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Layer 2 — sidecar escalation, gated and budgeted.
    if (!attempt.healed) {
      if (!cfg.agentFallbackEnabled) {
        attempt.notes.push(
          "sidecar escalation skipped (AGENT_FALLBACK_ENABLED=false)",
        );
      } else if (sidecarBudget <= 0) {
        attempt.notes.push("sidecar escalation skipped (budget exhausted)");
      } else {
        sidecarBudget--;
        report.sidecar_used = true;
        try {
          const html = await input.page.content();
          const located = await locateFieldViaSidecar({
            fieldLabel: entry.label,
            fieldType: entry.type,
            html,
          });
          for (const found of located) {
            if (ownedByAnother(found)) {
              attempt.notes.push(
                `sidecar candidate ${found.selector} skipped — it is another plan entry's control (#252)`,
              );
              continue;
            }
            if (await retryEntryWithCandidate(input.page, entry, found)) {
              attempt.layer = "sidecar";
              attempt.candidate = found;
              attempt.healed = true;
              break;
            }
            attempt.notes.push(
              `sidecar candidate ${found.selector} (${found.score}) did not verify`,
            );
          }
          if (located.length === 0) {
            attempt.notes.push("sidecar returned no candidates");
          }
        } catch (err) {
          attempt.notes.push(
            `sidecar layer error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    (attempt.healed ? report.healed : report.still_failing).push(
      entry.field_id,
    );
    report.attempts.push(attempt);
  }

  logger.info("fill heal pass finished", {
    service: "greenhouse",
    action: "fill_heal",
    metadata: {
      attempted: report.attempted,
      healed: report.healed.length,
      still_failing: report.still_failing.length,
      sidecar_used: report.sidecar_used,
    },
  });
  return report;
}
