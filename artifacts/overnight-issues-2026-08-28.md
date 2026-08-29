# Overnight session issues — 2026-08-28 (3-hour run, ~20:52–23:52)

Operator directive: focus one job at a time to submission; per-job deadline
4–5 min discovery→submit; every unsuccessful submit gets logged here; recurring
patterns get a "progressive overload" sandbox test one level above the failure.

## Issue log

### 1. Generic ATS resume upload does not verify (FAILED_BEFORE_CLICK)
- **When:** 2026-08-29T00:50Z, session run f5576ceb (pre-restart cycle)
- **App:** 66f54fef-43d2-43b7-8f7e-98e8bf951461 → `FAILED_RETRYABLE`
- **Evidence:** `Upload: resume — kind: upload_failed — input files: []; stillAttached=true; chip=false; planned resume-648f06d1.pdf`.
  Fill verified 7 text fields, then submit gate correctly refused to click
  because the upload never landed in the input.
- **Read:** the generic adapter sets the file on an `<input type=file>` that the
  page either clears or replaces with a custom widget (chip=false suggests a
  dropzone UI that needs a real file-chooser event, not setInputFiles on a
  hidden input).
- **Status:** watching for recurrence in the new session → sandbox candidate
  (higher-level test: dropzone-style upload fixture, not just plain input).

### 2. Deterministic fill can't reach forms on JobRight-leftover apps (7/7 gated)
- **When:** session d2d4104f (~01:10Z), queue leftovers after extension disabled
- **Evidence:** all 7 apps gated at NATIVE_AUTOFILL_RUNNING: generic
  FORM_NOT_REACHED ×2, generic UNKNOWN_LANDING ×2, greenhouse FORM_NOT_FOUND,
  workday NO_APPLICATION_FORM ×2. 0 submits, queue drained, session completed
  early.
- **Read:** these are the residue apps whose landing pages are job descriptions
  or portals needing an Apply click / account step the native path doesn't do.
  Sandbox candidate: "landing page → locate Apply → reach form" as a
  higher-level capability test per adapter (progressive overload above the
  individual field level).

### 3. Screener predictor fed placeholder junk as question labels
- **Evidence:** `prediction rejected "MM/DD/YYYY" / "vendor-search-handler" /
  "Start typing..." / "Pick date..." / "Search apple.com": no answer` — the
  label extractor is passing input placeholders/artifacts as questions.
  Predictor correctly refuses, but each is wasted LLM spend + noise.
- **Fix direction:** label extraction should discard placeholder-pattern labels
  (date masks, "Start typing", search boxes) before prediction.

### 4. discover:ats rejects greenhouse jobs with company-hosted apply URLs
- **Evidence:** all 12 Stripe + 8 Databricks matches rejected_url ("apply URL
  did not validate as greenhouse (got generic): https://stripe.com/jobs/...gh_jid=...").
  The board API's absolute_url is company-hosted; the canonical
  boards.greenhouse.io/<board>/jobs/<id> is derivable from the job id.
- **Fix (tonight):** canonicalize to boards.greenhouse.io before validation.
  20 jobs recoverable including Stripe SWE intern roles.

### 5. discover:ats --match is substring-based
- **Evidence:** "intern" matched "Internal Audit Data Analytics Lead",
  "International Accounting Lead", etc. (Stripe considered=12, mostly
  Internal-Audit roles).
- **Fix (tonight):** word-boundary match so "intern" ≠ "internal".

### 6. Greenhouse location combobox: bare-city plan value vs doubled places rows — FIXED e217af9
- **Evidence:** both Figma fills (17 and 21 fields verified) parked
  AMBIGUOUS_FIELD on candidate-location: plan "Baltimore" vs places rows
  "Baltimore, Maryland, United States" ×2 + New Baltimore ×2 + Baltimore
  Highlands → "ambiguous match" refusal.
- **Fix:** pickLocationOption single-part expected matches by exact first
  comma part + identical-label dedupe; generic substring path also dedupes
  identical labels. Fixture test mirrors the live react-select DOM with the
  doubled rows (the progressive-overload case). 60/60 fill tests green.
- **Follow-up done:** 3 parked apps resolved via requeueAmbiguousField →
  FIELD_VERIFICATION; worker resumes them under the fixed matcher.

### 7. Screener predictor left "Full legal name:" blank (Notion ashby)
- **Evidence:** review item 282c1cc5 (app 9a6bdf11): free-text "Full legal
  name:" got predicted_answer null despite legal_name in the profile.
  Alias bank has legal_name.first/.last but no composite "full name" mapping.
- **Direction:** either an alias for full-name phrasings backed by a composed
  profile value, or answer once via review to seed the bank. NOT auto-fixed
  tonight (name fields deserve care) — flagged for operator.

### 8. 16 apps stranded at NATIVE_AUTOFILL_RUNNING by killed sessions
- Worker's resume list includes that state, so the relaunched session sweeps
  them up naturally. No action needed; noting the pattern (each operator-
  requested mid-session restart strands in-flight rows until the next arm).

### 6b. Bare-city fix insufficient live — places lists carry hidden namesakes — FIXED c67d48c
- **Evidence:** session 1b93205e (fixed code confirmed by commit/start times)
  still refused candidate-location on 4 Databricks + re-run Figma apps with the
  identical 5-row display. The refusal reason caps at 5 rows (`sub.slice(0,5)`)
  — the live lists almost certainly hold a 6th+ namesake city (e.g. Baltimore,
  Ireland) which the bare-city rule correctly refuses. Probe confirms the
  displayed 5-row list resolves fine in-tree.
- **Fix:** comboboxExpected now composes "City, State, Country" from the
  operator profile for address.city combobox fills → multi-part exact-comma
  matcher names one row regardless of namesakes (04db417 also adds the total
  candidate count to ambiguity refusals so the display cap can't hide evidence
  again). 55/55 fill tests green.
- **Follow-up:** 4 Databricks/impact apps → FIELD_VERIFICATION,
  3 FAILED_RETRYABLE retried; fresh session launched 22:57 with this code.

### 9. Ashby (Notion): plan fields absent from DOM at fill time — OPEN
- **Evidence:** apps 0e7cc173/6c6adcad — 9+ "control not found on the page"
  (f_43, UUID ids, _systemfield_eeoc_*) with labels like "Pick date...".
  Inspection saw controls the fill page doesn't render (progressive sections /
  paged form suspected).
