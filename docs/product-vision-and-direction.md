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
| Last reviewed | 2026-09-05 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/dispatch` (private; formerly `jobright-application-agent`), `skale-07/tSearch` (**public**) |

---

## 1. Dispatch (engine: the application agent) + the new cloud console

### 1.1 Vision

**This changed materially since the last review (2026-08-07) and is the
single biggest update in this doc.** The original vision was a local,
operator-controlled Playwright agent automating *your own* job-application
workflow. As of an operator directive dated 2026-09-01, that engine is
being wrapped in a **split-plane product**: the deterministic, fail-closed
engine (Playwright, SQLite, `private/`) stays on the operator's machine
(v0) or a per-user container (v1 — reserved AWS credit, not yet built),
while a new **cloud plane is a real public multi-tenant web app** —
marketing site, waitlist, invite redemption (Supabase Auth magic link),
an onboarding wizard (profile, education, work authorization, resume
upload, job preferences), and a dashboard of applications/receipts/quota.
The product bet on determinism + fail-closed gating + an honest validation
ladder over an LLM-driven agent is unchanged and is explicitly carried into
the cloud plane (`SUPABASE_SYNC_ENABLED` is fail-closed like every other
flag). What's new is the audience: this is no longer built for one
operator's own applications — it is being launched, invite-only, at other
users ahead of "the September recruiting rush."

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / OpenAI + Anthropic (LLM provider now selectable) — plus, new: Supabase (Postgres + Auth + Storage, RLS-gated), Vercel Hobby (free tier) for the public app.
- **Source of truth:** SQLite (`data/app.sqlite`) on the engine side remains authoritative; the cloud plane's Supabase tables (`app_users`, `invites`, `user_profiles`, `application_status_mirror`, `application_receipts`) are a **mirror written by the engine**, never the reverse — engine→cloud pushes status/receipts via a whitelisted mapper (`src/cloud/syncMapping.ts`); cloud→engine only pulls onboarded profile/preferences into `private/cloud/`. The operator's own `private/`, ATS credentials, vault entries, and LLM keys never cross upward — stated as a "non-negotiable" data-flow rule in `docs/roadmap/cloud-deploy.md`.
- **State machine:** unchanged — `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with human-only `review:resolve` on uncertain submissions.
- **Safety architecture:** unchanged in kind, grown in list — every mutation capability (engine and cloud sync alike) sits behind a named fail-closed env flag (34 in `.env.example` now, including `SUPABASE_SYNC_ENABLED`, `CONSOLE_HOSTED_MODE_ENABLED`). `chromium.launch` still confined to three session-infra files; `check:forbidden` still bans Outlook send APIs anywhere in the tree.
- **Validation ladder — real promotion since last review:** the README now claims (and this review did not independently re-run, so treat as the project's own report, not this review's verification) that **five real applications have reached `LIVE_MUTATION_CONFIRMED`** — Neuralink, Old Mission, DV Trading (Greenhouse) and Exa (Ashby) — meaning the previously-blocking defect (workstream C′, live JobRight feed discovery returning 0 cards) is resolved and a full live discover→submit→verify loop has actually closed at least once. This is the most important engine-side change since 2026-08-07.
- **ATS coverage — expanded:** Greenhouse (job-boards + embeds), **Ashby, Lever, Workable**, and **Workday** (employer-portal account auth, SSO chooser, multi-page wizard incl. consent listboxes/date widgets/multiselect, EEO pages) — a large jump from "Greenhouse only, Lever/Ashby deferred" as of the last review. A generic adapter now handles ATS-handoff detection from careers-site front doors; unsupported families (USAJobs/login.gov, ByteDance portal, Phenom, iCIMS accounts) still refuse fail-closed with the reason recorded.
- **Lineage:** unchanged — the session/storage layer was hardened from tSearch (see §3); tSearch's product logic was not ported.

### 1.3 Technical direction

Two workstreams are now running, not one:

**Engine (formerly "Phase 5.6"):** per the README's 2026-08-31 "Current
state," the core live-validation goal of Phase 5.6 appears to have been
substantially met — full chain discovery→materials→inspect→plan→fill→
essays→gated submit→receipt verification→contacts→outreach drafts runs
live end to end for at least 5 completed applications. **Doc-drift flag:**
`docs/current-state-and-phase56.md` (dated to the 5.6 effort) still shows
open checkboxes for exactly the things the README now claims are done
(live feed discovery ≥1 card, CAPTCHA fix confirmed live, live Greenhouse
fill evidence) — see §4 for why this is worth closing out explicitly
rather than leaving two "source of truth" docs disagreeing.

