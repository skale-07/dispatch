# Overnight issues — 2026-09-04 (night24, applier + gmail pipeline)

Continues numbering from 2026-09-03 (#165 last — the Greenhouse
artifact-per-run fix). Session log:
`artifacts/console/auto-cycle-2026-09-04-night24.log`.

Operator directive this session: full control of every env flag, run
autonomously — fill applications and run the gmail/outreach pipeline.

## Preflight

- All capability flags armed in `.env` (FORM_FILL, SUBMIT, AUTOMATION,
  NAVIGATION, GMAIL_DRAFTS, EMAIL_GENERATION, GMAIL_VERIFICATION,
  SCREENER_PREDICT_LLM, ESSAY_AUTOFILL, MATERIALS_DOWNLOAD,
  ATS_DISCOVERY, CDP_AUTOLAUNCH, ARTIFACT_AUTOPUSH; DRY_RUN=false,
  SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false).
- **Debug Chrome was WEDGED at session start** — the documented night18
  trap, reproduced exactly: `/json/version` answered in ms (Chrome
  152.0.7977.66, 4 pages: 3× Gmail + jobright) while
  `chromium.connectOverCDP` timed out at BOTH 30s and 120s. The HTTP
  probe lies; only a real attach tells the truth. `probeCdpAttach` +
  `restartCdpChrome` already exist for this and CDP_AUTOLAUNCH_ENABLED
  is on, so the cycle preflight is expected to repair it itself —
  cycle 1 is the test of that.
- Queue at start: 7 QUEUED, 25 NATIVE_AUTOFILL_RUNNING (parked mid-fill),
  26 FAILED_RETRYABLE, 60 AMBIGUOUS_FIELD, 173 FAILED_FINAL,
  16 COMPLETED, 1 SUBMITTED.

## Cycles

