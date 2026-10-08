# Configuration and tool boundaries

Use the site's [configuration page](../site/src/content/docs/deploy/configuration.md) for runtime settings, defaults and ranges, and `.env.example` for local setup. This reference covers secret handling and maintenance-tool guards.

## Build configuration

Rebuild with `bun run build` after source changes before running compiled tools under `dist/scripts/`. Toolchain pins and checks are in [CONTRIBUTING](../CONTRIBUTING.md); runtime validation is in `src/config/env.ts`.

## Secrets from files

Use `src/config/secrets.ts` to resolve supported secret settings from either `NAME` or `NAME_FILE`:

- An unset/empty file setting uses the plain value.
- A file setting reads UTF-8 text and removes exactly one final newline. Setting both forms is a configuration error.
- Unreadable files name the setting only, never the path or value.
- Bot/tool readers and redaction use the resolved values, not direct reads from `process.env`.

Production and staging require a non-empty resolved database CA. Connections verify the certificate and hostname even when URL SSL flags would weaken verification. `RESTORE_DATABASE_URL` and `RESTORE_DATABASE_CA_CERT` have no file forms; an empty restore CA reuses the resolved primary CA.

Compose deployments use central host-only variables. Generic Docker secrets can instead supply supported `NAME_FILE` settings through read-only mounts; retain the resolver behavior above. Never log secrets or put them in argv.

The optional dashboard's `DISCORD_CLIENT_SECRET` is a plain environment secret only, not one of the supported `*_FILE` settings. The existing `DISCORD_APPLICATION_ID` is its OAuth client ID. `WEB_PUBLIC_ORIGIN` is shared by the bot and Caddy and determines the exact `/auth/callback` redirect; `WEB_PORT` defaults to private `8080`. `COMPOSE_PROFILES=web` additionally selects bundled Caddy, while an empty profile supports bot-only operation or an external proxy. See the site's [web settings](../site/src/content/docs/deploy/configuration.md#optional-web-dashboard) and [installation](../site/src/content/docs/deploy/install.md#optional-https-dashboard), rather than creating a separate settings source.

## Managed host settings

Production and staging settings remain in separate private host `.env` files; release worktrees reuse the appropriate central file. Their GitHub environments hold only their own SSH delivery credential and DNS hostname, not database or Discord credentials. Host identity is authenticated through matching DNSSEC-signed SSHFP in the owner's zone; there is no manual known_hosts fallback. Repository variables independently control activation: `DEPLOY_ENABLED` for production and `STAGING_DEPLOY_ENABLED` for staging. Use `production.env.example` or `staging.env.example` respectively, never a copied production secret file on staging. See [deployment](DEPLOYMENT.md#manual-linode-provisioning) for installation, backup and rotation.

Managed web setting changes require owner-approved recreation against the recorded current worktree and exact digest, not a restart or an `already-live` dispatch. Release worktrees are private (`umask 077`): before enabling or recreating bundled Caddy against the current worktree, run `chmod 644 <current.worktree>/ops/Caddyfile`, which only an actual upgrade with the profile selected does for you. Routine version upgrades retain the central web settings. Stable deploy/backup entries require reviewed owner reinstallation for the optional proxy lifecycle; release source never installs itself. See [owner lifecycle](DEPLOYMENT.md#optional-dashboard-owner-lifecycle).

Private issue reports may not target the public repository. Public-suggestion App credentials belong only to production; local DevBot uses its reports token for private previews. See the site's [monitoring reference](../site/src/content/docs/deploy/monitoring.md).

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

### DevBot rehearsal exceptions

- Only local DevBot's `migrate.js --restore-rehearsal` may use a `*_restore_test` primary, to rehearse a migration before touching `tarubot_dev`.
- Per-tool-run `DEVBOT_THROWAWAY_GUILD_ID` must equal `TEST_GUILD_ID` and name no managed guild. It replaces the DevBot guild/registration scope; other profiles refuse it, and bot startup never reads it. Use `commands.js list --guild <throwaway id>` to inspect that scope.

Shared DevBot updates, `.env` changes and throwaway-server rehearsals are owner-authorized work. See [DevBot](DEV_GUILD.md).

### Launch isolation

Bun loads `.env` automatically, and a `bun run` script child reloads it even when the parent used `--env-file`. Existing shell exports also override file values. Production, rehearsal and staging tools refuse an auto-loaded env file without an explicit `--env-file`.

For an owner-run tool outside containers, use a clean clone of the deployed release and a complete, mode-600 copy of `production.env.example` outside the checkout:

```sh
env -i HOME="$HOME" PATH="$PATH" bun --env-file=PATH dist/scripts/TOOL.js
```

Never use root `bun run` aliases or the development `.env` for production. Container tools use the matching release image, Compose manifest and central settings; see [deployment observation](DEPLOYMENT.md#everyday-observation-and-outcomes).

## Schema and host configuration

Use [persistence](PERSISTENCE.md) for schema changes and transaction rules; never use automatic schema synchronization or Drizzle Kit push.

Compose keeps read-only bot roots, no capabilities and no-new-privileges. Infrastructure provisioning is manual; reviewed release worktrees provide the bot manifest, not host provisioning instructions.
