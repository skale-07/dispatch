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
| Last reviewed | 2026-08-29 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**public**; product renamed "Dispatch" on `master` 2026-08-17, repo/URL name unchanged), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **twelfth** attempt at this document since
2026-08-07. Every prior attempt was pushed to a short-lived `claude/busy-clarke-*`
(jobright) / `claude/epic-pasteur-*` (tSearch) branch and never merged to
`master`/`main` — confirmed directly this review via `git merge-base
--is-ancestor` against every reachable review commit, not assumed. At least
two prior reviews (2026-08-21, 2026-08-25) made confident claims about their
own merge/notification status that were checked and found false. This
review does not assume its own claims are more reliable by default — every
figure below was re-derived directly against current `HEAD` in this
session (byte counts, blob checks, regex tests, `git log` ranges), and two
direct push notifications were sent to the operator mid-review, independent
of whether this document ever reaches a human by any other path, precisely
because that path has a documented history of failing silently.

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
fixtures.** An overnight L3 armed-automation session (2026-08-28→29, caps
removed by explicit operator directive) ran 7 sessions, 100+ application
attempts, and produced **2 real Submit clicks** against live employer forms
(Figma, Stripe) — both correctly parked `UNCERTAIN` behind an emailed
verification-code wall (a gap discovered and fixed same-night, `de2f2f1`;
future runs recover automatically). The product has therefore now
**completed a live closed loop**, which the 2026-08-07 doc explicitly said
had never happened — but not by fixing the original bug (see §1.3).

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
- **Verify gate, re-run directly this review on current `HEAD` (`d0b39dc`):** typecheck clean; `check:forbidden`/`check:secrets` both `ok`; `npm run test` ~993+/1221 passing, all failures traced to a missing `chrome-headless-shell` browser binary in this sandbox, not a code regression.
- **ATS coverage — expanded from Greenhouse-only to five platforms:** registry now lists `greenhouse, lever, ashby, workday, workable, generic`. All `FIXTURE_CONFIRMED`; live-DOM proof is real for Greenhouse (including the two live overnight submits) and partially demonstrated for Ashby (live fills attempted overnight, one open DOM-timing bug — see §1.3 issue tracker); Lever, Workday, Workable remain `UNVERIFIED` against real live pages.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

**A large feature wave landed since the last logged review (2026-08-27):
19 more commits (`933ee71` → `d0b39dc`), on top of 71 total since 08-07.**
Highlights: ATS-board discovery went live and started sourcing real
applications; six real bug fixes shipped same-night from the overnight
automation loop (Greenhouse combobox ambiguity, alias-mapper hijacking
screener questions, `gh_jid` URL canonicalization, emailed-code-wall
recovery); a 19-item self-authored issue log now exists at
`artifacts/overnight-issues-2026-08-28.md` documenting exactly what broke
and what's still open (Ashby DOM-at-fill-time mismatch, an export-control
checkbox mis-typing to `true` instead of the option label, Cloudflare
conditional-DOM drift cross-filling answers into the wrong field, an
illegal state-machine transition, a stale `FIELD_VERIFICATION` resume that
re-verifies an empty page).

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
- **`docs/current-state-and-phase56.md` is now actively wrong, not just
  stale:** it still frames the project as "Phase 5.6, live validation
  only" and still says live discovery "has never produced a job" — both
  false given the above. This needs a rewrite, not a patch; an operator or
  agent trusting it would materially misjudge what's shipped.
- **Second navigation-agent engine (Stagehand) is a pre-registered
  comparison, not a decision.** `docs/agent-engine-decision.md` (new,
  2026-08-26) defines the promotion bar (must strictly beat the incumbent
  `browser_use`, zero safety events) before Stagehand can become default —
  a genuinely good pattern (see §5) — but the comparison table is empty;
  nothing has run yet. Separately, a **navigation-only** agent fallback
  (`AGENT_FALLBACK_ENABLED`) is confirmed live in production, but strictly
  to get through navigation walls (find Apply, reach the form) — it never
  chooses field values or clicks Submit, per the overnight log's own
  operator directive.
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

