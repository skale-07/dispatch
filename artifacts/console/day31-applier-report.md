# Day31 applier report — 2026-09-12

Loop: `bash private/loop-day31.sh 1789267162` (end ≈ 22:39 local), adopted at
~16:45. One job per cycle, `auto:cycle --backlog --no-update --headed
--max-apps 1 --max-submits 1 --app-deadline 300 --defer-gmail` in the applier
Chrome (9222); `outreach:worker --loop` in the dedicated outreach Chrome
(9223). Both alive on adoption and since.

## 17:55 — cycles 1-39, 7 submits, issues #271-#275

### Submits (7)

Cycles 16 (5a8464b4), 17 (0f7d0a47), 18 (faa35a5b), 20 (caed3e39),
21 (2a263698), 23 (56b0357b), 28 (6f32baaa) — all COMPLETED, submit verified.
Outreach is deferred to the 9223 worker by design.

### Walls fixed

**#271/#272/#273 — Ashby's education block (the evening's dominant wall).**
Two applications parked `AMBIGUOUS_FIELD "verification failed"` on the SAME
block within 20 minutes — cycle 19 (04394211, Ibotta) and cycle 22 (80e6a0fc,
Commure) — so this was the one wall worth the night's engineering.

Diagnosed from the real rendered DOM
(`artifacts/ats-fill/ashby-live/form-snapshot-1789245428470.html`) plus the
12-item operator brief, not from guesses. The block is one
`data-field-path="_systemfield_education_history"` wrapper in which only
Degree and Field of Study carry their label's `for` id as a real element id:
School is an id-less autocomplete and Start/End Date are each a PAIR of
id-less month+year `<select>`s inside a container div that owns the id. So
generic discovery addressed four unnamed selects as `…education_history#17`
… `#20`, labelled all of them with the GROUP label "Education History", and
the plan sent them to the screener bank / LLM predict — which answered
"May" / "2025" into controls the fill could not even locate, while the
wrapper's own path id typed a stray "2025" into the SCHOOL typeahead
(`no option matches "2025" (options: IRL HealthDEEP | Fort Leavenworth
Unified School District 207 | …)`).

Third finding, from reading the option lists rather than assuming them: both
year `<select>`s **stop at 2027** while the candidate graduates in **2029**.
That is why the poisoned bank answer was a plausible-looking "2025" — 2029 was
never selectable. A factual graduation year is now skipped with the real
reason rather than traded for a nearby option, which would misstate a fact on
a real application. Requiredness also read off the DOM: only `School` is
required in that block, so skipping the year does not block the submit.

Fix: `discoverAshbyEducationDates` rebuilds the four date controls as one
field per `<select>` with the page's real options; `ashbyDiscoverFields` drops
the group-path twins a rebuild owns; new `src/ats/shared/educationBlock.ts` is
the first tier in `locatorForField` and resolves School and the month/year
selects against the wrapper (so the ashby-local combobox/verify path and the
delegated generic fill both get it); `fieldNormalization` maps the four by
structural id suffix to `start_month/start_year/graduation_month/
graduation_year`, anchored so a WORK-history date pair can never take an
education canonical. No education control can reach the screener bank or the
LLM any more.

Read-back on the real 89KB snapshot: 22 fields → 21, with the 5 bad entries
gone and 4 correct date fields added. Level **FIXTURE_CONFIRMED**
(`tests/unit/ashby-education-block.test.ts`, 12 cases over a fixture cut from
that live snapshot). Both apps requeued; live re-run pending — they had not
been picked again as of cycle 39.

A cold re-read of my own diff caught a regression before it shipped: the
"page does not offer this value" skip, as first written, would also have
claimed a COMPOSED seasonal graduation date ("May 2029" against a page
offering "Spring 2029"), silently stopping us from answering every seasonal
graduation-date question. It is now scoped to a bare month or a bare year —
the split-control case it is actually about — with a regression test.

