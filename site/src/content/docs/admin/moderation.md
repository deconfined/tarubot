---
title: Pausing people
description: Stop one person using one feature for a while, such as someone abusing /suggest, without touching their roles. Who can pause whom, the nine features, how long, what the person sees, the Moderation page, looking up who sent a suggestion, and lifting.
sidebar:
  order: 13
---

A **pause** stops one person using one feature for a while, for example a member who keeps abusing [`/suggest`](/tarubot/admin/suggestions/), without touching their Discord roles or anything else they can do. Officers who hold the **moderation** permissions set and lift pauses with [`/moderate`](/tarubot/reference/commands/#moderate-block) or on the dashboard's **Moderation** page. The people it affects read [If your use of a feature is paused](/tarubot/use/progress-and-problems/#if-your-use-of-a-feature-is-paused).

:::note[Releases]
Pauses need a **2.45.0 or newer** release. The Moderation page needs the [dashboard](/tarubot/admin/health-checks/#dashboard) turned on; `/moderate` works without it.
:::

## What a pause is, and isn't

- **It only takes away.** A pause removes one thing a person could do. It gives nobody anything, and it never changes who holds which Discord role: the person keeps Member or Guest and every role they chose, and everything else works as before.
- **It posts and sends nothing.** TaruBot posts nothing in Discord and sends no DM. The person finds out when they next use the feature, and can read the details any time with [`/moderate status`](/tarubot/reference/commands/#moderate-status).
- **It undoes nothing.** A suggestion already on GitHub stays there (officers can't remove an issue from Discord), a mod mail case already open stays open, roles already picked stay picked, and a role change the person saved before the pause still goes through.
- **It ends by itself.** Every pause has an end, or lasts until an officer lifts it. Ends are judged on the database's clock, and nothing needs to run for one to end.
- **It waits for the permission.** Pausing a feature for someone who can't use it yet, such as `/suggest` for a lobby newcomer, changes nothing now; it applies the moment they can.

## What can be paused

Nine features, the ones members and guests use rather than the work officers do:

| Feature | What stops | Who can pause it |
| --- | --- | --- |
| Linking characters | [`/claim`](/tarubot/reference/commands/#claim) and [`/verify`](/tarubot/reference/commands/#verify) | Officers and server managers |
| Roster checks | [`/refresh`](/tarubot/reference/commands/#refresh) | Officers and server managers |
| Guest applications | [`/apply`](/tarubot/reference/commands/#apply) | Officers and server managers |
| Reading the ledger | [`/ledger balance`](/tarubot/reference/commands/#ledger-balance) and [`/ledger history`](/tarubot/reference/commands/#ledger-history) | Officers and server managers |
| Recording ledger deposits | [`/ledger deposit`](/tarubot/reference/commands/#ledger-deposit) | Officers and server managers |
| Opening mod mail cases | [`/modmail`](/tarubot/reference/commands/#modmail) and **Open a case** on the dashboard. Cases the person already has stay readable, and they can still reply to and close them. | **Server managers only** |
| Picking roles on My roles | **Save my roles**. The page still opens. | Officers and server managers |
| Suggesting features | [`/suggest`](/tarubot/reference/commands/#suggest) | Officers and server managers |
| Reporting problems | [`/issue`](/tarubot/reference/commands/#issue) | Officers and server managers |

A pause on a ledger feature holds for **officers too**. Reading the ledger is opened for officers by their **ledger.audit** permission, and recording deposits by their officer role, but a pause is checked first, so a paused officer is refused just as a member is: reading stops for every ledger, including a previous Free Company's, and a deposit is refused before TaruBot checks the ledger's setup or anyone's FC membership. It leaves withdrawals, corrections and the opening balance alone, which are officer work and can't be paused. Only a server manager can pause an officer ([below](#who-can-pause-whom)).

Mod mail is how members raise concerns about officers, so officers can't cut it off; only a server manager can pause opening a case. The staff permissions, the officer work itself, can't be paused in this release, and neither can the things that need no permission at all: [`/unclaim`](/tarubot/reference/commands/#unclaim), [`/main`](/tarubot/reference/commands/#main), [`/nickname`](/tarubot/reference/commands/#nickname), a person's own records and the utilities. To change what an officer can do, change their role.

## How long

| Choice | Lasts |
| --- | --- |
| 1 hour | 1 hour |
| 1 day | 24 hours |
| 1 week | 7 days. The default. |
| 30 days | 30 days |
| Until lifted | Until an officer or server manager lifts it |

Pausing a feature that's already paused replaces the earlier pause with the new end and reason; the earlier one stays in the history.

## Who can pause whom

Two permissions decide, both carried by the Officer role and held by server managers: **moderation.view** sees who is paused and why, and **moderation.block** pauses and lifts. [Who can do what](/tarubot/admin/access/#pauses) lists them. On top of that:

- **Nobody pauses themselves,** or lifts a pause on themselves.
- **Server managers and bots can't be paused.** A server manager has both Manage Server and Manage Roles.
- **Server managers can pause anyone else,** in any of the nine features, and change or lift any pause.
- **Officers can pause only people with no officer permission.** They can't pause another officer or a server manager, can't pause mod mail opening, and can change or lift only pauses an officer set. A pause a server manager set is a server manager's to change or lift.
- **The person must be in the server,** or someone TaruBot already knows from an earlier time there, such as a member who left. TaruBot refuses an ID it has never seen.

## Pause someone

Use [`/moderate block`](/tarubot/reference/commands/#moderate-block): choose the member, the feature (or **All member features**, which leaves out mod mail), how long (a week unless you pick another) and a reason. The reply says what was paused and until when, repeats the reason the member will see, and lists any earlier pause it replaced. Discord suggests members as you type, and you can paste a user ID instead. On the dashboard, the Moderation page's **Pause someone** does the same with a form: the member's ID (or a pasted mention), one or more features ticked, how long and the reason.

## The reason

Every pause needs a reason of 1 to 1,000 characters, and a line break counts as one character, so anything the dashboard's box accepts is accepted. Lifting a pause asks for a reason of the same length. **The paused person reads it,** and so do officers who can see pauses, so write it for them: what happened, and what you expect. It is private text, kept like a guest revocation: it never goes in TaruBot's audit log, logs, reports or Discord, only in the pause's own record, which is kept until the server's data is removed.

## What the paused person sees

They're told which feature, when the pause ends and your reason, and **never who set it**. A pause shows up everywhere the feature is used:

- **Commands** refuse with a **Paused for you** card saying their use of the feature is paused, with the end and the reason. It's checked before the command's limits and before any GitHub request or Lodestone read, so a paused try costs nothing and counts against no limit. Where it comes in:
  - [`/claim`](/tarubot/reference/commands/#claim) checks it after finding the server and before it searches the Lodestone, so a mistyped name reads as the pause, not as "not found".
  - [`/modmail`](/tarubot/reference/commands/#modmail) and [`/apply`](/tarubot/reference/commands/#apply) check it **before their form opens**, so nobody writes a message into a form that can't be sent. `/apply` still says first that applications are closed. `/modmail` still says first that mod mail isn't set up or can't be used here, or that the person doesn't hold Member or Guest, and then tells a paused person about the pause before it mentions the on/off switch or the case limits. Server managers, who can't be paused, skip the check. Like the other checks before a form it is a courtesy that lets the form open if it can't finish in time; the submission checks again and refuses a paused person the same way.
  - [`/issue`](/tarubot/reference/commands/#issue) and [`/ledger deposit`](/tarubot/reference/commands/#ledger-deposit) look at what was typed first, so a description or note that can't be accepted is told that, not the pause.
- **My roles** still opens and says until when and why, with **Save my roles** off, as during a Discord time-out.
- **Mod mail's Open a case** is greyed out with a note beside it that opening cases is paused, and `/modmail` refuses before its form opens with the same **Paused for you** card, giving the end and the reason. Existing cases work as before.
- **Reading the ledger and recording deposits** are refused the same way, for officers as well as members.

The card points to `/modmail` for talking to the officers only when the paused feature is one of the member features that go with the Member and Guest roles: suggesting features, My roles and the ledger. For every other feature it says to ask an officer in the server. Linking characters, roster checks, guest applications and reporting problems are open to anyone in the server, who may hold neither role and so have no `/modmail`; and when opening cases is itself what is paused, the card adds that the cases already open stay open on the dashboard. `/moderate status` gives the person the same advice for everything paused for them at once: it points to `/modmail` when any paused feature is one of those member features and opening cases isn't paused.

## The Moderation page

When the dashboard is on, officers who can see pauses (and server managers) find **Moderation** in the server's navigation. It shows:

- **Paused now:** a card for each paused person, with a chip for each paused feature: when it ends, the reason, and who set it and when. Only officers who can see pauses see who, and never for their own pauses (see below).
- **Recently ended:** the newest 25 pauses to end, newest end first, each saying whether it ran out or who lifted it, and the lift's reason. A pause that ran out shows the time it was due to end, not the later moment TaruBot noticed, and has no lifter or lift reason.
- **Find someone:** a member's ID or a pasted mention, to see their pauses and the earlier ones, or a suggestion number such as `#123`, to see who sent it ([below](#who-sent-a-suggestion)).
- **Pause someone**, and **Lift** on each chip, for officers who hold **moderation.block**. Someone who holds only **moderation.view** sees everything and the page says changing needs the other permission. To change a pause, pause the same feature again: the new one replaces the old.

**An officer who is paused sees their own pauses like any member.** Only a server manager can pause an officer, and the officer keeps the page. Their own pauses show the feature, the end and the reason and never who set them, with a note in place of Lift ("Your own pause. Someone else lifts it."), and their own ended pauses aren't listed, so the 25 recently ended are other people's. Looking themselves up in **Find someone** shows the same as [`/moderate status`](/tarubot/reference/commands/#moderate-status) does. Who set a pause and who lifted one stays out of sight of the person it is about, whoever they are.

Pausing and lifting need a Discord sign-in from the **last 15 minutes**. If yours is older, the page says **Sign in again to make changes** and offers it as a plain link in place of the buttons. A change you send from an older session is **not made**: the page opens again with that link and without what you typed, so sign in again, then enter the change again. The form can't send you to Discord itself: a form submission redirected on to Discord's sign-in is blocked by the page's security policy in Chromium browsers, so the sign-in is a link you follow from the page. Looking people up needs no recent sign-in.

What this protects, exactly: TaruBot signs you in with Discord's `prompt=none`, so in a browser that is still signed in to Discord the sign-in again is silent and takes a moment. The rule stops a copied or replayed TaruBot session cookie, whose holder's browser has no live Discord session of yours, from pausing people once your last sign-in is more than 15 minutes old. It does **not** protect an unlocked computer or browser that is still signed in to Discord: whoever sits there passes the sign-in without a prompt. Lock your screen, and on a shared computer sign out of Discord itself, not only the dashboard.

## Who sent a suggestion

A suggestion's public issue never names its sender. Officers who can see pauses can still look the sender up: on the Moderation page, type the issue's number with a `#` in **Find someone**, such as `#123`. The result says who sent it, shows their pauses and, if you may pause them, offers **Pause**.

- **This is new visibility** (owner decision, 2026-10-12). Before 2.45.0 only whoever runs the database could find the sender. Nothing public changes: the issue, and everything else public, still carry no name.
- **Where it comes from.** `/suggest` writes a private entry in TaruBot's audit log once GitHub confirms an issue, naming the sender and the issue's number. The lookup reads that entry, for your own server only. See [data and privacy](/tarubot/architecture/data-and-privacy/#public-suggestions).
- **It can come back empty.** A suggestion GitHub didn't confirm has no issue number, and an entry lost in a restore is gone. Neither is found, and the page says there is no record of who sent it in this server.
- **Treat the answer as private.** Don't post the sender's name where members read it.

## Lift a pause

Use [`/moderate lift`](/tarubot/reference/commands/#moderate-lift) or **Lift** on the Moderation page, with a reason that stays in the history. Choose one feature, or **All member features** to lift every pause you're allowed to lift. The person can use the feature again from their next command; nobody is sent a message. Lifting a feature that isn't paused changes nothing and says so.

## Look at someone's pauses

[`/moderate status`](/tarubot/reference/commands/#moderate-status) with a member shows their active pauses and the newest ended ones, with who set each and the reasons. Without a member it shows your own, the way the member sees them. Anyone can read their own pauses; reading someone else's needs **moderation.view**.

## What TaruBot keeps

- **Every pause is kept as history.** A pause is a row that's never deleted or edited; only its lift is written, once. The Moderation page shows the newest ended ones.
- **The audit log** records that someone paused or lifted which features for which person, and when a pause was due to end, never the reason.
- **Backups.** A restored backup brings back the pauses it held, so they can differ from the current ones: a pause lifted since can reappear (unless its own end has passed), and one set since can be missing. After a restore, check the Moderation page.
- **Server managers can't be paused,** whatever is stored.

[Data and privacy](/tarubot/architecture/data-and-privacy/#pauses) has the details.
