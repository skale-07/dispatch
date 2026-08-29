# Overnight session issues — 2026-08-29 (open-ended run, until operator stop)

Operator directive (this session): run auto:cycle continuously until told to
stop; focus one job at a time to submission; per-job deadline 3 min
discovery→submit — if slower, stop and diagnose; every unsuccessful submit
logged here; recurring patterns get a "progressive overload" sandbox test one
level above the failure. Push notification only for urgent items.

Carried over from 2026-08-28 (still open): #2 JobRight-leftover form-reach,
#9 ashby control-not-found, #12 FIELD_VERIFICATION fresh-page resume,
#13 CDP instability, #16 nav illegal transition, #17 stored-URL mismatches,
#18 samsara greenhouse-embed identity mismatch (7 apps READY_TO_SUBMIT —
being fixed tonight as detection accuracy), #19 Cloudflare conditional forms.

Start-state counts: 22 QUEUED, 7 READY_TO_SUBMIT (gate-blocked #18),
21 AMBIGUOUS_FIELD, 17 APPLICATION_OPENING, 16 NATIVE_AUTOFILL_RUNNING,
12 FAILED_RETRYABLE, 64 FAILED_FINAL, 1 each AUTH_REQUIRED / COMPLETED /
FIELD_VERIFICATION.

## Issue log

### 20. Session 16:43Z drained in 7 min, 0 submits — same two blockers as last night
- **Evidence:** cycle-2026-08-29T16-43-32-653Z.json: 23 apps started, all
  gated. 7× ATS-mismatch (issue #18, pre-fix code), 5× pipeline_error
  "Invalid state transition: APPLICATION_OPENING -> FILTERED_OUT" (issue
  #16), each dropping the shared nav session. Discovery: 3+1+1+1+1+1
  eligible enqueued.
- **Action:** both fixed this session (see below); relaunch after gate.

### #16 FIXED — APPLICATION_OPENING → FILTERED_OUT is now a legal edge
- Nav learns mid-opening that JobRight says the posting is closed; that is
  ineligibility, not failure. Edge added in src/queue/states.ts with
  docs/state-machine.md note + canTransition unit test. Root cause of 5
  pipeline_errors in session 4590de55 (and 6 in 85e567a9 last night).

### #18 FIXED (detection accuracy) — first-party greenhouse embed recognized
- greenhouse.detect() now scores `?gh_jid=<digits>` (+0.5, only when the
  vendor host didn't already score) and grnhse_app/embed-iframe markers
  (+0.3). Live evidence: boards.greenhouse.io/samsara/jobs/8097345 302s to
  www.samsara.com/...?gh_jid=8097345 where the greenhouse fill already ran
  LIVE_MUTATION_CONFIRMED, but submit-time re-detection read "generic" and
  the ATS-mismatch check refused. Job-id identity is still enforced by the
  greenhouse gate (extractGreenhouseJobIdFromUrl reads gh_jid); the
  submit gate itself is untouched. 4 progressive-overload detection tests
  added (positive samsara-shaped case, gh_jid-alone, and two negative
  controls that must stay generic).

### 21. RECURRING PATTERN across the 21 AMBIGUOUS_FIELD apps — checkbox controls coerced to `true` when the plan holds a text/option answer
- **Evidence (review payloads):** ashby 6509763b: veteran_status expected
  "I am not a veteran" → observed `true` on `...-labeled-checkbox-2`; ashby
  a600b3bc: linkedin_url (a URL!) mapped to `...-labeled-checkbox-0` →
  observed `true`; databricks eeb4d446/f5003802 export-control country
  (issue #10) — same shape. Two defects: (a) the field mapper claims
  labeled-checkbox controls for text-valued canonical fields; (b) the fill
  path coerces to a boolean check instead of refusing the kind mismatch.
- **Also recurring:** Neuralink screener "I understand… on-site" expected
  "Yes" → "(empty)" (checkbox-group option never clicked, f_24/f_28 ×4
  apps); Neuralink relocate-question mis-mapped to address.city (alias
  hijack variant not covered by bd30947).
- **Plan:** progressive-overload fixture — labeled checkbox group where the
  planned answer must land on the matching labeled option, boolean-true
  must be refused as kind mismatch. Target after relaunch.

### 22. FIXED — fixture fill tests leaked the operator's live .env (essay LLM answered a fixture textarea)
- **Evidence:** essay-workflow test "fills the essay textarea from a human
  answer" failed the gate: the "extra" textarea came back approved with a
  generated ClarityAtlas answer — a REAL Anthropic call from a unit test
  (16–22s test time). `applyFixtureFillEnv` set its 3 flags but, unlike
  `applySafeFillEnv`, never cleared the other controlled keys, so
  `ESSAY_AUTOFILL_ENABLED=true` from the standing .env reached the fixture
  fill. Violates the "tests need no live network / enabled flags" gate rule.
- **Fix:** applyFixtureFillEnv now deletes all controlled keys before
  enabling its three. 11/11 essay suite green, 2.9s (was 22s).

### 23. Session 17:04Z (24 apps, 0 submits, drained ~10 min) — both earlier fixes CONFIRMED live, next wall exposed
- **#16 confirmed:** 5 closed postings ended FILTERED_OUT cleanly (4a60f1c4,
  88ece651, 13e97030, d4ef545f, a334c5eb) — zero nav-session drops from
  that path (one unrelated page.content race on 7d6c2811 remains).
- **#18 confirmed:** all 3 samsara SWE apps passed the ATS-identity check
  (no more "detected as generic"). New refusal: "field verification or
  upload did not pass" — brief shows (a) resume upload "Saw 0
  input[type=file]" (samsara embed uses a click-created dropzone input —
  issue #1's shape) and (b) one selectOption timeout on a custom widget
  (v-0-0-0-3-68). Cloudflare retryables refused the same way via #19.
- **All three samsara SWE apps now FAILED_RETRYABLE** — next session
  re-runs them fill→submit in one pass once requeued.

### #1 FIXED (dropzone upload) — filechooser fallback when no input[type=file] exists
- greenhouseUploadFile: when resolveGreenhouseFileInput finds zero file
  inputs in any frame, click the resume-context upload trigger while
  intercepting Playwright's filechooser event (no OS dialog) and set the
  file on the chooser. Trigger selection is evidence-based (upload-ish
  text + kind keywords in text/section; single-trigger resume exception);
  verified only on chip/filename read-back — no acknowledgment ⇒ still
  refuses. Progressive-overload fixture dropzone-upload.html (click-created
  input, resume vs cover triggers) + negative no-trigger test. 8/8 phase5.

### 24. ROOT CAUSE of the samsara wall (supersedes the #1-dropzone read): gate passed on page CHROME
- **Probes (read-only, live samsara page):** the ?gh_jid= landing's main
  document contains exactly 2 controls — footer "Select region" pickers
  (v-0-0-0-3-68 / v-0-0-0-3-148, the very ids in the failed briefs). The
  REAL form (49 controls incl. 2 file inputs) lives in a
  job-boards.greenhouse.io/embed/job_app iframe that only loads after the
  Apply Now click. The mutation gate PASSED on the chrome (form markers +
  2 fields), so the fill "verified" the region pickers, READY_TO_SUBMIT
  was junk, and only the upload guard ("Saw 0 input[type=file]") refused.
- **Fix:** gateLooksLikePostingShell — a passing gate whose page has no
  applicant-identity fields is treated as a posting shell; the existing
  Apply+hop recovery now runs for it (both retry rungs). Fixture: passing
  gate on identity-free chrome with Apply-revealed real form. The
  filechooser-dropzone fallback (earlier tonight) stays — it guards the
  distinct custom-widget shape.

### 25. Session 17:58Z — posting-shell fix CONFIRMED live; two new samsara walls, one fixed
- Fills now land on the real embed form (briefs show real questions: work
  authorization, personal-data consent, zip, salary-range). f8ffaa10
  (London) passed fill+verify+upload entirely and failed ONLY on
  "submit control not found" → FIXED: frame-aware submit search + typeless
  "Submit application" text fallback (selectors registry
  submitTextFallback; 2 fixture tests incl. iframe srcdoc).
- **Still open on 4d570a70/07b452d7 (next targets):**
  (a) react-select Yes/No comboboxes "filter yielded no/unmatched
  options" (question_68338892/94, 68220142/44);
  (b) plan mis-mapping: "[Compensation] Do you accept the listed salary
  range" planned "Online Job Board" (a how_heard answer), zip-code
  question observed "Yes" (cross-fill) — mapping hijack variant beyond
  bd30947, needs the samsara question bank/alias review next session.

### 26. Queue clog: 15/22 QUEUED apps picker-blocked by open MANUAL review items
- Sessions "drained" in minutes while IBM/Citadel/Schwab/Notion apps sat
  QUEUED — each held an open MANUAL item (duplicate-posting parks,
  "Answer needed" prompts from prior attempts, nav-budget). Applied the
  operator-guide remedy: review:bulk --action dismiss --kind MANUAL
  --apply (51 items). UNCERTAIN_SUBMISSION and AMBIGUOUS_FIELD items
  untouched. "Answer needed" prompts re-create on the next attempt if the
  predictor still can't answer them.

### 27. auto-cycle test flake root-caused: 5s timeouts under load — FIXED 195c339
- Verbose full run showed timeouts (not assertions) on the two tests that
  execute 2–3 full runAutoCycle cycles, while a live session + Chrome
  shared the machine. 30s explicit timeouts added.

### Operator-scope action: samsara SWE re-enqueue (re-discovery convention)
- 4d570a70/f8ffaa10/07b452d7 hit attempt caps (FAILED_FINAL) with every
  attempt burned on infra bugs fixed tonight (posting-shell reach, submit
  control, upload). Fresh rows created for the same jobs via legal edges
  (terminal rows don't block dedupe): 529d6511 (SWE I New Grad), 2270889b
  (SWE Intern London), cd03f7c6 (SWE Intern SF) — all QUEUED.

### Operator directive (live, ~14:40 local): personal Gmail is the main application email
- public-profile.json email: skale1@jh.edu → skale072007@gmail.com (all
  future fills). jh.edu now only fills fields that ask for a school/
  university/.edu email — added `school_email` custom bank entry with 10
  label variants. PORTAL_LOGIN_EMAIL was already the personal Gmail.
- Session 6 stopped mid-run for the change; relaunched as session 7.
- **GAP (needs operator):** Gmail token missing (`gmail:check`). Codes and
  confirmations sent to the personal Gmail are unreadable until
  `npm run gmail:auth` is run once for skale072007@gmail.com. Outlook
  (jh.edu) verification stays active for anything still sent there.
- Apps already submitted with jh.edu keep notifying jh.edu — not
  retroactively changeable.

### 28. FIRST 3 SUBMIT CLICKS (orphan session 26a41892, 18:22–18:30Z) — all parked UNCERTAIN, three distinct walls
- 5902f351 TransMarket SWE Intern: form fully verified on receipt; emailed
  8-char code wall to skale1@jh.edu; recovery failed because the OUTLOOK
  SESSION EXPIRED (login.microsoftonline.com redirect) — needs
  `npm run login:outlook`, then review:resolve/requeue.
- 0607aaab Xaira AI Scientist Intern: filled incl. 3 essay answers + EEO
  self-ID; blocked on REQUIRED COVER LETTER (no generation/attach path —
  feature gap).
- 52578119 Appian SWE Intern: filled (already with the personal Gmail);
  blocked on REQUIRED TRANSCRIPT upload — private/candidate/transcript.pdf
  exists, wiring it next.
- **Cross-cutting bug:** the pre-click completeness scan missed required
  FILE fields (cover letter, transcript) — two clicks burned on walls that
  were knowable before the click. Fix: completeness must treat a required,
  empty file input as unanswered.
- Note: TaskStop on a session kills only the shell wrapper on Windows —
  the node worker survived as an orphan (how these clicks happened while
  "stopped"). Supervisor now kills node PIDs + disarms explicitly.

### 29. Nav-audit duplicate detector counts TERMINAL rows — re-parks legal re-discoveries — OPEN
- The 3 samsara re-enqueues (and notion e4f01130) immediately got new
  "Duplicate posting" MANUAL parks: the audit's URL-duplicate check treats
  a FAILED_FINAL row as an active holder, defeating the documented
  re-discovery convention (terminal rows don't block a new row). Dismissed
  the items again (23 MANUAL total); fix direction: exclude
  COMPLETED/FAILED_FINAL/FILTERED_OUT holders in the audit's duplicate
  pass. Until fixed, each session re-parks these — dismissal needed per
  cycle (supervisor handles it).

### Operator-scope action: 4 samsara ADR apps abandoned
- bc3adad0/cc70554a (ADR Intern Atlanta/Phoenix), 68485479/9ee5373a
  (ADR II New Grad Atlanta/Phoenix) → FAILED_FINAL route INELIGIBLE via the
  state machine. Reason: non-SWE sales roles (last night's worklist item 5
  named ADR strays); with #18 fixed they would have auto-submitted. The 3
  samsara SWE apps (4d570a70 SWE I New Grad, f8ffaa10 SWE Intern London,
  07b452d7 SWE Intern SF) stay READY_TO_SUBMIT and are the first submit
  candidates after relaunch. Re-discovery can recreate the ADR rows if you
  actually wanted them.
