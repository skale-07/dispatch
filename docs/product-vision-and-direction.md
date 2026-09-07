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
| Last reviewed | 2026-09-07 |
| Reviewed by | Scheduled agent review (automated) |
| Repos covered | `skale-07/jobright-application-agent` (**private**; product name "Dispatch"), `skale-07/tSearch` (**public**) |

**Note on provenance — read this before trusting anything below at face
value.** This is at minimum the **sixteenth** attempt at this document since
2026-08-07. Every prior attempt was pushed to a short-lived
`claude/busy-clarke-*` (jobright) / `claude/epic-pasteur-*` (tSearch) branch
and **never merged to `master`/`main`** — reconfirmed directly this review
(both default branches still carry only the original 08-07 `defde99` commit
for this file). This review's own designated branches
(`claude/busy-clarke-bqnhr9` / `claude/epic-pasteur-bqnhr9`) are themselves
fresh, single-use names, i.e. this attempt is starting from the same
structural position as the fifteen before it — see the meta-risk in §4,
now the standing top line of that table. Every figure below was re-derived
directly against current `HEAD` in both repos this session (`git ls-tree`,
`git log`, direct file reads, live GitHub API queries for issues/PRs/repo
visibility) rather than carried over from the 15th review's text; where a
figure is genuinely unchanged and wasn't independently re-measured, that is
stated explicitly rather than implied.

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

