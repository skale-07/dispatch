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

### Cycle 2 (15:24Z) — app b32a3624 (ByteDance), login wall before submit

- Resume fix verified: no materials park this cycle; pipeline ran
  QUEUED → ... → NATIVE_AUTOFILL_RUNNING → READY_TO_SUBMIT ("verified
  (generic live fill: 1 filled (held for submit))"). LLM filler leg PASSED.
- Issue #167 (observation): submit run FAILED_BEFORE_CLICK — identity gate
  UNTRUSTED_FINAL_HOST, navigation ended on
  `https://jobs.bytedance.com/en/login?redirect_path=%2Fposition%2Fapplication`.
  ByteDance requires a portal account/sign-in before its application form;
  fully-autonomous flow has no credential/registration path for this
  tenant, so the app parks FAILED_RETRYABLE (attempt 2). The gate refusing
  to click on a login host is CORRECT fail-closed behavior. Class:
  "auth-walled portal, no account" — same family as the Workday sign-in
  walls of nights 20–22.
- submits_used 0, outreach null (correct).

### Cycle 3 (15:27Z) — app eac348f8, duplicate employer URL

- Materials fix holding: MATERIALS_GENERATING → RESUME_DOWNLOADED
  ("verified resume material found") in <1s.
- Issue #168 (observation): APPLICATION_OPENING refused — "navigation
  refused: duplicate employer URL" → FAILED_RETRYABLE. Another application
  row already owns this employer URL, and the nav guard (correctly)
  refuses a second visit. Autonomy gap: discovery enqueued a duplicate and
  the picker still spent a full cycle slot on it; nothing dedupes QUEUED
  rows against already-owned URLs at plan/pick time.
- submits_used 0, outreach null (correct).

### Cycle 4 (15:29Z) — app dc907d8d, duplicate employer URL again

- Recurrence of #168, second consecutive: "navigation refused: duplicate
  employer URL" → FAILED_RETRYABLE at APPLICATION_OPENING. The QUEUED
  backlog evidently holds a run of duplicate rows; autonomous operation
  burns one full cycle (~35s incl. discovery + nav audit) per dup.
- Queue snapshot after cycle 4 (`npm run report`): 5 QUEUED,
  28 FAILED_RETRYABLE, 60 AMBIGUOUS_FIELD, 25 NATIVE_AUTOFILL_RUNNING,
  3 APPLICATION_OPENING, 1 AUTH_REQUIRED, 2 CAPTCHA_REQUIRED,
  173 FAILED_FINAL, 16 COMPLETED.

### Cycle 5 (15:31Z) — app 18a31cd4, posting closed

- APPLICATION_OPENING → FILTERED_OUT (terminal): "posting closed on
  JobRight". Correct handling, no mishap. Autonomy note: queue staleness —
  jobs enqueued earlier can close before the agent reaches them; the
  pipeline detects it cleanly and spends ~20s on the row.
