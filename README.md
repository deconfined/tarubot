# TaruBot

A Bun/TypeScript Discord bot for Final Fantasy XIV Free Companies. It verifies character ownership through Lodestone biographies, reconciles FC access from complete roster observations, manages guest applications and nicknames, and maintains an exact, transactional gil ledger.

## Documentation

**[The documentation site](https://deconfined.github.io/tarubot/)** describes the latest release on `main`:

- [Use TaruBot](https://deconfined.github.io/tarubot/use/getting-started/): members and visitors.
- [Run a server](https://deconfined.github.io/tarubot/admin/add-to-server/): officers and server managers.
- [Deploy and operate](https://deconfined.github.io/tarubot/deploy/requirements/): self-hosters.
- [Architecture](https://deconfined.github.io/tarubot/architecture/overview/) and [reference](https://deconfined.github.io/tarubot/reference/commands/): design, commands and reply codes.

For development, start with **[CONTRIBUTING.md](CONTRIBUTING.md)**. Focused engineering references and maintainer runbooks are in the [internal documentation index](docs/README.md).

## Stack

| Component | Pinned version |
| --- | --- |
| Bun | 1.4.2 |
| TypeScript | 7.0.2 |
| Discord.js | 14.27.0 |
| Drizzle ORM / node-postgres | 0.45.3 / 8.23.0 |
| PostgreSQL | 18.4 |

Normal Compose deployments pull `ghcr.io/deconfined/tarubot`; merges to `main` publish tested AMD64/ARM64 images. The bot parses Lodestone in process with its own workers and follows [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) HEAD live. See [CI/CD](docs/CI_CD.md) and [the Lodestone adapter](docs/LODESTONE.md).

## License

First-party code is [GNU Affero General Public License v3.0](LICENSE), SPDX **AGPL-3.0-only**. `/version` provides source and license links. Third-party dependencies retain their own licenses.
