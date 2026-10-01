# Apply Alpine fixes released after the pinned Bun image was published. All stages use the
# same patched base so compilation/tests exercise the runtime's musl and system libraries.
FROM oven/bun:1.4.2-alpine AS base
RUN apk upgrade --no-cache

# Compile and verify all first-party code plus discoverable modules using pinned Bun.
FROM base AS build
# Host/workflow tests use Bash, GNU date and util-linux's flock/setsid options.
# These tools belong only in the build/test stage; the runtime retains the minimal base.
RUN apk add --no-cache bash coreutils flock util-linux-misc
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run typecheck && bun run test:unit && bun run test:contract

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

# The test harness injects the SQL fixture separately into an ephemeral container.
FROM build AS test
CMD ["bun", "test", "tests"]

# Preserve directory layout: discovery resolves compiled modules relative to import.meta.url.
FROM runtime AS tarubot
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun test-plans ./test-plans
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]
