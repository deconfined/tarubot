---
title: Commands
description: Every TaruBot slash command and option, who can use it, and an example.
sidebar:
  order: 1
---

Every command works only inside a server, and every reply is private to the person who ran it. The groups below follow the bot's own command folders. Guides link here instead of repeating the option tables.

**Who can use it** uses these words:

- **Anyone** means any human member of the server.
- **Officers** have Discord's Manage Server permission, or hold the Officer role with TaruBot backing it: a linked character holds the officer rank, or a server manager granted it with `/officer grant`. A role given by hand alone doesn't count. See [Who can do what](/tarubot/admin/access/).
- **Server managers** have both Manage Server and Manage Roles. Bot officer access alone isn't enough.
- **Confirmed FC members** have a linked character that an accepted roster lists in the server's Free Company.

A **Member** option suggests server members as you type. You can also paste a user ID or an @mention, which is how you name someone who has left the server.

## Characters

### /assign

Assign a trusted character link to a member, with a recorded reason. The character is found the same way as for `/claim`. See [Managing members' characters](/tarubot/admin/member-links/).

**Who can use it:** officers. Only a server manager's assignment lets the character's in-game rank grant automatic officer access; an assignment by any other officer grants membership only.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | Who the character belongs to. They must be in the server. |
| `reason` | Text | Yes | Recorded in the audit log; up to 1,000 characters. |
| `character` | Text | No | The character's Lodestone ID or profile URL. |
| `forename` | Text | No | With `surname` and `world`, instead of `character`. |
| `surname` | Text | No | The exact surname. |
| `world` | Text | No | The exact home world. |

```text
/assign member:123456789012345678 reason:Confirmed in voice chat character:99000001
/assign member:123456789012345678 reason:Confirmed in voice chat forename:Example surname:Character world:Diabolos
```

### /characters

List linked characters, how each was linked, the main character and the nickname setting.

**Who can use it:** anyone, for their own characters. Officers can name another member.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | No | Officers only: the member to look up. |

```text
/characters member:123456789012345678
```

### /claim

Start linking a character by proving you control its Lodestone profile. The reply gives a one-time token to put in the character's Lodestone biography. See [Link a character](/tarubot/use/link-a-character/).

**Who can use it:** anyone, for their own characters, once the server is set up.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `character` | Text | No | The character's Lodestone ID or profile URL. |
| `forename` | Text | No | With `surname` and `world`, instead of `character`. |
| `surname` | Text | No | The exact surname. |
| `world` | Text | No | The exact home world. |

Use either `character`, or all three of `forename`, `surname` and `world`.

```text
/claim character:99000001
/claim forename:Example surname:Character world:Diabolos
```

### /main

Choose your main character in this server. Your nickname follows your main while nickname sync is on.

**Who can use it:** anyone, for their own linked characters.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `character` | Character | Yes | Pick one of your linked characters from the suggestions. |

```text
/main character:99000001
```

### /nickname

Turn character-based nickname management on or off.

**Who can use it:** anyone, for their own nickname.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | True or false | Yes | `true` sets your nickname to your main character's name; `false` stops and restores your earlier nickname where it can. |

```text
/nickname enabled:true
```

### /unassign

Remove a member's character link, with a recorded reason. It works for members who have left.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The link's owner. |
| `character` | Character | Yes | One of that member's linked characters. |
| `reason` | Text | Yes | Recorded in the audit log; up to 1,000 characters. |

```text
/unassign member:123456789012345678 character:99000001 reason:Linked by mistake
```

### /unclaim

Remove one of your own character links. It works while the Lodestone is down, because it uses what TaruBot has stored.

**Who can use it:** anyone, for their own linked characters.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `character` | Character | Yes | Pick one of your linked characters from the suggestions. |

```text
/unclaim character:99000001
```

### /verify

Finish a claim: TaruBot reads the character's profile and looks for your token in the biography.

**Who can use it:** anyone, for their own claims.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `character` | Character | Yes | The character you claimed; suggestions list your open claims. |

```text
/verify character:99000001
```

## Configuration

### /config fc link

Link this server to its Free Company. TaruBot reads the FC from the Lodestone and queues a roster check.

**Who can use it:** officers; a server manager once an officer rank is set.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `fc_id` | Text | Yes | The FC's Lodestone ID or URL. |

```text
/config fc link fc_id:9230000000000000001
```

### /config fc unlink

Unlink the Free Company. Links, ledger accounts and history stay.

**Who can use it:** officers; a server manager once an officer rank is set.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `fc_id` | Text | Yes | The linked FC's ID, as a safeguard against unlinking the wrong one. `/config show` lists it. |

```text
/config fc unlink fc_id:9230000000000000001
```

### /config roles member

Choose the Member role, which TaruBot gives to confirmed FC members and removes from everyone else.

**Who can use it:** officers with Discord's Manage Roles; a server manager once onboarding is on.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | Role | No | The role to manage. |
| `unset_role` | True or false | No | Stop managing the role. It stays in Discord. |

Give exactly one of `role` or `unset_role:true`. Once onboarding is on, the four access roles can be replaced but not unset.

```text
/config roles member role:@Member
/config roles member unset_role:true
```

### /config roles guest

Choose the Guest role, which TaruBot gives to registered visitors, approved applicants and members an officer granted Guest.

**Who can use it:** officers with Discord's Manage Roles; a server manager once onboarding is on.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | Role | No | The role to manage. |
| `unset_role` | True or false | No | Stop managing the role. It stays in Discord. |

```text
/config roles guest role:@Guest
/config roles guest unset_role:true
```

### /config roles officer

Choose the Officer role. TaruBot gives it to members whose linked character holds the officer rank or whom a server manager granted officer access, and removes it from anyone else. Holding it with that backing gives bot officer access, never Discord permissions.

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | Role | No | The role to manage. |
| `unset_role` | True or false | No | Stop managing the role. It stays in Discord. |
| `adopt_holders` | True or false | No | Default `true`: the role's current human holders get recorded officer grants. `false` binds the role without granting anyone, so officer access comes only from the in-game rank and `/officer grant`. |

```text
/config roles officer role:@Officer adopt_holders:false
/config roles officer unset_role:true
```

### /config roles leader

Choose the FC Leader role, which TaruBot gives to the owner of the FC's leader character.

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `role` | Role | No | The role to manage. |
| `unset_role` | True or false | No | Stop managing the role. It stays in Discord. |

```text
/config roles leader role:@FC Leader
/config roles leader unset_role:true
```

### /config officer_rank

Choose the in-game FC rank whose holders get bot officer access automatically.

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `rank` | Text | No | The exact FC rank name. Case, spacing and Unicode forms don't matter. |
| `unset_rank` | True or false | No | Use manual officer grants only. |

```text
/config officer_rank rank:Officer
/config officer_rank unset_rank:true
```

### /config role_layout

Turn automatic display and ordering of the managed roles on or off. A server first set up with `/config` or `/setup onboarding` starts with it off. See [Role layout](/tarubot/admin/roles/#role-layout).

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | True or false | Yes | `true` shows the four roles separately in one block, FC Leader above Officer above Member above Guest. `false` leaves the current display as it is. |

```text
/config role_layout enabled:true
```

### /config ledger

Choose the channel where ledger entries are posted.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `channel` | Channel | No | A text channel TaruBot can post in. |
| `unset_channel` | True or false | No | Stop posting ledger entries. The channel and its messages stay. |

```text
/config ledger channel:#fc-ledger
/config ledger unset_channel:true
```

### /config officer_notifications

Choose the channel for officer notices: Lodestone trouble and its recovery, and the "Member status changes" posts about members who gained or lost access, Officer or FC Leader and characters that left the FC. See [Officer notices](/tarubot/admin/notices-and-updates/#officer-notices) and [Member status changes](/tarubot/admin/notices-and-updates/#member-status-changes).

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `channel` | Channel | No | A staff-only text channel TaruBot can post in. |
| `unset_channel` | True or false | No | Stop posting officer notices and status changes. Changes made while it is unset aren't posted later. |

```text
/config officer_notifications channel:#officer-chat
/config officer_notifications unset_channel:true
```

### /config changelog

Choose the channel where TaruBot posts what's new after it starts on a newer version. Setting it posts nothing at once: the first post comes with the next update that has a note. See [Update posts](/tarubot/admin/notices-and-updates/#update-posts).

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `channel` | Channel | No | A normal text channel that members and guests can read and TaruBot can post in. With lobby onboarding on, the reply warns about a channel members and guests can't read, or one onboarding doesn't manage. |
| `unset_channel` | True or false | No | Stop update posts. The channel and its posts stay, and updates released meanwhile aren't posted later. |

```text
/config changelog channel:#tarubot-updates
/config changelog unset_channel:true
```

### /config guest_applications

Turn guest applications on or off, and choose the channel where officers review them. The options combine in one call.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | True or false | No | Whether `/apply` takes applications. |
| `channel` | Channel | No | A staff-only text channel for reviews. It is checked before anything is saved. |
| `unset_channel` | True or false | No | Stop using a review channel, which also closes `/apply`. |

Give at least one option, and never `channel` with `unset_channel`.

```text
/config guest_applications enabled:true channel:#officer-chat
/config guest_applications unset_channel:true
```

### /config show

Show every setting and what each feature needs, with a **Run health check** button.

**Who can use it:** officers.

This command has no options.

### /config validate

Check the setup without changing anything: roles, channels, permissions, the linked FC and its roster, onboarding and the role layout, and TaruBot's own role and channel view, as if Administrator were off. See [Health checks](/tarubot/admin/health-checks/).

**Who can use it:** officers.

This command has no options.

### /officer grant

Give a member bot officer access regardless of their in-game rank.

**Who can use it:** server managers. Discord hides the `/officer` commands from other members by default.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | A current member of the server. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/officer grant member:123456789012345678 reason:New FC officer
```

### /officer revoke

Take bot officer access away from a member, even if their in-game rank qualifies. It works for members who have left.

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The member to revoke. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/officer revoke member:123456789012345678 reason:Stepped down
```

### /officer reset

Remove a member's grant or revocation, so the in-game rank decides again.

**Who can use it:** server managers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The member to reset. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/officer reset member:123456789012345678 reason:Back to the in-game rank
```

### /setup onboarding

Create or reuse the Member, Guest, Officer and FC Leader roles, a lobby and an officer room, and turn on lobby onboarding. Without `confirm:true` it is a dry run: it lists what it would create, reuse and change, and anything that would stop it, and changes nothing. Read [Setting up a server](/tarubot/admin/setup/) first: no command undoes `confirm:true`.

**Who can use it:** server managers who also have Manage Channels. Discord hides it from other members by default.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `fc_id` | Text | No | The FC's Lodestone ID or URL. Omit it to keep the linked FC. |
| `prefix` | Text | No | Put in front of each role name, up to 50 characters. |
| `officer_rank` | Text | No | The in-game FC rank that grants bot officer access. |
| `lobby` | Channel | No | An existing lobby to reuse. |
| `officers` | Channel | No | An existing officer-only room to reuse. |
| `confirm` | True or false | No | Make the changes; without it, only show what would change. |

```text
/setup onboarding fc_id:9230000000000000001
/setup onboarding prefix:EXFC
/setup onboarding officer_rank:Officer lobby:#lobby officers:#officer-chat confirm:true
```

### /setup overrides

Add TaruBot's own permission entry to each channel it couldn't otherwise see (or, where a setting names the channel, couldn't post in) while TaruBot temporarily holds Administrator, so that once Administrator is removed it still sees every channel, and can post where a setting names the channel. Channels it already sees, such as public ones, are left as they are. A channel no setting names that it can't see gets View Channel, with Read Message History, Manage Permissions, Manage Channels and Create Invite denied (and Connect in voice and stage channels and in categories). A channel hidden from TaruBot on purpose is left alone, and so is a private category that holds a configured channel, which you fix yourself. Without `confirm:true` it is a dry run that changes nothing and works without Administrator. Servers with lobby onboarding don't need it: onboarding manages TaruBot's channel access. Take Administrator away again as soon as `/config validate` says it is no longer needed; see [The setup window](/tarubot/admin/add-to-server/#the-setup-window).

**Who can use it:** server managers; `confirm:true` also needs Administrator, or the server owner. Discord hides it from members without Manage Server, Manage Roles and Manage Channels by default.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `confirm` | True or false | No | Make the changes; without it, only show what would change. |

```text
/setup overrides
/setup overrides confirm:true
```

## Guests

### /apply

Open the guest application form: two answers of 10 to 300 characters each, which officers review. See [Guest access](/tarubot/use/guest-access/).

**Who can use it:** visitors without a linked character, while the server's guest applications are open.

This command has no options.

### /guest approve

Approve a pending guest application. The applicant gets the Guest role and a direct message.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `application` | Application | Yes | Pick a pending application from the suggestions. |

```text
/guest approve application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f
```

### /guest deny

Deny a pending guest application. The applicant gets a direct message and can apply again after the cooldown.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `application` | Application | Yes | Pick a pending application from the suggestions. |
| `reason` | Text | No | Shown to the applicant. |

```text
/guest deny application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f reason:Not part of our community
```

### /guest grant

Give a member lasting Guest access, or restore it after a revocation.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The member to grant. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/guest grant member:123456789012345678 reason:Friend of the FC
```

### /guest revoke

Take away every kind of Guest access from a member until an officer grants it again. FC membership still gives the Member role.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The member to revoke. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/guest revoke member:123456789012345678 reason:Left the community
```

### /guest reset

Lift a member's revocation and end every grant, so FC membership and linked characters decide again.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | Yes | The member to reset. |
| `reason` | Text | Yes | Recorded in the audit log. |

```text
/guest reset member:123456789012345678 reason:Back to the automatic rules
```

### /guest status

Show guest applications, grants, revocations and delivery work.

**Who can use it:** anyone, for themselves. Officers can name another member.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `member` | Member | No | Officers only: the member to look up. |

```text
/guest status member:123456789012345678
```

## Ledger

### /ledger deposit

Record gil put into the FC chest.

**Who can use it:** confirmed FC members and officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `amount` | Number | Yes | 1 to 999,999,999 gil. |
| `note` | Text | Yes | What the deposit is for; up to 1,000 characters. |

```text
/ledger deposit amount:10005000 note:Weekly FC chest deposit
```

### /ledger withdraw

Record gil taken out of the FC chest. The recorded balance can't go below zero.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `amount` | Number | Yes | 1 to 999,999,999 gil. |
| `note` | Text | Yes | What the withdrawal is for. |

```text
/ledger withdraw amount:2500000 note:Housing materials
```

### /ledger initialize

Set the opening balance of a ledger that has none yet. It works once per FC account.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `balance` | Text | Yes | Whole gil, digits only, such as `10005000`. |
| `note` | Text | Yes | Where the figure came from. |

```text
/ledger initialize balance:10005000 note:Opening balance from FC chest
```

### /ledger adjust

Record a correction that sets the balance to a new figure. Nothing is overwritten: the correction is a new entry.

**Who can use it:** officers.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `balance` | Text | Yes | The corrected balance in whole gil. |
| `note` | Text | Yes | Why the balance changed. |
| `entry` | Text | No | The entry this corrects: its number from `/ledger history` (`42` or `#42`) or its ID. |

```text
/ledger adjust balance:10005000 note:Recount after chest audit
/ledger adjust balance:10005000 note:Withdrawal #42 was 2,550,000 gil entry:42
```

### /ledger balance

Show the current balance and whether recent entries have been posted.

**Who can use it:** confirmed FC members and officers. Only officers can name a previous FC with `fc_id`.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `fc_id` | Text | No | A previous FC's ID, to read its ledger. |

```text
/ledger balance fc_id:9230000000000000001
```

### /ledger history

Show ledger entries, newest first, ten to a page, with **Newer**, **Older** and **Latest** buttons.

**Who can use it:** confirmed FC members and officers. Only officers can name a previous FC with `fc_id`.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `fc_id` | Text | No | A previous FC's ID, to read its ledger. |
| `before` | Text | No | Start below this entry number, from an earlier page. |

```text
/ledger history before:34
/ledger history fc_id:9230000000000000001
```

## Synchronization

### /refresh

Ask for a roster check when one is due, then recheck everyone's roles. The reply gives a run ID for `/sync status`.

**Who can use it:** anyone. Only officers can use `force`.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `force` | True or false | No | Read the roster now even if the last one is recent. Rate limits and locks still apply. |

```text
/refresh force:true
```

### /sync status

Show background work: roster checks, role updates, posts and messages, with their [status markers](/tarubot/reference/replies/#status-markers).

**Who can use it:** anyone, for their own requests and work. Officers see server-wide work.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `run_id` | Text | No | One run's ID, from a `/refresh` reply. |

```text
/sync status run_id:9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a
```

## Utility

### /channel

Show the current channel's ID, name and type. In a channel TaruBot can't see, it shows the ID only.

**Who can use it:** anyone.

This command has no options.

### /issue

Report a problem to the maintainers of this TaruBot deployment. See [Progress and problems](/tarubot/use/progress-and-problems/).

**Who can use it:** anyone. One report per member every 10 minutes, and 20 per server a day.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `description` | Text | Yes | What went wrong and what you expected, 10 to 1,000 characters. |

```text
/issue description:My Member role disappeared after I ran /main this morning.
```

### /ping

Show Discord's gateway latency.

**Who can use it:** anyone.

This command has no options.

### /suggest

Suggest a TaruBot feature or improvement. It's posted at once as a public issue in TaruBot's GitHub repository, with only the cleaned idea and TaruBot's version, and the reply links to it. See [Suggest a feature](/tarubot/use/suggest-a-feature/).

**Who can use it:** holders of the server's Member or Guest role, in the FC's own server: the one server the TaruBot project's own deployment serves. Officer access alone doesn't count, and other servers get "Not available here", even for their managers (a development deployment's test server previews suggestions privately instead; see [configuration](/tarubot/deploy/configuration/#development-only)). Each member can send one suggestion an hour and three a day, and the deployment posts at most ten a day.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `idea` | Text | Yes | The idea, 10 to 1,000 characters. It's posted publicly, so leave out names, personal details and security problems. Links, mentions, email addresses and long ID numbers are removed first. |

```text
/suggest idea:Let officers schedule FC events and remind members an hour before.
```

### /version

Show the running version, links to the source code and license, and recent commits from GitHub.

**Who can use it:** anyone.

| Option | Type | Required | Notes |
| --- | --- | --- | --- |
| `commits` | Number | No | How many recent commits to show, 1 to 10. The default is 5. |

```text
/version commits:10
```