**#275 — Workday "Autofill with Resume" route (operator directive).**
Implemented behind an explicit option, `manual` default everywhere: registry
selectors for the file input / drop zone / uploaded-item / continue controls;
`PortalAuthSeams.workdayRoute` + `resumePath`; `clickAutofillWithResume`
(click the method, set the resume on the CSS-hidden input, poll ≤45s for the
account form, the SSO chooser, or the wizard, recording elapsed parse time);
`runAtsLiveFill.workdayRoute` wired only at the chooser call site; CLI
`ats:fill --workday-route manual|autofill`; documented in
`docs/operator-guide.md` with the per-job comparison checklist. The autofill
leg is tried once and always degrades to Apply Manually with the real reason.
Guardrails held: the approved plan still fills and `verify` still corrects, so
a parsed value disagreeing with the profile is never accepted; work
authorization / sponsorship / EEO never come from the parse; submit gating
untouched; SSO choosers still "Sign in with email".
Level **FIXTURE_CONFIRMED** (`tests/unit/workday-apply-route.test.ts`, 6 cases
including three degradation shapes).

### Needs the operator

1. **The route comparison has no supply.** There are **zero** Workday
   applications in the database and none in tonight's backlog — every queued
   posting is JobRight/board-sourced and resolves to Ashby/Greenhouse-class
   ATSes (Amgen looked promising but `careers.amgen.com` is a Phenom site).
   So "which route is more efficient and accurate, per tenant" stands at
   **UNVERIFIED** and cannot be promoted from a fixture. It needs Workday
   postings queued (`*.myworkdayjobs.com`) plus a tenant account, since the
   route sits behind the same account wall as the manual one. The instrument
   is ready: `npm run ats:fill -- --url <workday-url> --execute --headed
   --resume <pdf> --workday-route autofill`, then the same URL with
   `--workday-route manual`, comparing the `workday apply route:` note,
   `timing:`, fields touched, the `verify` mismatch list, and the submit gate.
2. **Poisoned screener-bank entry**: `screener:custom:education_history_year`
   = "2025". No Ashby field can reach it now, but it would still claim a
   genuinely "Education History"-labelled question elsewhere. Not mutated.
3. ~~**Cycles burned on duplicate postings**~~ — **withdrawn, I was wrong.**
   Cycles 36-38 and 40 each ended `navigation refused: duplicate employer
   URL`, and I started patching `duplicate_url` to record FAILED_FINAL
   instead of FAILED_RETRYABLE. Checking the tests first showed there is
   already an evidence-gated design for exactly this — duplicate_url parks,
   LLM triage decides `abandon_duplicate`, and the state machine retires it —
   and the logs show it WORKING: all 5 of today's duplicate_url cases logged
   `"chosen":"abandon_duplicate","mode":"act","executed":true,"detail":
   "abandoned to FAILED_FINAL"`. So a duplicate costs exactly one cycle (the
   navigation that discovers two JobRight postings share an employer URL) and
   is then permanently retired. The patch was reverted before it went
   anywhere; it would have duplicated working behaviour while bypassing the
   evidence gate.

### Open walls not yet fixed

- Cycle 24 (5818f1ce, Sanofi/generic) and cycle 34 (1ba9bebc) —
  `AMBIGUOUS_FIELD`, fills reporting "(empty)" after write on a Phenom-class
  page. Not diagnosed yet.
- Cycle 39 (d5917b41, `careers.amgen.com`) — reached READY_TO_SUBMIT but
  `0 file inputs on page`, so the resume never attached and the submit gate
  refused correctly. The upload control is presumably behind a step the walk
  does not open.
- Cycle 33 (54a4667a) — `CAPTCHA_REQUIRED`, genuinely operator-blocked.

## 19:45 — cycles 1-43, 8 submits, commit b8f541e6, #277/#278 added

Submit #8 landed on cycle 43 (2325619e, COMPLETED). Commit **b8f541e6** carries
#271-#273, #275 and #276 (18 files; typecheck, test, check:forbidden and
check:secrets all passed solo with the loop paused).

Since then, two more walls, both from the live Workday runs:

