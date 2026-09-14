# Spike M16 — can a hosted user sign in to JobRight inside a browser we host?

Status: **harness built, live run UNVERIFIED** (no Browserbase account on this
box as of 2026-09-14; `REMOTE_BROWSER_ENABLED` is off). This page is the
spike's report; the second half is filled in by whoever runs it.

## The question

The hosted product (plan `curried-growing-flurry`, decision 2026-09-11) uses
each user's OWN JobRight account, with no browser extension. The engine must
therefore obtain that user's JobRight session without ever seeing their
password. The plan's answer: the engine creates a remote browser session,
the web app shows its live view, the user signs in there, and the engine
attaches to the same session over CDP to read the storageState.

Two things can defeat that:

1. **Google challenges a datacenter browser.** JobRight's usual sign-in is
   Google; Google may show "This browser or app may not be secure", a
   phone-verification wall, or refuse the login outright from a cloud IP.
2. **The captured storageState does not carry auth headlessly.** JobRight
   is a SPA; a session bound to device fingerprint or a short-lived token
   would validate in the remote browser and die in the engine's headless
   Chromium.

## The harness (built, tested offline)

- `src/browser/remoteBrowser.ts` — `RemoteBrowserProvider` seam:
  `browserbaseProvider` (sessions API v1: create with the key in
  `x-bb-api-key`, live view from `/sessions/{id}/debug`, connect URL
  `wss://connect.browserbase.com?apiKey=…&sessionId=…`, release with
  `REQUEST_RELEASE`; optional `proxies: true` for the residential pool) and
  `nullProvider` (refuses by name). `resolveRemoteBrowserProvider(config)`
  picks Browserbase only behind `REMOTE_BROWSER_ENABLED`.
- `src/auth/cdpPolicy.ts` — `assertCdpUrlAllowed`: loopback always; a
  non-loopback CDP URL only behind the flag. Called once in
  `PlaywrightServiceSession` (CDP_ATTACH) before the existing
  `connectOverCDP`; no new `chromium.*` call site exists.
- `src/browser/remoteProbeCli.ts` — `npm run remote:probe -- [--wait <sec>]`:
  create → print LIVE VIEW → wait for Enter → attach through the session
  seam → `validate()` (the same app-shell check every engine run uses) →
  premium text probe → `storageState()` to
  `private/cloud/spike/jobright.storage.json` → release. JSON report with
  per-step timings; exit 1 unless `captured`.
- `tests/unit/tenant-handoff.test.ts` — provider against a fake fetch (key
  in the header, never echoed in an error; release body), the policy, and
  the capture state machine. UNIT_CONFIRMED.

## How to run it (operator)

1. Browserbase account → API key + project id. In `.env`:
   `REMOTE_BROWSER_ENABLED=true`, `BROWSERBASE_API_KEY=…`,
   `BROWSERBASE_PROJECT_ID=…` (the config refuses to boot with the flag on
   and either missing).
2. `npm run remote:probe` — open the printed LIVE VIEW in a normal browser
   tab, sign in to JobRight there, press Enter in the terminal.
3. Read the JSON: `validated.ok` and `captured.cookies` are the evidence.
4. Headless proof: copy the captured file over a THROWAWAY workspace's
   `private/auth/jobright.storage.json` (`PRIVATE_DIR=<tmp> npm run
   auth:validate -- jobright`, or the M17 `reconnect_verify` job once a
   tenant is sealed) and confirm `AUTHENTICATED` from a headless open.
5. Repeat step 2 with `proxies: true` only if step 2 hit a Google
   challenge (flip the option in `resolveRemoteBrowserProvider` or expose
   it; note which one worked).

Record the outcomes below. The level for each line is whatever the read-back
supports — nothing here is LIVE until the JSON says so.

## Results (to be filled by the live run)

| Check | Result | Evidence |
| --- | --- | --- |
| Session created, live view renders | UNVERIFIED | `remote:probe` step `session_created` |
| Google sign-in completes inside the remote browser | UNVERIFIED | step `validated.ok` |
| Email + password sign-in completes (fallback copy) | UNVERIFIED | step `validated.ok` |
| Captured storageState opens headless as AUTHENTICATED | UNVERIFIED | `auth:validate` / `reconnect_verify` |
| Residential proxy needed? | UNVERIFIED | second run with `proxies: true` |
| Session lifetime vs. 15-minute handoff window | UNVERIFIED | `expires_at`, time to `attached` |

## Hedges, in the order the plan states them

1. Browserbase residential proxy + a persisted context (the provider keeps
   a context across sessions; a second sign-in from the same fingerprint is
   less likely to be challenged).
2. Onboarding copy recommends a JobRight **email + password** account for
   the connect step (Google-in-a-datacenter is the risky path; a first-party
   password form is not).
3. Last resort: a local one-file connector the user runs once on their own
   machine that uploads a sealed storageState through the same `secrets`
   seam (no extension, no standing software).

## Decision this spike informs

M17 (`feat(handoff)`) is built on the seam regardless of the outcome; what
changes is the onboarding copy (Google vs email sign-in) and whether
`proxies: true` is the default. M18's scheduler polls handoff tasks either
way. If every hedge fails, the local connector becomes the connect step and
the remote browser is kept for `ats_login` / `captcha` walls only.
