# Night29 issues log — 2026-09-10 (operator asleep, autonomous)

Operator directives for the night (03:55 / 04:05 UTC):

1. Reset the current application queue, then start applying.
2. Prioritise Lever / Ashby / Greenhouse and similar short forms over
   Workday and other long-form apps — but still apply to the long ones.
3. Use Gmail when a verification code/link is needed; run the Gmail
   pipeline after every submission. Subagents may run that pipeline in a
   NEW Chrome CDP instance so it does not interfere with the applier.
4. "Where did you find this job": after a few retries, default to Other →
   type LinkedIn.
5. Keep the resume logic and the other existing logic.
6. Iterate the infrastructure, but never overfit to one application —
   always the general solution. The LLM agent owns what a deterministic
   system cannot decide; experiment with the deterministic/agent split for
   speed.
7. Operator is away; no questions, no prompts.

Numbering continues from night28 (last issue: #229).

---

## Start-of-night state (04:00 UTC)

- Queue reset through the state machine: 20 rows (9 QUEUED, plus parked
  AMBIGUOUS_FIELD / AUTH_REQUIRED / CAPTCHA_REQUIRED /
  SUBMISSION_VERIFICATION_FAILED and week-old strays) → FAILED_FINAL with
  reason "operator: queue reset 2026-09-10 (night29 start)".
  Script: `private/tmp-reset-queue-20260910.ts`.
- Open MANUAL review items dismissed (`review:bulk --action dismiss`).
- No node processes were left running from day28; CDP Chrome was closed.

## Issue #230 — supply: the board registry is now refreshed from public listing feeds

**Symptom.** Immediately after the reset, a sweep of the curated 47-board
registry enqueued **2** applications (Replit, Roblox). Everything else was
rejected as older than 24h (operator policy 2026-09-08). A hand-built
probe of 120 more candidate board slugs
(`private/tmp-probe-boards-20260910.ts`) found exactly **1** fresh posting:
most guesses were 404s, because a company's board token is not derivable
from its name (`greenhouse:snowflake`, `lever:netflix`, `ashby:xai` — all
404).

**Cause.** The registry was a hand-maintained list. It goes stale the
moment a company's hiring moves, and it can only ever contain boards
someone thought to add.

**Fix.** `private/tmp-refresh-boards-from-feeds.ts` reads the public
internship-tracker listing feeds (SimplifyJobs Summer2027 /
Summer2026 / New-Grad-Positions, vanshb03 mirrors —
`.github/scripts/listings.json`), keeps postings that are active, visible,
recent, role-fitting (the registry's own `role_terms` / `exclude_terms`)
and not confidently non-US, then extracts the **board token** out of every
Tier-1 apply URL it points at and merges those boards into the registry.
A board's token is unambiguous in its own apply URL, so this discovers
tokens instead of guessing them.

Nothing downstream changes: `discover:ats --registry` still applies role
terms, the US gate, the 24h policy and the per-board cap. The lookback for
*registry membership* is 168h (a board that posted yesterday will post
again today); the 24h gate on *applying* is untouched.

`MAX_BOARDS_PER_RUN` raised 50 → 150 in `src/discovery/atsDiscovery.ts`:
with 115 boards a 50-cap silently starved everything past the cut, and one
board is a single 500ms-throttled GET. The real spend limiter is
`max_new_applications`.

**Result.** 47 → 115 boards (68 added, 22 of them carrying <24h postings).
The next sweep enqueued **20** applications, every one of them
Lever/Ashby/Greenhouse — the operator's priority tier.
LIVE_READ_ONLY_CONFIRMED (real board APIs, real queue rows).

## Issue #231 — required EEO self-ID questions matched nothing (and the ordering trap)

**Symptom.** Smartly.io (greenhouse, cycle 2) withheld the submit on
`What gender do you identify as?*` and `Are you a person with a
disability?*` — both REQUIRED, both left blank.

**Cause.** The demographic mapping was phrase-shaped, not topic-shaped.
`answer-aliases.json` held bare "Gender" and "Do you have a disability",
and the only gender rule in `matchCanonicalField` keyed on a Greenhouse
`eeo[gender]` CONTROL NAME that this board does not use. The operator's
encrypted sensitive profile has every one of these values on file (gender,
race, veteran, disability), so the answers existed and never reached the
form.

**Fix.** Three topic recognisers in `matchCanonicalField` — gender,
disability, veteran — matching the self-ID topic rather than one board's
wording. Widening is safe here specifically because a demographic
canonical is the most restrictive destination in the system: the value can
come ONLY from the operator's own encrypted sensitive profile, nothing is
inferred or defaulted, and no value on file still means skipped. A false
positive costs a skipped field, never an invented answer.

**Regression caught live, same night — the ordering is load-bearing.**
The first version put the topic rules ABOVE the `eeo[...]` control-name
rules. Two Crest Industries (lever) apps immediately parked
AMBIGUOUS_FIELD with `verify:gender` on `field_id: eeo[race]`: Lever's EEO
block hands the RACE control a label that begins "Gender Select ... Male
Female Decline to self-identify". Read as a label it is a gender question;
its control NAME says race. The name is the fact. The topic rules now sit
BELOW every `eeo[...]` name rule and only see what the names left
unclaimed. The system caught this itself — read-back verification
mismatched and the submit was blocked, so nothing wrong was submitted.

Tests: field-normalization-fallbacks 21/21, including a case asserting
that a control named `eeo[race]` with a gender-shaped label stays
`race_ethnicity`. UNIT_CONFIRMED; live proof is Smartly.io's requeue.

## Issue #232 — the submit gate named its blocker "(unlabeled)"

**Symptom.** CIM Group (lever, cycle 3): "Refusing to click submit: 1
required question(s) unanswered — (unlabeled) [text]". The review item and
the stop reason identified no question at all.

**Cause.** Lever's custom "card" questions put their text in a SIBLING
`div.application-label > div.text` and wrap nothing, so
`scanRequiredCompleteness`'s label lookup (label[for] / aria / wrapping
label / legend) found nothing. Worse, the scan dedupes by label, so
several such controls collapse into one row.

**Fix.** When the direct lookup fails, climb up to four ancestors looking
for a labelling element (label, legend, [class*=label], [data-qa*=label]),
with the same unambiguity guard the widget path already used: exactly one
candidate means it belongs to this field, two or more means we climbed out
of the container — stop rather than borrow a neighbour's question and its
required asterisk.

(The underlying block for CIM Group is unchanged and correct: the question
is "What are your salary expectations?", and salary is review_required by
policy — never model-answered. The fix is that the refusal now says so.)

Tests: required-completeness 20/20, incl. a Lever-card fixture and an
ambiguous-container fixture. FIXTURE_CONFIRMED.

## Issue #233 — Gmail tail can run in its own Chrome (operator directive)

Operator: run the Gmail pipeline "in a NEW chrome CDP instance/window that
way it doesn't interfere with the application pipeline".

- `OUTREACH_CDP_URL` (new, plain endpoint setting — GMAIL_DRAFTS_ENABLED
  still gates whether any draft is written). Unset ⇒ byte-identical
  previous behaviour.
- `npm run chrome:debug:gmail` starts a second debug Chrome on 9223.
  Copying the applier's profile is impossible while it runs (Chrome holds
  `Default\Network\Cookies`; fs.cpSync dies EBUSY on the one file that
  matters), so the launcher instead reads the cookies out of the RUNNING
  applier browser over CDP and injects them into the new one.
