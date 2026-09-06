import type { Db } from "../storage/db/client.js";
import { logger } from "../logging/logger.js";
import { classifyReason } from "./failureSignature.js";

/**
 * Deterministic read-back for triage decisions: a decision's rationale is
 * never trusted; only what the application_events stream did AFTER the
 * decision can confirm or refute it (validation-ladder doctrine — an
 * LLM self-report carries no level until independently verified).
 *
 * - CONFIRMED: a later event reached a strictly-better state
 *   (SUBMITTED / READY_TO_SUBMIT / COMPLETED / CONTACTS_EXTRACTED…).
 * - REFUTED: a later event landed back in the same end_state with the
 *   same reason class — the remediation demonstrably did not change the
 *   outcome. REFUTED (signature, action) pairs are forbidden forever.
 * - EXPIRED: nothing conclusive after EXPIRE_DAYS.
 */

const CONFIRM_STATES = new Set([
  "READY_TO_SUBMIT",
  "SUBMITTED",
  "COMPLETED",
  "CONTACTS_EXTRACTED",
  "EMAIL_GENERATED",
  "DRAFT_CREATED",
]);

export const TRIAGE_OUTCOME_EXPIRE_DAYS = 7;

/** Signature end-states whose refails are gate stops (no event trail). */
const GATE_PARK_SIG_STATES = new Set(["NATIVE_AUTOFILL_RUNNING", "READY_TO_SUBMIT"]);

export type VerifySweepResult = {
  checked: number;
  confirmed: number;
  refuted: number;
  expired: number;
};

export function verifyTriageOutcomes(db: Db): VerifySweepResult {
  const pending = db
    .prepare(
      `SELECT id, application_id, failure_signature, action, created_at, executed
       FROM triage_decisions WHERE outcome_status = 'PENDING'`,
    )
    .all() as Array<{
    id: string;
    application_id: string;
    failure_signature: string;
    action: string;
    created_at: string;
    executed: number;
  }>;

  const result: VerifySweepResult = {
    checked: pending.length,
    confirmed: 0,
    refuted: 0,
    expired: 0,
  };
  const now = Date.now();

  for (const decision of pending) {
    const laterEvents = db
      .prepare(
        `SELECT next_state, reason, timestamp FROM application_events
         WHERE application_id = ? AND timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(decision.application_id, decision.created_at) as Array<{
      next_state: string;
      reason: string | null;
      timestamp: string;
    }>;

    const [sigEndState, , sigReasonClass] = decision.failure_signature.split("|");

    // A same-signature refail ANYWHERE after the decision outranks
    // transient progress: night25 cycle 14 (#174) — a requeued app reached
    // READY_TO_SUBMIT and then re-failed at the identical wall, and the
    // first-chronological-hit rule scored that CONFIRMED. Getting further
    // before hitting the same wall is not a fixed application.
    let verdict: "CONFIRMED" | "REFUTED" | "EXPIRED" | null = null;
    const refailed = laterEvents.some(
      (event) =>
        event.next_state === sigEndState &&
        classifyReason(event.reason) === sigReasonClass,
    );
    if (refailed) {
      verdict = "REFUTED";
    } else if (laterEvents.some((event) => CONFIRM_STATES.has(event.next_state))) {
      verdict = "CONFIRMED";
    } else if (decision.executed === 1 && GATE_PARK_SIG_STATES.has(sigEndState ?? "")) {
      // #177 (night25 Citadel): gate-stop refails write NO application_event
      // — an executed requeue for a gate-park signature could neither
      // confirm nor refute, stalemating re-triage while the app re-ground.
      // The refail evidence that DOES exist is the fill_runs row each
      // failed attempt writes: a later non-passing fill while the app sits
      // back in the signature's state is the wall recurring.
      const laterFailedFill = db
        .prepare(
          `SELECT COUNT(*) AS n FROM fill_runs
           WHERE application_id = ? AND created_at > ?
             AND (verify_passed IS NULL OR verify_passed = 0)`,
        )
        .get(decision.application_id, decision.created_at) as { n: number };
      const current = db
        .prepare(`SELECT state FROM applications WHERE id = ?`)
        .get(decision.application_id) as { state: string } | undefined;
      if (laterFailedFill.n > 0 && current?.state === sigEndState) {
        verdict = "REFUTED";
      }
    }
    if (verdict === null) {
      const ageMs = now - Date.parse(decision.created_at);
      if (ageMs > TRIAGE_OUTCOME_EXPIRE_DAYS * 24 * 60 * 60 * 1000) {
        verdict = "EXPIRED";
      }
    }
    if (verdict === null) continue;

    // A non-executed (shadow / precondition-failed) decision cannot claim
    // credit for a later success — only executed decisions CONFIRM. It can
    // still be REFUTED/EXPIRED, which feeds the forbidden memory honestly.
    if (verdict === "CONFIRMED" && decision.executed !== 1) continue;

    db.prepare(
      `UPDATE triage_decisions SET outcome_status = ?, outcome_checked_at = ?
       WHERE id = ?`,
    ).run(verdict, new Date().toISOString(), decision.id);
    if (verdict === "CONFIRMED") result.confirmed += 1;
    else if (verdict === "REFUTED") result.refuted += 1;
    else result.expired += 1;
  }

  logger.info("triage outcome sweep", {
    service: "triage",
    action: "verify_outcomes",
    metadata: { ...result },
  });
  return result;
}
