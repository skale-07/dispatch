import type { Db } from "../storage/db/client.js";

/**
 * #279 (day31/day32 livelock): every re-pick of an in-flight application
 * refreshes its updated_at, and the worker's second pass orders by recency
 * inside an ATS tier, so a row that had just failed re-selected itself
 * while everything behind it starved — Guardian Life ×12, First Internet
 * Bank ×9, Federal Reserve Board ×7 on 2026-09-14, each time behind the
 * same sign-in wall; 125 cycles produced one submission.
 *
 * The picker stamps `versions_json.last_picked_at` on every hand-out; a
 * row picked inside this window is not handed out again — whatever its
 * state (live 04e7ae17, cycles 153/154: an automated requeue put the row
 * back to QUEUED and the old QUEUED exemption re-handed it three minutes
 * later). READY_TO_SUBMIT (one click from done) is the only exemption.
 * OPERATOR requeues (retry, review resolutions) clear the stamp, so a
 * deliberate requeue runs on the next cycle; fresh rows carry no stamp.
 * Pure predicate, so the picker's behaviour is unit-testable without the
 * worker.
 */
export const RE_PICK_COOLDOWN_MS = 45 * 60_000;
export const LAST_PICKED_KEY = "last_picked_at";

export function inRePickCooldown(
  state: string,
  lastPickedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (state === "READY_TO_SUBMIT") return false;
  if (!lastPickedAt) return false;
  const t = Date.parse(lastPickedAt);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < RE_PICK_COOLDOWN_MS;
}

/** The stamp the picker reads, from a raw versions_json string. */
export function lastPickedAtOf(versionsJson: string | null | undefined): string | null {
  if (!versionsJson) return null;
  try {
    const v = JSON.parse(versionsJson) as Record<string, unknown>;
    const s = v[LAST_PICKED_KEY];
    return typeof s === "string" ? s : null;
  } catch {
    return null;
  }
}

/**
 * An operator requeue is deliberate: drop the pick stamp so the row is
 * eligible on the next cycle. Every other versions_json key is preserved;
 * a row without a stamp is untouched.
 */
export function clearPickStamp(db: Db, applicationId: string): boolean {
  const row = db.prepare(`SELECT versions_json FROM applications WHERE id = ?`).get(applicationId) as
    | { versions_json: string }
    | undefined;
  if (!row) return false;
  let versions: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.versions_json || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) versions = parsed as Record<string, unknown>;
  } catch {
    versions = {};
  }
  if (!(LAST_PICKED_KEY in versions)) return false;
  delete versions[LAST_PICKED_KEY];
  db.prepare(`UPDATE applications SET versions_json = ? WHERE id = ?`).run(JSON.stringify(versions), applicationId);
  return true;
}
