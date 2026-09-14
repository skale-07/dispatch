-- Per-user Gmail, drafts only (plan v0.5, M19).
--
-- The web app runs a PKCE consent with Dispatch's own Web OAuth client for
-- exactly two scopes — gmail.readonly (ATS verification codes) and
-- gmail.compose (referral DRAFTS) — and hands the authorization code to the
-- engine through this table. The ENGINE exchanges it (it holds the client
-- secret; the browser never does), refuses any grant outside those two
-- scopes, stores the refresh token as ciphertext through
-- engine_store_integration_secret (20260911000700), and deletes the
-- request. Nothing here can send mail: the token's scopes cannot include
-- gmail.send (the user_integrations CHECK), and the engine's own guards
-- ban every send endpoint (src/gmail/readonlyGuards.ts, check-forbidden).
--
-- Data boundary:
--   * gmail_oauth_requests holds a short-lived code + PKCE verifier. No
--     client may read it back; the user may only INSERT through
--     submit_gmail_oauth_code(). A request older than 15 minutes is dead
--     (Google's codes expire in ~10) and the engine deletes it unexchanged.
--   * One request per user; a second submission replaces the first.
--   * The engine_jobs row it enqueues is kind 'gmail_exchange' (already a
--     legal kind in 20260911000800).

create table if not exists public.gmail_oauth_requests (
  user_id uuid primary key references auth.users (id) on delete cascade,
  code text not null,
  code_verifier text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now()
);

alter table public.gmail_oauth_requests enable row level security;
revoke all on public.gmail_oauth_requests from anon, authenticated;
-- No policies for authenticated: the row is written by the RPC below
-- (security definer) and read only by the service role.

create or replace function public.submit_gmail_oauth_code(
  p_code text, p_code_verifier text, p_redirect_uri text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if coalesce(p_code, '') = '' or coalesce(p_code_verifier, '') = '' then
    raise exception 'code and code_verifier are required';
  end if;
  if coalesce(p_redirect_uri, '') = '' or p_redirect_uri !~ '^https?://' then
    raise exception 'redirect_uri must be an absolute http(s) URL';
  end if;

  insert into public.gmail_oauth_requests (user_id, code, code_verifier, redirect_uri, created_at)
  values (auth.uid(), p_code, p_code_verifier, p_redirect_uri, now())
  on conflict (user_id) do update
    set code = excluded.code,
        code_verifier = excluded.code_verifier,
        redirect_uri = excluded.redirect_uri,
        created_at = now();

  -- The dashboard shows "connecting…" until the engine exchanges the code.
  insert into public.user_integrations (user_id, provider, status)
  values (auth.uid(), 'gmail', 'pending_handoff')
  on conflict (user_id, provider) do update
    set status = case
      when public.user_integrations.status = 'connected' then 'connected'
      else 'pending_handoff'
    end;

  select id into v_job
  from public.engine_jobs
  where user_id = auth.uid() and kind = 'gmail_exchange' and status in ('queued', 'leased');
  if not found then
    insert into public.engine_jobs (user_id, kind, payload)
    values (auth.uid(), 'gmail_exchange', '{}'::jsonb)
    returning id into v_job;
  end if;

  return json_build_object('job_id', v_job, 'status', 'pending_handoff');
end;
$$;

revoke all on function public.submit_gmail_oauth_code(text, text, text) from public;
revoke all on function public.submit_gmail_oauth_code(text, text, text) from anon;
grant execute on function public.submit_gmail_oauth_code(text, text, text) to authenticated;
