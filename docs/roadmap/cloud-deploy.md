# Cloud deployment roadmap — split-plane architecture

Status: PLANNED (v0 targets the September recruiting rush).
Owner: operator. Engine plane invariants in this document defer to
`CLAUDE.md` house rules — nothing here weakens a fail-closed flag.

## The one architectural decision (approved)

**Split-plane.** The engine plane (this repo as it runs today —
Playwright, the operator's debug Chrome, `private/` PII, the SQLite
source of truth in `data/`) stays on the operator's machine. The cloud
plane is additive: a marketing/waitlist frontend, Supabase (Postgres)
holding **users, invites, quotas, and a one-way status mirror**, and —
only in v1 — per-user containerized engines.

```
┌────────────────────── CLOUD PLANE ──────────────────────┐
│  operator domain (Vercel Hobby, free)                   │
│    v0:   marketing site + waitlist + invite redemption  │
│    v0.5: read-only console mirror (reads Supabase       │
│          directly with anon key + RLS — no API server)  │
│                                                         │
│  Supabase (free tier + $300 YC credit)                  │
│    auth.users · app_users · invites ·                   │
│    application_status_mirror (status strings only)      │
└──────────────▲──────────────────────────────────────────┘
               │ one-way upserts, service-role key,
               │ SUPABASE_SYNC_ENABLED (fail-closed)
┌──────────────┴────────────── ENGINE PLANE ──────────────┐
│  operator machine (today) / per-user AWS container (v1) │
│  Playwright + debug Chrome · SQLite (data/) · private/  │
│  ALL PII, resumes, portal credentials, sensitive        │
│  profile, LLM keys — never leaves this plane in v0/v0.5 │
└─────────────────────────────────────────────────────────┘
```

**Data-flow rule (non-negotiable through v0.5):** nothing crosses from
engine → cloud except rows of the shape
`(engine_application_id, company, role, state, route, source_ats, timestamps)`
plus invite/user bookkeeping. No candidate PII, no resumes, no answers,
no ATS credentials, no artifacts, no screenshots. The sync worker is a
mirror of already-aggregate console read models, filtered further.

## Cost posture (per coordinator directive 2026-09-01)

v0 cash cost target: **the domain only (~$10/yr)**. Everything else
rides free tiers plus the operator's YC Startup School credits:

| Credit | Amount | Use |
| --- | --- | --- |
| Supabase | $300 / 12 mo | v0–v0.5 entirely (free tier likely suffices; credits are headroom) |
| AWS | $10,000 | **RESERVED for v1** per-user containerized engines. Do not spend on v0/v0.5. |
| Anthropic | $500 | Pipeline LLM calls (screeners, essays, nav sidecar) — not infra |
| OpenAI | $1,000 | Same — fallback provider spend |
| Langfuse (optional) | $100/mo × 6 | Optional LLM observability once multiple users generate LLM traffic |

v0 hosting: **Vercel Hobby (free)**. Note Vercel Hobby is licensed for
non-commercial/hobby use — fine for an invite-only test cohort; revisit
(Vercel Pro $20/mo or Fly.io) if this becomes commercial before v1.

---

## Phase v0 — marketing site + waitlist + invite links (days, not weeks)

Goal: a public page on the operator's domain where a visitor can join a
waitlist, and an invited tester can redeem an invite code, creating a
cloud account with a quota. **No engine capacity is exposed yet** — v0
test users ride operator-provisioned engine runs; the cloud account is
identity + quota + (from v0.5) a status page.

### Hosting recommendation: Vercel (Hobby), with reasoning

- The frontend is a Vite/React SPA (`frontend/` builds with
  `npm run frontend:build`); Vercel serves static Vite output natively
  with zero servers to operate, free SSL, and one-click custom domain.
- v0 needs **no backend of our own**: waitlist insert and invite
  redemption both go straight to Supabase (anon key + RLS + a
  `security definer` RPC — see `supabase/migrations/`). A platform with
  long-running servers (Fly, Render) buys nothing yet.
- Alternative considered — **Fly.io**: better once we want the console
  server itself hosted (long-running Node process, Dockerfile in
  `deploy/` already works for it). Chosen for v1 engine experiments or
  a hosted API if v0.5's direct-to-Supabase reads ever prove
  insufficient; overkill for a static site.

### v0 scope

1. Marketing/waitlist page (frontend agent owns `frontend/**`; the
   redemption API contract is below).
2. Supabase project with `supabase/migrations/` applied: `app_users`,
   `invites`, `waitlist`, `application_status_mirror`, RLS.
3. Invite minting on the engine machine:
   `npm run invites:mint -- --count N --quota M --base-url https://<domain>`
   generates codes + shareable links, stores them in local SQLite, and
   emits SQL/CSV under `private/cloud/invites/` to paste into Supabase
   until keys exist (then the same CLI can be re-run with keys to push
   directly — v0.5).