**That single-operator framing is now concretely in tension with where the
product is being built, unchanged from the 15th review's finding.**
`docs/marketing/college-launch.md` (dated September 2026, targeting "fall
recruiting season" — now) describes turning Dispatch into a multi-user
hosted product: a public app, invite/referral growth loop, waitlist, and
campus marketing collateral, backed by a genuinely well-built Supabase
schema (RLS on every table, service-role key server-only — see §1.2). That
may be the right call, and the marketing plan is unusually disciplined about
evidence ("we never fabricate user counts, testimonials, or outcomes"). But
it changes the blast radius of every data-handling risk below from "the
operator's own data" to "every invited student's resume and contact info,"
and the pipeline that would carry that data is the same one that has been
leaking the operator's own resume PDFs into git for a month (§1.3, §4).

### 1.2 Core technical details

- **Stack:** TypeScript / Node 20 / Playwright / better-sqlite3 / Zod / Anthropic + OpenAI + Kimi K3 (Moonshot) LLM call sites / Express + React operator console / two navigation-agent sidecars (Python `browser_use`, incumbent; TypeScript `agent/stagehand/`, still evaluation-only per `docs/agent-engine-decision.md`, unchanged "SPIKE — comparison not yet run") / Supabase (Postgres + Auth + Storage) as the backing store for the public-app surface, gated behind `SUPABASE_SYNC_ENABLED` / `CONSOLE_HOSTED_MODE_ENABLED`.
- **Source of truth:** SQLite (`data/app.sqlite`, gitignored) for the operator-facing engine, plus three append-only telemetry corpora (`fill_runs`/`fill_field_outcomes`, `navigation_attempts`, `submit_attempts`). The public-app surface has its **own** source of truth in Supabase Postgres (`supabase/migrations/`, 9 files) — a second persistence layer.
- **State machine:** `DISCOVERED → ELIGIBILITY_CHECK → QUEUED → inspect → fill → READY_TO_SUBMIT → SUBMITTING → SUBMITTED/SUBMISSION_VERIFICATION_FAILED → contacts/outreach → COMPLETED`, `FAILED_RETRYABLE`/`FAILED_FINAL` terminals, human `review:resolve` only (three exits — submitted / requeue / abandon — never automated).
- **Safety architecture:** every mutation capability sits behind a named fail-closed env flag (full list in `CLAUDE.md`). `chromium.launch` stays confined to three session-infra files. `check:forbidden` CI-fails the build if Outlook send APIs appear anywhere. Free-text/essay and demographic fields are architecturally incapable of being auto-filled — they route to `review_items`; predicted/generated text requires an explicit human "Approve & save."
- **The "operator confirmation" invariant has been redefined, not weakened at the gate level — worth stating precisely.** CLAUDE.md still reads "submit requires... explicit operator confirmation." The code now implements that as an **L3 armed-session** model (`src/automation/armSession.ts`): the operator explicitly arms a session with a time-boxed window (15–240 min) and a numeric submit budget (default 10); once armed, `SUBMIT_REQUIRES_LOCAL_CONFIRMATION=false` lets the click-commit gate (`submitRun.ts`) atomically consume budget slots with no further per-submission prompt, `--yes` required, budget consumed only immediately before the actual click so a failed attempt never burns a slot. `auto:cycle` (`src/automation/autoCycle.ts`) goes one step further: installed as a Windows Scheduled Task (`/SC HOURLY /MO 4` per `operator-guide.md` §19) with a standing `.env`, it self-arms and runs with **no per-run human click at all** — the code's own comment states the installed task itself "IS the standing human authorization." Every underlying gate (fail-closed defaults, atomic budget consumption, `AUTOMATION_ENABLED` kill switch) is intact and none has been silently loosened — but the *authorization model* has moved from "a human confirms this specific submission" to "a human configured a machine to confirm submissions on its behalf, on a schedule, for hours at a time." Whether that still satisfies the spirit of the house rule is a judgment call worth an explicit operator decision, not an assumption either way — flagged in §4 rather than asserted as a violation.
- **LLM boundary has grown substantially past "one narrow call site."** Live LLM usage now spans at least 6 gated call sites (outreach generation, essay drafts, screener label mapping, screener predictions, submit-inventory-healer proposal drafting, the nav-agent sidecar) plus the newer Kimi K3 addition. Each stays individually flag-gated and routes through the same approved-plan/review-item machinery downstream (verified by reading `src/screeners/`: `SCREENER_PREDICT_LLM_ENABLED` predictions land in a review item and require explicit human approval before ever reaching a form) — not a new safety gap, but any doc still describing "one narrow LLM call site" is stale.
- **A real, code-verified security loosening in sender-trust magic-link handling remains live, unchanged since first flagged 2026-08-11.** Read directly this review (`src/gmail/verificationParsers.ts:extractMagicLink`): domain match to the sender or an allowlist is a **ranking boost only** (+2), not a filter. Any `https://` link whose path merely contains a verification-shaped keyword (`verify|confirm|magic|auth|token|activate|login|click`) also scores +2 and qualifies with **zero sender-domain requirement** — no SPF/DKIM check anywhere in the chain. The nav-agent sidecar then actually navigates to the winning link using the operator's authenticated browser session. Downstream congruence + final-URL validation still stop a bad link from ever producing stored application data, which bounds the *application-data* blast radius, but the browser still visits an attacker-influenced URL on a phishing-style email with a live authenticated session. This has now gone unaddressed for four consecutive review cycles.
- **ATS coverage:** Greenhouse, Ashby, Lever, Workable, Workday, and — new since the 15th review's count, confirmed this review by direct source read — a UKG Pro shadow-DOM apply path (Auth0 signup submit, section expansion, disability-question fencing), plus a generic adapter with ATS-handoff detection for careers-site front doors. `README.md`'s "Current state" (dated 2026-08-31, the accurate doc — see §1.3) names 5 named `LIVE_MUTATION_CONFIRMED` submits directly (Neuralink, Old Mission, DV Trading via Greenhouse; Exa via Ashby); the 14th/15th reviews' changelog record 4 more the same evening (Stripe, Nuvo via Gem — first Gem submit, TIAA via Workday — first Workday submit), for a carried-forward total of **≥9 real submits across 4 ATS platforms**. Not independently re-confirmed this review (no live DB in this sandbox); Lever and Workable remain the two adapters with no live-DOM evidence per the 15th review's count.
- **Lineage:** the session/storage layer was deliberately hardened from tSearch (see §3) — atomic JSON patterns and the lazy-session-open concept were ported and re-verified; tSearch's product logic (scoring, GitHub graph, olympiad data) was explicitly **not** ported.

### 1.3 Technical direction

- **The `artifacts/`-tracked resume-PDF leak is worse than every prior
  review measured, still fully live, and still has all four root causes
  unfixed a full month after first being found.** Re-measured directly
  against current `HEAD` (`1772d9f8`, 2026-09-06) this review, full sweep not
  a sample:
  - **7,522 tracked `artifacts/applications/**/materials/resume-*.pdf`
    paths** — up from 6,025 four days ago (+25%) and from 183 when first
    found on 2026-08-11 (41x growth in under a month).
  - **Byte-size breakdown: 480 files carry real, substantial content**
    (310 at 113,381 bytes, 134 at 76,462 bytes, 16 at 74,509 bytes, plus a
    newly-observed 20 files at 113,810 bytes — a fourth real-content
    variant, up from three), the remaining 7,042 are the 45-byte placeholder
    fixture. Real-content count is up from 435 four days ago.
  - **Operator contact info still present in log artifacts**, confirmed via
    a direct email-pattern match against `artifacts/ats-fill/generic-live/*.json`
    (6 files hit on a strict email-regex check this review; prior reviews'
    broader phone+email methodology found 28 — order of magnitude
    consistent, not re-verified to the identical method this cycle).
  - **Root causes unchanged, confirmed by direct file read this review**:
    `.gitignore`'s `artifacts/` line is still commented out; `artifactAutopush.ts`
    still `git add -A -- artifacts` with no `materials/` exclusion; no
    `.git/hooks/pre-commit` is installed (`ls .git/hooks/pre-commit` →
    not found) despite CLAUDE.md explicitly forbidding committing real
    resumes/PDFs. `check:secrets` is a secrets/API-key scanner and would not
    catch this even if the hook were installed. **No purge has been
    attempted at any point in this document's sixteen review cycles.**
  - **Repo visibility: private**, reconfirmed this review via the GitHub
    API (`"visibility": "private"`). This bounds today's blast radius to
    collaborators, but per §1.1 does not survive contact with a
    student-facing resume-upload feature, and does not change that the data
    is sitting unpurged in git history regardless of who can currently see
    it.
- **Phase-status docs remain internally contradictory, unchanged since the
  14th review** — `docs/current-state-and-phase56.md` still frames the
  product at "Phase 5.6" and still states live discovery "has never produced
  a job," directly contradicted by `README.md`'s own accurate "Current state
  (2026-08-31)" section describing 5+ named live submits. An operator or
  agent reading the phase doc instead of the README would materially
  misjudge the product's actual state. This is a documentation fix, not new
  engineering, and has been a one-line-priority "next up" item for three
  review cycles without being actioned.
- **`master`'s disjoint-root history — explained, not resolved.** Current
  `master` tip is rooted at a 2026-09-01 commit that is, by direct SHA
  comparison, exactly a prior session's own designated development-branch
  tip — consistent with a per-session squash mechanism in how this
  environment hands off state, not tampering. It does **not** launder the
  PII finding: the new root's own tree already contained the leak in full,
  and the pre-rewrite branches are now orphaned copies that still
  independently hold the older leak on GitHub — more exposed surface, not
  less.
- **Submit-gate verify evidence remains self-reported only.** No commit in
  this window's history carries anything beyond a self-authored "tests
  green" claim; this sandbox has no live DB or `node_modules` to
  independently re-run the gate, now a standing five-review gap. Per the
  project's own validation-ladder discipline, a capability's self-report
  carries no level until independently verified — this applies to every
  recent Workday/Workable/UKG fix commit equally.
- **Deliberately not in scope:** Outlook send (permanently out of scope),
  loosening L3's numeric caps, replacing any deterministic adapter with an
  LLM agent as the default path ahead of the Stagehand-vs-`browser_use`
  comparison actually running.
- **Next up, in priority order:** (1) fix the `artifacts/` leak's four root
  causes and purge history **before** any real resume-upload feature ships
  to invited students — no longer optional cleanup, a pre-launch gate per
  §1.1; (2) get the operator's direct read on whether the L3/`auto:cycle`
  authorization model (§1.2) matches intent, since nobody outside this
  document has weighed in on it across five review cycles; (3) rewrite
  `current-state-and-phase56.md` from the accurate `README.md`; (4) close
  the sender-trust magic-link gap (tighten domain affinity or add
  sender-authentication) — four cycles unaddressed; (5) get independent,
  non-self-reported confirmation of the verify gate; (6) live-DOM proof for
  Lever and Workable; (7) let the Stagehand comparison actually run.

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

- **Stack:** TypeScript / Node / Playwright (headed, LinkedIn only) / Express + Vite (radial-graph UI) / Anthropic + OpenAI (provider-selectable) / Resend / a Supabase scaffold (deny-all RLS, throws until wired — not yet a live dual-write).
- **Still zero new commits.** `HEAD` is still `a52881b` ("Isolate youth wildcards on Score and stop dropping seed-tree neighbors below the top-80 cut"), dated 2026-08-24 — **14 days of inactivity**, reconfirmed directly this review, the longest stretch this document has recorded.
- **Discovery/Assessment/Presentation separation, judge system (six rubric judges), Supabase scaffold, website-graph channel, marks/watchlist feature — all unchanged**, no commits landed to change any of it.
- **Verify gate not independently re-run this review** (no `node_modules` in this sandbox, fifth consecutive review with this gap). Last independently-confirmed figure (2026-08-29): typecheck clean, 396/396 tests across 62 files.

### 2.3 Technical direction

- **CRITICAL, and still the more urgent of the two repos' PII exposures on
  today's blast radius — see §3.** `profiles/`/`backup/` real scraped-LinkedIn
  data was untracked from the working tree and gitignored on 2026-08-10, but
  **remains fully reachable in git history on this public repo** —
  reconfirmed directly this review (`git log --all --diff-filter=A --name-only
  -- profiles/*` still resolves 202 files across the commits that added them;
  the repo is world-clonable and world-readable right now). **This is now
  the sixteenth consecutive review confirming this unpurged**, on a repo
  whose public visibility has not changed. `git filter-repo` + force-push +
  collaborator re-clone remains the concrete, unexecuted unblock.
- **Everything else in this section is unchanged since the 13th–15th
  reviews** — restated briefly rather than re-derived, since zero commits
  landed to change any of it:
  - Ownership-share scoring bug and mid-run LinkedIn re-auth detection: both
    genuinely fixed 2026-08-10 (`collectOwnershipEvidence.ts`'s
    `candidate_commit_share` now correctly omits rather than synthesizes a
    denominator; `assertLinkedInAuth` runs on every navigation) — verified
    directly again this review by reading the code, not just trusting the
    commit message. The audit docs describing the old bugs (`assessment-rubric-architecture-audit.md`,
    `tsearch-playwright-system-audit.md`) still don't reflect the fixes —
    doc drift, low severity, safe direction.
  - Two Playwright-audit items remain open: zero retry/trace/screenshot
    capture on LinkedIn scrape failures; `expected_country` still only
    boosts match confidence rather than hard-filtering homonyms.
  - Digest loop: Phase 3 (feedback capture) fully wired (`feedbackStore.ts`,
    `/api/feedback*`, Relevant/Not-relevant/Explore-network UI); Phase 4 is
    a basic filter/boost, not full weight-learning. Open product questions
    (global vs. per-seed digest surfacing, Substack-only filtering)
    unresolved.
  - No fail-closed CI enforcement — `.github/workflows/ci.yml` still runs
    only typecheck + tests, no forbidden-API/PII checker comparable to
    jobright's `check:forbidden`. A future change could silently violate the
    frozen-snapshot or `final_score`/`priority_score` separation invariants
    with nothing to catch it.
  - Low, doc-only staleness: `docs/system-brief.md` (generated, due a
    refresh) and `docs/tsearch-reuse-map.md` (still describes a
    dropped-by-decision Phase-10 LinkedIn-enrichment port).
- **Zero open issues, zero open PRs**, reconfirmed this review directly via
  the GitHub API.

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
data reachable in git history — and the two are now diverging in which one
is more urgent for a different reason each.** tSearch's exposure is real
third parties' LinkedIn data on a repo anyone can clone *today*, unpurged
for sixteen reviews — the higher-urgency exposure on current blast radius.
jobright's exposure is currently the operator's own data on a private repo —
smaller blast radius today — but it is growing 25%+ every few days with no
fix in sight, and §1.1's college-launch plan gives it a dated reason to
become a third-party-PII incident within weeks if shipped before the four
root causes are fixed. **Recommendation unchanged in shape across every
review that has made it: both purges are still unexecuted, and jobright's
now has a deadline tSearch's does not.**

One document remains stale on the reuse-plan point: `docs/tsearch-reuse-map.md`
still describes porting `linkedinExtract.ts` "in Phase 10," contradicted by
jobright's own `known-limitations.md` recording that LinkedIn enrichment was
dropped by decision for the MVP. Low severity, unchanged since 08-07.

**Both repos have also now converged on the same operating-posture pattern:
a scheduled, unattended automation loop with real consequences if its gates
ever fail** — jobright's `auto:cycle` (real ATS submissions, hourly, no
per-run human click once the standing `.env`/task exist — §1.2/§1.3) and
tSearch's autopilot chain (sweep → resolve → discovery → assessment → digest
→ send, fail-closed to mock LLM / dry-run send by default). tSearch's is the
safer default configuration today, but the *shape* of risk — a scheduled
task silently doing something consequential if a gate regresses — is now
identical across both repos and worth a shared review, not two separate
ones.

