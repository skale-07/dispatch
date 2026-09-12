-- Field-surfacing intelligence: which application-form fields matter, so
-- onboarding can ask for them BEFORE the engine hits a form it cannot fill.
--
-- Two evidence sources, both about forms, never about people:
--   1. community — across tenants, which fields do forms ask for, how often
--      are they required, how often were they left blank. Stored per tenant
--      (service role only, no client policy at all) and exposed ONLY as an
--      aggregate view with tenant ids summed away.
--   2. own — a user's own engine runs: the field it skipped, the review
--      item it raised, the transcript it could not attach. Own rows only.
-- Plus two curated layers: admin pins (operator says "this matters") and
-- seeded rules (an internship seeker will be asked for hours per week).
--
-- Hard exclusions, enforced in SQL so no caller can weaken them:
--   * a signal key is a canonical field key, a screener registry key, or a
--     label fingerprint — anything else is refused before the write;
--   * a label that looks demographic / EEO / criminal / age is refused
--     outright (`field_label_is_sensitive`, mirrored from the engine's own
--     detectors and drift-tested against them). Self-identification is
--     opt-in (20260911000500) and is never "surfaced" by popularity.
--
-- The ranking itself is client-side (frontend fieldSuggestions.ts); this
-- migration only stores, aggregates and hands over the inputs.

-- ── vocabularies ─────────────────────────────────────────────────────

-- The canonical (profile-backed) field keys the engine maps forms onto,
-- MINUS every demographic canonical. Drift-tested against
-- src/cloud/fieldSignalKeys.ts.
create or replace function public.canonical_field_keys()
returns text[]
language sql
immutable
as $$
  select array[
    'legal_name.first', 'legal_name.middle', 'legal_name.last', 'preferred_name',
    'email', 'phone',
    'address.line1', 'address.line2', 'address.city', 'address.state',
    'address.postal_code', 'address.country',
    'linkedin_url', 'github_url', 'personal_website',
    'school', 'degree', 'major', 'gpa',
    'graduation_month', 'graduation_year', 'start_month', 'start_year',
    'current_company', 'current_job_title',
    'work_authorization', 'requires_sponsorship', 'relocation',
    'how_heard', 'restrictive_covenants'
  ]::text[];
$$;

revoke all on function public.canonical_field_keys() from public;
grant execute on function public.canonical_field_keys() to anon, authenticated, service_role;

-- Mirrors src/applications/essayDetector.ts isDemographicsField and
-- src/applications/essayAutofill.ts SENSITIVE_QUESTION. A label that trips
-- this never becomes a signal, an event, or a suggestion.
create or replace function public.field_label_is_sensitive(p_label text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_label, '') ~* (
    'gender|race|ethnic|veteran|disabilit|disabled|hispanic|latino|transgender'
    || '|eeo|equal opportunity|decline to (self-)?identify|sexual orientation|pronouns?\y'
    || '|felony|convict|criminal|date of birth|\yage\y|\ysex\y'
  );
$$;

revoke all on function public.field_label_is_sensitive(text) from public;
grant execute on function public.field_label_is_sensitive(text) to anon, authenticated, service_role;

-- canonical:<key> | screener:<registry key> | label:<12-hex fingerprint>
create or replace function public.field_signal_key_allowed(p_key text)
returns boolean
language sql
immutable
as $$
  select case
    when p_key like 'canonical:%' then substr(p_key, 11) = any (public.canonical_field_keys())
    when p_key like 'screener:%'  then substr(p_key, 10) = any (public.screener_registry_keys())
    when p_key like 'label:%'     then substr(p_key, 7) ~ '^[a-f0-9]{12}$'
    else false
  end;
$$;

revoke all on function public.field_signal_key_allowed(text) from public;
grant execute on function public.field_signal_key_allowed(text) to anon, authenticated, service_role;

-- ── tenant_field_signals (service role only) ─────────────────────────

create table if not exists public.tenant_field_signals (
  tenant_user_id uuid not null references auth.users (id) on delete cascade,
  signal_key text not null check (public.field_signal_key_allowed(signal_key)),
  ats text not null check (ats ~ '^[a-z0-9_]{1,32}$'),
  -- the form's own wording, normalized; never a value
  label text not null check (length(label) between 1 and 300),
  control text check (control ~ '^[a-z_]{1,32}$'),
  forms_seen integer not null default 0 check (forms_seen >= 0),
  unanswered_count integer not null default 0 check (unanswered_count >= 0),
  required_count integer not null default 0 check (required_count >= 0),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (tenant_user_id, signal_key, ats),
  check (not public.field_label_is_sensitive(label))
);

