# Overnight session issues — 2026-08-30 (open-ended run, until operator stop)

Operator directive (this session): run auto:cycle continuously until told to
stop; focus one job at a time to submission; per-job deadline 4:30 min
discovery→submit — if slower, stop and diagnose; every unsuccessful submit
logged here; recurring patterns get a "progressive overload" sandbox test one
level above the failure. Push notification only for urgent items.

Pre-flight state (10:05 local):
- Debug Chrome CDP at 9222: attaches cleanly (2 Playwright connects verified).
  Profile signed into BOTH JobRight (feed authenticated) and Gmail
  (skale072007@gmail.com) — issue #33's operator gap is CLOSED; emailed-code
  recovery can now read the inbox (TransMarket/Appian/Figma Greenhouse codes
  already visible there).
- Queue: 12 QUEUED, 34 APPLICATION_OPENING, 18 NATIVE_AUTOFILL_RUNNING,
  36 AMBIGUOUS_FIELD, 6 FAILED_RETRYABLE, 4 SUBMISSION_VERIFICATION_FAILED,
  111 FAILED_FINAL, 1 COMPLETED. Flags: form_fill+submit on, dry_run off.
- night17 (ended 00:25 local) died on #13: CDP "port answers, attach times
  out" mid-session — took out every later app. Currently healthy; watching
  for recurrence (if it recurs mid-run, that's the next progressive-overload
  target: attach-retry/relaunch seam instead of per-app hard failure).

Carried over (still open): #19 Cloudflare conditional forms, #21 checkbox
kind-mismatch coercion (progressive-overload fixture still owed), #25b
samsara react-select Yes/No combobox filter misses, #28 cover-letter
generation gap (Xaira), #29 nav-audit duplicate detector counts terminal
rows (needs per-cycle MANUAL dismissal until fixed), #33 now closed.

## Issue log

_(Night19 supervisor picked up at 10:25 local; the night18 session above had
logged only its pre-flight before dying.)_

### 34. ROOT CAUSE of #13 (recurring CDP "port answers but attach times out") — the in-session restart was theatre — FIXED
- **Evidence:** night18 log: 3× "CDP restart n/3: debug Chrome relaunched and
  reachable — continuing session", then 40+ consecutive apps died on the same
  attach timeout. At supervisor start the same Chrome (PID 17032, started
  09:51) was still wedged: `/json/version` answered, Playwright
  `connectOverCDP` timed out at 15s. `where wmic` → not found: Windows 11
  build 26200 has REMOVED wmic, so `killDebugChrome` silently did nothing,
  the "relaunch" was absorbed by the running instance (Chrome single-instance
  handoff), and the HTTP-only readiness probe reported success against the
  same dead process.
- **Fix (src/automation/cdpChrome.ts):** PID discovery via PowerShell CIM
  (`listDebugChromePids`, debug-profile dir match only), `taskkill /F /PID`,
  bounded post-kill liveness poll that REFUSES to relaunch over survivors
  ("relaunch would be absorbed"), and a real `probeCdpAttach` (connectOverCDP
  + detach) that demotes "reachable" when only the port answers.
  **Worker:** new stop reason `cdp_unrecoverable` — a failed restart or a
  recurrence after the 3-restart cap stops the session and leaves the queue
  for the next cycle instead of failing every remaining app (each of those
  would otherwise have been a burned attempt toward FAILED_FINAL).
- **Live verification:** running the new `restartCdpChrome` against the
  wedged Chrome killed 10 PIDs, relaunched, and the attach probe passed in
  8.5s → LIVE_MUTATION_CONFIRMED for the restart seam (infra mutation only).
  5 fixture tests (absorbed-relaunch refusal, attach-fail demotion, worker
  stop on failed restart, stop after cap, existing flag-off refusal).
- **Also shipped:** `auto:cycle --app-deadline <sec>` — per-job wall-clock
  budget enforced at pipeline step boundaries via the cooperative skip seam
  (operator directive: 3 min/job, then diagnose). Session note
  `deadline <id>: Ns > Ms budget — stopped in <STATE>`.