---

## 4. Risk triage

Severity reflects blast radius and reversibility, not effort to fix.

| Severity | Repo | Risk | Why it matters |
| --- | --- | --- | --- |
| **Critical** | Meta (both) | **This document has now been drafted at least sixteen times since 2026-08-07 and has never once been merged to `main`/`master` in either repo.** Every review — including this one — pushes to a fresh, single-use branch name and ends. Real, worsening, independently-verified findings (a resume-PII leak that has grown 41x in a month; a PII exposure unpurged for sixteen straight checks; a security loosening unaddressed for four cycles) exist only on throwaway branches nobody has looked at. | A review process with no merge path doesn't reduce risk, it just documents it privately and repeatedly. Escalated from "Medium" in the 15th review to "Critical" this review because the compounding cost is now concrete: the PDF leak literally would not have hit 7,522 files if review #1's finding had reached a human who could fix the four root causes. Recommendation: an operator needs to either merge one of these branches, or fix the reason none of the sixteen previous attempts did (no CI to auto-open a PR? no notification reaching a human with merge rights? something else) — this review cannot diagnose which from inside the sandbox. |
| **Critical** | tSearch | `profiles/`/`backup/` real-people LinkedIn PII is untracked from the current tree but still fully present and fetchable in git history **on this public repo** — reconfirmed directly this review, sixteenth review in a row, no purge attempted. | The one PII exposure between the two repos that is currently world-readable by anyone who clones the repo, right now, with zero prerequisite access. |
| **High → trending toward Critical** | jobright | 7,522 tracked resume-PDF paths (480 real, up from 6,025/435 four days ago — the fastest four-day growth rate this document has recorded), plus operator contact info in log artifacts, all still tracked in git history on a now-private repo. All four root causes reconfirmed unchanged; no purge attempted in sixteen cycles. A dated college-launch plan (§1.1/§1.3) would extend this exact pipeline to real student resume uploads within weeks if shipped as-is. | Still "only" High on today's blast radius (private repo, operator's own data) — but that mitigating fact does not survive contact with the launch plan, and the growth rate means "today's blast radius" is a moving target that gets worse every few days regardless of the launch question. |
| **High** | jobright | The "operator confirmation" authorization model for real submissions has moved from per-submission human confirmation to a standing, scheduled, self-arming `auto:cycle` task (§1.2) — no per-run human click once installed, running hourly, with a real (if capped) submit budget. Every underlying gate is intact; the *authorization posture* is what changed. No operator has confirmed this matches intent across five review cycles. | This is exactly the kind of drift that's easy to miss because no individual gate was weakened — worth a direct, on-the-record operator decision rather than continuing to run on an assumption. |
| **High** | jobright | Sender-trust magic-link handling (`extractMagicLink`) accepts any HTTPS link with a verification-shaped keyword and zero sender-domain requirement, and the nav-agent sidecar navigates there using the operator's authenticated session. Four cycles unaddressed. | A genuine, code-verified phishing-surface widening, not a hypothetical — easy to have been missed under "improves magic-link handling" framing when it shipped. |
| **High** | jobright | `docs/current-state-and-phase56.md` still contradicts the repo's own `README.md` and its own committed submit evidence. Unchanged since the 14th review despite being a same-day doc fix. | An operator or future agent trusting this specific file would materially misjudge what's actually proven. |
| **High** | jobright | Submit velocity (≥9 real submits across 4 ATS platforms) continues to outpace independently-verified gate confirmation — five consecutive reviews unable to re-run the gate directly; every recent fix commit's "tests green" claim is self-reported only. | The inverse failure mode — a false-success or silent wrong-field submit — would currently only be caught by a human checking the target site or inbox directly, on a system now submitting real applications on an hourly unattended schedule. |
| **Medium** | jobright | `master`'s disjoint-root history rewrite is explained (root = a prior session's own branch tip, consistent with an environment squash mechanism) but not resolved: pre-rewrite branches are now orphaned, independently-reachable copies of the older leak still sitting on GitHub. | Not evidence of tampering, but more independently-reachable copies of leaked data than before, not fewer. |
| **Medium** | jobright | Lever and Workable remain the two ATS adapters with no live-DOM evidence (of six wired). | Live-proof backlog narrowed earlier in the project's history but hasn't closed further recently. |
| **Medium** | tSearch | No fail-closed CI enforcement — `.github/workflows/ci.yml` still typecheck + tests only, no equivalent of jobright's `check:forbidden`. Unchanged since first flagged 08-11. | A future change could silently violate the frozen-snapshot or score-separation invariants with nothing mechanical to catch it. |
| **Medium** | tSearch | Zero retry/trace/screenshot capture on LinkedIn scrape failures; `expected_country` still never used to hard-reject homonym mismatches. Unchanged. | Wrong-person matches can still silently enter the candidate graph; live failures stay hard to diagnose after the fact. |
| **Low** | tSearch | `docs/system-brief.md` and the two audit docs are stale relative to fixes already shipped (safe direction — describing bugs that are now fixed, not hiding live ones). | Doc drift undermines trust in the others even when the drift itself is safe. |
| **Low** | tSearch | Digest ranking sort-order refinement is built; true weight-learning from feedback is not. Global-vs-per-seed and Substack-only-filtering product questions remain unresolved. | Not a defect — tracked so it doesn't silently drop off the roadmap. |
| **Low** | jobright | `docs/tsearch-reuse-map.md` still describes a dropped-by-decision Phase-10 LinkedIn-enrichment port. Unchanged since 08-07. | Doc drift; low cost either way. |

