import type { DiscoveredField } from "../ats/adapter.js";
import { getConfig } from "../config/index.js";
import { normalizeFieldLabel } from "./fieldNormalization.js";

export type EssayClassification = {
  field_id: string;
  label: string;
  is_essay: boolean;
  reasons: string[];
  estimated_min_words: number | null;
};

const ESSAY_LABEL_HINTS =
  /why (do )?you (want|are)|cover letter|tell us about|describe|essay|statement of|motivation|what interests you|additional information|anything else/i;

/** "If you said yes above, tell us about X" is a follow-up, not a cover letter. */
export function isConditionalYesFollowUp(label: string): boolean {
  // "If yes, select your most recent proprietary trading firm experience"
  // (live DV Trading 2026-08-30) — the submit-path re-plan predicted "N/A"
  // for it and the combobox refused; the parent had just been answered No.
  return /^if (?:you (?:said|answered|selected|responded|chose) )?(?:["“]?yes["”]?)\b/i.test(label.trim());
}

/**
 * Hard-stop gate for inspection → ESSAY_REQUIRED. Off by default (see
 * ESSAY_REQUIRED_GATE_ENABLED): heuristics false-positive too often on
 * voluntary demographic combobox labels.
 */
export function isEssayRequiredGateEnabled(): boolean {
  return getConfig().essayRequiredGateEnabled;
}

/**
 * Heuristic essay detector. Used for proposed-plan SKIP and optional
 * hard-stop when {@link isEssayRequiredGateEnabled} (default off).
 * Flags long textareas / high minlength / essay-ish labels.
 */
export function classifyEssayFields(fields: DiscoveredField[]): EssayClassification[] {
  return fields.map((f) => {
    const reasons: string[] = [];
    let isEssay = false;
    let estimatedMin: number | null = null;

    // File uploads (resume/cover) are not free-text essays
    if (f.type === "file") {
      return {
        field_id: f.id,
        label: f.label,
        is_essay: false,
        reasons: [],
        estimated_min_words: null,
      };
    }

    // EEO / self-ID selects often say "How would you describe your gender…".
    // That must not hit the "describe" essay hint before demographics handling.
    if (isDemographicsField(f)) {
      return {
        field_id: f.id,
        label: f.label,
        is_essay: false,
        reasons: [],
        estimated_min_words: null,
      };
    }

    if (f.type === "textarea") {
      reasons.push("textarea");
      isEssay = true;
    }
    if (f.maxLength && f.maxLength >= 500) {
      reasons.push(`maxLength>=500 (${f.maxLength})`);
      isEssay = true;
    }
    if (f.minLength && f.minLength >= 100) {
      reasons.push(`minLength>=100 (${f.minLength})`);
      estimatedMin = Math.ceil(f.minLength / 5);
      isEssay = true;
    }
    if (ESSAY_LABEL_HINTS.test(f.label)) {
      reasons.push("essay-like label");
      isEssay = true;
    }
    // A one-line <input> is a screener, even if the label says "describe".
    // "Describe your debugging spirit animal in one word" is not a cover letter.
    if (f.type === "text" && !f.minLength && (!f.maxLength || f.maxLength < 200)) {
      isEssay = false;
      reasons.length = 0;
    }
    if (isConditionalYesFollowUp(f.label)) {
      isEssay = false;
      reasons.length = 0;
    }
    // Select/radio/checkbox are never essays
    if (f.type === "select" || f.type === "radio" || f.type === "checkbox" || f.type === "date") {
      isEssay = false;
      reasons.length = 0;
    }

    if (isEssay && estimatedMin === null) {
      estimatedMin = 50;
    }

    return {
      field_id: f.id,
      label: f.label,
      is_essay: isEssay,
      reasons,
      estimated_min_words: isEssay ? estimatedMin : null,
    };
  });
}

export function essayFieldsOnly(fields: DiscoveredField[]): EssayClassification[] {
  return classifyEssayFields(fields).filter((c) => c.is_essay);
}

export function isDemographicsField(field: DiscoveredField): boolean {
  // #261 (live Palantir/Lever night30): the disability self-ID form's
  // SIGNATURE controls (eeo[disabilitySignature], …SignatureDate) appear
  // once the disability answer is given and are required. They carry no
  // demographic value — the applicant's name and the date they sign — so
  // they are not deferred to the sensitive-profile path (which has no value
  // for them and left the form unsubmittable).
  if (/signature/i.test(`${field.name ?? ""} ${field.inputId ?? ""} ${field.id ?? ""}`)) {
    return false;
  }
  // Live Intel Workday 2026-09-15 (e52e2060): Workday's CC-305 page puts
  // the signature line under selfIdentifiedDisabilityData--name /
  // --dateSignedOn / --employeeId — ids that CONTAIN "disability" while
  // holding no demographic value at all. Deferred to the sensitive path
  // they stayed empty and the wizard refused Next on two runs.
  if (
    /selfIdentifiedDisabilityData--(?:name|dateSignedOn|employeeId)\b|dateSignedOn/i.test(
      `${field.name ?? ""} ${field.inputId ?? ""} ${field.id ?? ""}`,
    )
  ) {
    return false;
  }
  // The OPTIONS say what a boilerplate label hides ("Please check one of
  // the boxes below:" → "Yes, I have a disability…"; live Intel 2026-09-15).
  const optionText = (field.options ?? []).join(" ");
  const n = normalizeFieldLabel(
    `${field.label} ${field.name ?? ""} ${field.inputId ?? ""} ${field.id ?? ""} ${optionText}`,
  );
  // pronouns?\b, not bare "pronoun": Sierra's live "Name pronounciation"
  // (sic) question contains the substring and was deferred to the
  // demographics policy path — a phonetic-spelling screener is not an
  // EEO field (2026-09-01, #118).
  // "disabled": UKG live 2026-09-01 (#144) names the ADA self-ID radio
  // group AreYouDisabled while its visible label is the boilerplate
  // "Please choose one of the options below" — the question reached the
  // predict tier (it produced nothing, but demographics must never take
  // that path). camelCase names survive normalization concatenated, so
  // substring, not \b.
  return /gender|race|ethnicity|veteran|disabilit|disabled|hispanic|latino|transgender|eeo|equal opportunity|decline to (self-)?identify|sexual orientation|pronouns?\b/.test(
    n,
  );
}
