---
title: Design decisions
description: The current engineering rationale behind TaruBot's architecture and delivery.
sidebar:
  order: 4
---

These are the current design choices and their engineering rationale. Implementation history belongs in Git and the [changelog](https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md), not a release-by-release diary.

## One writer per database

**Decision.** Exactly one bot process writes to a database, enforced by a PostgreSQL session advisory lock that the bot takes before it logs in or starts any work, and that migrations take while they apply.

**Why.** Correctness rests on ordered decisions: ledger sequences, departure confirmations, one active job per piece of work. Two writers would race on all of them. A "run one replica" setting is only a scaling hint, while a lock in the database itself holds even when a deployment overlaps, a container is started twice, or a migration runs next to an old bot. A second process waits, unready, instead of writing. The lease is checked every 30 seconds, and a bot that can't prove it still holds it exits instead of carrying on.

**Consequence.** The database connection must be a direct session, never a transaction-mode pool, and an update stops the old bot before the new one migrates: a migration waits for the lease, and refuses while a bot still holds it.

## Durable decisions, then effects

**Decision.** Every decision is one transaction that writes the state change, its audit record and its queued Discord work together. Discord changes happen afterwards, from a queue in PostgreSQL. A member's own choices for themselves are different: a role save on My roles, like the `/main` and `/nickname` preferences, commits only its state and queued work, with no audit record, and Discord is the record of which roles they hold (owner decision Q4 A; see [Data and privacy](/tarubot/architecture/data-and-privacy/#self-service-roles)).

**Why.** Discord and the Lodestone fail, rate-limit and time out. Keeping them out of decision transactions means a decision is never half-made, and work the bot owes survives crashes, restarts and outages. Replies can say honestly what was saved and what is still queued.

## TaruBot's own Lodestone parser, in the bot

**Decision.** The bot fetches Lodestone pages itself and parses them with its own parser, which applies the community [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) definitions in short-lived worker threads.

**Why.** One process and one image have fewer failure points than two services, and nothing is lost: each parse still runs in an isolated worker that is terminated at its deadline, under the same fetch limits and 429 cooldown.

## Selectors follow upstream live

**Decision.** The bot checks the selector repository every 15 minutes and switches to a new version by itself, after checking it against every field the parser reads. The set bundled with each release is the fallback.

**Why.** When the Lodestone changes its page layout, the community updates the selectors, usually before anyone notices a problem. Following them live keeps TaruBot working without a release, rebuild or restart. A version that fails the checks is rejected and logged, and the active set stays.

## Guild-only commands and private replies

**Decision.** Every command works only inside a server, and every reply is private.

**Why.** Every operation belongs to one server: its FC, its roles, its ledger. A DM has none of that context. Private replies keep members' records and officers' diagnostics to the person who asked, and no reply or post can ping anyone, apart from mod mail's ping of the Officer role in the officer notifications channel.

## SQL migrations are the schema authority

**Decision.** Numbered, checksum-verified SQL files define the schema, including constraints and triggers such as the immutable ledger. The ORM maps tables for queries but never generates or pushes schema changes.

**Why.** The database enforces the invariants that matter most (exact IDs, non-negative balances, immutable entries, one active job per key) regardless of the code that talks to it. Immutable, checksummed migrations make every deployment's schema reproducible, and the bot refuses to start on a schema it doesn't expect.

## Starting the image is the upgrade

**Decision.** TaruBot ships as attested AMD64/ARM64 images from protected `main`, run with Docker Compose: the scanned bot image, which carries its migrations and every tool, and a web image, the stock Caddy image with TaruBot's proxy configuration and offline page. Starting the bot's image is the whole upgrade: before it takes the writer lease it applies its own pending migrations, immediately after an encrypted backup, and once ready it registers its own commands (on a self-hosted installation, in the scope its `COMMAND_REGISTRATION` setting names). Backups run inside the bot, and restores are one-off containers of the same image. The stock installation bundles PostgreSQL; upstream production uses managed PostgreSQL on its own Docker host.

**Why.** Nothing outside the image can drift from the release: no host script, scheduled job or host tool takes part, so an operator needs access to the containers only, and an updater that just replaces a container (Watchtower, a platform's redeploy) still runs every step. A backup taken under the migration's own lock is exactly the state that migration started from. Command registration that Discord refuses is reported and leaves the bot running, rather than stopping a release that has already migrated. Upstream delivery is one owner approval that moves a registry tag the runtime follows, in a package only that approved deploy can write, so no other workflow of the repository can choose what production runs; GitHub never connects to the runtime, so it can't watch the result or roll back by itself, and a rollback is deploying the earlier version again. [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#how-a-release-reaches-production) distinguishes implementation from observed live acceptance.

## A host the Lodestone accepts

**Decision.** Verify outbound Lodestone access from a proposed host before relying on it.

**Why.** Some cloud addresses receive HTTP 403, preventing profile, claim and roster reads regardless of bot readiness. Provider choice alone is not proof of an accepted address; see [Requirements](/tarubot/deploy/requirements/).

## AGPL-3.0

**Decision.** TaruBot's code is licensed under the [GNU Affero General Public License v3.0](https://github.com/deconfined/tarubot/blob/main/LICENSE) (AGPL-3.0-only).

**Why.** A Discord bot is used over a network, so the AGPL's network clause applies: anyone who runs a modified TaruBot for others must offer their users its source. `/version` links to the source code and the license. Dependencies, including the selector data, keep their own licenses.
