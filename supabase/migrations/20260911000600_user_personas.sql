-- Onboarding parity, part 4 of 5: the outreach persona.
--
-- Referral emails are generated from private/candidate/personas/<id>.json
-- (src/candidate/personas.ts personaSchema): headline, education
-- {school, class_year, majors[]}, projects[] {name, summary, tools[],
-- relevance_tags[]}, skills[], interests[]. The persona is the ONLY
-- source of project claims — a deterministic validator rejects any
-- bullet naming a project not listed here — and loadPersona() refuses
-- placeholder names (REPLACE_*). Both rules are mirrored as CHECKs.
--
-- A user without projects simply has no persona; the engine then
-- generates no outreach for them and says so ("no persona"), never a
-- generic email.

create table if not exists public.user_personas (
  user_id uuid not null references auth.users (id) on delete cascade,
  persona_id text not null default 'default' check (persona_id ~ '^[a-z0-9_-]{1,32}$'),
  headline text not null check (length(headline) between 1 and 200),
  -- { school: text, class_year: int, majors: text[] }
  education jsonb not null default '{}'::jsonb
    check (jsonb_typeof(education) = 'object'),
  -- [{ name, summary, tools: text[], relevance_tags: text[] }]
  projects jsonb not null default '[]'::jsonb
    check (jsonb_typeof(projects) = 'array'),
  skills text[] not null default '{}',
  interests text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, persona_id),
  -- personas.ts PLACEHOLDER_PROJECT_NAME: /^REPLACE_[A-Z0-9_]*$/
  check (projects::text !~ '"name": *"REPLACE_')
);

drop trigger if exists user_personas_updated_at on public.user_personas;
create trigger user_personas_updated_at
  before update on public.user_personas
  for each row execute function public.set_updated_at();

alter table public.user_personas enable row level security;
revoke all on public.user_personas from anon;

drop policy if exists "own persona select" on public.user_personas;
create policy "own persona select"
  on public.user_personas for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "own persona insert" on public.user_personas;
create policy "own persona insert"
  on public.user_personas for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "own persona update" on public.user_personas;
create policy "own persona update"
  on public.user_personas for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "own persona delete" on public.user_personas;
create policy "own persona delete"
  on public.user_personas for delete
  to authenticated
  using (user_id = auth.uid());
