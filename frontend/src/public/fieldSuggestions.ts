/**
 * ── Field-surfacing intelligence: the ranker (plan M11) ────────────────
 *
 * `field_suggestion_inputs()` (migration 20260911000900) hands the client
 * everything in one call: community aggregates with tenant ids summed
 * away, admin pins, the user's OWN engine events, seeded rules, the
 * signal→target map and the user's answered-ness per store. This module
 * turns that into an ordered list of "answer this once" cards, and is
 * pure so the ordering is unit-tested and never depends on a network.
 *
 * Honesty rules baked in:
 *   - a community signal counts only when ≥ COMMUNITY_MIN_TENANTS tenants
 *     saw it (k-anonymity floor; the view already summed the ids away);
 *   - a `label:` signal has no target until a pin or the user's own event
 *     supplies one — a popular-but-unmapped question stays a question;
 *   - a card's `why` lines are templated from the numbers it was ranked
 *     on, never prose the data cannot back;
 *   - demographic fields never arrive here (the database refuses them at
 *     the write), and nothing here could answer one anyway — the self_id
 *     store only ever deep-links to the opt-in step.
 */

/** Mirror of src/cloud/fieldSignalKeys.ts SUGGESTION_STORES (drift-tested). */
export const SUGGESTION_STORES = [
  "profile",
  "screener",
  "education",
  "employment",
  "documents",
  "integrations",
  "self_id",
] as const;
export type SuggestionStore = (typeof SUGGESTION_STORES)[number];

export type SuggestionTarget = {
  store: SuggestionStore;
  key?: string;
  kind?: "text" | "number" | "boolean";
  /** documents/resume: the variant a rule asks for. */
  variant?: string;
  /** screener custom questions: the verbatim label(s) the key stands for. */
  labels?: string[];
};

export type FieldSignal = {
  signal_key: string;
  label: string | null;
  tenants_seen: number;
  forms_seen: number;
  unanswered_count: number;
  required_count: number;
  ats: string[];
};

export type FieldPin = { signal_key: string; target: SuggestionTarget; reason: string; priority: number };

export type FieldEvent = {
  signal_key: string;
  label: string;
  ats: string;
  kind: string;
  engine_application_id: string;
  occurred_at: string;
};

export type FieldRule = {
  rule_key: string;
  predicate: Predicate;
  target: SuggestionTarget;
  why: string;
  priority: number;
};

/** field_suggestion_inputs().status — what the user has already done. */
export type SuggestionStatus = {
  titles: string[];
  industries: string[];
  employer_types: string[];
  has_current_employer: boolean;
  /** Profile columns holding a real value (not null/''/[]/{}) — v2 RPC. */
  answered_profile: string[];
  /** Keys of job_preferences with a real value — v2 RPC (20260912000200). */
  answered_preferences: string[];
  answered_screener: string[];
  resume_variants: string[];
  has_transcript: boolean;
  gmail_status: string;
  jobright_status: string;
  jobright_premium: boolean;
  self_id_visited: boolean;
  event_kinds: string[];
};

export type SuggestionInputs = {
  signals: FieldSignal[];
  pins: FieldPin[];
  events: FieldEvent[];
  rules: FieldRule[];
  targets: Record<string, SuggestionTarget>;
  status: SuggestionStatus;
};

export type SuggestionSource = "own" | "community" | "pin" | "rule";

export type Suggestion = {
  /** Stable per target — the dedupe key and the dismiss key. */
  id: string;
  target: SuggestionTarget;
  title: string;
  why: string[];
  score: number;
  sources: SuggestionSource[];
  /** The signal the card came from, when it came from one. */
  signalKey?: string;
};

/* ── predicate DSL ─────────────────────────────────────────────────── */

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | Record<string, Partial<Record<PredicateOp, unknown>>>;

export type PredicateOp = "contains" | "contains_any" | "not_contains" | "matches" | "present" | "eq" | "neq" | "gte";

