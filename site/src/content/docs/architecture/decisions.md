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

**Consequence.** The database connection must be a direct session, never a transaction-mode pool, and an update stops the old bot before migrating.

## Durable decisions, then effects

**Decision.** Every decision is one transaction that writes the state change, its audit record and its queued Discord work together. Discord changes happen afterwards, from a queue in PostgreSQL.

**Why.** Discord and the Lodestone fail, rate-limit and time out. Keeping them out of decision transactions means a decision is never half-made, and work the bot owes survives crashes, restarts and outages. Replies can say honestly what was saved and what is still queued.

## TaruBot's own Lodestone parser, in the bot

**Decision.** The bot fetches Lodestone pages itself and parses them with its own parser, which applies the community [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) definitions in short-lived worker threads.

**Why.** One process and one image have fewer failure points than two services, and nothing is lost: each parse still runs in an isolated worker that is terminated at its deadline, under the same fetch limits and 429 cooldown.

## Selectors follow upstream live

**Decision.** The bot checks the selector repository every 15 minutes and switches to a new version by itself, after checking it against every field the parser reads. The set bundled with each release is the fallback.

**Why.** When the Lodestone changes its page layout, the community updates the selectors, usually before anyone notices a problem. Following them live keeps TaruBot working without a release, rebuild or restart. A version that fails the checks is rejected and logged, and the active set stays.

## Guild-only commands and private replies

**Decision.** Every command works only inside a server, and every reply is private.

**Why.** Every operation belongs to one server: its FC, its roles, its ledger. A DM has none of that context. Private replies keep members' records and officers' diagnostics to the person who asked, and no reply or post can ping anyone.

## SQL migrations are the schema authority

**Decision.** Numbered, checksum-verified SQL files define the schema, including constraints and triggers such as the immutable ledger. The ORM maps tables for queries but never generates or pushes schema changes.

**Why.** The database enforces the invariants that matter most (exact IDs, non-negative balances, immutable entries, one active job per key) regardless of the code that talks to it. Immutable, checksummed migrations make every deployment's schema reproducible, and the bot refuses to start on a schema it doesn't expect.

## One image, Docker Compose

**Decision.** TaruBot ships as one scanned, attested AMD64/ARM64 image from protected `main` and runs with Docker Compose. The stock installation bundles PostgreSQL; upstream production uses an owner-provisioned Linode host and managed PostgreSQL.

**Why.** The image carries its matching migrations/tools; exact digest pinning makes updates deliberate. Upstream delivery automates backup, migration, command registration and startup under one production approval, while infrastructure provisioning and initial cutover remain owner operations. [DEPLOYMENT](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md) distinguishes implementation from observed live acceptance.

## A host the Lodestone accepts

**Decision.** Verify outbound Lodestone access from a proposed host before relying on it.

**Why.** Some cloud addresses receive HTTP 403, preventing profile, claim and roster reads regardless of bot readiness. Provider choice alone is not proof of an accepted address; see [Requirements](/tarubot/deploy/requirements/).

## AGPL-3.0

**Decision.** TaruBot's code is licensed under the [GNU Affero General Public License v3.0](https://github.com/deconfined/tarubot/blob/main/LICENSE) (AGPL-3.0-only).

**Why.** A Discord bot is used over a network, so the AGPL's network clause applies: anyone who runs a modified TaruBot for others must offer their users its source. `/version` links to the source code and the license. Dependencies, including the selector data, keep their own licenses.
