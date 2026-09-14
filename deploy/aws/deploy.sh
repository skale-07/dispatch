#!/usr/bin/env bash
# Dispatch hosted engine on AWS — the whole lifecycle in one script.
# Runs from Git Bash on Windows or any POSIX shell; needs aws-cli v2,
# docker, git. Every command is idempotent; nothing here reads or prints
# a secret value (the env file is uploaded, never echoed).
#
#   deploy/aws/deploy.sh bootstrap   # ECR repo + the env secret (from deploy/aws/.env.engine)
#   deploy/aws/deploy.sh push        # build deploy/engine.Dockerfile, tag = git sha, push to ECR
#   deploy/aws/deploy.sh stack       # create/update the CloudFormation stack with that image
#   deploy/aws/deploy.sh redeploy    # point the running box at the newest pushed image and restart
#   deploy/aws/deploy.sh secret      # re-upload deploy/aws/.env.engine and restart (new flags/keys)
#   deploy/aws/deploy.sh logs        # tail the engine container's log over SSM
#   deploy/aws/deploy.sh status      # stack outputs + instance state
#
# Order for a first deploy: bootstrap → push → stack (then `logs`).
# Order for a code change:  push → redeploy.
set -euo pipefail

# A named profile beats stray AWS_ACCESS_KEY_ID/SECRET in the shell (the
# operator box had stale ones shadowing a working ~/.aws/credentials on
# 2026-09-14): `AWS_PROFILE=default deploy/aws/deploy.sh …`.
if [ -n "${AWS_PROFILE:-}" ]; then unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; fi

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STACK="${DISPATCH_STACK:-dispatch-engine}"
REPO="${DISPATCH_ECR_REPO:-dispatch-engine}"
SECRET_NAME="${DISPATCH_ENV_SECRET:-dispatch/engine-env}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/deploy/aws/.env.engine"
TEMPLATE="$ROOT/deploy/aws/engine-ec2.yaml"

say() { printf '%s\n' "$*" >&2; }
die() { say "deploy.sh: $*"; exit 1; }

account() { aws sts get-caller-identity --query Account --output text; }
registry() { printf '%s.dkr.ecr.%s.amazonaws.com' "$(account)" "$REGION"; }
git_sha() { git -C "$ROOT" rev-parse --short=12 HEAD; }
image_uri() { printf '%s/%s:%s' "$(registry)" "$REPO" "$(git_sha)"; }
secret_arn() { aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" --query ARN --output text; }
instance_id() { aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text; }

check_env_file() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy .env.example, set the hosted values (deploy/aws/README.md); it is gitignored"
  grep -q '^TENANT_MASTER_KEY=[0-9a-fA-F]\{64\}$' "$ENV_FILE" || die ".env.engine needs TENANT_MASTER_KEY=<64 hex> (openssl rand -hex 32)"
  grep -q '^TENANT_ENGINE_ENABLED=true$' "$ENV_FILE" || die ".env.engine needs TENANT_ENGINE_ENABLED=true"
  grep -q '^SUPABASE_URL=https://' "$ENV_FILE" || die ".env.engine needs SUPABASE_URL"
  grep -q '^SUPABASE_SERVICE_ROLE_KEY=.' "$ENV_FILE" || die ".env.engine needs SUPABASE_SERVICE_ROLE_KEY"
  if grep -q '^AGENT_CDP_URL=' "$ENV_FILE"; then die ".env.engine must not set AGENT_CDP_URL — tenant runs use the image's headless Chromium"; fi
}

cmd_bootstrap() {
  check_env_file
  aws sts get-caller-identity --query Arn --output text >&2
  if ! aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1; then
    aws ecr create-repository --region "$REGION" --repository-name "$REPO" \
      --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 >/dev/null
    say "created ECR repo $REPO"
  fi
  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_NAME" --secret-string "file://$ENV_FILE" >/dev/null
    say "updated secret $SECRET_NAME"
  else
    aws secretsmanager create-secret --region "$REGION" --name "$SECRET_NAME" \
      --description "Dispatch hosted engine .env (deploy/aws)" --secret-string "file://$ENV_FILE" >/dev/null
    say "created secret $SECRET_NAME"
  fi
  say "secret arn: $(secret_arn)"
}

cmd_push() {
  local uri; uri="$(image_uri)"
  aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$(registry)" >/dev/null
  docker build -f "$ROOT/deploy/engine.Dockerfile" --build-arg "CODE_VERSION=$(git_sha)" -t "$uri" "$ROOT"
  docker push "$uri"
  say "pushed $uri"
  printf '%s\n' "$uri"
}

cmd_stack() {
  local uri; uri="${1:-$(image_uri)}"
  aws cloudformation deploy --region "$REGION" --stack-name "$STACK" \
    --template-file "$TEMPLATE" --capabilities CAPABILITY_IAM \
    --parameter-overrides "ImageUri=$uri" "EnvSecretArn=$(secret_arn)" \
    --no-fail-on-empty-changeset
  cmd_status
}

ssm_run() {
  # Run a shell snippet on the box and wait for it; prints its stdout.
  local id; id="$(instance_id)"
  [ -n "$id" ] && [ "$id" != "None" ] || die "no instance — run 'stack' first"
  local cmd_id
  cmd_id="$(aws ssm send-command --region "$REGION" --instance-ids "$id" \
    --document-name AWS-RunShellScript --parameters "commands=[\"$1\"]" \
    --query Command.CommandId --output text)"
  aws ssm wait command-executed --region "$REGION" --command-id "$cmd_id" --instance-id "$id" || true
  aws ssm get-command-invocation --region "$REGION" --command-id "$cmd_id" --instance-id "$id" \
    --query '[Status, StandardOutputContent, StandardErrorContent]' --output text
}

cmd_redeploy() {
  local uri; uri="${1:-$(image_uri)}"
  ssm_run "echo '$uri' > /etc/dispatch/image && systemctl restart dispatch-engine && sleep 5 && systemctl is-active dispatch-engine"
}

cmd_secret() {
  check_env_file
  aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_NAME" --secret-string "file://$ENV_FILE" >/dev/null
  say "updated secret $SECRET_NAME; restarting the engine so it re-reads it"
  ssm_run "systemctl restart dispatch-engine && sleep 5 && systemctl is-active dispatch-engine"
}

cmd_logs() {
  local id; id="$(instance_id)"
  aws ssm start-session --region "$REGION" --target "$id" \
    --document-name AWS-StartInteractiveCommand \
    --parameters 'command=["docker logs -f --tail 200 dispatch-engine"]'
}

cmd_status() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query 'Stacks[0].[StackStatus, Outputs]' --output table
}

case "${1:-}" in
  bootstrap) cmd_bootstrap ;;
  push) cmd_push ;;
  stack) cmd_stack "${2:-}" ;;
  redeploy) cmd_redeploy "${2:-}" ;;
  secret) cmd_secret ;;
  logs) cmd_logs ;;
  status) cmd_status ;;
  *) sed -n '2,17p' "$0" >&2; exit 2 ;;
esac
