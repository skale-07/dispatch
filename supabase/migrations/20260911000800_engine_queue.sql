-- The engine queue: how a hosted user's work reaches the engine, and how
-- the engine reports back.
--
-- Until now the engine was one process for one operator, driven by a local
-- SQLite queue. A multi-tenant scheduler needs a durable, leasable work
-- queue that survives a crash and cannot hand the same job to two workers.
-- That is `engine_jobs` + `lease_engine_jobs` (FOR UPDATE SKIP LOCKED).
--
-- Data boundary, unchanged from the rest of the cloud schema:
--   * The CLIENT may read its own rows and may ask for exactly one kind of
--     work (`feed_sample`). Everything else the engine decides.
--   * The ENGINE (service role) owns every other write.
--   * `outreach_drafts` records that a draft exists — never its body.
--   * `jobright_feed_samples` carries title/company/location only.
--   * Nothing here ever holds a secret; handoff secrets live in
--     `user_integrations.secret_ciphertext` (20260911000700).

-- ── engine_jobs ──────────────────────────────────────────────────────
-- One row per unit of engine work. `payload` is the request, `result` is
-- the answer; both are small JSON the dashboard can render.

create table if not exists public.engine_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (
    kind in ('apply', 'outreach', 'feed_sample', 'reconnect_verify', 'gmail_exchange')
  ),
  status text not null default 'queued'
    check (status in ('queued', 'leased', 'succeeded', 'failed', 'dead')),
  -- not eligible for a lease before this instant (backoff, cadence)
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  -- which worker holds it, and until when; both null unless status='leased'
  lease_owner text,
  lease_until timestamptz,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists engine_jobs_leasable
  on public.engine_jobs (kind, run_after)
  where status = 'queued';
create index if not exists engine_jobs_user_recent
  on public.engine_jobs (user_id, created_at desc);
-- Expired leases, for the reaper.
create index if not exists engine_jobs_lease_until
  on public.engine_jobs (lease_until)
  where status = 'leased';

-- At most one unfinished job per (user, kind): the planner is idempotent
-- and a double-enqueue must not double-spend quota.
create unique index if not exists engine_jobs_one_active_per_kind
  on public.engine_jobs (user_id, kind)
  where status in ('queued', 'leased');

drop trigger if exists engine_jobs_updated_at on public.engine_jobs;
create trigger engine_jobs_updated_at
  before update on public.engine_jobs
  for each row execute function public.set_updated_at();

alter table public.engine_jobs enable row level security;
revoke all on public.engine_jobs from anon, authenticated;
grant select (
  id, user_id, kind, status, run_after, attempts, max_attempts,
  result, created_at, updated_at
) on public.engine_jobs to authenticated;

drop policy if exists "own engine jobs select" on public.engine_jobs;
create policy "own engine jobs select"
  on public.engine_jobs for select
  to authenticated
  using (user_id = auth.uid());

-- The dashboard's read model: never the lease bookkeeping, never payload.
create or replace view public.my_engine_jobs
  with (security_invoker = true) as
select
  id, user_id, kind, status, run_after, attempts, max_attempts,
  result, created_at, updated_at
from public.engine_jobs
where user_id = auth.uid();

grant select on public.my_engine_jobs to authenticated;
revoke all on public.my_engine_jobs from anon;

-- ── handoff_tasks ────────────────────────────────────────────────────
-- A human step the engine cannot do headlessly: signing in to JobRight,
-- clearing a captcha, re-granting Gmail. The engine provisions a remote
-- browser, the user drives it through `live_view_url`, the engine then
-- verifies and seals the resulting session.

create table if not exists public.handoff_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (
    kind in (
      'jobright_connect', 'jobright_reconnect', 'ats_login',
      'captcha', 'gmail_connect', 'gmail_reconnect'
    )
  ),
  status text not null default 'open'
    check (status in (
      'open', 'requested', 'provisioning', 'live', 'user_done',
      'verifying', 'completed', 'failed', 'expired', 'cancelled'
    )),
  -- why the engine opened it, in words the dashboard can show
  reason text,
  -- which application / host it blocks (never credentials)
  context jsonb not null default '{}'::jsonb,
  live_view_url text,
  -- remote-browser provider handle; engine-only, never granted to a client
  provider_session_id text,
  expires_at timestamptz,
  attempts integer not null default 0,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live task per (user, kind) — a second "connect JobRight" prompt
-- while one is already on screen is always a bug.
create unique index if not exists handoff_tasks_one_active_per_kind
  on public.handoff_tasks (user_id, kind)
  where status in ('open', 'requested', 'provisioning', 'live', 'user_done', 'verifying');
