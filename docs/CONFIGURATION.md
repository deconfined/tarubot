# Configuration and tool boundaries

Runtime settings, defaults and ranges are documented once on the site's [configuration page](../site/src/content/docs/deploy/configuration.md). `.env.example` is the local template; `src/config/env.ts` validates it. This reference covers implementation and deployment-specific guards.

## Build configuration

| File | Responsibility |
| --- | --- |
| `package.json` | ESM boundary, Bun pin, version and scripts; `build` compiles bot and one-shot tools |
| `bun.lock` | Generated dependency/source pins; selector commit must match `upstream-revisions.json` |
| `tsconfig.json` | Strict NodeNext ESM, explicit `.js` imports, bigint-safe modern output, checked optional/indexed values |
| `tsconfig.build.json` | Application/tool output under `dist/`, including imported JSON; tests are checked separately |
| `biome.json` | Two-space formatting, explicit types and no CommonJS; excludes generated/private inputs |
| `site/package.json` | Separate pnpm/Node pins; do not run the site through root Bun scripts |

`bun run build` removes stale generated modules. Rebuild after source changes before using `bun dist/scripts/TOOL.js` or its script alias. `/version` reads the build-local manifest. Scripts and formats that support comments document their inputs inline; strict JSON uses this reference.

## Secrets from files

`src/config/secrets.ts` resolves `DATABASE_URL`, `DATABASE_CA_CERT`, `DISCORD_TOKEN`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_REPORTS_TOKEN` and `HEALTHCHECKS_PING_URL` from either `NAME` or `NAME_FILE`:

- An unset/empty file setting uses the plain value.
- A file setting reads UTF-8 text and removes exactly one final newline. Setting both forms is a configuration error.
- Unreadable files name the setting only, never the path or value.
- Resolution returns a new object; it never writes `process.env`. All bot/tool readers and report redaction use the resolved values.

Production and staging require a non-empty resolved database CA. Connections verify the certificate and hostname even when URL SSL flags would weaken verification. `RESTORE_DATABASE_URL` and `RESTORE_DATABASE_CA_CERT` have no file forms; an empty restore CA reuses the resolved primary CA.

Staging's release playbook writes secrets to Podman's store over stdin. The unit mounts them read-only at `/run/secrets/` and writes only the corresponding `NAME_FILE` paths into its settings file. Compose deployments still use plain variables. Never log a secret, pass it in argv or read one of these settings directly from `process.env` outside the resolver.

## Staging settings

There is no staging `.env`. `ops/ansible/bot.yml` combines:

1. Plain settings from the release's `vars/bot.yml` and `vars/targets/staging.yml`.
2. Application and guild identity reported by that image's own `resolveDeployment`, without credentials or network access.
3. Runtime and backup secrets from the `staging` GitHub environment. The reports token is named `REPORTS_GITHUB_TOKEN` there and mapped to `GITHUB_REPORTS_TOKEN`; GitHub disallows secret names starting with `GITHUB_`. The same convention reserves `SUGGEST_APP_PRIVATE_KEY` for the public-suggestion key.

Target files declare required secret names and database identity. Missing/malformed secrets are refused before host writes. Single-line values must contain no whitespace; only PEM values may span lines. Optional tunables use the bot's defaults. See [deployment](DEPLOYMENT.md) and [host operations](HOSTING.md).

Private issue reports may not target the public repository. Public-suggestion app credentials belong only to production; local DevBot uses its reports token for private previews. Staging keeps suggestions off. See the site's [monitoring reference](../site/src/content/docs/deploy/monitoring.md).

## Maintenance-tool profiles

`src/config/deployment.ts` is the identity guard every Discord/database maintenance tool calls after argument parsing and before I/O. Publishing an import is guarded; a credential-free import dry run is not. After authentication, Discord tools confirm the token's application. Application/guild IDs are defined in that module, not copied into this guide.

| Profile | Discord scope | Database boundary |
| --- | --- | --- |
| `production` | Production application, managed guilds, global registration only; no test/public-response settings | Managed endpoint, verified CA, direct port 27520, user `tarubot`, database `tarubot` or `tarubot_restore` |
| `rehearsal` | Production identity, read-only Discord; no registration/cleanup | Primary ends in `_rehearsal`; restore ends in `_restore_test`; managed endpoints require CA/direct port and a non-admin user |
| `staging` | DevBot identity and test guild, guild registration only | Managed endpoint, CA/direct port; user and database exactly `tarubot_staging`; no restore target or restore-rehearsal flag |
| `devbot` | DevBot identity and test guild, never global registration | Local endpoint, empty CA, primary `tarubot_dev`; restore ends in `_restore_test` |
| `unmanaged` | Other developers/CI; may not use managed identities or guilds | No deployment-specific database rules |

Select managed profiles explicitly with `TARUBOT_ENVIRONMENT`. An empty marker can infer local DevBot from its application, never production; staging requires its marker despite sharing DevBot's application. Production/rehearsal reject staging database/user names. URLs must carry host, port, user and database themselves: libpq identity overrides in query parameters are refused. A restore target must differ from the primary.

### DevBot rehearsal exceptions

- Only local DevBot's `migrate.js --restore-rehearsal` may use a `*_restore_test` primary, to rehearse a migration before touching `tarubot_dev`.
- An explicit per-tool-run `DEVBOT_THROWAWAY_GUILD_ID` must equal `TEST_GUILD_ID` and name no managed guild. It **replaces**, not widens, the DevBot guild/registration scope. Other profiles refuse it; runtime and templates never read it. Use `commands.js list --guild <throwaway id>` because a full inventory will also find the normal test guild's commands.

Shared DevBot updates, `.env` changes and throwaway-server rehearsals are owner-authorized work. See [DevBot](DEV_GUILD.md).

### Launch isolation

Bun loads `.env` automatically, and a `bun run` script child reloads it even when the parent used `--env-file`. Existing shell exports also override file values. Production, rehearsal and staging tools refuse an auto-loaded env file without an explicit `--env-file`.

For an owner-run tool outside containers, use a clean clone of the deployed release and a complete, mode-600 copy of `production.env.example` outside the checkout:

```sh
env -i HOME="$HOME" PATH="$PATH" bun --env-file=PATH dist/scripts/TOOL.js
```

Never use root `bun run` aliases or the development `.env` for production. Container tools use the unit's settings and secrets, through `tarubot-tool` on staging or `docker compose … run` on production.

## Schema and host configuration

Numbered migrations are authoritative; `SCHEMA_VERSION` in `database.ts` identifies the required head. There is no automatic schema synchronization or Drizzle Kit push. See [persistence](PERSISTENCE.md) for mappings, transactions and migration checks.

Compose and Quadlet keep read-only bot roots, no capabilities and no-new-privileges. `site.yml` configures the host from reviewed `main`; `bot.yml` deploys the release's unit. Templates must stay in the subset rendered by `tests/fixtures/bot-render.ts`, which CI compares to Ansible. Host playbooks use `ansible.builtin` only. Infrastructure inputs, state and provider pins are documented in [the OpenTofu runbook](../ops/tofu/README.md).
