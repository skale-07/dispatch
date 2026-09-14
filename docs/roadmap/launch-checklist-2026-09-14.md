# Launch checklist — what is still needed to put Dispatch in front of users

Written 2026-09-14 after M23 (resume → cards) landed. This is the
operator's ordered to-do list from "the code is ready" to "a stranger
can sign up, onboard, and get an application submitted". Everything
here is an ACCOUNT, a KEY, or a DECISION — nothing on this list is code
the agent can write for you. `deploy/first-deploy.md` has the click-by-
click for each account; this page says what is missing and in what
order, with the check that proves each step.

Legend: **[blocks signup]** nobody can use the product without it ·
**[blocks applying]** signup works but no application goes out ·
**[before strangers]** fine for you and friends, needed before a public
link · **[optional]** later.

## 0. Already done (do not redo)

- Supabase project exists, all 66 schema objects applied and verified
  (`cloud:schema apply/verify`, 2026-09-14).
- Engine `.env` has `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` and the
  Gmail OAuth client id + secret.
- Frontend builds clean (`npm run build` in `frontend/`), CSP in
  `frontend/vercel.json` already lists Supabase, Google consent and the
  Browserbase live-view origin.

## 1. Supabase auth + email **[blocks signup]** (~20 min)

1. Authentication → Providers → **Email**: enable magic link / OTP.
2. Authentication → Providers → **Google**: needs a Google OAuth *Web*
   client (SIGN-IN client, separate from the Gmail-drafts one) whose
   redirect is `https://<ref>.supabase.co/auth/v1/callback`.
3. Authentication → **URL Configuration**: Site URL = the production
   origin; Redirect URLs = `https://<domain>/**`, `http://localhost:5173/**`,
   the Vercel preview pattern.
4. Authentication → **SMTP** **[before strangers]**: the built-in mailer
   is rate-limited to a few emails/hour. Point it at Resend (the engine
   already has `RESEND_API_KEY`) with `no-reply@<domain>` and verified
   DNS; raise Rate Limits → emails sent.

Check: open the deployed site in a private window, sign up with a
throwaway address, receive the link within a minute, land on
`/onboarding`.

## 2. Domain + Vercel **[blocks signup]** (~20 min + DNS wait)

1. Buy the domain (only cash item in v0).
2. Vercel → New Project → root `frontend/`, preset Vite, build
   `npm run build`, output `dist/`.
3. Environment variables (production AND preview):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable key only),
   `VITE_PUBLIC_URL=https://<domain>`,
   `VITE_LIVE_VIEW_ORIGIN=https://www.browserbase.com`.
   (`VITE_GMAIL_OAUTH_CLIENT_ID` only if the OAuth fallback in step 3 is
   used; unset, the Gmail card refuses by name until the CDP path lands.)
   Never `VITE_CONSOLE_ENABLED` on a public deploy.
4. Domains → add, follow the DNS records.
5. Engine `.env`: `CLOUD_BASE_URL=https://<domain>`.

Check: `https://<domain>` renders; `/onboarding` deep link rewrites to
the SPA (no 404); the waitlist form writes a row.

## 3. Gmail for hosted users — in the remote Chrome, not OAuth **[blocks outreach only]**

Decision 2026-09-14 (operator): the product's whole simplicity is ONE
Chrome the engine drives over CDP, where the user logs into JobRight and
Gmail themselves. For a hosted user that Chrome is their Browserbase
session (step 4). So Gmail follows the same rule as JobRight: the user
logs into Gmail in the live view, the engine drafts over CDP exactly as
it does on the operator's port-9223 Chrome, drafts only. No Google Cloud
project, no OAuth consent screen, no restricted-scope verification.

Built 2026-09-14 (UNIT_CONFIRMED, M25): the `gmail_connect` /
`gmail_reconnect` handoff is provisioned and captured exactly like
JobRight's (integrations step card, live view, "I'm signed in"); the
session is sealed as `gmail.storage` and unsealed for each tenant run,
whose child then drafts and reads verification codes through the user's
own mailbox headless (the Gmail flags pass through from the ceiling only
when that session exists). One persisted Browserbase context per tenant
keeps both sign-ins across handoffs.

What remains is proof, not code:

