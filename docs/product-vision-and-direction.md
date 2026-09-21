# Product vision & technical direction — jobright-application-agent ("Dispatch") + tSearch

Mirror of `docs/product-vision-and-direction.md` in `skale-07/jobright-application-agent`
— keep both files identical when editing. This is a **living document**,
refreshed by a scheduled review. It is not a proof log or a phase-status doc
(those already exist per-repo — see the "Deeper detail" links below) — it
exists so both projects' vision, architecture, and direction stay legible
from one place, and so risks that only show up when you look at *both* repos
together (shared lineage, shared operator, shared data-handling posture)
don't get missed.

**Naming note:** jobright-application-agent renamed its product to
**"Dispatch"** in-repo on 2026-08-17 (`package.json`, `README.md`, `AGENTS.md`
— "Operator directive 2026-08-18"). `CANDIDATE_DATA_KEY_NAME`, `src/jobright/`,
and `JOBRIGHT_*` flags were deliberately left unrenamed (they name the
external service, JobRight.ai, not the product). The GitHub repository itself
is still addressed as `skale-07/jobright-application-agent` — this session
could not confirm a GitHub-side repo rename actually happened (README claims
"GitHub redirects the old URLs," unverified). This doc uses "jobright" for
the repo/section identity and "Dispatch" when referring to the branded
product, matching what the repo's own docs have started doing.

**Process note on this refresh:** the two copies of this file had drifted —
jobright's copy (last touched 2026-08-07, plus an unmerged 2026-09-13 draft
on branch `claude/busy-clarke-2lxizm`) had started adopting "Dispatch"
section headers; tSearch's copy (untouched since 2026-08-07) had not. That
2026-09-13 draft was never merged to jobright's `master`, which then
diverged another 5 days ahead of it (M13–M25, see §1.3) — so even the
mirror meant to catch doc drift had itself drifted and fragmented. This
refresh reconciles both copies into one canonical version, folds in the
unmerged draft's analysis, and updates it for what changed since 2026-09-13.

