# TaruBot

A Bun/TypeScript Discord bot for Final Fantasy XIV Free Companies. It verifies character ownership through Lodestone biographies, reconciles FC access from complete roster observations, manages guest applications and nicknames, and maintains an exact, transactional gil ledger.

## Documentation

**[The documentation site](https://deconfined.github.io/tarubot/)** explains the bot and its operation:

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
| PostgreSQL (Compose/CI) | 18.6 |

Normal Compose deployments pull `ghcr.io/deconfined/tarubot`; an explicit version increase on `main` publishes tested, scanned AMD64/ARM64 images. Maintenance merges keep the bot version and existing images. Upstream production uses Docker Compose on an owner-provisioned Linode host with managed PostgreSQL; [deployment](docs/DEPLOYMENT.md) distinguishes repository delivery from owner cutover. The bot parses Lodestone in process with its own workers and follows [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors) HEAD live; see [the Lodestone adapter](docs/LODESTONE.md).

## License

First-party code is [GNU Affero General Public License v3.0](LICENSE), SPDX **AGPL-3.0-only**. `/version` provides source and license links. Third-party dependencies retain their own licenses. The dashboard, its offline page (`ops/offline`) and the documentation site bundle the Sora, Manrope and JetBrains Mono fonts (SIL OFL 1.1), and the dashboard bundles Lucide icons (ISC, with portions from Feather under the MIT License); their notices are in [the third-party licenses file](site/public/third-party-licenses.txt).
