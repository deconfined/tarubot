---
title: Install
description: Install TaruBot with Docker Compose and its bundled PostgreSQL, from the published image.
sidebar:
  order: 3
---

This installs TaruBot with the stock Compose file: the published bot image and a PostgreSQL 18 container next to it. You need the [requirements](/tarubot/deploy/requirements/) and a [Discord application](/tarubot/deploy/discord-application/).

This is the self-hosting Compose path, not permission to operate the upstream instance. That instance uses Linode and managed PostgreSQL with owner-approved exact-digest delivery; [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md) distinguishes repository implementation, manual provisioning and unobserved live cutover.

## 1. Get the Compose file and settings template

Pick a release from the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) and use it for `X.Y.Z` below. On the host, in a directory of its own, pull that release's image and fetch its Compose files, Caddy configuration and settings template from the exact commit that built it:

Choose a release whose exact source contains the dashboard and shared web setup described here. Older images cannot gain the feature by downloading files from `main`; use their matching deployment instructions until a feature-bearing release is published.

```sh
mkdir tarubot && cd tarubot
docker pull ghcr.io/deconfined/tarubot:X.Y.Z
commit=$(docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.yml"
curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.web.yml"
mkdir -p ops
curl -fsSL -o ops/Caddyfile "https://raw.githubusercontent.com/deconfined/tarubot/$commit/ops/Caddyfile"
chmod 644 ops/Caddyfile
curl -fsSL "https://codeload.github.com/deconfined/tarubot/tar.gz/$commit" \
  | tar -xz --strip-components=1 "tarubot-$commit/ops/offline"
chmod -R a+rX ops/offline
curl -fsSL -o .env "https://raw.githubusercontent.com/deconfined/tarubot/$commit/.env.example"
chmod 600 .env
```

The image's `org.opencontainers.image.revision` label names the commit it was built from. The image carries the compiled bot, migrations and tools. Keep `docker-compose.web.yml`, `ops/Caddyfile` and `ops/offline` beside the main manifest in the paths above even for a bot-only install: Compose parses the shared include even when its `web` profile is off. Do not mix these files with a different release or the moving `main` branch.

