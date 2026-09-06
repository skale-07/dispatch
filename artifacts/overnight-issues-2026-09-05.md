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

### Cycle 6 (15:33Z) — app 98784229 (Bennett Thrasher), duplicate refusal explained

- Third "duplicate employer URL" park, but the nav report
  (`artifacts/navigation/nav-5cd430a9-.../report.json`) shows what the
  dup class actually is:
- Issue #169 (observation, supersedes the #168 "queue dedupe" framing):
  Apply-click resolution collision across DIFFERENT companies. The job is
  at "Bennett Thrasher"; its Apply click resolved to
  `btcpa.rec.pro.ukg.net` (UKG tenant "btcpa"), which is ALREADY held by
  app 4e47f9ae — "Barbacane, Thornton & Company, IT Intern - AI &
  Automation" (AMBIGUOUS_FIELD). Two distinct CPA firms cannot both own
  tenant "btcpa"; at least one Apply click resolved to the WRONG
  company's portal (likely both are "BT CPA"-named firms and JobRight's
  interstitial routed one of them wrong). The congruence checker even
  flagged it ("URL names 'btcpa', which shares nothing with company
  'Bennett Thrasher' — recorded, not refused"); only the dup guard
  stopped it. Fail-closed worked — an autonomous submit to the wrong
  company's portal was prevented — but the detection fired for the wrong
  stated reason, and the row parks FAILED_RETRYABLE where a retry would
  hit the identical wall (retry loop trap). Cycles 3/4 dup refusals are
  plausibly this same collision class; their nav reports are on disk for
  the later fix session.

### Cycle 7 (15:35Z) — app e16379c4, upload wall at submit gate

- Best pipeline depth so far: portal-auth path taken ("needs_login —
  proceeding to fill"), generic live fill verified 5 fields, submit
  attempted with page reuse.
- Issue #170 (observation): submit refused FAILED_BEFORE_CLICK — operator
  brief `upload:resume`: "no file input resolved ... 0 file inputs on
  page" while 5/6 items were OK. The page's resume upload is not a
  standard `<input type=file>` (likely custom drag-drop or a
  dialog-opening button), so `adapter.uploadResume` had nothing to
  attach to; gate correctly refused the click. → FAILED_RETRYABLE.
  Evidence: artifacts/applications/e16379c4-.../submission/ (attempt 2).

## Directive change (15:40Z, operator /goal)

Observation-only is LIFTED. New mode: every 6 cycles, run a repair phase —
fix recorded issues, restart the failed apps (each restart counts as a
cycle; fewer than 6 failures ⇒ top up with fresh apps). Gmail pipeline
must run post-submit (automatic tail; verify). Separate Sonnet subagent
launched for outreach drafts on Scale AI / Garner Health / Juicebox
(applied manually on JobRight; report at
artifacts/gmail-pipeline-2026-09-05.md).

## Repair phase 1 (after cycles 1–6; cycle 7 was in flight and counts
toward window 2)

- Issue #171 (ROOT CAUSE of the #168 dup refusals, found during repair):
  `findApplicationsWithEmployerUrl` and the nav audit stripped the ENTIRE
  query string before comparing employer URLs. On Brassring-class hosts
  the job identity lives in the query (`?...&jobid=907868` —
  sjobs.brassring.com), so all three MicroVention roles collapsed to one
  "URL" and sibling roles parked as duplicates of each other. FIX
  (committed this phase): `normalizeEmployerUrlForDedupe` in
  `src/navigation/congruence.ts` — keep the query, drop only fragment +
  tracking/session params, sort params; used by both the dup guard and
  `auditEmployerUrls`. Regression test pinned on the real MicroVention
  URLs in `tests/unit/nav-congruence.test.ts` (45/45, UNIT_CONFIRMED).
- Issue #170 FIX: `uploadResumeViaFileChooser` in
  `src/ats/shared/uploadResolve.ts` — when a form has NO
  `<input type=file>` at all, click an upload-looking control (hard cap 3
  candidates) under a `filechooser` listener and deliver the file through
  the chooser; wired into the generic adapter only. Two fixture tests
  (12/12 in submit-resolve-upload.test.ts, FIXTURE_CONFIRMED).
- #169 resolution: 98784229 (Bennett Thrasher) abandoned to FAILED_FINAL
  via the state machine — JobRight attributes the same btcpa UKG job to
  two companies; 4e47f9ae (Barbacane Thornton) owns the real posting.
- Restarts (each counts as a cycle): b32a3624 (ByteDance, session
  experiment), eac348f8 + dc907d8d (MicroVention, now unblocked by #171
  fix), e16379c4 (SJHL, now has the #170 filechooser fallback) — all
  requeued at attempt 3. 18a31cd4 is terminal (posting closed), not
  restartable. 4 restarts + cycle 7 = 5; window 2 tops up with 1 fresh
  app for 6.

## Gmail pipeline on manually-applied jobs (Sonnet subagent, 16:00Z)

Report: artifacts/gmail-pipeline-2026-09-05.md; applied-page screenshot:
artifacts/gmail-pipeline-applied-page.png. Drafts only, zero sends.

- Scale AI "Software Engineering Intern (Summer 2027)" (app 76090f6b):
  5 insider contacts → 5 validated emails → 5 Gmail drafts ("Hopkins
  sophomore interested in Scale AI SWE internship"). 1 of 5 confirmed by
  Drafts-search read-back; 4 composed but read-back-unverified (honest
  level: not fully LIVE_MUTATION_CONFIRMED).
- Juicebox "Software Engineer Intern" (app 68882294): 0 insider contacts
  on the panels → legitimately 0 drafts. One transient CDP-attach failure
  from debug-Chrome contention with the applying loop; retry clean.
- Garner Health "Software Engineering Intern" (app f40d9047): 1 alum
  contact but no discoverable email → 0 drafts.
- Gap G1 (subagent): the operator's applied Scale AI posting is NOT the
  DB's old "AI Builder Intern" FAILED_FINAL row — different job. Old row
  and its 08-25 drafts left untouched.

## Window 2 cycles

### Cycle 8 (15:54Z) — b32a3624 ByteDance restart: same wall, as predicted

- Identical outcome to cycle 2 at attempt 3: fill verified (1 field),
  submit refused UNTRUSTED_FINAL_HOST on jobs.bytedance.com/en/login.
  No established session to ride (unlike the TIAA Workday class). Confirms
  #167 is a hard "auth-walled portal, no account" blocker — blind retry
  can never clear it. Decision: leave FAILED_RETRYABLE but do NOT requeue
  in future repair phases until an account/session strategy exists
  (FAILED_RETRYABLE → AUTH_REQUIRED is not a legal transition, checked).
  Also evidence for the triage thesis: a deterministic retry re-ran the
  whole pipeline to hit a wall the artifacts already predicted.

### Cycle 9 (15:58Z) — e16379c4 SJHL restart: new failure surface (progress)

- With the #170 filechooser fallback in the tree, the run no longer dies
  at the submit upload wall; it now stops earlier at fill verification:
  NATIVE_AUTOFILL_RUNNING → AMBIGUOUS_FIELD ("verification failed").
  Different signature than cycle 7 — the wall moved, which is what a real
  fix looks like; the residual verify mismatch is the next thing the
  triage layer should be deciding on. Operator paused the loop here to
  plan the LLM decision layer (plan approved: triage subsystem M1–M7).

## LLM decision layer implementation (post-plan)

- Commits: `8e82d3a3` (#170), `8517c81f` (#171), `11ce8884` (M2 triage
  subsystem: enumerated actions, verbatim validation, retry-differently
  memory, acting requeue class, flags/CLI/knowledge-graph; 13/13 tests).
- M1 (nav give-up evidence): `src/navigation/wallEvidence.ts` — scrubbed
  HTML + screenshot at every wall park, captured inside async `persist()`
  (single choke point), `evidence[]` on the nav report. 2/2 new tests;
  45/45 across all navigation suites with the async change.
- M3 (worker wiring): session-start `verifyTriageOutcomes` sweep +
  post-session `runTriageBatch` over triageable end states
  (`triageClient` test seam). End-to-end worker test: duplicate_url park
  → triage decides requeue_same → validated → executed → app QUEUED,
  decision row `mode=act, executed=1` (13/13 in automation-worker).
- Operator guide updated (triage section). Full-suite note: rotating
  browser-heavy failures under load are artifacts; every failed file
  re-verified green in isolation before each commit; the one unhandled
  vitest error is its own worker-RPC timeout, not app code.
- M4 partial + M6 + M7 (2026-09-06): `engage_agent_leg` one-shot
  hostPolicy override consumed in runNavigation (decision row is the
  marker); `anchorLlmAdjudicate` promotes ONE harvested candidate when
  both deterministic phases miss (verbatim set membership, downstream
  gates unchanged, method "anchor_llm"); `dupAdjudicate` records
  same-job/different-job evidence on identity-differing duplicate parks.
  `NAV_LLM_ASSIST_ENABLED` wired fail-closed everywhere. 5/5 new tests,
  14/14 triage, 47/47 navigation suites. Abandon-class act promotion
  still gated on the first live sweep running clean.
- Commits: `447c3b0c` (M4/M6/M7), `53d323a8` (package.json aliases).
  Flags armed in `.env`: TRIAGE_LLM, TRIAGE_ACT, NAV_LLM_ASSIST.
- FIRST LIVE SHADOW TRIAGE (LIVE_READ_ONLY_CONFIRMED, 15:44Z 09-06):
  `npm run triage:llm` over 25 real failed apps — every decision
  validated and recorded, zero mutations. Quality signals: ByteDance
  login_wall → park_for_operator (the blind-retry class is dead);
  ADP/UltiPro verify_mismatch → engage_agent_leg; a requeue_same chosen
  on an AMBIGUOUS_FIELD app was demoted by preconditions exactly as
  designed. Sweep: 25 PENDING, awaiting the next session's events.
  NEXT: run an armed session — its post-session batch will act on the
  requeue class; after the sweep runs clean once, flip abandon-class
  into ACT_ENABLED_ACTIONS (plan M4 completion).

## Loop resumed (15:50Z 09-06) — window 2 continues with triage live

- Guard added before resuming: Scale AI / Juicebox / Garner Health rows
  (enqueued by the gmail subagent as outreach targets only) marked
  `automation_excluded` — the operator applied to those manually; the
  loop must never double-apply.
- Restarts in place: eac348f8 + dc907d8d already QUEUED (repair phase 1);
  e16379c4 requeued AMBIGUOUS_FIELD → FIELD_VERIFICATION. ByteDance
  stays parked per the cycle-8 decision. Queue also holds fresh apps
  (Neuralink, Atlassian, 2× Barclays) for top-up.
- Cycles 10+ run with TRIAGE_LLM + TRIAGE_ACT + NAV_LLM_ASSIST armed —
  the "every 6 cycles repair + restart" directive is now mechanized in
  the session itself (post-session triage batch + session-start sweep).

### Cycle 11 (15:53Z 09-06) — 4299f8a0 Atlassian: every new layer fired live

- Navigation: phase A saw `careers-americas.icims.com` (congruence
  unverifiable vs "Atlassian"), phase B found no Apply control, **M6
  anchor adjudication ran live and ABSTAINED** (conservative — the iCIMS
  tenant is plausibly Atlassian's real portal; promotion would likely
  have been right; quality observation, not a defect), agent phase burned
  wall-clock because **the debug Chrome CDP is wedged again** (night18
  trap: port answers, session won't attach) → wall budget →
  FAILED_RETRYABLE.
- **M1 live**: giveup-budget.html + giveup-budget.png captured under the
  nav run dir, listed in report evidence[].
- **FIRST AUTONOMOUS ACTED TRIAGE (LIVE_MUTATION_CONFIRMED)**: post-
  session batch decided `park_for_operator` for signature
  `FAILED_RETRYABLE|budget|budget|-` and EXECUTED it (review item
  4b38df9f). report.triage = {decided:1, executed:1}. Reasonable call —
  requeueing into a wedged CDP would have been the old blind-retry.
- Environment issue to watch: if cycle 12's preflight does not self-
  repair the wedged CDP, run private/tmp-restart-cdp.ts (operator-
  approved repair) before continuing agent-phase apps.

### Cycle 12 (16:00Z 09-06) — 4a97ab57 Barclays Wilmington: triage acts with a second action class

- CDP self-repaired at preflight (cycle 11's wedge gone; session opened
  CDP_ATTACH AUTHENTICATED) — the product's own recovery, no operator.
- Pipeline depth: nav resolved via apply_click_popup, portal-auth fill
  verified 2 fields, submit refused FAILED_BEFORE_CLICK ("field
  verification or upload did not pass") → FAILED_RETRYABLE.
- **Second live acted triage, different action**: signature
  `FAILED_RETRYABLE|-|verify_mismatch|search.jobs.barclays` →
  `engage_agent_leg` EXECUTED (decision 841134a7): app requeued carrying
  the one-shot agent-leg override the next nav run will consume. The
  layer is choosing per-signature, not one-size-fits-all.
- Sweep now tracks 26 pending decisions.

### Cycle 13 (16:02Z 09-06) — 4a97ab57 Barclays rerun: two layer lessons

- The triage-requeued app was picked again; stored URL valid ⇒ NO nav
  run ⇒ the agent-leg override was never consumed. Same submit wall at
  attempt 2 ("field verification or upload did not pass").
- Issue #172 (LAYER DEFECT, FIXED same session — the M5 slot): the
  `engage_agent_leg` precondition didn't require a navigation wall, so
  triage granted it for a submit-stage failure where it cannot help.
  Fix: `canExecute` now demands `navWall` present and != "none"
  (evidence from the bundle's latest nav attempt). Test pinned on this
  exact shape; 28/28 triage+worker.
- Issue #173 (observation): Barclays upload wall is #170-class but
  harder — 0 file inputs AND the filechooser fallback found no
  upload-like control text. Needs a pixels-first diagnosis (form
  snapshot / screenshots) before any new tier; until then the
  retry-differently memory will refute engage_agent_leg for this
  signature next sweep and converge the app to park.
- Window 2 (cycles 8–13) complete: 0 submits; ByteDance parked by
  design, Neuralink closed, Atlassian parked by acted triage, SJHL in
  FIELD_VERIFICATION, Barclays at attempt 2, MicroVention pair still
  QUEUED for window 3.

### Cycle 10 (15:51Z 09-06) — 70aaa82a Neuralink, posting closed

- APPLICATION_OPENING → FILTERED_OUT (terminal): closed on JobRight.
  Correct handling. LIVE CONFIRMATION of the M3 wiring: session notes
  carry "triage sweep: 0 confirmed, 0 refuted, 0 expired of 25 pending"
  (start-of-session read-back ran), and the post-session batch correctly
  skipped a terminal end state.
