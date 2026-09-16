#!/usr/bin/env bash
# Dispatch hosted engine + public site on Azure — the whole lifecycle in one
# script (operator decision 2026-09-16: Azure credits, no Vercel). Runs from
# Git Bash on Windows or any POSIX shell; needs azure-cli (`az login` done),
# git, node/npm. No local Docker: the image is built by ACR Tasks. Every
# command is idempotent; nothing here reads or prints a secret value (the
# env file and the site deployment token are passed to the CLI, never echoed).
#
#   deploy/azure/deploy.sh bootstrap    # resource group + ACR + Key Vault + the env secret (deploy/azure/.env.engine)
#   deploy/azure/deploy.sh push         # build deploy/engine.Dockerfile IN ACR, tag = git sha
#   deploy/azure/deploy.sh stack        # deploy engine-vm.bicep with that image (VM, disk, NSG, roles)
#   deploy/azure/deploy.sh redeploy     # point the running VM at the newest pushed image and restart
#   deploy/azure/deploy.sh secret       # re-upload deploy/azure/.env.engine and restart (new flags/keys)
#   deploy/azure/deploy.sh logs         # last 200 lines of the engine container's log (run-command)
#   deploy/azure/deploy.sh shell "<cmd>"  # run one shell command on the VM (no SSH, no inbound port)
#   deploy/azure/deploy.sh status       # VM power state + last deployment
#   deploy/azure/deploy.sh site-create  # Azure Static Web App (Free) for the frontend
#   deploy/azure/deploy.sh site-push    # build frontend/ (frontend/.env.production) and deploy dist/
#   deploy/azure/deploy.sh site-domain <hostname>  # attach www.<domain> or the apex; prints the DNS records
#
# First deploy: bootstrap → push → stack (then `logs`); site-create → site-push → site-domain.
# Code change: push → redeploy. Flag or key change: edit .env.engine, then `secret`.
set -euo pipefail

RG="${DISPATCH_RG:-dispatch}"
LOCATION="${DISPATCH_LOCATION:-eastus2}"
# Static Web Apps is offered in a short region list; eastus2 is in it.
SITE_LOCATION="${DISPATCH_SITE_LOCATION:-eastus2}"
VM="${DISPATCH_VM:-dispatch-engine}"
SITE="${DISPATCH_SITE:-dispatch-site}"
SECRET_NAME="${DISPATCH_ENV_SECRET:-engine-env}"
IMAGE_REPO="${DISPATCH_IMAGE_REPO:-dispatch-engine}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/azure/.env.engine"
TEMPLATE="$ROOT/deploy/azure/engine-vm.bicep"
SSH_KEY="$ROOT/private/azure/engine_ed25519"

say() { printf '%s\n' "$*" >&2; }
die() { say "deploy.sh: $*"; exit 1; }

need_login() { az account show --query id -o tsv >/dev/null 2>&1 || die "not logged in — run: az login (then az account set --subscription <the credits subscription>)"; }
sub_id() { az account show --query id -o tsv; }
# ACR and Key Vault names are global: suffix them with the subscription id.
suffix() { sub_id | tr -d '-' | cut -c1-8; }
acr_name() { printf '%s' "${DISPATCH_ACR:-dispatchacr$(suffix)}"; }
kv_name() { printf '%s' "${DISPATCH_KV:-dispatch-kv-$(suffix)}"; }
git_sha() { git -C "$ROOT" rev-parse --short=12 HEAD; }
image_ref() { printf '%s.azurecr.io/%s:%s' "$(acr_name)" "$IMAGE_REPO" "$(git_sha)"; }

check_env_file() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy .env.example, set the hosted values (deploy/azure/README.md); it is gitignored"
  grep -q '^TENANT_MASTER_KEY=[0-9a-fA-F]\{64\}$' "$ENV_FILE" || die ".env.engine needs TENANT_MASTER_KEY=<64 hex> (openssl rand -hex 32)"
  grep -q '^TENANT_ENGINE_ENABLED=true$' "$ENV_FILE" || die ".env.engine needs TENANT_ENGINE_ENABLED=true"
  grep -q '^SUPABASE_URL=https://' "$ENV_FILE" || die ".env.engine needs SUPABASE_URL"
  grep -q '^SUPABASE_SERVICE_ROLE_KEY=.' "$ENV_FILE" || die ".env.engine needs SUPABASE_SERVICE_ROLE_KEY"
  if grep -q '^AGENT_CDP_URL=' "$ENV_FILE"; then die ".env.engine must not set AGENT_CDP_URL — tenant runs use the image's headless Chromium"; fi
}

