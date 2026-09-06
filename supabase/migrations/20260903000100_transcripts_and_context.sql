-- Onboarding closes the gap between what the wizard collects and what the
-- engine actually reads (operator direction 2026-09-03). Part 1 of 2:
-- columns only. The transcripts BUCKET is 20260903000200 — the two were
-- one file and deadlocked on first apply (2026-09-03), because taking an
-- AccessExclusiveLock on a hot user_profiles while the same transaction
-- touched storage.objects raced PostgREST's schema introspection. Two
-- transactions, two lock scopes, no race.
--
-- Three additions, each justified by an engine consumer that exists TODAY:
--
-- 1. TRANSCRIPT. src/ats/shared/supplementalMaterials.ts already attaches
--    private/candidate/transcript.pdf to transcript-labeled file inputs,
--    and already logs "no transcript on file — transcript inputs left
--    alone" when it is absent. Live evidence that this loses submissions:
--    Appian 2026-08-29 (the submit click bounced off "Please upload a copy
--    of an unofficial undergraduate transcript") and Databricks 2026-09-01
--    (#123, TWO required transcript sections). The engine knows what to do
--    with a transcript; nothing was ever asking the user for one.
--
-- 2. about_me. The single highest-value context field the engine has:
--    essay autofill (src/applications/essayAutofill.ts) and screener
--    PREDICTION (src/applications/screenerPredictionLlm.ts) both ground
--    every answer in it, and both abstain without it — live batch cc02e067
--    nulled 12/12 predictions partly for this reason. It is free text in
--    the user's own voice, the one thing a resume cannot supply.
--
-- 3. The education/context facts tryLoadProfileFacts() reads but the
--    wizard never collected: gpa, additional fields of study, start and
--    graduation MONTH (not just year), current employer, relocation.
--
-- Unchanged invariants: no EEO/demographic column is added here, and none
-- ever should be (queen directive 2026-09-01 — those fill only from the
-- operator's own encrypted sensitive profile, never from the cloud plane).
-- work_authorization stays self-reported and nullable: never inferred.

-- ── transcript pointer (mirrors the resume triplet) ────────────────────
alter table public.user_profiles
  add column if not exists transcript_object_path text,
  add column if not exists transcript_filename text,
  add column if not exists transcript_uploaded_at timestamptz;

-- ── the narrative the LLM surfaces ground on ───────────────────────────
-- Bounded so one row cannot become a document store; the engine sends
-- this as a cached prompt block, and ~8k characters is already a long
-- answer to "tell us about yourself".
alter table public.user_profiles
  add column if not exists about_me text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'user_profiles_about_me_len'
  ) then
    alter table public.user_profiles
      add constraint user_profiles_about_me_len
      check (about_me is null or length(about_me) <= 8000);
  end if;
end
$$;

-- ── context facts the predictor reads ──────────────────────────────────
alter table public.user_profiles
  add column if not exists current_company text,
  add column if not exists open_to_relocation boolean;

-- education entries gain optional gpa / months / additional fields; the
-- column is jsonb and already unconstrained per-entry, so this is a
-- documentation change rather than a DDL one:
--   { school, degree, field, start_year, end_year, gpa?,
--     start_month?, end_month?, additional_fields? }

comment on column public.user_profiles.about_me is
  'Free-text candidate narrative in the user''s own voice. Grounds essay '
  'autofill and screener prediction; both abstain without it. Never '
  'contains EEO/demographic data.';
comment on column public.user_profiles.transcript_object_path is
  'Object path inside the private transcripts bucket; first folder MUST '
  'be the owner uid (storage RLS).';
