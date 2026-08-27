# Product vision & technical direction — Dispatch + tSearch

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
| Last reviewed | 2026-08-27 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting "Last reviewed" above.**
This review is at least the **tenth** attempt at this document since
2026-08-07, and every prior attempt is still unmerged: `git merge-base
--is-ancestor <commit> origin/main` (tSearch) and the equivalent on
jobright's `master` were run directly against every review commit reachable
from `git log --all -- docs/product-vision-and-direction.md`, and **none of
them are ancestors of the default branch** — including the 2026-08-21 review
(`claude/epic-pasteur-6eyjpj`), whose own text claimed to be "the first
review to land on `main`/`master` since 2026-08-07." That claim was checked,
not assumed, and is false: commit `15c2359` is only reachable from
`origin/claude/epic-pasteur-6eyjpj`, not `origin/main`. The 2026-08-25 review
made a similar self-referential claim (that it was sending "the first"
operator notification) that this session has no way to verify happened.
**The pattern across this document's own history is not just "the fix
doesn't land" — it's that the review process has repeatedly and confidently
misreported its own status**, which is part of why this review sends a
direct notification rather than relying on the doc commit alone (see §4's
meta-risk row). This review is pushed to *this session's* designated
branches (`claude/busy-clarke-27e9vi` jobright, `claude/epic-pasteur-27e9vi`
tSearch) — almost certainly an eleventh unmerged copy unless a human merges
one of these branches deliberately.

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
inside a timed, capped, operator-initiated window.

**A large feature wave landed since the last review** (PRs #65–#69, 17
commits, 933ee71 now `HEAD`, up from `8018fde`), extending the
determinism-first architecture into three new directions rather than
loosening it:

- **D1a+D2 — ATS board discovery** (`src/discovery/atsBoards.ts`,
  `atsDiscovery.ts`, flag `ATS_DISCOVERY_ENABLED`, default `false`, present
  in `.env.example`): pulls postings directly from Greenhouse/Lever/Ashby/
  Workable's own public unauthenticated board APIs instead of scraping,
  re-validates each apply URL against the declaring ATS before queuing.
- **G1–G3 — schema-vs-DOM completeness**: the board API's own declared
  question sets and `required` flags become a third source (alongside DOM
  attributes and ARIA) for the pre-submit completeness gate, plus a
  `SchemaDiff` (api_only/dom_only/option_mismatches) surfaced on the fill
  report's Evidence card. Read-only enrichment of the existing gated fill
  path — no new mutation capability, so no new flag needed.
- **S1 — Stagehand navigate engine** (`src/agent/engine.ts`, flag
  `AGENT_ENGINE`, gated at the "does anything run at all" layer by the
  pre-existing `AGENT_FALLBACK_ENABLED`): a second, TypeScript-native
  navigate sidecar (`@browserbasehq/stagehand`) alongside the incumbent
  Python `browser_use` sidecar, kept in its own `agent/stagehand/`
  `package.json` to preserve the repo's "three sidecar dependencies, no
  more" stance. `docs/agent-engine-decision.md` pre-registers the promotion
  bar (must strictly beat `browser_use`, zero safety events) before it can
  become default — a genuinely good pattern (see §5).
- **C1/C2 — operator handoff and CAPTCHA ergonomics**: a values-free
  copy-paste brief for AUTH_REQUIRED/UNSUPPORTED_ATS/MANUAL walls
  (deliberately excludes CAPTCHA_REQUIRED, so no agent is ever pointed at a
  challenge), and a bounded (≤90s) attended in-place pause so a headed
  operator can solve a CAPTCHA without a full requeue. Headless/unattended
  runs are unchanged. Neither adds a flag — the "never automate CAPTCHA
  solving" stance is preserved as a hard invariant, not a gated capability.
