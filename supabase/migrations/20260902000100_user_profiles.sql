-- v0 public app (operator direction 2026-09-01): onboarding wizard writes a
-- real user profile. USER-SUBMITTED data belongs in the cloud plane — the
-- unchanged invariant is that the OPERATOR'S local private/ contents and
-- ATS credentials never do.
--
-- Contract owner: launcher. The storefront wizard reads/writes exactly
-- these columns under RLS (own row only). The engine pulls onboarded
-- profiles with the service-role key (cloud:sync pull) to act on them.

create table public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Step 1: identity / contact
  full_name text,
  phone text,
  location_city text,
  location_region text,
  location_country text,
  linkedin_url text,
  github_url text,
  portfolio_url text,
  -- Step 2: education — array of objects:
  --   { school, degree, field, start_year, end_year, gpa? }
  education jsonb not null default '[]'::jsonb
    check (jsonb_typeof(education) = 'array'),
  -- Step 3: work authorization. SELF-REPORTED by the user in the wizard,
  -- never inferred or defaulted (same rule as the engine's sensitive
  -- profile). Null until the user answers.
  work_authorization text
    check (work_authorization in
      ('us_citizen', 'permanent_resident', 'visa_holder',
       'needs_sponsorship', 'other')),
  needs_sponsorship boolean,
  -- Step 4: resume — object path inside the private `resumes` bucket
  -- (see the storage migration; path prefix must be the user's own uid).
  resume_object_path text,
  resume_filename text,
  resume_uploaded_at timestamptz,
  -- Step 5: job preferences — object:
  --   { titles: text[], locations: text[],
  --     remote: 'remote'|'hybrid'|'onsite'|'any',
  --     employment_types: text[], min_salary_usd?: number }
  job_preferences jsonb not null default '{}'::jsonb
    check (jsonb_typeof(job_preferences) = 'object'),
  -- Set by the wizard's final step; the engine only pulls profiles where
  -- this is non-null (half-finished onboarding is never acted on).
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

alter table public.user_profiles enable row level security;

-- Own row only, full lifecycle minus delete (account deletion cascades
-- from auth.users instead).
create policy "own profile select"
  on public.user_profiles for select
  to authenticated
  using (user_id = auth.uid());

create policy "own profile insert"
  on public.user_profiles for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "own profile update"
  on public.user_profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke delete on public.user_profiles from anon, authenticated;
revoke all on public.user_profiles from anon;
