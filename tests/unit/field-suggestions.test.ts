import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SUGGESTION_STORES as ENGINE_STORES } from "../../src/cloud/fieldSignalKeys.js";
import {
  COMMUNITY_MIN_TENANTS,
  SUGGESTION_STORES,
  customScreenerTarget,
  evaluatePredicate,
  humanize,
  isAnswered,
  parseSuggestionInputs,
  rankSuggestions,
  targetId,
  type SuggestionInputs,
  type SuggestionStatus,
} from "../../frontend/src/public/fieldSuggestions.js";

/**
 * The field-suggestion ranker (plan M11): pure, so the ordering rules,
 * the k-anonymity floor and the predicate DSL are pinned here without a
 * network. UNIT_CONFIRMED.
 */

const STATUS: SuggestionStatus = {
  titles: ["Software Engineer Intern"],
  industries: [],
  employer_types: ["internship"],
  has_current_employer: false,
  answered_profile: ["legal_first_name", "phone", "education", "job_preferences"],
  answered_preferences: ["titles", "employment_types"],
  answered_screener: ["age_over_18"],
  resume_variants: ["general"],
  has_transcript: false,
  gmail_status: "disconnected",
  jobright_status: "connected",
  jobright_premium: true,
  self_id_visited: false,
  event_kinds: ["unanswered_required"],
};

const EMPTY: SuggestionInputs = { signals: [], pins: [], events: [], rules: [], targets: {}, status: STATUS };

describe("predicate DSL (UNIT_CONFIRMED)", () => {
  it("evaluates the seeded shapes: any/all, contains_any, matches, eq/neq, not_contains", () => {
    expect(evaluatePredicate({ any: [{ "status.employer_types": { contains_any: ["internship", "co-op"] } }] }, STATUS)).toBe(true);
    expect(evaluatePredicate({ "status.titles": { matches: "intern|co-?op" } }, STATUS)).toBe(true);
    expect(evaluatePredicate({ "status.titles": { matches: "clearance|defense|federal" } }, STATUS)).toBe(false);
    expect(evaluatePredicate({ all: [{ "status.jobright_premium": { eq: true } }, { "status.gmail_status": { neq: "connected" } }] }, STATUS)).toBe(true);
    expect(evaluatePredicate({ all: [{ "status.event_kinds": { contains: "transcript_required" } }, { "status.has_transcript": { eq: false } }] }, STATUS)).toBe(false);
    expect(evaluatePredicate({ "status.resume_variants": { not_contains: "ds_ai" } }, STATUS)).toBe(true);
    expect(evaluatePredicate({ "status.self_id_visited": { eq: false } }, STATUS)).toBe(true);
    expect(evaluatePredicate({ "status.titles": { present: true } }, STATUS)).toBe(true);
    expect(evaluatePredicate({ "status.industries": { present: true } }, STATUS)).toBe(false);
  });

  it("a malformed rule never fires", () => {
    expect(evaluatePredicate({}, STATUS)).toBe(false);
    expect(evaluatePredicate({ all: [] }, STATUS)).toBe(false);
    expect(evaluatePredicate({ "status.titles": { explode: "x" } }, STATUS)).toBe(false);
    expect(evaluatePredicate({ "status.titles": { matches: "(" } }, STATUS)).toBe(false);
    expect(evaluatePredicate(null, STATUS)).toBe(false);
    expect(evaluatePredicate("status.titles", STATUS)).toBe(false);
  });
});

