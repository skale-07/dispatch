# Overnight issues — 2026-09-02 (applier, queen-orchestrated fleet)

Continues numbering from 2026-09-01 (#146 last). Session log:
`artifacts/console/auto-cycle-2026-09-02.log`.

## Milestone 0: bank the #145-#146 batch

- Reviewed the uncommitted diff (7 files). It also carried **#145c**
  (`walkSectionEditors`: one-editor-at-a-time cycle open → fill → save,
  written after run 16 showed only ONE editor ever opens because UKG
  disables every other pencil while an editor is open). Two defects found
  by review before the gate: `atsLiveFill.ts` called `walkSectionEditors`
  without importing it (typecheck would fail) and still imported the
  now-unused `openSectionEditors`/`saveOpenSectionEditors`. Fixed.
- #145c had no test — added a fixture test (two editors that disable each
  other's pencil while open; asserts each fill sees exactly ONE editor's
  controls, both saved, Delete never clicked). 7/7 generic-form-advance,
  10/10 label-collision.
- Run 16 artifact (live-executed-1788308592017.json, real UKG url): 14
  filled (names, phones, full address, relocation, how_heard, sponsorship,
  work-auth, gender), resume upload verified, PreferredName/FormerName
  skipped fast as readonly (#146 CONFIRMED live), verify accepted them in
  place. Still failing: Skills typeahead, work_style / motivations selects,
  EthnicOrigin — all inside editors that never opened ("opened 1 editor").
  That is exactly the #145c wall; run 17 is the first to exercise it.

## Job: 4e47f9ae Barbacane, Thornton & Company — IT Intern, AI & Automation (UKG Pro)

Pre-run-17 review of run 16's artifact surfaced two general walls that
#145c would have hit immediately; fixed before spending a live run:

- **#147 hidden-control fast-skip** (src/ats/greenhouse/fill.ts): with
  #145c the base plan now runs with every editor CLOSED, so the ~8 hidden
  phone/address text inputs would each burn fill()'s 30s timeout (4 min >
  the 240s app deadline). id/name locator tiers resolve hidden controls
  exactly (no visible filter), so after resolution any non-checkbox/radio/
  file control gets 1.5s to paint, else is SKIPPED with the real reason
  ("control is not visible (collapsed section or unopened editor)"). No
  regression surface: fill()/selectOption()/click() already required
  visibility, so nothing that used to fill can stop filling. Fixture test
  (hidden line1 skipped <10s, visible City still fills). First version of
  the guard keyed on the visibleOnly ladder and was a silent no-op — the
  suite's own #147 test caught it (30.4s) before commit.
- **#148 contact twins / Address 2 / hispanic hint**
  (src/applications/fieldNormalization.ts): run 16 typed the primary phone
  into "Secondary Phone", the street into "Address 2" (bare "Address"
  alias), and left the Hispanic/Latino select ("Ethnic Origin", id
  HispanicOrigin) unmapped although the sensitive profile has the value.
  Now: secondary/alternate/additional twins of phone/email/address/linkedin
  stay unmapped; `Address 2`/`Street Address Line 2` shapes map to
  address.line2 (profile empty ⇒ skipped); a `hispanic` id/name maps to
  hispanic_latino (sensitive-profile path only; race keeps its own). 3 new
  unit tests, 21/21 in the two normalization files. UNIT_CONFIRMED.
- **#145d stuck-editor release** (src/applications/genericFormAdvance.ts):
  an "Add Work Experience"/"Add Education" editor whose Save the section's
  own validation refuses (required Employer/School we cannot fill) stays
  open — and on UKG every other pencil is then disabled and the page
  submit blocked, so one refused Save wedges the whole walk. After the
  save step the walker checks whether the save control is still visible;
  if so it records the page's validation text (`readPageValidationErrors`)
  in the notes and clicks the editor's Cancel to release it. The section
  keeps its previously saved state; nothing is invented. Fixture test
  (refused Save → "page says: Employer is required" → Cancel → next editor
  saves, all pencils re-enabled). 8/8 generic-form-advance.
  FIXTURE_CONFIRMED.