| Field | Value |
| --- | --- |
| Last reviewed | 2026-09-21 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` ("Dispatch", private), `skale-07/tSearch` (**public**) |

---

## 1. jobright-application-agent ("Dispatch")

### 1.1 Vision

A **local, deterministic, operator-controlled** Playwright agent that automates
the mechanical parts of *your own* job-application workflow — JobRight.ai /
direct-ATS discovery → employer ATS form fill → gated submit → outreach →
Gmail/Outlook drafts — while keeping every judgment call (essays, demographics,
uncertain submissions) with a human. It is explicitly **not** trying to be a
general autonomous browser agent. The product bet is that determinism +
fail-closed gating + an honest validation ladder beats an LLM-driven agent for
a task where a wrong click (an accidental real submission, a leaked
credential, an invented EEO answer) is expensive and hard to undo.

**That bet is now being tested at real scale, and the product itself is
scaling with it.** Since roughly 2026-08-28 an operator-directed unattended
overnight loop (`src/automation/autoCycle.ts`, gated `AUTOMATION_ENABLED`)
has applied to real jobs across four ATS platforms nightly, drafted outreach
in an isolated Gmail-CDP Chrome, and self-repaired its own bugs under the
standard verify gate (`artifacts/overnight-issues-*.md`). Separately, as of
2026-08-17/18, the project pivoted from a single-operator local tool toward
a **hosted, multi-tenant product** ("Dispatch") aimed at a broad audience
(`docs/marketing/college-launch.md` targets college students for fall
recruiting: "It applies while you're in class."). Both expansions are
deliberate, operator-directed scope growth, not scope creep — but "works for
one careful operator" and "works unattended, for many tenants, at scale" are
different claims, and the honest caveat is that the first has visibly not
meant "error-free," even before the second is proven (see §4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Supabase (hosted tenant data + auth) / OpenAI (essay, predict-tier, triage, nav-assist LLM call sites — each separately flagged).
- **Source of truth:** SQLite (`data/app.sqlite`) per engine instance — queue state, transitions, leases, idempotency, review items. `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture, largely holding under load:** every mutation capability sits behind a named fail-closed env flag (~30 now, full list in `CLAUDE.md`). `chromium.launch` is confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. **One gap surfaced by live operation and still open:** nothing yet stops a bank/predicted screener answer from being applied to an *identity* question (name/email/phone) — see §4, issue #263, still unresolved as of the latest commit checked (`HEAD` on 2026-09-21).
- **New multi-tenant hosted engine** (`TENANT_ENGINE_ENABLED`, `src/tenants/{run,workspace,paths,keys}.ts`): per-tenant HKDF-derived crypto keys, workspace materialization from Supabase rows into the engine's own file formats, `tenant:run`/`tenant:scheduler` CLIs. `src/tenants/childEnv.ts`'s `composeChildEnv` is a **flag-ceiling model**: a tenant child process can never hold a gated flag the operator's own `.env` lacks, several flags are hard-forced off for every tenant regardless (`ARTIFACT_AUTOPUSH_ENABLED`, `OUTLOOK_*`, `LINKEDIN_ENRICHMENT_ENABLED`, `TRIAGE_ACT_ENABLED`, and more — the `TENANT_FORCED_OFF` list), secrets are stripped per tenant, and unattended submits are bounded by a quota budget. Architecturally, fail-closed gating is inherited downward rather than weakened by going multi-tenant — but this is `UNIT_CONFIRMED` only; live tenant runs against a real sealed JobRight session are explicitly `UNVERIFIED` pending flags-on testing (`docs/roadmap/cloud-deploy.md` rows 25–31).
- **Remote/hosted browser:** `REMOTE_BROWSER_ENABLED`, `BROWSER_USE_ENABLED`, `BROWSER_USE_AGENT_ENABLED` (`src/browser/remoteBrowser.ts`, `browserUseCli.ts`, `src/auth/cdpPolicy.ts`) — Browserbase and "Browser Use Cloud v4" as remote-browser providers so a hosted tenant can sign into JobRight/Gmail without a local Chrome.
- **Demographic/EEO handling reversed and re-hardened (2026-09-11, commit `8619f4c0c`, per CLAUDE.md decision note):** the 2026-09-01 decision to bar hosted users from ever supplying EEO/self-ID answers was reversed. New `user_sensitive_profiles` table (migration `20260911000500`): ciphertext + `answered_keys` (field *names* only, never values), per-field opt-in / "prefer not to answer," no client-readable policy or view, `engine_read_sensitive_profile()` is service-role-only (revoked from `anon`/`authenticated`), and `sensitive_profile_fields()` is drift-tested against the engine's own schema so the DB can't silently diverge from what the fill code expects. Design reads as sound: never aggregated, never inferred, re-encrypted into the tenant's own workspace key before use. Validated to `UNIT_CONFIRMED`/schema-apply `LIVE_MUTATION_CONFIRMED` only — no live field-fill under this path has been independently verified yet.
- **Essay/predict-tier scope was narrowed after a live incident, not widened:** after issue #259 (the predict tier answered a visa-expiry question), a shared `SENSITIVE_QUESTION` fence was pushed into the predict tier itself (not just the essay layer, `commit 626a3276`, #268) — status/expiry/compensation questions are excluded by construction now, not by convention.
- **ATS coverage — materially ahead of its own docs:** live submissions are now on record across **Greenhouse, Lever, Ashby, and Workday** (e.g. Palantir/Lever, Exegy/Ashby, Northrop/Workday), a real expansion from "Greenhouse only." `docs/ats-adapter-workday.md` and `docs/ats-adapters-lever-ashby.md` still say "no live run ever performed" — this is now false; see §4's doc-drift risk.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3); tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

**The docs still describe "Phase 5.6 — blocked on live discovery returning
zero jobs." That phase is over and undeclared.** Live discovery, fill, and
submit across four ATS platforms have run nightly for three-plus weeks. The
`storageState({ indexedDB: true })` fix speculated in the prior version of
this doc was apparently never needed — the actual unblock looks to be a
direct-ATS-board-discovery path (`ATS_DISCOVERY_ENABLED`, `discover:ats`)
that bypasses the JobRight feed-scrape entirely, bypassing the original
blocker rather than fixing it.

