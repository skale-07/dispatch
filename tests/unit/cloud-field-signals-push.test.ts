import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIELD_EVENT_COLUMNS,
  FIELD_SIGNAL_COLUMNS,
  runFieldSignalsPush,
  selectTenantFieldSignals,
  selectUserFieldEvents,
  usableSignalLabel,
} from "../../src/cloud/fieldSignals.js";
import type { SupabaseClientLike } from "../../src/cloud/syncSupabase.js";
import { loadConfig } from "../../src/config/env.js";
import { upsertJobByFingerprint } from "../../src/jobs/repository.js";
import { upsertOpenReviewItem } from "../../src/queue/reviewItems.js";
import { createApplication } from "../../src/queue/stateMachine.js";
import { closeDatabase, migrate, openDatabase } from "../../src/storage/db/client.js";

/**
 * Plan M21 — the engine's field-signal push. What leaves the box is WHICH
 * question, on which ATS, how often, how often unanswered — never a value.
 * The two column whitelists are exact; demographic / sensitive / widget /
 * short labels never become a signal; events are one per (field,
 * application, kind); the push is absolute and idempotent through the two
 * service-role RPCs. UNIT_CONFIRMED against a seeded SQLite and a fake client.
 */

const UID = "11111111-2222-4333-8444-555555555555";