alter table public.tenant_field_signals enable row level security;
revoke all on public.tenant_field_signals from anon, authenticated;
-- No policy at all: only the service role (which bypasses RLS) reaches rows.

-- The community read model. Owner-rights ON PURPOSE (not security_invoker):
-- the base table has no client policy, and this is the one door — every
-- tenant id is summed away before a row leaves.
create or replace view public.field_signals as
select
  signal_key,
  -- one representative wording for the card
  mode() within group (order by label) as label,
  count(distinct tenant_user_id)::integer as tenants_seen,
  sum(forms_seen)::integer as forms_seen,
  sum(unanswered_count)::integer as unanswered_count,
  sum(required_count)::integer as required_count,
  array_agg(distinct ats order by ats) as ats,
  min(first_seen_at) as first_seen_at,
  max(last_seen_at) as last_seen_at
from public.tenant_field_signals
group by signal_key;

grant select on public.field_signals to authenticated;
revoke all on public.field_signals from anon;

-- ── admin_field_pins ─────────────────────────────────────────────────
-- "This field matters, ask everyone." Operator-curated, service role writes
-- (npm run cloud:field-pins); every signed-in user may read the active set.

create table if not exists public.admin_field_pins (
  signal_key text primary key check (public.field_signal_key_allowed(signal_key)),
  target jsonb not null check (jsonb_typeof(target) = 'object' and target ? 'store'),
  reason text not null check (length(reason) between 1 and 300),
  priority integer not null default 5 check (priority between 1 and 10),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists admin_field_pins_updated_at on public.admin_field_pins;
create trigger admin_field_pins_updated_at
  before update on public.admin_field_pins
  for each row execute function public.set_updated_at();

alter table public.admin_field_pins enable row level security;
revoke all on public.admin_field_pins from anon;
revoke insert, update, delete on public.admin_field_pins from authenticated;

drop policy if exists "active pins are public to members" on public.admin_field_pins;
create policy "active pins are public to members"
  on public.admin_field_pins for select
  to authenticated
  using (active);

-- ── user_field_events ────────────────────────────────────────────────
-- A user's OWN engine evidence: "your run at Acme left this blank".

create table if not exists public.user_field_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  signal_key text not null check (public.field_signal_key_allowed(signal_key)),
  label text not null check (length(label) between 1 and 300),
  ats text not null check (ats ~ '^[a-z0-9_]{1,32}$'),
  kind text not null check (kind in (
    'unanswered_required', 'skip_unmapped', 'skip_empty_profile',
    'review_item', 'transcript_required', 'essay_required'
  )),
  -- which of the user's applications; the dashboard joins for the company
  engine_application_id text not null,
  occurred_at timestamptz not null default now(),
  check (not public.field_label_is_sensitive(label))
);

-- One event per (user, field, application, kind): a re-run is not a new fact.
create unique index if not exists user_field_events_dedupe
  on public.user_field_events (user_id, signal_key, engine_application_id, kind);
create index if not exists user_field_events_user_recent
  on public.user_field_events (user_id, occurred_at desc);

alter table public.user_field_events enable row level security;
revoke all on public.user_field_events from anon;
revoke insert, update, delete on public.user_field_events from authenticated;

drop policy if exists "own field events" on public.user_field_events;
create policy "own field events"
  on public.user_field_events for select
  to authenticated
  using (user_id = auth.uid());

-- ── field_rules + signal_targets (seeded, read-only to clients) ──────

-- predicate: {all:[...]} | {any:[...]} | {"<path>": {<op>: <value>}}
--   ops: contains | contains_any | not_contains | matches | present | eq | neq | gte
--   paths resolve into field_suggestion_inputs().status
-- target:    {store: profile|screener|education|employment|documents|integrations|self_id, key, kind?}
create table if not exists public.field_rules (
  rule_key text primary key check (rule_key ~ '^[a-z0-9_]{2,60}$'),
  predicate jsonb not null check (jsonb_typeof(predicate) = 'object'),
  target jsonb not null check (jsonb_typeof(target) = 'object' and target ? 'store'),
  why text not null check (length(why) between 1 and 300),
  priority integer not null default 5 check (priority between 1 and 10),
  active boolean not null default true
);

alter table public.field_rules enable row level security;
revoke all on public.field_rules from anon;
revoke insert, update, delete on public.field_rules from authenticated;