- **CRITICAL — a real, growing, currently-live PII leak on `master`,
  invisible to anyone who reads only the stale phase docs.** Verified
  directly this review, not carried over from a prior draft:
  - **574 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths.** Byte-level inspection (not done by any prior review) shows
    these are **not all placeholders**: 380 are a trivial 45-byte test
    fixture (`%PDF-1.1\n1 0 obj<<>>...`), but **194 are real, substantial,
    FlateDecode-compressed PDF documents** across 3 distinct file sizes
    (113,381 / 76,462 / 74,509 bytes) — the shape of genuine exported
    resumes, not synthetic content, repeated across many application UUIDs.
  - **A second, distinct, and arguably worse leak the prior eight review
    cycles did not check for: the operator's real contact information is
    in cleartext in currently-tracked files.** `artifacts/overnight-issues-2026-08-28.md`
    (committed `d0b39dc`, pushed to the public repo) contains the
    operator's real phone number in plain prose ("contact info (phone
    480-589-7636, jh.edu email) already in public-profile.json"). The
    operator's real email address (`skale1@jh.edu`) appears in **26
    tracked files**, including `artifacts/sandbox/plan-*.json` fixtures and
    at least one live-executed fill artifact
    (`artifacts/ats-fill/generic-live/live-executed-*.json`).
  - **Root causes, all confirmed directly in code:** `.gitignore` line 20
    has `artifacts/` **commented out**. The safety check that exists
    specifically to catch this (`src/security/artifactScan.ts`'s
    `REQUIRED_GITIGNORE_ENTRIES` check) tests via a naive
    `gitignoreText.includes("artifacts/")`, which is satisfied by the
    *commented-out* line — so the check that should have caught this never
    fires (verified directly: the substring is present, so the check
    passes, even though the rule is dead). The forbidden-filename pattern
    `/resume\.pdf$/i` only matches a file literally named `resume.pdf`, not
    the real naming convention `resume-<hash>.pdf` (verified: the regex
    does not match `"resume-aeb31421.pdf"`). `artifactAutopush.ts` runs an
    unexcluded `git("add", "-A", "--", "artifacts")`. The `.githooks/pre-commit`
    hook that would catch this is opt-in (`npm run hooks:install`) and not
    installed in this checkout. A fourth path also leaks it independent of
    all of the above: running `npm run test` itself writes fixture output
    into the tracked tree, because `artifacts/` isn't gitignored at all.
  - **This has been independently rediscovered by the automated review
    loop at least nine times** (2026-08-11 through 08-27, escalating
    183 → 187 → 308 → 327 → 366 → 396 → 481 → 574 tracked paths), every
    time on a branch that never merged to `master`, every time noted as
    "still unfixed." No purge of any kind has been attempted. This is now
    the single longest-standing, actively-worsening, unaddressed item
    across both repos.
- **A parallel, independently-diverged rebrand branch exists:**
  `claude/product-branding-design`'s `DESIGN.md`/`AGENTS.md` (`0b66fda`) is
  **not** an ancestor of `master`'s own already-merged Dispatch rebrand
  (`eedc63c`, `1f4b64c`) — two unreconciled versions of the same doc. Low
  urgency, but will cause merge pain if landed as-is.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand promotion-bar
  comparison actually running.
- **Next up, in priority order:** (1) fix the `artifacts/` leak at the
  root — uncomment the `.gitignore` line, fix `REQUIRED_GITIGNORE_ENTRIES`
  to test for an *active* rule rather than a substring, fix the resume
  regex to match the hash-suffixed convention, confirm the pre-commit hook
  actually runs on the autopush machine, **then** purge history
  (`git filter-repo`) — a `.gitignore` fix alone does not remove what's
  already public; (2) rewrite `current-state-and-phase56.md` to reflect
  reality; (3) resolve the two open overnight-log items that touch
  correctness of submitted data (export-control checkbox mis-typing,
  Cloudflare conditional-DOM cross-fill); (4) live-DOM proof for Lever,
  Workday, Workable; (5) let the Stagehand-vs-`browser_use` comparison
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
and now arbitrary web-page team/about listings), scoring on evidence of
building + thinking + pedigree, then running LLM "judges" over their actual
public work to produce a defensible, evidence-cited priority score for a
recruiter digest. The stated non-negotiable design principle
(`implementation-prompt.md`) is that every judgment must be
evidence-grounded and that missing evidence maps to `insufficient_public_evidence`,
never to a negative capability judgment.

