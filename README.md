# TaruBot

A Bun/TypeScript Discord bot for Final Fantasy XIV Free Companies. It verifies character ownership through Lodestone biographies, reconciles FC access from complete roster observations, manages guest applications and nicknames, and maintains an exact, transactional gil ledger.

## Documentation

**The documentation site is <https://deconfined.github.io/tarubot/>.** It describes the latest release on `main`:

- [Use TaruBot](https://deconfined.github.io/tarubot/use/getting-started/): for members and visitors.
- [Run a server](https://deconfined.github.io/tarubot/admin/add-to-server/): for officers and server managers, including adding the bot and the permissions it needs.
- [Deploy and operate](https://deconfined.github.io/tarubot/deploy/requirements/): for self-hosters, from requirements and installation to updates, backups and monitoring.
- [Architecture and design](https://deconfined.github.io/tarubot/architecture/overview/): how the bot is built and why.
- [Reference](https://deconfined.github.io/tarubot/reference/commands/): every command and option, and every reply code.

The site's source is [`site/`](site/), a small Astro Starlight package built with pnpm; its pages are in `site/src/content/docs/`. Build it with `cd site && pnpm install --frozen-lockfile && pnpm run build`.

Contributor detail lives in `docs/`: [MODULES](docs/MODULES.md), [PERSISTENCE](docs/PERSISTENCE.md), [LODESTONE](docs/LODESTONE.md), [CONFIGURATION](docs/CONFIGURATION.md), [CI_CD](docs/CI_CD.md), [REPLIES](docs/REPLIES.md) and [TEST_PLANS](docs/TEST_PLANS.md).

Maintainer records live in `docs/` too; start with [SESSION_HANDOFF.md](docs/SESSION_HANDOFF.md). Every coherent change set increments SemVer and updates [CHANGELOG.md](CHANGELOG.md).

## Stack

| Component | Pinned version |
| --- | --- |
| Bun | 1.4.2 |
| TypeScript | 7.0.2 |
| Discord.js | 14.27.0 |
| Drizzle ORM / node-postgres | 0.45.3 / 8.23.0 |
| PostgreSQL | 18.4 |

The normal Compose services are `tarubot` and `postgres`, and deployments pull **`ghcr.io/deconfined/tarubot`**. Merges to `main` publish tested AMD64/ARM64 images; see [CI_CD.md](docs/CI_CD.md). The bot reads the Lodestone in process: TaruBot's own parser applies [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) in isolated workers and follows the selectors' upstream HEAD live. See [the Lodestone adapter](docs/LODESTONE.md).

The bot checks the selector repository every 15 minutes and activates a new HEAD by itself; `/health/ready` and its logs show the live revision. To refresh the set bundled with a release as the fallback:

```sh
bun run selectors:check
bun run selectors:update
```

Merge the update PR and pull its published image.

## Development install and check

Clone the repository, then run these commands from this directory:

```sh
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run lint
bun run format:check
bun run test:unit
bun run test:contract
bun run test:docker
```

`test:docker` creates a uniquely named disposable PostgreSQL project, copies the selected SQL fixture into an ephemeral test container, runs the full test suite, and removes its test containers and volume. Its default is the locally supplied `tarubot_backup.sql`. CI instead generates synthetic input with `bun run test:fixture` and selects it through `LEGACY_FIXTURE_PATH=.cache/ci/legacy.sql`. Container images exclude SQL inputs, local environment files, repository metadata, caches, and import reports.

For an existing **disposable** test database whose name ends in `_test`:

```sh
TEST_DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/tarubot_test bun run test:integration
```

The integration suite recreates that test database's `public` schema. Tests use controlled Discord/Lodestone fixtures and real PostgreSQL; live Discord acceptance is described in [VERIFICATION.md](docs/VERIFICATION.md).

## Running the compiled bot locally

To run the compiled bot or one-shot tools locally (development only), publish loopback-only dependency ports explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres
bun run build
bun run start
```

The normal Compose configuration keeps dependency ports private. Use a separate database and development application for test-guild work. Bun loads this directory's `.env` for every `bun` command, including `bun run` script children.

The one-shot tools run from the compiled output too, so run `bun run build` after every source change. Their `bun run` aliases:

| Script | Tool |
| --- | --- |
| `bun run db:migrate` | `migrate.js`: apply pending migrations |
| `bun run commands:register --global` or `--guild ID` | `register.js`: register the slash commands in one scope |
| `bun run commands:list` | `commands.js list`: read back every command scope |
| `bun run commands:clear-guild GUILD_ID --application APP_ID` | `commands.js clear-guild`: remove one server's leftover commands, dry run first |
| `bun run preview GUILD_ID` | `preview.js`: read-only role and nickname preview |
| `bun run jobs:retry GUILD_ID JOB_ID` | `retry.js`: requeue failed or blocked delivery |

Tools without an alias, such as `check-restore.js`, run as `bun dist/scripts/NAME.js`. The [maintenance tools page](https://deconfined.github.io/tarubot/deploy/tools/) explains each tool, and [CONFIGURATION.md](docs/CONFIGURATION.md#maintenance-tool-profiles) the deployment guard every tool applies first.

## License

TaruBot's first-party code is licensed under the [GNU Affero General Public License v3.0](LICENSE), SPDX **AGPL-3.0-only**. `/version` provides source-code and license links. Third-party dependencies, including the `lodestone-css-selectors` data the parser applies, retain their own licenses.
