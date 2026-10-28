# Configuration and tool boundaries

Use the site's [configuration page](../site/src/content/docs/deploy/configuration.md) for runtime settings, defaults and ranges, and `.env.example` for local setup. This reference covers secret handling, the backup settings and maintenance-tool guards.

## Build configuration

Rebuild with `bun run build` after source changes before running compiled tools under `dist/scripts/`. Toolchain pins and checks are in [CONTRIBUTING](../CONTRIBUTING.md); runtime validation is in `src/config/env.ts`.

## Secrets from files

Use `src/config/secrets.ts` to resolve supported secret settings from either `NAME` or `NAME_FILE`:

- An unset/empty file setting uses the plain value.
- A file setting reads UTF-8 text and removes exactly one final newline. Setting both forms is a configuration error.
- Unreadable files name the setting only, never the path or value.
- Bot/tool readers and redaction use the resolved values, not direct reads from `process.env`.

Production and staging require a non-empty resolved database CA. Connections verify the certificate and hostname even when URL SSL flags would weaken verification. `RESTORE_DATABASE_URL` and `RESTORE_DATABASE_CA_CERT` have no file forms; an empty restore CA reuses the resolved primary CA.

Managed runtimes take their settings from the Compose project's environment ([managed runtime settings](#managed-runtime-settings)). Generic Docker secrets can instead supply supported `NAME_FILE` settings through read-only mounts; retain the resolver behavior above. Never log secrets or put them in argv.

The optional dashboard's `DISCORD_CLIENT_SECRET` is a plain environment secret only, not one of the supported `*_FILE` settings. The existing `DISCORD_APPLICATION_ID` is its OAuth client ID. `WEB_PUBLIC_ORIGIN` is shared by the bot and Caddy and determines the exact `/auth/callback` redirect; `WEB_PORT` defaults to private `8080`. `COMPOSE_PROFILES=web` additionally selects the bundled proxy, the release's own web image, while an empty profile supports bot-only operation or an external proxy. See the site's [web settings](../site/src/content/docs/deploy/configuration.md#optional-web-dashboard) and [installation](../site/src/content/docs/deploy/install.md#optional-https-dashboard), rather than creating a separate settings source.

Mod mail's `MODMAIL_KEY` (2.43.0) is a plain environment secret like `DISCORD_CLIENT_SECRET`, not a `*_FILE` setting: base64 for exactly 32 bytes, from `openssl rand -base64 32`, checked at startup by `src/infrastructure/modmail/cipher.ts`. Empty or malformed only makes mod mail unavailable (a malformed value is reported by name once the bot holds the writer lease), never stops the bot; readiness says only whether it is valid, and issue reports redact it. Every manifest passes it through (`MODMAIL_KEY: ${MODMAIL_KEY:-}`). main.ts reads it once, deletes it from `process.env` and keeps it out of the configuration object, so nothing that logs or reports settings can find it later. Only the cipher and the backup service keep it: the service's settings snapshot goes, encrypted, into each backup's settings copy (2.46.0). Keep a copy outside the runtime: it encrypts every case and has no rotation yet ([deployment](DEPLOYMENT.md#rotation-and-host-loss)).

Private issue reports may not target the public repository. Public-suggestion App credentials belong only to production; DevBot, on the staging host, previews into the private reports repository with staging's own reports token. See the site's [monitoring reference](../site/src/content/docs/deploy/monitoring.md).

## Backup settings

The bot's own backups (2.46.0, `src/application/backups.ts`) read plain environment variables; none has a `*_FILE` form. `backups.ts` validates them itself, not `src/config/env.ts`, so a bad backup setting never stops the bot: once the bot holds the writer lease it files one issue report naming the settings at fault (never a value), and every backup then fails at stage `settings`.

