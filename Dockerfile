# Mantis — containerised proxy + admin UI + bots.
#
# Build:  docker build -t mantis .
# Run:    docker run -p 8787:8787 -p 8788:8788 -v mantis-data:/root/.mantis mantis
#
# The image runs `mantis serve` (Anthropic-compatible proxy with the admin UI
# mounted at /admin). Config and per-user data live in /root/.mantis — mount a
# volume there so they survive container restarts.
#
# For network access set "proxy.host" to "0.0.0.0" in /root/.mantis/config.json,
# and enable sign-in (mantis auth) before exposing the admin UI.

FROM node:22-alpine

# git is handy for the agent's run_command tool; tini reaps zombie processes.
RUN apk add --no-cache git tini

WORKDIR /app

# Install only production dependencies first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Application code.
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts

# Make the CLI available as `mantis`.
RUN npm link

EXPOSE 8787 8788

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bin/mantis.js", "serve"]
