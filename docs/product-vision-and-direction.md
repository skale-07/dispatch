# Product vision & technical direction — Dispatch + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/jobright-application-agent`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both* repos
together (shared lineage, shared operator, shared data-handling posture)
don't get missed.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-09-19 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (private; rebranded "Dispatch" in-repo, GitHub `full_name` still `jobright-application-agent` — reconfirmed via API this pass), `skale-07/tSearch` (**public**, reconfirmed via API this pass) |

**Continuity note:** this is the 22nd review since 2026-08-07 and, like all
21 before it, is landing on a fresh single-use branch instead of `main`/
`master` (see the Critical meta-risk in §4 — still unresolved, now for six
consecutive weeks). This cycle's headline finding is not a new bug: it's
that the fix for last cycle's headline bug still hasn't reached `master`.
The 09-17 review root-caused and fixed the resume-PDF/`artifacts/` leak in
three places and pushed the fix to `claude/busy-clarke-gpm2tc` (commit
`5252dca9`). Two days later, that branch is still unmerged, no PR was ever
opened for it (reconfirmed: 0 open issues, 0 open PRs on both repos), and
the unattended automation loop kept running against the unpatched `master`
the entire time — the exposure it was supposed to stop grew by roughly
1,000 more tracked files in those two days (§1.3). This is the meta-risk in
§4 causing concrete, measurable harm, not a hypothetical: a known, coded,
tested fix sitting idle is now materially worse than the bug being unknown,
because *someone already spent the effort* and it isn't paying off. Treat
every unchecked claim below as inherited, not re-verified, unless it says
otherwise.

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

That bet is still being tested at real scale, and this cycle is the clearest
evidence yet that gating the *automation* isn't the same as gating the
*process that maintains it*: the automation itself never wrote an unsafe
field or made an ungated submission — the leak is a supply-chain-style gap
(what gets tracked into git), and it kept growing this cycle purely because
a known-good fix sat on a branch nobody merged, not because any fail-closed
flag failed.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (essay + predict-tier + triage LLM call sites, all separately flagged).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability still sits behind a named fail-closed env flag; `chromium.launch` is still confined to three session-infra files; `check:forbidden` still CI-fails the build if Outlook send APIs appear anywhere. The identity-field guard (never let a bank/predicted answer fill a name/email/phone question), named as missing in four prior reviews, is **still not built** — not re-verified line-by-line this pass, no new incident found.
- **The #279 picker livelock fix and essay/screener prediction path** — unchanged, not re-verified this pass; no reason found to doubt them.
- **ATS coverage:** unchanged — Greenhouse, Lever, Ashby, and Workday all have live submissions on record.
- **Lineage:** unchanged — the session/storage layer was deliberately hardened from tSearch; tSearch's product logic was not ported.

### 1.3 Technical direction

**Re-verified directly this pass, against the actual repo state, not the
prior review's self-report:**

- `origin/claude/busy-clarke-gpm2tc` (commit `5252dca9`, the three-bug fix
  from 09-17: the `resume(-[0-9a-f]+)?\.pdf$` regex, the active-lines-only
  `.gitignore` check, and the `maxBuffer`-safe `check-secrets-staged.ts`) is
  **still not an ancestor of `master`** — confirmed with
  `git merge-base --is-ancestor`. `master`'s `src/security/artifactScan.ts`
  still has the old `/resume\.pdf$/i`-only pattern, and `.gitignore` still
  has `artifacts/` commented out.
- `master` took nothing but `art: auto-cycle report` / `art: automation
  session` autopush commits through **2026-09-18 11:47 UTC** — the
  automation kept running against the unpatched code for the full two days
  between reviews.
- The leak grew accordingly: **55,996 tracked files under `artifacts/`**
  (up from 55,062 on 09-17) including **14,666 resume PDFs** (up from
  14,601). Both counted directly via `git ls-tree -r` against current
  `master`, not carried forward from the prior review's numbers.
- Repo is still private (reconfirmed via API), which still caps blast
  radius to those with repo access — the one thing keeping this at High
  rather than Critical. **Purging the ~56k already-committed paths from
  git history is still outstanding and still not this review's call to
  make unilaterally** — it rewrites every downstream commit hash. New this
  pass: confirmed via API that both repos currently have **zero open pull
  requests**, which is exactly the precondition security guidance gives for
  it being safe to do a history rewrite without breaking anyone's open PR
  (§5) — there is no longer even that reason to wait.
