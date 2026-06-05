# Mantis — containerised proxy + admin UI + bots.
#
# Build:  docker build -t mantis .
# Run:    docker run -p 8787:8787 -p 8788:8788 -v mantis-data:/root/.mantis mantis
#
# The image runs `mantis serve` (Anthropic-compatible proxy with the admin UI
# mounted at /admin). Config, per-user data, persisted sessions, and the
# conversation search index all live in /root/.mantis — mount a volume there so
# they survive container restarts.
#
# For network access set "proxy.host" / "admin.host" to "0.0.0.0" in
# /root/.mantis/config.json (or pass MANTIS_ADMIN_HOST=0.0.0.0), and enable
# sign-in (mantis auth) before exposing the admin UI.
#
# Node 22.5+ is required — node:sqlite powers conversation search. The node:22
# base satisfies that; search self-disables on anything older.

# ─── deps: production node_modules from the lockfile (cached layer) ───────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# git is handy for the agent's run_command tool; tini reaps zombie processes.
RUN apk add --no-cache git tini

WORKDIR /app

# Prebuilt dependencies, then application code (code changes don't bust the deps
# layer).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts

# Make the CLI available as `mantis`.
RUN npm link

EXPOSE 8787 8788

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bin/mantis.js", "serve"]
