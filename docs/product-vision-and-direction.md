# Product vision & technical direction — Dispatch + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both* repos
together (shared lineage, shared operator, shared data-handling posture)
don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-09-23 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` — now shipping as **Dispatch** (private; GitHub redirects the old slug, `full_name` still resolves via 301) · `skale-07/tSearch` (**public**) |

---

## 1. Dispatch (engine: the application agent, repo slug still `jobright-application-agent`)

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai /
public ATS-board discovery → employer ATS form fill → gated submit → outreach
→ Outlook drafts — while keeping every judgment call (essays, demographics,
uncertain submissions) with a human. It is explicitly **not** trying to be a
general autonomous browser agent. The product bet is that determinism +
fail-closed gating + an honest validation ladder beats an LLM-driven agent
for a task where a wrong click (an accidental real submission, a leaked
credential, an invented EEO answer) is expensive and hard to undo.

**Naming note (new this cycle):** the product has been renamed **Dispatch**
end-to-end — `package.json` (`"name": "dispatch"`), `README.md` title/branding,
in-app copy (dashboard, console, sandbox, frontend), and the GitHub repo
itself (`api.github.com/repos/skale-07/jobright-application-agent` now
301-redirects). `README.md` explicitly documents this as a real rename, not
an aspiration: "Repo formerly `jobright-application-agent`; GitHub redirects
the old URLs." The one place the rename didn't propagate: `CLAUDE.md` never
mentions "Dispatch" (it also never named the old product, so this is an
omission rather than drift). Low severity, noted in §4.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (one narrow call site only).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (`FORM_FILL_ENABLED`, `SUBMIT_ENABLED`, `DRY_RUN`, etc. — full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Demographic fields are never inferred. Essays fill from `about-me.md` when the LLM path is on; otherwise they park. One drift found this cycle: `.env.example` carries `ESSAY_REQUIRED_GATE_ENABLED` (a fail-closed pipeline hard-stop) that isn't in `CLAUDE.md`'s enumerated flag list — otherwise the two stay in sync.
- **Validation ladder:** `UNIT_CONFIRMED → FIXTURE_CONFIRMED → LIVE_READ_ONLY_CONFIRMED → LIVE_MUTATION_CONFIRMED`, with `UNVERIFIED` as the honest default. A capability's self-reported success (including the fill-healer's) carries no level until independently verified. This ladder is the project's main defense against "fixture green" being mistaken for "live green."
- **ATS coverage today:** Greenhouse (inspect + fill, live-path shipped) and Ashby now both have **`LIVE_MUTATION_CONFIRMED` real submissions with receipts** (see §1.3). Workday/iCIMS/Oracle are detected and skipped. Lever deferred. An "inert" Phase 6a agent-authoring sidecar exists to help *write* new adapters offline; it never drives a live page.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

**Material update this cycle — read this before trusting the repo's own phase docs.** The
in-repo docs (`docs/current-state-and-phase56.md`, `docs/known-limitations.md`)
still describe the product as blocked on live JobRight-feed discovery, with
"every application in SQLite fixture-derived" and Employer Submit listed as
an **explicit non-goal "through and beyond 5.6."** That is now contradicted by
the repo's own evidence:

- A new `discover:ats` path (`ATS_DISCOVERY_ENABLED`) enqueues jobs directly
  from public Greenhouse/Lever/Ashby board APIs, **bypassing JobRight
  entirely** (`docs/operator-guide.md`).
- `README.md`'s 2026-08-31 snapshot claims real, non-fixture, receipted
  submissions: **`LIVE_MUTATION_CONFIRMED` — Neuralink, Old Mission, DV
  Trading via Greenhouse; Exa via Ashby.**
- Daily "overnight session" artifacts (`artifacts/overnight-issues-2026-08-28.md`
  through `-2026-09-12.md`) show continued live-loop hardening — a picker-
  starvation livelock fix, Ashby autocomplete/date-discovery fixes, aggregator
  filtering — well past what the phase-status docs describe.

Net read: the underlying JobRight-session bug (still hypothesized as
`storageState()` dropping IndexedDB-held Google OAuth state) is likely
**still open**, but the product **worked around it** via public-board
discovery and has, on that path, gone further than its own docs admit —
including flipping on Employer Submit, which the same doc set still calls
out of scope. This doc-set internal contradiction is itself flagged as a
risk in §4: either the phase docs are dangerously stale, or submit scope
quietly expanded past what was deliberately signed off on. Given this
project's whole value proposition is disciplined, gated, one-phase-at-a-time
progression, that distinction matters and is worth the operator's direct
attention rather than being inferred from artifacts.

- **CAPTCHA retest status: still ambiguous.** `known-limitations.md` says the
  false-positive fix "has not been retested on a live board." An overnight
  artifact (2026-09-08) shows a live captcha-classification refusal being
  handled, but that isn't clear independent confirmation of the specific
  documented fix. Treat as still open pending an explicit retest note.
- **Deliberately not in scope right now (per the docs, now under a cloud —
  see above):** essay generation expansion, Outlook send (permanently out of
  scope, not just "not yet"), silent multi-ATS expansion beyond
  Greenhouse/Ashby, restoring the Phase 6 `autofillCompare` stash, or
  replacing the deterministic adapters with an LLM agent as the default path.
- **Longer arc:** Phase 6 constrained-agent fallback — *only* as a fill-assist
  for unsupported ATS (Workday first candidate), gated behind
  `AGENT_FALLBACK_ENABLED`, still passing through the same approved-plan +
  read-back verification gates. Not a replacement for the deterministic
  Greenhouse/Ashby path, which stays the default.
- **Review-process note:** this cycle's audit ran against a **shallow clone**
  (depth 50, all visible commits are same-day `art:` autopush noise from
  2026-09-18) — true commit history wasn't locally inspectable, so this
  section leans on artifact/doc content rather than `git log`. Worth knowing
  if a future review needs `git fetch --unshallow`.

Deeper detail (unchanged by this doc, still canonical):
[`architecture.md`](./architecture.md) ·
[`current-state-and-phase56.md`](./current-state-and-phase56.md) ·
[`known-limitations.md`](./known-limitations.md) ·
[`validation-levels.md`](./validation-levels.md)

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

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / OpenAI / Resend / Supabase (new — sync work in progress, see §2.3).
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score (final_score heuristic) → persist (candidates.json, profiles/, data/people/) → assess (LLM judges, priority_score) → digest email → feedback (relevant / not relevant / explore-network, new — see §2.3)`.
- **Discovery/Assessment/Presentation separation is load-bearing:** assessment reads only the frozen `output/candidates.json` — it never re-runs LinkedIn discovery or corrects a wrong identity match. `final_score` (discovery) and `priority_score` (assessment) are deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), technical + writing judges running in parallel where both apply, then a cross-artifact/synthesis pass. Judges are instructed to coerce (demote/backfill) rather than hard-fail on missing evidence IDs. Scoring has grown materially more sophisticated since the last review (§2.3).
- **Safety-flag layer now exists, on convention, not yet on enforcement.** `CLAUDE.md` was added this cycle and does cover what the earlier audit wanted: "no PII in git — ever," `digest:send --dry-run` as the default, paced/capped LinkedIn scraping, `ASSESSMENT_MOCK_LLM=1` as the test default. What's still missing versus Dispatch's equivalent: **no automated enforcement** — no `check:forbidden`-style script, no installed pre-commit hook (`package.json` has no such script; `.git/hooks/` has nothing installed). Nothing today mechanically stops a future commit from re-adding PII, which is exactly how the still-open Critical risk in §4 happened in the first place.

