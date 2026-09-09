# Session issues — 2026-09-09 (day28, autonomous 8h run)

Operator ask (10:16 EDT / 14:16 UTC): run the iterative apply loop for 8 hours,
≥20 applications; deterministic fill first, agent only for missing fields /
walls; stay ATS-general (no per-application overfitting); refresh the queue
every hour with the freshest postings; nothing older than 24h (#199).
Issue numbering continues from night27 (#199).

## Session start state (14:16 UTC)

- Uncommitted night27 work (#198 Workday header menu, #199 24h policy,
  fieldDiscovery/congruence/runNavigation changes, +423/-42 in src+docs).
  Typecheck passes. Last night's full gate: 1727/1730, the 3 failures all in
  `tests/unit/auto-cycle.test.ts` under a vitest worker RPC timeout at
  1908s total — load artifact pattern; re-running that file in isolation
  before committing.
- Queue: 11 QUEUED (7 fresh JobRight rows enqueued 14:21 UTC by an
  accidental `discover` invocation — the CLI has no `--help`, it ran a real
  discovery pass: CACI, Two Sigma, Red Hat, SWIVEL, DRW, ByteDance, Leidos;
  IBM ×3 + Databricks from 09-08 are >24h and will be abandoned at pick).
  Zero submits in the last 24h.
- Debug Chrome on 9222 is up (CDP_AUTOLAUNCH). Free RAM 1.8 GB.

## Issue #200 — ANTHROPIC_API_KEY invalid (401) since 14:24 UTC

Evidence: `artifacts/llm/calls-2026-09-09.jsonl` lines 14–17 — four essay
calls, `401 authentication_error "API key is invalid"`; a direct
`GET /v1/models` with the key from `.env` returns the same. The key worked
at 02:52 UTC (last successful call). `.env` unchanged since 09-06, so the
key was revoked/disabled server-side. OpenAI key verified working.

Action (14:30 UTC): appended `LLM_PROVIDER=openai` to `.env` so the run
could continue. Operator said "hold on no stop dont use openai" at 14:36
UTC — override REVERTED the same minute (`.env` back to no LLM_PROVIDER
line). Until the Anthropic key is replaced every LLM surface (nav
supervisor, triage, screener classify/map/predict, essay) fails 401 and
skips with that reason; deterministic paths are unaffected. Waiting on the
operator for the key before starting live cycles.

## LLM token profile before this session (ledger)

| day | nav supervisor | triage | screener (classify+map+predict) | essay |
|---|---|---|---|---|
| 09-06 | 29 calls, 409k in | 36 calls, 109k in | 7 calls, 3.5k in (+9k cache) | 5 calls, 1.2k in (+35k cache) |
| 09-08 | 56 calls, 500k in, 0 cache | 7 calls, 17k in | 20 calls, 11k in (+71k cache) | 28 calls, 3.5k in (+203k cache) |
| 09-09 (to 02:52) | 7 calls, 128k in, 4.8k cache | 3 calls, 7.6k | 3 calls | — |

The nav supervisor is ~85% of input tokens and reads 0% from cache
(every call 9k–39k fresh input). That is the surface to make more
deterministic / cache-shaped. Applier surfaces (screener/essay) are
small and cache well. Tracked as #201 below once evidence from today's
runs is in.

## Loop start (14:40 UTC) — `private/loop-day28.sh 8`

Serial `auto:cycle --backlog --max-apps 1 --max-submits 1 --app-deadline 300
--headed`; queue refreshed hourly (JobRight `discover --max-jobs 12` + boards
registry `--limit 6`), early refresh when the queue drains. Per-cycle
summary lines: `artifacts/console/day28-status.jsonl`; full log
`artifacts/console/auto-cycle-2026-09-09-day28.log`. Board sweeps now obey
the 24h gate (commit eb59af63, board `updated_at`/`publishedAt`).

Refresh 1 (14:40): JobRight 8 inspected / 4 eligible; boards sweep enqueued
Verkada rows (Greenhouse).

## Job #1 — Verkada (790a631f, Greenhouse job-boards, board-discovered) — SUBMITTED_VERIFIED

Cycle 1, 14:41→14:43 (2.5 min). 16-field plan (identity, address, phone,
grad month/year, LinkedIn, 1 predicted screener, relocation/availability,
EEO from the encrypted profile); resume chip verified before fill; submit
receipt `submission/receipt-attempt-1.png`. No agent leg, no nav model
call (direct employer URL). LIVE_MUTATION_CONFIRMED by the submit run's
own read-back. No outreach tail (board-sourced, #181).

## Jobs #2, #3 — Verkada Security SWE Intern (fc57b59b) and Mobile SWE Intern (ec74699c) — SUBMITTED_VERIFIED

Cycles 2 and 3 (14:44→14:47, 14:48→14:51), same board, same shape as
Job #1; all three Greenhouse job-boards fills were deterministic end to
end (no agent leg, no nav model). Gmail tail on each: "no JobRight job
id" (board-sourced) — see #202.

## Issue #202 — Gmail tail must ALWAYS run after a submit, in parallel (operator 14:49/14:54 UTC)

- Before: the worker ran `runPostSubmitGmail` inline after each submit
  (blocking the next pick), and board-sourced rows failed it with "no
  JobRight job id" → a MANUAL review item per submit.
- Change (commit pending): `src/outreach/outreachWorker.ts` — pending =
  VERIFIED submissions newer than `--since` whose
  `versions_json.gmail_tail` is not done; `runOutreachWorkerPass` runs the
  same tail and records attempts/ok/done/drafted/error (3-attempt cap;
  "no JobRight job id" is terminal at once). CLI `outreach:worker
  [--loop --duration --interval]`; `auto:cycle --defer-gmail` skips the
  inline tail. Tests `tests/unit/outreach-worker.test.ts` (4).
- Loop switched to `private/loop-day28b.sh` at 14:57 UTC (old shell
  stopped; its in-flight cycle 4 left to finish; day28b waits for it,
  then starts `outreach:worker --loop --since 2` alongside).
- Open: board-sourced submits still have no JobRight job to read insider
  contacts from. Probing whether JobRight has a search page that can find
  the twin posting (read-only, `private/tmp-jobright-search-probe.ts`).

## Jobs #4–#6 — Verkada Frontend (67b46321), Embedded (7066cacd), Backend (79185ac4) — SUBMITTED_VERIFIED

67b46321 submitted 14:58 in cycle 4 but the uplink dropped mid-tail (see
#203): the row is still in state SUBMITTED (VERIFIED submission row, receipt
png present); the outreach worker already marked its tail terminal, so
nothing else touches it. 7066cacd (cycle 17, 15:16→15:20) and 79185ac4
(cycle 18, 15:21→15:26) went end to end deterministically once the link
was back — same 19-field Greenhouse job-boards shape as Jobs #1–#3.

## Issue #203 — uplink outage burned one queued app per cycle (15:00–15:15 UTC)

Evidence: cycles 4–16 (13 cycles, ~55s each) every `app_begin` ends in
`pipeline_error: page.goto: net::ERR_INTERNET_DISCONNECTED` (jobright.ai
or job-boards.greenhouse.io) and the artifact autopush logged "Could not
resolve host: github.com". Nothing wrong with any page or adapter — the
box had no internet. Each cycle picked the NEXT queued row (seen-set is
per session, max-apps 1), so 13 rows were touched (left in
APPLICATION_OPENING/INSPECTION at attempt 1 — recoverable, and the
backlog picker re-picks those states, which is how cycle 17 resumed
7066cacd). The Claude session driving the loop lost its remote too
("Can't reach teddy"); the bash loop and both worker processes survived.

Fix (this session): `src/automation/connectivity.ts` —
`isNetworkOutageError` (Chromium/Node transport codes only, never a site
error) + `waitForConnectivity` (bounded: 8 probes × 15s, first probe
immediate). Worker: preflight probe before discovery/first pick →
`stopped_reason: network_unreachable`, zero apps touched; on a transport
error mid-session the same wait runs and the session stops if the link
does not return (queue untouched), or continues with a note if it does.
Seam `connectivityProbe` for tests; the three worker test files mock the
wait so no unit test touches the network. Tests: `connectivity.test.ts`
(4) + 3 worker cases (preflight, mid-session stop, transient continue).
Typecheck ok; `automation-worker.test.ts` 17/17 (one Gmail-ordering test
timed out twice under live-loop load and passed alone in 16s — load
artifact, same pattern as the memory note). UNIT/FIXTURE_CONFIRMED; the
live behaviour under a real outage is UNVERIFIED until the next one.

## Job #7 — Revel Full Stack intern (a3221a28, JobRight-sourced) — SUBMITTED_VERIFIED

Cycle 20 (15:29→15:33). First JobRight-sourced submit of the day, so the
first one the outreach worker can actually draft for. Essay autofill
abstained on "How did you hear about us?" (asked 1, answered 0) — the
free-text how_heard is an essay-tier question here; noted, not blocking.

## Issue #204 — referral field mapped to the candidate's own email (live cisco e56b7e7a, Phenom)

Cycle 19: generic adapter on careers.cisco.com, 9 filled, verification
failed on `referredBy` ("What's their name or email address?") — canonical
`email`, expected the operator's address, page shows empty (the control is
hidden until "Were you referred?" = Yes). The alias phrase "email address"
claimed a third-person question. Fix: `matchCanonicalFieldInner` returns
null for free-text controls whose label is third-person ("their") or
referred-by phrasing, or whose name/id says referr(ed|er); selects such as
"Referral source" keep their alias mapping. ATS-general — no Cisco-specific
selector. Cisco requeued after the fix.

## Job #8 — Sequence Holdings SWE intern (4858a87e, JobRight-sourced) — SUBMITTED_VERIFIED

Cycle 22 (15:36→15:38). Outreach tail ran within the minute: insider
triage checked 0 people (as for Revel) — the JobRight page lists no
insiders for either small company; generated/drafted 0, ok. The first
large JobRight-sourced submit (Cisco/CACI/Red Hat/Leidos) is the real
test of contact extraction; if that also reads 0 people, treat it as a
DOM change (#186-class), not "no contacts".

## Issue #205 — a page dialog killed the cycle process (cisco, cycle 24, 15:41 UTC)

Evidence: `ProtocolError: Protocol error (Page.handleJavaScriptDialog):
No dialog is showing` thrown from Playwright's own `DialogManager.
dialogDidOpen` → unhandled rejection → `node:internal/process/promises
triggerUncaughtException` → cycle 24 exit 1 mid-`NATIVE_AUTOFILL_RUNNING`.
No code in src registered a `dialog` listener, so Playwright auto-
dismissed and its dismiss raced a dialog the page had already closed
(CDP-attached Chrome). Side effects: the app stayed in
NATIVE_AUTOFILL_RUNNING (pickable — fine), the loop's status line
re-summarised cycle 23's report (no report was written), and the arm row
96f53ac8 stayed RUNNING — see #206.

Fix: `src/browser/dialogGuard.ts` `attachDialogGuard(context, service)`
— a context-level listener (turns Playwright's auto-dismiss off), logs
type+message, dismisses with the rejection swallowed; attached by every
browser seam (`PlaywrightServiceSession.open`, `openPublicUrlSession` both
paths, `withFixtureHtmlPage`) and detached on close so the operator's
Chrome is left as found. Last line: `src/cli/processGuards.ts`
`installProcessGuards()` from CLI `main()` only — an unhandled rejection
is logged (`cli/unhandled_rejection`, stack) and the process survives;
never installed from library code or tests. Tests: `dialog-guard.test.ts`
(fake-context race UNIT_CONFIRMED; real fixture page confirm/alert
FIXTURE_CONFIRMED).

## Issue #206 — crashed cycle's arm blocked the loop ("already armed", 118 min left)

Cycle 25 (15:42): `skipped_already_armed` — arm 96f53ac8 from the crashed
cycle 24 was still RUNNING with a heartbeat 2 min old; the sweep only
fires after 15 min of heartbeat silence and the heartbeat ticks once per
application, so a mid-fill crash looks like a long fill. The bash loop
read apps=0 as "queue drained" and would have retried every 300s until
~15:58. Manual: `private/tmp-disarm-stale-arm.ts 96f53ac8` (id-guarded)
at 15:47 UTC.

Fix: arm metadata records `worker_pid` (auto:cycle passes its own PID);
`sweepAbandonedArmSessions` completes an arm whose PID is dead at once
(`reason: worker_pid_dead`, never its own PID, `process.kill(pid, 0)` with
EPERM = alive), and keeps the heartbeat rule for rows without a PID
(console-armed). Tests: 3 new cases in `automation-arm.test.ts`. The
auto-cycle test file was NOT run (it writes real cycle artifacts while
the loop runs — see the note below); it is due at the next solo gate.

## 15:50→18:50 UTC — zero submits: queue drained, feed static, boards exhausted

Cycles 27–46: the JobRight recommend feed showed the same 8 cards on
every refresh (15:53, 18:40 — "inspected 8, eligible 4, reused 4"), the
15-board registry filtered out everything fresh, and the loop ground the
parked walls: S&P Global Workday (how_heard combobox not committed),
Peraton jibeapply NAVIGATION_INCOMPLETE ×4, CACI POSTING_MISMATCH ×3,
EOSYS (state select + skills picker empty), Equipment & Controls
paylocity verify mismatch, Cisco (1 required question unanswered),
Palantir (name pronunciation + conditional dates). Also #208 below.

## Issue #207 — Gmail tail for board-sourced submits via a company twin (operator 18:51 UTC)

"For submitted apps run the gmail generation to company employees."
All 7 Verkada submits were board-sourced (no JobRight job id) and the
tail ended terminal. JobRight's insider list is per COMPANY, and the DB
already held a JobRight Verkada posting (6a8ddb11). Fix:
`getStoredJobInspectionTargetByApplicationId` resolves the newest stored
JobRight job of the same company (exact name, case/space-insensitive —
`findCompanyTwinJob`) when the app's own job has none; `hasJobRightJobId`
agrees. Tails re-opened (`private/tmp-reopen-gmail-tails.ts`, 7 rows),
outreach worker restarted on the new code at 18:55.
Result (LIVE_MUTATION_CONFIRMED by the worker's own read-back): 79185ac4
→ 7 people checked, 3 emails found, 3 Gmail drafts DRAFTED; 7066cacd →
7 people, 4 emails, drafting. First re-opened tail (2e956d3f, 18:56) still
read 0 people — the insider panels sit behind "View" expanders and the
first pass after a fresh session tagged nothing; later passes expanded
fine. Revel/Sequence 0 people = genuinely no insiders listed.

## Issue #208 — cycle 39 held for 1h54m after its session ended

`session_end` 16:46:07, process exit 18:40:24; report notes empty, so the
time went before the report persisted — the only unbounded await on that
path is `dropNavSession` → `serviceSession.close()` (CDP disconnect) in
the session's finally. Fix: the close is raced against a 20s timer
(`NAV_SESSION_CLOSE_TIMEOUT_MS`). UNVERIFIED against a real wedge until it
recurs; every other await on that path is already bounded.

## Issue #209 — board discovery: one board took all 12 slots, 9 of them finance/ops

New registry of 42 candidate boards (private/discovery/boards-day28-
candidates.json): 31 resolve (Coinbase, Robinhood, Airbnb, DoorDash, Lyft,
Pinterest, Dropbox, Discord, Brex, Affirm, Gusto, Instacart, Asana,
Duolingo, MongoDB, Elastic, Okta, Twilio, Flexport, Nuro, Roblox, Reddit,
Datadog, Waymo, Vercel, Linear, Replit, Cohere, Perplexity, Cursor,
Sierra, Palantir/lever); 404: plaid, hashicorp, rippling,
appliedintuition, deepmind, cruise, snapchat, nvidia; anduril aborted.
First sweep enqueued 12 — all Coinbase, and `include: ["intern"]` let
Accounting / Business Controller / Credit Risk / Crypto Inventory Ops /
Employee Experience / Finance Ops / FP&A / Internal Audit / Accelerations
Programs through; the loop had already picked Internal Audit (cycle 47).
Those 9 were abandoned through the state machine (reason names the
policy); Analytics Engineer / Data Engineer / Data Science kept.
Fix: registry-wide `role_terms` (title must contain one — software,
engineer, developer, data, machine learning, ml, ai, research, analytics,
platform, infrastructure, security, full stack, frontend, backend, mobile,
embedded, systems, devops, cloud, quant) ANDed after include/exclude, and
`max_new_per_board` (per-board cap; #180 was the same failure with
Stripe). CLI `--role-terms` / `--per-board` override.

## Note — never run `tests/unit/auto-cycle.test.ts` while the loop runs

It writes real `artifacts/console/auto-cycle/cycle-*.json` files
(14:51:49–14:53:18, nine of them: refused/error/queue_drained) — the loop's
status line for cycle 3 summarized a TEST report instead of the real one
(the real cycle 3 was ec74699c → COMPLETED). Gate that file between runs
only, as the memory note already says for the suite.
