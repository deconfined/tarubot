---
title: Setting up a server
description: Set a server up step by step with /config, or with /setup onboarding and lobby onboarding, then give TaruBot its own channel access with /setup overrides.
sidebar:
  order: 3
---

:::caution[`/setup onboarding confirm:true` can't be undone by command]
Running `/setup onboarding confirm:true` turns on **lobby onboarding**: from then on TaruBot controls who can see which channel (View Channel) in the channels it manages. It also opens guest applications (`/apply`) and gives officer access to everyone who already holds the Officer role it adopts.

No command turns onboarding off again. Reverting it means restoring channel permissions by hand and changing the database, which only the deployment's operator can do. If you only want roles, nicknames and the ledger, set the server up with `/config` instead (below), and leave onboarding for later. Without `confirm:true`, `/setup onboarding` is a dry run that changes nothing, so you can always look first.
:::

There are two ways to set a server up:

- **Step by step with `/config`.** Link the FC, choose the roles and channels. Channel visibility stays yours; TaruBot only manages its roles, nicknames and posts. This suits a server whose channels are already arranged.
- **All at once with `/setup onboarding`.** TaruBot creates or reuses the four roles, a lobby and an officer room, and takes over channel visibility, so newcomers see only the lobby until they link a character or are approved.

Either way, the server goes live with its first `/config` change or `/setup onboarding confirm:true`: there is no separate activation step. A server first set up either way starts with the [role layout](/tarubot/admin/roles/#role-layout) off.

Without onboarding, TaruBot sees your private channels only while it holds Administrator. Once the server is set up, give it its own channel access with [`/setup overrides`](/tarubot/admin/add-to-server/#the-setup-window), then take Administrator away as soon as `/config validate` says it's no longer needed.

## Step by step with `/config`

Run these as an officer (the role commands have their own requirements; see [Who can do what](/tarubot/admin/access/)):

```text
/config fc link fc_id:9230000000000000001
/config roles member role:@Member
/config roles guest role:@Guest
/config officer_rank rank:Officer
/config roles officer role:@Officer adopt_holders:false
/config roles leader role:@FC Leader
/config ledger channel:#fc-ledger
/config officer_notifications channel:#officer-chat
/config validate
```

- [`/config fc link`](/tarubot/reference/commands/#config-fc-link) reads the FC from the Lodestone and queues its first roster check.
- The role commands make each chosen role one that TaruBot manages: it adds and removes the role to match the roster and members' links. See [Roles and access](/tarubot/admin/roles/).
- The officer rank and Officer role are explained in [Officers](/tarubot/admin/officers/). Set the rank before binding an existing Officer role with `adopt_holders:false`, or current holders who lack the rank lose the role.
- Guest applications stay closed until you open them; see [Guest applications](/tarubot/admin/guest-applications/).
- [`/config validate`](/tarubot/admin/health-checks/) checks everything without changing anything.

Optionally, choose where [update posts](/tarubot/admin/notices-and-updates/#update-posts) go: a normal text channel that members and guests can read. Announcement channels are refused, like every channel setting.

```text
/config changelog channel:#tarubot-updates
```

Setting the channel posts nothing at once; the first post comes with the next update that has something for members.

If some of these channels are private, choose them while TaruBot holds Administrator for the [setup window](/tarubot/admin/add-to-server/#the-setup-window): without it, TaruBot can't see them, and `/config` refuses a channel it can't post in.

## All at once with `/setup onboarding`

Look first, then run it with `confirm:true`:

```text
/setup onboarding fc_id:9230000000000000001 prefix:EXFC officer_rank:Officer lobby:#lobby officers:#officer-chat
/setup onboarding fc_id:9230000000000000001 prefix:EXFC officer_rank:Officer lobby:#lobby officers:#officer-chat confirm:true
```

Without `confirm:true`, [`/setup onboarding`](/tarubot/reference/commands/#setup-onboarding) is a **dry run**: it changes nothing and lists what it would create, reuse or rename, the rooms, how many channels onboarding's first pass would change and whether @everyone would lose View Channel, the guest-application and officer-notification settings, how many Officer-role holders it would adopt, the role layout, and every blocker that would stop it, each on its own line. Fix the blockers, run the dry run again, then run it with the same options and `confirm:true`.

Every option is optional. `/setup onboarding` needs **Manage Server**, **Manage Roles** and **Manage Channels**. With `confirm:true` it:

- creates or reuses four distinct ordinary roles, **Member**, **Guest**, **Officer** and **FC Leader**, plus a lobby and an officer room;
- turns on the channel-visibility policy below;
- links the FC and sets the officer rank when you give them. Omitting them keeps the current values, so you can set the roles up before linking an FC;
- sends officer notices and guest reviews to the officer room when no channel is set for them yet, and keeps any channel already chosen;
- switches guest applications on, so `/apply` opens.

Roles are created with no server permissions and receive channel-specific access. Every adopted role must be one TaruBot can manage and, unless you own the server, below your own highest role. Onboarding roles can't carry Administrator, Manage Server, Manage Roles or Manage Channels.

### Role names and reuse

The optional prefix goes in front of each role name: `prefix:EXFC` names them **EXFC Member**, **EXFC Guest**, **EXFC Officer** and **EXFC FC Leader**. Without it, the names are the plain ones.

Roles already chosen with `/config roles` are always reused, so renaming a configured role never creates a duplicate. Otherwise `/setup onboarding` looks for exactly one role named either the prefixed name or the plain **Member**, **Guest**, **Officer** or **FC Leader**, ignoring case, Unicode forms and spacing. A reused plain role is renamed to the prefixed name and keeps its ID, permissions and members. Only a missing role is created. If several roles match, choose one with `/config roles` and run `/setup onboarding` again.

When `/setup onboarding` adopts an existing Officer role, its current human holders get recorded officer grants. To bind an Officer role without that, use `/config roles officer` with `adopt_holders:false` instead; see [Officers](/tarubot/admin/officers/).

`/setup onboarding` can't link a different FC while one is linked: unlink it first with `/config fc unlink`. Once onboarding is on, all four roles must stay configured; replace one with `/config roles` instead of unsetting it, which needs a server manager.

### Rooms

Saved rooms are reused first. Otherwise `/setup onboarding` reuses a single `#lobby`, prefers a recognizable private officer or staff room (starting with `#officer-chat`), then the only private text room, then a room with an officer or staff name. Missing rooms are created as `#lobby` and `#officer-chat`, with their permissions already in place. If the choice is ambiguous, name the rooms with `lobby` and `officers`; they must be two different text channels.

After `/setup onboarding confirm:true`, choose the ledger channel, optionally the channel for update posts, and any overrides:

```text
/config ledger channel:#fc-ledger
/config changelog channel:#tarubot-updates
/config officer_notifications channel:#officer-chat
/config guest_applications channel:#officer-chat
/config validate
```

For update posts, don't choose the lobby, the officer room or a private channel: members and guests can't read them. Don't choose Discord's community-updates channel either: onboarding never manages it, so TaruBot can't tell who reads it. The receipt and `/config validate` warn about each, and TaruBot doesn't change the channel's permissions; see [Visibility with lobby onboarding](/tarubot/admin/notices-and-updates/#visibility-with-lobby-onboarding).

Running `/setup onboarding confirm:true` again is safe: it reuses what exists and repairs missing bindings. If it's interrupted, anything already created is reused on the next run.

## Channel visibility

With onboarding on, the channels TaruBot manages follow this table:

| Current access | Lobby | Ordinary channels | Officer room and existing private areas |
| --- | --- | --- | --- |
| Newcomer without access roles | Yes | No | No |
| Member or Guest | No | Yes | No |
| Officer or FC Leader, including with Member or Guest | Yes | Yes | Yes |
| TaruBot | Yes | Yes | Yes |

The server owner and Administrator bypass channel restrictions, as always in Discord. Manage Server alone doesn't: a manager needs the matching access role to see staff rooms.

- **The lobby** is a top-level text channel. Newcomers can read its history, chat and use commands there, but not create threads.
- **Every kind of channel** follows the policy: text, announcement, voice, stage, forum, media and categories. Threads follow their parent channel.
- **Existing private areas** are treated as staff-only from the moment onboarding first sees them, including channels inside staff categories, and stay that way when roles change. A channel created later that has any explicit View Channel allow or deny counts as private. A channel closed only by the server's default, with no visibility overwrites, counts as ordinary.

TaruBot becomes the authority for **View Channel** in managed channels: competing allows and denies, including custom-role and individual-member exceptions, are brought back in line. Other permission bits stay as they are, apart from the chat and command permissions the lobby and staff rooms need and TaruBot's own delivery permissions. Give bots and integrations the access roles they need.

@everyone loses the server-wide View Channel default only when that can't change an excluded area (below): each excluded channel or category must have its own explicit @everyone allow or deny, which TaruBot checks in the channel list Discord gives it. Otherwise the default stays as it is, and TaruBot enforces onboarding through each managed channel's overwrites instead. A new channel may then be visible briefly, until TaruBot processes its creation. Channel events also repair public overwrites that an admin adds later.

### Permissions TaruBot checks first

TaruBot needs server-level Manage Channels and Manage Roles and its own View Channel, plus View Channel, Manage Channels and Manage Roles in each existing managed channel. It checks these before it changes anything. It sets up the lobby's visibility before changing any default, and categories before the channels in them. After a pass it verifies the result. If a pass fails partway, the work and the original permissions stay recorded, so a retry picks up safely.

A channel onboarding should manage that TaruBot can't see stops the pass before anything changes, and `/sync status` names the channel with the fix: TaruBot needs View Channel, Manage Channels and Manage Roles there. TaruBot won't secure the rest and leave that channel unmanaged, because members could then see too much or too little in it. `/setup onboarding` stops the same way at a saved lobby or officer room TaruBot can't see, instead of creating a second one. From 16 November 2026 Discord hides such a channel from the bot: it is left out of the channel list the bot reads, and the bot sees only a placeholder name and placeholder permissions for it. TaruBot never works from those placeholders, and still stops at the channel as described.

Turning onboarding on after [`/setup overrides`](/tarubot/admin/add-to-server/#the-setup-window) has run needs one more step. In the channels it wrote an entry for that no setting names (the ones TaruBot couldn't see without Administrator), TaruBot's own entry denies it Manage Permissions and Manage Channels, and in voice and stage channels Connect too, which there also takes away Manage Channels. A role permission can't lift a member entry's deny, so without Administrator the dry run, `confirm:true` and onboarding's channel pass all stop at those channels, naming what TaruBot's own entry denies. Turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears those denies (the Create Invite deny stays), or remove them from TaruBot's own entry (the member, not its role) in each channel named, Connect included in a voice or stage channel.

Creating, changing or deleting a channel queues a repair of channel access. Startup, the bot rejoining, role changes, configuration changes and `/refresh` do too. [`/sync status`](/tarubot/reference/commands/#sync-status) shows the work, or a blocked permission. Run `/setup onboarding confirm:true` again to repair missing bindings, and `/refresh` after fixing permissions in Discord.

### Community resources outside onboarding

Discord's configured **community-updates channel** and its category are excluded. They are never chosen as the lobby or officer room, TaruBot doesn't need to see them, and onboarding never changes their permissions or position. Protecting the category also keeps its permission sync from changing the channel. They keep whatever policy you set.

From 16 November 2026, if TaruBot can't see them, Discord leaves them out of the channel list TaruBot reads, so TaruBot can't read their permissions either. It then leaves the server's @everyone View Channel default as it is and gates each managed channel through its own overwrites ([above](#channel-visibility)). To let TaruBot remove the default, give its role View Channel in the community-updates channel and its category, and give each of them an explicit @everyone View Channel allow or deny.

If the community-updates setting changes, TaruBot rechecks at once. If a saved lobby or officer room becomes the community-updates channel, run `/setup onboarding` with a different room.

## Reverting onboarding

TaruBot records each managed channel's original permissions, type, name and category the first time onboarding sees it, and the server's original @everyone permissions. `/setup onboarding confirm:true` and every enforcement pass are audited. Those records are what the deployment's operator uses to restore channels by hand. Because TaruBot restores its policy whenever it finds a difference, the operator has to switch onboarding off in the database before restarting the bot; editing channel permissions alone is treated as drift and repaired.
