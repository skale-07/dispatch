# Day31 — 2026-09-12

Operator directive (≈18:40 UTC): "reset the job queue and start applying to
jobs, once the job has been applied then run the gmail pipeline using a
separate cdp instance/chrome window to not interfere with the main job app
workflow. feel free to iterate on and fix any bugs/errors."

## Setup

- Queue reset through the state machine (`private/tmp-reset-queue-20260912.ts`):
  37 candidates, 35 → FAILED_FINAL. Kept: Merck 80338eb7 (applied by hand),
  Nominal 7c67a64c (UNCERTAIN submission, operator settles).
- Loop: `private/loop-day31.sh` (night30 shape) — `auto:cycle --backlog
  --defer-gmail` in the applier Chrome (9222); `outreach:worker --loop` in the
  dedicated outreach Chrome (9223, OUTREACH_CDP_URL). Pause file
  `artifacts/console/day31.pause`.
- Logs: `artifacts/console/auto-cycle-2026-09-12-day31.log`,
  `artifacts/console/outreach-worker-2026-09-12-day31.log`,
  `artifacts/console/day31-status.jsonl`.

Issue numbers continue from night30 (#269).

## Jobs

- **Job 1 — Lyft, Data Analyst Intern (Summer 2027)**, Greenhouse
  (534c47de, cycle 1): FAILED_BEFORE_CLICK — 1 required question unanswered
  → #270. Retry after the fix.

## Issues

### #270 — employment-history acknowledgement classified as veteran_status

- **Evidence:** `artifacts/ats-fill/greenhouse-live/live-executed-1789238799838.json`
  plan entry 16: "Please enter your relevant employment and military service
  above using the + Add Another Employment link." → `canonical_field:
  veteran_status`, `skip_empty` ("Profile value empty for veteran_status").
  Board API (`boards-api.greenhouse.io/v1/boards/lyft/jobs/8802198002?questions=true`):
  required `multi_value_single_select`, sole option "Thank you". The submit
  gate refused correctly.
- **Cause:** `matchCanonicalField` topic rule (#231) matched bare
  `\bmilitary service\b`, so an instruction about the work-history block
  took the demographic (sensitive-profile-only) path.
- **Fix:** "veteran"/"armed forces" still decide; "military service" maps
  to veteran_status only when the label does not mention employment / work
  history. The field now reaches the normal screener path (verbatim option
  choice). Demographic fields still never take the model path.
- **Tests:** `tests/unit/field-normalization-fallbacks.test.ts` —
  the Lyft label is not veteran_status; "Military Service Status" still is.

### #271 — Ashby education block: the school combobox took a screener-bank year

- **Evidence:** cycle 22, app 80e6a0fc (Commure,
  `jobs.ashbyhq.com/commure/62841aa1-…/application`),
  `artifacts/ats-fill/ashby-live/live-executed-1789246085713.json` +
  `form-snapshot-1789245428470.html`. Plan carried BOTH
  `_systemfield_education_history` → `screener:custom:education_history_year`
  = "2025" (label "Education History") and
  `_systemfield_education_history-school` → `school` = "Johns Hopkins
  University". Fill errors: `combobox option not committed: listbox opened
  after typing; no option matches "2025" (options: IRL HealthDEEP… |
  Fort Leavenworth Unified School District 207… )` — a YEAR typed at the
  school typeahead — and `-school: control not found on the page`.
  Cycle 19, app 04394211 (different Ashby tenant) parked on the same shape
  with `screener:custom:predicted:_systemfield_education_history` = "2025".
- **Cause:** the block is one `data-field-path="_systemfield_education_history"`
  wrapper. Only Degree and Field of Study carry their label's `for` id as a
  real element id; School's control is an id-less autocomplete. So
  `discoverAshbyAutocompletes` (#117) correctly rebuilt the school question
  as `<path>-school`, while the GENERIC pass independently addressed the same
  id-less input by the wrapper path (`fieldDiscovery.ts` pathId fallback) and
  labelled it with the group label. Two fields, one control, different
  canonicals — so #239's composite-parent collapse (which needs a shared
  canonical) never fired, and the group-labelled twin picked up a poisoned
  screener-bank entry.
- **Fix:** `ashbyDiscoverFields` now drops a generic field whose id is a
  wrapper path (bare or `path#N`) that a rebuild already owns. Claiming is
  restricted to NAMED `_systemfield_*` paths so a rebuilt autocomplete with
  a bare-uuid id (Sierra #117) cannot invent a path by chopping a uuid
  segment.
- **Tests:** `tests/unit/ashby-education-block.test.ts` over
  `tests/fixtures/ats/ashby/education-block.commure.html` (the real rendered
  DOM). Level: **FIXTURE_CONFIRMED**; live re-run pending (both apps
  requeued).
- **Open, operator:** the bank entry `screener:custom:education_history_year`
  = "2025" is poisoned (screener bank poisoning). No Ashby field can reach it
  now, but it would still claim a genuinely "Education History"-labelled
  question elsewhere. Not mutated here.

### #272 — Ashby education Start/End Date: four unfillable LLM-predicted selects

- **Evidence:** same artifacts. Plan entries
  `_systemfield_education_history#17`…`#20`, all labelled "Education
  History", two from `llm_predict` ("Profile facts list graduation in May
  2029") and two from the screener bank, values "May" / "2025". All four
  failed `control not found on the page (label "Education History") — failing
  fast instead of waiting 30s`, then verify reported 4 × `Expected …; page
  shows "(empty)"`. 12 brief items total; submit click blocked.
- **Cause:** Start Date and End Date are each a PAIR of id-less month+year
  `<select>`s inside a plain `<div id="…-startDate">` — the container owns
  the label's `for` id, the controls own nothing. The generic pass fell back
  to `path#N` (four id-less inputs in one wrapper), inherited the GROUP
  label, and the plan therefore treated a graduation date as an unmapped
  screener. Those synthetic ids resolve to nothing at fill time.
- **Fix:** `discoverAshbyEducationDates` in `src/ats/ashby/discovery.ts`
  rebuilds them as one field per `<select>` — id `<for-id>-month` /
  `<for-id>-year`, the page's real option list attached. New
  `src/ats/shared/educationBlock.ts` resolves those ids (and `-school`)
  against the wrapper: `[data-field-path=…]` → `input.ashby-application-form-input-autocomplete`
  for school, → `[id="…-startDate"] select` `.nth(0|1)` for month/year. It is
  the FIRST tier in `locatorForField`, so the ashby-local combobox/verify
  path and the delegated generic fill both get it. `fieldNormalization` maps
  the four by their structural id suffix (anchored on `education[_-]?history`
  in the id, so a work-history date pair can never take an education
  canonical) → `start_month`, `start_year`, `graduation_month`,
  `graduation_year` — all already in `SAFE_FACTUAL_CANONICALS`. No education
  control can reach the screener bank or the LLM any more.
- **Read-back:** `ashbyDiscoverFields` on the real 89KB live snapshot now
  yields 21 fields (was 22): the 5 bad entries (`path`, `#17`–`#20`) gone,
  4 correct date fields added, School required, Degree/Field of Study/Still
  Student unchanged.
- **Tests:** `tests/unit/ashby-education-block.test.ts` (11 cases).
  Level: **FIXTURE_CONFIRMED**; live re-run pending.

### #273 — a factual year the page does not offer must be skipped, not substituted

- **Evidence:** same snapshot. BOTH education year `<select>`s stop at
  **2027** (`Year...|2027|2026|2025|…|1908`) while the candidate graduates in
  **2029**. That is why the poisoned bank/predict answer was a plausible-
  looking "2025": 2029 was never selectable. Requiredness read off the real
  DOM: only `School` carries `_required_f7cvd_91` — Degree, Field of Study,
  Start Date and End Date do not.
- **Cause:** nothing checked a factual date value against the control's own
  option list, and the combobox ladder has a "class fallback" that picks a
  nearby option when a stored answer is not offered. On a graduation year
  that would misstate a fact on a real application.
- **Fix:** in `resolveAnswers`, an education DATE canonical
  (`graduation_month|graduation_year|start_month|start_year`) on an
  option control whose harvested options do not offer the value is
  `skip_empty` with the real reason (`page does not offer "2029" for
  graduation_year — not substituted`) — never traded for a nearby option and
  never predicted. Month comparison tolerates only the form's own spelling of
  the SAME month (full name vs 3-letter, any case). Also: `graduation_year`
  no longer composes "May 2029" when the control is a PURE year list (the
  seasonal-combobox rule from before still applies elsewhere).
- **Net effect on this form:** School / Degree / Field of Study / Start Date
  (August 2025) / End Date month (May) fill; End Date year is skipped and the
  page does not require it, so the page's own required-completeness scan is
  the only thing that can block. The remaining required item on Commure is
  the transcript upload — `private/candidate/transcript.pdf` exists and
  `attachSupplementalMaterials` runs in `submitRun`, which this app never
  reached.
- **Tests:** same file. Level: **FIXTURE_CONFIRMED**; live re-run pending.

### #275 — Workday "Autofill with Resume" route (operator experiment)

- **Directive (2026-09-12, relayed by the queen):** "on Workday tenants,
  experiment with Workday's OWN 'Autofill with Resume' path instead of always
  clicking 'Apply Manually'. Upload the resume, let Workday parse it into the
  form, then have our fill pass only REVIEW the pre-filled values and fill
  what is missing or wrong. Compare the two routes on real jobs — time to
  submit, fields we had to touch, verification mismatches, submit rate — and
  report which is more efficient and accurate, per tenant if it differs."
- **Implemented:**
  - `workdaySelectorsV1.applyMethods` gains `autofillFileInput`,
    `autofillDropZone`, `autofillUploadedItem`, `autofillContinue` — in the
    versioned registry, nothing inline.
  - `PortalAuthSeams` gains `workdayRoute?: "manual" | "autofill"` and
    `resumePath`. `openWorkdayApplyChooser` takes the route;
    `clickAutofillWithResume` clicks the method, sets the resume on the
    (CSS-hidden) file input, and polls ≤45s for the account form, the SSO
    chooser, or the wizard, recording the elapsed parse time in the notes.
  - `runAtsLiveFill` gains `workdayRoute`; only the CHOOSER call site uses it
    (the re-auth and mid-walk `authenticateAtsPortal` calls are past the
    chooser). Every Workday run now notes `workday apply route: … (#275)`.
  - CLI: `ats:fill --workday-route manual|autofill`, validated, default
    `manual`. Documented in `docs/operator-guide.md` §ats:fill with the
    per-job comparison checklist.
- **Guardrails honoured:** the plan-driven fill and `verify` run UNCHANGED
  over the pre-filled form, so a parsed value that disagrees with the approved
  plan is corrected and never accepted; work authorization / sponsorship / EEO
  resolve from the plan or the sensitive profile exactly as before and are
  never read from the parse; `assertExecutableApprovedEntry` and submit gating
  untouched; SSO choosers still take "Sign in with email". The autofill leg is
  tried ONCE and always degrades to Apply Manually with the real reason, so
  the manual path stays reachable on every tenant and `manual` stays the
  default everywhere including `auto:cycle`.
- **Tests:** `tests/unit/workday-apply-route.test.ts` — 6 cases over a routed
  Workday-host page: default = Apply Manually and never autofill; the autofill
  route clicks the method and the page really receives the file (asserted from
  inside the page) and reaches the account form; and three degradation shapes
  (no autofill control on the tenant, resume not on disk, no resume path).
  Level: **FIXTURE_CONFIRMED**.
- **Live comparison: NOT RUN — no supply.** There are **zero** Workday
  applications in the database (`applications ⨝ jobs` filtered on
  `source_ats LIKE '%workday%' OR normalized_application_url LIKE '%workday%'`
  returns no rows), and none in tonight's backlog (Klaviyo, CTGT, Amgen ×2,
  Athelas, Commure ×2, AfterQuery, Perpay, Abridge, Merck — all JobRight/board
  postings that resolve to Ashby/Greenhouse-class ATSes). The comparison
  therefore stands at **UNVERIFIED** and cannot be promoted from a fixture.
  What it needs: Workday postings in the queue (`discover:ats` against a
  registry of Workday tenants, or the operator queueing a few
  `*.myworkdayjobs.com` URLs), plus a tenant account, since the route sits
  behind the same account wall as the manual one. Amgen is a plausible Workday
  tenant and both Amgen rows are still QUEUED — if either resolves to a
  Workday host, that is the first comparison pair.
