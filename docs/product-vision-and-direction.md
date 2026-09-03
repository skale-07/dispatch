# Product vision & technical direction — Dispatch (jobright-application-agent) + tSearch

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
| Last reviewed | 2026-09-03 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**private**, unchanged since 09-01; product name "Dispatch"), `skale-07/tSearch` (**public**, unchanged) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **fifteenth** attempt at this document since
2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and never merged to `master`/`main` — reconfirmed directly this review (both
default branches still carry only the single 08-07 `defde99` commit for this
file). Every figure below was re-derived directly against current `HEAD` in
both repos this session (`git ls-tree`/`git ls-tree -l` byte-size counts,
`git log`/`git rev-list` ranges, direct file reads, live GitHub API queries
for issues/PRs/repo visibility) rather than carried over from the 14th
review's text. A push notification was sent to the operator on completion —
same rationale as every prior review, plus one genuinely new,
time-sensitive finding this cycle (§1.3).

---

## 1. jobright-application-agent ("Dispatch")

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai /
direct ATS-board discovery → employer ATS form fill → gated submit → outreach
→ Outlook drafts — while keeping every judgment call (essays, demographics,
uncertain submissions) with a human. It is explicitly **not** trying to be a
general autonomous browser agent. The product bet is that determinism +
fail-closed gating + an honest validation ladder beats an LLM-driven agent
for a task where a wrong click (an accidental real submission, a leaked
credential, an invented EEO answer) is expensive and hard to undo.

