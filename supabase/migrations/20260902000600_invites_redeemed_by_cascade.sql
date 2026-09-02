-- invites.redeemed_by: ON DELETE CASCADE (decision recorded in
-- docs/roadmap/cloud-deploy.md, "redeemed_by ON DELETE").
--
-- Why this is needed at all: 20260901000100 left redeemed_by as NO ACTION
-- while app_users.invite_id -> invites is also NO ACTION and
-- app_users.id -> auth.users cascades. Deleting an account therefore
-- fails (its redeemed invite still points at it), and deleting the
-- invite first fails too (the account's app_users row still points at
-- the invite). No deletion order works: a member could never be removed
-- (dashboard, GDPR request, or invites:roundtrip cleanup).
--
-- Why CASCADE and not SET NULL: the redemption check constraint
-- ((redeemed_by is null) = (redeemed_at is null)) would reject SET NULL
-- on redeemed_by alone, and clearing both would make the code redeemable
-- again — a quota reset by deleting and recreating an account. A deleted
-- account's invite is SPENT: the row goes with the account, the code can
-- never be replayed, and the inviter's already-banked bonus is untouched
-- (referral_bonuses.invite_id is SET NULL; app_users.bonus_* is a
-- counter). The inviter's my_referral_invites loses that one row, which
-- is the honest state: that invitee no longer exists.
--
-- Within the single DELETE on auth.users, Postgres cascades to both
-- app_users and invites and checks the NO ACTION app_users.invite_id
-- constraint at end of statement, when both rows are already gone.

alter table public.invites
  drop constraint invites_redeemed_by_fkey;

alter table public.invites
  add constraint invites_redeemed_by_fkey
    foreign key (redeemed_by) references auth.users (id) on delete cascade;