- **The real current top blocker is hosted-launch operational readiness, not
  engine capability:** per `docs/roadmap/launch-checklist-2026-09-14.md`,
  live-observed (2026-09-15) Supabase auth-provider misconfiguration
  (GitHub OAuth client-id field holding the app *name* instead of the actual
  client ID) and a Google OAuth `redirect_uri_mismatch` are blocking hosted
  sign-in for real tenants. This is a config/launch problem, not a safety
  regression, but it's what's actually gating the multi-tenant rollout today.
- **Immediate safety-relevant open item:** the identity-field guard
  ("never let a bank/predicted answer fill a name/email/phone question")
  named in the project's own night30 handoff (2026-09-11, after the Bear
  Robotics "Full Name: N/A" incident, issue #263) is still not built as of
  the latest commit reviewed. See §4 — this is the single most concrete,
  scoped, and overdue fix this review found.
- **Still deliberately human-only:** work-authorization *status* questions,
  salary/compensation questions, and anything demographic (outside the new
  opt-in sensitive-profile path above) — narrowed, not widened, after #259.
- **Documentation debt is itself now a standing technical-direction risk,
  not a one-time gap:** `docs/current-state-and-phase56.md`,
  `docs/known-limitations.md`, and both ATS adapter docs were already stale
  at the 2026-09-13 review and remain stale today, six weeks after the
  underlying capability moved. A future session trusting these could
  mistake live capability for gated/fixture-only, in either direction.
- **Deliberately not (yet) in scope:** Outlook send (permanently out of
  scope), silent expansion to unreviewed ATS platforms, replacing the
  deterministic adapters with an LLM agent as the default path.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo —
