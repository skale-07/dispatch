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

  // Live rb.wd5 2026-09-14 (app 02302b66, cycle 146): Workday's legal-name
  // block also renders LOCAL-script name inputs, and on that tenant label
  // discovery slid one control over — `name--legalName--firstNameLocal`
  // read as "First Name" (planned Shubham), `--lastNameLocal` as "Middle
  // Name", and the real `--firstName` as "Last Name" (planned Kale). The
  // control ids are Workday's own contract; they outrank the labels here.
  // Local-script names are not the profile's fact: never mapped.
  const idHint = `${field.inputId ?? ""} ${field.id ?? ""}`;
  if (/legalName--(first|last|middle)NameLocal\b/i.test(idHint)) return null;
  const legalNameById = idHint.match(/legalName--(firstName|lastName|middleName)\b/i);
  if (legalNameById) {
    const part = legalNameById[1]!.toLowerCase();
    return part === "firstname" ? "legal_name.first" : part === "lastname" ? "legal_name.last" : "legal_name.middle";
  }

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
  // #265 (live Palantir night30): "Year of High School Graduation" matched
  // the alias "School" by containment and the plan put "Johns Hopkins
  // University" into a year list (→ the form's "Other"). The profile's school
  // is the UNIVERSITY; a high-school question, or one asking for a year /
  // date / grade, is never that fact. Unmapped, it is asked of the operator.
  if (matched === "school" && /\bhigh school\b|\b(year|date|gpa|grade|graduation)\b/.test(normalized)) {
    return null;
  }
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
  // #255 (live Exegy/Ashby night30): "If you are currently authorized to
  // work on a visa or other work permit, when does that work authorization
  // expire?" — a DATE question — was claimed through the alias "authorized
  // to work" and fed the yes/no status ("Yes" into a date input; the fill
  // refused, the verify parked the app). A question about WHEN an
  // authorization ends is neither the status nor the sponsorship question.
  // Unmapped it stays unanswered — authorization is never model-answered —
  // and the page's own completeness scan decides whether it may be empty.
  if (
    (matched === "work_authorization" || matched === "requires_sponsorship") &&
    (field.type === "date" ||
      /\b(expir\w*|end\s+date|valid\s+(until|through)|when\s+does)\b/.test(normalized))
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
  // #164 (live Five Rings greenhouse 2026-09-03): "Please specify the
  // grading scale used by your current school." is one of the board's OWN
  // custom questions (question_17808225008, a 4-option select); the alias
  // "Current school" is multi-word and ≥12 chars, so it cleared the
  // short-alias guard by plain containment and the plan tried to place
  // "Johns Hopkins University" into a grading-scale list. A singular
  // history fact is answered by the form's own education / employment
  // section — a control the ATS names as a custom question is asking
  // something ABOUT that fact, never for its value. Unmapped, the
  // screener / predict tier answers it from the page's own options.
  if (matched && HISTORY_FACT.test(matched) && isAtsCustomQuestion(field)) {
    return null;
  }
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
 * #164: a control the ATS names as one of its OWN custom questions —
 * Greenhouse `question_17808225008` and
 * `job_application_answers_attributes_3_text_value` (the shared
 * "job_application" prefix is stripped first so it cannot itself count).
 * Lever's `cards[uuid][field0]` and a generated `f_58` carry no such
 * marker and are unaffected.
 */
export function isAtsCustomQuestion(field: {
  inputId?: string;
  name?: string;
}): boolean {
  const source = `${field.inputId ?? ""} ${field.name ?? ""}`.replace(
    /job[_ ]?application/gi,
    "",
  );
  return /(^|[^a-z])(answers?|questions?)([^a-z]|$)/i.test(source);
}

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
  // #272 (live Commure ashby 2026-09-12): an education block's Start/End
  // Date is a PAIR of month+year <select>s that the DOM leaves id-less, so
  // the only label in scope is the block's ("Education History") and the
  // plan sent all four to the screener bank / LLM predict — which answered
  // "May" / "2025" into controls the fill could not even find. The adapter
  // now rebuilds them with a structural id naming the datum exactly; that
  // suffix, not a label, is the honest mapping. Anchored on
  // `education`+`history` in the id so a WORK-history date pair (its own
  // history-group path) can never take an education canonical.
  {
    const idHint = field.id ?? "";
    const dated = /-(startDate|endDate)-(month|year)$/.exec(idHint);
    if (dated && /education[_-]?history/i.test(idHint)) {
      const when = dated[1] === "startDate" ? "start" : "graduation";
      return `${when}_${dated[2]}`;
    }
  }

  // "I have a preferred name" is Workday's reveal TOGGLE, not the
  // preferred-name text field (live tiaa 2026-08-30 #22g: the fill tried
  // to "check" the profile's name into it). The revealed text field keeps
  // its own "Preferred Name" label and still maps normally.
  if (field.type === "checkbox" && /\bpreferred name\b/.test(normalized)) {
    return null;
  }

  // #204 (live cisco 2026-09-09, Phenom `referredBy`): "What's their name
  // or email address?" is the REFERRER's identity, not the candidate's.
  // The phrase map's "email address" claimed it, the fill typed the
  // operator's email into a field the form keeps hidden until "Were you
  // referred?" is Yes, and verification parked the app. Third-person or
  // referred-by phrasing on a free-text control never maps to an identity
  // fact — ATS-general; a SELECT like "Referral source" still maps to
  // how_heard through the alias map.
  const freeText = field.type !== "select" && field.type !== "radio" && field.type !== "checkbox";
  if (
    freeText &&
    (/\btheir\b/.test(normalized) ||
      /\breferr(?:er|ed by)\b/.test(normalized) ||
      /referr(?:ed|er)(?:by|name|email)?/i.test(`${nameHint} ${field.id ?? ""}`))
  ) {
    return null;
  }

  // #226 (live Palantir 2026-09-09; operator: "it couldn't complete a
  // question that asked to plug in today's date"). Acknowledgement blocks
  // end with a bare "Name" + "Date" pair whose answers are facts.
  // #226b (night30): these rules sat AFTER the alias loop, whose reverse-
  // containment branch lets a 4-letter label claim any longer alias — with
  // the operator's real aliases bare "Date" → graduation_year (via
  // "Expected graduation date": "2029" typed at a signature date) and bare
  // "Name" → legal_name.first. The #226 test used empty aliases, so it never
  // saw it. They now run first, still anchored to BARE labels ("Graduation
  // Date", "Start Date", "Date of Birth" keep their own mappings; DOB is
  // sensitive and never auto-filled).
  // #261: signature controls named as such (Lever's disability self-ID form:
  // eeo[disabilitySignature] / eeo[disabilitySignatureDate]) carry
  // placeholder labels ("Enter your full name", "MM/DD/YYYY") — the NAME is
  // the fact. Date first: "SignatureDate" also contains "Signature".
  {
    const idHint = `${field.name ?? ""} ${field.id ?? ""}`;
    if (/signature[\s_-]*date/i.test(idHint)) return "signature_date";
    if (/signature/i.test(idHint) && field.type !== "checkbox" && field.type !== "radio") {
      return "signature_name";
    }
    // Workday's CC-305 form (live Intel 2026-09-15): the signature line is
    // selfIdentifiedDisabilityData--name / --dateSignedOn, and the answer
    // is a checkbox group whose OPTIONS say "…have a disability…" under a
    // boilerplate label ("Please check one of the boxes below:").
    if (/selfIdentifiedDisabilityData--dateSignedOn|dateSignedOn/i.test(idHint)) return "signature_date";
    if (/selfIdentifiedDisabilityData--name\b/i.test(idHint)) return "signature_name";
    if (
      /disabilityStatus|AreYouDisabled/i.test(idHint) ||
      ((field.type === "checkbox" || field.type === "radio" || field.type === "select") &&
        (field.options ?? []).filter((o) => /\bdisabilit(?:y|ies)\b/i.test(o)).length >= 2)
    ) {
      return "disability_status";
    }
  }
  if (/^(today'?s\s+)?date$/.test(normalized) || /^date\s+(signed|of\s+signature)$/.test(normalized)) {
    return "signature_date";
  }
  if (/^(e-?)?signature$/.test(normalized) || /^signature\s+of\s+applicant$/.test(normalized)) {
    return "signature_name";
  }
  // A bare "Name" that is one of the ATS's CUSTOM questions (Lever cards[…],
  // Greenhouse question_…) is a signature line, answered with the full legal
  // name. The form's own primary name field (Lever name="name", composed by
  // the adapter from legal_name.first) is not a custom question and keeps
  // its mapping below.
  if (
    /^(full\s+)?(legal\s+)?name$/.test(normalized) &&
    (isAtsCustomQuestion(field) || /\bcards\[/i.test(`${field.name ?? ""} ${field.id ?? ""}`))
  ) {
    return "signature_name";
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
        // Live Intel Workday 2026-09-14 (e52e2060): the two-word alias
        // "Current employer" (question-like by the rule above) matched
        // inside the 340-char "…aware of a contract or agreement with your
        // current employer…?" non-compete question, so the company name
        // was fed to a Yes/No list on four runs. A noun phrase of one or
        // two words names a FIELD; it may not claim a label many times its
        // length — that is a sentence mentioning the topic. Three-word-plus
        // phrases keep plain containment.
        if (p.split(" ").length <= 2 && normalized.length > Math.max(60, 6 * p.length)) {
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

  // #227 (operator directive 2026-09-09, emphatic: "FOR ANY QUESTION THAT
  // ASKS DO YOU REQUIRE WORK AUTHORIZATION THE ANSWER SHOULD BE NO").
  //
  // Two questions share this vocabulary and take OPPOSITE answers for a US
  // citizen, so the split is decided here, ahead of the alias phrase map:
  //
  //   "Are you legally authorized to work in the US?"      -> YES
  //   "Do you require work authorization / sponsorship?"   -> NO
  //
  // The alias list carries bare phrases ("Work authorization", "Authorized
  // to work") that were claiming the REQUIRE form of the question and
  // answering "Yes" from work_authorization — which an employer reads as
  // "I need sponsorship", the exact inversion of the truth.
  //
  // Status phrasing wins first, because "Are you authorized to work
  // WITHOUT requiring sponsorship?" contains both cues and is still the
  // status question (answer Yes).
  {
    const asksStatus =
      /^(are|is)\s+(you|the\s+applicant)\b/.test(normalized) ||
      /\b(are|is)\s+you\s+(currently\s+|legally\s+)?(authorized|eligible|able|permitted)\b/.test(
        normalized,
      ) ||
      /\bdo\s+you\s+have\s+(the\s+)?(legal\s+)?(right|authorization)\b/.test(normalized);
    // NB: no trailing \b after "authoriz" — there is no word boundary
    // inside "authorization", so `authoriz\b` matches nothing at all.
    const asksRequire =
      /\b(require|requiring|requires|need|needs)\b/.test(normalized) &&
      /\b(sponsor\w*|work\s+authoriz\w*|employment\s+authoriz\w*|visa)\b/.test(
        normalized,
      );
    if (asksRequire && !asksStatus) return "requires_sponsorship";
    if (asksStatus && /\b(authoriz\w*|eligible\s+to\s+work|work\s+lawfully)\b/.test(normalized)) {
      return "work_authorization";
    }
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
    (/\brace\b/.test(normalized) && !/trace|brace/.test(normalized)) ||
    // #213 (live roblox 2026-09-09): "How would you describe your
    // racial/ethnic background? (mark all that apply)" — the adjective
    // forms never matched \brace\b, so a REQUIRED EEO question went
    // unmapped and the submit was withheld. Sensitive-profile path only;
    // no value on file still means skipped.
    (/\bracial\b|\bethnic(?:ity)?\b|\bethnic background\b/.test(normalized) &&
      // #148: UKG's "Ethnic Origin" is the Hispanic/Latino question by its
      // control name — that rule (below) must keep winning.
      !/hispanic/i.test(`${nameHint} ${field.id ?? ""}`))
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

  // #231 (live Smartly.io greenhouse 2026-09-10): "What gender do you
  // identify as?*" and "Are you a person with a disability?*" are the
  // form's OWN self-ID wording, both REQUIRED, and neither matched — the
  // alias map held bare "Gender" and "Do you have a disability", and the
  // gender rule above keys on a Greenhouse `eeo[gender]` control name this
  // board does not use. Two required questions, submit withheld.
  //
  // Recognise the self-ID topic itself rather than one board's phrasing.
  // Safe to widen because a demographic canonical is the most restrictive
  // destination in the system: the value can come ONLY from the operator's
  // own encrypted sensitive profile, nothing is inferred or defaulted, and
  // no value on file still means the field is skipped. A false positive
  // costs a skipped field, never a wrong or invented answer.
  //
  // Ordering is load-bearing (live Crest Industries lever, same night):
  // Lever's EEO block hands the RACE control a label that begins
  // "Gender Select ... Male Female Decline to self-identify". Read as a
  // label that is a gender question; its control NAME says `eeo[race]`.
  // The name is the fact, so every `eeo[...]` rule above decides first and
  // these topic rules only see what the names left unclaimed.
  // "Gender identity" is its own canonical and its own stored value — the
  // module's opening contract ("bare Gender does not steal gender identity
  // fields") has to survive a topic rule, so the longer phrase decides
  // first.
  if (/\bgender identity\b/.test(normalized)) return "gender_identity";
  if (/\bgender\b/.test(normalized) && !/\bgender\s+pay\b/.test(normalized)) {
    return "gender";
  }
  if (/\bdisabilit(?:y|ies)\b|\bdisabled\b/.test(normalized)) {
    return "disability_status";
  }
  // #270 (live Lyft greenhouse 2026-09-12): "Please enter your relevant
  // employment and military service above using the + Add Another
  // Employment link." is a REQUIRED acknowledgement whose only option is
  // "Thank you" — an instruction about the work-history block, not a
  // self-ID question. Read as veteran_status it was skipped (no sensitive
  // value) and the submit was withheld. Bare "military service" only means
  // self-ID when the label is not about entering employment history.
  if (/\bveterans?\b|\barmed forces\b/.test(normalized)) {
    return "veteran_status";
  }
  if (
    /\bmilitary service\b/.test(normalized) &&
    !/\bemployment\b|\bwork history\b/.test(normalized)
  ) {
    return "veteran_status";
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
