---
title: Officers
description: Give officer access by in-game FC rank, by explicit grants, or both, and bind an existing Officer role safely.
sidebar:
  order: 6
---

TaruBot officers run its officer commands. Anyone with Discord's Manage Server is always an officer. Everyone else becomes one by holding the server's **Officer role**, which TaruBot gives out from two sources:

- **the in-game rank**: members whose linked character holds a chosen FC rank; and
- **explicit grants** that a server manager records with `/officer grant`.

All of these commands need a server manager (Manage Server and Manage Roles); see [Who can do what](/tarubot/admin/access/).

```text
/config officer_rank rank:Officer
/config officer_rank unset_rank:true
/config roles officer role:@Officer adopt_holders:false
/officer grant member:123456789012345678 reason:New FC officer
/officer revoke member:123456789012345678 reason:Stepped down
/officer reset member:123456789012345678 reason:Back to the in-game rank
```

## By in-game rank

[`/config officer_rank`](/tarubot/reference/commands/#config-officer_rank) names the FC rank whose holders get officer access:

- A linked character with confirmed FC membership and that rank on an accepted roster qualifies its owner. With several linked characters, any one is enough.
- Rank names match regardless of case, spacing and Unicode forms. This is the **FC rank**, not the character's Grand Company rank.
- A rank alone grants nothing until an FC is linked and an Officer role is bound; the reply says what's still missing.
- A changed rank rechecks every member. Naming the saved rank again, or `unset_rank:true` with no rank set, changes nothing and says so.
- `unset_rank:true` stops rank-based access, so only explicit grants give it.

## By explicit grant

- [`/officer grant`](/tarubot/reference/commands/#officer-grant) gives a current member officer access whatever their rank.
- [`/officer revoke`](/tarubot/reference/commands/#officer-revoke) takes it away, even when their rank qualifies. It applies to TaruBot's own checks at once, even while Discord is still removing the role, and works for a member who has left.
- [`/officer reset`](/tarubot/reference/commands/#officer-reset) removes the grant or revocation, so the in-game rank decides again. With no rank set, only `/officer grant` then gives access, and the reply says so. It also works for a member who has left. With no grant or revocation to remove, it says so and records nothing.

Every grant, revocation and reset needs a reason, is audited, and rechecks the member. While an Officer role is bound, each first checks that your highest role is above it (the server owner is exempt) and that TaruBot can manage it.

The `member` option suggests members as you type. You can also paste a user ID or mention, which is how you name someone who has left.

## Binding the Officer role

[`/config roles officer`](/tarubot/reference/commands/#config-roles-officer) chooses the role. Binding a role normally gives each of its current human holders a recorded officer grant, so nobody loses access.

Add `adopt_holders:false` to bind it without granting anyone. Officer access then comes only from the rank and explicit grants, and TaruBot removes the role from holders who have neither once it rechecks them. The option exists only on `/config roles officer`, and the choice is audited.

`/officer grant` and `/officer revoke` also work before any Officer role is bound: the decision is recorded (the reply reads "Applies once an Officer role is set") and takes effect when a role is bound.

To switch an existing staff role over to rank-based access without anyone losing it by mistake, work in this order:

1. Set the rank: `/config officer_rank rank:Officer`.
2. Grant the exceptions, the people who should be officers without the rank: `/officer grant`.
3. Bind the role without adopting its holders: `/config roles officer role:@Officer adopt_holders:false`.

Binding queues an immediate recheck. Because the grants were recorded first, the exceptions keep the role; holders with neither the rank nor a grant lose it.

## Delegated officers

Officers who hold only the Officer role can assign characters to members with `/assign`, but such an assignment never makes anyone an officer: only a verified claim, an imported link, or an assignment by a server manager with Manage Roles lets a character's rank count. This keeps officer access from being handed on indirectly. See [Managing members' characters](/tarubot/admin/member-links/).

The FC Leader role doesn't grant officer commands either.

Discord can't hide commands based on a configurable role, so TaruBot checks officer access itself every time a command runs. `/setup` and `/officer` also ask Discord to hide them from members without the manager permissions.