- **U1–U5 — console redesign**: Motion behind one seam, Tailwind v4 +
  shadcn bridged in for vendored chart/command-bar components (stock
  Tailwind palette wiped, all color forced through `tokens.css`), an
  Insights page rendering aggregate-only operational charts (fill runs,
  pipeline states, discovery sources, CAPTCHA incidents — never candidate
  answers), and a `/`-triggered command bar for real navigation. `DESIGN.md`
  got a truth-pass documenting all of it. UI-only, no mutation capability.

None of these five items touch `src/security/artifactScan.ts`,
`src/automation/artifactAutopush.ts`, or `.gitignore` — confirmed via
`git diff --stat` across the full PR #65–#69 range, not assumed. That
matters for the next finding.

**This review's central finding, unchanged in substance across seven
consecutive cycles: the Critical resume-PDF exposure first flagged 08-11 is
still unfixed.** Re-verified directly against current `HEAD` (`933ee71`),
not against the stale unmerged draft: **481 distinct
`artifacts/applications/*/materials/resume-*.pdf` paths** are tracked on
`master` right now (up from the 396 the last review reported at `HEAD`
`8018fde`) — but those paths resolve to only **4 unique resume-file
contents** by basename, so this is ~477 redundant copies of 4 real files,
each copy naming a real application UUID. The growth between reviews came
from ordinary autopush/manual-commit activity over the past two days, not
from the new feature wave — confirmed the wave's own diff never touches the
three relevant files. Both root-cause code locations are unchanged at the
same lines reported for seven reviews running.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) — three gated LLM call sites / Express + React console frontend / a second Node sidecar (`agent/stagehand/`) alongside the existing Python `browser_use` sidecar.
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`) exportable via `npm run training:export`. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture — flag roster grew by one this review** (`ATS_DISCOVERY_ENABLED`, default `false`), all still default `false` in `.env.example`/`src/config/env.ts` except `CDP_AUTOLAUNCH_ENABLED` (a debug-Chrome convenience default, still confined to the dedicated `jobright-cdp` profile dir via `assertDebugProfileDir`, not a mutation gate). `AGENT_ENGINE` is a plain setting (which sidecar to use), not itself a capability gate — whether any agent runs at all is still `AGENT_FALLBACK_ENABLED`. `chromium.launch` remains confined to three session-infra files.
- **Verify gate this review, re-run directly on current `HEAD` (`933ee71`), not assumed:** `npm run typecheck` clean. `npm run check:forbidden` and `npm run check:secrets` both `ok`. `npm run test`: **993 passed / 220 failed / 8 skipped across 1221 tests in 130 files** (up from 943/1163 at the last review, tracking the new feature wave's added tests). Every failure traces to the same single cause as every review since 08-15 — `chrome-headless-shell` isn't installed at this sandbox's Playwright browser path (confirmed by reading the failure output directly: `browserType.launch: Executable doesn't exist at .../chrome-headless-shell-linux64/...`). Not evidence of a code regression.
- **ATS coverage — unchanged since 08-23:** Registry (`src/ats/registry.ts:19`): `unsupported, greenhouse, lever, ashby, workable, workday, generic`. Greenhouse: `FIXTURE_CONFIRMED`, live CAPTCHA/redirect fixes still not retested live. Lever/Ashby/Workable: `FIXTURE_CONFIRMED` on synthetic fixtures only, no live run performed. Workday: `UNVERIFIED_SELECTOR` until first live capture. The 08-19 generic-adapter live-fill evidence against a real Paylocity posting (code comments in `src/ats/generic/v1.ts` etc.) remains undocumented in `current-state-and-phase56.md`/`validation-levels.md`.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **Resume-PDF leak: seventh review running, still unresolved, count corrected upward this review.** Re-verified directly against current `HEAD` (`933ee71`): **481 tracked paths / 4 unique file contents**, both root causes unchanged: `src/security/artifactScan.ts:26`'s pattern is still `/resume\.pdf$/i`, which does not match `resume-<hash>.pdf` filenames (verified against the regex directly — `"resume-aeb31421.pdf"` does not end in the literal substring `"resume.pdf"`); `src/automation/artifactAutopush.ts:53` still runs a blanket `git("add", "-A", "--", "artifacts")` with no `materials/` exclusion; `.gitignore` still has `artifacts/` commented out rather than excluding `artifacts/applications/**/materials/`. No purge has ever been attempted against this leak.
- **A fourth contributing mechanism, found by direct reproduction two reviews ago, still not closed by anything in this wave:** running `npm run test` in a checkout with `artifacts/` untracked-but-not-gitignored writes fixture-harness output straight into the tracked tree — independent of `ARTIFACT_AUTOPUSH_ENABLED` and independent of a manual `git add`. The missing piece is still that `artifacts/applications/` (or at minimum `**/materials/`) isn't gitignored at all, which is the single change that would close all four known paths (autopush, manual commit, feature-dev commit, test-run side effect) at once.
- **`docs/current-state-and-phase56.md` is still wrong** — line 179 still reads "The live discovery path has never produced a job," still contradicted by both auto-cycle artifacts and the 08-19 Paylocity live-fill evidence. Unchanged.
- **Declared phase vs. reality:** `docs/operator-guide.md` and the stale phase docs still frame the project as "Phase 5.6 — live validation only," though five ATS adapters, extension-first fill, essay autofill, Gmail drafts, a full console redesign, ATS board discovery, and a second agent engine have shipped since that framing was written.
- **L3 armed unattended apply, `auto:cycle` unattended posture, and sender-trust magic-link handling: unchanged** — no commits touched the relevant files (`extractMagicLink`, the L3 gating code, `operator-guide.md` §17b) in this wave.
- **Deliberately not in scope:** Outlook send (permanently out of scope), silent multi-ATS expansion beyond what's now wired, replacing any deterministic adapter with an LLM agent as the default path (the Stagehand promotion bar in `agent-engine-decision.md` is the right shape for this — see §5), loosening L3's numeric caps.
- **Next up, in priority order — the resume-PDF fix is now the single most overdue action item across both repos, eight review cycles running without being picked up:** (1) gitignore `artifacts/applications/**/materials/` (closes all four leak paths at once), fix `src/security/artifactScan.ts:26`'s regex to match `resume-*.pdf`, add a `materials/` exclusion to `artifactAutopush.ts:53` as defense-in-depth, confirm `npm run hooks:install` actually runs on the machine that autopushes, then purge the 481-path leak from history (`git filter-repo` — see §5); (2) fix `current-state-and-phase56.md` and refresh the phase framing; (3) resolve the `submits_used: 1`/`per_app` inconsistency; (4) live-DOM proof for Lever, Ashby, Workday, Workable; (5) a decision on tightening sender-trust domain affinity; (6) promote the 08-19 Paylocity live-fill session to a documented validation level; (7) let the Stagehand-vs-`browser_use` comparison in `agent-engine-decision.md` actually run and report before treating S1 as more than an experiment.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/current-state-and-phase56.md) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/operator-guide.md) ·
[`docs/agent-engine-decision.md`](https://github.com/skale-07/jobright-application-agent/blob/main/docs/agent-engine-decision.md) ·
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
- **No new commits since the last review** — `HEAD` is still `a52881b` (08-24, "Isolate youth wildcards on Score and stop dropping seed-tree neighbors below the top-80 cut"). Re-confirmed present and wired directly this review: `src/assessment/youthWildcard.ts` implements a frozen, salted (`youth-wildcard-v1`) 17–19 age-band draw capped at 5, with a `POST /api/assessment/youth-wildcard/pin` operator override; `src/storage/includeOnTree.ts` filters bot logins from hop-graph visibility while keeping `website`/`collaborator` edges always visible and gating `follower`-type nodes on a minimum context score.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen candidates snapshot — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass, joined by experience-distinctiveness, recruiter-label/tier, and age-relative-impressiveness + obscurity-multiplier judges. Six judges still carry no measured inter-rater agreement or position-bias number (see §5).
- **Supabase scaffold (landed 08-24 in `96dd18b`, unchanged by `a52881b`), re-verified fail-closed:** `src/storage/supabase/client.ts` returns `null` when URL/key env vars are unset; `src/storage/supabase/storeMode.ts`'s `assertTsearchStoreImplemented` throws whenever `TSEARCH_STORE === "supabase"`, so it's inert until deliberately wired; `supabase/migrations/0001_init.sql` defines the future schema with RLS enabled and deny-all policies on every table for both `anon` and `authenticated` roles, no person rows committed.
- **`docs/system-brief.md` is stale on the one point that matters most:** it's auto-generated (last run 2026-08-10, `npm run brief`) and still describes `profiles/` (39 files) and `backup/` (131 files) as tracked-and-pushed. That was true once but isn't now — `.gitignore` covers both paths and `git ls-files` returns zero matches under either today. Low severity (the current state is *better* than the stale doc claims, not worse) but worth a `npm run brief` re-run so a future reader doesn't over-state the live exposure.
- **Verify gate this review, re-run directly on current `HEAD` (`a52881b`):** `npm run typecheck` clean. `npm run test`: **396/396 passing across 62 files**, unchanged. Repo is not currently broken. Digest send-gating and LinkedIn pacing unchanged.

### 2.3 Technical direction

- **PII history exposure: unchanged, still critical, still unpurged — at least the tenth review in a row confirming it, independently re-verified this review with a direct primary-source check rather than trusting the prior draft.** `git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves; `git log --all` still contains no `filter-repo`/BFG-style purge commit. Current tree stays clean (`.gitignore` covers `profiles/`, `backup/`, `data/`, `cache/`, `output/`), which bounds new exposure but does nothing for what's already public in history.
- **Ownership-share fix and mid-run LinkedIn auth-guard: still holding**, unchanged since 08-10/08-11.
- **Everything else carries forward unchanged**, since `a52881b` was scoring/tree-filtering work, not the digest ranking-refinement loop, LinkedIn scrape-failure handling, or auto-assess default: zero retry/trace/screenshot capture on LinkedIn scrape failures; captured `expected_country` still only a matching-boost hint, never a hard homonym-rejection filter; digest ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved; auto-assess still runs by default (`AUTO_ASSESS=0` to opt out).
- Zero open issues, zero open PRs at time of this review (both repos, re-checked directly via the GitHub MCP tools, not assumed from the prior draft).

Deeper detail (in this repo): [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/system-brief.md`](./system-brief.md) (generated, Tier 0 oracle context — due for a refresh, see §2.2)

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
many review cycles, with the underlying automation in jobright's case still
capable of adding more.** tSearch's is third-party LinkedIn PII in history
only (current tree is clean); jobright's is the operator's own resume PDFs,
still growing between reviews via ordinary use of the tool. That keeps
jobright's the more urgent of the two: the fix has been fully specified — a
`.gitignore` entry, a regex fix, an autopush exclusion, a hook-install
check, then a history purge — for eight review cycles without being applied.

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
| **Critical** | jobright | **Eighth consecutive review finding this unfixed. Count re-verified directly this review at 481 tracked paths (4 unique file contents), up from 396 two reviews ago** — growth from ordinary autopush/manual-commit activity, confirmed the new PR #65–#69 feature wave itself never touches the relevant files. `ARTIFACT_AUTOPUSH_ENABLED` plus manual operator commits have pushed the operator's real resume PDFs to this public repo since 2026-08-08. Root causes unchanged since first found 08-11: `artifactScan.ts:26`'s regex doesn't match `resume-<hash>.pdf`; `artifactAutopush.ts:53` runs an unexcluded `git add -A`; `.gitignore` never gained an `artifacts/applications/**/materials/` entry, which is also why a bare `npm run test` run independently leaks fixture artifacts into the tracked tree. No purge has ever been attempted. | Single longest-standing, actively-worsening item across both repos. A `.gitignore` entry is the one change that closes all four known leak paths (autopush, manual commit, feature-dev commit, test-run side effect) at once; the regex/exclusion fixes are good defense-in-depth but not sufficient alone. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII (name, LinkedIn URL, photo URL, school, degree) is untracked from the current tree but still fully present and fetchable in git history on this public repo — re-verified directly this review (`git cat-file -e 700e2f6:profiles/madanva/profile.json` still resolves). No purge has been attempted since the finding was first raised. | At least the tenth review in a row confirming this is unchanged: a live public exposure of real third-party people's data, not a hypothetical. `git filter-repo` + force-push + collaborator re-clone is still the concrete, unexecuted unblock. |
| **High** | jobright | `docs/current-state-and-phase56.md` remains actively contradicted by the repo's own state (still says live discovery "has never produced a job") while genuine live-fill evidence (a real Paylocity session, 08-19) sits undocumented in code comments, and the doc's "Phase 5.6" framing now predates five ATS adapters, extension-first fill, essay autofill, Gmail drafts, a console redesign, ATS board discovery, and a second agent engine. | An operator or future agent trusting these docs would materially misjudge both what's broken and what's actually been proven live or shipped. The fix is doc edits, not new code. |
| **High** | jobright | `auto:cycle` + a standing `.env` + a scheduled task remains a genuinely unattended fill-and-submit operating mode with no per-run human click and no time-boxed re-arm gate, unchanged since 08-11. Whether `operator-guide.md` §17b's loop can self-merge its own gated PR under a "standing operator grant" is still unconfirmed either way from commit metadata. | Two open, deliberate product decisions bundled in one surface: whether unattended real-submission automation needs an additional standing-authorization gate, and whether the loop's PR-merge step is human-in-the-loop or self-authorizing. |
| **High** | jobright | Sender-trust magic-link handling remains a keyword-match-plus-ranking-boost qualifier with no hard sender-domain-affinity requirement; the browser still navigates to the top-scoring link using the operator's authenticated session. Unchanged since `a4f9cd8` (08-12). | Still a genuine, code-verified phishing-surface widening with no decision made yet on tightening it. |
| **Medium** | both | **Meta-risk: this living document has been drafted at least ten times (08-07 through 08-27) and never once merged to `main`/`master` in either repo — and, verified directly this review, at least two prior drafts (08-21, and implicitly 08-25) made confident claims about their own merge/notification status that turned out to be false when checked against actual git ancestry.** A review process that both fails to trigger action *and* cannot reliably self-report whether it triggered action has a compounding trust problem, not just a stuck-workflow problem. | If a direct operator notification from this review also goes unactioned, the concrete next step is a human merging one of these branches so the doc is discoverable at its canonical path — and, going forward, treating this document's own "landed on main" / "notification sent" claims as unverified until checked, the same way this review checked them. |
| **Medium** | jobright | Lever, Ashby, Workday, and Workable are all wired but unverified against real DOM — no live-DOM progress on any of them since ~08-11. | The live-proof backlog for the four named adapters isn't shrinking. |
| **Medium** | jobright | The new Stagehand agent engine (S1) is a second sidecar dependency with a pre-registered promotion bar in `agent-engine-decision.md` that hasn't run yet. | Good process (comparison-before-promotion) but worth tracking so "not yet default" doesn't quietly become "default by drift." |
| **Medium** | tSearch | No fail-closed safety-flag *enforcement* — `CLAUDE.md` documents boundaries in prose but there is still no forbidden-API checker or `*_ENABLED` naming convention comparable to jobright's CI-enforced `check:forbidden`. Unchanged since 08-11. | A future change could silently violate the frozen-candidates-snapshot or `final_score`/`priority_score` separation invariants and nothing in CI would catch it. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` remaining items unchanged: zero retry/trace/screenshot capture on scrape failures; captured `expected_country` still never used to reject homonym mismatches. | Wrong-person matches can still silently enter the candidate graph; live failures are still hard to diagnose after the fact. |
| **Low** | tSearch | `docs/system-brief.md` (auto-generated, last run 2026-08-10) overstates the PII exposure — still describes `profiles/`/`backup/` as tracked-and-pushed when the current tree has been clean for some time. | Doc drift in the safer direction, but a stale generated doc undermines trust in the others; `npm run brief` is a one-command fix. |
| **Low** | jobright | An older run artifact (`run-47082d9f`, 2026-08-08) still shows `submits_used: 1` at the top level while all 7 of its `per_app` entries show `submitted: false`/`FAILED_RETRYABLE`. Unchanged since 08-13. | Doesn't change L3's overall `FIXTURE_CONFIRMED` status, but a validation-ladder document should not have an unresolved contradiction sitting in its own evidence. |
| **Low** | tSearch | Auto-assess still runs by default at the end of every pipeline run (`AUTO_ASSESS=0` to opt out). Unchanged since 08-11. | Cost/scope-creep item, not a safety gap. |
| **Low** | tSearch | Digest-loop ranking-*refinement*-from-feedback still unbuilt; global-vs-per-seed and Substack-only-filtering product questions remain unresolved. Unchanged since 08-07. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase 10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **A path-blocking pre-commit hook is the right primitive here, not a
  secret scanner.** Checked this review: gitleaks/`git-secrets`-style tools
  are content-pattern matchers built for credentials (API keys, tokens),
  and would not catch a real resume PDF, which contains no secret-shaped
  string — it's a personal document, not a leaked credential. The correct
  tool class is a **path/size-based pre-commit block** (reject any staged
  path under `artifacts/**/materials/`, or any PDF over a size threshold in
  that tree), which is what the already-open **Lefthook** recommendation
  (carried over, unchanged) would run once configured — worth being
  explicit that Lefthook's value here is as the *delivery mechanism* for a
  custom rule, not an off-the-shelf secret-scanning ruleset.
  https://github.com/evilmartians/lefthook
