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
//   | "cannot redeem your own invite" | "already a member"   (20260902000300)

// 4. Own account + quota (RLS: only your rows)
const { data: me } = await supabase.from("app_users").select("*").single();
const { data: quota } = await supabase
  .from("user_quota_status")           // view: used vs max
  .select("*").single();
// quota columns (20260902000400 appends the last two; the first four are
// unchanged in name/type/order):
//   user_id: string
//   max_completed_applications: number   // EFFECTIVE quota = base + bonus
//   completed_applications: number
//   remaining: number                     // greatest(max - completed, 0)
//   base_max_completed_applications: number   // the invite's own quota
//   bonus_completed_applications: number      // earned via referrals

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

// 9. Referrals (migrations 20260902000300/400; frontend/src/public/referral.ts).
//    View: own issued codes only (RLS "own issued invites"; operator-minted
//    codes have issued_by = null and never appear here).
//      my_referral_invites: { code: string; max_completed_applications: number;
//                             redeemed_at: string | null; created_at: string }
const { data: mine } = await supabase
  .from("my_referral_invites")
  .select("code, max_completed_applications, redeemed_at")
  .order("redeemed_at", { ascending: true, nullsFirst: true });
//    RPC: mint one code for the caller (issuer = auth.uid(), quota =
//    referral_code_quota). No arguments.
const { data: minted, error: mintErr } = await supabase.rpc("mint_referral_invite");
// minted: { code: string; max_completed_applications: number;
//           redeemed_at: null; created_at: string;
//           active_unredeemed: number; max_active_referral_codes: number }
// mintErr.message is one of:
//   "not authenticated" | "not a member yet" | "referral cap reached"
//    Constants (anon-callable, immutable; render "3 codes, 5 apps each,
//    +10 for you when a friend completes 5, up to +100" from these, never
//    hardcode them):
const { data: settings } = await supabase.rpc("referral_settings");
// settings: { max_active_referral_codes: 3; referral_code_quota: 5;
//             activation_completed_applications: 5;
//             inviter_bonus_per_activation: 10; inviter_bonus_cap: 100 }
//    Bonus ledger (RLS: rows where you are the inviter; read-only):
//      referral_bonuses: { invitee_user_id: string; inviter_user_id: string;
//                          invite_id: string | null; bonus: number; granted_at: string }
//    The bonus itself is already folded into user_quota_status (above);
//    the ledger is for "you earned +10 from a friend on <date>" copy.

// 10. Engine heartbeat (20260902000500). One row per user, written by the
//     engine's sync worker every tick; RLS: own row, read-only.
//       engine_status: { user_id: string; last_seen_at: string;
//                        engine_version: string | null;
//                        last_sync_attempted: number; last_sync_upserted: number;
//                        last_sync_duration_ms: number; last_error: string | null }
const { data: engine } = await supabase.from("engine_status").select("*").maybeSingle();
// "engine running" = engine !== null &&
//   Date.now() - Date.parse(engine.last_seen_at) < 2 * SYNC_INTERVAL_MS
// (the operator runs cloud:sync after each session / alongside auto:cycle;
//  no row yet = "not connected", stale row = "offline since <last_seen_at>",
//  fresh row with last_error = "running, last push failed").
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

**Referral loop (college-launch §4, built 2026-09-02):** a member holds
at most 3 unredeemed referral codes (quota 5 each); one redemption per
account (`already a member`); when an invitee's COMPLETED count reaches
5 an AFTER trigger on `application_status_mirror` grants the inviter
+10 (`app_users.bonus_completed_applications`), keyed on the invitee so
it happens once ever, lifetime cap +100, never for self-referral or
operator-minted codes (`issued_by` null). Activation is a receipt-backed
COMPLETED row the engine wrote, so the loop is not farmable from the
browser.