### Run 17 (4e47f9ae, UKG Pro) — fill LIVE_MUTATION_CONFIRMED, submit refused

Artifacts: `artifacts/ats-fill/generic-live/live-executed-1788357755523.json`
(real UKG url), `artifacts/applications/4e47f9ae-.../submission/submit-run-7-1788358285974.json`
(FAILED_BEFORE_CLICK, 13 verify mismatches). Fill stage: 74 filled; #147
hidden fast-skips, #148 hispanic_latino filled from the sensitive profile,
#145c editor cycle and #145d Cancel release all fired live. What refused:

1. Uploading the resume renders UKG's **resume-review page** (same URL):
   every parsed row in ONE form (5 work-experience rows, education,
   contact) with `save-button` "Save and continue" / `cancel-button`.
   Save was refused — "Please select a state/province." Probe
   (`private/tmp-probe-review.ts`): `State` (label "State / Province",
   required) has 1 option until Country is chosen, 59 after. The plan is
   built from pre-fill HTML, so the dependent select never had an answer
   space (→ #149). #145d then released the editor via Cancel, which
   DISCARDED the whole review page, leaving Country/State empty.
2. The parsed rows were re-answered from the ONE profile job: bare
   "Company"/"Organization" in rows 1-4 → current_company, bare "Month" →
   graduation_month (reverse containment) and row 0's start month was
   overwritten Aug→May; "Job Title" bank entry typed into rows 1-4; row 0
   title/employer kept in place by the fill but the plan's expected values
   differ from the parsed ones → submit-stage verify mismatches (→ #150).
3. Skill-level selects (×38) answered "Some Knowledge" by predict — non-EEO,
   allowed.

- **#149 dependent (revealed) selects** (NEW `src/ats/shared/dependentSelects.ts`,
  wired in `src/applications/atsLiveFill.ts` after the base fill and inside
  `fillCurrentGenericPage`): one bounded pass (cap 6) over the page's
  visible native selects still at their placeholder that now offer a real
  option list; label → public-profile canonical (aliases), value must match
  an option verbatim (`pickOptionLabel`), read-back verified, appended to
  `fill.filled`. Never demographics, never screener/LLM, never re-picks an
  answered select; unmatched value ⇒ note "offers no option for the profile
  value — left for review". Fixture test: State picks Maryland after
  Country; Country/Gender/how_heard/hidden untouched; Ontario/Quebec list
  ⇒ no pick + note. 3/3. FIXTURE_CONFIRMED.
- **#150 history rows are the resume's own data** (three general pieces):
  (a) `historyGroupOf` (`fieldNormalization.ts`) reads the row index and
  group kind from id/name (`NewWorkExperience_JobTitle3`,
  `job_application[educations_attributes][1][...]`; Greenhouse
  `answers_attributes_N` and Lever `cards[..][fieldN]` are screeners, not
  history). Singular history facts (current_company/current_job_title/
  school/degree/major/gpa/graduation_*/start_*) never claim row ≥ 1, and
  an education fact never claims an employment row (bare "Month" in
  FromMonth0 → null instead of graduation_month). (b) `buildFillPlan`
  (`resolveAnswers.ts`): a history-row control that already holds a real
  value is skipped "already holds … (resume parse) — kept"; rows ≥ 1 never
  take a bank/predict answer (the profile holds one entry). (c) The plan
  could not SEE held values: `page.content()` serializes attributes and
  UKG/React hold values in properties. NEW `src/browser/liveHtml.ts`
  `readLiveHtml` clones the document, writes live value/selected/checked
  onto the CLONE, returns its outerHTML (live DOM untouched, falls back to
  page.content()); `settledFormHtml` and the four base planHtml reads now
  use it, and discovery captures `currentValue` from `value` attrs and
  `<option selected>` (placeholders ignored). This also makes #71's
  "already answered select ⇒ no prediction" work on native selects, not
  only Workday buttons. 5 tests in `tests/unit/history-rows.test.ts`
  (index parsing, mapper guard, plan skip/keep, discovery currentValue,
  readLiveHtml fixture with script-set values). FIXTURE_CONFIRMED.

### Run 18 (4e47f9ae, attempt 12) — #149 + #150 LIVE_MUTATION_CONFIRMED, submit refused (3)

Artifact `artifacts/ats-fill/generic-live/live-executed-1788361296138.json`
(real UKG url): 50 filled, 0 errors, verify passed with 0 mismatches.
`revealed-select: "State / Province" (address.state) → "Maryland"` (#149
live); every resume-parsed row planned as `employment row N already holds
"…" (resume parse) — kept` and `JobTitle3 … not answered from the bank`
(#150 live). Save was refused again — page says: "Job Title Experience job
title must not be empty." — the parser's fragment row 3 (employer "Gloria",
no title); #145d's Cancel then released the editor. Submit stage
(`submission/submit-run-8-1788361998909.json`, FAILED_BEFORE_CLICK):
3 mismatches — FromYear0 expected "2023" (bank `experience_year_5`, page
shows the parsed 2025), Degree expected "Bachelor of Science" (page "B.S."),
`f_58` major expected Mathematics (page "Choose..."). Root cause: the submit
stage re-plans from the GATE's html, which `verifyPageBeforeMutationGeneric`
still read with `page.content()` — attribute-only, so the #150 keep never
fired there.

- **#151 incomplete parsed rows** (NEW `src/ats/shared/incompleteRows.ts`,
  wired into `walkSectionEditors`'s refused-Save branch before the Cancel
  release): visible REQUIRED controls that are empty and belong to an
  indexed history group (`historyGroupOf`) identify a parse-fragment row;
  the row is removed via the page's own row control named with the row's
  1-based ordinal (`Delete Work Experience 4`, `remove-button`), highest
  index first, cap 3, then Save is retried once; only if still refused does
  Cancel fire. Nothing is invented; the resume stays attached; complete
  rows stand. Fixture test (#151 in generic-form-advance: fragment row
  removed via "Delete Work Experience 2", Save succeeds, no Cancel, complete
  row intact). 9/9. FIXTURE_CONFIRMED.
