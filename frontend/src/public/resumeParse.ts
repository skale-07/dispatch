import {
  EDUCATION_MAX_EXTRA,
  EMPLOYMENT_MAX_ROLES,
  EMPLOYMENT_SUMMARY_MAX,
  EMPTY_EDUCATION_ENTRY,
  EMPTY_EMPLOYMENT_ENTRY,
  type EducationDraft,
  type EmploymentDraft,
  type ProfileDraft,
// Extension-qualified: tests/unit/resume-parse.test.ts imports this file,
// so the repo-root tsconfig (node16 resolution) typechecks it.
} from "./contract.js";

/**
 * ── "Fill from resume" (plan M23) ────────────────────────────────────
 *
 * A deterministic, on-device reader for the text of a resume: no model,
 * no network, nothing leaves the browser. It finds the EXPERIENCE,
 * EDUCATION and SKILLS sections, cuts experience into one entry per
 * dated block, and returns wizard DRAFT rows — one editable card per
 * role — which the user reviews before anything is saved.
 *
 * Rules, inherited from the import fast path (importPrompt.ts):
 *   - NOTHING IS INVENTED. A month the resume does not state stays "";
 *     "Summer 2024" keeps the year and drops the season; a role the
 *     reader cannot split into company/title still comes back, with the
 *     text where it found it, for the user to fix on the card.
 *   - DETAIL IS KEPT. Every bullet under a role becomes a line of its
 *     description (operator 2026-09-14: "better to be detailed when
 *     filling out fields than less detailed"). The reader never
 *     summarises.
 *   - NEVER work authorization, never demographics. The reader does not
 *     look for them, so it cannot find them.
 *
 * Input is plain text with one resume line per string. Columns that a
 * PDF laid out side by side (a right-aligned date or city) arrive joined
 * by two or more spaces — resumePdf.ts produces exactly that — and the
 * reader treats that gap, a tab, or " | " as a column break.
 */

export type ResumeSection = "experience" | "education" | "skills" | "other" | "header";

export type ParsedRole = EmploymentDraft & {
  /** Which heading the role sat under (a "Leadership" role is still a role, but the user may not want it on Workday). */
  section: string;
};

export type ParsedResume = {
  employment: ParsedRole[];
  education: EducationDraft[];
  skills: string[];
  contact: Partial<
    Pick<ProfileDraft, "full_name" | "phone" | "linkedin_url" | "github_url" | "portfolio_url">
  >;
  /** Headings the reader recognised, in order — the honest "what I saw". */
  headings: string[];
  /** Non-empty lines in the input; 0 means the file had no text layer (a scanned PDF). */
  lineCount: number;
};

/* ── headings ─────────────────────────────────────────────────────── */

const EXPERIENCE_HEADING =
  /^(?:(?:work|professional|relevant|research|industry|related|selected)\s+)?(?:experiences?|employment(?:\s+history)?|work\s+history|internships?|positions?(?:\s+held)?|professional\s+background|career\s+history)$/i;
const ACTIVITY_HEADING =
  /^(?:leadership(?:\s*(?:&|and)\s*(?:activities|involvement|service))?|activities(?:\s*(?:&|and)\s*leadership)?|extracurriculars?(?:\s+activities)?|volunteer(?:ing|\s+experience|\s+work)?|community\s+(?:service|involvement)|campus\s+involvement|involvement)$/i;
const EDUCATION_HEADING = /^(?:education(?:al\s+background)?|academics?|academic\s+background|academic\s+history)$/i;
const SKILLS_HEADING =
  /^(?:(?:technical|core|key|relevant|professional)\s+)?(?:skills|competencies|proficiencies|technologies|tools|technical\s+proficiencies|skills\s*(?:&|and)\s*(?:tools|interests|technologies|abilities|certifications))$/i;
const OTHER_HEADING =
  /^(?:projects?|personal\s+projects|selected\s+projects|academic\s+projects|technical\s+projects|publications?|awards?(?:\s*(?:&|and)\s*honors)?|honors?(?:\s*(?:&|and)\s*awards)?|certifications?(?:\s*(?:&|and)\s*licenses)?|licenses?|interests|hobbies|summary|professional\s+summary|objective|profile|about(?:\s+me)?|coursework|relevant\s+coursework|courses|languages|references|additional(?:\s+information)?|affiliations|memberships)$/i;

