# Tenant-zero soak — the operator as the first hosted user

Status: **UNVERIFIED** (2026-09-14). Every engine milestone of plan v0.5
(M12–M21) is committed and UNIT_CONFIRMED; none has run against the live
project because `SUPABASE_SYNC_ENABLED`, `TENANT_ENGINE_ENABLED` and
`REMOTE_BROWSER_ENABLED` stay off in this tree and two prerequisites need
the operator (below). This page is the runbook for the soak and the place
its evidence goes. Levels are what the read-backs support — nothing here
is LIVE until its own line says so.

## Prerequisites (operator)

1. Apply the pending migrations, then read back:
   `npm run cloud:schema -- apply && npm run cloud:schema -- verify` →
   `complete: true` (expects `gmail_oauth_requests` among the tables and
   `submit_gmail_oauth_code` among the RPCs after `20260914000100`; the
   two `20260912*` migrations from M11 are pending too).
2. In the engine `.env`: `SUPABASE_SYNC_ENABLED=true`,
   `TENANT_ENGINE_ENABLED=true` (+ `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`), `SUPABASE_SYNC_USER_ID=<your auth uuid>`.
   For the handoff: `REMOTE_BROWSER_ENABLED=true`, `BROWSERBASE_API_KEY`,
   `BROWSERBASE_PROJECT_ID`. For Gmail: `GMAIL_OAUTH_CLIENT_ID/SECRET`
   (Web client) and `VITE_GMAIL_OAUTH_CLIENT_ID` in the frontend build.
3. Sign up in the deployed (or `npm run frontend:dev`) app with your own
   email and complete onboarding as yourself — you are tenant zero.

## The soak, in order (each step's evidence is a read-back)

| # | Command | Expect | Level when green |
| --- | --- | --- | --- |
| 1 | `npm run tenant:materialize -- --user <uuid>` then `npm run tenant:status` | files the engine's loaders accept; `sealed: []`; `stale_unsealed: []` | LIVE_READ_ONLY |
| 2 | `npm run tenant:run -- --user <uuid> --kind apply` (no sealed session yet) | `outcome: needs_jobright_connect`; a `jobright_connect` task on the dashboard; engine_status `parked` | LIVE_MUTATION (cloud rows only) |
| 3 | `npm run remote:probe` (spike M16) | `validated.ok: true`, `captured.cookies > 0` | LIVE_READ_ONLY; fill in `browserbase-spike-2026-09-14.md` |
| 4 | Dashboard → connect JobRight → sign in in the live view → "I'm signed in"; then `npm run tenant:scheduler -- --once` | task `completed`; `secrets/jobright.storage.enc` in `tenant:status`; `user_integrations.jobright = connected` | LIVE_MUTATION |
| 5 | `npm run tenant:run -- --user <uuid> --kind feed_sample` | `jobright_feed_samples` row with your titles; nothing persisted locally | LIVE_READ_ONLY (JobRight) |
| 6 | `npm run tenant:run -- --user <uuid> --kind apply --max-submits 1 --max-apps 1` with the parent `.env` at `SUBMIT_ENABLED=false` first | child refused or dry — `child.log` shows the flag ceiling; then with `SUBMIT_ENABLED=true`: one COMPLETED row mirrored, a receipt in `application_receipts`, `field_signals` populated | LIVE_MUTATION |
| 7 | Dashboard → connect Gmail → consent → callback; `npm run tenant:scheduler -- --once` | `user_integrations.gmail = connected` with the account email; `secrets/gmail.oauth.enc` sealed | LIVE_MUTATION |
| 8 | `node -e` one `createDraftViaApi` call against your own mailbox (or the outreach transport switch, follow-up) | a draft in Drafts, `verified: true`, never sent | LIVE_MUTATION |
| 9 | `npm run tenant:scheduler -- --duration 120 --interval 60` overnight | ticks in the log; one apply per 60-min cadence; `tenant:status` shows no stale plaintext at the end | soak evidence |

## Known gaps the soak will meet first

- `pushHandoffTask` upserts on `(user_id, kind)` while the unique index is
  partial (active statuses only) — PostgREST may refuse the `on_conflict`;
  the fix is an insert-if-no-active-row query. Recorded when M4's mapper
  was written; UNVERIFIED either way until step 2.
- Browserbase response shapes (`connectUrl`, `debuggerFullscreenUrl`) are
  from the public API description, not a run — step 3 settles them.
- Gmail for tenants (M25, 2026-09-14): a `gmail_connect` handoff seals
  the user's own session; the child drafts through it headless. The
  Google sign-in inside the remote browser is the UNVERIFIED step — do
  it in the soak right after the JobRight connect, and if Google refuses
  the browser, the OAuth fallback in the launch checklist §3 applies.
- Workday "My Experience" rows for a tenant are UNIT_CONFIRMED only
  (M23: wizard rows → `structuredEmploymentHistory()` entries). The soak's
  onboarding pass should use **Fill from resume** at step 4 and the first
  Workday application read back the rows; that is the LIVE proof.
  Launch order after the soak: `docs/roadmap/launch-checklist-2026-09-14.md`.

## Results

_(empty — fill in per row above, with the command output path under
`private/tenants/<uuid>/runs/`)_
