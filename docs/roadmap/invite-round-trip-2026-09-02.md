# Invite round trip against the real Supabase project — 2026-09-02

Charter item: mint invites, load them into Supabase, demonstrate
redeem → quota-decrement → quota-exhausted with a throwaway user, and hand
the operator 10 real invite links. This file is the evidence log; every
claim carries its validation level (`docs/validation-levels.md`).

## Status at a glance

| Piece | Level | Evidence |
|---|---|---|
| Project reachable, keys valid | `LIVE_READ_ONLY_CONFIRMED` | `npm run cloud:schema -- verify` answers per object (below) |
| Schema present on the project | `LIVE_MUTATION_CONFIRMED` (2026-09-02 ~14:19 UTC) | `SUPABASE_SYNC_ENABLED=true npm run cloud:schema -- apply` ran all 9 migrations (`20260901000100` … `20260902000600`, `failed: null`); independent `verify` → 8 tables / 3 views / 4 RPCs / 2 buckets `present`, `complete: true` (transcript below) |
| Load → redeem → decrement → exhausted → refused → RLS → referral mint/view/self-refused → inviter bonus once → mint cap → heartbeat own-row | `UNIT_CONFIRMED` | `tests/unit/cloud-invite-roundtrip.test.ts` (in-memory project encoding the migrations' RLS/RPC/trigger/FK semantics) + `tests/unit/cloud-referral-schema.test.ts` (static contract of the four 2026-09-02 migrations) |
| Same, on the live project | `LIVE_MUTATION_CONFIRMED` | `SUPABASE_SYNC_ENABLED=true npm run invites:roundtrip` → 23/23 steps `ok`, 5/5 cleanups `ok`, exit 0 (transcript below); independent service-role read-back afterwards: `invites`, `app_users`, `application_status_mirror`, `referral_bonuses`, `engine_status` all `*/0` rows, `auth.users` 0 |
| Throwaway user + real session JWT via admin API | `LIVE_MUTATION_CONFIRMED` | two users created, redeemed with their own ES256 session JWTs, deleted by cleanup; 0 users remain |
| 10 invite codes for the operator | `LIVE_MUTATION_CONFIRMED` (loaded) | `C:\dev\jobright-application-agent\private\invites-2026-09-02.csv` → `public.invites`: `attempted 10, inserted 10, skipped_existing 0, read_back_ok true`; independent read-back: 10 rows, all `redeemed_by null`, `issued_by null`, `issuer operator`, quota 5, note `cohort 2026-09-02`. Link base is still the placeholder (no domain yet) |
| Fail-closed gates | `LIVE_READ_ONLY_CONFIRMED` | flag off → both commands refuse by name, exit 1, no orphaned codes (ledger count unchanged) |
| `cloud:sync` heartbeat live | **BLOCKED on `SUPABASE_SYNC_USER_ID`** | `SUPABASE_SYNC_ENABLED=true npm run cloud:sync` → `Supabase sync is enabled but unconfigured — missing SUPABASE_SYNC_USER_ID. …` exit 1, before any DB or network access; `engine_status` still `*/0` rows. The operator has not signed into the app yet, so no uuid exists to set |

## What was built

- `npm run invites:mint -- … --load` — POSTs the freshly minted codes into
  `public.invites` (`on_conflict=code`, ignore-duplicates) and reads them
  back. Gate is checked BEFORE minting.
- `npm run invites:roundtrip [-- --quota N]` — `src/cloud/inviteRoundTrip.ts`.
  Self-cleaning, never touches local SQLite, prints one `steps[]` entry
  per deterministic read-back plus `cleanup[]`; `validation_level` is
  `LIVE_MUTATION_CONFIRMED` only when every step AND every cleanup
  succeeded.
- Both are behind `SUPABASE_SYNC_ENABLED` + `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY`. Operator guide §24 / §24.1.

## Exact steps (what the operator runs, in order)

1. Apply the schema (one of):
   - `SUPABASE_ACCESS_TOKEN=<personal token>` in the engine `.env`, then
     `SUPABASE_SYNC_ENABLED=true npm run cloud:schema -- apply`
     (Management API, records the CLI ledger), or
   - dashboard SQL Editor: paste `supabase/migrations/*.sql` in filename
     order, then `npm run cloud:schema -- verify` → expect `complete: true`.
2. Prove the lifecycle: `SUPABASE_SYNC_ENABLED=true npm run invites:roundtrip`
   → expect `"validation_level": "LIVE_MUTATION_CONFIRMED"` and the 23
   steps below all `ok: true`; paste the JSON into the "Live transcript"
   section of this file.
3. Load the cohort codes: paste the SQL for `private/invites-2026-09-02.csv`
   (see "Loading the 10 codes") — or mint a fresh batch with
   `--load` once the domain exists so the links are final.

All three were done on 2026-09-02 from the launcher worktree with the
main checkout's `.env` as the only key source (exported into the shell
by name; `.env` was not copied). Re-running 1 is a no-op
(`already_applied`), 2 is self-cleaning, 3 is idempotent on `code`.

