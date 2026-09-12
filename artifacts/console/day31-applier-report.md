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
3. **Cycles burned on duplicate postings**: cycles 36-38 all ended
   `navigation refused: duplicate employer URL`. The dedupe guard is correct
   (same posting, per the per-posting policy) but the picker is handing the
   loop rows it will always refuse.

### Open walls not yet fixed

- Cycle 24 (5818f1ce, Sanofi/generic) and cycle 34 (1ba9bebc) —
  `AMBIGUOUS_FIELD`, fills reporting "(empty)" after write on a Phenom-class
  page. Not diagnosed yet.
- Cycle 39 (d5917b41, `careers.amgen.com`) — reached READY_TO_SUBMIT but
  `0 file inputs on page`, so the resume never attached and the submit gate
  refused correctly. The upload control is presumably behind a step the walk
  does not open.
- Cycle 33 (54a4667a) — `CAPTCHA_REQUIRED`, genuinely operator-blocked.

### Gate + commit status

Gate not yet run: the queen held `artifacts/console/gate.lock` (taken
17:42). Waiting on it in the background per protocol, then pausing the loop
between cycles to gate solo — this box produces 8-13 false timeout failures
when the suite overlaps a live headed Chrome cycle, which is exactly what the
browser-launch tests did on the first pass. Typecheck is clean and every
targeted test file passes.
