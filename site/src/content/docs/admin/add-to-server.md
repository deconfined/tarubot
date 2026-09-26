---
title: Add TaruBot to a server
description: Who adds TaruBot to a server, the permissions it needs and why, and where its role must sit.
sidebar:
  order: 1
---

These pages are for the officers and managers of a Discord server that uses TaruBot.

## Adding the bot

Every TaruBot deployment runs its own Discord application, and the application's owner adds the bot to a server. If you run TaruBot yourself, [create the application](/tarubot/deploy/discord-application/) first.

The owner adds it with the two scopes TaruBot needs, `bot` and `applications.commands`, and the [permissions](#permissions) below, and needs **Manage Server** in that server. With **Public Bot** off, as recommended, nobody else can add the bot: if someone else runs your deployment, ask them to add it. The application also needs the **Server Members Intent**, which the owner switches on once in the Discord Developer Portal.

## Gateway intents

| Intent | Why TaruBot needs it |
| --- | --- |
| `Guilds` | Receive server, role and channel updates, and keep the server context that commands and managed-role checks use. |
| `GuildMembers`: **Server Members Intent** (privileged) | Read the complete member list, and see joins, departures, role changes and nickname changes, so roles and nicknames stay correct. |

## Permissions

Grant these at the server level. In each channel TaruBot posts to, it also needs View Channel, Send Messages, Embed Links and Read Message History.

| Permission | Why TaruBot needs it |
| --- | --- |
| **Manage Roles** | Give and remove the Member, Guest, Officer and FC Leader roles; manage channel permission overwrites and, once onboarding is on, the server's default View Channel. |
| **Manage Channels** | Only for [`/setup`](/tarubot/admin/setup/)'s lobby onboarding: create or reuse the lobby and officer room, and keep channel visibility in line. Without onboarding you can leave it out. |
| **Manage Nicknames** | Set and restore character-based nicknames for members who turn nickname sync on. |
| **View Channel** | See the ledger, officer notification, guest review and changelog channels. |
| **Send Messages** | Post ledger entries, officer notices, member status posts, guest review messages and update posts. |
| **Embed Links** | Ledger posts, guest review messages, member status posts (officer notifications channel), update posts and `/version` are embeds. |
| **Attach Files** | Deliver an officer's **Full details (JSON)** file, and keep explicit access in onboarding's managed rooms. |
| **Read Message History** | TaruBot checks for it, with View Channel, Send Messages and Embed Links, before it posts in a channel, and redrawing a guest review message fetches the earlier one. |

Leave **Administrator** off. TaruBot needs only the permissions above, and a bot with Administrator can see and change everything in the server.

## Role order

Discord only lets a bot manage roles below its own highest role, and nicknames of members whose highest role is below it. After adding TaruBot:

1. In **Server Settings → Roles**, drag TaruBot's role above the four roles it will manage, and above the members whose nicknames it will manage.
2. The access roles (Member, Guest, Officer, FC Leader) must be distinct, ordinary roles without Administrator, Manage Server or Manage Roles. With onboarding on, they must not have Manage Channels either.
3. Give TaruBot's role View Channel, and make sure it can see and manage every channel onboarding will secure. Onboarding stops at a channel TaruBot can't see, naming it, until TaruBot can see and manage it.

Discord's configured community-updates channel and its category are left out of onboarding and its permission checks, so TaruBot doesn't need to see them. From 16 November 2026, if it can't, it leaves the server's @everyone View Channel default as it is; see [Community resources outside onboarding](/tarubot/admin/setup/#community-resources-outside-onboarding).

TaruBot can't change the server owner's nickname: Discord doesn't allow any bot to.

## Next steps

1. Decide how officers are recognized: read [Who can do what](/tarubot/admin/access/).
2. Set the server up, with [`/setup`](/tarubot/admin/setup/) or individual `/config` commands.
3. Run [`/config validate`](/tarubot/admin/health-checks/) until it reports no problems.
