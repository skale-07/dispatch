import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import {
  assertSyncConfigured,
  runReceiptsPush,
  runSupabaseSync,
} from "../../src/cloud/syncSupabase.js";
import { CONTROLLED_FILL_ENV_KEYS } from "../helpers/fillEnvIsolation.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";

/**
 * Plan M12 — the two tenancy capability flags and the sync entry points
 * taking an explicit user id. Both flags default OFF; each refuses to
 * boot when enabled without its inputs (same posture as hosted mode);
 * neither is ever enabled here. UNIT_CONFIRMED.
 */

const ROOT = path.resolve(__dirname, "..", "..");

/** A minimal env: every flag at its fail-closed default. */
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_PATH: "data/test.sqlite",
};

describe("tenancy flags (UNIT_CONFIRMED)", () => {
  it("TENANT_ENGINE_ENABLED and REMOTE_BROWSER_ENABLED default false; the settings default sensibly", () => {
    const c = loadConfig(BASE);
    expect(c.tenantEngineEnabled).toBe(false);
    expect(c.remoteBrowserEnabled).toBe(false);
    expect(c.tenantsRoot).toBe(path.resolve("private/tenants"));
    expect(c.tenantMaxConcurrent).toBe(1);
    expect(c.browserbaseApiKey).toBeUndefined();
    expect(c.browserbaseProjectId).toBeUndefined();
  });

  it("TENANT_ENGINE_ENABLED=true refuses to boot without the cloud plane", () => {
    expect(() => loadConfig({ ...BASE, TENANT_ENGINE_ENABLED: "true" })).toThrow(
      /TENANT_ENGINE_ENABLED=true requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
    );
    const ok = loadConfig({
      ...BASE,
      TENANT_ENGINE_ENABLED: "true",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    expect(ok.tenantEngineEnabled).toBe(true);
    // The operator's own SUPABASE_SYNC_USER_ID is NOT required: tenants carry their own ids.
  });

  it("REMOTE_BROWSER_ENABLED=true refuses to boot without a provider", () => {
    expect(() => loadConfig({ ...BASE, REMOTE_BROWSER_ENABLED: "true" })).toThrow(
      /REMOTE_BROWSER_ENABLED=true requires BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID/,
    );
    const ok = loadConfig({
      ...BASE,
      REMOTE_BROWSER_ENABLED: "true",
      BROWSERBASE_API_KEY: "bb",
      BROWSERBASE_PROJECT_ID: "p",
    });
    expect(ok.remoteBrowserEnabled).toBe(true);
  });

  it("TENANT_MAX_CONCURRENT is a small positive integer", () => {
    expect(loadConfig({ ...BASE, TENANT_MAX_CONCURRENT: "2" }).tenantMaxConcurrent).toBe(2);
    expect(() => loadConfig({ ...BASE, TENANT_MAX_CONCURRENT: "0" })).toThrow();
    expect(() => loadConfig({ ...BASE, TENANT_MAX_CONCURRENT: "9" })).toThrow();
  });

  it("both flags are in the env-isolation set, the house-rules list, .env.example and the knowledge graph", () => {
    for (const flag of ["TENANT_ENGINE_ENABLED", "REMOTE_BROWSER_ENABLED"] as const) {
      expect(CONTROLLED_FILL_ENV_KEYS).toContain(flag);
      for (const file of ["CLAUDE.md", ".cursor/rules/house-rules.mdc", ".env.example", "docs/knowledge-graph/graph.json", "docs/operator-guide.md"]) {
        expect(fs.readFileSync(path.join(ROOT, file), "utf8"), `${flag} in ${file}`).toContain(flag);
      }
      // .env.example ships it OFF.
      expect(fs.readFileSync(path.join(ROOT, ".env.example"), "utf8")).toMatch(new RegExp(`^${flag}=false`, "m"));
    }
  });
});

describe("sync takes an explicit user id (UNIT_CONFIRMED)", () => {
  const enabled: NodeJS.ProcessEnv = {
    ...BASE,
    SUPABASE_SYNC_ENABLED: "true",
    SUPABASE_URL: "https://x.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "k",
  };

  it("assertSyncConfigured: the operator's SUPABASE_SYNC_USER_ID is required only when no user id is passed", () => {
    const config = loadConfig(enabled);
    expect(() => assertSyncConfigured(config)).toThrow(/SUPABASE_SYNC_USER_ID/);
    expect(assertSyncConfigured(config, { userId: "tenant-1" })).toEqual({
      url: "https://x.supabase.co",
      serviceRoleKey: "k",
      userId: "tenant-1",
    });
    // An explicit id wins over the operator's own.
    const withOp = loadConfig({ ...enabled, SUPABASE_SYNC_USER_ID: "operator" });
    expect(assertSyncConfigured(withOp).userId).toBe("operator");
    expect(assertSyncConfigured(withOp, { userId: "tenant-1" }).userId).toBe("tenant-1");
    // The flag still gates everything.
    expect(() => assertSyncConfigured(loadConfig(BASE), { userId: "tenant-1" })).toThrow(/SUPABASE_SYNC_ENABLED/);
  });

  it("runSupabaseSync / runReceiptsPush stamp every row with the passed user id and never the operator's", async () => {
    const db = openDatabase(":memory:");
    migrate(db);
    try {
      const calls: Array<{ table: string; rows: Array<Record<string, unknown>> }> = [];
      const fakeClient = {
        from(table: string) {
          return {
            upsert: async (rows: Record<string, unknown> | Array<Record<string, unknown>>) => {
              calls.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
              return { error: null };
            },
          };
        },
        storage: { from: () => ({ upload: async () => ({ error: null }) }) },
      };
      const config = loadConfig({ ...enabled, SUPABASE_SYNC_USER_ID: "operator" });
      const status = await runSupabaseSync({
        db,
        userId: "tenant-1",
        config,
        client: fakeClient as never,
      });
      expect(status.heartbeat).toBe(true);
      const heartbeat = calls.find((c) => c.table === "engine_status");
      expect(heartbeat?.rows[0]?.["user_id"]).toBe("tenant-1");
      expect(calls.every((c) => c.rows.every((r) => r["user_id"] !== "operator"))).toBe(true);

      const receipts = await runReceiptsPush({ db, userId: "tenant-1", config, client: fakeClient as never });
      expect(receipts.candidates).toBe(0);
    } finally {
      closeDatabase(db);
    }
  });
});
