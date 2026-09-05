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

### Cycle 1 (15:20Z) — app 99c3eda2, parked at materials

- AUTONOMY PASS: CDP autolaunch started debug Chrome on 9222 by itself
  (session-start probe had ECONNREFUSED). No operator repair needed.
- App 99c3eda2-4b93-49df-bf92-3cda8d634959: QUEUED → MATERIALS_GENERATING,
  stopped "review": "no verified resume material and no default resume to
  auto-attach". submits_used 0, outreach null (correct — no submit).
- Issue #166 (environment, NOT code): `DEFAULT_RESUME_PATH` in `.env` still
  pointed at `private/candidate/resumes/jake_swe.pdf`, but the resumes were
  renamed 2026-09-04 to `swe.pdf` / `ds_ai.pdf`. Preflight WARNED
  ("default_resume: MISSING ... every app with no registered resume will
  park at materials") but the cycle proceeded and burned the job slot
  anyway. Autonomy observation: a fatal preflight warning does not gate the
  session — every subsequent job would have parked identically all night.
  Operator-config remediation applied (allowed under standing env
  authorization; no code touched): `.env` DEFAULT_RESUME_PATH →
  `private/candidate/resumes/swe.pdf`.
- Requeue observation: `npm run retry -- --app 99c3eda2...` refused ("No
  FAILED_RETRYABLE application") — retry only serves FAILED_RETRYABLE, and
  a materials park lands at MATERIALS_GENERATING. No CLI path back to
  QUEUED for this park class (autonomy gap; left as-is). Hygiene pass
  dismissed 27 MANUAL review items.