- **Next:** compare ashby inspection artifact vs fill-time DOM on next wake;
  likely needs section-expansion or per-page fill in the ashby adapter.

### 10. Export-control question fills `true` instead of the country option — OPEN
- **Evidence:** apps eeb4d446/f5003802/a6c6ab06: "Individual granted permanent
  residency in a country other than Cuba, Iran, North Korea, or Syria" —
  expected "United States", observed "true" (a checkbox got checked; the
  planned answer is an option label). Control-kind mapping bug, listed twice
  per brief (duplicate verify rows).
- **Next:** inspect the field control kind in the Databricks fill meta.

### 11. FIRST SUBMIT CLICK of the night — post-click page unrecognized (312aad81, Figma)
- **Evidence:** session 517b8089 submits_used=1; app 312aad81 clicked submit
  (all field verification passed under the location fix), then "UNCERTAIN —
  Submission not confirmed within 15000ms (page classified: unknown)" →
  SUBMISSION_VERIFICATION_FAILED (review). receipt-attempt PNG in artifacts.
- **Action:** verify:mailbox scan running; if a Figma confirmation email
  exists, resolve submitted via review:resolve. Also: the post-click page
  classifier needs a Figma/greenhouse confirmation pattern — sandbox
  candidate if it recurs.

### 12. FIELD_VERIFICATION resume across sessions re-verifies a fresh (empty) page — OPEN
- **Evidence:** requeued apps went FIELD_VERIFICATION → READY_TO_SUBMIT →
  FAILED_BEFORE_CLICK "field verification or upload did not pass" / "5
  required question(s) unanswered": the fills from the PRIOR session's browser
  are gone, and the resume path re-verifies without re-filling.
- **Operator workaround (used):** npm run retry → full re-run from QUEUED.
- **Fix direction:** FIELD_VERIFICATION handler should detect an unfilled
  form (0 verified fields) and fall back to the fill stage instead of
  refusing.

### 13. Debug Chrome CDP instability burned 12+ apps this session — OPEN (operational)
- **Evidence:** repeated "Debug Chrome at 127.0.0.1:9222 is unresponsive (port
  answers but CDP session won't attach)"; 3 in-session restarts; queue drained
  mostly on this. Likely residue of tonight's many session kills.
- **Action:** kill all Chrome before next launch; CDP_AUTOLAUNCH respawns a
  fresh profile Chrome.

### 14. Databricks required availability checkboxes + offer-deadline textarea (46efd55b) — OPEN
- **Evidence:** pre-click scan (correctly) refused: "January to June (6
  months)/May to July (10 weeks)/June to August (10 weeks)/None of these"
  checkboxes + optional-deadline textarea unanswered. Screener bank has no
  availability entries; predictor didn't fill checkbox groups.
- **Note:** essay layer DID draft 1 suggestion for this app (in review).
  These are operator-preference answers (which internship window works) —
  queued for the operator's bank, not auto-invented.