**note: `current-state-and-phase56.md`, `known-limitations.md`, and the ATS
adapter docs are stale, see above; `docs/roadmap/cloud-deploy.md` and
`artifacts/overnight-issues-*.md` are the more reliable current-state
sources**): `docs/architecture.md` · `docs/roadmap/cloud-deploy.md` ·
`docs/roadmap/launch-checklist-2026-09-14.md` · `docs/validation-levels.md`.

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
- **Safety-flag layer now exists** (closes the prior review's Medium finding): `CLAUDE.md` (added 2026-08-10, extended 2026-08-24) codifies fail-closed conventions — hardcoded PII-path gitignore with a same-commit rule for new person-data paths, `digest:send` defaulting `--dry-run`, `ASSESSMENT_MOCK_LLM=1` default for tests, `LINKEDIN_DELAY_MS` pacing with no bulk cache-bypass. Residual gap vs. jobright: still convention-and-doc-enforced, not code-enforced — no `SUBMIT_ENABLED`-equivalent flag registry, no forbidden-API CI check.
- **Scoring has materially evolved** beyond the old single `final_score` heuristic: `src/scoring/computeScore.ts` now combines builder/thinker/olympiad/weirdness/identity terms with a **convergence** term (repeat seed-graph hits), then applies `ageScalar()` — a sweet-spot curve peaking 1.4x at ages 17–19, decaying cubically (floor 0.25) above 20. `computeObscurity.ts` scores "how undiscovered" someone is (GitHub followers/stars, website substance, writing, LinkedIn connections); `upsideVector()` = obscurity × LLM-judged substance ("corroborated GitHub" — GitHub only counts when the profile itself links back to the known identity, preventing misattribution — damped by the ownership-share fix below). A frozen 5-slot **youth wildcard** pool (`src/assessment/youthWildcard.ts`) surfaces 17–19-year-olds outside the main ranking; the most recent commit (`a52881b`, 2026-09-18) fixed this pool leaking into the ranked Assess list, and stopped the seed-tree UI from silently writing hop-1 neighbors as empty stubs when they fell outside the top-80 `MAX_CANDIDATES` cut (a real collaborator/follower data-loss bug, not cosmetic). `final_score` stays the legacy 0–3 discovery scale; a new recruiter-facing `overall_score` (1–10) sits on top — discovery/assessment separation is preserved.
- **New judges/quality passes:** an **experience-distinctiveness judge** scores a stated career path on rarity/agency/concreteness and explicitly bans "prestige as rarity"; **tiered recruiter labels** assign one of 6 archetypes (e.g. Garage Builder, Weird-Bet Experimentalist) with urgency tiers from already-computed judge outputs (no re-scoring); the writing judge's rubric v2 now requires a contrarian claim be *demonstrated* (falsifiable, directly rebutted), not just toned contrarian; judge prose was rewritten to plain-language "what they built" rationales, banning score-speak (prompt versions bumped so caches invalidate correctly).
- **Ownership-share scoring bug (High severity, prior review) is fixed:** `collectOwnershipEvidence.ts` now gates on a genuine unfiltered-sample denominator (`shareKnown`) instead of synthesizing 1.0, and requires direct changed-file evidence plus fork/template/course/generated-code provenance caps before granting `high_ownership_support`, with a regression test. `docs/assessment-rubric-architecture-audit.md` (last touched 2026-07-22) is now stale in the other direction — it still describes the bug as live.
- **New Supabase backend inspected directly and found well-hardened:** every PII-bearing table (`people`, `profiles`, `tree_edges`, `candidates`, `marks`, `feedback`, `assessment_runs`) has RLS enabled with explicit deny-all for both `anon` and `authenticated` — access requires a server-side service-role key. This is consistent with the project's post-incident PII discipline, not a new instance of the old problem. Paired with a large, not-yet-documented `src/pipeline/websiteGraph.ts` (952 lines) that screen-scrapes named people off third-party websites into the graph — worth the same PII-hygiene scrutiny LinkedIn scraping already gets, since no doc currently covers it.
- **LinkedIn scraping hardening: half-done.** Mid-run re-authentication detection now exists (`assertLinkedInAuth()`/`LinkedInAuthError` checked on every search/extract call) and a first LinkedIn test suite landed (`tests/linkedin/authGuard.test.ts`, `linkedinAge.test.ts`, `linkedinMatch.test.ts`, `searchQuery.test.ts`) — closing two of the four gaps flagged in the prior review. Still open: no retry/trace/screenshot capture on scrape failure, and `expected_country` is still never compared against a scraped profile's actual location to reject a homonym match (`linkedinMatch.ts` only uses it to toggle search behavior, not to reject).

### 2.3 Technical direction

- **Digest feedback loop, Phase 3 of 4, is now genuinely built** (not just labels): `feedbackStore.ts` (append-only, per-candidate), `POST/GET /api/feedback`, an explore-queue endpoint, and `buildDigest` wiring where `not_relevant` hides and `relevant` boosts ordering while leaving `priority_score` itself untouched, plus a Relevant/Not-relevant/Explore-network UI. Phase 4 — actually feeding that captured signal back into ranking — is still unbuilt; no scoring file references the feedback store yet. `docs/email-digest-implementation-context.md`'s Phase 3/4 planning table is unedited post-implementation — same doc-drift pattern as jobright, smaller scale.
- **Priority-v2 and the "Cory" persona judge remain explicitly not trustworthy alone:** `PRIORITY_V2_REQUIRES_CALIBRATION = true` is still literal in code, and per `docs/rubric-agents-verification-audit.md` (also last touched 2026-07-21), Cory is still fixture-only in the live `runAssessment` path.
- Open product question from prior reviews — global top-N vs. per-seed neighbors, and whether Substack-only candidates belong in the digest — remains unresolved; no new evidence either way this pass.

Deeper detail: [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/assessment-rubric-architecture-audit.md`](./assessment-rubric-architecture-audit.md) (**stale — describes a fixed bug, see §2.2**)

---

## 3. How the two projects relate

jobright-application-agent/Dispatch is a **hardened descendant** of tSearch's
session/scraping infrastructure (`docs/tsearch-reuse-map.md` records the
original reuse plan), not an unrelated project. Three things now link them
more than lineage alone:

- **Both are independently reaching toward hosted, multi-tenant/shared
  infrastructure at the same time** — Dispatch's `TENANT_ENGINE_ENABLED` +
  Supabase-backed tenant workspaces, and tSearch's new Supabase persistence
  layer. Dispatch's flag-ceiling model (`childEnv.ts`) is the more mature
  version of the discipline this pattern needs ("hosted/shared infra must
  never grant a capability the operator didn't already have locally");
  tSearch's Supabase layer is earlier-stage but currently *more* strict in
  one sense (RLS deny-all with no write path at all yet, vs. a real flag
  system) — worth having tSearch adopt Dispatch's explicit-flag discipline
  once it starts writing real person data through that layer, rather than
  relaxing today's deny-all posture piecemeal.
- **Both show the same shape of technical debt, independently, three
  review cycles running:** a fast-moving implementation outrunning its own
  status docs. Aug 7: neither repo's docs were badly stale yet. Sep 13
  (unmerged draft): jobright's Phase-5.6/ATS docs were already badly behind
  live reality; tSearch's ownership-audit and Cory-verification docs were
  stale in a smaller way. Sep 21 (this review): the same jobright docs are
  *still* stale, now joined by the new hosted-launch docs, and the
  Sep-13 draft itself sat unmerged long enough to go stale a second time.
  This is a recurring pattern, not a one-off — see §4's top risk.
- **A concrete cross-pollination opportunity, not yet acted on:** tSearch's
  judge system structurally forces evidence-grounded, per-criterion
  scoring rather than open-ended free text. Applying the same idea to
  Dispatch's predict/bank-answer tier — classify a field's *semantic type*
  (identity / eligibility / other) before allowing a promoted bank entry to
  match it, refusing identity-shaped fields outright — would turn Dispatch's
  current allowlist-of-excluded-topics (patched reactively after #259, still
  missing after #263) into a safer allowlist-of-permitted-shapes, catching
  both incidents by construction. See §5 for a concrete implementation angle.

`docs/tsearch-reuse-map.md` remains stale on one point carried over from two
prior reviews: it still describes porting `linkedinExtract.ts` into a
`packages/linkedin-enrichment` module "in Phase 10," but LinkedIn enrichment
was dropped by decision for the Dispatch MVP. Still unfixed; still low
severity; flagging a third time mainly as more evidence for the doc-drift
pattern above.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | tSearch | Real people's scraped LinkedIn PII (`profiles/`, `backup/`, 202 files — names, LinkedIn URLs, photos, education) was untracked from `HEAD` and gitignored on 2026-08-10 (commit `f5ad384`), but that commit's own message says "history purge still required separately" — **it still hasn't happened**. `git rev-list --objects --all` still shows 349 blob/tree objects reachable, e.g. `backup/20260713-131214/profiles/madanva/collaborators/hermabr/profile.json`, and the repo is confirmed still public. | The 2026-09-13 draft downgraded this to High on the reasoning that new commits no longer add to the exposure. This review disagrees and restores Critical: the *existing* exposure of real third parties' unconsented PII is fully and trivially reachable today by anyone who clones full history from a public repo, exactly as it was on 2026-08-07, and the flagged fix (`git filter-repo`/BFG + force-push + notify anyone with an existing clone) has now sat undone through three review cycles despite being named explicitly each time. |
| **High** | jobright | Core status docs (`docs/current-state-and-phase56.md`, `docs/known-limitations.md`, both ATS adapter docs) describe a blocked, fixture-only Phase 5.6 project, while the actual system has run live, self-repairing, unattended overnight applications across four ATS platforms for three-plus weeks, and is now mid-launch on a hosted multi-tenant product these docs don't mention at all. | A future session (human or agent) reading these docs for context would materially misjudge what's safely gated vs. already live in production. This is the largest documented-vs-actual gap found on either repo, and it has now persisted (and grown) across two full review cycles without being closed. |
| **High** | jobright | No guard yet prevents a bank/predicted answer from filling an *identity* question (name/email/phone). Already caused a real, sent defect: a Bear Robotics application (2026-09-01) submitted with "Full Name" answered "N/A" (issue #263) from a poisoned screener-bank entry; a Swarm Aero submission also went to an out-of-field role via a bare keyword match; one Greenhouse posting was double-submitted via two board listings before dedupe caught it. | Escalated from Medium (2026-09-13 draft) to High: the fix is named, scoped, and still not built three weeks after the incident that motivated it, and it's a live safety gap in the exact submit-gating machinery the project treats as non-negotiable elsewhere. See §5 for a concrete implementation angle. |
| **Medium** | jobright | Hosted-launch readiness: Supabase GitHub-OAuth provider misconfigured (client-id field holds the app name, not the ID) and a Google OAuth `redirect_uri_mismatch`, both observed live 2026-09-15, blocking real-tenant sign-in. | Operational/launch-blocking rather than a safety regression — tenant sign-in failing closed is the safe failure mode — but it's the actual bottleneck on the hosted-product direction right now and worth tracking to resolution. |
| **Medium** | jobright / tSearch | The marketing pivot to a broad-audience hosted product (`docs/marketing/college-launch.md`) is a real strategic shift from "single careful operator" to "many unattended tenants," and the flag-ceiling architecture (§1.2) looks sound on inspection — but it is `UNIT_CONFIRMED` only; no live multi-tenant run under real user diversity has happened yet. | Worth watching specifically for the failure mode where a well-designed ceiling has an unanticipated gap that only shows up under real (not operator-controlled) usage patterns — the opposite of the deliberate, single-operator conditions the safety architecture was originally proven under. |
| **Medium** | tSearch | LinkedIn scrape-failure hardening is half-done: mid-run re-auth detection and LinkedIn tests now exist, but there is still no retry/trace/screenshot capture on scrape failure, and a scraped profile's actual location is still never checked against `expected_country` to reject a homonym match. | Silent wrong-person matches and hard-to-diagnose live failures both remain possible — the same class of problem jobright already solved for its own live paths via traces/screenshots/read-back verification. |
| **Low** | jobright / tSearch | Secondary doc drift beyond §4's top risk: jobright's ATS-adapter docs ("no live run ever performed" — now false), tSearch's `assessment-rubric-architecture-audit.md` (describes a fixed bug) and `tsearch-reuse-map.md` (stale Phase-10 reference, flagged three reviews running). `src/pipeline/websiteGraph.ts` (952 lines, tSearch) has no doc coverage at all yet. | Not a product defect, just compounding doc drift — clearly a recurring pattern across both repos rather than an accident; a generated/drift-tested brief (tSearch already has `npm run brief`) is a better long-term fix than one-off doc edits. |
| **Low** | tSearch | Digest-loop Phase 4 (ranking refinement from now-captured Phase-3 feedback) still unbuilt; priority-v2/Cory remain uncalibrated/fixture-only. Open product question (global vs. per-seed top-N; Substack-only filtering) still unresolved. | Unfinished direction, not a defect — worth tracking so the now-collected feedback data doesn't sit unused indefinitely. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **Deterministic field-shape classification for the identity-guard fix
  (§4's top actionable item)** — and this project's own house philosophy
  (determinism beats an LLM call where it can) points at a more fitting fix
  than an ML PII classifier: reuse the same signal browsers already use for
  native autofill — the WHATWG **autocomplete token vocabulary**
  (`name`, `given-name`, `email`, `tel`, `street-address`, etc.) plus a
  small label-regex layer for forms that omit `autocomplete` — to
  deterministically tag a field as identity-shaped *before* any bank or
  predicted answer is allowed to fill it, rather than growing an
  ever-expanding exclusion list one incident at a time. For the harder
  residual case (free-text custom fields with no usable label or
  `autocomplete` hint), a narrow open PII/entity classifier — the GLiNER
  family now has 2026 PII-focused variants (NVIDIA's and Knowledgator's
  `gliner-pii-base`) with small, fixed label schemas — is a plausible local,
  no-API-call fallback; worth checking current model cards on Hugging
  Face/GitHub before adopting, since this session did not verify exact
  URLs/versions.
- **Stagehand** (`browserbase/stagehand`) and **browser-use** remain
  reasonable Phase-6-style fallback candidates for any future unsupported
  ATS, per the repo's own `browser-use-evaluation.md` — lower priority now
  that four ATS platforms are live on the deterministic path.

**tSearch**

- **RULERS** (Hong et al., 2026, [arXiv:2601.08654](https://arxiv.org/abs/2601.08654),
  "From Rubrics to Reliable Scores: Evidence-Grounded Text Evaluation with
  LLM Judges") — a concrete three-stage framework (lock rubric criteria into
  task-level specs → require typed, auditable evidence citations per
  scoring decision → post-hoc calibration against human score boundaries)
  directly applicable to actually measuring and fixing which of the
  existing judge dimensions (Cory, priority-v2) are noisy, rather than
  assuming the rubric is well-calibrated. More concrete than the previously
  cited Autorubric; [arXiv:2606.08625](https://arxiv.org/pdf/2606.08625) is
  a useful broader survey of the same design space if evaluating alternatives.
- **GitHub-graph-first identity resolution** (GitHub GraphQL over
  followers/stargazers/forks + community detection) — still relevant as a
  ToS-compliant complement that could shift weight away from LinkedIn
  scraping as the primary signal; unchanged from prior reviews, and still
  worth doing given LinkedIn hardening remains only half-complete (§4).
- **Stratified sampling for judge-output validation** — reduces how much
  human validation is needed to reach a given confidence level in the
  now-captured Phase-3 feedback data, versus simple random sampling; the
  natural next step once Phase 4 (ranking refinement) starts consuming that
  feedback.

---

## Changelog

- **2026-09-21** — Full refresh, reconciling the two drifted mirror copies
  (jobright's had partially adopted "Dispatch" branding; tSearch's had not)
  into one canonical version, and incorporating an unmerged 2026-09-13 draft
  (`origin/claude/busy-clarke-2lxizm` in jobright, never merged) that itself
  needed updating. Confirmed via two research passes plus direct git/GitHub
  checks: zero open issues, zero open PRs on both repos. Key updates since
  2026-09-13: jobright's product rebrand to "Dispatch" and hosted
  multi-tenant buildout characterized in detail (`childEnv.ts` flag-ceiling
  model, Supabase-backed tenant workspaces, remote-browser providers); the
  2026-09-11 EEO/demographic decision reversal documented; the real current
  blocker identified as hosted-launch OAuth misconfiguration, not engine
  capability; the identity-field guard (#263) confirmed still unbuilt three
  weeks after the incident that flagged it, and escalated to High. tSearch's
  PII-in-git-history risk restored to Critical (was downgraded to High on
  2026-09-13; this review found no remediation progress and disagrees with
  the downgrade). tSearch feature additions since 2026-09-13 (experience-
  distinctiveness judge, tiered recruiter labels, conviction rubric v2,
  humanized judge prose, the 2026-09-18 youth-wildcard/seed-tree fix)
  characterized. Amendments section refreshed with a live web search rather
  than carried over verbatim; RULERS citation corrected to its actual arXiv
  ID, and a deterministic (autocomplete-token) alternative proposed for the
  jobright identity-guard fix in place of the ML-classifier framing this
  review's own research initially reached for.
- **2026-09-13** — Unmerged draft (`claude/busy-clarke-2lxizm`, jobright
  repo only, never landed on `master` or mirrored to tSearch). Found:
  jobright had gone from blocked/fixture-only to weeks of live autonomous
  multi-ATS operation; tSearch fixed the ownership-share bug, added a
  safety-flag layer, and partially fixed LinkedIn hardening; tSearch's
  Critical PII risk downgraded to High (a judgment this review reverses).
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
