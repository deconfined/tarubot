---
title: Requirements
description: What you need to run your own TaruBot deployment.
sidebar:
  order: 1
---

These pages are for people who run TaruBot themselves. A deployment is one bot process, its PostgreSQL database and its own Discord application. One deployment can serve several servers, each linked to its own Free Company.

## A host

- **Docker Engine with Compose 2.20.0 or newer** on a Linux host, `amd64` or `arm64`. The shared ingress file uses Compose `include`. TaruBot ships as published container images, built for both: `ghcr.io/deconfined/tarubot:X.Y.Z` for the bot and every tool, and `web-X.Y.Z` beside it for the optional proxy. You don't need Bun, Node, PostgreSQL tools or a source checkout on the host, and nothing of TaruBot's lives on it but Docker's images and volumes, plus its two Compose files and its settings wherever you run Compose. No scheduled job or host script is involved: the bot migrates, registers its commands and backs up by itself.

  The bot image uses Bun on Alpine Linux and carries the PostgreSQL 18 client tools (`pg_dump`, `pg_restore` and `psql`) its backups and restores use. Alpine is inside the container; your host can use another Linux distribution.
- **An address the Lodestone accepts.** TaruBot reads character profiles, FC rosters and searches from the Lodestone itself, from the host's own address. Some cloud providers' addresses are refused: the Lodestone answers DigitalOcean's with HTTP 403, for example, so profile checks, claims and rosters all fail there. Test from the host before you commit to it:

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' https://na.finalfantasyxiv.com/lodestone/
  ```

  `200` is what you want; `403` means the Lodestone refuses that address.
- **A small machine is enough** for a Free Company's server: the bot does its heavy lifting (reading Lodestone pages) a page at a time, with a small, bounded amount of parallel work.
- **Outbound HTTPS** to Discord, the Lodestone (`<region>.finalfantasyxiv.com`), GitHub (`api.github.com` and `raw.githubusercontent.com`, for `/version`, the live Lodestone selectors, and issue reports if you turn them on), the GitHub container registry (`ghcr.io`) for the images, your backup bucket if you set up [backups](#optional-backup-storage), and `hc-ping.com` if you use the optional heartbeat or backup check. **No inbound ports for bot-only operation**: the bot's health endpoint stays inside the container network.

### Optional public dashboard

For the bundled HTTPS proxy, use a hostname you control, for example `tarubot.example.org`. Its DNS **A** record must point to this host's public IPv4 address; if you publish an **AAAA** record, IPv6 must reach the same proxy too. Remove stale/unreachable records rather than leaving certificate issuance or visitors to hit another host.

Allow inbound **TCP 80 and 443** through host and provider firewalls, and make sure no other service owns those ports. Caddy needs outbound access to certificate authorities for automatic issuance and renewal. Its certificate state persists in Docker volumes. Only Caddy publishes ports: bot web (`8080` by default), bot health (`3000` by default) and PostgreSQL remain private.

The standard recipe uses public HTTPS port 443. A custom public origin port requires a matching Caddy ports override and firewall allowance; changing `WEB_PORT` only changes the private backend. An existing external HTTPS proxy can replace bundled Caddy, provided it reaches that backend privately. See [installation](/tarubot/deploy/install/#optional-https-dashboard).

## A database

**The supported setup is the stock [`docker-compose.yml`](https://github.com/deconfined/tarubot/blob/main/docker-compose.yml)**, which runs PostgreSQL 18 next to the bot, with its data in a Docker volume. [Install](/tarubot/deploy/install/) walks through it.

To use an external PostgreSQL instead, such as a managed database:

- Write your own Compose override that sets the bot's `DATABASE_URL`, and `DATABASE_CA_CERT` for verified TLS; the stock file points the bot at its bundled database. Keep [the container's locked-down settings](/tarubot/deploy/install/#the-bots-container): an override that only adds these two settings does.
- Use PostgreSQL 18, the version the project tests with, over a **direct session connection**. A transaction-mode pool (such as PgBouncer in transaction mode) can't hold the session lock that keeps a single bot writing to the database; see [the single writer](/tarubot/deploy/operations/#single-database-writer). The image's `pg_dump` is PostgreSQL 18's, which can't back up a newer server.
- Give the bot its own database and user, which owns the schema: migrations create tables, functions and triggers.

The upstream project runs the same images on its own Docker host with managed PostgreSQL. Its `docker-compose.production.yml` and production tool profile belong to that application, not your deployment. Its separate staging rehearsal uses its own application identity, guild-scoped commands, managed database and backup bucket, never production credentials. The [owner runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#what-runs-on-a-docker-host) distinguishes those owner-operated paths from self-hosting and from unobserved live acceptance.

## Optional backup storage

For the bot's own encrypted [backups](/tarubot/deploy/operations/#backups):

- **An S3-compatible bucket** that answers at its own HTTPS host name (virtual-hosted style), with its signing region and an access key pair that can read and write it. Lifecycle rules keep it from filling up; [Backups](/tarubot/deploy/operations/#set-up-backups) lists them.
- **An [age](https://age-encryption.org) key pair**, made with `age-keygen` on a machine you trust: the bot gets the public key, and you keep the identity, with a second copy offline. Only the identity opens a backup.

Without them TaruBot runs the same, with no backups of its own: then dump the database yourself before every update that brings a migration.

## A Discord application

Each deployment needs its own application and bot token: [create one](/tarubot/deploy/discord-application/). The bot token and the database password are the deployment's secrets, with the backup bucket's key once you set up backups; keep them in `.env`, which never belongs in Git.

## Maintenance tools and profiles

TaruBot's one-shot [maintenance tools](/tarubot/deploy/tools/) (migrations, command registration, backups, restores, retries, restore checks) run from the same image. Before any I/O, each tool checks which deployment its settings belong to, and the bot applies the same check before it migrates at startup. The upstream project's own instances have managed profiles with extra safeguards, pinned to their application and server IDs in [`src/config/deployment.ts`](https://github.com/deconfined/tarubot/blob/main/src/config/deployment.ts). Every other deployment runs under the **unmanaged** profile, which has no deployment-specific rules, except that it refuses to touch the upstream instances' servers or use their tokens. Leave `TARUBOT_ENVIRONMENT` empty.