- **#150c gate reads live values** (`src/ats/shared/preMutationGate.ts`):
  `waitForRenderedContent` / `verifyPageBeforeMutationGeneric` now read
  `readLiveHtml`, so the submit-stage plan sees held values and keeps the
  parsed rows exactly as the fill-stage plan did. UNIT_CONFIRMED
  (pre-mutation-gate tests green); live in run 19.
- **Save loop stops on a refused Save** (`saveOpenSectionEditors`): the
  clicked element's handle is re-checked after the settle; the same
  control still on screen means the section refused it — note + break
  instead of "saved 12 open editor(s)". Covered by the #145c/#151 fixtures.

### Run 19 (4e47f9ae) — gate refused UNKNOWN_LANDING after Apply

`live-refused-1788362458768.json`: the Apply click landed on a page the
gate could not classify. Probes (`tmp-probe-livehtml*.ts`) showed
`readLiveHtml` classifies identically to `page.content()` (form/31
fields) and costs ~30ms more, so not a #150c regression — transient
landing timing (the fill stage sat 5m50s before refusing). Re-run as 20.

### Run 20 (4e47f9ae) — #151 LIVE_MUTATION_CONFIRMED, then a wrong Add

`live-executed-1788363583039.json`: `incomplete-row: removed employment
row 3 via "Delete Work Experience 4"` then `save succeeded after removing
the incomplete row(s)` — #151 live. But the walk's next trigger was the
review page's own "Add Experience" (a `primary-action-button`): the third
plan (78 fields) was the SAME review page, 10/78 filled, verify failed on
the education Major/From month/year, skills, work style (values read from
hidden base-page twins) and pipeline stopped AMBIGUOUS_FIELD.

