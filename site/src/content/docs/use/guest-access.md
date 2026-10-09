---
title: Guest access
description: How visitors get the Guest role, how to apply without a character, and how to check your status.
sidebar:
  order: 4
---

The Guest role is for people who aren't in the Free Company but belong in the server: friends, alliance members and former members. There are three ways to get it. With it, you can also [pick your own roles](/tarubot/use/pick-your-roles/) on the web, just as members can.

## With a linked character

The simplest way: [link a character](/tarubot/use/link-a-character/). If none of your linked characters is in the FC, or the server has no FC linked, TaruBot gives you the Guest role automatically. If one of them is in the FC, you get the Member role instead.

## By applying

If you don't want to link a character, you can apply to the officers with [`/apply`](/tarubot/reference/commands/#apply), when the server takes applications. Use it in the lobby or any channel you can see.

`/apply` opens a short form with two required answers, each 10 to 300 characters:

- **Introduce yourself**: a short introduction for the officers.
- **Why join this server?** What interests you, and how you found the server or who invited you.

Your answers go only to the officers' review channel, never to a public reply. Submitting grants nothing yet: an officer approves or denies the application, and TaruBot sends you a direct message with the decision.

- **Approved:** you get the Guest role.
- **Not approved:** the message gives the officers' reason, if they gave one, and when you can apply again (one day later by default).

Submitting the form again while your application waits returns that same application, and your first answers stay. If you leave the server, a waiting application is cancelled; apply again after you rejoin.

:::note
If you can't receive direct messages from server members, you won't get the decision message, but the decision still stands. Check [`/guest status`](/tarubot/reference/commands/#guest-status) instead.
:::

### When `/apply` says no

- **"Guest applications are not open in this server."** The officers haven't opened applications, or have closed them. Ask an officer about Guest access; they can also grant it directly.
- **"No application needed."** You already have a linked character, or already have Member or Guest access. Your access follows your characters and the FC's roster; if a role looks missing, TaruBot restores it by itself.
- **"You can apply again later."** A recent application was denied. The reply says when you can apply again.

## From an officer

An officer can grant you Guest access directly with `/guest grant`, with or without an application. Officers can also revoke Guest access: a revocation removes every kind of Guest access, including the automatic kind, until an officer grants it again. It never removes the Member role, which follows the FC's roster.

## Check your status

[`/guest status`](/tarubot/reference/commands/#guest-status) shows your guest applications and their outcomes, any grant and where it came from (an approved application, an officer, the previous bot, or the server's launch), any revocation, whether you currently qualify through a linked character, and the progress of your role and message deliveries.
