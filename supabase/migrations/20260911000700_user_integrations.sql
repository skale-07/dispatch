-- Onboarding parity, part 5 of 5: per-user integrations.
--
--   jobright — the USER'S OWN JobRight account (operator directive
--              2026-09-11: never the operator's; JobRight's per-user
--              filters are the discovery signal). Connected through a
--              Dispatch-launched browser the user drives (handoff_tasks,
--              20260911000800); the captured session is the secret.
--   gmail    — OAuth refresh token with gmail.readonly + gmail.compose
--              (ATS verification codes + DRAFTS; never send). Required
--              for autonomous runs; drafting additionally requires
--              jobright premium.
--
-- Secrets are ciphertext (20260911000450) and RPC-only: authenticated
-- has column-level SELECT on the non-secret columns only, and the
-- service role reaches plaintext solely through engine_* functions.
-- Users may set `premium` (self-reported) and disconnect; every other
-- write is the engine's.

create table if not exists public.user_integrations (
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('jobright', 'gmail')),
  status text not null default 'disconnected'
    check (status in ('disconnected', 'pending_handoff', 'connected', 'expired', 'revoked')),
  account_email text,
  -- jobright: self-reported JobRight Premium; the engine may overwrite
  -- from a read-only probe (never downgrades a self-report to false).
  premium boolean,
  -- gmail: granted scopes; must stay within the two the product uses.
  scopes text[] not null default '{}',
  connected_at timestamptz,
  expires_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  secret_ciphertext bytea,
  secret_key_version integer,
  secret_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  check (
    provider <> 'gmail'
    or scopes <@ array[
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose'
    ]::text[]
  )
);

drop trigger if exists user_integrations_updated_at on public.user_integrations;
create trigger user_integrations_updated_at
  before update on public.user_integrations
  for each row execute function public.set_updated_at();

alter table public.user_integrations enable row level security;
revoke all on public.user_integrations from anon, authenticated;
grant select (
  user_id, provider, status, account_email, premium, scopes,
  connected_at, expires_at, last_checked_at, last_error, updated_at
) on public.user_integrations to authenticated;

drop policy if exists "own integrations select" on public.user_integrations;
create policy "own integrations select"
  on public.user_integrations for select
  to authenticated
  using (user_id = auth.uid());

-- The frontend's read model: never a secret column.
create view public.my_integrations
  with (security_invoker = true) as
select
  user_id, provider, status, account_email, premium, scopes,
  connected_at, expires_at, last_checked_at, last_error, updated_at
from public.user_integrations
where user_id = auth.uid();

grant select on public.my_integrations to authenticated;
revoke all on public.my_integrations from anon;

-- User-side writes: only `premium` and a disconnect. Upserts the row so
-- a self-report before the connect flow is legal.
create or replace function public.set_my_integration(p_provider text, p_patch jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_premium boolean;
  v_disconnect boolean;
  v_row public.user_integrations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_provider not in ('jobright', 'gmail') then
    raise exception 'unknown provider';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'patch must be an object';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) k where k not in ('premium', 'disconnect')
  ) then
    raise exception 'patch may only set premium or disconnect';
  end if;

  v_premium := case when p_patch ? 'premium' then (p_patch->>'premium')::boolean end;
  v_disconnect := coalesce((p_patch->>'disconnect')::boolean, false);

  insert into public.user_integrations (user_id, provider, premium)
  values (auth.uid(), p_provider, v_premium)
  on conflict (user_id, provider) do update
    set premium = coalesce(excluded.premium, public.user_integrations.premium);

  if v_disconnect then
    update public.user_integrations
    set status = 'disconnected',
        secret_ciphertext = null,
        secret_key_version = null,
        secret_updated_at = null,
        connected_at = null,
        expires_at = null
    where user_id = auth.uid() and provider = p_provider;
  end if;

  select * into v_row
  from public.user_integrations
  where user_id = auth.uid() and provider = p_provider;

  return json_build_object(
    'provider', v_row.provider,
    'status', v_row.status,
    'premium', v_row.premium,
    'connected_at', v_row.connected_at
  );
end;
$$;

revoke all on function public.set_my_integration(text, jsonb) from public;
revoke all on function public.set_my_integration(text, jsonb) from anon;
grant execute on function public.set_my_integration(text, jsonb) to authenticated;