drop policy if exists "active rules are public to members" on public.field_rules;
create policy "active rules are public to members"
  on public.field_rules for select
  to authenticated
  using (active);

-- Where an answer for a signal lives. `label:` signals have no target
-- until a pin or the user's own event supplies one — that is how a
-- popular-but-unmapped question stays a question, not a guess.
create table if not exists public.signal_targets (
  signal_key text primary key check (public.field_signal_key_allowed(signal_key)),
  target jsonb not null check (jsonb_typeof(target) = 'object' and target ? 'store')
);

alter table public.signal_targets enable row level security;
revoke all on public.signal_targets from anon;
revoke insert, update, delete on public.signal_targets from authenticated;

drop policy if exists "targets are public to members" on public.signal_targets;
create policy "targets are public to members"
  on public.signal_targets for select
  to authenticated
  using (true);

-- Seeds are absolute: re-applying resets them to this file's truth.
insert into public.signal_targets (signal_key, target) values
  ('canonical:legal_name.first',   '{"store":"profile","key":"legal_first_name","kind":"text"}'),
  ('canonical:legal_name.middle',  '{"store":"profile","key":"legal_middle_name","kind":"text"}'),
  ('canonical:legal_name.last',    '{"store":"profile","key":"legal_last_name","kind":"text"}'),
  ('canonical:preferred_name',     '{"store":"profile","key":"preferred_name","kind":"text"}'),
  ('canonical:email',              '{"store":"profile","key":"contact_email","kind":"text"}'),
  ('canonical:phone',              '{"store":"profile","key":"phone","kind":"text"}'),
  ('canonical:address.line1',      '{"store":"profile","key":"address_line1","kind":"text"}'),
  ('canonical:address.line2',      '{"store":"profile","key":"address_line2","kind":"text"}'),
  ('canonical:address.city',       '{"store":"profile","key":"location_city","kind":"text"}'),
  ('canonical:address.state',      '{"store":"profile","key":"location_region","kind":"text"}'),
  ('canonical:address.postal_code','{"store":"profile","key":"postal_code","kind":"text"}'),
  ('canonical:address.country',    '{"store":"profile","key":"location_country","kind":"text"}'),
  ('canonical:linkedin_url',       '{"store":"profile","key":"linkedin_url","kind":"text"}'),
  ('canonical:github_url',         '{"store":"profile","key":"github_url","kind":"text"}'),
  ('canonical:personal_website',   '{"store":"profile","key":"portfolio_url","kind":"text"}'),
  ('canonical:school',             '{"store":"education","key":"school","kind":"text"}'),
  ('canonical:degree',             '{"store":"education","key":"degree","kind":"text"}'),
  ('canonical:major',              '{"store":"education","key":"major","kind":"text"}'),
  ('canonical:gpa',                '{"store":"education","key":"gpa","kind":"number"}'),
  ('canonical:graduation_month',   '{"store":"education","key":"graduation_month","kind":"number"}'),
  ('canonical:graduation_year',    '{"store":"education","key":"graduation_year","kind":"number"}'),
  ('canonical:start_month',        '{"store":"education","key":"start_month","kind":"number"}'),
  ('canonical:start_year',         '{"store":"education","key":"start_year","kind":"number"}'),
  ('canonical:current_company',    '{"store":"employment","key":"company","kind":"text"}'),
  ('canonical:current_job_title',  '{"store":"employment","key":"title","kind":"text"}'),
  ('canonical:work_authorization', '{"store":"profile","key":"work_authorization","kind":"text"}'),
  ('canonical:requires_sponsorship','{"store":"profile","key":"needs_sponsorship","kind":"boolean"}'),
  ('canonical:relocation',         '{"store":"profile","key":"job_preferences.willing_to_relocate","kind":"boolean"}'),
  ('canonical:how_heard',          '{"store":"profile","key":"how_heard","kind":"text"}'),
  ('canonical:restrictive_covenants','{"store":"profile","key":"restrictive_covenants","kind":"text"}'),
  -- screener registry keys that MIRROR a profile column point at the column
  -- (frontend PROFILE_MIRRORED_SCREENER_KEYS); the rest at the answer bank.
  ('screener:work_authorization',  '{"store":"profile","key":"work_authorization","kind":"text"}'),
  ('screener:requires_sponsorship','{"store":"profile","key":"needs_sponsorship","kind":"boolean"}'),
  ('screener:willing_to_relocate', '{"store":"profile","key":"job_preferences.willing_to_relocate","kind":"boolean"}'),
  ('screener:how_heard',           '{"store":"profile","key":"how_heard","kind":"text"}'),
  ('screener:non_compete',         '{"store":"profile","key":"restrictive_covenants","kind":"text"}'),
  ('screener:consent_agreement',   '{"store":"screener","key":"consent_agreement","kind":"boolean"}'),
  ('screener:availability_full_time','{"store":"screener","key":"availability_full_time","kind":"boolean"}'),
  ('screener:education_level',     '{"store":"screener","key":"education_level","kind":"text"}'),
  ('screener:closest_location',    '{"store":"screener","key":"closest_location","kind":"text"}'),
  ('screener:referral_name',       '{"store":"screener","key":"referral_name","kind":"text"}'),
  ('screener:remote_or_onsite',    '{"store":"screener","key":"remote_or_onsite","kind":"text"}'),
  ('screener:start_availability',  '{"store":"screener","key":"start_availability","kind":"text"}'),
  ('screener:internship_term',     '{"store":"screener","key":"internship_term","kind":"text"}'),
  ('screener:hours_per_week',      '{"store":"screener","key":"hours_per_week","kind":"number"}'),
  ('screener:previously_applied_or_worked','{"store":"screener","key":"previously_applied_or_worked","kind":"boolean"}'),
  ('screener:age_over_18',         '{"store":"screener","key":"age_over_18","kind":"boolean"}'),
  ('screener:government_employment','{"store":"screener","key":"government_employment","kind":"boolean"}'),
  ('screener:security_clearance',  '{"store":"screener","key":"security_clearance","kind":"text"}'),
  ('screener:twitter_url',         '{"store":"screener","key":"twitter_url","kind":"text"}'),
  ('screener:portfolio_url',       '{"store":"profile","key":"portfolio_url","kind":"text"}'),
  ('screener:salary_expectations', '{"store":"screener","key":"salary_expectations","kind":"text"}'),
  ('screener:notice_period',       '{"store":"screener","key":"notice_period","kind":"text"}')