- `resolveGmailCdpUrl()` picks the dedicated browser only when it is
  reachable AND actually signed into Gmail, memoized per process.

**Live result tonight: it falls back, by design.** 774 cookies transferred
cleanly, but Google binds its session to the profile, so the second Chrome
landed on the account chooser ("Shubham Kale — Signed out"). Reachable is
not usable, and preferring it would have silently broken every draft. The
sign-in probe catches exactly that, returning

    url: http://127.0.0.1:9222, dedicated: false,
    note: "dedicated gmail Chrome at http://127.0.0.1:9223 is reachable
           but not signed into Gmail — using the applier browser (sign in
           once in that window to enable it)"

So the Gmail tail keeps running on the applier browser tonight (which is
what produced drafts all evening), and the moment the operator signs in
once in the 9223 window it switches over with no further change.
LIVE_READ_ONLY_CONFIRMED for the resolution + fallback.

## Issue #234 — a required upload question was labelled "Attach", so a real submit was spent

**Symptom.** Lexington Medical (greenhouse, cycle 4) and Amperesand
(cycle 7) both ended "UNCERTAIN — Submission not confirmed within 15000ms"
with the page still on the job URL. The receipt screenshot shows the form
fully filled with one red error: "Do you have a portfolio of your
engineering work (e.g., CAD drawings, design projects, lab reports, or
other technical work)? If so, please attach it here or provide a link."