function resolvePath(status: SuggestionStatus, path: string): unknown {
  const parts = path.replace(/^status\./, "").split(".");
  let cur: unknown = status;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

const lower = (v: unknown): string => String(v ?? "").toLowerCase();

function containsOne(value: unknown, needle: unknown): boolean {
  const n = lower(needle);
  if (Array.isArray(value)) return value.some((v) => lower(v) === n || lower(v).includes(n));
  if (typeof value === "string") return value.toLowerCase().includes(n);
  return false;
}

function matchesOne(value: unknown, pattern: unknown): boolean {
  let re: RegExp;
  try {
    re = new RegExp(String(pattern), "i");
  } catch {
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => re.test(String(v)));
  if (typeof value === "string") return re.test(value);
  return false;
}

function present(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

function leaf(value: unknown, op: PredicateOp, operand: unknown): boolean {
  switch (op) {
    case "contains":
      return containsOne(value, operand);
    case "contains_any":
      return Array.isArray(operand) && operand.some((o) => containsOne(value, o));
    case "not_contains":
      return !containsOne(value, operand);
    case "matches":
      return matchesOne(value, operand);
    case "present":
      return present(value) === (operand !== false);
    case "eq":
      return value === operand || lower(value) === lower(operand);
    case "neq":
      return !(value === operand || lower(value) === lower(operand));
    case "gte":
      return typeof value === "number" && typeof operand === "number" && value >= operand;
  }
}

const OPS = new Set<string>(["contains", "contains_any", "not_contains", "matches", "present", "eq", "neq", "gte"]);

/** Unknown shapes evaluate FALSE: a malformed rule never fires. */
export function evaluatePredicate(pred: unknown, status: SuggestionStatus): boolean {
  if (!pred || typeof pred !== "object" || Array.isArray(pred)) return false;
  const p = pred as Record<string, unknown>;
  if (Array.isArray(p["all"])) return (p["all"] as unknown[]).length > 0 && (p["all"] as unknown[]).every((x) => evaluatePredicate(x, status));
  if (Array.isArray(p["any"])) return (p["any"] as unknown[]).some((x) => evaluatePredicate(x, status));
  const entries = Object.entries(p);
  if (entries.length === 0) return false;
  return entries.every(([path, cond]) => {
    if (!cond || typeof cond !== "object" || Array.isArray(cond)) return false;
    const ops = Object.entries(cond as Record<string, unknown>);
    if (ops.length === 0 || ops.some(([op]) => !OPS.has(op))) return false;
    const value = resolvePath(status, path);
    return ops.every(([op, operand]) => leaf(value, op as PredicateOp, operand));
  });
}

/* ── ranking ───────────────────────────────────────────────────────── */

/** k-anonymity floor: fewer tenants than this and a signal is not shown. */
export const COMMUNITY_MIN_TENANTS = 3;
/** Own events: one contribution per application, at most this many applications. */
export const OWN_EVENT_APP_CAP = 5;
export const OWN_EVENT_WEIGHT = 3;
export const RULE_WEIGHT = 2;

export function targetId(t: SuggestionTarget): string {
  return `${t.store}:${t.key ?? ""}:${t.variant ?? ""}`;
}

/** Whether the user has already answered what a target points at. */
export function isAnswered(target: SuggestionTarget, status: SuggestionStatus): boolean {
  const key = target.key ?? "";
  switch (target.store) {
    case "profile": {
      // "job_preferences.willing_to_relocate": answered when THAT key holds
      // a value, never merely because the jsonb column is non-empty.
      const [col, sub] = key.split(".");
      if (col === "job_preferences" && sub) return status.answered_preferences.includes(sub);
      return status.answered_profile.includes(col ?? key);
    }
    case "screener":
      return status.answered_screener.includes(key);
    case "education":
      return status.answered_profile.includes("education");
    case "employment":
      return status.answered_profile.includes("employment_history") || status.has_current_employer;
    case "documents":
      if (key === "transcript") return status.has_transcript;
      if (key === "resume") return target.variant ? status.resume_variants.includes(target.variant) : status.resume_variants.length > 0;
      return false;
    case "integrations":
      if (key === "gmail") return status.gmail_status === "connected";
      if (key === "jobright") return status.jobright_status === "connected";
      return false;
    case "self_id":
      return status.self_id_visited;
  }
}

/** "internship_term" → "Internship term"; "legal_name.first" → "Legal name first". */
export function humanize(key: string): string {
  const s = key.replace(/^(canonical|screener):/, "").replace(/[._]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/** A card for a key-less target is titled by what the store IS. */
const STORE_TITLES: Record<SuggestionStore, string> = {
  profile: "Your profile",
  screener: "A screener question",
  education: "Your education",
  employment: "Your experience",
  documents: "Your documents",
  integrations: "Your integrations",
  self_id: "Self-identification",
};

/** label:<fp12> signals answered as a custom screener question. */
export function customScreenerTarget(signalKey: string, label: string): SuggestionTarget | null {
  const fp = /^label:([a-f0-9]{12})$/.exec(signalKey)?.[1];
  if (!fp) return null;
  return { store: "screener", key: `q_${fp}`, kind: "text", labels: [label] };
}

export type RankOptions = {
  /** Company names by engine application id, for the own-event "why". */
  applications?: Record<string, string | undefined>;
  /** A question's prompt for a target, when the UI knows it (registry screeners). */
  titleFor?: (target: SuggestionTarget) => string | undefined;
  /** Targets the user dismissed ("not now"); by targetId. */
  dismissed?: ReadonlySet<string>;
};

export function rankSuggestions(inputs: SuggestionInputs, opts: RankOptions = {}): Suggestion[] {
  const cards = new Map<string, Suggestion>();
  const pinFor = new Map(inputs.pins.map((p) => [p.signal_key, p] as const));

  const upsert = (
    target: SuggestionTarget,
    add: number,
    why: string,
    source: SuggestionSource,
    signalKey: string | undefined,
    label: string | null | undefined,
  ): void => {
    const id = targetId(target);
    const existing = cards.get(id);
    if (existing) {
      existing.score += add;
      if (!existing.why.includes(why)) existing.why.push(why);
      if (!existing.sources.includes(source)) existing.sources.push(source);
      return;
    }
    const title =
      opts.titleFor?.(target) ??
      (label && label.trim()
        ? label.trim()
        : target.key
          ? humanize(target.key)
          : signalKey
            ? humanize(signalKey)
            : STORE_TITLES[target.store]);
    cards.set(id, {
      id,
      target,
      title,
      why: [why],
      score: add,
      sources: [source],
      ...(signalKey ? { signalKey } : {}),
    });
  };

  const targetForSignal = (signalKey: string, label: string | null | undefined): SuggestionTarget | null => {
    const pin = pinFor.get(signalKey);
    if (pin) return pin.target;
    const seeded = inputs.targets[signalKey];
    if (seeded) return seeded;
    return label ? customScreenerTarget(signalKey, label) : null;
  };

  // Own events: the strongest evidence — this user's own run left it blank.
  const appsBySignal = new Map<string, Map<string, FieldEvent>>();
  for (const e of inputs.events) {
    const byApp = appsBySignal.get(e.signal_key) ?? new Map<string, FieldEvent>();
    if (!byApp.has(e.engine_application_id)) byApp.set(e.engine_application_id, e);
    appsBySignal.set(e.signal_key, byApp);
  }
  for (const [signalKey, byApp] of appsBySignal) {
    const events = [...byApp.values()].slice(0, OWN_EVENT_APP_CAP);
    const first = events[0]!;
    // A pin or seed wins; a label-only signal becomes a custom question.
    const target = targetForSignal(signalKey, first.label);
    if (!target) continue;
    const company = opts.applications?.[first.engine_application_id];
    const where = company ? `Your run at ${company} (${first.ats})` : `One of your applications (${first.ats})`;
    const more = events.length > 1 ? ` — and ${events.length - 1} more` : "";
    upsert(target, OWN_EVENT_WEIGHT * events.length, `${where} left this blank${more}`, "own", signalKey, first.label);
  }

  // Community: many users, many forms, often unanswered.
  for (const s of inputs.signals) {
    if (s.tenants_seen < COMMUNITY_MIN_TENANTS || s.forms_seen <= 0) continue;
    const target = pinFor.get(s.signal_key)?.target ?? inputs.targets[s.signal_key];
    if (!target) continue; // label: signals need a pin or an own event
    const add = Math.log1p(s.tenants_seen) * (s.unanswered_count / Math.max(s.forms_seen, 1));
    if (add <= 0) continue;
    upsert(
      target,
      add,
      `Asked on ${s.forms_seen} ${s.forms_seen === 1 ? "form" : "forms"} across ${s.tenants_seen} users; unanswered on ${s.unanswered_count}`,
      "community",
      s.signal_key,
      s.label,
    );
  }

  // Pins: the operator says this matters.
  for (const p of inputs.pins) {
    const label = inputs.signals.find((s) => s.signal_key === p.signal_key)?.label ?? null;
    upsert(p.target, p.priority / 10, p.reason, "pin", p.signal_key, label);
  }

  // Rules: what this user's own profile predicts forms will ask.
  for (const r of inputs.rules) {
    if (!evaluatePredicate(r.predicate, inputs.status)) continue;
    upsert(r.target, RULE_WEIGHT + r.priority / 10, r.why, "rule", undefined, null);
  }

  return [...cards.values()]
    .filter((c) => !isAnswered(c.target, inputs.status))
    .filter((c) => !opts.dismissed?.has(c.id))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Defensive parse of the RPC's jsonb: unknown shapes become empty, never a throw. */
export function parseSuggestionInputs(raw: unknown): SuggestionInputs {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const st = (o["status"] && typeof o["status"] === "object" ? o["status"] : {}) as Partial<SuggestionStatus>;
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  return {
    signals: arr<FieldSignal>(o["signals"]),
    pins: arr<FieldPin>(o["pins"]),
    events: arr<FieldEvent>(o["events"]),
    rules: arr<FieldRule>(o["rules"]),
    targets: (o["targets"] && typeof o["targets"] === "object" ? o["targets"] : {}) as Record<string, SuggestionTarget>,
    status: {
      titles: strs(st.titles),
      industries: strs(st.industries),
      employer_types: strs(st.employer_types),
      has_current_employer: st.has_current_employer === true,
      answered_profile: strs(st.answered_profile),
      answered_preferences: strs(st.answered_preferences),
      answered_screener: strs(st.answered_screener),
      resume_variants: strs(st.resume_variants),
      has_transcript: st.has_transcript === true,
      gmail_status: typeof st.gmail_status === "string" ? st.gmail_status : "disconnected",
      jobright_status: typeof st.jobright_status === "string" ? st.jobright_status : "disconnected",
      jobright_premium: st.jobright_premium === true,
      self_id_visited: st.self_id_visited === true,
      event_kinds: strs(st.event_kinds),
    },
  };
}