4. Redemption flow (stub page contract): visitor signs up via Supabase
   Auth (email OTP/magic link), then calls the `redeem_invite` RPC.

### Frontend redemption contract (for the frontend agent)

All calls are `@supabase/supabase-js` against the operator's Supabase
project with the **anon key** (safe to ship in the bundle; RLS is the
guard). No custom API server exists in v0.

```ts
// 1. Waitlist (no auth required; insert-only policy)
await supabase.from("waitlist").insert({ email });

// 2. Sign-up / sign-in (Supabase Auth, email OTP or magic link)
await supabase.auth.signInWithOtp({ email });

// 3. Redeem an invite (after auth). Atomic, once-only, server-side.
const { data, error } = await supabase.rpc("redeem_invite", {
  invite_code: codeFromUrl, // e.g. /redeem?code=JRA-XXXX-XXXX
});
// data: { invite_id: string; max_completed_applications: number }
// error.message on failure is one of:
//   "invalid invite code" | "invite already redeemed" | "not authenticated"

// 4. Own profile + quota (RLS: only your rows)
const { data: me } = await supabase.from("app_users").select("*").single();
const { data: quota } = await supabase
  .from("user_quota_status")           // view: used vs max
  .select("*").single();

// 5. (v0.5) Own application statuses, newest first
const { data: apps } = await supabase
  .from("application_status_mirror")
  .select("engine_application_id, company, role, state, route, source_ats, engine_updated_at")
  .order("engine_updated_at", { ascending: false });
```

Invite link shape minted by the CLI: `<base-url>/redeem?code=<CODE>`,
code format `JRA-` + 2×4 crockford-base32 groups (e.g.
`JRA-7K2M-9QXF`), unambiguous and phone-dictatable.

**Quota semantics:** an invite's `max_completed_applications`
(default 5, minted range 5–10) counts **applications that reach state
`COMPLETED`** for the redeeming user, as reflected in
`application_status_mirror`. The `user_quota_status` view computes
used/remaining; enforcement in v0 is operational (the operator stops
running that user's queue at quota), becomes automatic in v1.

## Phase v0.5 — read-only hosted console mirror (week 2)

Goal: an invited user (and the operator, from a phone) sees live-ish
application status on the domain without the engine exposing any port.

- **Engine side:** `npm run cloud:sync` (`src/cloud/syncSupabase.ts`)
  reads the same aggregate queries the local console read models use
  (`src/console/readModels.ts` discipline: SELECTs only, redacted),
  maps them through pure functions (`src/cloud/syncMapping.ts` —
  unit-tested), and **upserts** to `application_status_mirror` with the
  **service-role key, which never leaves the engine machine**. Gated by
  `SUPABASE_SYNC_ENABLED` (fail-closed, `.env.example`), refuses loudly
  without `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` +
  `SUPABASE_SYNC_USER_ID`. One-way: the worker never reads cloud state
  into the engine, and cloud rows never influence the pipeline.
- **Cloud side:** the hosted frontend reads
  `application_status_mirror` directly with the anon key; RLS restricts
  every user to `user_id = auth.uid()`. **No hosted API server** — one
  less thing to secure, deploy, and pay for.
- Sync cadence: on-demand CLI at first; then a loop with a bounded
  interval and attempt caps (house rule: no unbounded polling) run by
  the operator alongside overnight sessions.

### The local console stays exactly as-is

`src/console/security.ts` (localhost Host-header pin + per-boot bearer
token) and the `CONSOLE_HOST` 127.0.0.1 assertion in
`src/config/env.ts` are untouched in every phase. Hosted read surface
is a *different* deployment (static frontend + Supabase), not a
re-exposed local console.

### Hosted-auth design (documented now, built only when needed)

If a hosted API server ever becomes necessary (v1 engine control
plane), the design is:

- New fail-closed flag `CONSOLE_HOSTED_MODE_ENABLED=false`. Off ⇒
  today's behavior byte-for-byte (Host pin, per-boot token, loopback
  bind assertion).
- On ⇒ the server binds `0.0.0.0`, **disables nothing**: instead of
  the per-boot token it verifies a Supabase Auth JWT (`Authorization:
  Bearer <jwt>`) against the project's JWKS on **every** request (GET
  included — hosted mode has no "reads are safe because loopback"
  assumption), maps `sub` → user, and scopes every query by user id.
  Mutation routes additionally require an operator-role claim.
- The Host-header check becomes an allowlist pinned to the deployed
  hostname (config, not code). CSRF stays impossible: bearer-only, no
  cookies.
- This is additive: local mode never gains a network listener, and
  hosted mode never learns the local per-boot token path.

## Phase v1 — per-user containerized engines (the $10k AWS credits)

