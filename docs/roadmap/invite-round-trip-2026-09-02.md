# Invite round trip against the real Supabase project — 2026-09-02

Charter item: mint invites, load them into Supabase, demonstrate
redeem → quota-decrement → quota-exhausted with a throwaway user, and hand
the operator 10 real invite links. This file is the evidence log; every
claim carries its validation level (`docs/validation-levels.md`).

## Status at a glance

| Piece | Level | Evidence |
|---|---|---|
| Project reachable, keys valid | `LIVE_READ_ONLY_CONFIRMED` | `npm run cloud:schema -- verify` answers per object (below) |
| Schema present on the project | **BLOCKED** | `verify` → every table/view/RPC/bucket `absent`, `complete: false` |
| Load → redeem → decrement → exhausted → refused → RLS → referral mint/view/self-refused → inviter bonus once → mint cap → heartbeat own-row | `UNIT_CONFIRMED` | `tests/unit/cloud-invite-roundtrip.test.ts` (in-memory project encoding the migrations' RLS/RPC/trigger/FK semantics) + `tests/unit/cloud-referral-schema.test.ts` (static contract of the four 2026-09-02 migrations) |
| Same, on the live project | **BLOCKED on schema** | `SUPABASE_SYNC_ENABLED=true npm run invites:roundtrip` aborts at step 1 naming `public.invites` missing (transcript below) |
| Throwaway user + real session JWT via admin API | `LIVE_READ_ONLY_CONFIRMED` | done earlier today for hosted auth: create user → `generate_link` (magiclink) → `verify` → ES256 JWT, then deleted; 0 users remain |
| 10 invite codes for the operator | DONE (local) | `C:\dev\jobright-application-agent\private\invites-2026-09-02.csv` — 10 rows, quota 5 each. NOT loaded (no schema); link base is a placeholder (no domain yet) |
| Fail-closed gates | `LIVE_READ_ONLY_CONFIRMED` | flag off → both commands refuse by name, exit 1, no orphaned codes (ledger count unchanged) |

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
   → expect `"validation_level": "LIVE_MUTATION_CONFIRMED"` and the 11
   steps below all `ok: true`; paste the JSON into the "Live transcript"
   section of this file.
3. Load the cohort codes: paste the SQL for `private/invites-2026-09-02.csv`
   (see "Loading the 10 codes") — or mint a fresh batch with
   `--load` once the domain exists so the links are final.

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

_Append the post-schema `invites:roundtrip` JSON here when it runs green._

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