on conflict (signal_key) do update set target = excluded.target;

insert into public.field_rules (rule_key, predicate, target, why, priority) values
  ('internship_term',
   '{"any":[{"status.employer_types":{"contains_any":["internship","intern","co-op","coop"]}},{"status.titles":{"matches":"intern|co-?op"}}]}',
   '{"store":"screener","key":"internship_term","kind":"text"}',
   'Internship postings ask which term you are applying for', 7),
  ('internship_hours',
   '{"any":[{"status.employer_types":{"contains_any":["internship","intern","co-op","coop"]}},{"status.titles":{"matches":"intern|co-?op"}}]}',
   '{"store":"screener","key":"hours_per_week","kind":"number"}',
   'Internship postings ask how many hours per week you can work', 6),
  ('internship_full_time',
   '{"any":[{"status.employer_types":{"contains_any":["internship","intern","co-op","coop"]}},{"status.titles":{"matches":"intern|co-?op"}}]}',
   '{"store":"screener","key":"availability_full_time","kind":"boolean"}',
   'Internship postings ask whether you are available full-time for the term', 5),
  ('clearance',
   '{"any":[{"status.industries":{"contains_any":["defense","government","aerospace","intelligence","public sector"]}},{"status.titles":{"matches":"clearance|defense|federal"}}]}',
   '{"store":"screener","key":"security_clearance","kind":"text"}',
   'Defense and government employers ask about security clearance', 8),
  ('government_employment',
   '{"any":[{"status.industries":{"contains_any":["defense","government","public sector"]}}]}',
   '{"store":"screener","key":"government_employment","kind":"boolean"}',
   'Government-adjacent employers ask about prior government employment', 6),
  ('finance_covenants',
   '{"status.industries":{"contains_any":["finance","banking","fintech","trading","asset management","insurance"]}}',
   '{"store":"profile","key":"restrictive_covenants","kind":"text"}',
   'Financial employers ask about non-compete and non-solicit agreements', 7),
  ('finance_notice',
   '{"status.industries":{"contains_any":["finance","banking","fintech","trading","asset management","insurance"]}}',
   '{"store":"screener","key":"notice_period","kind":"text"}',
   'Financial employers ask for your notice period', 5),
  ('employed_notice',
   '{"status.has_current_employer":{"eq":true}}',
   '{"store":"screener","key":"notice_period","kind":"text"}',
   'You listed a current employer — forms will ask for your notice period', 6),
  ('employed_non_compete',
   '{"status.has_current_employer":{"eq":true}}',
   '{"store":"profile","key":"restrictive_covenants","kind":"text"}',
   'You listed a current employer — forms will ask about non-compete agreements', 6),
  ('transcript_missing',
   '{"all":[{"status.event_kinds":{"contains":"transcript_required"}},{"status.has_transcript":{"eq":false}}]}',
   '{"store":"documents","key":"transcript"}',
   'A form you applied to required a transcript and none is uploaded', 9),
  ('ds_ai_resume_variant',
   '{"all":[{"status.titles":{"matches":"data scien|machine learning|\\bml\\b|\\bai\\b|deep learning"}},{"status.resume_variants":{"not_contains":"ds_ai"}}]}',
   '{"store":"documents","key":"resume","variant":"ds_ai"}',
   'Data science and ML roles read better with a tailored resume variant', 4),
  ('self_id_never_visited',
   '{"status.self_id_visited":{"eq":false}}',
   '{"store":"self_id"}',
   'Most forms have an optional self-identification section — decide once whether to answer it', 3),
  ('premium_connect_gmail',
   '{"all":[{"status.jobright_premium":{"eq":true}},{"status.gmail_status":{"neq":"connected"}}]}',
   '{"store":"integrations","key":"gmail"}',
   'Referral drafts need Gmail connected — you have JobRight Premium, so drafting is available', 8)
