# Product vision & technical direction — jobright-application-agent + tSearch

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
| Last reviewed | 2026-09-13 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (private), `skale-07/tSearch` (**public**) |

---

## 1. jobright-application-agent

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

**This bet is now being tested at real scale, not just in theory.** Since
roughly 2026-08-28 the project has run an operator-directed unattended
overnight loop (`src/automation/autoCycle.ts`, gated `AUTOMATION_ENABLED`)
that resets the queue, applies to real jobs across four ATS platforms, drafts
outreach in a separate Gmail-CDP Chrome, and self-repairs bugs it hits —
each fix gated through the same `npm run typecheck && test && check:forbidden
&& check:secrets` ladder as any other change (see `artifacts/overnight-issues-*.md`,
17 gated commits on the night of 2026-09-11 alone). This is a deliberate
expansion of scope *by the operator*, not scope creep: every mutation the
loop performs is still the same per-field-approved-plan / fail-closed
machinery described below, just running for hours unattended instead of one
job at a time under a human's eye. The honest caveat is that "deterministic
+ fail-closed" has visibly not meant "error-free at scale" — see §4.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI (essay + predict-tier + triage LLM call sites, all separately flagged).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture, largely holding under load:** every mutation capability sits behind a named fail-closed env flag (`FORM_FILL_ENABLED`, `SUBMIT_ENABLED`, `DRY_RUN`, plus newer ones below — full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Demographic/EEO fields are still architecturally fenced to the sensitive profile only. One gap surfaced by live operation: nothing yet stops a bank/predicted answer from being applied to an *identity* question (name/email/phone) — see §4 (#263).
- **Essay + screener prediction is now live, not just designed:** `src/applications/essayAutofill.ts` generates from `private/candidate/about-me.md` under `ESSAY_AUTOFILL_ENABLED`/`SCREENER_PREDICT_LLM_ENABLED` (operator directive 2026-08-15), output gated by `validateDraft`. As of commit `626a3276` (2026-09-11, #268), the predict tier also answers authorization/salary-adjacent free text that isn't itself a demographic/compensation/criminal question — narrower than it sounds: after issue #259 (predict answered a visa-expiry question), a shared `SENSITIVE_QUESTION` fence was pushed down into the predict tier itself, not just the essay layer, so status/expiry/compensation questions are excluded by construction, not by convention.
- **Validation ladder** (`UNIT_CONFIRMED → FIXTURE_CONFIRMED → LIVE_READ_ONLY_CONFIRMED → LIVE_MUTATION_CONFIRMED`, `UNVERIFIED` default) is still the project's stated discipline, but **the per-repo status docs have stopped tracking it accurately** — see §4's top risk. In actual practice, live Greenhouse/Lever/Ashby/Workday fill+submit, essay/predict-tier answers, and the Gmail outreach tail are all running with real read-back verification nightly, i.e. functioning at `LIVE_MUTATION_CONFIRMED`, even though `docs/current-state-and-phase56.md` still states several of these as `FIXTURE_CONFIRMED`/`UNVERIFIED`.
- **ATS coverage today:** Greenhouse, Lever, Ashby, and Workday all have live submissions on record (e.g. Palantir/Lever, Exegy/Ashby, Northrop/Workday, multiple Greenhouse boards) — a material expansion from the "Greenhouse only" state as of 2026-08-07. `docs/ats-adapters-lever-ashby.md` and `docs/ats-adapter-workday.md` still say "no live run ever performed," which is now false.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

**The docs say "Phase 5.6 — live validation of already-built Phase 0–13
machinery," blocked on live discovery returning zero jobs. That phase is
over and undeclared.** Live discovery, live fill, and live submit across
four ATS platforms have been running nightly for over two weeks; the
`storageState({ indexedDB: true })` fix speculated in the prior version of
this doc was never applied — the actual unblock appears to have been a
direct-ATS-board-API discovery path (`ATS_DISCOVERY_ENABLED`, `discover:ats`)
that bypasses the JobRight feed-scrape entirely, though the exact commit
predates this shallow clone's history and isn't independently confirmed.

- **Where things actually stand:** an autonomous nightly loop applies to
  real postings, fills real forms (including revealed/conditional form
  sections, EEO signature fields, Lever's async location typeahead, Workday
  wizard pages), drafts real outreach emails in a Gmail-isolated Chrome, and
  fixes its own bugs same-night under the standard verify gate. New flags
  in active nightly use: `ATS_DISCOVERY_ENABLED`, `AUTOMATION_ENABLED`,
  `TRIAGE_LLM_ENABLED`/`TRIAGE_ACT_ENABLED` (LLM chooses/executes failure
  remediation), `NAV_LLM_ASSIST_ENABLED`, `SUPABASE_SYNC_ENABLED`,
  `CONSOLE_HOSTED_MODE_ENABLED`.
- **Still deliberately human-only:** work-authorization *status* questions
  (citizen/visa/permanent-resident checkboxes), salary/compensation
  questions, and anything demographic — the predict tier was explicitly
  narrowed (not widened) on this front after #259.
- **Immediate open items per the project's own night30 handoff
  (2026-09-11):** a "High School Name" field is the last blocker on two
  Palantir applications; an identity-field guard (never let a bank/predicted
  answer fill a name/email/phone question) is named but not yet built;
  gate-parked rows are re-picked every cycle until triage catches them
  (~15 wasted cycles/night).
- **Documentation debt is now the primary technical-direction risk**, not a
  missing capability: `docs/current-state-and-phase56.md`,
  `docs/known-limitations.md`, and the ATS adapter docs need a real rewrite
  to reflect current capability before they mislead a future session (human
  or agent) into re-litigating already-solved problems or, worse, trusting
  a stale "gated off" description of something that is now live. This doc
  intentionally does not attempt that rewrite itself (see the framing note
  at the top) — it's flagged here as the thing to do next.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo —
**note: these are the stale docs described above**, useful for historical
design rationale but not current status):
`docs/architecture.md` · `docs/current-state-and-phase56.md` ·
`docs/known-limitations.md` · `docs/validation-levels.md` ·
`artifacts/overnight-issues-2026-09-11.md` (most reliable current-state source).

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
never to a negative capability judgment.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / OpenAI / Resend / **Supabase (new, optional persistence + hosted-console backend)**.
- **Pipeline:** `resolve identity (LinkedIn + website) → expand graph hop-1 (GitHub collaborators/followers, Substack) → optional hop-2 (UI-driven only) → score → persist → assess (LLM judges, priority_score) → digest email`, with a feedback loop now capturing signal on the way back in (see §2.3).
- **Scoring has materially evolved** from the "final_score heuristic" described in the prior version of this doc. `src/scoring/computeScore.ts` combines builder/thinker/olympiad/weirdness/identity terms with a new **convergence** term (repeat seed-graph hits), then applies `ageScalar()` — a sweet-spot curve peaking 1.4x at ages 17–19 and decaying sharply (cubic, floor 0.25) above 20. `computeObscurity.ts` scores "how undiscovered" someone is (GitHub followers/stars, website substance, writing, LinkedIn connections, renormalized for missing signals); `upsideVector()` = obscurity × LLM-judged substance ("corroborated GitHub," damped by the ownership-share fix below). A separate frozen 5-slot **youth wildcard** pool (`src/assessment/youthWildcard.ts`) surfaces 17–19-year-olds independent of the main ranking. `final_score` stays the legacy 0–3 discovery scale; a new `overall_score` (1–10) is the recruiter-facing number — the discovery/assessment score separation from the prior doc is preserved, just with an added presentation layer on top.
- **Ownership-share scoring bug (High severity in the prior review) is fixed.** `collectOwnershipEvidence.ts` now uses the repo-wide sampled commit count as the denominator (not the candidate's own commits) and requires direct changed-file evidence plus provenance caps (fork/template/course/generated-code) before granting `high_ownership_support` — this closes the "share ≈ 1.0 whenever any commits exist" bias flagged in `assessment-rubric-architecture-audit.md`. That audit doc itself is unedited since 2026-07-21 and now reads as describing a bug that no longer exists — same class of doc-drift as jobright's §1.3, smaller scale.
- **Safety-flag layer now exists** (fixed the prior review's Medium finding): `CLAUDE.md` + `.cursor/rules/tsearch.mdc` (added 2026-08-10) define concrete fail-closed conventions — hardcoded PII-path gitignore list with a same-commit rule for new paths, `digest:send` defaults `--dry-run`, `ASSESSMENT_MOCK_LLM=1` default for tests, `LINKEDIN_DELAY_MS` pacing with no bulk cache-bypass. Residual gap versus jobright: no code-enforced env-flag gate (no `SUBMIT_ENABLED`-equivalent) and no forbidden-API CI check — these remain convention, enforced by discipline and the house-rules doc rather than by a build-breaking check.
- **New Supabase backend** (`src/storage/supabase/`, `supabase/migrations/0001_init.sql`, commit `96dd18b`) is well-hardened on inspection: every PII-bearing table (`people`, `profiles`, `tree_edges`, `candidates`, `marks`, `feedback`, `assessment_runs`) has row-level security enabled with explicit deny-all policies for both `anon` and `authenticated` roles, meaning access must go through a server-side service-role key — consistent with the project's post-incident PII discipline rather than a new instance of the old problem. Paired with this is a large new `src/pipeline/websiteGraph.ts` (952 lines) feature, not yet characterized in any doc.
- **LinkedIn scraping hardening: 2 of the prior review's 4 items fixed.** Mid-run re-authentication detection now exists (`assertLinkedInAuth()` in `linkedinBrowser.ts`, checked on every search/extract call, not just session open) and `tests/linkedin/` now has real coverage (auth guard, matching, age, search-query tests). Still missing: retry/trace/screenshot capture on scrape failure, and `expected_country` is still not compared against a scraped profile's actual location to reject homonym mismatches (`linkedinMatch.ts:64-71` only uses it to toggle search behavior).

### 2.3 Technical direction

- **Digest feedback loop, Phase 3 of 4, is now built.** `POST/GET /api/feedback`, an explore-queue endpoint, and `feedbackStore.ts` capture relevant/not-relevant/explore-network signal keyed to a stable candidate id. Phase 4 — actually feeding that signal back into ranking — is still unbuilt (no scoring file references the feedback store yet).
- **Priority-v2 and the "Cory" persona judge remain explicitly not trustworthy alone:** `PRIORITY_V2_REQUIRES_CALIBRATION = true` is still literal in `synthesizeCandidate.ts`, and per `docs/rubric-agents-verification-audit.md` (also last touched 2026-07-21), Cory is still fixture-only / unwired in the live `runAssessment` path.
- Open product question from the prior review — global top-N vs. per-seed neighbors, and whether Substack-only candidates belong in the digest at all — remains unresolved in the docs; no evidence either way was found this pass.

Deeper detail: [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/assessment-rubric-architecture-audit.md`](./assessment-rubric-architecture-audit.md) (**stale — describes a fixed bug, see §2.2**)

---

## 3. How the two projects relate

jobright-application-agent is a **hardened descendant** of tSearch's session/
scraping infrastructure, not an unrelated project (`docs/tsearch-reuse-map.md`
records the original reuse plan). Both projects now show the *same shape* of
technical debt independently: a fast-moving implementation outrunning its
own status docs (jobright's Phase 5.6 docs vs. weeks of live autonomous
operation; tSearch's ownership-audit and Cory-verification docs vs. a fixed
bug and an unchanged judge respectively). Worth treating as one pattern
rather than two coincidences — whatever process fix addresses it (e.g. a doc
staleness check, or folding key state into a generated brief the way
tSearch's `npm run brief` already does) is likely worth applying to both
repos, not just the one where it was noticed this pass.

One cross-repo idea worth transplanting: jobright's predict tier just needed
a hand-added `SENSITIVE_QUESTION` fence *after* a live incident (#259, a
visa-expiry question got model-answered) to stop it answering fields outside
its intended scope, and separately still lacks a guard against answering
*identity* questions (name/email/phone — the cause of the Bear Robotics
"Full Name: N/A" submission, see §4). tSearch's judge system already has a
structural version of this discipline: rubrics force evidence-grounded,
per-criterion answers rather than open-ended free text. Applying the same
idea to jobright's predict/bank tier — classify a field's *semantic type*
(identity / eligibility / other) before allowing a promoted bank entry to
match it, refusing promotion for identity-shaped answers outright — would
turn the current allowlist-of-excluded-topics approach into a safer
allowlist-of-permitted-shapes one, and would have caught both #259 and #263
by construction rather than by patching each incident after the fact.

`docs/tsearch-reuse-map.md` remains stale on one point carried over from the
prior review: it still describes porting `linkedinExtract.ts` into a
`packages/linkedin-enrichment` module "in Phase 10," but LinkedIn enrichment
was dropped by decision for the jobright MVP. Still unfixed; still low
severity.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **High** | jobright | Core status docs (`docs/current-state-and-phase56.md`, `docs/known-limitations.md`, both ATS adapter docs) describe a blocked, fixture-only Phase 5.6 project, while the actual system has run live, self-repairing, unattended overnight applications across four ATS platforms for over two weeks. | A future session (human or agent) reading these docs for context would materially misjudge what's safe to assume is gated vs. live. This is the single biggest gap between documented and actual state found in this review, on either repo. |
| **High** | tSearch | `profiles/`/`backup/` (202 files of scraped real people's LinkedIn PII) were untracked from HEAD and gitignored on 2026-08-10, but the commit's own message says "history purge still required separately," and that purge has not happened: `git log --all` shows no filter-repo/BFG-shaped rewrite, and `skale-07/tSearch` is confirmed still public (`"private": false"` via the GitHub API). | Downgraded from the prior review's Critical (it's no longer actively re-leaked on every new commit or clone of HEAD), but the exposure is still real and still recoverable by anyone who checks out an older commit or clones full history from the public repo. The fix (`git filter-repo` + force-push + coordinate with anyone who has a clone) is still outstanding. |
| **Medium** | jobright | No guard yet prevents a bank/predicted answer from filling an *identity* question (name/email/phone). This produced one real, already-sent defect: Bear Robotics' application (2026-09-01) was submitted with "Full Name" answered "N/A" by a poisoned screener-bank entry (issue #263). Three other poisoned entries were cleaned the same night; a Swarm Aero submission also went out for a role outside the operator's field (bare "engineering" term match), and one Greenhouse job (DV Trading) was submitted twice via two board postings before dedupe caught the class of bug. | The operator's own nightly process already found, disclosed (night30 handoff, "Read this first — things that affect applications already sent"), and partly remediated all three of these — they are known, not newly discovered here. Flagging because the general guard ("an identity/name/email/phone question is never eligible for a bank or predicted answer") is explicitly named as still-missing in the artifact log, and is the kind of narrow, well-scoped fix that would prevent a whole class of future incidents rather than patching them one at a time. |
| **Medium** | tSearch | LinkedIn scrape-failure hardening is half-done: mid-run re-auth detection and LinkedIn tests now exist (fixed), but there is still no retry/trace/screenshot capture on scrape failure, and a scraped profile's actual location is still never checked against `expected_country` to reject a homonym match. | Silent wrong-person matches and hard-to-diagnose live failures are both still possible; the same class of problem jobright already solved for its own live paths via traces/screenshots/read-back verification. |
| **Low** | jobright / tSearch | Both repos have internal audit/status docs that now describe fixed bugs or stale plans as current: jobright's ATS-adapter docs ("no live run ever performed"), tSearch's `assessment-rubric-architecture-audit.md` (ownership bug, fixed) and `rubric-agents-verification-audit.md` (Cory wiring — actually still accurate, worth double-checking on the next pass), and `tsearch-reuse-map.md`'s stale Phase-10 LinkedIn-enrichment reference. | Not a defect in either product, just doc drift compounding across both repos (see §3) — worth a dedicated pass rather than one-off fixes, since it's clearly a recurring pattern, not an accident. |
| **Low** | tSearch | Digest-loop Phase 4 (ranking refinement from Phase-3 feedback, now captured) is still unbuilt; priority-v2/Cory remain `requires_calibration`/fixture-only. Open product question (global vs. per-seed top-N; Substack-only filtering) still unresolved. | Unfinished direction, not a defect — worth tracking so Phase 3's now-collected feedback doesn't sit unused indefinitely. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent**

- **Field-type allowlisting for predict/bank answers** (cross-repo idea, not
  external — see §3): the concrete, scoped fix for this review's Medium
  jobright risk. Classify a field's semantic type before allowing any
  bank/predicted answer to fill it; refuse identity-shaped fields (name,
  email, phone) outright rather than relying on an ever-growing exclusion
  list discovered incident-by-incident.
- **Playwright `storageState({ indexedDB: true })`** (≥1.51) — carried over
  from the prior review; now moot for the original live-discovery blocker
  (superseded by direct ATS-board-API discovery), but still worth trying if
  JobRight-native session capture (as opposed to board-API discovery) is
  ever revisited.
- **Stagehand** (`browserbase/stagehand`) and **browser-use** — both still
  reasonable Phase-6-style fallback candidates for unsupported ATS, per the
  repo's own `browser-use-evaluation.md`; less urgent now that four ATS
  platforms are live on the deterministic path, so lower priority than the
  identity-field guard above.

**tSearch**

- **RULERS-style rubric evaluation** (2026 arXiv work on LLM-judge
  reliability): versions rubric criteria as immutable bundles, requires
  judges to cite auditable evidence for every scoring decision, and applies
  post-hoc calibration against human labels — a more concrete framework
  than the previously-noted Autorubric for actually measuring and fixing
  which of the existing judge dimensions are noisy, directly relevant given
  Cory and priority-v2 both remain uncalibrated.
- **GitHub-graph-first identity resolution** (GitHub GraphQL over
  followers/stargazers/forks + community detection) — still relevant as a
  ToS-compliant complement that could shift weight away from LinkedIn
  scraping as the primary signal; unchanged from the prior review, still
  worth doing given LinkedIn hardening is only half-complete (§4).
- **Stratified sampling for judge-output validation** (ECIR 2026): reduces
  how much LLM-judge output needs human validation to reach a given
  confidence level, versus simple random sampling — applicable once Phase 3
  feedback data is used to check the assessment judges' actual reliability,
  rather than assuming it.

---

## Changelog

- **2026-09-13** — Full refresh. Reviewed both repos' git history, docs, and
  current artifacts since the 2026-08-07 baseline; zero open GitHub issues
  and zero open PRs on both repos (confirmed via GitHub API), unchanged.
  Major update: jobright has gone from a blocked, fixture-only Phase 5.6 to
  weeks of live autonomous overnight operation across four ATS platforms,
  which the repo's own deeper status docs have not caught up to (now the
  top-flagged risk). tSearch fixed 3 of the prior review's flagged issues
  (ownership-share bug, safety-flag layer, mid-run LinkedIn re-auth) and
  partially fixed a fourth (LinkedIn tests exist, but scrape-failure
  tracing and country-based homonym rejection still don't); its Critical
  PII risk is downgraded to High (no longer actively re-leaking, history
  purge still outstanding, repo confirmed still public). New Supabase
  backend in tSearch inspected directly (RLS policies) and found
  well-hardened, not a new instance of the old PII problem.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
