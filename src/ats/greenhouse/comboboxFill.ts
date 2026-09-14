import type { Locator, Page } from "playwright";

/**
 * Phase 5.6 live finding: Greenhouse job-boards renders selects as
 * React-select-style comboboxes. `.fill()` on them types filter text into
 * the inner input without ever committing an option — the UI keeps showing
 * "Select..." while inputValue() lies that something was entered. This
 * module opens, filters, picks a REAL option from the rendered list, and
 * confirms commitment from the visible display. Values are never invented:
 * no matching option means no selection plus a loud error.
 *
 * Live job-boards quirks handled here:
 * - Country options look like "United States +1"; display may collapse to "+1"
 * - Degree taxonomy uses "Bachelor's Degree" not "Bachelor of Science"
 * - Async / virtualized menus need sequential typing, not a single fill()
 */

export type ControlKind = "native_select" | "combobox" | "text";

export type ComboboxFillResult = {
  committed: boolean;
  selectedLabel: string | null;
  notes: string[];
  /** First visible options at pick time (training signal). */
  optionsSample?: string[];
  /** How the option was matched: exact | synonym | unique_substring | ci_exact */
  pickVia?: string | null;
};

export type OptionPick =
  | {
      ok: true;
      label: string;
      via: "exact" | "ci_exact" | "unique_substring" | "synonym" | "other_fallback";
    }
  | { ok: false; reason: string };

const PLACEHOLDER_RE = /^select\.{0,3}…?$|^select…$|^select\.\.\.$/i;

