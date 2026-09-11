-- Onboarding parity, part 1 of 5 (operator direction 2026-09-11): the
-- wizard must collect everything the engine reads from
-- private/candidate/public-profile.json (src/candidate/publicProfile.ts).
-- Before this the cloud row carried nine of those facts; the engine's
-- schema has ~30. Columns only here — the per-store tables follow in
-- 000300 (documents), 000400 (screener answers), 000600 (personas),
-- 000700 (integrations).
--
-- Mapping (cloud column -> engine field):
--   legal_first/middle/last_name  -> legal_name.{first,middle,last}
--   preferred_name                -> preferred_name
--   contact_email                 -> email (null = the auth email)
--   address_line1/2, postal_code  -> address.{line1,line2,postal_code}
--       (city/region/country columns already existed)
--   how_heard, how_heard_fallbacks -> how_heard (+ approved fallbacks the
--       fill may pick when a page's option list lacks the primary answer)
--   restrictive_covenants         -> restrictive_covenants ('yes'|'no';
--       null = unanswered, never invented — same rule as work auth)
--   skills                        -> skills (Workday-style multiselects)
--   employment_history            -> employment_history / current_company
--   education (unchanged DDL)     -> education[0] is the PRIMARY entry
--       (school/degree/major/...); the whole array -> education_history.
--   onboarding_progress           -> wizard resume-later pointer
--       ({ step: text, updated_at: timestamptz }); never read by the engine.
--
-- job_preferences (jsonb, unchanged DDL) gains documented optional keys:
--   max_posting_age_days (posting-age policy), industries text[],
--   target_employer_types text[] (feeds the field-suggestion rules),
--   early_graduation { year, month, academic_standing, statement }
--   (feeds application-education-policy.json only when present).
--
-- Still NO EEO/demographic column on this table. Self-identification is
-- an opt-in, encrypted, RPC-only table (20260911000500) — never here.

alter table public.user_profiles
  add column if not exists legal_first_name text,
  add column if not exists legal_middle_name text,
  add column if not exists legal_last_name text,
  add column if not exists preferred_name text,
  add column if not exists contact_email text,
  add column if not exists address_line1 text,
  add column if not exists address_line2 text,
  add column if not exists postal_code text,
  add column if not exists how_heard text,
  add column if not exists how_heard_fallbacks text[] not null default '{}',
  add column if not exists restrictive_covenants text,
  add column if not exists skills text[] not null default '{}',
  add column if not exists employment_history jsonb not null default '[]'::jsonb,
  add column if not exists onboarding_progress jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_restrictive_covenants_chk'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_restrictive_covenants_chk
      check (restrictive_covenants is null or restrictive_covenants in ('yes', 'no'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_employment_history_arr'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_employment_history_arr
      check (jsonb_typeof(employment_history) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_contact_email_chk'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_contact_email_chk
      check (contact_email is null or contact_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  end if;
end
$$;

comment on column public.user_profiles.employment_history is
  'Array of { company, title, location?, start_month?, start_year?, '
  'end_month?, end_year?, current?: boolean, summary? }. Engine reads it '
  'as employment_history; the wizard derives current_company from the '
  'entry marked current unless the user typed one.';
comment on column public.user_profiles.how_heard_fallbacks is
  'Answers the fill may choose when a form''s "how did you hear" options '
  'lack how_heard itself (e.g. {"LinkedIn","Company website"}). User-'
  'approved; the engine never adds to it.';
comment on column public.user_profiles.restrictive_covenants is
  'Non-compete / restrictive covenant yes-no. Null = unanswered; the '
  'engine leaves the field blank rather than inventing "no".';
comment on column public.user_profiles.onboarding_progress is
  'Wizard resume pointer { step, updated_at }; UI-only.';
