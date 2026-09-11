# Night30 issues log — 2026-09-11 (operator asleep, autonomous)

Operator directive (04:20 UTC): "reset the job queue and start applying to
jobs for the night, once the job has been applied then run the gmail
pipeline using a separate cdp instance/chrome window to not interfere with
the main job app workflow. feel free to iterate on and fix any bugs/errors.
im going to sleep."

Standing directives carried from night29 still apply (Lever/Ashby/
Greenhouse first, how-heard → Other/LinkedIn, 24h posting policy, no
overfitting, no questions).

Numbering continues from night29 (last issue: #249).

---

## Start-of-night state (04:25 UTC)

- Queue reset through the state machine: 48 rows (QUEUED, AMBIGUOUS_FIELD,
  APPLICATION_OPENING, NATIVE_AUTOFILL_RUNNING, FAILED_RETRYABLE,
  SUBMISSION_VERIFICATION_FAILED) → FAILED_FINAL with reason "operator:
  queue reset 2026-09-11 (night30 start)". Script:
  `private/tmp-reset-queue-20260911.ts`.
- **Kept:** the Merck "Modeling & Informatics" row (80338eb7) — the
  operator applied to it by hand at 23:32 UTC and it went through
  apply-yourself outreach (5 drafts). It is `automation_excluded`, which
  the picker checks BEFORE the 24h stale-abandon, so the loop never
  touches it.
- Open MANUAL review items dismissed.
- Nothing was running: no node processes, no debug Chrome.
- The dedicated Gmail Chrome (9223, `private/browser-profiles/gmail-cdp`)
  IS signed into Gmail now (skale072007@gmail.com — matches the candidate
  profile) and into JobRight. Night29's fallback note no longer applies:
  `resolveGmailCdpUrl()` → `{ url: 9223, dedicated: true }`.
  LIVE_READ_ONLY_CONFIRMED.

## Issue #250 — the Gmail tail still opened tabs in the applier's browser

**Symptom (code read, before launch).** #233 moved only Gmail Compose to
the dedicated Chrome. The insider-panel read (`runInsiderTriage`) still
attached with `mode: "CDP_ATTACH"` and no `cdpUrl`, i.e. the applier's
9222 — opening a JobRight tab and clicking email icons in the browser a
live fill is typing into. The operator's directive tonight is explicit
that the Gmail pipeline must not interfere with the apply workflow.

(The other two tail steps were already separate: enrich and the #242
company search open their own launched STORAGE_STATE browsers.)

**Fix.** `openInsiderSession` prefers the dedicated outreach Chrome when
`resolveGmailCdpUrl()` says it is usable AND the session's own JobRight
auth validation passes there; anything less falls back to the applier
browser (previous behaviour) with the reason recorded in the triage
report's notes.

**Latent cross-kill found on the way.** `PlaywrightServiceSession.open()`
answers a failed CDP attach with `restartCdpChrome()` — which always kills
and relaunches the APPLIER's debug profile, whatever URL failed. With
#233 that meant a wedged Gmail window on 9223 would have killed the
applier's Chrome mid-fill. The restart now fires only when the failing
endpoint IS `AGENT_CDP_URL`; any other endpoint gets an error naming its
own launcher (`chrome:debug:gmail`).

Tests: `service-session-restart-guard.test.ts` (2 — no restart for a
different endpoint; restart still attempted for the applier's own).
UNIT_CONFIRMED. The dedicated JobRight session validating AUTHENTICATED on
9223: LIVE_READ_ONLY_CONFIRMED. The triage actually running there is
confirmed by the first post-submit tail (note in the triage report).