### 15. Alias mapper hijacked screener questions with single-word aliases — FIXED bd30947
- **Evidence:** Stripe 420e19f5 submit-run briefs: "University" mapped the
  internship-length question to `school` (fill typed "Johns Hopkins
  University" into a length dropdown → no option matches), "Degree" mapped
  the enrolled-in-degree-programme question. Pre-click verify correctly
  refused both attempts — root cause of the repeated "field verification or
  upload did not pass".
- **Fix:** substring alias match now requires a multi-word intent phrase or
  a label-like target (len ≤ max(30, 3×phrase)). 104/104 across 9 suites.

### 16. Invalid state transition APPLICATION_OPENING → FILTERED_OUT (nav) — OPEN
- **Evidence:** 6 apps pipeline_error'd in session 8408bda3, each dropping
  the shared nav session. The nav layer tries to filter an app that is
  already mid-OPENING; the state machine (correctly) refuses; the error is
  unhandled.
- **Fix direction:** nav should transition via a legal edge (or skip the
  filter once opening started). Not fixed tonight — needs state-machine map
  review.

### 17. Stored-URL mismatch gate refusals (ben1022btll / ultipro / Rivian slug) — OPEN
- Nav stored garbage employer URLs for 3 apps; the identity gate refused the
  fill (correct behavior). Nav URL-resolution quality issue; morning triage.

### 11b. Post-click wall identified: Greenhouse emailed security code — FIXED de2f2f1
- **Evidence:** receipt screenshot for 8d9daaa9 (Stripe): form fully filled
  (location commit CONFIRMED on-page, essays in, resume attached), submit
  clicked, page waiting on "A verification code was sent to skale1@jh.edu —
  enter the 8-character code" with 8 one-char boxes + reCAPTCHA badge.
  Classifier read "unknown" → both real submissions (312aad81, 8d9daaa9)
  parked UNCERTAIN.
- **Fix:** post-click inconclusive + detected code wall → one recovery pass
  (mailbox code fetch → split-box typing → re-click → re-verify). The
  existing recovery only ran on a pre-click DISABLED button. 11/11 suite
  green incl. new split-box fixture; e2e pins at-most-one recovery per run.
- **Note:** 312aad81/8d9daaa9 stay operator-resolution (uncertain
  submissions are never auto-resolved) — but future apps clear this wall
  automatically. jh.edu codes arrive via the Outlook provider
  (OUTLOOK_VERIFICATION_ENABLED, session authenticated).

### 18. Samsara: greenhouse URL serves a company-hosted embed → submit identity gate refuses — OPEN (needs operator review)
- **Evidence:** 7 samsara apps fully filled + verified (READY_TO_SUBMIT), then
  "ATS mismatch: URL validated as greenhouse but the page detected as
  generic". boards.greenhouse.io/samsara/... renders samsara's own embed.
- **Proposed fix (NOT applied — submit gating is a never-weaken invariant):**
  teach the page-identity DETECTION to recognize a first-party greenhouse
  embed (grnhse_app container / gh_jid iframe with the SAME board token+job
  id) as greenhouse. Detection accuracy, not gate relaxation — but it changes
  what passes the gate, so it needs your review before shipping.

### 19. Cloudflare: conditional follow-up questions shift the DOM under the fill — OPEN
- **Evidence:** app 7cc468eb — predictor PLANNED correct answers (enrolled:
  Yes, graduation: June 2029, degree: Undergrad) but all landed "(empty)" and
  "Undergrad" landed in the city field (cross-fill). Cloudflare reveals
  follow-ups as prior answers commit; field targeting drifts.
- **Direction:** re-resolve controls after each conditional commit, or
  two-pass fill (commit conditionals first, re-inspect, fill the revealed
  set). Progressive-overload sandbox: fixture form where answering Q1
  inserts Q2 into the DOM.

## Session notes
- 20:50 stopped prior cycle mid-session (8 apps started, 10 submits left) to
  swap in updated resume (jake_swe.pdf) per operator; relaunched with 3-hour caps.
- 21:00 operator extended run 3h → 6h (target end ~02:55).
- 21:04 operator directive: prefer the deterministic fill tool + LLM essay
  generate/predict over the JobRight extension. Flipped
  JOBRIGHT_AUTOFILL_ENABLED=false (NATIVE_AUTOFILL, SCREENER_LLM_MATCH,
  SCREENER_PREDICT_LLM, ESSAY_DRAFT, ESSAY_AUTOFILL stay true;
  AGENT_FALLBACK stays true — navigation's agent leg needs it, it is not the
  extension fill path). Session A relaunched as arm d2d4104f
  (240 min, 60 apps, 40 submits, ends ~01:05); session B (~110 min) follows.
- 21:25 operator additions: portal login + Gmail/Outlook verification confirmed
  already configured; contact info (phone 480-589-7636, jh.edu email) already in
  public-profile.json; sensitive profile encrypted via candidate:encrypt-sensitive
  (draft deleted — EEO fills now come from the DPAPI store). Per-job deadline
  tightened 5 min → 3 min. Caps removed per operator: session A relaunching as
  --max-apps/--max-submits 100000, duration 240 (arm clamp), ends ~01:30;
  session B covers the remainder to ~02:55.
