# Overnight issues — 2026-09-05 (night25, OBSERVATION-ONLY autonomy run)

Continues numbering from 2026-09-04 (#165 last). Session log:
`artifacts/console/auto-cycle-2026-09-05-night25.log`.

Operator directive this session (2026-09-05): run the applying pipeline and
the gmail/outreach pipeline with the loop system, but make NO code changes
and NO fixes between cycles. The LLM predictor/filler is the ONLY source of
intelligence. Record every mishap as an issue; do not repair it. Goal:
measure how the product behaves fully autonomously.

Consequences of the directive:
- The night20 "stay on one job and fix it" rule is suspended — there is
  nothing to fix, so cycles rotate naturally through the queue.
- Issues below are OBSERVATIONS with evidence pointers only (no fix, no
  tests). They are the backlog for a later improvement session.
- Self-healing that the product performs on its own (CDP autolaunch,
  retries, agent fallback) is part of the experiment and gets recorded as
  pass/fail, not intervened in.

## Preflight

- All capability flags armed in `.env` (verified 2026-09-05): FORM_FILL,
  SUBMIT, AUTOMATION, NAVIGATION, GMAIL_DRAFTS, EMAIL_GENERATION,
  GMAIL_VERIFICATION, SCREENER_LLM_MATCH, SCREENER_PREDICT_LLM,
  ESSAY_DRAFT, ESSAY_AUTOFILL, MATERIALS_DOWNLOAD, ATS_DISCOVERY,
  CDP_AUTOLAUNCH, ARTIFACT_AUTOPUSH, AGENT_FALLBACK; DRY_RUN=false.
- Real attach probe (`private/tmp-cdp-attach-probe.ts`): ECONNREFUSED
  127.0.0.1:9222 in 73 ms — debug Chrome is NOT running at session start.
  CDP_AUTOLAUNCH_ENABLED=true, so cycle 1 doubles as the test of the
  product's own launch path. (Different failure mode than 09-04's wedge:
  tonight the port is simply closed, not lying.)

## Cycles
