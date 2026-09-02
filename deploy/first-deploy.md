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
   OTP / magic link** (no password provider needed for v0). Then
   Authentication → **URL Configuration**: set **Site URL** to the
   production origin (`https://<domain>`) and add every origin the magic
   links may return to under **Redirect URLs** — at minimum
   `https://<domain>/**`, `http://localhost:5173/**` (Vite dev), and the
   Vercel preview origin(s) once known. A magic link to an unlisted
   origin silently falls back to the Site URL.
5. Collect keys (Project Settings → **API Keys**). New projects show the
   NEW key style; both styles are drop-ins for supabase-js v2:
   - **Project URL** (`https://<ref>.supabase.co`) → frontend AND engine `.env`.
   - **Publishable key** (`sb_publishable_...`; legacy name: anon key) →
     frontend only (`VITE_SUPABASE_ANON_KEY`). Safe in the bundle; RLS is
     the guard.
   - **Secret key** (`sb_secret_...`; legacy name: service_role — under
     "Secret keys", create/reveal one) → engine `.env` ONLY, pasted into
     `SUPABASE_SERVICE_ROLE_KEY` as-is. Bypasses RLS. Never in the
     frontend, never in this repo, never in Vercel env. Caveat: secret
     keys are not JWTs — fine for supabase-js, but they cannot be used
     anywhere expecting a decodable JWT.

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
   (Names are the contract with the storefront agent; anon key only —
   NEVER the service-role key.)
   The app is a client-routed SPA (`/redeem`, `/onboarding`,
   `/dashboard`), so deep links must rewrite to `index.html`; storefront
   ships `frontend/vercel.json`:

   ```json
   { "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }
   ```
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
   name; that refusal is the fail-closed design working. Observed
   2026-09-02 against a read-only snapshot of the engine database
   (335 applications): flag off → `SUPABASE_SYNC_ENABLED is false`;
   flag on, no user id → `missing SUPABASE_SYNC_USER_ID`; flag on with
   a throwaway id and no schema → `Could not find the table
   'public.application_status_mirror'`. Nothing was written locally or
   cloud-side; the live proof waits on Part A1 step 3 + the user id.
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

No Docker daemon on the machine? The same artifacts validate natively
(this is exactly the image's CMD against the same `dist/` +
`frontend/dist/`; done 2026-09-02, `LIVE_READ_ONLY_CONFIRMED` on a
read-only snapshot of the engine database, never the live file):

```
npm run build                      # tsc -> dist + copies migrations (no tsx at runtime)
npm ci --prefix frontend && npm run frontend:build
DATABASE_PATH=<snapshot.sqlite> CONSOLE_PORT=8931 node dist/cli/index.js console
curl -s -o /dev/null -w "%{http_code}
" http://127.0.0.1:8931/api/summary            # 200
curl -s -o /dev/null -w "%{http_code}
" -H "Host: evil.example" http://127.0.0.1:8931/api/summary   # 403
curl -s -o /dev/null -w "%{http_code}
" http://127.0.0.1:8931/                       # 200 (SPA)
```

Hosted-mode smoke on the same build (what the Fly container will do):

```
CONSOLE_HOSTED_MODE_ENABLED=true node dist/cli/index.js console
#   -> refuses to boot: "requires CONSOLE_HOSTED_ALLOWED_HOSTS, CONSOLE_HOSTED_ALLOWED_USER_IDS"
CONSOLE_HOSTED_MODE_ENABLED=true CONSOLE_HOST=0.0.0.0 SUPABASE_URL=https://<ref>.supabase.co   CONSOLE_HOSTED_ALLOWED_HOSTS=127.0.0.1 CONSOLE_HOSTED_ALLOWED_USER_IDS=<uuid>   CONSOLE_PORT=8932 node dist/cli/index.js console
curl -s http://127.0.0.1:8932/api/summary                                  # 401 {"error":"missing bearer token"}
curl -s -H "Authorization: Bearer x.y.z" http://127.0.0.1:8932/api/summary # 401 {"error":"malformed token"}
curl -s -X POST http://127.0.0.1:8932/api/summary                          # 403 {"error":"hosted console is read-only"}
curl -s -H "Host: other.example" http://127.0.0.1:8932/api/summary         # 403 {"error":"forbidden host"}
curl -s -o /dev/null -w "%{http_code}
" http://127.0.0.1:8932/           # 200 (SPA, public)
```

`CONSOLE_HOSTED_ALLOWED_HOSTS` is a list of HOSTNAMES — the port is
stripped before matching, so `console.example.com`, not
`console.example.com:8899`.

### C2. Fly.io deploy (hosted mode — optional, NOT needed for v0)

The hosted-auth flag exists now (`CONSOLE_HOSTED_MODE_ENABLED`,
operator-guide §16 "Hosted mode"): with it the image binds `0.0.0.0`,
verifies a Supabase Auth JWT on every `/api` request, pins the Host
header to your deployed hostname, allows only your own user id, and
refuses every mutation. v0 users never touch this — they get the public
SPA + Supabase (Part A). Deploy it only if you want YOUR console readable
from another machine:

1. `fly launch --no-deploy --dockerfile deploy/Dockerfile` (creates `fly.toml`;
   set `internal_port = 8899`).
2. `fly volumes create dispatch_data --size 1` and mount at `/app/data`
   (the read-only console needs a copy of `data/app.sqlite` there — this
   is the operator's own state, not user PII).
3. `fly secrets set CONSOLE_HOSTED_MODE_ENABLED=true CONSOLE_HOST=0.0.0.0 \
     SUPABASE_URL=https://<ref>.supabase.co \
     CONSOLE_HOSTED_ALLOWED_HOSTS=console.<domain> \
     CONSOLE_HOSTED_ALLOWED_USER_IDS=<your auth.users uuid>`
   — still NO service-role key, NO secret key, NO mutation flags in the
   cloud plane. The container refuses to boot if any of the three
   hosted settings is missing.
4. `fly deploy`, then attach the domain (`fly certs add console.<domain>`).
5. The SPA must send `Authorization: Bearer <supabase session
   access_token>` on every `/api` call in this mode (storefront
   contract); a browser hitting `/api/...` directly gets 401 by design.
