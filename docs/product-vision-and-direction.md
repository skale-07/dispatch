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
| Last reviewed | 2026-09-17 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (private; rebranded "Dispatch" in-repo, but the GitHub repo itself has never been renamed — verified via API this pass, `full_name` is still `jobright-application-agent`), `skale-07/tSearch` (**public**, verified via API this pass) |

**Continuity note:** this is the 21st review since 2026-08-07 and, like all
20 before it, is landing on a fresh single-use branch instead of `main`/
`master` (see the Critical meta-risk in §4 — still unresolved). Two things
are different this cycle, both good: (1) this review didn't just re-describe
a known bug, it re-derived it from the actual code and found the prior
root-cause was incomplete — see §1.3; and it shipped and pushed an actual
code fix for it, not just a doc update. (2) it caught this same document
asserting a false claim about tSearch for at least three consecutive prior
reviews (§2.2) — a concrete instance of exactly the failure mode the
continuity notes in the 09-15 revision warned about ("do not assume a claim
is still true without re-checking it directly"). Treat every unchecked
claim below as inherited, not re-verified, unless it says otherwise.

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

That bet is still being tested at real scale: the operator-directed
unattended overnight loop (`src/automation/autoCycle.ts`, gated
`AUTOMATION_ENABLED`) is still running — `master` has taken nothing but
`art: auto-cycle report` / `art: automation session` autopush commits since
2026-09-15 (50 of them, confirmed via API), applying to real jobs across
four ATS platforms. This cycle sharpens last review's caveat rather than
softening it: "deterministic + fail-closed" has not meant "leak-free at
scale," and the leak turned out to be worse and structurally different than
previously scoped (§1.3, §4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (essay + predict-tier + triage LLM call sites, all separately flagged).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture — three independent gate failures found and fixed this cycle, not one:** every mutation capability still sits behind a named fail-closed env flag; `chromium.launch` is still confined to three session-infra files; `check:forbidden` still CI-fails the build if Outlook send APIs appear anywhere. But the artifact/secrets scanner itself had three compounding, independently-discovered defects — see §1.3 for the full root-cause chain and the fix. The identity-field guard (never let a bank/predicted answer fill a name/email/phone question), named as missing in three prior reviews, is **still not built** — not re-verified line-by-line this pass, no new incident found.
- **The #279 picker livelock fix (confirmed 09-15) holds:** `LAST_PICKED_KEY` cooldown logic is still present in `src/automation/worker.ts`, unchanged this cycle.
- **Essay + screener prediction** unchanged: `src/applications/essayAutofill.ts` generates from `private/candidate/about-me.md`, gated by `validateDraft`, with the `SENSITIVE_QUESTION` fence from issue #259.
- **Validation ladder discipline vs. documentation reality — unchanged, not re-verified this pass:** prior reviews (09-11 through 09-15) quoted `docs/current-state-and-phase56.md:277` and `docs/ats-adapter-workday.md:21` as stating a blocked/no-live-run state that live operation has contradicted for weeks. Not re-read this cycle; carried forward as presumed still true given master has taken no doc-editing commits since.
- **ATS coverage:** unchanged — Greenhouse, Lever, Ashby, and Workday all have live submissions on record.
- **Lineage:** unchanged — the session/storage layer was deliberately hardened from tSearch; tSearch's product logic was not ported.

### 1.3 Technical direction

**This cycle's substantive work: the resume-PDF leak (root-caused 09-15,
scoped then at 14,074 paths) turned out to be three independent gate
failures, not one — fixed all three, in `claude/busy-clarke-gpm2tc`
(commit `5252dca9`), not yet on `master`:**

1. `src/security/artifactScan.ts`'s forbidden-filename pattern
   (`/resume\.pdf$/i`) only ever matched a literal `resume.pdf`, never the
   real filename shape `resume-<sha8>.pdf` that `resumeDownload.ts` actually
   writes. Extended the pattern to match both.
2. **A second, independent defect masked by the first:** `.gitignore`'s
   `artifacts/` line was commented out (`# artifacts/`), and
   `checkGitignoreContents()` did a raw substring check against the *whole
   file text* rather than its active lines — so the commented-out line
   still satisfied the "required entry present" check. This is why the
   leak was never just resumes: **55,062 files under `artifacts/` were
   tracked in git** — `job.json`, `eligibility.json`, live-fill screenshots
   (`page.png`, `receipt-attempt-*.png`), submission JSON, not only the
   14,601 resume PDFs (up from 14,074 on 09-15, still growing at the time
   of this review). Fixed both: uncommented the line, and made the check
   skip comment lines so a disabled entry can no longer count as active.
3. **A third, independent defect that had been silently disabling the
   entire gate, not just the resume check:** `check-secrets-staged.ts`
   calls `execSync("git ls-files -c -o --exclude-standard")` with no
   `maxBuffer` override, wrapped in a bare `try/catch` that returned an
   empty file list on any error. Once this repo's tracked-file count grew
   past Node's default 1 MiB exec buffer, every call has been throwing
   `ENOBUFS` — silently swallowed — and `check:secrets` has been reporting
   "ok" while scanning **zero files**, for an unknown but nonzero span of
   recent history. This is a bigger finding than the resume regex: it means
   *every* forbidden-pattern category (`.env`, `sensitive-profile.enc`,
   `cookies.json`, not just resumes) has been unchecked against the tracked
   tree for as long as this has been silently failing. Fixed by raising
   `maxBuffer` to 256 MiB and letting failures propagate instead of
   vanishing.

   With all three fixed, `check:secrets` immediately and correctly flagged
   the full 55k-file leak. Untracked `artifacts/` from the index
   (`git rm --cached`; nothing deleted from disk) so the gate is green
   going forward and no new artifact gets re-added by accident. Added
   regression tests for all three (the new filename shape, the
   commented-out-entry bug, and — via the now-honest file count printed by
   the script — the buffer issue is exercised by any future gate run
   against this tree).

   **Deliberately not done, and not this review's call to make
   unilaterally:** purging the ~55k already-committed leaked paths from git
   history (`git filter-repo`/BFG). That rewrites every downstream commit
   hash and needs coordination with anyone holding a clone. Repo is
   private (confirmed via API this pass), which caps blast radius to those
   with repo access in the meantime, but the exposure is real and dated
   back over five weeks.

- **New, unrelated, small finding — left unfixed on purpose:**
  `tests/unit/test-split.test.ts` fails on this (Linux) review host: its
  `needsHeavySuite` Windows-backslash-path case fails because
  `scripts/testSplit.ts`'s `posix()` helper splits on `path.sep` (host-
  dependent — a no-op on Linux/Mac) instead of a hardcoded backslash.
  Reproduces identically on an unmodified tree (confirmed via `git stash`),
  so it's not this cycle's diff — but it means **no commit from a non-
  Windows machine can currently satisfy the house rules' "all four [gate
  commands] must pass"** literally, which is itself worth fixing soon.
  Left alone this cycle because `testSplit.ts` is in `ALWAYS_HEAVY`, so
  touching it forces the ~10-minute heavy suite for a change unrelated to
  this review's purpose.