function seedRun(db: ReturnType<typeof openDatabase>, ats: string, applicationId: string | null, createdAt: string): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO fill_runs (id, created_at, mode, source, ats, job_url, application_id, mutation_attempted)
     VALUES (?, ?, 'plan', 'test', ?, 'https://x/apply', ?, 0)`,
  ).run(id, createdAt, ats, applicationId);
  return id;
}

function seedOutcome(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  input: { label: string; canonical?: string | null; plan_action?: string; fill_ok?: number | null; notes?: string[]; expected?: string | null },
): void {
  db.prepare(
    `INSERT INTO fill_field_outcomes (id, fill_run_id, field_id, label, field_type, canonical_field, control_kind, plan_action, approved, fill_ok, expected_redacted, value_fingerprint, notes_json)
     VALUES (?, ?, ?, ?, 'text', ?, 'text', ?, 1, ?, ?, 'fp', ?)`,
  ).run(
    randomUUID(),
    runId,
    `f-${Math.random().toString(36).slice(2, 8)}`,
    input.label,
    input.canonical ?? null,
    input.plan_action ?? "fill",
    input.fill_ok ?? 1,
    input.expected ?? null,
    JSON.stringify(input.notes ?? []),
  );
}

describe("field signals selection (UNIT_CONFIRMED)", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-signals-"));
    db = openDatabase(path.join(dir, "app.sqlite"));
    migrate(db);
  });
  afterEach(() => {
    closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the label gate: short, sensitive, demographic and widget labels never become signals", () => {
    expect(usableSignalLabel("Are you legally authorized to work in the United States?")).toMatch(/^Are you/);
    expect(usableSignalLabel("Email")).toBeNull();
    expect(usableSignalLabel("What is your gender identity?")).toBeNull();
    expect(usableSignalLabel("Veteran status (voluntary self-identification)")).toBeNull();
    expect(usableSignalLabel("Have you ever been convicted of a felony?")).toBeNull();
    expect(usableSignalLabel("Voluntary Disclosures")).toBeNull(); // a section heading, never a question
    expect(usableSignalLabel("field_12345")).toBeNull(); // inspector placeholder
    expect(usableSignalLabel(null)).toBeNull();
  });

  it("aggregates one row per (signal, ats) with exact columns and no value-bearing key; events are one per (field, app, kind)", () => {
    const job = upsertJobByFingerprint(db, { company: "Acme", role: "SWE Intern", applicationUrl: "https://jobs.lever.co/acme/1" });
    const app = createApplication(db, { jobId: job.id, state: "QUEUED" });
    const r1 = seedRun(db, "lever", app.id, "2026-09-13T10:00:00Z");
    const r2 = seedRun(db, "Lever", null, "2026-09-14T10:00:00Z");
    seedOutcome(db, r1, { label: "Do you require visa sponsorship now or in the future?", canonical: "requires_sponsorship", plan_action: "skip", fill_ok: 0, notes: ["required question unanswered"], expected: "SECRET-VALUE" });
    seedOutcome(db, r2, { label: "Do you require visa sponsorship now or in the future?", canonical: "requires_sponsorship", fill_ok: 1 });
    seedOutcome(db, r1, { label: "How many hours per week can you commit this term?", plan_action: "skip", fill_ok: 0, notes: ["unmapped screener; no profile value"] });
    seedOutcome(db, r1, { label: "Please upload your transcript", plan_action: "skip", fill_ok: 0, notes: ["transcript required, none on file"] });
    seedOutcome(db, r1, { label: "What is your race or ethnicity?", plan_action: "skip", fill_ok: 0, notes: ["demographic — sensitive profile path"], expected: "NEVER" });
    db.prepare(
      `INSERT INTO screener_predictions (id, label_fingerprint, label, raw_label, control, ats, status, created_at, updated_at)
       VALUES ('p1', 'abcdefabcdefabcdefabcdefabcdefab', 'how many hours per week can you commit this term?', 'How many hours per week can you commit this term?', 'text', 'lever', 'PENDING', '2026-09-12T10:00:00Z', '2026-09-14T11:00:00Z')`,
    ).run();
    upsertOpenReviewItem(db, { kind: "AMBIGUOUS_FIELD", title: "Answer needed: What is your earliest available start date?", payload: { ats: "lever" }, applicationId: app.id });

    const signals = selectTenantFieldSignals(db);
    for (const s of signals) expect(Object.keys(s).sort()).toEqual([...FIELD_SIGNAL_COLUMNS].sort());
    const spons = signals.find((s) => s.signal_key === "canonical:requires_sponsorship")!;
    expect(spons).toMatchObject({ ats: "lever", forms_seen: 2, unanswered_count: 1, required_count: 1, first_seen_at: "2026-09-13T10:00:00Z", last_seen_at: "2026-09-14T10:00:00Z" });
    const hours = signals.find((s) => String(s.label).startsWith("How many hours"))!;
    expect(hours.signal_key).toMatch(/^label:[a-f0-9]{12}$/);
    expect(hours).toMatchObject({ forms_seen: 2, unanswered_count: 2, last_seen_at: "2026-09-14T11:00:00Z" });
    expect(signals.some((s) => /race|ethnicity/i.test(String(s.label)))).toBe(false);
    expect(JSON.stringify(signals)).not.toMatch(/SECRET-VALUE|NEVER|expected_|observed_|value_fingerprint|selected_option|options_sample|prediction_json/);

    const events = selectUserFieldEvents(db);
    for (const e of events) expect(Object.keys(e).sort()).toEqual([...FIELD_EVENT_COLUMNS].sort());
    expect(events.map((e) => e.kind).sort()).toEqual(["review_item", "skip_unmapped", "transcript_required", "unanswered_required"]);
    expect(events.every((e) => e.engine_application_id === app.id)).toBe(true);
    expect(events.some((e) => /race/i.test(e.label))).toBe(false);
  });

  it("the push is absolute through the two RPCs with the tenant's id, in bounded batches, and refuses without the sync gate", async () => {
    const r = seedRun(db, "ashby", null, "2026-09-14T10:00:00Z");
    seedOutcome(db, r, { label: "Are you willing to relocate for this role?", canonical: "relocation" });
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { data: null, error: null }; } } as unknown as SupabaseClientLike;
    const config = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite", SUPABASE_SYNC_ENABLED: "true", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_SYNC_USER_ID: "99999999-9999-4999-8999-999999999999" });
    const res = await runFieldSignalsPush({ db, userId: UID, config, client });
    expect(res).toMatchObject({ signals: 1, events: 0 });
    expect(rpcs).toEqual([{ fn: "engine_upsert_field_signals", args: { p_tenant: UID, p_rows: [expect.objectContaining({ signal_key: "canonical:relocation", ats: "ashby" })] } }]);
    const off = loadConfig({ NODE_ENV: "test", DATABASE_PATH: "data/test.sqlite" });
    await expect(runFieldSignalsPush({ db, userId: UID, config: off, client })).rejects.toThrow(/SUPABASE_SYNC_ENABLED/);
  });
});
