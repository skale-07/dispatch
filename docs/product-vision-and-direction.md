# Product vision & technical direction — Dispatch + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both*
repos together (shared lineage, shared operator, shared data-handling
posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-08-25 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting "Last reviewed" above.**
This is the **ninth** review. Every prior review (08-09 through 08-23) was
drafted on an unmerged `claude/*-*` branch and **never landed on
`main`/`master` in either repo** — the copy actually merged to both default
branches is still the original 2026-08-07 version. Per the session-start-
ritual instruction (tSearch `CLAUDE.md`) to check unmerged
`claude/epic-pasteur*`/`claude/busy-clarke*` branches for a fresher copy,
this review found and baselined on the 2026-08-23 draft
(`claude/epic-pasteur-lqqsk6` / `claude/busy-clarke-lqqsk6`, the eighth
review), then independently re-verified every carried-forward claim against
current `HEAD` in both repos — re-ran the verify gates directly rather than
trusting the draft's prose (see §1.2/§2.2). This review is pushed to *this
session's* designated branches (`claude/busy-clarke-84e9yy` jobright,
`claude/epic-pasteur-84e9yy` tSearch) — a **tenth** unmerged copy. See §4's
standing meta-risk: the living document has now been drafted nine times
without a single version ever reaching `main`/`master`, and this review
sends a direct notification to the operator for the first time rather than
relying solely on the doc commit, per the meta-risk row's own recommendation.

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
inside a timed, capped, operator-initiated window. A fourth architectural
idea landed 08-20 (PR #63): **extension-first dual-agent fill** — JobRight's
own browser extension (external, deterministic, non-LLM) becomes the primary
filler on supported pages, with Dispatch's native fill as gap-fill and the
same approved-plan + read-back verification gates still covering every write
either path makes.

**This review's central finding, again: the Critical resume-PDF exposure
first flagged 08-11 is now on its seventh consecutive review cycle without a
fix.** The count itself did not move this cycle (396, unchanged from
08-23) — but that is because **zero commits landed in this repo at all
between the 08-23 and 08-25 reviews** (`HEAD` is still `8018fde`), not
because the leak was addressed. Both root-cause code locations remain
unchanged at the same line numbers reported for six reviews running.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) — three gated LLM call sites / Express + React console frontend.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture — 21 fail-closed flags, unchanged since 08-23.** All default `false` in `.env.example`/`src/config/env.ts` except `CDP_AUTOLAUNCH_ENABLED` (a debug-Chrome convenience default, still confined to the dedicated `jobright-cdp` profile dir via `assertDebugProfileDir`, not a mutation gate). `chromium.launch` remains confined to three session-infra files.
- **Verify gate this review, re-run directly on current `HEAD` (`8018fde` — unchanged since 08-21/08-23, confirmed via `git rev-parse HEAD`), not assumed:** `npm run typecheck` clean. `npm run check:forbidden` and `npm run check:secrets` both `ok`. `npm run test`: **943 passed / 212 failed / 8 skipped across 1163 tests in 123 files — identical to 08-23**, because `HEAD` did not move. Every failure traces to the same single cause as every review since 08-15: `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path. Not evidence of a code regression.
- **ATS coverage — unchanged since 08-23:** Registry (`src/ats/registry.ts:19`): `unsupported, greenhouse, lever, ashby, workable, workday, generic`. Greenhouse: `FIXTURE_CONFIRMED`, live CAPTCHA/redirect fixes still not retested live. Lever/Ashby/Workable: `FIXTURE_CONFIRMED` on synthetic fixtures only, no live run performed. Workday: `UNVERIFIED_SELECTOR` until first live capture. The 08-19 generic-adapter live-fill evidence against a real Paylocity posting (code comments in `src/ats/generic/v1.ts` etc.) remains undocumented in `current-state-and-phase56.md`/`validation-levels.md`.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: seventh review running, still unresolved.** Re-verified
  directly against current `HEAD` (`8018fde`, unchanged since 08-21): **396
  `artifacts/applications/*/materials/resume-*.pdf` paths** still reachable
  — identical count to 08-23, because no commits landed in this repo over
  the past two days. Both root causes remain unchanged: `src/security/artifactScan.ts:26`'s
  pattern is still `/resume\.pdf$/i`, which does not match `resume-<hash>.pdf`
  filenames; `src/automation/artifactAutopush.ts:53` still runs a blanket
  `git("add", "-A", "--", "artifacts")` with no `materials/` exclusion. No
  purge has ever been attempted against this leak.
- **New this review — a third contributing mechanism, found by direct
  reproduction, not just code reading:** running `npm run test` in this
  sandbox generated **29 new `resume-*.pdf`-shaped files** and 32 new
  `artifacts/applications/*/` directories in the *tracked* `artifacts/` tree
  as a side effect of fixture-based ATS tests (`chrome-headless-shell`
  missing meant most of these tests failed, but the fixture harness writes
  its artifacts to disk before the browser launch fails). These were
  untracked working-tree files this review discarded (`git checkout --
  artifacts/ && git clean -fd artifacts/`) rather than committing — but it
  means **any contributor or CI job that runs the test suite against a
  checkout with `artifacts/` unignored is a fourth path to this leak**,
  independent of `ARTIFACT_AUTOPUSH_ENABLED` and independent of a manual
  `git add`. This sharpens the fix: the missing piece isn't just the
  autopush exclusion, it's that `artifacts/applications/` (or at minimum
  `**/materials/`) isn't gitignored at all, so test output and real
  application runs land in the same tracked tree by construction.
- **`docs/current-state-and-phase56.md` is still wrong** — line 179 still
  reads "The live discovery path has never produced a job," still
  contradicted by both auto-cycle artifacts and the 08-19 Paylocity live-fill
  evidence. Unchanged since 08-23 (no commits touched it).
- **Declared phase vs. reality:** `docs/operator-guide.md` and the stale
  phase docs still frame the project as "Phase 5.6 — live validation only,"
  though five ATS adapters, extension-first fill, essay autofill, Gmail
  drafts, and a full console redesign have shipped since that framing was
  written. Unchanged since 08-23.
- **L3 armed unattended apply, `auto:cycle` unattended posture, and
  sender-trust magic-link handling: all unchanged since 08-23** — no commits
  touched any of the relevant files (`extractMagicLink`, the L3 gating code,
  `operator-guide.md` §17b) in the two days since the last review.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  silent multi-ATS expansion beyond what's now wired, replacing any
  deterministic adapter with an LLM agent as the default path, loosening L3's
  numeric caps.
- **Next up, in priority order — unchanged from 08-23 because none of it has
  been picked up across three review cycles now:** (1) fix
  `src/security/artifactScan.ts:26`'s regex to match `resume-*.pdf`, add a
  `materials/` exclusion to `artifactAutopush.ts:53`, confirm
  `npm run hooks:install` actually runs on the machine that
  autopushes/tunes, then purge the 396-path leak from history — still the
  single most overdue action item across both repos, now seven review cycles
  running without being picked up; (2) fix `current-state-and-phase56.md`
  and refresh the phase framing; (3) resolve the `submits_used: 1`/`per_app`
  inconsistency; (4) live-DOM proof for Lever, Ashby, Workday, Workable;
  (5) a decision on tightening sender-trust domain affinity; (6) promote the
  08-19 Paylocity live-fill session to a documented validation level.

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
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email`, plus a GitHub-first "footprint sweep" and an autopilot chain (sweep → resolve → discovery → assessment → digest → send, fail-closed to mock/dry-run by default).
- **One new commit since 08-23** (`a52881b`, 08-24, "Isolate youth wildcards on Score and stop dropping seed-tree neighbors below the top-80 cut" — 40 files, +2086/-314). Reviewed the diff directly rather than trusting the commit message: it (1) reworks youth-wildcard tracking into an explicit freeze/pin/alumni model (`src/assessment/youthWildcard.ts`, new `resolveYouthWildcardFreeze`/`ingestYouthWildcardAlumni`/`setYouthWildcardPinned`) with a new `POST /api/assessment/youth-wildcard/pin` operator endpoint; (2) adds `src/storage/includeOnTree.ts`, a hop-graph bot/spam-login filter (hardcoded excluded logins plus a bot-name-pattern regex) that was previously dropping legitimate seed-tree neighbors below the top-80 score cutoff; (3) touches `profileStore.ts`/`fetchWebsiteHtml.ts`/`extractPagePeople.ts` for website-graph scoring, not PII handling. None of it touches `.gitignore`, the `profiles/`/`backup/` exclusion, LinkedIn scrape pacing, or the digest send-gating path — no new PII or safety-flag exposure introduced.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen candidates snapshot — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by experience-distinctiveness, recruiter-label/tier, and age-relative-impressiveness + obscurity-multiplier judges. Six judges now carry no measured inter-rater agreement or position-bias number (see §5).
- **Safety-flag layer — still unchanged.** `CLAUDE.md` documents fail-closed boundaries in prose; still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. `a52881b` didn't touch this.
- **Verify gate this review, re-run directly on current `HEAD` (`a52881b`):** `npm run typecheck` clean. `npm run test`: **396/396 passing across 62 files** (up from 359/359 on 08-23, tracking `a52881b`'s new tests). Repo is not currently broken. Digest send-gating and LinkedIn pacing unchanged.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — ninth
  review in a row confirming it.** Re-verified directly again this review:
  `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves,
  and `git log --all` still contains no `filter-repo`/BFG-style purge
  commit. Current tree stays clean (`.gitignore` covers `profiles/`,
  `backup/`, `data/`, `cache/`, `output/`, unchanged this review), which
  bounds new exposure but does nothing for what's already public in history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding**,
  unchanged since 08-10/08-11.
- **Everything else carries forward unchanged**, since `a52881b` was
  scoring/tree-filtering work, not the digest ranking-refinement loop,
  LinkedIn scrape-failure handling, or auto-assess default: zero
  retry/trace/screenshot capture on LinkedIn scrape failures; captured
  `expected_country` still only a matching-boost hint, never a hard
  homonym-rejection filter; digest ranking-*refinement*-from-feedback still
  unbuilt; global-vs-per-seed and Substack-only-filtering product questions
  remain unresolved; auto-assess still runs by default (`AUTO_ASSESS=0` to
  opt out).
- Zero open issues, zero open PRs at time of this review (both repos,
  re-checked directly via the GitHub API).

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md` ·
`docs/system-brief.md` (generated, Tier 0 oracle context)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(this repo) records the original reuse plan: tSearch's
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
history only (current tree is clean, count is stable — no new commits touch
`profiles/`/`backup/`); jobright's is the operator's own resume PDFs — not
growing this specific cycle only because no commits landed at all, not
because the automation stopped being capable of adding more. That keeps
jobright's the more urgent of the two: the fix has been fully specified — a
one-line regex, a one-line path exclusion, a hook-install check, then a
history purge — for seven review cycles without being applied.

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
| **Critical** | jobright | **Seventh consecutive review finding this unfixed, and this review found a fourth contributing path by direct reproduction:** `ARTIFACT_AUTOPUSH_ENABLED` plus manual operator commits have pushed the operator's real resume PDFs to this public repo since 2026-08-08 (396 leaked `materials/resume-*.pdf` paths, unchanged this cycle only because zero commits landed in two days) — and simply running `npm run test` in a checkout with `artifacts/` untracked-but-not-gitignored writes 29 more resume-PDF-shaped files straight into the tracked tree, no autopush or manual commit required. Both original root-cause code locations (`artifactScan.ts:26` regex, `artifactAutopush.ts:53` no-exclusion `git add -A`) are unchanged since first found 08-11. No purge has ever been attempted. | This is the single longest-standing, actively-worsening (whenever the repo is active) item across both repos, and it now has a fourth reproduction path (any test run) beyond the three already documented (autopush, manual commit, feature-dev commit). The real missing fix is a `.gitignore` entry for `artifacts/applications/**/materials/`, not just an autopush exclusion — that closes all four paths at once. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | Ninth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo` + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own state (still says live discovery "has never produced a job") while genuine live-fill evidence (a real Paylocity session, 08-19) sits undocumented in code comments. Eighth review in a row flagging the discovery-status line specifically. | An operator or future agent trusting these docs would materially misjudge both what's broken (discovery) and what's actually been proven live. The fix is doc edits, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. Whether `operator-guide.md` §17b's loop can self-merge its own gated PR under a "standing operator grant" is still unconfirmed either way from commit metadata. | Two open, deliberate product decisions bundled in one surface: whether unattended real-submission automation needs an additional standing-authorization gate, and whether the loop's PR-merge step is human-in-the-loop or self-authorizing. |
| **High** | jobright | Sender-trust magic-link handling remains a keyword-match-plus-ranking-boost qualifier with no hard sender-domain-affinity requirement; the browser still navigates to the top-scoring link using the operator's authenticated session. Unchanged since `a4f9cd8` (08-12). | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | both | **Meta-risk, now acted on rather than just noted: the living document has been drafted nine times (08-07 through 08-25) and never once merged to `main`/`master` in either repo.** Six of those cycles correctly found the Critical resume-PDF leak worsening and correctly specified the fix, without triggering action. This review, for the first time, sends a direct notification to the operator alongside the doc commit rather than relying solely on an unmerged branch being discovered. | A review process that finds the same growing Critical risk repeatedly without triggering action has stopped functioning as an early-warning system. If this notification also goes unactioned, the next step should be an operator decision to merge one of these branches so the doc is discoverable at its canonical path. |
| **Medium** | jobright | Lever, Ashby, Workday, and Workable are all wired but unverified against real DOM — no live-DOM progress on any of them since ~08-11. | The live-proof backlog for the four named adapters isn't shrinking. |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. Unchanged since 08-11; `a52881b` didn't touch this. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured `expected_country` still never used to reject homonym mismatches. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE`. Unchanged since 08-13. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Lefthook** (`evilmartians/lefthook`) — a new, more directly targeted
  recommendation than last review's generic "GitHub secret-scanning push
  protection" suggestion: this repo's own commit history already contains
  first-party evidence (`eb4a999`, 08-17) that the local pre-commit hook
  isn't reliably firing on the machine responsible for the resume-PDF leak.
  Lefthook is a single-YAML-config, multi-language hook manager whose hooks
  install automatically (unlike a bare `.git/hooks` script, and unlike
  Husky's npm-`prepare`-script dependency, which silently no-ops if
  `npm ci --omit=dev` or a CI-only install path skips dev-dependency hooks).
  Directly relevant to the seven-cycle-unfixed leak: the code fix
  (regex + exclusion) and the process fix (a hook that can't be silently
  skipped) are separate problems, and only the first has a proposed patch
  in this document so far.
  https://github.com/evilmartians/lefthook
- **GitHub secret-scanning push protection with a custom pattern** — carried
  over from last review, same feasibility caveat (custom patterns are
  configured at org/enterprise level, may not map onto a personal-account
  public repo).
- **Human-oversight-by-design browser-agent patterns** and **CDP
  session-handoff discipline** — carried over, still relevant to the
  unresolved `auto:cycle` posture question and the growing number of
  surfaces (console, nav-layer sidecar, sandbox, `auto:cycle`,
  extension-first fill) that can want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for the ninth review in a row.
- **AutoRubric** — last review cited the arXiv paper; it now has a live
  reference implementation at `autorubric.org` (ensemble judging, bias
  mitigation, Cohen's-kappa/Krippendorff's-alpha agreement metrics built
  in), making this a tool to actually adopt rather than a paper to adapt
  ideas from. Directly applicable with six judges now in the panel and zero
  measured agreement or position-bias numbers for any of them: sample
  100–300 traces, have 2–3 humans label them, compute agreement (below 0.4 =
  rubric needs a rewrite, 0.4–0.6 = weak but tunable, above 0.6 = acceptable,
  above 0.8 = strong), paired with position-bias measurement (run each
  comparison twice with the candidate's material in each slot, flag verdicts
  that flip on order alone).
  https://autorubric.org/
- **Supabase Row-Level Security review before the dual-write lands** —
  carried over; the scaffolding introduced 08-24 in `96dd18b` (unchanged by
  `a52881b`) remains correctly gated (deny-all RLS, server-only service-role
  key, throws until wired) — worth the same PII scrutiny once the dual-write
  actually lands.

---

## Changelog

- **2026-08-25** — Ninth review (this one). Baselined against the unmerged
  2026-08-23 draft (`claude/epic-pasteur-lqqsk6` / `claude/busy-clarke-lqqsk6`)
  per the session-start-ritual instruction, then independently re-verified
  every carried-forward claim against current `HEAD` in both repos.
  **jobright: zero commits since 08-21/08-23 — `HEAD` unchanged at
  `8018fde`.** Re-ran the full verify gate directly rather than assuming it
  still holds: typecheck clean, `check:forbidden`/`check:secrets` both `ok`,
  943/1163 tests passing with the same 212 failures traced to the same
  missing-browser-binary environment gap. Resume-PDF leak re-verified at 396
  paths (unchanged, because nothing moved) — **seventh review in a row**
  finding it unfixed. **tSearch: one new commit** (`a52881b`, 08-24) —
  diffed it directly; it reworks youth-wildcard tracking into a freeze/pin/
  alumni model and adds a hop-graph bot-login filter, touches no PII/gitignore/
  safety-flag paths. Re-ran the verify gate directly: typecheck clean,
  396/396 tests passing (up from 359). PII-history exposure re-verified
  unpurged for the **ninth review in a row** (direct `git cat-file` read of
  the same still-reachable blob; `git log --all` still has no purge commit).
  Both repos: zero open issues, zero open PRs (re-checked via GitHub API).
  **New this review:** sent a direct operator notification alongside this
  doc commit, per the meta-risk row's own standing recommendation that a doc
  commit alone hasn't been triggering action across six prior cycles of the
  same Critical finding. Found one new, more targeted amendment (Lefthook,
  replacing the generic secret-scanning suggestion) directly addressing the
  first-party evidence that jobright's pre-commit hook isn't reliably
  firing. Pushed to this session's assigned branches
  (`claude/busy-clarke-84e9yy` jobright, `claude/epic-pasteur-84e9yy`
  tSearch) — a tenth unmerged copy unless a human merges one of these
  branches deliberately.
- **2026-08-23** — Eighth review (drafted on `claude/epic-pasteur-lqqsk6` /
  `claude/busy-clarke-lqqsk6`, never merged; used as this review's baseline).
  Resume-PDF leak confirmed worse for the sixth review running (366→396),
  traced to two commits since 08-19. `current-state-and-phase56.md` found
  actively widening its gap from reality (undocumented Paylocity live-fill
  evidence). tSearch saw a real four-commit feature wave (Discover UI
  restore, youth wildcards, scoring tuning, marks watchlist + gated Supabase
  scaffolding). Made the eight-cycles-unmerged pattern an explicit Medium
  risk rather than a closing observation.
- **2026-08-19** — Seventh review (drafted on `claude/epic-pasteur-purjf5` /
  `claude/busy-clarke-purjf5`, never merged). Resume-PDF leak confirmed worse
  for the fifth review running (327→366), traced to a manual commit rather
  than autopush. Found first-party evidence the local pre-commit hook wasn't
  reliably firing. tSearch's PII-history exposure re-verified unpurged for
  the seventh review in a row.
- **2026-08-17** — Sixth review (drafted on `claude/epic-pasteur-kr7842`,
  never merged). Resume-PDF leak confirmed worse for the fourth review
  running (308→327). tSearch's PII-history exposure re-verified unpurged for
  the sixth review in a row. Zero commits landed anywhere in tSearch since
  08-15. jobright saw a real feature wave (PRs #49–#54).
- **2026-08-15** — Fifth review (drafted on `claude/epic-pasteur-kz1f9y`,
  never merged). Resume-PDF leak confirmed worse for the third review running
  (308 unique files now, 187 on 08-13, 183 on 08-11). tSearch's PII-history
  exposure re-verified unpurged for the fifth review in a row.
- **2026-08-13** — Fourth review (drafted on `claude/epic-pasteur-559fdc`,
  never merged). Found the Critical resume-PDF leak escalated rather than
  fixed (183→187 files) and found a second, independent cause: the
  secret-scanner's regex doesn't match the actual leaked filenames even when
  the hook runs.
- **2026-08-11** — Third review (drafted on `claude/epic-pasteur-by0hjn`,
  never merged). tSearch: verified two previously-flagged risks genuinely
  resolved (ownership-share bug, mid-run auth guard). **Mid-review,
  discovered a second Critical finding**: jobright's `art:`-autopush
  automation had been committing the operator's real resume PDFs to this
  public repo since 2026-08-08 (183 copies, 11 commits, missed by all three
  prior reviews) — the pre-commit hook was never installed.
- **2026-08-09** — Second review (drafted on `claude/epic-pasteur-27u1xf` /
  `claude/busy-clarke-27u1xf`, never merged). jobright: large feature wave
  landed (Lever/Ashby wiring, navigation layer, operator console, L3 armed
  automation, screener answer-bank, essay draft assistant, telemetry export,
  branding/site). Surfaced the discovery-status doc disagreement (since
  escalated).
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly (`git ls-files`, file content, repo
  visibility) rather than relying solely on subagent report.
