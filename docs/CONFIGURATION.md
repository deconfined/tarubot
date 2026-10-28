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
| `BACKUP_AGE_RECIPIENTS` | One or more age public keys (`age1…`), separated by whitespace or commas. Production's is the key in [age-recipients.txt](../ops/age-recipients.txt); staging has its own |
| `BACKUP_TIME_UTC` | `HH:MM`, UTC, default `03:00` |
| `HEALTHCHECKS_BACKUP_URL` | Optional healthchecks.io check for backups, `https://` only |

Without an endpoint the bot takes no daily backups (it logs that once at info), and the pre-migration rule decides: production and staging refuse to apply a pending migration without a backup first, and other profiles warn and migrate. With backups configured, a database whose first migration is still pending holds nothing to back up, so it is migrated without one.

The settings copy in `env/` is the bot's own settings as the container received them, captured once at startup before `MODMAIL_KEY` leaves `process.env`: every variable whose name matches `^[A-Z][A-Z0-9_]*$`, except `PATH`, `HOME`, `HOSTNAME`, `PWD`, `OLDPWD`, `SHLVL`, `TERM`, `LANG`, `LANGUAGE`, `LC_ALL`, `TZ` and names starting `BUN_`, `NODE_` or `LC_`, with each `NAME_FILE` secret replaced by its resolved value under `NAME`. It is a Compose-compatible env file: a `# TaruBot <version> settings copy, <stamp>` line, then `NAME='value'` sorted by name (single quotes are literal and may span lines; a value holding `'` is double-quoted with `\\`, `\"` and `$$` escapes), which `docker compose --env-file` reads back exactly.

`pg_dump` and `pg_restore` never see a URL or password in argv (`src/infrastructure/postgres/libpq.ts`). Their environment is built from scratch: the URL's parts as `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`, a 10-second connect timeout and the application name `tarubot-backup` or `tarubot-restore`, plus only `PATH`, `HOME` and `TMPDIR`, so the bot's other settings never reach them. With a CA, it is written to a private file in a fresh directory under `/tmp` (the manifests' 1 MiB tmpfs), the connection uses `verify-full` whatever the URL's `sslmode` says, and the directory is removed afterwards. Issue reports redact the storage keys and the ping URL.

## Managed runtime settings

Production and staging settings live in separate private copies of `production.env.example` and `staging.env.example`, mode 600, passed to Compose as the project's environment with `--env-file`; never copy production's to staging. `TARUBOT_IMAGE_TAG` names the channel tag the runtime follows (`production` or `staging`) and is required. Containers keep the settings they were created with: after a change, run `up -d` again, never `restart`. That holds for the web settings too; the proxy's Caddyfile and offline page come with its image. A variable exported in the shell overrides the file. See [what runs on a Docker host](DEPLOYMENT.md#what-runs-on-a-docker-host).

The GitHub environments hold no secrets or variables: Deploy reads the release and moves registry tags with the workflow's own token, and no database, Discord or backup credential reaches a runner. Repository variables independently control activation: `DEPLOY_ENABLED` for production and `STAGING_DEPLOY_ENABLED` for staging ([owner settings](DEPLOYMENT.md#owner-settings-in-github)).

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

The bot declares the same scopes as the tools for what it does at startup (2.46.0): `migrate.js`'s before it applies migrations, and `register.js`'s for its profile's registration scope (for `unmanaged`, the `TEST_GUILD_ID` guild when set, otherwise global). `backup.js` reads `DATABASE_URL` only. `restore.js database` touches `DATABASE_URL`'s identity and `RESTORE_DATABASE_URL` under `check-restore.js`'s restore-target rules (production: `tarubot_restore` on the primary's host, or `tarubot` on another host; refused on staging); its `list` and `settings` modes touch no database.

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