function headingKind(line: string): ResumeSection | "activity" | null {
  const t = line
    .replace(/[:_\-–—•·|]+$/g, "")
    .replace(/^[•·\-–—*]+\s*/, "")
    .trim();
  if (!t || t.length > 48 || /\d{4}/.test(t)) return null;
  if (EXPERIENCE_HEADING.test(t)) return "experience";
  if (ACTIVITY_HEADING.test(t)) return "activity";
  if (EDUCATION_HEADING.test(t)) return "education";
  if (SKILLS_HEADING.test(t)) return "skills";
  if (OTHER_HEADING.test(t)) return "other";
  return null;
}

/* ── dates ────────────────────────────────────────────────────────── */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

const MONTH_RE =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const SEASON_RE = "(?:spring|summer|fall|autumn|winter)";
const ONE_DATE = `(?:(?:${MONTH_RE}|${SEASON_RE})\\s+\\d{4}|\\d{1,2}\\/\\d{4}|\\d{4})`;
const PRESENT = "(?:present|current(?:ly)?|now|ongoing|to\\s+date|today)";
const DASH = "\\s*(?:-|–|—|−|to|through|until|till)\\s*";
const RANGE_RE = new RegExp(`\\b(${ONE_DATE})${DASH}(${ONE_DATE}|${PRESENT})\\b`, "i");
const SINGLE_RE = new RegExp(
  `\\b(?:(expected|anticipated|graduat(?:ed|ing|ion)|class\\s+of)\\s*:?\\s*)?(${ONE_DATE})\\b`,
  "i",
);

type MonthYear = { month: string; year: string };

export function normalizeMonth(raw: string): string {
  const key = raw.toLowerCase().replace(/\./g, "").slice(0, 3);
  const hit = MONTHS.find((m) => m.toLowerCase().startsWith(key));
  return hit ?? "";
}

function parseOneDate(text: string): MonthYear | null {
  const t = text.trim();
  let m = /^(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return { month: n >= 1 && n <= 12 ? MONTHS[n - 1]! : "", year: m[2]! };
  }
  m = new RegExp(`^(${MONTH_RE})\\s+(\\d{4})$`, "i").exec(t);
  if (m) return { month: normalizeMonth(m[1]!), year: m[2]! };
  m = new RegExp(`^${SEASON_RE}\\s+(\\d{4})$`, "i").exec(t);
  // A season is not a month: keep the year, never invent "June".
  if (m) return { month: "", year: m[1]! };
  m = /^(\d{4})$/.exec(t);
  if (m) return { month: "", year: m[1]! };
  return null;
}

export type DateRange = {
  start: MonthYear | null;
  end: MonthYear | null;
  current: boolean;
  /** The matched text, so callers can strip it from the line. */
  text: string;
};

/** A "May 2024 – Aug 2024" / "2023 - Present" / "06/2023 – 08/2023" range on a line. */
export function findDateRange(line: string): DateRange | null {
  const m = RANGE_RE.exec(line);
  if (!m) return null;
  const start = parseOneDate(m[1]!);
  const endRaw = m[2]!;
  const current = new RegExp(`^${PRESENT}$`, "i").test(endRaw);
  const end = current ? null : parseOneDate(endRaw);
  if (!start) return null;
  return { start, end, current, text: m[0] };
}

/** A lone date ("Expected May 2027", "Class of 2027", "May 2027"). */
export function findSingleDate(line: string): { date: MonthYear; expected: boolean; text: string } | null {
  const m = SINGLE_RE.exec(line);
  if (!m) return null;
  const date = parseOneDate(m[2]!);
  if (!date) return null;
  return { date, expected: Boolean(m[1]), text: m[0] };
}

/* ── lines, bullets, columns ──────────────────────────────────────── */

// Bullet glyphs as escapes (the console vocabulary test forbids raw
// icon-like characters in source): bullet, middle dot, filled/empty
// circles and squares, right-pointing triangles and arrows, check marks,
// hyphen, en/em dash, asterisk.
const BULLET_RE = new RegExp(
  "^\\s*(?:[\\u2022\\u00B7\\u25CF\\u25CB\\u25E6\\u25AA\\u25AB\\u25A0\\u25A1\\u25BA\\u25B8\\u27A2\\u27A4\\u2713\\u2714\\-\\u2013\\u2014*]|\\d{1,2}[.)])\\s+",
);

function isBullet(line: string): boolean {
  return BULLET_RE.test(line);
}

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, "").trim();
}

/** Column breaks: a tab, two+ spaces, or a spaced pipe / bullet / dash. */
function splitColumns(line: string): string[] {
  return line
    .split(/\t|\s{2,}|\s\|\s|\s[•·]\s|\s[–—]\s/)
    .map((s) => s.trim().replace(/^[,;|•·\-–—]+|[,;|•·\-–—]+$/g, "").trim())
    .filter(Boolean);
}

