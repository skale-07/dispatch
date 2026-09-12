import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT, PROFILE_MIRRORED_SCREENER_KEYS } from "../../frontend/src/public/contract.js";
import {
  CANONICAL_FIELD_KEYS,
  FIELD_EVENT_KINDS,
  labelSignalKey,
  SIGNAL_KEY_RE,
  SUGGESTION_STORES,
} from "../../src/cloud/fieldSignalKeys.js";
import { EXPECTED_RPCS, EXPECTED_TABLES, EXPECTED_VIEWS, RPC_PROBE_ARGS } from "../../src/cloud/schema.js";

/**
 * Field-surfacing intelligence (migration 20260911000900 + fieldSignalKeys).
 * UNIT_CONFIRMED — the SQL is proven live by `cloud:schema -- apply/verify`.
 *
 * What must never rot:
 *   1. per-tenant signal rows have NO client door; the only read is the
 *      aggregate view, and it never emits a tenant id;
 *   2. a demographic / EEO / criminal / age label cannot become a signal,
 *      an event, a pin, a target or a rule — the SQL backstop covers every
 *      alternative of the engine's own detectors;
 *   3. the vocabularies (canonical keys, event kinds) are identical in SQL
 *      and TypeScript, and every seeded rule's predicate only reads paths
 *      that `field_suggestion_inputs()` actually builds.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const FILE = "20260911000900_field_signals.sql";
const SQL = fs.readFileSync(path.join(ROOT, "supabase", "migrations", FILE), "utf8");

function fn(name: string): string {
  const re = new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`);
  const body = re.exec(SQL)?.[0] ?? "";
  expect(body, `${name} is not defined in ${FILE}`).not.toBe("");
  return body;
}

/** The 22 registry keys, parsed from the engine source, not imported. */
function engineRegistryKeys(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src", "candidate", "screeners.ts"), "utf8");
  const start = src.indexOf("export const SCREENER_REGISTRY");
  const end = src.indexOf("];", start);
  return [...src.slice(start, end).matchAll(/^\s*key:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!);
}

/** Every `'{...}'` JSON literal inside one INSERT statement, parsed. */
function seededJson(table: string): Record<string, unknown>[][] {
  const re = new RegExp(`insert into public\\.${table} \\(([^)]*)\\) values([\\s\\S]*?)\\non conflict`);
  const m = re.exec(SQL);
  expect(m, `${table} seed`).not.toBeNull();
  const rows: Record<string, unknown>[][] = [];
  // One row per top-level parenthesised tuple.
  for (const tuple of m![2]!.matchAll(/\(\s*'([^']*)'([\s\S]*?)\)\s*(?:,|$)/g)) {
    const key = tuple[1]!;
    const jsons = [...tuple[2]!.matchAll(/'(\{[\s\S]*?\})'/g)].map((j) => JSON.parse(j[1]!) as Record<string, unknown>);
    rows.push([{ key }, ...jsons]);
  }
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

describe("field signals SQL — the per-tenant table has no client door (UNIT_CONFIRMED)", () => {
  it("tenant_field_signals: RLS on, everything revoked, and NO policy of any kind", () => {
    expect(SQL).toMatch(/alter table public\.tenant_field_signals enable row level security/);
    expect(SQL).toMatch(/revoke all on public\.tenant_field_signals from anon, authenticated/);
    expect(SQL).not.toMatch(/on public\.tenant_field_signals for (select|insert|update|delete)/);
    expect(SQL).not.toMatch(/grant [a-z, ()_]+ on public\.tenant_field_signals to authenticated/);
  });

  it("the community view is owner-rights on purpose, and never emits a tenant id", () => {
    const view = /create or replace view public\.field_signals as([\s\S]*?)group by signal_key;/.exec(SQL)?.[1] ?? "";
    expect(view).not.toBe("");
    expect(SQL).not.toMatch(/view public\.field_signals\s+with \(security_invoker/);
    // tenant_user_id may only appear inside the count(distinct ...) aggregate.
    const stripped = view.replace(/count\(distinct tenant_user_id\)/g, "");
    expect(stripped).not.toContain("tenant_user_id");
    expect(view).toMatch(/count\(distinct tenant_user_id\)::integer as tenants_seen/);
    expect(SQL).toMatch(/grant select on public\.field_signals to authenticated/);
    expect(SQL).toMatch(/revoke all on public\.field_signals from anon/);
  });

  it("own events, pins, rules and targets are readable but never writable by a client", () => {
    for (const t of ["admin_field_pins", "user_field_events", "field_rules", "signal_targets"]) {
      expect(SQL, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security`));
      expect(SQL, t).toMatch(new RegExp(`revoke all on public\\.${t} from anon`));
      expect(SQL, t).toMatch(new RegExp(`revoke insert, update, delete on public\\.${t} from authenticated`));
      expect(SQL, t).toMatch(new RegExp(`on public\\.${t} for select`));
    }
    expect(SQL).toMatch(/on public\.user_field_events for select[\s\S]*?using \(user_id = auth\.uid\(\)\)/);
    // Pins and rules: only the active ones are visible.
    expect(SQL).toMatch(/on public\.admin_field_pins for select[\s\S]*?using \(active\)/);
    expect(SQL).toMatch(/on public\.field_rules for select[\s\S]*?using \(active\)/);
  });

  it("an event is unique per (user, field, application, kind) — a re-run is not a new fact", () => {
    expect(SQL).toMatch(
      /create unique index if not exists user_field_events_dedupe[\s\S]*?\(user_id, signal_key, engine_application_id, kind\)/,
    );
    expect(fn("engine_upsert_field_events")).toMatch(
      /on conflict \(user_id, signal_key, engine_application_id, kind\) do nothing/,
    );
  });
});

describe("field signals SQL — demographic labels cannot become signals (UNIT_CONFIRMED)", () => {
  /** The SQL backstop's pattern text, with Postgres `\y` folded to `\b`. */
  function sqlSensitivePattern(): string {
    const body = fn("field_label_is_sensitive");
    const parts = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    return parts.join("").replace(/\\y/g, "\\b");
  }

  it("covers every alternative of the engine's isDemographicsField regex", () => {
    const src = fs.readFileSync(path.join(ROOT, "src", "applications", "essayDetector.ts"), "utf8");
    const fnStart = src.indexOf("export function isDemographicsField");
    const re = /return \/(.+?)\/\.test\(/.exec(src.slice(fnStart))?.[1] ?? "";
    expect(re).not.toBe("");
    const sql = sqlSensitivePattern();
    for (const alt of re.split("|")) {
      // `ethnicity` is covered by the SQL's broader `ethnic`.
      const needle = alt === "ethnicity" ? "ethnic" : alt;
      expect(sql, alt).toContain(needle);
    }
  });

  it("covers the criminal / age / date-of-birth alternatives of SENSITIVE_QUESTION", () => {
    const sql = sqlSensitivePattern();
    for (const needle of ["felony", "convict", "criminal", "date of birth", "\\bage\\b", "\\bsex\\b"]) {
      expect(sql, needle).toContain(needle);
    }
  });

  it("every table that stores a label CHECKs it against the backstop", () => {
    for (const t of ["tenant_field_signals", "user_field_events"]) {
      const ddl = new RegExp(`create table if not exists public\\.${t} \\([\\s\\S]*?\\n\\);`).exec(SQL)?.[0] ?? "";
      expect(ddl, t).toMatch(/check \(not public\.field_label_is_sensitive\(label\)\)/);
    }
  });

  it("every table keyed by a signal CHECKs the key against the whitelist", () => {
    for (const t of ["tenant_field_signals", "admin_field_pins", "user_field_events", "signal_targets"]) {
      const ddl = new RegExp(`create table if not exists public\\.${t} \\([\\s\\S]*?\\n\\);`).exec(SQL)?.[0] ?? "";
      expect(ddl, t).toMatch(/check \(public\.field_signal_key_allowed\(signal_key\)\)/);
    }
  });

  it("both engine writers refuse an unknown user, a bad key and a sensitive label BEFORE inserting", () => {
    for (const name of ["engine_upsert_field_signals", "engine_upsert_field_events"]) {
      const body = fn(name);
      const insert = body.indexOf("insert into public.");
      expect(body.indexOf("raise exception 'unknown user'"), name).toBeLessThan(insert);
      expect(body.indexOf("raise exception 'rows must be an array'"), name).toBeLessThan(insert);
      expect(body.indexOf("raise exception 'signal key not allowed"), name).toBeLessThan(insert);
      expect(body.indexOf("raise exception 'sensitive label refused"), name).toBeLessThan(insert);
      expect(SQL, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\(uuid, jsonb\\) from anon, authenticated`));
      expect(SQL, name).toMatch(new RegExp(`grant execute on function public\\.${name}\\(uuid, jsonb\\) to service_role`));
    }
  });

  it("no seeded target or rule points at a demographic key", () => {
    const demographic = /gender|race|ethnic|veteran|disabilit|sexual|hispanic|latino|transgender|pronoun/;
    for (const [head, target] of seededJson("signal_targets")) {
      expect((head as { key: string }).key, "target key").not.toMatch(demographic);
      expect(JSON.stringify(target)).not.toMatch(demographic);
    }
    for (const row of seededJson("field_rules")) {
      const [head, predicate, target] = row;
      expect((head as { key: string }).key).not.toMatch(demographic);
      // self_id is a deep link to the opt-in step, never an inline answer.
      const store = (target as { store: string }).store;
      if (store === "self_id") expect(target).not.toHaveProperty("key");
      expect(JSON.stringify(predicate)).not.toMatch(demographic);
    }
  });
});

describe("field signals — vocabularies are identical in SQL and TypeScript (UNIT_CONFIRMED)", () => {
  it("canonical_field_keys() equals CANONICAL_FIELD_KEYS", () => {
    const body = fn("canonical_field_keys");
    const arr = /array\[([\s\S]*?)\]::text\[\]/.exec(body)?.[1] ?? "";
    const dbKeys = [...arr.matchAll(/'([a-z0-9_.]+)'/g)].map((m) => m[1]!);
    expect([...dbKeys].sort()).toEqual([...CANONICAL_FIELD_KEYS].sort());
  });

  it("no canonical key is demographic — the alias file's EEO canonicals are deliberately absent", () => {
    const demographic = /gender|race|ethnic|veteran|disabilit|sexual|hispanic|latino|transgender/;
    for (const k of CANONICAL_FIELD_KEYS) expect(k).not.toMatch(demographic);
    for (const k of CANONICAL_FIELD_KEYS) expect(SIGNAL_KEY_RE.test(`canonical:${k}`), k).toBe(true);
  });

  it("the event kind CHECK equals FIELD_EVENT_KINDS", () => {
    const ddl = /create table if not exists public\.user_field_events \([\s\S]*?\n\);/.exec(SQL)?.[0] ?? "";
    const check = /kind text not null check \(kind in \(([\s\S]*?)\)\)/.exec(ddl)?.[1] ?? "";
    const kinds = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect([...kinds].sort()).toEqual([...FIELD_EVENT_KINDS].sort());
  });

  it("field_signal_key_allowed and SIGNAL_KEY_RE agree on the three shapes", () => {
    const body = fn("field_signal_key_allowed");
    expect(body).toMatch(/'canonical:%'[\s\S]*?canonical_field_keys\(\)/);
    expect(body).toMatch(/'screener:%'[\s\S]*?screener_registry_keys\(\)/);
    expect(body).toMatch(/'label:%'[\s\S]*?\^\[a-f0-9\]\{12\}\$/);
    expect(body).toMatch(/else false/);
    expect(SIGNAL_KEY_RE.test("label:0123456789ab")).toBe(true);
    expect(SIGNAL_KEY_RE.test("label:0123456789abc")).toBe(false);
    expect(SIGNAL_KEY_RE.test("profile:phone")).toBe(false);
    expect(labelSignalKey("0123456789ab")).toBe("label:0123456789ab");
    expect(() => labelSignalKey("xyz")).toThrow(/12-hex/);
  });
});

describe("field signals — seeds are complete and only read what the RPC builds (UNIT_CONFIRMED)", () => {
  it("every screener registry key has a seeded target, mirrored keys pointing at the profile", () => {
    const targets = new Map(
      seededJson("signal_targets").map(([head, target]) => [(head as { key: string }).key, target as { store: string; key?: string }]),
    );
    for (const k of engineRegistryKeys()) {
      const t = targets.get(`screener:${k}`);
      expect(t, `screener:${k}`).toBeDefined();
      const expectedStore = (PROFILE_MIRRORED_SCREENER_KEYS as readonly string[]).includes(k) ? "profile" : "screener";
      // portfolio_url is the one registry key that already lives on the profile row.
      if (k !== "portfolio_url") expect(t!.store, `screener:${k}`).toBe(expectedStore);
    }
    for (const k of CANONICAL_FIELD_KEYS) expect(targets.has(`canonical:${k}`), `canonical:${k}`).toBe(true);
    for (const t of targets.values()) expect(SUGGESTION_STORES, t.store).toContain(t.store);
  });

  it("every rule predicate reads only status paths that field_suggestion_inputs() builds", () => {
    const body = fn("field_suggestion_inputs");
    const statusBlock = /v_status := jsonb_build_object\(([\s\S]*?)\n  \);/.exec(body)?.[1] ?? "";
    const built = new Set([...statusBlock.matchAll(/^\s*'([a-z_]+)',/gm)].map((m) => m[1]!));
    expect(built.size).toBeGreaterThan(8);

    const OPS = new Set(["contains", "contains_any", "not_contains", "matches", "present", "eq", "neq", "gte"]);
    const walk = (node: unknown): void => {
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.all)) return o.all.forEach(walk);
      if (Array.isArray(o.any)) return o.any.forEach(walk);
      for (const [pathKey, leaf] of Object.entries(o)) {
        expect(pathKey, "predicate path").toMatch(/^status\./);
        expect(built.has(pathKey.slice("status.".length)), pathKey).toBe(true);
        for (const op of Object.keys(leaf as object)) expect(OPS.has(op), `${pathKey} ${op}`).toBe(true);
      }
    };
    const rules = seededJson("field_rules");
    expect(rules.length).toBeGreaterThanOrEqual(12);
    for (const [head, predicate, target] of rules) {
      walk(predicate);
      expect(SUGGESTION_STORES, (head as { key: string }).key).toContain((target as { store: string }).store);
    }
  });

  it("the plan's seeded rules are all present", () => {
    const keys = seededJson("field_rules").map(([head]) => (head as { key: string }).key);
    for (const k of [
      "internship_term", "internship_hours", "internship_full_time",
      "clearance", "government_employment",
      "finance_covenants", "finance_notice",
      "employed_notice", "employed_non_compete",
      "transcript_missing", "ds_ai_resume_variant",
      "self_id_never_visited", "premium_connect_gmail",
    ]) expect(keys, k).toContain(k);
  });

  it("the ds/ml regex survives SQL quoting as a real word-boundary pattern", () => {
    const rule = seededJson("field_rules").find(([head]) => (head as { key: string }).key === "ds_ai_resume_variant")!;
    const pred = rule[1] as { all: Array<Record<string, { matches?: string }>> };
    const matches = pred.all[0]!["status.titles"]!.matches!;
    expect(new RegExp(matches, "i").test("Senior ML Engineer")).toBe(true);
    expect(new RegExp(matches, "i").test("HTML Developer")).toBe(false);
  });

  it("field_suggestion_inputs() checks auth first and returns the six sections", () => {
    const body = fn("field_suggestion_inputs");
    expect(body.indexOf("raise exception 'not authenticated'")).toBeLessThan(body.indexOf("select * into v_profile"));
    for (const k of ["'signals'", "'pins'", "'events'", "'rules'", "'targets'", "'status'"]) expect(body).toContain(k);
    // Bounded: never the whole community table, never unbounded events.
    expect(body).toMatch(/limit 200/);
    expect(body).toMatch(/interval '90 days'/);
    expect(SQL).toMatch(/revoke all on function public\.field_suggestion_inputs\(\) from anon/);
    expect(SQL).toMatch(/grant execute on function public\.field_suggestion_inputs\(\) to authenticated/);
  });
});