Goal: each redeemed user gets their own engine container so test users
stop riding operator capacity.

- **Shape:** one container per active user session — this repo's
  engine + bundled Chromium (base: `mcr.microsoft.com/playwright` or
  `node:22-slim` + `npx playwright install --with-deps chromium`),
  per-user encrypted volume for `data/` + `private/`. Headless first;
  interactive login walls handled via a short-lived noVNC/CDP tunnel to
  the user's browser (design TBD).
- **Platform:** AWS ECS on Fargate (credits): no hosts to manage,
  per-second billing, one task definition. EC2 falls back if Fargate's
  lack of `--shm-size`/GPU quirks bite Chromium (mitigate with
  `/dev/shm` env flags Playwright already sets).
- **Secrets:** DPAPI (Windows-only) is replaced per-user by AWS KMS +
  Secrets Manager for the candidate-data key; the same fail-closed env
  flags ship as task-definition env. Per-user LLM spend is metered
  (Langfuse optional here).
- **Cost model per active user** (Fargate us-east-1, 1 vCPU + 2 GB ≈
  $0.049/hr):
  - Engine runs only during sessions: ~1–2 h/day ⇒ **$1.5–3/user/mo** compute.
  - Storage: 1–2 GB EBS/EFS per user ⇒ <$0.25/user/mo.
  - LLM: ~$0.05–0.15 per application (screener match/predict + essays,
    Haiku/mini-class models) ⇒ a 10-application quota ≈ **$1–1.50/user**
    against the Anthropic/OpenAI credits, not AWS.
  - ⇒ roughly **$3–5/user/month all-in**; $10k of AWS credits funds a
    ~100-user cohort for well over a year. Always-on engines instead
    (24/7) would be ~$36/user/mo — the session-scoped design is the
    cost model.
- Quota enforcement becomes automatic: the engine refuses to start a
  fill for a user at `max_completed_applications` (read from the
  invite row at session start — the one permitted cloud→engine read,
  added in v1 with its own flag).

## The `.env` override fix (PaaS-breaking behavior, fixed additively)

Today `src/config/env.ts` runs
`dotenv.config({ path: <repo>/.env, override: true })` — the repo
`.env` file **overwrites already-set process env**. Correct locally
(leftover PowerShell `$env:` values must not mask the switchboard), but
fatal on any PaaS/container platform, where configuration arrives *as*
process env and a stray baked-in `.env` would silently override it.

Additive fix (shipped with the sync-worker milestone): a
`DOTENV_OVERRIDE` escape hatch read from raw process env *before*
dotenv runs. Unset/`true` ⇒ today's behavior, unchanged. Hosted
deployments set `DOTENV_OVERRIDE=false` ⇒ platform-injected env always
wins and `.env` (normally absent in images anyway) only fills gaps.
`deploy/Dockerfile` sets it in the image.

## Operator inputs — blocking checklist

Nothing below can be guessed or defaulted; each unblocks the phase in
parentheses.

1. **Redeem YC Startup School credits** at deals.ycombinator.com:
   Supabase ($300/12mo), Anthropic ($500), OpenAI ($1,000), AWS
   ($10,000 — reserve for v1). Optional: Langfuse ($100/mo × 6). (v0)
2. **Create the Supabase org + project** (region near users), apply
   `supabase/migrations/`, then hand over the **project URL + anon
   key** for the frontend. The **service-role key stays on the engine
   machine only** — it goes in the engine `.env`, never in frontend
   config, never in this repo. (v0)
3. **Buy/choose the domain** and report the name — invite links bake
   the base URL (`invites:mint --base-url`). (~$10/yr, the only v0
   cash) (v0)
4. **Create a free Vercel account** (Hobby) and connect the domain. (v0)
5. AWS account with the credits applied — v1 only, no earlier spend. (v1)

## Milestone sequence in this repo

| # | Deliverable | Validation |
| --- | --- | --- |
| 1 | This roadmap | n/a (doc) |
| 2 | `supabase/` SQL migrations (users, invites, waitlist, mirror, RLS, `redeem_invite`, quota view) | applied on a fresh Supabase project by the operator; SQL reviewed |
| 3 | `invites:mint` CLI + local `cloud_invites` table + SQL/CSV export to `private/cloud/invites/` | UNIT_CONFIRMED (code gen, link building, SQL/CSV emit) |
| 4 | `src/cloud/syncSupabase.ts` behind `SUPABASE_SYNC_ENABLED` + `DOTENV_OVERRIDE` fix | UNIT_CONFIRMED (pure mapping); live sync is LIVE_MUTATION (cloud-only) once keys exist |
| 5 | `deploy/` Dockerfile + first-deploy runbook; `npm run build` (tsc → dist, no tsx at runtime) | image builds + console serves locally (docker available on this box) |
