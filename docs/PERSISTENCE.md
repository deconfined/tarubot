# Persistence

Numbered SQL files in `migrations/` are the schema authority. `src/infrastructure/postgres/schema.ts` maps them for Drizzle; `database.ts` owns connections and migration/startup checks. `SCHEMA_VERSION` names the required head. Neither the ORM nor startup silently changes the schema.

## Queries and transactions

- Use `db.orm` for pooled application reads/writes and Drizzle for queries.
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

Expose only catalog `Failure` diagnostics, never driver messages or bound parameters. A failed Drizzle query's message and stack end with a `params:` line holding the bound values, which can be anything a person submitted; issue reports replace it with a marker (`withoutParams` in `src/application/issue-reports.ts`). Constraint tests inspect Drizzle's driver `cause`, including SQLSTATE.

## Durable-work invariants

- The writer lease holds one dedicated PostgreSQL session for the bot's lifetime. Pending migrations take the same gate; stop the bot before migrating. See [single-writer operations](../site/src/content/docs/deploy/operations.md#single-database-writer).
- Queue claims use a typed CTE, `FOR UPDATE OF jobs SKIP LOCKED` and one `UPDATE … RETURNING`. Preserve lease tokens, expiry, generation and configuration guards.
- Active-job upserts use the literal partial-index predicate so prepared plans can infer it. `scheduleJob` never changes an active job's generation/due time; `enqueue` may pull work forward.
- Do not prune job history, apart from finished `roles.self` rows after 30 days ([self-service role menus](#self-service-role-menus)). Officer notices rely on `officer.notify` rows matched by `dedupe_key`, status, timestamps and message ID, not payload text. Any future retention design must preserve pending rows and those finished within 24 hours or newer than the FC's last accepted roster.
- New guild inserts use `NEW_GUILD_ROW`: role layout off even though the existing SQL column default is on. The importer keeps its explicit off value.
- Guest resets end grants rather than delete history. First-activation grandfathering counts ended grants as existing grants, so it cannot undo an earlier reset.

### Lock order and officer status

Lock the guild row, then `guild_users` in `(guild_id, user_id)` order (`COLLATE "C"`), then jobs. Member rows use `FOR NO KEY UPDATE`, so foreign-key checks can proceed. Reconciliation/status freeze/mark/drop, `sync.guild` and role menu edits take the guild `FOR SHARE`; configuration, onboarding and activation take it `FOR UPDATE`. A role menu edit then takes its `self_role_menus` row `FOR UPDATE`. Roster departure recording takes these locks before character rows, preserving the unlink order.

Invalid officer status becomes a silent baseline; retry batches remain durable. Unsetting the officer channel drops pending/frozen state under the same locks, including departed members. A later channel must not resurrect old changes.

Update posts similarly persist `guilds.changelog_version`: a channel's first configuration establishes a baseline, rollbacks never lower it, and delivery advances it with a compare-and-set and audit on one client. Restoring an older database may replay a delivered post unless its baseline is deliberately corrected.

Visibility overrides retain before/after masks, deliberately hidden channels, propagated writes and uncertain/incomplete outcomes in audit. They share onboarding's setup lock, leave the configuration revision unchanged and requeue held work transactionally. Alert transitions lock per guild and retain audit history; new episodes withdraw unstarted recovery notices.

### Self-service role menus

`self_role_menus` (migration 012) holds each server's self-service role menu as one JSON document, written only by `src/application/self-roles.ts`. The document carries its own version, `v`, and `src/domain/self-roles.ts` validates it strictly on every read and before every write: the caps, one place on the menu per role, and stored text trimmed, in NFC and free of control and bidi characters. Those are zod rules, not SQL constraints; the table's CHECK only requires an object with a `categories` array. A document this build can't parse, such as one a newer release wrote before a rollback, is never overwritten by an edit: only an audited reset replaces it, and nothing on it counts as offered or listed. A server without a row has the empty menu at revision 1, and its first edit inserts the row.

`revision` is the officers' optimistic lock and has nothing to do with `guilds.revision`, the reconciliation fence, which menu edits never bump. An edit runs in one transaction: the guild row `FOR SHARE`; the menu row, inserted if missing, `FOR UPDATE`; then parse, apply the operation (its field refusals and `gone`), the equal-state rule, the reset and revision checks, the invariant checks, the schema check, the update with `revision + 1`, its audit row (`action = 'self_roles'`, the operation as `target`, identifiers only in `details`) and a last shutdown check that rolls everything back. So a stale form with a refused field gets its 422 before the revision check's 409. Menu edits queue no work and don't requeue parked or blocked jobs: changing the menu changes nobody's roles.

A menu role is never one of the four bound access roles or a retired role. `configure()` and `/setup onboarding` check that under their guild row `FOR UPDATE`, which a menu edit's `FOR SHARE` waits for, so the two can't interleave; a menu that doesn't parse is scanned for role IDs instead, failing closed.

Members' picks are never stored; Discord holds them. While a member's change waits, its `roles.self` job holds the role IDs involved, and migration 012's trigger `self_role_choice_forgotten` clears the payload to `{}` whenever such a job is inserted or updated as `succeeded` or `failed`, whatever path ends it, an operator's SQL included. The partial indexes `self_role_jobs` and `self_role_waiting` serve a member's newest choice and the waiting rows. Nothing queues a `roles.self` job yet; the dispatcher completes any it meets as skipped without a Discord call, and the trigger clears it. `Synchronization.schedule()` deletes `roles.self` rows that finished (`succeeded` or `failed`) more than 30 days ago (owner decision Q4 A): the one kind of job history that is pruned. No delivery attempt or sync-run link ever references such a row, and pending rows are never touched. 2.39.0 runs it too, so the promise holds after a rollback from 2.40.0.

### Web sessions

`web_sessions` (migration 011, #43) is the server side of a signed-in browser, written only by `src/web/sessions.ts`. A row holds the SHA-256 of the cookie token, the Discord user ID and timestamps: never the token, an IP address, a user agent or a Discord token. Sessions end after seven idle days or thirty days in all, judged on the database clock; `get` reads and touches `last_seen_at` (at most every ten minutes) in one statement, and the web's hourly sweep deletes expired rows. The table has no foreign key and isn't member state.

After any restore, once `check-restore.js` has verified the copy and before the bot starts on it, delete every row (`DELETE FROM web_sessions`): a backup would otherwise revive sessions signed out since it was taken. That signs everyone out, which is always safe. Deleting before the check would fail its exact row comparison. The restore checklist in [deployment](DEPLOYMENT.md#backups-and-restore) and the site's recovery steps carry this step.

## Change the schema

1. Add a new numbered SQL migration. Never edit, rename or delete an applied migration, including its comments: startup validates checksums.
2. Update Drizzle mappings and `SCHEMA_VERSION` together.
3. Test migrated-catalog parity, backfills, constraints, a repeated no-op migrate and application behavior in disposable PostgreSQL. Rehearse against synthetic legacy input and the supplied private fixture when relevant and available.
4. Follow [the change checklist](../CONTRIBUTING.md#make-a-change) and [deployment](DEPLOYMENT.md). An older image cannot start on a newer schema; crossing a migration is a restore or fix-forward operation, not an ordinary image rollback.

## Coverage

Use [the contributor guide](../CONTRIBUTING.md#set-up) to run the disposable-PostgreSQL suite. Relevant coverage includes exact values, transaction/queue races, migration backfills and catalog parity, managed privileges and recovery.
