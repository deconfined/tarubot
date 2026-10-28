---
title: Install
description: Install TaruBot with Docker Compose and its bundled PostgreSQL, from the published image.
sidebar:
  order: 3
---

This installs TaruBot with the stock Compose file: the published bot image and a PostgreSQL 18 container next to it. Starting the bot's image is the whole installation: it creates its database schema, registers its slash commands and, once you set them up, takes its own encrypted backups. You need the [requirements](/tarubot/deploy/requirements/) and a [Discord application](/tarubot/deploy/discord-application/).

This is the self-hosting path, not permission to operate the upstream instance. That instance runs the same image under its own manifests and managed PostgreSQL, and follows a registry tag that only an owner-approved deploy moves; its runbook is [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#how-a-release-reaches-production).

## 1. Get the Compose file and settings template

Pick a release from the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md) and use it for `X.Y.Z` below. These instructions are for **2.46.0 or newer**: before 2.46.0, migrations and command registration were steps you ran by hand, and the web proxy needed files beside the Compose file, so follow an older release's own instructions in its source.

In a directory of its own, on the machine you run Compose from, pull that release's image and fetch its two Compose files and its settings template from the exact commit that built it:

```sh
mkdir tarubot && cd tarubot
docker pull ghcr.io/deconfined/tarubot:X.Y.Z
commit=$(docker image inspect ghcr.io/deconfined/tarubot:X.Y.Z \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')
curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.yml"
curl -fsSLO "https://raw.githubusercontent.com/deconfined/tarubot/$commit/docker-compose.web.yml"
curl -fsSL -o .env "https://raw.githubusercontent.com/deconfined/tarubot/$commit/.env.example"
chmod 600 .env
```

