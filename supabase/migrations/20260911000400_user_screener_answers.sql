-- Onboarding parity, part 3 of 5: the screener answer bank, per user.
--
-- The engine answers recurring screener questions from
-- private/candidate/screeners.json (src/candidate/screeners.ts):
--   answers: { <registry key>: "<literal answer>" }   -- 22 fixed keys
--   custom:  { <snake_case key>: { answer, labels[], promoted_at } }
-- parseScreenerBank() rejects unknown registry keys, non-snake_case
-- custom keys, and custom keys that collide with a registry key. The
-- same rules are CHECK constraints here so a row the engine would refuse
-- cannot be written.
--
-- The registry list is duplicated on purpose: the frontend never imports
-- from src/, and a unit test (cloud-onboarding-schema.test.ts) parses
-- this array out of the SQL and asserts set-equality with
-- SCREENER_REGISTRY — adding a key to the engine fails the gate until a
-- follow-up migration `create or replace`s this function.
--
-- Facts that ALSO live as profile columns (work_authorization,
-- needs_sponsorship, open_to_relocation, how_heard, restrictive_covenants)
-- are NOT duplicated here; the engine-side materializer mirrors them into
-- the registry keys (work_authorization, requires_sponsorship,
-- willing_to_relocate, how_heard, non_compete) so both readers agree.

create or replace function public.screener_registry_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'consent_agreement',
    'availability_full_time',
    'requires_sponsorship',
    'work_authorization',
    'education_level',
    'closest_location',
    'how_heard',
    'referral_name',
    'willing_to_relocate',
    'remote_or_onsite',
    'start_availability',
    'internship_term',
    'hours_per_week',
    'previously_applied_or_worked',
    'age_over_18',
    'non_compete',
    'government_employment',
    'security_clearance',
    'twitter_url',
    'portfolio_url',
    'salary_expectations',
    'notice_period'
  ]::text[];
$$;

revoke all on function public.screener_registry_keys() from public;
grant execute on function public.screener_registry_keys() to anon, authenticated;

create table if not exists public.user_screener_answers (
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{2,60}$'),
  kind text not null check (kind in ('registry', 'custom')),
  -- The literal string the engine types or picks — never transformed.
  answer text not null check (length(answer) between 1 and 2000),
  -- custom: the normalized question labels this answer covers.
  labels text[] not null default '{}',
  source text not null default 'wizard'
    check (source in ('wizard', 'suggestion', 'engine_promote')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  check (kind <> 'registry' or key = any (public.screener_registry_keys())),
  check (
    kind <> 'custom'
    or (cardinality(labels) > 0 and not (key = any (public.screener_registry_keys())))
  )
);

drop trigger if exists user_screener_answers_updated_at on public.user_screener_answers;
create trigger user_screener_answers_updated_at
  before update on public.user_screener_answers
  for each row execute function public.set_updated_at();

alter table public.user_screener_answers enable row level security;
revoke all on public.user_screener_answers from anon;

drop policy if exists "own screener answers select" on public.user_screener_answers;
create policy "own screener answers select"
  on public.user_screener_answers for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "own screener answers insert" on public.user_screener_answers;
create policy "own screener answers insert"
  on public.user_screener_answers for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "own screener answers update" on public.user_screener_answers;
create policy "own screener answers update"
  on public.user_screener_answers for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own screener answers delete" on public.user_screener_answers;
create policy "own screener answers delete"
  on public.user_screener_answers for delete
  to authenticated
  using (user_id = auth.uid());
