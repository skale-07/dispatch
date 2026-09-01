# First deploy — step by step

Companion to `docs/roadmap/cloud-deploy.md`. Three parts, in the order
you will actually do them:

- **Part A — v0 cloud plane** (Supabase + Vercel + domain): the
  marketing/waitlist/invite site. Needs the operator inputs from the
  roadmap checklist. ~1 hour.
- **Part B — engine-side wiring** (this machine): invites + status sync.
- **Part C — console Docker image**: build/run validation today, Fly.io
  deploy later (blocked on the hosted-auth flag by design).

Nothing in any part weakens the engine plane: `private/`, `.env`,
resumes, and ATS credentials never leave this machine.

---

## Part A — v0 cloud plane

### A1. Supabase project (~15 min)

1. Redeem the YC credit (deals.ycombinator.com → Supabase $300), or just
   start on the free tier.
2. Create an organization + project. Region: closest to your users
   (e.g. `us-east-1`). Note the **database password** somewhere safe.
3. Apply the schema, either way:
   - Dashboard: SQL Editor → paste each file from `supabase/migrations/`
     **in filename order** → Run.
   - CLI: `supabase link --project-ref <ref>` then `supabase db push`.
4. Auth settings: Authentication → Providers → Email → enable **Email
   OTP / magic link** (no password provider needed for v0).
5. Collect keys (Project Settings → API):
   - **Project URL** (`https://<ref>.supabase.co`) → frontend AND engine `.env`.
   - **anon key** → frontend only. Safe in the bundle; RLS is the guard.
   - **service_role key** → engine `.env` ONLY. Never in the frontend,
     never in this repo, never in Vercel env.

### A2. Domain + Vercel (~20 min)

1. Buy the domain (any registrar, ~$10/yr — the only v0 cash).
2. Create a free Vercel account (Hobby) → New Project → import the
   frontend. Two workable layouts; pick per the frontend agent's repo:
   - This repo's `frontend/` as the project root: framework preset
     "Vite", build `npm run build`, output `dist/`.
   - A separate marketing repo: same preset.
3. Project → Settings → Environment Variables:
   - `VITE_SUPABASE_URL` = project URL
   - `VITE_SUPABASE_ANON_KEY` = anon key
   (Names are the contract with the frontend agent; anon key only.)
4. Project → Settings → Domains → add the domain, follow the DNS
   records (A / CNAME) at your registrar. SSL is automatic.
5. Smoke: open `https://<domain>`, join the waitlist, confirm a row in
   Supabase Table Editor → `waitlist`.

### A3. First invite end-to-end (~10 min)

1. On the engine machine:
   `npm run invites:mint -- --count 2 --quota 5 --base-url https://<domain>`
2. Open the newest `private/cloud/invites/invites-*.sql`, paste into the
   Supabase SQL Editor, Run. (CSV alongside is for your own tracking.)
3. Open one printed link (`https://<domain>/redeem?code=JRA-....`) in a
   private window, sign in with a test email (OTP), redeem.
4. Verify in Supabase: `invites.redeemed_by/redeemed_at` set,
   `app_users` has the row, `select * from user_quota_status` shows
   `remaining = 5`. Redeeming the same code from a second account must
   fail with `invite already redeemed`.

## Part B — engine-side wiring (this machine)

1. In the repo-root `.env` (never committed):

   ```
   CLOUD_BASE_URL=https://<domain>
   SUPABASE_SYNC_ENABLED=true
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service_role key>
   SUPABASE_SYNC_USER_ID=<auth.users uuid to mirror into>
   ```

   `SUPABASE_SYNC_USER_ID`: Supabase → Authentication → Users → copy the
   UUID of the account whose console should show these applications
   (your own account first; per-user engines make this per-container in v1).
2. `npm run cloud:sync` — expect a JSON result with `attempted/upserted`
   counts. With the flag off or any key missing it refuses loudly by
   name; that refusal is the fail-closed design working.
3. Verify in Supabase Table Editor → `application_status_mirror`, and
   confirm the columns are ONLY status strings + company/role +
   timestamps. That column set is the whole permitted surface
   (`MIRROR_COLUMNS` in `src/cloud/syncMapping.ts`).
4. Re-run after sessions (or alongside `auto:cycle`). One run = one
   bounded pass; nothing polls.

## Part C — console Docker image

### C1. Local build + validation (works today)

From the **repo root**:

```
docker build -f deploy/Dockerfile -t dispatch-console .
docker run -d --name dispatch-console dispatch-console
docker exec dispatch-console node -e "fetch('http://127.0.0.1:8899/api/summary').then(r=>r.text()).then(t=>{console.log(t)})"
docker rm -f dispatch-console
```

The `docker exec` probe is deliberate: the console binds
`127.0.0.1` **inside** the container (the local security model —
Host-header pin + per-boot token — is preserved byte-for-byte), so a
published port must NOT reach it yet. `docker run -p 8899:8899` failing
to connect from the host is the correct, expected result.

No Docker on the machine? The same artifacts validate natively:

```
npm run build          # tsc -> dist + copies migrations (no tsx at runtime)
npm run frontend:build
node dist/cli/index.js console
```

### C2. Fly.io deploy (LATER — intentionally blocked)

Do not do this until the hosted-auth flag from the roadmap
("hosted-auth design": `CONSOLE_HOSTED_MODE_ENABLED`, Supabase JWT on
every request, 0.0.0.0 bind) exists — today the image would boot but be
unreachable from outside, which is the fail-closed intent. When it lands:

1. `fly launch --no-deploy --dockerfile deploy/Dockerfile` (creates `fly.toml`;
   set `internal_port = 8899`).
2. `fly volumes create dispatch_data --size 1` and mount at `/app/data`.
3. `fly secrets set CONSOLE_HOSTED_MODE_ENABLED=true SUPABASE_URL=... `
   (JWT verification config; still NO service-role key in the cloud
   plane, and no mutation flags — the hosted console is read-only).
4. `fly deploy`, then attach the domain (`fly certs add console.<domain>`).

Until then the hosted read surface is v0.5's design: static frontend +
Supabase direct reads. There is nothing to deploy for it beyond Part A.