cmd_bootstrap() {
  need_login
  check_env_file
  local acr kv me
  acr="$(acr_name)"; kv="$(kv_name)"
  say "subscription $(sub_id), resource group $RG in $LOCATION"
  # A fresh (credits) subscription has most resource providers unregistered; registering is idempotent.
  for ns in Microsoft.Compute Microsoft.Network Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.Web; do
    az provider register --namespace "$ns" -o none 2>/dev/null || true
  done
  az group create -n "$RG" -l "$LOCATION" -o none
  if ! az acr show -n "$acr" -g "$RG" >/dev/null 2>&1; then
    az acr create -n "$acr" -g "$RG" --sku Basic -o none
    say "created ACR $acr"
  fi
  if ! az keyvault show -n "$kv" -g "$RG" >/dev/null 2>&1; then
    az keyvault create -n "$kv" -g "$RG" -l "$LOCATION" --enable-rbac-authorization true -o none
    say "created Key Vault $kv"
  fi
  # The deployer writes the secret; the VM's identity only reads it (stack).
  me="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || az account show --query user.name -o tsv)"
  az role assignment create --assignee "$me" --role "Key Vault Secrets Officer" \
    --scope "$(az keyvault show -n "$kv" -g "$RG" --query id -o tsv)" -o none 2>/dev/null || true
  az keyvault secret set --vault-name "$kv" --name "$SECRET_NAME" --file "$ENV_FILE" --encoding utf-8 -o none
  say "uploaded secret $SECRET_NAME to $kv"
}

cmd_push() {
  need_login
  local ref; ref="$(image_ref)"
  # Remote build: the context goes up to ACR Tasks (respecting .dockerignore), no local Docker needed.
  az acr build --registry "$(acr_name)" --resource-group "$RG" \
    --image "$IMAGE_REPO:$(git_sha)" --file deploy/engine.Dockerfile \
    --build-arg "CODE_VERSION=$(git_sha)" "$ROOT"
  say "pushed $ref"
  printf '%s\n' "$ref"
}

ensure_ssh_key() {
  if [ ! -f "$SSH_KEY.pub" ]; then
    mkdir -p "$(dirname "$SSH_KEY")"
    ssh-keygen -t ed25519 -N "" -C "dispatch-engine (inbound blocked; kept for recovery only)" -f "$SSH_KEY" >/dev/null
    say "generated $SSH_KEY (private/, gitignored)"
  fi
}

cmd_stack() {
  need_login
  local ref; ref="${1:-$(image_ref)}"
  ensure_ssh_key
  az deployment group create -g "$RG" -n "dispatch-engine-$(git_sha)" \
    --template-file "$TEMPLATE" \
    --parameters image="$ref" acrName="$(acr_name)" keyVaultName="$(kv_name)" envSecretName="$SECRET_NAME" \
      sshPublicKey="$(cat "$SSH_KEY.pub")" \
    --query 'properties.outputs' -o json
  cmd_status
}

vm_run() {
  # Run a shell snippet on the VM and print its output. No SSH: the NSG denies every inbound flow.
  az vm run-command invoke -g "$RG" -n "$VM" --command-id RunShellScript --scripts "$1" \
    --query 'value[0].message' -o tsv
}

cmd_redeploy() {
  need_login
  local ref; ref="${1:-$(image_ref)}"
  vm_run "echo '$ref' > /etc/dispatch/image && systemctl restart dispatch-engine && sleep 5 && systemctl is-active dispatch-engine"
}

cmd_secret() {
  need_login
  check_env_file
  az keyvault secret set --vault-name "$(kv_name)" --name "$SECRET_NAME" --file "$ENV_FILE" --encoding utf-8 -o none
  say "updated secret $SECRET_NAME; restarting the engine so it re-reads it"
  vm_run "systemctl restart dispatch-engine && sleep 5 && systemctl is-active dispatch-engine"
}

