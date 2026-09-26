# Drizzle persistence

TaruBot uses pinned **Drizzle ORM 0.45.3** with **node-postgres 8.23.0**. `src/infrastructure/postgres/schema.ts` maps application tables; `database.ts` owns the pool, transaction lifecycle, migration checks, and shared audit/user writes. `connection.ts` supports provider-supplied CA certificates through `DATABASE_CA_CERT` (or a per-connection CA, as `check-restore` uses for a PITR fork), retaining certificate/hostname verification despite URL SSL settings. Persisted application record contracts and leased-job fields derive from these mappings.

## Query and transaction conventions

- Use `db.orm` for pooled application reads/writes. Use Drizzle selections, joins, conflict targets, `returning`, and explicit row locks for ordinary persistence.
- Inside `db.transaction(async (client) => ...)`, obtain `const store = orm(client)` and use it for every part of that decision. Pass the same `client` to `audit`, `ensureUser`, `enqueue`, and reconciliation helpers. The adapter is cached by connection identity; a pooled query would escape the transaction.
- Keep Discord and Lodestone requests outside decision transactions. Existing session advisory locks serialize FC acquisition, user delivery, and setup/layout across remote calls, and the bot's writer lease (key `714882494`) holds one dedicated session for the process lifetime ([the single writer](../site/src/content/docs/deploy/operations.md#single-database-writer)). Always release those locks and checked-out clients in `finally`. Session locks need a direct connection, never a transaction-mode pool.
- Use schema column objects in `sql` expressions. Bind dynamic values through Drizzle; do not interpolate user strings as SQL identifiers or fragments. Alias computed selections when composing subqueries or insert-from-select operations.
- The work queue uses a typed CTE with `FOR UPDATE OF jobs SKIP LOCKED` and one `UPDATE ... RETURNING` claim. Preserve lease-token, expiry, generation, and configuration guards when changing queue or delivery queries. Active-job upserts use the literal predicate from the partial unique index so prepared plans can infer it.
- `jobs` rows are history as well as work, and the application never deletes them. Since 2.24.3 the officer Lodestone notices read that history (REQUIREMENTS.md "Approved officer-notice amendments"): the degraded notice's rate limit and the recovery check select `officer.notify` rows by exact `dedupe_key`, using `status`, `created_at`, `completed_at` and `message_id`, never payload or result text. A future jobs retention must keep every pending row, and every row finished within 24 hours or newer than its FC's last accepted roster. No index covers historical rows by key, so these reads scan `jobs`; if the table grows by orders of magnitude, an index on `jobs(dedupe_key, created_at)` would be a later migration.

## Exact values

| Value | Mapping |
| --- | --- |
| Discord/Lodestone identifiers | `external_id` domain mapped to decimal strings, including unsigned 64-bit maximum |
| Money, sequences, revisions, identity counters | PostgreSQL `bigint` mapped to JavaScript `bigint`; no floating-point conversion |
| Instants | `timestamptz` mapped to `Date`; connections use UTC |
| JSONB | Application `json()` serializer preserves bigint as decimal strings; node-postgres already decodes returned JSON values |

Pass objects/scalars directly into JSONB fields, rather than pre-serializing them. A returned scalar JSON string is already decoded and must not be parsed again. Drizzle treats a JavaScript `null` parameter as SQL NULL; use ``sql`'null'::jsonb` `` when a required payload intentionally contains JSON null. Audit and queue helpers handle that distinction. Nullable columns continue to use normal SQL NULL.

Drizzle query failures retain the PostgreSQL driver error in `cause`, including its SQLSTATE. Domain `Failure` exceptions remain the approved user-facing diagnostic boundary. Logs, Discord replies, and job diagnostics continue to omit arbitrary database exception messages and bound parameters; tests inspecting database-enforced failures assert the driver cause.

## Schema changes and deployment

Numbered SQL files in `migrations/` are the schema authority. They define domains, foreign keys, partial indexes, checks, and immutable-ledger triggers. The ORM mappings describe those tables for application queries; they are not a complete schema-generation manifest.

For a future schema change:

1. Add a new numbered SQL migration; preserve every applied migration and checksum.
2. Update the Drizzle mapping and `SCHEMA_VERSION` together.
3. Verify migration/schema parity and relevant behavior in disposable PostgreSQL with both migration fixtures.
4. Increment the application version/changelog and follow the PR/check/publication workflow. Apply the matching migration during the documented deployment window.