/** Spelled-out regions a "City, Region" pair may end with; a 2-letter code is always accepted. */
const REGION_NAMES = new Set(
  [
    "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware",
    "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky",
    "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi",
    "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico",
    "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania",
    "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
    "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "District of Columbia",
    "Puerto Rico", "Ontario", "Quebec", "British Columbia", "Alberta", "USA", "United States",
    "Canada", "United Kingdom", "England", "Scotland", "Germany", "France", "India", "China",
    "Japan", "Singapore", "Australia", "Mexico", "Brazil", "Ireland", "Netherlands", "Spain",
    "Italy", "Switzerland", "Sweden", "South Korea", "Israel", "UAE", "Remote",
  ].map((s) => s.toLowerCase()),
);
// The region is IN the pattern (not checked afterwards) so a failed
// candidate like "Northwind Traders, Platform" backtracks instead of
// consuming the "Columbus, OH" that follows it.
const LOCATION_RE = new RegExp(
  `\\b([A-Z][A-Za-z.'’-]+(?:\\s[A-Z][A-Za-z.'’-]+){0,3}),\\s*([A-Z]{2}|${[...REGION_NAMES]
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?:,\\s*(?:USA|U\\.S\\.A?\\.?|United States))?\\b`,
  "gi",
);
const REMOTE_RE = /\b(remote|work from home|wfh)\b/i;

/**
 * "Baltimore, MD" / "Columbus, Ohio" / "Remote" on a header line; returns
 * the text found. The LAST qualifying pair wins (a right-aligned city
 * sits at the end), and the region must be a 2-letter code or a known
 * region name — "Northwind Traders, Platform Team" is not a city.
 */
function findLocation(line: string): { location: string; remote: boolean; text: string } | null {
  const r = REMOTE_RE.exec(line);
  let best: RegExpExecArray | null = null;
  for (const m of line.matchAll(LOCATION_RE)) {
    // Case-insensitive only for spelled-out regions; a code must be capitals.
    if (m[2]!.length !== 2 || /^[A-Z]{2}$/.test(m[2]!)) best = m;
  }
  if (best) {
    return { location: `${best[1]}, ${best[2]}`, remote: Boolean(r), text: best[0] };
  }
  if (r) return { location: "Remote", remote: true, text: r[0] };
  return null;
}

/* ── company vs title ─────────────────────────────────────────────── */

const TITLE_WORDS =
  /\b(?:intern(?:ship)?|engineer(?:ing)?|developer|analyst|associate|assistant|researcher|research|consultant|scientist|lead|director|manager|specialist|coordinator|fellow|teaching|tutor|instructor|founder|co-?founder|president|vice\s+president|treasurer|secretary|chair|designer|technician|officer|clerk|cashier|server|barista|volunteer|ambassador|representative|mentor|captain|head|architect|administrator|apprentice|trainee|advisor|adviser|strategist|editor|writer|producer|operator|supervisor|partner|principal|staff|senior|junior|student|graduate|undergraduate|programmer|tester|qa|sde|swe|pm|cto|ceo|coo|cfo|member|organizer|photographer|nurse|physician|lifeguard|counselor|caddie|referee|coach)\b/i;
const COMPANY_WORDS =
  /\b(?:inc\.?|llc|ltd\.?|corp(?:oration)?\.?|co\.|company|group|university|college|institute|school|academy|labs?|technologies|technology|systems|solutions|partners|bank|capital|foundation|hospital|clinic|studios?|ventures|holdings|industries|international|global|network|agency|associates|consulting|software|media|health|financial|insurance|energy|logistics|department|center|centre|library|museum|church|club|team|society|association|council|committee|federal|national|state)\b/i;

function looksLikeTitle(s: string): boolean {
  return TITLE_WORDS.test(s);
}
function looksLikeCompany(s: string): boolean {
  return COMPANY_WORDS.test(s) || /&/.test(s);
}

/**
 * Split header lines (the 1–3 non-bullet lines around a date) into
 * company / title / location. The date usually sits on the title's line
 * and the location on the company's; a title-word or company-word
 * lexicon overrides that when it is sure.
 */
