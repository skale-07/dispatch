# Hosted engine + public site on Azure — v0 runbook

Operator decision 2026-09-16: the credits are Azure, not AWS, and Vercel
is out. Same shape as `deploy/aws/` (kept as the reference variant): ONE
Linux VM running the tenant scheduler container from
`deploy/engine.Dockerfile`, tenant workspaces on a managed data disk that
outlives the VM, the engine `.env` as a Key Vault secret, the image in
Azure Container Registry, no inbound ports. The public frontend is an
Azure Static Web App (Free tier) with the SPA fallback and response
headers in `frontend/public/staticwebapp.config.json` (pinned equal to
`frontend/vercel.json` by `tests/unit/deploy-azure.test.ts`).

Browsers: a tenant apply run drives the image's own headless Chromium
with the tenant's unsealed login state. The remote-browser provider
(Browserbase or Browser Use, `REMOTE_BROWSER_PROVIDER`) is used only for
the login handoffs, so the VM needs egress and the provider keys, no
display and no Chrome install.

## What you need once

- `az` (Azure CLI) on this machine, `az login`, and
  `az account set --subscription <the credits subscription>`. The
  identity you log in with must be Owner (or Contributor + User Access
  Administrator) on the subscription: the stack assigns two roles to the
  VM's managed identity.
- `deploy/azure/.env.engine` — the engine's env for the VM. Gitignored
  (`.env.*`). Seeded 2026-09-16 from the AWS draft (fresh
  `TENANT_MASTER_KEY` already inside); fill its `TODO(operator)` lines.
  The script refuses to upload it unless it has:
  - `TENANT_ENGINE_ENABLED=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `TENANT_MASTER_KEY=<openssl rand -hex 32>` (no DPAPI on Linux; losing it
    makes every sealed tenant session unreadable — users would reconnect)
  - NO `AGENT_CDP_URL` — the operator's debug Chrome does not exist there
  - `REMOTE_BROWSER_ENABLED=true` plus the provider block (Browserbase keys,
    or `REMOTE_BROWSER_PROVIDER=browser_use` + `BROWSER_USE_ENABLED=true` +
    `BROWSER_USE_API_KEY`); `CLOUD_BASE_URL`; the LLM key; the same
    fail-closed flags you run with locally.
- `frontend/.env.production` (gitignored) for the site build:
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (publishable key only),
  `VITE_PUBLIC_URL=https://<domain>`, `VITE_LIVE_VIEW_ORIGIN` (the
  provider's live-view origin). Never `VITE_CONSOLE_ENABLED`; the script
  refuses that file.
- No Docker needed: `push` builds the image inside ACR (ACR Tasks) from
  the repo context, honouring `.dockerignore`.

## Commands

```
deploy/azure/deploy.sh bootstrap        # resource group + ACR + Key Vault + the env secret
deploy/azure/deploy.sh push             # build the image in ACR (tag = git sha)
deploy/azure/deploy.sh stack            # deploy engine-vm.bicep with that image
deploy/azure/deploy.sh logs             # last 200 log lines (run-command)
deploy/azure/deploy.sh shell "<cmd>"    # one shell command on the VM
deploy/azure/deploy.sh redeploy         # after a new push: switch the VM to it
deploy/azure/deploy.sh secret           # after editing .env.engine: re-upload + restart
deploy/azure/deploy.sh status           # VM power state + last deployment

deploy/azure/deploy.sh site-create      # the Static Web App (Free)
deploy/azure/deploy.sh site-push        # npm run build in frontend/ + deploy dist/
deploy/azure/deploy.sh site-domain <h>  # www.<domain> (CNAME) or the apex (TXT + alias)
```

First deploy: `bootstrap → push → stack`, then `logs` and expect the
scheduler's first tick lines (the first start can take a few minutes:
cloud-init installs Docker and the CLI, and the role assignments
propagate; the unit retries every 15 s until the secret and the pull
succeed). A code change: `push → redeploy`. A flag or key change: edit
`.env.engine`, `secret`. Site: `site-create → site-push → site-domain`.

Operator shell: there is none. `shell "<cmd>"` runs one command through
`az vm run-command` (no SSH, no inbound port). On the VM: env file
`/etc/dispatch/engine.env` (0600, rewritten from the secret at every
service start), image ref `/etc/dispatch/image`, data under
`/data/dispatch` (mounted as `/data` in the container: `tenants/`,
`private/`, `engine/app.sqlite`, `artifacts/`), service
`dispatch-engine` (`systemctl status dispatch-engine`).

## Domain (GoDaddy registrar)

- `www.<domain>`: a CNAME at GoDaddy to the app's default hostname
  (`site-create` prints it), then `site-domain www.<domain>`.
- The apex `<domain>`: Static Web Apps validates it by TXT record and then
  needs an ALIAS/ANAME-style record, which GoDaddy's DNS does not offer.
  Two ways: forward the apex to `www` at GoDaddy (simplest), or move DNS
  to an Azure DNS zone (registrar stays GoDaddy; change the nameservers)
  and add an alias A record to the Static Web App. Either way, Supabase →
  Authentication → URL Configuration must list the origin you end up on.
- `CLOUD_BASE_URL` in `.env.engine` and `VITE_PUBLIC_URL` in
  `frontend/.env.production` are that same origin.

## What the stack creates

VNet + one subnet; an NSG whose only inbound rule denies everything (and
allows all outbound); a Standard static public IP for egress only; a
`Standard_D2s_v5` Ubuntu 24.04 VM with a system-assigned identity, a 32 GiB
OS disk deleted with the VM, and a 64 GiB Premium data disk detached
(kept) with the VM; two role assignments (AcrPull on the registry, Key
Vault Secrets User on the vault) for that identity. cloud-init formats
and mounts the data disk once, installs Docker and the Azure CLI, writes
the refresh script (secret → env file, ACR login, pull) and a systemd unit
that runs the container with `Restart=always`. The container runs one
scheduler day (`--duration 1440`) and is restarted by systemd, which also
re-reads the secret.

## Costs (list, eastus2)

`Standard_D2s_v5` ≈ $70/month pay-as-you-go, the two Premium disks ≈ $15,
ACR Basic $5, Key Vault pennies, Static Web App Free $0 — inside the
credit. Deallocate the VM when idle (`az vm deallocate -g dispatch -n
dispatch-engine`); the data disk and its contents stay.

## Known limits of v0

- One VM, one scheduler: `TENANT_MAX_CONCURRENT` (≤ 8) bounds parallel
  tenant runs; each is a headless Chromium (~400 MB). Size the VM to that
  or move to Container Apps jobs per user later.
- SQLite lives on the data disk — snapshot it (`az snapshot create`);
  there is no managed Postgres for engine state.
- Gmail for tenants runs through the user's own sealed session (M25); the
  Gmail flags in `.env.engine` are the ceiling.
- `logs` is a snapshot, not a stream; run it again, or `shell "journalctl
  -u dispatch-engine -n 100"`.
