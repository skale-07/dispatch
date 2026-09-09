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
| Last reviewed | 2026-09-09 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**private**; product name "Dispatch"), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **seventeenth** attempt at this document
since 2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and **never merged to `master`/`main`** — reconfirmed directly this review
(both default branches still carry only the original 08-07 `defde99` commit
for this file; this review's own designated branches,
`claude/busy-clarke-8qn1el` / `claude/epic-pasteur-8qn1el`, are themselves
another single-use pair, starting from the same structural position as the
sixteen before them — see the meta-risk in §4). **This review can now name a
concrete, previously-undiagnosed contributing cause**, found by listing
closed PRs via the GitHub API rather than just checking "open PRs = 0" as
prior reviews did: jobright's real feature work (the Dispatch rename, every
ATS adapter, the console redesign — PRs #40–#69) lands on one **persistent**
branch (`claude/browser-use-job-applications-2o154z`) that gets folded into
`master` repeatedly, with a PR opened and closed alongside each fold as a
paper trail (`merged: false` on all of them — the fold happens via a direct
push/rebase into `master`, not GitHub's merge button, so the flag doesn't
reflect it landing). tSearch's real feature work shows the same shape on its
own long-lived branches. The vision-doc review, by contrast, is issued a
**fresh single-use branch name every run** with no PR ever opened against it
and nothing that later folds it into the persistent branch or `master` — it
is structurally excluded from the exact mechanism that lands everything
else. Every figure below was re-derived directly against current `HEAD` in
both repos this session (`git ls-files`, `git log --all`, direct source
reads, live GitHub API queries for issues/PRs/repo visibility) rather than
carried over from the 16th review's text; where a figure is genuinely
unchanged and wasn't independently re-measured, that is stated explicitly.

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
product is being built, unchanged since the 15th/16th reviews' finding.**
`docs/marketing/college-launch.md` (25.5KB, present on disk, last modified
2026-09-09 per this sandbox's filesystem — not independently re-read in
full this cycle) describes turning Dispatch into a multi-user hosted
product: a public app, invite/referral growth loop, waitlist, and campus
marketing collateral, backed by a Supabase schema (RLS on every table,
service-role key server-only — see §1.2). That may be the right call, but it
changes the blast radius of every data-handling risk below from "the
operator's own data" to "every invited student's resume and contact info,"
and the pipeline that would carry that data is the same one that has been
leaking the operator's own resume PDFs into git for over a month (§1.3, §4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; TypeScript `agent/stagehand/`, evaluation-only) / Supabase (Postgres + Auth + Storage) as the backing store for the public-app surface, gated behind `SUPABASE_SYNC_ENABLED` / `CONSOLE_HOSTED_MODE_ENABLED` (both still present in `.env.example` this review).
- **Source of truth:** SQLite (`data/app.sqlite`, gitignored) for the operator-facing engine, plus append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`). The public-app surface has its own Supabase Postgres store (`supabase/migrations/`) — a second persistence layer.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, `FAILED_RETRYABLE`/`FAILED_FINAL` terminals, human `review:resolve` only (three exits — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` stays confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; predicted/generated text requires an explicit human "Approve & save."
- **The "operator confirmation" invariant is still redefined at the authorization-posture level, not weakened at any individual gate — reconfirmed by direct source read this review, unchanged in mechanism.** `src/automation/armSession.ts` implements an L3 armed-session model: the operator arms a session with a time-boxed window and a numeric submit budget, consumed atomically immediately before the actual submit click so a failed attempt never burns a slot. `src/automation/autoCycle.ts` still carries the comment (read directly, line 42, unchanged text): *"Governance: installing/enabling the scheduled task IS the standing human authorization."* Every underlying gate (fail-closed defaults, atomic budget consumption, `AUTOMATION_ENABLED` kill switch) is intact — the *authorization model* is what moved from "a human confirms this specific submission" to "a human configured a machine to confirm submissions on its behalf, on a schedule, for hours at a time." No operator decision on record across six review cycles now.
- **Sender-trust magic-link handling remains a real, code-verified security loosening — reconfirmed by direct read this review (`src/gmail/verificationParsers.ts:extractMagicLink`, lines 105–141), unchanged in mechanism for a fifth consecutive review.** Domain affinity to the sender or an allowlist is worth `+2` (a ranking boost), and *independently* any `https://` link whose path contains a verification-shaped keyword (`verify|confirm|magic|auth|token|activate|login|click`) is also worth `+2` — either alone clears the `score > 0` bar with zero sender-domain requirement, no SPF/DKIM check anywhere in the chain. The nav-agent sidecar then navigates to the winning link with the operator's authenticated browser session. Downstream congruence + final-URL validation still bound the *application-data* blast radius, but the browser still visits an attacker-influenced URL on a phishing-style email with a live authenticated session.
- **ATS coverage:** Greenhouse, Ashby, Lever, Workable, Workday, plus a UKG Pro shadow-DOM apply path and a generic adapter with ATS-handoff detection. No new ATS family or new named live submit was found in the 15 commits that landed between the 16th review and this one (2026-09-07 → 09-09) — those were discovery/nav-parsing hardening (US-only postings, board-postings dedup, description-region reads, resume-chip upload polling, identity-provider login-wall detection, a navigation-supervisor context fix) and a Greenhouse verifier tolerance fix for in-flight navigation after the submit click, not new ATS surface. `README.md`'s "Current state (2026-08-31)" section still names 5 `LIVE_MUTATION_CONFIRMED` submits directly (Neuralink, Old Mission, DV Trading via Greenhouse; Exa via Ashby); prior reviews' changelog records 4 more (Stripe, Nuvo via Gem, TIAA via Workday) for a carried-forward, not-independently-re-confirmed total of **≥9 real submits across 4 ATS platforms** — still no live DB in this sandbox to re-check directly, a seventh consecutive review with this gap.
- **Repo visibility: private**, reconfirmed this review via the GitHub API (`"private": true`, `"visibility": "private"`).
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **The `artifacts/`-tracked resume-PDF leak is still growing, still fully live, and all four root causes are still unfixed — now five-plus weeks after first being found.** Re-measured directly against current `HEAD` (`1329c66f`, 2026-09-08) this review, full sweep not a sample:
  - **7,914 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths** — up from 7,522 two days ago (+5.2% in 2 days) and 183 when
    first found on 2026-08-11 (a growth-rate deceleration from the 25%/4-day
    rate the 16th review flagged, but still net growth with zero fix
    applied). A 500-file random sample this review found the same real-vs-
    placeholder mix as before (about 7% real content: 45-byte placeholder
    the rest, 113,381/76,462/74,509/113,810-byte real-content variants
    present in the sample) — consistent with, not independently
    recalculated against, the 16th review's 480-real-file figure.
  - **Root causes unchanged, reconfirmed by direct file read this review**:
    `.gitignore`'s `artifacts/` line is still commented out
    (`# artifacts/`); no `.git/hooks/pre-commit` is installed (`ls
    .git/hooks/pre-commit` → not found) despite CLAUDE.md explicitly
    forbidding committing real resumes/PDFs. `artifactAutopush.ts` was not
    re-read line-by-line this cycle (unchanged from 16th review's finding,
    not independently reconfirmed). **No purge has been attempted at any
    point in this document's seventeen review cycles.**
  - Operator-contact-info-in-log-artifacts figure not re-measured this
    review (16th review: 6 files on a strict email-regex check).
