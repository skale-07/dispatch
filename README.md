<img src="design/logo.svg" alt="dispatch·console" width="232" height="40" />

# Dispatch

The application operator console. A local, deterministic Playwright
application processor (JobRight → ATS → gated submit → contacts/outreach
drafts) with an operator web console and operator-armed autonomy. Every
application accounted for. (Repo formerly `jobright-application-agent`;
GitHub redirects the old URLs.)

Design system: [DESIGN.md](DESIGN.md) · Coding-agent context: [AGENTS.md](AGENTS.md)

**Do not** place this repo under OneDrive. Canonical path: `C:\dev\jobright-application-agent`
(the local folder name predates the rename and is fine to keep — if you do
rename it, update the `DispatchAutoCycle` scheduled task's paths and any
`.env` absolute paths to match).

## Current state (2026-08-31)

The full chain — discovery → materials → inspect → plan → fill → essays →
**gated submit** → receipt verification → contacts → outreach drafts — runs
live end to end. Five applications have completed the whole pipeline with
verified receipts (`LIVE_MUTATION_CONFIRMED`: Neuralink, Old Mission,
DV Trading via Greenhouse; Exa via Ashby; state counts live in `data/`).

- **ATS coverage:** Greenhouse (job-boards + embeds), Ashby, Lever,
  Workable, and **Workday** (employer-portal account auth, SSO chooser
  handling, multi-page wizard walks incl. consent listboxes, date widgets,
  multiselect prompts, EEO pages) — plus a generic adapter with
  ATS-handoff detection for careers-site front doors. Unsupported families
  (USAJobs/login.gov, ByteDance portal, Phenom, iCIMS accounts…) refuse
  fail-closed with the reason recorded.
- **Autonomy:** `npm run auto:cycle` drives one job at a time
  (discover → plan → fill → submit) with per-app deadlines, attempt caps,
  a persistent per-host auth budget, and CDP-Chrome self-healing. Overnight
  sessions log to `artifacts/overnight-issues-<date>.md`; recurring failure
  patterns get progressive-overload fixtures before returning to live runs.
- **Answer integrity:** form values come only from the approved plan.
  Facts come from the operator's profile and screener bank (option answers
  verified verbatim against the page); demographic/EEO fields fill only
  from the operator's encrypted sensitive profile — nothing inferred;
  essays generate only from the operator's own about-me context and must
  pass validation. Page validation errors are read back on every failed
  verify, and resumed drafts are verified in place rather than retyped.
- **Safety:** every mutation sits behind fail-closed env flags
  (`.env.example`); submit additionally requires an approved plan entry,
  `SUBMIT_ENABLED`, and explicit operator confirmation (`--yes` in
  unattended mode). Every "it works" claim carries a validation-ladder
  level (`docs/validation-levels.md`).

**Start here:** [docs/operator-guide.md](docs/operator-guide.md) — the
end-to-end operator contract.

More: [docs/architecture.md](docs/architecture.md) ·
[docs/state-machine.md](docs/state-machine.md) ·
[docs/known-limitations.md](docs/known-limitations.md) ·
agent codebase map: [docs/knowledge-graph/](docs/knowledge-graph/)

## Quick start

```text
npm install
npx playwright install chromium
npm run migrate
npm run verify:phase5
npm run login:jobright:cdp
npm run discover -- --fixture --max-jobs 5
```

Guarded live runs copy `.env.example` → `.env` and enable flags there
(never hardcoded, never in tests). One job, end to end:

```text
npm run auto:cycle -- --no-update --headed --max-apps 1 --app-deadline 180
```

See [docs/jobright-workflow.md](docs/jobright-workflow.md).

## Verify gate

```text
npm run typecheck && npm run test && npm run check:forbidden && npm run check:secrets
```

All four must pass before every commit (house rules: `CLAUDE.md`).