**Cause.** The board's own schema declares that question REQUIRED (the
schema diff logged "3 declared-only (2 required)"), and the pre-click gate
promotes a declared-required question only when the DOM label matches the
declared one. Greenhouse renders a file question as Attach / Dropbox /
Google Drive buttons around a hidden input, so the DOM label read
"Attach" — which matches nothing. Nothing blocked, the click went through,
the page's own validation bounced it, and a submit from the unattended cap
was spent on an UNCERTAIN outcome that needs human adjudication.

**Fix.** Upload chrome is never a question. An anchored whole-string list
(attach, upload, choose file, browse, dropbox, google drive, drag and
drop, …) is skipped both as a direct label and as a competing candidate
during the container climb, so the real question text is reached. Anchored
whole-string deliberately: a genuine question that merely mentions
attaching ("…please attach it here or provide a link") is untouched.

This does not make an unanswerable question answerable — Lexington Medical
genuinely wants a portfolio file. It converts a spent submit and an
UNCERTAIN state into a precise, named refusal before the click.

Tests: required-completeness 20/20, incl. a Greenhouse attach-widget
fixture and a no-declared-list case proving nothing new blocks on its own.
FIXTURE_CONFIRMED.

## Issue #235 — a required checkbox GROUP the page could answer itself was skipped

**Symptom.** DV Trading (greenhouse) twice, cycles 8 and 9: "Refusing to
click submit: 1 required question(s) unanswered — Undergrad Discipline(s)
* [checkbox_group]". The plan entry read
`action: SKIP, reason: "No answer-alias mapping"`.

**Cause.** `isCaptureWorthyQuestion` requires a checkbox label to carry a
"?" or an imperative ("please select", "do you", "I agree") before it may
reach the screener/predict tier. That rule exists to keep individual
option checkboxes ("Electrical Engineering") out of the queue. "Undergrad
Discipline(s)" is a noun phrase, so it was rejected — even though the
board declares it required and publishes its full option list, which
contains "Applied Mathematics", "Statistics" and "Economics", the
operator's actual majors.

**Fix.** An option checkbox has no option list of its own; the GROUP does.
That structural fact is exactly what the phrasing heuristic was reaching
for, and it is exact where phrasing is a guess. A checkbox control
carrying 2+ options is a question whatever its wording. Everything
downstream is unchanged: the answer must still survive
validatePrediction's verbatim option-membership check, and demographic
groups were already excluded upstream.

Tests: greenhouse-checkbox-groups 12/12, incl. the group-with-options
case, the no-options case (unchanged phrasing rule) and a demographic
group with a full option list still excluded. UNIT_CONFIRMED.

## Issue #236 — a correctly-filled Yes/No group verified as `true`

**Symptom.** Three Rocket Lab (greenhouse) applications parked
AMBIGUOUS_FIELD on `Expected "No"; page shows "true"` for "Are you a
participant of the following scholarship, fellowship…".

