-- v0 public app: private storage buckets + submission receipt rows.
--
-- Buckets (both PRIVATE — nothing is publicly readable):
--   resumes  — written by the USER (wizard upload), path `{uid}/...`;
--              read by the user and by the engine (service role).
--   receipts — written ONLY by the engine (service role uploads the
--              submission screenshot); the user can read their own.
--
-- Path convention (enforced by the policies below): the FIRST folder of
-- every object name is the owner's auth.users uuid.
--   resumes/{user_id}/{filename}
--   receipts/{user_id}/{engine_application_id}/{attempt}.png

insert into storage.buckets (id, name, public)
values ('resumes', 'resumes', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

-- Resumes: the user manages files under their own uid prefix.
create policy "own resume read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'resumes'
         and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own resume upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'resumes'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own resume update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'resumes'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'resumes'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "own resume delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'resumes'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- Receipts: read-only for the owner. Deliberately NO insert/update/delete
-- policy for authenticated — only the engine's service role (which
-- bypasses RLS) writes receipt objects.
create policy "own receipts read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'receipts'
         and (storage.foldername(name))[1] = auth.uid()::text);

-- Receipt metadata rows: what the dashboard lists (the image itself is
-- fetched from storage via a signed URL / storage download under the
-- read policy above). Written only by the engine (service role).
create table public.application_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  engine_application_id text not null,
  submission_attempt integer not null default 1,
  object_path text not null,
  submitted_at timestamptz,
  confirmation_url text,
  application_identifier text,
  created_at timestamptz not null default now(),
  unique (user_id, engine_application_id, submission_attempt)
);

create index application_receipts_user_idx
  on public.application_receipts (user_id, created_at desc);

alter table public.application_receipts enable row level security;

create policy "own receipts rows"
  on public.application_receipts for select
  to authenticated
  using (user_id = auth.uid());

revoke insert, update, delete on public.application_receipts
  from anon, authenticated;
revoke all on public.application_receipts from anon;

-- Dashboard convenience view (storefront contract): one row per mirrored
-- application with the LATEST receipt attached. security_invoker, so the
-- underlying RLS scopes it to the caller's own rows.
create view public.my_applications
  with (security_invoker = true) as
select
  m.engine_application_id as id,
  m.company,
  m.role,
  m.state as status,
  m.route,
  m.source_ats,
  m.engine_updated_at,
  r.submitted_at,
  r.object_path as receipt_path
from public.application_status_mirror m
left join lateral (
  select rr.submitted_at, rr.object_path
  from public.application_receipts rr
  where rr.user_id = m.user_id
    and rr.engine_application_id = m.engine_application_id
  order by rr.submission_attempt desc
  limit 1
) r on true;

grant select on public.my_applications to authenticated;
revoke all on public.my_applications from anon;
