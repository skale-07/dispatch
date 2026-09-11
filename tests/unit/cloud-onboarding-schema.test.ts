import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROFILE_MIRRORED_SCREENER_KEYS,
  SCREENER_QUESTIONS,
} from "../../frontend/src/public/contract.js";
import {
  INTEGRATION_PUBLIC_COLUMNS,
  joinOnboardedUsers,
  toCloudIntegrationRow,
} from "../../src/cloud/syncMapping.js";

/**
 * Onboarding data model (migrations 20260911000200–000700) — text-level
 * gates on the SQL plus the pure mappers. The SQL itself is proven live
 * by `cloud:schema -- apply/verify`. UNIT_CONFIRMED.
 *
 * Three things must never rot:
 *   1. the registry-key list in the database equals SCREENER_REGISTRY
 *      (and the wizard's SCREENER_QUESTIONS) — a new engine key fails
 *      here until a migration `create or replace`s the function;
 *   2. every new table has RLS on and no anon grant; every RPC revokes
 *      public before granting;
 *   3. integration secrets never reach a client: the view and the
 *      column grant list exclude them, and the pull's whitelist mapper
 *      drops them even from a `select *` regression.
 */

const ROOT = path.resolve(__dirname, "..", "..");
const MIG = path.join(ROOT, "supabase", "migrations");

function sql(name: string): string {
  return fs.readFileSync(path.join(MIG, name), "utf8");
}

/** Registry keys parsed from the engine source, not imported. */
function engineRegistryKeys(): string[] {
  const src = fs.readFileSync(path.join(ROOT, "src", "candidate", "screeners.ts"), "utf8");
  const start = src.indexOf("export const SCREENER_REGISTRY");
  const end = src.indexOf("];", start);
  return [...src.slice(start, end).matchAll(/^\s*key:\s*"([a-z0-9_]+)"/gm)].map((m) => m[1]!);
}

describe("screener registry parity (UNIT_CONFIRMED)", () => {
  it("screener_registry_keys() in SQL equals SCREENER_REGISTRY in the engine", () => {
    const s = sql("20260911000400_user_screener_answers.sql");
    const fn = /screener_registry_keys\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/.exec(s);
    expect(fn, "screener_registry_keys array not found").toBeTruthy();
    const dbKeys = [...(fn?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]!);
    const engine = engineRegistryKeys();
    expect(engine.length).toBeGreaterThanOrEqual(20);
    expect([...dbKeys].sort()).toEqual([...engine].sort());
  });

  it("the wizard asks every registry key exactly once, with a legal kind", () => {
    const engine = engineRegistryKeys();
    const asked = SCREENER_QUESTIONS.map((q) => q.key);
    expect([...asked].sort()).toEqual([...engine].sort());
    expect(new Set(asked).size).toBe(asked.length);
    for (const q of SCREENER_QUESTIONS) {
      expect(["yes_no", "option", "short_text", "url"]).toContain(q.kind);
      expect(q.prompt.trim().length).toBeGreaterThan(8);
    }
    // Facts that live on the profile row are marked as such, never asked twice.
    for (const k of PROFILE_MIRRORED_SCREENER_KEYS) {
      expect(asked).toContain(k);
      expect(SCREENER_QUESTIONS.find((q) => q.key === k)?.hint ?? "").toMatch(/profile/);
    }
  });

  it("the table refuses what parseScreenerBank refuses: unknown registry keys, custom keys without labels or colliding with the registry", () => {
    const s = sql("20260911000400_user_screener_answers.sql");
    expect(s).toMatch(/check \(kind <> 'registry' or key = any \(public\.screener_registry_keys\(\)\)\)/);
    expect(s).toMatch(/kind <> 'custom'[\s\S]*cardinality\(labels\) > 0[\s\S]*not \(key = any \(public\.screener_registry_keys\(\)\)\)/);
    expect(s).toMatch(/check \(key ~ '\^\[a-z0-9_\]\{2,60\}\$'\)/);
  });
});

