---
title: Who can do what
description: How TaruBot decides who may use each function, through permissions carried by the roles it manages, how officers are recognized, what needs a server manager, and who can use the dashboard.
sidebar:
  order: 2
---

TaruBot checks every command, button and dashboard change against the person's current Discord roles and permissions, each time it runs. Every function it guards has a named **permission**, and people get permissions only from the roles TaruBot manages, plus a few everyone has:

| Who | What they can do |
| --- | --- |
| Everyone in the server, lobby newcomers included | Link their own characters, ask for a roster check, apply for guest access and report a problem. Their own records, `/main`, `/nickname`, `/unclaim` and the utilities need no permission at all. |
| Holders of the **Member** role | Everything above, plus [suggest features](/tarubot/admin/suggestions/) in the FC's own server, open [mod mail](/tarubot/admin/mod-mail/) cases, pick their own roles on the dashboard's **My roles** page, and read the ledger and record deposits while a linked character is a confirmed FC member |
| Holders of the **Guest** role | Everything everyone can do, plus suggest features, mod mail and My roles |
| **Officers**, through the Officer role | Every [officer permission](#officer-permissions), plus the ledger and My roles |
| **Server managers** | Every permission, including the ones [only they](#server-managers) can have |

The FC Leader role opens staff channels under onboarding, but carries no TaruBot permission. The permissions each role carries are fixed in this release.

## Officers

A member is a TaruBot **officer** in a server when they hold the server's bound **Officer role** and TaruBot backs it, and they haven't been revoked with `/officer revoke`. TaruBot backs it when:

- one of their linked characters holds the FC rank chosen with [`/config officer_rank`](/tarubot/reference/commands/#config-officer_rank), through a link that [counts for rank](#links-that-count-for-rank); or
- a server manager granted them officer access with [`/officer grant`](/tarubot/reference/commands/#officer-grant).

Discord's **Manage Server** permission on its own doesn't make anyone an officer. A server manager, who also has Manage Roles, holds every permission anyway.

TaruBot gives the Officer role to exactly those members. A role given by hand alone doesn't count: its holder gets **Officers only**, and TaruBot removes the role at its next pass. While TaruBot can't tell yet, for example before a new link's first roster check, a member who already holds the role keeps it, but it gives officer permissions only once a roster confirms the rank. See [Officers](/tarubot/admin/officers/).

The Officer role grants TaruBot's officer permissions only. It carries no Discord permissions, and it doesn't let anyone manage Discord roles or channels. A revocation takes effect at once, even while Discord is still removing the role.

### Officer permissions

| Area | Officers can |
| --- | --- |
| Configuration | See the configuration and health check (`/config show`, `/config validate`, the **Server configuration** page); choose the ledger, update and officer notifications channels; open or close guest applications |
| Members | Look up other members' characters and guest records; link a character to a member with [`/assign`](/tarubot/reference/commands/#assign); remove a link with [`/unassign`](/tarubot/reference/commands/#unassign), except one that [counts for rank](#links-that-count-for-rank) |
| Roster | See everyone's background work (`/sync status`, the **Background work** page); force a roster check with `/refresh force:true` |
| Guests | Approve and deny applications; grant, revoke and reset guest access |
| Ledger | Record withdrawals, corrections and the opening balance; see ledger details and a previous FC's ledger; read the ledger and record deposits without the membership condition |
| Mod mail | Read every case and who read it; reply to, close and reopen cases; turn mod mail on or off |
| Role menu | See the [self-service role menu](/tarubot/admin/self-service-roles/), drafts included; edit it, add roles and publish them |

For the Role menu, TaruBot doesn't check the officer's own Discord permissions or role position; the menu's checks and where TaruBot's own role sits decide what can be added. A role in a published category is one anyone with Member or Guest can give themselves on My roles.

## Server managers

A **server manager** has both **Manage Server** and **Manage Roles** (the server owner and Administrator have both). Server managers hold every permission. Some can't go to anyone else, because whoever holds them could give themselves the rest: changing who holds authority can't be delegated through the Officer role itself. Only server managers can:

- link or unlink the FC ([`/config fc link`](/tarubot/reference/commands/#config-fc-link), [`/config fc unlink`](/tarubot/reference/commands/#config-fc-unlink)), since the FC's roster decides who is a member;
- choose any of the four roles TaruBot manages: Member, Guest, Officer and FC Leader ([`/config roles`](/tarubot/reference/commands/#config-roles-member)), and set the role layout ([`/config role_layout`](/tarubot/reference/commands/#config-role_layout));
- set the officer rank ([`/config officer_rank`](/tarubot/reference/commands/#config-officer_rank));
- grant, revoke and reset officer access ([`/officer`](/tarubot/reference/commands/#officer-grant));
- make `/assign` links that count for rank, and remove links that do with `/unassign`;
- run [`/setup onboarding`](/tarubot/reference/commands/#setup-onboarding), which also needs **Manage Channels**;
- run [`/setup overrides`](/tarubot/reference/commands/#setup-overrides); its `confirm:true` also needs **Administrator**, or owning the server.

Before TaruBot is set up in a server, only a server manager can start it: the first `/config` change or `/setup onboarding`.

## Links that count for rank

A linked character's in-game rank counts for the Officer and FC Leader roles only through a link that **counts for rank**: one its owner verified with `/claim` and `/verify`, an imported one, or one a server manager made with `/assign`. A link an officer made with `/assign` counts for FC membership, but never for rank, so one officer can't make another officer, or anyone FC Leader. For the same reason, removing a link that counts for rank from someone else needs a server manager. See [Managing members' characters](/tarubot/admin/member-links/).

## Role hierarchy

Discord's role order applies on top of permissions:

- TaruBot can only manage a role below its own highest role.
- When a manager chooses a role for TaruBot, the role must be below the manager's own highest role, unless they own the server.
- While an Officer role is bound, `/officer grant`, `revoke` and `reset` also check that the manager's highest role is above it (the server owner is exempt) and that TaruBot can manage it.
- The self-service role menu doesn't use the officer's own position: any officer can add a role below TaruBot's highest role that passes the menu's checks.

## The dashboard

When the dashboard is on, its pages check the same permissions, against the person's current Discord roles and permissions, and again on every change:

| Who | Pages |
| --- | --- |
| Holders of the Member or Guest role | My roles and Mod mail (their own cases), while TaruBot doesn't have Administrator in the server |
| Officers | Server configuration, My roles, Role menu, Background work and Mod mail (every case) |
| Anyone else, including people in the lobby | No signed-in pages; anyone can open the public [status page](/tarubot/use/progress-and-problems/#is-tarubot-up) |

While TaruBot has Administrator in a server, members and guests can't open its pages at all: the pages everyone can reach never run beside a bot that can do anything in the server. Use [`/setup overrides`](/tarubot/reference/commands/#setup-overrides), then remove Administrator once `/config validate` says it's no longer needed. Someone who has just lost Member or Guest can keep viewing for up to a minute, but any change they send is checked again first and refused.

## What Discord shows

Discord can't hide a command from members based on a role TaruBot manages, so most officer commands appear in everyone's command list and TaruBot refuses people without the permission with **Officers only**, or **Server managers only**. Two commands ask Discord to hide them by default:

- `/setup` (`onboarding` and `overrides`), from members without Manage Server, Manage Roles and Manage Channels;
- `/officer`, from members without Manage Server and Manage Roles.

A server admin can change who sees a command under **Server Settings → Integrations → TaruBot**. That changes only visibility: TaruBot checks permissions again whenever a command runs, and whenever someone clicks one of its buttons.

## Every command

The [command reference](/tarubot/reference/commands/) has a **Who can use it** line for every command.
