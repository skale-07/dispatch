-- Referral invites (docs/marketing/college-launch.md §4, storefront seam
-- frontend/src/public/referral.ts): a signed-in, onboarded user mints their
-- OWN invite codes for friends, capped server-side, and reads them back
-- through an own-rows view. Operator-minted invites (invites:mint) keep
-- working unchanged: `issued_by` is null for them.
--
-- Every constant the loop depends on lives in referral_settings() so the
-- RPC, the bonus trigger (next migration) and the frontend read one place.

create or replace function public.referral_settings()
returns json
language sql
immutable
as $$
  select json_build_object(
    -- unredeemed codes a user may hold at once (mint refuses past this)
    'max_active_referral_codes', 3,
    -- completed applications each referral code grants the invitee
    'referral_code_quota', 5,
    -- invitee completions that count as an activation (bonus trigger)
    'activation_completed_applications', 5,
    -- inviter's quota bonus per activated invitee (college-launch §4: +10)
    'inviter_bonus_per_activation', 10,
    -- lifetime cap on bonus quota per inviter (college-launch §4: +100)
    'inviter_bonus_cap', 100
  );
$$;

revoke all on function public.referral_settings() from public;
grant execute on function public.referral_settings() to anon, authenticated;

-- Who issued the code. Null = the operator (invites:mint). Set null on
-- account deletion so an issued-but-unredeemed code survives its issuer
-- leaving (the code is still valid; nobody earns a bonus from it).
alter table public.invites
  add column issued_by uuid references auth.users (id) on delete set null;

create index invites_issued_by_idx on public.invites (issued_by);

-- RLS: a user may also SELECT the invites they issued (policies OR
-- together with "own redeemed invite"). Unredeemed codes stay secrets to
-- everyone else; still no client-side insert/update/delete.
create policy "own issued invites"
  on public.invites for select
  to authenticated
  using (issued_by = auth.uid());

-- Own-rows referral view — exactly what InvitePanel reads, plus
-- created_at for ordering. security_invoker: the policy above applies.
create view public.my_referral_invites
  with (security_invoker = true) as
select
  i.code,
  i.max_completed_applications,
  i.redeemed_at,
  i.created_at
from public.invites i
where i.issued_by = auth.uid();

grant select on public.my_referral_invites to authenticated;
revoke all on public.my_referral_invites from anon;

-- Same alphabet as src/cloud/invites.ts (no 0/O, 1/I/L, U): JRA-XXXX-XXXX.
create or replace function public.generate_invite_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  out_code text := 'JRA';
  g integer;
  i integer;
  grp text;
begin
  for g in 1..2 loop
    grp := '';
    for i in 1..4 loop
      grp := grp || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    end loop;
    out_code := out_code || '-' || grp;
  end loop;
  return out_code;
end;
$$;

revoke all on function public.generate_invite_code() from public;

-- Mint one referral code for the caller. Rules:
--   * must be signed in AND an app user (redeemed an invite themselves —
--     referrals come from members, not from anyone with a magic link)
--   * at most max_active_referral_codes UNREDEEMED codes per issuer
--   * quota per code = referral_code_quota; issuer = the calling user
-- Returns the new row's public shape. Error strings are the contract
-- (the frontend matches them verbatim).
create or replace function public.mint_referral_invite()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  s json := public.referral_settings();
  v_cap integer := (s->>'max_active_referral_codes')::integer;
  v_quota integer := (s->>'referral_code_quota')::integer;
  v_active integer;
  v_code text;
  v_attempt integer := 0;
  v_row public.invites%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (select 1 from public.app_users where id = auth.uid()) then
    raise exception 'not a member yet';
  end if;

  -- Serialize per issuer so two concurrent mints cannot both pass the cap.
  perform pg_advisory_xact_lock(hashtext('mint_referral_invite:' || auth.uid()::text));

  select count(*) into v_active
  from public.invites
  where issued_by = auth.uid() and redeemed_by is null;

  if v_active >= v_cap then
    raise exception 'referral cap reached';
  end if;

  loop
    v_attempt := v_attempt + 1;
    v_code := public.generate_invite_code();
    exit when not exists (select 1 from public.invites where code = v_code);
    if v_attempt >= 5 then
      raise exception 'could not allocate a unique code';
    end if;
  end loop;

  insert into public.invites (code, issuer, max_completed_applications, issued_by, note)
  values (v_code, auth.uid()::text, v_quota, auth.uid(), 'referral')
  returning * into v_row;

  return json_build_object(
    'code', v_row.code,
    'max_completed_applications', v_row.max_completed_applications,
    'redeemed_at', v_row.redeemed_at,
    'created_at', v_row.created_at,
    'active_unredeemed', v_active + 1,
    'max_active_referral_codes', v_cap
  );
end;
$$;

revoke all on function public.mint_referral_invite() from public;
revoke all on function public.mint_referral_invite() from anon;
grant execute on function public.mint_referral_invite() to authenticated;

-- redeem_invite, amended for referrals (body otherwise identical to
-- 20260901000300): a member cannot burn a code on themselves (no
-- self-referral bonus, no wasted code) and cannot redeem a second code
-- (quota comes from ONE invite; the bonus loop is the way to earn more).
-- New verbatim error strings: 'cannot redeem your own invite',
-- 'already a member'.
create or replace function public.redeem_invite(invite_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite public.invites%rowtype;
  v_email text;
  v_existing uuid;
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
      return json_build_object(
        'invite_id', v_invite.id,
        'max_completed_applications', v_invite.max_completed_applications
      );
    end if;
    raise exception 'invite already redeemed';
  end if;

  if v_invite.issued_by = auth.uid() then
    raise exception 'cannot redeem your own invite';
  end if;

  select invite_id into v_existing from public.app_users where id = auth.uid();
  if v_existing is not null then
    raise exception 'already a member';
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