- **`master`'s "disjoint-root" finding from the 16th review did not
  reproduce this cycle and should not be carried forward as-is.** This
  review's direct check (`git log --oneline --max-parents=0`) finds a single,
  ordinary root commit (`d64ab01d`, dated 2026-07-17, "Initialize Phase 0–1
  skeleton") — not a rewritten root matching a prior session's branch tip.
  Either the 16th review was looking at a transient state that has since
  been superseded by a normal linear history, or its comparison method
  differed from this one; either way, this review found no evidence of it
  and is not asserting it as a live risk pending a repeat sighting.
- **Phase-status docs remain internally contradictory, unchanged since the
  14th review** — `docs/current-state-and-phase56.md` still states, verbatim
  and unchanged (read directly this review, lines 177–179): *"the live HTML
  differs from the capture... Every application currently in SQLite is
  fixture-derived. The live discovery path has never produced a job."* This
  directly contradicts `README.md`'s own "Current state (2026-08-31)"
  section describing 5+ named live submits. Four review cycles as a
  one-line-priority "next up" item without being actioned.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand-vs-`browser_use`
  comparison actually running.
- **Next up, in priority order:** (1) fix the `artifacts/` leak's root
  causes (uncomment `artifacts/` in `.gitignore` at minimum for new writes,
  install the pre-commit hook, then purge history) **before** any real
  resume-upload feature ships to invited students — a pre-launch gate per
  §1.1; (2) get the operator's direct read on whether the L3/`auto:cycle`
  authorization model (§1.2) matches intent — six cycles unconfirmed;
  (3) rewrite `current-state-and-phase56.md` from the accurate `README.md`;
  (4) close the sender-trust magic-link gap — five cycles unaddressed;
  (5) get independent, non-self-reported confirmation of the verify gate;
  (6) let the Stagehand comparison actually run.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
`docs/architecture.md` · `docs/current-state-and-phase56.md` (stale — see
above) · `docs/marketing/college-launch.md` ·
`docs/operator-guide.md` · `docs/agent-engine-decision.md` ·
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
- **Still zero new commits.** `HEAD` is still `a52881b` ("Isolate youth wildcards on Score and stop dropping seed-tree neighbors below the top-80 cut"), dated 2026-08-24 — **16 days of inactivity**, reconfirmed directly this review, the longest stretch this document has recorded (up from 14 days at the 16th review).
- **Discovery/Assessment/Presentation separation, judge system (six rubric judges), Supabase scaffold, website-graph channel, marks/watchlist feature — all unchanged**, no commits landed to change any of it.
- **Verify gate not independently re-run this review** (no `node_modules` in this sandbox, sixth consecutive review with this gap). Last independently-confirmed figure (2026-08-29): typecheck clean, 396/396 tests across 62 files.

### 2.3 Technical direction

- **CRITICAL, and still the more urgent of the two repos' PII exposures on
  today's blast radius — see §3.** `profiles/`/`backup/` real scraped-LinkedIn
  data is untracked from the current working tree (confirmed: `git ls-files`
  returns 0 matches) but **remains fully reachable in git history on this
  public repo** — reconfirmed directly this review: `git log --all
  --diff-filter=A --name-only -- profiles/* backup/*` still resolves 202
  distinct file paths across the commits that added them, one sampled
  directly this review (`profiles/madanva/.../profile.json`, still contains
  a name/handle, GitHub profile URL, and collaboration-graph metadata in the
  blob). The repo remains world-clonable and world-readable right now via
  `github.com/skale-07/tSearch` (confirmed public via `git remote -v` +
  no visibility override found). **This is now the seventeenth consecutive
  review confirming this unpurged.** `git filter-repo` + force-push +
  collaborator re-clone remains the concrete, unexecuted unblock.
- **Everything else in this section is unchanged since the 13th–16th
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
seventeen reviews — the higher-urgency exposure on current blast radius.
jobright's exposure is currently the operator's own data on a private repo —
smaller blast radius today — but it continues growing with no fix in sight,
and §1.1's college-launch plan gives it a dated reason to become a
third-party-PII incident if shipped before the root causes are fixed.
**Recommendation unchanged in shape across every review that has made it:
both purges are still unexecuted, and jobright's now has a deadline
tSearch's does not.**

Both repos have also converged on the same operating-posture pattern: a
scheduled, unattended automation loop with real consequences if its gates
ever fail — jobright's `auto:cycle` (real ATS submissions, hourly, no
per-run human click once the standing `.env`/task exist — §1.2/§1.3) and
tSearch's autopilot chain (sweep → resolve → discovery → assessment → digest
→ send, fail-closed to mock LLM / dry-run send by default). tSearch's is the
safer default configuration today, but the *shape* of risk is now identical
across both repos.

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment was
dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | **This document has now been drafted at least seventeen times since 2026-08-07 and has never once been merged to `main`/`master` in either repo.** This review identified the concrete mechanism: real feature work lands via a *persistent* branch repeatedly folded into `master`/`main`; the vision-doc review is issued a *fresh single-use branch* every run with no PR ever opened and nothing that folds it forward — it sits outside the one mechanism everything else uses to land. | A review process with no path into the branch that actually reaches `master` doesn't reduce risk, it documents it privately and repeatedly. The compounding cost is concrete: the resume-PDF leak would not have reached 7,914 files if review #1's finding had reached a human able to act on it. Unresolved for six cycles once already elevated to Critical (15th→16th). Recommendation, sharper this cycle: either point the review at the same persistent-branch mechanism real feature work uses, or have an operator directly merge one of the existing review branches by hand — this sandbox cannot open a PR unless explicitly asked to. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history **on this public repo** — reconfirmed directly this review, seventeenth review in a row, no purge attempted. | The one PII exposure between the two repos that is currently world-readable by anyone who clones the repo, right now, with zero prerequisite access. |
| **High** | jobright | 7,914 tracked resume-PDF paths, all four root causes reconfirmed unchanged, no purge attempted in seventeen cycles. A dated college-launch plan (§1.1/§1.3) would extend this exact pipeline to real student resume uploads if shipped as-is. | Growth rate decelerated (+5.2% in 2 days vs. +25% in the prior 4) but is still net-positive with zero fix applied — "today's blast radius" stays a moving target. |
| **High** | jobright | The "operator confirmation" authorization model for real submissions is a standing, scheduled, self-arming `auto:cycle` task (§1.2) — no per-run human click once installed, running hourly, with a real (if capped) submit budget. No operator has confirmed this matches intent across six review cycles. | Exactly the kind of drift that's easy to miss because no individual gate was weakened — worth a direct, on-the-record operator decision. |
| **High** | jobright | Sender-trust magic-link handling (`extractMagicLink`) accepts any HTTPS link with a verification-shaped keyword and zero sender-domain requirement, and the nav-agent sidecar navigates there using the operator's authenticated session. Five cycles unaddressed, reconfirmed unchanged by direct source read this review. | A genuine, code-verified phishing-surface widening, not a hypothetical. |
| **High** | jobright | `docs/current-state-and-phase56.md` still contradicts `README.md` and the repo's own committed submit evidence, verbatim-unchanged text reconfirmed this review. Four cycles as a flagged, same-day-sized doc fix. | An operator or future agent trusting this specific file would materially misjudge what's actually proven. |
| **High** | jobright | Submit velocity (≥9 real submits across 4 ATS platforms, carried forward, not independently re-confirmed) continues to outpace independently-verified gate confirmation — seven consecutive reviews unable to re-run the gate directly. | The inverse failure mode — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly, on a system submitting real applications on an hourly unattended schedule. |
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
  script)** — carried forward for the fourth+ review in a row, still the
  single most time-sensitive suggestion given §1.3/§4: reject any staged
  path under `artifacts/**/materials/`, or any PDF over a trivial size
  threshold, at commit time. This alone would have stopped the leak at file
  #1 rather than file #7,914. https://github.com/evilmartians/lefthook