- **#278 (fixed, FIXTURE_CONFIRMED)** — the wizard walk re-filled ONE stuck page
  eight times. Merck `msd.wd5` (app 07fa81a1, cycle 42) recorded wizard pages
  2-9 as the same page: same heading, same `/apply/applyManually` URL, same
  `14 fillable / 11 filled`, eight copies of `never settled on a NEW page` and
  of `Error: The field How Did You Hear About Us? is required…`. That is ~12
  minutes of a 300s-deadline cycle, and it ended AMBIGUOUS_FIELD regardless.
  Workday answers a Next it will not honour by re-rendering the same page with
  a field error, so `transition.landed` is true, Next is never disabled, and
  the error-banner guard does not match its phrasing. Added
  `MAX_NO_PROGRESS_PAGES = 2`. **Negative control:** with the cap removed the
  new test fails `expected 8 to be 2` in 23.4s; with it, 2 clicks in 5.7s.
- **#277 (diagnosed, deliberately NOT shipped)** — Leidos `wd5` phone-type
  combobox harvested another dropdown's options (`Expected "Mobile"; page shows
  "Main/Home"`, options `LinkedIn (External Share) | United States of America
  (+1)`). `listboxForControl` falls back to the first visible listbox in
  DOCUMENT order, and Workday renders popups in portals. I wrote a proximity
  fix plus a fixture — the fixture passed **with and without** the fix, so it
  proved nothing and both were reverted. Shipping an unproven fix behind a
  non-discriminating test would have been worse than leaving it open.

**Correction to my earlier "zero Workday supply" claim:** it was wrong, and the
query was why — `jobs` only holds the JobRight URL, so no SQL filter over it can
see a Workday host that navigation resolves later. Leidos `wd5` and Merck
`msd.wd5` both ran tonight. The Merck artifact is live proof the #275
instrumentation works: `"workday apply route: manual (#275)"` next to
`"standing portal login used for msd.wd5.myworkdayjobs.com"` and
`"workday page kind after auth: wizard"`. So the route note and the manual
baseline are LIVE_READ_ONLY_CONFIRMED (19 planned, `plan 2s, fill 60s,
verify 3s`, 14 fillable / 11 filled per page, one `how_heard` mismatch); the
autofill route itself stays FIXTURE_CONFIRMED and the comparison UNVERIFIED. I
did not run the autofill leg beside the live loop: `ats:fill --url` starts an
unauthenticated context, so it would have driven a second sign-in against a
live tenant and spent that host's 3-attempt/6h auth budget — on Leidos, while
the loop was mid-flight on the same tenant.

**Supply, not bugs, is now the binding constraint.** A manual 60-board sweep
(`discover:ats --limit 60`, up from the loop's 10) enqueued **zero**: everything
left is >24h old, non-US, or outside role terms — all operator policy. JobRight
yields ~2 eligible per pass. The backlog has been 2-4 apps for the last hour.

## 20:10 — outreach verified working; Chrome self-healed

**The operator's Gmail directive is being met.** The 9223 worker reports
`pending: 0` every pass, which looked wrong against 9 submits — it is not. All
nine VERIFIED submissions have a completed tail record (`ok: true, done: true`,
`attempts: 1`), which is exactly why the queue is empty. **14 Gmail drafts** were
created in the dedicated Chrome: Voloridge 5, Perpay (56b0357b) 3, Klaviyo
(caed3e39) 3, Lightmatter 3 (4 generated). Five submits drafted 0 — no insider
contacts resolved for those (board-sourced rows, the #181 shape); Klaviyo
appearing once with 3 and once with 0 suggests per-company dedupe doing its job.
Verified by reading `versions_json.gmail_tail` directly, not by trusting the
worker log.

**Chrome/CDP wobble, self-healed.** Cycle 44 ended `cdp_unrecoverable` — the
debug Chrome died and the first restart did not recover ("killed stale
debug-profile Chrome (pids 9264,49780,5280,40616,20056)"), the #258 tab-leak
shape. Cycle 45 autolaunched a fresh Chrome on 9222 and resumed applying, so no
intervention was needed. Worth the operator knowing it still happens.

Cycle 44's status line also reads `skipped_already_armed` ("an armed session is
already live — arm 4a03556c, 0/25 apps, 120 min left"), i.e. a stray arm
overlapped one cycle. It cost that cycle only; later cycles armed normally.

## 20:00 — two abandonments, #279/#280/#281, queue livelock diagnosed

**#280 (fixed, FIXTURE_CONFIRMED, awaiting live):** Merck's real Workday tenant
is `msd.wd5.myworkdayjobs.com` — the company trades as **MSD** outside the US —
and the congruence gate refused the fill: `stored URL is for "msd", not Merck
(page does not name the company either)`. Cycle 42's Merck app on the SAME
tenant got through only because its posting page happened to print "Merck" and
the page-identity override fired. Added `TENANT_TRADE_NAMES`, a curated map
checked first in `slugMatchesCompany`, seeded with the single documented pair
`merck → msd`, exact-slug-match only. This is a safety gate, so it widens by
named pairs and nothing else: `msdholdings` does not match, and Pfizer on the
msd tenant is still a mismatch. **Negative control:** without the lookup the
test fails `expected 'mismatch' not to be 'mismatch'`. The fix is already in the
working tree, so the loop should exercise it on 77b667ce.

**#279 (diagnosed, NOT fixed) — the queue has a livelock.** Eight apps sat in
states the picker's second pass can re-hand, ordered by ATS tier then recency
DESC. Every re-pick refreshes `updated_at`, so a failing in-flight app
re-selects itself forever while older rows starve. Cycles 45+46 both took Tesla;
48+49 both took Retell AI. It is why **both applications I requeued to prove the
#271-#273 fix (updated 21:21) were never reached** — they sit behind rows that
re-bump themselves every cycle. No review item is open on them, so this is not a
park and #241 does not help. I did not change the ordering: it is load-bearing
for #228's ATS-tier priority and the 24h recency policy, and there is no way to
A/B it in a live session. Two candidate shapes are in the issues log (order the
second pass by `attempt` ASC, or by time-entered-state instead of `updated_at`).

**Two abandonments, both through the state machine with the reason recorded:**

- `d9cb4f54` **Tesla** → FAILED_FINAL (#279 mitigation). Bespoke careers SPA;
  the navigation supervisor never reached an applicant form
  (`NAVIGATION_INCOMPLETE`) on two consecutive attempts and it was not an auth
  wall. It was consuming a cycle each time.
- `8e9cd785` **Retell AI** → FAILED_FINAL (#281). Our side was clean — 9
  planned, `verify passed`, 0 mismatches, no required-completeness blockers —
  but the employer rejects the click server-side:
  `REJECTED_AFTER_CLICK — "We couldn't submit your application"` on cycles 48
  AND 49, each burning that cycle's submit budget. Employer-side block (likely a
  duplicate or closed posting), not a fillable wall.

## 20:25 — commit 8dc9315b; why the Ashby fix stays FIXTURE_CONFIRMED

Third commit: **8dc9315b** (#280 Merck→msd tenant trade name).

**The live validation of #271-#273 will not land tonight, and the reason is not
the fix.** Both candidate applications are now out of reach:

- `04394211` (Ibotta) finally got picked in cycle 50 — but from
  FIELD_VERIFICATION, which re-uses the STALE pre-fix verification instead of
  re-filling, so it refused at the submit gate without ever exercising the new
  discovery. `npm run retry` then moved it to QUEUED at 23:52:39 for a genuine
  fresh fill, and 17 seconds later the loop retired it:
  `posting published 26.7h ago (> 24h; operator policy 2026-09-08)`. That is the
  operator's own policy working correctly, not a bug.
- `80e6a0fc` (Commure) is still FIELD_VERIFICATION, starved by #279, and its
  posting is older still — so requeueing it to QUEUED would retire it the same
  way.

So #271-#273 stands at **FIXTURE_CONFIRMED**, backed by a deterministic
read-back on the real 89KB live snapshot (`ashbyDiscoverFields` goes 22 fields →
21: the five bad entries — the wrapper path plus `#17`-`#20` — are gone and four
correctly-mapped date fields replace them, School stays required). What it still
needs is one fresh Ashby posting under 24h old that carries the
`_systemfield_education_history` block. Three Ashby forms ran after the fix
tonight (Notion, CTGT, Retell AI) and all three verified clean, but none uses
that block — they use per-question uuid fields.

