-- Onboarding parity, part 2 of 5: documents as ROWS, not three columns.
--
-- The engine keeps several resume variants (private/candidate/resumes/
-- general_*.pdf, ds_ai_*.pdf; src/candidate/applicationEducation.ts
-- resumeVariantForRole picks 'general' | 'ds_ai' per role) plus one
-- transcript (src/ats/shared/supplementalMaterials.ts). The single
-- resume_object_path column could carry one file; user_documents carries
-- N, each tagged with a variant and the role families it serves.
--
-- Rules:
--   * object_path's first folder is the owner's uid (storage RLS already
--     enforces it on the bucket; the CHECK makes a mismatched row
--     impossible to write even with a bug in the client).
--   * bucket follows kind: transcripts live in 'transcripts', everything
--     else in 'resumes' (policies are per bucket — "a transcript is not a
--     resume" stays true at the policy layer).
--   * one default per (user, kind).
--   * variant vocabulary the engine understands today: 'general',
--     'ds_ai'. Other variants are stored and ignored until the engine
--     grows a family for them — never guessed onto a role.
--
-- Backfill: the legacy resume_*/transcript_* columns become rows
-- (variant 'general', default). The columns stay for one release as a
-- read fallback; the wizard keeps writing them for the general resume.
--
-- complete_my_onboarding() lives here (not in 000200) because it counts
-- user_documents rows.

create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('resume', 'transcript', 'cover_letter')),
  variant text not null default 'general' check (variant ~ '^[a-z0-9_]{1,32}$'),
  bucket text not null check (bucket in ('resumes', 'transcripts')),
  object_path text not null,
  filename text not null,
  role_families text[] not null default '{}',
  is_default boolean not null default false,
  uploaded_at timestamptz not null default now(),
  unique (user_id, kind, variant),
  check (split_part(object_path, '/', 1) = user_id::text),
  check ((kind = 'transcript') = (bucket = 'transcripts'))
);

create unique index if not exists user_documents_one_default
  on public.user_documents (user_id, kind)
  where is_default;

create index if not exists user_documents_user_kind_idx
  on public.user_documents (user_id, kind);

alter table public.user_documents enable row level security;
revoke all on public.user_documents from anon;

drop policy if exists "own documents select" on public.user_documents;
create policy "own documents select"
  on public.user_documents for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "own documents insert" on public.user_documents;
create policy "own documents insert"
  on public.user_documents for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "own documents update" on public.user_documents;
create policy "own documents update"
  on public.user_documents for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own documents delete" on public.user_documents;
create policy "own documents delete"
  on public.user_documents for delete
  to authenticated
  using (user_id = auth.uid());

-- Backfill from the legacy pointer columns (idempotent).
insert into public.user_documents
  (user_id, kind, variant, bucket, object_path, filename, is_default, uploaded_at)
select
  p.user_id, 'resume', 'general', 'resumes', p.resume_object_path,
  coalesce(p.resume_filename, 'resume.pdf'), true,
  coalesce(p.resume_uploaded_at, now())
from public.user_profiles p
where p.resume_object_path is not null
  and split_part(p.resume_object_path, '/', 1) = p.user_id::text
on conflict (user_id, kind, variant) do nothing;

insert into public.user_documents
  (user_id, kind, variant, bucket, object_path, filename, is_default, uploaded_at)
select
  p.user_id, 'transcript', 'general', 'transcripts', p.transcript_object_path,
  coalesce(p.transcript_filename, 'transcript.pdf'), true,
  coalesce(p.transcript_uploaded_at, now())
from public.user_profiles p
where p.transcript_object_path is not null
  and split_part(p.transcript_object_path, '/', 1) = p.user_id::text
on conflict (user_id, kind, variant) do nothing;

-- Server-side completeness. SECURITY INVOKER: RLS applies, the caller can
-- only ever complete their own row. Never raises for incompleteness —
-- it RETURNS what is missing so the Review step can name it. Stamps
-- onboarding_completed_at (the engine's "act on this profile" gate)
-- only when nothing is missing, and never moves an existing stamp.
--
-- Required for a HEADLESS engine (there is no "ask me per application"
-- once nobody is watching): legal first/last name, phone, city+country,
-- at least one education entry, at least one resume document,
-- work_authorization + needs_sponsorship answered, about_me of at least
-- 80 characters (tryLoadAboutMe's own floor), at least one target title.
create or replace function public.complete_my_onboarding()
returns json
language plpgsql
security invoker
set search_path = public
as $$
declare
  p public.user_profiles%rowtype;
  missing text[] := '{}';
  v_resumes integer := 0;
  v_titles jsonb;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into p from public.user_profiles where user_id = auth.uid();
  if not found then
    return json_build_object('complete', false, 'missing', to_json(array['profile']));
  end if;

  if coalesce(p.legal_first_name, '') = '' then missing := missing || 'legal_first_name'; end if;
  if coalesce(p.legal_last_name, '') = '' then missing := missing || 'legal_last_name'; end if;
  if coalesce(p.phone, '') = '' then missing := missing || 'phone'; end if;
  if coalesce(p.location_city, '') = '' then missing := missing || 'location_city'; end if;
  if coalesce(p.location_country, '') = '' then missing := missing || 'location_country'; end if;
  if jsonb_typeof(p.education) <> 'array' or jsonb_array_length(p.education) = 0 then
    missing := missing || 'education';
  end if;

  select count(*) into v_resumes
  from public.user_documents d
  where d.user_id = auth.uid() and d.kind = 'resume';
  if v_resumes = 0 then missing := missing || 'resume'; end if;

  if p.work_authorization is null then missing := missing || 'work_authorization'; end if;
  if p.needs_sponsorship is null then missing := missing || 'needs_sponsorship'; end if;
  if length(coalesce(p.about_me, '')) < 80 then missing := missing || 'about_me'; end if;

  v_titles := p.job_preferences -> 'titles';
  if v_titles is null or jsonb_typeof(v_titles) <> 'array' or jsonb_array_length(v_titles) = 0 then
    missing := missing || 'job_preferences.titles';
  end if;

  if cardinality(missing) = 0 then
    update public.user_profiles
    set onboarding_completed_at = coalesce(onboarding_completed_at, now())
    where user_id = auth.uid();
  end if;

  return json_build_object('complete', cardinality(missing) = 0, 'missing', to_json(missing));
end;
$$;

revoke all on function public.complete_my_onboarding() from public;
revoke all on function public.complete_my_onboarding() from anon;
grant execute on function public.complete_my_onboarding() to authenticated;