**`invites.redeemed_by` ON DELETE — decided: CASCADE**
(`20260902000600_invites_redeemed_by_cascade.sql`). The original
schema left it NO ACTION, and because `app_users.invite_id -> invites`
is also NO ACTION while `app_users.id -> auth.users` cascades, no
deletion order could remove a member — the user delete tripped on the
invite, the invite delete tripped on `app_users`. Options weighed:
(a) SET NULL on `redeemed_by` — violates the
`(redeemed_by is null) = (redeemed_at is null)` check unless a trigger
nulls `redeemed_at` too, and then the code is redeemable again, i.e. a
quota reset by deleting and recreating an account; (b) a
`delete_account()` procedure that nulls both columns first — same
replay problem plus a second code path the dashboard's Delete button
would bypass; (c) CASCADE — the invite row leaves with the account, the
code can never be replayed, the inviter's banked bonus is untouched
(`referral_bonuses.invite_id` is SET NULL, the bonus is a counter on
`app_users`), and the inviter's `my_referral_invites` drops that one
row, which is the honest state. (c) is one `alter table` pair and is
what shipped. `issued_by` stays SET NULL so an issuer leaving does not
revoke codes already handed out.

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
   config, never in this repo. (v0) — DONE 2026-09-02: project exists,
   all 9 migrations applied and read back, 10 cohort codes loaded.
   Still needed from this item: **`SUPABASE_SYNC_USER_ID`** (your own
   `auth.users` uuid, after your first sign-in) for `cloud:sync`.
3. **Buy/choose the domain** and report the name — invite links bake
   the base URL (`invites:mint --base-url`). (~$10/yr, the only v0
   cash) (v0)
4. **Create a free Vercel account** (Hobby) and connect the domain. (v0)
5. AWS account with the credits applied — v1 only, no earlier spend. (v1)

## Milestone sequence in this repo

| # | Deliverable | Validation |
| --- | --- | --- |
| 1 | This roadmap | n/a (doc) |
| 2 | `supabase/` SQL migrations (users, invites, waitlist, mirror, RLS, `redeem_invite`, quota view) | LIVE_MUTATION_CONFIRMED 2026-09-02: applied by `cloud:schema -- apply`, `verify` → `complete: true` |
| 3 | `invites:mint` CLI + local `cloud_invites` table + SQL/CSV export to `private/cloud/invites/` | UNIT_CONFIRMED (code gen, link building, SQL/CSV emit) |
| 4 | `src/cloud/syncSupabase.ts` behind `SUPABASE_SYNC_ENABLED` + `DOTENV_OVERRIDE` fix | UNIT_CONFIRMED (pure mapping); live sync is LIVE_MUTATION (cloud-only) once keys exist |
| 5 | `deploy/` Dockerfile + first-deploy runbook; `npm run build` (tsc → dist, no tsx at runtime) | image builds + console serves locally (docker available on this box) |
| 6 | v0 public-app schema (`user_profiles`, storage buckets + policies, `application_receipts`) + two-way sync (receipts push, profiles pull) + this roadmap's v0 reframe | UNIT_CONFIRMED (mappers/joins); schema LIVE_MUTATION_CONFIRMED (applied + read back 2026-09-02); sync itself still blocked on `SUPABASE_SYNC_USER_ID` |
| 7 | `cloud:schema` — apply `supabase/migrations/` via the Management API (`SUPABASE_ACCESS_TOKEN`, behind `SUPABASE_SYNC_ENABLED`) + deterministic REST/Storage read-back | LIVE_MUTATION_CONFIRMED 2026-09-02: `apply` ran all 9 migrations (`failed: null`), independent `verify` → 8 tables / 3 views / 4 RPCs / 2 buckets `present` |
| 8 | Hosted console auth behind `CONSOLE_HOSTED_MODE_ENABLED` (Supabase JWT via JWKS on every `/api`, host + user allowlists, read-only; local mode unchanged) | UNIT_CONFIRMED; LIVE_READ_ONLY_CONFIRMED (real user JWT accepted, stranger 403, service key 401, tampered 401) |
| 9 | `invites:roundtrip` live proof + `invites:mint --load` | LIVE_MUTATION_CONFIRMED 2026-09-02: 23/23 steps + 5/5 cleanups on the real project, nothing left behind; 10 cohort codes loaded and read back (`docs/roadmap/invite-round-trip-2026-09-02.md`) |
| 10 | Referral invites: `referral_settings()`, `invites.issued_by`, `my_referral_invites`, `mint_referral_invite()`, `redeem_invite` self/second-redemption refusals (`20260902000300`) | LIVE_MUTATION_CONFIRMED 2026-09-02: round-trip steps `referral_settings`, `referral_mint_as_a`, `referral_view_as_a`, `referral_view_hidden_from_b`, `referral_self_redeem_refused`, `referral_redeem_as_b`, `referral_view_shows_redeemed`, `referral_cap_enforced` all `ok` |
| 11 | Two-sided quota bonus: `referral_bonuses`, `app_users.bonus_completed_applications`, `user_quota_status` = base + bonus, AFTER trigger on COMPLETED mirror rows (`20260902000400`) | LIVE_MUTATION_CONFIRMED 2026-09-02: `referral_bonus_granted_to_inviter` (A max 2 → 12), `referral_bonus_idempotent` (stays 12), `referral_bonus_row_visible_to_inviter` (`[{bonus:10}]`) |
| 12 | `engine_status` heartbeat table + `cloud:sync` writes it every tick (`20260902000500`, `toEngineStatusRow`) | table + RLS LIVE_MUTATION_CONFIRMED (`engine_status_own_row_only`: A 1 row, B 0); the worker's write is still BLOCKED on `SUPABASE_SYNC_USER_ID` (refuses by name) |
| 13 | `invites.redeemed_by` ON DELETE CASCADE (`20260902000600`) — resolves the FK cycle that made members undeletable | LIVE_MUTATION_CONFIRMED 2026-09-02: `delete_user` ×2 succeeded with redeemed invites still pointing at them; `invites`/`app_users` `*/0` afterwards |

