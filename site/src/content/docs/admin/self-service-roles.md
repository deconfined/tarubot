---
title: Self-service roles
description: Build the role menu on the dashboard from existing roles that members and guests will pick for themselves, the checks every role must pass, and how to prepare to retire reaction roles.
sidebar:
  order: 5
---

Self-service roles replace reaction roles. Officers list existing Discord roles, such as pronouns, games or regions, in categories on the dashboard's **Role menu** page, and members and guests pick their own roles from that menu.

:::note[Officers build the menu first]
Role menu needs a **2.39.0 or newer** release, with the [dashboard](/tarubot/admin/health-checks/#dashboard) turned on. In this release, officers build the menu; members and guests can't pick from it yet. That comes in a later release, and until then nothing on the menu changes anyone's roles.
:::

## Who can change the menu

Any officer: anyone with Discord's Manage Server, or who holds the Officer role with TaruBot backing it (see [Who can do what](/tarubot/admin/access/)). Every officer can make every change, including adding roles and resetting a menu TaruBot can't read. TaruBot doesn't check the officer's own Discord permissions or role position here. What can be added is decided by [the checks below](#what-a-role-must-pass) and by [where TaruBot's own role sits](/tarubot/admin/roles/#where-tarubots-role-sits).

Every change is audited: TaruBot records who made it, which change it was, and the IDs of the categories and roles it touched. It doesn't copy the names and descriptions you type into its audit records.

## Open the page

Sign in to the dashboard and choose **Role menu** in the server's navigation.

The top of the page warns about anything that affects the menu:

- **TaruBot has Administrator** in the server. Members and guests won't be able to pick roles while it does. Use [`/setup overrides`](/tarubot/reference/commands/#setup-overrides), then remove Administrator once `/config validate` says it's no longer needed.
- **TaruBot can't read the server's roles** right now, for example just after a restart. Problems aren't shown and roles can't be added until it can; try again in a minute.
- **TaruBot can't see some channels**; see [Channels TaruBot can't see](#channels-tarubot-cant-see).
- **No Member role is set.** Members can't pick roles until one is set with [`/config roles`](/tarubot/reference/commands/#config-roles-member), and with no Guest role either, nobody can. A missing Guest role alone isn't flagged, since guests are optional.
- **Lobby onboarding is on**; see [Lobby onboarding](#lobby-onboarding).
- **Discord changes are paused**, so members and guests won't be able to save role choices until they're back on. You can still build the menu.

A server TaruBot isn't set up in shows only "Set TaruBot up first".

## Build the menu

1. **Add a category** at the bottom of the page: a name (up to 40 characters), an optional description (up to 200), and **How many can someone pick?**: Pick any number, Pick one, or Pick up to 2 to 25. New categories start as **drafts**, which only officers see.
2. **Add roles** in the category's card. It lists every role that passes [the checks](#what-a-role-must-pass), in Discord's order, each with the channels it opens. Tick as many as the category has room for, then choose **Add selected roles**. **Roles you can't add** lists every other role, with the first reason it can't be added.
3. **Edit roles** changes the whole category in one form. For each role, set its description (up to 100 characters, shown to people choosing it), its position, and **On the menu**: **Offered**, **Not offered** (nobody can add it, but people who have it can remove it), or **Remove from the menu**.
4. **Edit category** changes the name, description and limit. **Move up** and **Move down** change the order people see the categories in.
5. When the menu is ready, **Publish** each category, or use **Publish N drafts** at the top to publish every draft at once.

:::caution[Published categories go live with the next release]
A published category goes live for members and guests as soon as the release that lets them pick roles is installed. From then on, TaruBot also removes its roles that open channels from anyone who has none of the Member, Guest, Officer and FC Leader roles (see [Opt-in channels](#opt-in-channels)). If you're replacing a reaction-role bot, keep categories as drafts until you switch over; see [Preparing to replace reaction roles](#preparing-to-replace-reaction-roles).
:::

Names and descriptions are one line each. Control, text-direction and other invisible characters are refused, apart from the joiners and selectors that emoji and some scripts need, and text that shows nothing at all is refused too. Two categories can't have the same name. The menu holds at most **10 categories**, **25 roles** in a category and **50 roles** in all, and each role can be in only one category.

If another officer changed the menu while you were editing, your change isn't saved: the page shows the menu as it is now and keeps what you changed in your form, with the other officer's values in the fields you didn't touch, so you can check it and send it again without undoing their change. Sending the same change twice, for example with a double tap, saves it once.

## Taking roles off the menu

None of these changes anyone's roles in Discord: they change only what members and guests see on the menu.

| Action | Who sees the role on the menu | What they can do there |
| --- | --- | --- |
| **Publish** | Everyone with Member or Guest | Add it or remove it. |
| **Stop offering** (a category), or **Not offered** (one role) | Only people who have it | Remove it. Nobody can add it. |
| **Move back to draft** | Officers only | Nothing, until you publish it again. |
| **Remove from the menu** (one role), or **Delete category** | Nobody | Nothing: people keep the role in Discord, but can't change it here. |

To let people drop an identity role themselves, such as a pronoun, use **Stop offering** rather than deleting it. To take a role away from everyone, remove it from them in Discord, or delete the role.

## What a role must pass

Every role is checked against one set of rules. A role can be on the menu when:

- **TaruBot can assign it.** It exists, isn't @everyone, isn't managed by an integration, a bot or Server Boosting, isn't TaruBot's own role, sits below TaruBot's highest role, and TaruBot has Manage Roles.
- **It isn't an access role.** It isn't the Member, Guest, Officer or FC Leader role, or a role TaruBot is still cleaning up after a change ([why](/tarubot/admin/roles/#self-service-roles)).
- **It sits below every moderation role.** It's below the Officer and FC Leader roles, and below every role under TaruBot that has Kick Members, Ban Members, Time Out Members, Manage Nicknames or Administrator, a moderation bot's own role included, such as Dyno's. Discord lets someone kick, ban, time out or rename only members whose highest role is lower than theirs, so anyone who picked a role placed higher would be out of that role's reach. The page names the role to move it below in Discord's role list, and what people with that role couldn't do. TaruBot's own role doesn't count here.
- **It gives no server permissions.** It has no server permission that @everyone doesn't already have, and never Administrator, Manage Server, Manage Roles or Manage Channels, even where @everyone has them.
- **It changes nothing people can already see.** In a channel that everyone, members or guests can already see, it adds no permission: no Send Messages in a read-only #announcements, whether everyone can see that channel or only members.
- **It carries only @everyone's permissions in any channel.** Its own permission entry in a channel may allow only permissions @everyone has across the server, apart from View Channel (letting people see a channel is judged as opening it, below), such as reading and posting, and never Manage Messages, for example.
- **It lifts no channel restrictions.** In Discord, a role's allow beats other roles' denies, so its entry can't allow what another role is denied in that channel, such as Send Messages that a mute role takes away, or View Channel that a jail or quarantine role takes away, and can't allow what @everyone is denied in a channel it doesn't open, such as posting in a read-only #raid-news that people see through another role. In a channel it opens, it may let its people do what @everyone is denied there, such as seeing and posting, and let members and guests see it where the Member or Guest role is kept out. Another role's View Channel deny there still counts: a jail role's deny in an opt-in channel means the role can't be on the menu.
- **It takes nothing away.** Its entry denies nothing in a channel it doesn't open, and nothing that everyone, members or guests can already do in a channel is lost by picking it. People can remove a role on the menu themselves, so a mute, jail or quarantine role can't be on the menu: the people it restricts could remove it. A role that later starts restricting people can't be removed through the menu either, even under **Stop offering** or **Not offered**. A deny in a channel only the role opens, such as no Embed Links in its own #raids, is fine. This also refuses an opt-out role, such as one that hides #spoilers.
- **It opens only ordinary channels.** It may open channels those people can't otherwise see, such as a game's channels, but never one that looks like an officer channel (see [the heuristic](#the-officer-channel-check-is-a-heuristic)).

Each role on the menu shows **Opens:** with every channel it opens, and any problems it has, in plain words.

TaruBot checks a role when you add it, against a fresh view of the server, and again every time the page is shown. A role someone changes in Discord after you added it shows its problems on the page. The [Role menu health check](/tarubot/admin/health-checks/#role-menu) warns about roles in published and Not offered categories, what members and guests can see; a draft's problems show only on the page.

:::caution[Permission checks can't see everything]
Don't add roles that other bots or tools treat as a trust marker, such as DJ or Verified: a permission check can't see what another bot does with a role.
:::

### The officer-channel check is a heuristic

TaruBot can't know what a channel is for, so it judges by the channel's settings and permissions. It treats a channel as an officer channel when:

- a setting names it for officers: the officer room, the officer notifications channel, the guest application review channel, or a channel lobby onboarding keeps for staff; or
- nobody with only @everyone, Member or Guest can see it, and its permission entries let in the Officer or FC Leader role, or a role with a staff power: Administrator, Manage Server, Manage Roles, Manage Channels, Manage Messages, Kick Members, Ban Members or Time Out Members.

Two kinds of private channel aren't recognized: one that only Administrators can see, with no entry letting anyone in, and one opened to officers through entries for each person rather than a role, such as an officer room where each officer was added by name, or a ticket channel. **Read every role's Opens: list before you publish it.**

### Channels TaruBot can't see

TaruBot can't check channels it can't see, including channels you hide from it on purpose: it can't read a role's permission entry there, so it can't tell whether the role opens the channel or gives a permission in it, such as Manage Messages. While there are any, the page says how many, and **Add roles** asks you to confirm you've checked that the roles you're adding don't open them or give any permission in them. The audit record notes how many channels you confirmed.

### Opt-in channels

A role that opens channels opens them for everyone who holds it, whatever their other roles: Discord adds up the permissions of all of a member's roles. The release that lets members pick roles also removes menu roles that open channels from anyone left with none of the Member, Guest, Officer and FC Leader roles, such as a revoked guest or a former member. Roles that open nothing, such as pronouns, stay.

### Lobby onboarding

With TaruBot's [lobby onboarding](/tarubot/admin/setup/) on, menu roles can't open channels: onboarding's channel pass removes View Channel from every role it doesn't manage. Roles that open nothing work as usual. The Role menu page says so while onboarding is on.

## A menu TaruBot can't read

If the saved menu was written by a different TaruBot version, for example a newer one before the server went back to an older release, or it's damaged, the page shows a warning and only **Reset role menu**, and members and guests see nothing to pick from it. Resetting empties the menu so you can build it again, and changes nobody's roles in Discord. Any officer can reset it, and the reset is audited. The [health check](/tarubot/admin/health-checks/#role-menu) warns about it too.

## Discord's own onboarding

Discord's built-in Server Onboarding ("Channels & Roles") can also let people pick roles when they join, with no bot involved. TaruBot's role menu is for choices people make on the web at any time, with the checks above.

## Preparing to replace reaction roles

TaruBot can't read reactions, because it never asks Discord for message or reaction events, and it doesn't need to. People keep the roles they have, and Discord stays the record of who holds which role, so once a role is on the menu, the people who already have it will find it already chosen.

Prepare while your reaction-role bot, such as Dyno, keeps running; members notice nothing:

1. **List each reaction-role message**: its roles, and whether it lets people pick only one or several. Check the counts against the menu's limits above.
2. **Check where TaruBot's role sits**: above the menu roles and the four roles it manages, and below every role with moderation or admin powers. The menu roles must also sit below Officer, FC Leader and every moderation role, a moderation bot's own role included, or [the page refuses them](#what-a-role-must-pass). See [Where TaruBot's role sits](/tarubot/admin/roles/#where-tarubots-role-sits).
3. **Create one draft category per message**, with the same roles and the matching **How many can someone pick?**. Fix anything the page refuses, in Discord:
   - clear server permissions a cosmetic role doesn't need;
   - remove extra permissions in channels everyone can see, such as Send Messages in #announcements, and allows that undo another role's deny, such as a mute role's;
   - move the role below TaruBot's, and below Officer, FC Leader and every moderation role.
4. **Read every role's Opens: list.**
5. **Keep the categories as drafts.** Publish them only when you switch over, so people never have two ways to pick the same roles.

The switch-over steps come with the release that lets members and guests pick their roles.

## What's stored

The menu is configuration: category names, descriptions, limits and states, and the IDs of the roles on it, with their descriptions. TaruBot never stores who picked which role; see [Data and privacy](/tarubot/architecture/data-and-privacy/).
