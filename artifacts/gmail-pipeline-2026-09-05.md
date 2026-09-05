# Gmail/outreach pipeline run — 2026-09-05

Mission: produce Gmail DRAFTS (never send) for outreach on three jobs the
operator applied to MANUALLY on JobRight, per `docs/state-machine.md`'s
"Apply-yourself outreach" path (`runOutreachPipeline` / `npm run outreach`).

## Applied page read (LIVE_READ_ONLY_CONFIRMED)

Read via CDP-attached tab at `http://127.0.0.1:9222` (own tab, opened and
closed; no other tab touched). Screenshot: `artifacts/gmail-pipeline-applied-page.png`.
Raw text dump: `private/tmp-applied-page.txt` (not committed — private/ is gitignored).

The applied page shows `Applied(51)` total. The three most recent entries
(all "Applied on Sep 5, 2026", i.e. today) are exactly the three target
companies, in this order:

| Company | Role (as shown on page) | JobRight URL |
| --- | --- | --- |
| Juicebox | Software Engineer Intern | https://jobright.ai/jobs/info/6a9b2ed02cdc5958f53eb3ed |
| Scale AI | **Software Engineering Intern (Summer 2027)** | https://jobright.ai/jobs/info/6a9af7932cdc5958f53e9e6e |
| Garner Health | Software Engineering Intern | https://jobright.ai/jobs/info/6a9b3debd5ff1f3f1c39e64c |

### G1 — role-name mismatch vs. the brief

The mission brief named the Scale AI target "AI Builder Intern". The applied
page's actual, current, most-recent Scale AI entry (applied today) is titled
**"Software Engineering Intern (Summer 2027)"**, jobright_job_id
`6a9af7932cdc5958f53e9e6e`. This job id is NOT either of the two Scale AI job
rows already in the DB:
- `162f6639-97d2-4633-8cee-5d2e7cf66c8b` (jobright_job_id `6a23b8acd46c0f799608597d`, "AI Builder Intern", no application row)
- `5ecc1285-e051-4ee8-98ea-c60bec2bd7fa` (jobright_job_id `6a535a768ef95364ead91ec8`, "AI Builder Intern", application `796a8e0f-4d2e-40c2-a971-7ca6b94558af`, state `FAILED_FINAL`)