---

## 5. Amendments worth considering (external scan)

**jobright-application-agent / Dispatch**

- **A path/size-based pre-commit block, via Lefthook or a plain `.githooks`
  script** — carried forward from the last three reviews, now the single
  most time-sensitive external suggestion in either repo given §1.1/§4:
  reject any staged path under `artifacts/**/materials/`, or any PDF over a
  trivial size threshold in that tree, at commit time. This alone would have
  stopped the leak at file #1 rather than file #7,522.
  https://github.com/evilmartians/lefthook
- **Gitleaks** — as continuous defense-in-depth alongside, not instead of,
  fixing the four root causes: pre-commit hook + GitHub Action would catch
  this class of leak regardless of the custom checker's own gap.
  https://github.com/gitleaks/gitleaks
- **Migrate off the Supabase `anon`/`service_role` key-pair naming** before
  Supabase's stated end-of-2026 deprecation in favor of
  `sb_publishable_*`/`sb_secret_*` — the usage itself is already correct
  (server-only, RLS everywhere), this is a forward-looking rename/rotation
  item. https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys
- **`ShantanuVr/playwright-self-healing-framework`** — zero-LLM, zero-API-key
  locator healing targeting the same DOM-drift failure class as the
  project's open Cloudflare conditional-form bug, without adding a second
  nondeterministic call into a determinism-first codebase.
  https://github.com/ShantanuVr/playwright-self-healing-framework