**Cause.** The FILL decides option-vs-state with
`isCheckboxBooleanValue(value) && !multiMember` — a MULTI-member group
takes the option path even for Yes/No, so "No" checks the NO member. The
READ-BACK tested only the first half and reported `loc.isChecked()`.
Whether that read `true` or `false` depended on which group member the
field locator happened to resolve to; on these forms it resolved to the
member the fill had just correctly checked. An existing test passed only
because its locator happened to land on the OTHER member.

**Fix.** The read-back makes the same decision the fill makes.

Tests: greenhouse-checkbox-groups 13/13, with a new case that pins the
locator to the CHECKED member — the arrangement that was failing live.
FIXTURE_CONFIRMED.

## Issue #237 — a directory typeahead refused its own namesake

**Symptom.** Saronic (ashby), twice: the required education "School" field
stayed empty. `combobox option not committed: ambiguous match for "Johns
Hopkins University" (3 candidates)`.

**Cause.** Ashby's school control is a typeahead over a school DIRECTORY,
and every row concatenates the name with its country and domain:

```
Johns Hopkins UniversityUnited Statesjhu.edu
Johns Hopkins University School of Advanced International StudiesUnited Statessais-jhu.edu
Johns Hopkins University SAIS Bologna CenterItalysais-jhu.edu
```

All three contain the query, so the substring filter called it ambiguous
and refused — for every namesake school, on every directory-backed
typeahead.

**Fix, and the first attempt that was wrong.** "Shortest match wins" is
the obvious rule and it is wrong: it picks "Baltimore, County Cork,
Ireland" over "Baltimore, Maryland, United States", and resolves the
fragment "United" to a country. Two existing tests caught it immediately.

