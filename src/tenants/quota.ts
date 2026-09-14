import type { Db } from "../storage/db/client.js";

/**
 * Quota for a tenant run (plan v0.5, M15).
 *
 * The cloud's `user_quota_status` view is the record of truth for how many
 * COMPLETED applications a user may still have; it counts the mirrored
 * rows the engine has already pushed. Between a run and its sync the
 * tenant's OWN SQLite may hold completions the view has not seen yet, so
 * the run budget subtracts those too — a run can never spend what a
 * pending sync is about to claim.
 *
 * Fail-closed: no view row ⇒ remaining 0 ⇒ the run does not start.
 */

export type CloudQuota = {
  present: boolean;
  maxCompletedApplications: number;
  completedApplications: number;
  remaining: number;
};

/** The subset of supabase-js this module reads; a hand-written fake in tests. */
export type QuotaClient = {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): PromiseLike<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
  };
};

const nonNegInt = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

export async function readCloudQuota(client: QuotaClient, userId: string): Promise<CloudQuota> {
  const { data, error } = await client
    .from("user_quota_status")
    .select("max_completed_applications, completed_applications, remaining")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(`user_quota_status read failed: ${error.message}`);
  if (!data) {
    return { present: false, maxCompletedApplications: 0, completedApplications: 0, remaining: 0 };
  }
  return {
    present: true,
    maxCompletedApplications: nonNegInt(data["max_completed_applications"]),
    completedApplications: nonNegInt(data["completed_applications"]),
    remaining: nonNegInt(data["remaining"]),
  };
}

/** COMPLETED rows in the tenant's own database — what the mirror will count once synced. */
export function countLocalCompleted(db: Db): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM applications WHERE state = 'COMPLETED'`)
    .get() as { n: number } | undefined;
  return nonNegInt(row?.n);
}

export type RunBudget = {
  /** Submissions this run may make; 0 ⇒ do not start. */
  maxSubmits: number;
  /** Local completions the cloud view has not counted yet. */
  unmirrored: number;
  reason: "ok" | "quota_missing" | "quota_exhausted";
};

/**
 * remaining − (local COMPLETED − cloud completed)⁺, capped by the caller's
 * per-run ceiling. Pure.
 */
export function computeRunBudget(input: {
  quota: CloudQuota;
  localCompleted: number;
  /** Per-run cap (the scheduler's `max_submits`); default 1. */
  cap?: number;
}): RunBudget {
  const cap = Math.max(0, Math.floor(input.cap ?? 1));
  if (!input.quota.present) return { maxSubmits: 0, unmirrored: 0, reason: "quota_missing" };
  const unmirrored = Math.max(0, nonNegInt(input.localCompleted) - input.quota.completedApplications);
  const available = Math.max(0, input.quota.remaining - unmirrored);
  const maxSubmits = Math.min(available, cap);
  return { maxSubmits, unmirrored, reason: maxSubmits > 0 ? "ok" : "quota_exhausted" };
}
