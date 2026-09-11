# Product vision & technical direction — Dispatch (jobright-application-agent) + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch` — keep
both files identical when editing. This is a **living document**, refreshed
by a scheduled review. It is not a proof log or a phase-status doc (those
already exist per-repo — see the "Deeper detail" links below) — it exists so
both projects' vision, architecture, and direction stay legible from one
place, and so risks that only show up when you look at *both* repos together
(shared lineage, shared operator, shared data-handling posture) don't get
missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-09-11 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**private**; product name "Dispatch"), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **eighteenth** attempt at this document
since 2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and **never merged to `master`/`main`** — reconfirmed directly this review
(both default branches still carry only the original 08-07 `defde99` commit
for this file; this review's own designated branches,
`claude/busy-clarke-11odfx` / `claude/epic-pasteur-11odfx`, are themselves
another single-use pair, starting from the same structural position as the
seventeen before them — see the meta-risk in §4, unresolved for seven
cycles running now since first elevated to Critical). The 17th review
diagnosed the mechanism (real feature work lands via a persistent,
repeatedly-folded branch; this review is issued a fresh single-use branch
every run with nothing that folds it forward) and recommended flagging it to
the operator directly rather than unilaterally opening a PR or merging —
this review does the same, via push notification, since nothing in the
repos indicates that recommendation has been acted on yet. Every figure
below was re-derived directly against current `HEAD` in both repos this
session (`git log`, `git ls-tree`, direct source/diff reads, live GitHub API
queries for issues/PRs) rather than carried over from the 17th review's
text; where a figure is genuinely unchanged and wasn't independently
re-measured, that is stated explicitly.

---

## 1. jobright-application-agent ("Dispatch")

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that
automates the mechanical parts of *your own* job-application workflow —
JobRight.ai / direct ATS-board discovery → employer ATS form fill → gated
submit → outreach → Outlook drafts — while keeping every judgment call
(essays, demographics, uncertain submissions) with a human. It is explicitly
**not** trying to be a general autonomous browser agent. The product bet is
that determinism + fail-closed gating + an honest validation ladder beats an
LLM-driven agent for a task where a wrong click (an accidental real
submission, a leaked credential, an invented EEO answer) is expensive and
hard to undo.