**Chrome/CDP is degraded.** Every cycle from 48 onward logs `CDP autolaunch:
endpoint still unreachable after 10 polls — agent phase will be skipped`, so the
loop has been applying with its agent phase disabled — the #258 tab-leak shape
again. Cycles still complete and still submit, but the agent fallback that
rescues hard navigations is not available, which plausibly contributed to the
run of `FAILED_BEFORE_CLICK` outcomes in cycles 50-52.

## 20:35 — CDP repaired by hand, outreach worker restarted

The degradation above was worse than "agent phase skipped": **neither** debug
endpoint was reachable (`curl http://127.0.0.1:9222/json/version` and `:9223`
both returned nothing) while **25 Chrome processes** were alive — the #258
tab-leak/OOM shape. The loop's own autolaunch had been retrying and failing for
five consecutive cycles, so I repaired it rather than leave the rest of the night
degraded:

1. `day31.pause` set, waited 90s for the in-flight cycle to finish.
2. Killed every Chrome process (25 → 8 stragglers).
3. `npm run chrome:debug:jobright` (9222) and `npm run chrome:debug:gmail`
   (9223). Both endpoints now answer and report 3 tabs each.
4. Restarted the outreach worker on the exact `start_outreach()` command
   (`outreach:worker --headed --loop --duration 153 --interval 90 --since 6`),
   rewrote `artifacts/console/day31-outreach.pid`, since it had lost its browser.