- **Gitleaks** — continuous defense-in-depth alongside, not instead of,
  fixing the root causes. https://github.com/gitleaks/gitleaks
- **`ShantanuVr/playwright-self-healing-framework`** — zero-LLM,
  zero-API-key locator healing targeting the same DOM-drift failure class as
  the project's Cloudflare conditional-form bug, without adding a second
  nondeterministic call into a determinism-first codebase.
  https://github.com/ShantanuVr/playwright-self-healing-framework

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for the seventeenth review in a row. Pair with GitHub push
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

- **2026-09-09** — 17th+ attempt. Re-derived headline figures directly
  against current `HEAD` in both repos. jobright: resume-PDF leak now 7,914
  tracked paths (up from 7,522 two days ago, +5.2% — a deceleration from the
  prior +25%/4-day rate, still net growth, still zero fix applied); both
  root causes reconfirmed by direct file read (`.gitignore` still comments
  out `artifacts/`, no pre-commit hook installed). Reconfirmed the
  sender-trust magic-link gap and the L3/`auto:cycle` standing-authorization
  posture unchanged by direct source read (not just trusting the 16th
  review's description). Reconfirmed `current-state-and-phase56.md`'s stale
  claim verbatim-unchanged. **Could not reproduce the 16th review's
  "disjoint-root history" finding** — current `master` root is an ordinary,
  normally-dated commit; not carried forward as a live risk pending a
  repeat sighting. tSearch: reconfirmed zero commits, now 16 days of
  inactivity (up from 14); reconfirmed the PII-history exposure unpurged via
  a direct `git log --diff-filter=A` check and one direct file-content
  sample, seventeenth review in a row. Both repos: zero open issues, zero
  open PRs, confirmed live via the GitHub API. **New this cycle:** listed
  *closed* PRs (not just open) via the GitHub API and found the concrete
  mechanism behind the meta-risk — real feature work in both repos lands via
  a persistent, repeatedly-folded branch with a closed PR as a paper trail;
  the vision-doc review's single-use branch-per-run convention has never
  participated in that mechanism, which is why it never reaches `master`.
  Did not open a PR for this review's branch (out of scope without an
  explicit ask) or attempt the PII purge (destructive, history-rewriting,
  requires explicit operator go-ahead) — flagged both to the operator
  instead via a push notification, given the unresolved Critical-severity
  meta-risk and continued PII growth.
- **2026-09-07 (16th review) and earlier (2nd–15th reviews)** — See prior
  branch history (`claude/epic-pasteur-*` / `claude/busy-clarke-*`, none
  merged) for the full incremental record: PII-history exposure found and
  reconfirmed unpurged on every cycle since 08-07; ownership-share and
  mid-run-auth fixes landed and verified 08-10/11; jobright's resume-PDF
  leak first found 08-11 (183 paths), reconfirmed worse on every subsequent
  review (574 by 08-27, 4,086 by 08-31, 6,025 by 09-03, 7,522 by 09-07); a
  large jobright feature wave (ATS discovery, Lever/Ashby/Workday/Workable/UKG
  adapters, Stagehand engine spike, console redesign, public-app/Supabase/
  referral wave, ≥9 real ATS submits across 4 platforms) landed 08-09
  through 09-03; a large tSearch feature wave landed 08-10 through 08-24,
  then went quiet. Meta-risk elevated Medium→Critical at the 16th review.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly rather than relying solely on subagent
  report.