**That single-operator framing is still concretely in tension with where the
product is being built, unchanged since the 15th–17th reviews' finding.**
`docs/marketing/college-launch.md` (~25.5KB, present on disk, **modified
again as recently as 2026-09-11 02:00 local**, i.e. hours before this
review — this plan is still an active work item, not a stale artifact)
describes turning Dispatch into a multi-user hosted product: a public app,
invite/referral growth loop, waitlist, and campus marketing collateral,
backed by a Supabase schema (RLS on every table, service-role key
server-only — see §1.2). That may be the right call, but it changes the
blast radius of every data-handling risk below from "the operator's own
data" to "every invited student's resume and contact info," and the
pipeline that would carry that data is the same one that has been leaking
the operator's own resume PDFs into git for over a month, at an
**accelerating** rate this cycle (§1.3, §4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; TypeScript `agent/stagehand/`, evaluation-only) / Supabase (Postgres + Auth + Storage) as the backing store for the public-app surface, gated behind `SUPABASE_SYNC_ENABLED` / `CONSOLE_HOSTED_MODE_ENABLED` (both still present in `.env.example` this review).
- **Source of truth:** SQLite (`data/app.sqlite`, gitignored) for the operator-facing engine, plus append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`). The public-app surface has its own Supabase Postgres store (`supabase/migrations/`) — a second persistence layer.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, `FAILED_RETRYABLE`/`FAILED_FINAL` terminals, human `review:resolve` only (three exits — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` stays confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; predicted/generated text requires an explicit human "Approve & save."
- **The system is actively running unattended, right now, at real volume — directly observed this review, not inferred.** `master`'s tip commits at review time are a dense stream of `art: automation session … (autopush)` / `art: auto-cycle report … (autopush)` entries — 46 autopush commits in the 2 days since the 17th review (2026-09-09 → 09-11), timestamped as recently as ~30 minutes before this review ran. This is the L3 armed-session/`auto:cycle` model (§1.2 prior text, unchanged) actually exercising its standing authorization at a sustained multi-times-per-hour cadence, not a theoretical concern.
- **The "operator confirmation" invariant is still redefined at the authorization-posture level, not weakened at any individual gate — reconfirmed by direct source read this review, unchanged in mechanism.** `src/automation/armSession.ts` implements an L3 armed-session model: the operator arms a session with a time-boxed window and a numeric submit budget, consumed atomically immediately before the actual submit click so a failed attempt never burns a slot. One small reliability change landed in the window (`worker_pid` tracking added to `ArmMetadata`, so a crashed cycle's dead PID gets swept immediately instead of blocking the next two cycles on the 15-minute heartbeat timeout, per issue #206) — this hardens the *mechanics* of the standing-arm model, it does not touch the authorization question itself. `src/automation/autoCycle.ts` still carries the comment (unchanged text, not re-read byte-for-byte this cycle but no diff against it in the review window): *"Governance: installing/enabling the scheduled task IS the standing human authorization."* No operator decision on record across **seven** review cycles now.
- **Sender-trust magic-link handling remains a real, code-verified security loosening — no diff against `src/gmail/verificationParsers.ts` in the 09-09→09-11 window, so the 17th review's direct line-level read stands unchanged for a sixth consecutive review.** Domain affinity to the sender or an allowlist is worth `+2` (a ranking boost), and *independently* any `https://` link whose path contains a verification-shaped keyword (`verify|confirm|magic|auth|token|activate|login|click`) is also worth `+2` — either alone clears the `score > 0` bar with zero sender-domain requirement, no SPF/DKIM check anywhere in the chain. The nav-agent sidecar then navigates to the winning link with the operator's authenticated browser session.
- **ATS coverage:** Greenhouse, Ashby, Lever, Workable, Workday, plus a UKG Pro shadow-DOM apply path and a generic adapter with ATS-handoff detection. Only 4 non-autopush commits landed between the 17th review and this one (2026-09-09 → 09-11, PRs #251–#254): a Greenhouse per-location/mirror-board dedup fix, a fill-healer cross-question write-isolation fix plus a Lever id-less-checkbox test, and two outreach-flow fixes (JobRight first-run overlay dismissal, multi-step tour + async insider section). No new ATS family, no new named live submit. `README.md`'s "Current state (2026-08-31)" section still names 5 `LIVE_MUTATION_CONFIRMED` submits directly (Neuralink, Old Mission, DV Trading via Greenhouse; Exa via Ashby); prior reviews' changelog records 4 more (Stripe, Nuvo via Gem, TIAA via Workday) for a carried-forward, not-independently-re-confirmed total of **≥9 real submits across 4 ATS platforms** — still no live DB in this sandbox to re-check directly, an eighth consecutive review with this gap.
- **Repo visibility: private**, reconfirmed this review via the GitHub API (zero open issues, zero open PRs).
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **The `artifacts/`-tracked resume-PDF leak is not decelerating — it re-accelerated this cycle — and all root causes are still unfixed, now five-plus weeks after first being found.** Re-measured directly against current `master` HEAD this review, full tree count not a sample:
  - **9,976 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths** — up from 7,914 two days ago, **+2,062 files in 2 days
    (+26.1%)**. This *reverses* the 17th review's "deceleration" reading
    (which had it at +5.2% over the prior 2 days, down from +25%/4-days
    before that): the rate is now back above the original 25%-over-4-days
    pace when normalized per day. The prior review's characterization of a
    stabilizing trend should not be carried forward — treat the true trend
    as noisy/accelerating, not converging, until several more data points
    say otherwise.
  - **Root causes unchanged, reconfirmed by direct file read this review**:
    `.gitignore`'s `artifacts/` line is still commented out
    (`# artifacts/`, confirmed this review); no `.git/hooks/pre-commit` is
    installed (confirmed this review) despite CLAUDE.md explicitly
    forbidding committing real resumes/PDFs. `artifactAutopush.ts` was not
    re-read line-by-line this cycle (unchanged from 16th/17th reviews'
    finding, not independently reconfirmed). **No purge has been attempted
    at any point in this document's eighteen review cycles.**
  - Operator-contact-info-in-log-artifacts figure not re-measured this
    review (16th review: 6 files on a strict email-regex check).
- **Phase-status docs remain internally contradictory, unchanged since the
  14th review** — `docs/current-state-and-phase56.md` shows no diff against
  the 17th review's snapshot (reconfirmed via direct branch diff this
  review), so its verbatim claim stands: *"the live HTML differs from the
  capture... Every application currently in SQLite is fixture-derived. The
  live discovery path has never produced a job."* This directly contradicts
  `README.md`'s own "Current state (2026-08-31)" section describing 5+
  named live submits — and now also contradicts the directly-observed
  46-autopush-commits-in-2-days finding above, which makes "never produced a
  job" harder to square with what's actually running. Five review cycles as
  a one-line-priority "next up" item without being actioned.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand-vs-`browser_use`
  comparison actually running.
- **Next up, in priority order:** (1) fix the `artifacts/` leak's root
  causes (uncomment `artifacts/` in `.gitignore` at minimum for new writes,
  install the pre-commit hook, then purge history) **before** any real
  resume-upload feature ships to invited students — a pre-launch gate per
  §1.1, now more urgent given the growth re-acceleration; (2) get the
  operator's direct read on whether the L3/`auto:cycle` authorization model
  (§1.2) matches intent — seven cycles unconfirmed, and now directly
  observed running at a sustained multi-times-per-hour cadence; (3) rewrite
  `current-state-and-phase56.md` from the accurate `README.md`; (4) close
  the sender-trust magic-link gap — six cycles unaddressed; (5) get
  independent, non-self-reported confirmation of the verify gate; (6) let
  the Stagehand comparison actually run.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
`docs/architecture.md` · `docs/current-state-and-phase56.md` (stale — see
above) · `docs/marketing/college-launch.md` (active — modified this
morning) · `docs/operator-guide.md` · `docs/agent-engine-decision.md` ·
`docs/known-limitations.md` · `docs/validation-levels.md`

---

## 2. tSearch

### 2.1 Vision

"Unseen talent discovery": find people whose ability shows up in public
artifacts (GitHub repos, technical writing) rather than credentials —
starting from named seeds (olympiad medalists, referrals), expanding outward
through their real collaboration graph (GitHub collaborators/followers,
Substack, and arbitrary web-page team/about listings), scoring on evidence of
building + thinking + pedigree, then running LLM "judges" over their actual
public work to produce a defensible, evidence-cited priority score for a
recruiter digest. The stated non-negotiable design principle
(`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend / a Supabase scaffold (deny-all RLS, throws until wired).
- **Still zero new commits.** `HEAD` is still `a52881b` ("Isolate youth wildcards on Score and stop dropping seed-tree neighbors below the top-80 cut"), dated 2026-08-24 — **18 days of inactivity**, reconfirmed directly this review, the longest stretch this document has recorded (up from 16 days at the 17th review).
- **Discovery/Assessment/Presentation separation, judge system (six rubric judges), Supabase scaffold, website-graph channel, marks/watchlist feature — all unchanged**, no commits landed to change any of it.
- **Verify gate not independently re-run this review** (no `node_modules` in this sandbox, seventh consecutive review with this gap). Last independently-confirmed figure (2026-08-29): typecheck clean, 396/396 tests across 62 files.

### 2.3 Technical direction

- **CRITICAL, and still the more urgent of the two repos' PII exposures on
  today's blast radius — see §3.** `profiles/`/`backup/` real scraped-LinkedIn
  data is untracked from the current working tree (confirmed: `git ls-files`
  returns 0 matches) but **remains fully reachable in git history on this
  public repo** — reconfirmed directly this review: `git log --all
  --diff-filter=A --name-only -- profiles/* backup/*` still resolves 202
  distinct file paths across the commits that added them (unchanged count
  from the 17th review — expected, since no purge has been attempted and no
  new profile data has been committed either). The repo remains
  world-clonable and world-readable right now via
  `github.com/skale-07/tSearch`. **This is now the eighteenth consecutive
  review confirming this unpurged.** `git filter-repo` + force-push +
  collaborator re-clone remains the concrete, unexecuted unblock.
- **Everything else in this section is unchanged since the 13th–17th
  reviews** — restated briefly rather than re-derived, since zero commits
  landed to change any of it:
  - Ownership-share scoring bug and mid-run LinkedIn re-auth detection: both
    fixed 2026-08-10, not re-verified again this specific cycle (last
    directly re-read at the 16th review).
  - Two Playwright-audit items remain open: zero retry/trace/screenshot
    capture on LinkedIn scrape failures; `expected_country` still only
    boosts match confidence rather than hard-filtering homonyms.
  - Digest loop: Phase 3 (feedback capture) wired; Phase 4 is a basic
    filter/boost, not full weight-learning. Open product questions (global
    vs. per-seed digest surfacing, Substack-only filtering) unresolved.
  - No fail-closed CI enforcement — no equivalent of jobright's
    `check:forbidden`.
  - Low, doc-only staleness: `docs/system-brief.md` and
    `docs/tsearch-reuse-map.md`.
- **Zero open issues, zero open PRs**, reconfirmed this review directly via
  the GitHub API. Closed-PR history (#1–#6) shows tSearch's own real feature
  work also lands via a small number of persistent, repeatedly-folded
  branches (`claude/talent-discovery-pipeline-bfunzx`), the same pattern
  jobright shows — see the provenance note above.

Deeper detail (in this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` ·
`docs/email-digest-implementation-context.md` · `docs/system-brief.md`
(generated, due for a refresh) · `docs/assessment-rubric-architecture-audit.md`
(describes a bug now fixed — stale) · `docs/tsearch-playwright-system-audit.md`
(2 of 4 items now fixed — partially stale)

---

## 3. How the two projects relate

jobright-application-agent/Dispatch is a **hardened descendant** of
tSearch's session/scraping infrastructure, not an unrelated project (see
`docs/tsearch-reuse-map.md` in the jobright repo for the original reuse
plan). tSearch's product logic (olympiad scoring, GitHub graph expansion,
the seed-tree UI) was deliberately **not** ported.

**Both repos carry the same shape of unresolved risk — real personal/PII
data reachable in git history — and remain diverging in which one is more
urgent for a different reason each.** tSearch's exposure is real third
parties' LinkedIn data on a repo anyone can clone *today*, unpurged for
eighteen reviews — the higher-urgency exposure on current blast radius.
jobright's exposure is currently the operator's own data on a private repo —
smaller blast radius today — but it continues growing, **now at a
re-accelerated rate**, with no fix in sight, and §1.1's college-launch plan
(actively being edited, not shelved) gives it a dated reason to become a
third-party-PII incident if shipped before the root causes are fixed.
**Recommendation unchanged in shape across every review that has made it:
both purges are still unexecuted, and jobright's now has a deadline
tSearch's does not.**

Both repos have also converged on the same operating-posture pattern: a
scheduled, unattended automation loop with real consequences if its gates
ever fail — jobright's `auto:cycle` (real ATS submissions, now
directly confirmed running at a sustained multi-times-per-hour cadence, no
per-run human click once the standing `.env`/task exist — §1.2/§1.3) and
tSearch's autopilot chain (sweep → resolve → discovery → assessment → digest
→ send, fail-closed to mock LLM / dry-run send by default, though tSearch
has had zero commits or runs recorded in 18 days so this is dormant in
practice, not just safely configured). tSearch's *default configuration* is
still the safer of the two, but the *shape* of risk is now identical across
both repos, and jobright's instance of it is the one currently live.

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment was
dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | **This document has now been drafted at least eighteen times since 2026-08-07 and has never once been merged to `main`/`master` in either repo.** Real feature work lands via a *persistent* branch repeatedly folded into `master`/`main`; the vision-doc review is issued a *fresh single-use branch* every run with no PR ever opened and nothing that folds it forward — it sits outside the one mechanism everything else uses to land. | A review process with no path into the branch that actually reaches `master` doesn't reduce risk, it documents it privately and repeatedly. The compounding cost is concrete: the resume-PDF leak has grown from 183 to 9,976 files — and just re-accelerated — while every finding about it sat on an unmerged branch. Unresolved for **seven cycles** running since first elevated to Critical (15th→16th). This review is escalating it via push notification rather than drafting an eighteenth silent variant. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history **on this public repo** — reconfirmed directly this review, eighteenth review in a row, no purge attempted. | The one PII exposure between the two repos that is currently world-readable by anyone who clones the repo, right now, with zero prerequisite access. |
| **High** | jobright | 9,976 tracked resume-PDF paths (+26.1% in the last 2 days — the growth **re-accelerated**, reversing the prior review's "decelerating" read), all root causes reconfirmed unchanged, no purge attempted in eighteen cycles. A dated, actively-edited college-launch plan (§1.1/§1.3) would extend this exact pipeline to real student resume uploads if shipped as-is. | The trend is not converging toward safe; it should be treated as actively worsening until proven otherwise. |
| **High** | jobright | The "operator confirmation" authorization model for real submissions is a standing, scheduled, self-arming `auto:cycle` task (§1.2), now **directly confirmed running** at 46 autopush commits in 2 days (a multi-times-per-hour cadence) with a real (if capped) submit budget. No operator has confirmed this matches intent across seven review cycles. | This is no longer a theoretical drift risk — the system is observably doing exactly what the design allows, unattended, right now. |
| **High** | jobright | Sender-trust magic-link handling (`extractMagicLink`) accepts any HTTPS link with a verification-shaped keyword and zero sender-domain requirement, and the nav-agent sidecar navigates there using the operator's authenticated session. Six cycles unaddressed. | A genuine, code-verified phishing-surface widening, not a hypothetical, on a system with an authenticated session live. |
| **High** | jobright | `docs/current-state-and-phase56.md` still contradicts `README.md` and the repo's own committed submit/automation evidence. Five cycles as a flagged, same-day-sized doc fix. | An operator or future agent trusting this specific file would materially misjudge what's actually proven and what's actually running. |
| **High** | jobright | Submit velocity (≥9 real submits across 4 ATS platforms, carried forward, not independently re-confirmed) continues to outpace independently-verified gate confirmation — eighth consecutive review unable to re-run the gate directly. | The inverse failure mode — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly, on a system submitting real applications on an hourly-or-faster unattended schedule. |
| **Medium** | jobright | Lever and Workable remain the two ATS adapters with no live-DOM evidence per the last review to check (not re-verified this cycle). | Live-proof backlog narrowed earlier in the project's history but hasn't closed further recently. |
| **Medium** | tSearch | No fail-closed CI enforcement — no equivalent of jobright's `check:forbidden`. Unchanged since first flagged 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing mechanical to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose after the fact. |
| **Low** | tSearch | `docs/system-brief.md` and the two audit docs are stale relative to fixes already shipped (safe direction). | Doc drift undermines trust in the others even when the drift itself is safe. |
| **Low** | tSearch | True weight-learning from digest feedback is not built. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

Not independently re-searched this cycle beyond a light recheck — the
existing list remains valid and, notably, **still unexecuted after multiple
reviews recommending it**, which is now more informative than finding new
candidates would be.

**jobright-application-agent / Dispatch**

- **A path/size-based pre-commit block (Lefthook, or a plain `.githooks`
  script)** — carried forward for the fifth+ review in a row, still the
  single most time-sensitive suggestion given §1.3/§4: reject any staged
  path under `artifacts/**/materials/`, or any PDF over a trivial size
  threshold, at commit time. This alone would have stopped the leak at file
  #1 rather than file #9,976. https://github.com/evilmartians/lefthook
- **Gitleaks** — continuous defense-in-depth alongside, not instead of,
  fixing the root causes. https://github.com/gitleaks/gitleaks
- **`ShantanuVr/playwright-self-healing-framework`** — zero-LLM,
  zero-API-key locator healing targeting the same DOM-drift failure class as
  the project's Cloudflare conditional-form bug, without adding a second
  nondeterministic call into a determinism-first codebase.
  https://github.com/ShantanuVr/playwright-self-healing-framework

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for the eighteenth review in a row. Pair with GitHub push
  protection using a custom secret-scanning pattern matching the
  scraped-profile JSON shape (name + LinkedIn URL + photo URL) as recurrence
  prevention.
- **`joaquinhuigomez/llm-judge-calibrator`** — position-swap evaluation,
  Cohen's Kappa, position/verbosity/self-preference bias rates, directly
  runnable against the six existing rubric judges, none of which carry a
  measured inter-rater-agreement number today.
  https://github.com/joaquinhuigomez/llm-judge-calibrator
- **Reuse jobright's Supabase RLS pattern** (§1.2) as the reference once
  tSearch's own deny-all scaffold gets wired to a live dual-write.

---

## Changelog

- **2026-09-11 (18th review)** — Re-derived headline figures directly
  against current `HEAD` in both repos. jobright: resume-PDF leak now 9,976
  tracked paths (up from 7,914 two days ago, **+26.1%** — a
  re-acceleration that reverses the 17th review's "decelerating" read; both
  root causes reconfirmed by direct file read, `.gitignore` still comments
  out `artifacts/`, no pre-commit hook installed). Directly observed
  `auto:cycle` running live — 46 autopush commits in the 2-day window, a
  multi-times-per-hour cadence — upgrading the standing-authorization risk
  from "unconfirmed drift" to "confirmed live behavior." Diffed
  `armSession.ts`, `verificationParsers.ts`, and
  `current-state-and-phase56.md` directly against the 17th review's branch
  state: only `armSession.ts` changed, a dead-PID sweep (issue #206) that
  hardens mechanics without touching the authorization question. Only 4
  non-autopush commits landed in the window (PRs #251–#254), all hardening
  fixes, no new ATS surface. `docs/marketing/college-launch.md` confirmed
  modified again this morning — the multi-user hosted-product plan is an
  active work item. tSearch: reconfirmed zero commits, now 18 days of
  inactivity (up from 16); reconfirmed the PII-history exposure unpurged
  (202 paths, same count as the 17th review, consistent with no new commits
  landing on either side of that exposure). Both repos: zero open issues,
  zero open PRs, confirmed live via the GitHub API. Did not open a PR for
  this review's branch (out of scope without an explicit ask) or attempt
  either PII/resume purge (destructive, history-rewriting, requires
  explicit operator go-ahead) — flagged the unresolved Critical meta-risk
  and the resume-leak re-acceleration to the operator via push notification,
  as the 17th review recommended.
- **2026-09-09 (17th review) and earlier (2nd–16th reviews)** — See prior
  branch history (`claude/epic-pasteur-*` / `claude/busy-clarke-*`, none
  merged) for the full incremental record: PII-history exposure found and
  reconfirmed unpurged on every cycle since 08-07; ownership-share and
  mid-run-auth fixes landed and verified 08-10/11; jobright's resume-PDF
  leak first found 08-11 (183 paths), reconfirmed worse on every subsequent
  review (574 by 08-27, 4,086 by 08-31, 6,025 by 09-03, 7,522 by 09-07,
  7,914 by 09-09); a large jobright feature wave (ATS discovery,
  Lever/Ashby/Workday/Workable/UKG adapters, Stagehand engine spike, console
  redesign, public-app/Supabase/referral wave, ≥9 real ATS submits across 4
  platforms) landed 08-09 through 09-03; a large tSearch feature wave landed
  08-10 through 08-24, then went quiet. Meta-risk elevated Medium→Critical
  at the 16th review; 17th review diagnosed the concrete branch-folding
  mechanism behind it.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly rather than relying solely on subagent
  report.
