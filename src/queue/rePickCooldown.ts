/**
 * #279 (day31/day32 livelock): every re-pick of an in-flight application
 * refreshes its updated_at, and the worker's second pass orders by recency
 * inside an ATS tier, so a row that had just failed re-selected itself
 * while everything behind it starved — Guardian Life ×12, First Internet
 * Bank ×9, Federal Reserve Board ×7 on 2026-09-14, each time behind the
 * same sign-in wall; 125 cycles produced one submission.
 *
 * The picker stamps `versions_json.last_picked_at` on every hand-out; a
 * row picked inside this window is not handed out again. Keyed on the
 * pick stamp, not updated_at, so an operator requeue or a freshly seeded
 * row (no stamp) is never delayed. Fresh QUEUED rows and READY_TO_SUBMIT
 * (one click from done) are never delayed either; the tier order and the
 * 24h recency policy are untouched. Pure, so the picker's behaviour is
 * unit-testable without the worker.
 */
export const RE_PICK_COOLDOWN_MS = 45 * 60_000;
export const LAST_PICKED_KEY = "last_picked_at";

export function inRePickCooldown(
  state: string,
  lastPickedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (state === "QUEUED" || state === "READY_TO_SUBMIT") return false;
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