-- ── engine (service role) functions ──────────────────────────────────
-- Each refuses on bad input BEFORE touching a row, so the read-only
-- schema probe (cloud:schema -- verify) can call them with empty /
-- nil arguments and classify the refusal as "present".

create or replace function public.engine_store_integration_secret(
  p_user uuid, p_provider text, p_secret text, p_meta jsonb default '{}'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(p_secret, '') = '' then
    raise exception 'empty secret';
  end if;
  if p_provider not in ('jobright', 'gmail') then
    raise exception 'unknown provider';
  end if;
  if not exists (select 1 from public.app_users where id = p_user) then
    raise exception 'unknown user';
  end if;

  insert into public.user_integrations (
    user_id, provider, status, account_email, scopes, connected_at, expires_at,
    last_checked_at, last_error, secret_ciphertext, secret_key_version, secret_updated_at
  )
  values (
    p_user, p_provider, 'connected',
    nullif(p_meta->>'account_email', ''),
    coalesce(array(select jsonb_array_elements_text(coalesce(p_meta->'scopes', '[]'::jsonb))), '{}'),
    now(),
    (p_meta->>'expires_at')::timestamptz,
    now(), null,
    public._dispatch_encrypt(p_user, p_provider, p_secret),
    public.dispatch_key_version(),
    now()
  )
  on conflict (user_id, provider) do update
    set status = 'connected',
        account_email = coalesce(excluded.account_email, public.user_integrations.account_email),
        scopes = case when cardinality(excluded.scopes) > 0 then excluded.scopes else public.user_integrations.scopes end,
        connected_at = now(),
        expires_at = excluded.expires_at,
        last_checked_at = now(),
        last_error = null,
        secret_ciphertext = excluded.secret_ciphertext,
        secret_key_version = excluded.secret_key_version,
        secret_updated_at = now();

  return json_build_object('stored', true, 'provider', p_provider, 'key_version', public.dispatch_key_version());
end;
$$;

revoke all on function public.engine_store_integration_secret(uuid, text, text, jsonb) from public;
revoke all on function public.engine_store_integration_secret(uuid, text, text, jsonb) from anon, authenticated;
grant execute on function public.engine_store_integration_secret(uuid, text, text, jsonb) to service_role;

create or replace function public.engine_read_integration_secret(p_user uuid, p_provider text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_cipher bytea;
begin
  select secret_ciphertext into v_cipher
  from public.user_integrations
  where user_id = p_user and provider = p_provider;
  if v_cipher is null then
    return null;
  end if;
  return public._dispatch_decrypt(p_user, p_provider, v_cipher);
end;
$$;

revoke all on function public.engine_read_integration_secret(uuid, text) from public;
revoke all on function public.engine_read_integration_secret(uuid, text) from anon, authenticated;
grant execute on function public.engine_read_integration_secret(uuid, text) to service_role;

create or replace function public.engine_set_integration_status(
  p_user uuid, p_provider text, p_status text, p_meta jsonb default '{}'::jsonb
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_provider not in ('jobright', 'gmail') then
    raise exception 'unknown provider';
  end if;
  if p_status not in ('disconnected', 'pending_handoff', 'connected', 'expired', 'revoked') then
    raise exception 'unknown status';
  end if;
  if not exists (select 1 from public.app_users where id = p_user) then
    raise exception 'unknown user';
  end if;

  insert into public.user_integrations (user_id, provider, status, last_checked_at, last_error, premium)
  values (
    p_user, p_provider, p_status, now(),
    nullif(p_meta->>'last_error', ''),
    case when p_meta ? 'premium' then (p_meta->>'premium')::boolean end
  )
  on conflict (user_id, provider) do update
    set status = excluded.status,
        last_checked_at = now(),
        last_error = excluded.last_error,
        -- a probe may promote premium to true, never demote a self-report
        premium = case
          when excluded.premium is true then true
          else public.user_integrations.premium
        end,
        secret_ciphertext = case
          when excluded.status in ('disconnected', 'revoked') then null
          else public.user_integrations.secret_ciphertext
        end;

  return json_build_object('provider', p_provider, 'status', p_status);
end;
$$;

revoke all on function public.engine_set_integration_status(uuid, text, text, jsonb) from public;
revoke all on function public.engine_set_integration_status(uuid, text, text, jsonb) from anon, authenticated;
grant execute on function public.engine_set_integration_status(uuid, text, text, jsonb) to service_role;