- **GitHub secret-scanning push protection with a custom pattern** —
  re-checked this review (GitHub's 2026 docs and changelog): custom
  patterns and push protection for them still require GitHub Secret
  Protection (paid, org-owned repos), not available on a personal-account
  public repo. Confirms rather than resolves the standing caveat; also
  wouldn't apply to PDFs for the same content-vs-path reason above.
- **The `agent-engine-decision.md` pre-registered-comparison pattern (S1)
  is worth generalizing**, not importing from outside — it's already a
  good internal pattern (define the promotion bar and comparison protocol
  before the new component can become default) that the ATS-adapter
  live-DOM backlog (§4, Medium) could reuse: a written bar for "Lever goes
  from `FIXTURE_CONFIRMED` to `LIVE_READ_ONLY_CONFIRMED`" the same way
  Stagehand has one for "becomes the default engine."
- **CDP session-handoff discipline** — carried over, still relevant to the
  unresolved `auto:cycle` posture question and the growing number of
  surfaces (console, nav-layer sidecar, sandbox, `auto:cycle`, two agent
  sidecars now) that can want the same CDP Chrome instance.

**tSearch**

- **`git filter-repo` / BFG history purge, executed, not just planned** —
  repeated for at least the tenth review in a row.
- **AutoRubric** (`autorubric.org`) — carried over from the last review:
  a live reference implementation (ensemble judging, bias mitigation,
  Cohen's-kappa/Krippendorff's-alpha agreement metrics built in) directly
  applicable with six judges now in the panel and zero measured agreement
  or position-bias numbers for any of them. Concrete next step unchanged:
  sample 100–300 traces, have 2–3 humans label them, compute agreement,
  pair with a position-bias check (run each comparison twice with the
  candidate's material in each slot, flag verdicts that flip on order
  alone).
- **Supabase Row-Level Security review before the dual-write lands** —
  carried over; the scaffolding remains correctly gated (deny-all RLS,
  server-only service-role key, throws until wired) and unchanged this
  cycle — worth the same PII scrutiny once the dual-write actually lands.

---

## Changelog

- **2026-08-27** — This review. Baselined against the unmerged 2026-08-25
  draft (`claude/epic-pasteur-84e9yy` / `claude/busy-clarke-84e9yy`) per the
  session-start-ritual instruction, then independently re-verified every
  carried-forward claim against current `HEAD` in both repos rather than
  trusting the draft's prose — including re-checking, and finding false,
  the 08-21 draft's claim to have "landed on main/master" (verified via
  `git merge-base --is-ancestor`, not assumed). **jobright: 17 new commits
  since the last review (`933ee71`, up from `8018fde`)** — a real feature
  wave (ATS board discovery, schema-vs-DOM completeness, a second Stagehand
  agent engine, operator-handoff/CAPTCHA ergonomics, console redesign);
  diffed directly and confirmed none of it touches the leak-relevant files.
  Re-ran the full verify gate directly: typecheck clean,
  `check:forbidden`/`check:secrets` both `ok`, 993/1221 tests passing (up
  from 943/1163), same missing-browser-binary cause for every failure.
  Resume-PDF leak re-verified directly at **481 tracked paths / 4 unique
  file contents** (corrected upward from the 396 the prior draft reported)
  — eighth review in a row finding it unfixed. **tSearch: zero new
  commits** (`HEAD` still `a52881b`) — re-verified `youthWildcard`/
  `includeOnTree`/the pin endpoint are wired as described, re-ran the
  verify gate directly (typecheck clean, 396/396 tests), and found
  `docs/system-brief.md` stale in the safe direction (still describes
  `profiles/`/`backup/` as tracked when the tree has been clean for a
  while) — added as a new Low risk. PII-history exposure re-verified
  unpurged via direct `git cat-file` read of the same still-reachable blob;
  `git log --all` still has no purge commit. Both repos: zero open issues,
  zero open PRs (re-checked directly via the GitHub MCP tools). **New this
  review:** sent a direct operator notification alongside this doc commit,
  independent of whether the 08-25 draft's claim to have done the same is
  true, precisely because this review found that draft's other
  self-reported status claims to be unreliable. Replaced one amendment
  (generic secret-scanning suggestion) with a more precise framing: this
  class of tool doesn't actually address a PDF leak, and said so explicitly
  rather than carrying forward a recommendation that wouldn't fix the
  problem. Pushed to this session's assigned branches
  (`claude/busy-clarke-27e9vi` jobright, `claude/epic-pasteur-27e9vi`
  tSearch).
