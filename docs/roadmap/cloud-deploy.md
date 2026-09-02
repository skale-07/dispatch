# Cloud deployment roadmap — split-plane architecture

Status: PLANNED (v0 targets the September recruiting rush).
Owner: operator. Engine plane invariants in this document defer to
`CLAUDE.md` house rules — nothing here weakens a fail-closed flag.

## The one architectural decision (approved)

**Split-plane.** The engine plane (this repo as it runs today —
Playwright, the operator's debug Chrome, `private/` contents, the SQLite
source of truth in `data/`) stays on the operator's machine. The cloud
plane is a **real public web app** (operator direction 2026-09-01):
users visit the domain, redeem an invite (Supabase Auth magic link),
complete an onboarding wizard, and get a dashboard of their
applications, screenshot receipts, and remaining quota. Nothing
localhost-shaped ever reaches a user; the operator console remains
internal tooling.

```
┌────────────────────── CLOUD PLANE ──────────────────────┐
│  operator domain (Vercel Hobby, free) — the PUBLIC APP  │
│    marketing + waitlist + invite redemption             │
│    onboarding wizard (profile, education, work auth,    │
│      resume upload, job preferences)                    │
│    dashboard (applications · receipts · quota)          │
│    SPA → Supabase directly (anon key + RLS); no API     │
│                                                         │
│  Supabase (free tier + $300 YC credit)                  │
│    auth.users · app_users · invites · waitlist          │
│    user_profiles · application_status_mirror ·          │
│    application_receipts · storage: resumes/, receipts/  │
└───────▲──────────────────────────────┬──────────────────┘
        │ PUSH status + receipts       │ PULL onboarded
        │ (service-role key,           │ profiles/prefs
        │  SUPABASE_SYNC_ENABLED,      │ (same flag, into
        │  fail-closed)                │  private/cloud/)
┌───────┴──────────────────────────────▼────── ENGINE ────┐
│  operator machine (today) / per-user AWS container (v1) │
│  Playwright + debug Chrome · SQLite (data/) · private/  │
│  Operator console = INTERNAL tooling (loopback-only)    │
│  The OPERATOR'S private/ contents, ATS credentials,     │
│  vault entries, LLM keys — never go to the cloud        │
└─────────────────────────────────────────────────────────┘
```

**Data-flow rule (non-negotiable):** the cloud plane holds
**user-submitted** data (their own profile, resume, preferences) and
**their own application evidence** (status rows, screenshot receipts) —
that is correct and expected. What never crosses upward is the
OPERATOR'S local `private/` contents, ATS/portal credentials, vault
entries, and LLM keys. Every engine→cloud write goes through the
whitelist mappers in `src/cloud/syncMapping.ts`; every cloud table and
bucket is under RLS so a user sees only their own rows/objects.

## Cost posture (per coordinator directive 2026-09-01)

v0 cash cost target: **the domain only (~$10/yr)**. Everything else
rides free tiers plus the operator's YC Startup School credits:

| Credit | Amount | Use |
| --- | --- | --- |
| Supabase | $300 / 12 mo | v0 entirely — auth, tables, storage buckets (free tier likely suffices; credits are headroom) |
| AWS | $10,000 | **RESERVED for v1** per-user containerized engines. Do not spend on v0. |
| Anthropic | $500 | Pipeline LLM calls (screeners, essays, nav sidecar) — not infra |
| OpenAI | $1,000 | Same — fallback provider spend |
| Langfuse (optional) | $100/mo × 6 | Optional LLM observability once multiple users generate LLM traffic |

v0 hosting: **Vercel Hobby (free)**. Note Vercel Hobby is licensed for
non-commercial/hobby use — fine for an invite-only test cohort; revisit
(Vercel Pro $20/mo or Fly.io) if this becomes commercial before v1.

---

## Phase v0 — the public app (waitlist + invites + onboarding + dashboard)