function splitHeader(lines: string[], range: DateRange | null, dateLineIndex: number): {
  company: string;
  title: string;
  location: string;
  remote: boolean;
} {
  let location = "";
  let remote = false;
  let locationLine = -1;
  const segments: Array<{ text: string; line: number }> = [];
  lines.forEach((raw, i) => {
    let line = range && i === dateLineIndex ? raw.replace(range.text, " ") : raw;
    const loc = findLocation(line);
    if (loc && !location) {
      location = loc.location;
      remote = loc.remote;
      locationLine = i;
      line = line.replace(loc.text, " ");
    }
    for (const seg of splitColumns(line)) {
      // Leftover range punctuation / "(" ")" from a stripped date.
      const clean = seg.replace(/^[()\s]+|[()\s]+$/g, "").trim();
      if (clean && !/^\d{4}$/.test(clean)) segments.push({ text: clean, line: i });
    }
  });
  if (segments.length === 0) return { company: "", title: "", location, remote };

  // "Software Engineer Intern at Acme" on one segment.
  if (segments.length === 1) {
    const at = /^(.+?)\s+(?:at|@)\s+(.+)$/.exec(segments[0]!.text);
    if (at) return { title: at[1]!.trim(), company: at[2]!.trim(), location, remote };
    const only = segments[0]!.text;
    return looksLikeTitle(only) && !looksLikeCompany(only)
      ? { title: only, company: "", location, remote }
      : { company: only, title: "", location, remote };
  }

  const scored = segments.map((s) => ({
    ...s,
    title: (looksLikeTitle(s.text) ? 2 : 0) - (looksLikeCompany(s.text) ? 2 : 0)
      + (s.line === dateLineIndex ? 1 : 0)
      - (s.line === locationLine ? 1 : 0),
  }));
  const byTitle = [...scored].sort((a, b) => b.title - a.title);
  const title = byTitle[0]!;
  const company = byTitle.find((s) => s !== title && s.line !== title.line) ?? byTitle[byTitle.length - 1]!;
  if (company === title) return { title: title.text, company: "", location, remote };
  // Extra segments on the company line (a department, a team) are kept
  // with the company rather than dropped.
  const extra = scored.filter((s) => s !== title && s !== company && s.line === company.line).map((s) => s.text);
  return {
    title: title.text,
    company: [company.text, ...extra].join(", "),
    location,
    remote,
  };
}

/* ── experience ───────────────────────────────────────────────────── */

/** A short line without sentence punctuation — the shape of a header, not a description. */
function headerShaped(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 90 && !/[.!?]$/.test(t) && !/^[a-z]/.test(t);
}

/**
 * A section with no dates at all: one role per header-shaped line
 * ("Barista at Blue Bean Coffee"), consecutive header lines pairing up
 * as title + company, everything else the description.
 */
function parseRolesUndated(lines: string[], section: string): ParsedRole[] {
  const roles: ParsedRole[] = [];
  let cur: { headerLines: string[]; body: string[] } | null = null;
  const flush = (): void => {
    if (!cur) return;
    const split = splitHeader(cur.headerLines, null, -1);
    if (split.company || split.title) {
      roles.push({
        ...EMPTY_EMPLOYMENT_ENTRY,
        ...split,
        summary: cur.body.join("\n").slice(0, EMPLOYMENT_SUMMARY_MAX),
        section,
      });
    }
    cur = null;
  };
  for (const line of lines) {
    const isHeader =
      !isBullet(line) &&
      headerShaped(line) &&
      (/\s(?:at|@)\s/.test(line) || looksLikeTitle(line) || looksLikeCompany(line));
    if (isHeader) {
      if (cur && cur.body.length === 0 && cur.headerLines.length < 2) cur.headerLines.push(line.trim());
      else {
        flush();
        cur = { headerLines: [line.trim()], body: [] };
      }
      continue;
    }
    if (!cur) continue;
    if (isBullet(line)) cur.body.push(stripBullet(line));
    else if (cur.body.length > 0 && /^[a-z]/.test(line.trim())) cur.body[cur.body.length - 1] += ` ${line.trim()}`;
    else cur.body.push(line.trim());
  }
  flush();
  return roles;
}