**Cloud (new, "Phase v0"):** per `docs/roadmap/cloud-deploy.md` and
`docs/roadmap/invite-round-trip-2026-09-02.md` — Supabase schema is live,
a 23-step invite round trip has passed, a `redeemed_by` FK-cycle bug that
would have made member deletion (dashboard or GDPR request) impossible
was found and fixed pre-launch (`ON DELETE CASCADE`, decision recorded),
10 invite codes (quota 5 each) are loaded and unredeemed, and an
`engine_status` heartbeat now writes one row per user on every
`cloud:sync` tick. Marketing collateral (campus outreach templates,
short-form video scripts, a "college launch" doc) already exists,
suggesting user acquisition is imminent, not speculative.

- **Deliberately not (yet) in scope:** the v1 per-user containerized
  engine (reserved $10k AWS credit, explicitly "do not spend on v0");
  going commercial on Vercel Hobby (non-commercial-licensed; the repo's
  own roadmap already flags revisiting this before it becomes commercial).
- **Longer arc:** Phase 6 constrained-agent fallback for unsupported ATS
  is still just an evaluation (`browser-use-evaluation.md`), still gated
  behind `AGENT_FALLBACK_ENABLED`, still not the default path.

Deeper detail (in `skale-07/jobright-application-agent`, not this repo):
`docs/architecture.md` · `docs/current-state-and-phase56.md` ·
`docs/known-limitations.md` · `docs/validation-levels.md` ·
`docs/roadmap/cloud-deploy.md`

---

## 2. tSearch

### 2.1 Vision

Unchanged: "unseen talent discovery" — find people whose ability shows up
in public artifacts rather than credentials, expand outward through their
real collaboration graph, score on evidence of building + thinking +
pedigree, run LLM "judges" over their public work, and produce an
evidence-cited priority score for a recruiter digest. The non-negotiable
principle is unchanged: missing evidence maps to `insufficient_public_evidence`,
never to a negative judgment.

### 2.2 Core technical details

- **Stack:** unchanged — TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite / OpenAI or Anthropic / Resend.
- **Pipeline:** unchanged shape, richer scoring since last review: `resolve identity → expand graph hop-1/2 → score (final_score) → persist → assess (LLM judges, priority_score) → digest email`, now with an obscurity multiplier, age-relative ("youth wildcard") impressiveness, corroborated-GitHub weighting, an award registry, and a "Cory" persona/tiered recruiter-label judge on top of the technical/writing judges.
- **Judge system:** unchanged architecture (rubric-YAML-driven, coerce-not-hard-fail on missing evidence), plus a new experience-distinctiveness judge and "humanized" (non score-speak) judge prose.
- **Safety-flag layer — resolved since last review.** tSearch now has a `CLAUDE.md` house-rules file with explicit fail-closed boundaries: no PII in git (see below), assessment reads frozen `output/candidates.json` only, `digest:send` defaults to `--dry-run`, LinkedIn scraping must respect `LINKEDIN_DELAY_MS`/cache and degrade rather than retry-hammer on ban/captcha, and full-size live LLM runs need explicit operator OK. This closes what was flagged as a Medium structural gap on 2026-08-07.

### 2.3 Technical direction

- The digest feedback loop (Phase 3 of the 4-phase roadmap) is now
  **built**, not just designed — `src/digest/feedbackStore.ts` and
  `buildDigest.ts`/`server/index.ts` wire relevance feedback into the
  digest. Whether ranking actually *refines* from that feedback (Phase 4)
  was not independently verified this review.
- Priority-v2 scoring and the "Cory" persona are still explicitly tagged
  `requires_calibration` in the rubric type system and validators
  (`src/assessment/rubrics/`), i.e. this is a live, tracked flag, not
  something that quietly got dropped — but no calibration test suite
  exists yet (`tests/` has no calibration-specific coverage). See §5 for
  a concrete technique (RULERS) that fits this gap directly.
