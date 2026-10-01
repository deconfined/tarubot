# DevBot testing

Shared DevBot is not a disposable fixture. Stopping/restarting it, migrating its database, changing `.env` or writing to Discord needs owner authorization; read-only inspection is allowed. Use `src/config/deployment.ts` for identity, not real IDs copied into examples or tests.

## Local isolation

- Use the development application/token, test-guild scope and `tarubot_dev` database. The Compose overlay enforces database and guild scope; local tools also require the database URL to name `tarubot_dev`.
- Use both Compose files on **every** command. Set an explicit release tag: shared DevBot's `.env` must not be assumed to pin one.
- Never put production credentials in the checkout's `.env`. Bun loads it automatically.
- One application runs in one place only. Do not restart an old fallback VM or local bot after its token has moved to staging.

For a fresh, separately owned local installation, copy `.env.example`, supply your development identity and scope, and expose only loopback PostgreSQL for compiled local tools:

```sh
docker compose -f docker-compose.yml -f docker-compose.tools.yml up -d --wait postgres
bun run build
bun run start
```

Use a dedicated database/application; this setup is not permission to use shared DevBot or production credentials.

## Update shared local DevBot

After the owner's go-ahead:

1. Update [the startup plan](TEST_PLANS.md), read the changelog/schema changes and pull the pinned image without changing the running process.
2. Stop `tarubot` using the development overlay. Dump `tarubot_dev` into `.cache/backups/tarubot_dev-before-X.Y.Z-<sha>.dump` and restore it to `tarubot_dev_restore_test`. Follow the site's [backup procedure](../site/src/content/docs/deploy/operations.md#backup), substituting these names and Compose files.
3. Run `check-restore.js` with the deployed build or `--schema-version <old head>.sql`. Both databases still have the old schema.
4. If needed, rehearse the migration in the restore copy with the new image, then migrate DevBot while stopped. The rehearsal command derives its URL inside the container, never on the terminal:

```sh
TARUBOT_IMAGE_TAG=X.Y.Z docker compose -f docker-compose.yml -f docker-compose.devbot.yml \
  run --rm --no-deps -T tarubot \
  sh -c 'DATABASE_URL="${DATABASE_URL%/*}/tarubot_dev_restore_test" exec bun dist/scripts/migrate.js --restore-rehearsal'
```

Expect `Schema ready.`. The live migrate uses a plain `bun dist/scripts/migrate.js` in the same release image, without `--restore-rehearsal`.

5. Start the pinned release:

```sh
TARUBOT_IMAGE_TAG=X.Y.Z docker compose -f docker-compose.yml -f docker-compose.devbot.yml \
  up -d --wait --remove-orphans tarubot
```

6. Register commands in the test guild, then use `commands.js list` to compare the deployed inventory with its own declarations. Run tools inside the same pinned image using `… run --rm --no-deps -T tarubot bun dist/scripts/TOOL.js`; obey [tool-profile guards](CONFIGURATION.md#maintenance-tool-profiles).
7. Check readiness (including the writer lease), logs, schema, command scope and startup plan. Record human acceptance separately from automated regression.

## Test unmerged source

Append `-f docker-compose.build.yml` to the normal development command and use `up -d --build --wait`. This selects the local image and mounts editable test plans read-only. Do not mistake that image for a published release. Public test replies apply only in the scoped test guild and do not bypass authorization.

## Staging handover and acceptance

Staging uses `tarubot_staging`, verified TLS and the `staging` profile, with secrets in its GitHub environment. The owner must stop local DevBot before restoring equal-schema data and resetting/moving its token; see [deployment setup](DEPLOYMENT.md#first-host-setup-owner-checklist). Publication or a configure-only run does not prove the handover happened.

Use a throwaway server for destructive permission/visibility rehearsal under the local-DevBot-only [allowance](CONFIGURATION.md#devbot-rehearsal-exceptions). Remove DevBot/delete the throwaway while still scoped there, then restore the normal test-guild setting. This does not authorize production onboarding.

Record manual evidence in the relevant issue/PR: release/commit, environment role, checks and results, and anything skipped/waived. Use roles, not tester names. Fixture success does not replace live acceptance.
