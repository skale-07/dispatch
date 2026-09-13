-- field_suggestion_inputs() v2 — two defects found in review before the
-- first dashboard that calls it (2026-09-12, plan M11):
--
--   1. `cardinality(v_profile.employment_history)`: employment_history is
--      jsonb (20260911000200), not an array. plpgsql resolves the call at
--      first execution, so the function created cleanly and would have
--      raised `function cardinality(jsonb) does not exist` on every call.
--   2. `answered_profile` listed every non-null, non-empty-string column,
--      so the defaults '[]' (education, employment_history), '{}'
--      (job_preferences) and '{}' (skills) always read as answered — an
--      education or relocation suggestion could never appear.
--
-- Same signature and grants as 20260911000900; `answered_preferences` is
-- appended to `status` (keys of job_preferences with a real value) so the
-- ranker can judge dotted profile targets such as
-- job_preferences.willing_to_relocate. The client mirror is
-- frontend/src/public/fieldSuggestions.ts isAnswered().

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
      coalesce(jsonb_typeof(v_profile.employment_history) = 'array'
               and jsonb_array_length(v_profile.employment_history) > 0, false)
      or coalesce(v_profile.current_company, '') <> '',
    -- a column counts as answered only when it holds a real value: not
    -- null, not '', not an empty array/object, not an empty text[]
    'answered_profile', coalesce((
      select jsonb_agg(k) from (
        select key as k
        from jsonb_each(to_jsonb(v_profile))
        where value is not null
          and value <> 'null'::jsonb
          and (jsonb_typeof(value) <> 'string' or value #>> '{}' <> '')
          and (jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 0)
          and (jsonb_typeof(value) <> 'object' or value <> '{}'::jsonb)
      ) t
    ), '[]'::jsonb),
    'answered_preferences', coalesce((
      select jsonb_agg(key)
      from jsonb_each(coalesce(v_profile.job_preferences, '{}'::jsonb))
      where value is not null
        and value <> 'null'::jsonb
        and (jsonb_typeof(value) <> 'string' or value #>> '{}' <> '')
        and (jsonb_typeof(value) <> 'array' or jsonb_array_length(value) > 0)
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
