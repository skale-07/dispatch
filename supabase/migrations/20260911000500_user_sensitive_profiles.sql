-- Opt-in self-identification (EEO) profile — POLICY RECORD.
--
-- Operator decision 2026-09-11: this REVERSES the 2026-09-01 directive
-- ("no EEO/demographic column in the cloud plane, none ever should be",
-- restated in 20260903000100). The product is now a hosted app whose
-- engine applies for users headlessly; a user who WANTS their
-- self-identification answers placed on forms has no local encrypted
-- file to keep them in. So the cloud holds them — under the strictest
-- rules in this schema:
--
--   * OPT-IN. Nothing exists until the user ticks consent; the wizard
--     step is off by default and can be cleared at any time.
--   * PER-FIELD CHOICE. Each field is 'answer' (a verbatim value the
--     engine places), 'prefer_not' (an ANSWER — the engine picks the
--     form's own "decline to self-identify" option), or 'skip' (blank;
--     the question becomes a per-application to-do). Nothing is ever
--     inferred or defaulted — the same rule the engine applies to its
--     operator's sensitive-profile.enc.
--   * ENCRYPTED, RPC-ONLY. Values are pgcrypto ciphertext under a
--     per-(user,purpose) key derived from the in-DB Vault KEK
--     (20260911000450). The table has NO policies for authenticated or
--     anon and no view — the only paths in are the four functions below.
--     The engine (service role) reads a user's row solely through
--     engine_read_sensitive_profile() and re-encrypts it into that
--     tenant's workspace; it never lands in a plaintext snapshot.
--   * NEVER AGGREGATED. The only non-secret column is answered_keys —
--     field NAMES the user made a choice on (answer or prefer_not),
--     never values — so the Review step and the suggestion engine can
--     say "self-ID: set" without decrypting anything.
--
-- The engine-side contract is src/candidate/sensitiveProfile.ts
-- (sensitiveProfileSchema). sensitive_profile_fields() lists the same
-- nine keys; a unit test parses both and fails on drift.

create table if not exists public.user_sensitive_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  ciphertext bytea not null,
  key_version integer not null default 1,
  -- names only, NEVER values
  answered_keys text[] not null default '{}',
  consent_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists user_sensitive_profiles_updated_at on public.user_sensitive_profiles;
create trigger user_sensitive_profiles_updated_at
  before update on public.user_sensitive_profiles
  for each row execute function public.set_updated_at();

alter table public.user_sensitive_profiles enable row level security;
-- No policies on purpose: RPC-only.
revoke all on public.user_sensitive_profiles from anon, authenticated;

create or replace function public.sensitive_profile_fields()
returns text[]
language sql
immutable
as $$
  select array[
    'gender_identity',
    'gender',
    'race_ethnicity',
    'sexual_orientation',
    'hispanic_latino',
    'transgender',
    'veteran_status',
    'disability_status',
    'pronouns'
  ]::text[];
$$;

revoke all on function public.sensitive_profile_fields() from public;
grant execute on function public.sensitive_profile_fields() to anon, authenticated;

