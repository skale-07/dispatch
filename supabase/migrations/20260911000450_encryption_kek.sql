-- Encryption at rest for per-user secrets (integration tokens/sessions in
-- 000700; the opt-in self-identification profile in 000500). Shared
-- bootstrap so both use one key-management story.
--
-- Model (decision 2026-09-11, docs/roadmap/cloud-deploy.md):
--   * KEK: one random 32-byte key generated INSIDE the database and
--     stored in Supabase Vault. Nobody — repo, operator, agent, client —
--     ever sees it; only SECURITY DEFINER functions owned by the
--     migration role read vault.decrypted_secrets.
--   * DEK per (user, purpose): HMAC-SHA256(KEK, user_id || ':' || purpose).
--     Derived on use, never stored, so a leaked ciphertext column is
--     useless without the vault AND the user id AND the purpose.
--   * Ciphertext: pgp_sym_encrypt(plaintext, dek, aes256) as bytea, with
--     a key_version column on each table for rotation.
--   * Access is RPC-only. Tables that hold ciphertext grant NO select on
--     the ciphertext column to authenticated (or no policies at all);
--     the service role reaches plaintext only through engine_* functions.
--
-- Why not pgsodium TCE: deprecated on new projects, and column-level
-- transparent decryption hands plaintext to any service-role SELECT —
-- the exact "shows up in an aggregate by accident" path this design
-- closes. Why not client-side public-key encryption: the user could
-- never read their own answers back under magic-link auth. Dual-wrapping
-- the DEK for a per-tenant engine key is the v1 hardening path and slots
-- in here without changing callers.

create extension if not exists pgcrypto with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'dispatch_kek_v1') then
    perform vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'hex'),
      'dispatch_kek_v1',
      'Dispatch per-user secret KEK v1 (generated in-DB 2026-09-11; never exported)'
    );
  end if;
end
$$;

-- Private helper: the current KEK version and the derived DEK for one
-- (user, purpose). Not callable by any API role.
create or replace function public._dispatch_dek(p_user uuid, p_purpose text)
returns text
language plpgsql
security definer
stable
set search_path = public, extensions, vault
as $$
declare
  v_kek text;
begin
  if p_user is null or coalesce(p_purpose, '') = '' then
    raise exception 'dek requires a user and a purpose';
  end if;
  select decrypted_secret into v_kek
  from vault.decrypted_secrets
  where name = 'dispatch_kek_v1'
  limit 1;
  if v_kek is null then
    raise exception 'encryption key not provisioned';
  end if;
  return encode(extensions.hmac(p_user::text || ':' || p_purpose, v_kek, 'sha256'), 'hex');
end;
$$;

revoke all on function public._dispatch_dek(uuid, text) from public;
revoke all on function public._dispatch_dek(uuid, text) from anon, authenticated;

create or replace function public._dispatch_encrypt(p_user uuid, p_purpose text, p_plain text)
returns bytea
language sql
security definer
stable
set search_path = public, extensions
as $$
  select extensions.pgp_sym_encrypt(
    p_plain,
    public._dispatch_dek(p_user, p_purpose),
    'cipher-algo=aes256, compress-algo=0'
  );
$$;

revoke all on function public._dispatch_encrypt(uuid, text, text) from public;
revoke all on function public._dispatch_encrypt(uuid, text, text) from anon, authenticated;

create or replace function public._dispatch_decrypt(p_user uuid, p_purpose text, p_cipher bytea)
returns text
language sql
security definer
stable
set search_path = public, extensions
as $$
  select extensions.pgp_sym_decrypt(p_cipher, public._dispatch_dek(p_user, p_purpose));
$$;

revoke all on function public._dispatch_decrypt(uuid, text, bytea) from public;
revoke all on function public._dispatch_decrypt(uuid, text, bytea) from anon, authenticated;

-- Current key version, for the key_version columns.
create or replace function public.dispatch_key_version()
returns integer
language sql
immutable
as $$ select 1 $$;

revoke all on function public.dispatch_key_version() from public;
grant execute on function public.dispatch_key_version() to authenticated;