`ops/offline` (2.41.0 and newer) is the [offline page](/tarubot/deploy/monitoring/#offline-page) bundled Caddy shows while the bot is down. The `tar` line takes just that directory from the same commit's source archive, and `chmod` makes it readable to Caddy, which can't read private files. Without it, Caddy answers a one-line text instead. If Caddy already ran before you fetched it, Docker created an empty `ops/offline` owned by root, which `tar` can't write into: remove it with `sudo rmdir ops/offline` first.

## 2. Fill in `.env`

Edit `.env`. [Configuration](/tarubot/deploy/configuration/) describes every setting; for a first install, set these:

```sh
DISCORD_TOKEN=your-bot-token
DISCORD_APPLICATION_ID=YOUR_APPLICATION_ID
POSTGRES_PASSWORD=a-long-random-url-safe-password
TARUBOT_IMAGE_TAG=X.Y.Z
ENABLE_EFFECTS=true
```

- **`POSTGRES_PASSWORD`** creates the bundled database's login on first start. Use letters, digits, `-` and `_` only (for example the output of `openssl rand -hex 24`), because Compose puts it into the bot's connection URL.
- **`TARUBOT_IMAGE_TAG`** pins a release. Use the same `X.Y.Z` as in step 1, so the bot runs the release its Compose file came from. `latest` follows every release, which makes updates, and any migration they bring, happen whenever the image is pulled; pin a version instead.
- **`ENABLE_EFFECTS=true`** lets the bot change roles and nicknames and post messages. With `false`, it records every decision but holds the Discord changes as paused work.

Leave these as the template has them:

- **`TEST_GUILD_ID`** and **`TEST_PLAN_CHANNEL_ID`** empty, and **`PUBLIC_TEST_RESPONSES=false`**. They're development settings: with `TEST_GUILD_ID` set, the bot answers only in that one server, posts the development session plan to its `#chat` at every startup, labels its issue reports as development ones, and refuses `register.js --global`.
- **`TARUBOT_ENVIRONMENT`** empty, so the maintenance tools use the unmanaged profile.
- **`DATABASE_URL`** is only for tools you run outside the container. The stock Compose file gives the bot its own connection to the bundled database. If you do run local tools, set the same password in it.

### Optional HTTPS dashboard

Use a **2.37.0 or newer** release for the dashboard and bundled Caddy recipe.

The default is bot-only: leave `COMPOSE_PROFILES`, `WEB_PUBLIC_ORIGIN` and `DISCORD_CLIENT_SECRET` empty. To expose the dashboard through bundled Caddy, first meet the [DNS and firewall requirements](/tarubot/deploy/requirements/#optional-public-dashboard) and [register OAuth](/tarubot/deploy/discord-application/#optional-dashboard-oauth), then add:

```sh
COMPOSE_PROFILES=web
WEB_PUBLIC_ORIGIN=https://tarubot.example.org
WEB_PORT=8080
DISCORD_CLIENT_SECRET=YOUR_APPLICATION_CLIENT_SECRET
```

`WEB_PUBLIC_ORIGIN` is shared by the bot and Caddy: it is the public HTTPS origin, not a backend address. Use the existing `DISCORD_APPLICATION_ID`; the client secret is separate from the bot token and is a plain environment setting, with no `DISCORD_CLIENT_SECRET_FILE` support. `WEB_PORT` is the private bot listener (default `8080`), not a host-published port. Caddy alone publishes TCP 80/443 and persists certificates/settings in `caddy_data` and `caddy_config`.

This recipe uses HTTPS's default public port 443. A custom origin such as `https://tarubot.example.org:8443` also needs a matching Caddy `ports` override; changing the origin alone does not change Compose's published ports. Keep port 80 available for certificate issuance/renewal and HTTP redirects.

An external HTTPS reverse proxy is an alternative: leave `COMPOSE_PROFILES` empty, set the same bot web settings and route to `tarubot:8080` (or your `WEB_PORT`) over a private container network. Preserve the public host/protocol, and keep bot web, health and database ports unpublished; do not start a second bot for the dashboard.

## 3. Create the database schema

```sh
docker compose pull
docker compose up -d --wait postgres
docker compose run --rm --no-deps tarubot bun dist/scripts/migrate.js
```

`migrate.js` applies every migration in one transaction and prints `Schema ready.` The bot refuses to start against a database whose schema doesn't match its release, so migrations always come first.

## 4. Register the slash commands

Register the commands once, in one scope:

```sh
# In every server the bot joins:
docker compose run --rm --no-deps tarubot bun dist/scripts/register.js --global

# Or in one server only:
docker compose run --rm --no-deps tarubot bun dist/scripts/register.js --guild YOUR_GUILD_ID
```

Guild commands appear at once in that one server; global commands can take a little longer to show up everywhere. Don't register both: a server that has both sees every command twice. `commands.js list` checks the result, and `commands.js clear-guild` removes leftovers; see [Maintenance tools](/tarubot/deploy/tools/).

## 5. Start the bot

```sh
docker compose up -d --wait
```

`--wait` returns once the bot's health check passes. Check readiness and the log:

```sh
docker compose exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.HEALTH_PORT || "3000") + "/health/ready"); console.log(await r.text())'
docker compose logs --since 10m tarubot
```

Readiness must report `database`, `writerLease`, `discord` and `effects` as `true`. See [Monitoring](/tarubot/deploy/monitoring/) for the rest.

If web is enabled, `--wait` also checks Caddy's private health: its loopback admin process and a response from the bot's private web listener; Caddy startup depends on the bot's main readiness. This is not proof of public DNS, TLS or OAuth. From outside the host, open `https://tarubot.example.org`, check a trusted certificate and the HTTP-to-HTTPS redirect, then verify Discord login returns to the exact registered `/auth/callback` URL and only authorized servers are visible. Do not bypass certificate verification to call this accepted.

## 6. Add the bot to your server

Add the bot with [the scopes and permissions it needs](/tarubot/admin/add-to-server/#adding-the-bot), place its role, and [set the server up](/tarubot/admin/setup/). A new server goes live with its first `/config` change or `/setup onboarding confirm:true`: there's no activation step. If TaruBot can't see every channel without Administrator, give it Administrator only for [the setup window](/tarubot/admin/add-to-server/#the-setup-window), and take it away as soon as `/config validate` says so.

Next: [back up](/tarubot/deploy/operations/#backup) the database regularly, and read [Updates, backups and recovery](/tarubot/deploy/operations/) before your first update.

## Pinning an exact image

`TARUBOT_IMAGE_TAG` also accepts `sha-<commit>`, the full commit that published an image. To pin by digest, set `TARUBOT_IMAGE` to the complete reference, such as `ghcr.io/deconfined/tarubot@sha256:<digest>`; it overrides `TARUBOT_IMAGE_TAG`.

New bot releases publish version and commit tags after their checks pass. Documentation and pipeline maintenance can merge without a bot release, so some commits on `main` have no image. A maintenance fix can finish the same release if its build failed before publishing a version tag. Existing version tags are preserved.

### Checking where an image came from

Images from 2.32.0 on carry signed build provenance: a signature, made by the project's publish workflow on `main`, that names the commit the image was built from. The upstream project checks it before every deploy. To check an image yourself, with the [GitHub CLI](https://cli.github.com) signed in (it asks for a login even for this public repository):

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@sha256:<digest> --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

`<digest>` is the image's index digest (`docker buildx imagetools inspect ghcr.io/deconfined/tarubot:X.Y.Z` prints it), and `<commit>` the full commit its `org.opencontainers.image.revision` label names. Exit status 0 means the project's publish workflow on `main` built that digest from that commit on a GitHub-hosted runner. Images before 2.32.0 carry no signature, so the check fails for them.

## The bot's container

The stock Compose file locks the bot's container down. It runs as the image's unprivileged `bun` user, and:

- its root filesystem is read-only (`read_only: true`);
- it has no Linux capabilities (`cap_drop: [ALL]`);
- nothing in it can gain privileges (`no-new-privileges`).

The bot writes no files: its records are in PostgreSQL, and its log goes to standard output. The [maintenance tools](/tarubot/deploy/tools/) run in the same locked-down container, so they can't write files there either. Most only print: to keep their output, redirect it on the host. The two that write a file need [a writable mount](/tarubot/deploy/tools/#previewjs) for that one run.

If you write your own Compose override, such as one for an [external database](/tarubot/deploy/requirements/#a-database), keep these three settings, and make any mount it adds read-only. A writable mount belongs only on a single tool run, never in the override. The bundled PostgreSQL container keeps Docker's defaults, because it prepares its data directory as root when it starts.