Goal: a real product on the operator's domain. A visitor joins the
waitlist; an invited tester redeems a code (Supabase Auth magic link),
completes the onboarding wizard (name/contact, education, work
authorization, resume upload, job preferences), and lands on a dashboard
showing their applications, screenshot receipts, and remaining quota.
**Engine capacity is still operator-provisioned** — the engine pulls
onboarded profiles (`cloud:sync --pull`), the operator runs their queue,
and pushes status + receipts back up. The old "hosted console mirror"
idea is dead: the operator console is internal tooling only, and nothing
localhost-shaped ever reaches a user.

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
  a hosted API if the SPA's direct-to-Supabase reads ever prove
  insufficient; overkill for a static SPA.

### v0 scope

1. The public SPA (storefront agent owns `frontend/**`; the full
   Supabase contract is below): marketing + waitlist, invite redemption,
   onboarding wizard, dashboard.
2. Supabase project with `supabase/migrations/` applied: `app_users`,
   `invites`, `waitlist`, `user_profiles`, `application_status_mirror`,
   `application_receipts`, the `resumes`/`receipts` storage buckets, RLS
   throughout.
3. Invite minting on the engine machine:
   `npm run invites:mint -- --count N --quota M --base-url https://<domain>`
   generates codes + shareable links, stores them in local SQLite, and
   emits SQL/CSV under `private/cloud/invites/` to paste into Supabase
   until keys exist.
4. Engine sync, both directions behind the one fail-closed flag
   (`SUPABASE_SYNC_ENABLED`): `npm run cloud:sync` pushes status +
   screenshot receipts; `--pull` brings onboarded users' profiles and
   preferences down into `private/cloud/users/` for operator-run engine
   sessions.

### Frontend ⇄ Supabase contract (for the storefront agent)

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

// 4. Own account + quota (RLS: only your rows)
const { data: me } = await supabase.from("app_users").select("*").single();
const { data: quota } = await supabase
  .from("user_quota_status")           // view: used vs max
  .select("*").single();

// 5. Onboarding wizard — one user_profiles row, upsert as steps complete.
//    Columns (see supabase/migrations/20260902000100_user_profiles.sql):
//    full_name, phone, location_city/region/country, linkedin_url,
//    github_url, portfolio_url, work_authorization ('us_citizen' |
//    'permanent_resident' | 'visa_holder' | 'needs_sponsorship' |
//    'other'), needs_sponsorship, education (jsonb array of
//    {school, degree, field, start_year, end_year, gpa?}),
//    job_preferences (jsonb {titles[], locations[], remote:
//    'remote'|'hybrid'|'onsite'|'any', employment_types[],
//    min_salary_usd?}), resume_object_path/filename/uploaded_at,
//    onboarding_completed_at (set by the FINAL step — the engine ignores
//    profiles until it is non-null).
await supabase.from("user_profiles").upsert({
  user_id: session.user.id, full_name, phone, /* ...step fields */
});

// 6. Resume upload — private `resumes` bucket, path MUST start with the
//    user's own uid (storage RLS enforces it), then record it:
const objectPath = `${session.user.id}/${file.name}`;
await supabase.storage.from("resumes").upload(objectPath, file, { upsert: true });
await supabase.from("user_profiles").upsert({
  user_id: session.user.id,
  resume_object_path: objectPath,
  resume_filename: file.name,
  resume_uploaded_at: new Date().toISOString(),
});

// 7. Dashboard — own applications with the latest receipt attached
//    (my_applications view: id, company, role, status, route, source_ats,
//     engine_updated_at, submitted_at, receipt_path)
const { data: apps } = await supabase
  .from("my_applications")
  .select("*")
  .order("engine_updated_at", { ascending: false });

// 8. Dashboard — screenshot receipts (rows + signed image URLs).
//    Receipts are engine-written; users are read-only by design.
const { data: receipts } = await supabase
  .from("application_receipts")
  .select("engine_application_id, submission_attempt, object_path, submitted_at, confirmation_url, application_identifier")
  .order("created_at", { ascending: false });
const { data: signed } = await supabase.storage
  .from("receipts")
  .createSignedUrl(receipts[0].object_path, 3600);
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

## The engine sync — two-way, one flag, whitelisted both directions

`npm run cloud:sync` (`src/cloud/syncSupabase.ts`), gated by
`SUPABASE_SYNC_ENABLED` (fail-closed, `.env.example`), refusing loudly
without `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` +
`SUPABASE_SYNC_USER_ID`. The service-role key never leaves the engine
machine.