### 2.2 Core technical details

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend.
- **No new commits since 2026-08-24** — `HEAD` is still `a52881b`
  ("Isolate youth wildcards on Score and stop dropping seed-tree neighbors
  below the top-80 cut"). 41 commits landed between 2026-08-07 and 08-24,
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
- **Verify gate, re-run directly this review on current `HEAD`:** typecheck
  clean; `npm run test` 396/396 passing across 62 files.

### 2.3 Technical direction

- **CRITICAL — PII history exposure: unchanged, still unpurged, now
  confirmed for at least the eleventh review in a row.** `profiles/`
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
clean since 08-10). jobright's is the operator's own materials — real
resume PDFs *and*, newly confirmed this review, the operator's own phone
number and email in cleartext — still actively growing in the *current*
tree via ordinary automated use of the tool, which makes it the more
urgent of the two: every fix has been fully specified for nine review
cycles without being applied.

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment
was dropped by decision for the MVP. Low severity, unchanged since 08-07.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | jobright | **Ninth consecutive review finding this unfixed, and worse than any prior review understood: 574 tracked resume-PDF paths (194 with real, substantial PDF content, not placeholders) plus the operator's real phone number (1 file) and email (26 files, including a live fill artifact) in cleartext, all currently tracked on the public repo.** Root causes unchanged since 08-11: a commented-out `.gitignore` line that the safety checker's naive substring match fails to catch, a resume-filename regex that doesn't match the real naming convention, an unexcluded `git add -A` in the autopush path, and an opt-in pre-commit hook not installed in this checkout. No purge attempted. | Longest-standing, actively-worsening item across both repos, and the only one with a hard fix already fully specified — one `.gitignore` line plus two small code fixes closes every known leak path; only the history purge is nontrivial. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history on this public repo — reconfirmed directly this review. No purge attempted since first flagged. | Eleventh review in a row confirming a live, non-hypothetical exposure of real third-party people's data. |
| **High** | jobright | `docs/current-state-and-phase56.md` actively contradicts the repo's own state (still frames the project as pre-live-loop "Phase 5.6") while a real live closed loop (2 real submits, five ATS adapters, a console redesign, ATS board discovery) has already shipped. | An operator or future agent trusting this doc would materially misjudge what's proven and what's still broken. Fix is doc edits, not new code. |
| **High** | jobright | `auto:cycle`/L3 armed mode is a genuinely unattended fill-and-submit operating mode, now proven to click real Submit buttons against real employers, with no per-run human click once armed and caps removable by the operator. | A deliberate, working product capability — but worth a standing line item precisely because it now has live evidence behind it, not just design intent. |
| **Medium** | both | **Meta-risk: this document has been drafted at least twelve times since 08-07 and never merged to `main`/`master` in either repo; at least two prior drafts made confident, false claims about their own merge/notification status.** | A review process that both fails to trigger action and cannot reliably self-report whether it triggered action has a compounding trust problem. This review sent direct operator push notifications specifically because of that history — the next concrete step is a human merging one of the accumulated branches, or acting on the notifications directly. |
| **Medium** | jobright | Lever, Workday, and Workable remain wired but unverified against real DOM; only Greenhouse and (partially) Ashby have live evidence. | The live-proof backlog isn't shrinking even as adapter count grows. |
| **Medium** | jobright | Two open overnight-log findings touch data correctness on already-submitted-adjacent flows: an export-control question fills `true` instead of the selected option label (control-kind mapping bug), and Cloudflare conditional forms cross-fill an answer into the wrong field when the DOM shifts mid-fill. | These are exactly the class of silent-wrong-answer bug the validation ladder exists to catch before it reaches a real submission. |
| **Medium** | tSearch | No fail-closed CI enforcement — `CLAUDE.md` documents boundaries in prose only, no forbidden-API checker. Unchanged since 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose. |
| **Low** | jobright | A parallel, unreconciled rebrand branch (`claude/product-branding-design`) diverges from the already-merged Dispatch rebrand on `master`. | Will cause merge pain if landed as-is; no functional risk today. |
| **Low** | tSearch | `docs/system-brief.md` and `docs/assessment-rubric-architecture-audit.md`/`tsearch-playwright-system-audit.md` are stale relative to fixes already shipped (all in the safer direction — they overstate risk, not understate it). | Doc drift undermines trust in the others even when the drift is "safe." One-line/one-paragraph fixes. |
| **Low** | tSearch | Digest ranking sort-order refinement is built; true weight-learning from feedback is not. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **A path/size-based pre-commit block, not a secret scanner, is the
  correct tool for the `artifacts/` leak.** gitleaks/`git-secrets`-style
  tools are content-pattern matchers for credential-shaped strings; a
  resume PDF or a plaintext phone number in prose contains no such
  pattern. The right primitive is a rule that rejects any staged path
  under `artifacts/**/materials/` (or any PDF over a size threshold in
  that tree) — Lefthook remains the right *delivery mechanism* for that
  custom rule, not an off-the-shelf ruleset.
  https://github.com/evilmartians/lefthook
