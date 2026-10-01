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

The staging playbook feeds secrets to Podman over stdin; the unit mounts them read-only and stores only `NAME_FILE` paths in its settings file. Compose deployments use plain variables. Never log secrets or pass them in argv.

## Staging settings

There is no staging `.env`. `ops/ansible/bot.yml` combines:

1. Plain settings from the release's `vars/bot.yml` and `vars/targets/staging.yml`.
2. Application and guild identity reported by the release image.
3. Runtime and backup secrets from the `staging` GitHub environment. `REPORTS_GITHUB_TOKEN` maps to `GITHUB_REPORTS_TOKEN`, and `SUGGEST_APP_PRIVATE_KEY` to `GITHUB_APP_PRIVATE_KEY`: GitHub disallows secret names starting with `GITHUB_`.

Target files declare required secrets and database identity. Missing/malformed values are refused before host writes. Single-line values must contain no whitespace; only PEM values may span lines. See [deployment](DEPLOYMENT.md) for setup and [host operations](HOSTING.md) for rotation.

Private issue reports may not target the public repository. Public-suggestion app credentials belong only to production; local DevBot uses its reports token for private previews. Staging keeps suggestions off. See the site's [monitoring reference](../site/src/content/docs/deploy/monitoring.md).

## Maintenance-tool profiles

Every Discord/database maintenance tool calls `src/config/deployment.ts` before I/O. Discord tools also confirm the token's application after authentication. Publishing an import is guarded; a credential-free dry run is not. Application/guild identities live in that module.

| Profile | Discord scope | Database boundary |
| --- | --- | --- |
| `production` | Production application, managed guilds, global registration only; no test/public-response settings | Managed endpoint, verified CA, direct port 27520, user `tarubot`, database `tarubot` or `tarubot_restore` |
| `rehearsal` | Production identity, read-only Discord; no registration/cleanup | Primary ends in `_rehearsal`; restore ends in `_restore_test`; managed endpoints require CA/direct port and a non-admin user |
| `staging` | DevBot identity and test guild, guild registration only | Managed endpoint, CA/direct port; user and database exactly `tarubot_staging`; no restore target or restore-rehearsal flag |
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

Never use root `bun run` aliases or the development `.env` for production. Container tools use the unit's settings and secrets, through `tarubot-tool` on staging or `docker compose … run` on production.

## Schema and host configuration

Use [persistence](PERSISTENCE.md) for schema changes and transaction rules; never use automatic schema synchronization or Drizzle Kit push.

Compose and Quadlet keep read-only bot roots, no capabilities and no-new-privileges. Host playbooks use `ansible.builtin` only. Bot templates must render in `tests/fixtures/bot-render.ts`, which CI compares to Ansible. See [the OpenTofu runbook](../ops/tofu/README.md) for infrastructure inputs and state.
