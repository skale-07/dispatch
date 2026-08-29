# Overnight session issues — 2026-08-28 (3-hour run, ~20:52–23:52)

Operator directive: focus one job at a time to submission; per-job deadline
4–5 min discovery→submit; every unsuccessful submit gets logged here; recurring
patterns get a "progressive overload" sandbox test one level above the failure.

## Issue log

### 1. Generic ATS resume upload does not verify (FAILED_BEFORE_CLICK)
- **When:** 2026-08-29T00:50Z, session run f5576ceb (pre-restart cycle)
- **App:** 66f54fef-43d2-43b7-8f7e-98e8bf951461 → `FAILED_RETRYABLE`
- **Evidence:** `Upload: resume — kind: upload_failed — input files: []; stillAttached=true; chip=false; planned resume-648f06d1.pdf`.
  Fill verified 7 text fields, then submit gate correctly refused to click
  because the upload never landed in the input.
- **Read:** the generic adapter sets the file on an `<input type=file>` that the
  page either clears or replaces with a custom widget (chip=false suggests a
  dropzone UI that needs a real file-chooser event, not setInputFiles on a
  hidden input).
- **Status:** watching for recurrence in the new session → sandbox candidate
  (higher-level test: dropzone-style upload fixture, not just plain input).

## Session notes
- 20:50 stopped prior cycle mid-session (8 apps started, 10 submits left) to
  swap in updated resume (jake_swe.pdf) per operator; relaunched with 3-hour caps.