on conflict (rule_key) do update
  set predicate = excluded.predicate,
      target = excluded.target,
      why = excluded.why,
      priority = excluded.priority,
      active = true;

-- ── engine RPCs (service role) ───────────────────────────────────────
-- Each refuses BEFORE any write so the read-only schema probe can call
-- it with a nil uuid and classify the refusal as "present".

-- Absolute upsert of one tenant's aggregated signals. Every row is
-- re-validated in SQL: an unknown key or a sensitive label fails the whole
-- call, so a regression in the engine's own filter cannot leak through.
create or replace function public.engine_upsert_field_signals(p_tenant uuid, p_rows jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_n integer := 0;
begin
  if not exists (select 1 from public.app_users where id = p_tenant) then
    raise exception 'unknown user';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    if not public.field_signal_key_allowed(v_row->>'signal_key') then
      raise exception 'signal key not allowed: %', v_row->>'signal_key';
    end if;
    if public.field_label_is_sensitive(v_row->>'label') then
      raise exception 'sensitive label refused for %', v_row->>'signal_key';
    end if;
    insert into public.tenant_field_signals (
      tenant_user_id, signal_key, ats, label, control,
      forms_seen, unanswered_count, required_count, first_seen_at, last_seen_at
    ) values (
      p_tenant,
      v_row->>'signal_key',
      v_row->>'ats',
      left(v_row->>'label', 300),
      nullif(v_row->>'control', ''),
      greatest(coalesce((v_row->>'forms_seen')::integer, 0), 0),
      greatest(coalesce((v_row->>'unanswered_count')::integer, 0), 0),
      greatest(coalesce((v_row->>'required_count')::integer, 0), 0),
      coalesce((v_row->>'first_seen_at')::timestamptz, now()),
      coalesce((v_row->>'last_seen_at')::timestamptz, now())
    )
    on conflict (tenant_user_id, signal_key, ats) do update
      set label = excluded.label,
          control = excluded.control,
          forms_seen = excluded.forms_seen,
          unanswered_count = excluded.unanswered_count,
          required_count = excluded.required_count,
          first_seen_at = least(public.tenant_field_signals.first_seen_at, excluded.first_seen_at),
          last_seen_at = greatest(public.tenant_field_signals.last_seen_at, excluded.last_seen_at);
    v_n := v_n + 1;
  end loop;

  return json_build_object('upserted', v_n);
end;
$$;

revoke all on function public.engine_upsert_field_signals(uuid, jsonb) from public;
revoke all on function public.engine_upsert_field_signals(uuid, jsonb) from anon, authenticated;
grant execute on function public.engine_upsert_field_signals(uuid, jsonb) to service_role;

create or replace function public.engine_upsert_field_events(p_user uuid, p_rows jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_n integer := 0;
begin
  if not exists (select 1 from public.app_users where id = p_user) then
    raise exception 'unknown user';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be an array';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    if not public.field_signal_key_allowed(v_row->>'signal_key') then
      raise exception 'signal key not allowed: %', v_row->>'signal_key';
    end if;
    if public.field_label_is_sensitive(v_row->>'label') then
      raise exception 'sensitive label refused for %', v_row->>'signal_key';
    end if;
    insert into public.user_field_events (
      user_id, signal_key, label, ats, kind, engine_application_id, occurred_at
    ) values (
      p_user,
      v_row->>'signal_key',
      left(v_row->>'label', 300),
      v_row->>'ats',
      v_row->>'kind',
      v_row->>'engine_application_id',
      coalesce((v_row->>'occurred_at')::timestamptz, now())
    )
    on conflict (user_id, signal_key, engine_application_id, kind) do nothing;
    v_n := v_n + 1;
  end loop;

  return json_build_object('processed', v_n);
end;
$$;

revoke all on function public.engine_upsert_field_events(uuid, jsonb) from public;
revoke all on function public.engine_upsert_field_events(uuid, jsonb) from anon, authenticated;
grant execute on function public.engine_upsert_field_events(uuid, jsonb) to service_role;

-- ── the user's read: everything the ranker needs, in one call ────────
-- `status` is the user's own answered-ness per store, so the ranker can
-- exclude what is already on file and evaluate rule predicates. No other
-- user's data is in here: the community half is the aggregate view.

create or replace function public.field_suggestion_inputs()
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_status jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select * into v_profile from public.user_profiles where user_id = v_uid;

  v_status := jsonb_build_object(
    'titles', coalesce(v_profile.job_preferences->'titles', '[]'::jsonb),
    'industries', coalesce(v_profile.job_preferences->'industries', '[]'::jsonb),
    'employer_types', coalesce(v_profile.job_preferences->'target_employer_types', '[]'::jsonb),
    'has_current_employer',
      coalesce(cardinality(v_profile.employment_history), 0) > 0,
    'answered_profile', coalesce((
      select jsonb_agg(k) from (
        select key as k
        from jsonb_each(to_jsonb(v_profile))
        where value is not null and value <> 'null'::jsonb
          and (jsonb_typeof(value) <> 'string' or value #>> '{}' <> '')
      ) t
    ), '[]'::jsonb),
    'answered_screener', coalesce((
      select jsonb_agg(key) from public.user_screener_answers where user_id = v_uid
    ), '[]'::jsonb),
    'resume_variants', coalesce((
      select jsonb_agg(variant) from public.user_documents where user_id = v_uid and kind = 'resume'
    ), '[]'::jsonb),
    'has_transcript', exists (
      select 1 from public.user_documents where user_id = v_uid and kind = 'transcript'
    ),
    'gmail_status', coalesce((
      select status from public.user_integrations where user_id = v_uid and provider = 'gmail'
    ), 'disconnected'),
    'jobright_status', coalesce((
      select status from public.user_integrations where user_id = v_uid and provider = 'jobright'
    ), 'disconnected'),
    'jobright_premium', coalesce((
      select premium from public.user_integrations where user_id = v_uid and provider = 'jobright'
    ), false),
    -- visited, not answered: the decision may legitimately be "skip all"
    'self_id_visited', coalesce(v_profile.onboarding_progress ? 'self_id', false),
    'event_kinds', coalesce((
      select jsonb_agg(distinct kind) from public.user_field_events where user_id = v_uid
    ), '[]'::jsonb)
  );

  return jsonb_build_object(
    'signals', coalesce((
      select jsonb_agg(to_jsonb(s)) from (
        select * from public.field_signals
        order by unanswered_count desc, forms_seen desc
        limit 200
      ) s
    ), '[]'::jsonb),
    'pins', coalesce((
      select jsonb_agg(to_jsonb(p)) from (
        select signal_key, target, reason, priority from public.admin_field_pins where active
      ) p
    ), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(to_jsonb(e)) from (
        select signal_key, label, ats, kind, engine_application_id, occurred_at
        from public.user_field_events
        where user_id = v_uid and occurred_at > now() - interval '90 days'
        order by occurred_at desc
        limit 200
      ) e
    ), '[]'::jsonb),
    'rules', coalesce((
      select jsonb_agg(to_jsonb(r)) from (
        select rule_key, predicate, target, why, priority from public.field_rules where active
      ) r
    ), '[]'::jsonb),
    'targets', coalesce((
      select jsonb_object_agg(signal_key, target) from public.signal_targets
    ), '{}'::jsonb),
    'status', v_status
  );
end;
$$;

revoke all on function public.field_suggestion_inputs() from public;
revoke all on function public.field_suggestion_inputs() from anon;
grant execute on function public.field_suggestion_inputs() to authenticated;
