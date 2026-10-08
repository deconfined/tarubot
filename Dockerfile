# Apply Alpine fixes released after the pinned Bun image was published. All stages use the
# same patched base so compilation/tests exercise the runtime's musl and system libraries.
FROM oven/bun:1.4.2-alpine AS base
RUN apk upgrade --no-cache

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

# Both services execute compiled ESM as a non-root user.
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
# Host delivery tests use Bash, GNU date, Git, jq and util-linux's flock/setsid options; these
# tools belong only in this stage, so the runtime retains the minimal base.
# The test harness injects the SQL fixture separately into an ephemeral container.
FROM build AS test
RUN apk add --no-cache bash coreutils git jq flock util-linux-misc
RUN bun run typecheck && bun run test:unit && bun run test:contract
CMD ["bun", "test", "tests"]

# Preserve directory layout: discovery resolves compiled modules relative to import.meta.url.
FROM runtime AS tarubot
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun test-plans ./test-plans
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]