create index if not exists handoff_tasks_user_recent
  on public.handoff_tasks (user_id, created_at desc);

drop trigger if exists handoff_tasks_updated_at on public.handoff_tasks;
create trigger handoff_tasks_updated_at
  before update on public.handoff_tasks
  for each row execute function public.set_updated_at();

alter table public.handoff_tasks enable row level security;
revoke all on public.handoff_tasks from anon, authenticated;
grant select (
  id, user_id, kind, status, reason, context, live_view_url,
  expires_at, attempts, result, created_at, updated_at
) on public.handoff_tasks to authenticated;

drop policy if exists "own handoff tasks select" on public.handoff_tasks;
create policy "own handoff tasks select"
  on public.handoff_tasks for select
  to authenticated
  using (user_id = auth.uid());

create or replace view public.my_handoff_tasks
  with (security_invoker = true) as
select
  id, user_id, kind, status, reason, context, live_view_url,
  expires_at, attempts, result, created_at, updated_at
from public.handoff_tasks
where user_id = auth.uid();

grant select on public.my_handoff_tasks to authenticated;
revoke all on public.my_handoff_tasks from anon;

-- ── jobright_feed_samples ────────────────────────────────────────────
-- Proof to the user that their OWN JobRight filters produce a feed we can
-- work: a handful of titles. Never a full posting, never a description.

create table if not exists public.jobright_feed_samples (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sampled_at timestamptz not null default now(),
  -- [{title, company, location}] — nothing else is permitted to land here
  jobs jsonb not null default '[]'::jsonb,
  count integer not null default 0,
  note text
);

alter table public.jobright_feed_samples enable row level security;
revoke all on public.jobright_feed_samples from anon;
revoke insert, update, delete on public.jobright_feed_samples from authenticated;

drop policy if exists "own feed sample" on public.jobright_feed_samples;
create policy "own feed sample"
  on public.jobright_feed_samples for select
  to authenticated
  using (user_id = auth.uid());

-- ── outreach_drafts ──────────────────────────────────────────────────
-- The dashboard shows THAT a referral draft is waiting in the user's own
-- Gmail Drafts, and links to it. The body never leaves the engine.

create table if not exists public.outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  engine_application_id text not null,
  company text,
  contact_name text,
  subject text,
  gmail_draft_id text,
  created_at timestamptz not null default now(),
  unique (user_id, engine_application_id, gmail_draft_id)
);

create index if not exists outreach_drafts_user_recent
  on public.outreach_drafts (user_id, created_at desc);

alter table public.outreach_drafts enable row level security;
revoke all on public.outreach_drafts from anon;
revoke insert, update, delete on public.outreach_drafts from authenticated;

drop policy if exists "own outreach drafts" on public.outreach_drafts;
create policy "own outreach drafts"
  on public.outreach_drafts for select
  to authenticated
  using (user_id = auth.uid());

-- ── user_engine_controls ─────────────────────────────────────────────
-- The stop button. The planner reads `paused` before enqueuing anything;
-- a paused user's in-flight job still finishes (we never abandon a
-- half-filled form), but nothing new is planned.

