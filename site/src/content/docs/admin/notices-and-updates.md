---
title: Officer notices and update posts
description: What TaruBot tells officers about Lodestone trouble, unlinked characters, missing channel overrides and members' status changes, and the update posts it shares with members.
sidebar:
  order: 9
---

TaruBot posts in two channels besides the ledger: officer notices and member status changes in a staff channel, and, if you choose one, short update posts for members. All are sent with mentions turned off, so they never ping anyone.

## Officer notices

Choose a staff-only text channel with [`/config officer_notifications`](/tarubot/reference/commands/#config-officer_notifications). Without one, notices are skipped. TaruBot posts plain text there:

- **Lodestone trouble.** "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status." TaruBot keeps using the last roster it accepted, so nobody loses a role over an outage.
- **Recovery.** "Lodestone synchronization recovered: the FC roster was accepted again." It follows only an outage that officers were told about.
- **Missing channel overrides**, and a recovery line once they're complete. See [below](#missing-channel-overrides).

Routine roster reads post no notice here; departures they confirm appear in the [member status post](#member-status-changes).

### How often Lodestone notices post

The trouble notice waits before it posts, and repeats slowly, so a short blip doesn't reach officers at all:

- **Five minutes' grace.** The first failed roster read since the last good one starts the notice, and it posts only if the roster still hasn't been read five minutes later. A roster read in that time cancels it, and no recovery line follows.
- **At most once a day.** While the FC's roster keeps failing, the notice repeats at most once every 24 hours.
- **One at a time.** While a notice is still waiting to post, including one held by a permission problem or paused Discord changes, no new one is started.
- **Throttling isn't trouble.** When the Lodestone asks TaruBot to slow down, or work waits its turn, no notice is posted.
- **One recovery line per outage.** It posts once the roster is read again, only if a trouble notice was posted during that outage. Each outage longer than the grace period gets its own pair.
- **Unlinking the FC** with `/config fc unlink` cancels a trouble notice that hasn't posted yet, so nothing posts later about an FC the server no longer uses.

While a notice waits to post, the officer view of [`/sync status`](/tarubot/reference/commands/#sync-status) lists it as an `officer.notify` job. A notice cancelled before it posted simply leaves the list; that's expected.

### Missing channel overrides

On a server without lobby onboarding, TaruBot checks every 30 seconds whether it would still see every channel, and post where a setting names the channel, without Administrator: the same count as `/config validate`'s Visibility section ([Health checks](/tarubot/admin/health-checks/#tarubots-role-and-channel-view)). When channels are missing TaruBot's own entry, it posts one alert:

> Some channels are missing TaruBot's channel override, so without Administrator TaruBot can't see them or can't post where it should. /config validate lists them and what to do; /setup overrides adds missing overrides while TaruBot holds Administrator.

When every channel is covered again, and only if the alert posted, it follows with:

> TaruBot's channel overrides are complete again: /config validate shows every channel visible.

- **It counts as if Administrator were off,** so the alert posts even while TaruBot still holds Administrator: it tells you what [the setup window](/tarubot/admin/add-to-server/#the-setup-window) still has to fix. A server that has just started using TaruBot usually gets one, about six minutes after its private channels are first counted, or five minutes after the officer notifications channel is set if that comes later.
- **No spam.** A change has to show on two checks in a row, so a blip posts nothing. The alert then waits five minutes, and a fix in that time cancels it without a recovery line. A new alert posts at most once in 24 hours: one that comes due sooner waits until 24 hours after the last one posted, and is cancelled if the channels are covered by then. A recovery line that hasn't been sent yet when channels go missing again is cancelled too.
- **A server with onboarding** gets no alert, because onboarding's own pass gives TaruBot its channel access. `/config validate` and `/sync status` show a pass that hasn't reached a channel.
- **Without an officer notifications channel** the alert isn't posted; `/config validate` still lists the channels. Once you set the channel, an alert still owed follows five minutes later.

## Member status changes

The same officer notifications channel gets one post, "Member status changes", listing what changed about your members. There is nothing else to set up and no separate switch: while the channel is set, the posts are on.

### What the post shows

- **Access and officer changes.** Members who gained or lost Member, Guest, Officer or FC Leader, grouped by the change and the reason TaruBot decided it: "Member → Guest · no linked character is in the FC", "No access → Guest · guest grant", "Officer added · officer override", "FC Leader removed · no linked character leads the FC". Access changes come first, largest group first, then Officer and FC Leader, added before removed.
- **Left the FC.** Each linked character that left the FC (missing from the roster, then still absent a minute later), with its owner's mention. Departures are listed even when nobody's access changes: an alt whose owner keeps Member through another character, or an owner who already left the server.
- **Mentions only.** Members appear as mentions, which never ping; character names appear only on departure lines. The footer counts the members, and the time is when the post was put together.
- **Officers' own changes** (grants, revocations, overrides, approvals) read like automatic ones, with no "by @officer". TaruBot's audit keeps who made each change.

For example:

```text
Member status changes

Member → Guest · no linked character is in the FC
@Alex, @Sam

No access → Guest · guest grant
@Robin

Officer removed · officer access revoked
@Jordan

Left the FC
Example Alt @ Diabolos (@Alex)
Second Alt @ Diabolos (@Casey)

5 members
```

### When it posts

- **About 2 minutes after the first change,** one post covers everything that changed in that window. A change undone inside it cancels out: a `/guest grant` to a visitor with no linked character, followed by `/guest revoke` a minute later, posts nothing (`/guest reset` then clears the revocation). For a visitor who already has Guest through a registered character, the grant changes nothing, so the revoke alone posts "Guest → No access · guest access revoked".
- **Large changes** are split: a post names at most 100 members, fewer when their lines are long, and the rest follow straight away. Nobody is left out.
- **Without a channel,** changes aren't saved for later. Setting the officer notifications channel afterwards, even within 2 minutes, posts none of what happened before it. Unsetting the channel also drops anything still waiting to be posted.
- **While Discord changes are paused,** the post waits and goes out once they're back on.

While a post waits, the officer view of [`/sync status`](/tarubot/reference/commands/#sync-status) lists it as a queued `officer.status` job (`… QUEUED`); members never see it.

### What isn't announced

These stay quiet on purpose:

- Role changes that follow a role binding change with [`/config roles`](/tarubot/admin/roles/) or `/setup onboarding confirm:true` (setting up, replacing or removing a role). The exception: when a new Officer role replaces one already set, officers adopted with `adopt_holders` show as "Officer added".
- Decisions TaruBot makes while its evidence is unconfirmed (an out-of-date roster, a new link it hasn't checked yet, an unknown rank), and hand edits of roles it keeps in those times. Once a fresh roster confirms them, anything that still differs from the last post is announced.
- Roles given on joining or rejoining the server, people who left it, nicknames, FC rank changes that change neither Officer nor FC Leader, characters nobody linked, and FC joins that change no access.
- Each member's first check, which only records where they stand: after TaruBot is installed or updated to a release with these posts, after a server is activated, or when a member first appears.

Linking an FC to a server whose roles are already set up lists its confirmed members as "Guest → Member" after the first roster check, or about 2 minutes after the relink when the same FC is linked again while its last roster is still fresh ([`/config fc unlink`](/tarubot/reference/commands/#config-fc-unlink) keeps what the roster showed). Unlinking lists the reverse.

### If a status post doesn't arrive

- **`! BLOCKED`** on the `officer.status` job in `/sync status`: TaruBot can't post in the officer notifications channel. Fix its permissions there. The same post is retried, so nothing is lost or repeated; see [Jobs that need attention](/tarubot/deploy/monitoring/#jobs-that-need-attention) for when it retries.
- **`‖ PAUSED`**: Discord changes are paused for the server or the deployment. The post goes out once they're back on.
- **Nothing in `/sync status`**: nothing changed that is announced, or the channel was unset when the change happened.

## Update posts

When TaruBot starts on a newer version, it can post what's new for members in a channel you choose: one short message, "TaruBot updated to vX.Y.Z", with a one-sentence note for each release since the last post, newest first. The title links the full changelog, and [`/version`](/tarubot/reference/commands/#version) lists the recent commits.

- **Only what members notice.** A release that changes nothing for members has no note and isn't listed, and an update with nothing for members posts nothing.
- **No repeats.** A restart, a rollback or another update doesn't repeat releases the channel was already told about. Only a crash in the middle of a post or an operator's restore of an older backup can repeat one; see [Monitoring](/tarubot/deploy/monitoring/#update-posts).
- **Nothing piles up.** Updates released while no channel is set are never posted later.

### Choosing the channel

Officers choose it with [`/config changelog`](/tarubot/reference/commands/#config-changelog):

```text
/config changelog channel:#tarubot-updates
```

Pick a normal text channel that members and guests can read, and where TaruBot can post. Announcement channels are refused, like every channel setting.

Setting the channel posts nothing at once: the first post comes with the next update that has something for members. Moving it to another channel keeps its place in the release history, so nothing is posted again. To stop the posts, run `/config changelog unset_channel:true`; the channel and its old posts stay.

### Visibility with lobby onboarding

Where [lobby onboarding](/tarubot/admin/setup/#channel-visibility) manages who sees each channel, TaruBot checks who can read the channel you chose, and warns without changing anything:

- **The lobby, the officer room or a staff-only channel** gives a warning receipt: members and guests can't read it, so they won't see the posts. Choose another channel.
- **A channel onboarding has no record of** gets a **Visibility** note on the receipt: a channel created since TaruBot's last repair pass, or Discord's community-updates channel, which onboarding never manages. Make sure members and guests can read it.

Choosing the same channel again replies `= NO CHANGE` and keeps the note. [`/config validate`](/tarubot/admin/health-checks/) shows either case as a `[WARN] Changelog` line for as long as it applies. TaruBot never changes the channel's permissions for update posts; pick a channel members can already read.

Without onboarding, server admins own every channel's permissions, and TaruBot doesn't check who can read it.

### When a post doesn't arrive

- **`! BLOCKED`** on a `changelog.post` job in `/sync status`: TaruBot can't post in the channel. Fix its permissions there, or choose another channel. Saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once; otherwise it retries by itself about every 10 minutes.
- **`‖ PAUSED`**: Discord changes are paused for the server or the deployment. The post goes out once they're back on, as one post covering every release since the last.
- **Nothing in `/sync status`**: there was nothing to post. The update had nothing for members, the channel was unset before the post went out, or the channel had already been told about this version.
