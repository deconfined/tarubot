# Legacy import and production cutover (App Platform + Managed PostgreSQL)

> **Done 2026-09-24.** The cutover ran as written below and went live on App Platform at 22:02 UTC. Production then moved the same evening to a Linode Docker host with Linode managed PostgreSQL, because the Lodestone refuses DigitalOcean's addresses. See [the record](#record-of-the-2026-09-24-cutover). Operate production with [HOSTING.md](HOSTING.md). This runbook remains the record of the procedure. Its App Platform and `doadmin` steps describe the original target.

This runbook moves the production guild `1036062273631952955` (linked FC `9232097761132958152`) from the legacy nextcord bot to TaruBot v2. It follows **MIG-12**, **MIG-13**, and **MIG-14**, the "Approved launch amendments (2026-09-23)", and the "Approved reply-session amendments (2026-09-24)" in [REQUIREMENTS.md](../REQUIREMENTS.md). Production runs on App Platform attached to the owner-provisioned Managed PostgreSQL cluster `tarubot-pg` (database and user `tarubot`); see [APP_PLATFORM.md](APP_PLATFORM.md). The single-writer lease and its `pg_locks` gate are in [the site's operations page](../site/src/content/docs/deploy/operations.md#single-database-writer).

2.13.0 supplies the launch policy and the cutover tooling used below. **The cutover itself uses a published release at or above 2.16.0**: 2.14.0 replaces every JSON reply with the approved embeds, 2.15.0 ships the owner's reply-session decisions of 2026-09-24 (among them the guest-application switch this runbook relies on, the `unset_*` option names and `/officer reset` and `/guest reset`, with migration `006_guest_application_switch.sql`), and 2.16.0 adds the deployment safeguards: a migration guard that refuses pending migrations while a bot holds the writer lease, a schema re-check once a bot holds the lease, and the stale card for undeclared command shapes. Operational telemetry and officer alerts (OPS-10, OPS-11) follow in 2.17.0, after launch. `X.Y.Z` below is that release.

Every provider action (cluster, databases, grants, trusted sources, app create/update), the token reset, and command registration is a separately authorized owner step. Generating or validating a spec authorizes none of them.

## The importer

The importer reads MySQL/MariaDB dump syntax as data. Its reader handles escaped quoted values, doubled quotes, Unicode, NULL, comments/directives, explicit or schema-derived column ordering, and forward relationships. Input is bounded to 64 MiB. Foreign keys, canonical IDs, balances, and mappings are validated before publication, and PostgreSQL publication is one transaction. Legacy `DATETIME` values use the owner-approved **UTC** interpretation; their original values and UTC conversion remain in the import report.

### Fixture rehearsal (local, no credentials)

```sh
bun install --frozen-lockfile
bun run build
bun run test:docker
bun dist/scripts/import.js --file tarubot_backup.sql --source-timezone UTC --dry-run
```

A dry run uses no database or Discord credentials. The supplied acceptance fixture must report 40 FCs, 4,251 characters, 241 users, 161 ownership links, 36 known balances, and four unknown balances. The linked FC is `9232097761132958152`; its recorded opening is **349,279,945 gil**.

The single source guild is `1036062273631952955`. All 161 ownership links and 40 source ledger states map to it, and the report records this mapping. A multi-guild input requires `--mapping FILE.json`:

```json
{
  "ownership": { "CHARACTER_ID": ["DESTINATION_GUILD_ID"] },
  "accounts": { "FC_ID": "DESTINATION_GUILD_ID" }
}
```

Every supplied ownership record needs explicit destination guilds, and every source FC balance maps once. Guilds observing the same FC still have independent accounts and policy state.

### What a published import contains

- **Links and users.** Imported links use trusted `imported_link` provenance, including owners absent from Discord. Snapshot-only users are additional records, reported separately from the 241 SQL users.
- **Guests.** Every captured human holder of the configured guest role receives an explicit `imported_guest` grant. Snapshot enumeration must be complete.
- **Ledger.** Known balances become immutable import opening entries, including known zero. NULL balances produce uninitialized accounts.
- **History.** Source character/FC relationships remain historical cache facts. Imported historical membership exists only where supplied trusted ownership and the source guild's linked FC match. Imported Member-role holders with that evidence get two-observation departure protection.
- **Preferences.** Imported users have no primary character and nickname management disabled; captured nicknames are retained.
- **Launch defaults** (owner decisions of 2026-09-23 and 2026-09-24). The guild row starts with effects disabled, onboarding off (`access_policy_enabled=false`), the role-layout switch off (`role_layout_enabled=false`), grandfathering pending (`guest_grandfather='pending'`), and guest applications switched off (`guest_applications_enabled=false`). The legacy review channel is imported into `guest_application_channel_id` without validation; the switch, not an unset channel, keeps `/apply` closed, so reopening applications after launch is `/config guest_applications enabled:true`, which validates that channel first (W16). The report's `guildSettings[].guestApplications` reads `{state: "closed", legacyChannelId}`, and the `migration.import` audit records the same. The report's `bootstrap` block lists the same defaults. (History: the cutover never ran `/setup`, which would have turned onboarding on, opened `/apply` and adopted Officer-role holders. Since 2.35.0 `/setup` has two subcommands, and the standing rule is never to run `/setup onboarding confirm:true` in production; `/setup overrides` is the approved least-privilege step for removing TaruBot's Administrator there. REQUIREMENTS.md "Approved visibility amendments (2026-09-28)".)
- **Guilds without a linked FC.** Such a guild is imported with grandfathering pending too. `acquire.js` does not apply to it (there is no roster), and preview and activation skip the roster-freshness and departure gates, so `preview.js GUILD_ID --output PLAN.json` still writes the plan and checksum that activation confirms. With no roster evidence, every present human without a revocation or an existing grant (an active one, or one that `/guest reset` ended) is planned a grant.
- **Idempotency.** The same fingerprint returns the committed import report and preserves later links, financial entries, preferences, and access decisions. A changed dump targeting an already populated guild produces an explicit conflict for an operator mapping/migration decision.

## E0. Conventions

**Source.** Build a clean clone outside the DevBot checkout, at the merge commit that published release X.Y.Z:

```sh
mkdir -p ~/tarubot-cutover/work/{rehearsal,backups} && chmod -R go-rwx ~/tarubot-cutover
git clone https://github.com/deconfined/tarubot.git ~/tarubot-cutover/src   # releases before 2.20.0 also need --recurse-submodules
cd ~/tarubot-cutover/src
ln -s ../work work   # clone-relative work/ is ~/tarubot-cutover/work, which the pg container mounts at /work
git checkout RELEASE_MERGE_SHA   # before 2.20.0: && git submodule update --init --recursive
jq -r .version package.json   # must print X.Y.Z
bun install --frozen-lockfile && bun run build
```

Run every tool from the clone root: migrations and schema checks read `migrations/` relative to it, and every `work/…` path below goes through the `work` symlink to `~/tarubot-cutover/work`, so tool outputs and the `pg` container's `/work` files land in one directory. The clone has no `.env`. `bun install` creates the clone's `.cache/` (the tracked `bunfig.toml` keeps Bun's cache there), which W13 writes spec copies into.

**Environment files.** Copy [`production.env.example`](../production.env.example) to `~/tarubot-cutover/production.env` (`chmod 600`) and fill the cluster host, the `tarubot` password, and the cluster CA. It carries every key, so nothing falls back to a development value. Leave `DISCORD_TOKEN` empty until the reset at W3.

Before the window, every use of the production token runs from a second file, `~/tarubot-cutover/rehearsal.env` (`chmod 600`): a copy of `production.env` with `TARUBOT_ENVIRONMENT=rehearsal`, the database name `tarubot_rehearsal` in `DATABASE_URL`, and the current (pre-reset) token. The deployment guard keeps the rehearsal profile read-only on Discord and confines it to `*_rehearsal` databases. Delete `rehearsal.env` after E2.

**Invocation.** Never use `bun run` with these files, and never name a copy `.env` or `.env.production`. A `bun run` child reloads a checkout's `.env` for any key the file leaves out, and shell variables override the file ([CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles)). zsh does not word-split a variable that holds a command, so use functions:

```sh
prod()     { env -i HOME="$HOME" PATH="$PATH" bun --env-file="$HOME/tarubot-cutover/production.env" "$@"; }
rehearse() { env -i HOME="$HOME" PATH="$PATH" bun --env-file="$HOME/tarubot-cutover/rehearsal.env" "$@"; }
```

Each tool checks its deployment profile before any Discord or database I/O. It refuses a mismatched application, test-guild scope, guild, or database, and a checkout's auto-loaded env files. Its messages name settings, hosts, and database names only.

**Direct SQL** for gates, backups, and restores uses a PostgreSQL 18 client over verified TLS as `tarubot`, never `doadmin`:

```sh
cp CA_CERTIFICATE_PEM ~/tarubot-cutover/work/ca-certificate.crt
export PGHOST=CLUSTER_HOST PGPORT=25060 PGUSER=tarubot PGSSLMODE=verify-full PGSSLROOTCERT=/work/ca-certificate.crt
read -rs 'PGPASSWORD?tarubot password: '; export PGPASSWORD
pg() { docker run --rm -i -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGSSLMODE -e PGSSLROOTCERT \
  -v "$HOME/tarubot-cutover/work:/work" postgres:18.4-alpine "$@"; }
```

`prod` and `rehearse` start from `env -i`, so `PGPASSWORD` never reaches a tool.

**Writer-lease gate.** Before migrate, import, activate, or a restore, this must print nothing. A row means a bot writer is connected; stop it with the maintenance phase first ([APP_PLATFORM.md](APP_PLATFORM.md#single-writer-updates-and-migrations)).

```sh
pg psql -d tarubot -At -c "SELECT l.pid FROM pg_locks l WHERE l.locktype='advisory' AND l.granted
  AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND l.classid=0 AND l.objid=714882494 AND l.objsubid=1"
```

**Sidecar.** *(Until 2.21.0. Since 2.21.0 tools that read the Lodestone parse in their own process, and this step is not needed.)* Run an isolated Nodestone on loopback port 18080, matching `NODESTONE_URL` in both files:

```sh
docker run -d --rm --name tarubot-cutover-nodestone -p 127.0.0.1:18080:8080 ghcr.io/deconfined/tarubot-nodestone:X.Y.Z
```

Do not use `docker-compose.tools.yml`: it would recreate DevBot's default-project containers, and its PostgreSQL is not the production database.

**Artifacts.** Keep every dump, snapshot, report, preview, plan, activation output, and backup in `~/tarubot-cutover/work/`, and record `shasum -a 256` for each.

## E1. Preconditions

1. **Releases.** 2.12.3, 2.13.0, 2.14.0, 2.15.0, and X.Y.Z (at least 2.16.0) are merged and published, and the DevBot validation and pre-activation smoke test of X.Y.Z passed.
2. **Owner actions.**
   - Remove the production application `965294750741692416` from the development guild `1040379370159743139`. It must not be installed there: with `TEST_GUILD_ID` empty, its global commands would appear there, and a `/config` there would create an effects-enabled production guild row.
   - Record where the legacy bot runs and how its supervisor restart is disabled (W2).
   - Decide which holders of the legacy Officer role keep officer authority without the in-game Officer rank; they receive `/officer grant` at W15.
   - Make the legacy Officer role (and an FC Leader role, if one will be bound at W15) bindable. `/config roles` refuses a role that grants Administrator, Manage Server or Manage Roles, or that sits at or above the bot's highest role (`DiscordGateway.validateRole`). If step 6 reports either, remove those permissions or move the role below the bot before the window, or choose another Officer role. The W15 manager must also be the guild owner or have a highest role above @Officer.
3. **Managed cluster** (owner-authorized; details in [APP_PLATFORM.md](APP_PLATFORM.md#provider-prerequisites-owner-authorized)). Cluster `tarubot-pg` runs PostgreSQL 18. `doadmin` creates the user `tarubot` and the databases `tarubot`, `tarubot_rehearsal`, and `tarubot_restore_test`. Connected to each database as `doadmin`, it grants:

   ```sql
   GRANT CONNECT ON DATABASE tarubot TO tarubot;  -- name the database being granted
   GRANT USAGE, CREATE ON SCHEMA public TO tarubot;
   SELECT has_schema_privilege('tarubot','public','USAGE') AS usage,
          has_schema_privilege('tarubot','public','CREATE') AS "create";
   ```

   Every schema-changing or writing tool connects as `tarubot`; tables created by `doadmin` would be unusable by the app.
4. **Trusted sources and CA.** Add the operator's IP as a trusted source before the app exists. Right after creating the app, add its `app:` rule, because App Platform does not add it by itself, then confirm the rule. Save the cluster CA as `work/ca-certificate.crt` and in both env files.
5. **Foundation app.** Create the app from the worker-free `foundation` phase ([APP_PLATFORM.md](APP_PLATFORM.md#creating-the-app-without-a-writer)). Its pre-deploy job proves the binding, TLS, and grants. Expect `Schema ready.` in the job log, and check that `pg psql -d tarubot -At -c "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1" -c "SELECT count(*) FROM guilds"` prints the release's `SCHEMA_VERSION` and `0`.
6. **Read-only production inspection** (authorized pre-window token use). Take a read-only dump of the live legacy database, `mysqldump --single-transaction --default-character-set=utf8mb4 LEGACY_DATABASE > work/legacy-rehearsal.sql`, and record its checksum. Then run these REST-only reads:

   ```sh
   rehearse dist/scripts/discord-inspect.js --guild 1036062273631952955 --dump work/legacy-rehearsal.sql \
     --role LEGACY_OFFICER_ROLE_ID [--role LEADER_ROLE_ID] > work/inspect-before.json
   rehearse dist/scripts/commands.js list > work/commands-before.json   # exits 2 while legacy commands exist
   ```

   Check that `application.intents.guildMembers` is `enabled` or `limited` (an unverified app in fewer than 100 guilds reports `limited`; `disabled` means the Server Members Intent is off in the Developer Portal) and that `application.intents.probe` is `ok`. The guild list must contain only the production guild. Check the bot's permissions with and without Administrator, that the managed roles are below the bot, and access to the destination channels. The legacy dump names only the Member and Guest roles, so the `--role` flags add the roles W15 binds. Every `target.managedRoles[]` entry, including those with `field: "role"`, must show `exists: true`, `belowBot: true` and `blockingPermissions: []`; otherwise W15's binding is refused (see step 2). From the command read-back, record the legacy global set and any guild-scoped leftovers. An Activity entry-point command (type 4) in the global scope would make W12's bulk registration fail with Discord error 50240; resolve it before the window.

## E2. Rehearsal (before the window; the legacy bot keeps running)

The rehearsal uses the real cluster, a disposable `tarubot_rehearsal` database, and `rehearsal.env`. The owner authorized its gateway logins (snapshot and preview) and the roster acquisition while the legacy bot is still connected. The guard refuses every Discord write (registration, command cleanup) under this profile.

1. Use the E1 dump, or take a newer one the same way.
2. Run the writer-lease gate against `tarubot_rehearsal` (`pg psql -d tarubot_rehearsal …`), then `rehearse dist/scripts/migrate.js`.
3. `rehearse dist/scripts/snapshot.js --dump work/legacy-rehearsal.sql --output work/rehearsal/discord-snapshot.json`
4. Run `rehearse dist/scripts/import.js --file work/legacy-rehearsal.sql --snapshot work/rehearsal/discord-snapshot.json --source-timezone UTC --dry-run`, then run it again without `--dry-run` and save the output as `work/rehearsal/import-report.json`.
5. Acquire twice, at least 60 seconds apart. `rehearse dist/scripts/acquire.js 1036062273631952955`, wait, then run it again. The second observation confirms imported members who are absent from the live roster.
6. `rehearse dist/scripts/preview.js 1036062273631952955 --output work/rehearsal/plan.json > work/rehearsal/preview.json`
7. Only if the owner separately authorizes its gateway login, run `rehearse dist/scripts/activate.js 1036062273631952955 --grandfather-plan SHA --grandfather-plan-file work/rehearsal/plan.json`. It validates the production roles and channels and exercises the one-time grandfathering, writing only to `tarubot_rehearsal`. Never point a worker or spec at `tarubot_rehearsal`.
8. Rehearse restore on the same cluster (E4 limit (b)). Dump `tarubot_rehearsal` with `pg pg_dump -d tarubot_rehearsal -Fc -f /work/rehearsal/rehearsal.dump`, then `pg pg_restore -d tarubot_restore_test --no-owner --no-privileges --exit-on-error /work/rehearsal/rehearsal.dump`. Add `RESTORE_DATABASE_URL=…/tarubot_restore_test` to `rehearsal.env`, then run `rehearse dist/scripts/check-restore.js`.
9. Time every step. The import is one long transaction over the WAN.
10. Owner review, from `preview.json`:
    - **Member removals:** `roleTotals` entries whose `binding` is `member` (`remove`), plus `pendingDepartures`. This covers Member holders without a qualifying link, including those who already hold a grant.
    - **Guest additions:** registered users and former members (`grandfathering.plannedDetail.registeredVisitors`, `formerMembers`, `guestRoleAdded`).
    - **Grandfathering:** `grandfathering.planned`, `skipped.existingGrant.byProvenance` (overlap with `imported_guest`), and `skipped.revoked` (expected 0). A grant that `/guest reset` ended also counts under `skipped.existingGrant`, so a reset before activation is not undone. It appears in no `byProvenance` entry, which lists active grants only. With no worker before W13, expect none here.
    - **Nicknames:** nickname targets are expected to be zero.
    - **Later layout:** `roleLayout.ifEnabled` shows what enabling the layout would change.
11. Clean up. `doadmin` drops `tarubot_rehearsal` and `tarubot_restore_test`. After a rehearsal activation the database holds effects-enabled queued work, so drop it promptly. Delete `rehearsal.env`. Keep the timings and outputs.

## E3. Maintenance window

**Time budget.** Activation (W11) must commit within `ROSTER_INTERVAL_SECONDS` (21,600 in `production.env`) of the confirming acquisition at W8. Any acquisition after the W9 preview needs a new preview and checksum; the checksum binds the roster snapshot, so activation refuses the old one.

- **W1. Announce.** Staff freeze Member, Guest, and Officer role edits.
- **W2. Stop the legacy bot.** Stop the legacy process, disable its supervisor restart, and confirm the bot is offline. A legacy restart after this point would re-sync its commands and change roles.
- **W3. Reset the token.** The owner resets the token of `965294750741692416` in the Developer Portal. The new token goes into `production.env` and, at W13, the App Platform secret. The legacy process can no longer connect.
- **W4. Final dump.** Run `mysqldump --single-transaction --default-character-set=utf8mb4 LEGACY_DATABASE > work/legacy-final.sql` and record the checksum. Run `prod dist/scripts/import.js --file work/legacy-final.sql --source-timezone UTC --dry-run > work/import-dry-run.json`, then reconcile counts and balances independently of the report.
- **W5. Migrate.** Run the writer-lease gate, then `prod dist/scripts/migrate.js`. It prints `Schema ready.`; after the foundation deploy it changes nothing.
- **W6. Snapshot.** Run `prod dist/scripts/snapshot.js --dump work/legacy-final.sql --output work/discord-snapshot.json` and record the checksum. This is also the record of pre-cutover roles for E4.
- **W7. Import.** Repeat the dry run with `--snapshot work/discord-snapshot.json`. Run the writer-lease gate, then publish with `prod dist/scripts/import.js --file work/legacy-final.sql --snapshot work/discord-snapshot.json --source-timezone UTC > work/import-report.json`. Verify the launch defaults:

  ```sh
  pg psql -d tarubot -c "SELECT effects_enabled, access_policy_enabled, role_layout_enabled, guest_grandfather,
    guest_applications_enabled, guest_application_channel_id, officer_role_id, leader_role_id, officer_rank_name FROM guilds"
  ```

  Expect `f, f, f, pending, f`, then the legacy review channel `1196246221682131017`, then three NULLs. The publish output is `{status: "imported", report}`, and its `report.guildSettings[0].guestApplications` is `{state: "closed", legacyChannelId: "1196246221682131017"}`.
- **W8. Acquire twice.** With the sidecar running, run `prod dist/scripts/acquire.js 1036062273631952955 > work/roster-1.json`. Wait at least 60 seconds, then run it again with output to `work/roster-2.json`. Note the time of the second run; the time budget starts here.
- **W9. Preview.** Run `prod dist/scripts/preview.js 1036062273631952955 --output work/grandfather-plan.json > work/preview.json`. The plan checksum is printed on stderr and appears as `grandfathering.planChecksum`.
  - If `pendingDepartures.count` is not zero, the plan is blocked. Acquire again at least 60 seconds after the previous acquisition, then preview again.
  - Review the same totals as E2 step 10 and compare them with the rehearsal.
  - Expect `guestApplications: "closed"` (the switch is off; the legacy review channel is set), `onboarding: false`, and a `roleLayout` of `{enabled:false, wouldRun:false, skipped:"layout disabled"}`.
  - The owner gives go or no-go. Record the checksum.
- **W10. Backups.** Record the UTC time `T_pre` as the point-in-time-recovery target and confirm the cluster's backups. Take an independent logical backup with `pg pg_dump -d tarubot -Fc -f /work/backups/pre-activation.dump`, record its checksum, and copy it off the provider.
- **W11. Activate.** Activation writes only to PostgreSQL; it reads Discord to validate roles and channels and to enumerate members. Run the writer-lease gate, then `prod dist/scripts/activate.js 1036062273631952955 --grandfather-plan SHA --grandfather-plan-file work/grandfather-plan.json > work/activation.json`.
  - **Guest applications:** pass no `--guest-applications` flag. Without it the switch keeps its imported value (off), so no explicit choice is required, and activation neither changes nor validates the legacy review channel. `--guest-applications open` would switch applications on; it needs a review channel, and activation then validates that channel. `--guest-applications closed` switches them off and keeps the channel; for an import it changes nothing. Opening applications is not part of the launch.
  - **Success:** the output reports `status: "activated"`; `grandfathering` shows `completed` with the planChecksum and `granted`; applications are closed, onboarding is false, and roleLayout is disabled. `lateJoiners` lists humans who joined between the enumeration and the commit.
  - **Plan mismatch:** `status: "plan_mismatch"`, exit 1, and nothing is written. The output shows the added and removed users relative to the reviewed file and whether the roster snapshot or the import changed. If either changed, return to W9. Otherwise the owner reviews only that difference, then either rerun W9 or rerun activate with `--grandfather-plan NEW_SHA` alone; the old plan file describes the previous plan.
  - **Stale roster or pending departures:** return to W8.
  - The commit ends abort limit (a) in E4.
- **W12. Commands.** Run `prod dist/scripts/register.js --global`; it prints the application, `scope: "global"`, 19 roots, and 43 paths.
  - Read back with `prod dist/scripts/commands.js list > work/commands-registered.json`.
  - For each guild scope that still holds commands, run a dry run, for example `prod dist/scripts/commands.js clear-guild 1036062273631952955 --application 965294750741692416`, review the listed commands, then rerun the printed command with `--confirm FINGERPRINT`.
  - Finally, `prod dist/scripts/commands.js list > work/commands-final.json` must exit 0.
  - v2 commands are visible now with nothing answering them, so continue straight to W13.
- **W13. Start the only writer.** Copy the release's `.do/app.yaml` to `.cache/app-platform-full.yaml` (`chmod 600`) and put the new token in `DISCORD_TOKEN`. The foundation app holds no worker secrets; re-add registry credentials if the packages are private. Then:

  ```sh
  bun dist/scripts/app-spec.js full .cache/app-platform-full.yaml .cache/app-platform-full.checked.yaml
  doctl apps spec validate .cache/app-platform-full.checked.yaml --schema-only > /dev/null
  doctl apps update APP_ID --spec .cache/app-platform-full.checked.yaml
  ```

  The `full` phase refuses leftover placeholders and anything other than one non-autoscaled worker. The pre-deploy migration is a no-op. The worker takes the writer lease, then logs in. In its console, `/health/ready` must report the writer lease, the database, and Discord as ready, with effects enabled.

  Once `/health/ready` reports ready, run `rm -f .cache/app-platform-full.yaml .cache/app-platform-full.checked.yaml`. Both hold the new token in plaintext. Later `full` updates start from the exported live spec, where the token appears only as `EV[...]`.
- **W14. Smoke checks.**
  - `/config show` and `/config validate`: onboarding off, role layout disabled, guest applications off, and roles/channels available. `/config show` reads "Off · reviews in #…" with the legacy review channel; `/config validate` reads "Guest applications: closed, so /apply refuses" and shows no check for that channel while applications are off.
  - `/sync status`: the activation reconcile drains with nothing blocked.
  - `/ledger balance` equals the final dump's opening balance.
  - `/guest status` for one imported guest and one grandfathered user (provenance `grandfathered`).
  - `/apply` as a visitor answers "Guest applications are not open in this server. Ask an officer about Guest access." without opening the form.
  - Managed-role hoist and positions are unchanged. Compare `prod dist/scripts/discord-inspect.js --guild 1036062273631952955 --dump work/legacy-final.sql --role LEGACY_OFFICER_ROLE_ID [--role LEADER_ROLE_ID]`, with the same `--role` flags as E1, against E1's output. The Officer entry must still be bindable before W15.
  - A non-officer is denied an officer operation, and a representative `/claim` and `/verify` work.
  - After the first guild reconciliation completes, run `prod dist/scripts/preview.js 1036062273631952955 --late-joiners > work/late-joiners.json`, which reads only the database. Officers decide `/guest grant` for each listed user.
- **W15. Officer configuration.** A server manager with Manage Server and Manage Roles, who is the guild owner or whose highest role is above @Officer, runs these in order:
  1. `/config officer_rank rank:Officer`. Repeating it with the saved rank replies "Officer rank already set" and changes nothing (no revision bump, audit or repair pass).
  2. `/officer grant member:… reason:…` for each exception the owner approved in E1. With no Officer role bound yet, each "Officer access granted" reply says the grant is recorded and takes effect once `/config roles officer` binds a role, and its Discord role field reads "Applies once an Officer role is set".
  3. `/config roles officer role:@Officer adopt_holders:false`. The reply is titled "Officer role set without adopting holders", with the footer "Audited · adopt_holders:false".

  Binding the role queues an immediate repair pass. Mapping the rank first and recording the grants before the binding means neither rank holders nor approved exceptions lose Officer in between. Holders with neither the rank nor a grant lose the Officer role once reconciliation runs. Optionally run `/config roles leader role:@…`. Do not run `/setup`: it would enable onboarding, open `/apply`, and adopt every Officer-role holder. Staff change access with `/officer grant|revoke` and `/guest grant|revoke`; hand edits to managed roles are treated as drift. `/officer reset` and `/guest reset` are in launch scope (owner decision, 2026-09-24) but are not cutover steps. Each removes a member's override so the automatic rules decide again. `/officer reset` removes an approved exception's grant too, and needs the same manager as grant and revoke. `/guest reset` also ends imported and grandfathered grants.
- **W16. Close the window.**
  - Remove the operator's trusted-source IP, unless the owner keeps a narrow rule for exports, and stop the sidecar.
  - Export the live spec to `.cache/` (`chmod 600`), and archive `work/` with its checksums off the provider. Confirm that `.cache/app-platform-full.yaml` and `.cache/app-platform-full.checked.yaml` are gone (W13), and remove the token from `production.env` unless local tools still need it.
  - Post the MIG-10 announcement: members opt in with `/main character:ID` and `/nickname enabled:true`. Visitors get Guest by verifying a character with `/claim` and `/verify`, or by asking an officer for `/guest grant`. `/apply` is not open yet. Reopening it later is `/config guest_applications enabled:true`, which reuses the imported review channel. Switching on validates that channel first. If it was deleted, or TaruBot can't post there, the command refuses with "Discord permissions need attention", naming the channel, and saves nothing. Fix the channel's permissions, or name another channel in the same command: `/config guest_applications enabled:true channel:#…`.

## E4. Recovery and abort limits

**(a) Before the activation commit (W11).** Abort. Give the legacy bot the new token from W3, restart it, and re-enable its supervisor; its command sync restores its commands. Unfreeze role edits. Keep the production database for a retry. If the legacy data changes before the next attempt, `doadmin` drops and recreates `tarubot` and repeats the grants, and the retry starts again at W2.

**(b) After the activation commit, before the worker starts (W13).** Discord roles are unchanged because no writer has run. Continue forward if the problem can be fixed. To abort instead, return the database to its pre-activation state first. On a managed cluster, `doadmin` owns this:
- **Restore in place.** Rename or drop `tarubot`, recreate it with the grants, and restore the W10 backup as `tarubot`: `pg pg_restore -d tarubot --no-owner --no-privileges --exit-on-error /work/backups/pre-activation.dump`.
- **Or fork.** A DigitalOcean point-in-time restore to `T_pre` forks a **new cluster** (new host and CA, trusted sources to recheck). Repoint the spec's `cluster_name` and the local production tooling (env file host and CA, `work/ca-certificate.crt`, `PGHOST`, the writer-lease gate) to the fork, and retire the original database by renaming it, as in [APP_PLATFORM.md](APP_PLATFORM.md#backups-pitr-and-recovery). At W13 of a retry, set `databases[0].cluster_name` in `.cache/app-platform-full.yaml` to the fork, because the release template names `tarubot-pg`. Restoring in place keeps the host, CA and template cluster name, so prefer it before the worker has started.

Then restart the legacy bot as in (a). If W12 already ran, the legacy command sync replaces the v2 global set, and the next attempt registers it again.

**(c) After the worker has applied effects.** Recovery is forward-only. A database restore does not revert Discord role changes, and recovery must retain acknowledged decisions (MIG-13), so never restore to before activation once any user decision has been acknowledged. Correct individual outcomes with `/guest revoke`, `/guest grant`, `/officer grant|revoke`, and `/config`. `/guest reset` and `/officer reset` are optional (W15). `/guest reset` also ends imported and grandfathered grants, so use it only where FC membership or a registered character should decide Guest. To stop the writer, apply the maintenance phase.

For role repairs, compare current managed roles with the W6 snapshot. Capture a fresh snapshot with `prod dist/scripts/snapshot.js --dump work/legacy-final.sql --output work/role-check.json`; it is a read-only gateway login. Then list every user whose managed roles differ, with `null` meaning absent:

```sh
jq -n --slurpfile before work/discord-snapshot.json --slurpfile after work/role-check.json \
  --arg guild 1036062273631952955 \
  --argjson managed '["MEMBER_ROLE_ID","GUEST_ROLE_ID","OFFICER_ROLE_ID","LEADER_ROLE_ID"]' '
  def managedRoles($snapshot):
    $snapshot[0].guilds[] | select(.id == $guild) | .members
    | map({key: .id, value: ([.roles[] | select(IN($managed[]))] | sort)}) | from_entries;
  managedRoles($before) as $b | managedRoles($after) as $a
  | [($b + $a | keys[]) as $user | {user: $user, before: $b[$user], after: $a[$user]}
     | select(.before != .after)]' > work/role-diff.json
```

Take the role IDs from `SELECT member_role_id, guest_role_id, officer_role_id, leader_role_id FROM guilds`. Officers resolve each difference explicitly through the commands above, never by hand-editing managed roles.

Re-importing the legacy opening snapshot is never a post-activation recovery mechanism. Keep the dumps, snapshots, reports, and backups as immutable inputs. See [HOSTING.md](HOSTING.md#backups-and-recovery) for production backups, and the site's [operations](../site/src/content/docs/deploy/operations.md) and [monitoring](../site/src/content/docs/deploy/monitoring.md) pages for restore checks and retries.

## Record of the 2026-09-24 cutover

The cutover ran with release 2.16.0 (merge `c812d4d`). The operator's evidence log and every artifact, with its checksum, are in `~/tarubot-cutover/work/`.

- **Preparation (21:10–21:48 UTC).**
  - The owner created cluster `tarubot-pg` (PostgreSQL 18.6, nyc3).
  - The foundation app came up at 21:18, with migrations 001–006 applied under the migration guard's lease line.
  - **App Platform did not add an `app:` trusted-source rule by itself.** The first pre-deploy migration timed out until the owner added the rule. E1 step 4 and [APP_PLATFORM.md](APP_PLATFORM.md) now say to add the rule explicitly.
  - The E1 inspection found the bot in two other guilds and @Officers holding Manage Server and Manage Roles. The owner removed both before the rehearsal.
  - The E2 rehearsal imported the rehearsal dump in 208 s, acquired 105 roster members twice, previewed 3 role changes and 2 planned grandfathered grants, and verified a restore at `006`.
- **Window (21:50–22:02 UTC).**
  - The legacy bot was already offline, with its token reset.
  - W4 dumped the legacy database. The dump matched the direct counts: FC 40, characters 4,251, members 241, guild 1, links 161.
  - W7 imported it in 206 s, with the launch defaults and the guest-application switch off on the legacy channel.
  - W9 previewed plan `aaef7f2f…` with the same three role changes as the rehearsal: Bukidai Sagahl and Oydela Seoel from Member to Guest (grandfathered), and Arvin Daliseas from Guest to Member.
  - W10 took `pre-activation.dump` and set `T_pre` to 21:59:59.
  - W11 activated at 22:00:39, granting 2. Late joiners were unavailable because the member list was incomplete.
  - W12 registered 19 roots and 43 paths globally, and the read-back was clean.
  - W13's worker took the writer lease and was ready at 22:02.
- **The move to Linode (22:38–22:40 UTC).**
  - Every profile refresh failed. From App Platform the Lodestone answered **HTTP 403 in 4–41 ms**, an edge block of DigitalOcean's addresses, while other networks got 200.
  - The owner chose a Linode Docker host with Linode managed PostgreSQL ([HOSTING.md](HOSTING.md)) over proxying.
  - The move took four steps:
    1. The App Platform maintenance phase stopped the worker; the DigitalOcean database showed no lease holder and no connections.
    2. `pg_dump` took 4 s and `pg_restore` into Linode 6 s.
    3. `check-restore.js` verified 26 tables at `006` across the two providers.
    4. `docker compose -f docker-compose.production.yml up` became healthy at 22:39:56.
  - Downtime was about 90 seconds. The first profile burst after the move hit Lodestone rate limits, and retries caught up.
- **Left open:**
  - W14 smoke checks and W15 officer configuration;
  - the late-joiner check (`preview.js --late-joiners`);
  - a retry of the profile jobs that failed on DigitalOcean;
  - the DigitalOcean app, cluster and trusted-source cleanup;
  - rotating the legacy MariaDB login.

  [OPEN_ITEMS.md](OPEN_ITEMS.md) tracks them.