describe("onboarding tables: RLS, grants, idempotency (UNIT_CONFIRMED)", () => {
  const tables: Array<[string, string]> = [
    ["20260911000300_user_documents.sql", "user_documents"],
    ["20260911000400_user_screener_answers.sql", "user_screener_answers"],
    ["20260911000600_user_personas.sql", "user_personas"],
    ["20260911000700_user_integrations.sql", "user_integrations"],
  ];

  it.each(tables)("%s: RLS enabled, anon revoked, own-row policies", (file, table) => {
    const s = sql(file);
    expect(s).toContain(`create table if not exists public.${table}`);
    expect(s).toContain(`alter table public.${table} enable row level security`);
    expect(s).toMatch(new RegExp(`revoke all on public\\.${table} from anon`));
    // Every policy is scoped to the caller.
    const policies = [...s.matchAll(/create policy "[^"]+"\s+on public\.(\w+)[\s\S]*?;/g)];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p[1]).toBe(table);
      expect(p[0]).toMatch(/auth\.uid\(\)/);
    }
    // Idempotent: policies are dropped before being (re)created.
    for (const p of policies) {
      const name = /create policy "([^"]+)"/.exec(p[0])?.[1] ?? "";
      expect(s).toContain(`drop policy if exists "${name}" on public.${table}`);
    }
  });

  it("every RPC revokes public before granting, and engine_* functions are service-role only", () => {
    const all = fs
      .readdirSync(MIG)
      .filter((f) => /^20260911000[2-7]/.test(f))
      .map((f) => sql(f))
      .join("\n");
    const fns = [...all.matchAll(/create or replace function public\.([a-z_]+)\(([^)]*)\)/g)];
    expect(fns.length).toBeGreaterThanOrEqual(8);
    for (const m of fns) {
      const name = m[1]!;
      expect(all, `${name} must revoke all from public`).toMatch(
        new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public`),
      );
      if (name.startsWith("engine_")) {
        expect(all, `${name} is service-role only`).toMatch(
          new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to service_role`),
        );
        expect(all).toMatch(
          new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from anon, authenticated`),
        );
      }
    }
  });

  it("complete_my_onboarding never raises for incompleteness — it returns the missing list", () => {
    const s = sql("20260911000300_user_documents.sql");
    const body = /function public\.complete_my_onboarding\(\)[\s\S]*?\n\$\$;/.exec(s)?.[0] ?? "";
    expect(body).not.toBe("");
    expect(body).toContain("security invoker");
    const raises = [...body.matchAll(/raise exception '([^']+)'/g)].map((m) => m[1]);
    expect(raises).toEqual(["not authenticated"]);
    expect(body).toMatch(/coalesce\(onboarding_completed_at, now\(\)\)/);
    expect(body).toMatch(/'missing', to_json\(missing\)/);
  });

  it("documents: uid-prefixed object paths, bucket follows kind, one default per kind", () => {
    const s = sql("20260911000300_user_documents.sql");
    expect(s).toMatch(/check \(split_part\(object_path, '\/', 1\) = user_id::text\)/);
    expect(s).toMatch(/check \(\(kind = 'transcript'\) = \(bucket = 'transcripts'\)\)/);
    expect(s).toMatch(/create unique index if not exists user_documents_one_default[\s\S]*where is_default/);
    // Backfill is idempotent and only copies uid-prefixed legacy paths.
    expect((s.match(/on conflict \(user_id, kind, variant\) do nothing/g) ?? []).length).toBe(2);
  });

  it("personas refuse placeholder project names like the engine loader does", () => {
    const s = sql("20260911000600_user_personas.sql");
    expect(s).toMatch(/check \(projects::text !~ '"name": \*"REPLACE_'\)/);
  });
});

describe("integration secrets never reach a client (UNIT_CONFIRMED)", () => {
  const SECRET_COLUMNS = ["secret_ciphertext", "secret_key_version", "secret_updated_at"];

  it("the view and the column grant exclude every secret column", () => {
    const s = sql("20260911000700_user_integrations.sql");
    const view = /create view public\.my_integrations[\s\S]*?;/.exec(s)?.[0] ?? "";
    const grant = /grant select \(([\s\S]*?)\) on public\.user_integrations to authenticated/.exec(s)?.[1] ?? "";
    expect(view).not.toBe("");
    expect(grant).not.toBe("");
    for (const c of SECRET_COLUMNS) {
      expect(view).not.toContain(c);
      expect(grant).not.toContain(c);
    }
    expect(s).toMatch(/revoke all on public\.user_integrations from anon, authenticated/);
    // The user-side RPC can only touch premium / disconnect.
    expect(s).toMatch(/k not in \('premium', 'disconnect'\)/);
  });

  it("the KEK is generated in-database and never appears as a literal", () => {
    const s = sql("20260911000450_encryption_kek.sql");
    expect(s).toMatch(/vault\.create_secret\(\s*encode\(extensions\.gen_random_bytes\(32\), 'hex'\)/);
    expect(s).not.toMatch(/[0-9a-f]{32,}/);
    expect(s).toMatch(/revoke all on function public\._dispatch_dek\(uuid, text\) from anon, authenticated/);
    expect(s).toMatch(/revoke all on function public\._dispatch_decrypt\(uuid, text, bytea\) from anon, authenticated/);
  });

  it("the pull's whitelist mapper drops secret columns even from a select * regression", () => {
    const dirty = {
      user_id: "u1",
      provider: "gmail",
      status: "connected",
      account_email: "a@b.c",
      premium: null,
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      connected_at: "2026-09-11T00:00:00Z",
      expires_at: null,
      last_checked_at: null,
      last_error: null,
      secret_ciphertext: "\\x00ff",
      secret_key_version: 1,
      secret_updated_at: "2026-09-11T00:00:00Z",
    };
    const clean = toCloudIntegrationRow(dirty);
    expect(Object.keys(clean).sort()).toEqual([...INTEGRATION_PUBLIC_COLUMNS].sort());
    for (const c of SECRET_COLUMNS) expect(clean).not.toHaveProperty(c);
  });

  it("joinOnboardedUsers carries the per-store rows and the whole profile row", () => {
    const profile = {
      user_id: "u1",
      full_name: "T",
      phone: null,
      location_city: null,
      location_region: null,
      location_country: null,
      linkedin_url: null,
      github_url: null,
      portfolio_url: null,
      work_authorization: null,
      needs_sponsorship: null,
      education: [],
      job_preferences: {},
      resume_object_path: null,
      resume_filename: null,
      onboarding_completed_at: "2026-09-11T00:00:00Z",
      legal_first_name: "Tee",
      skills: ["sql"],
    };
    const out = joinOnboardedUsers(
      [{ id: "u1", email: "a@b.c", invite_id: null }],
      [profile],
      {
        documents: [
          {
            id: "d1",
            user_id: "u1",
            kind: "resume",
            variant: "ds_ai",
            bucket: "resumes",
            object_path: "u1/resume/ds_ai/r.pdf",
            filename: "r.pdf",
            role_families: ["ds_ai"],
            is_default: true,
            uploaded_at: null,
          },
        ],
        screenerAnswers: [
          { user_id: "u1", key: "age_over_18", kind: "registry", answer: "Yes", labels: [], source: "wizard", updated_at: null },
          { user_id: "u2", key: "age_over_18", kind: "registry", answer: "No", labels: [], source: "wizard", updated_at: null },
        ],
        personas: [
          { user_id: "u1", persona_id: "default", headline: "h", education: {}, projects: [], skills: [], interests: [] },
        ],
        integrations: [toCloudIntegrationRow({ user_id: "u1", provider: "jobright", status: "connected", scopes: [] })],
      },
    );
    expect(out).toHaveLength(1);
    const u = out[0]!;
    expect(u.profile.legal_first_name).toBe("Tee");
    expect(u.documents.map((d) => d.variant)).toEqual(["ds_ai"]);
    // Another user's answers never leak into this user's bundle.
    expect(u.screenerAnswers.map((a) => a.answer)).toEqual(["Yes"]);
    expect(u.persona?.headline).toBe("h");
    expect(u.integrations[0]?.provider).toBe("jobright");
  });
});