- **#151b settled "closed" read** (`walkSectionEditors`,
  `saveControlGone`): right after a Save click the control is hidden while
  the request is in flight and re-rendered when validation refuses; the
  instant read said "closed". Closed now means the control stays gone for a
  2.5s quiet window inside an 8s budget; a reappearance is a refusal (the
  page's reason is logged on the retry too). settle 0 ⇒ single read.
  FIXTURE_CONFIRMED (existing #145c/#151 fixtures).
- **#152 Add trigger guard** (`openSectionEditors`): an "Add <Thing>"
  trigger is skipped when its history section already holds entries —
  read from the page (visible `Delete/Remove <kind> N` controls or held
  indexed history controls via `historyGroupOf`; kind via the new
  `historyKindOfText`). A blank row has nothing truthful to fill: the
  profile holds one entry of each kind and the parse already placed it.
  An empty section's Add still opens (#145 path). Fixture: "Add
  Experience" beside a held row skipped with the note, "Add Education" on
  an empty section opened, filled, saved. 10/10. FIXTURE_CONFIRMED; live
  in run 21.

### Run 21 (4e47f9ae) — killed before a duplicate row saved; inactivity modal found

Watcher captures `private/tmp-watch/run21-*.{png,txt}`, probe shots
`private/tmp-shot-1788365778215.png` (Add Experience editor holding a
duplicate of row 1) and `private/tmp-shot-1788365834283.png` (modal).
Findings:

- UKG's candidate profile PERSISTS across runs: after run 20's saves the
  application page renders the 4 experience rows + 1 education row as
  read-only entries with per-entry "Edit Experience Item N" pencils, no
  Delete/Remove controls and no held inputs — so #152's launch-time guard
  (Delete/Remove + held controls only) counted 0 and clicked "Add
  Experience" again. Killed the run (16:16Z) before its Save so the
  duplicate row was never committed; the session then expired and the
  unsaved editor was discarded (verified: tab landed on
  `/Timeout/TimeOut` "Sorry, you have been logged out").
- Plan phases are slow live: run 20's three plans took ~16 min; run 21
  passed 28 min still planning the review page. Added `timing:` notes
  (plan/fill/verify ms per page) to the fill report so the next artifact
  says where the minutes go.
- **#152 (extended)** — per-entry `Edit … N` controls (trailing ordinal;
  section pencils like "Edit Contact Information" carry none) now count
  as entries. Fixture updated (Delete + Edit Item 2 ⇒ 2 entries). 10/10.
- **#152b hidden Save** (`saveOpenSectionEditors`): every closed editor
  keeps its own hidden Save in the DOM; the unfiltered `first()` landed
  on one and reported "no save control found" while the open editor's
  Save sat on screen. Visible filter. FIXTURE_CONFIRMED (existing).
- **#153 inactivity keep-alive dialog** (`obstructions.ts`,
  `walkSectionEditors`, `genericSubmit`): "Are you still there?"
  (`#timeout-modal-container`, Stay logged in / Log out, ~2 min
  countdown) mounts during a long plan phase and intercepts every click
  under it; expiring it ends the session (run 21 died of exactly this).
  Registry gains `keepAlivePattern` (whole-name: stay/keep me logged|
  signed in, continue|extend|keep [my] session, I'm still here, …),
  checked BEFORE the flow-dialog and never-click screens so "Continue
  session" qualifies while a bare "Continue" dialog stays untouched;
  `log ?out` joined never-click; id-only containers (`[id*=modal]`,
  `[id*=timeout]`) are scanned. The section-editor walk sweeps before
  each open and each save; the generic submit sweeps before its click.
  Fixtures: UKG modal cleared via Stay logged in with Log out untouched;
  "Continue session" vs bare Continue. 8/8 obstruction, 10/10 advance.
  FIXTURE_CONFIRMED; live in run 22.

### Run 22 (4e47f9ae) — read back from the artifact, not a self-report

`live-executed-1788368009680.json` (16:53Z, the run the last session was
killed mid-flight): gate ok, Apply → UKG login wall → standing portal
login cleared it, resume upload verified, 20 fields filled across the base
and revealed pages, `#153` never had to fire. The wall is now COST, not
correctness — the `timing:` notes added in run 21 say exactly where:

- base page (106 planned): plan 7s, **fill 282s, verify 325s**
- revealed page (103 planned): plan 64s, **fill 421s, verify 705s**

~30 min for two pages, before the section-editor walk even starts. The
walk then opened Contact Information, filled 12/69, and the section
refused the Save ("resume … has been used to pre-fill part of your
application. Please verify …"); `#151` fired correctly again (removed
employment row 3 via "Delete Work Experience 4") but there was no Cancel
control, so the editor was left open. UNVERIFIED — no submit attempted.

## Milestone: Intel outreach (operator applies to this one themselves)

Operator directive 2026-09-02 evening: draft the emails for Intel
(4a03b318, Software Development Graduate Intern) — they submit that
application by hand — and keep applying to everything else.

- `contacts:insider`: 10 people checked, **7 emails**, 1 without contact
  info. Names captured from the row cards, so every draft greets a name.
- `email:generate` × 7: **7/7 VALIDATED**, 0 violations, claude-opus-5.
- `gmail:draft` × 7: **7/7 DRAFTED and verified** by the Drafts read-back.
  Two needed a retry: Vaishali's first attempt recorded no row at all, and
  Maciej's first came back `verified:false`.
- Read-only duplicate probe (`private/tmp-probe-intel-drafts.ts`, per
  recipient `in:draft to:<addr>`): 1 draft each for 6 recipients,
  **2 for maciej.peplinski@intel.com** — the first attempt DID compose,
  only its read-back failed, so the retry composed a second. Operator
  deletes one; nothing sends either way. A first `to:` probe read
  jiahua.guo as 0 and a 7s-settle re-probe read 1 — Gmail's `to:` index
  lags a just-saved draft, which is also the likeliest cause of the
  `verified:false`. LIVE_MUTATION_CONFIRMED (drafts only).

## #155 — `describeHiddenResolution` was never defined (uncommitted batch)

`npm run typecheck` on the carried-over #151–#153 diff:
`src/ats/greenhouse/fill.ts(1091): TS2304: Cannot find name
'describeHiddenResolution'`. The symbol exists nowhere in the repo — the
last session wrote the CALL and not the function, and nothing caught it
because `tsx` does not typecheck and the gate had not been run since.

Not cosmetic: the call sits inside the `#147` fast-skip branch, so the
first hidden control on any page would have thrown a ReferenceError and
killed the fill. Run 22 survived only because its skips were all
`#69` anchorless-twin skips, which return earlier.

Fixed by writing the helper the call site wanted: a read-only, never-throws
diagnostic naming the rung that resolved the control (id / name / label),
the match count, and the DOM shape (`<tag type=…> display=… visibility=…`,
plus whether a hidden ancestor is what is hiding it) — so a "hidden control
— skipped fast" note can be read back without a rerun. Typed structurally
against `globalThis.getComputedStyle` like `comboboxFill.ts` does, because
this tsconfig has no DOM lib. UNIT_CONFIRMED.

**Process note:** the previous session logged #151–#153 as
FIXTURE_CONFIRMED with the gate never run. A fixture that passes under
`tsx` says nothing about whether the module compiles. Gate before the
claim, not after.

## #156 — the #154 ledger silently broke the provider factory

Second defect in the same un-gated batch. #154 (`llmCallLedger.ts`, also
uncommitted and shipped with NO test) wraps every LLM client so each call
lands in `artifacts/llm/calls-<date>.jsonl`. The wrapper was an object
literal `{ async generateJson(input) {…} }`, which does not share the
wrapped client's prototype — so `makeLlmClient()` stopped returning
anything that is `instanceof AnthropicLlmClient`, and all six provider
selection assertions in `email-llm-provider.test.ts` failed.

