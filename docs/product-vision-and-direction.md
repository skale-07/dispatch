# Product vision & technical direction — jobright-application-agent + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/jobright-application-agent`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both*
repos together (shared lineage, shared operator, shared data-handling
posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-23 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting "Last reviewed" above.**
This is the **eighth** review. Every prior review (08-09, 08-11, 08-13,
08-15, 08-17, 08-19) was drafted on an unmerged `claude/*-*` branch and
**never landed on `main`/`master` in either repo** — the copy actually
merged to both default branches is still the original 2026-08-07 version.
Per the session-start-ritual instruction (tSearch `CLAUDE.md`) to check
unmerged `claude/epic-pasteur*`/`claude/busy-clarke*` branches for a fresher
copy, this review found and baselined on the 2026-08-19 draft
(`claude/epic-pasteur-purjf5` / `claude/busy-clarke-purjf5`, the seventh
review), then independently re-verified every carried-forward claim against
current `HEAD` in both repos rather than trusting the draft's prose. This
review is pushed to *this session's* designated branches
(`claude/busy-clarke-lqqsk6` jobright, `claude/epic-pasteur-lqqsk6` tSearch)
— a **ninth** unmerged copy. See §4's standing meta-risk: the living
document has now been drafted eight times without a single version ever
reaching `main`/`master`.

---

## 1. jobright-application-agent

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai
discovery → employer ATS form fill → gated submit → outreach → Outlook
drafts — while keeping every judgment call (essays, demographics, uncertain
submissions) with a human. It is explicitly **not** trying to be a general
autonomous browser agent. The product bet is that determinism + fail-closed
gating + an honest validation ladder beats an LLM-driven agent for a task
where a wrong click (an accidental real submission, a leaked credential, an
invented EEO answer) is expensive and hard to undo. That bet now spans three
surfaces: the CLI, an **operator console** ("Dispatch" — the repo began a
rename to this name on 08-17, PR #61, prep-only so far: the GitHub repo
itself is still named `jobright-application-agent`, still public), and an
opt-in **L3 armed mode** that removes per-application confirmation only
inside a timed, capped, operator-initiated window. As of 08-20 (PR #63) a
fourth architectural idea landed: **extension-first dual-agent fill** —
JobRight's own browser extension (external, deterministic, non-LLM) becomes
the primary filler on supported pages, with Dispatch's native fill as gap-fill
and the same approved-plan + read-back verification gates still covering
every write either path makes.

**This review's central finding, again: the Critical resume-PDF exposure
first flagged 08-11 is now on its sixth consecutive review cycle without a
fix, and it grew again — 366 leaked files on 08-19, 396 today.** Both
root-cause code locations are unchanged at the same line numbers reported
for five reviews running, and no commit since 08-19 touches either of them.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) — three gated LLM call sites, not one narrow OpenAI site as the doc said before 08-09 / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture — 21 fail-closed flags now (12 more than the 08-07 baseline's 9).** New since 08-07: `NATIVE_AUTOFILL_ENABLED`, `JOBRIGHT_AUTOFILL_ENABLED`, `MATERIALS_DOWNLOAD_ENABLED`, `GMAIL_VERIFICATION_ENABLED`, `SCREENER_LLM_MATCH_ENABLED`, `SCREENER_PREDICT_LLM_ENABLED`, `ESSAY_DRAFT_ENABLED`, `ESSAY_AUTOFILL_ENABLED`, `ARTIFACT_AUTOPUSH_ENABLED`, `CDP_AUTOLAUNCH_ENABLED`, `OUTLOOK_VERIFICATION_ENABLED`, `AUTOMATION_ENABLED`. All default `false` in `.env.example`/`src/config/env.ts` except `CDP_AUTOLAUNCH_ENABLED` (a debug-Chrome convenience default, still confined to the dedicated `jobright-cdp` profile dir via `assertDebugProfileDir`, not a mutation gate). `chromium.launch` remains confined to three session-infra files. `check:forbidden` and `check:secrets` both ran clean this review (`ok`), but `check:secrets` is staged-diff-scoped — it does not scan the existing tree, which is exactly why it hasn't caught the resume-PDF leak (see §1.3). **Policy reversal since 08-07:** essay generation is no longer "deliberately out of scope" — `ESSAY_AUTOFILL_ENABLED` shipped under an explicit 2026-08-15 operator directive (`CLAUDE.md`), filling from `private/candidate/about-me.md` behind `validateDraft`.
- **New testing rig, not a gate weakening:** a loopback-only sandbox submit path (`ats:fill --submit`) is hard-restricted by `isLoopbackUrl()` (`src/cli/index.ts:1391-1406`) to `http://localhost:4599/...` against the operator's own fake-employer sandbox (`npm run sandbox`). Real employer `SUBMIT_ENABLED` is unaffected and still defaults `false`.
- **ATS coverage — materially expanded since 08-07, unchanged since ~08-11.** Registry (`src/ats/registry.ts:19`): `unsupported, greenhouse, lever, ashby, workable, workday, generic`. Greenhouse: inspect+fill shipped, `FIXTURE_CONFIRMED`; live CAPTCHA/redirect fixes still not retested live (unchanged since 08-07, no commit touches `captchaDetection.ts`). Lever/Ashby: fully wired, `FIXTURE_CONFIRMED` on synthetic fixtures only — `docs/ats-adapters-lever-ashby.md`: "no live run has been performed." Workday: real Tier-2 adapter (portal auth + multi-page wizard), `UNVERIFIED_SELECTOR` until first live capture. Workable: new adapter, same unverified status. Generic: lost its own feature flag (08-14 operator directive, PR #42) — detection/planning always on, mutation still covered by the standard `FORM_FILL_ENABLED`/`SUBMIT_ENABLED`/`DRY_RUN` flags. **Real news this review:** in-code comments dated "live 2026-08-19" across `src/ats/generic/v1.ts`, `preMutationGate.ts`, `atsLiveFill.ts`, `comboboxFill.ts`, `locationQuery.ts`, `fieldDiscovery.ts` show a genuine live-fill session against a Paylocity-hosted employer form drove real bug fixes (form-less SPA handling, a USPS state-list combobox, OneTrust consent-DOM exclusion) — the first concrete live-fill evidence found in any review so far, but it is undocumented in `current-state-and-phase56.md`/`validation-levels.md` and not promoted to any validation level there.
- **Verify gate this review, all re-run directly on current `HEAD` (`8018fde`), not assumed:** `npm run typecheck` clean. `npm run check:forbidden` and `npm run check:secrets` both `ok`. `npm run test`: **943 passed / 212 failed / 8 skipped across 1163 tests in 123 files** (up from 895/1102 on 08-19 — growth tracks new adapter/design-system tests). Every failure traces to the same single cause as every review since 08-15: `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path — plain Chromium is present but the headless-shell channel the fixture harness requests is not. Not evidence of a code regression; claim stays `UNVERIFIED` for anything touching a real browser launch until re-run where the binary is present.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: sixth review running, still unresolved, still growing.**
  Verified directly against current `HEAD` (`8018fde`): **396
  `artifacts/applications/*/materials/resume-*.pdf` paths** are reachable
  from `HEAD` (up from 366 on 08-19). Traced the 30 net-new paths to two
  commits since 08-19: `c6ec813` ("recent artifact push and tunign," a
  manual commit, +1 file) and `ad8896e` (PR #63, extension-first fill
  dev/testing, +29 files) — confirming, again, that this is not solely the
  autopush code path's doing. Both root causes remain unchanged at the same
  line numbers reported for five reviews running: `src/security/artifactScan.ts:26`'s
  pattern is still `/resume\.pdf$/i`, which does not match the actual
  `resume-<hash>.pdf` filenames (re-verified: `node -e "console.log(/resume\.pdf$/i.test('resume-db94def0.pdf'))"`
  → `false`); `src/automation/artifactAutopush.ts:53` still runs a blanket
  `git("add", "-A", "--", "artifacts")` with no `materials/` exclusion. No
  commit since `eb4a999` (08-17, the one that surfaced first-party evidence
  the local pre-commit hook wasn't reliably firing) touches either file. No
  purge has ever been attempted against this specific leak.
- **`docs/current-state-and-phase56.md` is still wrong — seventh review in a
  row flagging it, now twelve days past when it was first called a "same-day
  fix."** Line 179 still reads "The live discovery path has never produced a
  job," now directly contradicted not just by auto-cycle artifacts (flagged
  since 08-11) but by the newly-found 08-19 live-fill evidence against a real
  Paylocity posting (§1.2) — the document is falling further behind the
  actual state of the product with each review, not just staying stale.
  `docs/known-limitations.md` and `docs/validation-levels.md` are similarly
  unrefreshed relative to the ATS/extension-first expansion.
- **Declared phase vs. reality — new framing gap, not previously called out
  explicitly.** `docs/operator-guide.md` and the stale phase docs still frame
  the project as "Phase 5.6 — live validation only, no new capability," but
  five ATS adapters, extension-first fill, essay autofill (a reversed
  non-goal), Gmail drafts, and a full console redesign have shipped since
  that framing was written. None of this weakens any safety gate (verified
  per-commit, §1.2), but an operator or future agent trusting the phase
  framing would materially misjudge how much new capability surface exists.
- **L3 armed unattended apply: unchanged, still `FIXTURE_CONFIRMED`.** No new
  auto-cycle artifacts with a live submit found this review; the
  `submits_used: 1`/`per_app`-mismatch artifact (`run-47082d9f`) flagged
  08-13 is unchanged (re-verified: still present, still contradictory).
- **`auto:cycle` unattended operating posture: unchanged.** Still a standing
  `.env` + scheduled task, self-arming, no per-run human click, no time-boxed
  re-arm gate. Whether `operator-guide.md` §17b's "standing operator grant"
  self-merge language describes an actual auto-merge or just a human clicking
  merge remains unconfirmed either way from commit metadata alone (unchanged
  since 08-19).
- **Sender-trust magic-link handling: unchanged since `a4f9cd8` (08-12).** No
  commit since 08-19 touches `extractMagicLink` in
  `src/gmail/verificationParsers.ts`. Still a keyword-match-plus-ranking-boost
  qualifier with no hard sender-domain-affinity requirement.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order, unchanged from 08-19 because none of it has
  been picked up across two more review cycles:** (1) confirm
  `npm run hooks:install` is actually run on the machine that
  autopushes/tunes, fix `src/security/artifactScan.ts:26`'s regex to match
  `resume-*.pdf`, add a `materials/` exclusion to `artifactAutopush.ts:53`,
  then purge the (now 396-path) leak from history — still the single most
  overdue action item across both repos, now six review cycles running
  without being picked up; (2) fix `current-state-and-phase56.md` and refresh
  the phase framing; (3) resolve the `submits_used: 1`/`per_app`
  inconsistency with an operator; (4) live-DOM proof for Lever, Ashby,
  Workday, Workable; (5) a decision on tightening sender-trust domain
  affinity from ranking-boost to filter; (6) promote the 08-19 Paylocity
  live-fill session to a documented validation level instead of leaving it
  only in code comments.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/current-state-and-phase56.md) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/operator-guide.md) ·
[`docs/ats-adapters-lever-ashby.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/ats-adapters-lever-ashby.md) ·
[`docs/ats-adapter-workday.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/ats-adapter-workday.md) ·
[`docs/known-limitations.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/known-limitations.md) ·
[`docs/validation-levels.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/validation-levels.md)

---

## 2. tSearch

### 2.1 Vision

"Unseen talent discovery": find people whose ability shows up in public
artifacts (GitHub repos, technical writing) rather than credentials — starting
from named seeds (olympiad medalists, referrals), expanding outward through
their real collaboration graph (GitHub collaborators/followers, Substack),
scoring on evidence of building + thinking + pedigree, then running LLM
"judges" over their actual public work to produce a defensible, evidence-cited
priority score for a recruiter digest. The stated non-negotiable design
principle (`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment — the system is built to avoid
confidently ranking someone down for something it simply couldn't see.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`, plus a GitHub-first "footprint sweep" that pre-qualifies olympiad-CSV names before ever touching LinkedIn, and an autopilot chain (sweep → resolve → discovery → assessment → digest → send, fail-closed to mock/dry-run by default).
- **Real feature wave this cycle — four commits since the 08-19 review, none previously reviewed.** `4ba3672` (restore the Discover UI + lock identity/scoring against cache wipes), `54d1d36` (youth wildcards: 17-19-year-old LinkedIn-only candidates always ride along in digests even below the priority floor; GitHub only attached when the profile corroborates the known LinkedIn/site), `8a7a3f0` (scoring-weight tuning, smarter age surfacing, a new `articleAuthoredBy.ts` writing-hub check), `96dd18b` (a "marks" operator watchlist feature — `MARKS_DIR=data/marks`, already gitignored via the existing `data/` rule — and **Supabase scaffolding**: `TSEARCH_STORE` env var, `SUPABASE_URL`/`SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` config. Verified directly: the `supabase` store backend throws until a later dual-write integration lands, the service-role key is explicitly commented server/pipeline-only ("never `VITE_`, never commit"), RLS is deny-all by design, and `.gitignore` picked up `supabase/.temp/`/`supabase/.branches/` in the same commit — this is scaffolding done correctly, not a new live risk, but worth watching once the dual-write actually lands).
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen candidates snapshot — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number; the youth-wildcard change (`54d1d36`) adds a floor-bypass for digest *inclusion*, not a change to how the two scores are computed or combined.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by experience-distinctiveness, recruiter-label/tier, and (merged 08-18, PR #6) age-relative-impressiveness + obscurity-multiplier judges. Six judges now carry no measured inter-rater agreement or position-bias number (see §5).
- **Safety-flag layer — still unchanged.** `CLAUDE.md` documents fail-closed boundaries in prose (added 08-10: no PII in git, assessment reads frozen snapshot only, email sends gated, LinkedIn pacing respected, LLM calls default to mock). None of this cycle's four commits touch it, and there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden` — a future change could silently violate the frozen-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it.
- **Verify gate this review, re-run directly:** `npm run typecheck` clean. `npm run test`: **359/359 passing across 57 files** (up from 222/222 on 08-19 — the jump tracks this cycle's four-commit feature wave, not just PR #6). Repo is not currently broken. Digest send-gating re-verified directly in `src/digest/sendDigest.ts:56`: `wasDryRun = opts.dryRun || !EMAIL_PROVIDER_API_KEY` — fails closed to dry-run with no key present, unchanged.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — eighth
  review in a row confirming it.** Re-verified directly again this review:
  `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves, and
  the blob still contains a real person's full name, LinkedIn URL, photo CDN
  URL, school, and degree. No `filter-repo`/BFG commit exists anywhere in
  `git log --all`. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`, confirmed unchanged this review),
  which bounds new exposure but does nothing for what's already public in
  history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding.**
  `tests/assessment/ownership.test.ts` and the LinkedIn auth-guard test
  confirmed still present this review — the two risks resolved 08-10/08-11
  have not regressed across five subsequent reviews.
- **Everything else in this section carries forward unchanged**, since this
  cycle's four commits were scoring/UI/persistence-scaffolding, not the
  digest ranking-refinement loop, LinkedIn scrape-failure handling, or
  auto-assess default: zero retry/trace/screenshot capture on LinkedIn scrape
  failures (unchanged since the original audit); captured `expected_country`
  still used only as a matching-boost hint, never to actively reject a
  homonym mismatch (re-verified directly in `src/linkedin/linkedinMatch.ts`
  this review); digest ranking-*refinement*-from-feedback (as opposed to
  feedback *capture*, which shipped 08-10) still unbuilt; global-vs-per-seed
  and Substack-only-filtering product questions remain unresolved;
  auto-assess still runs by default at pipeline end (`AUTO_ASSESS=0` to opt
  out).
- Zero open issues, zero open PRs at time of this review.

Deeper detail (in this repo): [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/system-brief.md`](./system-brief.md) (generated, Tier 0 oracle context)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(**jobright repo**, not this one) records the original reuse plan: tSearch's
`saveSession.ts` / `linkedinBrowser.ts` concepts (manual storageState login,
lazy session open/validate) and atomic-JSON-store pattern were the seed for
jobright's `ServiceSession` and `src/storage/` layers, explicitly rebuilt with
more hardening (coverage statuses, mid-run auth checks — matched on
tSearch's side too, see §2.2 — traces/screenshots, no committed profile
artifacts, a design choice tSearch has also adopted going forward per
§2.2, though not retroactively into history per §4). tSearch's product
logic — olympiad scoring, GitHub graph expansion, the seed-tree UI — was
deliberately **not** ported; the two products solve different problems
(apply vs. discover) and share only the "safely drive a browser session
against a third-party site" substrate.

**Both repos still share the same unresolved shape of risk: a personal/PII
document exposure on a public repo, found and re-confirmed unpurged across
multiple review cycles, with the underlying automation in jobright's case
still capable of adding more.** tSearch's is third-party LinkedIn PII in
history only (current tree is clean, and the count is stable — no new
commits touch `profiles/`/`backup/`); jobright's is the operator's own resume
PDFs, still actively growing with every automation cycle (396 files now vs.
366 four days ago) from both automated and manual commits. That keeps
jobright's the more urgent of the two: it is the one still getting worse in
real time, and the fix has been fully specified — a one-line regex, a
one-line path exclusion, a hook-install check, then a history purge — for
six review cycles without being applied. Both repos also carry a genuinely
unattended, scheduled-automation surface — jobright's `auto:cycle` (§1.3,
real submissions possible, plus the still-unconfirmed standing-grant
self-merge) and tSearch's autopilot (§2.3, fail-closed to mock/dry-run by
default) — worth watching as a shared pattern, since a gating bug in either
would look similar from the outside (a scheduled task silently doing
something consequential).

One document is stale on the reuse-plan point specifically:
`docs/tsearch-reuse-map.md` still describes porting `linkedinExtract.ts` into
a `packages/linkedin-enrichment` module "in Phase 10," but
`current-state-and-phase56.md` records that LinkedIn enrichment was
**dropped by decision** for the MVP (JobRight contact context only).
Low-severity, unchanged since 2026-08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | jobright | **Sixth consecutive review finding this unfixed and worse.** `ARTIFACT_AUTOPUSH_ENABLED` plus manual operator commits continue pushing the operator's real resume PDFs to this public repo: 30 more paths landed since 08-19 (one manual commit, one feature-dev commit), bringing the total to **396 leaked `materials/resume-*.pdf` paths** (up from 366 on 08-19, 327 on 08-17, 308 on 08-15, 187 on 08-13, 183 on 08-11). Both root-cause code locations (`artifactScan.ts:26` regex, `artifactAutopush.ts:53` no-exclusion `git add -A`) are unchanged since first found. No purge has ever been attempted. | This is the single longest-standing, actively-worsening item across both repos. The fix is small and has been specified identically for six review cycles running without being picked up — the blocker looks like it is *process* (nobody reads the unmerged review branches, see the meta-risk row below), not difficulty. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | Eighth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo` + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own state (still says live discovery "has never produced a job"), and the gap is widening: this review found genuine live-fill evidence (a real Paylocity session, 08-19) sitting undocumented in code comments while the phase docs still frame the whole project as "validation only, no new capability" despite five new ATS adapters and extension-first fill shipping since that framing was written. Seventh review in a row flagging the discovery-status line specifically. | An operator or future agent trusting these docs would materially misjudge both what's broken (discovery) and what's actually been proven live (generic-adapter fill against a real employer). The fix is doc edits, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. Whether `operator-guide.md` §17b's loop can self-merge its own gated PR under a "standing operator grant" is still unconfirmed either way from commit metadata. Realized submission risk stays bounded (no confirmed live employer submit yet). | Two open, deliberate product decisions bundled in one surface: whether unattended real-submission automation needs an additional standing-authorization gate, and whether the loop's PR-merge step is human-in-the-loop or self-authorizing. |
| **High** | jobright | Sender-trust magic-link handling remains a keyword-match-plus-ranking-boost qualifier with no hard sender-domain-affinity requirement; the browser still navigates to the top-scoring link using the operator's authenticated session. Unchanged since `a4f9cd8` (08-12); no commit since 08-19 touches `extractMagicLink`. | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | both | **Meta-risk, now explicit rather than inferred: the living document has been drafted eight times (08-07 through 08-23) and never once merged to `main`/`master` in either repo.** Each review has correctly found the Critical resume-PDF leak worsening and correctly specified the fix, and the fix has still not been applied across six cycles — the most parsimonious explanation is that nobody with merge authority is reading these branches, not that the finding is wrong or the fix is hard. | A review process that finds the same growing Critical risk six times running without triggering action has stopped functioning as an early-warning system and become a paper trail. Worth an explicit operator decision: either merge one of these review branches so the doc is discoverable at its canonical path, or change how these findings reach a human (e.g., a direct notification channel rather than a doc commit). |
| **Medium** | jobright | Lever, Ashby, Workday, and Workable are all wired but unverified against real DOM — no live-DOM progress on any of them since ~08-11, though the generic adapter did get real live-fill exercise this cycle (Paylocity, 08-19, see §1.2/§1.3). | The live-proof backlog for the four named adapters isn't shrinking; the honest `UNVERIFIED_SELECTOR` labeling is good discipline but doesn't reduce the backlog itself. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. This cycle's four-commit feature wave didn't touch this. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured `expected_country` still never used to reject homonym mismatches (re-verified directly this review). | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE` — an internal inconsistency, not a confirmed live submit. Unchanged since 08-13. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt (feedback *capture* shipped 08-10); global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **GitHub secret-scanning push protection**, with the same feasibility
  caveat noted last review: it's free and on by default for public repos
  (both qualify), but the **custom** pattern needed here
  (`materials/resume-<hash>\.pdf$`, not a built-in credential shape) is
  configured at the org/enterprise level in GitHub's UI, which may not map
  cleanly onto a personal-account public repo — worth the operator
  confirming reachability before counting on it. A `.gitleaks.toml` path
  rule in CI remains the complementary, definitely-available option.
  https://docs.github.com/en/code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns/defining-custom-patterns-for-secret-scanning
- **Human-oversight-by-design browser-agent patterns** (e.g. Asteroid,
  Straiker's runtime guardrails for agentic browsers) — carried over, still
  directly relevant to the unresolved `auto:cycle` posture question in §4.
- **CDP session-handoff discipline** — carried over, still relevant now that
  the console, the nav-layer sidecar, the local sandbox, `auto:cycle`, and
  the new extension-first fill path can all potentially want the same CDP
  Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the eighth review in a row. `git filter-repo` remains the
  right tool over BFG specifically because both leaks (this repo's
  `profiles/`, jobright's `materials/`) are path-scoped — BFG can't target
  by directory path, only by filename/glob.
- **GitHub push protection with a custom secret-scanning pattern** matching
  the scraped-profile JSON shape (name + LinkedIn URL + photo URL) — pairs
  with the history purge as a recurrence-prevention measure at push time;
  same organization/personal-account caveat noted above applies here too.
- **Krippendorff's alpha for judge-panel calibration, with concrete
  thresholds** — carried over, still unimplemented and still directly
  actionable: sample 100–300 traces, have 2–3 humans label them, compute
  Krippendorff's alpha (below 0.4 = rubric needs a rewrite, 0.4–0.6 = weak
  but tunable, above 0.6 = acceptable, above 0.8 = strong), paired with
  position-bias measurement (run each comparison twice with the candidate's
  material in each slot, flag verdicts that flip on order alone). More
  relevant than ever with six judges now in the panel and zero measured
  agreement or bias numbers for any of them.
- **Supabase Row-Level Security review before the dual-write lands** — this
  review found the Supabase scaffolding (§2.2) is currently correctly
  gated (deny-all RLS, server-only service-role key, throws until wired),
  but since it's explicitly future work: when the dual-write does land,
  the RLS policy design itself (not just the key handling) should get the
  same PII scrutiny this document already applies to the filesystem store —
  a hosted DB with a permissive policy would turn the *history-only* PII
  exposure this doc already flags into a live, queryable one.

---

## Changelog

- **2026-08-23** — Eighth review (this one). Baselined against the unmerged
  2026-08-19 draft (`claude/epic-pasteur-purjf5` / `claude/busy-clarke-purjf5`)
  per the session-start-ritual instruction, then independently re-verified
  every carried-forward claim against current `HEAD` in both repos rather
  than trusting the draft's prose. **Resume-PDF leak (jobright) confirmed
  worse for the sixth review running**: 396 paths now (366 on 08-19), traced
  to two commits (one manual, one feature-dev) since 08-19; both root-cause
  code locations still unchanged. **tSearch's PII-history exposure
  re-verified unpurged for the eighth review in a row** (direct `git
  cat-file` read of the same still-reachable blob). `docs/current-state-and-
  phase56.md` still wrong, seventh review flagging it — and this review
  found the gap is actively widening: genuine live-fill evidence (a Paylocity
  session, 08-19) sits undocumented while the phase docs still claim
  "validation only." tSearch saw a **real four-commit feature wave** since
  08-19 (Discover UI restore, youth wildcards + honest digest scoring,
  scoring-weight tuning, and a "marks" watchlist feature plus correctly-gated
  Supabase scaffolding) — diffed all four directly; none touch the
  safety-flag layer, the frozen-snapshot invariant, or PII handling in a way
  that weakens existing protections. jobright saw the design-system overhaul
  land (#64) and, more substantively, "extension-first dual-agent fill"
  (#63, X0–X6) — reviewed the safety framing directly: fail-closed extension
  presence detection, an empty selector registry until operator-promoted,
  and `assertExecutableApprovedEntry` still guarding every native write.
  Verify gates this review, all re-run directly rather than assumed: tSearch
  359/359 tests passing (up from 222), typecheck clean; jobright typecheck
  clean, `check:forbidden`/`check:secrets` both `ok`, 943/1163 tests passing
  with the remaining 212 traced to the same missing-browser-binary
  environment gap seen in every review since 08-15. Both repos: zero open
  issues, zero open PRs. **New this review**: made the eight-cycles-unmerged
  pattern an explicit Medium risk in §4 rather than a closing-changelog
  observation, since six of those cycles have now re-found the same growing
  Critical leak without triggering a fix. Pushed to this session's assigned
  branches (`claude/busy-clarke-lqqsk6` jobright, `claude/epic-pasteur-lqqsk6`
  tSearch) — a ninth unmerged copy unless a human merges one of these
  branches deliberately.
- **2026-08-19** — Seventh review (drafted on `claude/epic-pasteur-purjf5` /
  `claude/busy-clarke-purjf5`, never merged; used as this review's baseline).
  Resume-PDF leak confirmed worse for the fifth review running (327→366),
  traced to a manual commit rather than autopush. Found first-party evidence
  (commit `eb4a999`'s own message) that the local pre-commit hook wasn't
  reliably firing on the machine responsible for the leak. tSearch's
  PII-history exposure re-verified unpurged for the seventh review in a row;
  tSearch saw its first code change in six cycles (PR #6, diffed clean of
  the safety-flag layer and PII-history concerns).
- **2026-08-17** — Sixth review (drafted on `claude/epic-pasteur-kr7842`,
  never merged). Resume-PDF leak confirmed worse for the fourth review
  running (308→327), traced to three specific commits; both root-cause code
  locations re-verified unchanged. tSearch's PII-history exposure re-verified
  unpurged for the sixth review in a row. Zero commits landed anywhere in
  tSearch since 08-15. jobright saw a real feature wave (PRs #49–#54).
- **2026-08-15** — Fifth review (drafted on `claude/epic-pasteur-kz1f9y`,
  never merged). Resume-PDF leak confirmed worse for the third review running
  (308 unique files now, 187 on 08-13, 183 on 08-11). tSearch's PII-history
  exposure re-verified unpurged for the fifth review in a row. Zero commits
  landed anywhere in tSearch since 08-13.
- **2026-08-13** — Fourth review (drafted on `claude/epic-pasteur-559fdc`,
  never merged). Found the Critical resume-PDF leak escalated rather than
  fixed (183→187 files) and found a second, independent cause: the
  secret-scanner's regex doesn't match the actual leaked filenames even when
  the hook runs. tSearch: PII-history exposure re-confirmed unchanged.
- **2026-08-11** — Third review (drafted on `claude/epic-pasteur-by0hjn`,
  never merged). tSearch: verified two previously-flagged risks genuinely
  resolved (ownership-share bug, mid-run auth guard); verified the
  PII-history risk unchanged; found one new low-severity risk (auto-assess on
  by default). jobright: found the discovery-status doc question had flipped
  from "ambiguous" to "actively contradicted"; found L3 still not graduated
  past `FIXTURE_CONFIRMED`; found two new High risks (`auto:cycle`
  unattended-scheduling posture, sender-trust magic-link loosening).
  **Mid-review, discovered a second Critical finding**: jobright's
  `art:`-autopush automation had been committing the operator's real resume
  PDFs to this public repo since 2026-08-08 (183 copies, 11 commits, missed
  by all three prior reviews) — the pre-commit hook was never installed.
- **2026-08-09** — Second review (drafted on `claude/epic-pasteur-27u1xf` /
  `claude/busy-clarke-27u1xf`, never merged). tSearch: zero commits since
  2026-08-07 beyond the vision-doc merge itself. jobright: large feature wave
  landed (Lever/Ashby wiring, navigation layer, operator console, L3 armed
  automation, screener answer-bank, essay draft assistant, telemetry export,
  branding/site). Surfaced the discovery-status doc disagreement (since
  escalated).
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs). Verified the critical PII/public-repo finding
  directly (`git ls-files`, file content, repo visibility) rather than
  relying solely on subagent report.
