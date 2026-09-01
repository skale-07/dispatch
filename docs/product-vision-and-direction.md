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
| Last reviewed | 2026-09-01 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**now private** — visibility flipped from public sometime between the 08-31 morning review and this one, reconfirmed directly via the GitHub API this review, not assumed; product renamed "Dispatch" on `master` 2026-08-17), `skale-07/tSearch` (**public**, unchanged) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **fourteenth** attempt at this document
since 2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and never merged to `master`/`main` — reconfirmed directly this review.
The 13th review (2026-08-31) itself made at least one confirmed-wrong claim
(see §1.3 correction on issue #21) despite explicitly re-deriving its
figures rather than trusting the 12th draft — this review does not assume
its own claims are more reliable by default either. Every figure below was
re-derived directly against current `HEAD` in both repos this session (byte
counts, `git ls-tree`/`git cat-file --batch-check` counts, `git log` ranges,
live GitHub API queries for issues/PRs/repo visibility, direct source reads
of the safety-check code paths), and a push notification was sent to the
operator on completion given the scale of this window's findings — same
rationale as every prior review, since the meta-risk (this doc never
merging) is itself unchanged.

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

**That bet keeps compounding: the closed loop is not just sustaining, it is
widening.** Three more real, `LIVE_MUTATION_CONFIRMED` Submit clicks landed
the evening of 2026-08-31 (the "night22" session), on top of the 6 the 13th
review already confirmed: a fresh Stripe Software Engineering Intern posting
(Greenhouse, posting `0a2dbfa6` — a distinct application from the earlier
Stripe submit, not a re-count of it), Nuvo via **Gem** (`jobs.gem.com` —
the **first-ever Gem submission**, a new ATS surface reached through the
generic adapter's field-discovery path rather than a dedicated adapter — see
§1.2), and TIAA via **Workday** (the **first-ever Workday submission**,
resolving the poisoned-screener-prediction park from the 13th review's open
issue #83). That brings the running total to **at least 9 real submits
across 4 ATS platforms in under a week**, up from 6 across 2 platforms two
days ago. Submit velocity is still accelerating faster than this document's
independent-verification methodology can keep up with (see §1.2, §1.3, §4).

The product also renamed itself **"Dispatch"** on `master` itself on
2026-08-17 (`eedc63c`, "operator directive 2026-08-18") — package.json,
README, CLI header, console/dashboard title, and the house-rules
frontmatter all now say Dispatch. Deliberately unchanged: `CANDIDATE_DATA_KEY_NAME`,
`src/jobright/`/`JOBRIGHT_*` (names the external job board, not this
project), and the GitHub repo's own name/URL (`skale-07/jobright-application-agent`).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) — three gated LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; a TypeScript `agent/stagehand/` using `@browserbasehq/stagehand`, still evaluation-only — see §1.3).
- **Source of truth:** SQLite (`data/app.sqlite`, not present in this review's sandbox checkout — gitignored, so all figures below come from the tracked `artifacts/` logs and source, not a live DB query) — queue state, transitions, leases, idempotency, review items, and append-only telemetry. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture, flags unchanged in shape.** All default `false` in `.env.example` except `CDP_AUTOLAUNCH_ENABLED` (a debug-Chrome convenience, not a mutation gate). `chromium.launch` remains confined to three session-infra files. Demographic/EEO/pronoun fields are architecturally confirmed to still never take the LLM/screener path (spot-checked again this review against `src/security/artifactScan.ts` and the screener code paths — consistent with prior reviews).
- **ATS coverage — live-DOM proof now reaches FOUR platforms, up from two.** The registry (`src/ats/registry.ts`) still lists exactly `greenhouse, lever, ashby, workable, workday, generic` plus an `unsupported` fallback — unchanged. **Gem is not a new registry entry**: `jobs.gem.com` renders inputs with no id/name/label/aria, and the 08-31 fix (`dfb6dfed`, #112) taught the *shared* `src/applications/fieldDiscovery.ts` a caption-follow-control fallback rung used by every adapter, plus an "Apply without saving" CTA match and a looser confirmation-text regex — Gem's first live submit (Nuvo) rides on the generic path, not a Gem-specific adapter class. **Workday reached its first real submit this window** (TIAA, "first-ever Workday submission" per the operator's own night23 handoff note), closing out the 13th review's open item #83 (a poisoned cached screener-prediction reply that had been feeding a wrong Phone/Device-Type answer). Greenhouse still has the deepest proof; Ashby has one (Exa, carried from the 13th review). **Lever and Workable remain the only two adapters fully `UNVERIFIED` against real live pages** — the live-proof backlog that was 4-of-6 unverified two reviews ago is now 2-of-6.
- **Verify gate — still could not be independently re-run this review, now the third consecutive review with this gap.** No `node_modules` in this sandbox checkout (same limitation as 08-29 and 08-31). Every fix commit in this window (`dfb6dfed` included) carries only a self-reported "Gate: NNNN/NNNN green" in its own commit message — per this project's own validation-ladder rule, that is `UNVERIFIED`, not `UNIT_CONFIRMED`, until a review actually re-runs it with dependencies installed. This gap is now old enough to be a standing methodology risk in its own right (see §4), not a one-off sandbox limitation.
- **NEW this review — `master`'s own git history was rewritten (force-pushed to a disjoint root) sometime this window.** The current `master`/`claude/busy-clarke-d5f62z` tip (`f917e2f7`) has **no common ancestor** with the `claude/busy-clarke-tlr33g` branch the 13th review was drafted from (`git merge-base` returns no result, not just "far behind") — `master` is now only 50 commits deep, rooted at what reads as a single squashed "automation session" commit. This is a different, more disruptive event than the ordinary branch divergence this document has tracked before: it appears `master` itself was reset/rewritten, not just that a feature branch fell behind. No corruption or malicious content was found in the resulting tree (spot-checked: the vision doc, README, and safety-check source all read as coherent, intact files), but an unexplained history rewrite on the default branch — even of a now-private repo — is worth an operator explanation, and it has a concrete side effect: `claude/product-branding-design` (104 commits of marketing-site work, last touched 2026-08-08) now shares no common ancestor with `master` either, up from "104 ahead / 50 behind" — a normal merge is no longer possible without manual reconciliation.
- **Lineage:** unchanged from prior reviews — tSearch's session/storage layer was the seed for `ServiceSession`/`src/storage/`; tSearch's product logic was not ported.

### 1.3 Technical direction

**Correction to the 13th review, found by direct log inspection this
review:** that review stated issue **#21** (the export-control
checkbox mis-typing bug) was "explicitly carried forward unfixed" as of
`c284026`. Direct inspection of `artifacts/overnight-issues-2026-08-30.md`
shows #21 was carried into that day's session as open, then
**root-caused and fixed the same day** ("`### 40. #21 ROOT-CAUSED on the
live Neuralink DOM — checkbox GROUPS were discovered as one field per
option — FIXED + progressive-overload set`"), and the 08-31 session's own
issue recap no longer lists #21 among the open carry-overs — only **#19**
(Cloudflare conditional-DOM cross-fill) is explicitly reconfirmed still
open ("`#19 Cloudflare still OPEN`", 08-31 log line 12). The 13th review's
figure was stale by one day, not fabricated, but it is a concrete instance
of exactly the self-report-trust problem this document keeps warning about
— this time in a review artifact, not a commit message.

- **The "Phase 5.6" framing is now stale in two different ways, and they
  diverged this window instead of both staying wrong.** `docs/current-state-and-phase56.md`
  is unchanged this window (only appears in the base squashed commit — no
  edit landed) and still says live discovery "has never produced a job,"
  now false by a much wider margin (9 submits, not 6, not 2). **But
  `README.md`'s own "Current state" section *was* rewritten this window**
  and is now accurate: it names the Greenhouse/Ashby submits, the five-ATS
  coverage claim (now six-ATS in practice, given Gem), and the safety
  posture correctly. An operator or agent reading only the README would no
  longer be misled; one reading `current-state-and-phase56.md` still would
  be. The fix is the same as before — rewrite the phase doc, this time
  ideally from the now-accurate README rather than from scratch.
- **Second navigation-agent engine (Stagehand) is still a pre-registered
  comparison, not a decision — unchanged this window.** `docs/agent-engine-decision.md`
  still opens "SPIKE — comparison not yet run," no edits landed this
  window.
- **Submit velocity vs. independent verification — the gap this document
  flagged as a new risk on 08-31 has not narrowed; if anything the ATS
  surface area it needs to cover just grew.** 9 real submits across 4
  platforms now, an `L3` mode with operator-removable caps, and a
  validation methodology that still rests entirely on self-reported "Gate:
  ... green" claims from fix commits (three consecutive reviews now unable
  to re-run the gate directly in this sandbox). The one classifier failure
  already on record (#79, Ashby success misread as "unknown") plus this
  review's own #21 correction above both point at the same underlying
  problem: self-reported status in this pipeline has now been wrong at
  least twice, once in production code and once in this very document.
- **PII leak — root causes byte-for-byte unchanged, growth continues on the
  same curve, but this review adds one real mitigating fact and one
  important caveat about it.**
  - **5,128 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths as of `HEAD` (`f917e2f7`) — up from 4,086 two days ago, another
    ~25% jump in one day.** Full-population byte-size check this review
    (not a sample, all 5,128 objects): 4,730 are the 45-byte placeholder
    fixture; **398 are real, substantial PDF content** (248 at 113,381
    bytes, 134 at 76,462 bytes, 16 at 74,509 bytes — the same three sizes
    every prior review has found), up from 360 two days ago.
  - **The operator's cleartext contact info did not grow this window** —
    phone number still in exactly 1 tracked file, email still in exactly
    28 tracked files, both unchanged from the 13th review's count. The
    growth this window is entirely resume-PDF volume through the autopush
    path, not new log files naming the operator directly.
  - **Root causes reconfirmed directly against current source, not
    carried over:** `.gitignore` line 20 is still `# artifacts/`
    (commented out); `REQUIRED_GITIGNORE_ENTRIES` in
    `src/security/artifactScan.ts` (lines 37-43, checked at 138-139) still
    does a naive `.includes()` substring match that the dead commented
    line satisfies; `artifactAutopush.ts` still shells out `git add`
    unexcluded; `.git/hooks/pre-commit` is still absent in this checkout.
    No purge attempted.
  - **NEW this review, and important not to over-read: the repository
    itself is now private.** This is a real, meaningful change to
    going-forward blast radius — the tracked resume PDFs and cleartext
    contact info are no longer world-readable by default. It is **not**
    a resolution of the underlying problem: the exact timing of the
    visibility change is unconfirmed (somewhere between the 08-31 morning
    review and this one), every prior review through 08-31 verified the
    repo as public, and flipping visibility now does not undo whatever
    window this content spent publicly readable, nor does it fix any of
    the four root causes above, which are still fully specified and still
    unapplied. Treat this as a severity-of-going-forward-exposure change
    (reflected in §4), not a "fixed" checkbox.
- **New capability surfaces since the last review: none — no new
  ESSAY_/SCREENER_/AGENT_ flags landed this window,** consistent with the
  window's commits being ATS-adapter and field-discovery fixes rather than
  new capability surfaces.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand promotion-bar
  comparison actually running.
- **Next up, in priority order (re-ordered this review given what changed):**
  (1) get an operator explanation for the `master` history rewrite and
  decide what to do with the now fully-orphaned `claude/product-branding-design`;
  (2) fix the `artifacts/` leak's four root causes and purge history — still
  fully specified, now somewhat less urgent in going-forward terms given
  private visibility, but the fix is unchanged and cheap relative to a
  growth rate that hasn't slowed; (3) rewrite `current-state-and-phase56.md`,
  now that an accurate `README.md` exists to rewrite it from; (4) resolve
  #19 (Cloudflare conditional-DOM cross-fill) — the one correctness bug
  left open, now that #21 is confirmed fixed; (5) get independent (not
  self-reported) confirmation of the verify gate — three reviews running
  without one; (6) live-DOM proof for the two remaining unverified adapters,
  Lever and Workable; (7) let the Stagehand-vs-`browser_use` comparison
  actually run before treating either as more than an experiment.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
[`docs/architecture.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/architecture.md) ·
[`docs/current-state-and-phase56.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/current-state-and-phase56.md) (stale — see above) ·
[`docs/operator-guide.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/operator-guide.md) ·
[`docs/agent-engine-decision.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/agent-engine-decision.md) ·
[`docs/ats-adapters-lever-ashby.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/ats-adapters-lever-ashby.md) ·
[`docs/ats-adapter-workday.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/ats-adapter-workday.md) ·
[`docs/screener-questions.md`](https://github.com/skale-07/jobright-application-agent/blob/master/docs/screener-questions.md) ·
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
- **Still zero new commits — now a full 8 days of inactivity, reconfirmed
  this review.** `HEAD` is still `a52881b` ("Isolate youth wildcards on
  Score and stop dropping seed-tree neighbors below the top-80 cut"), last
  touched 2026-08-24. This is now the longest stretch of tSearch inactivity
  this document has recorded — worth naming plainly as a fact (not
  necessarily a problem: could be intentional pause, could be
  deprioritization relative to jobright's active nightly loop) rather than
  assuming a cause.
- **Discovery/Assessment/Presentation separation, judge system, Supabase
  scaffold, website-graph channel, marks/watchlist feature — all unchanged**
  since no commits landed. See the 13th review (carried forward below,
  §"Changelog") for the full feature-wave detail; not re-derived here since
  nothing about the code changed.
- **Verify gate — not re-run this review, third consecutive review with this
  gap** (same sandbox limitation as jobright: no `node_modules` in this
  checkout). Carrying forward the 08-29 figure (typecheck clean; `npm run
  test` 396/396 across 62 files) as last-confirmed, now two reviews stale.

### 2.3 Technical direction

- **CRITICAL, and now the more urgent of the two repos' PII exposures —
  see §3.** `profiles/`/`backup/` real scraped-LinkedIn-people data was
  untracked from the working tree and gitignored on 2026-08-10, but
  **remains fully reachable in git history on this public repo** —
  reconfirmed directly this review (`git cat-file -e
  700e2f6:profiles/madanva/profile.json` still resolves). This is now the
  **fourteenth** consecutive review confirming this unpurged, on a repo
  whose public visibility has not changed while jobright's just did (see
  §3). `git filter-repo` + force-push + collaborator re-clone remains the
  concrete, unexecuted unblock.
- **Everything else in this section is unchanged since the 13th review** —
  restated briefly rather than re-derived, since zero commits landed to
  change any of it:
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
  - No fail-closed CI enforcement — `.github/workflows/ci.yml` reconfirmed
    this review to still run only typecheck + tests, no forbidden-API/PII
    checker comparable to jobright's `check:forbidden`.
  - Low, doc-only staleness: `docs/system-brief.md` (stale in the safe
    direction) and `docs/tsearch-reuse-map.md` (still describes a dropped
    Phase-10 LinkedIn-enrichment port) — both unchanged, both low severity.
- **Zero open issues, zero open PRs, reconfirmed this review directly via
  the GitHub API** (not assumed from the prior draft).

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

**Both repos still carry the identical shape of unresolved risk — real
personal/PII data reachable in git history on a repo that was, until this
window, public in both cases — but this review is the first time the two
have diverged on the one variable that determines blast radius: public
visibility.** jobright's repo went private sometime this window (unconfirmed
exact date; every review through 08-31 verified it public). tSearch's has
not moved and remains fully public, with its exposure now confirmed
unpurged for the fourteenth review running. **This flips the relative-urgency
call the 13th review made** (it called jobright's leak "unambiguously the
more urgent of the two" because it was actively growing on a public repo):
jobright's leak is still actively growing internally and its four root
causes are still unfixed, but it is no longer world-readable by default,
while tSearch's exposure — smaller in raw file count, static rather than
growing — is now the one sitting on a repo anyone can currently clone. Both
still need their fix executed; tSearch's now has the better claim to being
first given nothing about its own risk picture has changed while jobright's
just improved on this one dimension.

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment
was dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history **on this public repo** — reconfirmed directly this review, fourteenth review in a row. No purge attempted. | The one PII exposure between the two repos that is currently world-readable by anyone who clones the repo — see §3 for why this now outranks jobright's on urgency. |
| **High** | jobright | 5,128 tracked resume-PDF paths (398 with real, substantial content, up from 360 two days ago) plus the operator's phone (1 file) and email (28 files) in cleartext, all still tracked in git history — but the repo **flipped to private this window**, reconfirmed via the GitHub API. Four root causes (commented-out `.gitignore` line, substring-match safety check, unexcluded `git add -A`, no installed pre-commit hook) all reconfirmed unchanged in source; no purge attempted. | Downgraded from Critical: no longer world-readable by default, which is the dimension "Critical" was tracking. Still High, not Medium, because the underlying invariant violation is unfixed, the leak keeps growing on the same trajectory, and repo visibility could change again without any of the four code fixes having landed. |
| **High** | jobright | Submit velocity (≥9 real submits across 4 ATS platforms now, up from 6 across 2 two days ago) continues to outpace independent gate verification — three consecutive reviews unable to re-run the gate directly, every recent fix commit's "tests green" claim self-reported only. | The inverse failure — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly; nothing in the pipeline independently confirms it, and the surface area needing that confirmation just grew (Workday and Gem joined Greenhouse/Ashby this window). |
| **High** | jobright | `docs/current-state-and-phase56.md` still actively contradicts the repo's own state (still says live discovery "has never produced a job" against ≥9 real submits) — notably, `README.md`'s own current-state section *was* fixed this window, so this is now the one remaining actively-wrong doc, not a shared problem across the whole docs tree. | An operator or future agent trusting this specific doc would materially misjudge what's proven; the fix is doc edits, now with an accurate README to rewrite it from. |
| **High** | jobright | `auto:cycle`/L3 armed mode is a genuinely unattended fill-and-submit operating mode, now proven across 4 ATS platforms and still accelerating, with no per-run human click once armed and caps removable by the operator. | Standing line item: a deliberate, working capability whose live evidence and platform coverage are both still growing. |
| **Medium** | jobright | **NEW this review — `master`'s git history was force-rewritten to a disjoint root sometime this window**, and `claude/product-branding-design` (104 commits, unmerged marketing-site work) now shares no common ancestor with `master` at all, up from a normal-if-large divergence. No evidence of tampering or data loss found on inspection, but the rewrite itself is unexplained. | Breaks the assumption this document has relied on for 13 reviews — that branch relationships are at least computable even when unmerged. Worth a direct operator explanation; the orphaned rebrand branch now needs manual reconciliation, not just a merge, if it's ever going to land. |
| **Medium** | both | **Meta-risk: this document has been drafted at least fourteen times since 08-07 and never merged to `main`/`master` in either repo; the 13th draft itself was independently found wrong on one point by this review (§1.3, issue #21).** | A review process that both fails to trigger action and has now been shown to make its own stale/wrong claims — even while explicitly trying to avoid that — has a compounding trust problem in both directions. This review sent a direct operator push notification on completion for the same reason as every prior one. |
| **Medium** | jobright | Lever and Workable remain the only two ATS adapters fully unverified against real DOM, now that Workday and Gem both reached live submits this window. | The live-proof backlog is narrowing (4-of-6 unverified → 2-of-6) but hasn't closed. |
| **Medium** | jobright | One open correctness bug remains from the pair the 13th review tracked: #19, Cloudflare conditional forms cross-filling an answer into the wrong field when the DOM shifts mid-fill. (#21 is confirmed fixed as of 08-30 — see §1.3 correction.) | Exactly the class of silent-wrong-answer bug the validation ladder exists to catch before a real submission, at a time when submissions are happening across more platforms than before. |
| **Medium** | tSearch | No fail-closed CI enforcement — reconfirmed this review, `.github/workflows/ci.yml` still typecheck + tests only. Unchanged since 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose. |
| **Low** | tSearch | `docs/system-brief.md` and the two audit docs are stale relative to fixes already shipped (safe direction — they overstate risk, not understate it). | Doc drift undermines trust in the others even when the drift is "safe." One-line/one-paragraph fixes. |
| **Low** | tSearch | Digest ranking sort-order refinement is built; true weight-learning from feedback is not. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **NEW this review — Gitleaks, as continuous defense-in-depth alongside
  (not instead of) fixing the four root causes above.** [`gitleaks/gitleaks`](https://github.com/gitleaks/gitleaks)
  is the actively-maintained, widely-used open-source secret/PII scanner
  with both a pre-commit hook mode and a GitHub Action. Worth naming
  specifically because this project's own custom safety check
  (`REQUIRED_GITIGNORE_ENTRIES`'s substring match) has now been
  demonstrably wrong for three-plus weeks without anyone noticing via that
  check — a second, independently-maintained scanner running in CI would
  have caught the growing resume-PDF leak on every push regardless of
  whether the custom check's own logic bug was ever found. Complementary
  to, not a replacement for, the path-based pre-commit block below (that
  one stops the specific known leak shape; Gitleaks catches classes of
  leak nobody has thought to write a bespoke rule for yet).
- **`ShantanuVr/playwright-self-healing-framework`** (carried forward from
  the 13th review, still unapplied, still the best philosophical fit) —
  zero-LLM, zero-API-key locator healing that targets the same DOM-drift
  failure class as the Cloudflare cross-fill bug (#19, still open) without
  adding a second nondeterministic call into a codebase whose product bet
  is determinism. https://github.com/ShantanuVr/playwright-self-healing-framework
- **A path/size-based pre-commit block via the already-present
  Lefthook/`.githooks` mechanism** (carried forward, still unapplied) — a
  rule rejecting any staged path under `artifacts/**/materials/`, or any
  PDF over a size threshold in that tree, is still the most direct fix for
  the specific leak shape. https://github.com/evilmartians/lefthook

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for the fourteenth review in a row, and now the higher-priority
  of the two repos' purges per §3.
- **`joaquinhuigomez/llm-judge-calibrator`** (carried forward, still
  unapplied) — position-swap evaluation across judge calls, Cohen's Kappa
  and position/verbosity/self-preference bias rates, directly runnable
  against the six existing rubric judges, none of which carry a measured
  inter-rater-agreement number. https://github.com/joaquinhuigomez/llm-judge-calibrator
- **Supabase Row-Level Security review before the dual-write lands** —
  scaffolding remains correctly gated (deny-all RLS, throws until wired)
  and unchanged; worth the same PII scrutiny once it actually lands.

---

## Changelog

- **2026-09-01** — This review (14th+ attempt). Confirmed jobright: 3 more
  real `LIVE_MUTATION_CONFIRMED` submits landed 08-31 evening (a fresh
  Stripe posting, Nuvo via Gem — first-ever Gem submit, TIAA via Workday —
  first-ever Workday submit), bringing the running total to ≥9 across 4 ATS
  platforms. Found and corrected a stale claim in the 13th review: issue
  #21 was actually fixed 08-30, not carried forward unfixed as previously
  stated; #19 remains the one open correctness bug. `README.md`'s
  current-state section was rewritten and is now accurate;
  `current-state-and-phase56.md` and `agent-engine-decision.md` remain
  stale/unchanged. PII leak: 5,128 tracked resume-PDF paths (398 real, up
  from 4,086/360 two days ago), operator phone/email counts unchanged (1 /
  28 files) — root causes reconfirmed unchanged in source. **New finding:
  the jobright repo flipped from public to private sometime this window**
  (exact timing unconfirmed), which downgrades that risk from Critical to
  High in blast-radius terms without resolving the underlying leak.
  **New finding: `master`'s git history was force-rewritten to a disjoint
  root**, orphaning `claude/product-branding-design` further and breaking
  this document's usual branch-comparison method — flagged for an operator
  explanation. Confirmed tSearch: zero new commits for a full 8 days;
  PII-history exposure reconfirmed unpurged for the 14th review in a row on
  a repo that is still fully public — given jobright's visibility change,
  this is now the more urgent of the two purges. Neither repo has open
  issues or PRs (confirmed via live GitHub API). Added Gitleaks as a new
  jobright amendment (continuous scanning as defense-in-depth given the
  custom checker's own logic bug went unnoticed for weeks); kept
  `playwright-self-healing-framework` and `llm-judge-calibrator` as
  still-unapplied, still-relevant carryovers. Sent one operator push
  notification on completion given the repo-visibility change and the
  master rewrite, independent of whether this document lands anywhere by
  any other path. Pushed to this session's assigned branches; did not
  assume this lands on `main`/`master` without a human merging it.
- **2026-08-31** — 13th+ attempt. Confirmed jobright: 50 new
  commits since 08-29, almost entirely a second overnight L3 automation
  window. 4 new real `LIVE_MUTATION_CONFIRMED` Submit clicks (Neuralink,
  Old Mission, DV Trading, Exa), bringing the running total to 6 in 4 days.
  Workday reached a live pre-submit gate but did not submit (parked on
  #83). PII leak accelerated sharply: 574→4,086 tracked resume-PDF paths
  (194→360 real) in two days. Flagged submit velocity outpacing
  verification as a new risk. Confirmed tSearch: zero new commits for a
  full week, PII-history exposure reconfirmed unpurged. Neither repo had
  open issues or PRs. Replaced the Skyvern-only jobright amendment with
  `playwright-self-healing-framework`; replaced abstract judge-reliability
  references for tSearch with `llm-judge-calibrator`. Sent an operator push
  notification on completion.
- **2026-08-29** — 12th+ attempt. Found the prior draft's
  characterization of the resume-PDF leak incomplete (byte-level inspection
  showed real content, not just placeholders) and found a second,
  more directly identifying leak (operator's phone/email in cleartext
  across 27 files) that no prior review had checked for. Sent two operator
  push notifications mid-review. Confirmed jobright: 19 new commits,
  ATS board discovery went live, 2 real Submit clicks (Figma, Stripe).
  Confirmed tSearch: zero new commits since 08-24. Re-ran both repos'
  verify gates directly (last time this was possible). Added Skyvern and
  RULERS/Judge-Reliability-Harness as amendment candidates.
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
