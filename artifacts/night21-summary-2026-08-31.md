# Night21 morning summary — 2026-08-30 22:00 → 2026-08-31 05:00

## Jobs attempted vs submitted

| Job | ATS | Runs | Outcome |
|---|---|---|---|
| **Exa — Software Engineer, Intern** | Ashby | 2 | ✅ **SUBMITTED** (receipt pixels: green "successfully submitted" banner; state SUBMITTED) |
| TIAA — Churchill Summer Internship IIT | Workday | ~14 (22k–23e) | Parked: draft intact (page 1 committed + resume uploaded); sign-in silently refused by mouse/JS/Enter after ~30 attempts — suspected tenant throttle (#77). Retry after cool-down. |
| Stryker — Summer 2027 Internship, Data Analytics | Workday | 2 | Parked FAILED_RETRYABLE (one field from clean when the loop moved on) |
| Stryker — Summer 2027 Internship, Electrical Eng | Workday | 11 | Parked at ONE field: block items 17 → 3 → 1; the free-text GPA textarea reads empty at submit despite keystroke entry + settle re-verify (#86–#88 each removed a real layer; suspected twin control — needs a pixels-first probe, see #88/OPEN) |
| USAJobs ×2 | federal | 2 | Abandoned with reason (login.gov flow unsupported; refusals correct) |
| Banco Popular — Data Analytics Internship | generic | 1 | Parked (email-gated portal funnel; 30s field timeouts) |

**Submitted: 1** (Exa). The night's value was capability: the Workday
pipeline went from "cannot pass page 1" to "fills 6 wizard pages, nine
compliance answers landing, one field from the click" — and every fix is
ATS-general.

## Commits (all gated: typecheck + full suite solo + forbidden + secrets)

~20 milestones, #63d–#85c. Highlights by theme:
- **Truthful evidence** (#64,#66a): create-first portal policy per your
  directive; success requires positive evidence; EVERY failed verify now
  reads the page's OWN validation errors (platform-neutral reader,
  vendor selectors via registries) — this single change decoded four
  nights of mystery failures.
- **React value-drops** (#65,#66b): blur-stability at fill; keystroke
  retype at the moment verify proves state never took.
- **Workday widget classes** (#67,#71,#85): listbox buttons, multiselect
  search widgets (chips, two-LEVEL category drill — your stored
  "LinkedIn" found verbatim as a Job Board leaf), legend-labeled
  questionnaire buttons. Plus #67a: a one-char regex boundary bug that
  had been mislabeling every multiselect on every page.
- **Cross-widget contamination** (#69,#83): popup reads/picks scope to
  the owning control; the option harvest was attributing one widget's
  chips to another field — the factory for poisoned predictions.
- **Plan sanity** (#70,#71a,#80,#85c): free-value canonicals (phone,
  gpa) never answer option controls; prediction never overwrites an
  answered select; topic fences on bank attachment.
- **Submit-leg wizard awareness** (#81,#82,#84): posting identity
  survives locale/comma/apply-suffix; cross-page answers don't
  re-verify against one page; walk-time upload is evidence.
- **Your requests, live**: skills fill from your resume (30 entries,
  option-verified per form, #73); page-error reading generalized to all
  platforms (#66a); create-before-sign-in (#64).

## Sandboxes / progressive-overload fixtures added
- `tests/fixtures/ats/workday/listbox-multiselect.html` + suite (16
  tests by night's end): live TIAA/Stryker markup one level harder —
  attr-order trap, hex decoy, preselected chips, virtualization window,
  two-level category tree, questionnaire legend buttons, overlaid
  radios, skills taxonomy.
- Obstruction suite: Workday legalNotice banner; flow-dialogs (the
  Start Your Application chooser) are never dismissed even via their X.
- Page-error reader + keystroke-retype suites (platform-neutral).

## Open items for you (⚠ = needs your input)
- ⚠ Bank: "Do you currently hold a Visa (including a student visa)?" =
  "No" — if you're on F-1 this is wrong; confirm in screeners.json.
- ⚠ how_heard fallbacks: I mapped LinkedIn → Social Media/Network → Job
  Board when a form doesn't offer "LinkedIn" (TIAA's tree had LinkedIn
  as a leaf under Job Board — used verbatim there). Veto/edit the table
  in comboboxAlternates if you want different picks.
- TIAA: retry after a multi-hour cool-down (`npm run retry -- --app
  fda27acb-…` then the pipeline run); draft is intact.
- #29 (review re-parks), #19 (Cloudflare), #55 (CDP wedge trigger)
  still open from prior nights. Sibling-session coordination note: -0d
  contributed #63e/#63f early night; division held cleanly after.
- Diagnosis-hygiene memory saved: refused runs record NO fill_runs row
  (five cycles were lost re-reading a stale row before I caught it).

Issues log: `artifacts/overnight-issues-2026-08-30.md` (#63d–#85c, night21 sections).
