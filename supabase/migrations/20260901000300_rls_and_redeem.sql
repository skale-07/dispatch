-- Cloud plane v0: row-level security + the atomic redeem_invite RPC.
--
-- Model: anon/authenticated clients (the frontend, shipping the anon key)
-- can ONLY (a) insert into waitlist, (b) read their own rows, (c) call
-- redeem_invite. Every write path to invites/app_users/mirror belongs to
-- the service role (engine sync worker + operator), which bypasses RLS.

alter table public.invites enable row level security;
alter table public.app_users enable row level security;
alter table public.waitlist enable row level security;
alter table public.application_status_mirror enable row level security;

-- Belt and braces on top of RLS: strip Supabase's default table grants so
-- client roles cannot even attempt forbidden verbs.
revoke insert, update, delete on public.invites from anon, authenticated;
revoke insert, update, delete on public.app_users from anon, authenticated;
revoke insert, update, delete on public.application_status_mirror
  from anon, authenticated;
revoke select, update, delete on public.waitlist from anon, authenticated;
revoke all on public.invites from anon;
revoke all on public.app_users from anon;
revoke all on public.application_status_mirror from anon;

-- Users see only their own profile row.
create policy "own profile"
  on public.app_users for select
  to authenticated
  using (id = auth.uid());

-- Only YOUR redeemed invite is visible (shows your quota). Unredeemed
-- codes are secrets: no policy exposes them, so they are unlistable.
create policy "own redeemed invite"
  on public.invites for select
  to authenticated
  using (redeemed_by = auth.uid());

-- Status mirror: strictly your own rows.
create policy "own application statuses"
  on public.application_status_mirror for select
  to authenticated
  using (user_id = auth.uid());

-- Waitlist: anyone may join; nobody (client-side) may read or edit it.
create policy "join waitlist"
  on public.waitlist for insert
  to anon, authenticated
  with check (true);

-- Atomic, once-only invite redemption. SECURITY DEFINER so it can see and
-- update the invite row despite RLS; FOR UPDATE serializes racers so a
-- code can never be redeemed twice. Idempotent for the same user.
create or replace function public.redeem_invite(invite_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites%rowtype;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_invite
  from public.invites
  where code = upper(trim(invite_code))
  for update;

  if not found then
    raise exception 'invalid invite code';
  end if;

  if v_invite.redeemed_by is not null then
    if v_invite.redeemed_by = auth.uid() then
      -- Same user re-submitting the form: succeed idempotently.
      return json_build_object(
        'invite_id', v_invite.id,
        'max_completed_applications', v_invite.max_completed_applications
      );
    end if;
    raise exception 'invite already redeemed';
  end if;

  select email into v_email from auth.users where id = auth.uid();

  update public.invites
  set redeemed_by = auth.uid(), redeemed_at = now()
  where id = v_invite.id;

  insert into public.app_users (id, email, invite_id)
  values (auth.uid(), coalesce(v_email, ''), v_invite.id)
  on conflict (id) do update
    set invite_id = coalesce(public.app_users.invite_id, excluded.invite_id);

  return json_build_object(
    'invite_id', v_invite.id,
    'max_completed_applications', v_invite.max_completed_applications
  );
end;
$$;

revoke all on function public.redeem_invite(text) from public;
revoke all on function public.redeem_invite(text) from anon;
grant execute on function public.redeem_invite(text) to authenticated;

grant select on public.user_quota_status to authenticated;
revoke all on public.user_quota_status from anon;
