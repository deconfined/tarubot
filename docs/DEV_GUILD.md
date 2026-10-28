# DevBot testing

Shared DevBot is not a disposable fixture. Stopping/restarting it, migrating its database, changing its settings or writing to Discord needs owner authorization; read-only inspection is allowed. Use `src/config/deployment.ts` for identity, not real IDs copied into examples or tests.

## DevBot on the staging host

DevBot runs on the staging host, from `docker-compose.staging.yml`: the explicit `staging` deployment target uses DevBot's application and declared test guild with the managed `tarubot_staging` database. The workstation copy and its local `tarubot_dev` database are retired; never start DevBot's application anywhere else. Rebuilding staging follows [staging](DEPLOYMENT.md#staging) in the deployment runbook; moving the token, changing staging's settings and every operation on its runtime remain owner steps. Staging has its own approval, activation, settings, bucket and age recipients; it never uses production credentials or global command registration.

## Update DevBot

DevBot is updated only by the owner's Deploy dispatch with `target: staging` ([staging](DEPLOYMENT.md#staging)), from a published, signed release on `main`. Deploy verifies the release as for production and points the `staging` tags of `ghcr.io/deconfined/tarubot-release` at it, with the `staging` environment's own release token; staging's Watchtower then replaces the containers. The new bot applies any pending migration after staging's own pre-migration backup, takes the writer lease and registers its commands in DevBot's guild. Agents dispatch it only when the owner asks in that session.

Afterwards, check `/version`, readiness (including the writer lease), logs, DevBot's guild command inventory and the [startup plan](#startup-test-session-plans). Owner-run inspection and tools use one-off containers of the staging manifest with staging's private settings copy ([everyday operations](DEPLOYMENT.md#everyday-operations)); obey [tool-profile guards](CONFIGURATION.md#maintenance-tool-profiles). Record human acceptance separately from automated regression.

## Local isolation

A separately owned local installation uses its own development application/token, test-guild scope and a dedicated database, never DevBot's application or production credentials.

- The `devbot` tool profile and the `docker-compose.devbot.yml` overlay remain in the source for a local `tarubot_dev` database: the overlay enforces database and guild scope, and local tools require the database URL to name `tarubot_dev`. They aren't for DevBot itself, which runs only on staging.
- Never put production credentials in the checkout's `.env`. Bun loads it automatically.
- One application runs in one place only. Fence its previous process before moving a token or starting a replacement.

For a fresh local installation, copy `.env.example`, supply your development identity and scope, and expose only loopback PostgreSQL for compiled local tools:

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres
bun run build
bun run start
```

Use a dedicated database/application; this setup is not permission to use shared DevBot or production credentials.

## Test unmerged source

Unmerged source never reaches DevBot: staging accepts only published, signed releases from `main`. In a local installation, append `-f docker-compose.build.yml` to its Compose command and use `up -d --build --wait`. This selects the local image and mounts editable test plans read-only. Do not mistake that image for a published release. Public test replies apply only in the scoped test guild and do not bypass authorization.

## Manual acceptance

The throwaway-server [allowance](CONFIGURATION.md#devbot-rehearsal-exceptions) for destructive permission/visibility rehearsal belongs to the local `devbot` profile only. Staging refuses it and requires DevBot's declared test guild, so DevBot can't use it while it runs only on the staging host. This does not authorize production onboarding.

Record manual evidence in the relevant issue/PR: release/commit, environment role, checks and results, and anything skipped/waived. Use roles, not tester names. Fixture success does not replace live acceptance.

## Startup test-session plans

With `TEST_GUILD_ID` set, each successful startup posts a plan to that guild's unique `chat` text channel. Set `TEST_PLAN_CHANNEL_ID` if ambiguous, or `TEST_PLAN_FILE` for another plan file. Inspection and registration tools never post plans.

Edit `test-plans/current.json` before an authorized session. Keep separate **You** (human commands/prerequisites), **Me** (assistant implementation/diagnosis) and **DevBot** (automatic acquisition/reconciliation/delivery) checklists. Each must fit one 1,024-character embed field; invalid plans produce a startup diagnostic. The announcement includes startup time and effect-enable state, with mentions disabled.

Published images carry the plan committed with their release, and the staging manifest mounts no plan, so a plan edit reaches DevBot only through a release the owner delivers with the staging dispatch. In a local installation, `docker-compose.build.yml` mounts editable plans read-only; changes take effect at the next startup without rebuilding. A plan grants no permission to operate shared DevBot.
