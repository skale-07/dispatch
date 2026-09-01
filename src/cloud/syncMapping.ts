/**
 * Pure mapping from engine-plane application rows to cloud mirror rows
 * (`application_status_mirror` in supabase/migrations). This module is the
 * DATA BOUNDARY: the explicit field-by-field construction below is the
 * complete list of what may cross engine → cloud. No candidate PII, no
 * answers, no artifacts, no credentials — adding a field here needs the
 * same scrutiny as a new capability flag (see docs/roadmap/cloud-deploy.md).
 *
 * Kept free of config/db/network imports so the unit tests exercise it
 * without any flag or key existing.
 */

export type EngineApplicationRow = {
  id: string;
  state: string;
  route: string | null;
  created_at: string | null;
  updated_at: string | null;
  company: string | null;
  role: string | null;
  source_ats: string | null;
};

export type StatusMirrorRow = {
  user_id: string;
  engine_application_id: string;
  company: string | null;
  role: string | null;
  state: string;
  route: string | null;
  source_ats: string | null;
  engine_created_at: string | null;
  engine_updated_at: string | null;
  last_synced_at: string;
};

/** Exact upsert column set — asserted in tests so the boundary cannot drift. */
export const MIRROR_COLUMNS = [
  "user_id",
  "engine_application_id",
  "company",
  "role",
  "state",
  "route",
  "source_ats",
  "engine_created_at",
  "engine_updated_at",
  "last_synced_at",
] as const;

const MAX_TEXT = 300;

function clampText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > MAX_TEXT ? trimmed.slice(0, MAX_TEXT) : trimmed;
}

/** SQLite timestamps are ISO strings already; anything unparsable ⇒ null. */
function toTimestamp(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function toStatusMirrorRow(
  row: EngineApplicationRow,
  userId: string,
  now: Date,
): StatusMirrorRow {
  if (row.id.trim() === "") {
    throw new Error("engine application row has an empty id");
  }
  if (userId.trim() === "") {
    throw new Error("mirror rows require a cloud user id");
  }
  return {
    user_id: userId,
    engine_application_id: row.id,
    company: clampText(row.company),
    role: clampText(row.role),
    state: row.state,
    route: clampText(row.route),
    source_ats: clampText(row.source_ats),
    engine_created_at: toTimestamp(row.created_at),
    engine_updated_at: toTimestamp(row.updated_at),
    last_synced_at: now.toISOString(),
  };
}

export function toStatusMirrorRows(
  rows: EngineApplicationRow[],
  userId: string,
  now: Date,
): StatusMirrorRow[] {
  return rows.map((row) => toStatusMirrorRow(row, userId, now));
}

/** Bounded batches for upserts — no single giant network payload. */
export function chunkRows<T>(rows: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer (got ${size})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    out.push(rows.slice(i, i + size));
  }
  return out;
}
