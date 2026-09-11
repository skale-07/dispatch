import fs from "node:fs";
import path from "node:path";

/**
 * Cloud schema tooling (docs/roadmap/cloud-deploy.md): apply the SQL under
 * `supabase/migrations/` to the operator's Supabase project and READ BACK
 * what exists. The read-back is the validation evidence — a migration
 * "ran" means nothing until the tables, views, RPC and buckets answer over
 * the project's own APIs (validation ladder: LIVE_MUTATION_CONFIRMED only
 * with this read-back).
 *
 * Two transports, both without extra dependencies:
 *   - probe:  PostgREST (`/rest/v1`) + Storage (`/storage/v1`) with the
 *             service-role key — read-only, no flag needed.
 *   - apply:  Supabase Management API `POST /v1/projects/{ref}/database/query`
 *             with a personal access token (SUPABASE_ACCESS_TOKEN). DDL is a
 *             cloud mutation ⇒ behind SUPABASE_SYNC_ENABLED like every other
 *             engine→cloud write. Applied versions are recorded in
 *             `supabase_migrations.schema_migrations` (the Supabase CLI's own
 *             ledger) so a later `supabase db push` sees them as done.
 *
 * Pure helpers (file listing, name parsing, result classification) carry
 * no network so unit tests cover them with no key or flag present.
 */

export const MANAGEMENT_API_BASE = "https://api.supabase.com";

/** Every object the migrations create — the read-back checklist. */
export const EXPECTED_TABLES = [
  "invites",
  "app_users",
  "waitlist",
  "application_status_mirror",
  "user_profiles",
  "application_receipts",
  "referral_bonuses",
  "engine_status",
  // onboarding data model (20260911000300-000700)
  "user_documents",
  "user_screener_answers",
  "user_personas",
  "user_integrations",
] as const;
export const EXPECTED_VIEWS = [
  "user_quota_status",
  "my_applications",
  "my_referral_invites",
  "my_integrations",
] as const;
export const EXPECTED_RPCS = [
  "redeem_invite",
  "referral_settings",
  "mint_referral_invite",
  "grant_referral_bonus_if_activated",
  "ensure_member",
  "complete_my_onboarding",
  "screener_registry_keys",
  "dispatch_key_version",
  "set_my_integration",
  "engine_store_integration_secret",
  "engine_read_integration_secret",
  "engine_set_integration_status",
] as const;
/**
 * Read-only probe arguments per RPC. Called with the service role
 * (auth.uid() is null) so the mutating ones refuse before touching a row:
 * redeem_invite/mint_referral_invite raise 'not authenticated' (400 ⇒
 * present); grant_referral_bonus_if_activated for a uuid with no rows
 * answers {granted:false}; referral_settings is immutable; ensure_member
 * (open signup, 20260911000100) raises 'not authenticated' with no args.
 * Onboarding RPCs (20260911000300-000700): complete_my_onboarding and
 * set_my_integration check auth first; the engine_* functions refuse an
 * empty secret / an unknown user BEFORE any write; the read returns null
 * for a uuid with no row.
 */
const NIL_UUID = "00000000-0000-4000-8000-000000000000";
export const RPC_PROBE_ARGS: Record<(typeof EXPECTED_RPCS)[number], Record<string, unknown>> = {
  redeem_invite: { invite_code: "JRA-PROBE-ONLY" },
  referral_settings: {},
  mint_referral_invite: {},
  grant_referral_bonus_if_activated: { p_invitee: NIL_UUID },
  ensure_member: {},
  complete_my_onboarding: {},
  screener_registry_keys: {},
  dispatch_key_version: {},
  set_my_integration: { p_provider: "jobright", p_patch: {} },
  engine_store_integration_secret: { p_user: NIL_UUID, p_provider: "jobright", p_secret: "", p_meta: {} },
  engine_read_integration_secret: { p_user: NIL_UUID, p_provider: "jobright" },
  engine_set_integration_status: { p_user: NIL_UUID, p_provider: "jobright", p_status: "disconnected", p_meta: {} },
};
export const EXPECTED_BUCKETS = ["resumes", "receipts", "transcripts"] as const;