## Status — 2026-09-02 (launcher agent, deterministic read-backs only)

| Item | Status | Level | Exact operator input to unblock |
| --- | --- | --- | --- |
| Supabase project reachable with the engine `.env` keys | DONE | LIVE_READ_ONLY_CONFIRMED | — |
| Schema applied on the project | DONE (2026-09-02 ~14:19 UTC) | LIVE_MUTATION_CONFIRMED — `apply`: 9 applied, `failed: null`; `verify`: `complete: true` | — (future migrations: same command; already-applied ones are skipped via the CLI ledger) |
| Invite lifecycle proof (redeem → decrement → exhausted → refused → referral → bonus → cap → heartbeat) | DONE | LIVE_MUTATION_CONFIRMED — 23/23 steps, 5/5 cleanups, 0 rows / 0 users left | — (re-run any time; self-cleaning) |
| Referral loop + engine heartbeat schema (`20260902000300`–`000600`) | DONE | LIVE_MUTATION_CONFIRMED (every RPC/view/trigger/RLS rule exercised by the round trip; see milestones 10–13) | — |
| 10 invite codes for the cohort | DONE (loaded) | LIVE_MUTATION_CONFIRMED — `inserted 10, read_back_ok true`; read-back: 10 live, unredeemed, operator-issued | Links in `private/invites-2026-09-02.csv` still carry the placeholder base `https://<domain>`; the codes are final. Report the domain, then `sed` it into the CSV (no reload needed) |
| Status-mirror sync + `engine_status` heartbeat (`cloud:sync`) live | **BLOCKED on user id** | refusal verbatim: `Supabase sync is enabled but unconfigured — missing SUPABASE_SYNC_USER_ID. All three live in the engine .env; the service-role key must never be deployed anywhere else.` (exit 1, before any DB/network access) | Sign into the app once (needs the Vercel deploy below, or a magic link from the dashboard), then Authentication → Users → copy your uuid into the engine `.env` as `SUPABASE_SYNC_USER_ID`, then `npm run cloud:sync`. Dry evidence: a read-only snapshot of the engine DB has 335 applications the worker would attempt |
| Vercel deploy of `frontend/` | **BLOCKED** | no Vercel login / token on this box | Vercel → New Project → import repo, root `frontend/`, preset Vite, env `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` (publishable key), Domains → add — `deploy/first-deploy.md` A2. Or `vercel login` here and tell the queen |
| Console Docker image | BUILT, image BLOCKED | Dockerfile unchanged; daemon not running | Start Docker Desktop, then `docker build -f deploy/Dockerfile -t dispatch-console .` (C1). Not started by the agent: this box runs the live browser pipeline |
| Console artifacts (`dist/` + `frontend/dist/`) run as the image's CMD | DONE | LIVE_READ_ONLY_CONFIRMED (native, snapshot DB) | — (transcript in `deploy/first-deploy.md` C1: local 200/403/200; hosted 401/401/403/403/200; boot refusal without allowlists) |
| Hosted console on Fly.io | optional, not v0 | — | `deploy/first-deploy.md` C2 |
| Storefront contract for hosted mode | request filed | — | SPA sends `Authorization: Bearer <supabase access_token>` on every `/api` call when hosted; console is read-only there |
