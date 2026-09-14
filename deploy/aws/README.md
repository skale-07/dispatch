# Hosted engine on AWS — v0 runbook

One Linux box (EC2, Amazon Linux 2023) running the tenant scheduler
container from `deploy/engine.Dockerfile`, tenant workspaces on its own
encrypted EBS volume, secrets in Secrets Manager, no inbound ports. This
is today's architecture — every tenant on one engine host — moved off
the operator's Windows machine and onto AWS credits. Per-user Fargate
tasks are the later shape (`docs/roadmap/cloud-deploy.md`, Phase v1).

Browsers: a tenant apply run drives the image's own headless Chromium
with the tenant's unsealed login state. Browserbase is used only for the
login handoffs (the user signs into JobRight and Gmail in a live view).
So the box needs Browserbase egress and keys, but no display and no
Chrome install.

## What you need once

- An IAM identity that may deploy. Found 2026-09-14: the operator box
  had stale `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in the shell
  environment shadowing a working `~/.aws/credentials` profile, and that
  profile's user (`SnapSortImageRec`, another project) has no ECR /
  CloudFormation / EC2 / IAM rights. Fix in the AWS console: IAM → create
  user `dispatch-deployer` (or attach to your admin user) → attach the
  policy in `deploy/aws/iam-deployer-policy.json` (it names exactly what
  `deploy.sh` and the stack need: ECR push, the `dispatch/*` secrets, the
  `dispatch-engine` stack and its VPC/EC2/role resources, SSM for the
  operator shell) → create an access key → `aws configure --profile
  dispatch`. Then run every command below as
  `AWS_PROFILE=dispatch deploy/aws/deploy.sh …` — the script drops stray
  env keys when a profile is named. `aws sts get-caller-identity` must
  show that user before anything else.
- Docker and git on the machine you deploy from.
- `deploy/aws/.env.engine` — the engine's env for the box. Gitignored
  (`.env.*`). A first draft was generated on 2026-09-14 from the
  operator `.env` with the operator-only keys removed and a fresh master
  key appended; fill its `TODO(operator)` lines (Browserbase keys,
  `CLOUD_BASE_URL`). The deploy script refuses to upload it unless it has:
  - `TENANT_ENGINE_ENABLED=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  - `TENANT_MASTER_KEY=<openssl rand -hex 32>` — the tenant master key
    (Windows DPAPI does not exist on Linux). Generate it once, keep it in
    the secret only. Losing it makes every sealed tenant session
    unreadable; users would reconnect.
  - NO `AGENT_CDP_URL` — the operator's debug Chrome does not exist there.
  - `REMOTE_BROWSER_ENABLED=true` + `BROWSERBASE_API_KEY` +
    `BROWSERBASE_PROJECT_ID` for handoffs; `CLOUD_BASE_URL`; the LLM key
    and the same fail-closed flags you run with locally. Flags absent ⇒
    off, exactly as on the operator box.

## Commands

```
deploy/aws/deploy.sh bootstrap   # ECR repo + Secrets Manager secret from .env.engine
deploy/aws/deploy.sh push        # build the image (tag = git sha) and push
deploy/aws/deploy.sh stack       # create/update the CloudFormation stack
deploy/aws/deploy.sh logs        # follow the container log (SSM session)
deploy/aws/deploy.sh redeploy    # after a new `push`: switch the box to it
deploy/aws/deploy.sh secret      # after editing .env.engine: re-upload + restart
deploy/aws/deploy.sh status      # stack status + outputs
```

First deploy: `bootstrap → push → stack`, then `logs` and expect the
scheduler's first tick lines. A code change: `push → redeploy`. A flag
or key change: edit `.env.engine`, `secret`.

Operator shell (no SSH): the stack's `Shell` output —
`aws ssm start-session --target <instance>`. On the box: the env file is
`/etc/dispatch/engine.env` (0600, rewritten from the secret at every
service start), the image URI `/etc/dispatch/image`, data under
`/data/dispatch` (mounted as `/data` in the container: `tenants/`,
`private/`, `engine/app.sqlite`, `artifacts/`), service
`dispatch-engine` (`systemctl status dispatch-engine`).

## What the stack creates

VPC + one public subnet + internet gateway; an egress-only security
group (no ingress rules at all); an instance role with SSM core, ECR
read, and `GetSecretValue` on exactly the env secret; one `t3.large`
with a 50 GiB encrypted gp3 root volume that outlives the instance
(`DeleteOnTermination: false`). User data installs Docker, writes the
refresh script (secret → env file, ECR login, pull) and a systemd unit
that runs the container with `Restart=always`. The container runs one
scheduler day (`--duration 1440`) and is restarted by systemd, which
also re-reads the secret.

Drift-tested by `tests/unit/deploy-engine-image.test.ts`: Playwright base
image = installed playwright version; no `.env`/`private/` in the image;
no inbound port; the env file is gitignored.

## Costs (us-east-1, list)

`t3.large` ≈ $60/month on demand, 50 GiB gp3 ≈ $4, Secrets Manager
$0.40/secret, ECR pennies — well inside the $10k credit. Stop the
instance when idle (`aws ec2 stop-instances`); the volume and data stay.

## Known limits of v0

- One box, one scheduler: `TENANT_MAX_CONCURRENT` (≤ 8) bounds parallel
  tenant runs; each run is a headless Chromium (~400 MB). Size the
  instance to that, or move to Fargate per user (Phase v1).
- SQLite lives on the box's volume — back it up with EBS snapshots
  (`aws ec2 create-snapshot`); there is no RDS.
- The Gmail transport for tenants is still forced off in
  `src/tenants/childEnv.ts` until the drafter drives the tenant's own
  browser (launch checklist §3).
