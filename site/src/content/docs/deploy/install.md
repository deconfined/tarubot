---
title: Install
description: Install TaruBot with Docker Compose and its bundled PostgreSQL, from the published image.
sidebar:
  order: 3
---

This installs TaruBot with the stock Compose file: the published bot image and a PostgreSQL 18 container next to it. You need the [requirements](/tarubot/deploy/requirements/) and a [Discord application](/tarubot/deploy/discord-application/).

## 1. Get the Compose file and settings template

Pick a release from the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) and use it for `X.Y.Z` below. On the host, in a directory of its own, pull that release's image and fetch the Compose file and settings template from the commit that built it, so the three match:

```sh
mkdir tarubot && cd tarubot
docker pull ghcr.io/deconfined/tarubot:X.Y.Z
commit=$(docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.yml"
curl -fsSL -o .env "https://raw.githubusercontent.com/deconfined/tarubot/$commit/.env.example"
chmod 600 .env
```

The image's `org.opencontainers.image.revision` label names the commit it was built from. That's all the host needs: the image carries the compiled bot, its migrations and its tools.

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

## 6. Add the bot to your server

Add the bot with [the scopes and permissions it needs](/tarubot/admin/add-to-server/#adding-the-bot), place its role, and [set the server up](/tarubot/admin/setup/). A new server goes live with its first `/config` or `/setup`: there's no activation step.

Next: [back up](/tarubot/deploy/operations/#backup) the database regularly, and read [Updates, backups and recovery](/tarubot/deploy/operations/) before your first update.

## Pinning an exact image

`TARUBOT_IMAGE_TAG` also accepts `sha-<commit>`, the full commit that published an image. To pin by digest, set `TARUBOT_IMAGE` to the complete reference, such as `ghcr.io/deconfined/tarubot@sha256:<digest>`; it overrides `TARUBOT_IMAGE_TAG`.

## The bot's container

The stock Compose file locks the bot's container down. It runs as the image's unprivileged `bun` user, and:

- its root filesystem is read-only (`read_only: true`);
- it has no Linux capabilities (`cap_drop: [ALL]`);
- nothing in it can gain privileges (`no-new-privileges`).

The bot writes no files: its records are in PostgreSQL, and its log goes to standard output. The [maintenance tools](/tarubot/deploy/tools/) run in the same locked-down container, so they can't write files there either. Most only print: to keep their output, redirect it on the host. The two that write a file need [a writable mount](/tarubot/deploy/tools/#previewjs) for that one run.

If you write your own Compose override, such as one for an [external database](/tarubot/deploy/requirements/#a-database), keep these three settings, and make any mount it adds read-only. A writable mount belongs only on a single tool run, never in the override. The bundled PostgreSQL container keeps Docker's defaults, because it prepares its data directory as root when it starts.
