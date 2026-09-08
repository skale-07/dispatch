# Overnight issues — 2026-09-07 (night26)

Continues numbering from 2026-09-05/06 (#177 last). Session log:
`artifacts/console/auto-cycle-2026-09-07-night26.log`.

Operator directive (2026-09-07): run the full system — discovery → apply →
post-submit gmail pipeline — with the queue reset, and make sure the LLM
has sufficient context for the larger navigation decisions.

## Preflight

- Queue reset (`private/tmp-reset-queue-20260907.ts`, state machine only):
  3 stale QUEUED rows (Scale AI — operator already applied by hand —,
  Juicebox, Garner Health; all from 09-05) → FAILED_FINAL with the reset
  reason. QUEUED = 0 before cycle 1; fresh discovery repopulates.
  Backlog (29 FAILED_RETRYABLE, 26 NATIVE_AUTOFILL_RUNNING gate parks,
  61 AMBIGUOUS_FIELD) left to the triage layer, untouched.
- Flags verified in `.env`: FORM_FILL, SUBMIT, AUTOMATION, NAVIGATION,
  GMAIL_DRAFTS, EMAIL_GENERATION, GMAIL_VERIFICATION, SCREENER_LLM_MATCH,
  SCREENER_PREDICT_LLM, ESSAY_DRAFT, ESSAY_AUTOFILL, MATERIALS_DOWNLOAD,
  ATS_DISCOVERY, CDP_AUTOLAUNCH, ARTIFACT_AUTOPUSH, AGENT_FALLBACK,
  TRIAGE_LLM, TRIAGE_ACT, NAV_LLM_ASSIST all true; DRY_RUN=false.
  ANTHROPIC_LLM_MODEL=claude-opus-5 (navigation supervisor runs on it at
  effort "high"; triage/anchor adjudication at "low").
- CDP 9222 closed at session start; CDP_AUTOLAUNCH_ENABLED=true so cycle 1
  launches the debug Chrome itself (worked on night25).

## LLM context audit (what each decision surface sees)

- Triage (`src/triage/evidenceBundle.ts`): app identity, last 15 events,
  newest nav report (wall/method/notes/congruence/dups/login wall/phase
  trace), submit brief, fill gate, open review items, prior decisions,
  failed-host count. Adequate.
- Anchor adjudication (M6): company, role, ≤8 harvested hrefs with the
  congruence verdict per URL. Adequate for its narrow choice.
- Navigation supervisor (`src/navigation/applicationSupervisor.ts`) —
  the surface that makes the "larger" navigation decisions — saw ONLY
  `{company, role, url}` plus the live observation/screenshot/history.
  Gap: no posting details (location, employment type, description), no
  source posting URL, and NO memory of earlier attempts on the same app
  (walls hit, hosts reached), so it could not recognise the right posting
  on a multi-job careers site nor avoid a route a prior attempt already
  exhausted.
- Issue #178 (fix, UNIT_CONFIRMED): new `src/navigation/supervisorContext.ts`
  builds a capped, redacted job context — location, employment_type,
  source_ats, posting_url, 700-char description excerpt, attempt number,
  last 3 navigation attempts (wall/method/end_host/resolved + 4 notes
  each), last 6 state events. Wired into both supervisor call sites
  (`atsLiveFill.ts`, greenhouse `liveFill.ts`); the system prompt names the
  new fields as evidence-only. Test: `tests/unit/supervisor-context.test.ts`.
  Typecheck clean; supervisor + knowledge-graph tests pass. Full gate to
  run in the next quiet window before commit (box cannot carry the suite
  and a live headed run at once).

## Cycles

### Cycle 1 (00:13Z 09-08) — fresh mode, no_fresh_candidate

- AUTONOMY PASS: CDP autolaunch started debug Chrome on 9222 (port was
  closed at session start). Preflight ok, agent leg available.
- Discovery: 8 cards inspected, 0 eligible, 8 filtered (fresh-mode intern
  filter), 0 reused → `no_fresh_candidate`, backlog untouched. Same static
  8-card feed as all of 09-06.
- Issue #179 (observation): JobRight feed discovery is starved. The scan
  limit is 40 in fresh mode but the live scrape returns only the 8 cards
  the recommend page renders without scrolling, and that page has not
  changed in ~30h. Fresh-mode cycles therefore idle forever. Second
  discovery source used instead (below). Candidate fix for a later
  session: scroll/paginate the feed scrape, or rotate feed URLs.
- Autopush 6ec2d395 (artifacts only — verified the source change was NOT
  staged).

### Discovery via ATS boards (00:17Z) — `discover:ats --registry`

- `private/discovery/boards.json` (15 Greenhouse/Ashby boards) swept with
  `--limit 8`: 8 enqueued (Databricks SWE Intern Winter 2027; Stripe ×7 —
  6 "Software Engineer, Intern" variants + 1 "Operations Associate, New
  Grad (Mexico)"), 3 reused (Samsara new grad, 2 Databricks), rest capped
  (Verkada ×2, Notion ×4 — re-run to continue).
- Issue #180 (observation): the registry's `include: ["new grad"]` on
  Stripe over-matched a non-engineering Mexico ops role, and one board can
  monopolise the cap (Stripe took 7 of 8 slots; a per-board cap would
  spread the sweep). Parked the ops role FAILED_FINAL through the state
  machine (`private/tmp-park-one-20260907.ts`) with the reason recorded.
- Queue after: 7 QUEUED (6 Stripe, 1 Databricks). Backlog cycles from
  here (`--backlog`) — the picker takes QUEUED newest-first, so the
  ATS-discovered rows run before any parked app.

### Cycle 2 (00:18Z) — 883643e8 Stripe SWE Intern (Summer or Winter): SUBMITTED

- LIVE_MUTATION_CONFIRMED: QUEUED → … → NATIVE_AUTOFILL_RUNNING →
  READY_TO_SUBMIT → SUBMITTED → COMPLETED in one cycle. Submit report
  `submission/submit-run-1-1788826875938.json` = `SUBMITTED_VERIFIED`
  ("Thank you for applying"); receipt pixels `receipt-attempt-1.png` show
  Stripe's confirmation page. Greenhouse-hosted form; supervisor not
  needed (form reached directly from the board apply URL). submits_used 1.
- Nav audit at session start parked the new Databricks row 8f320b96 as a
  duplicate: its board URL is already held by f7cc3448 (COMPLETED 09-01
  via JobRight). Correct — `discover:ats` fingerprint dedupe missed it
  (JobRight-sourced twin has a different fingerprint) but the URL guard
  caught it before any cycle was spent. Observation only.
- Issue #181 (observation, product gap): post-submit gmail tail SKIPPED —
  "Cannot resolve stored job: … has no JobRight job id". Contact
  extraction reads the JobRight insider panel, so an ATS-board-discovered
  application has no contact source and the pipeline (by design, comment
  at `runPipeline.ts:1639`) completes without outreach. With the JobRight
  feed starved (#179), every submit tonight comes from boards.json, so the
  gmail pipeline cannot fire on them. Candidate fix: resolve a JobRight
  job id for board-discovered apps by searching JobRight for the
  company+role, or add a non-JobRight contact source.
- Autopush 3e5cf693 (artifacts only).

### Cycle 3 (00:21Z) — 9df6221e Stripe SWE Intern (Toronto, gh 8130805): FORM_NOT_FOUND

- Greenhouse live fill refused FORM_NOT_FOUND; supervisor outcome
  `stopped` ("page is confirmation"). Triage → requeue_same executed
  (attempt 2, back to QUEUED). Report:
  `artifacts/navigation/supervisor-60e559da-…/{report,observation}.json`.
- #178 read-back (LIVE_READ_ONLY_CONFIRMED): the supervisor's step
  rationales now cite the enriched context — "Correct posting (Stripe,
  Software Engineer Intern, Toronto, job id 8130805)" here and "Dublin,
  8097801" on cycle 2 — location comes only from the new job context.
- Issue #182 (fix, UNIT_CONFIRMED; safety-relevant): Greenhouse's
  job-boards embed (`job-boards.greenhouse.io/embed/job_app`) ships the
  posting's post-submit `confirmation_message` ("Thank you for
  applying.") inside its `window.__remixContext` bootstrap `<script>` on
  the BLANK form. Verified by fetching both Stripe forms read-only: the
  generic confirmation regex matched the raw HTML of 8130805 AND 8097801
  (the Dublin form that submitted fine got lucky on observation timing);
  after stripping script bodies neither matches and all inputs remain.
  Consequences: `classifyPage` returned `confirmation` for an unsubmitted
  form (supervisor stops; atsLiveFill thinks the landing is not a form),
  and — worse — `greenhouse/submission.ts` tested the SAME marker class
  against raw HTML with no form-gone guard, so a failed submit click on a
  job-boards form could have read as SUBMITTED_VERIFIED. Fix: new
  `renderedMarkup(html)` in `src/ats/shared/pageClassify.ts` strips
  script/style/noscript/template bodies; used by the classifier's
  confirmation check and by all six ATS submit verifiers (greenhouse,
  ashby, lever, workable, workday, generic) for marker tests and the
  confirmation_text match. Tests:
  `tests/unit/rendered-markup-confirmation.test.ts` (5) + posting-advance,
  ashby/lever submission, submit-click-gate, knowledge-graph all green;
  typecheck clean. Cycle 2's Stripe submit stays verified — its receipt
  pixels are the real thank-you page.

### Cycle 4 (00:30Z) — 9df6221e again: form reached, submit refused on resume

- #182 held live: supervisor `form_ready`, fill verified 22/22 fields
  (incl. the generated essay + predicted ACT screener), then submit
  FAILED_BEFORE_CLICK "field verification or upload did not pass" — brief:
  "Greenhouse resume file input not found … Saw 2 input[type=file]:
  cover_letter, question_68743857". Triage → park_for_operator (review
  item 9f565807, rationale "form-structure/adapter mismatch"). Wrong
  diagnosis, see below.
- Read-only CDP probe (`private/tmp-probe-gh-widget-20260907.ts`,
  `artifacts/probes/gh-widget-{toronto,dublin}-20260907.{json,png}`):
  both embeds are structurally identical — hidden `input#resume`,
  `#cover_letter`, one question upload, Attach/Dropbox/Enter-manually
  buttons. Not a form-shape mismatch.
- Issue #183 (fix, FIXTURE_CONFIRMED): fill-phase upload evidence on
  Toronto was `input files: []; stillAttached=false; chip=false` yet
  `verified: true` — the rule "input unmounted + no files ⇒ success" (a
  job-boards heuristic) reported a phantom upload after a single 350 ms
  wait; Dublin's chip simply rendered faster (`chip=true`). At submit the
  page had no chip and no input, so the adapter correctly refused. Two
  defects in `src/ats/greenhouse/fill.ts`:
  1. `input.evaluate(fn, {timeout})` passed the timeout as the callback
     ARG, so on a detached input (the success case) the read-back blocked
     the default 30 s — the fixture exposed it (both new tests timed out).
     Now `evaluate(fn, undefined, {timeout: 2000})`.
  2. Chip read-back now POLLS up to 8 s (`CHIP_POLL_MS`); an unmounted
     input with no filename acknowledgment is `verified=false`, gets ONE
     filechooser (Attach) retry, and the evidence carries the widget's
     visible text. The filechooser path polls the same way.
  Test `tests/unit/greenhouse-upload-chip-poll.test.ts` (chip lands at
  1.5 s ⇒ verified chip=true; never lands ⇒ verified=false with widget
  text); ats-phase5 + submit-resolve-upload still green; typecheck clean.
  Observation for later: `src/ats/shared/uploadResolve.ts:272` keeps the
  same weak "unmounted ⇒ verified" rule for the other adapters.
- Rerun: dismissed the MANUAL review item, `retry --app 9df6221e` →
  QUEUED, cycle 5 below.

### Cycle 5 (00:52Z) — 9df6221e Stripe SWE Intern (Toronto): SUBMITTED

- LIVE_MUTATION_CONFIRMED: same posting, attempt 3, with #182 + #183
  live. Upload evidence now `input files: []; stillAttached=false;
  chip=true` (the poll caught the chip), 22/22 verified, submit →
  SUBMITTED → COMPLETED. submits_used 1. Third attempt on one hard job,
  two walls removed — the night20 "stay on the job" loop shape.
- Triage sweep: the cycle-3 `requeue_same` decision resolved CONFIRMED
  (the requeue led to a submit) — first CONFIRMED verdict of the night,
  and correct. The cycle-4 `park_for_operator` rationale ("adapter
  mismatch, retry would fail identically") was wrong; the model had no
  upload read-back detail to see the phantom-verify. Observation only.
- Gmail tail skipped again (#181, no JobRight job id).

### Cycle 6 (01:00Z) — 692ca520 Stripe SWE Intern (gh 8130807): SUBMITTED

- LIVE_MUTATION_CONFIRMED on the first attempt: supervisor form_ready →
  fill verified → resume chip read back → SUBMITTED → COMPLETED
  (`submission/receipt-attempt-1.png` = Stripe thank-you page). Third
  submit of the night. Gmail tail skipped (#181).

### Cycle 7 (01:06Z) — b907c3a6 Stripe SWE Intern (gh 8031833): SUBMITTED

- LIVE_MUTATION_CONFIRMED, first attempt; receipt-attempt-1.png is the
  Stripe thank-you page. Fourth submit. Gmail tail skipped (#181).

### Cycle 8 (01:12Z) — 6acb28ae Stripe SWE Intern (gh 8130883): SUBMITTED

- LIVE_MUTATION_CONFIRMED, first attempt; receipt-attempt-1.png is the
  Stripe thank-you page. Fifth submit. Gmail tail skipped (#181).

### Cycle 9 (01:16Z) — 37815d56 Stripe SWE Intern (gh 8130867): SUBMITTED

- LIVE_MUTATION_CONFIRMED, first attempt; receipt-attempt-1.png is the
  Stripe thank-you page. Sixth submit. Gmail tail skipped (#181).
- ATS-discovered queue drained (Databricks 8f320b96 stays parked as a
  duplicate of the COMPLETED JobRight twin). Browser idle → full verify
  gate for #178/#182/#183 (`artifacts/console/gate-2026-09-07-night26.log`).

## Operator interjection (01:25Z) — "You've applied to Stripe 6 times"

- Fact check: six DISTINCT Stripe "Software Engineer, Intern" postings,
  all non-US (Dublin 8097801, Toronto 8130805, Bucharest 8130807,
  Bengaluru 8031833, Singapore 8130883, London 8130867). The board sweep
  matched them on the registry's "intern" include; dedupe is per posting
  URL, eligibility has no location rule, and I kept the loop going
  instead of stopping after the pattern was obvious. Loop halted;
  submissions cannot be withdrawn from here (Greenhouse confirmation
  emails carry a withdraw link).
- Operator directive (01:30Z): NOT one company per session — dedupe is
  "same JobRight job" (same posting) only. Multiple distinct roles at one
  company are fine. No location rule requested.
- Issue #184 (fix, UNIT_CONFIRMED) — the per-posting rule had a hole:
  `discover:ats` re-enqueued Databricks 8732364002 although f7cc3448 was
  COMPLETED via JobRight (JobRight job rows key on the card URL; the
  employer URL sits only in raw_json, so the fingerprint/URL upsert never
  saw the twin; the nav audit caught it a cycle later by URL). Two fixes:
  1. `enqueueBoardJob` now asks `findApplicationsWithEmployerUrl` before
     creating anything: a holder in SUBMITTED/COMPLETED/post-submit/
     uncertain states ⇒ `blocked`; any other live holder ⇒ `reused`.
  2. `normalizeEmployerUrlForDedupe` canonicalizes Greenhouse's three URL
     shapes (boards / job-boards hosts, embed `?for=&token=`) to one
     identity — before this, the same posting on the two hosts was two
     "URLs", and the embed's `token` (the job id) was stripped as noise.
  Tests: ats-board-discovery (+1: blocked/reused/enqueued triple),
  greenhouse-url-dedupe-identity (3), nav-congruence, supervisor-context
  (order now `created_at, rowid` — the first gate run flaked on same-ms
  inserts) all green; typecheck clean. Second full gate:
  `artifacts/console/gate-2026-09-07-night26-b.log`.
- Operator directive (01:40Z): "and yes US only".
- Issue #185 (fix): US-only location rule. New
  `src/jobs/locationEligibility.ts` (`classifyLocation` → us / non_us /
  unknown; US signal always wins — "Paris, TX", "Rome, NY", "Dublin, OH"
  are US; unknown is NOT a rejection — bare "Remote" or an unplaceable
  city passes with a warning). Wired into JobRight eligibility
  (`location_us` check) and the board sweep (non-US postings are counted
  as filtered, never enqueued). Backlog sweep of every live row: all US
  except Samsara 529d6511 "London - UK2" → parked FAILED_FINAL with the
  directive as the reason. Test `tests/unit/location-eligibility.test.ts`
  pins the six Stripe locations as non_us.