export type MigrationFile = {
  /** Leading digits of the filename, e.g. 20260901000100. */
  version: string;
  /** Remainder of the filename without extension, e.g. invites_users_waitlist. */
  name: string;
  path: string;
};

const MIGRATION_RE = /^(\d{14})_([A-Za-z0-9_]+)\.sql$/;

export function parseMigrationFilename(
  filename: string,
): { version: string; name: string } | null {
  const m = MIGRATION_RE.exec(filename);
  if (!m) return null;
  return { version: m[1]!, name: m[2]! };
}

/** `supabase/migrations/*.sql` in filename (= version) order. */
export function listMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((f) => ({ file: f, parsed: parseMigrationFilename(f) }))
    .filter((x): x is { file: string; parsed: { version: string; name: string } } =>
      x.parsed !== null,
    )
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((x) => ({
      version: x.parsed.version,
      name: x.parsed.name,
      path: path.join(dir, x.file),
    }));
}

/** `https://<ref>.supabase.co` → `<ref>`; anything else ⇒ null. */
export function projectRefFromUrl(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]{15,})\.supabase\.(?:co|in)\/?$/i.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export type ObjectPresence = "present" | "absent" | "error";

export type SchemaProbe = {
  tables: Record<string, ObjectPresence>;
  views: Record<string, ObjectPresence>;
  rpcs: Record<string, ObjectPresence>;
  buckets: Record<string, ObjectPresence>;
  /** Every expected object is present. */
  complete: boolean;
  /** Human-readable detail per errored object (never contains keys). */
  errors: Record<string, string>;
};

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/** PostgREST answers 404 + PGRST205 for an unknown relation, PGRST202 for an unknown function. */
export function classifyRestProbe(status: number, body: string): ObjectPresence {
  if (status >= 200 && status < 300) return "present";
  if (status === 404 && /PGRST20[25]/.test(body)) return "absent";
  // 400/401/403 mean the object exists but the call was refused (e.g. an
  // RPC raising "not authenticated"): the definition is there.
  if (status === 400 || status === 401 || status === 403) return "present";
  return "error";
}

/**
 * Deterministic read-back of the expected cloud schema over the project's
 * REST + Storage APIs. Read-only: `limit=0` selects, one RPC call with a
 * code that cannot exist, one bucket listing.
 */