function parseRoles(lines: string[], section: string): ParsedRole[] {
  const roles: ParsedRole[] = [];
  const ranges = lines.map((l) => (isBullet(l) ? null : findDateRange(l)));
  if (!ranges.some(Boolean)) return parseRolesUndated(lines, section);
  const header = lines.map(() => false);
  const owner = lines.map(() => -1);
  ranges.forEach((r, i) => {
    if (!r) return;
    header[i] = true;
    owner[i] = i;
    const before = i - 1;
    if (before >= 0 && !isBullet(lines[before]!) && !ranges[before] && !header[before] && !headingKind(lines[before]!)) {
      // A line above the date that is not a bullet is the other half of
      // the header — unless it is a wrapped continuation of a bullet
      // (starts lowercase, or the previous bullet ends mid-sentence).
      const twoBefore = before - 1;
      const wrapped =
        !headerShaped(lines[before]!) ||
        (twoBefore >= 0 && isBullet(lines[twoBefore]!) && /[,;]$|\b(?:and|or|the|a|an|to|of|with|for)$/i.test(lines[twoBefore]!.trim()));
      if (!wrapped) {
        header[before] = true;
        owner[before] = i;
      }
    }
    const after = i + 1;
    if (after < lines.length && !isBullet(lines[after]!) && !ranges[after] && !headingKind(lines[after]!)) {
      const afterNext = after + 1;
      const nextIsBody = afterNext >= lines.length || isBullet(lines[afterNext]!) || Boolean(ranges[afterNext]);
      // Only claim the line after the date when what follows is clearly
      // the body (bullets) or the next role — a paragraph description
      // would otherwise be eaten as a header.
      if (nextIsBody || lines[after]!.length <= 90) {
        header[after] = true;
        owner[after] = i;
      }
    }
  });

  let current: { role: ParsedRole; lines: string[]; headerLines: string[]; dateAt: number } | null = null;
  const flush = (): void => {
    if (!current) return;
    const { role, lines: body, headerLines, dateAt } = current;
    const range = findDateRange(headerLines[dateAt]!)!;
    const split = splitHeader(headerLines, range, dateAt);
    role.company = split.company;
    role.title = split.title;
    role.location = split.location;
    role.remote = split.remote;
    role.summary = body.join("\n").slice(0, EMPLOYMENT_SUMMARY_MAX);
    if (role.company || role.title) roles.push(role);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (header[i]) {
      const key = owner[i]!;
      if (!current || current.role.section !== `${section}#${key}`) {
        flush();
        const r = ranges[key]!;
        current = {
          role: {
            ...EMPTY_EMPLOYMENT_ENTRY,
            start_month: r.start?.month ?? "",
            start_year: r.start?.year ?? "",
            end_month: r.end?.month ?? "",
            end_year: r.end?.year ?? "",
            current: r.current,
            section: `${section}#${key}`,
          },
          lines: [],
          headerLines: [],
          dateAt: -1,
        };
      }
      if (i === key) current.dateAt = current.headerLines.length;
      current.headerLines.push(line);
      continue;
    }
    if (!current) continue;
    if (isBullet(line)) current.lines.push(stripBullet(line));
    else if (current.lines.length > 0) current.lines[current.lines.length - 1] += ` ${line.trim()}`;
    else current.lines.push(line.trim());
  }
  flush();
  return roles.map((r) => ({ ...r, section }));
}

/** Date text and column breaks out of an education line, so field regexes stop where the column does. */
function educationColumns(line: string): string {
  let s = line;
  const range = findDateRange(s);
  if (range) s = s.replace(range.text, " | ");
  else {
    const single = findSingleDate(s);
    if (single) s = s.replace(single.text, " | ");
  }
  return s.replace(/\t|\s{2,}/g, " | ").trim();
}

const FIELD_END =
  "(?=\\s*(?:[|•·;,.(]|\\bGPA\\b|\\bminors?\\b|\\bmajor\\b|\\bconcentration\\b|\\bexpected\\b|\\banticipated\\b|\\bgraduat|\\bclass of\\b|\\d{4}|$))";

/* ── education ────────────────────────────────────────────────────── */

const SCHOOL_RE =
  /\b(?:university|college|institute|school|academy|polytechnic|conservatory|seminary)\b|\bU\.?\s?(?:of|at)\b/i;