/** "United States +1" → "united states" */
export function stripDialCode(s: string): string {
  return s.replace(/\s*\+\d+\s*$/u, "").trim();
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Loose key for synonym / degree / punctuation-insensitive compare. */
function optionKey(s: string): string {
  return (
    normalize(stripDialCode(s))
      .replace(/['']/g, "")
      .replace(/[^a-z0-9&+]/g, " ")
      // #94: "&" and "and" are the same conjunction — "Applied
      // Mathematics and Statistics" must key like "Applied Mathematics &
      // Statistics" (majors taxonomies use both spellings).
      .replace(/&/g, " and ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Known education vocabulary on Greenhouse job-boards. Profile strings are
 * often "Bachelor of Science"; options are "Bachelor's Degree".
 */
const DEGREE_BUCKETS: ReadonlyArray<readonly string[]> = [
  ["associate", "associates degree", "associate's degree"],
  [
    "bachelor",
    "bachelors",
    "bachelors degree",
    "bachelor degree",
    "bachelor of science",
    "bachelor of arts",
    "bachelor of engineering",
    "bs",
    "ba",
    "bsc",
    "b eng",
  ],
  [
    "master",
    "masters",
    "masters degree",
    "master degree",
    "master of science",
    "master of arts",
    "mba",
    "ms",
    "ma",
    "msc",
  ],
  ["phd", "ph d", "doctor of philosophy", "doctorate"],
  ["jd", "juris doctor", "j d"],
  ["md", "doctor of medicine", "m d"],
  ["high school", "secondary"],
];

/**
 * Phone device-type vocabulary. Live PIMCO wd1 2026-09-14: the bank's
 * "Mobile" met a list of "Cell - Personal | Cell - Business | Home | Work"
 * — no rung matched, verify then failed on the page's own default. A
 * cell phone is a mobile phone; within the bucket a "personal" row beats a
 * "business/work" one for the candidate's own number.
 */
const PHONE_TYPE_BUCKETS: ReadonlyArray<readonly string[]> = [
  ["mobile", "cell", "cellular", "mobile phone", "cell phone", "cellphone"],
  ["home", "landline", "home phone", "residence"],
  ["work", "business", "office", "work phone"],
];

/** Loose: the OPTION side — "Cell - Personal", "Home Phone", "Work" carry a bucket token. */
function phoneTypeBucket(key: string): number {
  const tokens = key.split(" ");
  for (let i = 0; i < PHONE_TYPE_BUCKETS.length; i++) {
    if (PHONE_TYPE_BUCKETS[i]!.some((b) => key === b || tokens.includes(b))) return i;
  }
  return -1;
}

/**
 * Strict: the EXPECTED side must BE a device type ("Mobile", "cell
 * phone", "Home number") — not merely contain one of its words. Gate
 * evidence: "Chicago office" keyed to the work bucket via "office" and
 * a radio group committed "New York office" for it (ashby-native-group).
 */
function phoneTypeBucketStrict(key: string): number {
  const m = key.match(/^([a-z]+(?: [a-z]+)?)(?: (?:phone|number))?$/);
  if (!m) return -1;
  const head = m[1]!;
  for (let i = 0; i < PHONE_TYPE_BUCKETS.length; i++) {
    if (PHONE_TYPE_BUCKETS[i]!.includes(head)) return i;
  }
  return -1;
}

/** Option in the expected value's phone-type bucket, personal rows first. */
function pickPhoneTypeOption(options: string[], expected: string): OptionPick | null {
  const bucket = phoneTypeBucketStrict(optionKey(expected));
  if (bucket < 0) return null;
  const hits = options.filter((o) => phoneTypeBucket(optionKey(o)) === bucket);
  if (hits.length === 0) return null;
  const personal = hits.find((o) => /personal/i.test(o));
  const notBusiness = hits.find((o) => !/business|work|office/i.test(o));
  return { ok: true, label: personal ?? notBusiness ?? hits[0]!, via: "synonym" };
}

function degreeBucket(key: string): number {
  const padded = ` ${key} `;
  for (let i = 0; i < DEGREE_BUCKETS.length; i++) {
    const bucket = DEGREE_BUCKETS[i]!;
    if (
      bucket.some((b) => {
        // Whole-token / whole-phrase match only — short codes like "ma"/"ms"/"bs"
        // must not fire inside "math" / "stats".
        if (b.length <= 3) {
          return padded.includes(` ${b} `) || key === b;
        }
        return key === b || key.includes(b) || b.includes(key);
      })
    ) {
      return i;
    }
  }
  return -1;
}

/** Entire-string yes/no only (profile short values + binary options). */
function yesNoToken(v: string): "yes" | "no" | null {
  const n = normalize(v);
  if (["yes", "y", "true", "1"].includes(n)) return "yes";
  if (["no", "n", "false", "0"].includes(n)) return "no";
  return null;
}

/**
 * Leading yes/no for long EEO/OFCCP sentences:
 * "No, I do not have a disability…" → no
 * "Yes, I have a disability…" → yes
 * "I do not want to answer" does not lead with yes/no → null
 */
function leadingYesNo(v: string): "yes" | "no" | null {
  const n = normalize(v);
  if (/^yes\b/.test(n)) return "yes";
  if (/^no\b/.test(n)) return "no";
  return null;
}

/** Decline / prefer-not-to-answer — never map bare Yes/No onto these. */
function isDeclineOption(v: string): boolean {
  const k = optionKey(v);
  return (
    /decline|prefer not|prefer not to say|do not want to answer|dont want to answer|i do not want|i dont want|not answer|do not wish|dont wish|i do not wish|i dont wish/.test(
      k,
    ) &&
    // Keep disability "No, I do not have a disability…" out of decline.
    !/\bhave a disability\b|\bhad a disability\b|\bhave not had one\b|\bdo not have a disability\b/.test(
      k,
    )
  );
}

/**
 * Match bare Yes/No to short options or long sentence options that *start*
 * with Yes/No (word boundary). Never attaches No → "I do not want…" via
 * substring ("not" contains "no").
 */
function pickYesNoOption(
  options: string[],
  expYn: "yes" | "no",
): OptionPick | null {
  const candidates = options.filter((o) => {
    if (isDeclineOption(o)) return false;
    if (yesNoToken(o) === expYn) return true;
    if (leadingYesNo(o) === expYn) return true;
    const k = optionKey(o);
    // OFCCP veteran (does not lead with Yes/No):
    // "I am not a protected veteran" / "I identify as one or more … protected veteran"
    if (expYn === "no" && /not a protected veteran|i am not a protected veteran/.test(k)) {
      return true;
    }
    if (
      expYn === "yes" &&
      /protected veteran/.test(k) &&
      !/not a protected veteran/.test(k) &&
      (/i identify as|i am a|classifications of a protected/.test(k) ||
        leadingYesNo(o) === "yes")
    ) {
      return true;
    }
    return false;
  });
  if (candidates.length === 1 && candidates[0] !== undefined) {
    return { ok: true, label: candidates[0], via: "synonym" };
  }
  if (candidates.length > 1) {
    // Prefer short binary label when present, else first leading-yes/no
    // sentence (OFCCP disability "No, I do not have…").
    const bare = candidates.find((o) => yesNoToken(o) === expYn);
    if (bare) return { ok: true, label: bare, via: "ci_exact" };
    // Prefer disability / veteran "No, …" / "Yes, …" over other long hits.
    const ofccpish = candidates.find((o) =>
      /disability|veteran|protected|armed forces/i.test(o),
    );
    if (ofccpish) return { ok: true, label: ofccpish, via: "synonym" };
    return {
      ok: false,
      reason: `ambiguous yes/no match for "${expYn}": ${candidates.slice(0, 5).join(" | ")}`,
    };
  }
  return null;
}

/** Word-boundary containment — blocks "no" ⊂ "not". */
function containsAsWord(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length === 0) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/** Country vocabulary differences between profiles and location autocompletes. */
const COUNTRY_SYNONYMS: Record<string, string> = {
  usa: "united states",
  us: "united states",
  "u s a": "united states",
  "united states of america": "united states",
  uk: "united kingdom",
};

/**
 * USPS name ↔ abbreviation. Paylocity (live 053aa25b) lists MD, not
 * Maryland. Matching only fires when the page actually offers one of the
 * pair — we never invent a code into an empty list.
 */
const US_STATE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["alabama", "al"],
  ["alaska", "ak"],
  ["arizona", "az"],
  ["arkansas", "ar"],
  ["california", "ca"],
  ["colorado", "co"],
  ["connecticut", "ct"],
  ["delaware", "de"],
  ["district of columbia", "dc"],
  ["florida", "fl"],
  ["georgia", "ga"],
  ["hawaii", "hi"],
  ["idaho", "id"],
  ["illinois", "il"],
  ["indiana", "in"],
  ["iowa", "ia"],
  ["kansas", "ks"],
  ["kentucky", "ky"],
  ["louisiana", "la"],
  ["maine", "me"],
  ["maryland", "md"],
  ["massachusetts", "ma"],
  ["michigan", "mi"],
  ["minnesota", "mn"],
  ["mississippi", "ms"],
  ["missouri", "mo"],
  ["montana", "mt"],
  ["nebraska", "ne"],
  ["nevada", "nv"],
  ["new hampshire", "nh"],
  ["new jersey", "nj"],
  ["new mexico", "nm"],
  ["new york", "ny"],
  ["north carolina", "nc"],
  ["north dakota", "nd"],
  ["ohio", "oh"],
  ["oklahoma", "ok"],
  ["oregon", "or"],
  ["pennsylvania", "pa"],
  ["rhode island", "ri"],
  ["south carolina", "sc"],
  ["south dakota", "sd"],
  ["tennessee", "tn"],
  ["texas", "tx"],
  ["utah", "ut"],
  ["vermont", "vt"],
  ["virginia", "va"],
  ["washington", "wa"],
  ["west virginia", "wv"],
  ["wisconsin", "wi"],
  ["wyoming", "wy"],
];

const US_STATE_ABBR: Record<string, string> = Object.fromEntries(US_STATE_PAIRS);
const US_STATE_NAME: Record<string, string> = Object.fromEntries(
  US_STATE_PAIRS.map(([name, abbr]) => [abbr, name]),
);

function usStateSynonyms(expectedKey: string): string[] | null {
  const abbr = US_STATE_ABBR[expectedKey];
  if (abbr) return [expectedKey, abbr];
  const name = US_STATE_NAME[expectedKey];
  if (name) return [expectedKey, name];
  return null;
}

function pickUsStateOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const syns = usStateSynonyms(optionKey(expected));
  if (!syns) return null;
  const hits = options.filter((o) => syns.includes(optionKey(o)));
  if (hits.length === 0) return null;
  const prefer = hits.find((o) => optionKey(o) === optionKey(expected));
  return { ok: true, label: prefer ?? hits[0]!, via: "synonym" };
}

function locationParts(s: string): string[] {
  return s
    .split(",")
    .map((p) => optionKey(p))
    .filter((p) => p.length > 0)
    .map((p) => COUNTRY_SYNONYMS[p] ?? US_STATE_ABBR[p] ?? p);
}

/**
 * Comma-shaped location matching. Live failure (impact.com, cc02e067):
 * profile "Baltimore, Maryland, USA" vs board options "Baltimore, Maryland,
 * United States" plus near-ties ("Baltimore County, …", "Baltimore
 * Highlands, …") — token overlap ties and refuses. Compare comma parts
 * pairwise with country synonyms; among hits prefer the shortest label
 * (the bare city). Null when the expected value is not location-shaped.
 */
export function pickLocationOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const expParts = locationParts(expected);
  if (expParts.length === 1) {
    // Live 2026-08-28 (Figma greenhouse candidate-location): the plan holds
    // the bare city ("Baltimore"); the places list offers "Baltimore,
    // Maryland, United States" (listed twice), "New Baltimore, Michigan…",
    // "Baltimore Highlands, Maryland…". Exact first-comma-part match drops
    // the prefix/suffix towns, and identical-label dedupe collapses the
    // doubled row to one choice. Two DIFFERENT cities sharing the name
    // (Baltimore, Ireland) still refuse — that needs state context the
    // expected value does not carry.
    const hits = options.filter((o) => {
      const parts = locationParts(o);
      return parts.length >= 2 && parts[0] === expParts[0];
    });
    const distinct = new Set(hits.map((o) => normalize(o)));
    if (distinct.size === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
    return null;
  }
  if (expParts.length < 2) return null;
  const hits = options.filter((o) => {
    const parts = locationParts(o);
    if (parts.length === 0) return false;
    const n = Math.min(expParts.length, parts.length);
    for (let i = 0; i < n; i++) {
      if (expParts[i] !== parts[i]) return false;
    }
    return true;
  });
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => a.length - b.length);
  return { ok: true, label: sorted[0]!, via: "synonym" };
}

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const SEASON_WORD_RE = /\b(winter|spring|summer|fall|autumn)\b/;

function monthNumber(raw: string): number | null {
  const k = optionKey(raw);
  if (MONTH_INDEX[k] !== undefined) return MONTH_INDEX[k]!;
  const n = Number(k);
  if (Number.isInteger(n) && n >= 1 && n <= 12) return n;
  return null;
}

/** Academic-calendar seasons. May → spring; Jump's "Spring/Summer" matches spring. */
function seasonsForMonth(month: number): string[] {
  if (month === 12 || month <= 2) return ["winter"];
  if (month <= 5) return ["spring"];
  if (month <= 7) return ["summer"];
  return ["fall", "autumn"];
}

function parseYearMonthExpected(
  expected: string,
): { year: string; month: number | null } | null {
  const t = expected.trim();
  const yearOnly = t.match(/^(20\d{2}|19\d{2})$/);
  if (yearOnly?.[1]) return { year: yearOnly[1], month: null };
  const monthYear = t.match(/^([A-Za-z]+|\d{1,2})\s+(20\d{2}|19\d{2})$/);
  if (monthYear?.[1] && monthYear[2]) {
    return { year: monthYear[2], month: monthNumber(monthYear[1]) };
  }
  const yearMonth = t.match(/^(20\d{2}|19\d{2})\s+([A-Za-z]+|\d{1,2})$/);
  if (yearMonth?.[1] && yearMonth[2]) {
    return { year: yearMonth[1], month: monthNumber(yearMonth[2]) };
  }
  return null;
}

/**
 * Profile stores a year (and usually a month). Boards like Jump offer
 * "Winter 2029 | Spring/Summer 2029 | Fall 2029". A bare year is
 * ambiguous — refuse. Month + year that uniquely names one season is not.
 */
function pickSeasonalYearOption(
  options: string[],
  expected: string,
): OptionPick | null {
  const parsed = parseYearMonthExpected(expected);
  if (!parsed) return null;
  const yearHits = options.filter((o) => {
    const k = optionKey(o);
    return (
      containsAsWord(k, parsed.year) && SEASON_WORD_RE.test(k)
    );
  });
  if (yearHits.length === 0) return null;
  if (yearHits.length === 1 && yearHits[0] !== undefined) {
    return { ok: true, label: yearHits[0], via: "unique_substring" };
  }
  if (parsed.month === null) return null;
  const seasons = seasonsForMonth(parsed.month);
  const seasonHits = yearHits.filter((o) => {
    const k = optionKey(o);
    return seasons.some((s) => containsAsWord(k, s));
  });
  if (seasonHits.length === 1 && seasonHits[0] !== undefined) {
    return { ok: true, label: seasonHits[0], via: "synonym" };
  }
  return null;
}

/**
 * Pure option matching: exact → case-insensitive exact → dial-stripped →
 * location parts → degree synonym → yes/no (word-leading) → unique
 * substring (either direction) → seasonal year + month. Values are never
 * invented: multi-hit substring refuses unless a profile month names one
 * season.
 */
export function pickOptionLabel(options: string[], expected: string): OptionPick {
  const exp = expected.trim();
  if (exp === "") return { ok: false, reason: "expected value is empty" };

  // Operator rule: any math-ish major/discipline → prefer bare "Mathematics"
  // over compound "Applied Mathematics & Statistics" / "Applied Math & Stats"
  // when the board offers both (or only Mathematics).
  if (/\bmath/i.test(exp)) {
    const bareMath = options.find((o) => {
      const k = optionKey(o);
      return k === "mathematics" || normalize(o) === "mathematics";
    });
    if (bareMath) return { ok: true, label: bareMath, via: "synonym" };
  }

  const exact = options.find((o) => o.trim() === exp);
  if (exact) return { ok: true, label: exact, via: "exact" };

  const ciExact = options.filter((o) => normalize(o) === normalize(exp));
  if (ciExact.length === 1 && ciExact[0] !== undefined) {
    return { ok: true, label: ciExact[0], via: "ci_exact" };
  }

  // Country / phone-style labels: "United States" ↔ "United States +1"
  const strippedExp = optionKey(exp);

  // OFCCP veteran: profile "I am not a protected veteran" (or close) → board copy.
  // Boards phrase the negative answer with or without "protected"; match either,
  // but ONLY negative-polarity options — never an "I identify as…" row.
  if (
    /not a protected veteran|i am not a protected veteran|not a veteran/.test(
      strippedExp,
    )
  ) {
    const vetHits = options.filter((o) => {
      if (isDeclineOption(o)) return false;
      const k = optionKey(o);
      return /not\s+a(?:\s+protected)?\s+veteran/.test(k);
    });
    if (vetHits.length === 1 && vetHits[0] !== undefined) {
      return { ok: true, label: vetHits[0], via: "synonym" };
    }
    if (vetHits.length > 1) {
      const prefer = vetHits.find((o) =>
        /i am not a protected veteran/i.test(o),
      );
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const dialHits = options.filter((o) => optionKey(o) === strippedExp);
  if (dialHits.length === 1 && dialHits[0] !== undefined) {
    return { ok: true, label: dialHits[0], via: "ci_exact" };
  }

  // "Mobile" ↔ "Cell - Personal" (Workday device-type lists).
  const phonePick = pickPhoneTypeOption(options, exp);
  if (phonePick) return phonePick;

  // State name ↔ USPS code before substring (Maryland must not land on
  // Maryland Heights when MD is on the list).
  const statePick = pickUsStateOption(options, exp);
  if (statePick) return statePick;

  // Location strings before generic token overlap — Baltimore variants tie
  // under token scoring but resolve cleanly by comma-part comparison.
  const locPick = pickLocationOption(options, exp);
  if (locPick) return locPick;
  // Full state name with no USPS/name option: do not unique-substring
  // into "Maryland Heights". Codes like OR/IN still fall through.
  if (US_STATE_ABBR[optionKey(exp)]) {
    return {
      ok: false,
      reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
    };
  }
  // country dial substrings: optionKey compare already handled as dialHits.
  // Keep dial-stripped unique substring here too (tight length gate):
  const dialSub = options.filter((o) => {
      const ok = optionKey(o);
      return (
        ok.length > 0 &&
        (ok.includes(strippedExp) ||
          (strippedExp.includes(ok) &&
            ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))))
      );
    });
  if (dialSub.length === 1 && dialSub[0] !== undefined && strippedExp.length >= 3) {
    return { ok: true, label: dialSub[0], via: "unique_substring" };
  }

  const expBucket = degreeBucket(strippedExp);
  if (expBucket >= 0) {
    const degHits = options.filter((o) => degreeBucket(optionKey(o)) === expBucket);
    if (degHits.length === 1 && degHits[0] !== undefined) {
      return { ok: true, label: degHits[0], via: "synonym" };
    }
    // Prefer bare "Bachelor's Degree" over longer specialized degrees when many.
    if (degHits.length > 1) {
      const prefer = degHits.find((o) =>
        /bachelor'?s degree|master'?s degree|associate'?s degree/i.test(o),
      );
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const expYn = yesNoToken(exp);
  if (expYn) {
    const ynPick = pickYesNoOption(options, expYn);
    if (ynPick) {
      if (ynPick.ok) return ynPick;
      // Ambiguous yes/no evidence — do not fall through to substring that
      // would re-match "not" on decline lines.
      return ynPick;
    }
    // Relocation sentence sets never lead with Yes/No (live: Cloudflare
    // "I am willing to relocate to this job's location." vs "I do not
    // live and not willing to relocate…"). Bank relocation=Yes means
    // willing; No means not willing. Only fires when the option set is
    // unambiguously relocation-shaped.
    const relocationOptions = options.filter((o) => /relocat/i.test(o));
    if (relocationOptions.length >= 2) {
      const willing = options.filter(
        (o) => /willing to relocate/i.test(o) && !/\bnot\b/i.test(optionKey(o)),
      );
      const notWilling = options.filter((o) =>
        /not willing to relocate|not able to relocate/i.test(o),
      );
      if (expYn === "yes" && willing.length === 1 && willing[0] !== undefined) {
        return { ok: true, label: willing[0], via: "synonym" };
      }
      if (expYn === "no" && notWilling.length === 1 && notWilling[0] !== undefined) {
        return { ok: true, label: notWilling[0], via: "synonym" };
      }
    }
  }

  // Gender vocabulary: operator "Man"/"Woman" ↔ board "Male"/"Female".
  // Identity boards keep Man/Woman; binary Sex select uses Male/Female.
  const genderMap: Record<string, string[]> = {
    man: ["man", "male", "m"],
    male: ["male", "man", "m"],
    woman: ["woman", "female", "f"],
    female: ["female", "woman", "f"],
    "non-binary": ["non-binary", "nonbinary", "non binary"],
    nonbinary: ["non-binary", "nonbinary", "non binary"],
  };
  const gKey = strippedExp;
  const gSyns = genderMap[gKey];
  if (gSyns) {
    // Prefer exact token match for identity ("Man") vs binary ("Male").
    const preferExact = options.filter((o) => optionKey(o) === gKey);
    if (preferExact.length === 1 && preferExact[0] !== undefined) {
      return { ok: true, label: preferExact[0], via: "synonym" };
    }
    const hits = options.filter((o) => {
      const ok = optionKey(o);
      return gSyns.some((s) => ok === s || ok.startsWith(s + " "));
    });
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
  }

  // Orientation: Heterosexual ↔ "Heterosexual or straight"
  if (
    strippedExp === "heterosexual" ||
    strippedExp === "straight" ||
    strippedExp === "heterosexual or straight"
  ) {
    const hits = options.filter((o) => {
      const ok = optionKey(o);
      return (
        ok === "heterosexual" ||
        ok === "straight" ||
        ok.includes("heterosexual") ||
        ok.includes("straight")
      );
    });
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
  }

  // Race: profile "Asian" — pick bare "Asian" or a single non-Hispanic Asian option.
  if (strippedExp === "asian") {
    const exact = options.find((o) => optionKey(o) === "asian");
    if (exact) return { ok: true, label: exact, via: "exact" };
    const asianHits = options.filter(
      (o) => /\basian\b/i.test(o) && !/hispanic|latino|latinx/i.test(o),
    );
    if (asianHits.length === 1 && asianHits[0] !== undefined) {
      return { ok: true, label: asianHits[0], via: "synonym" };
    }
    // Prefer "South Asian" / "East Asian" only when that is the sole remaining hit
    // class — never multi-pick Hispanic.
    if (asianHits.length > 1) {
      const prefer = asianHits.find((o) => /^asian$/i.test(o.trim()));
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  // Decline / prefer-not-to-say vocabulary (EEO questions).
  const declineRe =
    /decline|prefer not|do not wish|don t wish|dont wish|not answer|prefer not to say|i don t wish|i do not wish/;
  if (declineRe.test(strippedExp)) {
    const hits = options.filter((o) => declineRe.test(optionKey(o)));
    if (hits.length === 1 && hits[0] !== undefined) {
      return { ok: true, label: hits[0], via: "synonym" };
    }
    if (hits.length > 1) {
      const prefer = hits.find((o) => /decline/i.test(o));
      if (prefer) return { ok: true, label: prefer, via: "synonym" };
    }
  }

  const sub = options.filter((o) => {
    const ok = optionKey(o);
    if (ok.length < 2 || strippedExp.length < 2) return false;
    // Short tokens (yes/no/us) must be whole words — "no" must not hit "not".
    if (strippedExp.length <= 3) {
      return containsAsWord(ok, strippedExp);
    }
    // Prefer option that contains expected (filter refinements).
    if (ok.includes(strippedExp)) return true;
    // expected contains option only when the option is substantial —
    // blocks "Mathematics" from swallowing "Applied Mathematics".
    if (
      strippedExp.includes(ok) &&
      ok.length >= Math.max(10, Math.floor(strippedExp.length * 0.6))
    ) {
      return true;
    }
    return false;
  });
  if (sub.length === 1 && sub[0] !== undefined) {
    return { ok: true, label: sub[0], via: "unique_substring" };
  }
  // Boards can list the same label twice (live: doubled places rows);
  // identical strings are one choice, not an ambiguity.
  if (sub.length > 1 && sub[0] !== undefined) {
    const distinct = new Set(sub.map((o) => normalize(o)));
    if (distinct.size === 1) {
      return { ok: true, label: sub[0], via: "unique_substring" };
    }
  }
  const seasonal = pickSeasonalYearOption(options, exp);
  if (seasonal) return seasonal;
  // #237 (live Saronic ashby 2026-09-10, two apps): Ashby's education
  // "School" control is a typeahead over a school DIRECTORY, and each row
  // concatenates the school name with its country and domain. Typing
  // "Johns Hopkins University" returns three rows:
  //
  //   Johns Hopkins UniversityUnited Statesjhu.edu
  //   Johns Hopkins University School of Advanced International Studies…
  //   Johns Hopkins University SAIS Bologna Center…
  //
  // All three CONTAIN the query, so the substring filter called it
  // ambiguous and refused — and the school (a required education field)
  // stayed empty on every such form. Directory-backed typeaheads behave
  // this way everywhere; the two rejected rows are different, LONGER
  // school names that merely begin with the same words.
  //
  // The tell is not "shortest" — that is too blunt, and it would pick
  // "Baltimore, County Cork, Ireland" over "Baltimore, Maryland, United
  // States", or resolve the fragment "United" to a country. The tell is
  // WHAT FOLLOWS the query. A row that continues with a space or a comma
  // is still saying the name ("Johns Hopkins University| School of…",
  // "Baltimore|, County Cork"); a row that continues with a glued
  // alphanumeric character has ended the name and started concatenated
  // metadata ("Johns Hopkins University|United Statesjhu.edu"). So: the
  // query must be a whole-name prefix of exactly ONE row, with the rest
  // glued on. Anything else stays an honest refusal.
  if (sub.length > 1 && strippedExp.length >= 8) {
    const glued = sub.filter((o) => {
      const key = optionKey(o);
      if (!key.startsWith(strippedExp) || key.length === strippedExp.length) return false;
      return /[a-z0-9]/.test(key.charAt(strippedExp.length));
    });
    const only = glued.length === 1 ? glued[0] : undefined;
    if (only !== undefined) {
      return { ok: true, label: only, via: "unique_substring" };
    }
  }
  if (sub.length > 1) {
    // Name the TOTAL candidate count — live 2026-08-28 the 5-entry display
    // hid the namesake row that actually caused the refusal, twice.
    return {
      ok: false,
      reason: `ambiguous match for "${exp}" (${sub.length} candidates): ${sub.slice(0, 5).join(" | ")}${sub.length > 5 ? " | …" : ""}`,
    };
  }

  // Token overlap (discipline / school nicknames): "Applied Math & Stats"
  // may not exist on the GH board — prefer "Mathematics" / "Statistics…" over
  // a weak "Applied Health Services" hit.
  const tokens = strippedExp
    .split(/\s+/)
    .map((t) => t.replace(/&/g, "").trim())
    .filter((t) => t.length >= 3 && !["and", "the", "for", "of"].includes(t))
    .map((t) => {
      if (t === "stats" || t === "stat") return "statistic";
      if (t === "math" || t === "maths") return "math";
      if (t === "comp" || t === "cs") return "computer";
      return t;
    });
  if (tokens.length >= 1) {
    const scored = options
      .map((o) => {
        const ok = optionKey(o);
        let score = 0;
        for (const t of tokens) {
          if (ok.includes(t)) score += 1;
          else if (t === "math" && ok.includes("mathematic")) score += 3;
          else if (t === "statistic" && ok.includes("statistic")) score += 3;
          else if (t === "computer" && ok.includes("computer")) score += 3;
        }
        // Downgrade generic "applied …" matches that only hit "applied"
        if (
          score === 1 &&
          tokens.includes("applied") &&
          ok.startsWith("applied") &&
          !ok.includes("math") &&
          !ok.includes("stat")
        ) {
          score = 0;
        }
        return { o, score };
      })
      .filter((x) => x.score >= 1);
    scored.sort((a, b) => b.score - a.score);
    if (
      scored.length >= 1 &&
      scored[0] !== undefined &&
      (scored.length === 1 || scored[0].score > (scored[1]?.score ?? 0))
    ) {
      return { ok: true, label: scored[0].o, via: "unique_substring" };
    }
  }

  return {
    ok: false,
    reason: `no option matches "${exp}" (options: ${options.slice(0, 8).join(" | ")}${options.length > 8 ? " | …" : ""})`,
  };
}

/**
 * Whether the visible committed label matches the option we clicked.
 * Handles Greenhouse country UI collapsing "United States +1" → "+1".
 *
 * Note: bare +1 is shared by US/Canada/etc. We only accept dial-only
 * display against a *country name* when the pick/label text included that
 * dial (p.includes("+1")) — profile "United States" alone does not match
 * "+1"; verify must use a richer committed label or the dial must be
 * carried in the expected side (see valuesMatch phone/country helpers).
 */
export function labelsCompatible(
  pickedLabel: string,
  display: string | null,
): boolean {
  if (display === null) return false;
  const d = display.replace(/\s+/g, " ").trim();
  if (d === "" || PLACEHOLDER_RE.test(d)) return false;

  const p = pickedLabel.replace(/\s+/g, " ").trim();
  if (p === "") return false;
  if (normalize(p) === normalize(d)) return true;

  // Never treat empty substring as a match — "".includes is always true.
  const np = normalize(p);
  const nd = normalize(d);
  if (np.length >= 2 && nd.length >= 2 && (np.includes(nd) || nd.includes(np))) {
    return true;
  }

  const op = optionKey(p);
  const od = optionKey(d);
  if (op.length === 0 || od.length === 0) {
    // optionKey("+1") is empty after dial-strip; still allow collapse
    // when the picked option string clearly carried that dial.
    if (/^\+\d+$/.test(d) && p.includes(d)) return true;
    return false;
  }
  if (op === od) return true;
  if (op.length >= 2 && od.length >= 2 && (op.includes(od) || od.includes(op))) {
    return true;
  }
  const pSyns = usStateSynonyms(op);
  if (pSyns && pSyns.includes(od)) return true;
  // Dial-code-only display after picking "Country +N"
  if (/^\+\d+$/.test(d) && p.includes(d)) return true;
  // "Mobile" committed as "Cell - Personal": same device-type bucket.
  const pb = phoneTypeBucketStrict(op);
  if (pb >= 0 && pb === phoneTypeBucket(od)) return true;
  return false;
}

/**
 * Operator directive 2026-09-14 (how-did-you-hear): "most of the time
 * LinkedIn isn't there, so it should pick any social media you can
 * choose." A class rung between the exact/alternate picks and the
 * "Other" / first-option last resorts: the FIRST pattern that any option
 * satisfies wins, options in page order. Patterns are the caller's — this
 * helper is pure and never invents an option. Placeholder rows are never
 * picked.
 */
export function classPatternPick(
  options: string[],
  patterns: ReadonlyArray<RegExp>,
): string | null {
  const real = options.filter((o) => {
    const t = o.trim();
    return t !== "" && !PLACEHOLDER_RE.test(t) && !PLACEHOLDER_OPTION_RE.test(t);
  });
  for (const re of patterns) {
    const hit = real.find((o) => re.test(o));
    if (hit) return hit;
  }
  return null;
}

/**
 * How-did-you-hear class ladder, most to least specific: the brand, then
 * any social-media row, then job boards, then the open internet. Every
 * rung is truthful for a posting found through JobRight/LinkedIn.
 */
export const HOW_HEARD_CLASS_PATTERNS: ReadonlyArray<RegExp> = [
  /linkedin/i,
  /social\s*(media|network)/i,
  /\b(facebook|instagram|twitter|x\.com|tiktok|youtube|reddit|glassdoor|handshake)\b/i,
  /\b(job|career)s?\s*(board|site|website|posting|search)/i,
  /\b(online|internet|web\s*site|website|search\s*engine|google)\b/i,
];

/**
 * Live rb.wd5 2026-09-14 (app 02302b66): a country listbox popper stayed
 * open after its pick — `data-popper-reference-hidden` — and intercepted
 * every later click on the page ("<div>Uruguay</div> … intercepts pointer
 * events"), so first/last name and the whole address block timed out and
 * verify failed on six fields. One bounded recovery: on a click timeout,
 * dismiss stray popups (Escape, then a click on the page body away from
 * any control) and retry the click ONCE. A click that still fails throws
 * as before.
 */
export async function clickPastStrayPopup(
  page: Page,
  loc: Locator,
  opts: { timeoutMs?: number } = {},
): Promise<{ recovered: boolean }> {
  const timeout = opts.timeoutMs ?? 5_000;
  try {
    await loc.click({ timeout });
    return { recovered: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only an intercepted/timed-out click is a popup symptom; a detached
    // or missing element is a different failure and must surface as such.
    if (!/intercepts pointer events|Timeout \d+ms exceeded/.test(msg)) throw err;
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(200);
    const strays = page
      .locator("[data-popper-placement], [data-popper-reference-hidden]")
      .filter({ visible: true });
    if ((await strays.count().catch(() => 0)) > 0) {
      // A neutral click blurs whatever owns the popper; the body corner is
      // never a form control.
      await page.mouse.click(2, 2).catch(() => undefined);
      await page.waitForTimeout(300);
    }
    await loc.click({ timeout });
    return { recovered: true };
  }
}

/**
 * Classify the live control. Role/aria evidence first; hashed-class
 * fallbacks (React-select "select__control", select2) are last because
 * Greenhouse's CSS-module names churn.
 */
export async function detectControlKind(loc: Locator): Promise<ControlKind> {
  return loc.evaluate((el: {
    tagName: string;
    getAttribute: (n: string) => string | null;
    closest: (s: string) => unknown;
  }) => {
    if (el.tagName === "SELECT") return "native_select" as const;
    const role = el.getAttribute("role") ?? "";
    const haspopup = el.getAttribute("aria-haspopup") ?? "";
    const autocomplete = el.getAttribute("aria-autocomplete") ?? "";
    if (
      role === "combobox" ||
      haspopup === "listbox" ||
      haspopup === "true" ||
      autocomplete === "list" ||
      autocomplete === "both"
    ) {
      return "combobox" as const;
    }
    if (
      el.closest('[class*="select__control"]') ||
      el.closest('[class*="select-shell"]') ||
      el.closest('[class*="select2"]') ||
      el.closest('[role="combobox"]')
    ) {
      return "combobox" as const;
    }
    // #70 (live tiaa #22s): Workday multiselect search inputs carry no
    // role/haspopup — VERIFY classified them "text", read the input's
    // empty value, and failed a committed chip. The widget marker / the
    // container is the tell.
    if (
      el.getAttribute("data-uxi-widget-type") === "selectinput" ||
      el.closest("[data-automation-id='multiSelectContainer']")
    ) {
      return "combobox" as const;
    }
    return "text" as const;
  });
}

/** Committed display text, or null while the placeholder is showing. */
export async function readComboboxValue(loc: Locator): Promise<string | null> {
  type ContainerEl = {
    querySelector: (s: string) => {
      textContent: string | null;
      getAttribute?: (n: string) => string | null;
      childNodes?: ArrayLike<{ textContent?: string | null; nodeType?: number }>;
    } | null;
    querySelectorAll: (s: string) => ArrayLike<{ textContent: string | null }>;
    textContent: string | null;
    closest: (s: string) => ContainerEl | null;
  };
  const raw = await loc.evaluate((el: ContainerEl & { value?: string; parentElement?: ContainerEl | null; tagName?: string; getAttribute?: (n: string) => string | null; textContent?: string | null }) => {
    // #67 Workday (live tiaa 2026-08-31). Two widget shapes:
    // (a) listbox BUTTON — the committed display is the button's own text
    //     ("Mobile"); its sibling hidden input holds only a hex token.
    if (
      el.tagName === "BUTTON" &&
      el.getAttribute?.("aria-haspopup") === "listbox"
    ) {
      const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      return t && !/^select one$/i.test(t) ? t : null;
    }
    // (b) multiselect search input — the committed values are chips
    //     ([data-automation-id='selectedItem']) in the container; the
    //     input's own value is only filter residue.
    const wdContainer = el.closest("[data-automation-id='multiSelectContainer']");
    if (wdContainer) {
      const chips = Array.from(
        wdContainer.querySelectorAll("[data-automation-id='selectedItem']"),
      )
        .map((c) => (c.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0);
      return chips.length > 0 ? chips.join("; ") : null;
    }
    // Paylocity FIRST. `[class*="select_"]` matches `pcty-input-select__input`
    // (the inner filter wrap), which does not contain the committed label.
    // Live 2026-08-19: display already said "United States"; verify read
    // the empty input and fill then typed a filter that wiped the pick.
    const pctyWrap =
      el.closest('[id$="-select-wrapper"]') ??
      el.closest('[class*="input-select-full-container"]') ??
      el.closest('[data-automation-id$="-input-base"]');
    if (pctyWrap) {
      const single = pctyWrap.querySelector('[class*="single-value"]');
      const t = (single?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && !/^select(\s+a)?\s+(country|state|option|one)\b/i.test(t)) {
        return t;
      }
    }

    const shell =
      el.closest('[class*="select-shell"]') ??
      el.closest('[class*="select__control"]') ??
      el.closest('[class*="select_"]');
    if (!shell) {
      // Native role=combobox (employer sandbox / company-hosted): the
      // input value IS the committed display. Ignore it while the
      // listbox is open — that is filter residue, the Greenhouse lie.
      const host = el.closest("[class*='combo']") ?? el.parentElement;
      const list = host?.querySelector('[role="listbox"]');
      const doc = (
        globalThis as unknown as {
          getComputedStyle?: (n: unknown) => { display: string; visibility: string };
        }
      ).getComputedStyle;
      const open =
        list != null &&
        doc != null &&
        doc(list).display !== "none" &&
        doc(list).visibility !== "hidden";
      if (open) return null;
      const value = typeof el.value === "string" ? el.value.trim() : "";
      return value || null;
    }

    // ONLY the single-value node counts as committed — never the open menu or
    // the filter input. Using control textContent caused false positives when
    // the menu listed matching options while still on Select...
    const single = shell.querySelector(
      '[class*="single-value"], [class*="singleValue"]',
    );
    if (single) {
      const t = (single.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
      const title = single.getAttribute?.("title");
      if (title) return title;
    }

    // Multi-select chips: only label nodes (parent multi-value doubles text).
    const multi = shell.querySelectorAll(
      '[class*="multi-value__label"], [class*="multiValue__label"]',
    );
    const chips: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < multi.length; i++) {
      const t = (multi[i]?.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t !== "×" && t !== "x" && t.length > 1 && !seen.has(t)) {
        seen.add(t);
        chips.push(t);
      }
    }
    if (chips.length > 0) {
      return chips.join(", ");
    }
    return null;
  });
  if (raw === null) return null;
  const text = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^select\.{0,3}…?\s*/i, "")
    .replace(/\s*select\.{0,3}…?$/i, "")
    .trim();
  if (text === "" || PLACEHOLDER_RE.test(text)) return null;
  return text;
}

const LISTBOX_SELECTOR =
  '[role="listbox"], [class*="select__menu"], [id$="-dropdown-list-container"]';
// #127 (live finastra 2026-09-01): Workday prompt popups can render
// [data-automation-id="promptOption"] rows with no role=option — the
// fill opened the popup and read an EMPTY option list ('no option
// matches "Yes" (options: )') on four of nine listboxes.
const OPTION_SELECTOR =
  '[role="option"], [class*="select__option"], [data-automation-id="promptOption"]';

/**
 * True for Stats / Statistics majors — not for "United States" (/\bstat/ matches
 * the prefix of "states").
 */
function hasStatsMajorToken(lower: string): boolean {
  return /\bstats?\b|\bstatistics\b|\bstatistical\b/.test(lower);
}

/** Progressive filter strings for virtualized React-select menus. */
export function buildFilterCandidates(expected: string): string[] {
  const full = expected.trim();
  if (full === "") return [];
  const cleaned = full
    .replace(/[&|,/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").filter((w) => w.length > 0);
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.trim().slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  };
  const lower = cleaned.toLowerCase();

  // Location autocompletes ("Baltimore, Maryland, USA"): search by CITY
  // first — typing the whole comma string into an async place-search
  // returns nothing, and the last-resort word filters ("Maryland") pull
  // pure junk (live: Maryland Heights, Missouri…).
  const commaParts = full.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length >= 2 && commaParts[0]!.length >= 3) {
    push(commaParts[0]!);
  }

  // Paylocity state lists filter on USPS codes. Typing "Maryland" yields
  // no rows; typing "MD" does. Only when the whole expected string is a
  // state — do not inject MD into "Baltimore, Maryland, USA".
  if (commaParts.length < 2) {
    const abbr = US_STATE_ABBR[optionKey(full)];
    if (abbr) push(abbr.toUpperCase());
  }

  // Degree: type "Bachelor" / "Master" first — GH job-boards catalogue
  // is usually "Bachelor's Degree", not "Bachelor of Science". Full
  // profile strings still remain as later fallbacks.
  if (/\bbachelor/.test(lower)) {
    push("Bachelor");
    push("Bachelor's Degree");
  } else if (/\bmba\b/.test(lower)) {
    push("MBA");
  } else if (/\bmaster/.test(lower)) {
    push("Master");
    push("Master's Degree");
  } else if (/\bassociate/.test(lower)) {
    push("Associate");
    push("Associate's Degree");
  } else if (/\bph\.?\s*d|doctorate|doctor of philosophy/.test(lower)) {
    push("PhD");
    push("Doctor");
  }

  // Math majors: always filter "Mathematics" first, then applied/composite strings.
  // Live GH boards almost never list "Applied Math & Stats" as a catalogue option.
  if (/\bmath/.test(lower)) {
    push("Mathematics");
    push("Math");
  }
  // Must NOT use /\bstat/ — it matches "States" in "United States" and
  // briefly types "Statistics" into country comboboxes before correcting.
  if (hasStatsMajorToken(lower) && !/\bmath/.test(lower)) {
    push("Statistics");
  }

  push(full);
  push(cleaned);
  const yearToken = cleaned.match(/\b(20\d{2}|19\d{2})\b/);
  if (yearToken?.[1]) push(yearToken[1]);
  if (words.length >= 3) push(words.slice(0, 3).join(" "));
  if (words.length >= 2) push(words.slice(0, 2).join(" "));
  // Skip leading "Applied" as first token for math majors — already tried Math.
  if (words.length >= 1 && words[0]!.toLowerCase() !== "applied") {
    push(words[0]!);
  } else if (words.length >= 2) {
    push(words[1]!);
  }
  if (hasStatsMajorToken(lower)) {
    push("Statistics");
  }
  if (/\bcomputer|\bcs\b/.test(lower)) {
    push("Computer Science");
    push("Computer");
  }
  // Remaining content words (skip filler)
  for (const w of words) {
    if (
      w.length >= 4 &&
      !["applied", "science", "studies", "with"].includes(w.toLowerCase())
    ) {
      push(w);
    }
  }
  return out;
}

async function clearComboboxSelection(
  page: Page,
  clickTarget: Locator,
): Promise<string[]> {
  const notes: string[] = [];
  // Clear-all control wipes every multi/single chip in one click.
  const clearAll = clickTarget
    .locator(
      '[class*="clear-indicator"], [class*="ClearIndicator"], [aria-label*="Clear" i]',
    )
    .first();
  if ((await clearAll.count().catch(() => 0)) > 0) {
    await clearAll.click({ force: true, timeout: 2_000 }).catch(() => undefined);
    notes.push("cleared selection via clear-indicator");
    await page.waitForTimeout(100);
    return notes;
  }
  // Multi-value remove (×) on each chip — remove until gone (cap 12).
  for (let i = 0; i < 12; i++) {
    const remove = clickTarget
      .locator(
        '[class*="multi-value__remove"], [class*="multiValue__remove"], [aria-label*="Remove" i]',
      )
      .first();
    if ((await remove.count().catch(() => 0)) === 0) break;
    await remove.click({ force: true, timeout: 1_500 }).catch(() => undefined);
    notes.push("removed multi-value chip");
    await page.waitForTimeout(80);
  }
  return notes;
}

async function openCombobox(
  page: Page,
  loc: Locator,
): Promise<{ clickTarget: Locator; notes: string[] }> {
  const notes: string[] = [];
  // Paylocity: the inner filter input is not the open control. Click the
  // expand chevron (or the aria-haspopup wrapper) so the owned list mounts.
  const pcty = loc
    .locator('xpath=ancestor::*[@aria-haspopup="listbox"][1]')
    .first();
  let clickTarget: Locator;
  if ((await pcty.count()) > 0) {
    const icon = pcty
      .locator('[aria-label="expand"], [class*="dropdown-icon"]')
      .first();
    clickTarget = (await icon.count()) > 0 ? icon : pcty;
  } else {
    const control = loc
      .locator(
        'xpath=ancestor-or-self::*[contains(@class,"select__control") or contains(@class,"select-shell") or @role="combobox"][1]',
      )
      .first();
    clickTarget = (await control.count()) > 0 ? control : loc;
  }
  await clickTarget.scrollIntoViewIfNeeded().catch(() => undefined);

  notes.push(...(await clearComboboxSelection(page, clickTarget)));

  await clickTarget.click({ timeout: 10_000, force: true });
  notes.push("opened via control click");
  await page.waitForTimeout(200);
  return { clickTarget, notes };
}

/**
 * #94: full inventory of a (possibly virtualized) open listbox — scroll
 * the list container step by step, collecting option texts until two
 * consecutive steps add nothing (bounded). Read-only; the scroll
 * position is left wherever the harvest ends (the direct click below
 * re-scrolls to its target).
 */
async function scrollHarvestListbox(
  page: Page,
  listbox: Locator,
): Promise<string[]> {
  const seen = new Set<string>();
  const read = async (): Promise<number> => {
    const texts = await listbox
      .locator(OPTION_SELECTOR)
      .allTextContents()
      .catch(() => [] as string[]);
    let added = 0;
    for (const t of texts) {
      const c = t.replace(/\s+/g, " ").trim();
      // <250 (was 120): sentence options are real rows (#97).
      if (c && c.length < 250 && !seen.has(c)) {
        seen.add(c);
        added += 1;
      }
    }
    return added;
  };
  await read();
  let quiet = 0;
  for (let i = 0; i < 40 && quiet < 2 && seen.size < 500; i++) {
    const moved = await listbox
      .evaluate((el: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
        return el.scrollTop !== before;
      })
      .catch(() => false);
    await page.waitForTimeout(150);
    const added = await read();
    if (!moved && added === 0) break;
    quiet = added === 0 ? quiet + 1 : 0;
  }
  return [...seen].filter((t) => !/^(no options|no results|loading|searching|select one)\b/i.test(t));
}

/**
 * #94: click ONE option by exact text in a virtualized list — scroll
 * from the top until the row is rendered, then click it. Never iterates
 * clicks across rows.
 */
async function clickScrolledOption(
  page: Page,
  listbox: Locator,
  label: string,
): Promise<boolean> {
  await listbox
    .evaluate((el: { scrollTop: number }) => {
      el.scrollTop = 0;
    })
    .catch(() => undefined);
  for (let i = 0; i < 45; i++) {
    const target = listbox
      .getByRole("option", { name: label, exact: true })
      .filter({ visible: true })
      .first();
    if ((await target.count().catch(() => 0)) > 0) {
      await target.click({ timeout: 5_000, force: true }).catch(() => undefined);
      return true;
    }
    const moved = await listbox
      .evaluate((el: { scrollTop: number; clientHeight: number; scrollHeight: number }) => {
        const before = el.scrollTop;
        el.scrollTop = Math.min(el.scrollTop + el.clientHeight, el.scrollHeight);
        return el.scrollTop !== before;
      })
      .catch(() => false);
    if (!moved) break;
    await page.waitForTimeout(150);
  }
  return false;
}

async function listboxForControl(page: Page, loc: Locator): Promise<Locator> {
  const ownedId = await loc.evaluate(
    (el: {
      closest: (s: string) => { getAttribute: (n: string) => string | null } | null;
      getAttribute: (n: string) => string | null;
    }) => {
      const wrap = el.closest("[aria-owns]");
      return wrap?.getAttribute("aria-owns") ?? el.getAttribute("aria-controls");
    },
  );
  if (ownedId) {
    return page.locator(`[id="${ownedId.replace(/"/g, '\\"')}"]`);
  }
  // #67 (live tiaa 2026-08-31): Workday multiselects keep their SELECTED
  // chips in an always-visible `<ul role=listbox data-automation-id=
  // selectedItemList>` — the fallback's "first visible listbox" found the
  // chips, not the options popup. Exclude it per selector part.
  const withoutChips = LISTBOX_SELECTOR.split(",")
    .map((s) => `${s.trim()}:not([data-automation-id='selectedItemList'])`)
    .join(", ");
  const candidates = page.locator(withoutChips).filter({ visible: true });
  // #277 (live Leidos + PIMCO wd1 2026-09-14, `source--source` and
  // `phoneNumber--phoneType`): Workday renders popups in portals, so
  // DOCUMENT order says nothing about ownership — the first visible
  // listbox was the phone COUNTRY-CODE list, and both how-did-you-hear and
  // device type harvested "United States of America (+1)". Pick the
  // visible listbox nearest the control instead: a popper hangs directly
  // under (or above) its anchor and overlaps it horizontally.
  const n = await candidates.count().catch(() => 0);
  if (n <= 1) return candidates.first();
  const anchor = await loc.boundingBox().catch(() => null);
  if (!anchor) return candidates.first();
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const box = await candidates.nth(i).boundingBox().catch(() => null);
    if (!box) continue;
    const vertical = Math.max(0, box.y - (anchor.y + anchor.height), anchor.y - (box.y + box.height));
    const overlapsX = box.x < anchor.x + anchor.width && anchor.x < box.x + box.width;
    const horizontal = overlapsX ? 0 : Math.min(Math.abs(box.x - anchor.x), Math.abs(box.x + box.width - anchor.x - anchor.width));
    const score = vertical + horizontal * 2;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return candidates.nth(best);
}

async function clickListedOption(
  listbox: Locator,
  expected: string,
): Promise<{ label: string; via: Extract<OptionPick, { ok: true }>["via"] } | null> {
  // Length cap 200, not 80 (live tiaa 2026-08-31 #97): Workday consent
  // prompts offer SENTENCE options ("Yes, I hereby Consent and “Opt-in”
  // to …", ~150 chars) — the 80-char junk filter silently dropped the
  // only pickable rows and the whole ladder ground past an open popup.
  const clean = (texts: string[]) =>
    texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 0 && t.length < 200);

  const roleLabels = clean(
    await listbox.locator(OPTION_SELECTOR).filter({ visible: true }).allTextContents(),
  );
  const rolePick = pickOptionLabel(roleLabels, expected);
  if (rolePick.ok) {
    const byRole = listbox
      .getByRole("option", { name: rolePick.label, exact: true })
      .filter({ visible: true });
    if ((await byRole.count().catch(() => 0)) > 0) {
      await byRole.first().click({ timeout: 5_000, force: true });
      return { label: rolePick.label, via: rolePick.via };
    }
    const byClass = listbox
      .locator(OPTION_SELECTOR)
      .filter({ visible: true })
      .filter({ hasText: rolePick.label });
    if ((await byClass.count().catch(() => 0)) > 0) {
      await byClass.first().click({ timeout: 5_000, force: true });
      return { label: rolePick.label, via: rolePick.via };
    }
  }

  // Paylocity (live 2026-08-19): listbox opens, rows are plain divs with
  // no role=option, collector returned []. Click the visible string.
  const exact = listbox.getByText(expected, { exact: true }).filter({ visible: true });
  if ((await exact.count().catch(() => 0)) > 0) {
    await exact.first().click({ timeout: 5_000, force: true });
    return { label: expected, via: "exact" };
  }
  const loosePick = pickOptionLabel(
    clean(
      await listbox.locator("div, li, button").filter({ visible: true }).allTextContents(),
    ),
    expected,
  );
  if (loosePick.ok) {
    const named = listbox
      .getByText(loosePick.label, { exact: true })
      .filter({ visible: true });
    if ((await named.count().catch(() => 0)) > 0) {
      await named.first().click({ timeout: 5_000, force: true });
      return { label: loosePick.label, via: loosePick.via };
    }
  }
  return null;
}

/**
 * The list's own catch-all option, or null (#223). Anchored so "Mother
 * tongue" / "Otherwise" can never match; the optional tail covers the
 * shapes forms actually use ("Other:", "Other (please specify)",
 * "Other - please specify").
 */
const OTHER_OPTION_RE =
  /^other\s*(?:\((?:please\s*)?specify\)|[:–—-]\s*(?:please\s*specify)?)?\s*$/i;

export function findOtherOptionLabel(options: string[]): string | null {
  return options.find((o) => OTHER_OPTION_RE.test(o.trim())) ?? null;
}

/**
 * A list entry that is not a real answer: the prompt row every select
 * ships with. Used by the #225 last resort so "the first option" is never
 * "Select one".
 */
const PLACEHOLDER_OPTION_RE =
  /^(\s*|-+|—+|select(\s|$).*|please\s+select.*|choose(\s|$).*|pick\s+one.*|none(\s+selected)?|n\/?a)$/i;

/** First option that is an actual answer, or null (#225). */
export function firstRealOptionLabel(options: string[]): string | null {
  return (
    options.find((o) => {
      const t = o.trim();
      return t.length > 0 && !PLACEHOLDER_OPTION_RE.test(t) && !OTHER_OPTION_RE.test(t);
    }) ?? null
  );
}

/** Attribute used to hand a DOM-walked specify input back to Playwright. */
const SPECIFY_ATTR = "data-dispatch-other-specify";

/**
 * Type the intended answer into the free-text box that picking "Other"
 * reveals (#223). Walks up a few ancestors from the combobox looking for a
 * visible, EMPTY text input that is not the combobox itself — the shape
 * every "Other (please specify)" pairing uses. Returns false when no such
 * box appears, which is a legitimate outcome, not an error.
 */
async function fillOtherSpecifyBox(
  page: Page,
  loc: Locator,
  value: string,
): Promise<boolean> {
  // The box mounts on the selection's re-render.
  await page.waitForTimeout(400);
  type El = {
    parentElement: El | null;
    querySelectorAll: (s: string) => Iterable<El>;
    setAttribute: (k: string, v: string) => void;
    offsetParent: unknown;
    value?: string;
    disabled?: boolean;
    readOnly?: boolean;
  };
  const tagged = await loc
    .evaluate((el: El, attr: string) => {
      let node: El | null = el.parentElement;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const boxes = Array.from(
          node.querySelectorAll("input[type='text'], input:not([type]), textarea"),
        ).filter(
          (c) =>
            c !== (el as unknown as El) &&
            c.offsetParent !== null &&
            !c.disabled &&
            !c.readOnly &&
            !(c.value ?? "").trim(),
        );
        if (boxes.length > 0) {
          boxes[0]!.setAttribute(attr, "1");
          return true;
        }
        node = node.parentElement;
      }
      return false;
    }, SPECIFY_ATTR)
    .catch(() => false);
  if (!tagged) return false;
  const box = page.locator(`[${SPECIFY_ATTR}="1"]`).first();
  const ok = await box
    .fill(value, { timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  await box
    .evaluate((el: { removeAttribute: (k: string) => void }, attr: string) =>
      el.removeAttribute(attr),
    SPECIFY_ATTR)
    .catch(() => undefined);
  return ok;
}

/**
 * Open → (filter) → pick a real option → confirm commitment.
 * Returns committed:false with notes rather than leaving filter residue —
 * the caller records an error and the field stays honestly unfilled.
 */
export async function fillComboboxControl(
  page: Page,
  loc: Locator,
  expected: unknown,
  opts: {
    /**
     * #68 (live tiaa 2026-08-31): caller-scoped CLASS fallbacks tried in
     * order when the stored answer matches no option ("LinkedIn" on a
     * source list offering only channel classes). Still option-verified:
     * an alternate must itself match a page option verbatim/synonym, and
     * the pick is noted as a fallback.
     */
    alternates?: string[];
    /**
     * #94c: multi-VALUE callers (skills) pick repeatedly into the same
     * chips container — they must never reconcile away their own prior
     * picks. Single-value picks leave this unset and DO remove chips
     * that match neither the expected value nor any alternate (live
     * tiaa majors: a drill mishap committed "Communication" and an old
     * run left "CS" — both had to go before the right pick).
     */
    preserveExistingChips?: boolean;
    /**
     * #223 (operator directive 2026-09-09, live Workday `source--source`):
     * when the planned answer is not on the OPEN list, take the form's own
     * "Other" and type the intended answer into the specify box it
     * reveals. `applicationFiller` already does this at PLAN time, but only
     * for controls whose options are in the static HTML — Workday's
     * how-did-you-hear list exists only once the listbox opens, so the
     * escape hatch has to be available here too. Callers set this only for
     * NON-demographic fields; EEO/self-ID never takes an escape hatch.
     */
    allowOtherFallback?: boolean;
    /** Text typed into the "please specify" box after picking Other (#223). */
    otherSpecifyValue?: string;
    /**
     * #225 (operator directive 2026-09-09, how-did-you-hear): last resort
     * for an IRRELEVANT question that must not block the submit — take the
     * list's first real option when nothing else matched. Callers set this
     * for that one canonical field; it is never a general behaviour, and
     * never for demographics.
     */
    lastResortFirstOption?: boolean;
    /**
     * Operator directive 2026-09-14: class patterns tried, in order, when
     * neither the stored answer nor its alternates is on the list — "pick
     * any social media you can choose". Runs BEFORE the "Other" and
     * first-option last resorts. Callers set it for how_heard only.
     */
    classPatterns?: ReadonlyArray<RegExp>;
  } = {},
): Promise<ComboboxFillResult> {
  const notes: string[] = [];
  const expectedText = String(expected);
  // #72 (live tiaa #22u): the chip renders up to seconds after a drill
  // pick — a fixed double-read reported "not committed" while the page
  // itself showed the field satisfied. Bounded poll.
  const pollCommittedRead = async (): Promise<string | null> => {
    for (let i = 0; i < 6; i++) {
      const v = await readComboboxValue(loc);
      if (v) return v;
      await page.waitForTimeout(500);
    }
    return null;
  };

  const already = await readComboboxValue(loc);
  if (already && labelsCompatible(expectedText, already)) {
    notes.push(`already committed "${already}"`);
    return {
      committed: true,
      selectedLabel: already,
      notes,
      pickVia: "exact",
    };
  }
  // #94c: chips that match neither the expected value nor any alternate
  // are STALE (wrong picks from earlier runs/mishaps) — remove them via
  // their delete charms before picking, unless a multi-value caller
  // asked to preserve its own accumulating picks.
  if (already && !opts.preserveExistingChips) {
    const compatible = [expectedText, ...(opts.alternates ?? [])].some(
      (c) =>
        labelsCompatible(c, already) ||
        normalize(already).includes(normalize(c)),
    );
    if (!compatible) {
      const removed = await loc
        .evaluate(
          (el: {
            closest: (s: string) => {
              querySelectorAll: (s: string) => ArrayLike<{ click?: () => void }>;
            } | null;
          }) => {
            const c = el.closest("[data-automation-id='multiSelectContainer']");
            if (!c) return 0;
            const charms = Array.from(
              c.querySelectorAll("[data-automation-id='DELETE_charm']"),
            ).slice(0, 5);
            for (const ch of charms) ch.click?.();
            return charms.length;
          },
        )
        .catch(() => 0);
      if (removed > 0) {
        notes.push(
          `removed ${removed} stale chip(s) ("${already.slice(0, 60)}") before picking`,
        );
        await page.waitForTimeout(500);
      }
    }
  }

  const opened = await openCombobox(page, loc);
  notes.push(...opened.notes);

  const listbox = await listboxForControl(page, loc);
  try {
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    // #69 (live tiaa phoneType): a painted overlay swallows the MOUSE
    // click on Workday's listbox button while a JS click opens the popup
    // (probe-confirmed). One JS-click tier, then give up loudly.
    await loc
      .evaluate((el: { click: () => void }) => el.click())
      .catch(() => undefined);
    try {
      await listbox.waitFor({ state: "visible", timeout: 3_000 });
      notes.push("opened via JS click (mouse click swallowed)");
    } catch {
      notes.push("listbox did not open after click");
      return { committed: false, selectedLabel: null, notes };
    }
  }

  const direct = await clickListedOption(listbox, expectedText);
  if (direct) {
    notes.push(`picked "${direct.label}" (${direct.via}) from open list`);
    await listbox
      .waitFor({ state: "hidden", timeout: 5_000 })
      .catch(async () => {
        notes.push("listbox still visible after pick");
        await page.keyboard.press("Escape").catch(() => undefined);
      });
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(250);
    let committedLabel = await readComboboxValue(loc);
    if (!committedLabel) {
      await page.waitForTimeout(300);
      committedLabel = await readComboboxValue(loc);
    }
    const committed = labelsCompatible(direct.label, committedLabel) ||
      Boolean(
        committedLabel &&
          normalize(committedLabel).includes(normalize(direct.label)),
      );
    if (!committed) {
      notes.push(
        `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
      );
    }
    return {
      committed,
      selectedLabel: committed ? (committedLabel ?? direct.label) : null,
      notes,
      pickVia: direct.via,
    };
  }

  const collectOptions = async (): Promise<string[]> =>
    (
      await page
        .locator(OPTION_SELECTOR)
        .filter({ visible: true })
        .allTextContents()
    )
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);

  // Filter with sequential typing — React-select often ignores a single fill()
  // and virtualized menus only expose matching rows after the filter settles.
  // Progressive filters: full string → strip punctuation → head tokens.
  let options: string[] = [];
  const filterCandidates = buildFilterCandidates(expectedText);
  try {
    await loc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
    // #72 (live tiaa #22t/#22u): a listbox BUTTON is not typeable — with
    // the button focused, keyboard.type went to the PAGE, opened sibling
    // widgets, and committed strays ("Fax" onto the device-type button).
    // Buttons pick from their open list only; no typed filters.
    const typeable = await loc
      .evaluate((el: { tagName: string }) => el.tagName !== "BUTTON")
      .catch(() => true);
    if (!typeable) {
      notes.push("filter typing skipped: control is a button (not typeable)");
    }
    for (const typeText of typeable ? filterCandidates : []) {
      // Clear prior filter without collapsing the menu when possible.
      await loc.evaluate((el: { focus: () => void; value: string }) => {
        el.focus();
        el.value = "";
      }).catch(() => undefined);
      // Keyboard input goes to the ACTIVE element — if focus slipped off
      // the combobox (menu re-render, unmount), typing would land in a
      // neighboring field. Live 2026-08-29 samsara: the zip-code input
      // read "Yes" after a combobox miss. Skip typing when focus is gone.
      const focused = await loc
        .evaluate(
          (el: { ownerDocument: { activeElement: unknown } }) =>
            el.ownerDocument.activeElement === el,
        )
        .catch(() => false);
      if (!focused) {
        notes.push(
          `filter "${typeText}" skipped: combobox lost focus (typing would hit a neighboring field)`,
        );
        continue;
      }
      // keyboard.type reaches React onZero-size combobox inputs more reliably than fill().
      await page.keyboard.type(typeText, { delay: 25 });
      options = [];
      for (let i = 0; i < 18; i++) {
        await page.waitForTimeout(120);
        const typed = await clickListedOption(listbox, expectedText);
        if (typed) {
          notes.push(
            `filter "${typeText}" then picked "${typed.label}" (${typed.via})`,
          );
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(250);
          const committedLabel = await readComboboxValue(loc);
          const committed =
            labelsCompatible(typed.label, committedLabel) ||
            Boolean(
              committedLabel &&
                normalize(committedLabel).includes(normalize(typed.label)),
            );
          return {
            committed,
            selectedLabel: committed ? (committedLabel ?? typed.label) : typed.label,
            notes,
            pickVia: typed.via,
          };
        }
        options = await collectOptions();
        if (options.length === 0) continue;
        if (pickOptionLabel(options, expectedText).ok) break;
      }
      if (pickOptionLabel(options, expectedText).ok) {
        notes.push(
          `filter "${typeText}" → ${options.length} option(s); match`,
        );
        break;
      }
    }
    if (options.length === 0 || !pickOptionLabel(options, expectedText).ok) {
      // Re-open and dump unfiltered (first virtualization window). Clear
      // typed residue FIRST — live (cc02e067) the leftover "Maryland"
      // filter made the "unfiltered" list pure junk (Maryland Heights,
      // Missouri…), poisoning both the pick and the artifact.
      // #97 (live tiaa consent buttons): a listbox BUTTON has no residue
      // to clear, and clicking it here TOGGLED the already-open popup
      // CLOSED — every later phase then ground against a shut list. A
      // button only gets a re-open when the popup is actually closed.
      if (typeable) {
        await loc.click({ force: true, timeout: 2_000 }).catch(() => undefined);
        await page.keyboard.press("ControlOrMeta+a").catch(() => undefined);
        await page.keyboard.press("Delete").catch(() => undefined);
        await page.keyboard.press("Escape").catch(() => undefined);
        await openCombobox(page, loc);
        await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
        notes.push("filter yielded no/unmatched options; re-collected unfiltered (residue cleared)");
      } else if (!(await listbox.isVisible().catch(() => false))) {
        await openCombobox(page, loc);
        await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
        notes.push("button popup was closed; reopened for the unfiltered pick");
      } else {
        notes.push("button popup already open; picking from it directly");
      }
      await page.waitForTimeout(250);
      options = await collectOptions();
      const afterOpen = await clickListedOption(listbox, expectedText);
      if (afterOpen) {
        notes.push(`picked "${afterOpen.label}" (${afterOpen.via}) after reopen`);
        await page.keyboard.press("Escape").catch(() => undefined);
        await page.waitForTimeout(250);
        const committedLabel = await readComboboxValue(loc);
        return {
          committed: Boolean(
            committedLabel &&
              (labelsCompatible(afterOpen.label, committedLabel) ||
                normalize(committedLabel).includes(normalize(afterOpen.label))),
          ),
          selectedLabel: committedLabel ?? afterOpen.label,
          notes,
          pickVia: afterOpen.via,
        };
      }
      // #94 (operator, live tiaa majors field): on a FLAT virtualized
      // list the drill scan degenerated into clicking every row and left
      // a wrong value committed. Correct design: SCROLL the whole
      // virtualized list once, inventory every option, match, click the
      // one target directly. Only when the FULL inventory has no match
      // do the two-level drill semantics below apply.
      const fullInventory = await scrollHarvestListbox(page, listbox);
      if (fullInventory.length > 0) {
        notes.push(`scroll-harvested ${fullInventory.length} option(s)`);
        const candidates = [expectedText, ...(opts.alternates ?? [])];
        for (const cand of candidates) {
          const pick = pickOptionLabel(fullInventory, cand);
          if (!pick.ok) continue;
          const clicked = await clickScrolledOption(page, listbox, pick.label);
          if (!clicked) continue;
          await page.waitForTimeout(400);
          let committedLabel = await readComboboxValue(loc);
          const accept = (label: string, via: typeof pick.via): ComboboxFillResult => {
            notes.push(
              cand === expectedText
                ? `picked "${label}" (${via}) from the full inventory`
                : `stored answer "${expectedText}" not offered — class fallback picked "${label}" from the full inventory`,
            );
            return {
              committed: Boolean(
                committedLabel &&
                  (labelsCompatible(label, committedLabel) ||
                    normalize(committedLabel).includes(normalize(label))),
              ),
              selectedLabel: committedLabel ?? label,
              notes,
              pickVia: via,
            };
          };
          if (committedLabel && labelsCompatible(pick.label, committedLabel)) {
            await page.keyboard.press("Escape").catch(() => undefined);
            committedLabel = (await pollCommittedRead()) ?? committedLabel;
            return accept(pick.label, pick.via);
          }
          // No chip — the row was a CATEGORY that drilled to leaves.
          // Harvest the drilled level and pick the EXPECTED leaf there.
          const drilledInv = await scrollHarvestListbox(page, listbox);
          const leaf = pickOptionLabel(drilledInv, expectedText);
          if (leaf.ok && (await clickScrolledOption(page, listbox, leaf.label))) {
            notes.push(`drilled into "${pick.label}" via inventory — leaf "${leaf.label}"`);
            await page.keyboard.press("Escape").catch(() => undefined);
            await page.waitForTimeout(250);
            committedLabel = await pollCommittedRead();
            return accept(leaf.label, leaf.via);
          }
          // Not there either — back out for the next candidate.
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(300);
          await loc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
          await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
        }
        // Class rung over the FULL inventory (operator directive
        // 2026-09-14: any social-media row when LinkedIn is absent).
        const classHit = opts.classPatterns ? classPatternPick(fullInventory, opts.classPatterns) : null;
        if (classHit && (await clickScrolledOption(page, listbox, classHit))) {
          await page.waitForTimeout(400);
          await page.keyboard.press("Escape").catch(() => undefined);
          const committedLabel = await pollCommittedRead();
          notes.push(
            `stored answer "${expectedText}" not offered — class pattern picked "${classHit}" from the full inventory`,
          );
          return {
            committed: Boolean(
              committedLabel &&
                (labelsCompatible(classHit, committedLabel) ||
                  normalize(committedLabel).includes(normalize(classHit))),
            ),
            selectedLabel: committedLabel ?? classHit,
            notes,
            pickVia: "synonym",
          };
        }
      }
      // #71 (live tiaa #22t, probe-mapped): Workday prompt lists can be
      // TWO-LEVEL — level 1 is categories ("Job Board", "Social
      // Network"), clicking one drills to leaves, and the stored answer
      // lives as a LEAF ("Job Board" → LinkedIn). The search box ignores
      // typing on these. Drill bounded: category candidates are the
      // caller's alternates first (class hints), then every level-1 row;
      // in each drilled level look for the EXPECTED leaf; back out via
      // the widget's back affordance (else reopen) when it is not there.
      const level1 = await collectOptions();
      const drillCandidates = [
        ...(opts.alternates ?? []).filter((a) =>
          level1.some((o) => optionKey(o) === optionKey(a)),
        ),
        ...level1,
      ].filter((v, i, a) => a.indexOf(v) === i);
      // #97: the drill scan is for Workday MULTISELECT prompts only (#71's
      // two-level category→leaf lists) — those have chips whose delete
      // charm can undo an accidental flat commit. On any other widget a
      // "category" click just COMMITS the row with no undo affordance
      // (live: react-select "Canada" committed for "Atlantis"; tiaa
      // consent button committed a sentence row). And a yes/no answer
      // never lives under a category anywhere.
      const isWorkdayMultiselect = await loc
        .evaluate(
          (el: {
            closest: (s: string) => unknown;
            getAttribute: (n: string) => string | null;
          }) =>
            Boolean(el.closest("[data-automation-id='multiSelectContainer']")) ||
            el.getAttribute("data-uxi-widget-type") === "selectinput",
        )
        .catch(() => false);
      const drillable = isWorkdayMultiselect && yesNoToken(expectedText) === null;
      if (!drillable && drillCandidates.length > 0) {
        notes.push(
          "drill scan skipped (not a Workday multiselect prompt, or a yes/no answer — flat rows are answers, not categories)",
        );
      }
      for (const cat of drillable ? drillCandidates.slice(0, 12) : []) {
        const catRow = await clickListedOption(listbox, cat);
        if (!catRow) continue;
        await page.waitForTimeout(800);
        const drilled = await collectOptions();
        const changed =
          drilled.length > 0 &&
          drilled.join("|") !== level1.join("|");
        if (changed) {
          const leaf = await clickListedOption(listbox, expectedText);
          if (leaf) {
            notes.push(
              `drilled into "${catRow.label}" and picked leaf "${leaf.label}"`,
            );
            await page.keyboard.press("Escape").catch(() => undefined);
            await page.waitForTimeout(250);
            const committedLabel = await pollCommittedRead();
            return {
              committed: Boolean(
                committedLabel &&
                  (labelsCompatible(leaf.label, committedLabel) ||
                    normalize(committedLabel).includes(normalize(leaf.label))),
              ),
              selectedLabel: committedLabel ?? leaf.label,
              notes,
              pickVia: leaf.via,
            };
          }
        } else {
          // Clicking committed a chip directly — this level is FLAT, not
          // categories. Accept only when the clicked row was the stored
          // answer or a sanctioned alternate; anything else is undone via
          // the chip's delete charm and the drill scan stops (a flat list
          // has nothing to drill).
          const maybe = await readComboboxValue(loc);
          if (maybe && labelsCompatible(catRow.label, maybe)) {
            const sanctioned =
              labelsCompatible(expectedText, catRow.label) ||
              (opts.alternates ?? []).some((a) => labelsCompatible(a, catRow.label));
            if (sanctioned) {
              notes.push(`picked "${catRow.label}" (drill scan)`);
              return {
                committed: true,
                selectedLabel: maybe,
                notes,
                pickVia: catRow.via,
              };
            }
            // Undo the LAST chip (the accidental one) via its delete
            // charm; fall back to removing its pill node outright.
            await loc
              .evaluate((el: { closest: (s: string) => { querySelectorAll: (s: string) => ArrayLike<{ click?: () => void; closest?: (s: string) => { remove?: () => void } | null }> } | null }) => {
                const c = el.closest("[data-automation-id='multiSelectContainer']");
                const charms = c ? Array.from(c.querySelectorAll("[data-automation-id='DELETE_charm']")) : [];
                const last = charms[charms.length - 1];
                if (last?.click) last.click();
                else {
                  const chips = c ? Array.from(c.querySelectorAll("[data-automation-id='selectedItem']")) : [];
                  const lastChip = chips[chips.length - 1] as { closest?: (s: string) => { remove?: () => void } | null } | undefined;
                  (lastChip?.closest?.("li") ?? (lastChip as { remove?: () => void } | undefined))?.remove?.();
                }
              })
              .catch(() => undefined);
            await page.waitForTimeout(300);
            const after = await readComboboxValue(loc);
            notes.push(
              `flat list — undid accidental pick "${catRow.label}"${
                after && labelsCompatible(catRow.label, after) ? " (UNDO FAILED — flagging)" : ""
              }; stopping the drill scan`,
            );
            break;
          }
        }
        // back out of the drilled level for the next candidate
        const back = page
          .locator(
            "[data-automation-id='backButtonQuantum'], [data-automation-id='promptBack'], [aria-label*='back' i]",
          )
          .first();
        if ((await back.count().catch(() => 0)) > 0) {
          await back.click({ timeout: 3_000 }).catch(() => undefined);
          await page.waitForTimeout(600);
        } else {
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(400);
          await loc.click({ force: true, timeout: 3_000 }).catch(() => undefined);
          await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
          await page.waitForTimeout(400);
        }
      }
      // #68 class fallbacks: the stored answer is not offered. Try each
      // alternate in order — first against the open window, then as its
      // own typed filter (virtualized lists), same focus guard as above.
      for (const alt of opts.alternates ?? []) {
        let altHit = await clickListedOption(listbox, alt);
        if (!altHit) {
          const focused = await loc
            .evaluate(
              (el: { ownerDocument: { activeElement: unknown } }) =>
                el.ownerDocument.activeElement === el,
            )
            .catch(() => false);
          if (focused) {
            await page.keyboard.type(alt, { delay: 25 }).catch(() => undefined);
            await page.waitForTimeout(500);
            altHit = await clickListedOption(listbox, alt);
            if (!altHit) {
              await page.keyboard.press("ControlOrMeta+a").catch(() => undefined);
              await page.keyboard.press("Delete").catch(() => undefined);
            }
          }
        }
        if (altHit) {
          notes.push(
            `stored answer "${expectedText}" not offered — class fallback picked "${altHit.label}"`,
          );
          await page.keyboard.press("Escape").catch(() => undefined);
          await page.waitForTimeout(250);
          const committedLabel = await pollCommittedRead();
          return {
            committed: Boolean(
              committedLabel &&
                (labelsCompatible(altHit.label, committedLabel) ||
                  normalize(committedLabel).includes(normalize(altHit.label))),
            ),
            selectedLabel: committedLabel ?? altHit.label,
            notes,
            pickVia: "synonym",
          };
        }
      }
    }
  } catch {
    options = await collectOptions();
    notes.push("control not typeable; using unfiltered options");
  }

  let pick = pickOptionLabel(options, expectedText);
  const optionsSample = options.slice(0, 20);
  if (!pick.ok) {
    // Consent widgets: a single option like "Acknowledge/Confirm" with an
    // affirmative planned answer ("Yes"). Live 2026-08-29 samsara
    // "Processing of Personal Data" — the plan can't know the option text
    // (menus render only on open), and picking the SOLE consent option for
    // an affirmative answer is a synonym, not authorship. Anything else
    // still refuses.
    const consentSole =
      options.length === 1 &&
      /acknowledge|confirm|agree|accept|i understand|consent/i.test(
        options[0]!,
      ) &&
      /^(yes|true|acknowledge[d]?|agree[d]?|accept(ed)?|i (agree|accept|acknowledge|consent))$/i.test(
        expectedText.trim(),
      );
    if (consentSole) {
      notes.push(
        `sole consent option "${options[0]}" accepted for affirmative "${expectedText}" (synonym)`,
      );
      pick = { ok: true, label: options[0]!, via: "synonym" };
    } else if (opts.classPatterns && classPatternPick(options, opts.classPatterns)) {
      // Operator directive 2026-09-14: a class match ("Social Media",
      // "Job Board", …) beats the form's "Other" and the first-option
      // last resort — it is the truthful row, not an escape hatch.
      const cls = classPatternPick(options, opts.classPatterns)!;
      notes.push(
        `planned "${expectedText}" not on this list — class pattern picked "${cls}" (operator directive 2026-09-14)`,
      );
      pick = { ok: true, label: cls, via: "synonym" };
    } else if (opts.allowOtherFallback && findOtherOptionLabel(options)) {
      // #223: the list is open and the planned answer is provably absent.
      // The form's own "Other" is the escape hatch, and the intended
      // answer goes in its specify box below — so the field carries the
      // truth instead of blocking the submit.
      const other = findOtherOptionLabel(options)!;
      notes.push(
        `planned "${expectedText}" not on this list — taking the form's own "${other}" (#223)`,
      );
      pick = { ok: true, label: other, via: "other_fallback" };
    } else if (opts.lastResortFirstOption && firstRealOptionLabel(options)) {
      // #225: an irrelevant required question (how-did-you-hear) with no
      // matching option and no "Other". The operator's call: take the
      // first real option rather than block the submit.
      const first = firstRealOptionLabel(options)!;
      notes.push(
        `planned "${expectedText}" and its alternates are not on this list and it offers no "Other" — taking the first real option "${first}" (#225, operator directive: this question must not block the submit)`,
      );
      pick = { ok: true, label: first, via: "other_fallback" };
    } else {
      notes.push(pick.reason);
      await page.keyboard.press("Escape").catch(() => undefined);
      await loc.fill("").catch(() => undefined);
      return {
        committed: false,
        selectedLabel: null,
        notes,
        optionsSample,
        pickVia: null,
      };
    }
  }

  // #97: the drill/harvest phases can leave the popup CLOSED (each option
  // click shuts it) — the final pick then waited 5s on invisible options
  // and timed out (live tiaa consent listbox). Reopen once before picking.
  if (!(await listbox.isVisible().catch(() => false))) {
    await openCombobox(page, loc);
    await listbox.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
    notes.push("reopened listbox for the final pick");
  }
  // Prefer role=option exact text when Playwright can resolve it; fall back to
  // substring filter if whitespace / flag chrome differs.
  const optionByRole = page.getByRole("option", { name: pick.label, exact: true });
  let option = optionByRole.filter({ visible: true }).first();
  if ((await option.count().catch(() => 0)) === 0) {
    option = page
      .locator(OPTION_SELECTOR)
      .filter({ visible: true })
      .filter({ hasText: pick.label })
      .first();
  }
  await option.click({ timeout: 5_000, force: true });
  notes.push(`picked "${pick.label}" (${pick.via})`);

  await listbox
    .waitFor({ state: "hidden", timeout: 5_000 })
    .catch(async () => {
      notes.push("listbox still visible after pick");
      // Multi-select keeps the menu open; Escape commits chips and blurs filter.
      await page.keyboard.press("Escape").catch(() => undefined);
    });
  // Always close residual filter focus so the next field isn't left typing residue.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(250);

  // Re-read after menu settles (multi-value chips mount after close).
  let committedLabel = await readComboboxValue(loc);
  if (!committedLabel) {
    await page.waitForTimeout(300);
    committedLabel = await readComboboxValue(loc);
  }
  let committed = labelsCompatible(pick.label, committedLabel);
  // Multi-select chips may report "LinkedIn, Other" while pick was "LinkedIn".
  // Require the pick to appear AND refuse when unexpected second chips remain
  // for a single-value expectation (operator fills one answer at a time).
  if (
    !committed &&
    committedLabel &&
    normalize(committedLabel).includes(normalize(pick.label))
  ) {
    const parts = committedLabel.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length <= 1 || parts.every((p) => labelsCompatible(pick.label, p) || normalize(p) === normalize(pick.label))) {
      committed = true;
      notes.push(`multi-select chip contains "${pick.label}"`);
    } else {
      notes.push(
        `multi residue after clear: display shows "${committedLabel}" (wanted only "${pick.label}")`,
      );
    }
  }
  // #229 (operator directive 2026-09-09: "for filling anything with
  // dropdowns/lists/options, ensure you click enter — that's what's
  // required for the query to register"). Some list widgets treat the
  // option click as a highlight and only commit on Enter; live S&P /
  // Leidos Workday `source--source` clicked a real option and still read
  // back empty. Enter is a RECOVERY rung, not the default gesture: on a
  // widget that already committed, a stray Enter can submit the form, and
  // this pipeline gates submission deliberately. So it fires only when the
  // read-back says the click did not take.
  if (!committed) {
    const focused = await loc
      .evaluate((el: { ownerDocument: { activeElement: unknown } }) => el.ownerDocument.activeElement === el)
      .catch(() => false);
    if (!focused) await loc.click({ timeout: 2_000 }).catch(() => undefined);
    await page.keyboard.press("Enter").catch(() => undefined);
    await page.waitForTimeout(300);
    const afterEnter = await pollCommittedRead();
    if (afterEnter && labelsCompatible(pick.label, afterEnter)) {
      committedLabel = afterEnter;
      committed = true;
      notes.push(`click did not register — Enter committed "${pick.label}" (#229)`);
    }
  }
  if (!committed) {
    notes.push(
      `commit not confirmed: display shows ${committedLabel === null ? "placeholder" : `"${committedLabel}"`}`,
    );
  }
  // #223: "Other" alone says nothing — put the intended answer in the
  // specify box the choice reveals (live: how-did-you-hear ⇒ "LinkedIn").
  if (committed && pick.via === "other_fallback" && opts.otherSpecifyValue) {
    const typed = await fillOtherSpecifyBox(page, loc, opts.otherSpecifyValue);
    notes.push(
      typed
        ? `typed "${opts.otherSpecifyValue}" into the "Other" specify box`
        : `no "Other" specify box appeared — the choice stands alone`,
    );
  }
  // Prefer the richer option label over dial-code-only collapse ("+1").
  let selectedLabel = committedLabel;
  if (committed && committedLabel && /^\+\d+$/.test(committedLabel.trim())) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
    notes.push(`display collapsed to dial code; recording "${selectedLabel}"`);
  } else if (committed && !committedLabel) {
    selectedLabel = stripDialCode(pick.label) || pick.label;
  } else if (committed && committedLabel) {
    selectedLabel = committedLabel;
  }
  return {
    committed,
    selectedLabel: committed ? selectedLabel : null,
    notes,
    optionsSample,
    pickVia: pick.via,
  };
}