export async function probeSchema(input: {
  url: string;
  serviceRoleKey: string;
  fetch?: FetchLike;
}): Promise<SchemaProbe> {
  const f: FetchLike = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = input.url.replace(/\/+$/, "");
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
  };
  const probe: SchemaProbe = {
    tables: {},
    views: {},
    rpcs: {},
    buckets: {},
    complete: false,
    errors: {},
  };

  async function relation(name: string): Promise<ObjectPresence> {
    try {
      const r = await f(`${base}/rest/v1/${name}?select=*&limit=0`, { headers });
      const body = await r.text();
      const presence = classifyRestProbe(r.status, body);
      if (presence === "error") probe.errors[name] = `HTTP ${r.status}: ${body.slice(0, 200)}`;
      return presence;
    } catch (err) {
      probe.errors[name] = err instanceof Error ? err.message : String(err);
      return "error";
    }
  }

  for (const t of EXPECTED_TABLES) probe.tables[t] = await relation(t);
  for (const v of EXPECTED_VIEWS) probe.views[v] = await relation(v);

  for (const fn of EXPECTED_RPCS) {
    try {
      const r = await f(`${base}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(RPC_PROBE_ARGS[fn]),
      });
      const body = await r.text();
      const presence = classifyRestProbe(r.status, body);
      if (presence === "error") probe.errors[fn] = `HTTP ${r.status}: ${body.slice(0, 200)}`;
      probe.rpcs[fn] = presence;
    } catch (err) {
      probe.errors[fn] = err instanceof Error ? err.message : String(err);
      probe.rpcs[fn] = "error";
    }
  }

  try {
    const r = await f(`${base}/storage/v1/bucket`, { headers });
    const body = await r.text();
    if (r.status >= 200 && r.status < 300) {
      const ids = new Set(
        (JSON.parse(body) as Array<{ id?: string; name?: string }>).map(
          (b) => b.id ?? b.name ?? "",
        ),
      );
      for (const b of EXPECTED_BUCKETS) probe.buckets[b] = ids.has(b) ? "present" : "absent";
    } else {
      for (const b of EXPECTED_BUCKETS) probe.buckets[b] = "error";
      probe.errors["storage"] = `HTTP ${r.status}: ${body.slice(0, 200)}`;
    }
  } catch (err) {
    for (const b of EXPECTED_BUCKETS) probe.buckets[b] = "error";
    probe.errors["storage"] = err instanceof Error ? err.message : String(err);
  }

  probe.complete = [
    ...Object.values(probe.tables),
    ...Object.values(probe.views),
    ...Object.values(probe.rpcs),
    ...Object.values(probe.buckets),
  ].every((p) => p === "present");
  return probe;
}

/** The Supabase CLI's migration ledger, created exactly as the CLI does. */
export const MIGRATIONS_LEDGER_SQL = [
  "create schema if not exists supabase_migrations;",
  "create table if not exists supabase_migrations.schema_migrations (",
  "  version text not null primary key,",
  "  statements text[],",
  "  name text",
  ");",
].join("\n");

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Migration body + its ledger row in ONE query so they land together. */
export function buildApplyQuery(m: MigrationFile, sql: string): string {
  return (
    `${sql}\n\n` +
    `insert into supabase_migrations.schema_migrations (version, name, statements)\n` +
    `values (${sqlString(m.version)}, ${sqlString(m.name)}, array[${sqlString(sql)}])\n` +
    `on conflict (version) do nothing;\n`
  );
}

export type ApplyResult = {
  project_ref: string;
  already_applied: string[];
  applied: string[];
  /** Version that failed (apply stops at the first failure) + Supabase's message. */
  failed: { version: string; message: string } | null;
};

/**
 * Run a SQL string through the Management API. Returns the JSON rows
 * (an array; empty for DDL). Throws with Supabase's message on non-2xx —
 * never with the token.
 */
export async function managementQuery(input: {
  projectRef: string;
  accessToken: string;
  query: string;
  fetch?: FetchLike;
}): Promise<unknown[]> {
  const f: FetchLike = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const r = await f(
    `${MANAGEMENT_API_BASE}/v1/projects/${input.projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: input.query }),
    },
  );
  const body = await r.text();
  if (r.status < 200 || r.status >= 300) {
    let message = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? message;
    } catch {
      // keep raw text
    }
    throw new Error(`Management API HTTP ${r.status}: ${message}`);
  }
  if (body.trim() === "") return [];
  const parsed = JSON.parse(body) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Apply every migration not yet in the ledger, in version order, stopping
 * at the first failure (a half-applied schema is reported, never hidden).
 */
export async function applyMigrations(input: {
  projectRef: string;
  accessToken: string;
  migrations: MigrationFile[];
  fetch?: FetchLike;
  readFile?: (p: string) => string;
}): Promise<ApplyResult> {
  const read = input.readFile ?? ((p: string) => fs.readFileSync(p, "utf8"));
  const q = (query: string) =>
    managementQuery({
      projectRef: input.projectRef,
      accessToken: input.accessToken,
      query,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });

  await q(MIGRATIONS_LEDGER_SQL);
  const ledger = (await q(
    "select version from supabase_migrations.schema_migrations order by version;",
  )) as Array<{ version?: string }>;
  const done = new Set(ledger.map((r) => String(r.version ?? "")));

  const result: ApplyResult = {
    project_ref: input.projectRef,
    already_applied: [],
    applied: [],
    failed: null,
  };
  for (const m of input.migrations) {
    if (done.has(m.version)) {
      result.already_applied.push(m.version);
      continue;
    }
    try {
      await q(buildApplyQuery(m, read(m.path)));
      result.applied.push(m.version);
    } catch (err) {
      result.failed = {
        version: m.version,
        message: err instanceof Error ? err.message : String(err),
      };
      break;
    }
  }
  return result;
}