1. The first hosted Gmail sign-in in the live view: Google sometimes refuses
   sign-in inside an automated or datacenter browser ("this browser may
   not be secure"). Browserbase persistent contexts usually pass; if not,
   fall back to the OAuth path below for Gmail only.
2. Read-back: a tenant run's `child.log` shows "gmail tail in the
   tenant's own sealed Gmail session" and a draft with the submitted
   resume attached appears in the user's Drafts; nothing sent.

**Optional fallback — Google OAuth client** (the plan's earlier M19
path; the client id + secret are already in the engine `.env`): Gmail API
enabled, consent screen in *Testing* with you as a test user, authorized
origins/redirects for `<domain>/gmail/callback`, and — before strangers
— the restricted-scope verification / CASA process (weeks). Only if the
CDP sign-in is blocked.

## 4. Browserbase **[blocks applying]** (~15 min)

1. browserbase.com → project → API key + project id into the engine
   `.env`: `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`,
   `REMOTE_BROWSER_ENABLED=true`.
2. `npm run remote:probe` — the spike in
   `docs/roadmap/browserbase-spike-2026-09-14.md` says what a pass looks
   like (a session, a live-view URL, a JobRight page title read back).

Check: the JobRight connect step embeds the live view (CSP frame-src
already allows it) and a `jobright_connect` handoff completes.

## 5. Engine host on AWS **[blocks applying]** (~45 min, decision 2026-09-14)

The engine leaves the operator's Windows box: one EC2 box on the AWS
credit runs the scheduler container (`deploy/engine.Dockerfile`), with
the runbook in `deploy/aws/README.md`.

1. Fresh AWS access keys on this machine (`aws sts get-caller-identity`
   failed with a signature mismatch on 2026-09-14).
2. `deploy/aws/.env.engine` (gitignored): the hosted env — `TENANT_ENGINE_ENABLED=true`,
   Supabase URL + service key, `TENANT_MASTER_KEY=$(openssl rand -hex 32)`,
   Browserbase keys + `REMOTE_BROWSER_ENABLED=true`, `CLOUD_BASE_URL`, the
   LLM key, and the same fail-closed flags as locally; no `AGENT_CDP_URL`.
3. `deploy/aws/deploy.sh bootstrap && deploy/aws/deploy.sh push && deploy/aws/deploy.sh stack`,
   then `deploy/aws/deploy.sh logs`.

Check: the log shows the scheduler's first tick; `tenant:status` rows
appear under `/data/dispatch/tenants` on the box. Before the box exists,
the same flags in the local `.env` still run the scheduler here.

## 6. Tenant-zero soak **[blocks applying]** (one evening)

`docs/roadmap/tenant-zero-soak-2026-09-14.md`, in order. You are the
first hosted user: sign up on the real site, onboard (use **Fill from
resume** at step 4 — this is the M23 acceptance test: one card per role,
edit one, continue), upload the resume at step 5, connect JobRight
through Browserbase, then `tenant:materialize` → `tenant:run` and read
back one submitted application in the dashboard.

Known hazards the soak will meet first (from the runbook): the handoff
upsert partial-index (`tenant-handoff` test pins it), Workday rows on a
cold tenant workspace (M23 now maps them; first live proof is this
soak), and a `gmail_reconnect` after 7 days while the consent screen is
in Testing.

## 7. Before a public link **[before strangers]**

- Custom SMTP (step 1.4); the Google verification only if the OAuth
  fallback in step 3 turned out to be needed.
- Quota: `user_quota_status` shows `remaining = 5` on a fresh account
  (open signup, 5 free — decision 2026-09-11).
- A privacy line on the landing page that says what the engine stores
  (profile, resume, application statuses; self-ID encrypted and opt-in;
  Gmail drafts-only). Text only; no code.
- Rotate the Supabase secret key if it was ever pasted anywhere but the
  engine `.env`.
- Turn off `ARTIFACT_AUTOPUSH_ENABLED` for tenant runs (tenant artifacts
  must not be pushed to the public repo; `childEnv.ts` already forces it
  off — verify in a tenant run log).

## 8. Optional / later **[optional]**

- Hosted resume parsing by Dispatch's own model (a Supabase Edge
  Function holding an API key behind a flag). M23 ships two zero-cost
  paths instead — the user's own assistant with the resume text
  pre-filled into the prompt, and the on-device reader — and both keep
  the review-first rule. Add the hosted path only if users without an
  assistant show up in feedback.
- Fly.io console image (`deploy/first-deploy.md` Part C) — internal ops
  only; not needed for users.
- Analytics: the dashboard reads `application_status_mirror`; a product
  analytics tool is a later decision.
