-- Two-sided quota bonus (docs/marketing/college-launch.md §4, Dropbox
-- model): when an INVITEE reaches activation_completed_applications
-- COMPLETED applications, the INVITER's quota grows by
-- inviter_bonus_per_activation, capped at inviter_bonus_cap lifetime.
-- Constants: referral_settings() (previous migration).
--
-- Resistant to farming because completion requires a receipt from the
-- engine; idempotent because the grant is keyed on the invitee (one row
-- per invitee, ever). Runs as an AFTER trigger on the status mirror, i.e.
-- on the same COMPLETED-count read user_quota_status already does, so
-- the sync worker needs no new capability.

alter table public.app_users
  add column bonus_completed_applications integer not null default 0
    check (bonus_completed_applications >= 0);

create table public.referral_bonuses (
  -- one bonus per invitee, ever (the idempotency key)
  invitee_user_id uuid primary key references auth.users (id) on delete cascade,
  inviter_user_id uuid not null references auth.users (id) on delete cascade,
  invite_id uuid references public.invites (id) on delete set null,
  bonus integer not null check (bonus > 0),
  granted_at timestamptz not null default now()
);

create index referral_bonuses_inviter_idx on public.referral_bonuses (inviter_user_id);

alter table public.referral_bonuses enable row level security;
revoke all on public.referral_bonuses from anon;
revoke insert, update, delete on public.referral_bonuses from authenticated;

-- An inviter may see the bonuses they earned (never who the invitee is
-- beyond the uuid they already hold through their own invite row).
create policy "own earned bonuses"
  on public.referral_bonuses for select
  to authenticated
  using (inviter_user_id = auth.uid());

-- Quota read model now includes the bonus. Existing columns keep their
-- names, types and order (create or replace view requirement);
-- max_completed_applications becomes the EFFECTIVE quota (base + bonus)
-- so `remaining` stays the one number the dashboard trusts. Two columns
-- appended for transparency.
create or replace view public.user_quota_status
  with (security_invoker = true) as
select
  u.id as user_id,
  (i.max_completed_applications + u.bonus_completed_applications)
    as max_completed_applications,
  count(m.*) filter (where m.state = 'COMPLETED') as completed_applications,
  greatest(
    (i.max_completed_applications + u.bonus_completed_applications)
      - count(m.*) filter (where m.state = 'COMPLETED'),
    0
  ) as remaining,
  i.max_completed_applications as base_max_completed_applications,
  u.bonus_completed_applications
from public.app_users u
join public.invites i on i.id = u.invite_id
left join public.application_status_mirror m on m.user_id = u.id
group by u.id, i.max_completed_applications, u.bonus_completed_applications;

-- Grant the inviter's bonus for p_invitee if (and only once) the invitee
-- has activated. Safe to call any number of times.
create or replace function public.grant_referral_bonus_if_activated(p_invitee uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  s json := public.referral_settings();
  v_threshold integer := (s->>'activation_completed_applications')::integer;
  v_per integer := (s->>'inviter_bonus_per_activation')::integer;
  v_cap integer := (s->>'inviter_bonus_cap')::integer;
  v_completed integer;
  v_inviter uuid;
  v_invite_id uuid;
  v_current integer;
  v_bonus integer;
  v_inserted uuid;
begin
  if exists (select 1 from public.referral_bonuses where invitee_user_id = p_invitee) then
    return json_build_object('granted', false, 'reason', 'already granted');
  end if;

  select count(*) into v_completed
  from public.application_status_mirror
  where user_id = p_invitee and state = 'COMPLETED';
  if v_completed < v_threshold then
    return json_build_object('granted', false, 'reason', 'not activated',
                             'completed', v_completed, 'threshold', v_threshold);
  end if;

  select i.issued_by, i.id into v_inviter, v_invite_id
  from public.app_users u
  join public.invites i on i.id = u.invite_id
  where u.id = p_invitee;
  if v_inviter is null or v_inviter = p_invitee then
    return json_build_object('granted', false, 'reason', 'no inviter');
  end if;

  -- Serialize per inviter so concurrent activations respect the cap.
  perform pg_advisory_xact_lock(hashtext('referral_bonus:' || v_inviter::text));

  select coalesce(sum(bonus), 0) into v_current
  from public.referral_bonuses where inviter_user_id = v_inviter;
  v_bonus := least(v_per, v_cap - v_current);
  if v_bonus <= 0 then
    return json_build_object('granted', false, 'reason', 'inviter at bonus cap');
  end if;

  insert into public.referral_bonuses (invitee_user_id, inviter_user_id, invite_id, bonus)
  values (p_invitee, v_inviter, v_invite_id, v_bonus)
  on conflict (invitee_user_id) do nothing
  returning invitee_user_id into v_inserted;
  if v_inserted is null then
    return json_build_object('granted', false, 'reason', 'already granted');
  end if;

  update public.app_users
  set bonus_completed_applications = bonus_completed_applications + v_bonus
  where id = v_inviter;

  return json_build_object('granted', true, 'inviter', v_inviter, 'bonus', v_bonus);
end;
$$;

revoke all on function public.grant_referral_bonus_if_activated(uuid) from public;
revoke all on function public.grant_referral_bonus_if_activated(uuid) from anon, authenticated;

create or replace function public.referral_bonus_on_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.grant_referral_bonus_if_activated(new.user_id);
  return null;
end;
$$;

create trigger application_status_mirror_referral_bonus
  after insert or update of state on public.application_status_mirror
  for each row
  when (new.state = 'COMPLETED')
  execute function public.referral_bonus_on_completed();
