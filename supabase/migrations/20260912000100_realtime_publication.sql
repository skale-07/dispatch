-- Realtime for the dashboard's "needs you" panel and the engine line.
--
-- The hosted dashboard shows a handoff task the moment the engine opens
-- one, and the engine heartbeat as it ticks, without polling
-- (frontend/src/public/dashboard/NeedsYouPanel.tsx subscribes to
-- postgres_changes; a manual refresh remains). Supabase Realtime only
-- streams tables in the `supabase_realtime` publication, and RLS still
-- decides which rows a client may receive — every table below already
-- carries an own-row select policy, so a user only ever hears about
-- their own rows.
--
-- Idempotent: adding a table that is already published raises, so each
-- is guarded by a lookup in pg_publication_tables. Nothing here grants
-- anything; no client policy changes.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    -- Hosted Supabase always ships it; a local stack without it simply
    -- has no realtime, and the dashboard's manual refresh carries.
    raise notice 'publication supabase_realtime not present — realtime skipped';
    return;
  end if;
  foreach t in array array['handoff_tasks', 'engine_status', 'engine_jobs'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
