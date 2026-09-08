# Overnight issues — 2026-09-07 (night26)

Continues numbering from 2026-09-05/06 (#177 last). Session log:
`artifacts/console/auto-cycle-2026-09-07-night26.log`.

Operator directive (2026-09-07): run the full system — discovery → apply →
post-submit gmail pipeline — with the queue reset, and make sure the LLM
has sufficient context for the larger navigation decisions.

## Preflight

- Queue reset (`private/tmp-reset-queue-20260907.ts`, state machine only):
  3 stale QUEUED rows (Scale AI — operator already applied by hand —,
  Juicebox, Garner Health; all from 09-05) → FAILED_FINAL with the reset
  reason. QUEUED = 0 before cycle 1; fresh discovery repopulates.
  Backlog (29 FAILED_RETRYABLE, 26 NATIVE_AUTOFILL_RUNNING gate parks,
  61 AMBIGUOUS_FIELD) left to the triage layer, untouched.
- Flags verified in `.env`: FORM_FILL, SUBMIT, AUTOMATION, NAVIGATION,
  GMAIL_DRAFTS, EMAIL_GENERATION, GMAIL_VERIFICATION, SCREENER_LLM_MATCH,
  SCREENER_PREDICT_LLM, ESSAY_DRAFT, ESSAY_AUTOFILL, MATERIALS_DOWNLOAD,
  ATS_DISCOVERY, CDP_AUTOLAUNCH, ARTIFACT_AUTOPUSH, AGENT_FALLBACK,
  TRIAGE_LLM, TRIAGE_ACT, NAV_LLM_ASSIST all true; DRY_RUN=false.
  ANTHROPIC_LLM_MODEL=claude-opus-5 (navigation supervisor runs on it at
  effort "high"; triage/anchor adjudication at "low").
- CDP 9222 closed at session start; CDP_AUTOLAUNCH_ENABLED=true so cycle 1
  launches the debug Chrome itself (worked on night25).

## LLM context audit (what each decision surface sees)

- Triage (`src/triage/evidenceBundle.ts`): app identity, last 15 events,
  newest nav report (wall/method/notes/congruence/dups/login wall/phase
  trace), submit brief, fill gate, open review items, prior decisions,
  failed-host count. Adequate.
- Anchor adjudication (M6): company, role, ≤8 harvested hrefs with the
  congruence verdict per URL. Adequate for its narrow choice.
- Navigation supervisor (`src/navigation/applicationSupervisor.ts`) —
  the surface that makes the "larger" navigation decisions — saw ONLY
  `{company, role, url}` plus the live observation/screenshot/history.
  Gap: no posting details (location, employment type, description), no
  source posting URL, and NO memory of earlier attempts on the same app
  (walls hit, hosts reached), so it could not recognise the right posting
  on a multi-job careers site nor avoid a route a prior attempt already
  exhausted.
- Issue #178 (fix, UNIT_CONFIRMED): new `src/navigation/supervisorContext.ts`
  builds a capped, redacted job context — location, employment_type,
  source_ats, posting_url, 700-char description excerpt, attempt number,
  last 3 navigation attempts (wall/method/end_host/resolved + 4 notes
  each), last 6 state events. Wired into both supervisor call sites
  (`atsLiveFill.ts`, greenhouse `liveFill.ts`); the system prompt names the
  new fields as evidence-only. Test: `tests/unit/supervisor-context.test.ts`.
  Typecheck clean; supervisor + knowledge-graph tests pass. Full gate to
  run in the next quiet window before commit (box cannot carry the suite
  and a live headed run at once).

## Cycles