The **2.9.0 adoption added no migration** and used `002_setup_and_ranks.sql`. Migration `003_guild_access.sql` added opt-in channel policy bindings and first-observed recovery snapshots. `004_guest_application_form.sql`, introduced in **2.12.0**, added paired nullable introduction/interest fields that preserve existing applications, with a database constraint bounding supplied answers; new form answers, submission audit, and review work commit on the same client. The 2.12.1–2.12.3 releases add no schema change.

`005_launch_access_policy.sql`, introduced in **2.13.0** and required through the 2.14.x releases, is additive and needs no superuser privileges:

- **Provenance.** It replaces `guest_grants_provenance_check` so provenance may also be `grandfathered`.
- **Grandfathering marker.** It adds `guilds.guest_grandfather`, NULL, `pending`, or `completed`. The completion time `guilds.guest_grandfathered_at` is set exactly when the marker is `completed`.
- **Role layout.** It adds `guilds.role_layout_enabled boolean NOT NULL DEFAULT true`.
- **Backfill.** Guilds with a `migration.import` audit get the layout switch off. Imported guilds with effects off and no `activation` audit become `pending`. Other guilds keep layout on and a NULL marker, so DevBot is never grandfathered.
- **Revisions.** The backfill changes no revision.

Registered-visitor Guest needs no schema change. First-activation grants, their per-grant and completion audits, the marker, and the effects flip commit on the activation transaction's client.

