# Persistence

`src/infrastructure/postgres/schema.ts` maps application tables for Drizzle and inferred record types. `database.ts` owns the pool, transactions, migration/startup checks and shared writes. Numbered SQL files in `migrations/` remain the schema authority; `SCHEMA_VERSION` names the required head. Neither the ORM nor startup silently changes the schema.

## Queries and transactions

- Use `db.orm` for pooled application reads/writes and Drizzle selections, joins, conflict targets, `returning` and explicit row locks.
- Inside `db.transaction(async (client) => …)`, use `const store = orm(client)` for the whole decision. Pass that client to audit, user, queue and reconciliation helpers. A pooled query escapes the transaction.
- State, audit and outbox writes commit together. Keep Discord/Lodestone I/O outside decision transactions; session advisory locks serialize remote acquisition/delivery/setup where needed. Release locks and checked-out clients in `finally`.
- Bind values and use schema columns in `sql` expressions. Never interpolate user strings as identifiers/fragments. Alias computed selections used in subqueries and insert-from-select queries.
- Raw SQL is reserved for migration/transaction control, advisory locks, health probes and independent catalog/restore verification. Tests may use independent SQL observations and fault injection.
- Managed connections verify the CA and hostname through `connection.ts`. Advisory session locks require direct connections, never a transaction-mode pool.

## Exact values and failures

| Value | Mapping |
| --- | --- |
| Discord/Lodestone identifiers | Decimal strings via `external_id`, including unsigned 64-bit maximum |
| Gil, sequences, revisions and counters | PostgreSQL `bigint` ↔ JavaScript `bigint`; never float |
| Instants | UTC `timestamptz` ↔ `Date` |
| JSONB | Objects/scalars passed directly; `json()` preserves bigint as decimal strings |

Returned JSON is already decoded: do not parse a scalar string again. A JavaScript `null` parameter means SQL NULL; use ``sql`'null'::jsonb` `` for intentional JSON null in a required payload. Audit/queue helpers handle that distinction.

Drizzle retains driver failures in `cause`, including SQLSTATE. Expose only catalog `Failure` diagnostics, never arbitrary driver messages or bound parameters. Tests of database constraints inspect the driver cause.

## Durable-work invariants

- The writer lease holds one dedicated PostgreSQL session for the bot's lifetime. Pending migrations take the same gate; stop the bot before migrating. See [single-writer operations](../site/src/content/docs/deploy/operations.md#single-database-writer).
- Queue claims use a typed CTE, `FOR UPDATE OF jobs SKIP LOCKED` and one `UPDATE … RETURNING`. Preserve lease tokens, expiry, generation and configuration guards.
- Active-job upserts use the literal partial-index predicate so prepared plans can infer it. `scheduleJob` never changes an active job's generation/due time; `enqueue` may pull work forward.
- Job rows are history, not disposable messages. The application never deletes them. Officer Lodestone/visibility notices read `officer.notify` history by exact `dedupe_key`, status, timestamps and message ID, not payload text. Do not prune that history. A future retention design must preserve all pending rows and those finished within 24 hours or newer than the FC's last accepted roster.
- New guild inserts use `NEW_GUILD_ROW`: role layout off even though the existing SQL column default is on. The importer keeps its explicit off value.
- Guest resets end grants rather than delete history. First-activation grandfathering counts ended grants as existing grants, so it cannot undo an earlier reset.

### Lock order and officer status

Lock the guild row, then `guild_users` in `(guild_id, user_id)` order (`COLLATE "C"`), then jobs. Member rows use `FOR NO KEY UPDATE`, so foreign-key checks can proceed. Reconciliation/status freeze/mark/drop and `sync.guild` take the guild `FOR SHARE`; configuration, onboarding and activation take it `FOR UPDATE`. Roster departure recording takes these locks before character rows, preserving the unlink order.

`status_state` stores the baseline/pending decisive flags and departures; invalid state becomes a new silent baseline. `status_since` drives the two-minute window. `status_posting` freezes a durable batch for retry. No officer channel means changes are taken as announced: unsetting the channel drops pending/frozen state under the same locks, including departed members. A later channel must not resurrect old changes.

Update posts similarly persist `guilds.changelog_version`: a channel's first configuration establishes a baseline, rollbacks never lower it, and delivery advances it with a compare-and-set and audit on one client. Restoring an older database may replay a delivered post unless its baseline is deliberately corrected.

Visibility override runs preserve before/after masks, deliberate hidden channels, propagated writes, uncertain outcomes and incomplete-run status in `setup.overrides` audit rows. They share the setup session lock with onboarding, make no configuration-revision bump, and requeue held work transactionally. Alert episode transitions use a per-guild transaction lock and persisted audit history; new episodes withdraw unstarted recovery notices. See the implementations and tests for the complete payload contracts.

## Change the schema

1. Add a new numbered SQL migration. Never edit, rename or delete an applied migration, including its comments: startup validates checksums.
2. Update Drizzle mappings and `SCHEMA_VERSION` together.
3. Test migrated-catalog parity, backfills, constraints, a repeated no-op migrate and application behavior in disposable PostgreSQL. Rehearse against synthetic legacy input and the supplied private fixture when relevant and available.
4. Follow [the change checklist](../CONTRIBUTING.md#make-a-change) and [deployment](DEPLOYMENT.md). An older image cannot start on a newer schema; crossing a migration is a restore or fix-forward operation, not an ordinary image rollback.

## Coverage

The integration suite checks mapping parity against the catalog; large IDs/bigints; UTC dates; scalar/nested JSON and JSON null; transaction rollback; concurrent queue claims; expired/superseded leases; and domain/import/recovery behavior. `migrations.test.ts` tests upgrades/backfills and `managed-privileges.test.ts` applies migrations under the documented non-owner grants.

Run the full suite with synthetic input using [CONTRIBUTING.md](../CONTRIBUTING.md#set-up). Private fixture results and older migration evidence remain in [the verification archive](archive/README.md#verification-and-acceptance), not duplicated here as release notes.