-- Validate + encrypt + upsert the caller's profile. Plaintext contract:
--   { consent: true,
--     fields: { <field>: { choice: 'answer'|'prefer_not'|'skip', value } },
--     self_identification_preferences?: object }
-- race_ethnicity.value is a string array; every other value is a string.
-- choice='answer' requires a non-empty value. Unknown field => error.
create or replace function public.save_my_sensitive_profile(p_profile jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fields text[] := public.sensitive_profile_fields();
  v_key text;
  v_entry jsonb;
  v_choice text;
  v_value jsonb;
  v_answered text[] := '{}';
  v_clean jsonb := '{}'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_profile is null or jsonb_typeof(p_profile) <> 'object' then
    raise exception 'profile must be an object';
  end if;
  if coalesce((p_profile->>'consent')::boolean, false) is not true then
    raise exception 'consent required';
  end if;
  if p_profile->'fields' is null or jsonb_typeof(p_profile->'fields') <> 'object' then
    raise exception 'fields must be an object';
  end if;

  for v_key in select jsonb_object_keys(p_profile->'fields') loop
    if not (v_key = any (v_fields)) then
      raise exception 'unknown sensitive field: %', v_key;
    end if;
    v_entry := p_profile->'fields'->v_key;
    v_choice := v_entry->>'choice';
    v_value := v_entry->'value';
    if v_choice not in ('answer', 'prefer_not', 'skip') then
      raise exception 'field % has an invalid choice', v_key;
    end if;
    if v_choice = 'answer' then
      if v_key = 'race_ethnicity' then
        if v_value is null or jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) = 0 then
          raise exception 'race_ethnicity answer must be a non-empty array';
        end if;
      elsif v_value is null or jsonb_typeof(v_value) <> 'string' or length(v_value #>> '{}') = 0 then
        raise exception 'field % answer must be a non-empty string', v_key;
      end if;
      v_clean := v_clean || jsonb_build_object(v_key, jsonb_build_object('choice', 'answer', 'value', v_value));
      v_answered := v_answered || v_key;
    elsif v_choice = 'prefer_not' then
      v_clean := v_clean || jsonb_build_object(v_key, jsonb_build_object('choice', 'prefer_not', 'value', null));
      v_answered := v_answered || v_key;
    else
      v_clean := v_clean || jsonb_build_object(v_key, jsonb_build_object('choice', 'skip', 'value', null));
    end if;
  end loop;

  v_clean := jsonb_build_object(
    'consent', true,
    'fields', v_clean,
    'self_identification_preferences',
      case
        when jsonb_typeof(p_profile->'self_identification_preferences') = 'object'
          then p_profile->'self_identification_preferences'
        else '{}'::jsonb
      end
  );

  insert into public.user_sensitive_profiles (user_id, ciphertext, key_version, answered_keys, consent_at)
  values (
    auth.uid(),
    public._dispatch_encrypt(auth.uid(), 'sensitive_profile', v_clean::text),
    public.dispatch_key_version(),
    v_answered,
    now()
  )
  on conflict (user_id) do update
    set ciphertext = excluded.ciphertext,
        key_version = excluded.key_version,
        answered_keys = excluded.answered_keys,
        consent_at = coalesce(public.user_sensitive_profiles.consent_at, excluded.consent_at);

  return json_build_object('saved', true, 'answered_keys', to_json(v_answered));
end;
$$;

revoke all on function public.save_my_sensitive_profile(jsonb) from public;
revoke all on function public.save_my_sensitive_profile(jsonb) from anon;
grant execute on function public.save_my_sensitive_profile(jsonb) to authenticated;

-- The caller's own plaintext, or null when none.
create or replace function public.get_my_sensitive_profile()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_cipher bytea;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select ciphertext into v_cipher
  from public.user_sensitive_profiles
  where user_id = auth.uid();
  if v_cipher is null then
    return null;
  end if;
  return public._dispatch_decrypt(auth.uid(), 'sensitive_profile', v_cipher)::jsonb;
end;
$$;

revoke all on function public.get_my_sensitive_profile() from public;
revoke all on function public.get_my_sensitive_profile() from anon;
grant execute on function public.get_my_sensitive_profile() to authenticated;

create or replace function public.clear_my_sensitive_profile()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  delete from public.user_sensitive_profiles where user_id = auth.uid();
  get diagnostics v_rows = row_count;
  return json_build_object('cleared', v_rows > 0);
end;
$$;

revoke all on function public.clear_my_sensitive_profile() from public;
revoke all on function public.clear_my_sensitive_profile() from anon;
grant execute on function public.clear_my_sensitive_profile() to authenticated;

-- Engine (service role) read for ONE user; null when none. The caller
-- writes the result straight into an encrypted workspace file.
create or replace function public.engine_read_sensitive_profile(p_user uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_cipher bytea;
begin
  if p_user is null then
    return null;
  end if;
  select ciphertext into v_cipher
  from public.user_sensitive_profiles
  where user_id = p_user;
  if v_cipher is null then
    return null;
  end if;
  return public._dispatch_decrypt(p_user, 'sensitive_profile', v_cipher)::jsonb;
end;
$$;

revoke all on function public.engine_read_sensitive_profile(uuid) from public;
revoke all on function public.engine_read_sensitive_profile(uuid) from anon, authenticated;
grant execute on function public.engine_read_sensitive_profile(uuid) to service_role;
