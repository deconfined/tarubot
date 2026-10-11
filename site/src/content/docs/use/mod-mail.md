---
title: Message your officers
description: Open a private mod mail case with /modmail or on TaruBot's dashboard, continue the conversation there, and who can read it, what Discord shows and how long it's kept.
sidebar:
  order: 6
---

Mod mail is a private conversation between you and your server's officers. You open a case with **`/modmail`** in Discord or with **Open a case** on your server's TaruBot dashboard, and the conversation then continues on the dashboard, never in a Discord channel. Use it for anything you'd rather not post publicly: a problem with another member, a question about your access, or an appeal.

:::note[Where to find it]
Mod mail needs a **2.43.0 or newer** TaruBot with its dashboard turned on, and your officers turn it on for your server. If `/modmail` says it isn't turned on, ask an officer. [`/dashboard`](/tarubot/reference/commands/#dashboard) gives you the dashboard's address.
:::

## Who can read it

- **All of your server's officers.** Every officer can read every case, see that you opened it, and see each reply. There's no way to write to just one officer.
- **You.** Only you and the officers can open your case on the dashboard. Another member who tries your case's address gets the same "Page not found" as an address that doesn't exist.

Officers can see who opened each case: mod mail is never anonymous. TaruBot records each time someone opens a case's page or sees its topic in a list (who and when), and officers can see that list.

## Who can use it

Anyone with the server's **Member** or **Guest** role. Guests can use it just like members; someone still in the lobby can't. While TaruBot still has Discord's Administrator permission in the server, members and guests can't use mod mail; your officers know how to fix that.

In a Discord time-out you can't run `/modmail`, since Discord takes slash commands away during one, but you can still open a case with **Open a case** on the dashboard and reply to your cases there, for example to talk to the officers about the time-out.

## Open a case

There are two ways, and they work the same: the same form, the same limits and the same notice that all officers can read it.

**With `/modmail` in Discord:**

1. **Run `/modmail`** in the server. A form opens. It says at the top that all of the server's officers can read what you send.
2. **Write a topic** (up to 100 characters), a few words officers see in their list, and your **message** (up to 4,000 characters).
3. **Send it.** TaruBot answers privately with **Case #N opened** and an **Open case #N** button that takes you to your case on the dashboard. Sign in with Discord if it asks.

**On the dashboard:**

1. **Open Mod mail** in your server's navigation and choose **Open a case**. The form opens over the page, right next to the button (a sheet from the bottom on a phone), and says at the top that all of the server's officers can read it.
2. **Write a topic and your message**, with the same limits as above.
3. **Choose Open case.** Your new case opens, with **Case opened.** at the top. If something needs fixing, such as an empty topic, the form comes back with what you typed and says what to change. **Close** or Escape closes the form without sending anything.

The officers are told a new case is open, but not what it says or who sent it: they read it on the dashboard.

You can have up to 3 open cases in a server at once, and open up to 5 new ones in any 24 hours. If you hit a limit, add to one of your open cases instead: the dashboard's **Open a case** button is greyed out then, and says why next to it.

## On the dashboard

Choose **Mod mail** in your server's navigation (it's listed while mod mail is on) to see your cases, open ones first, each with its topic, what it's waiting on and when something last happened. Open one to read the conversation:

- **You** marks what you wrote.
- An officer's reply shows **their server name**, or **The officers** when they chose to sign it that way. Either way it's an officer of your server.
- Lines such as **Closed by the officers** or **Reopened by you** show when the case changed.

Write in **Your reply** and choose **Send reply**. Your reply appears in the conversation, and the case goes back to waiting on the officers. On a phone the page works the same way. Messages keep their line breaks; nothing you write is formatted or turned into links.

When an officer replies, TaruBot sends you a Discord DM: "An officer replied to your mod mail case #N in ⟨your server⟩", with a button to the case. The DM never includes the reply itself. If your DMs are closed, just check the dashboard. You get at most one DM per case every 10 minutes, and none for something you've already read on the dashboard.

## Close and reopen

Either you or an officer can close a case with **Close this case**, for example once your question is answered. A closed case stays readable. To reopen it, write a reply: the reply box says **Reply to reopen this case**. If an officer closes it, you get a DM saying so.

You can't delete a case. TaruBot deletes a closed case, with its whole conversation and its list of who opened it, **90 days after it's closed**; reopening it cancels that, and closing it again starts the 90 days over.

## What Discord sees

Only `/modmail`'s opening form passes through Discord, as part of the command; a case opened on the dashboard doesn't touch Discord at all. Your topic and messages never appear in any Discord channel or DM, so they aren't in Discord's search or any channel's history. TaruBot doesn't read messages or DMs at all.

TaruBot keeps your topic and messages encrypted in its database, with a key kept separately on the server it runs on, so a copy of the database alone holds only scrambled text. Whoever runs your TaruBot can still reach them, as they can everything TaruBot holds. See [mod mail's data](/tarubot/architecture/data-and-privacy/#mod-mail).

## If something goes wrong

- **"Mod mail isn't turned on in this server"** (or a greyed-out **Open a case** saying it's turned off): your officers haven't turned it on, or have turned it off. Cases you already have stay readable on the dashboard, and you can still reply to them.
- **"No new case right now"** (or a greyed-out **Open a case** naming the limit): you've reached the limit of open cases, or of new cases in 24 hours. Add to an open case on the dashboard.
- **`/modmail` doesn't show up or can't be used** while you're in a time-out: use **Open a case** on the dashboard instead.
- **"This message can't be read with this TaruBot's current key."** shows instead of a message: the server's mod mail key changed. Tell an officer.
- **A Page not found** for one of your own cases: check you're signed in as yourself, and that you still have the Member or Guest role. A case is also gone once it has been closed for 90 days.
