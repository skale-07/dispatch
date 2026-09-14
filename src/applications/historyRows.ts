import type { DiscoveredField } from "../ats/adapter.js";
import {
  structuredEducationHistory,
  structuredEmploymentHistory,
  type EducationEntry,
  type EmploymentEntry,
  type PublicProfile,
} from "../candidate/publicProfile.js";
import { historyGroupOf } from "./fieldNormalization.js";

/**
 * Work-experience / education ROWS answered from the profile's structured
 * history (operator directive 2026-09-14).
 *
 * Live PIMCO wd1 2026-09-14 (app fd529364): page 1 verified clean, the
 * wizard reached My Experience, and the submit gate refused on "5 required
 * question(s) unanswered — Job Title, Company, From, To, Role Description"
 * plus Degree / Field of Study. The plan had skipped every one of them:
 * "employment row 6 — the profile holds one entry" (#150's rows-after-the-
 * first rule, tripped by Workday's non-ordinal row numbers) and "No
 * answer-alias mapping" (Company / From / To have no profile canonical).
 *
 * Pure: a field + its ORDINAL row + the profile ⇒ a `history:` canonical
 * and value, or null. Row ordinals come from first appearance in the page
 * (Workday numbers rows 6, 7, 13…; Greenhouse 0, 1, 2), so the first row
 * on the page is the most recent entry. Sub-fields are named by the
 * control's own id suffix first (Workday `workExperience-6--jobTitle`),
 * then by label for boards that carry no structural id. Nothing here is
 * inferred: an entry without a datum yields null and the row stays empty.
 */

export const HISTORY_CANONICAL_PREFIX = "history:";

export function isHistoryCanonical(canonical: string | null | undefined): boolean {
  return typeof canonical === "string" && canonical.startsWith(HISTORY_CANONICAL_PREFIX);
}

type HistoryField = Pick<DiscoveredField, "id" | "label" | "type"> & {
  inputId?: string;
  name?: string;
};

/** `${kind}:${index}` → ordinal, by first appearance in page order. */
export function historyOrdinals(fields: ReadonlyArray<HistoryField>): Map<string, number> {
  const ordinals = new Map<string, number>();
  const counts: Record<"employment" | "education", number> = { employment: 0, education: 0 };
  for (const f of fields) {
    const g = historyGroupOf(f);
    if (!g) continue;
    const key = `${g.kind}:${g.index}`;
    if (ordinals.has(key)) continue;
    ordinals.set(key, counts[g.kind]);
    counts[g.kind] += 1;
  }
  return ordinals;
}

type EmploymentSub =
  | "title"
  | "company"
  | "location"
  | "current"
  | "start"
  | "end"
  | "description";
type EducationSub = "school" | "degree" | "field" | "gpa" | "start" | "end";

const EMPLOYMENT_ID_SUBS: ReadonlyArray<[RegExp, EmploymentSub]> = [
  [/(job)?title$/i, "title"],
  [/company(name)?$|employer(name)?$/i, "company"],
  [/location$/i, "location"],
  [/currently(work|employed)(here)?$|current$/i, "current"],
  [/startdate$|start$|from$/i, "start"],
  [/enddate$|end$|to$/i, "end"],
  [/(role)?description$|responsibilities$/i, "description"],
];
const EMPLOYMENT_LABEL_SUBS: ReadonlyArray<[RegExp, EmploymentSub]> = [
  [/^(job )?title$|^position( title)?$/i, "title"],
  [/^(company|employer)( name)?$/i, "company"],
  [/^location$/i, "location"],
  [/currently work|current(ly)? employed|present position/i, "current"],
  [/^(from|start( date)?)$/i, "start"],
  [/^(to|end( date)?)$/i, "end"],
  [/description|responsibilities/i, "description"],
];
const EDUCATION_ID_SUBS: ReadonlyArray<[RegExp, EducationSub]> = [
  [/school(name)?$|university$|institution$/i, "school"],
  [/degree$/i, "degree"],
  [/fieldofstudy$|major$/i, "field"],
  [/gradeaverage$|gpa$/i, "gpa"],
  [/startdate$|start$|from$/i, "start"],
  [/enddate$|end$|to$|graduation(date)?$/i, "end"],
];
const EDUCATION_LABEL_SUBS: ReadonlyArray<[RegExp, EducationSub]> = [
  [/school|university|institution|college/i, "school"],
  [/^degree/i, "degree"],
  [/field of study|major/i, "field"],
  [/gpa|grade/i, "gpa"],
  [/^(from|start( date)?)$/i, "start"],
  [/^(to|end( date)?|graduation( date)?)$/i, "end"],
];

