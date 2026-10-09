---
title: Overview
description: How TaruBot is built, from a slash command to a Discord change, and where to read more.
sidebar:
  order: 1
---

TaruBot is a single TypeScript process on [Bun](https://bun.sh), with [discord.js](https://discord.js.org) for Discord and PostgreSQL, through [Drizzle ORM](https://orm.drizzle.team), for everything it knows. It ships as one container image.

## System context

```text
                         ┌────────────────────────────┐
  Discord members ──────►│  Discord (gateway and API) │
                         └─────────────┬──────────────┘
                                       │ interactions, member and
                                       │ role events; role, nickname
                                       ▼ and message changes
┌──────────────────────────────────────────────────────────────────┐
│ TaruBot (one process)                                            │
│  commands · components · events  →  services  →  job queue       │
│  Lodestone adapter (parser workers)   health probes on :3000     │
└──────┬───────────────────┬────────────────────┬─────────────┬────┘
       │ SQL               │ HTTPS               │ HTTPS       │ HTTPS
       ▼                   ▼                     ▼             ▼
  PostgreSQL        The Lodestone        GitHub: selectors,  healthchecks.io
  (all state)       (profiles, rosters,  /version history,   (optional
                     searches)           issue reports       heartbeat)
```

- **Discord** delivers interactions (slash commands, buttons, forms) and gateway events (members joining, leaving and changing; roles and channels changing). TaruBot changes roles, nicknames and channel permissions, and posts messages.
- **PostgreSQL** holds all state: links, rosters, grants, the ledger, settings, the audit trail and the work queue. Nothing important lives only in memory.
- **The Lodestone** is Square Enix's public character site. TaruBot reads character profiles (for ownership proofs), FC pages and member lists (for membership and ranks), and character searches.
- **GitHub** supplies the Lodestone CSS selectors TaruBot's parser follows, `/version`'s commit history, and, when configured, the repository that receives issue reports. The project's own deployment also posts `/suggest` ideas to TaruBot's public repository, as a GitHub App.
- **healthchecks.io** receives an optional heartbeat, so an outside check notices when the bot goes silent.

## Layers

| Layer | Directory | What it holds |
| --- | --- | --- |
| Domain | `src/domain` | Pure rules: identifiers and exact values, authorization, desired access, departures, the failure catalog, report redaction, and the cleaning that makes a suggestion safe to publish. No I/O. |
| Application | `src/application` | Transactional operations: claims, links, grants, the ledger, configuration, synchronization and reconciliation, the lifecycle, issue reports, public suggestions. |
| Bot framework | `src/bot` | Module contracts, discovery, the service registry and the interaction router. |
| Features | `src/commands`, `src/components`, `src/events` | One module per slash command, button namespace and gateway listener. |
| Discord | `src/discord` | The gateway adapter, option builders, and the reply presenters. |
| Infrastructure | `src/infrastructure` | PostgreSQL (schema and connections), GitHub clients, and the Lodestone adapter. |
| Jobs | `src/jobs` | The durable work queue and the dispatcher that performs Discord effects. |
| Schema | `migrations` | Numbered SQL migrations, the authority for the database schema. |

`src/main.ts` is the composition root: it builds each capability once, discovers the modules, and connects them.

## Modules are discovered

Every command, button namespace and gateway listener lives in its own file (`*.command.ts`, `*.component.ts`, `*.event.ts`), found by recursive discovery at startup. There is no central switch to edit. The same discovered definitions drive both the running bot and command registration, so what `register.js` deploys is exactly what the bot answers. Duplicate names, invalid modules and missing services stop startup with a clear error.

## From a command to a Discord change

1. **The router** receives the interaction, acknowledges it, and resolves the actor afresh from Discord: their permissions and roles right now, and whether they're a TaruBot officer. It authorizes the command, and any button click, against that actor.
2. **A service method** makes the decision in one database transaction. The state change, its audit record and any Discord work it needs (as queued jobs) are written on the same connection, so they commit or roll back together. Discord and the Lodestone are never called inside that transaction.
3. **A presenter** turns the result into the reply. The reply reports what was saved, and describes queued Discord work as queued, never as done.
4. **The job queue** runs the work: workers lease jobs from PostgreSQL, perform the Discord change, and record the outcome. A job that meets a missing permission is parked as blocked; a temporary error is retried with backoff; a newer change supersedes older queued work for the same thing. Everything survives restarts.

Background work follows the same path without an interaction: a scheduler, which runs every 30 seconds, queues roster reads when they're due, and gateway events queue reconciliation for the members and channels they touch.

## Lifecycle and the single writer

At startup the bot checks the database schema, then takes the **writer lease**, a PostgreSQL session lock, before it logs in or starts any work, so only one process ever writes to a database. It checks the schema again, reconciles every configured server, resumes held work, queues an [update post](/tarubot/admin/notices-and-updates/#update-posts) for each server whose changelog channel hasn't heard about the running version, and starts the queue and scheduler. It reports ready only when the database, the lease and Discord are all up. On shutdown it stops taking work, lets workers finish for up to 20 seconds, and releases the lease. See [the single writer](/tarubot/deploy/operations/#single-database-writer).

## The Lodestone adapter

TaruBot reads the Lodestone itself. Each request fetches one page under strict limits (the configured region only, spaced request starts, a shared cooldown after a 429, deadlines, a size limit, no redirects) and parses it in a fresh worker thread that never touches the network or disk and is terminated at its deadline. The parser applies the community-maintained [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) definitions, which the bot keeps at their latest version. Every parsed field is validated before it becomes a fact TaruBot acts on.

## Further reading

The contributor notes in the repository go deeper:

- [MODULES.md](https://github.com/deconfined/tarubot/blob/main/docs/MODULES.md): adding commands, events, components and services.
- [PERSISTENCE.md](https://github.com/deconfined/tarubot/blob/main/docs/PERSISTENCE.md): Drizzle, transactions, exact values and schema changes.
- [LODESTONE.md](https://github.com/deconfined/tarubot/blob/main/docs/LODESTONE.md): the Lodestone adapter, parser and live selectors.
- [CONFIGURATION.md](https://github.com/deconfined/tarubot/blob/main/docs/CONFIGURATION.md): the configuration files and the maintenance-tool guard.
- [CONTRIBUTING.md](https://github.com/deconfined/tarubot/blob/main/CONTRIBUTING.md): credential-free checks, releases and dependency updates.
- [REPLIES.md](https://github.com/deconfined/tarubot/blob/main/docs/REPLIES.md): the reply house style.
- [DEV_GUILD.md](https://github.com/deconfined/tarubot/blob/main/docs/DEV_GUILD.md): owner-authorized development acceptance and startup plans.
- [DEPLOYMENT.md](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md): exact-digest Compose delivery, manual provisioning/cutover and recovery.