The current **2.30.4** source adds no migration and requires `SCHEMA_VERSION=010_status_notices.sql`, which **2.29.0** added. It is additive and needs no superuser privileges. It adds three nullable `guild_users` columns for the officer status posts, with no default, index or constraint (every query filters on `guild_id`, the primary key's prefix):

- **`status_state`** (`jsonb`): the join time the state belongs to, the flags last announced (or silently taken as the baseline), the last decisive flags, the reason for each difference, and confirmed FC departures not yet posted. `src/domain/status.ts` validates it with zod on every read; an unreadable value counts as NULL, a new silent baseline, so a bad row never wedges reconciliation.
- **`status_since`** (`timestamptz`): when something first waited to be announced, from the database clock; NULL exactly when nothing waits. The two-minute window is computed in SQL from the oldest.
- **`status_posting`** (`jsonb`): the member's frozen lines in the post being sent (batch UUID, position, freeze time); NULL outside a post in flight.
- **Existing rows.** All three start NULL, so the deploy posts nothing.

The lock order is the guild row, then its `guild_users` rows in `(guild_id, user_id)` order (`COLLATE "C"`), then job rows. A reconciliation pass records its decisive flags in its own transaction after the role write: the guild row `FOR SHARE` (which also gives the officer channel: with none, the change is taken as announced and nothing is queued), the member's row, then (only when a value moved) the guild's `officer:<guild>:status` job, and an unchanged pass writes nothing. Unsetting the channel (`Service.configure`) clears, in the same transaction, everything the guild still has waiting (the pending flags and departures in `status_state`, `status_since` and `status_posting`), members who left the server included: under its `guilds` row `FOR UPDATE`, it locks those rows in user order (`dropWaiting`, shared with the job's no-channel drop) before it queues any job. A change left by a job that ended `failed` before the unset, which nothing revives, therefore never posts once a channel is set again, even when no pass reaches its member (a member who left, or Discord changes paused). As backstops, the job's no-channel drop clears whatever it still finds, and with no channel every pass clears whatever its member still has waiting, whether or not it changed anything; a pass with nothing to clear still writes nothing. The guild lock comes first because the job insert takes `FOR KEY SHARE` on the guild row through its foreign key, while `/config` adoption, the officer channel's unset, `/setup` and activation hold that row `FOR UPDATE` before locking members. `sync.guild` likewise share-locks the guild row, then locks all its guild's rows up front. The accepted roster, which share-locks its guilds, records departures in its snapshot transaction, locking the departing owners' rows (only in guilds with an officer channel) in that order before any `characters` row, the order `/unclaim`, `/assign` and the two-404 unlink use. The job's freeze, mark and no-channel drop share-lock the guild row, then lock rows in user order, and take no jobs-row lock; the freeze checks the job's lease with a plain read, and re-reads the channel, `effects_enabled` and `active` under its share lock. Every member-row lock here is `FOR NO KEY UPDATE`: it conflicts with the others and with `FOR UPDATE`, but not with the `FOR KEY SHARE` that a foreign-key check takes, so inserts referencing a member (`membership_history`, `links`, grants) never wait on it. A batch's `delivered` attempt stores the nonce key `status:<batch>` in `diagnostic` and is written before the mark, so a retry after a failed mark finds it and only marks the batch. The queue now resets `attempts` when a successful run is requeued for a newer generation. The Drizzle mapping still covers 26 application tables. An older image can't start on schema 010; the site's [monitoring page](../site/src/content/docs/deploy/monitoring.md#status-notices) has the manual reversal.

`009_changelog_channel.sql`, introduced in **2.25.0** and required through 2.28.0, is additive and needs no superuser privileges. It adds two nullable `guilds` columns for update posts:

- **`changelog_channel_id`** (`external_id`): where update posts go; NULL means they're off.
- **`changelog_version`** (`text`): the newest version the guild was told about. A CHECK allows only `MAJOR.MINOR.PATCH` with an optional prerelease, which `Bun.semver.order` compares. The `changelog_baseline` CHECK requires it whenever a channel is set.
- **Existing rows.** Both start NULL, so nothing posts on the deploy, and no revision changes.

`/config changelog` writes the channel and, when none was set, the baseline (`newer(stored, running)`) in the same `UPDATE`, under the guild row lock, with its `config` audit and the usual repair pass on one client. It reads the guild's `channel_access_policies` row there, in onboarding guilds, to report who can read the channel; it writes none. Startup queues `changelog.post` in the presence transaction. The job moves the baseline with a compare-and-set (`UPDATE … WHERE changelog_version = <from>`) and its `changelog.advanced` audit in one transaction, and treats zero rows as already done. The Drizzle mapping still covers 26 application tables. An older image can't start on schema 009, so a rollback across it is a restore or a fix release; restoring a snapshot taken before a post was delivered can post it again unless `changelog_version` is raised by hand first.

`/suggest` (2.28.0) adds no table. Its limits and its private record of who sent each public issue are `audit` rows, written with `audit()` on the pool: `suggestion.posted` (target `#N`, details `{repository, issue}`) after GitHub confirms the issue, and `suggestion.unconfirmed` (no target, details `{repository}`) when GitHub's answer is unclear. The three limit reads filter those two actions by actor and `event_at` against the database clock; `audit` has no index for them, which is fine at its size. Submissions run one at a time in the writer process, so no database connection or lock is held across the GitHub calls.

`008_issue_reports.sql`, introduced in **2.18.0**, is additive and needs no superuser privileges. It adds the `issue_reports` table, one row per report fingerprint:
- the source (`user`, `error`, `job` or `trouble`), title, the first occurrence's Markdown body and the newest repeat's (`latest`);
- the server and member for `/issue`;
- occurrence counts, and the GitHub issue number, creation time and last post.

Partial indexes serve `/issue`'s per-member and per-server limits, and the delivery sweep's pending reports. A report is saved on its caller's client (`/issue` checks its limits under a per-server transaction lock), and an `issue.report` job delivers it. The job records the posted occurrences and the issue number after GitHub answers. The daily caps count succeeded `issue.report` jobs by their `result`. The Drizzle mapping covers 26 application tables.

`007_profile_checks.sql`, introduced in **2.17.0**, adds two nullable columns to `characters`:

- **`profile_retry_at`.** The scheduler queues no profile refresh before it. It is stamped an hour ahead whenever a refresh is queued, moved to the profile interval for a private profile, and cleared by a successful refresh.
- **`profile_missing_at`.** The first Lodestone 404 of the two-404 unlink rule. Any later sighting clears it: a profile read, a private answer, or a roster listing.

Existing rows start NULL, so behavior is unchanged until each character's next refresh. The scheduler selects and stamps characters in one pass, and queues each refresh with `scheduleJob`. That is an `INSERT … ON CONFLICT DO NOTHING` against the active-job partial index, so it never touches an active job's `due_at` or generation.

The automatic unlink ends each link in its own transaction, in `/unclaim`'s lock order: the guild_users row, then the character, then the link. It re-checks under those locks that the first 404 still stands, and writes the unlink, its audit, the officer notice and the owner's reconciliation on one client, through the same `endLink` path as `/unclaim` and `/unassign`.

`006_guest_application_switch.sql`, introduced in **2.15.0**, is also additive and needs no superuser privileges:

- **Applications switch.** It adds `guilds.guest_applications_enabled boolean NOT NULL DEFAULT false`, separate from `guest_application_channel_id`. `/apply` opens only while the switch is on and a review channel and a Guest role are set.
- **Backfill.** Guilds with a review channel whose `guest_grandfather` is not `pending` get the switch on, so DevBot's applications stay open. Guilds without a channel, and imported guilds still awaiting first activation, stay off. On an empty database the update is a no-op. Guilds created later start off: `/setup` turns the switch on, and the importer stores the legacy review channel with the switch off.
- **Ended grants.** It adds nullable `guest_grants.ended_at`, `ended_by` and `ended_reason`. `/guest reset` sets them instead of deleting the row, so the grant, with its unique source key, stays as history. Only grants with `ended_at` NULL confer Guest or appear in `/guest status`. First-activation grandfathering still counts an ended grant as an existing grant (basis `existing_grant`), so a reset before activation is not undone; the plan's provenance lists active grants only. Existing grants stay active.
- **Revisions.** The backfill changes no revision.

`/config guest_applications` validates in Discord, before its transaction, the channel that will take applications (one named in the call, or the kept one when the call switches applications on). Under the guild row lock it then refuses with `conflict` if the save would leave applications taking a channel it did not validate, and otherwise writes the switch and channel, one `config` audit per changed setting, and the repair pass on one client. `/config officer_rank` naming the saved rank reads the locked guild row and writes nothing: no revision, audit or repair pass. `/guest reset` ends the grants, lifts the revocation, writes the `guest.reset` audit and queues reconciliation on one client, as `/officer reset` does for its override deletion and `officer.reset` audit. Activation's `--guest-applications` choice sets the switch with its `config` audit on the activation transaction's client. The Drizzle mapping still covers 25 application tables, and all prior migration checksums stay immutable. `bun run db:migrate` remains the deployment command; there is no Drizzle Kit push or automatic runtime schema mutation. See the site's [setup](../site/src/content/docs/admin/setup.md) and [operations](../site/src/content/docs/deploy/operations.md) pages, and [HOSTING.md](HOSTING.md) for production.

Raw SQL is limited to transaction/migration control, advisory locks, health probes, and independent catalog/restore verification. The dump reader still decodes legacy SQL as data. Integration tests also use independent SQL observations and fault injection to validate ORM behavior rather than relying exclusively on the same mappings under test.

## Regression coverage

The PostgreSQL suite compares every application table/column/type/null/default mapping to the migrated catalog. It exercises unsigned IDs, maximum bigint money, large sequences, UTC dates, scalar/nested JSON and JSON null, isolation and rollback across policy/audit/outbox writes, simultaneous `SKIP LOCKED` claims, superseding generations, expired leases, and empty/shared-FC capability aggregates. Existing ownership, ledger, guest, roster, nickname, import, and recovery tests exercise the converted application paths. `tests/integration/migrations.test.ts` applies 005 over 001–004, 006 over 001–005, 007 over 001–006, 008 over 001–007, 009 over 001–008 and 010 over 001–009, in private schemas: it checks each backfill case (for 006, the switch starts on only for a guild with a review channel that is not awaiting first activation, revisions stay unchanged, schema-005 grants stay active, and a guild created later starts off), the constraints, grants written under the old provenances, an empty database, and a real `Database.migrate` upgrade from schema 004 to the head that a second run leaves unchanged. For 007, existing characters keep both new columns NULL. For 008, the table accepts only the four sources and has its indexes. For 009, existing guilds keep posts off and their revision, and the version CHECKs hold. For 010, an existing member row keeps all three new columns NULL, with the expected types and no default. `tests/integration/managed-privileges.test.ts` runs every migration as a non-owner login holding only the documented managed-cluster grants.

```sh
bun run test:docker
bun run test:fixture
LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql bun run test:docker
```

The harness creates disposable `_test` databases and removes its containers/volumes. The first command uses the locally supplied private dump; the second run selects generated synthetic input suitable for public CI.