That FAILED_FINAL "AI Builder Intern" application already has 3 contacts,
3 VALIDATED email_generations, and 3 DRAFTED+verified gmail_drafts from
2026-08-25 (a prior automation attempt's outreach tail) — but this is a
**different posting** than the one the operator actually applied to by hand
today. Treating "Scale AI" as covered by that old data would be wrong.
Proceeding with the job the applied page actually shows
(`6a9af7932cdc5958f53e9e6e`, Software Engineering Intern Summer 2027) as
today's manual-apply target; not touching the old FAILED_FINAL app's
existing drafts.

## Pre-check: no existing DB rows for the three targets

Confirmed via read-only SQLite query before running anything:
- Garner Health, Juicebox: no `jobs` rows at all (not previously imported).
- Scale AI `6a9af7932cdc5958f53e9e6e`: no `jobs` row (distinct from the two existing Scale AI rows above).

No prior gmail_drafts/email_generations exist for any of these three exact
postings, so nothing is being re-drafted after an operator send.

## Chain: `npm run outreach -- --jobright <url>`

This single command performs enqueue (apply-yourself, `excludeFromAutomation`
tagged so it never enters the auto-apply pipeline) + JobRight detail-page
enrich + insider-triage contacts + email:generate + gmail:draft, idempotently.
Run once per target so a failure on one does not block the others.

(Results filled in below as each run completes.)

### 1. Juicebox — Software Engineer Intern

- URL: https://jobright.ai/jobs/info/6a9b2ed02cdc5958f53eb3ed
- Status: DONE — zero contacts, so zero emails/drafts (a real, legitimate result, not a failure)
- application_id: `68882294-08f9-43fc-ada6-b87da3015fb4` (state `QUEUED`, `automation_excluded=true`)
- Attempt 1 (15:49:22): failed transiently — "Debug Chrome at http://127.0.0.1:9222 is unresponsive (port answers but the CDP session won't attach)" during insider triage. Recorded as **G2** below; retried per the attempt-cap rule.
- Attempt 2 (15:50:53): insider triage ran and completed: `people_checked: 0, emails: 0, skipped: true`, note "no Insider Connection people in the school/beyond panels — triage skipped". Pipeline reported `ok: true` with 0 generated / 0 drafted, because there were no contacts to email.
- No Gmail draft created for Juicebox — there is nothing to draft against (no insider contact emails surfaced for this posting).

### 2. Scale AI — Software Engineering Intern (Summer 2027)

- URL: https://jobright.ai/jobs/info/6a9af7932cdc5958f53e9e6e
- Status: DONE (LIVE_MUTATION_CONFIRMED for the drafts themselves — the pipeline's own read-back verified 1 of 5; see note)
- application_id: `76090f6b-4fc3-4c66-a302-cd6ea88900f3` (state `QUEUED`, `automation_excluded=true` — apply-yourself, never entered auto-apply)
- Insider triage: 10 people checked, 5 emails found (LINKEDIN_ENRICHMENT_ENABLED path)
- email:generate: 5/5 contacts VALIDATED (model claude-opus-5, 0 violations each)
- gmail:draft: 5/5 contacts → status DRAFTED. Read-back verification (`verified` field, a search of Gmail Drafts for the subject): TRUE for 1 contact, FALSE for the other 4 (draft-compose + save-and-close all reported "draft composed and closed (Gmail autosaves on close)"; the Drafts-search read-back just didn't find a match within its short wait for those 4 — a stricter/slower search would likely confirm them, but per the validation ladder I am NOT promoting those 4 past what the tool itself reported).
- Drafts created (from `gmail_drafts` table, all `status=DRAFTED`, subject "Hopkins sophomore interested in Scale AI SWE internship"):

  | recipient | verified (Drafts-search read-back) |
  | --- | --- |
  | andrew.zhang@datadoghq.com | true |
  | bijan.varjavand@openai.com | false |
  | haojin.li@scale.com | false |
  | jake.krantz@scale.com | false |
  | varsha.roopreddy@scale.com | false |

  (Two recipients are school-alumni contacts at other companies — Insider
  Connection's school/beyond panels surface alumni regardless of current
  employer; that's expected, not an error.)
- **G1 applies**: this is the "Software Engineering Intern (Summer 2027)" posting the operator actually applied to today, not the "AI Builder Intern" posting named in the brief (that one is a separate, older FAILED_FINAL application already carrying its own 2026-08-25 drafts — left untouched).

### 3. Garner Health — Software Engineering Intern

- URL: https://jobright.ai/jobs/info/6a9b3debd5ff1f3f1c39e64c
- Status: DONE — zero contacts with an email, so zero emails/drafts (legitimate result)
- application_id: `f40d9047-d40d-4e9d-ad92-a6cb4f718c2d` (state `QUEUED`, `automation_excluded=true`)
- Insider triage ran cleanly (not skipped): `people_checked: 1, emails: 0` — matches the "1 school alum" badge seen on the applied-page card; that one insider contact had no discoverable email address.
- No email generated, no Gmail draft created — nothing to send to.

## Gaps / mishaps log

- G1: role-name mismatch for Scale AI vs. the brief (see above) — used the
  page's actual current posting, not the briefed title.
- G2: Juicebox's first `outreach` attempt hit a transient CDP-attach failure
  ("port answers but the CDP session won't attach") against the shared debug
  Chrome at 127.0.0.1:9222 — most likely contention with the main applying
  loop that also uses this browser. A same-command retry succeeded a few
  seconds later with no other changes. Not a code bug; noting it as an
  environment/contention hazard of sharing one CDP browser across the
  applying loop and this pipeline run.

## Summary

| Target | Contacts found | Emails generated | Gmail drafts | Notes |
| --- | --- | --- | --- | --- |
| Juicebox — Software Engineer Intern | 0 | 0 | 0 | insider triage found no school/beyond panel people; needed 1 retry for a transient CDP hiccup (G2) |
| Scale AI — Software Engineering Intern (Summer 2027) | 5 | 5 (all VALIDATED) | 5 (DRAFTED; 1/5 confirmed by automated read-back, 4/5 unconfirmed by read-back but reported composed+saved) | this is NOT the "AI Builder Intern" title from the brief (G1) — that's a separate older FAILED_FINAL application, untouched |
| Garner Health — Software Engineering Intern | 1 | 0 | 0 | the one insider contact had no discoverable email |

Validation levels: applied-page contents = LIVE_READ_ONLY_CONFIRMED (own
screenshot + text dump). Enqueue/contacts/generation/draft-creation states
are exactly what each CLI step reported back (JSON above), i.e.
LIVE_MUTATION_CONFIRMED for the DB writes and the 1 read-back-verified Gmail
draft; the other 4 Scale AI drafts are LIVE_MUTATION_CONFIRMED for "compose +
save & close executed" but UNVERIFIED for "definitely visible in Gmail
Drafts" since the read-back step itself reported false — operator should
glance at Gmail Drafts to confirm those 4 before relying on them.

No sends occurred (GMAIL_DRAFTS_ENABLED path only ever calls Save & close;
send button is a named-forbidden selector, never a click target). No source
code was modified; only a read-only probe script
(`private/tmp-applied-probe.ts`, gitignored) and this artifact were added.
No commits made.
