# Overnight session issues — 2026-08-31 (night22, open-ended run until operator stop)

Operator directive (this session): standing overnight authorization; run the
loop one job at a time discovery→submit; 3-min budget per RUN then stop +
diagnose (stay on the SAME job per the night20 directive until submitted or
operator-blocked); every unsuccessful submit logged here; recurring patterns
get a progressive-overload sandbox; gate + commit per fix. Push notification
only for urgent. **Start at TIAA (fda27acb) and go until it is submitted.**

Issue numbering continues from night21 (#95 was last; #77 TIAA silent-auth,
#83 phoneType replay fence, #88 Stryker GPA twin, #55 attach preflight,
#29 review re-parks, #19 Cloudflare still OPEN).

Pre-flight (14:18 EDT):
- Debug Chrome was in the #13 wedge (ws connects, attach times out) —
  `restartCdpChrome` cleared it (killed 5 stale pids, attach probe passed,
  LIVE_READ_ONLY_CONFIRMED).
- TIAA fda27acb: NATIVE_AUTOFILL_RUNNING, attempt 2, no open review items.
  Auth ledger 1/3 used (last automated attempt 11:19 EDT refused AUTH_REQUIRED).
- Read-only probe: posting signed OUT, Apply (adventureButton) present,
  cookie banner persisted-dismissed, 22 days left to apply.
- SMS/WhatsApp opt-in blockers from night21's last full run are already
  addressed in the bank (`sms_consent_opt_in` = No, commit c603b33a).

## Issue log

### Job #1 — fda27acb TIAA Churchill Summer Internship IIT (tiaa.wd1 Workday) — resumed

- 14:2x EDT: paced sign-in diagnostic (keystroke typing 70ms delay, read-back
  before submit — the 20:55 night21 recipe) SIGNED IN on the FIRST click:
  password form gone in <1s, header signed in, landed on /apply/applyManually.
  The ~3h cool-down since 11:19 plus human pacing cleared the #77 wall — no
  manual operator sign-in was needed after all. Auth budget: this was a real
  credential attempt (2/3 in-window, self-accounted; ledger only records
  portalAuth attempts).
- Post-auth wizard shell painted "Something went wrong — Please refresh the
  page and then try again" (transient Workday shell error; progress bar for
  7 steps drawn). Session lives in the profile; pipeline launched to resume
  the draft (night21 #22n pattern).
- 14:3x EDT run night22-tiaa-01 in flight.

### 96. OPERATOR DIRECTIVE (mid-run, watching the majors prompt): typed filter
inert ⇒ MUST fall back to scrolling the list and clicking the match
- Operator screenshot: the education Field of Study prompt with "Math" typed
  into the prompt search box and the list still showing the FULL alphabetical
  majors window (Law … Political Science) — typing does not filter this
  widget, "Mathematics" sits unclicked in plain view. Directive: when the
  initial type-to-filter matching isn't working, revert to scrolling through
  the whole list and clicking the option.
- #94 (scroll-harvest + click ONCE) was built for exactly this field; the
  math-preference rule in pickOptionLabel would choose bare "Mathematics".
  RESOLUTION (run night22-tiaa-01 fill notes): the majors field SELF-RESCUED
  — 'filter "Math" → 25 option(s); picked "Mathematics" (synonym)' + one
  verify-triggered re-pick. The operator watched the slow middle of a walk
  that ended verified. The grind-time directive stands and #97's fixes cut
  the worst of it (see below).

### Run night22-tiaa-01 (14:23–14:29 EDT) — fill leg VERIFIED, READY_TO_SUBMIT
reached (first time for TIAA); submit refused pre-click on 2 items
- Wizard walked 6 pages, verify PASSED on the fill leg (13 filled + walk).
  The auth walk worked on the resumed signed-in session; re-reach fired once.
- Submit blockers: (a) `sms_scheduling_consent` verify_mismatch — expected
  "Yes", page "(empty)"; (b) upload item is COSMETIC (the #84 waiver already
  cleared it — uploadOk gates the click, the brief prints the raw upload).
- Wizard page-6 error panel named THREE required questionnaire fields never
  filled: internal investigation, IRCA identity/authorization verification,
  and the SMS scheduling consent.

### 97. Workday consent listbox buttons: sentence options dropped by junk
caps; button toggle desync; drill scan commits on flat lists — FIXED
(FIXTURE_CONFIRMED 4/4 + 56/56 regression; live check next run)
- **Live popup probe (read-only, resumed draft):** the consent control is a
  `<button aria-haspopup=listbox>` whose popup OPENS on a plain mouse click;
  options are "Select One" + two ~150-char SENTENCES ("Yes, I hereby Consent
  and “Opt-in”…" / "No, I hereby Do Not Consent…"). A JS click TOGGLES the
  popup closed.
- **Failure chain:** (1) clickListedOption's clean() dropped labels ≥80
  chars — the only pickable rows vanished; (2) the reopen branch blind-
  clicked the button, toggling the open popup SHUT; (3) scrollHarvest's
  120-char cap dropped the sentences from the inventory too; (4) the tail
  pick matched "Yes, I hereby…" via leadingYesNo but the popup was closed →
  the recorded 5s option-click timeouts, three required fields empty.
- **Fixes (comboboxFill.ts):** caps 80→200 / 120→250; buttons only re-open
  when the popup is actually closed (typeable inputs keep the residue-clear
  path); the final pick reopens a closed popup once; the DRILL SCAN is
  fenced to Workday multiselect prompts with a non-yes/no expectation —
  everywhere else a "category" click just commits a wrong row with no chip
  charm to undo (this also fixes 3 PRE-EXISTING #94-fallout failures in
  combobox-fill.test.ts at HEAD: react-select "Canada" committed for
  "Atlantis" ×2, samsara sole-consent 30s timeout).
- **Progressive-overload fixture** tests/fixtures/ats/workday/
  consent-listbox.html (~190-char sentences, toggling button, placeholder
  row, two-yes ambiguous set that must refuse with nothing committed) + 4
  tests, first-run green.
### Run night22-tiaa-02 (14:57–15:01 EDT) — #97 LIVE-CONFIRMED (IRCA + SMS
consent filled; questionnaire errors 3 → 1); TWO new walls isolated
- verify + upload + completeness ALL passed; the submit leg failed only on
  "workday final submit control not found (not on the Review page?)" — the
  held page is Application Questions 1 of 2, not Review; nothing walks the
  remaining wizard steps to reach the Submit button (#99, next).
- Page-6 pixels: ONE error left — the internal-investigation question still
  "Select One". IRCA shows Yes; SMS consent filled. (The pre-click gate
  passed because the completeness scan couldn't see the undiscovered field
  — fail-open hole closed by #98 fixing discovery itself.)

### 98. Discovery discarded any label containing [brackets] — the ONE
questionnaire legend with "[ER]" was never a field — FIXED
- isUninformativeLabel's machine-name rule (`/\[[^\]]*\]/` for
  cards[uuid][field0] / urls[Other]) rejected the natural-language legend
  "…(such as an ongoing Employee Relations [ER] review)…" — the only one
  of TIAA's 15 questionnaire questions with brackets, which is why exactly
  this field was invisible on every run. Rule narrowed to whole-label
  machine shapes (`/^[\w.-]*(\[[^\]]*\])+$/`); the live snapshot now
  discovers the field (select, required). Regression case added to the
  label tests; machine shapes still rejected.
- **Bank (⚠ operator review):** `internal_investigation_current` = **No**
  (you have no present-employer ER investigation) and
  `irca_identity_work_authorization_verification` = **Yes** (you are a
  confirmed US citizen — verifying identity + work authorization within 72
  hours is factual). Labels are the exact on-form questions. Say the word
  and I'll change either.
