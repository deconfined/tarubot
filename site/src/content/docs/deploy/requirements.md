---
title: Requirements
description: What you need to run your own TaruBot deployment.
sidebar:
  order: 1
---

These pages are for people who run TaruBot themselves. A deployment is one bot process, its PostgreSQL database and its own Discord application. One deployment can serve several servers, each linked to its own Free Company.

## A host

- **Docker Engine with Compose v2** on a Linux host, `amd64` or `arm64`. TaruBot ships as one published container image, `ghcr.io/deconfined/tarubot`, built for both. You don't need Bun, Node or a source checkout on the host.

  The bot image uses Bun on Alpine Linux. Alpine is inside the container; your host can use another Linux distribution.
- **An address the Lodestone accepts.** TaruBot reads character profiles, FC rosters and searches from the Lodestone itself, from the host's own address. Some cloud providers' addresses are refused: the Lodestone answers DigitalOcean's with HTTP 403, for example, so profile checks, claims and rosters all fail there. Test from the host before you commit to it:

  ```sh
  curl -sS -o /dev/null -w '%{http_code}\n' https://na.finalfantasyxiv.com/lodestone/
  ```

  `200` is what you want; `403` means the Lodestone refuses that address.
- **A small machine is enough** for a Free Company's server: the bot does its heavy lifting (reading Lodestone pages) a page at a time, with a small, bounded amount of parallel work.
- **Outbound HTTPS** to Discord, the Lodestone (`<region>.finalfantasyxiv.com`), GitHub (`api.github.com` and `raw.githubusercontent.com`, for `/version`, the live Lodestone selectors, and issue reports if you turn them on), and `hc-ping.com` if you use the optional heartbeat. **No inbound ports**: the bot's health endpoint stays inside the container network.

## A database

**The supported setup is the stock [`docker-compose.yml`](https://github.com/deconfined/tarubot/blob/main/docker-compose.yml)**, which runs PostgreSQL 18 next to the bot, with its data in a Docker volume. [Install](/tarubot/deploy/install/) walks through it.

To use an external PostgreSQL instead, such as a managed database:

- Write your own Compose override that sets the bot's `DATABASE_URL`, and `DATABASE_CA_CERT` for verified TLS; the stock file points the bot at its bundled database. Keep [the container's locked-down settings](/tarubot/deploy/install/#the-bots-container): an override that only adds these two settings does.
- Use PostgreSQL 18, the version the project tests with, over a **direct session connection**. A transaction-mode pool (such as PgBouncer in transaction mode) can't hold the session lock that keeps a single bot writing to the database; see [the single writer](/tarubot/deploy/operations/#single-database-writer).
- Give the bot its own database and user, which owns the schema: migrations create tables, functions and triggers.

The upstream project uses this same Docker Compose runtime on an owner-provisioned Linode host with managed PostgreSQL. Its `docker-compose.production.yml` and production tool profile belong to that application, not your deployment. Its separate staging rehearsal uses its own application identity, guild-scoped commands, managed database and backup bucket, never production credentials. The [release/provisioning/cutover runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md) distinguishes those owner-operated paths from self-hosting and from unobserved live acceptance.

The upstream project's automated production/staging delivery authenticates SSH host keys through **DNSSEC-signed SSHFP**, with a complete signed delegation chain and a runner-local validating resolver. Missing, unsigned, invalid or mismatching records refuse delivery without a manual host-pin fallback. This is an upstream automation requirement, not an extra requirement for the stock self-hosted Compose installation.

## A Discord application

Each deployment needs its own application and bot token: [create one](/tarubot/deploy/discord-application/). The bot token and the database password are the deployment's secrets; keep them in `.env`, which never belongs in Git.

## Maintenance tools and profiles

TaruBot's one-shot [maintenance tools](/tarubot/deploy/tools/) (migrations, command registration, retries, restore checks) run from the same image. Before any I/O, each tool checks which deployment its settings belong to. The upstream project's own instances have managed profiles with extra safeguards, pinned to their application and server IDs in [`src/config/deployment.ts`](https://github.com/deconfined/tarubot/blob/main/src/config/deployment.ts). Every other deployment runs under the **unmanaged** profile, which has no deployment-specific rules, except that it refuses to touch the upstream instances' servers or use their tokens. Leave `TARUBOT_ENVIRONMENT` empty.