The image's `org.opencontainers.image.revision` label names the commit it was built from. Nothing else from the repository is needed: the bot image carries the compiled bot, its migrations and its tools, and the optional proxy's image carries its configuration and [offline page](/tarubot/deploy/monitoring/#offline-page). Keep `docker-compose.web.yml` beside the main file even for a bot-only install, because Compose reads the included file even when its `web` profile is off. Don't mix these files with a different release or the moving `main` branch.

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
- **`TARUBOT_IMAGE_TAG`** pins a release. Use the same `X.Y.Z` as in step 1, so the bot runs the release its Compose file came from; the optional proxy runs the same release's `web-X.Y.Z` image. Upgrading is changing this tag and starting again ([Updates](/tarubot/deploy/operations/#updating-to-a-release)). `latest` follows every release, and with the opt-in [automatic updates](/tarubot/deploy/operations/#automatic-updates) each one, and any migration it brings, arrives without you: pin a version unless you want that.
- **`ENABLE_EFFECTS=true`** lets the bot change roles and nicknames and post messages. With `false`, it records every decision but holds the Discord changes as paused work.

Leave these as the template has them:

- **`TEST_GUILD_ID`** and **`TEST_PLAN_CHANNEL_ID`** empty, and **`PUBLIC_TEST_RESPONSES=false`**. They're development settings: with `TEST_GUILD_ID` set, the bot answers only in that one server, registers its commands there instead of globally, posts the development session plan to its `#chat` at every startup, labels its issue reports as development ones, and refuses `register.js --global`.
- **`TARUBOT_ENVIRONMENT`** empty, so the bot and its tools use the unmanaged profile.
- **`DATABASE_URL`** is only for tools you run outside the container. The stock Compose file gives the bot its own connection to the bundled database. If you do run local tools, set the same password in it.
- **The backup settings** (`BACKUP_STORAGE_ENDPOINT` and the rest) as they are for now. Backups are optional and off while the endpoint is empty; [set them up](/tarubot/deploy/operations/#backups) before you rely on the bot, because with them set the bot also backs up before every migration.

### Optional HTTPS dashboard

The default is bot-only: leave `COMPOSE_PROFILES`, `WEB_PUBLIC_ORIGIN` and `DISCORD_CLIENT_SECRET` empty. To expose the dashboard through bundled Caddy, first meet the [DNS and firewall requirements](/tarubot/deploy/requirements/#optional-public-dashboard) and [register OAuth](/tarubot/deploy/discord-application/#optional-dashboard-oauth), then add:

```sh
COMPOSE_PROFILES=web
WEB_PUBLIC_ORIGIN=https://tarubot.example.org
WEB_PORT=8080
DISCORD_CLIENT_SECRET=YOUR_APPLICATION_CLIENT_SECRET
```

`WEB_PUBLIC_ORIGIN` is shared by the bot and Caddy: it is the public HTTPS origin, not a backend address. Use the existing `DISCORD_APPLICATION_ID`; the client secret is separate from the bot token and is a plain environment setting, with no `DISCORD_CLIENT_SECRET_FILE` support. `WEB_PORT` is the private bot listener (default `8080`), not a host-published port. Caddy alone publishes TCP 80/443 and persists certificates/settings in `caddy_data` and `caddy_config`. It runs the release's own web image, `ghcr.io/deconfined/tarubot:web-X.Y.Z`: the stock Caddy image with TaruBot's Caddyfile and offline page built in, so nothing is mounted into it.

This recipe uses HTTPS's default public port 443. A custom origin such as `https://tarubot.example.org:8443` also needs a matching Caddy `ports` override; changing the origin alone does not change Compose's published ports. Keep port 80 available for certificate issuance/renewal and HTTP redirects.

An external HTTPS reverse proxy is an alternative: leave `COMPOSE_PROFILES` empty, set the same bot web settings and route to `tarubot:8080` (or your `WEB_PORT`) over a private container network. Preserve the public host/protocol, and keep bot web, health and database ports unpublished; do not start a second bot for the dashboard.

## 3. Start the bot

```sh
docker compose pull
docker compose up -d --wait
```

The first start does everything in order, and logs each step:

1. **The schema.** The bot applies every migration in one transaction (`Migrations applied`). A new database holds nothing to back up, so it takes no backup first; with backups still off, it also warns that it migrated without one, which is expected here. On every later start it applies only what's pending, which is usually nothing.
2. **The writer lease.** It takes the [single writer's lease](/tarubot/deploy/operations/#single-database-writer) (`Database writer lease acquired`), logs in to Discord and becomes ready.
3. **The commands.** Once ready, it registers its slash commands globally, in every server it joins (`Commands registered`). It does this at every start, replacing the whole set at once, so a restart changes nothing and an update brings its new commands. Global commands can take a little longer to show up everywhere. If Discord refuses the set, the bot files an [issue report](/tarubot/deploy/monitoring/#issue-reports) and keeps running with the commands Discord already has.

Don't also register the commands in one server with `register.js --guild`: a server that has both sees every command twice. `commands.js list` checks the result; see [Maintenance tools](/tarubot/deploy/tools/).

`--wait` returns once the bot's health check passes; a new bot has 300 seconds for it, room for a migration and the backup before it. Check readiness and the log:

```sh
docker compose exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.HEALTH_PORT || "3000") + "/health/ready"); console.log(await r.text())'
docker compose logs --since 10m tarubot
```

Readiness must report `database`, `writerLease`, `discord` and `effects` as `true`. See [Monitoring](/tarubot/deploy/monitoring/) for the rest. If the bot exits at startup instead, its log names the setting or step at fault; Docker starts it again, with a growing pause, until you fix it.

If web is enabled, `--wait` also checks Caddy's private health: its loopback admin process and a ready answer from the bot's private web listener. Caddy doesn't wait for the bot: it starts at once and shows the offline page until the bot is ready. This is not proof of public DNS, TLS or OAuth. From outside the host, open `https://tarubot.example.org`, check a trusted certificate and the HTTP-to-HTTPS redirect, then verify Discord login returns to the exact registered `/auth/callback` URL and only authorized servers are visible. Do not bypass certificate verification to call this accepted.

## 4. Add the bot to your server

Add the bot with [the scopes and permissions it needs](/tarubot/admin/add-to-server/#adding-the-bot), place its role, and [set the server up](/tarubot/admin/setup/). A new server goes live with its first `/config` change or `/setup onboarding confirm:true`: there's no activation step. If TaruBot can't see every channel without Administrator, give it Administrator only for [the setup window](/tarubot/admin/add-to-server/#the-setup-window), and take it away as soon as `/config validate` says so.

Next: set up [backups](/tarubot/deploy/operations/#backups), and read [Updates, backups and recovery](/tarubot/deploy/operations/) before your first update.

## Pinning an exact image

`TARUBOT_IMAGE_TAG` also accepts `sha-<commit>`, the full commit that published an image. Those tags exist for the bot image only, so with the `web` profile pin a version instead. To pin the bot by digest, set `TARUBOT_IMAGE` to the complete reference, such as `ghcr.io/deconfined/tarubot@sha256:<digest>`; it overrides `TARUBOT_IMAGE_TAG` for the bot only, so keep `TARUBOT_IMAGE_TAG` at the same version for the proxy.

New bot releases publish version and commit tags after their checks pass. Documentation and pipeline maintenance can merge without a bot release, so some commits on `main` have no image. A maintenance fix can finish the same release if its build failed before publishing a version tag. Existing version tags are preserved.

### Checking where an image came from

Images from 2.32.0 on carry signed build provenance: a signature, made by the project's publish workflow on `main`, that names the commit the image was built from. Web images, from 2.46.0, carry it too. The upstream project checks both before every deploy. To check an image yourself, with the [GitHub CLI](https://cli.github.com) signed in (it asks for a login even for this public repository):

```sh
gh attestation verify oci://ghcr.io/deconfined/tarubot@sha256:<digest> --repo deconfined/tarubot \
  --cert-identity https://github.com/deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main \
  --source-ref refs/heads/main --source-digest <commit> \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
```

`<digest>` is the image's index digest (`docker buildx imagetools inspect ghcr.io/deconfined/tarubot:X.Y.Z`, or `:web-X.Y.Z`, prints it), and `<commit>` the full commit its `org.opencontainers.image.revision` label names. Exit status 0 means the project's publish workflow on `main` built that digest from that commit on a GitHub-hosted runner. Images before 2.32.0 carry no signature, so the check fails for them.

## The bot's container

The stock Compose file locks the bot's container down. It runs as the image's unprivileged `bun` user, and:

- its root filesystem is read-only (`read_only: true`), and its only writable path is a 1 MiB `/tmp` in memory, where the backup and restore tools keep a private copy of the database's CA certificate while they run;
- it has no Linux capabilities (`cap_drop: [ALL]`);
- nothing in it can gain privileges (`no-new-privileges`).

The bot writes no files: its records are in PostgreSQL, its log goes to standard output, and its backups, once you set them up, stream straight to your bucket, encrypted. The [maintenance tools](/tarubot/deploy/tools/) run in the same locked-down container, so they can't write files there either. Most only print: to keep their output, redirect it outside the container. The two that write a file need [a writable mount](/tarubot/deploy/tools/#previewjs) for that one run.

If you write your own Compose override, such as one for an [external database](/tarubot/deploy/requirements/#a-database), keep these settings, and make any mount it adds read-only. A writable mount belongs only on a single tool run, never in the override. The bundled PostgreSQL container keeps Docker's defaults, because it prepares its data directory as root when it starts. The optional [automatic updates](/tarubot/deploy/operations/#automatic-updates) container is locked down the same way, but holds the Docker socket.