- Open product question from the last review is now moot in one
  direction: a real feedback mechanism exists, so "should the digest
  surface global top-N or per-seed neighbors" is answerable empirically
  once feedback volume accumulates — worth deciding whether to actually
  look at that data now that it's being collected.

Deeper detail (in `skale-07/tSearch`, not this repo): `docs/implementation-prompt.md` ·
`docs/all-agents-wiring-verification.md` · `docs/email-digest-implementation-context.md`

---

## 3. How the two projects relate

Unchanged from the last review: Dispatch is a hardened descendant of
tSearch's session/scraping infrastructure (`docs/tsearch-reuse-map.md`,
this repo), not an unrelated project. tSearch's product logic was
deliberately not ported. One notable new parallel: **both repos are now
independently building toward "real users other than the operator"** —
Dispatch via its cloud console, tSearch via its digest feedback loop
capturing recruiter reactions. Neither repo's docs currently cross-reference
the other's multi-user posture; worth a shared read if session/credential
handling patterns Dispatch is building for its cloud plane (RLS,
whitelisted sync mappers, invite-scoped quotas) would also harden
tSearch's own occasional need to serve output to people other than the
operator (the recruiter digest recipients).

The stale reuse-map note from the last review (Phase 10 LinkedIn-enrichment
port that was actually dropped by decision) has not been corrected; still
low-severity doc drift.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.
Items marked **RESOLVED** were Critical/High/Medium in the 2026-08-07
review and are verified fixed as of this review; kept here for the
record rather than silently dropped.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **High** | Dispatch | New: the v0 cloud plane's quota is enforced **only by the engine checking before it acts**; the roadmap's own docs note "the quota view counts COMPLETED rows even past the quota... nothing cloud-side blocks it." A buggy or compromised engine instance (or a future v1 per-user container) could run past a user's paid/free quota with no server-side backstop, and since LLM calls cost real money, this is a live cost-control gap, not just a UX nit. | Directly exposed by the multi-user pivot — didn't exist as a risk category when this was single-operator software. Worth a server-side check (a Postgres trigger or edge function rejecting writes past quota) before the cohort grows past 10 invite codes. |
| **Medium** | Dispatch | Doc drift: `docs/current-state-and-phase56.md` still shows open checkboxes (live feed discovery, CAPTCHA-live-confirm, Greenhouse-live-fill-evidence) for things the README's 2026-08-31 "Current state" section reports as done (5 live `LIVE_MUTATION_CONFIRMED` applications). Two documents both presented as authoritative now disagree. | This project's own culture is unusually strict about validation-ladder honesty ("a lower level never promotes a capability"); leaving a stale phase doc uncorrected undercuts that discipline for the next reader (human or agent) who treats it as current. |
| **Low** | Dispatch | Vercel Hobby tier (used for the v0 public app) is licensed non-commercial/hobby-use only; the project's own roadmap already flags this needs revisiting before anything commercial. | Not urgent pre-launch with an invite-only cohort, but a "September recruiting rush" push could cross that line faster than expected — worth a calendar reminder, not a code change. |
| **Low** | tSearch | Priority-v2 and "Cory" persona scoring remain `requires_calibration` with no calibration test harness, while the scoring surface has grown substantially since the last review (obscurity multiplier, youth wildcards, corroborated-GitHub, tiered labels). | Not a regression — this was already flagged and is still honestly tracked in the type system — but the gap between "scoring surface" and "calibration harness" is widening, not closing, since 2026-08-07. |
| **Low** | tSearch | Stale `docs/tsearch-reuse-map.md` reference to a dropped Phase-10 LinkedIn-enrichment port (carried over from last review, still uncorrected). | Doc drift; low effort to fix, keeps getting deferred. |

### Resolved since 2026-08-07 (verified this review)

