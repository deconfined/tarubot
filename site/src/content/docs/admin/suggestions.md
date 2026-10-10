---
title: Feature suggestions
description: What /suggest lets members post publicly, where it works, how suggestions are moderated, and who can switch it off.
sidebar:
  order: 12
---

[`/suggest`](/tarubot/reference/commands/#suggest) lets members and guests send ideas for TaruBot. Each one is posted at once as a public issue in [TaruBot's GitHub repository](https://github.com/deconfined/tarubot/issues), with only the cleaned idea and TaruBot's version. Members' side of it is on [Suggest a feature](/tarubot/use/suggest-a-feature/).

## Where it works

`/suggest` works only in the one Free Company server the TaruBot project's own deployment serves. There is nothing to set up and no `/config` option for it. In every other server, including servers that run their own copy of TaruBot, it answers "Not available here", even for server managers. The one exception is a development deployment's test server (`TEST_GUILD_ID`): there `/suggest` previews suggestions privately into the operator's reports repository (`GITHUB_REPORTS_REPO`) when `GITHUB_REPORTS_TOKEN` is set, so testing never posts publicly ([configuration](/tarubot/deploy/configuration/#development-only)).

## Who can use it

- Holders of the server's bound **Member** or **Guest** role, read fresh from Discord each time. Officers qualify through their Member role.
- Officer access alone doesn't qualify, and neither does a server manager without either role. While no Member or Guest role is bound, nobody qualifies.

To stop one member from suggesting, take away the role that qualifies them: a Guest with [`/guest revoke`](/tarubot/reference/commands/#guest-revoke). It counts from the moment Discord removes the role, a moment after the command. A member keeps the Member role while the FC's roster lists their character.

## What goes public

Only the member's text, after TaruBot removes links, IP addresses, Discord mentions, email addresses, credential shapes and long ID numbers, and turns every `@` into `＠`, plus a fixed first line and TaruBot's version. The member's name and ID, the server, its channels and roles, characters and FC data never go public. [What goes public](/tarubot/use/suggest-a-feature/#what-goes-public) has the full list.

Cleaning can't catch a name typed out or an ID split up on purpose, and a public post stays in GitHub's notification emails, event feed and archives even after it's deleted. If members ask, tell them to leave names, personal details and security problems out.

## Limits

Each member can send one suggestion an hour and three in any 24 hours, and the deployment posts at most ten in any 24 hours, from every member together. A few accounts could use up the daily ten; the limit keeps the repository from being flooded, and the maintainers deal with abuse after posting.

## Moderation

Suggestions go up without review. TaruBot's maintainers moderate them on GitHub: they answer, label, close (for example as not planned), lock or delete issues. Officers can't remove an issue from Discord. To flag one, comment on it on GitHub or tell the maintainers.

The issue never names the member who sent it, and neither does anything else public. The deployment records privately who sent each issue, so its operator can find the sender if a suggestion needs follow-up ([monitoring](/tarubot/deploy/monitoring/#public-suggestions)).

## The off switch

Only the deployment's operator can switch `/suggest` off, by emptying one of its GitHub App settings and recreating the bot's container ([configuration](/tarubot/deploy/configuration/#upstream-production-only)). While it's off, members get "Not available here", saying suggestions are switched off. Nothing needs undoing afterwards: switching it back on restores the command as it was.
