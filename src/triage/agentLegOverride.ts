import type { Db } from "../storage/db/client.js";

/**
 * One-shot agent-leg override (M4 of the LLM decision layer): an executed
 * `engage_agent_leg` triage decision is the marker; runNavigation consumes
 * it to run the agent phase ONCE past a hostPolicy park. Standalone module
 * (DB only) — runNavigation must not import the triage orchestrator
 * (runTriage → runPipeline → runNavigation would be a cycle).
 */
export function consumeAgentLegOverride(db: Db, applicationId: string): boolean {
  const row = db
    .prepare(
      `SELECT id, execution_result_json FROM triage_decisions
       WHERE application_id = ? AND action = 'engage_agent_leg' AND executed = 1
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(applicationId) as
    | { id: string; execution_result_json: string | null }
    | undefined;
  if (!row) return false;
  let result: Record<string, unknown> = {};
  try {
    result = JSON.parse(row.execution_result_json ?? "{}") as Record<string, unknown>;
  } catch {
    result = {};
  }
  if (result.agent_leg_consumed === true) return false;
  db.prepare(
    `UPDATE triage_decisions SET execution_result_json = ? WHERE id = ?`,
  ).run(JSON.stringify({ ...result, agent_leg_consumed: true }), row.id);
  return true;
}
