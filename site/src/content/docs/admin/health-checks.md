---
title: Health checks
description: Check the server's setup with /config show and /config validate, follow background work, and fix what they report.
sidebar:
  order: 10
---

## Settings and checks

[`/config show`](/tarubot/reference/commands/#config-show) lists every setting: the linked FC, the four roles, the officer rank, the channels, guest applications, onboarding and the role layout.

[`/config validate`](/tarubot/reference/commands/#config-validate) checks the setup without changing anything, and lists each check with a token:

- `[OK]` passed; `[WARN]` works but needs attention; `[FAIL]` stops a feature; `[OFF]` switched off; `[WAIT]` waiting for something, such as a first roster.
- It covers whether each role and channel exists, TaruBot's permissions and role position, its own role and channel view as if Administrator were off ([below](#tarubots-role-and-channel-view)), the linked FC and how fresh its roster is, onboarding, changes in Discord, the role layout, and whether Discord changes are paused. With onboarding on, it also warns when members and guests may not be able to read the [changelog channel](/tarubot/admin/notices-and-updates/#visibility-with-lobby-onboarding).
- The title gives the verdict: problems, warnings, or all checks passed.

**Run health check** on `/config show`, and **Re-check** on `/config validate`, run the checks again in place. Fix what a `[FAIL]` line names, then re-check. [Replies and error codes](/tarubot/reference/replies/#health-check-tokens) explains each token.

Run `/config validate` after setting a server up, after changing roles or channels in Discord, and whenever members report missing roles.

### TaruBot's role and channel view

Two sections of `/config validate` judge TaruBot's own access **as if Administrator were off**, so they show whether the server still depends on it. They read what Discord has already sent TaruBot, so right after a restart the Visibility section may ask you to try again in a minute.

**TaruBot's role:**

- **Administrator.** `[OK] Administrator: off`; `[WARN]` while TaruBot holds it and something below still needs it ("still needed until the items below are fixed"); or `[WARN] Administrator: no longer needed`, followed by exactly what to do: turn it off on TaruBot's own role (or @everyone), and remove any other role that gives it, such as an Officer role people also hold, from TaruBot. That's your cue to [remove it](/tarubot/admin/add-to-server/#the-setup-window).
- **The seven core permissions** (Manage Roles, Manage Nicknames, View Channel, Send Messages, Embed Links, Attach Files, Read Message History), grouped when they share an answer: `[OK]` from TaruBot's own role; `[WARN]` when one comes only from @everyone or from another role, since a change to that role takes it away; `[FAIL]` when one is missing, or `[WARN]` "missing without Administrator; grant it before removing Administrator" while it still holds Administrator.
- **Onboarding permissions**, only on a server with onboarding: all five of onboarding's (Manage Channels, Use Application Commands, Create Public Threads, Create Private Threads and Connect), `[FAIL]` when one is missing, or `[WARN]` while Administrator still covers it. A server without onboarding gets no row for them.
- **Role order:** `[OK]` when TaruBot's highest role is above every access role (and every role it's still cleaning up), otherwise `[FAIL]`, naming the roles to move it above. Discord's role order applies with Administrator too, so while TaruBot holds a shared Administrator role (one other people hold, such as an Officer role) that sits above roles its own role doesn't, those roles get a `[WARN]` instead: TaruBot manages them only through the shared role. Move TaruBot's own role above them before you remove the shared one; until then Administrator stays "still needed".
- **Never needed:** `[WARN]` for any of Manage Server, Manage Messages, Mention Everyone, Kick Members, Ban Members, Time Out Members and Manage Webhooks that a role of TaruBot's gives it, naming the roles, so you can take it away. What @everyone gives every member doesn't count here.

**Visibility**, on a server without onboarding:

- `[OK] TaruBot can see every channel`, adding "except K hidden on purpose" and naming them when some are, with how many of them are only inside a category hidden from TaruBot.
- `[WARN] Missing TaruBot overrides`: the categories (and the channels inside them) and channels TaruBot couldn't see without Administrator. While TaruBot holds Administrator it says `/setup overrides confirm:true` adds them; without it, to turn Administrator on for TaruBot first, and how many of them it can't even read until then.
- `[WARN] Posting channels without all four posting permissions`: a channel TaruBot posts in that lacks any of View Channel, Send Messages, Embed Links and Read Message History, with the same remedy.
- `[WARN] Configured channels where TaruBot's own entry denies Read Message History`: a channel you chose for a setting after `/setup overrides` covered it. `/setup overrides` lifts that deny while TaruBot holds Administrator.
- **Configured but denied to TaruBot on purpose:** a channel a setting names whose permissions deny TaruBot View Channel. Lift the deny or change the setting: `[WARN]` while Administrator still hides the problem, `[FAIL]` once it's off. If you've already lifted it and TaruBot still can't see the channel, [run the setup window again](/tarubot/admin/add-to-server/#the-setup-window) so it looks afresh.
- `[WARN] Private categories holding a configured channel`: a category TaruBot can't see that holds a channel a setting names, such as the ledger. `/setup overrides` leaves it alone, whether or not Administrator is on. Move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself ([why](/tarubot/admin/add-to-server/#the-setup-window)).
- `[OFF] Hidden on purpose`: channels that deny TaruBot View Channel on purpose and that no setting names, and channels with no entry of their own for TaruBot inside a category that denies it (counted apart, "inside a category hidden from TaruBot"). They're left alone. Once Discord hides a channel's details from TaruBot, this goes by what the last `/setup overrides confirm:true` recorded, so run the setup window again after adding or removing such a deny. A channel created later inside a category recorded as hidden on purpose counts as hidden with it, since Discord copies the category's deny into it.

**Visibility**, on a server with onboarding: onboarding's own channel pass gives TaruBot its access, so `[OK] Onboarding manages TaruBot's channel access` once it has. Until then, the channels it hasn't reached yet (including those whose TaruBot entry still carries `/setup overrides`' deny mask, which only onboarding's first pass with Administrator lifts) are a `[WARN]` (keep Administrator on until [`/sync status`](/tarubot/reference/commands/#sync-status) shows the pass finished) or a `[FAIL]` without Administrator (`/sync status` shows why the pass is waiting). A configured community-updates channel, which onboarding never manages, needs TaruBot's own access to all four posting permissions there.

`/config show`'s health line ends with how many of these rows (warnings and failures) `/config validate` asks you to review.

**The same count elsewhere.** On a server without onboarding, the channels behind the Missing, Posting, Masked, Denied and Private categories rows also raise [one officer alert](/tarubot/admin/notices-and-updates/#missing-channel-overrides) in the officer notifications channel, even while TaruBot still holds Administrator, and a deployment's readiness shows the total as an informational count. A server with onboarding raises no alert; readiness counts separately the channels its pass hasn't reached and a configured community-updates channel TaruBot can't post in.

**A refusal after `/setup overrides`.** Choosing a channel for a setting where TaruBot's own entry denies Read Message History, or turning onboarding on without Administrator where the entry denies Manage Permissions and Manage Channels (or Connect in a voice or stage channel), is refused with a card that says which permissions TaruBot's own entry denies and how to fix it: remove the deny from TaruBot's own entry (the member, not its role), or turn Administrator on for the step. A role permission can't lift a member entry's deny, so "give the TaruBot role…" wouldn't help.

## Background work

Officers get the server-wide view of [`/sync status`](/tarubot/reference/commands/#sync-status): recent runs, outstanding work, what runs next, and what needs attention. Each job line shows the raw job kind (such as `reconcile.user`), the first 8 characters of its ID, the attempt, when it runs next, and its stored diagnostic. **Full details (JSON)** attaches the complete view. `/sync status run_id:<id>` shows one run.

A failed job stops being listed once the same work succeeds after it; the job itself is kept as history.

What to do with each [status marker](/tarubot/reference/replies/#status-markers):

- `! BLOCKED`: a permission, the role order, or a deleted role or channel. Fix what the diagnostic names, then run `/config validate`. TaruBot retries blocked work by itself about every 10 minutes, and saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once.
- `‖ PAUSED`: Discord changes are off for the deployment. Only its operator can turn them back on.
- `✗ FAILED`: the job stopped after repeated errors. Tell the deployment's operator, who can retry it; the error was also reported to them if issue reports are on.
- `↻ WAITING`: it's waiting its turn, a Lodestone rate limit or a retry. Nothing to do.

Members see only their own requests and work, in plain words.

## Repeats and unsetting

A request that matches what's already saved changes nothing and replies with `= NO CHANGE`: naming the saved officer rank, a `/config guest_applications` request that matches the settings, `/main` naming the current main, `/nickname` repeating its setting, and `/officer reset` or `/guest reset` with nothing to remove. Nothing is saved, audited or queued.

Choosing the role or channel that's already saved with `/config roles`, `/config ledger`, `/config officer_notifications` or `/config changelog` is the exception: it's saved and audited again and rechecks the server, which is a handy way to requeue held work.

To stop using a setting, use its unset option: `unset_channel:true` for `ledger`, `officer_notifications`, `changelog` and `guest_applications`, `unset_role:true` for the `roles` commands, and `unset_rank:true` for `officer_rank`. Unsetting never deletes the Discord channel or role.

## Naming members

Every `member` option suggests server members as you type, matching display name, username, global name or nickname. You can also paste a user ID or an @mention, so you can name someone who has left the server. Where a member may name only themselves (`/characters` and `/guest status` for non-officers), they're offered only themselves.

## Members who leave

When a member leaves the Discord server, their links, grants and revocations stay on record and apply again if they return. A waiting guest application is cancelled. Officers can still act on someone who left by pasting their user ID: `/unassign`, `/officer revoke`, `/officer reset`, `/guest revoke` and `/guest status` all work for them.
