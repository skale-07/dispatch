-- Part 2 of 2 (see 20260903000100): the private transcripts bucket.
--
-- Split from part 1 because the combined file deadlocked on first apply
-- (2026-09-03): one transaction holding an AccessExclusiveLock on
-- public.user_profiles while also touching storage.objects raced
-- PostgREST's schema introspection. Storage DDL now runs alone.
--
-- Its own bucket rather than a prefix inside `resumes`: storage policies
-- are per-bucket, so a separate bucket is what keeps "a transcript is not
-- a resume" true at the policy layer instead of by convention. Path
-- convention is identical to resumes — transcripts/{user_id}/{filename},
-- first folder MUST be the owner's uid.

insert into storage.buckets (id, name, public)
values ('transcripts', 'transcripts', false)
on conflict (id) do nothing;

-- Idempotent: a failed apply must be safe to re-run. `create policy` has
-- no IF NOT EXISTS, so each is dropped first.
drop policy if exists "own transcript read" on storage.objects;
create policy "own transcript read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'transcripts'
         and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own transcript upload" on storage.objects;
create policy "own transcript upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'transcripts'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own transcript update" on storage.objects;
create policy "own transcript update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'transcripts'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'transcripts'
              and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own transcript delete" on storage.objects;
create policy "own transcript delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'transcripts'
         and (storage.foldername(name))[1] = auth.uid()::text);