### 2.3 Technical direction

- **Digest feedback loop (previously "designed but not built") is now built.**
  `src/digest/feedbackStore.ts` (append-only per-candidate `relevant` /
  `not_relevant` / `explore_network` verdicts), `POST /api/feedback` +
  `GET /api/feedback/explore-queue`, UI buttons in `ProfilePanel`, and
  `buildDigest.ts` wiring: `not_relevant` hides a candidate, `relevant` boosts
  ordering — `priority_score` itself stays untouched, preserving the
  discovery/assessment separation. The global-top-N-vs-per-seed-neighbors
  question remains unresolved in the docs.
- **Substantial scoring work landed since the last review:** an
  ownership-share denominator fix (§4 — was High severity, now resolved),
  mid-run LinkedIn re-auth detection, an experience-distinctiveness judge,
  tiered recruiter labels, a conviction-in-writing rubric v2, an obscurity
  multiplier + age-relative impressiveness ("upside = obscurity × judged
  substance"), an award registry, LinkedIn-connections capture, a restored
  Discover UI with verified-GitHub badging, and — most recently — a fix that
  isolates "youth wildcard" candidates and stops seed-tree neighbors below
  the top-80 cut from being silently dropped. Net effect: the scoring model
  is meaningfully more sophisticated than the Aug 7 snapshot, though
  Priority-v2 and the "Cory" persona calibration remain flagged
  `requires_calibration` in the docs — external tooling to actually measure
  that calibration is a live amendment candidate (§5).
- **Supabase sync is in-progress, uncommitted-shaped work** (`docs/prompts/integrate-supabase.md`,
  added 2026-08-21; most recent commit message is literally "current progress
  on window, supabase, marking changes"). Worth tracking as an open
  workstream rather than assuming it's finished.
- Phase-D GitHub helpers (PR files/reviews/CODEOWNERS/workflows) — no new
  evidence found either way this cycle; treat as still unwired pending a
  closer look next review.

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md` ·
`docs/system-brief.md` (new, generated overview, added 2026-08-10)

---

## 3. How the two projects relate

Dispatch is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project. `docs/tsearch-reuse-map.md`
(in the Dispatch repo) records the original reuse plan: tSearch's
`saveSession.ts` / `linkedinBrowser.ts` concepts (manual storageState login,
lazy session open/validate) and atomic-JSON-store pattern were the seed for
Dispatch's `ServiceSession` and `src/storage/` layers, explicitly rebuilt with
more hardening (coverage statuses, mid-run auth checks, traces/screenshots, no
committed profile artifacts — a design choice that, per §4 below, tSearch
itself does not currently follow, and has not closed out even after two
review cycles). tSearch's product logic — olympiad scoring, GitHub graph
expansion, the seed-tree UI — was deliberately **not** ported; the two
products solve different problems (apply vs. discover) and share only the
"safely drive a browser session against a third-party site" substrate.

**New cross-cutting pattern this cycle: status docs lagging shipped reality
in both repos, independently.** In Dispatch, `known-limitations.md` and
`current-state-and-phase56.md` still describe a fixture-only, submit-off
product that the repo's own README and artifacts contradict (§1.3). In
tSearch, `assessment-rubric-architecture-audit.md` and
`tsearch-playwright-system-audit.md` still describe bugs that were, per
source and commit evidence, already fixed weeks ago (§4). Neither is a
one-off — it's the same failure mode (a fix or capability ships, and the
audit/status doc that named the original problem never gets a closing note)
recurring independently in two codebases with otherwise very different risk
postures. Worth a shared convention: when a doc-named issue is fixed, the doc
gets one line saying so, not just a silent code change.

`docs/tsearch-reuse-map.md` is still stale on the LinkedIn-enrichment point,
now for a **second consecutive review**: it still frames LinkedIn enrichment
as "Phase 1 — no LinkedIn code ported yet / port in Phase 2," while both
`known-limitations.md` and `current-state-and-phase56.md`'s capability matrix
say it was **dropped by decision**. Low severity, but it's been six weeks
since first flagged with no update — see §4.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix. Items
resolved since the last review are removed from the table and noted in the
changelog instead, so this table reflects **current** standing risk only.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical — unresolved for 2nd cycle** | tSearch | `profiles/` and `backup/` are now gitignored and the **current tree is clean** (0 tracked files) — but **git history was never purged**. Directly verified: 349 blob/tree objects containing real scraped LinkedIn PII (names, GitHub URLs, education, etc. — e.g. a `backup/` snapshot with "Herman Brunborg"'s full profile data) are still reachable from `origin/main`. The commit that untracked the files (`f5ad384`) says so explicitly in its own message: "files stay on disk, history purge still required separately." The repo is confirmed **still public** (`api.github.com` → `"private": false`). | This is unambiguously still a live, public PII exposure — anyone can `git clone` and walk history with no auth. `CLAUDE.md`'s "previously leaked" phrasing reads past-tense/closed, which risks an operator believing this is handled when it isn't. Needs `git filter-repo`/BFG + force-push, or the repo going private until purged — same recommendation as last cycle, now overdue. |
| **High — new finding** | Dispatch | Internal doc-set contradiction: `known-limitations.md`/`current-state-and-phase56.md` still describe the product as fixture-only with Employer Submit an explicit non-goal "through and beyond 5.6," while `README.md` and dated overnight artifacts document real `LIVE_MUTATION_CONFIRMED` submissions (Neuralink, Old Mission, DV Trading, Exa) already obtained via a new public-board discovery path. | Either the phase-status docs are dangerously stale (an operator trusting them would misjudge what's already live), or submit scope quietly moved past what was deliberately gated — for a project whose entire safety case rests on disciplined, declared phase progression, that ambiguity itself is the risk, independent of whether the underlying submits were handled safely. Needs a direct answer, not just a doc sync. |
| **Medium** | Dispatch | The original JobRight-feed live-discovery blocker (`jobs_inspected: 0`) is very likely still technically unresolved — no evidence the underlying `storageState()`/IndexedDB hypothesis was tested or fixed — but the product routed around it via public ATS-board discovery, so it's no longer the single blocking defect it was. Downgraded from High. | Still worth closing properly: the workaround only covers boards with public APIs (Greenhouse/Lever/Ashby), not the full intended JobRight-driven discovery surface. |
| **Medium** | tSearch | `tsearch-playwright-system-audit.md` HIGH items — half fixed, half open. **Fixed:** mid-run LinkedIn re-auth detection (`linkedinBrowser.ts`), LinkedIn test coverage (previously zero, now 4 test files). **Still open:** no retry/trace/screenshot capture anywhere in `src/` on scrape failure; country is captured and used to *target* search results but never compared against the scraped profile's own extracted country to *reject* a homonym match post-extraction — the exact gap the audit named, just with better search-time steering around it. | The remaining two directly threaten data-quality (wrong-person matches entering the candidate graph) and diagnosability of live scrape failures — same class of problem Dispatch already solved for its own live paths. |
| **Low** | tSearch | No automated enforcement behind the new `CLAUDE.md` safety conventions (no forbidden-check script, no installed pre-commit hook), unlike Dispatch's `check:forbidden`. | Convention-only means nothing mechanically prevents a repeat of the Critical PII issue at the *next* commit, even though the current tree is clean. |
| **Low** | Dispatch | `.env.example`'s `ESSAY_REQUIRED_GATE_ENABLED` flag isn't in `CLAUDE.md`'s enumerated flag list. | Minor doc/CLAUDE.md drift; a future reader of the house-rules list would miss one fail-closed gate. |
| **Low — unresolved 2 cycles running** | Dispatch | `docs/tsearch-reuse-map.md` still frames tSearch LinkedIn-enrichment porting as a not-yet-done Phase 1/2 item, contradicting two other in-repo docs that say it was dropped by decision. | Doc drift; a future reader could plan work against a stale, already-reversed decision. Flagged twice now with no fix — worth just doing it. |
| **Low** | tSearch | Global-vs-per-seed digest question still unresolved; Supabase sync integration is mid-flight (uncommitted-shaped WIP as of the latest commit). | Not defects, just open threads worth tracking so they don't silently stall. |
| **Note, not a risk** | Dispatch | This cycle's audit hit a shallow git clone (depth 50, single-day autopush noise) — true commit history wasn't locally auditable, so this review leans on artifact/doc content. | Flagging so a future review knows to `git fetch --unshallow` if it needs real `git log` history. |

**Resolved since last review (removed from the active table):**
- tSearch — the ownership-share metric's denominator bug (`assessment-rubric-architecture-audit.md`) is fixed: commit `5f80433` (2026-08-10) changed the share calculation to use the full unfiltered repo commit sample rather than defaulting to the candidate's own commits, with `omitShare` gating when coverage is insufficient, plus a regression test. (The audit doc itself wasn't updated to note the fix — see the cross-cutting pattern in §3.)
- tSearch — the digest feedback loop (§2.3) moved from "designed, not built" to shipped.
- Dispatch — CAPTCHA/live-Greenhouse-fill retest status moved from "not yet attempted" to "ambiguous, partial evidence of live handling" — not a clean resolution, but no longer purely `FIXTURE_CONFIRMED`-only. Kept as a note in §1.3 rather than the risk table since it's improving, not stuck.

---

## 5. Amendments worth considering (external scan)

**Dispatch**

- **`storageState({ indexedDB: true })`** (Playwright ≥1.51) — still the most
  direct fix for the underlying (still-open, per §4) JobRight live-session
  blocker: Google OAuth state plausibly lives in IndexedDB, which default
  `storageState()` silently drops. Worth doing even though the public-board
  workaround has unblocked forward progress — it doesn't cover the full
  intended discovery surface. https://playwright.dev/docs/auth
- **Skyvern** (`Skyvern-AI/skyvern`, 22k+ GitHub stars) — a computer-vision-first
  browser agent, reported as the strongest current open-source agent
  specifically on WRITE/form-filling tasks. This cuts against Dispatch's
  explicit deterministic-first philosophy, so it's not a fit for the
  Greenhouse/Ashby default path — but worth a scoped evaluation as a
  Phase 6 fallback candidate for the messiest unsupported ATS forms
  (Workday), alongside browser-use and Stagehand, with its output still
  required to pass the existing approved-plan + `SUBMIT_ENABLED` +
  read-back-verify gates.
- **Stagehand** (`browserbase/stagehand`) — unchanged recommendation from last
  cycle: mixes deterministic Playwright code with narrow, cached LLM calls
  for one step, replaying deterministically once resolved. Closer
  architectural fit for Phase 6 than a full autonomous agent.
  https://github.com/browserbase/stagehand
- **browser-use** — unchanged: still the concrete Phase 6 candidate already
  named in this repo's own `browser-use-evaluation.md`; external validation
  it's reasonable *scoped strictly to fill-assist*.

**tSearch**

- **Judge Reliability Harness** (arXiv 2603.05399, open source) — a direct,
  concrete answer to what last cycle's Autorubric mention only gestured at:
  an actual library that stress-tests LLM judges for label-flip accuracy,
  paraphrase/formatting invariance, verbosity bias, and stochastic
  calibration across an ordinal scale. This maps precisely onto the docs'
  own `requires_calibration` flags on Priority-v2 and the "Cory" persona —
  it's the tool to actually go measure that, rather than continue flagging
  it as an open question. https://arxiv.org/abs/2603.05399
- **CalibratedRubric** (arXiv 2607.29252) — task-adaptive, probabilistically
  calibrated rubric evaluation, as an alternative/complement to a fixed
  deterministic rubric YAML pipeline; relevant to the same calibration gap.
- **LinkedIn v. ProAPIs consent judgment, finalized 2026-09-21** (two days
  before this review) — a fresh, concrete escalation of the legal risk
  already named in the Critical PII item and last cycle's Proxycurl note:
  a permanent scraping ban plus a data-destruction order, following the same
  pattern as the July 2026 Proxycurl shutdown. This is current, not
  hypothetical, evidence that LinkedIn is actively litigating and winning
  against scraping operations at exactly this repo's scale of activity —
  strengthens both the case for git-history remediation (§4) and for
  treating LinkedIn as a low-volume confirmation step rather than the
  primary discovery mechanism, per the existing GitHub-graph-first
  amendment below.
- **GitHub-graph-first identity resolution** (pattern: `theArjun/github-social-graph`,
  GitHub GraphQL API over followers/stargazers/forks + NetworkX for
  community detection) — unchanged recommendation: a ToS-compliant
  complement that could shift weight away from LinkedIn scraping as the
  primary signal.

---

## Changelog

- **2026-09-23** — Second scheduled review. Two parallel deep-dive agents
  independently audited each repo's git/doc state since 2026-08-07; findings
  cross-checked directly (git history object walk and gitignore state for
  the tSearch PII item, GitHub API redirect + package.json/README for the
  Dispatch rename, source-level fix verification for the ownership-share
  bug) rather than taken on the subagents' word alone. Both repos: zero open
  issues, zero open PRs. Headline changes: the tSearch Critical PII risk is
  **not** resolved (history never purged, repo still public — a second
  consecutive review flagging the same live exposure); the ownership-share
  bug and the digest feedback loop **are** resolved; Dispatch was renamed
  end-to-end and appears to have shipped real live-mutation submissions
  while its own phase-status docs still describe submit as out of scope —
  flagged as a new High-severity doc-contradiction / possible scope-creep
  risk. New cross-cutting observation: both repos independently let
  audit/status docs go stale after the underlying issue was fixed.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
