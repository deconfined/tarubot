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

Lock the guild row, then `guild_users` in `(guild_id, user_id)` order (`COLLATE "C"`), then jobs. Member rows use `FOR NO KEY UPDATE`, so foreign-key checks can proceed. Reconciliation/status freeze/mark/drop, `sync.guild` and role menu edits take the guild `FOR SHARE`; configuration, onboarding and activation take it `FOR UPDATE`. A role menu edit then takes its `self_role_menus` row `FOR UPDATE`. A My roles save takes only its `self-roles:<guild>:<user>` transaction advisory lock and its waiting job row; the `roles.self` job takes the session advisory lock `user:<guild>:<user>` that `reconcile.user` takes, so the two never write one member's roles at once. Roster departure recording takes these locks before character rows, preserving the unlink order.

Invalid officer status becomes a silent baseline; retry batches remain durable. Unsetting the officer channel drops pending/frozen state under the same locks, including departed members. A later channel must not resurrect old changes.

Update posts similarly persist `guilds.changelog_version`: a channel's first configuration establishes a baseline, rollbacks never lower it, and delivery advances it with a compare-and-set and audit on one client. Restoring an older database may replay a delivered post unless its baseline is deliberately corrected.

Visibility overrides retain before/after masks, deliberately hidden channels, propagated writes and uncertain/incomplete outcomes in audit. They share onboarding's setup lock, leave the configuration revision unchanged and requeue held work transactionally. Alert transitions lock per guild and retain audit history; new episodes withdraw unstarted recovery notices.

### Self-service role menus

`self_role_menus` (migration 012) holds each server's self-service role menu as one JSON document, written only by `src/application/self-roles.ts`. The document carries its own version, `v`, and `src/domain/self-roles.ts` validates it strictly on every read and before every write: the caps, one place on the menu per role, and stored text trimmed, in NFC and free of control and bidi characters. Those are zod rules, not SQL constraints; the table's CHECK only requires an object with a `categories` array. A document this build can't parse, such as one a newer release wrote before a rollback, is never overwritten by an edit: only an audited reset replaces it, and nothing on it counts as offered or listed. A server without a row has the empty menu at revision 1, and its first edit inserts the row.

`revision` is the officers' optimistic lock and has nothing to do with `guilds.revision`, the reconciliation fence, which menu edits never bump. An edit runs in one transaction: the guild row `FOR SHARE`; the menu row, inserted if missing, `FOR UPDATE`; then parse, apply the operation (its field refusals and `gone`), the equal-state rule, the reset and revision checks, the invariant checks, the schema check, the update with `revision + 1`, its audit row (`action = 'self_roles'`, the operation as `target`, identifiers only in `details`) and a last shutdown check that rolls everything back. So a stale form with a refused field gets its 422 before the revision check's 409. Menu edits queue no work and don't requeue parked or blocked jobs, so an edit changes nobody's roles by itself. Which categories are published or Stop offering decides which channel-opening roles reconciliation removes from people with no access role (owner decision Q3 B).

A menu role is never one of the four bound access roles or a retired role. `configure()` and `/setup onboarding` check that under their guild row `FOR UPDATE`, which a menu edit's `FOR SHARE` waits for, so the two can't interleave; a menu that doesn't parse is scanned for role IDs instead, failing closed.

Members' picks are never stored; Discord holds them. While a member's change waits, its `roles.self` job holds the role IDs involved, and migration 012's trigger `self_role_choice_forgotten` clears the payload to `{}` whenever such a job is inserted or updated as `succeeded` or `failed`, whatever path ends it, an operator's SQL included. The partial indexes `self_role_jobs` and `self_role_waiting` serve a member's newest choice and the waiting rows.

