import { describe, expect, it } from "vitest";
import {
  chunkRows,
  MIRROR_COLUMNS,
  toStatusMirrorRow,
  toStatusMirrorRows,
  type EngineApplicationRow,
} from "../../src/cloud/syncMapping.js";
import { assertSyncConfigured } from "../../src/cloud/syncSupabase.js";
import { loadConfig } from "../../src/config/index.js";

const NOW = new Date("2026-09-01T12:00:00.000Z");

function row(overrides: Partial<EngineApplicationRow> = {}): EngineApplicationRow {
  return {
    id: "app-1",
    state: "COMPLETED",
    route: "ats:greenhouse",
    created_at: "2026-08-30T01:02:03.000Z",
    updated_at: "2026-08-31T04:05:06.000Z",
    company: "Acme",
    role: "ML Intern",
    source_ats: "greenhouse",
    ...overrides,
  };
}

describe("cloud sync mapping (UNIT_CONFIRMED)", () => {
  it("maps an engine row onto exactly the permitted mirror columns", () => {
    const mapped = toStatusMirrorRow(row(), "user-uuid", NOW);
    expect(Object.keys(mapped).sort()).toEqual([...MIRROR_COLUMNS].sort());
    expect(mapped).toEqual({
      user_id: "user-uuid",
      engine_application_id: "app-1",
      company: "Acme",
      role: "ML Intern",
      state: "COMPLETED",
      route: "ats:greenhouse",
      source_ats: "greenhouse",
      engine_created_at: "2026-08-30T01:02:03.000Z",
      engine_updated_at: "2026-08-31T04:05:06.000Z",
      last_synced_at: NOW.toISOString(),
    });
  });

  it("is a whitelist: extra fields on the source row never cross", () => {
    const dirty = {
      ...row(),
      error_summary: "stack trace with a portal email inside",
      versions_json: "{...}",
      answers: ["secret"],
    } as EngineApplicationRow;
    const mapped = toStatusMirrorRow(dirty, "u", NOW) as Record<string, unknown>;
    expect(mapped["error_summary"]).toBeUndefined();
    expect(mapped["versions_json"]).toBeUndefined();
    expect(mapped["answers"]).toBeUndefined();
    expect(Object.keys(mapped)).toHaveLength(MIRROR_COLUMNS.length);
  });

  it("normalizes blanks, clamps oversized text and nulls bad timestamps", () => {
    const mapped = toStatusMirrorRow(
      row({
        company: "   ",
        role: "x".repeat(1000),
        route: null,
        created_at: "not-a-date",
        updated_at: null,
      }),
      "u",
      NOW,
    );
    expect(mapped.company).toBeNull();
    expect(mapped.role).toHaveLength(300);
    expect(mapped.route).toBeNull();
    expect(mapped.engine_created_at).toBeNull();
    expect(mapped.engine_updated_at).toBeNull();
  });

  it("rejects empty ids and empty user ids", () => {
    expect(() => toStatusMirrorRow(row({ id: " " }), "u", NOW)).toThrow(/empty id/);
    expect(() => toStatusMirrorRow(row(), "  ", NOW)).toThrow(/user id/);
  });

  it("maps lists and chunks them into bounded batches", () => {
    const rows = toStatusMirrorRows(
      [row(), row({ id: "app-2" }), row({ id: "app-3" })],
      "u",
      NOW,
    );
    expect(rows.map((r) => r.engine_application_id)).toEqual([
      "app-1",
      "app-2",
      "app-3",
    ]);
    expect(chunkRows(rows, 2).map((c) => c.length)).toEqual([2, 1]);
    expect(chunkRows([], 5)).toEqual([]);
    expect(() => chunkRows(rows, 0)).toThrow(/positive integer/);
  });
});

describe("supabase sync gate (UNIT_CONFIRMED, fail-closed)", () => {
  it("refuses when SUPABASE_SYNC_ENABLED is absent (default false)", () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);
    expect(config.supabaseSyncEnabled).toBe(false);
    expect(() => assertSyncConfigured(config)).toThrow(/SUPABASE_SYNC_ENABLED/);
  });

  it("names every missing key when enabled but unconfigured", () => {
    const config = loadConfig({
      SUPABASE_SYNC_ENABLED: "true",
    } as unknown as NodeJS.ProcessEnv);
    expect(() => assertSyncConfigured(config)).toThrow(
      /SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SYNC_USER_ID/,
    );
  });

  it("returns the triple when fully configured", () => {
    const config = loadConfig({
      SUPABASE_SYNC_ENABLED: "true",
      SUPABASE_URL: "https://ref.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "srk",
      SUPABASE_SYNC_USER_ID: "uid",
    } as unknown as NodeJS.ProcessEnv);
    expect(assertSyncConfigured(config)).toEqual({
      url: "https://ref.supabase.co",
      serviceRoleKey: "srk",
      userId: "uid",
    });
  });
});