5. Released the pause.

Worth noting for the operator: the outreach worker's LAST pass before the
restart (pass 194) processed a new submission for `28743dcd` (Retell AI), so the
Gmail tail kept working right up to the Chrome failure.

## 20:50 — 10 verified submissions (corrected count)

Counting from the `submissions` table rather than the loop's `submits_used`
counter, because that counter increments on a submit ATTEMPT: it read 12, but two
of those were the rejected clicks on 8e9cd785. **10 VERIFIED submissions since
the loop started at 18:39 UTC:**

| time (UTC) | company | role |
|---|---|---|
| 19:58 | GrayMatter Robotics | Robotics Engineer (New Grad), Government Programs |
| 20:01 | AfterQuery | AI/ML Research Intern |
| 20:04 | Lightmatter | Silicon Packaging Engineer — Intern & New Grad |
| 20:31 | Klaviyo | Software Engineer Intern (Summer 2027) |
| 20:35 | Klaviyo | Software Engineer Co-op (Spring 2027) |
| 20:51 | Perpay Inc. | Data Science Internship, Summer 2027 |
| 21:22 | Voloridge Investment Management | Quantitative Research Intern 2027 |
| 21:28 | CTGT | Software Engineering Intern (Summer 2027) |
| 23:07 | Perpay Inc. | Data Engineering Internship, Summer 2027 |
| 00:04 | Retell AI | Forward Deployed Engineer, New Grad |

Earlier entries in this report that said 8 or 9 submits were reading the
attempt counter; this table is the one to trust.

## Where the night's 40 app-outcomes went (prioritisation data)

| n | outcome |
|---|---|
| 10 | **COMPLETED** (verified submission) |
| 7 | AMBIGUOUS_FIELD — "verification failed" |
| 6 | FAILED_BEFORE_CLICK — "field verification or upload did not pass" |
| 5 | navigation refused: duplicate employer URL (correct; auto-abandoned by triage) |
| 4 | FAILED_BEFORE_CLICK — "N required question(s) unanswered" |
| 2 | generic live fill refused: NAVIGATION_INCOMPLETE |
| 2 | REJECTED_AFTER_CLICK (employer refused the click) |
| 1 each | UNTRUSTED_FINAL_HOST · blocking captcha · unsupported ATS · msd/Merck slug (#280) |

**The dominant blocker is verification, not navigation: 13 of 40.** Tonight's
#271-#273 work removed two of the seven "verification failed" cases (both the
Ashby education block); the remaining five are each a different page
(Sanofi/Phenom fills reading back "(empty)", Google careers, Leidos phone type,
Merck how-did-you-hear). That is where the next session's leverage is, and the
two best-evidenced ones already have DOM-level write-ups here: #277 (Leidos
phone type) and #282 (Workday multiselect).

