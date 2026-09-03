# Overnight issues — 2026-09-01 (night24, day session continuation)

Continues numbering from 2026-08-31 (#115 last). Focus: Sierra
44fb9eb1 (Ashby, Intern Agent Development Winter 2027) — the AMBIGUOUS_FIELD
park from night23b runs 2/3.

## Job: 44fb9eb1 Sierra — Intern, Agent Development (Winter 2027)

Diagnosis (probe-first, CDP read-only probes in private/tmp-probe-sierra-*.ts,
pixels + wrapper dumps in artifacts/probes/night24-sierra/):

- Run 3's "24 items empty / listbox did not open after click" had ONE cause:
  Sierra's Ashby form renders every choice question as a NATIVE
  input[type=radio]/[type=checkbox] fieldset (opacity-0 painted inputs,
  label-per-option) inside a `data-field-path="<field id>"` wrapper. No
  combobox anywhere except the university autocomplete. The fill's combobox
  ladder clicked a radio and waited for a listbox that cannot exist.
- The night23b scroll-sweep hypothesis (#114 "lazy mount") was WRONG — a live
  probe found all 27 wrappers mounted with no scrolling. Sweep removed.

Fixes (all landed, typecheck + 30 unit tests green):

- **#116 native fieldset groups**: new `src/ats/ashby/nativeGroupFill.ts`
  (locate by data-field-path; option labels from label[for] / name; pick via
  pickOptionLabel; click the option LABEL; commit = re-read checked state).
  Dispatched ahead of the combobox probe in ashbyFillFromPlan/VerifyFromPlan.
  LIVE run 5: 21 filled, verify passed, LIVE_MUTATION_CONFIRMED.
- **#117 autocomplete caption discovery + type-to-open ladder**: the
  autocomplete input has no id/name/label[for] — discovery mislabeled it by
  placeholder ("Start typing...", f_18) and the bank planned a CITY into the
  university question. Now: label from the question-title's `for` uuid;
  placeholder twin suppressed. fillAshbyCombobox ladder: click → type →
  browse-via-toggle (probe: click alone never opens; "Johns" says No results
  while toggle lists 101 fixed schools incl. typo "Carngie Melon") → the
  form's own "Other" as screener-only escape hatch (fill-time mirror of the
  2026-08-14 plan-time policy; demographics excluded, verify accepts under
  the same gate). LIVE run 5: typed JHU → browsed 101 → committed "Other",
  verify match.
- **#118 pronoun boundary**: "Name pronounciation" (sic, contains "pronoun")
  was deferred to the demographics policy path and never filled.
  isDemographicsField now requires `pronouns?\b`.
- **#119 option-label collision**: the real "LinkedIn" URL field was
  swallowed at discovery because "LinkedIn" is also an option of "How did
  you hear…" (consumedNames label suppression). Label collision now only
  suppresses option-shaped fields (checkbox/radio/member-id/synthetic-id).
- **alias**: "GitHub or personal website" → github_url (profile
  personal_website is empty; github_url is set).

Run log: run 4 resumed mid-state from the requeue (FIELD_VERIFICATION →
submit on a fresh unfilled page) — gate refused correctly; retry → run 5 full
walk (fill verified; submit gate: 3 required text fields unanswered — the
#118/#119/alias trio above); run 6 in flight.

## Operator interaction (13:26 EDT-ish)

- Operator: "hold up stop i already sent stripe and nuvo." Outreach re-verify
  for the two unverified gmail_drafts rows (andrewr@stripe.com,
  emily.duffy@pentera.io) had just re-composed both drafts. NOTHING sent
  (send is forbidden), but two duplicate drafts now sit in Gmail —
  ⚠ OPERATOR: delete both drafts. Gmail MCP cleanup was permission-denied in
  dontAsk mode. Lesson: once the operator reports having SENT an app's
  outreach, drafts for it are done — do not re-verify old unverified rows.
- ⚠ JobRight data flag (again, cf. #openai-under-Datadog): Nuvo insider
  "Emily Brown" carries emily.duffy@pentera.io — wrong domain AND mismatched
  local part; do not send.

## Run 7 (13:32): 23 filled, verify passed — ONE blocker left, operator's

- #119 + github alias confirmed live: LinkedIn and GitHub now fill (23 vs 21).
- "Name pronounciation" is genuinely REQUIRED (probe: input.required=true,
  label carries _required_f7cvd_91 — the earlier "optional" read was a
  truncated dump). #118 unblocked it from the demographics path; the predict
  tier then correctly REFUSED to invent how the operator pronounces their
  own name (about-me has nothing on it). Bank capture + review item
  8f80f5f2 opened.
- ⚠ OPERATOR: provide the phonetic spelling (e.g. "SHOO-bum KAH-lay");
  it gets banked and Sierra submits. AskUserQuestion + Gmail MCP are
  permission-blocked in dontAsk mode, so asked via chat text.

## Job: f173d837 Bosch — Calibration Process Data Science Intern
(SmartRecruiters via generic adapter)

- **#120** POSTING_MISMATCH false refusal: SmartRecruiters redirects the
  validated slug URL to /oneclick-ui/company/BoschGroup/publication/<uuid>
  ("Easy apply"), which can never string-match the slug. Probe: the oneclick
  page carries the requisition id 744000146546699 AND the exact title in
  the H1. Rescue tier `oneclickContinuationConvicted` (preMutationGate):
  same company segment + oneclick shape + requisition id present in the
  rendered page — the #81 doctrine (req id convicts) applied to the page
  body when the URL cannot carry identity. 9/9 tests. Cycle also
  self-healed a dead CDP session (restart 1/3) — first live confirmation
  of the CDP restart path.
- Rerun with #120: posting gate PASSES, next wall is real — the oneclick
  page offers ONLY "Apply With Indeed" / "Apply with SEEK" external-account
  routes (probe: zero direct inputs; screenshot
  artifacts/probes/night24-bosch/01-oneclick.png). Apply→Indeed OAuth
  sign-in wall; no Indeed session on file. Parked AUTH_REQUIRED —
  ⚠ OPERATOR: one manual Indeed sign-in in the debug Chrome (like TIAA),
  then requeue f173d837; or apply manually.

## Job: f7cc3448 Databricks — SWE Intern Winter 2027 (greenhouse) — 9-run grind

Fill stage verifies 31/31 every run (grad-date bucket via llm_option, GPA via
gpa_range, demographics from sensitive profile). The submit stage then
re-plans the SAME page and walled four ways:

- **#121** the option-select pick is now REMEMBERED
  (rememberPredictedScreenerAnswer, first-write-wins) — the submit re-plan
  used to carry the raw bank answer ("May 2029") the page's bucket list
  cannot hold. (Write was refused for grad-date — label already attached to
  the expected_graduation_date custom entry — but stands for fresh labels.)
- **#122 fill-evidence waiver**: when submit-verify disagrees but the page
  holds exactly what the newest fill run committed AND verified
  (fill_field_outcomes.selected_option, joined by canonical OR the plan's
  field id), accept with a warning. Three instrumented iterations found the
  real shapes: submit re-plan maps the same control to a different canonical
  (gpa vs gpa_range → field-id join), observed can be "" not null, and
  observed can be an OBJECT ({label,value}) whose String() is
  "[object Object]". Run 8: waived 2 — values confirmed on page.
- **#122b** the blanket refill on a REUSED page is destructive: it re-opens
  verified comboboxes with re-plan values, CLEARS the committed picks, fails
  to restore ("no option matches"), and its own fill error blocks the click.
  On reuse, the refill is now skipped in favor of the targeted heal pass
  (fills only verify-failures — the late-mounting race/school fields that
  appear after Hispanic=No / school typeahead), which never touches a
  verified control.
- Run 9 verify-green then crashed on a malformed bank key (my
  "custom:name_pronunciation" write — keys are bare snake_case; fixed, and
  the pronunciation answer the operator supplied in chat is banked as
  name_pronunciation = "SHOO-bum KAH-lay").
- Run 11: verify PASSED (failing_detail []) — first click. Bounced off a
  SECOND required transcript slot ("graduate studies (if applicable)"),
  pixels: receipt-attempt-11.png. **#123**: the filechooser fallback only
  ran when zero attachments had happened, so a multi-slot form could never
  fill slot 2. Now runs per-section (skips sections already showing the
  filename, cap 3). 5/5 tests.
- **Run 12: SUBMITTED_VERIFIED → COMPLETED.** Databricks done on attempt 12.
- Outreach: insider triage found 7 emails; drafting for the 6
  @databricks.com addresses. ⚠ JobRight data flag: gdb@gdbsecurity.com
  listed under Databricks insiders — off-domain, not drafted.
- CDP wedged twice more (port answers, attach hangs) — manual restart:
  kill chrome.exe with jobright-cdp in the command line, relaunch,
  verify with a real connectOverCDP.

## Submissions (day session, 2026-09-01)

- **Databricks f7cc3448 SUBMITTED_VERIFIED → COMPLETED** (attempt 12,
  15:53 UTC). Outreach: 6 drafts to @databricks.com insiders (5 verified,
  diana.poplacenel drafted-unverified — left alone per outreach-sent-is-final).
- **Sierra 44fb9eb1 SUBMITTED → COMPLETED** (attempt 8, 15:02 UTC) — the
  #116-#119 batch + banked name_pronunciation ("SHOO-bum KAH-lay",
  operator-supplied in chat). Outreach: drafting to the 4 @sierra.ai
  insiders. ⚠ JobRight data flags: ralucam@waymo.com and
  andrew.min@scale.com listed under SIERRA insiders — off-domain, not
  drafted.

## Backlog: JPMC Oracle conversational apply (0e32b81d, f66faeba)

jpmc.fa.oraclecloud.com renders the apply flow as an Oracle Digital
Assistant CHAT (`oda-chat-user-text-input` role=combobox "Ask Me
Something"; `oda-work-summary-text-area` hidden until the conversation
reveals it). The generic adapter's flat fill can only time out against it
(it did — honest refusal, nothing committed). Supporting this needs a
conversational-apply adapter: drive the chat turn-by-turn, answer from
the same plan/bank tiers, verify per exchange. BOTH queued JPMC rows hit
this. Parked in review (AMBIGUOUS_FIELD) — a future night's project, not
a mid-loop fix.

## Job: 7ce4b2b0 Finastra — AI Engineer Intern Summer 2027 (Workday wd3) —
15-run grind → **SUBMITTED → COMPLETED (run 15, 18:05 UTC)**

Walls, in order (operator co-debugged live):
- **#124** completeness scan false-positived on Workday multiselect SEARCH
  inputs (empty by design; answer lives in selectedItemList /"N item
  selected") and MISSED unanswered listbox BUTTONS — both fixed
  (chips/promptAriaInstruction accepted; button[aria-haspopup=listbox]
  scanned, Workday's own "must have a value" hint = strongest signal).
- **#125/#125b** the stock returning-candidate radio
  (candidateIsPreviousWorker) was labeled "My Information" by the heading
  fallback → unmappable; id→question map added. Operator directive:
  returning-candidate = NOT returning (banked "No").
- **#126/#126b** wizard pages planned with ZERO option data — harvest only
  ever ran on page 1 (operator-diagnosed: "ensure you're properly scraping
  the outputs"). Walk now discovers→harvests→plans per page.
- **#127** four of nine questions-page listboxes render popup rows as
  [data-automation-id=promptOption] with NO role=option — harvest and fill
  both read an EMPTY open popup ("no option matches Yes (options: )").
  Selector added to both readers; next run submitted.
- Banked (operator-approved): us_work_authorization_status="U.S. Citizen",
  application_truthfulness_consent="Yes", ai_recruitment_opt_out="Yes"
  ("always yes no matter what"), returning_candidate_details="No",
  country-phone-code→address.country alias.
- CDP wedged 3× (port answers, attach hangs); cure: kill jobright-cdp
  chrome.exe, relaunch FOREGROUND (background-shell launches die with the
  parent), verify with real connectOverCDP.
- Auth note: one run hit the TIAA-class signed-out + "Something went
  wrong" sign-in rejection; the next run rode the re-established session.
- Outreach: 5 @finastra.com insiders drafting.

## Afternoon general loop (operator: any board, any time, one job/cycle)

- Day/night shift policy added then REVERTED same-day (operator: "attempt
  any job and improve the system at all times"). discover_max now 1.
- **Zipline SUBMITTED → COMPLETED** (e2087abe, one 188s cycle). ⚠ JobRight
  data flag: ghao@zoox.com under Zipline — not drafted.
- **Bear Robotics (Gem) SUBMITTED → COMPLETED** (b4619451, run 5) — first
  Gem-board submission. Walls: **#129** stored slug truncated by one char
  → prefix rule (≥30 chars) in samePostingPath; **#129b** #122 waiver
  extended to TEXT evidence (cover letter verified at fill, submit read
  empty/truncated); **#130** radio groups labeled by their own OPTION
  ("Male" as the gender question, "White (not Hispanic or Latino)" as
  race) — a demographic group took a wrong-question option pick TWICE,
  caught by the submit gate both times, never submitted. Collapse now
  relabels via the semantic shared name (gender, race_ethnicity) ONLY
  when members carry ≥2 distinct labels (wrapping radios keep their
  question label — the first #130 cut regressed exactly that and was
  fixed against tests). Outreach: 3/3 @bearrobotics.ai drafts verified.
- Suite flake storm reproduced memory's warning: 15 portal-auth + 2
  automation-worker timeouts while drafts ran concurrently; all pass in
  isolation. Gate re-run solo: 1470/1470.
- CDP wedge cure refined: launcher-spawned Chrome dies with the parent
  shell — launch DETACHED (Start-Process) and verify with real
  connectOverCDP.

## Backlog: amazon.jobs portal (a39259e5, AWS SWE Intern Fall 2026)

- #131 (id-segment conviction) passed the posting gate; Apply now →
  passport.amazon.jobs LOGIN wall (email/password + federated
  Amazon/Google/Apple/LinkedIn; screenshot
  artifacts/probes/night24-aws/apply-landing.png).
- Needs: amazon.jobs portal-auth wiring (standing account or
  create-account + email OTP via the existing Gmail code provider).
  Pieces exist (portalAuth create-account flows, GMAIL_VERIFICATION);
  wiring is an evening project.
- Classifier bug observed: the pipeline's Apply-landing classified this
  login page as "confirmation" (confirmation markers matched) — find and
  fence whatever copy matched before trusting post-click classification
  on this host.
- Parked AMBIGUOUS_FIELD (review) — out of the queue until wired.

## Evening loop additions

- **Valon (Ashby) SUBMITTED → COMPLETED** — **#132** Ashby yes/no BUTTON
  PAIRS (input-yesno: two aria-pressed buttons + hidden uuid checkbox);
  discovered by question title, filled by clicking the real button.
  Outreach: 6 drafts (5 verified). REJECTED_AFTER_CLICK on run 1 was the
  honest post-click classifier catching the form's own error — the alias
  "authorized to work for any employer" also added.
- **#133** serviceSession CDP attach now self-heals (one bounded
  restartCdpChrome + re-attach) — direct runs no longer die on the wedge
  the worker already survived. First live save: Clearwater's rerun.
- **#134** looksLikeApplicationUrl vetoes editorial paths (/news/, /blog/,
  /press/…) — a financialit.net article about Clearwater beat the real
  apply link via "job" in its slug + company-name congruence.
- Backlog: **Clearwater Analytics (9d70d002)** applies via
  linkedin.com/jobs/view — LinkedIn Easy Apply is unwired (login session
  exists via login:linkedin; the flow is a dedicated project). Parked.

## Backlog: ADP myjobs portal (d59e4a75, Plymouth Rock Data Eng Intern)

- OneTrust banner dismissal WORKS (probe-verified: .onetrust-close-btn-handler,
  aria Close). Apply → myjobs.adp.com/<tenant>/auth: email-first sign-in /
  create-profile wall ("If we don't recognize your info, we'll prompt you
  to create a profile"), screenshot
  artifacts/probes/night24-adp/03-after-proper-apply.png. Lighter than
  Amazon passport — a candidate for the portal-auth create-account
  machinery with an ADP adapter. Classifier called the post-Apply /auth
  page "posting" — same post-click classification gap as Amazon's.
- Intel posting (4a03b318) was REMOVED upstream (Workday 404) — parked
  FAILED_FINAL with probe evidence.

## Night25 (APPLIER agent takes the loop, ~22:30 UTC)

### Job: d9c79368 Bradesco Bank — AI & Data Engineering Intern → PARKED

- Cycle refused FORM_NOT_REACHED (live-refused-1788301474805.json): stored
  URL is linkedin.com/jobs/view/4458798591; generic adapter clicked
  a[href*=apply] twice, classifier honestly kept reading "posting".
- Probe (private/tmp-probe-bradesco.ts, signed-in session, pixels in
  artifacts/probes/night25-bradesco/01-posting.png): the posting offers
  ONE apply control — anchor "Easy Apply to this job" →
  /jobs/view/4458798591/apply/?openSDUIApplyFlow=true. No external-apply
  route exists on this posting.
- Verdict: Clearwater-class (LinkedIn Easy Apply adapter unwired — a
  dedicated project, not a mid-loop fix). Parked AMBIGUOUS_FIELD via the
  state machine with probe evidence in the reason.
- Hygiene: Clearwater 9d70d002 had been LEFT in NATIVE_AUTOFILL_RUNNING
  when backlogged — formally parked AMBIGUOUS_FIELD too, so cycles stop
  re-picking a known-unwired flow.

### Cycle 1: 091945b8 → FILTERED_OUT (posting closed on JobRight — honest terminal)

### Job: 4e47f9ae Bennett Thrasher (Barbacane/Thornton listing) — IT Intern AI & Automation (UKG Pro)

- Cycle 2 wall: FORM_NOT_REACHED on btcpa.rec.pro.ukg.net OpportunityDetail —
  "posting page but no Apply control found; visible apply-ish: div 'Apply now'".
- Probe (tmp-probe-ukg*.ts, pixels artifacts/probes/night25-ukg/01-posting.png):
  the only Apply control is `<ukg-button data-automation="apply-now-button">
  Apply now</ukg-button>` — web component, native button inside an OPEN shadow
  root, label slotted from the host. getByRole('button', /^apply/i) FINDS it
  (count 1, visible) but innerText/textContent/aria-label are all "" — the
  loose tier's self-text re-check rejected the only real match.
- **#135 strict accessible-name tier**: findApplyControl now tries
  getByRole(button|link, { name: APPLY_TEXT_RE }) FIRST — whole-name match
  against the anchored Apply regex needs no self-text re-check (and still
  excludes "Apply filters"/"Apply and save"/"Apply with Indeed" by anchor).
  Fixture test reproduces the shadow/slot shape; 20/20 posting-advance tests,
  typecheck green. Serves every web-component board (UKG family is large).
- Rerun in flight (night25-job-4e47f9ae-run2.log).
- Run 2: #135 CONFIRMED live ("clicking Apply via role=button accessible
  name is Apply") → next wall AUTH_REQUIRED: signin-us.ukg.net Auth0
  universal login. Portal auth correctly took "Sign up"
  (create-before-sign-in) but bailed "no create submit control found" —
  the /u/signup form's only submit says "Continue" (probe: email+password+
  button[type=submit name=action], pixels 02-signin.png/03-signup.png).
- **#136 signup-route submit fallback**: attempt("create") now accepts the
  form's own type=submit when the URL path is a signup/register/
  create-account route and no create-labeled control exists. Path check
  keeps it off sign-in forms. Fixture test mirrors the live Auth0 pair;
  22/22 portal-auth tests, typecheck green.
- Run 3: #136 CONFIRMED live — "using the form's own submit" → "form
  cleared" → account CREATED and vault-recorded for signin-us.ukg.net.
  Redirect landed on gusea1p01.rec.pro.ukg.net /AuthCode/Register: page
  classed form, but firstName/lastName both discovered with label "" and
  planned SKIP "No answer-alias mapping" → verify failed → AMBIGUOUS_FIELD.
- Snapshot: inputs carry NO label/aria-label and placeholder="" — the
  question text lives in `<ukg-label id="ukg-label-id-…">First name
  </ukg-label>` referenced via aria-labelledby (ARIA-standard, ladder never
  resolved it).
- **#137 aria-labelledby resolution**: fieldDiscovery ladder now resolves
  aria-labelledby (any tag, up to 4 ids, immediate text) between
  label[for] and aria-label. Test mirrors the live markup; 24/24
  autonomy-unblockers, typecheck green.
- Run 4: requeue resumed mid-state (FIELD_VERIFICATION → submit on a fresh
  unfilled page) — submit gate refused correctly (Sierra-run-4 pattern);
  `retry` re-routed through the fill leg.
- Run 5: full walk, signed-in session rode straight to AuthCode/Register —
  but plan discovered 0 FIELDS and verify failed. Probe: the register form
  (firstName/lastName + ukg-button "Create account") IS there after ~8s;
  run 5's plan HTML was the Apply click's settle snapshot, taken at the
  FIRST DOM change — before the ukg web components mounted their native
  inputs. The re-gate had already re-read the page fresh; the plan kept
  the stale advance.html.
- **#138 plan-from-fresh-read**: after advancePastPosting hops, planHtml/
  planUrl now come from the re-gate's read (which waits for form markers
  on unknown first paints), never the click snapshot. Deterministic
  fixture test (Apply → empty shell → form mounts 2.2s later, discriminates
  because performTransition's settle returns on FIRST change); 20/20
  ats-live-fill, typecheck green.
- Run 6: MY error — used requeue-one-ambiguous again, which resumes at
  FIELD_VERIFICATION → submit walked a fresh unfilled page → gate refused
  (exactly the run-4 trap). LESSON: after an AMBIGUOUS_FIELD park whose fix
  changes the FILL, always requeue with `retry` (full walk), not the
  ambiguous resolver. Run 7 (retry → full walk) in flight.
- Run 7: #137+#138 CONFIRMED live — gate class form, plan firstName/
  lastName both "Mapped from public profile". Last wall: `[name=firstName]`
  resolves the `<ukg-input>` HOST (web-component hosts MIRROR name=; host
  precedes the native input in document order) — fill and verify both
  errored "Element is not an <input>…".
- **#139 name-tier control preference**: locatorForField's name tier now
  prefers the [name] match that IS a native control and otherwise descends
  into the host (`byName.and(CONTROL).or(byName.locator(CONTROL))`) —
  plain pages resolve identically. Fixture test with the ukg-input mirror
  shape; 9/9 label-collision, typecheck green. Run 8 in flight.
- Run 8 was a NO-OP: stopped on run 7's still-OPEN review item ("open
  review item: AMBIGUOUS_FIELD") — `retry` alone does not resolve review
  items. The artifact I first read as "run 8" was run 7's. FULL requeue
  recipe for an AMBIGUOUS_FIELD park whose fix changes the fill:
  requeue-one-ambiguous (resolves the item) → retry (full walk) → run.
  Run 9 launched with that sequence.
- Run 9 corrected the recipe again: `retry` is a NO-OP unless the row is
  FAILED_RETRYABLE — chained right after requeue-one-ambiguous (state
  FIELD_VERIFICATION) it did nothing, the run submit-walked a fresh page
  and failed the identity gate into FAILED_RETRYABLE. FINAL recipe:
  requeue-one-ambiguous → run once (burns the mid-state resume into
  FAILED_RETRYABLE) → retry → run; or straight retry when already
  FAILED_RETRYABLE. Run 10 (retry from FAILED_RETRYABLE → full walk) in
  flight — first run that will actually exercise #139 live.
- Run 10: **#139 LIVE_MUTATION_CONFIRMED** — firstName/lastName filled AND
  verified (observed Shubham/Kale on the page). Next wall at submit: the
  shared identity gate refused POSTING_MISMATCH — /AuthCode/Register can
  never path-match /OpportunityDetail, but the final URL's state param
  EMBEDS returnUrl=/…/OpportunityApply?opportunityId=<our uuid> (plus the
  board uuid).
- **#140 returnUrl continuation conviction**: preMutationGate rescue —
  every uuid/≥7-digit id in the EXPECTED posting URL must reappear in the
  percent-decoded FINAL URL (query included); no ids ⇒ no rescue; a
  different posting lacks ours by construction (#81 doctrine applied to
  the query string). 15/15 posting-path tests, typecheck green. Run 11 in
  flight.
- Run 11: #140 passed the identity gate; fill verified again (2 filled,
  held for submit). Submit refused honestly: upload_failed — "0 file
  inputs on page". Structural read: AuthCode/Register is an ACCOUNT-SETUP
  step; the real application (with the resume input) is BEHIND its
  "Create account" button, which is submit-shaped ("no Next/Continue after
  page 1") and rightly excluded from the submit cascade.
- **#141 account-setup continuation tier**: resolveAdvanceControl now
  takes a strict-named "Create account|Sign up|Register" button as a page
  ADVANCE — ONLY when the page's own text says account setup
  (ACCOUNT_SETUP_PAGE_RE) AND the page has no file input. Page-wide scope
  on purpose (ukg-button mounts outside the form, associated via form=).
  Same click class portalAuth already performs under NAVIGATION_ENABLED.
  4/4 generic-form-advance tests incl. a no-marker guard; typecheck green.
  Run 12 in flight.
- Run 12: #141 CONFIRMED live ("resolved advance: account-setup
  continuation 'Create account'") — the walk reached the REAL application
  (OpportunityApply) and "filled" page 2… but only re-planned the two
  name fields (form:2/2). Submit refused: required "Job Title"/"Skills"
  unanswered. Probe (07-app-form.png): OpportunityApply is a large SPA —
  resume-parse offer, Contact/Work Experience/Education/Skills/Questions/
  EEO sections, most controls mounting late (names prefilled from the
  account). The walk's fillCurrentPage received transition.html — the
  FIRST-change snapshot again (same class as #138, this time inside the
  walk).
- **#142 stable-field-count settle**: walkGenericFormPages now plans each
  landed page from settledFormHtml() — poll page.content() until the
  discovered-field count is stable across one 700ms interval (bounded by
  the settle budget) — instead of the click snapshot. 4/4 tests, typecheck
  green. Run 13 in flight. Expected next walls: collapsed accordion
  sections (controls vis=false until expanded), how_heard select,
  MultipleChoiceResponse radios, EEO from sensitive profile.
- Run 13: #142 CONFIRMED (plan 2 → 31 rows; 22 fillable). 7 fills landed
  live incl. how_heard (bank exact_option), sponsorship, work-auth,
  gender. 13 fills timed out "waiting for element to be visible" — ALL in
  collapsed Bootstrap panels (probe 08-sections.png: h2
  .collapsible-panel-title headers over div.collapse display:none bodies;
  AddressLine1's hidden ancestor chain confirms).
- **#143 section expansion**: new shared expandCollapsedSections() —
  clicks visible collapsed toggles ([data-toggle=collapse],
  aria-expanded=false buttons, .collapsible-panel-title wrapping a
  collapsed chevron), skips action-named controls (submit/apply/delete/…),
  cap 12 / 2 rounds. Wired: atsLiveFill before harvest/plan (execute
  only, planHtml refreshed) and walkGenericFormPages before the #142
  settle. Fixture test incl. the action-name guard.
- **#144 demographics fence by camelCase NAME**: AreYouDisabled (visible
  label = boilerplate "Please choose one of the options below") reached
  the PREDICT tier — produced nothing, but demographics must never route
  there. isDemographicsField regex now matches "disabilit|disabled"
  (substring — camelCase names survive normalization concatenated).
  Unit tests added. Typecheck + 18/18 green. Run 14 in flight
  (tmp-requeue-full.ts: resolve review item → FAILED_RETRYABLE → retry).
- Run 14: Apply now rides the session STRAIGHT to OpportunityApply (no
  register page — account complete). Same 7 fills / 13 hidden-control
  timeouts; #143 clicked 0. Probe chain (09/10-*.png):
  - The h2.collapsible-panel-title is INERT (data-bind text only); the
    chevron i[aria-expanded] is neither inside the h2 nor its parent.
  - #143b: collapsed check extended to the parent container (general),
    fixture updated with the sibling-chevron shape — but the REAL UKG
    toggle is `collapsible-panel-button` → button[data-automation=
    primary-action-button] (pencil): clicking it opens the section in
    EDIT mode (10-after-pencil.png — Contact Information open: Title
    select, email, required fields; rest of page dimmed).
  - Structural read: UKG sections are a per-section EDIT WORKFLOW
    (pencil → fill → save/check), not a Bootstrap accordion. Needs a
    section-edit walker (Workday-wizard analog, #126 class) — the last
    wall class on this board.
- Gate running solo (browser idle) to bank the #135-#144 batch per queen
  check-in; section-edit walker attempt follows the commit.
- **Batch COMMITTED + pushed: dde925b0** (19 files, #135-#144 + bank-key
  guard). Gate: typecheck, 1514/1516 (2 fails = console-a11y at HEAD,
  pre-existing/foreign — queen notified), forbidden, secrets all green.
- Editor probe (11-editor-open.png): pencil = "Edit Contact Information"
  (data-automation=primary-action-button); opening mounts ALL contact
  controls (Prefix…WillingToRelocate) + Save (save-button) / Cancel;
  editors coexist; page submit = ukg-button btn-submit. Questions + EEO
  were always visible — that's why exactly 7 fills landed.
- **#145 section-editor pass**: genericSelectorsV1.sectionEditors
  (attribute tier + /^(edit|add)\b/ name pattern); openSectionEditors runs
  in the pre-plan block (planHtml refreshed), saveOpenSectionEditors after
  verify+uploads with a post-save page-error read. Save is a SECTION
  commit — btn-submit stays with the gated submit path. 6/6 tests,
  typecheck green. Run 15 in flight.
- Run 15: #145 partial CONFIRMED — Contact editor opened, filled 7→14
  (phones, country, full address) and the RESUME UPLOADED VERIFIED
  (first upload on this board). Two mechanical gaps:
  - only ONE editor opened — each open re-renders and shifts nth()
    indexes. **#145b**: rounds — re-query per click, dedupe by accessible
    name, break when nothing new opens.
  - PreferredName/FormerName are READONLY by design (account-owned;
    "change it on My presence") — two 30s fill timeouts + verify misses.
    **#146**: fill skips readonly/disabled fast with the real reason;
    verify accepts a locked control in place with a warning (submit
    completeness still guards required emptiness). 16/16 tests, typecheck
    green. Run 16 in flight.
- Aside: fixture-suite runs persist live-*.json into artifacts/ats-fill/
  generic-live/ (localhost URLs, "test seam" note) — they can shadow the
  newest REAL artifact during diagnosis. Read the url field before
  trusting. (Cosmetic; not fixed mid-loop.)

## State snapshot (13:30)

- Sierra 44fb9eb1: run 6 in flight (all four fixes live).
- Queue: Delta, HP IQ, JPMC ×2, Finastra, Nuvo(dup row b4f518fe), Databricks,
  Bosch, Booz Allen — QUEUED.
- Mastercard 4eb2b7ad: still operator-blocked (military-service answer).
- Stripe 0a2dbfa6 / Nuvo 86533179: outreach SENT by operator; chain closed.