The real tell is WHAT FOLLOWS the query. A row that continues with a space
or a comma is still saying the name ("Johns Hopkins University| School
of…", "Baltimore|, County Cork"); a row that continues with a glued
alphanumeric character has ended the name and started concatenated
metadata. So the query must be a whole-name prefix of exactly ONE row,
with the rest glued on — anything else stays an honest refusal.

Tests: combobox-fill 46/46, including the namesake case, a same-length tie
that still refuses, the two places sharing a name, and a query that names
the LONGER school. UNIT_CONFIRMED.

## Issue #238 — the #229 settle paid three full gates to learn nothing

The unknown-landing settle re-gated three times, 1.5s apart. A gate is the
expensive read in that loop, and a landing that is genuinely not a form —
the common case — paid all three for nothing (it blew a 45s test budget on
a fixture). "unknown" means classifyPage counted zero fields, so the only
thing worth waiting for is CONTROLS appearing: poll that cheaply, and
spend a re-gate only once something mounted. Behaviour on a late-mounting
SPA is unchanged.

## Issue #239 — one datum, two ids, one hard failure

**Symptom.** Three Saronic (ashby) applications died on
`_systemfield_education_history-school: control not found on the page
(label "School")`.

**Cause.** Ashby's education block exposes ONE datum through two ids: the
widget `_systemfield_education_history` ("College/University") and a child
input `…-school` ("School"). Both map to canonical `school`. The widget
fills; by the time the fill reaches the child, the block has re-rendered
into its committed state and the child id is gone.

**Fix.** A child id scoped under an earlier control's id, carrying the SAME
canonical, is the same question asked twice by one composite widget —
answered once, through the parent. It needs BOTH signals, so two genuinely
different fields can never collapse into one.

Tests: composite-control-duplicate 3/3 (including same-canonical-but-
unrelated-ids and id-scoped-but-different-datum). UNIT_CONFIRMED.

## Issue #240 — the page's own rules decide whether an application is complete

**The biggest single lever of the night.** Applications were being
abandoned over a plan-vs-page difference about a control the page itself
was content to leave EMPTY:

- Saronic — the phantom child control above
- Barnes & Thornburg — a phone entry whose locator resolved to a radio
  group, so nothing was typed anywhere
- ICD Portal — an essay textarea that read back empty

In each the form satisfied its own validation. Only our plan disagreed
with the page, and the disagreement was always "we wanted to write
something here and did not". Blocking there costs a finished application
and buys nothing: `scanRequiredCompleteness` already checks every required
question against three independent sources (DOM required, asterisk, board
schema), and it is the authority the page itself uses.

So the completeness scan decides. A control it does not require, showing
nothing, is a note on the report — not a stop.

**It fails closed on every axis that matters**, and the tests pin the
refusals as hard as the waivers:

- a mismatch where the page holds a DIFFERENT non-empty value still
  blocks — that is exactly what verification exists to catch;
- an upload miss is never waivable;
- a fill error is waivable only when its own message proves nothing was
  written (control not found, option not committed, value refused before
  typing). Anything else could have left a stray value on a control
  outside the plan, which verify cannot see;
- a page painting its own validation error blocks;
- a completeness scan that did not run blocks.

Nothing fills, approves or invents a value. The approved-plan gate,
SUBMIT_ENABLED and the operator confirmation are untouched — what changes
is only which side of "complete" a page-empty control lands on. Every
waived field is named in the run report, so a submit that went through
with gaps stays auditable.

Applied at BOTH gates through one shared helper
(`src/applications/pageCompleteWaiver.ts`). The submit gate was the obvious
place and the wrong one on its own: most of tonight's losses never reached
submit, because a fill-stage verify miss parks the application
AMBIGUOUS_FIELD three steps before the click.

Tests: page-complete-waiver 10/10, ats-live-fill 20/20. UNIT_CONFIRMED
plus the live evidence that motivated it.

## Issue #241 — a requeued application could not be picked again

Two separate holes, both live tonight, both costing the exact apps that
were requeued to prove a fix.

**The picker and the pipeline disagreed about what a review item means.**
`runPipeline` has treated "Answer needed: …" and completeness-gate
leftovers as ADVISORY since night19 (#29) — they want an answer, they are
not a full stop — but `pickNextApplication` blocked on ANY open item. So
an application the pipeline would happily continue could never be handed
to it. Live: 5 of 20 QUEUED rows unreachable while the loop re-picked the
same two failing Workday/generic apps cycle after cycle. Both layers now
use one definition.

**The LLM triage's park outlived `retry --app`.** Triage opens "Triage:
operator decision needed …" when it parks an app; nothing cleared it, so
an application explicitly returned to QUEUED stayed unreachable forever.
A requeue IS the decision the park was waiting for, so the requeue clears
it — while it stands, it still stops the loop.

Backfill: the five stuck parks were dismissed through the resolver so
tonight's fixes could actually be re-tested.

Tests: review-item-blocking 3/3, pinning that real walls (AMBIGUOUS_FIELD,
CAPTCHA_REQUIRED, AUTH_REQUIRED, UNSUPPORTED_ATS) and unrecognised MANUAL
items still block. UNIT_CONFIRMED.

## Issue #242 — twelve submits, zero Gmail drafts (the outreach chain had no contact source)

**Symptom.** Twelve verified submits by 06:00 UTC and ZERO Gmail drafts,
against the operator's standing directive to run the Gmail pipeline after
every submission. Every tail ended
`Cannot resolve stored job: Application <id> has no JobRight job id`.

**Cause.** Outreach reaches people through JobRight's insider panel, which
is keyed to a JobRight JOB. Every submission of the night was
board-discovered, so none had one, and #207's fallback — borrow any STORED
JobRight job of the same employer — had nothing to borrow: under the 24h
posting policy the JobRight feed now contributes almost nothing, so the
companies we apply to have never appeared in it. The gap was not partial;
it was total, and it widens as board discovery carries more of the supply.

**Fix.** JobRight's own search resolves any employer.
`/jobs/search?value=<company>` returned 373 results for "Rocket Lab" —
including the very intern postings this run had just applied to through
the board. One search yields a JobRight job id, which is all the insider
panel needs. Read-only against JobRight (a navigation and a DOM read, no
clicks on cards, nothing applied to); the only write is a local `jobs`
row, so the NEXT lookup is the deterministic stored-twin path again.

A result card is accepted only when the company occupies the card's own
company slot ("…Intern Summer 2027Rocket Lab/Aerospace · …"), never
because the text merely mentions the employer — otherwise every
"competitor to Rocket Lab" posting would qualify.

**Company naming needed the same care.** Two catalogues spell one employer
differently ("Rocket Lab USA" on the board, "Rocket Lab" on JobRight) —
and so does our own database: a boards sweep wrote "Rocket Lab USA" at
04:35 and "Rocket Lab" at 06:05 from two registry entries for one board,
which made a twin stored minutes earlier invisible to
`findCompanyTwinJob`'s exact match. Both now compare through variants that
equate ONLY legal-entity and country tails (Inc / LLC / Ltd / Corp / USA /
a .io suffix). Words that DISTINGUISH employers are never stripped, so
"Verkada" still never reads "Verkada Partners" — the discipline that
function was written for is intact, and the tests pin it.

**Live proof** (Rocket Lab, application 244d11bf):

```
company twin (#242): JobRight search resolved Rocket Lab USA
  -> 6a84cdbbd34f700f87fbb2e8
insider triage: 8 people checked, 3 emails found
3 generated, 3 Gmail drafts saved (2 read-back verified)
```

LIVE_MUTATION_CONFIRMED. Drafts only — nothing is ever sent.

**What the backlog then produced, and why the number is right.** After the
twelve terminal marks were cleared, the worker re-ran them all: Rocket Lab
found 3 insiders on each of 5 applications and DV Trading 1 on each of 2,
but only **4 drafts** were written — to 4 distinct people. That is #214
working: one person gets one email per company per window, so the four
duplicate Rocket Lab applications and the second DV Trading application
correctly skipped people already drafted. Saronic, Lexington Medical and
Smartly.io are simply not listed on JobRight, and the tail says so.

Tests: company-search 7/7 (company-slot matching, the "mentions the
company" rejection, id parsing, role recovery, qualifier variants, and the
"Verkada Partners" guard). UNIT_CONFIRMED + LIVE_MUTATION_CONFIRMED.

## Issue #243 — one control, N plan entries

**Symptom.** Shield AI (lever): the fill logged the SAME refusal 6 times
for "Which degrees have you already completed" and 9 times for "Are you a
member of any of the following student groups", and the canonical grew on
every pass (`screener:custom:predicted:cards[…]:cards[…]`).

**Cause.** Lever renders a multi-select question as N checkbox inputs that
all share ONE control name, and discovery emits one field per MEMBER — so
the plan carried 6 and 9 identical entries (same id, same label, same
planned answer) and the fill attempted the identical write once per
member.

**Fix.** Two fields with the same id are the same control by definition:
the first entry owns it, the rest are skipped by name. The checkbox-group
fill already picks the right member out of the group, so nothing about how
the question is ANSWERED changes — only how many times it is attempted.

Tests: composite-control-duplicate 4/4. UNIT_CONFIRMED.

## Note — the #240 waiver is refusing for the right reason

Cycles 48–52 all ended AMBIGUOUS_FIELD with the waiver declining, and the
reason it recorded was correct every time:

```
page-complete waiver not applied: page requires 2 unanswered question(s)
page-complete waiver not applied: page requires 1 unanswered question(s)
```

Those pages genuinely still want an answer, so the waiver is doing its
job. The remaining blocker on that class is the ANSWER, not the gate —
Shield AI's required "Which degrees have you already completed" got a
predicted value ("I have not yet completed…") that matches no option on
the page. Worth a session with a solo gate: when a checkbox group's
options are known, a prediction that matches none of them should be
rejected at plan time rather than refused at fill time.
