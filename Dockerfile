# The pinned Bun release; only its musl binary is used, copied into the base below.
FROM oven/bun:1.4.2-alpine AS bun

# Alpine 3.24 is the first Alpine with a PostgreSQL 18 client (pg_dump must be at least as new as
# the server, and the Bun image's own Alpine 3.22 stops at 17). Fixes released after the pinned
# digest are applied at build time. Every stage builds on this one, so compilation and tests run on
# the runtime's musl, system libraries and PostgreSQL client: the test stage restores real dumps.
FROM docker.io/library/alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a AS base
RUN apk upgrade --no-cache && apk add --no-cache libgcc libstdc++ postgresql18-client \
 && addgroup -g 1000 bun && adduser -D -u 1000 -G bun -h /home/bun bun
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx
# As in the Bun image: no runtime transpiler cache, which a read-only root filesystem can't hold.
ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

# Compile all first-party code plus discoverable modules using pinned Bun. The runtime image
# depends on this compilation only, so publishing never re-runs the test suite.
FROM base AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Keep source/build dependencies separate from the final runtime dependency tree.
FROM base AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# The bot and its maintenance tools (backup.js and restore.js call pg_dump and pg_restore) execute
# compiled ESM as a non-root user.
FROM base AS runtime
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun LICENSE ./LICENSE
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
USER bun
STOPSIGNAL SIGTERM

# Verify the compiled tree on this platform's base: pull-request CI builds this stage on native
# AMD64 and ARM64 before merge, and publication then reuses that proof for the identical tree.
# Bash, Git and jq are for the tests that run workflow steps (publish-gate.test.ts and its
# siblings run `run:` blocks under Bash with jq, against a scratch Git history); they belong only
# in this stage, so the runtime keeps the minimal base.
# The test harness injects the SQL fixture separately into an ephemeral container.
FROM build AS test
RUN apk add --no-cache bash git jq
RUN bun run typecheck && bun run test:unit && bun run test:contract
CMD ["bun", "test", "tests"]

# The web proxy (published as ghcr.io/deconfined/tarubot:web-X.Y.Z beside each release): the stock
# Caddy image with TaruBot's Caddyfile and offline page, so the proxy needs no bind mounts and
# follows the release like the bot. Root-owned files 0644 and directories 0755, nothing else,
# whatever the checkout's modes, on every BuildKit Docker engine: older built-in frontends (Engine
# 27.x) reject a symbolic --chmod, and newer ones give a COPY's implicitly created parents its file
# mode, so a 0644 directory the cap-dropped Caddy couldn't enter. So WORKDIR creates the two
# directories (always 0755) and restores the image's own /srv, and each COPY sets numeric file
# modes. Only COPY and WORKDIR: publish.yml builds both platforms without emulation. ops/offline is
# one level deep (offline-page.test.ts fails if it gains a subdirectory this doesn't create).
FROM docker.io/library/caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f AS web
WORKDIR /srv/offline/assets
WORKDIR /srv
COPY --chmod=0644 ops/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0644 ops/offline/index.html /srv/offline/index.html
COPY --chmod=0644 ops/offline/assets/ /srv/offline/assets/

# Preserve directory layout: discovery resolves compiled modules relative to import.meta.url.
# Last, so a plain `docker build` produces the bot.
FROM runtime AS tarubot
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun test-plans ./test-plans
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]