A My roles save is one transaction in `SelfRoles.choose`: `pg_advisory_xact_lock` on the dedupe key `self-roles:<guild>:<user>`, the newest waiting row (`queued`, `running`, `blocked` or `disabled`) `FOR UPDATE`, a merge of the categories this save changed into it, the equal-state rule (the same change as the waiting one writes nothing, and so does nothing waiting and nothing to do, unless one of the person's `roles.self` rows ended in the last 5 minutes: the roles the POST read before the transaction may predate that job's write, so the save is queued instead), `enqueue()` and the pre-commit shutdown check. The payload is `{chosen, offered, savedAt}`: role IDs only, and `savedAt` is the database clock at the latest save. A parked `disabled` row sits outside `active_job`, so `enqueue()` makes a new row beside it; the save closes the parked one as superseded, and the trigger clears it. No audit row is written per save (owner decision Q4 A); officer menu edits stay audited. Saves are refused while Discord changes are paused, so no new choice waits on a pause.

The job takes `user:<guild>:<user>`, the advisory lock `reconcile.user` takes, re-reads the menu and the member, blocks as a whole while that fresh snapshot shows TaruBot without Manage Roles (keeping the payload, with a role-free diagnostic), checks every role again on it and writes one role at a time. It records no `delivery_attempts` row, and its result holds counts only. A cleared `{}` payload (a failed change an operator retried) completes as skipped before the effects gate. `Synchronization.schedule()` closes a change still waiting 7 days after its `savedAt` as `{"skipped":"expired"}` (a running one with a live lease is left to finish, while one whose lease ran out is closed too, since `Queue.claim()` never reclaims it in a server TaruBot has left; a payload without a readable `savedAt` falls back to `created_at`), and deletes `roles.self` rows that finished (`succeeded` or `failed`) more than 30 days ago: the one kind of job history that is pruned. No delivery attempt or sync-run link ever references such a row, and pending rows are never touched. After a rollback, 2.39.0's pass instead closes every waiting row at once, whatever its age, as `{"skipped":"needs a newer TaruBot"}`, leaving a running one only while its lease lives.

