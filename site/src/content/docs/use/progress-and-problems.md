---
title: Progress and problems
description: Check background work, refresh your roles, and report a problem.
sidebar:
  order: 7
---

## Check on background work

Changing a role, setting a nickname or posting a ledger entry happens in the background, a moment after your command. [`/sync status`](/tarubot/reference/commands/#sync-status) shows that work for you: your refresh requests and the role, nickname and message work queued for you, each with a [status marker](/tarubot/reference/replies/#status-markers).

- `… QUEUED` and `… IN PROGRESS`: it's on its way.
- `↻ WAITING`: it's waiting its turn or retrying after a temporary problem, and the line says when.
- `! BLOCKED`: an officer needs to fix a permission or setting.
- `‖ PAUSED`: Discord changes are paused on this server or deployment; the work runs once they're back on.
- `✗ FAILED`: it stopped and won't retry. Tell an officer.

## Refresh your roles

TaruBot checks the FC's roster on a schedule, and rechecks roles whenever something changes. If your roles look wrong, run [`/refresh`](/tarubot/reference/commands/#refresh):

- when the last roster is older than the refresh interval, TaruBot reads a new one from the Lodestone, then rechecks everyone's roles;
- when the roster is recent, it rechecks roles against the roster it has.

The reply gives a run ID. Follow it with `/sync status run_id:<the ID>`. Officers can add `force:true` to read the roster even when it's recent. Refreshes are rate-limited, so running `/refresh` repeatedly doesn't make it faster.

## Other utilities

- [`/version`](/tarubot/reference/commands/#version) shows the version this server runs, links to its source code and license, and the most recent commits on GitHub (five by default, up to ten).
- [`/ping`](/tarubot/reference/commands/#ping) shows Discord's gateway latency, a quick check that the bot is alive.
- [`/channel`](/tarubot/reference/commands/#channel) shows the current channel's ID, name and type (only the ID in a channel TaruBot can't see), handy when an officer asks for a channel ID.
- [`/suggest`](/tarubot/reference/commands/#suggest) sends an idea for TaruBot to its public GitHub repository, from the FC's own server. See [Suggest a feature](/tarubot/use/suggest-a-feature/).

## Report a problem

When something doesn't work the way it should, use [`/issue`](/tarubot/reference/commands/#issue) to tell the people who run this TaruBot deployment:

```text
/issue description:My Member role disappeared after I ran /main this morning.
```

- Describe what went wrong and what you expected, in 10 to 1,000 characters.
- One report per member every 10 minutes, and 20 per server a day. A refusal says when you can send the next one.
- The reply lists what the report carries: your description, your Discord username and ID, your linked characters and settings in this server, your recent TaruBot activity, and the bot's health and recent logs. Tokens, passwords and other secrets are removed first.

If the deployment hasn't connected issue reporting yet, the reply says the report was saved; it's sent once reporting is connected.

TaruBot also reports unexpected errors and failed background work by itself, so you don't need to report an error that says "Something went wrong" unless you have something to add.

## Share a Ref

Every refusal or error ends with `Code <code> · Ref <number>`. When you ask an officer for help, or mention an error in `/issue`, include that line or a screenshot of the card. The Ref is the ID of your command, and it leads straight to the matching entry in the bot's log.