create table if not exists public.user_engine_controls (
  user_id uuid primary key references auth.users (id) on delete cascade,
  paused boolean not null default false,
  paused_at timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists user_engine_controls_updated_at on public.user_engine_controls;
create trigger user_engine_controls_updated_at
  before update on public.user_engine_controls
  for each row execute function public.set_updated_at();

alter table public.user_engine_controls enable row level security;
revoke all on public.user_engine_controls from anon, authenticated;
grant select (user_id, paused, paused_at, updated_at) on public.user_engine_controls to authenticated;
grant insert (user_id, paused) on public.user_engine_controls to authenticated;
grant update (paused) on public.user_engine_controls to authenticated;

drop policy if exists "own engine controls select" on public.user_engine_controls;
create policy "own engine controls select"
  on public.user_engine_controls for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "own engine controls insert" on public.user_engine_controls;
create policy "own engine controls insert"
  on public.user_engine_controls for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "own engine controls update" on public.user_engine_controls;
create policy "own engine controls update"
  on public.user_engine_controls for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- `paused_at` is bookkeeping, not something a client may backdate.
create or replace function public.stamp_engine_controls_paused_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.paused is true and (tg_op = 'INSERT' or old.paused is distinct from true) then
    new.paused_at := now();
  elsif new.paused is false then
    new.paused_at := null;
  else
    new.paused_at := case when tg_op = 'INSERT' then null else old.paused_at end;
  end if;
  return new;
end;
$$;

drop trigger if exists user_engine_controls_paused_at on public.user_engine_controls;
create trigger user_engine_controls_paused_at
  before insert or update on public.user_engine_controls
  for each row execute function public.stamp_engine_controls_paused_at();

-- ── engine_status: what the worker is doing right now ────────────────
-- 20260902000500 recorded only the last sync tick. A hosted user watching
-- a dashboard needs the live state too.

alter table public.engine_status add column if not exists state text;
alter table public.engine_status add column if not exists paused_reason text;
alter table public.engine_status add column if not exists current_job_id uuid;

update public.engine_status set state = 'idle' where state is null;

alter table public.engine_status alter column state set default 'idle';
alter table public.engine_status alter column state set not null;

alter table public.engine_status drop constraint if exists engine_status_state_check;
alter table public.engine_status add constraint engine_status_state_check
  check (state in ('idle', 'running', 'parked', 'quota_exhausted'));

-- ── engine RPCs (service role) ───────────────────────────────────────
-- Each refuses on bad input BEFORE touching a row, so the read-only schema
-- probe (cloud:schema -- verify) can call them with empty / nil arguments
-- and classify the refusal as "present".

-- Atomically claim up to p_limit due jobs. SKIP LOCKED is what makes two
-- schedulers on two boxes safe.
create or replace function public.lease_engine_jobs(
  p_owner text, p_limit integer default 1, p_kinds text[] default null, p_lease_s integer default 900
)
returns setof public.engine_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 1), 1), 50);
  v_lease integer := least(greatest(coalesce(p_lease_s, 900), 30), 7200);
begin
  if coalesce(p_owner, '') = '' then
    raise exception 'lease owner required';
  end if;

  return query
  with due as (
    select j.id
    from public.engine_jobs j
    where j.status = 'queued'
      and j.run_after <= now()
      and (p_kinds is null or j.kind = any (p_kinds))
    order by j.run_after
    limit v_limit
    for update skip locked
  )
  update public.engine_jobs j
  set status = 'leased',
      lease_owner = p_owner,
      lease_until = now() + make_interval(secs => v_lease),
      attempts = j.attempts + 1
  from due
  where j.id = due.id
  returning j.*;
end;
$$;

revoke all on function public.lease_engine_jobs(text, integer, text[], integer) from public;
revoke all on function public.lease_engine_jobs(text, integer, text[], integer) from anon, authenticated;
grant execute on function public.lease_engine_jobs(text, integer, text[], integer) to service_role;

