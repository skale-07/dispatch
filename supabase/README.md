# Supabase migrations (cloud plane)

Plain SQL, applied in filename order. Two ways to run them:

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
- `20260901000200` — `application_status_mirror` (one-way engine→cloud
  status rows; the entire permitted data surface) + `user_quota_status` view.
- `20260901000300` — RLS (users see only their rows; unredeemed invite
  codes are unlistable; waitlist is insert-only) + the atomic
  `redeem_invite(invite_code)` RPC (once-only, idempotent per user).

Key handling: the **anon key** goes to the frontend (RLS is the guard).
The **service-role key** stays in the engine machine's `.env` only — it is
what `npm run cloud:sync` and invite loading use, and it must never appear
in frontend config or this repo.
