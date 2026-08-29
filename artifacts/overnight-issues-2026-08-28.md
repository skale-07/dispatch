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