That is the whole reason the first clean gate read `1 failed | 156
passed`: not a flake, a real regression sitting in the working tree.

Fixed by making the wrapper a `Proxy` over the client: the `get` trap
returns the instrumented `generateJson` and forwards everything else
(binding methods to the target), while `getPrototypeOf` falls through to
the target — so telemetry is invisible to every caller, `instanceof`
included. 10/10 provider tests green.

New `tests/unit/llm-call-ledger.test.ts` (4 tests) pins what had no test
at all: instanceof survives the wrap, a success records the model the
client reported, a failure records the FALLBACK model + error and
rethrows, and the input reaches the inner client unchanged. It also pins
that `surface` is the whitespace-collapsed SYSTEM prompt only — the user
prompt carries the operator's about-me and answer bank and must never
reach an artifact. Isolated via a temp `ARTIFACTS_DIR`. UNIT_CONFIRMED.

**#154 itself is live-confirmed**: tonight's 7 Intel generations each
appended a row — anthropic/claude-opus-5, 7.0-9.1s, ok=true. That also
proves the new test's temp-dir isolation (it sees 1 record, not those 7).

## Gate result for the #151-#156 batch

`npm run typecheck` green; `check:forbidden` ok; `check:secrets` ok;
`npm run test --maxWorkers=2` **1583/1584**, the one failure being
`portal-auth > SILENT sign-in escalates once…`, which passes **22/22 in
isolation** (45s). Different file than the previous run's failure — the
rotating-timeout signature this box produces under load, not a defect.