The round trip's steps, each a read-back:

| # | step | read-back |
|---|---|---|
| 1 | `load_invite` | `select code from invites where code in (…)` returns it |
| 2 | `create_user_a` | admin `POST /auth/v1/admin/users` → id; `generate_link` → `verify` → session JWT |
| 3 | `redeem_as_a` | `rpc/redeem_invite` with the USER's JWT returns `max_completed_applications = quota` |
| 4 | `invite_marked_redeemed` | `invites.redeemed_by = A`, `redeemed_at` set |
| 5 | `quota_after_redeem` | `user_quota_status` as A: `completed 0, remaining quota` |
| 6..n | `quota_after_completed_k` | after each COMPLETED `application_status_mirror` row (service role, as the sync worker writes): `completed k, remaining quota-k` |
| n+1 | `quota_exhausted_clamps_at_zero` | one more COMPLETED: `remaining 0` (view uses `greatest(…, 0)`) |
| n+2 | `redeem_again_as_a_idempotent` | same user, same code → success, no second `app_users` row |
| n+3 | `redeem_as_b_refused` | second throwaway user → HTTP 400 `invite already redeemed` |
| n+4 | `rls_hides_other_users_rows` | as B: `invites` filtered to 0 rows, `user_quota_status` 0 rows |
| n+5 | `referral_settings` | `rpc/referral_settings` returns the five loop constants (anon-callable json) |
| n+6 | `referral_mint_as_a` | `rpc/mint_referral_invite` as A (a member) → `JRA-XXXX-XXXX` in the CLI alphabet, `max_completed_applications = referral_code_quota` |
| n+7 | `referral_view_as_a` | `my_referral_invites` as A: exactly that one row, `redeemed_at null` |
| n+8 | `referral_view_hidden_from_b` | `my_referral_invites` as B: 0 rows |
| n+9 | `referral_self_redeem_refused` | A redeems own code → HTTP 400 `cannot redeem your own invite` |
| n+10 | `referral_redeem_as_b` | B redeems A's code → `max_completed_applications = referral_code_quota` (B becomes a member) |
| n+11 | `referral_view_shows_redeemed` | `my_referral_invites` as A: `redeemed_at` now set |
| n+12 | `referral_bonus_granted_to_inviter` | `activation_completed_applications` COMPLETED mirror rows for B (service role) → A's `user_quota_status.max_completed_applications` grew by `inviter_bonus_per_activation` (trigger fired) |
| n+13 | `referral_bonus_idempotent` | one more COMPLETED row for B → A's max unchanged (one bonus per invitee, ever) |
| n+14 | `referral_bonus_row_visible_to_inviter` | `referral_bonuses` as A: 1 row (RLS: inviter's own) |
| n+15 | `referral_cap_enforced` | A mints `max_active_referral_codes` more, the next → HTTP 400 `referral cap reached` |
| n+16 | `engine_status_own_row_only` | service-role upsert of A's heartbeat (as `cloud:sync` writes it) → as A 1 row, as B 0 rows |
| cleanup | `delete_issued_invites` ×2, `delete_user` ×2, `delete_invite` | unredeemed issued codes first (deleting the issuer would only SET NULL `issued_by` and orphan them), then the users — `20260902000600` makes `invites.redeemed_by` CASCADE so each user's redeemed invite, `app_users`, mirror rows, `engine_status` and `referral_bonuses` go with them — then the loaded code (a no-op unless the run aborted before A redeemed). See Findings 1 for why no other order works. |

## Live transcript (2026-09-02, engine machine, keys from the main `.env`, values never printed)

### After the schema apply (~14:19 UTC)

`SUPABASE_SYNC_ENABLED=true npm run cloud:schema -- apply` (Management API, `SUPABASE_ACCESS_TOKEN` from the main `.env`):

```
"apply": { "already_applied": [], "applied": [ "20260901000100", "20260901000200",
            "20260901000300", "20260902000100", "20260902000200", "20260902000300",
            "20260902000400", "20260902000500", "20260902000600" ], "failed": null }
"read_back": {
  "tables":  { invites, app_users, waitlist, application_status_mirror, user_profiles,
               application_receipts, referral_bonuses, engine_status: present }
  "views":   { user_quota_status, my_applications, my_referral_invites: present }
  "rpcs":    { redeem_invite, referral_settings, mint_referral_invite,
               grant_referral_bonus_if_activated: present }
  "buckets": { resumes, receipts: present }
  "complete": true, "errors": {} }
"validation_level": "LIVE_MUTATION_CONFIRMED"
```

`npm run cloud:schema -- verify` (independent, read-only, no token): `"complete": true`, `"validation_level": "LIVE_READ_ONLY_CONFIRMED"`, exit 0.

`SUPABASE_SYNC_ENABLED=true npm run invites:roundtrip` — exit 0, 23/23 steps, 5/5 cleanups. The two `user_id`s are throwaway accounts deleted by the cleanup (`auth.users` count 0 afterwards); session JWTs are never printed:

```json
{
  "ok": true,
  "validation_level": "LIVE_MUTATION_CONFIRMED",
  "invite_code": "JRA-KSCF-8N4F",
  "quota": 2,
  "steps": [
    {
      "step": "load_invite",
      "ok": true,
      "detail": "inserted=1 read_back_ok=true"
    },
    {
      "step": "create_user_a",
      "ok": true,
      "detail": "user_id=a278b781-580c-4e5c-8d70-fd3ab3716d37 session=jwt"
    },
    {
      "step": "redeem_as_a",
      "ok": true,
      "detail": "rpc returned max_completed_applications=2"
    },
    {
      "step": "invite_marked_redeemed",
      "ok": true,
      "detail": "redeemed_by matches A: true"
    },
    {
      "step": "quota_after_redeem",
      "ok": true,
      "detail": "user_quota_status={\"max\":2,\"completed\":0,\"remaining\":2}"
    },
    {
      "step": "quota_after_completed_1",
      "ok": true,
      "detail": "user_quota_status={\"max\":2,\"completed\":1,\"remaining\":1}"
    },
    {
      "step": "quota_after_completed_2",
      "ok": true,
      "detail": "user_quota_status={\"max\":2,\"completed\":2,\"remaining\":0}"
    },
    {
      "step": "quota_exhausted_clamps_at_zero",
      "ok": true,
      "detail": "user_quota_status={\"max\":2,\"completed\":3,\"remaining\":0}"
    },
    {
      "step": "redeem_again_as_a_idempotent",
      "ok": true,
      "detail": "same user, same code: success without a second row"
    },
    {
      "step": "redeem_as_b_refused",
      "ok": true,
      "detail": "HTTP 400 {\"code\":\"P0001\",\"details\":null,\"hint\":null,\"message\":\"invite already redeemed\"}"
    },
    {
      "step": "rls_hides_other_users_rows",
      "ok": true,
      "detail": "B sees invites=0 quota_rows=0"
    },
    {
      "step": "referral_settings",
      "ok": true,
      "detail": "{\"max_active_referral_codes\":3,\"referral_code_quota\":5,\"activation_completed_applications\":5,\"inviter_bonus_per_activation\":10,\"inviter_bonus_cap\":100}"
    },
    {
      "step": "referral_mint_as_a",
      "ok": true,
      "detail": "code shape ok=true quota=5"
    },
    {
      "step": "referral_view_as_a",
      "ok": true,
      "detail": "rows=1"
    },
    {
      "step": "referral_view_hidden_from_b",
      "ok": true,
      "detail": "rows=0"
    },
    {
      "step": "referral_self_redeem_refused",
      "ok": true,
      "detail": "HTTP 400 {\"code\":\"P0001\",\"details\":null,\"hint\":null,\"message\":\"cannot redeem your own invite\"}"
    },
    {
      "step": "referral_redeem_as_b",
      "ok": true,
      "detail": "max_completed_applications=5"
    },
    {
      "step": "referral_view_shows_redeemed",
      "ok": true,
      "detail": "[{\"redeemed_at\":\"2026-09-02T14:20:52.881391+00:00\"}]"
    },
    {
      "step": "referral_bonus_granted_to_inviter",
      "ok": true,
      "detail": "A max 2 -> 12 (expected +10)"
    },
    {
      "step": "referral_bonus_idempotent",
      "ok": true,
      "detail": "A max stays 12"
    },
    {
      "step": "referral_bonus_row_visible_to_inviter",
      "ok": true,
      "detail": "[{\"bonus\":10}]"
    },
    {
      "step": "referral_cap_enforced",
      "ok": true,
      "detail": "HTTP 400 {\"code\":\"P0001\",\"details\":null,\"hint\":null,\"message\":\"referral cap reached\"}"
    },
    {
      "step": "engine_status_own_row_only",
      "ok": true,
      "detail": "A rows=1 B rows=0"
    }
  ],
  "cleanup": [
    {
      "step": "delete_issued_invites",
      "ok": true,
      "detail": "a278b781-580c-4e5c-8d70-fd3ab3716d37"
    },
    {
      "step": "delete_issued_invites",
      "ok": true,
      "detail": "cd79aaf1-f7ef-49fa-a0c5-01ac89732905"
    },
    {
      "step": "delete_user",
      "ok": true,
      "detail": "a278b781-580c-4e5c-8d70-fd3ab3716d37"
    },
    {
      "step": "delete_user",
      "ok": true,
      "detail": "cd79aaf1-f7ef-49fa-a0c5-01ac89732905"
    },
    {
      "step": "delete_invite",
      "ok": true,
      "detail": "JRA-KSCF-8N4F"
    }
  ]
}
```

Post-run read-back (service role, `Prefer: count=exact`): `invites */0`, `app_users */0`,
`application_status_mirror */0`, `referral_bonuses */0`, `engine_status */0`,
`GET /auth/v1/admin/users` → 0 users. Nothing left behind.

Loading the cohort (`loadInvitesToSupabase` with the CSV rows, i.e. the `--load` path without minting):

```
{ "csv_rows": 10, "result": { "attempted": 10, "inserted": 10, "skipped_existing": 0, "read_back_ok": true } }
read-back: total 10, unredeemed operator codes 10 (redeemed_by null, issued_by null, issuer operator), quota 5, note "cohort 2026-09-02"
```

`SUPABASE_SYNC_ENABLED=true npm run cloud:sync` (flag on the command only; `SUPABASE_SYNC_USER_ID` absent from the main `.env`):

```
Supabase sync is enabled but unconfigured — missing SUPABASE_SYNC_USER_ID. All three live in the engine .env; the service-role key must never be deployed anywhere else.
exit 1   (refused before opening the engine database or the network; engine_status still */0)
```

### Before the schema apply (earlier the same day)

`npm run cloud:schema -- verify` (read-only):

```
"tables": { invites: absent, app_users: absent, waitlist: absent,
            application_status_mirror: absent, user_profiles: absent,
            application_receipts: absent }
"views":  { user_quota_status: absent, my_applications: absent }
"rpcs":   { redeem_invite: absent }
"buckets":{ resumes: absent, receipts: absent }
"complete": false, "validation_level": "INCOMPLETE"
```

`npm run invites:roundtrip` (flag off):

```
SUPABASE_SYNC_ENABLED is false (fail-closed default). Set it in .env to write invites to Supabase.
exit 1
```

`SUPABASE_SYNC_ENABLED=true npm run invites:roundtrip`:

```json
{
  "ok": false,
  "validation_level": "UNVERIFIED",
  "quota": 2,
  "steps": [
    { "step": "aborted", "ok": false,
      "detail": "public.invites does not exist on the project — apply the schema first (npm run cloud:schema -- apply, or paste supabase/migrations/ in the SQL editor)." }
  ],
  "cleanup": []
}
```

`npm run invites:mint -- --count 1 --base-url https://x.example --load` (flag off):

```
--load refused: SUPABASE_SYNC_ENABLED is false (fail-closed default). …
exit 1   (local cloud_invites row count unchanged: gate runs before mint)
```


## The 10 codes

- File: `C:\dev\jobright-application-agent\private\invites-2026-09-02.csv`
  (columns `code,issuer,max_completed_applications,link,created_at`;
  10 rows; quota 5 each; issuer `operator`). Codes are secrets until
  redeemed — the file is under `private/` and must stay there.
- Ledger: the `cloud_invites` table of the LAUNCHER WORKTREE's
  `data/app.sqlite` (the main engine database was not written).
- Links are `https://<domain>/redeem?code=JRA-XXXX-XXXX` — a literal
  placeholder because no domain exists yet. Once it does, either
  `sed -i 's#https://<domain>#https://real.domain#' private/invites-2026-09-02.csv`
  or mint a fresh batch (`--base-url https://real.domain --load`).

### Loading the 10 codes

LOADED 2026-09-02 (see the transcript): all 10 are live in
`public.invites`, unredeemed, `issued_by null`, note `cohort 2026-09-02`.
Loading again is a no-op (`on_conflict=code`, ignore-duplicates). The
links in the CSV still carry the placeholder base; the CODES are what the
project knows, so fixing the base later is a CSV edit only.

The SQL twin of the CSV was written next to it in the worktree
(`private/cloud/invites/invites-2026-09-02T13-40-51-878Z.sql`). If that
worktree is gone, regenerate from the CSV — one line per row:

```sql
insert into public.invites (code, issuer, max_completed_applications)
values ('JRA-XXXX-XXXX', 'operator', 5) on conflict (code) do nothing;
```

## Findings

1. **`invites.redeemed_by` had no `on delete` behaviour — and no deletion
   order worked.** (RESOLVED by `20260902000600_invites_redeemed_by_cascade.sql`;
   decision in `docs/roadmap/cloud-deploy.md`, "redeemed_by ON DELETE".)
   `invites.redeemed_by -> auth.users` was NO ACTION, but so is
   `app_users.invite_id -> invites`, while `app_users.id -> auth.users`
   cascades. So: delete the user first → FK error from the invite still
   pointing at them; delete the invite first → FK error from `app_users`
   still pointing at the invite. A member could never be removed
   (dashboard, GDPR request, or this round trip's cleanup). The earlier
   version of this document prescribed "invite first" — that was
   `UNIT_CONFIRMED` against a fake that did not model `app_users.invite_id`,
   and would have failed live; the fake now models both constraints
   (`tests/unit/cloud-invite-roundtrip.test.ts`, "models the FK cycle").
   CASCADE, not SET NULL: SET NULL on `redeemed_by` alone violates the
   `(redeemed_by is null) = (redeemed_at is null)` check, and nulling both
   would make the code redeemable again — a quota reset by deleting and
   recreating an account. A deleted account's invite is spent.
2. The quota view counts COMPLETED rows even past the quota
   (`completed_applications` keeps rising; `remaining` clamps). The
   engine is what must stop at `remaining = 0`; nothing cloud-side
   blocks it. That matches the roadmap ("quota unit is COMPLETED
   applications"), noted so nobody assumes enforcement exists.
3. A user JWT + the service key as `apikey` works for REST as the
   authenticated role (PostgREST takes the role from `Authorization`),
   which is how the round trip exercises RLS without shipping the anon
   key to the engine.