- **GitHub secret-scanning push protection with a custom pattern** — still
  requires paid GitHub Secret Protection on org-owned repos, not available
  here, and wouldn't catch a PDF or prose leak regardless (content- vs.
  path-based, same reasoning as above).
- **Skyvern** (computer-vision + LLM reasoning form filling, reads the page
  visually rather than via CSS selectors) — worth a scoped, non-promoted
  evaluation alongside the existing Stagehand-vs-`browser_use` comparison
  specifically for the DOM-fragility failure modes the overnight log just
  surfaced (Cloudflare's conditional-DOM drift, Ashby's DOM-at-fill-time
  mismatch) — exactly the class of failure a selector-based approach is
  structurally worst at. Same promotion-bar discipline as Stagehand should
  apply before it's anything but an experiment. https://www.skyvern.com
- **The `agent-engine-decision.md` pre-registered-comparison pattern is
  worth generalizing internally** — the same "define the promotion bar
  before the new component can become default" shape could apply to the
  ATS-adapter live-DOM backlog (a written bar for "Lever goes from
  `FIXTURE_CONFIRMED` to `LIVE_READ_ONLY_CONFIRMED`").

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for at least the eleventh review in a row.
- **RULERS** (Hong et al., 2026) and the **Judge Reliability Harness**
  (arXiv 2603.05399) — both more directly actionable than the previously-cited
  AutoRubric for the current gap (six judges, zero measured
  inter-rater-agreement or position-bias numbers). RULERS compiles rubric
  criteria into versioned immutable bundles, requires judges to cite
  auditable evidence per scoring decision, and applies post-hoc calibration
  against human labels — a close match for hardening the existing YAML
  rubric system. The Judge Reliability Harness is purpose-built for stress
  testing judge consistency, which is the concrete next step this doc has
  recommended for three reviews running: sample 100–300 traces, have 2–3
  humans label them, compute agreement (target Krippendorff's alpha ~0.8),
  and run each comparison twice with the candidate's material in each slot
  to check for position bias.
- **Supabase Row-Level Security review before the dual-write lands** — the
  scaffolding remains correctly gated (deny-all RLS, server-only
  service-role key, throws until wired) and unchanged; worth the same PII
  scrutiny once the dual-write actually lands, given both repos' shared
  history with this exact failure mode.

---

## Changelog

- **2026-08-29** — This review (12th+ attempt). Independently re-derived
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
- **2026-08-27 and earlier (2nd–11th reviews)** — See prior branch history
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