- `tests/unit/test-split.test.ts`'s host-dependent failure (`testSplit.ts`'s
  `posix()` helper splits on `path.sep` instead of a hardcoded backslash) —
  reconfirmed still present on `master` this pass, still unfixed, same
  reasoning as 09-17 (touching `testSplit.ts` forces the heavy suite).
- **Still deliberately human-only:** work-authorization status, salary, and
  demographic questions — unchanged.
- **Documentation debt** (current-state-and-phase56.md, known-limitations.md,
  ATS adapter docs describing a stale blocked state) — carried forward,
  not re-read this cycle.

Deeper detail (staleness not re-checked this pass): `docs/architecture.md` ·
`docs/current-state-and-phase56.md` · `docs/known-limitations.md` ·
`docs/validation-levels.md` · `docs/security.md`

---

## 2. tSearch

### 2.1 Vision

Unchanged: "unseen talent discovery" — resolve identity from public
artifacts, expand a real collaboration graph, score on evidence, run
evidence-grounded LLM judges, produce a defensible recruiter digest.

### 2.2 Core technical details

Re-verified directly this pass (not carried forward as text):

- The digest feedback loop (Phase 4) is still live: `feedbackBoost()` in
  `src/digest/buildDigest.ts` is still a wired-in sort comparator. The
  09-17 correction (it was never "unbuilt," despite three prior reviews
  claiming so) stands.
- `PRIORITY_V2_REQUIRES_CALIBRATION = true` is still literal in
  `src/assessment/scoring/synthesizeCandidate.ts:26` — Cory/priority-v2 is
  still gated as uncalibrated.
- `expected_country` (`src/linkedin/linkedinMatch.ts`) is still present and
  still only feeds `isTargetedSearch()`'s boolean decision — still not
  compared against a scraped profile's actual location anywhere in that
  file. Unchanged.
- `main` has had exactly one commit since 2026-08-24 — now 26 days frozen,
  reconfirmed via API this pass (`pushed_at` still reflects only review-
  branch pushes).

Not re-verified this pass (carried forward): the ownership-share fix,
safety-flag layer, mid-run LinkedIn re-auth detection, and LinkedIn
scrape-failure hardening claims from prior reviews.

### 2.3 Technical direction

- Phase 4 of the digest feedback loop is built and wired in (§2.2) —
  whether its ranking behavior has been validated against real reviewer
  outcomes is still open; no calibration/backtest code found in any pass
  so far, searched lightly each time, not exhaustively.
- Cory/priority-v2 uncalibrated — unchanged, confirmed again this pass.
- LinkedIn scrape-failure hardening still missing retry/trace capture, and
  the `expected_country` homonym check specifically — unchanged, confirmed
  again this pass.
- The global-top-N-vs-per-seed product question — carried forward, not
  re-examined this pass.

Deeper detail: [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md)

---

## 3. How the two projects relate

Dispatch is a hardened descendant of tSearch's session/scraping
infrastructure. Both projects keep showing variations on the same shape of
problem — a safety- or status-relevant claim, or fix, that was true/shipped
once and then either silently drifted from reality or silently failed to
propagate to the place that matters. This cycle's headline finding is a new
instance of the second half of that pattern: it's not that the fix was
wrong, it's that a correct, tested fix on a branch is worth exactly nothing
to production until someone merges it, and nothing in either repo's process
currently makes that happen. The frozen `main`/`master` copies of *this very
document* (both still dated 08-07, and — noted this pass — no longer even
textually identical to each other, one still calling the sibling project
"jobright-application-agent" and the other "Dispatch") are a second,
harmless-but-illustrative case of the same root cause: nothing re-visits a
branch once a review pushes to it.

