# Product vision & technical direction — Dispatch + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/tSearch` — keep both
files identical when editing. This is a **living document**, refreshed by a
scheduled review. It is not a proof log or a phase-status doc (those already
exist per-repo — see the "Deeper detail" links below) — it exists so both
projects' vision, architecture, and direction stay legible from one place, and
so risks that only show up when you look at *both* repos together (shared
lineage, shared operator, shared data-handling posture) don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-09-15 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/dispatch` (private; formerly `jobright-application-agent`), `skale-07/tSearch` (**public**, not independently re-verified via API this pass — see §4) |

**Continuity note (read before trusting anything below the fold):** the
2026-09-13 revision of this document silently dropped two rows that the
2026-09-11 revision had just escalated to a push notification: the Critical
"this document never merges" meta-risk, and the High resume-PDF leak (then
9,976 paths). No commit message or changelog line said either was resolved —
they were simply absent. This review restores both, reconciled with current
numbers, and treats the drop itself as a finding (§4). If a future review
reads this doc and a row it expects is missing with no resolution note, do
not assume it was fixed — assume it may have been dropped the same way.

---

## 1. Dispatch (engine: the application agent)

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai
discovery → employer ATS form fill → gated submit → outreach → Gmail/Outlook
drafts — while keeping every judgment call (essays, demographics, uncertain
submissions) with a human. It is explicitly **not** trying to be a general
autonomous browser agent. The product bet is that determinism + fail-closed
gating + an honest validation ladder beats an LLM-driven agent for a task
where a wrong click (an accidental real submission, a leaked credential, an
invented EEO answer) is expensive and hard to undo.

This bet is still being tested at real scale: the operator-directed
unattended overnight loop (`src/automation/autoCycle.ts`, gated
`AUTOMATION_ENABLED`) has now been running for roughly three weeks straight,
applying to real jobs across four ATS platforms, drafting outreach in a
separate Gmail-CDP Chrome, and self-repairing bugs it hits under the same
verify gate as any other change. The honest caveat, unchanged from the prior
review: "deterministic + fail-closed" has not meant "error-free at scale" —
and this review adds a second caveat: it has also not meant "leak-free at
scale" (§4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (essay + predict-tier + triage LLM call sites, all separately flagged).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture, mostly holding under load, with one confirmed hole:** every mutation capability sits behind a named fail-closed env flag; `chromium.launch` is confined to three session-infra files; `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. The confirmed hole is the resume-PDF leak below — the secrets gate exists, runs, and is wired into a pre-commit hook, but its pattern doesn't match the files actually being produced (§4). The identity-field guard (never let a bank/predicted answer fill a name/email/phone question) named as missing in the prior two reviews is **still not built** — no code implementing field-semantic classification for the predict/bank tier was found this pass.
- **One picker bug from the 2026-09-11 handoff is now fixed:** `src/automation/worker.ts`'s `pickNextApplication` previously let a failing in-flight application bump its own `updated_at` on every failed attempt, which re-won the recency ordering and starved older rows indefinitely (issue #279, a livelock, not a park). A cooldown/stamp mechanism (`LAST_PICKED_KEY` in `versions_json`) now records each hand-out explicitly and is referenced directly against #279 in the current code — this is a real fix, confirmed by reading `worker.ts` directly, not by trusting a status doc.
- **Essay + screener prediction** remains as previously described: `src/applications/essayAutofill.ts` generates from `private/candidate/about-me.md`, gated by `validateDraft`, with a `SENSITIVE_QUESTION` fence in the predict tier after issue #259. Unchanged this cycle.
- **Validation ladder discipline vs. documentation reality — still the same gap flagged last review, not yet closed:** live Greenhouse/Lever/Ashby/Workday fill+submit, essay/predict-tier answers, and Gmail outreach are functioning at `LIVE_MUTATION_CONFIRMED` in practice, while `docs/current-state-and-phase56.md` still states (verified by reading the file directly this pass, line 277) *"The product is blocked on 1 — there is no closed loop while live discovery yields nothing,"* and `docs/ats-adapter-workday.md` still states (line 21) *"no [live] run has been performed."* Both are false as of today. This is now the **third consecutive review** (09-11, 09-13, 09-15) to confirm these specific lines are unedited.
- **ATS coverage:** unchanged — Greenhouse, Lever, Ashby, and Workday all have live submissions on record.
- **Lineage:** unchanged — the session/storage layer was deliberately hardened from tSearch; tSearch's product logic was not ported.

