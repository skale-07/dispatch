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
