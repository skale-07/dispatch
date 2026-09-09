# Overnight issues — 2026-09-08 (night27)

Continues numbering from 2026-09-07 (#193 last). Session log:
`artifacts/console/auto-cycle-2026-09-08-night27.log`. Gate log:
`artifacts/console/gate-2026-09-08-night27.log`.

Operator directive (2026-09-08): keep architecting in loops with one
critical focus — the LLM must be spent where it is efficient. Identify the
issues across filling / navigating / logging in first, then build, then run
the apply loop with the post-submit email drafts.

## Preflight

- Peer session e3 handed off at HEAD 74869b54: not driving CDP 9222 or any
  application row; debug Chrome up with leftover read-only tabs (safe to
  close). Queue drained — every QUEUED row sits behind a MANUAL item (IBMid
  ×3: 907955ca / 3b848e6b / 2f917d89), Oracle cbed2850 AMBIGUOUS_FIELD
  (#188), Astera 72ad2ead uncertain submission, Merck dc734a38 / b1d25281
  FAILED_FINAL (#190). Fresh discovery must repopulate before any cycle.
- Flags verified in `.env` (unchanged from night26): FORM_FILL, SUBMIT,
  AUTOMATION, NAVIGATION, GMAIL_DRAFTS, EMAIL_GENERATION, GMAIL_VERIFICATION,
  SCREENER_LLM_MATCH, SCREENER_PREDICT_LLM, ESSAY_DRAFT, ESSAY_AUTOFILL,
  MATERIALS_DOWNLOAD, ATS_DISCOVERY, CDP_AUTOLAUNCH, ARTIFACT_AUTOPUSH,
  AGENT_FALLBACK, TRIAGE_LLM, TRIAGE_ACT, NAV_LLM_ASSIST all true;
  DRY_RUN=false; ANTHROPIC_LLM_MODEL=claude-opus-5; no NAV_AGENT_MODEL /
  ANTHROPIC_APPLIER_MODEL split set (operator's call, not defaulted).
- Review queue: 84 open (63 AMBIGUOUS_FIELD, 7 UNCERTAIN_SUBMISSION,
  6 MANUAL, 5 UNSUPPORTED_ATS, 2 CAPTCHA_REQUIRED, 1 AUTH_REQUIRED). Age:
  9 ≤1d, 25 4–7d, 50 ≥8d — the AMBIGUOUS_FIELD backlog spans 08-15→09-08 and
  predates #179–#193; not resolved here (operator's call).

## LLM efficiency audit (ledger `artifacts/llm/calls-2026-09-08.jsonl`, 111 calls)

| surface | calls | fresh in-tok | cache read | cache write | thinking | cache hit |
|---|---|---|---|---|---|---|
| navigation supervisor | 56 | 500,474 | 0 | 0 | 8,312 | 0% |
| failure triage | 7 | 16,519 | 0 | 0 | 66 | 0% |
| screener predict | 10 | 6,290 | 71,352 | 17,838 | 0 | 92% |
| screener option-map | 9 | 4,331 | 0 | 0 | 0 | n/a |
| essay generation | 28 | 3,529 | 202,705 | 33,901 | 2,019 | 98% |
| screener classify | 1 | 54 | 0 | 1,014 | 0 | — |

- The applier surfaces already follow the pattern (closed-set choice,
  `effort: "low"`, stable material in cacheable `context[]` blocks). The
  navigation supervisor did not: everything in the `user` turn (nothing
  cacheable), `effort: "high"` hardcoded, a screenshot every step, the
  fast path usable once per run, and the model consulted even when it had
  no real choice. 95% of uncached input tokens for the day.
- Yield: 5 live supervisor runs = 31 Opus calls; 1 of 5 reached a form.
  10 of 31 calls (32%) decided `wait` or `back`. Two msd.wd5 runs (10 and
  9 calls) cycled wait→back→click→wait across two fingerprints — every
  step had a distinct repeat-guard key, so the guard never tripped.
- 3 of 4 `authenticate` steps came back `portal auth: not_an_auth_wall`
  on pages the model had correctly named sign-in gates (IBMid ×2, MSD
  Workday ×1): expensive model insight discarded by a narrow detector.
- Fill recovery has ZERO LLM involvement: `fillHealer` = token-overlap
  heuristic + a deterministic Python `locate_field` (contract.ts:22 "no
  browser, no CDP, no LLM"). 252 queued field failures never met a model.
  Dominant clusters: `control not found on the page` (EEO + Degree Type +
  sponsorship + how-heard missing TOGETHER ⇒ page-phase, not selector) and
  Workday `source--source` combobox option not committed.
- Sidecar (Phase C browser_use/stagehand) LLM spend is invisible to the
  ledger (own SDK in the Python process). Recent agent-run artifacts are
  fixture replays (identical step shapes ×3); all live nav this week was
  the in-process supervisor.

Decision matrix agreed with the operator: the model decides at genuine
navigation forks and may NOMINATE a login wall (code confirms + types);
values stay deterministic (plan) except the two sanctioned free-text paths
(essays, never-seen screeners); the missing surface is field LOCATION when
the locator ladder misses (same closed-set shape as navigation) — deferred
until a live screenshot run says how much of the `control not found`
cluster is unrendered-step vs. mislocated; never submit; never EEO.

## Issue #194 — navigation supervisor cost model (UNIT/FIXTURE_CONFIRMED)

`src/navigation/applicationSupervisor.ts`:

- Model consulted only at a fork. Deterministic, model-free steps:
  - one unambiguous Apply control → click, once per PAGE STATE
    (fingerprint) instead of once per run (`fastPathTried`);
  - no allowed controls and no openable frame → `wait` once; on the same
    state again → `authenticate` when the page classifies as auth, else
    `stop` with the page class in the reason;
  - a page unchanged after a `wait` → one free second wait
    (`freeWaitUsed`), then the model is asked again WITH a no-progress
    note.
- No-progress detector: a fingerprint observed `NO_PROGRESS_LIMIT` (4)
  times ends the run — catches A→B→A→B cycles the action-keyed repeat
  guard cannot.
- Prompt caching: `{job}` (supervisorContext, identical every step of a
  run) moved into `context[]` → `AnthropicLlmClient` attaches
  `cache_control`; system (~550 tok) + job (~1.2K tok) clears the 1,024
  minimum. Observation/history stay in the uncacheable tail.
- Effort `low`; `medium` only when the previous step failed / was refused
  / produced no change. (Was `high` on every step: 8,312 thinking tokens
  billed as output on pick-one-of-N.)
- Evidence line in every report: `model calls: N of M steps`.
- Tests (`tests/unit/application-supervisor.test.ts`, 9): fast path on
  two consecutive page states with the model forbidden; nothing-navigable
  page → wait, stop, no model; stalled `wait` → free retry → medium effort
  + note → stop at 4 observations; existing cases updated (`effort` low,
  job in `context[0]`, not in `user`). Test 1 timed out once at 30s under
  load right after `tsc` (passes alone in 7.0s) — load artifact per the
  box's known behaviour.
- Screenshot-per-step left as is (≈1.5K tok/call; needed on multi-job
  careers sites). Follow-up: send it only when the text observation is
  ambiguous.
- Prediction for tonight's live runs: model calls per supervised app
  drop from 6–10 to ≤4; `cache_read_input_tokens` > 0 on the second and
  later calls of a run; no run ends `budget`/`stopped` after a wait/back
  cycle without a `no progress` reason.

## Issue #195 — portal auth: username-first (identifier-only) walls (FIXTURE_CONFIRMED)

`src/verification/portalAuth.ts` (completes #192; pairs with #191's
IDP-host signal in loginWallDetection):

- Shape: login.ibm.com (IBMid) shows ONE identifier input + Continue; the
  password input renders only after the identifier is accepted.
  `locateAuthFields` read email=true/password=false and the flow answered
  `not_an_auth_wall` — the supervisor then clicked "Create an IBMid" and
  the fill gate refused the registration form (POSTING_MISMATCH), so the
  app requeued into the same wall via triage.
- Fix: `advanceUsernameFirstWall` — guarded to sign-in shapes only
  (login-looking host/path, federated buttons, or a
  continue/next/sign-in submit; a lone email input on a job-alert form
  is untouched) — types the standing username (paced `typeCredential`,
  read-back + one retype), clicks the page's own Continue, waits ≤8s for
  a password input, then the normal sign-in path runs on the completed
  form. If no password step renders, the outcome is `wall_remains` with
  the post-click diagnosis in the note (identifier unknown to the portal
  / further wall) — NOT `not_an_auth_wall` — so the pipeline parks for
  auth instead of re-queuing. Username-only typing does not burn the
  per-host auth budget (`credentialsTyped` stays false until the
  password attempt).
- `typeCredential` hoisted from the sign-in/create attempt so both paths
  type the same way (#102 keystroke pacing).
- Tests (`tests/unit/portal-auth.test.ts`, 25): two-step fixture advances
  and signs in (username + password typed, password in `secrets`, never
  in notes); dead-end identifier → `wall_remains` with the reason; job-
  alerts email input on a non-login path → `not_an_auth_wall`, nothing
  typed.
- Live expectation: IBM apps (907955ca / 3b848e6b / 2f917d89) will now
  reach IBM's "no account" answer and park `wall_remains` — an IBMid
  still has to be created once by the operator (create-account on IBM
  is a full registration form the create path does not cover).

## Gate

- First full gate (`gate-2026-09-08-night27.log`, 18:07–18:24): 46 failed /
  17 files at 1000s — double the solo duration — with five Codex
  computer-use node processes resident and a vitest worker `onTaskUpdate`
  timeout. Load artifact per the box's known behaviour, not counter-
  evidence: `application-supervisor` (9/9) and `portal-auth` (24/25) pass
  in isolation afterwards.
- The one isolated miss, `#136 Auth0 signup route`, is `Hook timed out in
  10000ms` and reproduces byte-for-byte on HEAD with `portalAuth.ts`
  stashed (`vitest -t "#136"`) — pre-existing, filter-run only, not #195.
- Portal-auth code/test labels renumbered #194 → #195 to match this log.
- Second gate (`-b.log`, 21:44) aborted at 8 min: 12/176 files, all
  failures 60s timeouts, box at 187 MB free / 13K pages/s (Edge ≈3.5 GB,
  Codex CUA runtime, 16 orphaned headless-shell browsers). Killed the tree
  and the orphans (→1.7 GB free).
- Third gate (`-c.log`, detached, `--maxWorkers=2`, 933s): typecheck 0,
  forbidden 0, secrets 0; tests 1700/1705 — 5 pure timeouts in
  automation-integration / automation-worker / combobox-fill, none
  touching #194/#195. Codex's own report confirms it ran vitest
  concurrently ("another Vitest process was concurrently generating
  artifacts") — the two-suites overlap this box cannot take.
- Isolation: automation-worker 14/14 and combobox-fill 39/39 (3-file
  rerun); automation-integration 5/5 alone in 35s (the two "timed out"
  cases finish in 12.9s and 4.2s). Gate treated as clear on that basis.

## Codex findings (2026-09-08 22:07, operator-forwarded; NOT verified here)

Recorded for triage after the loop; none acted on tonight:
1. Fixture/test fill runs land in `data/app.sqlite` and artifacts
   (applicationFiller.ts ~909, fillOutcomes.ts ~454); insights/screener
   suggestions don't filter by validation level. 348 fixture + 1,496
   unverified of 2,102 fill_runs; 8,552 artifact app dirs.
2. fieldDiscovery parses serialized HTML (no computed visibility / active
   wizard step); fill.ts ~1113 takes the first match, may be a hidden
   duplicate — same cluster as the `control not found` F1 finding above.
3. navigateToEmployer.ts ~259 awaits a 10s popup promise before checking
   same-tab navigation; supervisor mirrors it at 2.5s.
4. insights.ts ~143 stats every JSON under artifacts before slicing to 400
   (1.9–4.2s per view).
5. fillOutcomes.ts ~290: extension-satisfied fills and annotated skips
   recorded as errors (278 rows, 166 extension-filled).
6. Browser tests launch Chromium per fixture / per beforeEach — the gate
   cost driver.
7. codeProviders.ts ~117: Outlook code polling envelope up to ~6×70s,
   providers serial (six failures ≈350s each).

## Job #1 — Coinbase, Data Science Intern (79e75805, JobRight 6aa08b4b)

Cycle 1 (22:16, fresh discovery: 2 inspected, 1 eligible). Phase A: no
congruent href (11 external: linkedin, x, crunchbase, glassdoor,
coinbase.com…). Phase B: Apply → "Apply Without Customizing" → popup to
`linkedin.com/jobs/view/4464900528` — recorded with congruence
`unknown`, resolved_ats generic. Fill refused `NAVIGATION_INCOMPLETE`;
the supervisor ran inside the fill: clicked "Easy Apply", the model
claimed form_ready on LinkedIn's "Apply to Coinbase" modal (pixels
confirm identity fields — LinkedIn's Easy Apply form, prefilled), code
refused it (classifier saw 3 non-identity fields; the modal is
LinkedIn's, not Coinbase's — refusal is the right outcome). Triage:
`requeue_reopen_navigation` → APPLICATION_OPENING attempt 2 — which would
replay the identical path.

**#194 live evidence (LIVE_READ_ONLY_CONFIRMED):** `model calls: 3 of 5
steps` (was 6–10). Ledger: thinking 0 / 0 / 128 tokens (was 8,312 per
run); call 2 `cache_read_input_tokens: 1614` (job context cached); call 3
re-wrote the cache (1614) because the effort bump to `medium` changes the
cache key — a 1.6K-token cost per escalation, acceptable. Uncached
observation+history is still 23–39K tokens per call — follow-up: trim
frame text / history when the screenshot carries the state.

## Issue #196 — aggregator → employer-board hop (UNIT_CONFIRMED; live pending)

`src/navigation/employerBoardHop.ts` + two call sites in
`runNavigation.ts` (phase B when the captured URL is a consumer
aggregator; before phase C when nothing resolved):

- Consumer aggregators (linkedin, indeed, glassdoor, ziprecruiter, dice,
  builtin, wellfound, simplyhired, monster, lensa) are REPOSTS; their
  Easy Apply is the aggregator's form. The employer usually runs a public
  Greenhouse/Lever/Ashby board — `boards-api.greenhouse.io/v1/boards/
  coinbase/jobs` lists id 8175462 "Data Science Intern", Hybrid - San
  Francisco (LIVE_READ_ONLY_CONFIRMED, curl 22:24).
- Slugs from the company name (≤3: joined, hyphenated, first word when
  long), 3 ATSes × 3 slugs ≤ 9 GETs, 20s deadline. Match = exact
  normalized title, else a unique containment; several exact titles are
  tie-broken by a shared location token and otherwise REFUSED. A matched
  URL whose hostname names another company is refused (congruence
  reused). No model, no browser.
- `NavigationMethod` gains `employer_board`; trace phase `B_board_hop`;
  every note rides the report. Miss ⇒ the aggregator URL stays as before.
- `getJobIdentity` now returns `location` too.
- Tests `tests/unit/nav-board-hop.test.ts` (8): the Coinbase payload
  shape, no-board cap, board-without-role stops that ATS, ambiguity
  refused, cross-company URL refused, no company ⇒ zero requests.
  Graph + operator guide updated.
- Prediction: run 2 of 79e75805 resolves `employer_board` →
  coinbase.com/careers/positions/8175462?gh_jid=8175462 (Greenhouse
  embed), adapter greenhouse, fill proceeds.
- **Run 2 (22:29, LIVE_READ_ONLY_CONFIRMED for the hop):** phase A miss →
  `B_board_hop` "resolved on the employer's greenhouse board (exact
  title)" in 4s, `method: employer_board`, employer_url exactly as
  predicted. Then APPLICATION_INSPECTION threw `page.goto:
  net::ERR_CONNECTION_RESET` on coinbase.com. NOT the code: from this box
  `curl https://www.coinbase.com/` fails at TCP level in 0.02s (DNS
  resolves to Cloudflare; connection reset), while
  job-boards.greenhouse.io answers — and its 302 goes straight back to
  coinbase.com. The operator switched Wi-Fi at ~22:20; this network
  blocks coinbase.com (crypto-site filter shape). Job #1 is
  OPERATOR-BLOCKED (network), parked in APPLICATION_INSPECTION with the
  correct URL stored; `npm run run -- --pipeline --app 79e75805… --submit
  --headed --yes` resumes it on a network that reaches coinbase.com.

## Gmail tail — BLOCKED: token missing

`npm run gmail:check` → "Gmail token missing — run `npm run gmail:auth`
once as the operator." `private/auth/` holds jobright + outlook storage
only; no `gmail.oauth.json` anywhere in the tree. Consequence: the
post-submit outreach tail (`runOutreachTail` in the automation worker;
`outreach` CLI for direct runs) can extract contacts and generate the
email but cannot save a Gmail draft until the operator runs
`npm run gmail:auth -- --email <mailbox> --client-id … --client-secret …`
(OAuth browser consent — cannot be done unattended). Flags are all on
(GMAIL_DRAFTS, EMAIL_GENERATION); the OAuth client id/secret are in
`.env`. Every submit tonight will leave the email generated and a
"draft not saved: token missing" note until then.

## Loop plan (after the gate clears and the commit lands)

Queue at 21:40 (5 QUEUED, newest first — `--backlog` order): Morningstar
02992499 (JobRight, Chicago), IBM 2a0a69ec / 65f34bd6 / 4ace04ba (IBMid
wall — #195 should park them `wall_remains`), Databricks af5a95d5 (board,
no outreach tail). CDP 9222 down at session start; `CDP_AUTOLAUNCH`
relaunches the debug Chrome.


1. Close the peer's leftover tabs; verify CDP 9222 attach.
2. Fresh JobRight discovery (feed fixed by #179/#186) so JobRight-sourced
   apps — the only ones with the outreach tail (#181) — flow:
   `npm run auto:cycle -- --no-update --headed --max-apps 1 --max-submits 1 --app-deadline 300`;
   `discover:ats --registry` + `--backlog` only as a supplement.
3. Stay on one job until it submits or is genuinely operator-blocked.
4. After each verified JobRight-sourced submit the pipeline's tail runs
   contacts:insider → email:generate → gmail:draft (drafts only).
5. Read every supervised run's `model calls: N of M steps` and ledger
   `cache_read_input_tokens` — that is the #194 evidence.
