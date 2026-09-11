# Night30 issues log — 2026-09-11 (operator asleep, autonomous)

Operator directive (04:20 UTC): "reset the job queue and start applying to
jobs for the night, once the job has been applied then run the gmail
pipeline using a separate cdp instance/chrome window to not interfere with
the main job app workflow. feel free to iterate on and fix any bugs/errors.
im going to sleep."

Standing directives carried from night29 still apply (Lever/Ashby/
Greenhouse first, how-heard → Other/LinkedIn, 24h posting policy, no
overfitting, no questions).

Numbering continues from night29 (last issue: #249).

---

## Start-of-night state (04:25 UTC)

- Queue reset through the state machine: 48 rows (QUEUED, AMBIGUOUS_FIELD,
  APPLICATION_OPENING, NATIVE_AUTOFILL_RUNNING, FAILED_RETRYABLE,
  SUBMISSION_VERIFICATION_FAILED) → FAILED_FINAL with reason "operator:
  queue reset 2026-09-11 (night30 start)". Script:
  `private/tmp-reset-queue-20260911.ts`.
- **Kept:** the Merck "Modeling & Informatics" row (80338eb7) — the
  operator applied to it by hand at 23:32 UTC and it went through
  apply-yourself outreach (5 drafts). It is `automation_excluded`, which
  the picker checks BEFORE the 24h stale-abandon, so the loop never
  touches it.
- Open MANUAL review items dismissed.
- Nothing was running: no node processes, no debug Chrome.
- The dedicated Gmail Chrome (9223, `private/browser-profiles/gmail-cdp`)
  IS signed into Gmail now (skale072007@gmail.com — matches the candidate
  profile) and into JobRight. Night29's fallback note no longer applies:
  `resolveGmailCdpUrl()` → `{ url: 9223, dedicated: true }`.
  LIVE_READ_ONLY_CONFIRMED.

## Issue #250 — the Gmail tail still opened tabs in the applier's browser

**Symptom (code read, before launch).** #233 moved only Gmail Compose to
the dedicated Chrome. The insider-panel read (`runInsiderTriage`) still
attached with `mode: "CDP_ATTACH"` and no `cdpUrl`, i.e. the applier's
9222 — opening a JobRight tab and clicking email icons in the browser a
live fill is typing into. The operator's directive tonight is explicit
that the Gmail pipeline must not interfere with the apply workflow.

(The other two tail steps were already separate: enrich and the #242
company search open their own launched STORAGE_STATE browsers.)

**Fix.** `openInsiderSession` prefers the dedicated outreach Chrome when
`resolveGmailCdpUrl()` says it is usable AND the session's own JobRight
auth validation passes there; anything less falls back to the applier
browser (previous behaviour) with the reason recorded in the triage
report's notes.

**Latent cross-kill found on the way.** `PlaywrightServiceSession.open()`
answers a failed CDP attach with `restartCdpChrome()` — which always kills
and relaunches the APPLIER's debug profile, whatever URL failed. With
#233 that meant a wedged Gmail window on 9223 would have killed the
applier's Chrome mid-fill. The restart now fires only when the failing
endpoint IS `AGENT_CDP_URL`; any other endpoint gets an error naming its
own launcher (`chrome:debug:gmail`).

Tests: `service-session-restart-guard.test.ts` (2 — no restart for a
different endpoint; restart still attempted for the applier's own).
UNIT_CONFIRMED. The dedicated JobRight session validating AUTHENTICATED on
9223: LIVE_READ_ONLY_CONFIRMED. The triage actually running there is
confirmed by the first post-submit tail (note in the triage report).

**Live confirmation (05:13 UTC):** the first post-submit tail (Swarm Aero)
recorded `insider triage ran in the dedicated outreach Chrome
(http://127.0.0.1:9223)`. LIVE_READ_ONLY_CONFIRMED for the routing.

## Issue #251 — one Greenhouse job, several postings: the sweep enqueued it three times

**Symptom.** The first sweep of the night enqueued "Intern - Information
Security (Cybersecurity)" three times and "Intern - Quality Engineer"
twice — NISC publishes every job once on `greenhouse:nisc` and once PER
CITY on `greenhouse:testnisc` (a real mirror board the feed refresh
found). Different posting URLs, so the per-posting dedupe passed them,
and identical titles, so #249 deliberately left them alone.

**Cause.** The board API says outright which postings are one job:
Greenhouse's `internal_job_id` (3544833 for all three InfoSec posts). We
never read it.

**Fix.** `parseBoardPayload` keeps `internal_job_id`; enqueue stores it as
`raw_json.board_internal_job_id`; before enqueueing, a posting whose
internal id is already held by a DIFFERENT posting (any state except
FILTERED_OUT / UNSUPPORTED_ATS — same rule as #249) is recorded
`near_duplicate` with the holder named. Keyed on ATS + internal id (the
vendor's primary key), not company text, which differs between boards of
one employer. Distinct reqs carry distinct internal ids and still enqueue,
so #249's per-location-req contract is untouched.

**Backfill + audit.** `private/tmp-backfill-internal-job-id-20260911.ts`
tagged 100/105 existing Greenhouse board rows from the live APIs. It
found one past TRUE duplicate: **DV Trading "Client Platforms Engineer
Intern - Summer 2027" was submitted twice on night29** through two postings
of internal job 4453964005. Also Neuralink "Biomedical Engineer Intern"
and "R&D Materials Engineer Intern" share one internal job (one req,
two role-titled posts — one application is right there too).

Immediate cleanup: the three testnisc rows abandoned through the state
machine; `testnisc` removed from the registry (a pure mirror).
Prevalence: Rocket Lab has 68 multi-post jobs, Datadog 50, Verkada 19.

Tests: ats-board-discovery 25/25 incl. mirror board + per-location posts
+ distinct-req-same-title + idempotent re-sweep. UNIT_CONFIRMED.

## Registry note — non-software engineering disciplines excluded

Swarm Aero "Composite Engineering (M&P) Intern" was submitted (cycle 2):
`role_terms` contains bare "engineering", which admits every hardware
discipline. The operator is Applied Math & Stats / Econ with software/ML
work (#209's intent: software/data/AI roles). Added unambiguous
discipline PHRASES to `exclude_terms` (mechanical/manufacturing/civil/
chemical/structural/aerospace/electrical/hardware engineer(ing),
composite(s), m&p, propulsion, avionics engineer, mechatronics, …) —
phrases, not bare words, so "Manufacturing Software Engineer" and
"Electrical/Embedded Software Engineer" still pass. Dry-run over 15 real
titles confirmed. That one submission cannot be undone.

## Issue #252 — the healer typed a race answer into the gender control and a referral box

**Symptom.** Hudl ×2 (greenhouse) parked AMBIGUOUS_FIELD with gender
"Expected Male; page shows (empty)" — although the fill log says `picked
"Male" (exact)`.

**Cause (from the live report, not guessed).** Race had no unambiguous
option ("Asian" vs East / South / Southeast Asian) so the fill correctly
REFUSED it. The heal pass then tried to "relocate" race:
candidate `[id="1326"]` — the GENDER control, scored 0.85 on "please
indicate your" — typed "Asian" into it and wiped the verified "Male"; then
`#question_68482526` — "If you heard about this role from a current Hudl
employee, please provide their name", scored 0.6 on "please/your" — and
reported race HEALED there. The submit gate held (nothing wrong was
sent), but a demographic value was written into two other questions.

**Fix (three general rules).**
1. Label similarity ignores question boilerplate (please, indicate, your,
   select, provide, …): those three labels now score 0 against each other.
2. The healer never tries a candidate that is another plan entry's control
   (`planFieldIds`, all entries whatever their action) — heuristic and
   sidecar layers alike.
3. A field whose control was located and whose VALUE was refused (the
   combobox's own "ambiguous match" / "no option matches") is not healed —
   relocation cannot fix a value refusal; it can only write it elsewhere.

Tests: fill-healer + combobox-fill 60/60 (new: boilerplate scores 0;
another entry's control skipped with its value intact; located-but-refused
not relocated). FIXTURE_CONFIRMED.

(Hudl's race question itself stays an operator item: the sensitive profile
says "Asian", the form wants a sub-region, and demographics are never
inferred.)

## Issue #253 — every insider lookup timed out in the dedicated Chrome

**Symptom.** After #250 moved triage into the 9223 Chrome, 0 drafts from
the first 8 submits: triage either saw 0 people or got `popup_timeout` on
every email icon (Rocket Lab ×3, Tanium ×3).

**Cause (pixels).** The 9223 profile has never used JobRight's UI, so the
job page shows first-run overlays — an "Orion · Boost Your Resume Here!"
product tour (EXIT / TRY IT NOW) with a dimming mask, and a "Make Turbo
Even Better" survey card — over the Insider Connection panels. The
old profile dismissed them long ago. Screenshot:
`artifacts/console/night30-insider-probe-4s.png`.

**Fix.** Registry `insiderSelectorsV1.onboardingOverlays` (marker text →
its own dismiss control); triage dismisses each (never accepts) before
tagging panels. Live: after the tour's EXIT the same page showed 3 school
+ 5 beyond people (was 0) and the lookup reached "Contact Info Found!".
Remaining: the survey card's × has no text label, and the Connect Now
click still missed once — both being probed.

### #253b — the tour has more than one step, and the section mounts late

A later load of the same Tanium page tagged 0 people again: the Orion tour
is multi-step ("Boost Your Resume Here!" → "Stand Out Among Applicants" →
…) and each step's mask swallows the panels' View clicks
(`artifacts/console/night30-panel-timing.png`). The marker is now the
step's own TRY IT NOW control, dismissed via EXIT in bounded passes, and
re-checked before every person. The Insider Connection section also mounts
asynchronously (0 people at +3s, 8 at +6s on one page), so triage waits
for it (bounded 10s). Icon-only survey close accepted by class for a
close-type dismiss. Live probe: tour dismissed, 8 people tagged, Connect
Now clicked, email modal up. Fixture: a two-step blocking tour + survey
card, never accepted (insider-triage 8/8). Commit 75fc6542.

**Backfill + first live drafts.** The 8 tails that ran before the fix
(0 drafts each) were cleared (`private/tmp-reset-gmail-tail-20260911.ts`,
metadata only) and the worker restarted: Zipline 3 people → 2 emails → 1
draft (one person capped by #214), 045dbbab 5 people → 3 emails → 3
drafts — every draft `verified: true` by Gmail read-back in the dedicated
Chrome. **LIVE_MUTATION_CONFIRMED** for the whole tail running outside the
applier's browser (operator directive).

## Issue #254 — Lever checkbox members have no id

Palantir (lever) parked on three card questions — "checkbox group has no
option matching "English (ENG)" (options: English (ENG), Spanish (SPA) …)".
The label matched; the id-only targeting then refused, because Lever card
checkboxes carry only the shared group `name` and a per-box `value`. The
fallback targets `input[type=checkbox][name=…][value=…]` — the HTML
identity of a group member, for any ATS. Fixture test with Lever's markup
(14/14). Palantir requeued to prove it live.

## Issue #255 — a visa-EXPIRY date question was answered "Yes"

Exegy (ashby): "If you are currently authorized to work on a visa or other
work permit, when does that work authorization expire?" was claimed by the
alias "authorized to work" → `work_authorization` → "Yes" into a date
input (fill refused, verify parked). A question about WHEN an
authorization ends is neither the status nor the sponsorship question:
unmapped now (date control, or expir*/end date/valid until/when does).
Authorization is never model-answered, so it stays empty and the page's
own completeness scan decides whether that is allowed. Tests 22/22.
Exegy requeued.

## Registry note — PhD roles

Waymo "2027 Summer Intern, PhD, Machine Learning" reached the queue (and
looped on JOB_ID_MISMATCH). The operator is an undergraduate (class of
2029). `exclude_terms` += phd / ph.d / doctoral; the row abandoned with a
role-fit reason (policy-abandoned ⇒ never re-created).

## Observed, not fixed

- Gate-stop parks (NATIVE_AUTOFILL_RUNNING, no transition) are re-picked by
  every new cycle until the post-session triage parks them — Waymo and
  IBM each cost 3 cycles. Bounded, but ~6 wasted cycles tonight.
- JobRight re-discovery of a job previously FILTERED_OUT creates a fresh
  row every pass (Amazon apprentice / Northern Trust ×20 on 09-10) — by
  design (policy may change), costs a detail read per pass.

## Issue #255b — the screener bank claimed the same expiry question

After #255 unmapped it upstream, Exegy's visa-expiry date question was
claimed by the screener registry's `work_authorization` pattern
(/work authorization/) and got the bank's "Yes". Both authorization keys
now carry `excludePatterns` for expir*/end date/valid until/when does —
excludes bind every path to a key (#113b), including stored LLM label
maps. Tests: screener-bank + screener-prediction 50/50.

## Issue #256 — Greenhouse never had the fill-stage page-complete waiver

#240 put the "page's own rules decide" waiver into `atsLiveFill` — every
adapter except the dedicated Greenhouse runner. A Greenhouse form whose
only gap is an optional question we correctly leave empty (Hudl's race:
profile "Asian" vs East / South / Southeast Asian — demographics are never
inferred) parked AMBIGUOUS_FIELD three steps before the submit gate's own
waiver could look. Same block, same fail-closed contract, now in
`greenhouse/liveFill.ts`.

Live (Hudl ×2 re-runs): #252 held — gender kept, the healer declined race
with "value refused … not healed" — and the waiver ran and REFUSED
correctly: the page still requires 2 questions. The waiver's refusal now
names them (it said only "2 unanswered question(s)"); Exegy's re-run
showed exactly why that matters: "What is your notice period…" and
"What are your annual base salary expectations…" — salary is policy.

## Issue #257 — one Compose timeout aborted six drafts

Tanium: 6 emails generated, 0 drafted — `locator.click: Timeout 5000ms`
on Gmail's Compose, whose call log reads "click action done … waiting for
scheduled navigations to finish". The click landed; Playwright then waited
on Compose's hash navigation (`noWaitAfter` is a no-op in 1.61). The
click's own timeout no longer decides — the compose window appearing
(the existing To-field wait) does, so a click that truly missed still
fails there. Live after restart: Tanium 6/6 drafted.

### #257b — every walk opened a LinkedIn tab

The expander regex accepts "Find More Connections" (an old UI's
expander). On an expanded panel today that control is
`<a href="linkedin.com/search/…" target="_blank">` (live DOM probe), so each
triage opened a LinkedIn people-search tab in the outreach Chrome. An
expander is now never a link to another host or a new tab.

## Issue #258 — the box ran out of memory: sessions never closed their tabs

**Symptom.** At ~08:00 UTC the harness killed the loop's wrapper task for
low memory (1 GB free of 16; Chrome 3.3 GB / 56 processes). The loop's own
bash survived and kept cycling, but the cause was structural: the applier
Chrome held a tab for nearly every application attempted tonight (Palantir
×2, Oracle HCM ×2, IBM ×2, Tesla ×2, UltiPro, Dell, Zipline, USAA …), the
outreach Chrome 7 more.

**Cause.** `PlaywrightServiceSession.close()` in CDP_ATTACH mode only
disconnects — correctly, so it never closes the operator's tabs — but that
also abandoned every page the session ITSELF opened. `withNavHandoffPage`
(inspection + fill in the applier Chrome) never closed its page, and Apply
popups multiplied it. (Some outreach-Chrome tabs were my own crashed
probes.)

**Fix.** The session tracks the pages it opened via `newPage()` and every
popup they spawn, and `close()` closes exactly those (bounded 5s — #208)
before disconnecting. A tab the session did not open is never touched.
Unit test with a fake attached browser: own pages + popup closed, the
operator's pre-existing tab untouched, browser only disconnected.
Stale tabs closed by hand; free memory back to ~2.4 GB.

## Issue #259 — the predict tier answered an authorization question

Exegy's re-run after #255/#255b: the now-unmapped visa-expiry question
reached the screener predict tier, which answered "N/A - I am a U.S.
citizen, so my work authorization does not expire." (the date input
refused it). The operator's standing rule — demographic / authorization /
compensation / criminal questions are never model-answered — was enforced
by the essay layer's `SENSITIVE_QUESTION` and not by the predict tier.
It now is (shared constant). One existing test used "Which country are you
authorized to work in?" as its sample predict question; its subject was
the payload shape, so it now asks a neutral question. Tests 117/117 across
predict/essay/screener suites.

Exegy itself stays parked correctly: its page requires "What are your
annual base salary expectations?" (policy) and a notice period.

## Issue #260 — JobRight discovery queued a term variant of a submitted role

Cycle 44: Zipline "Data Analytics Intern (Summer 2027)" (JobRight feed)
reached the form hours after the board's "(Spring 2027)" posting of the
same role was SUBMITTED (a72fc204) — #249's term-variant guard ran only in
board discovery. It blocked on a required authorization question before
anything was sent; abandoned as a policy duplicate. JobRight discovery now
applies the same guard (shared `existingRolesForCompany`) before the detail
read, never against a posting it already holds. Audit of the 19 open rows:
no other term variant queued. Test (phase55-dedupe): a JobRight card whose
role is a term variant of an existing application is skipped with the
#260 note.

Still not covered: company-name variants between catalogues ("Rocket Lab"
vs "Rocket Lab USA") — the guard compares exact company text, as #249 did.

## For the operator — authorization STATUS questions

"Please provide details on your current work authorization status in the
United States" (checkbox group: citizen / permanent resident / visa …) has
no deterministic mapping, and after #259 the model no longer answers it. The
profile carries no citizenship field; my notes say you confirmed US
citizenship on 08-31, but an authorization answer is yours to record
(sensitive profile or `screeners.json`), not something to write for you.

## Issue #224 (closed) — required controls an ANSWER reveals

Top item since night28 (Palantir ×N, Crest ×2, Immuta): the submit gate
refused on a bare "Name" + "Date" acknowledgement block the plan never saw.
Tonight Palantir hit it again (cycle 40) — after #254 fixed its three
checkbox cards, those two were the only questions left.

**Diagnosis, settled with a read-only probe** (public-URL session, no
debug Chrome): on Palantir's EMPTY form 94 controls are discovered at
+1.5s and +6s and the completeness scan lists 16 required questions —
neither "Name" nor "Date" exists at any point. So it is not a slow mount;
an answer REVEALS the block (conditional section). No plan-time snapshot
can contain it.

**Fix — one bounded second pass in `atsLiveFill`** (after the other-specify
and revealed-select sweeps): a control is revealed when the settled page
has it and the plan-time HTML did not (new by id AND by label) and it is
required (attribute OR the completeness scan's own list — Lever marks
cards with ✱). Only then is the page re-planned through
`planApplicationFill` (same aliases, same approval rules — values only from
the approved plan, sensitive/salary unapproved), the fill restricted to the
revealed entries, and read back. A revealed control that fails verify is a
fill error; the submit gate's completeness scan still arbitrates, so the
pass can only turn a refusal into a submit, never the reverse.

Fixture: filling "First Name" reveals a required Name/Date block with Lever
`cards[…]` names — the pass plans it, fills both, verifies, and the
sandbox submit goes through (ats-live-fill 21/21). FIXTURE_CONFIRMED;
Palantir requeued for the live proof.

### #226b — bare "Date" was being answered with the graduation year

Writing the fixture exposed a real mapping bug: with the operator's actual
alias file, bare "Date" → `graduation_year` (reverse containment: "date" is
inside "Expected graduation date") and bare "Name" → `legal_name.first`.
#226's signature rules sat AFTER the alias loop and its test used empty
aliases, so production never reached them — the first revealed "Date"
would have been typed "2029". The signature rules now run first; a bare
"Name" that is an ATS custom question (Lever `cards[…]`, Greenhouse
`question_…`) is a signature line → full legal name, while the form's
primary name field (Lever `name="name"`, composed by the adapter) keeps
`legal_name.first`. Tests with realistic aliases (48/48 incl. Lever
adapter).
