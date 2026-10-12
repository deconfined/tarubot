---
title: Mod mail
description: Turn mod mail on for your server, answer cases in the dashboard's inbox, sign replies with your name or as the officers, and what members, Discord and the database see.
sidebar:
  order: 6
---

Mod mail lets members and guests write privately to your server's officers. A member opens a case with [`/modmail`](/tarubot/reference/commands/#modmail) or with **Open a case** on their own Mod mail page; you read and answer it on the dashboard's **Mod mail** page. Discord only carries a ping with the case number. The members' side is described in [Message your officers](/tarubot/use/mod-mail/).

:::note[Releases]
Mod mail needs a **2.43.0 or newer** release with the [dashboard](/tarubot/admin/health-checks/#dashboard) turned on and a mod mail key set by whoever runs your TaruBot.
:::

## Turn it on

Mod mail is off in every server until an officer turns it on. Choose **Mod mail** in the server's navigation (officers always see it). The card beside the inbox says whether it's on, and lists what it needs, each **[OK]** or **[FAIL]**:

- **Encryption key is set.** Whoever runs your TaruBot sets `MODMAIL_KEY` on its host ([configuration](/tarubot/deploy/configuration/#optional-mod-mail)). Without it nothing can be opened or read.
- **Dashboard is on.** Always true when you're looking at the page.
- **Officer notifications channel is set**, with [`/config officer_notifications`](/tarubot/reference/commands/#config-officer_notifications): that's where TaruBot pings officers about cases. Without it officers would never hear about a case, so mod mail can't be turned on.

A fourth line, **Pings notify officers**, is **[OK]** or **[WARN]**: whether TaruBot can mention the Officer role in that channel ([below](#let-pings-notify-officers)). It's a warning, not a requirement, so it never stops you turning mod mail on, but without it pings arrive silently.

When every check passes, choose **Turn mod mail on**. Members and guests can then open cases with `/modmail` or on their Mod mail page, and they see **Mod mail** in their dashboard navigation. Any officer can turn it on or off; TaruBot records who did and when in its audit log.

**Turn mod mail off** stops new cases only. Existing cases stay readable, and you and the members can still reply to them and close them.

The card also warns when:

- a check fails while mod mail is on, for example after the officer notifications channel was unset (`/config validate` warns about that too);
- TaruBot has Administrator in the server: members and guests can't open or read cases until it doesn't ([`/setup overrides`](/tarubot/reference/commands/#setup-overrides));
- Discord changes are paused, so pings and DMs wait until they resume;
- no Officer role is set, so pings mention nobody.

### Let pings notify officers

A ping mentions the Officer role, but Discord only notifies the role's holders when the role is mentionable or when TaruBot has **Mention @everyone, @here and All Roles** (Discord's **Mention Everyone** permission) in that channel. Keep the Officer role non-mentionable, so members can't ping all officers, and allow the permission for TaruBot in the officer notifications channel only:

1. In Discord, open the officer notifications channel's settings (**Edit Channel**), then **Permissions**.
2. Add the **TaruBot role** (the role named after TaruBot that Discord manages for it) to the channel's permissions if it isn't there. Use the role rather than TaruBot itself: TaruBot rewrites its own entry there when lobby onboarding keeps the channel's access in line, and Discord may refuse to rewrite an entry carrying a permission TaruBot doesn't hold elsewhere, while TaruBot never writes its role's entry.
3. Set **Mention @everyone, @here and All Roles** to allow (the green check), and save.

You set this by hand: TaruBot never gives itself a permission, and Discord wouldn't let it without Administrator. The Mod mail card shows **[OK] Pings notify officers** once it's in place, and so does [`/config validate`](/tarubot/admin/health-checks/#tarubots-role-and-channel-view) while mod mail is on. Until then both warn, with these steps:

- **Pings will post but notify nobody**: TaruBot can't mention the Officer role there.
- **Pings can't be posted**: TaruBot can't see the channel or post in it (it needs View Channel, Send Messages, Embed Links and Read Message History there), or can't find it at all, for example after it was deleted (choose it again with `/config officer_notifications`).
- **Only while TaruBot has Administrator**, or **only through Mention Everyone granted server-wide** (on TaruBot's role, which `/config validate` says it never needs, or on @everyone): pings work now, but would go quiet once that comes off, so add the channel permission first.

Don't give TaruBot Mention Everyone anywhere else. `/config validate` warns when one of TaruBot's roles has it server-wide, or when another channel allows it to TaruBot, and, while mod mail is off, about the officer notifications channel's allow too, since nothing needs it then. TaruBot's pings never mention @everyone or @here even with the permission: each ping can mention only the Officer role.

## Pings

TaruBot posts in the officer notifications channel when a case is opened (**Mod mail case #N opened**), whether with `/modmail` or on the dashboard, and when the member replies (**New reply on mod mail case #N**), with an **Open case #N** button. The post mentions the server's Officer role, and only that role, so the people who handle cases are notified (once TaruBot may [mention it there](#let-pings-notify-officers)). It never names the member or quotes the case, so it's safe in a channel every officer reads.

Pings are coalesced: at most one per case every 10 minutes, and at most one reply ping per member every 10 minutes across all their cases, so a member writing several replies in a row, or in several cases, doesn't flood the channel. The ping still says there's something new; the case page shows everything. The ping never mentions @everyone.

## The inbox

The Mod mail page lists your server's cases, waiting on officers first, with the case that has waited longest at the top. Each row shows the case number, who opened it (their server display name, or **A former member** if they've left), the topic, what it's waiting on and for how long. Filter by **Open**, **Waiting on officers**, **Waiting on member** or **Closed**; each filter shows how many cases it holds. Times are UTC.

## Answer a case

Open a case to read the conversation. You always see who wrote each reply, and a **Member** badge marks the member's own messages.

Write in **Your reply**, then choose how to sign it:

- **Sign with my name** (the default): the member sees your server display name.
- **Sign as the officers**: the member sees **The officers**. Other officers still see that it was you, with a **Signed as the officers** badge.

You choose for each reply. Choose **Send reply**: the case then waits on the member, and the member gets a DM with a link, never your reply's text. DMs are coalesced to one per case every 10 minutes, and none is sent when the member has already read the case since. A member with DMs closed sees it on the dashboard.

## Close and reopen

**Close this case** when it's done; the member can close their own case too. Closing it sends the member a DM. The member sees **Closed by** your name, or **the officers**, following how you signed your latest reply in that case (the officers if you haven't replied). A closed case is deleted, conversation, read log and all, 90 days after it was closed.

**Reopen case** puts it back among the cases waiting on officers and cancels the deletion. Any reply, yours or the member's, reopens it too. A member with 3 open cases can't reopen another by replying until they close one, but your reply or Reopen always works, even if it leaves the member with more than 3 open: the limit stops members flooding the officers, and officers decide which cases stay open.

If someone else changed the case while you were reading it (a new reply, say), TaruBot refuses your Close or Reopen and shows the case as it is now: check the newest messages, then try again.

## Pausing a member's new cases

A server manager can [pause](/tarubot/admin/moderation/) one member's opening of new cases, for example after a flood of them. Officers can't, because mod mail is how members raise concerns about officers. The member's **Open a case** is greyed out with the reason beside it and `/modmail` refuses, but every case they already have stays usable: they can read it, reply and close it, and your replies still reach them.

## The read log

Every time someone opens a case's page, TaruBot records who and when, and whether they're the member or an officer (opening it again within a minute counts once). Seeing a case's topic in a list, the inbox or the member's own list, is recorded too, as **Saw the topic in a list** (once an hour). **Read log** at the bottom of a case, folded by default, lists the newest 50 and how many there are in all. Only officers see it.

The Mod mail pages check who you are on every visit, so an officer who is demoted or leaves the server can't keep reading cases.

## What TaruBot keeps

- **The text is encrypted.** Topics and messages are stored encrypted with the deployment's mod mail key, which never enters the database, so a database copy alone shows only scrambled text. Whoever runs your TaruBot holds the key. Its daily backup keeps an encrypted copy of the settings, key included, next to the database dump, so whoever can open the backups can read mod mail cases too: that's deliberate, so a lost host can be restored in full. TaruBot never puts the text in its logs, issue reports, audit log, pings or DMs.
- **Nothing in Discord.** TaruBot doesn't read messages or DMs: the member's first message comes with the `/modmail` form, or from the dashboard's form.
- **No deleting by hand.** Neither officers nor members can delete a case; TaruBot deletes it 90 days after it's closed. Mod mail isn't in TaruBot's long-lived audit log, apart from turning it on and off, so nothing there keeps who opened cases once they're gone.
- **Limits.** Each member can have 3 open cases and open 5 a day, counted together whether they use `/modmail` or the dashboard; messages are up to 4,000 characters, and a case holds up to 500 messages.
- **Time-outs.** Discord takes slash commands away from a member in a time-out, so they can't run `/modmail`, but they can still open a case on the dashboard and reply there, for example to appeal. Officers can open cases only with `/modmail`, and only while they hold the Member or Guest role: their Mod mail page is the inbox.

See [mod mail's data](/tarubot/architecture/data-and-privacy/#mod-mail) for the details.