### 1.3 Technical direction

Unchanged headline from the prior review, now three cycles stale:
**Dispatch's own docs still say "Phase 5.6 — blocked on live discovery
returning zero jobs," while live discovery/fill/submit across four ATS
platforms has been running nightly for roughly three weeks.**

- **New this cycle, root-caused (not just re-flagged):** the resume-PDF leak
  (§4, now 14,074 tracked paths). `scripts/check-secrets-staged.ts` /
  `src/security/artifactScan.ts` runs on every commit via the installed
  `.githooks/pre-commit` hook and does check for resume files — but its
  pattern, `/resume\.pdf$/i`, only matches a literal `resume.pdf`. The actual
  file `src/jobright/resumeDownload.ts` writes for every real application is
  `` `resume-${sha8}.pdf` `` under
  `artifacts/applications/{id}/materials/` (confirmed by reading
  `resumeDownload.ts:67` directly) — a filename shape the pattern was never
  written to catch. This is not a bypassed gate or an uninstalled hook; it is
  a gate that has been faithfully running and passing on every one of the
  14,074 commits that added a leaked file, because it was checking for the
  wrong filename the whole time. The fix is a one-line regex change (e.g.
  matching `/^resume-[0-9a-f]+\.pdf$/i` in addition to the existing exact
  pattern, keeping the synthetic-fixture allowlist as-is since
  `sample-resume.pdf` already matches on its own), plus a separate,
  one-time `git filter-repo`/BFG history rewrite to remove the 14,074
  already-committed copies (coordinate with anyone holding a clone — this
  rewrites hashes).
- **Still deliberately human-only:** work-authorization status, salary, and
  demographic questions — unchanged.
- **Documentation debt remains the primary technical-direction risk apart
  from the leak** — `docs/current-state-and-phase56.md`, `known-limitations.md`,
  and both ATS adapter docs still need the rewrite named three reviews running.

Deeper detail (still stale in the ways described above): `docs/architecture.md` ·
`docs/current-state-and-phase56.md` · `docs/known-limitations.md` ·
`docs/validation-levels.md` · `artifacts/overnight-issues-2026-09-12.md`
(most recent dated issues log found; none dated 09-13 through 09-15 exist in
the tree as of this review, though `master` has ~50+ undated `art:
auto-cycle report` / `art: automation session` autopush commits in that
window — the loop is still running, it has just stopped writing dated
narrative issue logs).

---

## 2. tSearch

### 2.1 Vision

Unchanged: "unseen talent discovery" — resolve identity from public
artifacts, expand a real collaboration graph, score on evidence, run
evidence-grounded LLM judges, produce a defensible recruiter digest.

### 2.2 Core technical details

Unchanged from the 2026-09-13 review in every particular checked this pass —
and that itself is notable: **`main` has had exactly one commit since
2026-08-24** (`a52881b`, the youth-wildcard fix already described in the
prior two reviews). Re-verified directly:

- `PRIORITY_V2_REQUIRES_CALIBRATION = true` is still literal in
  `src/assessment/scoring/synthesizeCandidate.ts:26`.
- No file under `src/scoring/` or `src/assessment/` references
  `feedbackStore` — the digest feedback loop's Phase 4 (using Phase-3's now-
  captured signal to actually re-rank) is still unbuilt.
- Ownership-share fix, safety-flag layer, mid-run LinkedIn re-auth detection:
  all still present and unchanged from the 09-13 review's direct findings.

### 2.3 Technical direction

Unchanged: Phase 4 of the digest feedback loop unbuilt; Cory/priority-v2
uncalibrated; LinkedIn scrape-failure hardening still missing retry/trace
capture and the `expected_country`-vs-actual-location homonym check
(`linkedinMatch.ts:64-71`); the global-top-N-vs-per-seed product question
still open.

Deeper detail: [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md)

---

## 3. How the two projects relate

