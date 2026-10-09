---
title: Who can do what
description: TaruBot's three levels of access, how officers are recognized, and which commands need a server manager.
sidebar:
  order: 2
---

TaruBot checks who may run a command every time it runs, against the member's current Discord permissions and roles. It recognizes three levels.

## Anyone

Every human member can link their own characters, choose a main and a nickname setting, check their own guest status and background work, report a problem, and use the utilities. Confirmed FC members can also record deposits and read the ledger. Holders of the Member or Guest role can [suggest features](/tarubot/admin/suggestions/) in the FC's own server.

## Officers

A member is a TaruBot **officer** in a server when either is true:

- they have Discord's **Manage Server** permission there; or
- they hold the server's bound **Officer role** and TaruBot backs it: one of their linked characters holds the FC rank chosen with [`/config officer_rank`](/tarubot/reference/commands/#config-officer_rank), or a server manager granted them officer access with [`/officer grant`](/tarubot/reference/commands/#officer-grant), and they haven't been revoked with `/officer revoke`.

TaruBot gives the Officer role to exactly those members. A role given by hand alone doesn't count: its holder gets **Officers only**, and TaruBot removes the role at its next pass. While TaruBot can't tell yet, for example before a new link's first roster check, a member who already holds the role keeps it. See [Officers](/tarubot/admin/officers/).

The Officer role grants TaruBot's officer commands only. It carries no Discord permissions, and it doesn't let anyone manage Discord roles or channels. A revocation takes effect at once, even while Discord is still removing the role.

Officers run the day-to-day commands: the guest decisions, assigning and unassigning characters, withdrawals and corrections in the ledger, the ledger, officer notification, guest review and changelog channels ([`/config changelog`](/tarubot/reference/commands/#config-changelog) for update posts), and `/config show` and `/config validate`.

Officers, Officer-role holders included, also build the [self-service role menu](/tarubot/admin/self-service-roles/) on the dashboard's **Role menu** page: they can add any role that passes the menu's checks, and reset the menu. TaruBot doesn't check their own Discord permissions or role position for this; the menu's checks and where TaruBot's own role sits decide what can be added. Once members and guests can pick from the menu, a role on it is one anyone with Member or Guest can give themselves.

## Server managers

A **server manager** has both **Manage Server** and **Manage Roles**. Bot officer access alone never counts: changing who holds authority can't be delegated through the Officer role itself. Only server managers can:

- choose the Officer and FC Leader roles ([`/config roles officer`](/tarubot/reference/commands/#config-roles-officer), [`/config roles leader`](/tarubot/reference/commands/#config-roles-leader));
- set the officer rank and the role layout ([`/config officer_rank`](/tarubot/reference/commands/#config-officer_rank), [`/config role_layout`](/tarubot/reference/commands/#config-role_layout));
- grant, revoke and reset officer access ([`/officer`](/tarubot/reference/commands/#officer-grant));
- run [`/setup onboarding`](/tarubot/reference/commands/#setup-onboarding), which also needs **Manage Channels**;
- run [`/setup overrides`](/tarubot/reference/commands/#setup-overrides); its `confirm:true` also needs **Administrator**, or owning the server.

Some officer commands need more once a feature is on:

- **Member and Guest roles** need Discord's Manage Roles to choose, and a server manager once onboarding is on.
- **Linking or unlinking the FC** needs a server manager once an officer rank is set, because the FC's roster then decides who is an officer.

## Role hierarchy

Discord's role order applies on top of these levels:

- TaruBot can only manage a role below its own highest role.
- When a manager chooses a role for TaruBot, the role must be below the manager's own highest role, unless they own the server.
- While an Officer role is bound, `/officer grant`, `revoke` and `reset` also check that the manager's highest role is above it (the server owner is exempt) and that TaruBot can manage it.
- The self-service role menu doesn't use the officer's own position: any officer can add a role below TaruBot's highest role that passes the menu's checks.

## What Discord shows

Discord can't hide a command from members based on a role TaruBot manages, so most officer commands appear in everyone's command list and TaruBot refuses non-officers with **Officers only**. Two commands ask Discord to hide them by default:

- `/setup` (`onboarding` and `overrides`), from members without Manage Server, Manage Roles and Manage Channels;
- `/officer`, from members without Manage Server and Manage Roles.

A server admin can change who sees a command under **Server Settings → Integrations → TaruBot**. That changes only visibility: TaruBot checks access again whenever a command runs, and whenever someone clicks one of its buttons.

## Delegated officers and `/assign`

An officer who is an officer only through the Officer role can vouch for a member's character with [`/assign`](/tarubot/reference/commands/#assign), but that link can't make anyone an officer: the character's in-game rank counts for officer access only when the link was verified by the owner, imported, or assigned by a server manager. Otherwise one officer could appoint another. See [Managing members' characters](/tarubot/admin/member-links/).

The FC Leader role gives access to staff channels under onboarding, but not officer commands.

## Every command

The [command reference](/tarubot/reference/commands/) has a **Who can use it** line for every command.
