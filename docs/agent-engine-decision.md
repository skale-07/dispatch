# Agent engine decision: browser_use vs Stagehand

Status: **SPIKE — comparison not yet run.** `browser_use` remains the
default. This document pre-registers the protocol and the promotion bar
so the decision is made by evidence gathered *after* the bar was written,
never by vibes or by whoever ran the last demo.

## What is being compared

Two navigate sidecars, one contract, one seam:

| | browser_use (incumbent) | stagehand (challenger) |
| --- | --- | --- |
| Runtime | Python (`agent/jobright_agent`) | Node (`agent/stagehand/navigate.mjs`) |
| Library | browser-use | `@browserbasehq/stagehand` (v4, DOM agent mode) |
| Browser | operator's CDP Chrome — never launches | same (Stagehand `localBrowser.connect`; `close()` detaches, never kills) |
| Contract | `src/agent/contract.ts` stdin/stdout JSON | identical — validated by the same zod schemas |
| Selection | default | `.env`: `AGENT_ENGINE=stagehand` |

Both engines face identical downstream treatment: `navigateViaSidecar`
zod-validates the result and rejects any `final_url` that is non-https,
jobright-hosted, or off the allowed domains; congruence and adapter URL
validation still run after. The engine's self-report is never trusted,
so switching engines cannot widen any trust boundary. `AGENT_ENGINE` is a
plain setting — `AGENT_FALLBACK_ENABLED` still decides whether *any*
agent runs.

Install (once, desktop): `cd agent/stagehand && npm install`. The
dependency lives in its own package on purpose — the main `package.json`
keeps its three-dependency stance. Model comes from `STAGEHAND_MODEL`
(default `anthropic/claude-sonnet-4-5`; needs the corresponding API key
in the environment). Until installed, selecting the engine fails safe:
every task returns a contract-valid error result naming the missing
install.

## Protocol (S2) — run on the desktop, attended

For EACH engine, same day, same machine, same debug Chrome profile:

1. **navhard × 10**: `npm run sandbox`, then 10 navigation runs against
   `http://localhost:4599/navhard` variants (the obstacle course), fresh
   application rows each time.
2. **fillhard wizard reach × 10**: 10 navigation runs whose goal is
   reaching the `fillhard` form page (navigation only — the fill itself is
   out of scope for this comparison).

Record per run, from the run artifacts (no manual scoring):
`resolved (bool)`, `wall`, `turns_used`, `steps_used`, wall-clock ms,
and any safety event (a submit-control click, a form answer typed, an
off-domain landing — all of which the existing gates should make
impossible; any occurrence is disqualifying, see bar).

## Promotion bar (pre-registered — must BEAT, not tie)

Stagehand becomes the default (`AGENT_ENGINE` default flipped) only if,
on the same 20-run protocol:

1. **Resolution**: strictly more resolved runs than browser_use
   (ties do NOT promote — switching costs churn; the incumbent wins ties).
2. **Safety**: zero disqualifying events across all 20 runs. One event
   ends the spike for this Stagehand version regardless of resolution.
3. **Cost**: median wall-clock per resolved run ≤ 1.25× browser_use's,
   and no run exceeding the turn budget that browser_use stays within.
4. **Honesty**: every failed run's result classifies its wall at least as
   accurately as browser_use's (spot-checked against the recorded pages).

Anything short of all four: the spike concludes "keep browser_use",
`agent/stagehand` stays as an operator-selectable alternative, and the
next revisit needs a NEW pre-registered bar (this one is spent once the
comparison runs — no re-rolling against the same data).

## Results

_To be filled by the desktop comparison run. Validation level for
everything above this line: the wiring is UNIT_CONFIRMED (contract
fail-safe + engine selection tests); the engines' relative merit is
UNVERIFIED until this section has data._

| Engine | navhard resolved /10 | fillhard reach /10 | median ms/resolved | safety events |
| --- | --- | --- | --- | --- |
| browser_use | — | — | — | — |
| stagehand | — | — | — | — |

Decision: —
