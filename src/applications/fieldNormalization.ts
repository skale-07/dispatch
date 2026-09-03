import type { DiscoveredField } from "../ats/adapter.js";

/**
 * Map a discovered field label to a canonical candidate profile key
 * using answer-alias phrases (case-insensitive substring / exact match).
 *
 * Longest phrase wins so bare "Gender" does not steal "gender identity" fields
 * and vice versa.
 */
export function normalizeFieldLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[*：:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchCanonicalField(
  field: DiscoveredField,
  aliases: Record<string, string[]>,
): string | null {
  const normalized = normalizeFieldLabel(field.label);
  const nameHint = (field.name ?? "").toLowerCase();

  // "Phone Extension" is not the phone number (live Workday huntington
  // 2026-08-30: the profile's number was typed into the extension box).
  if (/\b(extension|ext)\b/.test(normalized) && /\b(phone|tel|telephone)\b/.test(normalized)) {
    return null;
  }

  // #70 (live tiaa #22s): "Phone Device Type" — a SELECT — mapped
  // canonical `phone` via the label substring and the name hint, so the
  // plan tried to pick the phone NUMBER from [Mobile|Fax|Landline] and
  // the wrong-target writes re-rendered the section, wiping the real
  // number every run. A phone number is free text: canonical `phone`
  // never claims an option control (the country-code select has its own
  // canonicals).
  const optionControl =
    field.type === "select" || field.type === "checkbox" || field.type === "radio";
  // #148 (live UKG run 16): "Address 2" is the second address line, not a
  // second copy of the street — bare "Address" claimed it and the street
  // was typed twice. Line-2 shapes map to address.line2 (empty ⇒ skip).
  if (/^(street |mailing |home )?(address|street)( line)? ?2$/.test(normalized)) {
    return "address.line2";
  }

  const matched = matchCanonicalFieldInner(field, aliases, normalized, nameHint);
  // #85c (live stryker): "Is your current cumulative GPA 3.0 or above?"
  // — a Yes/No SELECT — matched canonical `gpa` and was fed "3.7". A
  // free-value fact (number/text) can never answer an option control;
  // unmapped, the screener path answers it from the page's own options.
  if ((matched === "phone" || matched === "gpa") && optionControl) return null;
  // #148 (live UKG run 16): "Secondary Phone" took the primary number —
  // a secondary/alternate/additional twin of a contact fact is a DIFFERENT
  // datum; the profile holds one of each. Leave the twin unmapped (empty).
  if (
    matched &&
    /^(phone|email|address\.line1|address\.city|linkedin_url)$/.test(matched) &&
    /^(secondary|alternate|alternative|additional|second|other)\b/.test(normalized)
  ) {
    return null;
  }
  // #150 (live UKG run 17, resume-review page): the resume parse renders
  // FIVE work-experience rows (NewWorkExperience_JobTitle0..4). Bare
  // "Company" / "Organization" / "Month" in rows 1-4 claimed the profile's
  // ONE current_company / graduation_month, and the fill overwrote the
  // parsed start month of row 0 with the graduation month. The profile
  // holds a single current job and a single education; a history fact
  // never claims a later row, and an education date never claims an
  // employment row (nor the reverse).
  if (matched && HISTORY_FACT.test(matched)) {
    const group = historyGroupOf(field);
    if (group) {
      if (group.index >= 1) return null;
      const educationFact = EDUCATION_FACT.test(matched);
      if (educationFact && group.kind === "employment") return null;
      if (!educationFact && group.kind === "education") return null;
    }
  }
  return matched;
}

/** Singular history facts — the profile holds one current job and one education. */
const HISTORY_FACT =
  /^(current_company|current_job_title|school|degree|major|gpa|graduation_month|graduation_year|start_month|start_year)$/;
const EDUCATION_FACT = /^(school|degree|major|gpa|graduation_month|graduation_year|start_month|start_year)$/;
const EMPLOYMENT_HINT = /(work|employ|job|position|experience|company|employer)/i;
const EDUCATION_HINT = /(education|school|degree|academic|university)/i;

/**
 * #150: a control that belongs to an indexed history row (work experience
 * or education), read from its id/name — `NewWorkExperience_JobTitle3`,
 * `job_application[educations_attributes][1][school_name_id]`. Only
 * attributes that name a history group count: a Lever screener
 * `cards[uuid][field1]` or a generated `f_58` is not a history row.
 */
export function historyGroupOf(field: {
  inputId?: string;
  name?: string;
}): { kind: "employment" | "education"; index: number } | null {
  // The form's own prefix ("job_application[...]") is not a history hint,
  // and an indexed custom QUESTION (Greenhouse
  // `job_application_answers_attributes_3_text_value`) is a screener row.
  const source = `${field.inputId ?? ""} ${field.name ?? ""}`.replace(/job[_ ]?application/gi, "");
  if (/(answer|question)/i.test(source)) return null;
  const employment = EMPLOYMENT_HINT.test(source);
  const education = EDUCATION_HINT.test(source);
  if (!employment && !education) return null;
  const indexes = Array.from(source.matchAll(/(\d{1,2})(?=[\]_.\-\s]|$)/g)).map((m) =>
    Number(m[1]),
  );
  if (indexes.length === 0) return null;
  return { kind: education && !employment ? "education" : "employment", index: indexes[indexes.length - 1]! };
}

/**
 * The history kind a visible label names ("Add Experience", "Delete
 * Education 1", "Remove job") — same hints as {@link historyGroupOf},
 * without an index.
 */
export function historyKindOfText(text: string): "employment" | "education" | null {
  const employment = EMPLOYMENT_HINT.test(text);
  const education = EDUCATION_HINT.test(text);
  if (!employment && !education) return null;
  return education && !employment ? "education" : "employment";
}

