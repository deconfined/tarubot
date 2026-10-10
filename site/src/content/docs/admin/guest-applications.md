---
title: Guest applications
description: Open and close guest applications, choose the review channel, decide applications, and grant or revoke Guest directly.
sidebar:
  order: 8
---

Guest applications let a visitor ask for the Guest role without linking a character. They answer two short questions with `/apply`; officers read the answers in a staff channel and approve or deny.

Applications are **open only while all three are true**: the applications switch is on, a review channel is set, and a Guest role is set. The switch is separate from the channel, so closing applications keeps the channel.

## Open, close and choose the channel

[`/config guest_applications`](/tarubot/reference/commands/#config-guest_applications) takes any combination of its options and saves them together:

```text
/config guest_applications enabled:true
/config guest_applications enabled:false
/config guest_applications channel:#officer-chat
/config guest_applications enabled:true channel:#officer-chat
/config guest_applications unset_channel:true
```

- **`enabled:true`** opens applications. With no review channel or no Guest role, the switch is saved and the reply names what's still missing, while `/apply` stays closed.
- **Switching on checks the channel first**: the one named in the same call, or the one already saved. If that channel was deleted or TaruBot can't post there, the call is refused and nothing is saved; name a working channel with `enabled:true channel:#…`. If someone else changes the settings at the same moment, the call saves nothing and asks you to run it again.
- **`enabled:false`** closes applications and keeps the review channel. It never checks the channel, so a deleted channel can't stop you closing. Applications already waiting stay reviewable in their channel.
- **`channel:#…`** sets the review channel, and is always checked first, even while applications stay closed. Applications already posted stay reviewable where they were posted.
- **`unset_channel:true`** stops using a review channel without checking anything, which also leaves `/apply` closed.
- `channel` together with `unset_channel`, or no option at all, is refused as an input error.

Each changed setting is audited separately and rechecks the server. A request that matches what's saved changes nothing and says so. [`/setup onboarding confirm:true`](/tarubot/admin/setup/) switches applications on, and uses the officer room as the review channel when none is set.

`/config show` reads "Off · reviews in #channel" while the switch is off with a channel kept. `/config validate` checks the review channel only while applications are on; while they're off, it lists applications as closed.

Choose a **staff-only** channel for reviews: the review message holds the applicant's answers. Changing the officer room with `/setup onboarding` doesn't move reviews.

## What visitors see

A visitor without a linked character runs `/apply` in the lobby or any channel they can see. It opens a form with two required answers, each 10 to 300 characters:

- **Introduce yourself**
- **Why join this server?**, which asks how they found the community or who invited them.

While applications are closed, `/apply` answers "Guest applications are not open in this server. Ask an officer about Guest access." before any form opens, and a form opened earlier is refused the same way when it's sent. Visitors can still get Guest by linking a character, or from an officer's `/guest grant`.

Submitting grants nothing. Replies, status views and decision receipts never repeat the answers; only the review message shows them.

## Review an application

The review message in the review channel shows the applicant, when they applied, the outcome, both answers, and **Approve** and **Deny** buttons. Read the answers for spam before deciding.

You can also decide with commands; the `application` option suggests pending applications:

```text
/guest approve application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f
/guest deny application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f reason:Not part of our community
```

- **Approve** queues the Guest role and a direct message to the applicant.
- **Deny** grants nothing, sends a direct message with your reason if you gave one, and starts a cooldown before they can apply again (one day by default, set by the deployment's `GUEST_COOLDOWN_SECONDS`). A direct message that can't be delivered doesn't undo the decision.

Applications are tied to the applicant's current stay in the server: leaving cancels a waiting application, and a new form is needed after rejoining. Sending the form twice returns the same application without replacing the answers. Restarts keep answers and buttons, and a missing review message is recreated from the stored application when its work is retried.

If an applicant links a character before you decide, their access follows the character instead, and the application is no longer needed.

## Grant, revoke and reset directly

Officers can decide Guest access without an application:

```text
/guest grant member:123456789012345678 reason:Friend of the FC
/guest revoke member:123456789012345678 reason:Left the community
/guest reset member:123456789012345678 reason:Back to the automatic rules
```

- [`/guest grant`](/tarubot/reference/commands/#guest-grant) records a lasting manual grant, and restores a revoked member.
- [`/guest revoke`](/tarubot/reference/commands/#guest-revoke) removes every kind of Guest access until an officer grants it again. FC membership still gives the Member role.
- [`/guest reset`](/tarubot/reference/commands/#guest-reset) lifts the revocation and ends every active grant, so FC membership and linked characters decide again. Ended grants stay as history. With nothing to remove, it says so and records nothing.

[`/guest status`](/tarubot/reference/commands/#guest-status) with `member` shows an officer the member's applications, grants with where they came from (Application approved, Granted by an officer, Imported from the previous bot, Granted at launch), any revocation, the latest three deliveries, and **Full details (JSON)**.
