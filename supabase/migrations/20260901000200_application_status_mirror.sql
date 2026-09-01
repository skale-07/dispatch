-- Cloud plane v0.5: one-way mirror of engine application status.
-- Written ONLY by the engine-side sync worker (src/cloud/syncSupabase.ts,
-- SUPABASE_SYNC_ENABLED, service-role key that never leaves the engine
-- machine). The cloud never writes back; the engine never reads this.
--
-- Column set is the entire allowed surface: status strings + job identity
-- (company/role) + timestamps. Adding a column here is a data-boundary
-- change and needs the same scrutiny as a new capability flag.

create table public.application_status_mirror (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The engine-plane application UUID (SQLite applications.id). Opaque
  -- string here; uniqueness is per user because each user has their own
  -- engine database.
  engine_application_id text not null,
  company text,
  role text,
  state text not null,
  route text,
  source_ats text,
  engine_created_at timestamptz,
  engine_updated_at timestamptz,
  last_synced_at timestamptz not null default now(),
  primary key (user_id, engine_application_id)
);

create index application_status_mirror_updated_idx
  on public.application_status_mirror (user_id, engine_updated_at desc);

-- Quota read model: completed applications counted against the invite.
-- security_invoker so the underlying RLS applies to the querying user.
create view public.user_quota_status
  with (security_invoker = true) as
select
  u.id as user_id,
  i.max_completed_applications,
  count(m.*) filter (where m.state = 'COMPLETED') as completed_applications,
  greatest(
    i.max_completed_applications
      - count(m.*) filter (where m.state = 'COMPLETED'),
    0
  ) as remaining
from public.app_users u
join public.invites i on i.id = u.invite_id
left join public.application_status_mirror m on m.user_id = u.id
group by u.id, i.max_completed_applications;