const DEGREE_RE =
  /\b(bachelor(?:'s|s)?(?:\s+of\s+(?:science|arts|engineering|business\s+administration|fine\s+arts|technology))?|master(?:'s|s)?(?:\s+of\s+(?:science|arts|engineering|business\s+administration|fine\s+arts|public\s+health|education))?|doctor(?:ate)?(?:\s+of\s+philosophy)?|ph\.?\s?d\.?|m\.?b\.?a\.?|b\.?s\.?c?\.?|b\.?a\.?|b\.?eng\.?|b\.?e\.?|b\.?f\.?a\.?|b\.?b\.?a\.?|m\.?s\.?c?\.?|m\.?a\.?|m\.?eng\.?|m\.?f\.?a\.?|m\.?p\.?h\.?|a\.?a\.?|a\.?s\.?|associate(?:'s|s)?(?:\s+of\s+(?:science|arts|applied\s+science))?|high\s+school\s+diploma|diploma)\b\.?/i;

const DEGREE_EXPANSIONS: Array<[RegExp, string]> = [
  [/^b\.?s\.?c?\.?$/i, "Bachelor of Science"],
  [/^b\.?a\.?$/i, "Bachelor of Arts"],
  [/^b\.?eng\.?$|^b\.?e\.?$/i, "Bachelor of Engineering"],
  [/^b\.?f\.?a\.?$/i, "Bachelor of Fine Arts"],
  [/^b\.?b\.?a\.?$/i, "Bachelor of Business Administration"],
  [/^m\.?s\.?c?\.?$/i, "Master of Science"],
  [/^m\.?a\.?$/i, "Master of Arts"],
  [/^m\.?eng\.?$/i, "Master of Engineering"],
  [/^m\.?f\.?a\.?$/i, "Master of Fine Arts"],
  [/^m\.?p\.?h\.?$/i, "Master of Public Health"],
  [/^m\.?b\.?a\.?$/i, "Master of Business Administration"],
  [/^ph\.?\s?d\.?$/i, "Doctor of Philosophy"],
  [/^a\.?a\.?$/i, "Associate of Arts"],
  [/^a\.?s\.?$/i, "Associate of Science"],
  [/^bachelor(?:'s|s)?$/i, "Bachelor's"],
  [/^master(?:'s|s)?$/i, "Master's"],
];

/** "B.S." → "Bachelor of Science": a conversion, not a guess; the wording helps degree dropdowns. */
export function expandDegree(raw: string): string {
  const t = raw.trim().replace(/\.$/, "");
  for (const [re, full] of DEGREE_EXPANSIONS) if (re.test(t)) return full;
  return t
    .replace(/\bof\s+science\b/i, "of Science")
    .replace(/\bof\s+arts\b/i, "of Arts")
    .replace(/^bachelor/i, "Bachelor")
    .replace(/^master/i, "Master");
}

const GPA_RE = /\bGPA\s*[:\-–]?\s*(\d\.\d{1,3})(?:\s*\/\s*(\d(?:\.\d)?))?/i;
const MINOR_RE = new RegExp(`\\bminors?\\s*(?:in|:)?\\s+([A-Za-z&\\s]+?)${FIELD_END}`, "i");
const MAJOR_RE = new RegExp(
  `\\b(?:major(?:ing)?|concentration|specialization)\\s*(?:in|:)\\s+([A-Za-z&\\s]+?)${FIELD_END}`,
  "i",
);
const FIELD_AFTER_DEGREE_RE = new RegExp(`^\\s*(?:,|in|of|-|–|:)?\\s*([A-Z][A-Za-z&\\s]+?)${FIELD_END}`, "i");

function parseEducation(lines: string[]): EducationDraft[] {
  const entries: EducationDraft[] = [];
  let cur: EducationDraft | null = null;
  let curText: string[] = [];
  const flush = (): void => {
    if (cur && cur.school) entries.push(cur);
    cur = null;
    curText = [];
  };
  for (const raw of lines) {
    const line = stripBullet(raw);
    const isSchool = SCHOOL_RE.test(line) && !isBullet(raw);
    if (isSchool && (!cur || curText.length > 0)) {
      flush();
      cur = { ...EMPTY_EDUCATION_ENTRY };
      // The school is the column that names it; strip date/location first.
      let s = line;
      const range = findDateRange(s);
      if (range) s = s.replace(range.text, " ");
      const loc = findLocation(s);
      if (loc) s = s.replace(loc.text, " ");
      const cols = splitColumns(s);
      cur.school = (cols.find((c) => SCHOOL_RE.test(c)) ?? cols[0] ?? "").replace(/[,;]+$/, "").trim();
      // Anything else on the school line is still degree/field material.
      curText = [];
      applyEducationLine(cur, line);
      continue;
    }
    if (!cur) continue;
    curText.push(line);
    applyEducationLine(cur, line);
  }
  flush();
  return entries.slice(0, EDUCATION_MAX_EXTRA + 1);
}

function applyEducationLine(e: EducationDraft, line: string): void {
  const range = findDateRange(line);
  if (range && !e.grad_year) {
    e.start_month = range.start?.month ?? e.start_month;
    e.start_year = range.start?.year ?? e.start_year;
    if (range.end) {
      e.grad_month = range.end.month;
      e.grad_year = range.end.year;
    }
  } else if (!range && !e.grad_year) {
    const single = findSingleDate(line);
    if (single && (single.expected || /\b(?:grad|expected|class of)/i.test(line) || !e.school || DEGREE_RE.test(line) || SCHOOL_RE.test(line))) {
      e.grad_month = single.date.month;
      e.grad_year = single.date.year;
    }
  }
  const gpa = GPA_RE.exec(line);
  if (gpa && !e.gpa) e.gpa = gpa[1]!;
  const cols = educationColumns(line);
  const minor = MINOR_RE.exec(cols);
  if (minor && !e.additional_fields) e.additional_fields = minor[1]!.trim().replace(/\s+/g, " ");
  const major = MAJOR_RE.exec(cols);
  if (major && !e.field) e.field = major[1]!.trim();
  const deg = DEGREE_RE.exec(cols);
  if (deg && !e.degree) {
    e.degree = expandDegree(deg[1]!);
    if (!e.field) {
      // "Bachelor of Science in Computer Science" / "B.S., Computer Science" / "BS Computer Science".
      const after = cols.slice(deg.index + deg[0].length);
      const m = FIELD_AFTER_DEGREE_RE.exec(after);
      const field = m?.[1]?.trim() ?? "";
      if (field && !SCHOOL_RE.test(field) && !/^(?:degree|candidate|student)$/i.test(field)) e.field = field;
    }
  }
}

/* ── skills ───────────────────────────────────────────────────────── */

function parseSkills(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    let line = stripBullet(raw);
    // "Languages: Python, Java" — the category is not a skill.
    const cat = /^([A-Za-z&/\s\-()]{2,40}):\s*(.+)$/.exec(line);
    if (cat) line = cat[2]!;
    // "Python (NumPy, Pandas)" — the parenthetical names more skills.
    line = line.replace(/\(([^)]+)\)/g, ", $1,");
    for (const part of line.split(/[,;|•·]|\s{2,}|\t|\s[–—]\s|\s\/\s/)) {
      const skill = part.replace(/^(?:and|&)\s+/i, "").trim().replace(/[.:]+$/, "");
      if (!skill || skill.length > 40 || skill.split(/\s+/).length > 5) continue;
      const key = skill.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(skill);
    }
  }
  return out.slice(0, 80);
}

/* ── contact (the block above the first heading) ──────────────────── */

function parseContact(lines: string[]): ParsedResume["contact"] {
  const text = lines.join("  ");
  const out: ParsedResume["contact"] = {};
  const phone = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/.exec(text);
  if (phone) out.phone = phone[0].trim();
  const li = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[\w\-%]+\/?/i.exec(text);
  if (li) out.linkedin_url = withScheme(li[0]);
  const gh = /(?:https?:\/\/)?(?:www\.)?github\.com\/[\w\-]+\/?/i.exec(text);
  if (gh) out.github_url = withScheme(gh[0]);
  const site = /(?:https?:\/\/)?(?:www\.)?([\w\-]+\.(?:dev|io|me|com|org|net|app|site|xyz|tech|ai)(?:\/[\w\-./]*)?)\b/gi;
  for (const m of text.matchAll(site)) {
    const url = m[0];
    if (/linkedin\.com|github\.com|@/.test(url) || text.includes(`@${m[1]!.split("/")[0]}`)) continue;
    // An email's domain is not a personal site.
    if (new RegExp(`[\\w.+-]+@${m[1]!.split("/")[0]!.replace(/\./g, "\\.")}`, "i").test(text)) continue;
    out.portfolio_url = withScheme(url);
    break;
  }
  const first = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  const words = first.split(/\s+/);
  if (
    words.length >= 2 &&
    words.length <= 4 &&
    words.every((w) => /^[A-Za-z][A-Za-z'\-.]*$/.test(w)) &&
    !/@|\d/.test(first)
  ) {
    out.full_name = words
      .map((w) => (w === w.toUpperCase() && w.length > 1 ? w[0]! + w.slice(1).toLowerCase() : w))
      .join(" ");
  }
  return out;
}

function withScheme(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/* ── the reader ───────────────────────────────────────────────────── */

export function parseResumeText(input: string | string[]): ParsedResume {
  const lines = (Array.isArray(input) ? input : input.split(/\r?\n/))
    .map((l) => l.replace(/ /g, " ").trim())
    .filter((l) => l.length > 0);

  const sections: Array<{ kind: ResumeSection | "activity"; title: string; lines: string[] }> = [
    { kind: "header", title: "", lines: [] },
  ];
  const headings: string[] = [];
  for (const line of lines) {
    const kind = headingKind(line.trim());
    if (kind) {
      headings.push(line.trim());
      sections.push({ kind, title: line.trim().replace(/[:_\-–—•·|]+$/g, "").trim(), lines: [] });
      continue;
    }
    sections[sections.length - 1]!.lines.push(line);
  }

  const employment: ParsedRole[] = [];
  const education: EducationDraft[] = [];
  const skills: string[] = [];
  const headerBlock = sections[0]!.lines;
  for (const s of sections) {
    if (s.kind === "experience" || s.kind === "activity") employment.push(...parseRoles(s.lines, s.title));
    else if (s.kind === "education") education.push(...parseEducation(s.lines));
    else if (s.kind === "skills") skills.push(...parseSkills(s.lines));
  }
  // No headings at all (a plain-text dump): read the whole thing as
  // experience so dated blocks still come back as cards.
  if (headings.length === 0 && lines.length > 0) {
    employment.push(...parseRoles(lines, "resume"));
    education.push(...parseEducation(lines));
  }

  return {
    employment: employment.slice(0, EMPLOYMENT_MAX_ROLES),
    education,
    skills: [...new Set(skills)],
    contact: parseContact(headerBlock.slice(0, 8)),
    headings,
    lineCount: lines.length,
  };
}

/* ── merge into the wizard draft ──────────────────────────────────── */

export type ResumeApplyOptions = {
  /** Indices into parsed.employment to take (default: all). */
  roles?: number[];
  /** Indices into parsed.education to take (default: all). */
  schools?: number[];
  /** Replace the draft's existing roles instead of adding after them. */
  replaceRoles?: boolean;
  /** Take the skills list (default true). */
  skills?: boolean;
  /** Fill blank identity/contact fields from the resume header (default true). */
  contact?: boolean;
};

export type ResumeApplyOutcome = {
  draft: ProfileDraft;
  /** Draft keys the merge changed, for the "what just happened" list. */
  filled: string[];
};

function sameSchool(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Put parsed rows onto the draft. Roles append (or replace) up to the
 * cap; the first school fills the primary education keys when those are
 * blank and every other school lands in more_education (deduped by
 * name); skills union with what the user typed; blank contact fields
 * take the header's values. Never overwrites a filled scalar.
 */
export function applyResumeToDraft(
  draft: ProfileDraft,
  parsed: ParsedResume,
  opts: ResumeApplyOptions = {},
): ResumeApplyOutcome {
  const filled: string[] = [];
  const next: ProfileDraft = { ...draft };

  const roleIdx = opts.roles ?? parsed.employment.map((_, i) => i);
  const roles: EmploymentDraft[] = roleIdx
    .map((i) => parsed.employment[i])
    .filter((r): r is ParsedRole => Boolean(r))
    .map((r) => {
      const { section: _section, ...rest } = r;
      return rest;
    });
  if (roles.length > 0) {
    const base = opts.replaceRoles ? [] : draft.employment_history;
    next.employment_history = [...base, ...roles].slice(0, EMPLOYMENT_MAX_ROLES);
    filled.push("employment_history");
    const current = roles.find((r) => r.current && r.company);
    if (current && !draft.current_company.trim()) {
      next.current_company = current.company;
      filled.push("current_company");
    }
  }

  const schoolIdx = opts.schools ?? parsed.education.map((_, i) => i);
  const schools = schoolIdx.map((i) => parsed.education[i]).filter((e): e is EducationDraft => Boolean(e));
  if (schools.length > 0) {
    let rest = schools;
    if (!draft.school.trim()) {
      const primary = schools[0]!;
      Object.assign(next, {
        school: primary.school,
        degree: primary.degree,
        field: primary.field,
        grad_month: primary.grad_month,
        grad_year: primary.grad_year,
        start_month: primary.start_month,
        start_year: primary.start_year,
        gpa: primary.gpa,
        additional_fields: primary.additional_fields,
      });
      filled.push("school");
      rest = schools.slice(1);
    }
    const more = [...draft.more_education];
    for (const s of rest) {
      if (sameSchool(s.school, next.school) || more.some((m) => sameSchool(m.school, s.school))) continue;
      if (more.length >= EDUCATION_MAX_EXTRA) break;
      more.push(s);
    }
    if (more.length !== draft.more_education.length) {
      next.more_education = more;
      filled.push("more_education");
    }
  }

  if (opts.skills !== false && parsed.skills.length > 0) {
    const have = draft.skills.split(",").map((s) => s.trim()).filter(Boolean);
    const seen = new Set(have.map((s) => s.toLowerCase()));
    const merged = [...have];
    for (const s of parsed.skills) {
      if (seen.has(s.toLowerCase())) continue;
      seen.add(s.toLowerCase());
      merged.push(s);
    }
    const joined = merged.join(", ");
    if (joined !== draft.skills) {
      next.skills = joined.slice(0, 2000);
      filled.push("skills");
    }
  }

  if (opts.contact !== false) {
    for (const key of ["full_name", "phone", "linkedin_url", "github_url", "portfolio_url"] as const) {
      const v = parsed.contact[key];
      if (v && !draft[key].trim()) {
        next[key] = v;
        filled.push(key);
      }
    }
  }

  return { draft: next, filled };
}
