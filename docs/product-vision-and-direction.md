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
| Last reviewed | 2026-08-31 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**; product renamed "Dispatch" on `master` 2026-08-17, repo/URL name unchanged), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **thirteenth** attempt at this document
since 2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and never merged to `master`/`main` — reconfirmed directly this review via
`git merge-base --is-ancestor` (the 08-29 draft, `busy-clarke-hu0i3c` /
`epic-pasteur-hu0i3c`, is still not an ancestor of either default branch).
At least two prior reviews (2026-08-21, 2026-08-25) made confident claims
about their own merge/notification status that were checked and found
false. This review does not assume its own claims are more reliable by
default — every figure below was re-derived directly against current `HEAD`
in both repos this session (byte counts, `git grep`/`git ls-tree` counts,
`git log` ranges, live GitHub issue/PR queries), a background sub-review
independently re-read the 50 raw jobright commits rather than trusting the
prior draft's characterization of them, and a push notification was sent to
the operator on completion, independent of whether this document ever
reaches a human by any other path, precisely because that path has a
documented history of failing silently.

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

**That bet has now been tested against real live submissions, not just
fixtures — and the loop is now running continuously, not as a one-off.**
The 2026-08-28→29 overnight L3 session produced the first 2 real Submit
clicks (Figma, Stripe). A second overnight window (2026-08-30→31, same L3
armed mode) added **4 more real, `LIVE_MUTATION_CONFIRMED` Submit clicks**
against live employer forms — Neuralink (Greenhouse), Old Mission
(Greenhouse), DV Trading (Greenhouse), and Exa (Ashby) — bringing the
running total to **6 real submits across two ATS platforms in four days**.
The Exa submit is notable on its own: that same posting had been rejected
after an earlier click attempt because Ashby's success banner was
misclassified as "unknown" by the confirmation-answer parser (a bug fixed
same-night as #58/#78/#79), then resubmitted successfully once fixed. The
product has therefore **completed and is now sustaining a live closed
loop**, which the 2026-08-07 doc explicitly said had never happened — but
not by fixing the original bug (see §1.3) — and submit volume is
accelerating faster than this document's independent-verification
methodology is keeping up with it (see the new risk flagged in §1.3 and
§4).

The product also renamed itself **"Dispatch"** on `master` itself on
2026-08-17 (`eedc63c`, "operator directive 2026-08-18"; a truth-pass on
`DESIGN.md` followed on 2026-08-19/24) — package.json, README, CLI header,
console/dashboard title, the Python sidecar's `pyproject.toml`, and the
house-rules frontmatter all now say Dispatch. Deliberately unchanged:
`CANDIDATE_DATA_KEY_NAME`, `src/jobright/`/`JOBRIGHT_*` (names the external
job board, not this project), and the GitHub repo's own name/URL
(`skale-07/jobright-application-agent`), which is still **public**.

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) — three gated LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; a new TypeScript `agent/stagehand/` using `@browserbasehq/stagehand`, evaluation-only — see §1.3).
- **Source of truth:** SQLite (`data/app.sqlite`) — queue state, transitions, leases, idempotency, review items, and append-only telemetry (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`, exportable via `npm run training:export`). `state.json` is a read-only export, never a write target.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, with `FAILED_RETRYABLE`/`FAILED_FINAL` terminals. Every transition is a DB event; uncertain submissions require a human `review:resolve` (three exits only — submitted / requeue / abandon — never automated).
- **Safety architecture — flag roster has grown substantially** since 2026-08-07 (see `CLAUDE.md` for the full current list: `ATS_DISCOVERY_ENABLED`, `SCREENER_PREDICT_LLM_ENABLED`, `ESSAY_AUTOFILL_ENABLED`, `AUTOMATION_ENABLED`, etc. are all new). All default `false` in `.env.example` except `CDP_AUTOLAUNCH_ENABLED` (a debug-Chrome convenience, confined to a dedicated profile dir, not a mutation gate). `chromium.launch` remains confined to three session-infra files. Demographic/EEO/pronoun fields are architecturally confirmed to never take the LLM/screener path (verified across `docs/screener-questions.md`, `operator-guide.md`, and `CLAUDE.md`, all consistent) — they route only through the operator's own encrypted sensitive-profile store.
- **New mutation-adjacent capability worth naming explicitly:** the Workday adapter can autonomously **create portal accounts** on third-party ATS sites (`src/verification/portalAuth.ts`), gated by `NAVIGATION_ENABLED` + a host allowlist (`isRecognizedAtsAuthHost`) with per-host random passwords — a materially different capability class from "fill a form," worth tracking as its own line item going forward.
- **Verify gate — could not be independently re-run this review; flagged as a methodology gap, not asserted clean.** This sandbox has no `node_modules` in either checkout (`tsc`/`tsx` not found), so this review could not itself confirm typecheck/`check:forbidden`/`check:secrets`/tests as the 08-29 review did. Every one of the ~19 fix commits landed since then carries only a self-reported "Gate: full suite solo + checks green" in its commit message — per this project's own validation-ladder rule ("an agent's self-report carries no level until independently verified by a deterministic read-back"), that status is `UNVERIFIED`, not `UNIT_CONFIRMED`, until someone re-runs it with dependencies installed.
- **ATS coverage — five platforms in the registry (`greenhouse, lever, ashby, workday, workable, generic`), live-DOM proof now reaches three of them.** Greenhouse has the deepest proof (4 of the 6 real submits). Ashby now has one full live submit (Exa) after fixing a fieldset-radio resolution bug and a confirmation-banner misclassification. **Workday moved from `UNVERIFIED` to partial live-DOM proof this window:** a fresh tenant (Stryker, `stryker.wd1`) completed auth and a 6-page wizard walk with resume upload, all the way to the pre-submit gate — but did not click Submit, because a cached `screener_predictions` replay fed a poisoned answer into a Phone/Device-Type question (open issue #83, parked not clicked). Lever and Workable remain fully `UNVERIFIED` against real live pages — no new evidence this window.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

**Another 50 commits landed since the last logged review (2026-08-29):
`d0b39dc` → `c284026`, almost entirely a second overnight L3 automation
window (2026-08-30→31), on top of 121 total since 08-07.** Highlights: the
Workday live-DOM progress above; an Ashby fieldset-radio resolution fix and
a confirmation-banner-misclassification fix (#58/#78/#79) that unblocked
the Exa resubmit; a CDP-restart root-cause fix (#34, PID kill via
PowerShell CIM); a test-hermeticity fix (#59 — a unit test had been making
a live CDP network call and is now stubbed). The overnight issue log moved
to `artifacts/overnight-issues-2026-08-30.md` (~1,400 new lines), which
**explicitly carries both of the previously-open correctness bugs forward
as still unfixed** — #19 (Cloudflare conditional-DOM cross-fill) and #21
(checkbox kind-mismatch coercion, the export-control mis-typing bug) — no
commit in this window touches either.

- **The original C′ blocker (`jobs_inspected: 0` against live JobRight
  feed) was never fixed — it was routed around.** `storageState({
  indexedDB: true })`, the concrete fix hypothesis from the 2026-08-07 doc,
  was never tried (`grep -rn indexedDB src/` returns nothing). Instead,
  **D1a+D2 "ATS board discovery"** (`src/discovery/atsBoards.ts`, flag
  `ATS_DISCOVERY_ENABLED`, shipped 2026-08-26) bypasses the JobRight
  scraper entirely by pulling postings directly from Greenhouse/Lever/
  Ashby/Workable's own public unauthenticated board APIs. This is why the
  product now has a live closed loop despite the original bug still being
  unfixed and undocumented as such.
- **`docs/current-state-and-phase56.md` is still actively wrong, unchanged
  this window (diffed byte-for-byte against 08-29: zero changes):** it
  still frames the project as "Phase 5.6, live validation only" and still
  says live discovery "has never produced a job" — both false given the
  above and now false by a wider margin (6 real submits, not 2). This needs
  a rewrite, not a patch; an operator or agent trusting it would materially
  misjudge what's shipped.
- **Second navigation-agent engine (Stagehand) is still a pre-registered
  comparison, not a decision — unchanged this window.** `docs/agent-engine-decision.md`
  still opens "SPIKE — comparison not yet run," diffed byte-for-byte
  against 08-29 with zero changes; the promotion bar (must strictly beat
  the incumbent `browser_use`, zero safety events) is defined but nothing
  has run against it yet. Separately, a **navigation-only** agent fallback
  (`AGENT_FALLBACK_ENABLED`) is confirmed live in production, but strictly
  to get through navigation walls (find Apply, reach the form) — it never
  chooses field values or clicks Submit, per the overnight log's own
  operator directive.
- **New risk this review: submit velocity is now outpacing independent
  verification, and the one classifier failure already on record makes
  that specifically concerning.** 6 real submits in 4 days (up from 2), an
  `L3` mode with caps removable by the operator, and a validation
  methodology (see §1.2) that currently rests on each fix commit's own
  self-reported "Gate: full suite solo + checks green" rather than a
  reproduced result — combined with the fact that the Exa submit only
  happened after discovering the confirmation-banner parser had previously
  *misread an actual success as "unknown"* (#79). The inverse failure
  mode — misreading an actual failure/duplicate as success, or submitting
  on a field the export-control/Cloudflare bugs (below) silently
  mis-filled — has not been ruled out and would not currently be caught by
  anything except a human checking the target site or inbox directly.
- **New capability surfaces since 2026-08-07, all consistent with the
  fail-closed pattern on inspection:** essay autofill/draft from
  `private/candidate/about-me.md` (operator directive 2026-08-15,
  `ESSAY_AUTOFILL_ENABLED`/`ESSAY_DRAFT_ENABLED`, output validated,
  unattended runs land as suggestions requiring approval); a self-improving
  screener answer bank (`SCREENER_PREDICT_LLM_ENABLED` — verbatim-match or
  park, accepted answers persist as reusable entries); an L3 armed
  unattended-automation mode with a documented contract (timed/capped
  sessions, disarm-by-default, kill switch, `operator-guide.md` §17b–19)
  and a "Stage-1 self-improvement loop" (`/improve` + scheduled polling
  sessions that open PRs against new artifacts).

- **CRITICAL — the PII leak on `master` got dramatically worse this window,
  not just older.** Verified directly this review, not carried over from a
  prior draft:
  - **4,086 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths as of `c284026` — up from 574 on 2026-08-29, a >7x jump in two
    days.** Byte-level inspection again shows these are **not all
    placeholders**: 3,726 are the trivial 45-byte test fixture, but **360
    are real, substantial, FlateDecode-compressed PDF documents** (up from
    194) across the same 3 distinct file sizes (113,381 / 76,462 / 74,509
    bytes) — the shape of genuine exported resumes, repeated across many
    application UUIDs. The jump tracks directly with the second overnight
    session's ~50-commit, 100+-application volume (§ above) — this is not
    a one-time leak, it is a leak rate proportional to how much the tool is
    used.
  - **The operator's real contact information remains in cleartext,**
    essentially unchanged: the phone number (480-589-7636) is still in 1
    tracked file (`artifacts/overnight-issues-2026-08-28.md`), and the
    operator's real email (`skale1@jh.edu`) now appears in **28 tracked
    files** (up from 26). The newest overnight log
    (`artifacts/overnight-issues-2026-08-30.md`) itself was checked
    directly this review and does **not** add new phone/email hits — the
    growth is elsewhere (fixture/plan artifacts) — but it still adds to the
    same `artifacts/` tracked-tree problem.
  - **Root causes, unchanged and unremediated since first identified on
    08-11:** `.gitignore` line 20 still has `artifacts/` **commented out**
    (re-verified directly on `c284026`). `src/security/artifactScan.ts`'s
    `REQUIRED_GITIGNORE_ENTRIES` check still passes on the dead
    commented-out line via a naive substring match. The forbidden-filename
    regex still only matches a file literally named `resume.pdf`, not the
    real `resume-<hash>.pdf` convention. `artifactAutopush.ts` still runs
    an unexcluded `git add -A -- artifacts`, and it is that exact autopush
    path — one commit per automation cycle, dozens per overnight session —
    that is now the dominant growth driver, confirmed by the background
    sub-review this cycle (every `art: auto-cycle report` / `art:
    automation session` commit in the 50-commit window touched
    `artifacts/`). The opt-in pre-commit hook remains not installed in
    either checkout inspected.
  - **This has been independently rediscovered by the automated review
    loop at least ten times now** (2026-08-11 through 08-29, escalating
    183 → 187 → 308 → 327 → 366 → 396 → 481 → 574, and now **574 → 4,086**
    in the two days since), every time on a branch that never merged to
    `master`, every time noted as "still unfixed." No purge of any kind has
    been attempted. This is now the single longest-standing,
    fastest-worsening, unaddressed item across both repos, and the growth
    curve means every additional day of normal automated use makes the
    eventual purge larger and more disruptive without changing its
    difficulty — the fix is the same three small edits it was on 08-11.
- **The parallel, independently-diverged rebrand branch has drifted
  further, not been reconciled:** `claude/product-branding-design` is now
  104 commits ahead of `master` and 50 behind it (re-measured this
  review) — still not an ancestor of `master`'s own already-merged Dispatch
  rebrand. Low urgency, but the merge-pain cost is compounding on the same
  curve as everything else this window.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand promotion-bar
  comparison actually running.
- **Next up, in priority order (unchanged from 08-29 — none of these have
  been started):** (1) fix the `artifacts/` leak at the root — uncomment
  the `.gitignore` line, fix `REQUIRED_GITIGNORE_ENTRIES` to test for an
  *active* rule rather than a substring, fix the resume regex to match the
  hash-suffixed convention, confirm the pre-commit hook actually runs on
  the autopush machine, **then** purge history (`git filter-repo`) — a
  `.gitignore` fix alone does not remove what's already public, and every
  day this waits the purge gets larger; (2) rewrite
  `current-state-and-phase56.md` to reflect reality; (3) resolve the two
  open overnight-log items that touch correctness of submitted data
  (#21 export-control checkbox mis-typing, #19 Cloudflare conditional-DOM
  cross-fill); (4) get independent (not self-reported) confirmation of the
  verify gate on real dependencies before trusting further fix commits'
  "Gate: ... green" claims at face value; (5) live-DOM proof for Lever and
  Workable, and resolve #83 to get Workday's first live submit; (6) let the
  Stagehand-vs-`browser_use` comparison actually run before treating either
  as more than an experiment.

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
and now arbitrary web-page team/about listings), scoring on evidence of
building + thinking + pedigree, then running LLM "judges" over their actual
public work to produce a defensible, evidence-cited priority score for a
recruiter digest. The stated non-negotiable design principle
(`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **No new commits since 2026-08-24, reconfirmed this review** — `HEAD` is
  still `a52881b` ("Isolate youth wildcards on Score and stop dropping
  seed-tree neighbors below the top-80 cut"), one full week of no activity
  as of 2026-08-31. 41 commits landed between 2026-08-07 and 08-24,
  across five broad themes: (1) triage-driven infra — `CLAUDE.md` house
  rules (new), a real CI gate, the ownership-share and mid-run-auth fixes
  (both confirmed still holding, see §2.3), digest feedback-loop scaffolding;
  (2) an "oracle" package — `docs/system-brief.md` (generated Tier-0
  context brief) and a `tsearch-oracle` MCP server for read-only doc/source
  Q&A, plus an autopilot chain (sweep → resolve → discovery → assessment →
  digest → send, fail-closed to mock/dry-run by default); (3) digest/UI
  maturity — profile pages, a reports panel, tiered recruiter labels via a
  new LLM label judge, an experience-distinctiveness judge, "humanized"
  judge prose, a feedless-blog fallback; (4) scoring/UX — restored a
  previously "wiped" Discover-intake feature (now locked against
  recurrence), added **youth wildcards** (a frozen, salted 17–19 age-band
  draw capped at 5, always surfaced below the priority floor — kept
  separate from ranked scoring), "corroborated GitHub" anti-spoofing
  (GitHub only attached when it points back at the known identity), "honest
  digest scoring" (capped LinkedIn substitution when GitHub is absent); (5)
  a **Supabase persistence scaffold** (inert by design: `TSEARCH_STORE`
  defaults to `fs`, the Supabase client returns `null` without env vars, an
  assertion throws if anyone sets `TSEARCH_STORE=supabase`, RLS is
  deny-all on every table) plus a new **website-graph discovery channel**
  (extracts and screens people from arbitrary web pages, e.g. team/about
  pages) and a **marks/watchlist feature** (explicitly does not affect
  ranking).
- **Discovery/Assessment/Presentation separation is load-bearing:**
  assessment reads only the frozen `output/candidates.json` snapshot — it
  never re-runs LinkedIn discovery or corrects a wrong identity match.
  `final_score` (discovery) and `priority_score` (assessment) are
  deliberately never collapsed into one number.
- **Judge system:** rubric-YAML-driven (`rubrics/`), now six judges deep
  (technical, writing, cross-artifact/synthesis, experience-distinctiveness,
  recruiter-label/tier, age-relative-impressiveness + obscurity-multiplier).
  **None of the six carry a measured inter-rater-agreement or
  position-bias number** — see §5.
- **Verify gate — not re-run this review; this sandbox has no `node_modules`
  in this checkout either (same gap as jobright, see §1.2).** Carrying
  forward the 08-29 figure (typecheck clean; `npm run test` 396/396 passing
  across 62 files) as last-confirmed, not re-verified.

### 2.3 Technical direction

- **CRITICAL — PII history exposure: unchanged, still unpurged, now
  confirmed for at least the twelfth review in a row.** `profiles/`
  (real scraped LinkedIn people's data — name, URL, photo, education,
  headline, country) and `backup/` were untracked from the working tree
  and gitignored on 2026-08-10 (`f5ad384`) — but **the files stay fully
  reachable in git history on this public repo**: `git cat-file -e
  700e2f6:profiles/madanva/profile.json` still resolves; `git log --all`
  contains no `filter-repo`/BFG-style purge commit. Untracking created a
  false sense of resolution; the actual public exposure is unchanged.
  `git filter-repo` + force-push + collaborator re-clone remains the
  concrete, unexecuted unblock.
- **Two previously-flagged bugs are genuinely fixed, but their audit docs
  were never updated to say so — worth correcting so they stop reading as
  open alarms:**
  - The **ownership-share scoring bug** (`docs/assessment-rubric-architecture-audit.md`,
    frozen since 2026-07-22 and now describing field names that no longer
    exist) was fixed 2026-08-10 (`5f80433`): `candidate_commit_share` is
    now computed from a genuine unfiltered commit sample and **omitted**
    (not synthesized as 1.0) when the denominator is unknowable, with a
    regression test.
  - **Mid-run LinkedIn re-authentication detection** was added the same
    commit: `assertLinkedInAuth()` now runs on every extraction/search
    navigation (not just session open) and throws a typed error on
    login/checkpoint/authwall redirects.
- **Two Playwright-audit items remain genuinely open:** zero retry/trace/
  screenshot capture on LinkedIn scrape failures (only unit tests of pure
  functions exist now — `tests/linkedin/` — still no integration/E2E test
  against a real or recorded DOM); `expected_country` still only *boosts*
  match confidence and is never used as a hard filter to reject a
  wrong-country homonym.
- **Digest loop (Phases 3–4): Phase 3 built, Phase 4 built in a basic
  filter/boost form — not full weight-learning.** Direct code inspection
  (`src/digest/feedbackStore.ts`, `buildDigest.ts`) this review resolves a
  discrepancy in the prior draft: feedback capture (Relevant / Not
  relevant / Explore network, `POST /api/feedback`) is fully wired, and
  `buildDigest.ts` reads that feedback to exclude `not_relevant` candidates
  and boost `relevant` ones in sort order — while explicitly leaving
  `priority_score` itself untouched. That's real ranking refinement in a
  narrow sense, just not the weight-learning form the roadmap doc
  originally envisioned. Open product questions (global vs. per-seed top-N
  digest surfacing, Substack-only filtering) remain unresolved.
- **No fail-closed CI enforcement, unchanged.** `CLAUDE.md` (new since
  2026-08-07) documents boundaries in prose — no PII in git, frozen
  candidates snapshot, `--dry-run` default on sends, `LINKEDIN_DELAY_MS`
  pacing, `ASSESSMENT_MOCK_LLM` default — but there is still no CI-enforced
  forbidden-API checker or `*_ENABLED` naming convention comparable to
  jobright's `check:forbidden`. A future change could silently violate the
  frozen-snapshot or score-separation invariants and nothing would catch
  it.
- **Low, doc-only:** `docs/system-brief.md` (auto-generated, last run
  2026-08-10) is stale in the *safe* direction — it still describes
  `profiles/`/`backup/` as tracked-and-pushed, which is no longer true; a
  `npm run brief` re-run fixes it. `docs/tsearch-reuse-map.md` still
  describes a Phase-10 `linkedinExtract.ts` port that was dropped by
  decision (unchanged since 08-07) — note for future readers: the newer
  `LINKEDIN_ENRICHMENT_ENABLED` flag on the jobright side is unrelated to
  this plan; it gates JobRight's own "Insider Connection" contact-lookup
  feature, not a LinkedIn-profile port.
- Zero open issues, zero open PRs at time of this review (both repos,
  checked directly via the GitHub API, not assumed).

Deeper detail (in this repo): [`docs/implementation-prompt.md`](./implementation-prompt.md) ·
[`docs/all-agents-wiring-verification.md`](./all-agents-wiring-verification.md) ·
[`docs/email-digest-implementation-context.md`](./email-digest-implementation-context.md) ·
[`docs/system-brief.md`](./system-brief.md) (generated, due for a refresh) ·
[`docs/assessment-rubric-architecture-audit.md`](./assessment-rubric-architecture-audit.md) (describes a bug now fixed — stale) ·
[`docs/tsearch-playwright-system-audit.md`](./tsearch-playwright-system-audit.md) (2 of 4 items now fixed — partially stale)

---

## 3. How the two projects relate

jobright-application-agent/Dispatch is a **hardened descendant** of
tSearch's session/scraping infrastructure, not an unrelated project.
`docs/tsearch-reuse-map.md` (jobright repo) records the original reuse
plan: tSearch's `saveSession.ts`/`linkedinBrowser.ts` concepts (manual
storageState login, lazy session open/validate) and atomic-JSON-store
pattern were the seed for jobright's `ServiceSession` and `src/storage/`
layers, rebuilt with more hardening (coverage statuses, mid-run auth
checks — now matched on tSearch's own side too, §2.3 — traces/screenshots,
no committed profile artifacts by design going forward, though not
retroactively into either repo's history). tSearch's product logic
(olympiad scoring, GitHub graph expansion, the seed-tree UI) was
deliberately **not** ported.

**Both repos now share the identical shape of unresolved risk: a
personal/PII exposure on a public repo, independently rediscovered across
many automated review cycles and never remediated.** tSearch's is
third-party LinkedIn PII, contained to git history only (current tree is
clean since 08-10) and stable — no new commits, no new exposure this
window. jobright's is the operator's own materials — real resume PDFs
(now 360 with substantial content, up from 194 two days ago) *and* the
operator's own phone number and email in cleartext (28 files) — still
actively growing in the *current* tree via ordinary automated use of the
tool, and growing much faster than before (574 → 4,086 tracked paths in
two days), which makes it unambiguously the more urgent of the two: every
fix has been fully specified for ten review cycles without being applied,
and the cost of that delay is now compounding daily rather than sitting
flat.

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment
was dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | jobright | **Tenth consecutive review finding this unfixed, and the leak rate itself accelerated sharply: 4,086 tracked resume-PDF paths (360 with real, substantial PDF content) — up from 574 (194 real) just two days ago — plus the operator's real phone number (1 file) and email (28 files) in cleartext, all currently tracked on the public repo.** Root causes unchanged since 08-11: a commented-out `.gitignore` line the safety checker's naive substring match fails to catch, a resume-filename regex that doesn't match the real naming convention, an unexcluded `git add -A` in the autopush path (confirmed this review as the dominant growth driver — every automation-cycle commit touches `artifacts/`), and an opt-in pre-commit hook not installed in this checkout. No purge attempted. | Longest-standing, now fastest-worsening item across both repos, and the only one with a hard fix already fully specified — one `.gitignore` line plus two small code fixes closes every known leak path; only the history purge is nontrivial, and it gets bigger every day this waits. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history on this public repo — reconfirmed directly this review. No purge attempted since first flagged. | Twelfth review in a row confirming a live, non-hypothetical exposure of real third-party people's data. |
| **High** | jobright | Submit velocity (6 real submits across 2 platforms in 4 days, up from 2) is now outpacing this review's ability to independently verify the tool's own gate — every recent fix commit's "tests green" claim is self-reported, unconfirmed in this sandbox, and the one classifier bug already found on this exact path (Ashby success misread as "unknown," #79) shows the failure mode is real, not hypothetical. | The inverse failure — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly; nothing in the pipeline is independently confirming it. |
| **High** | jobright | `docs/current-state-and-phase56.md` actively contradicts the repo's own state (still frames the project as pre-live-loop "Phase 5.6", byte-identical to 08-29) while a real live closed loop (6 real submits, five ATS adapters, ATS board discovery) has already shipped. | An operator or future agent trusting this doc would materially misjudge what's proven and what's still broken. Fix is doc edits, not new code. |
| **High** | jobright | `auto:cycle`/L3 armed mode is a genuinely unattended fill-and-submit operating mode, now proven to click real Submit buttons against real employers at increasing volume, with no per-run human click once armed and caps removable by the operator. | A deliberate, working product capability — but worth a standing line item precisely because live evidence and volume are both growing, not just design intent. |
| **Medium** | both | **Meta-risk: this document has been drafted at least thirteen times since 08-07 and never merged to `main`/`master` in either repo; at least two prior drafts made confident, false claims about their own merge/notification status.** | A review process that both fails to trigger action and cannot reliably self-report whether it triggered action has a compounding trust problem. This review sent a direct operator push notification on completion specifically because of that history — the next concrete step is a human merging one of the accumulated branches, or acting on the notification directly. |
| **Medium** | jobright | Lever and Workable remain wired but fully unverified against real DOM; Workday reached the live pre-submit gate this window but has not completed a real submit (parked on #83). Only Greenhouse and Ashby have completed live submits. | The live-proof backlog isn't shrinking evenly even as adapter count and submit volume grow. |
| **Medium** | jobright | Two open overnight-log findings, explicitly carried forward unfixed this window: #21, an export-control question fills `true` instead of the selected option label (control-kind mapping bug); #19, Cloudflare conditional forms cross-fill an answer into the wrong field when the DOM shifts mid-fill. | These are exactly the class of silent-wrong-answer bug the validation ladder exists to catch before it reaches a real submission — and submissions are now happening at higher volume than when these were first found. |
| **Medium** | tSearch | No fail-closed CI enforcement — `CLAUDE.md` documents boundaries in prose only; `.github/workflows/ci.yml` runs only typecheck + tests, no forbidden-API/PII checker. Unchanged since 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose. |
| **Low** | jobright | The parallel, unreconciled rebrand branch (`claude/product-branding-design`) has drifted further: now 104 commits ahead of `master`, 50 behind. | Will cause more merge pain the longer it sits; no functional risk today. |
| **Low** | tSearch | `docs/system-brief.md` and `docs/assessment-rubric-architecture-audit.md`/`tsearch-playwright-system-audit.md` are stale relative to fixes already shipped (all in the safer direction — they overstate risk, not understate it). | Doc drift undermines trust in the others even when the drift is "safe." One-line/one-paragraph fixes. |
| **Low** | tSearch | Digest ranking sort-order refinement is built; true weight-learning from feedback is not. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **NEW this review — a non-LLM, zero-API-key self-healing locator
  framework matches this project's own stated philosophy better than
  Skyvern does, and targets exactly the bugs the overnight logs keep
  surfacing.** [`ShantanuVr/playwright-self-healing-framework`](https://github.com/ShantanuVr/playwright-self-healing-framework)
  (TypeScript + Playwright, "zero LLMs, zero API keys") intercepts a broken
  locator, scores the live DOM against a stored semantic fingerprint, and
  rewrites the selector on the fly — the same DOM-drift class of failure
  as Cloudflare's conditional-DOM cross-fill (#19) and the earlier Ashby
  DOM-at-fill-time mismatch, but without introducing a second
  nondeterministic LLM call into a codebase whose entire product bet is
  determinism over LLM-driven browsing. Worth a scoped evaluation before
  reaching for Skyvern's heavier vision-based approach for this specific
  failure class.
- **Skyvern** (computer-vision + LLM reasoning form filling) remains a
  reasonable second-line candidate for the same DOM-fragility failure
  modes, but is a bigger philosophical departure than the self-healing
  locator approach above — same promotion-bar discipline as Stagehand
  should apply before either is anything but an experiment.
  https://www.skyvern.com
- **A path/size-based pre-commit block, not a secret scanner, is still the
  correct tool for the `artifacts/` leak** (carried forward, still
  unapplied and now more urgent given the 08-31 growth-rate finding above)
  — a rule rejecting any staged path under `artifacts/**/materials/` (or
  any PDF over a size threshold in that tree), delivered via the
  already-present Lefthook/`.githooks` mechanism.
  https://github.com/evilmartians/lefthook
- **The `agent-engine-decision.md` pre-registered-comparison pattern is
  still worth generalizing internally** — the same "define the promotion
  bar before the new component can become default" shape could apply to
  the ATS-adapter live-DOM backlog (a written bar for "Lever goes from
  `FIXTURE_CONFIRMED` to `LIVE_READ_ONLY_CONFIRMED`") and, given this
  review's new §1.3 finding, to "self-reported gate pass" itself — no fix
  commit should be trusted as `UNIT_CONFIRMED` without a machine re-running
  it, which currently isn't happening.

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for at least the twelfth review in a row.
- **NEW this review — a directly runnable open-source tool for the exact
  gap already identified (six judges, zero measured inter-rater-agreement
  or position-bias numbers):** [`joaquinhuigomez/llm-judge-calibrator`](https://github.com/joaquinhuigomez/llm-judge-calibrator)
  runs position-swap evaluation across judge calls, computes Cohen's Kappa
  and position/verbosity/self-preference bias rates, and produces a
  calibration report with an overall grade — a more concrete, immediately
  actionable substitute for the previously-cited RULERS/Judge Reliability
  Harness academic references (still directionally correct, but this is
  something that can actually be pointed at the six existing rubric
  judges this week: sample 100–300 traces, run each comparison twice with
  slots swapped, get a real Kappa number instead of an assumed one).
- **Supabase Row-Level Security review before the dual-write lands** — the
  scaffolding remains correctly gated (deny-all RLS, server-only
  service-role key, throws until wired) and unchanged; worth the same PII
  scrutiny once the dual-write actually lands, given both repos' shared
  history with this exact failure mode.

---

## Changelog

- **2026-08-31** — This review (13th+ attempt). Confirmed jobright: 50 new
  commits since 08-29 (`d0b39dc` → `c284026`), almost entirely a second
  overnight L3 automation window (08-30→31). 4 new real
  `LIVE_MUTATION_CONFIRMED` Submit clicks (Neuralink, Old Mission, DV
  Trading — all Greenhouse — and Exa on Ashby, a resubmit after fixing a
  confirmation-banner misclassification bug), bringing the running total
  to 6 in 4 days. Workday reached a live pre-submit gate on a fresh tenant
  (Stryker) for the first time but did not submit (parked on open issue
  #83). The two previously-open correctness bugs (#19 Cloudflare cross-fill,
  #21 export-control checkbox) are explicitly carried forward unfixed in
  the newest overnight log with no commit touching either.
  `docs/current-state-and-phase56.md` and `docs/agent-engine-decision.md`
  are byte-identical to 08-29 — no doc updates landed. The
  `claude/product-branding-design` divergence grew (now 104 ahead/50
  behind `master`). Most significantly, **the PII leak accelerated
  sharply**: tracked resume-PDF paths went from 574 to 4,086 (real,
  substantial PDF content from 194 to 360) in two days, confirmed to track
  directly with automation volume via the unexcluded `git add -A` in the
  autopush path — same root causes, same unapplied fix, now compounding
  daily rather than sitting flat. Flagged a new risk this review: submit
  volume is now outpacing this review's ability to independently verify
  the tool's own gate (this sandbox has no `node_modules` in either repo
  checkout, so typecheck/tests could not be re-run directly this time;
  recent fix commits carry only self-reported "Gate: ... green" claims,
  and the project's own validation-ladder rule says a self-report doesn't
  count until independently re-verified). Confirmed tSearch: zero new
  commits for a full week (`HEAD` still `a52881b`), PII-history exposure
  reconfirmed unpurged and unchanged, CI still typecheck+test only. Neither
  repo has any open issues or PRs (confirmed via live GitHub queries, not
  reused from the prior draft). Replaced the Skyvern-only jobright
  amendment with `playwright-self-healing-framework` (LLM-free, better
  philosophical fit, targets the DOM-drift bugs directly) as the lead
  candidate, keeping Skyvern as a second-line option; replaced the abstract
  RULERS/Judge-Reliability-Harness references for tSearch with a directly
  runnable tool, `llm-judge-calibrator`. Sent one operator push notification
  on completion given the scale of the jobright escalation, independent of
  whether this document lands anywhere by any other path — same rationale
  as 08-29, since the meta-risk (this doc never merging) is itself
  unchanged. Pushed to this session's assigned branches; did not assume
  this lands on `main`/`master` without a human merging it.
- **2026-08-29** — 12th+ attempt. Independently re-derived
  every figure directly against current `HEAD` in both repos rather than
  trusting the prior 08-27 draft's numbers, and found the prior draft's
  characterization of the resume-PDF leak incomplete: byte-level inspection
  (not previously done) shows 194 of the 574 tracked paths are real,
  substantial PDF content rather than placeholders, and a **second, more
  directly identifying leak** was found that no prior review had
  checked for — the operator's real phone number and email in cleartext
  across 27 currently-tracked files, including a live fill artifact. Sent
  two direct operator push notifications mid-review (one on discovery of
  the resume-PDF/public-repo finding, one on discovery of the cleartext
  phone/email finding), independent of this document landing anywhere,
  because of this document's own documented history of confident
  self-misreporting. Confirmed jobright: 19 new commits since the 08-27
  review (`933ee71` → `d0b39dc`) — ATS board discovery went live and
  produced real applications, six same-night bug fixes from an overnight
  L3 automation session, 2 real Submit clicks (Figma, Stripe) both parked
  `UNCERTAIN` behind an emailed-code wall since auto-recovered. Confirmed
  tSearch: zero new commits since 08-24 (`HEAD` still `a52881b`); resolved
  a discrepancy in the 08-27 draft about digest Phase 4 status via direct
  code read of `buildDigest.ts` (basic filter/boost is built; full
  weight-learning is not). Re-ran both repos' verify gates directly.
  Neither repo has any open issues or PRs. Replaced one superseded
  amendment (generic Autorubric citation) with more current, directly
  actionable references (RULERS, Judge Reliability Harness) and added
  Skyvern as a scoped evaluation candidate for the DOM-fragility failures
  the overnight log surfaced. Pushed to this session's assigned branches;
  given the meta-risk pattern (§4), did not assume this lands on
  `main`/`master` without a human merging it.
- **2026-08-27 and earlier (2nd–12th reviews)** — See prior branch history
  (`claude/epic-pasteur-*` / `claude/busy-clarke-*`, none merged) for the
  full incremental record: PII-history exposure found and reconfirmed
  unpurged on every cycle since 08-07; ownership-share and mid-run-auth
  fixes landed and verified 08-10/11; jobright's resume-PDF leak first
  found 08-11 (183 paths) and reconfirmed worse on every subsequent review
  through 08-27 (574 by this review); a large jobright feature wave (ATS
  discovery, Lever/Ashby/Workday/Workable adapters, Stagehand engine,
  console redesign, operator-handoff ergonomics) landed 08-09 through
  08-26; a large tSearch feature wave (autonomy/oracle package, digest
  feedback capture, youth wildcards, corroborated-GitHub, Supabase
  scaffold, website graph) landed 08-10 through 08-24.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly rather than relying solely on subagent
  report.
