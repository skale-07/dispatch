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

## State snapshot (13:30)

- Sierra 44fb9eb1: run 6 in flight (all four fixes live).
- Queue: Delta, HP IQ, JPMC ×2, Finastra, Nuvo(dup row b4f518fe), Databricks,
  Bosch, Booz Allen — QUEUED.
- Mastercard 4eb2b7ad: still operator-blocked (military-service answer).
- Stripe 0a2dbfa6 / Nuvo 86533179: outreach SENT by operator; chain closed.
