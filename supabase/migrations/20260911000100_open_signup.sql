-- Open signup (operator decision 2026-09-11). Until now an account existed
-- only after redeem_invite() — the app_users row WAS the invite. The
-- product is now a public web app: anyone signs up and starts with
-- free_signup_quota completed applications; an invite code (operator-
-- minted or a friend's referral) still ADDS its own quota on top, and the
-- referral bonus loop is unchanged.
--
-- Three changes, each additive:
--
-- 1. referral_settings() gains 'free_signup_quota' (5). The frontend
--    renders "5 free applications" from this value, never from a literal.
--
-- 2. ensure_member(): the SPA calls it once per session after sign-in.
--    Idempotent insert of the caller's app_users row (invite_id null).
--    An RPC rather than a trigger on auth.users because a failing trigger
--    would block sign-in for everyone, the managed auth schema is not
--    ours to attach triggers to, and an RPC is probe-able by
--    cloud:schema -- verify (service role => 'not authenticated' =>
--    present).
--
-- 3. user_quota_status: `join invites` becomes `left join invites` so an
--    invite-less member has a row at all (before this a free-signup user
--    was invisible to the view = "not a member" on the dashboard).
--    max_completed_applications = free + invite (0 when none) + bonus.
--    The first six columns keep their names, types and order (create or
--    replace view); two are appended: free_completed_applications and
--    has_invite. Existing invite holders gain the free allowance too —
--    "5 free for everyone" is the offer, the invite is the extra.
--
-- Unchanged: redeem_invite() already lets a member whose invite_id is
-- null redeem exactly one code later (its 'already a member' refusal
-- keys on invite_id, not on the row), and refuses a second one. The
-- bonus trigger inner-joins invitee -> invite -> issued_by, so a free
-- signup with no inviter earns nobody a bonus.

create or replace function public.referral_settings()
returns json
language sql
immutable
as $$
  select json_build_object(
    'max_active_referral_codes', 3,
    'referral_code_quota', 5,
    'activation_completed_applications', 5,
    'inviter_bonus_per_activation', 10,
    'inviter_bonus_cap', 100,
    -- completed applications every new account starts with (2026-09-11)
    'free_signup_quota', 5
  );
$$;

revoke all on function public.referral_settings() from public;
grant execute on function public.referral_settings() to anon, authenticated;

-- Membership for the signed-in user, created on first call. Returns
-- { user_id, created, invite_id, free_signup_quota }.
create or replace function public.ensure_member()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_rows integer := 0;
  v_invite uuid;
  s json := public.referral_settings();
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  insert into public.app_users (id, email)
  values (auth.uid(), coalesce(v_email, ''))
  on conflict (id) do nothing;
  get diagnostics v_rows = row_count;

  select invite_id into v_invite from public.app_users where id = auth.uid();

  return json_build_object(
    'user_id', auth.uid(),
    'created', v_rows > 0,
    'invite_id', v_invite,
    'free_signup_quota', (s->>'free_signup_quota')::integer
  );
end;
$$;

revoke all on function public.ensure_member() from public;
revoke all on function public.ensure_member() from anon;
grant execute on function public.ensure_member() to authenticated;

-- Quota read model: free + invite + bonus. Columns 1-6 unchanged in name,
-- type and order; 7-8 appended.
create or replace view public.user_quota_status
  with (security_invoker = true) as
select
  u.id as user_id,
  (s.free + coalesce(i.max_completed_applications, 0) + u.bonus_completed_applications)
    as max_completed_applications,
  count(m.*) filter (where m.state = 'COMPLETED') as completed_applications,
  greatest(
    (s.free + coalesce(i.max_completed_applications, 0) + u.bonus_completed_applications)
      - count(m.*) filter (where m.state = 'COMPLETED'),
    0
  ) as remaining,
  coalesce(i.max_completed_applications, 0) as base_max_completed_applications,
  u.bonus_completed_applications,
  s.free as free_completed_applications,
  (i.id is not null) as has_invite
from public.app_users u
cross join lateral (
  select ((public.referral_settings())->>'free_signup_quota')::integer as free
) s
left join public.invites i on i.id = u.invite_id
left join public.application_status_mirror m on m.user_id = u.id
group by u.id, i.id, i.max_completed_applications, u.bonus_completed_applications, s.free;