Note the 5 duplicate-URL outcomes are NOT waste to fix — triage abandons each
one automatically after the single cycle that discovers it (see the withdrawn
item in the 17:55 entry).

## 21:05 — queue refed

The backlog had fallen to 3 rows with ~2.4h of loop left, so I paused between
cycles and ran `discover --max-jobs 40` (the loop's own pass uses `--max-jobs
10`, which was yielding ~2 eligible). Backlog 3 → 7: Veeam Software, Amazon,
GigFinder.ai and Sanofi added; pause released immediately after. Board discovery
remains exhausted for the day — a 60-board sweep earlier enqueued zero, every
candidate being >24h old, non-US or outside role terms, all operator policy.

**Suggestion for the operator:** the loop's per-cycle `discover --max-jobs 10`
inspects 8-ish jobs and yields ~2 eligible, which does not keep a
one-app-per-cycle loop fed once the board registry is exhausted. Raising it (the
manual `--max-jobs 40` above produced 4 fresh eligible rows immediately) would
cost a little more time per discovery pass and keep the queue non-empty.

## 21:40 — #280 promoted to LIVE_READ_ONLY_CONFIRMED; my #282 suspect refuted

**#280 works live.** Cycle 57 (app e246ea07) resolved `jobs.merck.com` →
`msd.wd5.myworkdayjobs.com` and went *through* to the wizard fill and a field
brief. Before this fix that exact handoff was refused with `fill refused: stored
URL is for "msd", not Merck`. The refusal is gone from the run and nothing was
mis-filled, so #280 moves from FIXTURE_CONFIRMED to
**LIVE_READ_ONLY_CONFIRMED**.

And it immediately proved my prediction: with the gate no longer in the way, that
application is blocked by **#282** — `source--source: combobox option not
committed … scroll-harvested 18 option(s)`, `How Did You Hear About Us?` expected
"LinkedIn", page shows "(empty)". Second live occurrence, same tenant, same
field. #282 is now the single thing between us and Workday submissions.

**I then refuted my own #282 suspect, and corrected the write-up.** I had named
`locatorForField` resolving `source--source` to the `<label>` rather than the
input that shares the id. Testing it deterministically — loading the real 143KB
Workday snapshot into a fixture page and asking `locatorForField` what it returns
— gives `{"tag":"INPUT","id":"source--source","widget":"selectinput",
"inMulti":true}`: the correct input, so `isWorkdayMultiselect` is true there and
the locator is not the bug. The issues log now says so explicitly and points at
the wizard's own fill path (the failure is logged as `wizard fill error`) and at
which `expectedText` reaches that branch. Better a corrected handoff than a
confident wrong lead.

## 20:58 — adopted the new split gate; one gap to flag

`npm run test:gate -- <paths>` (commit b13c5f78) is now my gate step. First run,
on markdown-only paths: **heavy correctly did not run**, and fast finished in
**83s** for 109 files / 1007 tests — a big improvement on the 20-35 minute
whole-suite runs that cost the loop two pause windows earlier tonight.

**Gap worth flagging to the queen:** the automatic "re-run the failures serially,
only a second failure counts" rule is applied to the HEAVY project only, but the
FAST project is not immune to the same load-timeout class. That first gate run
reported `Test Files 1 failed | 108 passed` — `tests/unit/review-item-blocking.test.ts`,
failing on a cold `await Promise.all([import(...)])` inside a 5s default while a
live applier cycle was running. Re-run serially it passes **4/4**, and its
subject was last touched in `d5e1ad7d`, nothing from tonight. So `test-gate`
printed `FAILED` for a false failure and I had to do the serial re-verify by
hand. Extending the existing retry-once-serially logic to fast would make the
script's final line trustworthy in both projects.

### Gate + commit status

Gate not yet run: the queen held `artifacts/console/gate.lock` (taken
17:42). Waiting on it in the background per protocol, then pausing the loop
between cycles to gate solo — this box produces 8-13 false timeout failures
when the suite overlaps a live headed Chrome cycle, which is exactly what the
browser-launch tests did on the first pass. Typecheck is clean and every
targeted test file passes.
