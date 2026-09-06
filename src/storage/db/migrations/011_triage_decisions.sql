-- LLM failure-triage decisions: one row per (application, failure
-- signature) decision. The LLM only ever picks from the enumerated action
-- space and every pick is re-validated deterministically before any
-- executor runs; this table is the retry-differently memory — a
-- signature's past actions become forbidden on the next occurrence, and a
-- REFUTED (signature, action) pair is forbidden forever. Rationale text
-- is UNVERIFIED model output; outcome_status is upgraded only by the
-- deterministic read-back sweep (verifyTriageOutcomes).
CREATE TABLE IF NOT EXISTS triage_decisions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  application_id TEXT NOT NULL,
  arm_run_id TEXT,
  failure_signature TEXT NOT NULL,
  evidence_relpath TEXT,                 -- artifacts/triage/<id>/decision.json
  action TEXT NOT NULL,
  forbidden_actions_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT,                        -- UNVERIFIED model text, truncated
  confidence TEXT,                       -- high | medium | low
  mode TEXT NOT NULL,                    -- shadow | act
  llm_model TEXT,
  executed INTEGER NOT NULL DEFAULT 0,
  execution_result_json TEXT,            -- executor result / transition_skipped
  outcome_status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING|CONFIRMED|REFUTED|EXPIRED
  outcome_checked_at TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS triage_decisions_app_idx
  ON triage_decisions(application_id);
CREATE INDEX IF NOT EXISTS triage_decisions_sig_idx
  ON triage_decisions(failure_signature);