- **Still deliberately human-only:** work-authorization status, salary, and
  demographic questions — unchanged.
- **Documentation debt** (current-state-and-phase56.md, known-limitations.md,
  ATS adapter docs describing a stale blocked state) — carried forward,
  not re-read this cycle.

Deeper detail (staleness not re-checked this pass): `docs/architecture.md` ·
`docs/current-state-and-phase56.md` · `docs/known-limitations.md` ·
`docs/validation-levels.md`

---

## 2. tSearch

### 2.1 Vision

Unchanged: "unseen talent discovery" — resolve identity from public
artifacts, expand a real collaboration graph, score on evidence, run
evidence-grounded LLM judges, produce a defensible recruiter digest.

### 2.2 Core technical details

**Correction to this document, not to the code:** the prior three reviews
(09-11, 09-13, 09-15) all stated "Phase 4 of the digest feedback loop
unbuilt" / "still unbuilt." This is false and has been false since before
09-11 — re-checked directly this pass:

- `src/assessment/runAssessment.ts:95` imports `loadFeedbackMap` from
  `../digest/feedbackStore.js` and passes it into `buildDigest()`.
- `src/digest/buildDigest.ts` has a `feedbackBoost()` function, explicitly
  commented `Phase 4 ranking refinement`, that is used as a live sort
  comparator (`feedbackBoost(b) - feedbackBoost(a)`) and produces
  `feedback_excluded_count` / `feedback_boosted_count` in the digest
  output. This is a real, wired-in re-ranking step, not dead code.
- Traced to `git log -S`: this landed in commit `5f80433` (PR #3, merged
  2026-08-10) — over a month before the first review that called it
  "unbuilt." The prior reviews' claim was never re-verified against the
  actual file; it was carried forward as inherited text. This is the same
  failure mode the 09-15 continuity note warned future reviews about,
  just found in this document's own §2 instead of a dropped row.

Re-verified and still accurate this pass:

- `PRIORITY_V2_REQUIRES_CALIBRATION = true` is still literal in
  `src/assessment/scoring/synthesizeCandidate.ts:26` — Cory/priority-v2 is
  still gated as uncalibrated.
- `expected_country` (`src/linkedin/linkedinMatch.ts:6,67`) is real and
  read, but only as one of several booleans deciding `isTargetedSearch()`
  (whether to trust LinkedIn's top search result) — it is never compared
  against a scraped profile's actual location anywhere in that file. The
  "collected but not wired into the check it implies" framing from prior
  reviews holds for this field specifically; it does not hold for the
  feedback loop above.
- `main` has had exactly one commit since 2026-08-24 (`a52881b`, the
  youth-wildcard fix) — confirmed again via API (`pushed_at` reflects a
  09-15 push, which is `main` receiving no new commits since; the 09-15
  push was to a review branch).

Not re-verified this pass (carried forward): the ownership-share fix,
safety-flag layer, and mid-run LinkedIn re-auth detection claims from the
09-13/09-15 reviews.

### 2.3 Technical direction

- Phase 4 of the digest feedback loop is built and wired in (§2.2) —
  remove from any future "still open" list. What's still genuinely open:
  whether its ranking behavior has been validated against real reviewer
  outcomes (no calibration/backtest code found this pass, but this wasn't
  searched exhaustively).
- Cory/priority-v2 uncalibrated — unchanged, confirmed.
- LinkedIn scrape-failure hardening still missing retry/trace capture, and
  the `expected_country` homonym check specifically — confirmed unchanged
  this pass.
- The global-top-N-vs-per-seed product question — carried forward, not
  re-examined this pass.

Deeper detail: [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md)

---

## 3. How the two projects relate

Dispatch is a hardened descendant of tSearch's session/scraping
infrastructure. Both projects keep showing variations on the same shape of
problem — a safety- or status-relevant claim (a regex, a gitignore entry, a
"still unbuilt" line in this very document) that was correct once and then
silently drifted from reality, with nothing forcing a re-check. This
review's two headline findings are both instances of that pattern: Dispatch's
three-bug leak chain (§1.3) and this document's own stale Phase-4 claim
(§2.2). tSearch's `expected_country`-collected-but-unchecked field (§2.2) is
a milder version of the same thing.

`docs/tsearch-reuse-map.md` (in `skale-07/jobright-application-agent`) —
not re-checked this pass.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | This document has now been drafted 21 times since 2026-08-07 and has never once been merged to `main`/`master` in either repo. Unchanged in substance from the last five reviews' recommendation: point this review at the same persistent branch real feature work uses, or have an operator merge one of the review branches by hand. | A review process whose findings don't reach a persistent location keeps losing track of what it already found — demonstrated concretely on 09-13 (dropped rows) and again this review (§2.2, a stale claim surviving three cycles unchecked). Both failures share one cause: nothing forces the next review to start from ground truth instead of inherited text. |
| **High** | Dispatch | The resume-PDF leak was three independent gate defects, not one, and the real scope is **55,062 tracked files under `artifacts/`**, not 14,601 resumes — job data, eligibility decisions, live-fill screenshots, submission receipts. All three code-level defects are fixed and pushed this cycle (`claude/busy-clarke-gpm2tc`, commit `5252dca9`): the filename regex, the commented-out `.gitignore` entry that a substring check couldn't see was disabled, and a buffer-overflow-on-`git ls-files` bug that had been making `check:secrets` silently scan zero files. `artifacts/` is untracked from the index so the gate stays green and the leak stops growing, once this branch reaches `master`. **Still outstanding, needs an explicit operator decision:** purging the ~55k already-committed paths from git history (hash-rewriting, needs clone coordination). Repo is private, capping blast radius until then. | This was undercounted for at least two prior reviews (09-11 named 9,976 resumes; 09-15 named 14,074) because neither the `.gitignore` bug nor the buffer-swallow bug had been found yet — the true exposure was always the whole `artifacts/` tree, not just resumes. |
| **High** | tSearch | `profiles/`/`backup/` (202 unique historical paths, confirmed via `git log --all` this pass) are absent from `HEAD` but present in git history on a repo independently reconfirmed public via the GitHub API this pass. No purge attempted. | Same exposure as prior reviews, now with the public-repo status independently confirmed rather than assumed unchanged. |
| **Medium** | Dispatch | Identity-field guard (never let a bank/predicted answer fill a name/email/phone question) still not built, four reviews after being named. Not re-verified line-by-line this pass. | Same class of risk as the leak above: a denylist-of-known-incidents rather than an allowlist-of-safe-shapes. |
| **Medium** | tSearch | LinkedIn scrape-failure hardening still half-done: no retry/trace/screenshot capture on failure, and `expected_country` still isn't checked against actual scraped location (confirmed this pass). | Silent wrong-person matches and hard-to-diagnose failures both remain possible. |
| **Low** | Dispatch | `tests/unit/test-split.test.ts` fails on any non-Windows review host because `testSplit.ts`'s path-normalizing helper uses the host's `path.sep` instead of a hardcoded backslash — reproduces on an unmodified tree. No commit from a non-Windows machine can currently satisfy the house rules' "all four must pass" literally. Newly found this pass; not fixed (touching `testSplit.ts` forces the heavy suite). | Process friction, not a security defect — but it means the gate has a host-dependent hole in exactly the kind of check meant to be unconditional. |
| **Low** | Dispatch | Documentation debt (`current-state-and-phase56.md`, `known-limitations.md`, ATS adapter docs) describing a stale blocked state — not re-read this pass, presumed unchanged. | Doc drift, not a defect. |
| **Low** | tSearch | Cory/priority-v2 still uncalibrated; global-vs-per-seed product question still open; `main` frozen at one commit in three-plus weeks. | Unfinished direction, not a defect. |

---

## 5. Amendments worth considering (external scan)

**Dispatch**

- **Gitleaks** ([`gitleaks/gitleaks`](https://github.com/gitleaks/gitleaks)) —
  new this cycle. A fast, single-binary, pattern-plus-entropy secret scanner
  widely recommended (2026 comparisons) as the pre-commit-stage half of a
  "gitleaks at commit time, TruffleHog on a schedule" layered setup. Doesn't
  replace `artifactScan.ts`'s filename-shape checks (Gitleaks scans content,
  not paths) but is a maintained, independently-tested second opinion —
  exactly the kind of defense-in-depth this cycle's three-bug chain argues
  for, since a homegrown scanner's own logic was the failure mode here.
- **Talisman** (`thoughtworks/talisman`, carried over, still not adopted) —
  filename/extension/size heuristics as a second layer specifically against
  the shape-drift class of bug (§1.3, defect 1).
- **Field-type allowlisting for predict/bank answers** (carried over) — the
  scoped fix for the identity-field guard risk in §4.

**tSearch**

- **Margin-Adaptive Confidence Ranking** (arXiv 2605.15416) — new this
  cycle, more specific to tSearch's actual problem than the previously-noted
  general calibration papers: learns a dedicated confidence estimator for
  *ranking* tasks rather than raw judgment accuracy, explicitly targeting
  the gap between "how confident the judge sounds" and "how much its
  confidence should move a ranking" — directly applicable to Cory/
  priority-v2's uncalibrated state, which is a ranking-confidence problem,
  not a pointwise-accuracy one. Not independently verified beyond the
  search result — a lead to check, not a confirmed technique.
- **Camoufox** (`daijro/camoufox`, carried over, still not adopted) —
  fingerprint-spoofing Firefox fork for the LinkedIn scraping surface;
  several near-identical forks exist under other names, use the `daijro`
  origin specifically.

---

## Changelog

- **2026-09-17** — Full refresh. **Dispatch:** re-derived the resume-PDF
  leak from the actual code instead of trusting the 09-15 root-cause, and
  found it was three independent gate defects (filename regex, a
  commented-out `.gitignore` line that a substring check couldn't see was
  disabled, and a `git ls-files` buffer overflow silently swallowed into an
  empty file list) compounding into a much larger leak than scoped —
  55,062 tracked files under `artifacts/`, not 14,601 resumes. Fixed and
  pushed all three code-level defects plus untracked `artifacts/` from the
  index (`claude/busy-clarke-gpm2tc`, commit `5252dca9`); history purge
  still outstanding and flagged as an operator decision. Found a new,
  unrelated, host-dependent test failure (`test-split.test.ts` on non-
  Windows) and left it unfixed with reasoning (§1.3). **tSearch:** corrected
  this document's own three-cycle-old false claim that the digest
  feedback loop (Phase 4) was unbuilt — it has been live since commit
  `5f80433` / PR #3 (merged 2026-08-10); traced with `git log -S` rather
  than trusted. Re-verified `PRIORITY_V2_REQUIRES_CALIBRATION` and the
  `expected_country` gap directly — both still accurate. Independently
  reconfirmed via GitHub API: tSearch still public, jobright-application-
  agent repo still private and never actually renamed to "Dispatch" on
  GitHub despite the in-repo rebrand, zero open issues and zero open PRs on
  both repos. New amendments: Gitleaks, Margin-Adaptive Confidence Ranking.
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