cmd_logs() { need_login; vm_run "docker logs --tail 200 dispatch-engine 2>&1"; }
cmd_shell() { need_login; [ -n "${1:-}" ] || die "shell needs a command string"; vm_run "$1"; }

cmd_status() {
  need_login
  az vm get-instance-view -g "$RG" -n "$VM" --query '{name:name, power:instanceView.statuses[1].displayStatus, size:hardwareProfile.vmSize}' -o table 2>/dev/null || say "no VM yet — run 'stack'"
  az deployment group list -g "$RG" --query "[?starts_with(name,'dispatch-engine-')] | [0].{deployment:name, state:properties.provisioningState, at:properties.timestamp}" -o table 2>/dev/null || true
}

cmd_site_create() {
  need_login
  az group create -n "$RG" -l "$LOCATION" -o none
  if ! az staticwebapp show -n "$SITE" -g "$RG" >/dev/null 2>&1; then
    az staticwebapp create -n "$SITE" -g "$RG" -l "$SITE_LOCATION" --sku Free -o none
    say "created Static Web App $SITE"
  fi
  say "default hostname: $(az staticwebapp show -n "$SITE" -g "$RG" --query defaultHostname -o tsv)"
}

cmd_site_push() {
  need_login
  [ -f "$ROOT/frontend/.env.production" ] || die "missing frontend/.env.production (gitignored): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_PUBLIC_URL, VITE_LIVE_VIEW_ORIGIN — never VITE_CONSOLE_ENABLED"
  if grep -q '^VITE_CONSOLE_ENABLED=true' "$ROOT/frontend/.env.production"; then die "frontend/.env.production must not enable the console on a public deploy"; fi
  (cd "$ROOT/frontend" && npm run build)
  [ -f "$ROOT/frontend/dist/staticwebapp.config.json" ] || die "frontend/dist lacks staticwebapp.config.json (it ships from frontend/public/)"
  local token
  token="$(az staticwebapp secrets list -n "$SITE" -g "$RG" --query properties.apiKey -o tsv)"
  [ -n "$token" ] || die "could not read the deployment token"
  (cd "$ROOT" && npx --yes @azure/static-web-apps-cli@2 deploy "$ROOT/frontend/dist" --deployment-token "$token" --env production >&2)
  say "deployed frontend to https://$(az staticwebapp show -n "$SITE" -g "$RG" --query defaultHostname -o tsv)"
}

cmd_site_domain() {
  need_login
  local host="${1:-}"; [ -n "$host" ] || die "site-domain needs a hostname (www.<domain> or the apex <domain>)"
  local default_host; default_host="$(az staticwebapp show -n "$SITE" -g "$RG" --query defaultHostname -o tsv)"
  case "$host" in
    *.*.*)
      say "CNAME $host -> $default_host (add it at the registrar, then this command validates)"
      az staticwebapp hostname set -n "$SITE" -g "$RG" --hostname "$host" -o none
      ;;
    *)
      say "apex domain: Static Web Apps validates by TXT record, then needs an ALIAS/ANAME (or Azure DNS alias) to $default_host"
      az staticwebapp hostname set -n "$SITE" -g "$RG" --hostname "$host" --validation-method dns-txt-token -o none
      say "TXT token: $(az staticwebapp hostname show -n "$SITE" -g "$RG" --hostname "$host" --query validationToken -o tsv)"
      ;;
  esac
  az staticwebapp hostname list -n "$SITE" -g "$RG" -o table
}

case "${1:-}" in
  bootstrap) cmd_bootstrap ;;
  push) cmd_push ;;
  stack) cmd_stack "${2:-}" ;;
  redeploy) cmd_redeploy "${2:-}" ;;
  secret) cmd_secret ;;
  logs) cmd_logs ;;
  shell) cmd_shell "${2:-}" ;;
  status) cmd_status ;;
  site-create) cmd_site_create ;;
  site-push) cmd_site_push ;;
  site-domain) cmd_site_domain "${2:-}" ;;
  *) sed -n '2,23p' "$0" >&2; exit 2 ;;
esac
