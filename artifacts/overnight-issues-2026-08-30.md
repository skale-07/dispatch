# Overnight session issues — 2026-08-30 (open-ended run, until operator stop)

Operator directive (this session): run auto:cycle continuously until told to
stop; focus one job at a time to submission; per-job deadline 4:30 min
discovery→submit — if slower, stop and diagnose; every unsuccessful submit
logged here; recurring patterns get a "progressive overload" sandbox test one
level above the failure. Push notification only for urgent items.

Pre-flight state (10:05 local):
- Debug Chrome CDP at 9222: attaches cleanly (2 Playwright connects verified).
  Profile signed into BOTH JobRight (feed authenticated) and Gmail
  (skale072007@gmail.com) — issue #33's operator gap is CLOSED; emailed-code
  recovery can now read the inbox (TransMarket/Appian/Figma Greenhouse codes
  already visible there).
- Queue: 12 QUEUED, 34 APPLICATION_OPENING, 18 NATIVE_AUTOFILL_RUNNING,
  36 AMBIGUOUS_FIELD, 6 FAILED_RETRYABLE, 4 SUBMISSION_VERIFICATION_FAILED,
  111 FAILED_FINAL, 1 COMPLETED. Flags: form_fill+submit on, dry_run off.
- night17 (ended 00:25 local) died on #13: CDP "port answers, attach times
  out" mid-session — took out every later app. Currently healthy; watching
  for recurrence (if it recurs mid-run, that's the next progressive-overload
  target: attach-retry/relaunch seam instead of per-app hard failure).

Carried over (still open): #19 Cloudflare conditional forms, #21 checkbox
kind-mismatch coercion (progressive-overload fixture still owed), #25b
samsara react-select Yes/No combobox filter misses, #28 cover-letter
generation gap (Xaira), #29 nav-audit duplicate detector counts terminal
rows (needs per-cycle MANUAL dismissal until fixed), #33 now closed.

## Issue log

_(Night19 supervisor picked up at 10:25 local; the night18 session above had
logged only its pre-flight before dying.)_

### 34. ROOT CAUSE of #13 (recurring CDP "port answers but attach times out") — the in-session restart was theatre — FIXED
- **Evidence:** night18 log: 3× "CDP restart n/3: debug Chrome relaunched and
  reachable — continuing session", then 40+ consecutive apps died on the same
  attach timeout. At supervisor start the same Chrome (PID 17032, started
  09:51) was still wedged: `/json/version` answered, Playwright
  `connectOverCDP` timed out at 15s. `where wmic` → not found: Windows 11
  build 26200 has REMOVED wmic, so `killDebugChrome` silently did nothing,
  the "relaunch" was absorbed by the running instance (Chrome single-instance
  handoff), and the HTTP-only readiness probe reported success against the
  same dead process.
- **Fix (src/automation/cdpChrome.ts):** PID discovery via PowerShell CIM
  (`listDebugChromePids`, debug-profile dir match only), `taskkill /F /PID`,
  bounded post-kill liveness poll that REFUSES to relaunch over survivors
  ("relaunch would be absorbed"), and a real `probeCdpAttach` (connectOverCDP
  + detach) that demotes "reachable" when only the port answers.
  **Worker:** new stop reason `cdp_unrecoverable` — a failed restart or a
  recurrence after the 3-restart cap stops the session and leaves the queue
  for the next cycle instead of failing every remaining app (each of those
  would otherwise have been a burned attempt toward FAILED_FINAL).
- **Live verification:** running the new `restartCdpChrome` against the
  wedged Chrome killed 10 PIDs, relaunched, and the attach probe passed in
  8.5s → LIVE_MUTATION_CONFIRMED for the restart seam (infra mutation only).
  5 fixture tests (absorbed-relaunch refusal, attach-fail demotion, worker
  stop on failed restart, stop after cap, existing flag-off refusal).
- **Also shipped:** `auto:cycle --app-deadline <sec>` — per-job wall-clock
  budget enforced at pipeline step boundaries via the cooperative skip seam
  (operator directive: 3 min/job, then diagnose). Session note
  `deadline <id>: Ns > Ms budget — stopped in <STATE>`.
- Commit 7681d2a. Housekeeping: 12 MANUAL parks dismissed per the guide's
  per-cycle convention (#29 still open: 3 were agent_unavailable = this CDP
  wall, 1 the notion duplicate re-park); 4 ancient RUNNING `submit`-stage
  rows (Aug 7–14, empty metadata) are not arm rows and are harmless.

### 35. RECURRING (3×, all Ashby) — submit gate refused `BLOCKING_CAPTCHA` on an INVISIBLE reCAPTCHA — FIXED + progressive-overload set
- **Evidence:** submit_attempts for 23d64c04 Quadrillion (×2, 00:06Z and
  03:16Z) and d607b204 Composio (04:03Z), all `jobs.ashbyhq.com`, all
  `FAILED_BEFORE_CLICK` with signals
  `challenge_iframe_rendered,recaptcha_widget_container,readable_application_form_present`
  — the fill had just been "rehearsal verified" on the same page, and
  the app went READY_TO_SUBMIT → FAILED_RETRYABLE, burning attempts
  (Composio now a3 = cap).
- **Live read-only probe (CDP, Composio page):** one anchor iframe
  `recaptcha/api2/anchor…` 256×60 sitting inside `.grecaptcha-badge`
  with computed `visibility: hidden`; the bframe placeholder has
  `src=""` + `display:none`; NO `.g-recaptcha` element; 10 readable
  fields. I.e. invisible reCAPTCHA v2 that executes on submit — dormant.
  Static scoring: anchor iframe +3, and `recaptcha_widget_container` +3
  because `\bg-recaptcha\b` also matches `class="g-recaptcha-response"`
  (the hidden response textarea every invisible reCAPTCHA ships); −2 for
  the readable form = 4 = HIGH.
- **Fix (captchaDetection.ts):** an anchor iframe with `size=invisible`
  on its src OR a `grecaptcha-badge` wrapper on the page is a dormant
  marker (`invisible_recaptcha_anchor`), not a challenge; widget-class
  regexes now require the exact token (`(?![\w-])`); an explicit
  `<div class="g-recaptcha" data-size="invisible">` is dormant
  (`invisible_recaptcha_widget`). bframe/hCaptcha/Turnstile frames,
  checkbox-v2 anchors, and interstitials score exactly as before.
- **Progressive-overload fixture** `tests/fixtures/ats/ashby/
  captcha-invisible-recaptcha.html` (live shape) + 5 tests: live shape,
  badge-less `size=invisible`, explicit invisible widget in both
  attribute orders, and two negative controls that MUST still block
  (checkbox v2 with a visible widget; an open bframe with no readable
  form). Both Ashby apps requeued (named `retry --app` override) as the
  first live check of this fix. Commit fcd0fe5.

### Job #1 — 23d64c04 Quadrillion SWE Intern (Ashby) — 10:53 local, 27s discovery→click, NOT submitted
- #35 fix CONFIRMED live: captcha gate passed, fill reused (5 fields),
  submit control clicked (`submits_used: 1`).
- **Wall:** post-click page = Ashby banner "We couldn't submit your
  application — Your application submission was flagged as possible
  spam" (receipt-attempt-5.png). Classifier read `unknown`, code-recovery
  diagnosis said "no visible errors found", run burned the 15s window and
  parked UNCERTAIN_SUBMISSION (operator-only resolution) although the page
  had already answered "not submitted".

### 36. Two defects behind job #1 — on-page rejection unread; live fill/submit runs in headless bundled Chromium — FIXED (pending live check)
- **(a) Classifier:** `detectSubmissionRejection` (shared) + Ashby
  classification `rejected` (wins over still_on_form/unknown, fast-fails
  with the refusal text). submitRun maps `rejected` to a NEW definitive
  outcome `REJECTED_AFTER_CLICK`: submission marked failed, idempotency key
  failed, app → FAILED_RETRYABLE with the refusal in the reason, no
  UNCERTAIN park. 4 tests (banner alone, banner over a rendered form,
  "spam" as a screener word must NOT match, fast-fail < 7s with evidence).
- **(b) Spam root cause:** `openPublicUrlSession` hard-coded
  `channel: "chromium"` (Playwright's bundled Chrome-for-Testing) and the
  automation session runs it headless — only NAVIGATION uses the real CDP
  Chrome. Ashby's invisible reCAPTCHA scores that browser as a bot and the
  server refuses the POST as spam. Fix: the live fill/submit/held-page
  callers now pass the operator's `BROWSER_CHANNEL` (.env = chrome, an
  installed supported browser — not stealth); fixture/test paths keep the
  bundled Chromium. Night19 sessions run `--headed` from here on.
- **Operator:** the 23d64c04 UNCERTAIN item (85deccfc) should be resolved
  `not-submitted --requeue`; the receipt is unambiguous. Doing that here
  since the page evidence is explicit and the resolve path is the guide's.
- Commit ba2c7e0.

### Job #2 — 23d64c04 Quadrillion again (headed, installed Chrome channel) — 11:03 local, 10s, NOT submitted
- **#36(a) CONFIRMED live:** `REJECTED_AFTER_CLICK` → FAILED_RETRYABLE in
  10s with the refusal text in the reason; no UNCERTAIN park.
- **#36(b) NOT sufficient:** Ashby still answered "flagged as possible
  spam" from a headed, installed-Chrome, Playwright-launched, profile-less
  browser. Next rung (#37): open live fill/submit pages as a new tab in
  the operator's own debug Chrome (`AGENT_CDP_URL`, the nav seam — real
  signed-in profile, real history) when `NAVIGATION_ENABLED`; fall back to
  the launch path when the endpoint won't attach. Closes only its own tab.
  Not fingerprint spoofing — the project's existing trusted browser.
  If Ashby STILL flags it from the real profile, the signal is rate/IP
  based (Quadrillion is at attempt 6 tonight) and Ashby apps get abandoned
  for the night rather than ground on. 23d64c04 is at the attempt cap; the
  live check is d607b204 Composio (QUEUED, a4). Commit 3c8aee7.

### Job #3 — d607b204 Composio Fullstack Intern (Ashby) — 11:08 local, 21s, NOT submitted — #37 CONFIRMED, new wall
- **#37 (CDP tab in the operator's Chrome) CONFIRMED live:** NO spam
  banner this time — Ashby processed the click and answered with a real
  validation error instead. The spam flag was the profile-less browser.