Two process notes for the next session:

- Running two full suites concurrently (my own error early tonight)
  produced `27 failed` and then `19 failed`; alone the same tree gives
  1-6. Suite duration alone is ~500s vs ~1200-1380s doubled up. Never
  overlap suites here, and never read a failure count from an overlapped
  run.
- A live browser is NOT the only thing that contends with the gate.

## State snapshot

_Updated at each job boundary._

- 2026-09-02 ~12:35 local: commits f7794768, 288a7934, d0aa6a3a pushed;
  #151/#151b/#152/#152b/#153 + timing notes are UNCOMMITTED on master
  (typecheck green; obstruction 8/8, advance 10/10, history-rows 5/5,
  kg 9/9) — bank at the next idle-browser window (gate needs the browser
  quiet). Submissions today: none yet. Run 22 on 4e47f9ae (UKG) in
  flight since 16:22Z: session re-authenticated on its own, base fill
  landed 16:28Z (start date, sponsorship No, authorized Yes), Contact
  Information editor opened 16:33Z — first live exercise of #152 Edit-N
  guard, #152b, #153. Operator-blocked backlog unchanged.
- 2026-09-02 ~10:55 local: commits this session f7794768, 288a7934,
  d0aa6a3a (all pushed). Issues #147-#150 fixed (UNIT/FIXTURE_CONFIRMED;
  #145c/#147/#148 LIVE_MUTATION_CONFIRMED by run 17's fill stage).
  Submissions today: none yet. Run 18 on 4e47f9ae (UKG, attempt 12) in
  flight — first live exercise of #149/#150. Operator-blocked backlog
  unchanged (Amazon passport, JPMC ODA chat, LinkedIn Easy Apply, ADP
  myjobs auth, Bosch Indeed, Mastercard military datum, Composio
  take-home, Tesla ALREADY_CONFIRMED check).