function subOf<T extends string>(
  field: HistoryField,
  byId: ReadonlyArray<[RegExp, T]>,
  byLabel: ReadonlyArray<[RegExp, T]>,
): T | null {
  // The id suffix after Workday's "--" (or the whole id/name) names the datum.
  const idSources = [field.inputId, field.id, field.name].filter((s): s is string => typeof s === "string" && s.length > 0);
  for (const src of idSources) {
    const tail = src.includes("--") ? src.slice(src.lastIndexOf("--") + 2) : src;
    for (const [re, sub] of byId) if (re.test(tail)) return sub;
  }
  const label = field.label.replace(/\s+/g, " ").trim().replace(/\*$/, "").trim();
  for (const [re, sub] of byLabel) if (re.test(label)) return sub;
  return null;
}

function monthYear(v: { month: string; year: number } | null | undefined): string | null {
  if (!v) return null;
  // Year-only (wizard rows without a month): parseDateParts() returns null
  // for "2024", so a Month/Year widget stays empty instead of guessing.
  return v.month ? `${v.month} ${v.year}` : String(v.year);
}

function locationText(loc: EmploymentEntry["location"] | EducationEntry["location"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.state].map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

export type HistoryAnswer = {
  canonical: string;
  value: unknown;
  reason: string;
};

/**
 * The plan entry for one history-row control, or null when the profile
 * has no structured entry for that row / no datum for that sub-field.
 * `reasonWhenEmpty` explains the miss for the plan's skip note.
 */
export function historyRowAnswer(
  field: HistoryField,
  ordinal: number,
  profile: PublicProfile,
): { answer: HistoryAnswer | null; reasonWhenEmpty: string } {
  const g = historyGroupOf(field);
  if (!g) return { answer: null, reasonWhenEmpty: "not a history row" };
  if (g.kind === "employment") {
    const entries = structuredEmploymentHistory(profile);
    const entry = entries[ordinal];
    if (!entry) {
      return {
        answer: null,
        reasonWhenEmpty: `employment row ${ordinal + 1} — the profile has ${entries.length} structured employment entr${entries.length === 1 ? "y" : "ies"}`,
      };
    }
    const sub = subOf(field, EMPLOYMENT_ID_SUBS, EMPLOYMENT_LABEL_SUBS);
    if (!sub) return { answer: null, reasonWhenEmpty: `employment row ${ordinal + 1} — control "${field.label}" names no known datum` };
    const canonical = `${HISTORY_CANONICAL_PREFIX}employment[${ordinal}].${sub}`;
    const reason = `Structured employment entry ${ordinal + 1} (${entry.company}) — ${sub}`;
    const value: unknown =
      sub === "title" ? entry.title
      : sub === "company" ? entry.company
      : sub === "location" ? locationText(entry.location)
      : sub === "current" ? (entry.current ? true : null)
      : sub === "start" ? monthYear(entry.start)
      : sub === "end" ? (entry.current ? null : monthYear(entry.end))
      : entry.description || null;
    if (value === null || value === "") {
      return {
        answer: null,
        reasonWhenEmpty:
          sub === "end" && entry.current
            ? `employment row ${ordinal + 1} — current position, no end date`
            : sub === "current" && !entry.current
              ? `employment row ${ordinal + 1} — not the current position, box left unchecked`
              : `employment row ${ordinal + 1} — entry has no ${sub}`,
      };
    }
    return { answer: { canonical, value, reason }, reasonWhenEmpty: "" };
  }
  const entries = structuredEducationHistory(profile);
  const entry = entries[ordinal];
  if (!entry) {
    return {
      answer: null,
      reasonWhenEmpty: `education row ${ordinal + 1} — the profile has ${entries.length} structured education entr${entries.length === 1 ? "y" : "ies"}`,
    };
  }
  const sub = subOf(field, EDUCATION_ID_SUBS, EDUCATION_LABEL_SUBS);
  if (!sub) return { answer: null, reasonWhenEmpty: `education row ${ordinal + 1} — control "${field.label}" names no known datum` };
  const canonical = `${HISTORY_CANONICAL_PREFIX}education[${ordinal}].${sub}`;
  const reason = `Structured education entry ${ordinal + 1} (${entry.school}) — ${sub}`;
  const value: unknown =
    sub === "school" ? entry.school
    : sub === "degree" ? entry.degree || null
    : sub === "field" ? entry.field_of_study || null
    : sub === "gpa" ? (typeof entry.gpa === "number" ? String(entry.gpa) : null)
    : sub === "start" ? monthYear(entry.start)
    : monthYear(entry.end);
  if (value === null || value === "") {
    return { answer: null, reasonWhenEmpty: `education row ${ordinal + 1} — entry has no ${sub}` };
  }
  return { answer: { canonical, value, reason }, reasonWhenEmpty: "" };
}