- **Wall:** "Your form needs corrections — Missing entry for required
  field: Complete the Takehome" (a required Yes/No segmented control
  asking whether the 1–2.5h take-home assignment is done). Two findings:
  (a) the validation fast-fail regex did not know Ashby's phrasing, so
  the run burned the 15s window and parked UNCERTAIN (2nd occurrence —
  Quadrillion 2026-08-11 receipt shows the same banner) → FIXED: regex +
  field-name extraction ("missing entry for required field: Complete the
  Takehome"), and still_on_form+validation-error is now a definitive
  `REJECTED_AFTER_CLICK` (FAILED_RETRYABLE) plus a MANUAL "Answer needed"
  item naming the field; test with the live banner shape.
  (b) the pre-click completeness scan missed a required segmented
  Yes/No control — logged as a candidate progressive-overload target if
  it recurs on a fillable question.
- **Abandoned (reason recorded):** the answer would assert a completed
  take-home the operator has not done; not fillable by policy. Item
  resolved not-submitted, no requeue (row stays FAILED_RETRYABLE at the
  cap). Operator: do the take-home, then `retry --app d607b204`.
- Commit d99f0ef.

### Job #4 — 83751e38 Rivian SWE Intern (iCIMS) — 11:15 local, 11s, NOT submitted
- Navigation resolved the right page
  (`internal-careers-rivian.icims.com/jobs/27486/software-engineering-intern…`)
  in 6s via the JobRight Apply popup; the fill then REFUSED: "stored URL
  is for 'softwareengineeringintern2cconnectedsystemssummer2026', not
  Rivian" and parked a MANUAL item. The identity decoder skipped the
  tenant subdomain (icims.com is a multi-employer host) and let the
  job-title path slug accuse the URL.

### 38. RECURRING (12 live URLs tonight/last night) — URL-identity decoder accuses correct URLs and misses tenant subdomains — FIXED + progressive-overload set
- **Evidence (review payloads):** 5 correct URLs accused — Rivian and
  Schwab (icims tenant subdomain + title slug), Cleveland Research
  (applytojob tenant + posting id "zy7WHaTRsu"), Atlas (hrmdirect
  "oneatlas" + "employment"), Bear Robotics (breezy.hr tenant + posting
  id); 7 URLs that name no employer were accused by a page word or code —
  "view" (linkedin ×2), "hcmui" (oraclecloud), "tgnewui" (brassring),
  "ultipro" (vendor host not in the list), "globalhr"/"myworkdayjobs"
  (RTX Workday tenant is a generic word), "BEN1022BTLL" (UKG tenant code
  for btcpa = Barbacane Thornton).
- **Fix (src/navigation/congruence.ts):** (1) tenant-subdomain labels on
  multi-employer/vendor hosts are match evidence (source `tenant`, split
  on hyphens + joined); (2) `accuser` flag — only a clean single word
  (letters, ≥4; ≥5 for tenants) may turn "nothing matched" into a
  mismatch; title slugs, tenant codes, posting ids and phrases can match
  but never convict; (3) page words added to GENERIC_URL_WORDS, `ultipro`
  to the vendor regex, `myworkdayjobs.com` to multi-employer hosts;
  (4) initials-PREFIX match for short slugs ("btcpa"); (5) `%2c` decoded
  before tokenising. Matching authority unchanged: ATS slugs still convict.
- **Progressive-overload set:** all 12 live URLs as `it.each` (6 must
  match, 6 must be unknown), accuser-shape assertions, and two harder
  negative controls: a WRONG tenant on the same board ("schwab" for
  Rivian) must still be a mismatch; initials-prefix must not fire on a
  long unrelated word. Cohere trio + all prior congruence tests untouched.
- Commit 026683b. Rivian's MANUAL park dismissed; it re-runs next pick.

### Job #5 — 976529cb Zipline Electrical Project Engineer Intern (Greenhouse via zipline.com) — 11:22 local, 87s, NOT submitted → abandoned
- Hardware stray the nav-requeue sweep pulled back in (I had left it
  alone). Agent navigation 83s → job-boards.greenhouse.io/flyzipline/
  jobs/7980874003, which 302s to www.zipline.com/open-roles?gh_jid=….
  Posting-shell detection fired correctly, Apply and iframe hop both
  missed ("no hopable iframe — frames: main only"), and the fill then
  ran on the page's two "Search roles" boxes → AMBIGUOUS_FIELD, and the
  predictor persisted `search_roles_query_2 = "Software Engineer
  Intern"` into screeners.json (bank poisoning, #32's shape).
- Abandoned via the state machine (FAILED_FINAL, reason recorded:
  non-SWE hardware role). The SWE Zipline app be8620a0 (QUEUED) hits the
  same page shape and is the live check for #39.

### 39. Posting shell with NO Apply and NO iframe (zipline.com gh_jid) — fill ran on page chrome and poisoned the bank — FIXED + progressive-overload set
- **Fix A (liveFill.ts):** `greenhouseEmbedFallbackUrl` — when a
  ?gh_jid= shell has nothing to hop to, ONE navigation to Greenhouse's
  canonical `boards.greenhouse.io/embed/job_app?for=<board>&token=<id>`
  (board from the requested URL, id from either), then re-gate.
  **Fix B:** if the page is still chrome after every rung, the reach
  REFUSES (`FORM_NOT_FOUND`, "posting shell: … application form never
  rendered") instead of handing search boxes to the fill.
  **Fix C (screenerMatch/screenersIO):** `isPageWidgetLabel` fence —
  "Search roles/jobs", "Keywords", "Filter by…", "Sort by", "Email me
  jobs" etc. are never stored, attached, or matched; the poisoned
  `search_roles_query_2` entry deleted from the bank.
- **Tests:** 5 embed-URL cases (live zipline shape; samsara-shaped split
  evidence; already-embed; missing board/id; encoding + host pin), a
  fixture reach test for the zipline listing shell that must refuse
  (no board token ⇒ no network), and 16 widget-label cases + a poisoned-
  bank reuse test. Commit 8caf0ec.

### Job #6 — 279c395b Neuralink SWE Intern, BCI Applications — 11:31 local, 60s, NOT submitted → abandoned (true duplicate)
- Agent navigation (54s) found the Greenhouse URL; nav refused it as
  `duplicate_url` — correctly: 5766f038 (same role, AMBIGUOUS_FIELD) is a
  live holder, not a terminal one (#29 does not apply here). JobRight
  re-listed this role 4× (d1974007, 82dd996e, 5766f038, 279c395b).
  Abandoned via the state machine with the holder named.
- **Pattern surfaced:** 12 Neuralink SWE/ML rows sit in AMBIGUOUS_FIELD
  from last night — the largest single cluster in the queue. That is
  issue #21 (checkbox-group screener "I understand… on-site" never
  clicked; kind-mismatch coercion). Next work item.

### 40. #21 ROOT-CAUSED on the live Neuralink DOM — checkbox GROUPS were discovered as one field per option — FIXED + progressive-overload set
- **Live read-only DOM (job-boards.greenhouse.io/neuralink/jobs/5469298003,
  43 inputs):** every checkbox question is `<fieldset><legend>Q</legend>`
  with members `<input type=checkbox name="question_N[]"
  description="Q">` + `<label for>OPTION</label>`. Discovery read each
  member as its own field named by the OPTION: "LinkedIn" (an option of
  "How did you hear about us?") became a field the mapper claimed as
  `linkedin_url` (URL → checkbox → verify read `true` / "(empty)");
  "I understand… on-site" (one member, option "Yes") had no control the
  legend text could locate ("control not found" f_24); and the
  "Are you authorized…?" [Yes|No] group would have taken "No" as
  "uncheck the first box".
- **Fix (fieldDiscovery.ts):** a checkbox member with a `description`
  attr or an enclosing fieldset legend takes the QUESTION as label and
  its own label as an option; `collapseCheckboxGroups` folds members by
  `name` into one field (id = name, options = member labels, inputId =
  first member as the locator anchor). Lone checkboxes with their own
  label (privacy consent) are untouched. **fill.ts:** a multi-member
  group takes the option path even for Yes/No — "No" checks the No
  member; only a lone box reads Yes/No as its state.
- **Progressive-overload fixture** `tests/fixtures/ats/greenhouse/
  checkbox-groups.html` (the live markup, sanitized) + 9 tests:
  discovery (one field per group, 12 options, "LinkedIn" never a field
  label, one-member group, lone consent box, legend-only variant) and
  fill/verify (Yes on the one-member group; No on Yes|No checks the NO
  member; "LinkedIn" checks the option while "LinkedIn Profile" gets the
  URL; no-match refuses by name with nothing checked).
- Relocation-question → address.city hijack (4dc34df9) not yet
  addressed — separate alias problem; watch for recurrence.
- Commit 7e2b33c.

### Job #7 — 1e213072 Neuralink SWE Intern, Infrastructure (Greenhouse) — 11:41–11:46 local, two runs, NOT submitted (refused before click)
- Requeued from AMBIGUOUS_FIELD via the console resolver (FIELD_VERIFICATION)
  and driven with `run --pipeline --app … --submit --headed` (first run
  REFUSED for my missing `--yes`; second with `--yes`). Second run:
  FAILED_BEFORE_CLICK, 8 items: five comboboxes "(empty)" (graduation
  year, sponsorship, relocation, intern season, Hispanic/Latino) plus
  `f_25` "I understand… on-site" control-not-found, and season
  "12 or 16 weeks" matching none of the page's options (a real bank
  mismatch — `internship_term` answer vs the form's options; operator
  bank item, not a code bug).
- **Diagnosis via `ats:fill --url … --execute --headed` on the same page
  (same CDP tab):** 22/24 verified OK — comboboxes fill fine in the
  real-Chrome tab. Only `f_24` failed, and the healer then "healed" it
  onto `#question_16876432003` (the relocation combobox) at score 0.45.

### 41. Two more Greenhouse job-boards defects — hidden required sentinels discovered as fields; submit path verifies AFTER the upload re-render — FIXED
- **(a)** job-boards ships `<input required tabindex="-1"
  aria-hidden="true" class="…requiredInput">` after every combobox and
  checkbox group. Discovery emitted them as text fields labeled by the
  nearest legend (f_24/f_25 "I understand… on-site", f_12/f_14/f_21/f_26
  "field_N"); one even took the `willing_to_relocate` alias. Fix: an
  input whose OWN attributes are hidden is skipped (`isHiddenAttrs`).
  Fixture gains the sentinel; test asserts no ghost `f_N` and exactly
  one on-site field.
- **(b)** submit path order was fill → essays → upload → verify while the
  fill-only path is fill → verify → upload; the five comboboxes were
  empty only in the former. Fix: when the post-upload verify fails, ONE
  re-fill + re-verify (the existing reuse-fallback, generalised and
  logged as `post_upload_refill`). Bounded; verify still decides.
- Next: 1e213072 requeued (`retry --app`) as the live check. Commit ab7418a.

### Jobs #7c–#7f — Neuralink, four more runs (11:55–12:15 local): 8 blockers → 0 field blockers → SUBMIT CLICKED → emailed-code wall
- **#7c:** the checkbox/ghost fixes held; ONE mismatch left — season
  combobox: bank had "12 or 16 weeks" (a LENGTH answer) attached to the
  season labels (paraphrase-attach poisoning, #32's shape). Options on
  the form: "Fall 2026 (September - December)" | "Winter 2027 (January -
  April)". Detached the labels; added `internship_season = "Winter 2027
  (January - April)"` from the operator's own `second_cohort_flexibility`
  = "Winter (January - April)" + availability "Flexible — aligned to the
  posted term". ⚠ Operator: confirm/change in screeners.json. Code:
  length↔season topic fence + 9 tests (#42).
- **#7d:** fill + verify PASSED; the required-completeness scan then
  listed 13 "unanswered" checkboxes — every unchecked MEMBER of two
  answered groups. Fix: group-aware scan (one question per named group,
  answered by any member, labeled by the legend; control
  `checkbox_group`); test on the live fixture (#42).
- **#7e:** 1 left — the on-site acknowledgement group was
  `skip_unmapped`: `isCaptureWorthyQuestion` needed a "?" or "I agree/
  certify/…" for checkbox questions; added "I understand / I am aware /
  I accept". Bank: `onsite_requirement_acknowledged = Yes` (consistent
  with the operator's relocation "Yes" / "open to relocating"; ⚠ confirm).
- **#7f: SUBMIT CLICKED** (first click of the night that passed every
  pre-click gate). Greenhouse raised its 8-char emailed security-code
  wall (to skale072007@gmail.com). The mail ARRIVED at 12:10 ("Security
  code for your application to Neuralink") and the live-context Gmail
  scan opened it — but found "no fresh code": the code is 8 mixed-case
  LETTERS and `extractOtpCode` only scans digit runs. Then the Outlook
  provider threw "session invalid", the throw escaped the recovery, and
  the post-click run was recorded FAILED_BEFORE_CLICK / FAILED_RETRYABLE
  (the form is still sitting on the code wall — nothing was submitted).

### 43. Emailed-code recovery: letter codes unparsed; a dead provider aborted the chain; post-click error mislabeled — FIXED
- `extractOtpCode`: one alphanumeric token (6–12) directly after a
  "code …:" / "code is" phrase, rejected when it looks like a word
  (must be mixed case or carry a digit); digit codes keep their scoring.
- `chainVerificationCodeProviders`: a provider that throws (Outlook
  UNAUTHENTICATED) is logged and skipped, never fatal.
- submitRun: the whole post-click recovery is fenced — anything thrown
  parks UNCERTAIN instead of "failure before the click".
- ⚠ Operator (60s, not urgent): `npm run login:outlook` is expired; with
  Gmail primary this no longer blocks anything. Commit dfa3d49.

### ✅ Job #7g — 1e213072 Neuralink SWE Intern, Infrastructure — 12:28 local — SUBMITTED_VERIFIED (first submit of the night; LIVE_MUTATION_CONFIRMED)
- Full chain: CDP-tab fill (24 fields incl. 3 checkbox groups + essays)
  → verify → upload → completeness → click → Greenhouse emailed-code
  wall → Gmail live-context scan found the 8-letter code on poll 0 →
  typed into the split-box widget → re-click → confirmation receipt.
- Tail: contacts extraction failed "Cannot resolve stored job: no
  JobRight job id" (row came from the boards.json discovery, not
  JobRight) → parked review in CONTACTS_EXTRACTING. Submission itself is
  verified and recorded; tail fix next (#44).

### 44. Post-submit tail parks board-discovered rows — FIXED
- SUBMITTED handler now completes (reason "no JobRight job id — contact
  extraction not applicable") instead of running JobRight contact
  extraction and parking a MANUAL item; pipeline test added. 1e213072
  moved CONTACTS_EXTRACTING → COMPLETED via the state machine. Commit cf56990.

### Job #8 — 0f148a1e Huntington Summer 2027 Data & Analytics Internship (Workday) — 12:36 local, 28s, NOT submitted (AUTH_REQUIRED)
- Nav resolved the Workday posting in 5s. Portal auth walked Apply →
  Apply Manually → account form → flipped Create Account → Sign In with
  standing credentials → `sign_in: no_form_found` → parked "Workday
  account wall not cleared". First live exercise of the Workday portal
  login tonight (operator asked about exactly this path).

### 45. Workday sign-in: modal dialog over the create form; email input unrecognised; hidden real submit — FIXED + progressive-overload set
- **Live read-only DOM (huntington.wd12, after Apply → Apply Manually →
  Sign In):** the Create Account form STAYS in the DOM under a
  `[role=dialog]` holding the Sign In form; both email inputs are
  `type=text autocomplete=email data-automation-id=email` (no name/id →
  `email=false` in the diagnosis); page-wide password count = 3 → still
  "create_account_form" after the flip; the real `signInSubmitButton`
  is aria-hidden/tabindex=-2 while the visible control is `<div
  role=button data-automation-id=click_filter aria-label="Sign In">` —
  and the FIRST visible click_filter on the page belongs to the create
  form BEHIND the modal. A `beecatcher` honeypot (name=website) sits
  beside both forms.
- **Fix:** `authScope` — when a visible dialog holds a password input,
  diagnosis and the sign-in/create attempt scope to it (inputs, password
  count, submit lookup, button names, error text); `EMAIL_INPUT_SELECTOR`
  adds autocomplete=email / data-automation-id=email / aria-label /
  placeholder; registry accepts the role=button click_filter by
  aria-label; honeypot excluded from field counts and never filled.
- **Tests (live shape):** dialog diagnosed as sign_in_form (email=true,
  no confirm); sign-in happens INSIDE the dialog (create-form handlers
  would flag "wrong form"), honeypots stay empty; harder: a wrong
  standing password is credentials_rejected, never a blind create.
  Commit 8f61912.

### Job #8b — Huntington again — 12:49 local, NOT submitted; sign-in now recognised, wall "remains"
- `sign_in: sign_in_form` (dialog recognised, credentials typed, Sign In
  clicked) but no error read → "wall remains". Live probe of the exact
  response: Workday `data-automation-id="errorMessage"`: "You may have
  entered the wrong email address or password or your account might be
  locked." (this tenant has no account for the standing email — the only
  stored per-host account is interdigital.wd5).

### 46. Workday rejection sentence unread → the documented create-account escalation never ran — FIXED (+ `account_locked`)
- `ERROR_RE` learns "wrong email address or password", "might be
  locked", "unable to sign in"; Workday's `errorMessage`/`alertMessage`/
  `role=alert` containers are read first. New classification
  `account_locked` (real lock wording only: "account has been locked",
  "too many … attempts", "try again in N minutes") → portal auth parks
  `wall_remains` with the sentence and neither retries nor creates.
  Tests: live rejection ⇒ credentials_rejected + create route found;
  two lock sentences ⇒ account_locked; beecatcher label wording is not
  an error. Next live run should escalate: Create Account with the same
  standing email+password (guide §Employer-portal logins). Commit ec35237.

### Job #8c — Huntington — 13:01 local: sign-in rejected → Create Account opened and filled → "wall remains (create_account_form)"
- Escalation now runs. Live probe of the create step: email, both
  passwords, agreement checkbox filled; Create Account clicked (visible
  click_filter) → NOTHING changes after 8s, no error text.

### 47. ⚠ OPERATOR — the standing PORTAL_LOGIN_PASSWORD cannot create Workday accounts (policy) — guard added, password unchanged
- Workday's Create Account page states: numeric + ≥8 chars + special +
  lowercase + uppercase. The standing password is 39 chars with NO digit
  and NO lowercase letter → Workday's client-side validation swallows the
  click silently. This blocks every Workday tenant where no account
  exists yet (Huntington, Vanguard, Intel… — only interdigital.wd5 has a
  stored per-host account). **Fix is yours:** either set a compliant
  per-host password (`npm run cli -- accounts:set --host <tenant> --email
  skale072007@gmail.com --password "<compliant>"`) or change
  `PORTAL_LOGIN_PASSWORD` to one with a digit and a lowercase letter
  (it stays the one login used everywhere).
- **Code (#47):** `passwordPolicyGaps` reads the page's stated rules and
  the create attempt refuses BEFORE typing when the password fails them,
  with the exact missing classes in the note ("missing: numeric
  character, lowercase character") instead of "wall remains". Tests:
  live rule text ×3 (gaps / compliant / short), page with no rules never
  blocks, fixture create page with a non-compliant password is never
  submitted. Commit b1a9273.

### Job #9 — 2d517c7a DV Trading SWE Intern Summer 2027 (Greenhouse) — 13:15 local, 150s, NOT submitted (refused before click)
- Pipeline fill: 22 controls incl. 18 comboboxes picked exact/synonym,
  resume uploaded, verify PASSED (fill report errors []). Submit path on
  the held page: re-uploaded the resume → job-boards re-parsed/re-rendered
  → three verified comboboxes read "(empty)"; the one re-fill could not
  restore react-selects; and the submit-path re-plan (a second LLM
  prediction) answered "N/A" on "If yes, select your most recent
  proprietary trading firm…" (parent = No), which the pipeline plan had
  correctly left unanswered.

### 48. Second resume upload on a reused page wipes comboboxes; "If yes," follow-ups not recognised — FIXED
- `greenhouseUploadFile`: when the exact filename chip is visible and the
  file input is unmounted, the upload already happened — report verified,
  touch nothing (evidence string names it). Ends the destructive
  re-upload on the held submit page (#41b's real cause).
- `isConditionalYesFollowUp`: "If yes, …" / 'If "Yes", …' / "If you
  responded/chose yes" now skip when the parent answer is No. 10 cases.
- Noted (operator data): sponsorship answered "Yes, I will require
  sponsorship…" here vs "No" on Neuralink's "Will you, at any point,
  require employer sponsorship" — two canonical keys; worth one look at
  public-profile.json / screeners.json `requires_sponsorship`.
- Commit 412fc36. **#9b (13:29):** the skip did NOT fire — on this form
  the `#resume` input stays mounted beside the chip, so the mount check
  let the 30s second upload through again; re-fill then mis-committed an
  already-filled react-select ("Bachelor's Degree" picked, display shows
  "Doctor of Medicine (M.D.)") — the re-fill-on-filled-combobox hazard
  the code comment warned about. Fix: the chip alone (exact filename or
  long stem, the same read-back verification trusts) means attached;
  the pre-check now logs `input_mounted`/`chip_visible` when it proceeds.
- **#9c (13:32):** pre-check logged `chip_visible:false` — the pipeline
  fill and the submit path upload DIFFERENT filenames for the same
  resume (default resume path vs the registered material copy), so the
  chip never matches → second upload → re-fill. Then the completeness
  gate stopped on a REQUIRED "What are your preferred pronouns?"
  combobox: pronoun/demographic fields never take the predict path and
  only fill from the operator's sensitive profile — no value on file ⇒
  skipped ⇒ click blocked. ⚠ Operator: add a pronouns answer to the
  sensitive profile (or "Prefer not to say" if the form offers it) and
  `retry --app 2d517c7a`. Row left FAILED_RETRYABLE (attempt 3).

### 49. ROOT CAUSE of the "(empty) after upload" comboboxes — the pipeline's Greenhouse fill never uploaded; the submit path uploaded AFTER the fill — FIXED (upload → settle → fill → verify)
- Reading the code, not the logs: `runPipeline` called
  `runGreenhouseLiveFill` without a `resumePath`, so the held-page fill
  never uploaded (fill report `upload: null`); the submit path's single
  upload then landed after the fill, job-boards parsed the resume and
  re-rendered, and verified react-selects read "(empty)" (Neuralink
  #7b, DV Trading #9/#9b/#9c). The re-fill fallback typed into filled
  react-selects and mis-committed ("Bachelor's" → "Doctor of Medicine").
- **Fix:** Greenhouse liveFill uploads BEFORE the fill when a resume path
  is given (2.5s parse settle, then fill overwrites any prefill, then
  verify); the pipeline now passes the registered resume (same file the
  submit path uses, so the chip check finds it); the submit path uploads
  before its fill too and re-verifies after. Late upload only when the
  file input appears after the fill. Validation: existing Greenhouse
  fixture suites (FIXTURE) + the next live Greenhouse job. Commit 731c568.

### Job #10 — 70aaa82a — 13:48 local: CDP wedge (#13) recurred mid-day — and the #34 restart CLEARED it (LIVE_MUTATION_CONFIRMED)
- "port answers but the CDP session won't attach" at APPLICATION_OPENING
  (~3.5h after the morning restart). Worker: `CDP restart 1/3: debug
  Chrome relaunched and attach-verified — continuing session`; new Chrome
  13:49:19, attach probe 48 ms afterwards. The app errored on the wall
  itself (state unchanged, no attempt burned) and the 1-app cycle ended;
  it is picked first on the next cycle. Recurrence cadence noted: twice
  today; cause still unknown (many attach/detach cycles per job is the
  leading suspect).

### Job #11 — f32f22f4 ByteDance Self-Built Engineer Intern (CDN) — 13:50 local, 10s — duplicate of d7059081 (live holder) → abandoned
- Correct `duplicate_url` refusal via the JobRight Apply popup; the
  holder is NATIVE_AUTOFILL_RUNNING (not terminal), so #29 does not
  apply. Twin abandoned via the state machine with the holder named.

### Job #12 — 6cb05b18 Old Mission (Greenhouse embed on the JobRight page) — 13:51 local, 195s, NOT submitted (navigation budget)
- Phase A found only `boards.greenhouse.io/embed/job_app?token=<id>`
  (no `?for=` board) → "failed strict validation" → no Apply control →
  agent phase exhausted its budget. Third occurrence of this exact
  shape tonight (Zipline 83s, Neuralink 54s — those the agent eventually
  solved; here it did not). Pattern → next fix: resolve a token-only
  Greenhouse embed anchor deterministically (see #50). (The agent's
  "could not attach" note here was the heuristic misreading its own
  wall-clock timeout; CDP attached in 59 ms right after.)

### 50. JobRight's token-only Greenhouse embed anchors → one read-only GET resolves the board — FIXED
- Live probes: `boards.greenhouse.io/embed/job_app?token=7796180003`
  returns 200 with the full application form and
  `<form action="/embed/job_app?for=oldmissioncapital&token=…">`; the
  boards API confirms the board. Phase A now rewrites token-only embed
  anchors to the canonical `?for=<board>&token=<id>` (which the strict
  validator accepts) before ranking candidates — no agent, no guessing
  (null on fetch failure / no board in the page). Tests: live anchor +
  page shape, canonical/foreign URLs untouched, single GET, failure
  paths. Commit 7a4a358.

### Job #12b — Old Mission SWE 2027 Internship — 14:04 local, NOT submitted; #49 + #50 CONFIRMED live
- Phase A resolved the embed anchor deterministically (no agent turn);
  resume uploaded BEFORE the fill; submit path logged "resume already
  attached — skipping re-upload (input_mounted:false)"; fill + verify
  passed. Completeness gate: 1 required "SAT/ACT Score*" [text]
  unanswered. ⚠ Operator: add an `sat_act_score` answer to the screener
  bank (or the profile) and `retry --app 6cb05b18`; the system will not
  invent a test score. Row FAILED_RETRYABLE (attempt 1).
- **Operator answered live (14:10):** ACT 35; split Math 36 / Reading 35 /
  English 34 / Science 35 → bank entries `act_score`, `sat_act_score`
  ("ACT: 35"), `act_math/reading/english/science`. Requeued.

### Job #13 — e1082c7f Philips Graduate Co-op Data Scientist (careers.philips.com, generic) — 14:06 local, 20s, NOT submitted
- Nav resolved in 5s; generic gate refused `POSTING_MISMATCH`: the site
  canonicalised the slug's CASE on load (`graduate-level-co-op…` →
  `Graduate-Level-Co-op…`, same id PHILUS590567ENNA) and the redirect
  guard read it as a different posting.

### 51. Posting-redirect guard: case/encoding-only path differences are the same posting — FIXED
- `samePostingPath`: decode + lowercase + trailing-slash-insensitive
  compare; a different id or slug is still POSTING_MISMATCH. Tests: the
  live Philips pair, an encoded-comma pair, three negative controls.

### ✅ Job #12c — 6cb05b18 Old Mission Software Engineer – 2027 Internship Program — 14:10 local — SUBMITTED_VERIFIED → COMPLETED (second submit of the night)
- With the ACT answer in the bank: embed resolved deterministically (#50),
  upload-first (#49), fill + verify + completeness passed, click, receipt
  verified, and the post-submit tail completed (board-discovered row,
  #44) — 26s from QUEUED to COMPLETED.

### Job #13b — Philips — 14:18 local: #51 CONFIRMED (posting check passed) → `UNKNOWN_LANDING` (Phenom People careers site)
- careers.philips.com is a Phenom-style SPA: the generic classifier saw
  neither a form, an Apply control, nor a login wall ("no signals
  matched") and parked fail-closed. New ATS family — needs its own
  read-only DOM probe + Apply-path rung (Phenom "Apply" → external
  Workday/Phenom form). Left NATIVE_AUTOFILL_RUNNING; not ground on.
  Commit f1e1bc4.

### Job #14 — 7eeeb3c3 Leidos Data Science Intern (careers.leidos.com) — 14:19 local, 17s, NOT submitted (FORM_NOT_REACHED)
- Nav 5s. Generic adapter clicked "APPLY NOW" → landed on
  `leidos.wd5.myworkdayjobs.com/External/job/…/apply?bid=…` — the
  employer's WORKDAY — and kept reading it as "a posting with an Apply
  CTA" → refused. Second careers-site → real-ATS hop in a row (Philips
  is Phenom → Workday too).

### 52. ATS HANDOFF — Apply on a careers site lands on another recognised ATS — FIXED
- `detectAtsHandoff(currentAts, landedUrl)`: a recognised, non-generic
  ATS different from the current binding ⇒ handoff (same vendor or a
  generic host ⇒ null). The generic live fill returns `ATS_HANDOFF` with
  the normalised URL; the pipeline stores it as the employer URL and
  loops APPLICATION_OPENING → ATS_DETECTION with the right adapter
  (attempt cap bounds it). Tests: Leidos Workday URL, greenhouse/ashby/
  lever targets, same-vendor + generic + unparseable ⇒ null. Commit 6cd4e0a.
- **#14b (14:30):** Leidos' "APPLY NOW" this time routed to
  `careers.leidos.com/jobs/…/apply?tm_src=0` → Cloudflare interstitial
  ("Just a moment", no form) → `BLOCKING_CAPTCHA`, refused fail-closed
  (#19 Cloudflare, still open). The handoff rung is unit-confirmed but
  not yet live-confirmed. Row left NATIVE_AUTOFILL_RUNNING.

### Operator inputs applied live (14:20–14:35)
- `PORTAL_LOGIN_PASSWORD` changed as instructed (quoted in .env — dotenv
  reads an unquoted `#` as a comment; verified 8 chars, all four classes).
- Pronouns "He/Him" written into the encrypted sensitive profile via the
  crypto seams; new canonical `pronouns` (label match "pronouns",
  sensitive allowlist, `getSensitiveValue`) + 6 tests. DV Trading requeued.

### Job #8d — Huntington with the NEW password — 14:32 local: still parked; response timing
- Sign-in clicked; the 1.2s settle read `sign_in_form` (no error yet), so
  the rejection branch did not fire; the final diagnosis a moment later
  read `credentials_rejected` → "wall remains". Workday answers after the
  settle.

### 53. Portal auth: wait (bounded 8s) for the portal's answer after a sign-in/create click — FIXED
- After the click, poll every 500ms until an error text, the form gone,
  a verification-code input, or a changed classification — then decide.
  Tests keep settle 0 (synchronous). Live check: Huntington #8e (should
  now escalate to Create Account with the compliant password, then the
  emailed verification code via Gmail). Commit (this entry's fix).

### ✅ Job #8e — Huntington — 14:40 local — FIRST LIVE WORKDAY WALK: account created, wizard filled (5 pages) — parked AMBIGUOUS_FIELD
- sign-in rejected → "opened Create Account" → `create: form cleared`
  (account created with the new password; no emailed-code wall shown)
  → "workday page kind after auth: wizard" → wizard walked 5 pages,
  8/11 fields each → live fill executed (LIVE_MUTATION_CONFIRMED for
  portal-auth + wizard walk). Verify failed on 3 fields → AMBIGUOUS_FIELD.
- **The 3 misses (next issue #54):** `getByLabel('Have you previously
  worked for Huntington…')`, `('Address')`, `('Phone')` each resolved to a
  Workday wrapper element ("Element is not an <input>… does not have a
  role") — Workday's `<label for>` points at a container div, so the fill
  must descend to the inner control. And "Phone Extension" was planned
  with the phone NUMBER (mapping hijack: extension ≠ phone).

### ✅ Job #9d — 2d517c7a DV Trading SWE Intern Summer 2027 — 14:49 local — SUBMITTED_VERIFIED → COMPLETED (third submit of the night)
- With pronouns on file: upload-first, 22 controls verified, completeness
  clean, click, receipt, tail completed.

### 54. Workday wizard fill: wrapper-div labels + "Phone Extension" hijack — FIXED
- `locatorForField`: a labelled element that is not a control descends to
  the first input/textarea/select/contenteditable inside it (type filter
  preserved) — Workday's `<label for>` targets a container div.
  "Phone Extension"/"Ext" never maps to `phone`. Tests: wrapper-div text
  + select fill/verify (fixture), 4 extension labels unmapped, plain
  phone still maps. (Playwright's getByLabel does not associate a
  `<label for>` with a non-form element at all — an explicit
  label→@for→id→inner-control XPath fallback was needed.)

### Job #15 — 621ec215 — 14:51 local: CDP wedge (#13) for the 4th time today, restart cleared it again
- The wedge recurs right after a direct `run --pipeline` process detaches
  from the debug Chrome; the next attach (the cycle's navigation) times
  out. `CDP restart 1/3 … attach-verified`, but the 1-app cycle was spent
  on the error. Next: attach-verify (real CDP connect) in the session
  preflight and restart BEFORE the first app (#55). Commit bbbfb08.

### Job #16 — 97aad252 Booz Allen 2027 Summer Games Data Scientist Intern (bah.wd1 Workday) — 15:03 local, 4 min, NOT submitted (AMBIGUOUS_FIELD)
- Second full live Workday walk: account created at bah.wd1 too, wizard
  filled 5 pages (8/10). Misses (snapshot form-snapshot-1788116847321):
  (a) "Have you previously been employed by Booz Allen?" is a RADIO group
  named by `<legend><label>` with NO `for`; the group div carries
  `aria-labelledby` so getByLabel matches the DIV, and discovery planned
  it as text; (b) "Phone Number" (`id=phoneNumber--phoneNumber`) — the
  plan's label was bare "Phone", the fill timed out and verify read a hex
  token off some hidden match.

### 56. OPEN — Workday wizard field layer needs data-automation-id resolution (radio-in-legend groups; formField-* containers)
- Evidence saved: the bah.wd1 snapshots (formField-candidateIsPreviousWorker
  radio group, formField-phoneNumber/extension). Direction: resolve wizard
  fields via `data-automation-id="formField-*"` containers → inner control;
  collapse legend-labelled radio groups like #40 did for checkbox groups.
  Interim tonight: `.or()` unions in locatorForField no longer include the
  bare labelled element (an ancestor wrapper in document order would beat
  its inner control), so wrappers can never be filled.

### Job #17 — 20790417 ByteDance — 15:10 local, 30s — UNKNOWN_LANDING (their portal's search page)
- The JobRight Apply popup landed on `joinbytedance.com/search/<id>` —
  ByteDance's own portal search page, not an application form; the
  generic classifier parked fail-closed. ByteDance needs its own portal
  walk (account + form) — long-tail, not tonight. (Job #18, a second
  ByteDance row, parked identically. Databricks PM intern abandoned —
  outside the SWE+DS+AI scope directive.)

### Job #19 — 5766f038 Neuralink SWE Intern BCI Applications — 15:20 local — one field left after the #40 fixes
- Checkbox groups, LinkedIn, on-site ack all pass now. Last miss:
  "Which onsite location would you like to apply to?" — plan guessed
  "United States" (country hijack), options are Austin | South San
  Francisco | No preference; the option-verified matcher refused (as
  designed). Bank entry added: `onsite_location_preference = "No
  preference"` (consistent with the operator's stated flexibility;
  ⚠ operator: change it if you have an office preference). Re-run #19b.
- **#19b (15:25):** onsite-location filled; last wall "Third example:*"
  — the essay model ABSTAINED on the third example twice (each essay
  was generated in isolation: the bare "Third example:" label had no
  parent question and no view of examples 1–2). **#57 FIXED:** follow-up
  labels inherit the nearest preceding long question; the batch's
  previous answers ride along with a distinctness instruction; the
  null-over-invention rule unchanged. Test with a capturing fake client.

### Job #20 — 93eff173 iA — 15:27 local, 20s — wrong-employer accusation by "workforcenow" (#38's family) — FIXED
- ADP WorkforceNow tenant URL; the vendor's product name (tenant label)
  and app-plumbing path words convicted the URL. Added to
  GENERIC_URL_WORDS; live pair added to the #38 progressive set.

---

## Night20 (same date, evening session; operator asleep, 3-min/job budget)

Pre-flight state (16:00 local):
- Debug Chrome CDP 9222: real `connectOverCDP` verified (probe listed night19's
  leftover tabs); JobRight feed authenticated (39 applied per header).
- Queue: 11 QUEUED, 41 APPLICATION_OPENING, 36 AMBIGUOUS_FIELD, 22
  NATIVE_AUTOFILL_RUNNING, 6 FAILED_RETRYABLE, 4 SUBMISSION_VERIFICATION_FAILED,
  4 COMPLETED. Flags: form_fill+submit on, dry_run off, rollout stage 4.
- Hygiene: 12 MANUAL review rows dismissed (#29 still re-parks them).
- Found UNCOMMITTED night19 work in the tree: #57 essay follow-up context fix +
  #20 workforcenow GENERIC_URL_WORDS fix, with tests. The new #57 test's stub
  answer was 32 words — validateDraft's 40-word floor rejected it and the test
  crashed on a null `previous_answers`; padded the stub past 40 words, file now
  5/5. Full gate running before commit. tmp CDP probes moved scripts/ → private/.
- Issue numbering continues from #57 (#55 attach-preflight and #56 Workday
  formField-* resolution still OPEN from night19).

### Job #21 — 11eba960 Exa (Ashby) — 16:07 local, ~70s — NOT submitted (REJECTED_AFTER_CLICK)
- Best fill of the night otherwise: 11 fields + 3 essays LIVE_MUTATION_CONFIRMED,
  submit clicked, form bounced it: `missing entry for required field: Are you
  based in San Francisco or open to relocating?`. Left FAILED_RETRYABLE.
- The field (DB fill_field_outcomes + read-only CDP probe): Ashby NATIVE radio
  group, legendless fieldset, options `San Francisco based | Open to relocating`,
  radios carry NO required/aria-required — requiredness is only `_required_…`
  in the question label's class. Plan parked it REVIEW_REQUIRED (`bank answer
  "Yes" matches none of the 2 page options`); LLM option-select abstained twice
  (chosen 0); then the pre-click completeness scan filed the group as OPTIONAL
  (no marker it could see) under an OPTION's label → clicked anyway.

### 58. Relocation sentence-options + class-marked required radio groups — FIXED (two shared-layer fixes)
- (A) `resolveScreenerAnswer` willing_to_relocate: when the option set has no
  Yes/No token, pick the SINGLE relocation-affirmative sentence option
  (`open to/willing to/able to/happy to/will + relocat|mov`, negations
  excluded); two affirmatives or none ⇒ park. Mirrors the greenhouse
  comboboxFill logic that never got shared. Location claims ("San Francisco
  based") are never inferred.
- (B) completeness scan native-radio branch: group visibility now counts a
  visible member `<label for>` (Ashby hides inputs behind painted circles);
  legendless fieldsets resolve the QUESTION label (the fieldset label not
  targeting a member radio); requiredness adds the label's class token
  (`/(^|[_\s-])required([_\s-]|$)/`) and trailing asterisk. Wrong hit ⇒
  refusal + review item, never a wrong submit.
- Progressive-overload fixtures one level above live: hidden inputs, decoy
  `notrequired` class, answered required group, two-affirmative and
  negated-affirmative option sets. UNIT/FIXTURE_CONFIRMED + live read-only
  re-scan of the real Exa page reports the group correctly
  (LIVE_READ_ONLY_CONFIRMED).

### 59. CDP wedge #13 recurred (5th today) + the attach-preflight leaked a LIVE attach into a unit test — both handled
- 16:15-16:19 local: gate run failed 1/1385 — `automation-worker.test.ts`
  "requeues nav-starved apps" read `preflight: CDP attach failed…
  CDP_AUTOLAUNCH_ENABLED is off`. Root causes: (a) the debug Chrome wedged
  again mid-evening (my own probe then hung at ws attach — same #13
  signature: /json answers, attach times out); (b) night19's bbbfb08
  preflight does a REAL `probeCdpAttach` in unit tests when a test stubs
  `agentLegProbe: true` without `cdpAttachProbe` — a live-network
  dependency in the gate, house-rule violation, flaky by Chrome state.
- Fixes: `restartCdpChrome()` via the repo seam (killed 5 stale pids,
  relaunched, attach probe passed, JobRight session survived —
  LIVE_READ_ONLY_CONFIRMED); test now stubs `cdpAttachProbe: async () =>
  true` (hermetic). The wedge trigger pattern (recurs after processes
  attach/detach repeatedly) still untreated — #55 remains OPEN.

### Job #22 — fda27acb TIAA Churchill Summer Internship IIT (tiaa.wd1 Workday) — 16:33 local, ~35s — NOT submitted (NO_APPLICATION_FORM)
- Nav resolved the `/search/job/…` posting fine. portalAuth walk: clicked
  "Apply" (1) → clicked "Apply Manually" (2) → `no account form within 15s`
  → attempt 3 found no Apply controls → "no sign-in form on this page" →
  page kind after auth read `wizard` with ZERO discoverable fields →
  refused fail-closed. final_url never left the posting URL.
- Read-only probe of the same page: normal posting, visible Apply
  `adventureButton`, 0 inputs — AND an undismissed cookie-consent banner
  ("Decline / Accept Cookies"); the fill's `dismissPageObstructions` pass
  reported nothing dismissed. Suspected: the banner overlay intercepts or
  delays the post-Apply-Manually account dialog, or TIAA renders it
  slower than the fixed 15s window. Left NATIVE_AUTOFILL_RUNNING.
- **#60 root cause found and FIXED** — not the cookie banner: two more
  bounded probes (cookie dismissed, 35s poll, frame scan, automation-id
  dump) showed the post-Apply-Manually page is a Workday **SSO sign-in
  chooser** — `signInContent` with `AppleSignInButton`/`GoogleSignInButton`/
  `LinkedInSignInButton`/`SignInWithEmailButton` and ZERO inputs, wizard
  progress bar already drawn ("step 1 of 8") ⇒ classified `wizard`,
  "nothing to fill". Operator directive (mid-run, 2026-08-30): ALWAYS
  click "Sign in with email", never a third-party provider, then standing
  PORTAL_LOGIN_* creds.
- Fix: `clickSignInWithEmail` in portalAuth (fires when the Apply-Manually
  form wait misses and when no Apply control is left; bounded, notes the
  click); `classifyWorkdayPage`: `signInContent`/`SignInWithEmailButton`
  ⇒ `auth`, checked BEFORE the wizard branch. Tests: TIAA fixture walk
  Apply → Apply Manually → chooser → email → sign-in (third-party click
  traps assert no provider button is ever touched) + pageKind case.
  22/22 in the two files (FIXTURE_CONFIRMED). Live re-run after gate.

### Job #22b — TIAA re-run with the SSO fix — 16:46 local, ~40s — half the wall fell
- LIVE_CONFIRMED: "SSO chooser — clicked Sign in with email" → "email
  sign-in form rendered" → standing creds filled → Sign In clicked. Then:
  `wall remains (sign_in_form)` — the click answered NOTHING within the
  bounded response wait (no error banner, no navigation), so the
  credentials_rejected → create escalation never fired. Refusal changed
  NO_APPLICATION_FORM → AUTH_REQUIRED.
- Pixel check (operator directive — screenshot read, private/
  tiaa-signin-form.png): clean sign-in form, NO visible captcha, no error,
  and "Don't have an account yet? Create Account" on screen. Invisible
  `noCaptchaWrapper`/`click_filter` + `beecatcher` honeypot input present
  in DOM (fill touches only email/password selectors — honeypot safe).

### 60b. Silent sign-in ⇒ take the page's own Create Account route once — FIXED
- New escalation in portalAuth: sign_in attempt ends with the form
  standing, classification `sign_in_form`, NO error text, and a
  `createAccountRoute` on the page ⇒ click the create link ONCE and run
  the create attempt (asymmetry safe: creating an existing account fails
  with an inline error; attempt caps bound the walk). First contact with
  a tenant usually needs CREATE (huntington #8e, bah #16 both did).
- Fixture test: silent Sign In handler + Create Account flip →
  account_created, escalated_to_create, no secrets in notes. 17/17 in
  portal-auth.test.ts (FIXTURE_CONFIRMED). Live #22c after gate.

### ✅ Job #22c — TIAA — 16:59 local — FULL LIVE WORKDAY WALK through BOTH new auth fixes
- LIVE_MUTATION_CONFIRMED: Apply → Apply Manually → SSO chooser → "Sign in
  with email" → silent sign-in → **create: form cleared** (account created)
  → wizard walked 5 pages, 8/13 fields each. Parked AMBIGUOUS_FIELD on the
  #56 field-layer class. The two auth fixes (#60, #60b) are live-proven.
- The misses (fill_run 2edb5eb8, DB read-back): (a) previousWorker RADIO
  group planned "text" → `fill("No")` crashed ("Input of type radio cannot
  be filled") — same as BAH #16a; (b) "Phone" resolved a HIDDEN decoy
  input holding a hex token, hung 30s — same as BAH #16b; (c) SMS/WhatsApp
  opt-in checkboxes: painted, native inputs display-hidden → check() hung
  30s; (d) "I have a preferred name" checkbox got the NAME text (mapping
  quirk, minor, left open).

### 61. Workday wizard field layer — three shared-layer fixes + progressive-overload fixture — FIXED (recurrence of #56 across bah+tiaa triggered the sandbox)
- `locatorForField` gains a `visibleOnly` rung (label tiers ∩ `:visible`);
  fill AND verify ladders run visible-first → type-filtered → unfiltered,
  so a hidden decoy can never win while a visible control exists.
- `checkPaintedControl`: check() on a hidden box/radio goes through its
  `label[for]` click (verify still reads the input's own state); applied
  to consent boxes, checkbox-group members, radio members.
- A resolved RADIO under a text-planned entry routes through
  `checkRadioGroupMember` (same member-label matching the radio branch
  used) — never fill(); no matching member parks with the real reason.
- New tests/unit/workday-field-layer.test.ts: TIAA-shaped fixture one
  level harder (display:none members, decoy BEFORE the real input,
  painted consent box, mismatch-parks case) — 4/4 + 86 regression tests
  across the fill suites green. FIXTURE_CONFIRMED; live #22d next.

### Jobs #22d/#22e — TIAA — 17:12-17:13 local — the next wall is the SUBMIT path
- #22d: refused instantly on the open AMBIGUOUS_FIELD review item (by
  design). Requeued via requeueAmbiguousField → FIELD_VERIFICATION.
- #22e: FIELD_VERIFICATION → READY_TO_SUBMIT (checks passed on stored
  state; the #61 fixes were NOT live-exercised — no re-fill ran), then
  the submit runner opened the stored `/search/job/…` POSTING URL cold
  and the identity gate refused: NO_APPLICATION_FORM ("form markers
  matched but no fillable fields — posting page"). Correct fail-closed
  behavior; the gap is structural.

### 62. OPEN — Workday submit path has no wizard REACH (fill path's auth+Apply walk is not shared with submit)
- Evidence: #22e submit-run FAILED_BEFORE_CLICK at the pre-mutation gate
  on the posting URL. The fill path reaches the wizard via portalAuth
  (Apply → Apply Manually → SSO email → sign-in/create) + wizard walk;
  submitRun navigates the raw employer URL and expects a form. Without
  this, NO Workday app can ever submit — the blocker between "wizard
  fills live" (proven tonight) and "Workday submits".
- Direction: submitRun (or the workday adapter's submit prep) needs the
  same reach seam: when binding is workday and the landing classifies
  posting/auth, run portalAuth (signs into the NOW-EXISTING account) +
  wizard walk to the review page, then completeness-gate + click. Est
  1-2h; scheduled between cycles tonight. TIAA parked meanwhile (5
  attempts consumed — moving the loop on per budget discipline).
- **OPERATOR DIRECTIVE (mid-run, ~17:15): stay on the SAME job until it
  submits or needs operator input — do not rotate away from hard jobs.**
  Supersedes the 3-min move-on rule; recorded in memory. TIAA resumes as
  the sole target after #62 lands.

### 62 — FIXED (pipeline-level): cold Workday FIELD_VERIFICATION re-runs the fill leg
- Implementation: rather than teach submitRun the whole portal walk, the
  pipeline routes a COLD Workday FIELD_VERIFICATION (no held same-run
  page) back to NATIVE_AUTOFILL_RUNNING — the fill leg already performs
  auth + Apply walk + wizard fill (overwrite = trusted reset) and hands
  the live held page to the same-run submit (the Exa #21 shape). New
  deliberate state-machine edge FIELD_VERIFICATION →
  NATIVE_AUTOFILL_RUNNING (states.ts + docs/state-machine.md), bounded
  by fill attempt caps. Non-Workday cold entries unchanged.
- pipeline-run + review-resolvers 35/35. Gate → commit → live TIAA #22f.

### Job #23 — (cycle while #62 was designed) — generic UNKNOWN_LANDING, 0 eligible in discovery
- One app, generic adapter refused UNKNOWN_LANDING (details in cycle log;
  parked NATIVE_AUTOFILL_RUNNING). Per the new directive the loop returns
  to TIAA; this row queues behind it.

### Jobs #22f/#22g — TIAA — 17:22-17:33 — signed-in state discovered; wizard now 10/13
- #22f re-ran the whole auth walk on an already-authenticated session and
  ended on an unknown signed-in page ("nothing to fill"). Operator (at the
  screen) reported the create form typed but "Create Account" never
  clicked; the click failure is silently swallowed at portalAuth's
  submit.click (noted for #63 cleanup).
- Probes (screenshots read): header shows Candidate Home + account menu —
  the TIAA account EXISTS and the profile session persists across Chrome
  restarts. Signed-in flow confirmed: Apply → popup chooser (Autofill/
  Apply Manually) → `/apply/applyManually` = the RESUMED wizard, "My
  Information" step 1, prior values retained (Country pre-filled).
- #22g: walk flowed clean (no SSO, no create), wizard filled 5 pages
  10/13 (was 8/13 — the #61 fixes gained 2 live). Remaining 3 (fill_run
  5912cf28): (a) "I have a preferred name" reveal-toggle got the NAME
  text (mapping); (b/c) SMS/WhatsApp opt-ins: label-click didn't toggle
  and force-check threw instantly ("Element is not visible") — ids
  regenerate per render; the label the click hit may be the heading twin.
- CDP wedge recurred TWICE (6th/7th) — trigger CONFIRMED for #55: a
  SIGKILL'd probe client (3-min timeout kill) wedges the debug pipe
  immediately; killing the zombie tsx + restartCdpChrome recovers.

### 63. Toggle-mapping + JS-click tier — FIXED
- `matchCanonicalField`: checkbox-typed "preferred name" labels never map
  (the revealed TEXT field still does) — mirror of the #54 extension
  guard.
- `checkPaintedControl` gains a JS-click tier (evaluate el.click()) after
  the label-click and before force-check — covers painted inputs with no
  usable label[for]; the read-back stays the arbiter. Progressive
  fixture: painted checkbox with NO label at all. 5/5 + mapping tests.

### Job #22h — TIAA — 17:46 — #62 route live-proven; wizard 10/12; STALE-ID class isolated
- FIELD_VERIFICATION → re-fill fired exactly as designed (the new edge is
  LIVE_CONFIRMED); preferred-name toggle no longer planned (12 fields).
  Only the two opt-ins still failed — but with NEW signatures: one hung
  30s waiting for a DEAD id (`[id=pg0ki]`), the other failed the ladder
  ("control not found"). Workday REGENERATES its short random ids on
  every re-render; the opt-ins render last, so their discovery-time ids
  die after earlier fills re-render the section.

### 63b. Stale generated ids — label fallback everywhere — FIXED
- Fill AND verify ladders: when the id/name lookup finds nothing, drop
  them and run the label tiers (visible → typed → unfiltered) before
  failing. `checkPaintedControl` fast-fails a detached control (named)
  instead of force-check's 30s re-attach wait. The checkbox branch gets
  ONE bounded retry: on a stale-shaped failure with an id/name-resolved
  box, re-resolve by label and run the same body (same refusals; the
  read-back arbitrates). Fixture: entry with a dead discovery id checks
  the real labeled box for fill AND verify. 24/24 across the fill suites.

### Gate-environment note (18:00-18:35): flake roulette root-caused to a memory-tight box
- Three consecutive full-suite runs each failed on a DIFFERENT purely
  environmental timeout (afterAll browser.close; auto-cycle preflight;
  then a 23-failure teardown cascade with vitest worker RPC timeouts).
  Free physical memory: 1.6 GB (operator's Edge/Slack/Notion/Steam open —
  not touched). No leaked playwright processes. Resolution: two flaky
  timeouts bumped with evidence notes; the gate now runs at
  `--maxWorkers=2` on this box — 1395/1395 + all checks green (commit
  9fa3a66). One cascade run leaked the real portal password into a TEMP
  task-output file via an unrestored test env (never near the repo);
  file deleted.

### Job #22i — TIAA — 18:34 — the auth wall's TRUE root cause isolated
- The #62 route fired; the walk hit the SSO chooser AGAIN (the Workday
  session had expired — earlier probes were signed in at 18:04) and the
  sign-in click answered NOTHING — with an account that EXISTS (created
  #22c, sign-in verified via probes). So the "silent sign-in" was never
  a missing account: the tenant's visible Sign In control is the
  invisible-captcha overlay (`click_filter`/`noCaptchaWrapper`);
  clicking the underlying `signInSubmitButton` is a silent no-op. This
  also explains the operator's pixel report on #22f ("filled everything
  but never clicked create") — the clicks never registered.

### 63c. Silent auth click ⇒ ONE keyboard-submit retry (Enter from the password field) — FIXED
- In `attempt()`: when the response poll ends with the form standing,
  unchanged, and no error, press Enter in the (form-scoped) password
  field — the human-faithful submit that bypasses the overlay — note it,
  re-poll, then the existing decision tree (rejection → create; silent →
  #60b create route) runs unchanged. Fixture: overlay tenant whose
  button click is swallowed and only keydown Enter submits →
  signed_in with the retry note. 18/18 portal-auth (FIXTURE_CONFIRMED).

### Job #22j — 18:49 — Enter retry fired, sign-in STILL silent; create "cleared" again → off-flow page
- Notes confirm the new retry ran ("click answered nothing — retried with
  Enter") with no change; then the create route "cleared" (as every run).
  The #22j page was closed before pixels could be taken. Working theory
  consistent with ALL evidence (probes found the profile SIGNED IN after
  pipeline runs): the create/sign-in eventually SUCCEEDS but dumps the
  session OFF the apply flow (Candidate Home / posting), and the walk
  never re-approaches the wizard — "unknown, nothing to fill".

---

## Night21 (2026-08-30 late evening, operator asleep; standing overnight authorization)

Pre-flight (≈18:55 local):
- Found night20's #63d (Workday off-flow re-reach) implemented but
  UNCOMMITTED and ungated in the tree; gate running, commit next, then
  TIAA #22k is the live check.
- Debug Chrome was fully DOWN (ECONNREFUSED, not the #13 wedge);
  `restartCdpChrome` relaunched + attach-verified (LIVE_READ_ONLY_CONFIRMED).
- Queue: 11 QUEUED, 41 APPLICATION_OPENING, 36 AMBIGUOUS_FIELD,
  24 NATIVE_AUTOFILL_RUNNING, 6 FAILED_RETRYABLE, 4 COMPLETED. TIAA
  fda27acb NATIVE_AUTOFILL_RUNNING attempt 2 — stays the active job per
  the stay-on-same-job directive (operator's new message re-states the
  3-min budget: stop the RUN at 3 min, diagnose, fix, retry same job).
- Open issue carry-over: #55 CDP attach preflight, #29 review re-parks,
  #19 Cloudflare, #47 operator password items resolved night19; Outlook
  login still expired (Gmail primary — fine).

### 63d. Workday post-auth off-flow ⇒ ONE bounded re-reach — implemented, mechanism LIVE_CONFIRMED on #22k/#22l
- atsLiveFill workday branch: after auth, when the page classifies
  posting/chooser or a zero-field wizard/unknown, goto the employer URL
  once and run `authenticateAtsPortal` again — a signed-in session walks
  Apply → Apply Manually → the RESUMED wizard (exactly the live-probed
  signed-in flow); an unauthenticated one parks as before. Bounded to
  one re-reach; notes carry the full trail.
- #22k: re-reach fired but walked a BLANK shell (Workday paints Apply
  seconds after domcontentloaded) — added a bounded 15s wait for
  `adventureButton` after the goto. #22l: the re-reach then walked the
  full chain properly (Apply → Manually → SSO → email form) — auth
  itself still silent. Also learned: pipeline pages close at teardown,
  so post-mortem pixels need in-run capture.

### Container restart + parallel-gate note (20:00-20:50)
- The harness container restarted mid-gate; stray vitest workers cleaned,
  gate recreated. New memory guidance adopted ("gate only before commits;
  run live cycles in parallel") — but empirically THIS box cannot carry
  the full suite and a live headed run simultaneously (the overlapped
  gate produced 12 pure-timeout failures). Reconciliation: gates run solo
  between live runs; live work never waits on a gate.

### 🔑 ROOT CAUSE of the silent TIAA auth — found via instrumented diagnostic (operator's pixels directive)
- One diagnostic walk with HUMAN pacing (wait for paints, then type, then
  click) signed in INSTANTLY: header showed the account email + Candidate
  Home and landed directly in the wizard (step 1 of 7). Credentials,
  selectors, click target: all correct. The pipeline's typing lands
  before the just-rendered React form's handlers attach — the keystrokes
  never reach component state and the submit posts an EMPTY form, which
  this tenant answers with NOTHING (no error, no navigation). Every
  "silent sign-in"/"create: form cleared" of the night traces to this.

### 63e. Auth fills settle + read-back + one retype — FIXED (pending live #22m)
- `attempt()`: settle before typing (bounded by settleMs; tests at 0
  unchanged), settle after, then READ THE FIELDS BACK — an empty
  read-back retypes once, noted. The submit only fires over values that
  provably took. Side effect of the diagnostic: the profile session is
  signed in, so #22m may take the signed-in resume path directly.

### ⚠ TWO SESSIONS, ONE TREE (≈20:40-21:05 local) — discovered and divided
- Session -35 (this loop) and session -0d were BOTH live-driving TIAA and
  editing portalAuth.ts unaware of each other (-35's job22k overlapped
  -0d's 22k/22l — same row, same debug Chrome). Division agreed by
  message: -35 owns the loop, issues log, and live runs; -0d commits its
  uncommitted stack (#63e settle/read-back/retype, #63f greenhouse text
  fill read-back, #63d paint-wait addendum) and stops driving. TIAA auth
  evidence from that window is CONTAMINATED — treat with suspicion.
- Evidence reconciliation for the auth mystery:
  - -0d instrumented diagnostic 20:55: paced sign-in SUCCEEDED (header
    email, Candidate Home, wizard step 1/7; pixels in private/
    tiaa-diag-*.png) ⇒ the TIAA account EXISTS and the standing password
    matches — the dropped-keystroke root cause explains every "silent"
    click. LIVE_READ_ONLY-observed on a mutation walk.
  - -35 probes ~20:47: posting page signed OUT (utilityButtonSignIn) —
    consistent with short session expiry, not with "no account";
    Gmail has ZERO tiaa emails ⇒ this tenant sends no creation mail, so
    mailbox absence is NOT evidence of a missing account (correcting the
    earlier #64 inference).

### 64. Create-before-sign-in (operator directive night21) + auth truthfulness — PARTIALLY LANDED, rest queued behind -0d's commit
- Operator (watching the screen, ~20:30): "creating an account is
  necessary unless Workday explicitly tells you that you have an account
  and you should sign in." Policy: on FIRST CONTACT (no vault record for
  the host) attempt Create Account first; sign in only when the vault
  records an account we made/set, or the portal answers "already
  exists" — and RECORD verified creations in the vault so the signal is
  evidence, not a note.
- Landed now (non-colliding files, FIXTURE_CONFIRMED):
  - obstructions.ts containers += `[data-automation-id*='legalnotice' i]`
    — TIAA's cookie banner sat over every auth click since night20 and
    the container scan couldn't see it (probe + pixel evidence); new
    fixture test 5/5.
  - loginWallDiagnosis ERROR_RE += `already (exists|in use|registered|
    taken)` so the portal's explicit answer is readable ("already have an
    account" deliberately EXCLUDED — static text on every create form).
- LANDED (after cae9569): knownAccount ordering (read vault BEFORE
  prepareCredentialsForHost mints), flip-to-sign-in gated on a known
  account, create-first route-click on sign-in-only walls,
  already-exists ⇒ sign-in branch, submit-click failures noted instead
  of swallowed, "form cleared" demoted when the Workday header still
  shows utilityButtonSignIn (the false-positive killer), and verified
  creations recorded in the vault. Obstruction sweep runs at portal-auth
  start. Tests: 3 new #64 cases (create-first + never-signs-in flag +
  vault record; "already exists" ⇒ signed_in; ghost-clear ⇒
  wall_remains, nothing recorded); 6 existing sign-in-first tests seeded
  with vault accounts (their premise, made explicit); huntington +
  sandbox describes gained temp PRIVATE_DIR (a fixture password in the
  real vault would hijack live runs). portal-auth 24/24 +
  auth-phase2 + login-wall-diagnosis green. FIXTURE_CONFIRMED; live
  validation rides the next cold-auth Workday tenant (TIAA is signed
  in, so #64 wasn't exercised there).

### Job #22n — TIAA — 21:12 local — wizard 12/12 ×5, blocker isolated to the phone DRAFT never persisting
- First run on cae9569: already signed in ("no sign-in form on this
  page"), wizard filled 12/12 on all five pages. Outer page-1 verify
  still failed: phoneNumber--phoneNumber expected the number, page
  shows "(empty)" → AMBIGUOUS_FIELD.
- DRAFT PROBE (resumed wizard, read-only): the saved draft's phone is
  EMPTY while its siblings persisted — the DOM held the value (fill_ok,
  immediate read-back saw it) but React state never took it, Workday
  saved "", and the next re-render wiped the field before verify. #63f's
  immediate read-back cannot catch this class. Also on the page: the
  night19 #16b hidden hex-token decoy input, still there.

### 65. Blur-stability for plain text fills — FIXED (the location widget's pattern, generalized)
- greenhouse/fill.ts plain-text branch (shared by the Workday wizard):
  after fill + #63f read-back, BLUR the field (forces the commit/
  re-render now), settle 300ms, read back again; a cleared value gets
  ONE keystroke-level retype (pressSequentially — real key events reach
  handlers fill() can miss) + blur + read-back; still-empty pushes a
  loud fill error naming the class. Mirrors the location autocomplete's
  blur-stability check that solved the identical Places-widget symptom.
  Bounded; verify stays the arbiter. Live validation: TIAA #22o.

### Job #22o — TIAA — 21:32 local — #65 NOT sufficient; operator names the missing capability
- Wizard 12/12 ×5 again; phone STILL "(empty)" at the page-1 verify and
  NO blur-retype note fired — the post-blur read-back saw a value that a
  LATER re-render wiped (blur does not force React to re-render an input
  whose state never changed). 2 review items now.
- **Operator (watching, 21:35):** the run "can't recognize where errors
  were found even though the application is telling you on the page" —
  and (21:40) "reading page errors is a necessity for ALL applications,
  don't overfit it to one platform."

### 66. Page-error reading (generic) + verify-failure keystroke retype — FIXED (FIXTURE_CONFIRMED; live #22p)
- **66a** `src/applications/pageErrors.ts` — platform-NEUTRAL validation
  reader: role=alert / aria-live=assertive text, aria-invalid fields
  named by their nearest label with their aria-describedby message, and
  short visible error-classed nodes (bounded ×12, length-filtered).
  Vendor containers ride in via each ATS's selector REGISTRY
  (workdaySelectorsV1.errorContainers — the only vendor-specific lines);
  page-side code ships as a string expression per the repo's no-DOM-libs
  pattern. Wired into atsLiveFill on EVERY failed verify (all bindings)
  and per wizard page; lines land in notes + verify.warnings so review
  items carry the page's own wording.
- **66b** `retypeEmptyVerifyMisses` (shared fill layer) + optional
  adapter method on workday AND greenhouse: a verify miss observing
  EMPTY on a text control is the moment we KNOW React state never took
  the fill — ONE keystroke-level retype (click, clear, pressSequentially,
  blur; real key events), then re-verify decides. Non-empty mismatches
  and non-text controls are never touched.
- Tests: 5 new (alert/aria/classed + hidden excluded; vendor-extras +
  flood filter; clean page; keydown-counting input proves keystroke
  entry; skip-everything-else negative). Live validation: #22p.

### Job #22p — TIAA — 21:52 local — #66a pays off instantly: the page names the REAL blockers
- Wizard 12/12 ×5 (vacuously — see below), still AMBIGUOUS_FIELD, but
  the notes now carry Workday's own words: "The field State is required
  and must have a value", "The field How Did You Hear About Us? is
  required…" / "0 items selected". Three nights of expected/observed
  diffs never surfaced these because THE FIELDS WERE NEVER DISCOVERED —
  12/12 counted only what the plan knew about. (Also: the wizard-page
  retype tried "Phone" on later pages where it doesn't exist — noisy
  5s timeouts, bounded, left as-is.)

### 67. Workday listbox buttons + multiselects invisible to discovery; getAttr matched INSIDE aria-invalid — FIXED + progressive-overload set
- Live probes (resumed wizard, read-only + open-state popup dumps):
  - State / Phone Device Type / Country are `<button aria-haspopup=
    "listbox" id=…>` with a label[for] pointing at the BUTTON — the
    input-scan never saw them; their popup is `<ul role=listbox><li
    role=option>` (generic selectors already match). The #16b hidden
    hex-token decoy is the button's companion input.
  - How Did You Hear / Country Phone Code are multiselect search
    widgets (`input data-uxi-widget-type=selectinput`, placeholder
    "Search"); options render in a virtualized `activeListContainer`
    (role=listbox, role=option) and committed values are CHIPS in an
    always-visible `<ul role=listbox data-automation-id=
    selectedItemList>`.
  - **#67a root bug:** `getAttr("id")` had no left boundary and matched
    inside `aria-invalid="false"` → every multiselect got id "false",
    missed its label[for], took placeholder "Search" as its label, and
    the #39 widget fence skipped it. One-line boundary fix relabels the
    whole class correctly.
- Fixes: getAttr boundary; selectinput inputs typed "select" (pick
  path, never fill()); a discovery pass for labeled listbox BUTTONs
  (label[for] required — page-chrome listbox buttons have none and stay
  invisible); listboxForControl excludes selectedItemList (the chips
  ul was winning "first visible listbox"); readComboboxValue learns
  both shapes (button text; chips join).
- Progressive-overload fixture `tests/fixtures/ats/workday/
  listbox-multiselect.html` (live markup + harder: attr-order trap,
  hex decoy, preselected chips, virtualization window, chrome button)
  + 5 tests — all FIXTURE_CONFIRMED first run. Live validation: #22q.

### Job #22q — TIAA — 22:15 local — #67 LIVE-CONFIRMED (17 fields discovered, State fills); two last walls isolated
- Discovery 12→17 fields; "State is required" GONE (the listbox button
  filled); 13/17. The page names the rest: (a) "How Did You Hear About
  Us? — 0 items selected": the pick machinery worked live (opened,
  filtered, collected TIAA's real options) and REFUSED correctly — the
  profile's stored `how_heard: "LinkedIn"` matches nothing TIAA offers
  (College Event | Company Communication | Contacted by Agency/Recruiter
  | Corporate Website | Job Board | Military/Veterans | …). (b) the
  previously-an-employee RADIO: the right member resolved, then check()
  hung 30s — VISIBLE input under a painted overlay div that intercepts
  pointer events; checkPaintedControl's ladder only engaged for HIDDEN
  inputs. Also noted: the wizard walk re-filled the same page 5× (Next
  blocked while errors exist) and the wizard retype probes fields from
  other pages (noise, bounded).

### 68. Overlaid-radio ladder + how_heard class fallbacks — FIXED (FIXTURE_CONFIRMED; live #22r)
- (a) checkPaintedControl: the visible-path check() is now BOUNDED (5s)
  and falls through to the label[for]-click / JS-click tiers on
  interception — the read-back still arbitrates.
- (b) fillComboboxControl gains caller-scoped `alternates`: tried in
  order against the open window, then as typed filters (same focus
  guard). `comboboxAlternates` is scoped to canonical how_heard ONLY,
  with a small deterministic channel-class table (LinkedIn → Social
  Media | Social Network | Job Board | …; JobRight/Indeed → Job Board);
  an alternate must itself match a page option verbatim and the pick is
  noted as a fallback. Everything else still refuses. ⚠ Operator: the
  class mapping is my inference from "LinkedIn IS social media / a job
  board" — say the word and I'll change the order or remove it.
- Tests: overlaid-radio fixture (question-label legend, live shape);
  class-only option list picks "Social Media" over "Job Board" by
  order; no alternates ⇒ still refuses; scoping negatives. 8/8.

### Job #22r — TIAA — 22:35 local — 15/17; radio FIXED live (#68a); last walls decomposed by probe
- Previously-an-employee radio error GONE. Remaining, probe-decomposed:
  (a) f_13 "Phone" is a GHOST — no phone-section element carries a bare
  "Phone" label; an anchorless duplicate of canonical `phone` whose
  fill typed into an ambiguous resolution, whose verify double-counted
  the miss, and whose bare label blocked the #66b retype's locator
  (four "Phone…" labels collide). (b) the phoneType listbox button's
  MOUSE click is swallowed (painted overlay) while a JS click opens the
  popup — probe-confirmed. (c) paced typing + Tab PERSISTS 3s (probe) ⇒
  the phone wipe comes from LATER sibling fills re-rendering the
  section; the verify-time keystroke retype is the right medicine and
  only the ghost blocked it. (d) countryPhoneCode: the fill's chips
  read-back accepted "United States of America (+1)" (labelsCompatible)
  but VERIFY was stricter and mismatched the same pair. (e) the source
  fallback picked "Social Network" but the single 250ms commit read
  missed the chip.

### 69. Ghost-twin dedupe; JS-click popup tier; verify↔fill comparator parity; chip-read settle — FIXED (FIXTURE_CONFIRMED; live #22s)
- `dedupeAnchorlessCanonicalTwins` (fill + verify + retype): an
  anchorless FILL twin of an anchored canonical is dropped and noted;
  lone anchorless entries survive. The retype prefers the anchored
  entry for a canonical.
- fillComboboxControl: when the listbox doesn't open after the mouse
  click, ONE JS-click tier (probe-proven on the live button), then the
  loud refusal as before.
- greenhouseVerifyFromPlan: verify accepts exactly what the fill's
  commit check accepts for string observations (labelsCompatible) —
  verify was stricter than fill and failed committed chips.
- Alternates commit read gets the same double-read the main path has.
- Tests: dedupe unit case (live f_13 shape); prior suites green. 11/11.

### Job #22s — TIAA — 23:00 local — the REAL phone root cause: the PLAN mapped canonical `phone` onto THREE controls
- Evidence (outcomes, unredacted expected_class): phoneNumber--phoneType
  (the device-type SELECT) and f_13 were both planned with the phone
  NUMBER — the option-verified pick refused ("no option matches
  '480…'"), and those wrong-target writes are what re-rendered the
  section and wiped the real number all night. #69's pieces held:
  JS-click tier fired live ("opened via JS click — mouse click
  swallowed"), dedupe dropped anchorless twins (f_13 apparently carries
  an anchor since #67a and is dealt with by #70's guard instead).
  countryPhoneCode's chip committed at fill but verify classified the
  multiselect input "text" and read its empty value.

### 70. Canonical `phone` never claims option controls; multiselects verify via chips — FIXED (FIXTURE_CONFIRMED; live #22t)
- matchCanonicalField: select/checkbox/radio controls can never map
  `phone` (label substring AND name-hint routes both fenced — the
  mirror of #54's extension guard, one level up: a phone number is free
  text). Text phone fields unaffected.
- detectControlKind: an input with data-uxi-widget-type=selectinput or
  inside multiSelectContainer is a combobox — verify now reads the
  CHIPS (readComboboxValue's #67 branch) instead of the empty search
  input.
- Tests: 4 mapper-guard cases + prior widget suites. 5/5 + 9/9.

### Job #22t — TIAA — 23:05 local — phone section CLEAN (#70 live-proven); two walls left, both decomposed
- phoneNumber, countryPhoneCode, f_13 all verify ✓ (the mapper guard
  ended the wrong-target writes that had wiped the number all night).
  Remaining: (a) phoneType — the #70 guard worked (no longer canonical
  phone) but the LLM predict tier then answered the UNMAPPED select
  with country-code nonsense while the button already sits on a correct
  prefilled "Mobile"; (b) source — probes mapped the widget: TWO-LEVEL
  list (categories → leaves), the search box ignores typing, "Social
  Network" → [Facebook, Other], and **"Job Board" → […, Indeed,
  LinkedIn, …] — the operator's stored answer EXISTS as a leaf.**

### 71. Prediction never overwrites an answered select; two-level prompt lists drill to the stored leaf — FIXED (FIXTURE_CONFIRMED; live #22u)
- resolveAnswers: an llm_predict/other_option screener resolution for a
  SELECT whose discovered currentValue is a committed non-placeholder is
  skipped with the value named — prediction is for UNANSWERED fields.
- fillComboboxControl drill tier (before class fallbacks): category
  candidates = caller alternates present at level 1 first (class
  hints), then every level-1 row, capped 12; a drilled level is
  searched for the EXPECTED leaf (stored answer verbatim — better than
  any fallback); back out via the widget's back affordance or reopen.
  FLAT lists are protected: an accidental commit of an unsanctioned row
  is undone via the chip's delete charm and the scan stops.
- Tests: two-level fixture (live TREE shape, typing inert) drills Job
  Board → LinkedIn; flat-list fallback still picks the sanctioned
  alternate; 10/10 across the widget suite.

### Job #22u — TIAA — 23:30 local — PAGE 1 CLEARED live (drill picked LinkedIn; Next advanced!); next wall = resume upload
- The drill fired live ("drilled into 'Job Board' and picked leaf
  'LinkedIn'"), page 1's error list emptied, and the wizard ADVANCED
  past page 1 for the first time (walk shapes 14/17 → 0/17 → 13/14).
  Our commit read raced (page satisfied, chip read null — the walk's
  page-1 re-fill re-picked and stuck). New wall ×3: "The field Upload a
  file (5MB max) is required" — and the ROOT is structural: the
  pipeline's non-greenhouse branch NEVER passed resumePath to
  runAtsLiveFill; no Workday run ever had the resume. Also: the predict
  tier filled the empty phoneType via typed "filters" that went to the
  PAGE (buttons aren't typeable) and committed a stray "Fax"; and the
  signed-in draft now renders continueButton (not adventureButton) on
  the posting — the walk didn't know it.

### 72. Resume threaded to the workday leg; continueButton; buttons never typed; chip-read poll — FIXED (live #22v)
- runPipeline non-greenhouse branch passes the registered resume (same
  file as the submit path, #49 doctrine).
- Registry applyButton/gatedEntry += continueButton (draft-in-progress
  posting); re-reach paint-wait accepts it too.
- fillComboboxControl: a BUTTON control skips the typed-filter phase
  entirely (keyboard went to the page and committed strays — the "Fax"
  incident); picks come only from its open list.
- Drill/alternates commit reads use a bounded 6×500ms poll (chips
  render seconds late; the page was satisfied while we reported not
  committed).
- ⚠ phoneType now holds a stray "Fax" in the draft from #22u —
  the next run must re-pick; if the plan leaves prefilled selects alone
  (#71a) it will SKIP the wrong value. Watch for it; may need a
  targeted correction pass.

### Job #22v — TIAA — 23:55 local — RESUME UPLOADED + VERIFIED (#72 live-proven); wizard reaches the question pages; two mysteries
- uploads: verified:true, chip evidence — the "Upload a file" wall is
  GONE. phoneType draft restored to Mobile pre-run (logged one-off
  remediation of our own stray write). The walk now surfaces the
  Application Questions pages' real screeners via #66a (work auth,
  sponsorship, government-official, debarment, PwC conflict, SEC
  pay-to-play disclosure) — but fills 0/17, 0/14, 0/11, 0/9 with ZERO
  recorded evidence (per-page fill errors were dropped on the floor),
  and the phoneType plan STILL predicted (why didn't #71a fire? —
  under investigation; its drill scan also page-wide-clicked the
  countryPhoneCode chip: contained by the flat-list undo now).

### 73. Skills from the resume (operator directive) + wizard fill-evidence propagation — FIXED (FIXTURE_CONFIRMED; live #22w)
- **Operator (00:00): "there's a skills input for most jobs in Workday —
  the skills to be input and selected should be the ones on my resume."**
  Resume read (Shubham_Kale_Resume_SWE.pdf); 30 skills written to
  public-profile.json `skills` (languages → frameworks → AI → workflow,
  taxonomy-friendly names). New canonical `skills` (schema + accessor +
  SAFE_FACTUAL allowlist), tight label mapping (/^(technical|top|
  relevant|your)? skills?$/ — sentences never match), and a multi-VALUE
  select branch: each skill picked option-verified through the existing
  multiselect machinery (cap 10), unoffered skills NAMED, ≥1 must land;
  verify passes when the chips are a non-empty subset of the planned
  list. Flat-list drill-scan undo hardened: deletes the LAST chip via
  its charm (falls back to node removal) and flags a failed undo.
- Wizard per-page fill errors/skips now land in report.notes (the 0/N
  mystery becomes diagnosable next run).
- Tests: skills fixture (picks offered, names unoffered, chips-subset
  verify), 3 label-mapping cases. 11/11 + 8/8.

### Job #22w — TIAA — 00:15 local — the 0/N mystery DECODED by the new evidence: every per-page plan was ONE PAGE STALE
- The propagated errors say it plainly: page 2's plan tried page 1's
  fields (source, previousWorker, names, address — "control not found"
  ×8), page 3's tried My Experience's (workExperience-4--jobTitle…) —
  performTransition's readyMarker (/data-automation-id=/) matches ANY
  Workday chrome, so its html snapshot is the pre-Next DOM. The #69
  dedupe notes also verified live (f_11/f_13 ghost drops).

### ⚠ #74/#74b/#74c/#74d were chasing an ARTIFACT — the real cause was a signed-out session (see #75)
- Three fingerprint strategies produced identical failures because the
  runs weren't on our draft at all. Kept (they harden the walk), but
  the "stale page" readings of #22w-#23a are reinterpreted below.

### 74. Wizard plans on the FRESH page — field-set fingerprint poll after Next — FIXED (live #22x)
- Before Next: fingerprint the current page's discovered field ids.
  After a landed transition: poll page.content() (bounded by
  settleTimeoutMs) until the field set DIFFERS, then run the error
  check, classification, and the per-page plan on that fresh DOM.
  settleMs 0 keeps fixtures synchronous. frame-hop-wizard 10/10.

### 75. THE REAL #22x-#23a CAUSE — Workday session expiry + a late-painting chooser modal left the walk anonymous — FIXED
- Pixels (01:30): header "Sign In" (session expired AGAIN — recurrent
  every ~30-60 min all night), and Continue opens the "Start Your
  Application" chooser. #23a's auth trail: clicked "Continue
  Application" → probed for Apply Manually BEFORE the modal painted →
  15s wait for a password form that never comes → "no sign-in form" →
  an anonymous wizard shell classified `wizard` → three runs planned
  against pages that were never our draft. The identical "stale plan"
  failures across three fingerprint fixes were this, not DOM staleness.
- Fixes: (a) openWorkdayApplyChooser's fall-through now polls (bounded
  15s) for ANY continuation — password form, the Apply Manually button,
  or the SSO email button — and loops when the chooser paints late;
  (b) atsLiveFill: a wizard-looking page with the signed-OUT header
  (utilityButtonSignIn visible) is an anonymous shell — off-flow, one
  re-reach through the (fixed) auth walk. portal-auth + ats-live-fill
  40/40. Live: #23b.

### ⚠ DIAGNOSIS-HYGIENE FAILURE (#74–#75b, ~00:40-01:50): five cycles read ONE stale fill_runs row
- Refused runs record NO fill_runs row; "ORDER BY created_at DESC
  LIMIT 1" kept returning #22x's row (code_version 97e2cc8) and every
  "identical failure" was the same old record. The #74 fingerprint
  hardening and #75 chooser/flow-dialog fixes are real improvements but
  were aimed at an artifact. Memory note saved (stale-fill-run-rows):
  check code_version/created_at, prefer the newest live-*.json.

### 76. Auth submit JS-click tier — FIXED code-side; #77 opened on the remaining wall
- The true #23b-#23e trail (refusal artifacts): the walk works end to
  end (Apply → Apply Manually → SSO email → form, creds typed and
  read back), but the sign-in submit is intercepted (10s click timeout
  on the click_filter overlay), and now the JS click AND Enter are BOTH
  silent — on the same form the 20:55 paced diagnostic cleared
  instantly. The create route then "clears" (false positive; #64's
  header demotion can't fire on auth pages, so a vault entry was
  recorded — factually correct, account exists).

### ✅ Job — 11eba960 Exa Software Engineer, Intern (Ashby) — 02:26 local — SUBMITTED (first submit of night21; LIVE_MUTATION_CONFIRMED)
- Cycle 1 picked Exa (night20's #58 job). One blocker left: the
  relocation question resolves "Open to relocating" (#58 ✓) but the
  control is an Ashby hidden-radio FIELDSET typed select — resolution
  failed. **#78**: when the label ladder exhausts and a fieldset
  matching the question holds radios, pick the member painted-safe;
  verify reads the checked member's label. Fixture from the live shape.
- Retry: fill passed → READY_TO_SUBMIT → click → receipt pixels:
  green "Success — Your application was successfully submitted."
  The classifier read `unknown` (wording gap) and parked UNCERTAIN —
  resolved submitted via the guide's resolver; state = SUBMITTED.
- **#79**: Ashby confirmationMarkers learn "application was
  successfully submitted" (the live banner). One-line regex.

### 77. OPEN — TIAA sign-in silently refused by every input path; suspected tenant throttle after ~30 attempts tonight
- Same creds + same form + human-paced clicks succeeded at 20:55;
  by 01:50 mouse/JS/Enter all no-op with no error text. Consistent with
  silent rate-limiting on the tenant. Not code-fixable now. TIAA parked
  (AMBIGUOUS_FIELD, draft intact: page 1 committed + resume uploaded);
  retry after a multi-hour cool-down or in the morning. Per the 3-min
  doctrine the loop MOVES ON — tonight's fixes (#66-#74) are
  ATS-generic and the rest of the queue benefits immediately.