describe("field signals are registered with the schema probe and the SPA (UNIT_CONFIRMED)", () => {
  it("every new object is expected by the read-back with probe arguments", () => {
    for (const t of ["tenant_field_signals", "admin_field_pins", "user_field_events", "field_rules", "signal_targets"]) {
      expect(EXPECTED_TABLES, t).toContain(t);
    }
    expect(EXPECTED_VIEWS).toContain("field_signals");
    for (const r of [
      "canonical_field_keys", "field_label_is_sensitive", "field_signal_key_allowed",
      "engine_upsert_field_signals", "engine_upsert_field_events", "field_suggestion_inputs",
    ]) {
      expect(EXPECTED_RPCS, r).toContain(r);
      expect(Object.keys(RPC_PROBE_ARGS), r).toContain(r);
    }
    // The writers are probed with an empty batch for a nil user: refused before any row.
    expect(RPC_PROBE_ARGS.engine_upsert_field_signals.p_rows).toEqual([]);
    expect(RPC_PROBE_ARGS.engine_upsert_field_events.p_rows).toEqual([]);
  });

  it("the SPA names what the migration creates", () => {
    expect(SQL).toContain(`function public.${CONTRACT.fieldSuggestionInputsRpc}()`);
    expect(SQL).toContain(`create or replace view public.${CONTRACT.fieldSignalsView}`);
    for (const t of [CONTRACT.fieldPinsTable, CONTRACT.fieldEventsTable, CONTRACT.fieldRulesTable, CONTRACT.signalTargetsTable]) {
      expect(SQL).toContain(`create table if not exists public.${t}`);
    }
  });
});
