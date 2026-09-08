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

### Cycle 1 (00:13Z 09-08) — fresh mode, no_fresh_candidate

- AUTONOMY PASS: CDP autolaunch started debug Chrome on 9222 (port was
  closed at session start). Preflight ok, agent leg available.
- Discovery: 8 cards inspected, 0 eligible, 8 filtered (fresh-mode intern
  filter), 0 reused → `no_fresh_candidate`, backlog untouched. Same static
  8-card feed as all of 09-06.
- Issue #179 (observation): JobRight feed discovery is starved. The scan
  limit is 40 in fresh mode but the live scrape returns only the 8 cards
  the recommend page renders without scrolling, and that page has not
  changed in ~30h. Fresh-mode cycles therefore idle forever. Second
  discovery source used instead (below). Candidate fix for a later
  session: scroll/paginate the feed scrape, or rotate feed URLs.
- Autopush 6ec2d395 (artifacts only — verified the source change was NOT
  staged).

### Discovery via ATS boards (00:17Z) — `discover:ats --registry`

- `private/discovery/boards.json` (15 Greenhouse/Ashby boards) swept with
  `--limit 8`: 8 enqueued (Databricks SWE Intern Winter 2027; Stripe ×7 —
  6 "Software Engineer, Intern" variants + 1 "Operations Associate, New
  Grad (Mexico)"), 3 reused (Samsara new grad, 2 Databricks), rest capped
  (Verkada ×2, Notion ×4 — re-run to continue).
- Issue #180 (observation): the registry's `include: ["new grad"]` on
  Stripe over-matched a non-engineering Mexico ops role, and one board can
  monopolise the cap (Stripe took 7 of 8 slots; a per-board cap would
  spread the sweep). Parked the ops role FAILED_FINAL through the state
  machine (`private/tmp-park-one-20260907.ts`) with the reason recorded.
- Queue after: 7 QUEUED (6 Stripe, 1 Databricks). Backlog cycles from
  here (`--backlog`) — the picker takes QUEUED newest-first, so the
  ATS-discovered rows run before any parked app.

