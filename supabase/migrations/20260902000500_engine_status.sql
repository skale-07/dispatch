-- Engine heartbeat: one row per user, upserted by the engine-side sync
-- worker (src/cloud/syncSupabase.ts, SUPABASE_SYNC_ENABLED, service role)
-- on EVERY sync tick — including ticks that had nothing to push — so the
-- dashboard can show a real "engine running" indicator instead of
-- inferring it from application timestamps.
--
-- Data boundary: timestamps, counts and a git short-sha. No hostnames,
-- no paths, no candidate data. The cloud never writes this; the engine
-- never reads it.

create table public.engine_status (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- when the worker last completed a tick for this user
  last_seen_at timestamptz not null default now(),
  -- git short-sha of the engine code (src/storage/codeVersion.ts)
  engine_version text,
  -- what the tick did (status mirror push)
  last_sync_attempted integer not null default 0,
  last_sync_upserted integer not null default 0,
  last_sync_duration_ms integer not null default 0,
  -- error text when the tick failed AFTER the heartbeat (never a key)
  last_error text
);

alter table public.engine_status enable row level security;
revoke all on public.engine_status from anon;
revoke insert, update, delete on public.engine_status from authenticated;

create policy "own engine status"
  on public.engine_status for select
  to authenticated
  using (user_id = auth.uid());