After any restore, once `check-restore.js` has passed and before the bot starts, close the role changes the backup caught waiting, so a restored copy never replays older choices over newer ones; the trigger clears their payloads. The restore checklist in [deployment](DEPLOYMENT.md#backups-and-restore) and the site's recovery steps carry this step:

```sql
UPDATE jobs SET status='succeeded', completed_at=now(), lease_until=NULL, last_error=NULL,
       result='{"skipped":"restored"}'
 WHERE kind='roles.self' AND status IN ('queued','running','blocked','disabled');
```

### Web sessions

`web_sessions` (migration 011, #43) is the server side of a signed-in browser, written only by `src/web/sessions.ts`. A row holds the SHA-256 of the cookie token, the Discord user ID and timestamps: never the token, an IP address, a user agent or a Discord token. Sessions end after seven idle days or thirty days in all, judged on the database clock; `get` reads and touches `last_seen_at` (at most every ten minutes) in one statement, and the web's hourly sweep deletes expired rows. A user keeps at most `SESSIONS_PER_USER` (10) live sessions: `create` inserts the new row and deletes that user's older live rows beyond the cap in one transaction, under a per-user `pg_advisory_xact_lock`, so concurrent sign-ins can't overshoot it. The new row always stays; expired rows are left to the sweep, so they never push out a session still in use. The table has no foreign key and isn't member state.

After any restore, once `check-restore.js` has verified the copy and before the bot starts on it, delete every row (`DELETE FROM web_sessions`): a backup would otherwise revive sessions signed out since it was taken. That signs everyone out, which is always safe. Deleting before the check would fail its exact row comparison. The restore checklist in [deployment](DEPLOYMENT.md#backups-and-restore) and the site's recovery steps carry this step.

### Status samples

`status_samples` (migration 013, 2.41.0) is the public status page's 90-day history, written only by `src/application/public-status.ts`. A row is one five-minute bucket: its start as the key (a CHECK keeps it on the boundary), readiness, the Discord, database, Lodestone and Discord-changes states, and the version that wrote it. Nothing about a server, member or visitor. While a process holds the writer lease, its status timer (every minute) inserts the current bucket's row with `ON CONFLICT DO NOTHING`, so a restart or a second tick inside a bucket adds nothing, then deletes rows older than 90 days, all but the earliest, and recounts per UTC day and version (`to_char(sampled_at AT TIME ZONE 'UTC', ...)`, so the session's zone can't move a day). The earliest row is the first sample ever, which marks where the history starts: without it, an outage at the 90-day window's oldest edge would read as no data instead of down. It's one row of the same process-wide states. The counts live in memory until the next sample, and every snapshot works the days out from them afresh; `/status` never queries the table. A bucket without a row counts as down once it has passed, even while the database is down. The table has no foreign key and isn't member state.

A restore needs no step for it: rows written after the backup are lost, and the page shows those buckets as down. Samples can simply be kept across restores and rehearsals. 2.40.0 refuses to start on this schema head, so going back needs the pre-migration backup.

### Mod mail

Migration 014 (2.43.0) holds mod mail, written only by `src/application/modmail.ts`:

- `modmail_settings`: one row per server that ever turned it on (no row is off at revision 1). `enabled` is the officers' switch, `revision` its optimistic lock, and `last_number` the server's case counter. Opening a case takes this row `FOR UPDATE` and increments the counter in the same transaction, so concurrent opens in one server get distinct numbers in order; a number is never reused, not even after retention deletes its case. Only the switch is audited (`action = 'modmail'`, `enable` or `disable`, the revision in `details`).
- `modmail_cases`: the server, number (unique per server), opener, state (`officers`, `member`, `closed`), `revision` (bumped by every change, compared by close and reopen), `state_since` (how long it has waited), `closed_at` and `delete_after` (both set exactly while closed: CHECKs), and the topic as one bytea, nonce ‖ ciphertext ‖ tag, with `topic_key_id`. A trigger refuses any change to a case's ID, server, number, opener, opening time or topic.
- `modmail_messages`: the thread, ordered by `seq` (an identity, since a reopen line and its reply share one `now()`). `kind` is `message` (a body and key ID, both required) or the state history, `closed` and `reopened` (neither). `side` is who acted: the opener is the member side, even an officer who opened their own case; an officer's row records `signed_as` (`name` or `officers`), what the member sees.
- `modmail_reads`: the read log. `kind = 'case'` is a view of a case page (views by the same reader within a minute are one row); `kind = 'list'` is a list that showed the case's decrypted topic, the officers' inbox or the member's own list (one row per reader per case per hour, only for topics that decrypted).

Messages and reads are append-only: a trigger refuses every UPDATE on them, whatever path tries it, while DELETE stays allowed so retention's cascade works. Ciphertext uses AES-256-GCM under `MODMAIL_KEY`. The plaintext is padded first (ISO/IEC 7816-4: 0x80, then zeros): a topic to 512 bytes, so every `topic` is 540 bytes with the nonce and tag, and a body to a multiple of 256 bytes; the CHECKs hold those shapes. The AAD is `tarubot-modmail-v1|topic|<guild>|<case>|<opener>` for a topic and `tarubot-modmail-v1|message|<guild>|<case>|<opener>|<message>|<author>|<side>|<signed_as or none>|<kind>` for a body, every part a decimal ID, a lowercase UUID or a fixed word (`fieldAad` refuses anything else, so no part holds the separator). A body or topic copied to another row, or re-inserted with another opener, author, side or signing, fails to decrypt. The IDs are made in the application before encrypting, and a form's minted ID (a reply's message, or a case opened on the web) is lowercased first, as PostgreSQL stores it, so the AAD matches the row read back. The key ID is the first 16 hex characters of HMAC-SHA256(key, "tarubot modmail key id"): 2.43.0 has no rotation, but the stored ID lets a later release keep previous keys for reading. Only ciphertext is ever bound as a query value. The AAD binds identity, but a database writer can still delete rows, or change who counts as an officer through the configuration tables; the [threat model](THREAT_MODEL.md) says so.

Lock order: the guild row `FOR SHARE`, then the member's own transaction advisory lock `modmail:<guild>:<user>` (opening a case, and a member's reply that may reopen one, both count that member's open cases), then the settings row (opening) or the case row `FOR UPDATE`, then jobs. Appends don't compare the revision but bump it, so a Close drawn before a reply is a 409.

`/modmail`'s form and the Mod mail page's Open a case form both open through one `ModMail.open`, so a case opened from either takes the same locks and limits: two forms at once, one from each, can't both pass the open limit. The web form carries a case ID minted with its page, used as the case's primary key: the same form sent again finds its case under the member's lock (checked before the switch and the limits, which that case may itself have reached) and answers it as opened; a minted ID naming someone else's case is a conflict, including two people sending one copied form at once, where the loser meets `modmail_cases_pkey` after the winner commits. `/modmail` can't be submitted twice and leaves the ID to the application.

Notifications are jobs with no user attached and the case ID as the whole payload (a ping adds `event`, `opened` or `reply`): `modmail.ping` under `modmail:ping:<case>` and `modmail.dm` under `modmail:dm:<case>`, queued with `scheduleJob` and delayed until 10 minutes after the key's last finished job (the partial index `modmail_jobs`). A reply ping also waits 10 minutes after the member's latest reply ping in any of their cases (found through `modmail_cases_opener`, since jobs name no member). An event while a job is queued adds nothing, since the job reads the case when it sends. An event while it is **running** bumps the row's generation and sets its due time one window on (with the event's payload), so the queue runs it again once it finishes instead of losing the event (a close while the reply DM is being sent). Their history isn't pruned; it names cases, never people, and a case that retention removed completes as skipped.

Retention: `ModMailRetention` has its own unref'd timer (every minute, a pass at most every 10 minutes by `performance.now()`, so a wall-clock step can't pause it), runs only while the process holds the writer lease, and catches and reports its own errors, so nothing else in the scheduler can skip it. A pass deletes cases whose `delete_after` has passed, 90 days after closing; the cascades remove their messages, reads and history (`modmail_cases_expiry`). Reopening clears `delete_after`. The drain stops the timer.

A restore needs no extra step for the database, but two facts matter. The key isn't in the dump: the restored database is readable only with the same `MODMAIL_KEY`, which lives in the host's settings and their encrypted copies. The daily backup's encrypted settings copy holds the key next to the dump, so whoever holds the backups' age identity can read mod mail cases; that's the owner's deliberate trade-off, so a lost host restores fully ([deployment](DEPLOYMENT.md)). And a backup can bring back cases that have since expired, or undo a later reopen or close; the next retention pass deletes the expired ones. Read rows and replies written after the backup are lost. 2.42.0 refuses to start on this schema head, so going back needs the pre-migration backup.

## Change the schema

1. Add a new numbered SQL migration. Never edit, rename or delete an applied migration, including its comments: startup validates checksums.
2. Update Drizzle mappings and `SCHEMA_VERSION` together.
3. Test migrated-catalog parity, backfills, constraints, a repeated no-op migrate and application behavior in disposable PostgreSQL. Rehearse against synthetic legacy input and the supplied private fixture when relevant and available.
4. Follow [the change checklist](../CONTRIBUTING.md#make-a-change) and [deployment](DEPLOYMENT.md). An older image cannot start on a newer schema; crossing a migration is a restore or fix-forward operation, not an ordinary image rollback.

## Coverage

Use [the contributor guide](../CONTRIBUTING.md#set-up) to run the disposable-PostgreSQL suite. Relevant coverage includes exact values, transaction/queue races, migration backfills and catalog parity, managed privileges and recovery.