describe("ranking (UNIT_CONFIRMED)", () => {
  it("the store vocabulary mirrors the engine's", () => {
    expect([...SUGGESTION_STORES]).toEqual([...ENGINE_STORES]);
  });

  it("community signals below the k-anonymity floor are never shown; above it they rank by log1p(tenants)·unanswered/forms", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      targets: {
        "screener:internship_term": { store: "screener", key: "internship_term", kind: "text" },
        "screener:notice_period": { store: "screener", key: "notice_period", kind: "text" },
        "screener:closest_location": { store: "screener", key: "closest_location", kind: "text" },
      },
      signals: [
        { signal_key: "screener:internship_term", label: "Which term are you applying for?", tenants_seen: 9, forms_seen: 41, unanswered_count: 30, required_count: 20, ats: ["greenhouse"] },
        { signal_key: "screener:notice_period", label: "Notice period", tenants_seen: 4, forms_seen: 10, unanswered_count: 2, required_count: 1, ats: ["lever"] },
        { signal_key: "screener:closest_location", label: "Closest office", tenants_seen: COMMUNITY_MIN_TENANTS - 1, forms_seen: 50, unanswered_count: 50, required_count: 50, ats: ["workday"] },
      ],
    };
    const out = rankSuggestions(inputs);
    expect(out.map((s) => s.target.key)).toEqual(["internship_term", "notice_period"]);
    expect(out[0]!.why).toEqual(["Asked on 41 forms across 9 users; unanswered on 30"]);
    expect(out[0]!.title).toBe("Which term are you applying for?");
    expect(out[0]!.score).toBeCloseTo(Math.log1p(9) * (30 / 41), 6);
  });

  it("already-answered targets are excluded, and cards dedupe by target", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      targets: {
        "canonical:phone": { store: "profile", key: "phone", kind: "text" },
        "screener:age_over_18": { store: "screener", key: "age_over_18", kind: "boolean" },
        "screener:notice_period": { store: "screener", key: "notice_period", kind: "text" },
      },
      signals: [
        { signal_key: "canonical:phone", label: "Phone", tenants_seen: 20, forms_seen: 100, unanswered_count: 90, required_count: 90, ats: ["greenhouse"] },
        { signal_key: "screener:age_over_18", label: "Are you 18?", tenants_seen: 20, forms_seen: 100, unanswered_count: 90, required_count: 90, ats: ["greenhouse"] },
        { signal_key: "screener:notice_period", label: "Notice period", tenants_seen: 5, forms_seen: 10, unanswered_count: 5, required_count: 1, ats: ["lever"] },
      ],
      pins: [{ signal_key: "screener:notice_period", target: { store: "screener", key: "notice_period", kind: "text" }, reason: "Finance forms always ask this", priority: 8 }],
    };
    const out = rankSuggestions(inputs);
    expect(out).toHaveLength(1);
    expect(out[0]!.target.key).toBe("notice_period");
    expect(out[0]!.sources.sort()).toEqual(["community", "pin"]);
    expect(out[0]!.why).toContain("Finance forms always ask this");
  });

  it("own events outrank community, name the application, and a label-only signal becomes a custom question", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      targets: { "screener:notice_period": { store: "screener", key: "notice_period", kind: "text" } },
      signals: [
        { signal_key: "screener:notice_period", label: "Notice period", tenants_seen: 9, forms_seen: 41, unanswered_count: 40, required_count: 40, ats: ["lever"] },
      ],
      events: [
        { signal_key: "label:0123456789ab", label: "Which programming languages have you shipped in production?", ats: "greenhouse", kind: "unanswered_required", engine_application_id: "app-1", occurred_at: "2026-09-12T00:00:00Z" },
        { signal_key: "label:0123456789ab", label: "Which programming languages have you shipped in production?", ats: "greenhouse", kind: "review_item", engine_application_id: "app-1", occurred_at: "2026-09-12T01:00:00Z" },
        { signal_key: "label:0123456789ab", label: "Which programming languages have you shipped in production?", ats: "ashby", kind: "unanswered_required", engine_application_id: "app-2", occurred_at: "2026-09-11T00:00:00Z" },
      ],
    };
    const out = rankSuggestions(inputs, { applications: { "app-1": "Acme", "app-2": "Ramp" } });
    expect(out[0]!.target).toEqual({
      store: "screener",
      key: "q_0123456789ab",
      kind: "text",
      labels: ["Which programming languages have you shipped in production?"],
    });
    // Two applications, not three events: a re-run of the same app is not new evidence.
    expect(out[0]!.score).toBe(6);
    expect(out[0]!.why).toEqual(["Your run at Acme (greenhouse) left this blank — and 1 more"]);
    expect(out[0]!.sources).toEqual(["own"]);
    expect(out[1]!.target.key).toBe("notice_period");
  });

  it("a label-only community signal without a pin or an own event is NOT a card", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      signals: [{ signal_key: "label:abcdefabcdef", label: "Tell us about a time you failed", tenants_seen: 50, forms_seen: 200, unanswered_count: 200, required_count: 200, ats: ["greenhouse"] }],
    };
    expect(rankSuggestions(inputs)).toEqual([]);
    expect(customScreenerTarget("screener:notice_period", "x")).toBeNull();
  });

  it("rules fire from the user's own status and self_id deep-links instead of asking", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      rules: [
        { rule_key: "internship_term", predicate: { any: [{ "status.titles": { matches: "intern|co-?op" } }] }, target: { store: "screener", key: "internship_term", kind: "text" }, why: "Internship postings ask which term you are applying for", priority: 7 },
        { rule_key: "clearance", predicate: { "status.titles": { matches: "clearance|defense" } }, target: { store: "screener", key: "security_clearance", kind: "text" }, why: "Defense employers ask about clearance", priority: 8 },
        { rule_key: "self_id_never_visited", predicate: { "status.self_id_visited": { eq: false } }, target: { store: "self_id" }, why: "Decide once whether to answer self-identification", priority: 3 },
        { rule_key: "premium_connect_gmail", predicate: { all: [{ "status.jobright_premium": { eq: true } }, { "status.gmail_status": { neq: "connected" } }] }, target: { store: "integrations", key: "gmail" }, why: "Referral drafts need Gmail connected", priority: 8 },
      ],
    };
    const out = rankSuggestions(inputs);
    expect(out.map((s) => s.id)).toEqual([
      targetId({ store: "integrations", key: "gmail" }),
      targetId({ store: "screener", key: "internship_term" }),
      targetId({ store: "self_id" }),
    ]);
    expect(out.every((s) => s.sources.includes("rule"))).toBe(true);
    expect(out.find((s) => s.target.store === "self_id")?.title).toBe("Self-identification");
  });

  it("dismissed targets stay hidden; titleFor wins over the humanized key", () => {
    const inputs: SuggestionInputs = {
      ...EMPTY,
      rules: [{ rule_key: "r", predicate: { "status.titles": { present: true } }, target: { store: "screener", key: "hours_per_week", kind: "number" }, why: "why", priority: 5 }],
    };
    expect(rankSuggestions(inputs, { dismissed: new Set([targetId({ store: "screener", key: "hours_per_week" })]) })).toEqual([]);
    expect(rankSuggestions(inputs, { titleFor: () => "Hours per week you can commit" })[0]!.title).toBe("Hours per week you can commit");
    expect(rankSuggestions(inputs)[0]!.title).toBe("Hours per week");
    expect(humanize("canonical:legal_name.first")).toBe("Legal name first");
  });

  it("answered-ness per store follows the status the RPC computes", () => {
    // A dotted preference key is answered only when THAT key has a value —
    // a non-empty job_preferences column is not enough (review 2026-09-12).
    expect(isAnswered({ store: "profile", key: "job_preferences.willing_to_relocate" }, STATUS)).toBe(false);
    expect(
      isAnswered({ store: "profile", key: "job_preferences.willing_to_relocate" }, { ...STATUS, answered_preferences: ["willing_to_relocate"] }),
    ).toBe(true);
    expect(isAnswered({ store: "education", key: "gpa" }, { ...STATUS, answered_profile: ["phone"] })).toBe(false);
    expect(isAnswered({ store: "documents", key: "resume", variant: "ds_ai" }, STATUS)).toBe(false);
    expect(isAnswered({ store: "documents", key: "resume" }, STATUS)).toBe(true);
    expect(isAnswered({ store: "documents", key: "transcript" }, STATUS)).toBe(false);
    expect(isAnswered({ store: "integrations", key: "jobright" }, STATUS)).toBe(true);
    expect(isAnswered({ store: "integrations", key: "gmail" }, STATUS)).toBe(false);
    expect(isAnswered({ store: "self_id" }, STATUS)).toBe(false);
    expect(isAnswered({ store: "employment", key: "company" }, { ...STATUS, has_current_employer: true })).toBe(true);
  });

  it("the v2 RPC migration fixes cardinality(jsonb) and empty-container answered-ness, and emits answered_preferences", () => {
    const root = path.resolve(__dirname, "..", "..");
    const v1 = fs.readFileSync(path.join(root, "supabase", "migrations", "20260911000900_field_signals.sql"), "utf8");
    // Judge the SQL, not the header that explains the bug: comment lines out.
    const v2 = fs
      .readFileSync(path.join(root, "supabase", "migrations", "20260912000200_field_suggestion_inputs_v2.sql"), "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    // The applied v1 carries the bug; v2 must be the later `create or replace`.
    expect(v1).toMatch(/cardinality\(v_profile\.employment_history\)/);
    expect(v2).not.toMatch(/cardinality\(/);
    expect(v2).toMatch(/jsonb_array_length\(v_profile\.employment_history\)/);
    expect(v2).toMatch(/create or replace function public\.field_suggestion_inputs\(\)/);
    expect(v2).toMatch(/'answered_preferences'/);
    expect(v2).toMatch(/jsonb_typeof\(value\) <> 'array' or jsonb_array_length\(value\) > 0/);
    expect(v2).toMatch(/jsonb_typeof\(value\) <> 'object' or value <> '\{\}'::jsonb/);
    expect(v2).toMatch(/grant execute on function public\.field_suggestion_inputs\(\) to authenticated/);
    expect(v2).toMatch(/revoke all on function public\.field_suggestion_inputs\(\) from public/);
  });

  it("parseSuggestionInputs never throws on an odd payload and fails closed", () => {
    const p = parseSuggestionInputs({ status: { titles: "not-an-array", jobright_premium: "yes" }, signals: "nope" });
    expect(p.signals).toEqual([]);
    expect(p.status.titles).toEqual([]);
    expect(p.status.jobright_premium).toBe(false);
    expect(p.status.gmail_status).toBe("disconnected");
    expect(parseSuggestionInputs(null).rules).toEqual([]);
  });
});
