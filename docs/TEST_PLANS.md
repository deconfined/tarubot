# Startup test-session plans

With `TEST_GUILD_ID` set, each successful bot startup posts a test plan to that guild's unique `chat` text channel. Set `TEST_PLAN_CHANNEL_ID` if the channel is ambiguous, or `TEST_PLAN_FILE` to use another plan file.

The message separates actions into three sections:

- **You**: human actions in Discord, including exact commands and prerequisites.
- **Me**: implementation, diagnosis and follow-up verification by the coding assistant.
- **DevBot**: automatic acquisition, reconciliation, and delivery work.

Edit `test-plans/current.json` before a new session. Each checklist must fit one 1,024-character embed field; invalid plans produce a startup diagnostic. The announcement includes the startup time and effect-enable state, with mentions disabled.

`docker-compose.build.yml` mounts editable plans read-only; changes take effect at the next startup without rebuilding code. Combine it with `docker-compose.devbot.yml` for the isolated database. Published images carry their own default plan.

Inspection and registration tools do not post session plans. A plan grants no permission to use shared DevBot; follow [the testing procedure](DEV_GUILD.md).