function matchCanonicalFieldInner(
  field: DiscoveredField,
  aliases: Record<string, string[]>,
  normalized: string,
  nameHint: string,
): string | null {

  // "I have a preferred name" is Workday's reveal TOGGLE, not the
  // preferred-name text field (live tiaa 2026-08-30 #22g: the fill tried
  // to "check" the profile's name into it). The revealed text field keeps
  // its own "Preferred Name" label and still maps normally.
  if (field.type === "checkbox" && /\bpreferred name\b/.test(normalized)) {
    return null;
  }

  let best: { canonical: string; score: number } | null = null;

  for (const [canonical, phrases] of Object.entries(aliases)) {
    for (const phrase of phrases) {
      const p = normalizeFieldLabel(phrase);
      if (!p) continue;
      let score = 0;
      if (normalized === p) {
        // Exact label win — pad so short exact "Gender" beats a looser long include.
        score = 10_000 + p.length;
      } else if (normalized.includes(p)) {
        // Live 2026-08-29 (Stripe 420e19f5): bare "University" mapped the
        // 190-char "length of internship … requirement from your University
        // for academic credit" question to `school`, and "Degree" mapped
        // "Are you currently enrolled in a degree programme…" — the fill
        // then typed profile values into screener dropdowns. A short
        // single-word alias may only claim a LABEL, not a sentence; only
        // multi-word phrases ("require sponsorship") carry enough intent
        // to match inside a long question.
        const phraseIsQuestionLike = p.includes(" ") && p.length >= 12;
        if (
          !phraseIsQuestionLike &&
          normalized.length > Math.max(30, 3 * p.length)
        ) {
          continue;
        }
        // #103 (live tiaa): a short alias must match as a WHOLE WORD —
        // "state" claimed the "Personal Data Statement" heading and typed
        // Maryland at a disclosures-page control. Multi-word question
        // phrases keep plain containment.
        if (!phraseIsQuestionLike) {
          const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          if (!new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(normalized)) {
            continue;
          }
          // #110 (live stripe 0a2dbfa6): "Third location preference" is a
          // CHOICE among offices, not the candidate's city — bare
          // "Location" claimed it and typed Baltimore at a dynamic-option
          // widget (which then leaked into First Name on the refill pass).
          // An identity fact never answers a preference/ranking question;
          // the screener/predict tier picks from the page's own options.
          if (/\b(preferences?|ranking)\b/.test(normalized)) {
            continue;
          }
        }
        score = 100 + p.length;
      } else if (p.includes(normalized) && normalized.length >= 4) {
        score = 50 + normalized.length;
      } else {
        continue;
      }
      if (!best || score > best.score) {
        best = { canonical, score };
      }
    }
  }

  if (best) return best.canonical;

  // #73 (operator directive): Workday-style Skills pickers fill from the
  // resume's skills (profile.skills). Tight label match — a sentence
  // mentioning skills is a screener, not the picker.
  if (/^(technical |top |relevant |your )?skills?$/.test(normalized)) {
    return "skills";
  }

  // Name/id-based hints when phrase map missed (Lever EEO / org / location)
  // "What are your preferred pronouns?" / "Pronouns" (live DV Trading
  // 2026-08-30, REQUIRED): operator-supplied only, via the sensitive profile.
  if (/\bpronouns?\b/.test(normalized)) return "pronouns";
  if (/eeo\[?\s*gender|name=["']?eeo\[gender\]/i.test(nameHint) || /eeo\[gender\]/i.test(normalized))
    return "gender";
  if (
    /eeo\[?\s*race|name=["']?eeo\[race\]/i.test(nameHint) ||
    /eeo\[race\]/i.test(normalized) ||
    (/\brace\b/.test(normalized) && !/trace|brace/.test(normalized))
  )
    return "race_ethnicity";
  if (/eeo\[?\s*veteran|eeo\[veteran\]/i.test(nameHint) || /eeo\[veteran\]/i.test(normalized))
    return "veteran_status";
  // #148 (live UKG run 16): the Hispanic/Latino question is labelled
  // "Ethnic Origin" but its control is named/id'd HispanicOrigin — the
  // attribute is the deterministic tell. Sensitive-profile path only.
  if (/hispanic/i.test(nameHint) || /hispanic/i.test(field.id ?? "")) {
    return "hispanic_latino";
  }
  if (
    nameHint === "org" ||
    /^(current )?company$/.test(normalized) ||
    /current organization|organization name/.test(normalized)
  )
    return "current_company";
  if (
    /location-input|name=["']?location/i.test(nameHint) ||
    normalized === "location" ||
    normalized === "current location"
  )
    return "address.city";

  // Name-based Greenhouse hints (only when phrase map missed)
  if (/email/i.test(nameHint)) return "email";
  if (/phone/i.test(nameHint)) return "phone";
  if (/first_name/i.test(nameHint)) return "legal_name.first";
  if (/last_name/i.test(nameHint)) return "legal_name.last";
  return null;
}

export type MappedField = DiscoveredField & {
  canonical_field: string | null;
  mapping_confidence: "high" | "medium" | "low" | "none";
};

export function mapDiscoveredFields(
  fields: DiscoveredField[],
  aliases: Record<string, string[]>,
): MappedField[] {
  return fields.map((f) => {
    const canonical = matchCanonicalField(f, aliases);
    let confidence: MappedField["mapping_confidence"] = "none";
    if (canonical) {
      const exact = aliases[canonical]?.some(
        (p) => normalizeFieldLabel(p) === normalizeFieldLabel(f.label),
      );
      confidence = exact ? "high" : "medium";
    }
    return {
      ...f,
      canonical_field: canonical,
      mapping_confidence: confidence,
    };
  });
}
