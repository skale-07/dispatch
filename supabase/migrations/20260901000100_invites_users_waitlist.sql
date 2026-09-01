-- Cloud plane v0: invites, users, waitlist.
-- Runnable via `supabase db push` / `supabase migration up` or pasted into
-- the dashboard SQL editor in filename order.
--
-- Data-minimization contract (docs/roadmap/cloud-deploy.md): these tables
-- hold identity + invite bookkeeping only. No candidate PII, no resumes,
-- no ATS credentials — those never leave the engine plane.

-- Invites: minted on the engine machine (npm run invites:mint), loaded
-- here by the operator (service role / SQL editor). Codes are secrets
-- until redeemed; RLS (later migration) never exposes unredeemed rows.
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  issuer text not null default 'operator',
  -- Quota: completed applications counted against this invite.
  -- Minting CLI enforces 5-10; the check is the hard backstop.
  max_completed_applications integer not null default 5
    check (max_completed_applications between 1 and 100),
  redeemed_by uuid references auth.users (id),
  redeemed_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  -- Redemption is atomic and all-or-nothing: both set or both null.
  check ((redeemed_by is null) = (redeemed_at is null))
);

create index invites_redeemed_by_idx on public.invites (redeemed_by);

-- App users: one row per redeemed cloud account, keyed to Supabase Auth.
create table public.app_users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  invite_id uuid references public.invites (id),
  created_at timestamptz not null default now()
);

-- Waitlist: public insert-only mailbox (RLS in the later migration).
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null unique
    check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  created_at timestamptz not null default now()
);
