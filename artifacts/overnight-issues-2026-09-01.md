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

## State snapshot (13:30)

- Sierra 44fb9eb1: run 6 in flight (all four fixes live).
- Queue: Delta, HP IQ, JPMC ×2, Finastra, Nuvo(dup row b4f518fe), Databricks,
  Bosch, Booz Allen — QUEUED.
- Mastercard 4eb2b7ad: still operator-blocked (military-service answer).
- Stripe 0a2dbfa6 / Nuvo 86533179: outreach SENT by operator; chain closed.
