---
title: Add TaruBot to a server
description: Who adds TaruBot, the one permission set it needs and why, the short Administrator window for /setup overrides, and what to check and remove afterwards.
sidebar:
  order: 1
---

These pages are for the officers and managers of a Discord server that uses TaruBot.

:::danger[Administrator is temporary: only for the `/setup overrides` window]
TaruBot runs **without Administrator**. Give it Administrator only for a short setup window, so that [`/setup overrides`](#the-setup-window) can add TaruBot's own entry to your channels, and **take it away again as soon as `/config validate` says "Administrator: no longer needed"**:

1. Turn **Administrator** on for TaruBot's role.
2. Set every channel setting you'll use with `/config` (the ledger, officer notifications, update posts and the guest review channel) while Administrator is on.
3. Run the `/setup overrides` dry run, and fix any private category it names.
4. Run `/setup overrides confirm:true`.
5. Run `/config validate` until it says Administrator is no longer needed.
6. **Remove Administrator at once**, exactly as `/config validate` says: turn it off on TaruBot's own role, and take any other role that gives it away from TaruBot.

**Don't remove it before step 5.** Until TaruBot's own entries are in place, taking Administrator away hides the channels you configured from it: ledger posts, officer notices, update posts and guest reviews stop until they're back.

Leave Administrator off except during `/setup overrides` (or, on a server with lobby onboarding, until onboarding's first channel pass has run). A bot with Administrator can see and change everything in the server.
:::

## Adding the bot

Every TaruBot deployment runs its own Discord application, and the application's owner adds the bot to a server. If you run TaruBot yourself, [create the application](/tarubot/deploy/discord-application/) first.

The owner adds it with the two scopes TaruBot needs, `bot` and `applications.commands`, and the one recommended permission set, **105630518288**: the twelve [permissions](#permissions) below. Adding a bot needs **Manage Server** in that server. With **Public Bot** off, as recommended, nobody else can add the bot: if someone else runs your deployment, ask them to add it. The application also needs the **Server Members Intent**, which the owner switches on once in the Discord Developer Portal.

Don't include Administrator when you add the bot. You turn it on by hand on TaruBot's role for the [setup window](#the-setup-window), and off again afterwards.

## Gateway intents

| Intent | Why TaruBot needs it |
| --- | --- |
| `Guilds` | Receive server, role and channel updates, and keep the server context that commands and managed-role checks use. |
| `GuildMembers`: **Server Members Intent** (privileged) | Read the complete member list, and see joins, departures, role changes and nickname changes, so roles and nicknames stay correct. |

TaruBot asks Discord for these two intents and no others. It never asks for the message intents, Message Content or Presence, so Discord sends it no message events and nobody's message text, in any channel or direct message. Commands, buttons and forms reach it as interactions, and the only messages it reads are its own posts, such as a guest review message it redraws. Leave **Presence Intent** and **Message Content Intent** off in the Developer Portal.

## Permissions

Grant these twelve on TaruBot's own role, at the server level. Together they are the permission integer **105630518288**. The first seven are what TaruBot uses in every server. The last five are lobby onboarding's ([`/setup onboarding`](/tarubot/admin/setup/#all-at-once-with-setup-onboarding)); they're part of the one recommended set, so a server can turn onboarding on later without adding the bot again.

| Permission | Why TaruBot needs it |
| --- | --- |
| **Manage Roles** | Give and remove the Member, Guest, Officer and FC Leader roles. In a channel, Discord calls it Manage Permissions: `/setup overrides` needs it to write TaruBot's own entry, and onboarding to write channel overwrites and the server's default View Channel. |
| **Manage Nicknames** | Set and restore character-based nicknames for members who turn nickname sync on. |
| **View Channel** | See the server's channels, including the ledger, officer notification, guest review and changelog channels, and appear in their member lists. |
| **Send Messages** | Post ledger entries, officer notices, member status posts, guest review messages and update posts. |
| **Embed Links** | Ledger posts, guest review messages, member status posts (officer notifications channel), update posts and `/version` are embeds. |
| **Attach Files** | Deliver an officer's **Full details (JSON)** file, and keep explicit access in onboarding's managed rooms. |
| **Read Message History** | TaruBot checks for it, with View Channel, Send Messages and Embed Links, before it posts in a channel, and redrawing a guest review message fetches the earlier one. |
| **Manage Channels** | Onboarding: create or reuse the lobby and officer room, and keep channel visibility in line. |
| **Use Application Commands** | Onboarding: the lobby's overwrites let newcomers use commands there, and Discord lets a bot allow or deny only a permission it holds itself. |
| **Create Public Threads** | Onboarding: the lobby's overwrites keep newcomers from creating threads there, for the same reason. |
| **Create Private Threads** | Onboarding: as Create Public Threads. |
| **Connect** | Onboarding: managing the overwrites of voice and stage channels needs it. |

In every channel TaruBot posts to (the ledger, officer notifications, update posts and guest reviews) it needs all four of **View Channel**, **Send Messages**, **Embed Links** and **Read Message History**. `/config` refuses a channel that lacks any of them, and `/config validate` checks them again.

## Right after adding the bot

1. **Role order.** Discord only lets a bot manage roles below its own highest role, and nicknames of members whose highest role is below it. In **Server Settings → Roles**, drag TaruBot's role above the four roles it will manage, and above the members whose nicknames it will manage.
2. **Only TaruBot's own role gives it permissions.** Keep the twelve on TaruBot's own role, and don't give TaruBot another role that adds permissions. `/config validate` warns when one of the first seven comes only from @everyone or from another role, since a change to that role would take it away, and it lists any permission TaruBot never needs (Manage Server, Manage Messages, Mention Everyone, Kick Members, Ban Members, Time Out Members and Manage Webhooks) with the roles that give it.
3. **Two-factor authentication.** If the server requires two-factor authentication for moderation, Discord lets a bot use Manage Roles, Manage Channels and Administrator there only while the account that owns the bot's application has two-factor authentication turned on. Without it, TaruBot's role and channel changes are refused.
4. **The application's intents.** In the Developer Portal, **Server Members Intent** on, **Presence Intent** and **Message Content Intent** off.
5. **Access roles.** The access roles (Member, Guest, Officer, FC Leader) must be distinct, ordinary roles without Administrator, Manage Server or Manage Roles. With onboarding on, they must not have Manage Channels either.

Discord's configured community-updates channel and its category are left out of onboarding and its permission checks, so TaruBot doesn't need to see them. From 16 November 2026, if it can't, it leaves the server's @everyone View Channel default as it is; see [Community resources outside onboarding](/tarubot/admin/setup/#community-resources-outside-onboarding).

TaruBot can't change the server owner's nickname: Discord doesn't allow any bot to.

:::caution[Two settings to decide on purpose]
**Binding a Member or Guest role that people already hold removes it straight away from everyone TaruBot can't match.** Once a role is bound, TaruBot gives and removes it itself: Member only to people with a linked character in the FC, Guest only to people with a linked character or a guest grant. Link the FC and let members link their characters, and record [guest grants](/tarubot/admin/guest-applications/) for the guests you want to keep, before you bind a role in use.

**The role layout is off for new servers.** TaruBot leaves your roles' display and order alone unless you ask. Turning it on with [`/config role_layout enabled:true`](/tarubot/reference/commands/#config-role_layout) moves the four roles into one block and shows them separately in the member list at once. See [Role layout](/tarubot/admin/roles/#role-layout).
:::

## The setup window

Without Administrator, TaruBot sees a channel only when a permission entry lets it, just like a member. Most servers have private channels and categories that deny @everyone View Channel, so TaruBot can't see them, including channels you choose for its settings. [`/setup overrides`](/tarubot/reference/commands/#setup-overrides) gives TaruBot its own member entry in each channel it couldn't otherwise see, or couldn't post in where a setting names the channel, so it keeps seeing them once Administrator is off. Channels it already sees, such as public ones, are left as they are. Discord lets a bot write such an entry only for permissions it holds in that channel, which is why TaruBot needs Administrator while the step runs.

If `/config validate` already shows `[OK] TaruBot can see every channel` and `[OK] Administrator: off`, your server needs no window.

**Before the window.** Set TaruBot up with `/config` or [`/setup onboarding`](/tarubot/admin/setup/) first: `/setup overrides` refuses a server with no TaruBot configuration. With lobby onboarding, turn Administrator on before `/setup onboarding confirm:true` instead (see the last paragraph of this section). Choose every channel setting you'll use while Administrator is on, because `/setup overrides` treats every channel that no setting names as one TaruBot only needs to see.

**The dry run.** `/setup overrides` without `confirm:true` changes nothing and works whether or not TaruBot holds Administrator, but it can plan the channels TaruBot can't see yet only while TaruBot holds Administrator. It lists the entries it would add, grouped by what they allow and deny; channels that stop being synced with their category; channels hidden from TaruBot on purpose; configured channels that deny TaruBot; private categories you must fix; and permissions to give TaruBot's role before Administrator comes off.

**The real run.** `/setup overrides confirm:true` needs Administrator on TaruBot, and the person running it needs Administrator too, or must own the server. It writes only TaruBot's own member entry, never another role's or member's, and only where TaruBot couldn't see the channel without Administrator (or, in a channel a setting names, couldn't post there):

- **A channel a setting names** gets whatever it lacks of View Channel, Send Messages, Embed Links and Read Message History. A Read Message History deny on TaruBot's own entry there is lifted.
- **Any other channel TaruBot can't see without Administrator** gets View Channel, with Read Message History, Manage Permissions, Manage Channels and Create Invite denied, and Connect too in voice and stage channels and categories. TaruBot appears in the member list there but can't read the channel's history.
- **Categories TaruBot can't see** get the same entry, and channels synced with a category copy its entry, so they stay synced. A channel a setting names inside a visible category gets its own entry and stops being synced; the reply lists it.

Channels TaruBot already sees, such as public ones, are left alone and keep what its role allows, Read Message History included.

A run stops after 10 minutes, at a restart, or when something it depends on changes. Run it again: it continues where it stopped. A channel Discord refuses is listed under "Not changed" and stays in `/config validate`'s list.

**Hidden on purpose.** A View Channel deny on TaruBot's own entry or its own role wins: TaruBot never overwrites it. A channel no setting names is reported as hidden on purpose and left alone. A channel a setting names is reported as denied to TaruBot; lift the deny or choose another channel. A deny on a category reaches only the channels synced with it, and Discord shows a bot a category once it can see any channel inside. So a channel in a category hidden from TaruBot that has no entry of its own for TaruBot or its role counts as hidden on purpose too, and is left alone unless a setting names it; `/config validate` counts those apart.

From 16 November 2026, Discord hides a channel's details from a bot that can't see it, so TaruBot goes by what the last `/setup overrides confirm:true` recorded. A channel you hide from TaruBot after that run looks missing, and one whose deny you remove while TaruBot still can't see it still looks hidden on purpose (or denied to TaruBot, if a setting names it). Either way, run the window again after changing such a deny. A channel you create later inside a category hidden from TaruBot on purpose changes no deny: Discord copies the category's permissions into it, so it stays hidden on purpose (unless a setting names it) and needs no window.

**Private categories are yours to fix.** A private category TaruBot can't see that holds a configured channel, such as the ledger inside a staff category, is left alone with everything in it. Writing the category would decide what TaruBot may do in its other channels, and writing only the configured channel would break its sync, so TaruBot does neither. The dry run, the run's reply and `/config validate` name the category. Fix it one of three ways, then run `/setup overrides` again:

- move the configured channel out of the category;
- choose another channel for that setting; or
- give TaruBot View Channel on the category yourself, and decide what its other channels allow.

Until you do, Administrator stays needed.

**After the window.** A channel you choose for a setting later, where TaruBot's entry already denies Read Message History, is refused: TaruBot's own entry blocks it, and no role permission can lift a member entry's deny. Either remove that deny from TaruBot's own entry in the channel's permissions (the member, not its role), or turn Administrator on for TaruBot, set the channel with `/config`, run `/setup overrides confirm:true` again, and take Administrator away once `/config validate` says so. A private channel created later needs the same round trip, unless it sits inside a category hidden from TaruBot on purpose, where it stays hidden on purpose. Until then `/config validate` lists it, and TaruBot posts [one alert](/tarubot/admin/notices-and-updates/#missing-channel-overrides) in the officer notifications channel.

**With lobby onboarding** TaruBot doesn't need `/setup overrides`: onboarding's own channel pass gives it access in every channel it manages, and `/setup overrides` answers that onboarding manages them. That pass is the window instead: turn Administrator on before it, or it stops at every channel TaruBot can't see, and keep it until [`/sync status`](/tarubot/reference/commands/#sync-status) shows that pass finished and `/config validate` says Administrator is no longer needed. If you ran `/setup overrides` before turning onboarding on, the entries it wrote deny Manage Permissions and Manage Channels, which stop onboarding's pass without Administrator; its first pass with Administrator lifts those denies, and until then `/config validate` counts those channels as not yet reached.

## What can come off afterwards, and what never does

You can remove:

- **TaruBot's Administrator**, as soon as `/config validate` says it is no longer needed.
- **Permissions TaruBot never needs**, which `/config validate` lists.
- **Your own Administrator, Manage Server or Manage Roles**, if you were given them only to set TaruBot up. Managers need Manage Server and Manage Roles again to rebind a role, change an officer override or switch the role layout.

Never remove:

- **The first seven permissions** on TaruBot's own role.
- **TaruBot's own entries in your channels.** Without Administrator they are how it sees the server and appears in member lists.
- **Onboarding's five**, on a server with lobby onboarding. A server that never turns onboarding on doesn't use them, and `/config validate` checks them only where it's on.

## Next steps

1. Decide how officers are recognized: read [Who can do what](/tarubot/admin/access/).
2. Set the server up, with individual `/config` commands or [`/setup onboarding`](/tarubot/admin/setup/).
3. If TaruBot can't see every channel without Administrator, run the [setup window](#the-setup-window).
4. Run [`/config validate`](/tarubot/admin/health-checks/) until it reports no problems.
