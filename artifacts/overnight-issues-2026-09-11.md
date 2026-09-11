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
