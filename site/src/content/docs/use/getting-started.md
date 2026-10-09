---
title: Getting started
description: What TaruBot does for members, what its roles mean, and how to read its replies.
sidebar:
  order: 1
---

TaruBot connects a Discord server to a Final Fantasy XIV Free Company. You prove which characters are yours through the Lodestone, and TaruBot gives you the roles that match: Member while one of your characters is in the FC, Guest otherwise. It can also keep your nickname in step with your main character, and it keeps the FC's gil ledger.

## Where commands work

- **In a server only.** Every TaruBot command is a slash command that works inside a server where TaruBot is set up. None of them works in direct messages.
- **Replies are private.** Only you can see TaruBot's reply to your command. Nobody else in the channel sees it.
- **No pings.** TaruBot never pings anyone, even when a reply or post names a member or a role.

Type `/` in any channel you can write in, and Discord lists the commands with their options. The [command reference](/tarubot/reference/commands/) describes every one.

## Roles

TaruBot manages up to four roles. Your server may call them something else.

| Role | Who gets it |
| --- | --- |
| **Member** | Anyone with a linked character that the FC's roster lists. |
| **Guest** | Anyone whose linked characters are all outside the FC (any linked character counts while no FC is linked); former members; applicants an officer approved; and members an officer granted Guest. |
| **Officer** | Members whose character holds the FC rank the server chose for officers, and anyone a server manager granted officer access. It unlocks TaruBot's officer commands, not Discord permissions. |
| **FC Leader** | The member whose linked character leads the FC. |

TaruBot adds and removes these roles to match the FC's roster and your links, and it repairs one that is changed by hand. With several linked characters, the best one counts: any character in the FC makes you a Member. An officer can also grant or revoke Guest access, and those decisions last until an officer changes them.

To get started, [link your character](/tarubot/use/link-a-character/).

## Reading a reply

Every reply is one card:

- **The title** says the outcome first: "Deposit recorded", "Officers only".
- **The description** says what happened and what happens next.
- **The fields** hold the facts, and the last one names the next step as an exact command.
- **Buttons**, where there are any, do the obvious next thing, such as **Check again** or **View history**.

Much of what TaruBot does, such as changing your roles or posting a ledger entry, happens in the background a moment later. Replies mark that work with a status marker, such as `… QUEUED`, `✓ DONE` or `‖ PAUSED`. A reply only says `✓ DONE` once Discord has confirmed the change. [Replies and error codes](/tarubot/reference/replies/#status-markers) lists every marker.

When a command can't do what you asked, the card says why and what to try, and its footer reads `Code <code> · Ref <number>`. If you ask an officer or the bot's maintainers for help, include that line: the Ref leads them straight to the bot's log entry.

## What's new

Your server may have a channel where TaruBot posts what's new after it's updated: one short message, "TaruBot updated to vX.Y.Z", with a sentence for each release since the last post that changed something members, guests or officers can notice, in Discord, on the dashboard or on this site. An update that changes nothing anyone can notice isn't posted. The officers choose the channel, so ask them where it is. For the technical detail, [`/version`](/tarubot/reference/commands/#version) lists the recent commits, and each post links the full changelog.

## Your data

TaruBot keeps what it needs to decide access and keep the ledger exact:

- **Your links.** Which characters you linked, how, and when. `/unclaim` ends a link, but the ended link is kept as history.
- **What you record.** Ledger entries are permanent: a mistake is fixed by a correction entry, never by editing or deleting one.
- **An audit trail** of changes, such as links, grants and settings, with who made them.
- **Public Lodestone data** for your characters: name, world, FC and rank, as the Lodestone shows them.

Your Lodestone token is never stored; only a one-way fingerprint of it is. A guest application's answers go to the officers' review channel, never to a public reply.

`/issue` sends a report to the people who run this TaruBot deployment. It includes your description, your Discord username and ID, your linked characters and settings in this server, your recent TaruBot activity, and the bot's health. Known secrets are removed first. See [Progress and problems](/tarubot/use/progress-and-problems/#report-a-problem).

`/suggest` posts an idea publicly on GitHub, in the FC's own server. Only your cleaned text and TaruBot's version are posted, never your name, your characters or anything about the server. See [Suggest a feature](/tarubot/use/suggest-a-feature/#what-goes-public).

For the full picture, see [Data and privacy](/tarubot/architecture/data-and-privacy/).