- **2026-08-25** — Ninth review (drafted on `claude/epic-pasteur-84e9yy` /
  `claude/busy-clarke-84e9yy`, never merged). Resume-PDF leak re-verified
  unchanged at 396 paths because zero commits landed in the two days since
  08-23. Found a fourth leak-reproduction path by direct reproduction:
  running the test suite writes untracked resume-PDF-shaped fixture output
  into the tracked `artifacts/` tree. Claimed to send the first direct
  operator notification alongside the doc commit.
- **2026-08-23** — Eighth review (drafted on `claude/epic-pasteur-lqqsk6` /
  `claude/busy-clarke-lqqsk6`, never merged). Resume-PDF leak confirmed
  worse for the sixth review running (366→396), traced to two commits since
  08-19. `current-state-and-phase56.md` found actively widening its gap
  from reality (undocumented Paylocity live-fill evidence). tSearch saw a
  real four-commit feature wave (Discover UI restore, youth wildcards,
  scoring tuning, marks watchlist + gated Supabase scaffolding). Made the
  eight-cycles-unmerged pattern an explicit Medium risk rather than a
  closing observation.
- **2026-08-21** — Review drafted on `claude/epic-pasteur-6eyjpj` /
  presumed matching `claude/busy-clarke-*`, claimed to be "the first review
  to land on `main`/`master` since 2026-08-07." **This review (08-27)
  checked that claim directly and found it false** — the commit is only
  reachable from the unmerged review branch, not from `origin/main`.
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
