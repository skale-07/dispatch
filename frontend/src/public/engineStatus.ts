import { supabase } from "../lib/supabaseClient";
import { CONTRACT, type EngineStatusRow } from "./contract";

/**
 * ── Engine heartbeat (launcher contract §10, migration 20260902000500) ──
 *
 * The engine's sync worker upserts one engine_status row per user on
 * every tick, including ticks with nothing to push. That row is the
 * ONLY evidence the dashboard has that an engine is alive for this
 * account; before it existed the page inferred activity from
 * application timestamps (QA 2026-09-02, D-25), which could not tell
 * "idle" from "off".
 *
 * Freshness is judged against the sync cadence. The OPERATOR defines
 * the real cadence (cloud:sync runs after each session / alongside
 * auto:cycle — see docs/roadmap/cloud-deploy.md); this constant is the
 * frontend's assumption of it, overridable per build so a deployment
 * with a slower tick does not read as "offline" between ticks.
 */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const envInterval = Number(import.meta.env.VITE_ENGINE_SYNC_INTERVAL_MS);
export const SYNC_INTERVAL_MS =
  Number.isFinite(envInterval) && envInterval > 0
    ? envInterval
    : DEFAULT_SYNC_INTERVAL_MS;

/** A row older than this is "offline" (contract: 2 × the sync interval). */
export const ENGINE_STALE_AFTER_MS = 2 * SYNC_INTERVAL_MS;

export type EngineIndicator =
  /** No row yet: nothing has ever synced for this account. */
  | { state: "not-connected" }
  /** Fresh heartbeat, last tick clean. */
  | { state: "running"; row: EngineStatusRow }
  /** Fresh heartbeat but the tick failed after writing it. */
  | { state: "running-push-failed"; row: EngineStatusRow }
  /** Heartbeat older than the staleness window. */
  | { state: "offline"; row: EngineStatusRow }
  /** The read itself failed — reported, not folded into "not connected". */
  | { state: "unknown"; reason: string };

/** Own row, read-only; null when the engine has never synced this user. */
export async function getEngineStatus(): Promise<EngineStatusRow | null> {
  if (!supabase) throw new Error("account service not configured in this build");
  const { data, error } = await supabase
    .from(CONTRACT.engineStatusTable)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as EngineStatusRow | null) ?? null;
}

/**
 * Pure classification so the rule is testable and the fixture harness
 * can pin every state: the contract's `now - last_seen_at < 2 × interval`.
 */
export function classifyEngine(
  row: EngineStatusRow | null,
  now = Date.now(),
  staleAfterMs = ENGINE_STALE_AFTER_MS,
): EngineIndicator {
  if (row === null) return { state: "not-connected" };
  const seen = Date.parse(row.last_seen_at);
  if (!Number.isFinite(seen)) return { state: "unknown", reason: "heartbeat has no readable timestamp" };
  if (now - seen < staleAfterMs) {
    return row.last_error ? { state: "running-push-failed", row } : { state: "running", row };
  }
  return { state: "offline", row };
}