| Setting | Rule |
| --- | --- |
| `BACKUP_STORAGE_ENDPOINT` | The bucket's own HTTPS host (virtual-hosted style); `https://` may be left off, an optional `:port` is allowed, one trailing `/` is dropped and a path becomes a key prefix. Empty turns backups off |
| `BACKUP_STORAGE_ACCESS_KEY`, `BACKUP_STORAGE_SECRET_KEY` | Required when the endpoint is set. The key pair needs read and write on the bucket: the monthly copy reads the daily object back, and `restore.js` lists and reads |
| `BACKUP_STORAGE_REGION` | Required when the endpoint is set: the bucket's signing region, `[a-z0-9-]+`, with no default |
| `BACKUP_AGE_RECIPIENTS` | One or more age public keys (`age1…`), separated by whitespace or commas, each one `age-encryption` itself decodes (its Bech32 checksum included), so a mistyped key is an invalid setting like any other, not a failure at stage `dump`. Production's is the key in [age-recipients.txt](../ops/age-recipients.txt); staging has its own |
| `BACKUP_TIME_UTC` | `HH:MM`, UTC, default `03:00` |
| `HEALTHCHECKS_BACKUP_URL` | Optional healthchecks.io check for backups, `https://` only |

Without an endpoint the bot takes no daily backups (it logs that once at info), and the pre-migration rule decides: production and staging refuse to apply a pending migration without a backup first, and other profiles warn and migrate. With backups configured, a database whose first migration is still pending holds nothing to back up, so it is migrated without one. The `rehearsal` profile never backs up, configured or not: its `*_rehearsal` database is disposable, and its one-off containers carry production's backup settings, so its dump would become the newest object in production's bucket, the one `restore.js` takes as `latest`. The bot and `migrate.js` take no pre-migration backup there, and `backup.js` refuses that profile ([deployment](DEPLOYMENT.md#backups-and-restore)).

A backup cut off by a shutdown (a restart, a tag move, `docker compose stop`) sends no `/fail` ping: nothing broke, its `/start` stays open until a later backup succeeds, and healthchecks.io marks the check down by itself if none does within the check's grace time. Every other failure pings `/fail`, a settings failure included.

The settings copy in `env/` is the bot's own settings as the container received them, captured once at startup before `MODMAIL_KEY` leaves `process.env`: every variable whose name matches `^[A-Z][A-Z0-9_]*$`, except `PATH`, `HOME`, `HOSTNAME`, `PWD`, `OLDPWD`, `SHLVL`, `TERM`, `LANG`, `LANGUAGE`, `LC_ALL`, `TZ` and names starting `BUN_`, `NODE_` or `LC_`, with each `NAME_FILE` secret replaced by its resolved value under `NAME`. It is a Compose-compatible env file: a `# TaruBot <version> settings copy, <stamp>` line, then `NAME='value'` sorted by name (single quotes are literal and may span lines), or `NAME="value"` with `\\`, `\"` and `$$` escapes when the value holds `'` or `\` (Compose's parser reads a backslash before a quote as an escape even inside single quotes, so a value ending in `\` would otherwise run on into the next line), which `docker compose --env-file` reads back exactly. The manifests also pass the bot the Compose project's own settings, which it ignores, so the copy starts the project again as it was: `TARUBOT_IMAGE_REPOSITORY`, `TARUBOT_IMAGE_TAG` and `COMPOSE_PROFILES` from every manifest, and from the stock file also `TARUBOT_IMAGE`, `POSTGRES_PASSWORD` and `COMMAND_REGISTRATION`. A profile chosen with `--profile` on the command line never reaches the copy, so set `COMPOSE_PROFILES` instead. `restore.js settings` prints every secret to standard output: run it with `--rm`, since Docker keeps a container's output in its log until the container is removed.

`pg_dump` and `pg_restore` never see a URL or password in argv (`src/infrastructure/postgres/libpq.ts`). Their environment is built from scratch: the URL's parts as `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, a 10-second connect timeout and the application name `tarubot-backup` or `tarubot-restore`, plus only `PATH`, `HOME` and `TMPDIR`, so the bot's other settings never reach them. With a CA, it is written to a private file in a fresh directory under `/tmp` (the manifests' 1 MiB tmpfs), the connection uses `verify-full` whatever the URL's TLS parameters say, and the directory is removed afterwards. Without one (self-hosted installations only: production and staging require a CA), the tools must connect wherever the bot's driver does and verify at least as much, and the URL never reaches them, so its TLS parameters are translated into libpq's as node-postgres (`pg-connection-string`) reads them. `sslmode=disable`, or `ssl=0` without a certificate file, is plaintext. Node-postgres's `sslmode=no-verify` (or, alone, `ssl=no-verify`) becomes libpq's `require`, without a root certificate (libpq verifies the chain whenever one is named). Every other `sslmode` (`require` and `prefer` included, which node-postgres verifies fully), any other `ssl` value (node-postgres takes even `ssl=false` as TLS on), a certificate file or `sslnegotiation=direct` becomes `verify-full`, against `sslrootcert` or else the image's system CA bundle (`PGSSLROOTCERT=system`). With `uselibpqcompat=true` libpq's own meanings are kept, except `prefer` (`require`) and `allow` (`verify-full`), for which node-postgres insists on TLS, and `verify-ca` without `sslrootcert`, which is refused as node-postgres refuses it, naming `DATABASE_CA_CERT` (for `RESTORE_DATABASE_URL`, `RESTORE_DATABASE_CA_CERT` or `DATABASE_CA_CERT`). With no TLS parameter at all, libpq's default applies. `sslcert` and `sslnegotiation` pass through as `PGSSLCERT` and `PGSSLNEGOTIATION`; `sslkey` is copied to a private file (mode 0600) in a fresh directory under `/tmp`, removed afterwards, since libpq refuses a key its group or others can read and node-postgres doesn't, and a key that can't be read is refused by setting name. Issue reports redact the storage keys and the ping URL.

## Managed runtime settings

Production and staging settings live in separate private copies of `production.env.example` and `staging.env.example`, mode 600, passed to Compose as the project's environment with `--env-file`; never copy production's to staging. `TARUBOT_IMAGE_REPOSITORY` (`ghcr.io/deconfined/tarubot-release`, the package only an approved Deploy writes) and `TARUBOT_IMAGE_TAG`, the channel tag the runtime follows (`production` or `staging`), are both required; the proxy runs `web-<tag>` from the same repository. Unset, as in the stock file, `docker-compose.yml` and `docker-compose.web.yml` use `ghcr.io/deconfined/tarubot`. Containers keep the settings they were created with: after a change, run `up -d` again, never `restart`. That holds for the web settings too; the proxy's Caddyfile and offline page come with its image. A variable exported in the shell overrides the file. See [what runs on a Docker host](DEPLOYMENT.md#what-runs-on-a-docker-host).

The GitHub environments `production` and `staging` each hold one secret, `RELEASE_REGISTRY_TOKEN`, and no variables: Deploy verifies the release with the workflow's own read-only token and copies it to the channel tags with that token, and no database, Discord or backup credential reaches a runner. Repository variables independently control activation: `DEPLOY_ENABLED` for production and `STAGING_DEPLOY_ENABLED` for staging ([owner settings](DEPLOYMENT.md#owner-settings-in-github)).

## Maintenance-tool profiles

Every Discord/database maintenance tool calls `src/config/deployment.ts` before I/O. Discord tools also confirm the token's application after authentication. Publishing an import is guarded; a credential-free dry run is not. Application/guild identities live in that module.

| Profile | Discord scope | Database boundary |
| --- | --- | --- |
| `production` | Production application, managed guilds, global registration only; no test/public-response settings | Managed endpoint, verified CA, direct port 27520, user `tarubot`, database `tarubot` or `tarubot_restore` |
| `rehearsal` | Production identity, read-only Discord; no registration/cleanup | Primary ends in `_rehearsal`; restore ends in `_restore_test`; managed endpoints require CA/direct port and a non-admin user |
| `staging` | Managed DevBot identity, guild registration only; explicit staging deployment target | Managed endpoint, CA/direct port; user and database exactly `tarubot_staging`; no restore target or restore-rehearsal flag |
| `devbot` | DevBot identity and test guild, never global registration | Local endpoint, empty CA, primary `tarubot_dev`; restore ends in `_restore_test` |
| `unmanaged` | Other developers/CI; may not use managed identities or guilds | No deployment-specific database rules |

Select managed profiles with `TARUBOT_ENVIRONMENT`. Only local DevBot may be inferred from its application; staging requires its marker. Production/rehearsal reject staging database/user names. URLs must contain host, port, user and database: libpq identity overrides in query parameters are refused. Restore into a different database from the primary.

The bot declares the same scopes as the tools for what it does at startup (2.46.0): `migrate.js`'s before it applies migrations, and `register.js`'s for its profile's registration scope. Managed profiles ignore `COMMAND_REGISTRATION` and keep their own scope. An `unmanaged` installation registers only where `COMMAND_REGISTRATION` says (read by `src/application/startup.ts`, not `env.ts`, so it never stops the bot): `global`, a server ID (through the same guard as `register.js --guild`), or `off`; empty or unset is off, with one info line at each start, because a self-hoster who registered one server by hand before 2.46.0 would see every command twice there after a global registration. `global` is refused while `TEST_GUILD_ID` is set, as `register.js --global` is. A bad value is reported (`command registration`, code `configuration`) and registration skipped. `.env.example` sets `global` for new installations. `backup.js` reads `DATABASE_URL` only, and refuses the `rehearsal` profile. `restore.js database` touches `DATABASE_URL`'s identity and `RESTORE_DATABASE_URL` under `check-restore.js`'s restore-target rules (production: `tarubot_restore` on the primary's host, or `tarubot` on another host; refused on staging), and refuses a target server older than PostgreSQL 17, whose `pg_restore` 18 statements it would reject (`transaction_timeout`); its `list` and `settings` modes touch no database.