Unchanged framing: Dispatch is a hardened descendant of tSearch's
session/scraping infrastructure. Both projects continue to show the same
shape of technical debt — implementation (or, for Dispatch, an unfixed
defect) outrunning its own status docs — and now a second shared pattern is
visible: **both repos' safety gates are pattern-matching allowlists/denylists
that were correct when written and have since drifted from what the code
actually produces or needs.** Dispatch's resume-PDF regex (§1.3) missing the
real filename shape is one instance; the identity-field guard gap (a
denylist-of-topics rather than an allowlist-of-shapes, named in the 09-13
review) is the same category of problem, just not yet causing measured harm.
tSearch's `expected_country` field existing but never being checked against
a scraped profile's actual location is a milder version of the same thing —
a safety-relevant field that's collected but not wired into the check it
implies.

`docs/tsearch-reuse-map.md` (in `skale-07/dispatch`) — unchanged, still
stale on the same point (Phase-10 LinkedIn-enrichment reference).

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | **This document has now been drafted at least twenty times since 2026-08-07 and has never once been merged to `main`/`master` in either repo — and on 2026-09-13, the single-use review branch mechanism demonstrated the exact failure this risk describes: a previously-escalated Critical finding (this same row) and a High finding (the resume-PDF leak, then 9,976 paths) were silently absent from that revision, with no note that either was resolved.** Restored this review. | A review process whose findings don't reach a persistent, actionable location doesn't just fail to reduce risk — it can actively lose track of risks it already found, as just happened. This is no longer a hypothetical compounding cost; it is an observed one. Recommendation, unchanged in substance across five reviews: either point this review at the same persistent branch real feature work uses, or have an operator directly merge one of the existing review branches by hand. |
| **High** | Dispatch | **14,074 real candidate resume PDFs are tracked in `master`'s git history** (up from 9,976 on 09-11, +41% in 4 days), and this review identified the exact root cause for the first time: the pre-commit secret-scan hook is running correctly on every commit but its pattern (`/resume\.pdf$/i`) doesn't match the actual generated filename (`resume-<sha8>.pdf`), so it has never once fired on a real leak. Repo is private (confirmed 09-01, not re-checked this pass), which caps blast radius to those with repo access, but the count is still growing daily and no purge has been attempted in five-plus weeks. | This is now a precisely scoped, one-line fix plus a one-time history rewrite — the kind of finding that should close out next review rather than recur a 21st time. If it recurs unfixed after this review names the exact line, that itself would be worth escalating differently (a fix that's this cheap and still doesn't land is a process signal, not a difficulty signal). |
| **High** | tSearch | `profiles/`/`backup/` (real people's scraped LinkedIn PII) untracked from HEAD but still present in git history on a repo last confirmed public 2026-09-13; no purge attempted. Not independently re-verified via GitHub API this pass (tool access to the raw API was unavailable in this session) — treated as unchanged since no purge-shaped commit exists in the visible history. | Same exposure as the last four reviews: recoverable by anyone who checks out an older commit or clones full history, if the repo is still public. |
| **Medium** | Dispatch | Identity-field guard (never let a bank/predicted answer fill a name/email/phone question) is still not built, three reviews after being named. No new incident found this pass, but the gap is unchanged. | Same class of risk as the resume-regex bug above: a denylist-of-known-incidents rather than an allowlist-of-safe-shapes. |
| **Medium** | tSearch | LinkedIn scrape-failure hardening still half-done: no retry/trace/screenshot capture on failure, and `expected_country` still isn't checked against actual scraped location. Unchanged. | Silent wrong-person matches and hard-to-diagnose failures both remain possible. |
| **Low** | Dispatch | `docs/current-state-and-phase56.md` and both ATS adapter docs still describe a blocked/no-live-run state that has been false for three-plus weeks, third consecutive review to confirm the exact unedited lines. | Doc drift, not a defect — but the size of the drift (three weeks of live autonomous operation undocumented) keeps growing. |
| **Low** | tSearch | Digest-loop Phase 4 still unbuilt; priority-v2/Cory still uncalibrated; global-vs-per-seed product question still open. `main` has had a single commit in three weeks. | Unfinished direction, not a defect. |

---

## 5. Amendments worth considering (external scan)

**Dispatch**

- **Talisman** ([`thoughtworks/talisman`](https://github.com/thoughtworks/talisman)) —
  a pre-commit/pre-push hook that flags secrets by filename/extension/size
  heuristics in addition to content regex. Directly relevant as a second
  layer alongside fixing the resume regex (§4): a size/extension-shaped check
  would have caught the leak even with the wrong filename pattern, which is
  exactly the kind of defense-in-depth this incident argues for.
- **Field-type allowlisting for predict/bank answers** (cross-repo idea,
  carried over) — the scoped fix for the identity-field guard risk above.
- **Browser Harness** (`browser-use/browser-harness`) — a thin CDP-native
  pattern where the agent authors its own missing helper functions mid-task
  instead of relying on fixed selectors. Lower confidence/priority than the
  above two — worth a look given Dispatch already runs LLM-driven nightly
  failure triage, but unverified against this codebase's actual failure
  modes.

**tSearch**

- **Camoufox** (`daijro/camoufox`) — a Firefox fork with fingerprint spoofing
  patched below the JS layer (WebGL, AudioContext, WebRTC), positioned as a
  stealth drop-in for Playwright-style automation. Addresses the detection
  surface itself rather than just failure-recovery, complementary to the
  still-open retry/trace gap. Note: several near-identical forks under
  unrelated names showed up in a search for this — use the `daijro` origin.
- **Linear-probe LLM-judge calibration** (arXiv 2512.22245, "Calibrating LLM
  Judges") — trains a lightweight probe on judge-model internals for faster,
  better-calibrated confidence than the judge's own stated confidence; a
  more recent, more concrete complement to the previously-noted RULERS and
  stratified-sampling ideas, directly applicable to Cory/priority-v2's
  uncalibrated state. Not independently verified beyond the search result —
  treat as a lead to check, not a confirmed technique.
- **GitHub-graph-first identity resolution** — unchanged from prior reviews,
  still relevant given LinkedIn hardening is still half-done.

---

## Changelog

- **2026-09-15** — Full refresh. Restored the Critical meta-risk row and the
  High resume-PDF-leak row that the 2026-09-13 revision dropped without
  explanation (see the continuity note at the top and §4) — this is now
  itself flagged as evidence the meta-risk is not hypothetical. Root-caused
  the resume-PDF leak for the first time: `src/security/artifactScan.ts`'s
  `/resume\.pdf$/i` pattern never matches the real `resume-<sha8>.pdf`
  filename `resumeDownload.ts` actually writes, so a hook that has run
  correctly on every commit has never once caught the leak; leak now 14,074
  paths (+41% since 09-11). Confirmed fixed since 09-13: the #279 picker
  livelock (a failing in-flight app was starving older queued rows) — a real
  code fix, verified by reading `worker.ts` directly. Reconfirmed unchanged:
  Dispatch's status docs (line-level quotes taken directly this pass), the
  identity-field guard gap, tSearch's frozen `main` (one commit in three
  weeks), Phase 4 feedback loop, Cory/priority-v2 calibration, LinkedIn
  hardening gaps, and tSearch's unpurged public-history PII (not
  independently re-verified via API this pass due to a tool restriction in
  this session — flagged rather than silently assumed). Zero open GitHub
  issues, zero open PRs on both repos (confirmed via GitHub API). New
  amendments: Talisman, Browser Harness, Camoufox, linear-probe LLM-judge
  calibration.
- **2026-09-13** — Full refresh (see continuity note at top of this
  revision: this entry's own doc silently dropped two previously-escalated
  findings, discovered and restored 2026-09-15). Major update: Dispatch
  documented as moving from blocked/fixture-only to weeks of live autonomous
  operation the docs hadn't caught up to. tSearch fixed 3 of the prior
  review's flagged issues and partially fixed a fourth.
- **2026-08-07 through 2026-09-11** — Eighteen prior reviews on unmerged
  single-use branches (`claude/epic-pasteur-*` / `claude/busy-clarke-*`,
  none merged to `main`/`master`). Full incremental record, including the
  original PII-history discovery, the resume-PDF leak's growth from 183 to
  9,976 paths, and the 2026-09-11 review's push-notification escalation of
  the meta-risk, lives in that branch history.