**tSearch**

- **`git filter-repo`/BFG history purge, executed, not just planned** —
  repeated for the sixteenth review in a row. Pair with GitHub push
  protection using a custom secret-scanning pattern matching the scraped-profile
  JSON shape (name + LinkedIn URL + photo URL) as recurrence prevention.
- **`joaquinhuigomez/llm-judge-calibrator`** — position-swap evaluation,
  Cohen's Kappa, position/verbosity/self-preference bias rates, directly
  runnable against the six existing rubric judges, none of which carry a
  measured inter-rater-agreement number today.
  https://github.com/joaquinhuigomez/llm-judge-calibrator
- **Reuse jobright's now-demonstrated Supabase RLS pattern** (§1.2) as the
  reference once tSearch's own deny-all scaffold gets wired to a live
  dual-write, rather than re-deriving the policy shape from scratch.

---

## Changelog

- **2026-09-07** — 16th+ attempt. Re-derived every headline figure directly
  against current `HEAD` in both repos rather than carrying over the 15th
  review's text. jobright: resume-PDF leak now 7,522 tracked paths (480
  real, up from 6,025/435 four days ago) — fastest four-day growth yet
  recorded; a fourth real-content PDF size variant appeared (20 files at
  113,810 bytes); all four root causes reconfirmed unchanged via direct file
  read (`.gitignore` still comments out `artifacts/`, no pre-commit hook
  installed); repo visibility reconfirmed private. Read the L3/`auto:cycle`
  authorization code directly (`armSession.ts`, `autoCycle.ts`,
  `submitRun.ts`) and the sender-trust parser directly
  (`verificationParsers.ts:extractMagicLink`) rather than relying on prior
  reviews' description — both risks confirmed still present, unchanged in
  mechanism. Confirmed UKG Pro adapter present via direct source read (six
  ATS families now wired). tSearch: reconfirmed zero commits, now 14 days of
  inactivity (a52881b, 2026-08-24); reconfirmed the ownership-share and
  mid-run-auth fixes by reading the current code, not just trusting past
  reviews; reconfirmed the PII-history exposure unpurged via a direct
  `git log --diff-filter=A` check, sixteenth review in a row. Both repos:
  zero open issues, zero open PRs, confirmed live via the GitHub API.
  **Elevated the meta-risk (this document's own sixteen-review non-merge
  streak) from Medium to Critical**, on the reasoning that the compounding
  cost is no longer abstract — the PDF leak's 41x growth since first found
  is a direct consequence of sixteen consecutive findings not reaching
  anyone who could act on them. Sent an operator push notification given
  the elevated meta-risk and the continued, accelerating PII growth.
- **2026-09-03 and earlier (2nd–15th reviews)** — See prior branch history
  (`claude/epic-pasteur-*` / `claude/busy-clarke-*`, none merged) for the
  full incremental record: PII-history exposure found and reconfirmed
  unpurged on every cycle since 08-07; ownership-share and mid-run-auth
  fixes landed and verified 08-10/11; jobright's resume-PDF leak first found
  08-11 (183 paths), reconfirmed worse on every subsequent review (574 by
  08-27, 4,086 by 08-31, 5,128 by 09-01, 6,025 by 09-03); a large jobright
  feature wave (ATS discovery, Lever/Ashby/Workday/Workable/UKG adapters,
  Stagehand engine spike, console redesign, public-app/Supabase/referral
  wave, ≥9 real ATS submits across 4 platforms) landed 08-09 through 09-03;
  a large tSearch feature wave (autonomy/oracle package, digest feedback
  capture, youth wildcards, corroborated-GitHub, Supabase scaffold, website
  graph) landed 08-10 through 08-24, then went quiet.
- **2026-08-07** — Initial creation. Full read of both repos' docs trees,
  git history, and current GitHub issue/PR state. Verified the critical
  PII/public-repo finding directly rather than relying solely on subagent
  report.