### DevBot rehearsal exceptions

- Only local DevBot's `migrate.js --restore-rehearsal` may use a `*_restore_test` primary, to rehearse a migration before touching `tarubot_dev`.
- Per-tool-run `DEVBOT_THROWAWAY_GUILD_ID` must equal `TEST_GUILD_ID` and name no managed guild. It replaces the DevBot guild/registration scope, and other profiles refuse it. No manifest passes it to the bot; since 2.46.0 the bot's startup guard (migration and registration) reads it as the tools do, so never leave it exported where a bot starts. Use `commands.js list --guild <throwaway id>` to inspect that scope.

Shared DevBot updates, `.env` changes and throwaway-server rehearsals are owner-authorized work. See [DevBot](DEV_GUILD.md).

### Launch isolation

Bun loads `.env` automatically, and a `bun run` script child reloads it even when the parent used `--env-file`. Existing shell exports also override file values. Production, rehearsal and staging tools refuse an auto-loaded env file without an explicit `--env-file`.

For an owner-run tool outside containers, use a clean clone of the deployed release and a complete, mode-600 copy of `production.env.example` outside the checkout:

```sh
env -i HOME="$HOME" PATH="$PATH" bun --env-file=PATH dist/scripts/TOOL.js
```

Never use root `bun run` aliases or the development `.env` for production. Container tools run as one-off containers of the bot's service, with the runtime's settings and the running release's image: `docker compose … run --rm -T tarubot bun dist/scripts/TOOL.js`. Always name the tool, since a `run` without a command starts a second bot; see [everyday operations](DEPLOYMENT.md#everyday-operations).

## Schema and runtime configuration

Use [persistence](PERSISTENCE.md) for schema changes and transaction rules; never use automatic schema synchronization or Drizzle Kit push.

Compose keeps read-only bot roots, no capabilities and no-new-privileges; the bot's only writable path is a 1 MiB `/tmp` tmpfs. Infrastructure provisioning is manual; the manifests describe the containers, not the host.
