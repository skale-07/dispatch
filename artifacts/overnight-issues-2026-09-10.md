# Night29 issues log — 2026-09-10 (operator asleep, autonomous)

Operator directives for the night (03:55 / 04:05 UTC):

1. Reset the current application queue, then start applying.
2. Prioritise Lever / Ashby / Greenhouse and similar short forms over
   Workday and other long-form apps — but still apply to the long ones.
3. Use Gmail when a verification code/link is needed; run the Gmail
   pipeline after every submission. Subagents may run that pipeline in a
   NEW Chrome CDP instance so it does not interfere with the applier.
4. "Where did you find this job": after a few retries, default to Other →
   type LinkedIn.
5. Keep the resume logic and the other existing logic.
6. Iterate the infrastructure, but never overfit to one application —
   always the general solution. The LLM agent owns what a deterministic
   system cannot decide; experiment with the deterministic/agent split for
   speed.
7. Operator is away; no questions, no prompts.

Numbering continues from night28 (last issue: #229).

---

## Start-of-night state (04:00 UTC)

- Queue reset through the state machine: 20 rows (9 QUEUED, plus parked
  AMBIGUOUS_FIELD / AUTH_REQUIRED / CAPTCHA_REQUIRED /
  SUBMISSION_VERIFICATION_FAILED and week-old strays) → FAILED_FINAL with
  reason "operator: queue reset 2026-09-10 (night29 start)".
  Script: `private/tmp-reset-queue-20260910.ts`.
- Open MANUAL review items dismissed (`review:bulk --action dismiss`).
- No node processes were left running from day28; CDP Chrome was closed.

## Issue #230 — supply: the board registry is now refreshed from public listing feeds

**Symptom.** Immediately after the reset, a sweep of the curated 47-board
registry enqueued **2** applications (Replit, Roblox). Everything else was
rejected as older than 24h (operator policy 2026-09-08). A hand-built
probe of 120 more candidate board slugs
(`private/tmp-probe-boards-20260910.ts`) found exactly **1** fresh posting:
most guesses were 404s, because a company's board token is not derivable
from its name (`greenhouse:snowflake`, `lever:netflix`, `ashby:xai` — all
404).

**Cause.** The registry was a hand-maintained list. It goes stale the
moment a company's hiring moves, and it can only ever contain boards
someone thought to add.

**Fix.** `private/tmp-refresh-boards-from-feeds.ts` reads the public
internship-tracker listing feeds (SimplifyJobs Summer2027 /
Summer2026 / New-Grad-Positions, vanshb03 mirrors —
`.github/scripts/listings.json`), keeps postings that are active, visible,
recent, role-fitting (the registry's own `role_terms` / `exclude_terms`)
and not confidently non-US, then extracts the **board token** out of every
Tier-1 apply URL it points at and merges those boards into the registry.
A board's token is unambiguous in its own apply URL, so this discovers
tokens instead of guessing them.

Nothing downstream changes: `discover:ats --registry` still applies role
terms, the US gate, the 24h policy and the per-board cap. The lookback for
*registry membership* is 168h (a board that posted yesterday will post
again today); the 24h gate on *applying* is untouched.

`MAX_BOARDS_PER_RUN` raised 50 → 150 in `src/discovery/atsDiscovery.ts`:
with 115 boards a 50-cap silently starved everything past the cut, and one
board is a single 500ms-throttled GET. The real spend limiter is
`max_new_applications`.

**Result.** 47 → 115 boards (68 added, 22 of them carrying <24h postings).
The next sweep enqueued **20** applications, every one of them
Lever/Ashby/Greenhouse — the operator's priority tier.
LIVE_READ_ONLY_CONFIRMED (real board APIs, real queue rows).