-- Finish a leased job. A retryable failure goes back to 'queued' with
-- backoff until `max_attempts`, then 'dead' — never an unbounded loop
-- (house rule: attempt caps on every retry path).
create or replace function public.complete_engine_job(
  p_job uuid, p_status text, p_result jsonb default '{}'::jsonb, p_retry_after_s integer default 300
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.engine_jobs%rowtype;
  v_next text;
  v_backoff integer := least(greatest(coalesce(p_retry_after_s, 300), 10), 86400);
begin
  if p_status not in ('succeeded', 'failed', 'dead') then
    raise exception 'unknown completion status';
  end if;

  select * into v_job from public.engine_jobs where id = p_job for update;
  if not found then
    raise exception 'unknown job';
  end if;

  if p_status = 'succeeded' then
    v_next := 'succeeded';
  elsif p_status = 'dead' or v_job.attempts >= v_job.max_attempts then
    v_next := 'dead';
  else
    v_next := 'queued';
  end if;

  update public.engine_jobs
  set status = v_next,
      result = coalesce(p_result, '{}'::jsonb),
      lease_owner = null,
      lease_until = null,
      run_after = case when v_next = 'queued' then now() + make_interval(secs => v_backoff) else run_after end
  where id = p_job;

  return json_build_object('id', p_job, 'status', v_next, 'attempts', v_job.attempts);
end;
$$;

revoke all on function public.complete_engine_job(uuid, text, jsonb, integer) from public;
revoke all on function public.complete_engine_job(uuid, text, jsonb, integer) from anon, authenticated;
grant execute on function public.complete_engine_job(uuid, text, jsonb, integer) to service_role;

-- A worker that died holding leases: return its jobs to the queue (or
-- bury them if they are already at the cap). No-op when nothing expired.
create or replace function public.reap_engine_job_leases()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requeued integer := 0;
  v_dead integer := 0;
begin
  with expired as (
    select id, attempts, max_attempts
    from public.engine_jobs
    where status = 'leased' and lease_until is not null and lease_until < now()
    for update skip locked
  ),
  reaped as (
    update public.engine_jobs j
    set status = case when e.attempts >= e.max_attempts then 'dead' else 'queued' end,
        lease_owner = null,
        lease_until = null,
        run_after = now()
    from expired e
    where j.id = e.id
    returning j.status
  )
  select
    count(*) filter (where status = 'queued'),
    count(*) filter (where status = 'dead')
  into v_requeued, v_dead
  from reaped;

  return json_build_object('requeued', coalesce(v_requeued, 0), 'dead', coalesce(v_dead, 0));
end;
$$;

revoke all on function public.reap_engine_job_leases() from public;
revoke all on function public.reap_engine_job_leases() from anon, authenticated;
grant execute on function public.reap_engine_job_leases() to service_role;

-- ── user RPCs ────────────────────────────────────────────────────────

-- The only work a user may ask for directly. Everything that spends
-- quota is the planner's decision, not a button.
create or replace function public.request_engine_job(p_kind text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_kind is distinct from 'feed_sample' then
    raise exception 'only feed_sample may be requested';
  end if;

  select id into v_id
  from public.engine_jobs
  where user_id = auth.uid() and kind = 'feed_sample' and status in ('queued', 'leased');
  if found then
    return json_build_object('id', v_id, 'created', false);
  end if;

  insert into public.engine_jobs (user_id, kind)
  values (auth.uid(), 'feed_sample')
  returning id into v_id;

  return json_build_object('id', v_id, 'created', true);
end;
$$;

revoke all on function public.request_engine_job(text) from public;
revoke all on function public.request_engine_job(text) from anon;
grant execute on function public.request_engine_job(text) to authenticated;

-- "I'm ready — open the browser." Moves an engine-opened task to
-- `requested`; the scheduler's handoff poller provisions from there.
create or replace function public.handoff_task_request(p_kind text, p_context jsonb default '{}'::jsonb)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.handoff_tasks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_kind not in (
    'jobright_connect', 'jobright_reconnect', 'ats_login',
    'captcha', 'gmail_connect', 'gmail_reconnect'
  ) then
    raise exception 'unknown handoff kind';
  end if;

  select * into v_row
  from public.handoff_tasks
  where user_id = auth.uid()
    and kind = p_kind
    and status in ('open', 'requested', 'provisioning', 'live', 'user_done', 'verifying');

  if not found then
    insert into public.handoff_tasks (user_id, kind, status, context)
    values (auth.uid(), p_kind, 'requested', coalesce(p_context, '{}'::jsonb))
    returning * into v_row;
  elsif v_row.status = 'open' then
    update public.handoff_tasks
    set status = 'requested',
        context = coalesce(p_context, context)
    where id = v_row.id
    returning * into v_row;
  end if;

  return json_build_object('id', v_row.id, 'kind', v_row.kind, 'status', v_row.status);
end;
$$;

revoke all on function public.handoff_task_request(text, jsonb) from public;
revoke all on function public.handoff_task_request(text, jsonb) from anon;
grant execute on function public.handoff_task_request(text, jsonb) to authenticated;

-- "I finished in the browser." The engine verifies before believing it —
-- this only hands the task back, it never marks it completed.
create or replace function public.handoff_task_user_done(p_task uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.handoff_tasks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_row
  from public.handoff_tasks
  where id = p_task and user_id = auth.uid();
  if not found then
    raise exception 'unknown handoff task';
  end if;
  if v_row.status not in ('live', 'provisioning') then
    raise exception 'handoff task is not live';
  end if;

  update public.handoff_tasks
  set status = 'user_done'
  where id = p_task
  returning * into v_row;

  return json_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;

revoke all on function public.handoff_task_user_done(uuid) from public;
revoke all on function public.handoff_task_user_done(uuid) from anon;
grant execute on function public.handoff_task_user_done(uuid) to authenticated;

create or replace function public.handoff_task_cancel(p_task uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.handoff_tasks%rowtype;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_row
  from public.handoff_tasks
  where id = p_task and user_id = auth.uid();
  if not found then
    raise exception 'unknown handoff task';
  end if;
  if v_row.status in ('completed', 'failed', 'expired', 'cancelled') then
    raise exception 'handoff task is already finished';
  end if;

  update public.handoff_tasks
  set status = 'cancelled', live_view_url = null, provider_session_id = null
  where id = p_task;

  return json_build_object('id', p_task, 'status', 'cancelled');
end;
$$;

revoke all on function public.handoff_task_cancel(uuid) from public;
revoke all on function public.handoff_task_cancel(uuid) from anon;
grant execute on function public.handoff_task_cancel(uuid) to authenticated;