- **PUSH status:** the same aggregate queries the local console read
  models use (`src/console/readModels.ts` discipline: SELECTs only),
  mapped through pure, unit-tested whitelist functions
  (`MIRROR_COLUMNS` in `src/cloud/syncMapping.ts`), upserted in bounded
  batches to `application_status_mirror`.
- **PUSH receipts:** each submitted application's screenshot + metadata
  (attempt, confirmation URL, application identifier) — the user's own
  evidence — uploaded to the private `receipts` bucket at
  `{uid}/{app}/attempt-N.png` and upserted into `application_receipts`.
  Idempotent; missing files are counted and skipped, never fatal.
- **PULL profiles (`--pull`):** onboarded users' wizard data
  (`onboarding_completed_at` non-null only — half-finished onboarding is
  never acted on) joined to invite quota, snapshotted into
  `private/cloud/users/onboarded-<ts>.json`. User PII lives under
  `private/` on the engine, never `artifacts/`. Cloud rows never
  mutate engine pipeline state directly — the operator runs sessions
  from the snapshot.
- Cadence: on-demand CLI; any future loop gets a bounded interval and
  attempt caps (house rule: no unbounded polling).

### The operator console is internal tooling — repositioned explicitly

The console (`npm run console`) is for the OPERATOR only. Its security
model (`src/console/security.ts` localhost Host-header pin + per-boot
bearer token, `CONSOLE_HOST` 127.0.0.1 assertion in
`src/config/env.ts`) is untouched in every phase, and no user-facing
surface is ever built on it. Users get the public SPA + Supabase under
RLS; nothing localhost-shaped reaches them.

### Hosted-auth design (BUILT 2026-09-02 — `src/console/hostedAuth.ts`)

- Fail-closed flag `CONSOLE_HOSTED_MODE_ENABLED=false`. Off ⇒ today's
  behavior byte-for-byte (Host pin, per-boot token, loopback bind
  assertion) — `src/console/security.ts` is untouched and the local
  handler path in `server.ts` is unchanged.
- On ⇒ the server may bind `0.0.0.0` and a SEPARATE handler path
  (`handleHosted`) runs: the Host header must match
  `CONSOLE_HOSTED_ALLOWED_HOSTS` (config, not code); every `/api`
  request (GET included — no "reads are safe because loopback"
  assumption) must carry a Supabase Auth JWT verified against the
  project JWKS (ES256/RS256 via `node:crypto`, no dependency; issuer
  `<SUPABASE_URL>/auth/v1`, audience `authenticated`, `exp` with 30 s
  leeway; JWKS cached 10 min with a rate-limited refetch on unknown
  `kid`), and its `sub` must be in `CONSOLE_HOSTED_ALLOWED_USER_IDS`
  (the engine DB is single-tenant: the operator's own cloud account).
- v0 hosted console is **read-only**: every `POST /api` is refused
  (403) regardless of credential. An operator-role claim for hosted
  mutations is a later, separate milestone.
- CSRF stays impossible: bearer-only, no cookies. The static bundle is
  public (a navigation cannot attach a bearer; it holds no data).
- Boot is fail-closed: `loadConfig` refuses when the flag is on
  without `SUPABASE_URL` + both allowlists.
- Validation: UNIT_CONFIRMED (`tests/unit/console-hosted-auth.test.ts`
  — throwaway ES256 keypair; both modes through `createConsoleHandler`);
  LIVE_READ_ONLY_CONFIRMED against the operator's real project
  (2026-09-02: a real Supabase session JWT for a throwaway auth user
  verified against the live JWKS; wrong user ⇒ 403, service key or
  tampered signature ⇒ 401; user deleted afterwards).

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
  fill for a user at `max_completed_applications` (the quota already
  rides down with the v0 profiles pull; v1 makes the refusal
  programmatic at session start instead of operational).

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
| 6 | v0 public-app schema (`user_profiles`, storage buckets + policies, `application_receipts`) + two-way sync (receipts push, profiles pull) + this roadmap's v0 reframe | UNIT_CONFIRMED (mappers/joins); cloud-side LIVE once operator keys exist |
