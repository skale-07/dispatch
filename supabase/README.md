# Supabase migrations (cloud plane)

Plain SQL, applied in filename order. Three ways to run them:

**From this repo (no CLI install):** `npm run cloud:schema -- apply`
with `SUPABASE_SYNC_ENABLED=true` + `SUPABASE_ACCESS_TOKEN` (personal
access token) in the engine `.env`. Records versions in the CLI's own
`supabase_migrations.schema_migrations` ledger. Then / or standalone:
`npm run cloud:schema -- verify` reads back every expected object over
REST + Storage (operator-guide §26).

**Dashboard (no CLI needed):** Supabase project → SQL Editor → paste each
file from `migrations/` in order → Run.

**Supabase CLI:**

```
supabase link --project-ref <your-project-ref>
supabase db push
```

What they create (see `docs/roadmap/cloud-deploy.md` for the architecture):

- `20260901000100` — `invites` (code, issuer, quota, redeemed_by/at),
  `app_users` (keyed to `auth.users`), `waitlist`.
- `20260901000200` — `application_status_mirror` (engine→cloud status
  rows; the permitted status surface) + `user_quota_status` view.
- `20260901000300` — RLS (users see only their rows; unredeemed invite
  codes are unlistable; waitlist is insert-only) + the atomic
  `redeem_invite(invite_code)` RPC (once-only, idempotent per user).
- `20260902000100` — `user_profiles`: the onboarding wizard's row
  (contact, education jsonb, work authorization — self-reported only,
  resume pointer, job preferences jsonb, `onboarding_completed_at`).
  RLS: own row select/insert/update, no delete.
- `20260902000200` — private storage buckets `resumes` (user-managed
  under their own `{uid}/` prefix) and `receipts` (engine-written,
  user read-only) + `application_receipts` metadata rows (engine-written
  via service role; users select their own) + the `my_applications`
  dashboard view (status joined to latest receipt, security_invoker).

Key handling: the **anon key** goes to the frontend (RLS is the guard).
The **service-role key** stays in the engine machine's `.env` only — it is
what `npm run cloud:sync` and invite loading use, and it must never appear
in frontend config or this repo.