**That single-operator framing is now, concretely, in tension with where the
product is actually being built — see the new finding in §1.3.** This
window's commits are the first hard evidence that "Dispatch" is being
turned into a multi-user hosted product (`docs/marketing/college-launch.md`,
dated "September 2026": a public app, an invite/referral growth loop, a
waitlist, campus marketing collateral) rather than staying a personal tool
one operator runs locally. That may be the right call — the marketing plan
is unusually disciplined about it ("we never fabricate user counts,
testimonials, or outcomes... marketing that can't show a receipt doesn't
ship") — but it is a vision-level decision this document has not previously
tracked, and it changes the blast radius of every data-handling risk below
from "the operator's own data" to "every invited student's resume and
contact info." Flagged for the operator explicitly, not just filed as a doc
update.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; TypeScript `agent/stagehand/`, still evaluation-only) / **new this window:** Supabase (Postgres + Auth + Storage) as a hosted backing store for the public app, gated behind `SUPABASE_SYNC_ENABLED` / `CONSOLE_HOSTED_MODE_ENABLED`.
- **Source of truth:** SQLite (`data/app.sqlite`, gitignored, not present in this sandbox checkout — figures below come from tracked `artifacts/`, source, and Supabase migration files, not a live DB query) for the operator-facing engine. The new public-app surface has its **own** source of truth in Supabase Postgres (`supabase/migrations/`, 9 files) — a second persistence layer this document has not had to track before.
- **State machine:** unchanged — `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, `FAILED_RETRYABLE`/`FAILED_FINAL` terminals, human `review:resolve` only.
- **Safety architecture — flags unchanged in shape, three new fail-closed flags added and consistent with the pattern:** `SUPABASE_SYNC_ENABLED`, `CONSOLE_HOSTED_MODE_ENABLED` (Supabase JWT verified on every `/api` route, host + user allowlists, read-only), and (per `CLAUDE.md`'s own flag list) the rest carried forward unchanged. `chromium.launch` remains confined to three session-infra files.
- **New this window — the Supabase schema itself is well-built, spot-checked directly against source, not assumed.** `supabase/migrations/20260902000300_referral_invites.sql` and its siblings: RLS enabled on every new table (`user_profiles`, `application_receipts`, `referral_bonuses`, `engine_status`), `security definer` functions with explicit `auth.uid()` checks, `pg_advisory_xact_lock` to close a mint-cap race, verbatim error-string contracts the frontend matches against. `SUPABASE_SERVICE_ROLE_KEY` usage is confined to `src/cloud/*` CLI/server code (`src/config/env.ts`), never shipped client-side — checked directly, not assumed. One actionable, dated gap: Supabase is deprecating the `anon`/`service_role` key pair in favor of `sb_publishable_*`/`sb_secret_*` keys by end of 2026 (see §5) — this codebase still reads `SUPABASE_SERVICE_ROLE_KEY` by that name.
- **ATS coverage — no new live-DOM evidence surfaced this window.** The 50 commits since the 09-01 review are almost entirely the public-app/referral/Supabase/console-hosted-mode wave described above, plus a UKG Pro adapter landing end-to-end (#135–144: shadow-DOM apply tier, Auth0 signup submit, section expansion, disability fence) and correctness fixes #145–160. None of this window's commit messages claim a new real `LIVE_MUTATION_CONFIRMED` Submit beyond what the 14th review already counted (≥9 across 4 platforms) — carried forward, not re-confirmed, since no fresh evidence landed either way.
- **`master`'s disjoint-root history rewrite, now partially explained rather than a pure mystery.** The current `master` tip (`22d2e8c5`, 2026-09-03) is 50 commits deep, rooted at `15367adb` ("chore(gate): forbidden scanner skips .claude/", 2026-09-01 18:37:43) — and that root commit is **exactly this session's own designated development-branch tip** (`claude/busy-clarke-wd8s4j`), reconfirmed by direct SHA comparison. This is consistent with a per-session working branch getting squash-flattened into a fresh `master` root — plausibly a mechanism of how this environment's ephemeral sessions hand off state — rather than an adversarial or corrupting event; no evidence of tampering was found on inspection (repeats the 14th review's spot-check, this time with a concrete causal story). **This does not change the PII finding**: the new root commit's own tree already contains 5,529 tracked resume-PDF paths and 21,985 files total — the squash preserved the leak wholesale, it did not purge it. It also means the pre-rewrite branches (`claude/*-tlr33g` and earlier) are now orphaned copies that still hold the older, smaller-but-still-real leak independently on GitHub — one more surface than before, not fewer.
- **Lineage:** unchanged from prior reviews — tSearch's session/storage layer was the seed for `ServiceSession`/`src/storage/`; tSearch's product logic was not ported.

### 1.3 Technical direction

- **NEW and the headline finding this review — the college-launch plan
  (`docs/marketing/college-launch.md`, `docs/marketing/qa-2026-09-02.md`,
  `docs/marketing/campus-outreach-templates.md`,
  `docs/marketing/short-form-scripts.md`) makes the unfixed resume-PDF leak
  a dated, concrete pre-launch blocker, not an abstract ongoing risk.** The
  plan is explicit that it targets "fall recruiting season" and is dated
  September 2026 — now. `docs/marketing/qa-2026-09-02.md` confirms, directly
  read, that real resume upload against a live Supabase project has **not**
  been exercised yet ("What this pass did NOT cover: ... real resume
  upload ... all need a deployed Supabase project" — only fixture-router
  coverage exists today). That is the one piece of good news: **no
  third-party student PII has flowed through this system yet.** But the
  architecture that has been leaking the *operator's own* resume/PII into
  git on every autopush cycle for three-plus weeks (§4) is the same
  `artifacts/`-tracking pipeline a real resume-upload feature would extend
  to every invited student. Shipping student-facing resume upload before
  the four root causes in §4 are fixed would mean onboarding real
  third-party PII directly into the same unpurged, growing leak. This is
  now the single most important item in this document's "next up" list,
  ahead of everything carried forward below.
- **Phase-doc staleness, unchanged from the 14th review — not re-derived,
  since neither file was touched this window (both still date to the
  `15367adb` squash root).** `docs/current-state-and-phase56.md` still
  frames the product at "Phase 5.6" and still says live discovery "has
  never produced a job," against ≥9 confirmed real submits. `README.md`'s
  "Current state" section remains the accurate one (per the 14th review's
  fix) — an operator/agent should keep reading that, not the phase doc,
  until it's rewritten.
- **PII leak — same four root causes, still unfixed, still growing, now
  re-measured directly against `HEAD` (`22d2e8c5`), not carried over.**
  - **6,025 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths — up from 5,128 two days ago (+17%).** Full byte-size sweep this
    review (not a sample): 5,590 are the 45-byte placeholder fixture; **435
    have real, substantial content** (285 at 113,381 bytes, 134 at 76,462
    bytes, 16 at 74,509 bytes — the same three sizes every review has found
    since 08-11), up from 398 two days ago.
  - **Operator's cleartext contact info unchanged again this window** —
    reconfirmed directly: phone/email patterns hit exactly 28 files under
    `artifacts/ats-fill/generic-live/*.json` (e.g.
    `artifacts/ats-fill/generic-live/live-executed-1788357755523.json`),
    same count as the 13th and 14th reviews. All of this window's growth is
    resume-PDF volume through the ongoing autopush loop, not new
    operator-identifying log files.
  - **Root causes not re-verified line-by-line this review** (no
    `node_modules` in this sandbox, fourth consecutive review with that
    gap on the verify-gate side, and the source paths were unchanged in
    this window's diff) — carried forward from the 14th review's direct
    check: `.gitignore`'s `artifacts/` line still commented out,
    `REQUIRED_GITIGNORE_ENTRIES`'s substring-match check still satisfied by
    a dead comment, `artifactAutopush.ts` still shells `git add`
    unexcluded, no installed pre-commit hook. No purge attempted.
  - **Repo visibility unchanged since the 14th review: still private**,
    reconfirmed directly via the GitHub API this review (`"private":
    true`). Still not a resolution of the underlying leak — see the
    college-launch framing above for why it matters again regardless.
- **Verify gate — still not independently re-run, now the fourth
  consecutive review with this gap** (no `node_modules` in this sandbox).
  Every fix commit in this window still only carries a self-reported "Gate:
  NNNN/NNNN green" in its own message. This gap is now old enough to be its
  own standing methodology risk (§4).
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand comparison actually
  running (`docs/agent-engine-decision.md` still opens "SPIKE — comparison
  not yet run," unchanged this window).
- **Next up, in priority order (re-ordered this review given the
  college-launch finding):** (1) fix the `artifacts/` leak's four root
  causes and purge history **before** any real resume-upload feature ships
  to invited students — no longer just "cheap and unfixed," now a
  pre-launch gate; (2) rewrite `current-state-and-phase56.md` from the
  now-accurate `README.md`; (3) get independent (not self-reported)
  confirmation of the verify gate — four reviews running without one; (4)
  resolve #19 (Cloudflare conditional-DOM cross-fill), the one open
  correctness bug carried from the 13th/14th reviews with no new evidence
  either way this window; (5) live-DOM proof for the still-unverified
  adapters (Lever, Workable, per the 14th review's count); (6) let the
  Stagehand-vs-`browser_use` comparison actually run.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/current-state-and-phase56.md) (stale — see above) ·
[`docs/marketing/college-launch.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/marketing/college-launch.md) (new this window) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/operator-guide.md) ·
[`docs/agent-engine-decision.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/agent-engine-decision.md) ·
[`docs/known-limitations.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/known-limitations.md) ·
[`docs/validation-levels.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/validation-levels.md)

---

## 2. tSearch

### 2.1 Vision

"Unseen talent discovery": find people whose ability shows up in public
artifacts (GitHub repos, technical writing) rather than credentials — starting
from named seeds (olympiad medalists, referrals), expanding outward through
their real collaboration graph (GitHub collaborators/followers, Substack,
and arbitrary web-page team/about listings), scoring on evidence of
building + thinking + pedigree, then running LLM "judges" over their actual
public work to produce a defensible, evidence-cited priority score for a
recruiter digest. The stated non-negotiable design principle
(`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **Still zero new commits — now a full 10 days of inactivity, reconfirmed
  this review.** `HEAD` is still `a52881b` ("Isolate youth wildcards on
  Score and stop dropping seed-tree neighbors below the top-80 cut"), last
  touched 2026-08-24. This remains the longest stretch of tSearch
  inactivity this document has recorded, restated plainly rather than
  interpreted (could be a pause, could be deprioritization relative to
  jobright's active nightly loop).
- **Discovery/Assessment/Presentation separation, judge system, Supabase
  scaffold, website-graph channel, marks/watchlist feature — all unchanged**
  since no commits landed. See the changelog for the full feature-wave
  detail; not re-derived here since nothing about the code changed.
- **Verify gate — not re-run this review, fourth consecutive review with
  this gap** (same sandbox limitation as jobright). Carrying forward the
  08-29 figure (typecheck clean; `npm run test` 396/396 across 62 files) as
  last-confirmed, now three reviews stale.

### 2.3 Technical direction

- **CRITICAL, and still the more urgent of the two repos' PII exposures —
  see §3.** `profiles/`/`backup/` real scraped-LinkedIn-people data was
  untracked from the working tree and gitignored on 2026-08-10, but
  **remains fully reachable in git history on this public repo** —
  reconfirmed directly this review (`git log --all -- profiles/*` still
  returns 5 commits touching real profile data; `git cat-file -p` against
  an old commit still resolves a real name, LinkedIn slug, and education
  history for at least one person). This is now the **fifteenth**
  consecutive review confirming this unpurged, on a repo whose public
  visibility has not changed. `git filter-repo` + force-push + collaborator
  re-clone remains the concrete, unexecuted unblock.
- **Everything else in this section is unchanged since the 13th/14th
  reviews** — restated briefly rather than re-derived, since zero commits
  landed to change any of it:
  - Ownership-share scoring bug and mid-run LinkedIn re-auth detection:
    both genuinely fixed 2026-08-10, audit docs still don't say so (doc
    drift, low severity, safe direction).
  - Two Playwright-audit items remain open: zero retry/trace/screenshot
    capture on LinkedIn scrape failures; `expected_country` still only
    boosts match confidence rather than hard-filtering homonyms.
  - Digest loop: Phase 3 (feedback capture) fully wired; Phase 4 is a
    basic filter/boost, not full weight-learning. Open product questions
    (global vs. per-seed digest surfacing, Substack-only filtering)
    unresolved.
  - No fail-closed CI enforcement — `.github/workflows/ci.yml` still runs
    only typecheck + tests, no forbidden-API/PII checker comparable to
    jobright's `check:forbidden`.
  - Low, doc-only staleness: `docs/system-brief.md` and
    `docs/tsearch-reuse-map.md` (still describes a dropped Phase-10
    LinkedIn-enrichment port) — both unchanged, both low severity.
- **Zero open issues, zero open PRs, reconfirmed this review directly via
  the GitHub API.**

Deeper detail (in this repo): [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/system-brief.md`](./system-brief.md) (generated, due for a refresh) ·
[`docs/assessment-rubric-architecture-audit.md`](./assessment-rubric-architecture-audit.md) (describes a bug now fixed — stale) ·
[`docs/tsearch-playwright-system-audit.md`](./tsearch-playwright-system-audit.md) (2 of 4 items now fixed — partially stale)

---

## 3. How the two projects relate

jobright-application-agent/Dispatch is a **hardened descendant** of
tSearch's session/scraping infrastructure, not an unrelated project (see
`docs/tsearch-reuse-map.md` in the jobright repo for the original reuse
plan). tSearch's product logic (olympiad scoring, GitHub graph expansion,
the seed-tree UI) was deliberately **not** ported.

**Both repos still carry the same shape of unresolved risk — real
personal/PII data reachable in git history — and this window sharpens why
that matters for jobright specifically, not just tSearch.** tSearch's
exposure is real people's LinkedIn data on a repo anyone can clone today,
unpurged for fifteen reviews. jobright's exposure is currently the
operator's own data on a now-private repo — smaller blast radius today —
but §1.3's college-launch finding means jobright's unfixed leak is the one
with a dated reason to get worse soon: a real resume-upload feature aimed
at invited students would run through the exact pipeline that has been
leaking the operator's own resume for three-plus weeks. **Recommendation
unchanged in shape, sharper in urgency for jobright:** both fixes are still
unexecuted; tSearch's has the stronger claim to "most exposed right now,"
jobright's has the stronger claim to "most urgent to close before it gets
materially worse."

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment
was dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history **on this public repo** — reconfirmed directly this review, fifteenth review in a row. No purge attempted. | The one PII exposure between the two repos that is currently world-readable by anyone who clones the repo. |
| **High → trending back toward Critical** | jobright | 6,025 tracked resume-PDF paths (435 real, up from 398 two days ago) plus the operator's phone/email in cleartext (28 files, unchanged), all still tracked in git history on a now-private repo. Four root causes reconfirmed unchanged; no purge attempted. **New this review: a dated college-launch plan (§1.3) would extend this same pipeline to real student resume uploads within weeks if shipped as-is.** | Still "only" High on today's blast radius (private repo, operator's own data), but the mitigating fact that kept this from Critical last review (private visibility) does not survive contact with the launch plan — onboarding real third-party PII into an already-leaking, unpurged pipeline would be a new and avoidable Critical incident, not a continuation of the current one. |
| **High** | jobright | Submit velocity (≥9 real submits across 4 ATS platforms, unchanged this window — no new evidence either way) continues to outpace independent gate verification — four consecutive reviews unable to re-run the gate directly, every recent fix commit's "tests green" claim self-reported only. | The inverse failure — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly. |
| **High** | jobright | `docs/current-state-and-phase56.md` still actively contradicts the repo's own state (still says live discovery "has never produced a job" against ≥9 real submits); unchanged since the 14th review's fix of `README.md` alongside it. | An operator or future agent trusting this specific doc would materially misjudge what's proven. |
| **High** | jobright | `auto:cycle`/L3 armed mode remains a genuinely unattended fill-and-submit operating mode across 4 ATS platforms, no per-run human click once armed, caps removable by the operator. | Standing line item: a deliberate, working capability with real financial/legal-identity consequences per run. |
| **Medium** | both | **Meta-risk: this document has been drafted at least fifteen times since 08-07 and never merged to `main`/`master` in either repo.** | A review process that surfaces real, worsening findings (this window: a dated pre-launch PII blocker) but has no merge path to make them visible outside this branch has a compounding trust problem. This review sent a direct operator push notification for the same reason as every prior one. |
| **Medium** | jobright | `master`'s disjoint-root history rewrite (§1.2) is now partially explained (root commit = this session's own designated branch tip) rather than a pure mystery, but the pre-rewrite branches (`claude/*-tlr33g` and earlier) are now orphaned and still independently hold the older leak content on GitHub. | Not evidence of tampering, but it means there are now *more* independently-reachable copies of the leaked data on GitHub than before the rewrite, not fewer. |
| **Medium** | jobright | Lever and Workable remain the only ATS adapters fully unverified against real DOM (per the 14th review's count; no new evidence this window). | Live-proof backlog narrowed two reviews ago (4-of-6 → 2-of-6 unverified) but hasn't closed further. |
| **Medium** | jobright | One open correctness bug carried forward: #19, Cloudflare conditional forms cross-filling an answer into the wrong field when the DOM shifts mid-fill. No new evidence this window. | Exactly the class of silent-wrong-answer bug the validation ladder exists to catch before a real submission. |
| **Medium** | tSearch | No fail-closed CI enforcement — reconfirmed this review, `.github/workflows/ci.yml` still typecheck + tests only. Unchanged since 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose. |
| **Low** | tSearch | `docs/system-brief.md` and the two audit docs are stale relative to fixes already shipped (safe direction). | Doc drift undermines trust in the others even when the drift is "safe." |
| **Low** | tSearch | Digest ranking sort-order refinement is built; true weight-learning from feedback is not. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **NEW this review — migrate off the `anon`/`service_role` Supabase key
  pair before Supabase's stated end-of-2026 deprecation.** Supabase's own
  guidance (checked this review) is moving to `sb_publishable_*`/
  `sb_secret_*` keys; this codebase's new cloud/console surface still reads
  `SUPABASE_SERVICE_ROLE_KEY` by the old name (`src/config/env.ts`,
  `src/cloud/*`). The service-role usage itself is already correctly
  server-only and RLS is already enabled on every new table (§1.2) — this
  is a forward-looking rename/rotation item, not a currently-exploitable
  gap. https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- **Gitleaks, as continuous defense-in-depth alongside (not instead of)
  fixing the four root causes** (carried forward, still unapplied) —
  [`gitleaks/gitleaks`](https://github.com/gitleaks/gitleaks), pre-commit
  hook + GitHub Action, would have caught the resume-PDF leak on every push
  regardless of the custom checker's own logic bug.
- **`ShantanuVr/playwright-self-healing-framework`** (carried forward,
  still unapplied) — zero-LLM, zero-API-key locator healing that targets
  the same DOM-drift failure class as #19 without adding a second
  nondeterministic call into a determinism-first codebase.
  https://github.com/ShantanuVr/playwright-self-healing-framework
- **A path/size-based pre-commit block via Lefthook/`.githooks`** (carried
  forward, still unapplied, now the most time-sensitive of the three given
  §1.3) — reject any staged path under `artifacts/**/materials/`, or any
  PDF over a size threshold in that tree.
  https://github.com/evilmartians/lefthook

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for the fifteenth review in a row, still the higher-priority of
  the two repos' purges on today's blast radius per §3.
- **`joaquinhuigomez/llm-judge-calibrator`** (carried forward, still
  unapplied) — position-swap evaluation across judge calls, Cohen's Kappa
  and position/verbosity/self-preference bias rates, directly runnable
  against the six existing rubric judges, none of which carry a measured
  inter-rater-agreement number. https://github.com/joaquinhuigomez/llm-judge-calibrator
- **Supabase Row-Level Security review before the dual-write lands** —
  scaffolding remains correctly gated (deny-all RLS, throws until wired)
  and unchanged; worth the same PII scrutiny once it actually lands, and
  worth reusing jobright's now-demonstrated RLS pattern (§1.2) as a
  reference rather than re-deriving one.

---

## Changelog

- **2026-09-03** — This review (15th+ attempt). Confirmed jobright: 50 new
  commits since the 14th review, almost entirely a new public-app/
  referral/Supabase-cloud/console-hosted-mode wave (invite minting,
  quota-bonus triggers, engine heartbeat, hosted console behind
  `CONSOLE_HOSTED_MODE_ENABLED`) plus a UKG Pro adapter shipped end-to-end
  and fixes #145–160; no new ATS-submit evidence beyond the 14th review's
  ≥9-across-4-platforms count. **New finding: a dated college-launch
  marketing plan** (`docs/marketing/college-launch.md`, targeting fall
  2026 recruiting season) turns the long-unfixed resume-PDF leak from an
  ongoing internal problem into a concrete pre-launch blocker — real
  student resume uploads are planned but not yet built
  (`qa-2026-09-02.md` confirms only fixture-router coverage exists today),
  so no third-party PII has leaked yet, but the pipeline that would carry
  it is the same one leaking the operator's own data. PII leak re-measured
  directly: 6,025 tracked resume-PDF paths (435 real, up from 5,128/398
  two days ago), operator phone/email unchanged (28 files). Partially
  explained (not resolved) the `master` disjoint-root rewrite: the new
  root commit is exactly this session's own designated branch tip,
  consistent with a per-session squash mechanism rather than tampering —
  but the new root's tree already contains the full leak, so this was not
  a purge, and pre-rewrite branches now sit as additional orphaned copies
  of the older leak on GitHub. Confirmed tSearch: zero new commits for a
  full 10 days; PII-history exposure reconfirmed unpurged for the 15th
  review in a row on a still-public repo. Neither repo has open issues or
  PRs (confirmed via live GitHub API). Verified the new Supabase schema
  directly (RLS on every table, service-role key server-only) rather than
  assuming risk by default given it's new surface — found it well-built,
  with one forward-looking amendment (key-pair migration deadline). Sent
  one operator push notification on completion given the college-launch
  finding. Pushed to this session's assigned branches; did not assume this
  lands on `main`/`master` without a human merging it.
- **2026-09-01** — 14th+ attempt. Confirmed jobright: 3 more real
  `LIVE_MUTATION_CONFIRMED` submits landed 08-31 evening (Stripe, Nuvo via
  Gem — first-ever Gem submit, TIAA via Workday — first-ever Workday
  submit), bringing the running total to ≥9 across 4 ATS platforms. Found
  and corrected a stale claim in the 13th review (#21 was fixed 08-30, not
  carried forward unfixed); #19 remains the one open correctness bug.
  `README.md`'s current-state section was rewritten and is now accurate;
  `current-state-and-phase56.md` and `agent-engine-decision.md` remain
  stale. PII leak: 5,128 tracked resume-PDF paths (398 real, up from
  4,086/360 two days ago), operator phone/email unchanged (1 / 28 files).
  New finding: jobright flipped from public to private; `master`'s git
  history was force-rewritten to a disjoint root. Confirmed tSearch: zero
  new commits for 8 days; PII-history exposure unpurged for the 14th
  review in a row. Neither repo had open issues or PRs. Added Gitleaks as
  a new jobright amendment. Sent an operator push notification.
- **2026-08-31** — 13th+ attempt. Confirmed jobright: 50 new commits since
  08-29, a second overnight L3 automation window. 4 new real
  `LIVE_MUTATION_CONFIRMED` submits (Neuralink, Old Mission, DV Trading,
  Exa), running total 6 in 4 days. Workday reached a live pre-submit gate
  but did not submit (#83). PII leak accelerated sharply: 574→4,086
  tracked paths (194→360 real) in two days. Flagged submit velocity
  outpacing verification. Confirmed tSearch: zero new commits for a full
  week, PII-history exposure unpurged. Neither repo had open issues or
  PRs. Replaced amendments with `playwright-self-healing-framework` and
  `llm-judge-calibrator`. Sent an operator push notification.
- **2026-08-29** — 12th+ attempt. Found the resume-PDF leak had real
  content (not just placeholders) and a second leak (operator phone/email
  cleartext, 27 files). Sent two operator push notifications mid-review.
  Confirmed jobright: 19 new commits, ATS board discovery live, 2 real
  submits (Figma, Stripe). Confirmed tSearch: zero new commits since
  08-24. Re-ran both repos' verify gates directly (last time possible).
  Added Skyvern and RULERS/Judge-Reliability-Harness as amendment
  candidates.
- **2026-08-27 and earlier (2nd–12th reviews)** — See prior branch history
  (`claude/epic-pasteur-*` / `claude/busy-clarke-*`, none merged) for the
  full incremental record: PII-history exposure found and reconfirmed
  unpurged on every cycle since 08-07; ownership-share and mid-run-auth
  fixes landed and verified 08-10/11; jobright's resume-PDF leak first
  found 08-11 (183 paths) and reconfirmed worse on every subsequent review
  through 08-27 (574 by that review); a large jobright feature wave (ATS
  discovery, Lever/Ashby/Workday/Workable adapters, Stagehand engine,
  console redesign, operator-handoff ergonomics) landed 08-09 through
  08-26; a large tSearch feature wave (autonomy/oracle package, digest
  feedback capture, youth wildcards, corroborated-GitHub, Supabase
  scaffold, website graph) landed 08-10 through 08-24.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly rather than relying solely on subagent
  report.
