import { describe, expect, it } from "vitest";
import {
  chunkRows,
  joinOnboardedUsers,
  MIRROR_COLUMNS,
  toReceiptUpload,
  toStatusMirrorRow,
  toStatusMirrorRows,
  type CloudProfileRow,
  type EngineApplicationRow,
  type EngineSubmissionRow,
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

describe("receipt upload mapping (UNIT_CONFIRMED)", () => {
  function sub(overrides: Partial<EngineSubmissionRow> = {}): EngineSubmissionRow {
    return {
      application_id: "app-9",
      submission_attempt_number: 2,
      submitted_at: "2026-09-01T10:00:00.000Z",
      confirmation_url: "https://boards.example/confirm/123",
      application_identifier: "GH-456",
      screenshot_path: "applications/app-9/submission/receipt.png",
      ...overrides,
    };
  }

  it("builds the RLS-matching object path {uid}/{app}/attempt-N.png", () => {
    const r = toReceiptUpload(sub(), "user-1");
    expect(r).not.toBeNull();
    expect(r!.objectPath).toBe("user-1/app-9/attempt-2.png");
    expect(r!.row).toEqual({
      user_id: "user-1",
      engine_application_id: "app-9",
      submission_attempt: 2,
      object_path: "user-1/app-9/attempt-2.png",
      submitted_at: "2026-09-01T10:00:00.000Z",
      confirmation_url: "https://boards.example/confirm/123",
      application_identifier: "GH-456",
    });
    expect(r!.localScreenshotPath).toBe("applications/app-9/submission/receipt.png");
  });

  it("no screenshot evidence ⇒ no receipt; bad attempt defaults to 1", () => {
    expect(toReceiptUpload(sub({ screenshot_path: null }), "u")).toBeNull();
    expect(toReceiptUpload(sub({ screenshot_path: "  " }), "u")).toBeNull();
    const r = toReceiptUpload(sub({ submission_attempt_number: null }), "u");
    expect(r!.row.submission_attempt).toBe(1);
    expect(() => toReceiptUpload(sub(), " ")).toThrow(/user id/);
  });
});

describe("onboarded-profile join (UNIT_CONFIRMED)", () => {
  function profile(overrides: Partial<CloudProfileRow> = {}): CloudProfileRow {
    return {
      user_id: "u1",
      full_name: "Test User",
      phone: "+1 555 0100",
      location_city: "Boston",
      location_region: "MA",
      location_country: "US",
      linkedin_url: null,
      github_url: null,
      portfolio_url: null,
      work_authorization: "us_citizen",
      needs_sponsorship: false,
      education: [{ school: "MIT", degree: "BS" }],
      job_preferences: { titles: ["SWE Intern"], remote: "any" },
      resume_object_path: "u1/resume.pdf",
      resume_filename: "resume.pdf",
      onboarding_completed_at: "2026-09-01T09:00:00.000Z",
      ...overrides,
    };
  }

  it("joins users to completed profiles and carries invite quota", () => {
    const out = joinOnboardedUsers(
      [
        { id: "u1", email: "a@b.c", invite_id: "i1", max_completed_applications: 7 },
        { id: "u2", email: "x@y.z", invite_id: "i2", max_completed_applications: 5 },
      ],
      [profile()],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u1");
    expect(out[0]!.maxCompletedApplications).toBe(7);
    expect(out[0]!.workAuthorization).toBe("us_citizen");
    expect(out[0]!.resumeObjectPath).toBe("u1/resume.pdf");
    expect(out[0]!.education).toEqual([{ school: "MIT", degree: "BS" }]);
  });

  it("half-finished onboarding is never returned; malformed jsonb degrades safely", () => {
    const out = joinOnboardedUsers(
      [
        { id: "u1", email: "a@b.c", invite_id: null },
        { id: "u3", email: "m@n.o", invite_id: null },
      ],
      [
        profile({ onboarding_completed_at: null }),
        profile({
          user_id: "u3",
          education: "not-an-array",
          job_preferences: ["not-an-object"],
        }),
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.userId).toBe("u3");
    expect(out[0]!.education).toEqual([]);
    expect(out[0]!.jobPreferences).toEqual({});
    expect(out[0]!.maxCompletedApplications).toBeNull();
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
