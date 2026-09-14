# syntax=docker/dockerfile:1
# Hosted ENGINE image — the per-tenant scheduler on Linux (deploy/aws).
# Build from the REPO ROOT:  docker build -f deploy/engine.Dockerfile -t dispatch-engine .
#
# What runs here: `tenant:scheduler` — the bounded loop over the cloud
# queue (src/tenants/scheduler.ts): materialize a tenant's workspace,
# provision Browserbase handoffs for logins, and run `auto:cycle` as a
# CHILD process per tenant. Two facts shape the image:
#
#   1. The child is spawned as `node <tsx> src/cli/index.ts …`
#      (src/tenants/run.ts), so the image ships the SOURCE tree and tsx,
#      not a dist/ build. Same code path as the operator's box.
#   2. A tenant apply run drives a LOCAL headless Chromium with the
#      tenant's unsealed login state (STORAGE_STATE mode); Browserbase is
#      only for the login handoff. So the base image is Playwright's own,
#      which carries Chromium and every system library it needs, pinned
#      to the exact playwright version in package-lock (drift-tested by
#      tests/unit/deploy-engine-image.test.ts).
#
# What is NOT here: no .env, no private/ data, no keys. Every secret
# arrives as injected env (deploy/aws: Secrets Manager → --env-file),
# and DOTENV_OVERRIDE=false means a stray .env could never beat it.
# All mutation flags stay fail-closed defaults unless that env sets them.

FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app
ENV NODE_ENV=production \
    DOTENV_OVERRIDE=false \
    # Playwright's image already holds the browsers; never re-download.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # No Chrome/Edge channel on Linux — the bundled Chromium is the browser.
    BROWSER_CHANNEL=chromium \
    # Everything stateful lives on the mounted volume.
    TENANTS_ROOT=/data/tenants \
    PRIVATE_DIR=/data/private \
    DATABASE_PATH=/data/engine/app.sqlite \
    ARTIFACTS_DIR=/data/artifacts

# better-sqlite3 may need to compile when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Full install on purpose: tsx (a devDependency) is the child launcher,
# and NODE_ENV=production above would otherwise make npm skip it.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY prompts ./prompts
COPY src ./src

# The code version the engine stamps on rows (src/storage/codeVersion.ts)
# comes from the build, not from a .git directory the image never has.
ARG CODE_VERSION=unknown
ENV CODE_VERSION=${CODE_VERSION}

RUN mkdir -p /data/tenants /data/private /data/engine /data/artifacts
VOLUME /data

# One scheduler day per container life; the host restarts it (systemd
# Restart=always), which also picks up a refreshed env file.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/tenants/cli.ts", "scheduler", "--duration", "1440", "--interval", "60"]