- **RESOLVED — Critical (tSearch):** `profiles/`/`backup/` PII exposure.
  Verified directly: both paths are now gitignored (with a comment citing
  this doc) and `git ls-files` returns zero tracked files under either
  path. (Whether the *history* was purged, i.e. old commits with the PII
  are still fetchable from a clone, was not re-checked this review and is
  worth a one-time confirmation if it hasn't already been done.)
- **RESOLVED — High (Dispatch):** live JobRight feed discovery returning
  0 cards (workstream C′) — superseded by 5 completed live applications
  per the README (project self-report; see the doc-drift flag above for
  the one loose end).
- **RESOLVED — High (tSearch):** ownership-share denominator bug.
  Verified directly in `src/assessment/github/collectRepositoryArtifact.ts`:
  share is now computed from an explicit unfiltered `repository_commit_sample`,
  and is *omitted* (not fabricated as 1.0) when no unfiltered sample exists —
  matches the "missing evidence, not a negative judgment" design principle.
- **RESOLVED — Medium (tSearch):** no fail-closed safety-flag layer.
  Verified: `CLAUDE.md` now exists with explicit hard boundaries.
- **RESOLVED — Medium (tSearch):** no mid-run LinkedIn re-auth detection,
  zero LinkedIn tests. Verified: `src/linkedin/linkedinBrowser.ts` detects
  a mid-run redirect to a login/checkpoint wall and raises a clear error;
  `tests/linkedin/` now has two test files plus LinkedIn-adjacent coverage
  in `tests/assessment/` and `tests/scoring/`.
- **RESOLVED — Medium (Dispatch):** CAPTCHA false-positive fix and live
  Greenhouse fill were `FIXTURE_CONFIRMED` but unconfirmed live — now
  implied resolved by the same 5-application live evidence above.

---

## 5. Amendments worth considering (external scan)

**Dispatch**

- **rlsautotest** (featured in Supabase's July 2026 "Made with Supabase")
  — reads a Postgres schema's actual RLS policies and auto-generates a
  native pgTAP suite proving, per table/command/identity, who can
  SELECT/INSERT/UPDATE/DELETE which rows, using reverse-predicate seeding.
  This lands directly on the new cloud plane: `docs/roadmap/cloud-deploy.md`
  already leans on RLS as the isolation boundary between users' rows, and
  the invite-round-trip doc already found and fixed one real FK/RLS-adjacent
  bug by hand (the `redeemed_by` cascade issue) — an auto-generated pgTAP
  suite would catch the next one before a live user hits it, which matters
  more now that real users' resumes/PII are the thing at stake, not just
  the operator's own data. https://unitautogen.com/postgresql.html
- Prior-review amendments (`storageState({ indexedDB: true })`, Stagehand,
  browser-use) are largely **overtaken by events** — the live-discovery
  blocker they targeted is reported resolved and ATS coverage already
  expanded to 5 vendors without them. Re-evaluate only if a *new*
  unsupported-ATS blocker resembling the old C′ symptom shows up.

**tSearch**

- **RULERS** (Hong et al., 2026) — compiles judge criteria into versioned
  immutable bundles, requires the judge to cite auditable evidence for
  every scoring decision (already tSearch's own design principle), and
  applies **post-hoc calibration to align score distributions with human
  annotations**. This is a closer fit than the previously-noted Autorubric
  for the specific, still-open `requires_calibration` gap on priority-v2
  and the Cory persona — it's a calibration *method*, not just a rubric
  *format*.
- Autorubric, Prometheus 2/GLIDER, and the GitHub-graph-first identity
  resolution pattern from the last review remain applicable and unbuilt;
  carried forward rather than re-described.

---

## Changelog

- **2026-09-05** — Refresh. Read both repos' current docs trees (README,
  CLAUDE.md/house-rules, roadmap/, knowledge-graph), full git log since
  the last review (30 tSearch commits since 2026-08-07; ~40+ Dispatch
  commits since 2026-09-01 alone), and current GitHub issue/PR state
  (both repos: zero open issues, zero open PRs, same as last review).
  Directly verified (not just read from docs): tSearch's PII untracking
  (`git ls-files`), the ownership-share fix and mid-run auth-guard code,
  and Dispatch's `.env.example`/flag-registry growth. The Dispatch cloud
  pivot (multi-tenant SaaS launch) is the most significant development
  since the last review and is reflected in a rewritten §1. Two risks
  closed to RESOLVED that were previously open (tSearch ownership-share,
  tSearch mid-run auth); the Critical PII item and the JobRight
  live-feed blocker were also resolved and are recorded in §4's resolved
  list rather than silently dropped from the table.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state (both repos: zero open
  issues, zero open PRs at time of review). Verified the critical PII/public-repo
  finding directly (`git ls-files`, file content, repo visibility) rather
  than relying solely on subagent report.
