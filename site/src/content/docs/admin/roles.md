---
title: Roles and access
description: How TaruBot decides Member, Guest and FC Leader, how departures work, where TaruBot's own role sits, and the role layout switch.
sidebar:
  order: 4
---

Once you choose the Member, Guest, Officer and FC Leader roles, TaruBot manages them: it adds and removes each one to match the evidence it has, and repairs changes made by hand. Choosing a new role for a slot moves the members over and cleans the old role up; the old role itself stays in Discord.

## Who gets which role

Access comes from a member's **trusted links**: characters they verified with a Lodestone token, that an officer assigned, or that were imported from the previous bot. A pending `/claim` doesn't count, and neither does a character's FC as a profile shows it: FC membership comes only from the FC's roster.

TaruBot looks at all of a member's linked characters together:

- any character with **confirmed membership** in the linked FC gives **Member**;
- any such character holding the configured **officer rank** adds **Officer**, unless the link came from a delegated officer's assignment (see [Who can do what](/tarubot/admin/access/#delegated-officers-and-assign));
- a member whose linked characters are all outside the FC gets **Guest**. With no FC linked, any trusted link is enough for Guest.

This applies in every server, with or without onboarding. Onboarding only adds channel visibility on top of these roles; a server without `/setup onboarding` gets no channel changes.

Guest also comes from:

- **former membership**: a member whose FC character left keeps Guest;
- **grants**: an approved application, an officer's `/guest grant`, a grant imported from the previous bot, or one written when the server was first activated.

Member always wins: a member of the FC gets Member, never Guest, even if their Guest access was revoked.

## Revocations and resets

- [`/guest revoke`](/tarubot/reference/commands/#guest-revoke) is the lasting removal of every kind of Guest access: automatic, former-member and granted. It survives restarts and the member leaving and rejoining.
- [`/guest grant`](/tarubot/reference/commands/#guest-grant) restores a revoked member with a manual grant.
- [`/guest reset`](/tarubot/reference/commands/#guest-reset) removes both kinds of override: it lifts the revocation and ends every active grant. Ended grants are kept as history but no longer give Guest. With nothing to remove, it says so and records nothing.

Automatic Guest is worked out each time, never stored as a grant, so removing a member's last link removes it.

## Uncertain evidence

A roster that can't be read, or is older than the roster interval, is uncertain evidence. TaruBot never adds a new automatic role on uncertain evidence, but keeps a role a member already holds until it knows more. Explicit grants and revocations still apply meanwhile. [`/guest status`](/tarubot/reference/commands/#guest-status) shows whether a member currently qualifies through a link, separately from their grants.

## Departures

A departure is confirmed only by two complete rosters, read at least 60 seconds apart, that both leave the character out; TaruBot reads the second about a minute after the first. A character that reappears in between stays a member. Former-member Guest applies to the FC currently linked. A member who leaves the Discord server keeps their links and grants on record, and they apply again if they return.

## FC Leader

TaruBot recognizes the FC's leader from the leader's rank icon on the Lodestone roster, whatever your FC calls that rank. The FC Leader role marks status and, with onboarding on, gives access to staff channels, but it doesn't grant TaruBot's officer commands.

Rank names and leadership are stored with each accepted roster. While a departure is waiting for confirmation, the member keeps their last known rank. Missing or unrecognized rank or leader data keeps what a member already has, but can't grant a new role.

## Where TaruBot's role sits

TaruBot can give and take only roles below its own highest role. Place its role:

- **above** the four roles it manages (Member, Guest, Officer and FC Leader) and every role on the [self-service role menu](/tarubot/admin/self-service-roles/);
- **below** every role that holds moderation or admin powers TaruBot doesn't manage.

TaruBot can then give anyone any role below it: Officer, FC Leader, the menu roles and any other lower role. So could anyone who stole its bot token. This placement keeps your moderation and admin roles out of that reach, but the roles below still matter. `/config roles` lets Officer and FC Leader carry Kick Members, Ban Members or Manage Messages, so keep those powers on roles above TaruBot where you can.

Keep the menu roles below Officer, FC Leader and every moderation role too. Discord lets a role kick, ban, time out or rename only members whose highest role is lower, so a menu role placed above one of those roles would put everyone who picks it out of that role's reach, a moderation bot's included. The role menu refuses such a role and says which role to move it below; see [what a role must pass](/tarubot/admin/self-service-roles/#what-a-role-must-pass).

## Self-service roles

Roles on the [self-service role menu](/tarubot/admin/self-service-roles/) are kept apart from the four access roles, in both directions. The menu refuses Member, Guest, Officer, FC Leader and any role TaruBot is still cleaning up, and [`/config roles`](/tarubot/reference/commands/#config-roles-member) and [`/setup onboarding`](/tarubot/reference/commands/#setup-onboarding) refuse a role that's on the menu. Reconciliation adds and removes only the four roles and the ones it's cleaning up, so it never gives a menu role to everyone, or takes it from everyone who picked it.

## Role layout

While the server's **role layout** switch is on, TaruBot keeps the four roles displayed separately from online members (Discord's "Display role members separately"), in one consecutive block, highest first: **FC Leader → Officer → Member → Guest**, below TaruBot's own role.

- **Off by default.** A server first set up with `/config` or `/setup onboarding` starts with it off, so TaruBot never reorders or restyles your roles unasked. `/setup onboarding` never changes it. Servers imported from a previous bot start with it off too, and a server that already had the switch on keeps it.
- **Off.** TaruBot changes no role's display or position. Roles `/setup onboarding` creates keep Discord's default display. Role assignment is unaffected.
- **Changing it** takes a server manager: [`/config role_layout`](/tarubot/reference/commands/#config-role_layout) `enabled:true` or `enabled:false`. Turning it on first checks that TaruBot and you can manage every role, then queues one layout pass, which moves and restyles the roles at once. Turning it off queues nothing and doesn't undo the display or order already applied. Repeating the current value changes nothing.

Layout checks run after `/setup onboarding confirm:true`, role changes, a refresh and startup, only while the switch is on, and send only the changes needed. TaruBot moves the block to where the lowest managed role sits, keeps unrelated roles in their relative order, and verifies the result afterwards. With fewer than four roles configured, the block is smaller but keeps the same order.

Discord groups members by their highest displayed role, and hides empty groups. Grouping doesn't change who holds a role.

If a layout pass is blocked, [`/sync status`](/tarubot/reference/commands/#sync-status) says why. Fix the roles or TaruBot's position, then run `/setup onboarding confirm:true` or `/refresh` again.
