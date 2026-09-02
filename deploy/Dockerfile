# syntax=docker/dockerfile:1
# Console image (engine-plane read surface, v0.5+ groundwork).
# Build from the REPO ROOT:  docker build -f deploy/Dockerfile -t dispatch-console .
# Runs the operator console with plain `node dist/...` — no tsx at runtime.
#
# What this image is NOT: it has no Playwright browsers, no private/ data,
# no ATS credentials. It serves the built frontend + the read API over the
# mounted SQLite database. Mutation capability still requires the same
# fail-closed .env flags as everywhere else (none are baked in here).

# ── Stage 1: frontend build (Vite) ─────────────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: backend build (tsc -> dist) ───────────────────────────────
FROM node:22-slim AS build
WORKDIR /app
# playwright's postinstall downloads browsers unless told not to; the
# console image never drives a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/copy-dist-assets.mjs ./scripts/copy-dist-assets.mjs
COPY src ./src
RUN npm run build

# ── Stage 3: production node_modules ───────────────────────────────────
# Separate stage with a toolchain so better-sqlite3 can compile if no
# prebuilt binary matches; the runtime stage stays toolchain-free.
FROM node:22-slim AS deps
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 4: runtime ───────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
# DOTENV_OVERRIDE=false: on a platform, injected env must always beat any
# stray .env baked into an image (see docs/roadmap/cloud-deploy.md).
ENV NODE_ENV=production \
    DOTENV_OVERRIDE=false
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=frontend /app/frontend/dist ./frontend/dist
# SQLite lives on a volume; the image itself is stateless.
VOLUME /app/data
EXPOSE 8899
# NOTE: the console binds CONSOLE_HOST=127.0.0.1 by design (loopback-only
# security model). Inside a container that means `docker exec`/sidecar
# access only. To publish a port, run the image in HOSTED mode
# (CONSOLE_HOSTED_MODE_ENABLED=true + CONSOLE_HOST=0.0.0.0 + SUPABASE_URL +
# CONSOLE_HOSTED_ALLOWED_HOSTS + CONSOLE_HOSTED_ALLOWED_USER_IDS, all as
# injected env — deploy/first-deploy.md Part C2): every /api request then
# needs a verified Supabase JWT and the console is read-only. Nothing is
# baked in here, so the image cannot silently weaken the local model.
CMD ["node", "dist/cli/index.js", "console"]