`docs/tsearch-reuse-map.md` (in `skale-07/jobright-application-agent`) —
not re-checked this pass.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | This document has now been drafted 22 times since 2026-08-07 and has never once been merged to `main`/`master` in either repo. Unchanged recommendation, now six reviews running: point this review at the same persistent branch real feature work uses, or have an operator merge one of the review branches by hand. | This cycle is the sharpest demonstration yet: it's no longer just documentation losing continuity (09-13, 09-17) — a real, tested **code fix** for an actively-growing data leak has sat unmerged for two full days while the thing it fixes kept getting worse. The review process finding the right answer is not the same as the right answer reaching production, and nothing here closes that gap. |
| **High** | Dispatch | The resume-PDF / `artifacts/` leak: root-caused and fixed 09-17 (three independent gate defects — filename regex, a commented-out `.gitignore` entry a substring check couldn't see was disabled, and a `git ls-files` buffer overflow silently swallowed into an empty file list), but the fix (`claude/busy-clarke-gpm2tc`, `5252dca9`) is **still not on `master`** as of this review. `master` kept accumulating leaked files for two more days: **55,996 tracked files under `artifacts/` (up from 55,062), 14,666 resume PDFs (up from 14,601)** — both counted fresh this pass. Repo is still private, capping blast radius. Purging the already-committed history is still an explicit operator decision, not this review's call — and is now unblocked on the one precondition it might have needed (0 open PRs on the repo, confirmed via API, so a history rewrite wouldn't orphan anyone's in-flight PR). | A fix that exists and isn't deployed protects nobody. Every day this branch stays unmerged is a day of continued, measurable exposure that a human could stop by running one merge. |
| **High** | tSearch | `profiles/`/`backup/` (202 unique historical paths, last confirmed via `git log --all` 09-17) are absent from `HEAD` but present in git history on a repo confirmed public via the GitHub API. No purge attempted. Not re-walked this pass; carried forward. | Same exposure as prior reviews. |
| **Medium** | Dispatch | Identity-field guard (never let a bank/predicted answer fill a name/email/phone question) still not built, five reviews after being named. Not re-verified line-by-line this pass. | Same class of risk as the leak above: a denylist-of-known-incidents rather than an allowlist-of-safe-shapes. |
| **Medium** | tSearch | LinkedIn scrape-failure hardening still half-done: no retry/trace/screenshot capture on failure, and `expected_country` still isn't checked against actual scraped location (reconfirmed this pass). | Silent wrong-person matches and hard-to-diagnose failures both remain possible. |
| **Low** | Dispatch | `tests/unit/test-split.test.ts` fails on any non-Windows review host (hardcoded-vs-host `path.sep` bug in `testSplit.ts`) — reconfirmed still present, still unfixed for the same reason (touching it forces the heavy suite). | Process friction, not a security defect — but the gate has a host-dependent hole in exactly the kind of check meant to be unconditional. |
| **Low** | Dispatch | Documentation debt (`current-state-and-phase56.md`, `known-limitations.md`, ATS adapter docs) describing a stale blocked state — not re-read this pass, presumed unchanged. | Doc drift, not a defect. |
| **Low** | tSearch | Cory/priority-v2 still uncalibrated; global-vs-per-seed product question still open; `main` frozen at one commit in 26+ days. | Unfinished direction, not a defect. |

---

## 5. Amendments worth considering (external scan)

**Dispatch**

- **History-rewrite sequencing, not just tooling (new this cycle).**
  Current security guidance (Harness, Elegant Software Solutions,
  GitHub's own docs) converges on two points directly relevant to the
  pending §4 decision: (1) rotate/revoke any live credential *before*
  scrubbing history — scrubbing alone never un-exposes an already-seen
  secret — and (2) merge or close open PRs first, because a history
  rewrite changes every downstream commit hash and breaks any PR based on
  the old history. Point (2) is already satisfied here (0 open PRs,
  confirmed via API this pass), which removes what may have been an
  implicit reason to keep waiting. Between BFG and `git-filter-repo`
  specifically: BFG is simpler and faster for the common "strip these
  paths/blobs" case; `git-filter-repo` gives finer control and — unlike
  BFG — applies its filters to `HEAD` too, avoiding a disconnect between
  history and current state. For a flat "remove this whole `artifacts/`
  subtree from all history" job, either works; `git-filter-repo` is the
  actively maintained one.
- **Gitleaks** (`gitleaks/gitleaks`, carried over) — content-based secret
  scanner as a second opinion alongside `artifactScan.ts`'s filename-shape
  checks.
- **Talisman** (`thoughtworks/talisman`, carried over, still not adopted).
- **Field-type allowlisting for predict/bank answers** (carried over) — the
  scoped fix for the identity-field guard risk in §4.

**tSearch**

- **"Calibrate, Don't Curate: Label-Efficient Estimation from Noisy LLM
  Judges"** (arXiv 2605.09702) — new this cycle, and more directly on-point
  than prior calibration leads: addresses estimating a reliable signal from
  noisy judge output with a small labeled set, which is exactly tSearch's
  situation for Cory/priority-v2 (uncalibrated, presumably limited human-
  labeled ground truth to calibrate against). Worth reading before
  Margin-Adaptive Confidence Ranking (carried over from 09-17) — this one
  is closer to "how do I calibrate with the data I actually have" rather
  than "how do I rank once calibrated."
- **"A Finite-Calibration Regime Map for LLM Judge Panels"** (arXiv
  2606.01034) — new this cycle, a framework for reasoning about when a
  judge panel's calibration ceiling is reachable at all given panel size
  and disagreement — useful context for deciding whether priority-v2's
  gate should stay a hard boolean or become a confidence threshold.
  Neither paper independently verified beyond the search result — leads to
  check, not confirmed techniques.
- **Camoufox** (`daijro/camoufox`, carried over, still not adopted) —
  fingerprint-spoofing Firefox fork for the LinkedIn scraping surface.

---

## Changelog

- **2026-09-19** — Full refresh. Re-verified rather than carried forward:
  the 09-17 leak fix (`claude/busy-clarke-gpm2tc`, `5252dca9`) is
  confirmed **still not merged to `master`** two days later; `master` took
  only autopush commits through 09-18 11:47 UTC and the leak grew to
  55,996 tracked `artifacts/` files / 14,666 resumes (from 55,062 /
  14,601). Reconfirmed via API: both repos still at 0 open issues, 0 open
  PRs — which also means the one precondition for a history rewrite
  (no open PRs to orphan) is already met. tSearch: re-verified the Phase 4
  feedback loop, `PRIORITY_V2_REQUIRES_CALIBRATION`, `expected_country`
  gap, and `main`'s freeze (now 26 days) — all unchanged. Noted the frozen
  `main`/`master` copies of this document are no longer even textually
  identical to each other (illustrative of the same never-revisited-branch
  problem, not a new risk). Elevated the meta-risk framing: a merged branch
  problem became, this cycle, a *known fix rotting while the bug it fixes
  actively worsens* — a stronger, more concrete case for an operator to act
  on than any prior cycle made. New amendments: git history-rewrite
  sequencing guidance (BFG vs. `git-filter-repo`, rotate-then-scrub,
  PRs-closed precondition), two new calibration papers for tSearch judge
  work (arXiv 2605.09702, arXiv 2606.01034).
- **2026-09-17** — Full refresh. Re-derived the resume-PDF leak from the
  actual code instead of trusting the 09-15 root-cause, and found it was
  three independent gate defects compounding into a much larger leak than
  scoped — 55,062 tracked files under `artifacts/`, not 14,601 resumes.
  Fixed and pushed all three code-level defects (`claude/busy-clarke-gpm2tc`,
  `5252dca9`); history purge flagged as an operator decision. Corrected a
  three-cycle-old false claim that tSearch's digest feedback loop (Phase 4)
  was unbuilt — traced live since PR #3 (merged 2026-08-10) via `git log -S`.
  New amendments: Gitleaks, Margin-Adaptive Confidence Ranking.
- **2026-09-15** — Full refresh. Restored the Critical meta-risk row and the
  High resume-PDF-leak row that the 2026-09-13 revision dropped without
  explanation. Root-caused the resume-PDF leak (at the time, as a single
  filename-regex bug); leak then measured at 14,074 paths.
- **2026-09-13** — Full refresh. This entry's own doc silently dropped two
  previously-escalated findings, discovered and restored 2026-09-15. Major
  update: Dispatch documented as moving from blocked/fixture-only to weeks
  of live autonomous operation the docs hadn't caught up to.
- **2026-08-07 through 2026-09-11** — Eighteen prior reviews on unmerged
  single-use branches (`claude/epic-pasteur-*` / `claude/busy-clarke-*`,
  none merged to `main`/`master`). Full incremental record, including the
  original PII-history discovery, the resume-PDF leak's growth from 183 to
  9,976 paths, and the 2026-09-11 review's push-notification escalation of
  the meta-risk, lives in that branch history.
