---
title: Monitoring
description: Health probes, logs, background jobs, members' role choices, dashboard sign-ins, Lodestone refreshes, officer notices, member status posts, update posts, issue reports, public suggestions and the optional heartbeat.
sidebar:
  order: 6
---

## Health probes

The bot serves two probes on `HEALTH_PORT` (3000 by default) inside its container. No port is published: read them through the container. The command reads the port from the container's own setting, as Compose's health check does.

```sh
docker compose exec -T tarubot \
  bun -e 'const r = await fetch("http://127.0.0.1:" + (process.env.HEALTH_PORT || "3000") + "/health/ready"); console.log(await r.text())'
```

- **`/health/live`** answers 200 whenever the process can answer at all, even while it waits for the writer lease.
- **`/health/ready`** is 200 only when the bot is fully working, and 503 otherwise. Compose's health check uses it.

The readiness body reports:

| Field | Meaning |
| --- | --- |
| `live` | `true` until shutdown begins. |
| `ready` | The overall verdict. |
| `database` | The database is reachable and on the expected schema. |
| `writerLease` | This process holds the [writer lease](/tarubot/deploy/operations/#single-database-writer). `false` means another bot holds it. |
| `discord` | Connected to Discord. |
| `effects` | `ENABLE_EFFECTS` is on. |
| `publicTestResponses` | Development replies are public: `TEST_GUILD_ID` is set and `PUBLIC_TEST_RESPONSES` is on. Normally `false`. |
| `capabilities` | Pending and blocked work, the age of the oldest accepted roster, and FCs whose roster reads are failing. |
| `lodestone` | Informational; a Lodestone outage never makes the bot unready. `parsing` and `waiting` count parses running and waiting; `cooldownSeconds` above 0 means Lodestone requests are paused after a 429; `selectors` shows the [live selector set](#live-selectors). |
| `visibility` | Informational; it never changes `ready` or the status code. `missing` counts, across servers without onboarding, the channels TaruBot couldn't see or post in without Administrator: the count behind the [missing-overrides alert](/tarubot/admin/notices-and-updates/#missing-channel-overrides). `onboardingPending` counts, on servers with onboarding, the channels onboarding's pass hasn't reached and configured community-updates channels TaruBot can't post in. `checked` is how many servers the last check covered, and `checkedAt` when it ran; all four are `null` until the first check, about 30 seconds after startup. |

Probes never fetch a Lodestone page. The bot also logs a capability summary periodically: queue counts, blocked work, the oldest roster's age and failing FCs.

## Logs

```sh
docker compose logs --since 1h tarubot
```

Logs are structured JSON lines. Tokens, passwords, message payloads and command option values are never logged.

For upstream automated delivery, Actions receives only fixed step/result tokens. Detailed host diagnostics stay in private deployment logs; inspect them privately as the owner. Repository checks do not establish which release is live. The [owner runbook](https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#everyday-observation-and-outcomes) covers exact image/schema/writer observation.

**Finding a member's error.** Every failure reply ends with `Code <code> · Ref <interaction ID>`, and the log entry for it carries the same ID in `operation`:

```sh
docker compose logs tarubot | grep '"operation":"123456789012345678"'
```

The entry's `code`, `source`, `scope` and `diagnostic` say what happened. [Replies and error codes](/tarubot/reference/replies/) explains each code and log level.

**Background jobs** log each attempt with the job ID, kind, attempts, code, status and timings, never the payload:

- Expected waits (another job first, contention, a cooldown, a Lodestone rate limit, a superseded input) log at debug, and at warn once a job has waited 10 minutes.
- Blocked, paused and retrying work logs at warn.
- Terminal failures log at error.
- Each Lodestone 429 logs one line: "The Lodestone throttled TaruBot".

A member's role update (`reconcile.user`) keeps an `applied` list in its stored result: the newest 20 role changes Discord actually received, including those from a pass that a newer change later superseded. It's the record of the access-role changes TaruBot really made for that member; menu roles it removes, or that the member picked on My roles, are only counted, never listed (see [Role choices](#role-choices)).

## Jobs that need attention

Officers see outstanding and failed work in `/sync status`. Blocked work (a permission, the role order, a deleted channel) resumes once an officer fixes the cause. The scheduler retries it by itself about every 10 minutes; saving a `/config` role or channel, the FC link or `/config guest_applications` retries it at once, and so does queuing the same work again. `/config officer_rank`, `/config role_layout` and `/config fc unlink` don't requeue it.

A job that **failed** has stopped for good. After fixing the cause, retry it with [`retry.js`](/tarubot/deploy/tools/#retryjs), giving the server's ID and the job's full ID:

```sh
docker compose run --rm --no-deps -T tarubot bun dist/scripts/retry.js YOUR_GUILD_ID JOB_ID
```

It retries a blocked, failed or paused job of that server and clears its diagnostic. It refuses, changing nothing, when a newer job for the same work is already queued, running or blocked, and prints that job's ID. A retry recomputes what's wanted now: it never repeats a decision, and a ledger post is posted for the same entry.

To find job IDs, use the officer `/sync status` with **Full details (JSON)**, or query the database:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT id, kind, status, attempts, due_at, last_error
FROM jobs WHERE status IN ('queued','running','blocked','failed','disabled')
ORDER BY created_at;"
```

## Role choices

From 2.40.0, each save on the dashboard's [My roles](/tarubot/use/pick-your-roles/) page queues one `roles.self` job for that member (`self-roles:<guild>:<user>`), labelled **Role choices**. A newer save merges into one still waiting. Its payload holds the IDs of the roles involved, and the database clears it to `{}` as soon as the job ends, however it ends: role choices can reveal pronouns or gender identity, so they're never kept ([data and privacy](/tarubot/architecture/data-and-privacy/#self-service-roles)). The job writes no delivery attempt, logs no payload, and its result and diagnostics never name a role.

- **Applied.** The result is counts only: `{"status":"applied","added":1,"removed":1,"skipped":0}`. `skipped` counts choices that weren't applied: a role taken off the menu since the save, or in a category now over its limit, one that now fails [the menu's checks](/tarubot/admin/self-service-roles/#what-a-role-must-pass), one Discord refused because it was deleted or moved above TaruBot, and a channel-opening role for someone who no longer has Member, Guest, Officer or FC Leader. The member sees how many weren't applied, or, when nothing was added or removed, that the change wasn't applied, never which, and nothing records which. Role menu and its health check show menu roles that now fail a rule, deleted roles included.
- **Skipped**, as `– SKIPPED` with a reason: `member left`, `guild inactive`, `nothing to apply` (its payload was already cleared, for example a failed job you retried: the member saves again instead), `superseded` (a newer save replaced a paused one), `expired`, `restored`, or `needs a newer TaruBot` (2.39.0 closed it after a rollback).
- **Blocked.** A refusal that affects the whole server, such as TaruBot losing Manage Roles, parks it as `! BLOCKED` with "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate." It retries as other blocked work does, and when the member saves another change.
- **Waiting.** It waits without spending an attempt while the same member's `reconcile.user` runs, and backs off while TaruBot can't read the server's roles.
- **Paused.** With Discord changes off, a waiting change parks as `‖ PAUSED`, and My roles refuses new saves until they're back on.
- **Expiry.** The scheduler closes a change still waiting 7 days after the member's last save as skipped with `expired`, and the member is told to pick their roles again. A running job with a live lease is left to finish; one whose lease ran out, such as after a crash in a server TaruBot has since left, is closed the same way.
- **Retention.** Finished `roles.self` jobs are deleted 30 days after they end: the one kind of job history TaruBot removes by itself. They say only who changed their roles, and when.
- **Who.** Officers' Background work shows someone else's role choices as "A member", `/sync status` and its JSON leave the user out, and `/guest status` records never list them. The member sees their own as **Role choices** in `/sync status`.
- **Issue reports.** A report shows that a role change happened only in its queue tables, which count waiting work by kind and list the day's failures by kind, never naming the member. Its member section leaves role changes out, even in the member's own `/issue`, and an automatic report about a failed one has no member section.
- **Restores.** After restoring a backup, close the changes it caught waiting before the bot starts ([recovery](/tarubot/deploy/operations/#recovery), step 7).

When a `reconcile.user` pass leaves someone with none of the Member, Guest, Officer and FC Leader roles, it also removes the channel-opening menu roles they hold ([why](/tarubot/admin/self-service-roles/#opt-in-channels)). Its stored result and [`preview.js`](/tarubot/deploy/tools/#previewjs) record only how many, as `selfRoles`, never which, and they're left out of the `applied` list.

## Dashboard sign-ins

Sign-in limits are counted in memory, so a restart resets them, and never by address:

- **Per person:** 10 sign-ins in 10 minutes. The 11th gets a 429 with Retry-After ("That's a lot of sign-ins in a short time") and no session; the request log records it as a 429.
- **Everyone together:** at most 30 Discord token exchanges a minute, and 4 at once. Beyond that, and for as long as Discord asks after it answers a sign-in with a 429, every sign-in gets a 503 with Retry-After ("Lots of people are signing in right now"), logged at warn with code `unavailable`, without a request to Discord. Repeated refusals from Discord's sign-in endpoint could otherwise get the bot's own address blocked from Discord.
- **Sessions:** each person keeps at most 10. A sign-in beyond that ends their oldest, silently.

## Lodestone requests

TaruBot reads each tracked FC's roster every `ROSTER_INTERVAL_SECONDS`. It reads a character's profile only when a member verifies ownership, or when `/claim` or `/assign` names a character that roster doesn't list, never on a schedule.

- **Throttling.** A Lodestone 429 pauses all Lodestone requests for a shared cooldown (15 seconds, doubling to 5 minutes). Jobs wait it out as `↻ WAITING` without using attempts, and readiness shows `lodestone.cooldownSeconds`.
- **Retired profile refreshes.** Earlier versions refreshed linked characters' profiles daily. A `profile` job one of them queued before an upgrade completes as skipped, with `profile refreshes retired`, without reading the Lodestone.

## Officer notices

Officer notices are `officer.notify` jobs that post plain text to a server's officer notifications channel ([what officers see](/tarubot/admin/notices-and-updates/#officer-notices)). Each kind has its own job key:

- **Lodestone degraded** (`officer:<guild>:degraded:<fc>`). Queued on the first roster failure since the FC's last accepted roster that isn't a wait, and posted only if it is still pending 5 minutes later. While the FC keeps failing it repeats at most once a day, counted from when the last one finished. A notice still waiting to post (held, paused or blocked) blocks new ones. Throttling and the queue's other waits post nothing.
- **Recovered** (`officer:<guild>:recovered:<fc>`). One line after an accepted roster, only when a degraded notice posted (or was posting) during that outage.
- **FC roster accepted** (`officer:<guild>`), only on a development deployment's test server (`TEST_GUILD_ID`). Other servers get no line for a routine roster read.
- **Missing channel overrides** (`officer:<guild>:visibility`). Queued when a server without onboarding has had channels missing TaruBot's own entry, counted as if Administrator were off, on two checks in a row, and posted 5 minutes later, or at the end of 24 hours after the last one that posted. The episode is recorded as a `visibility.missing` audit row. A server getting its first channel overrides usually gets one, even while TaruBot holds Administrator.
- **Channel overrides restored** (`officer:<guild>:visibility:restored`). Once two checks in a row find nothing missing (a `visibility.restored` audit row), a waiting alert closes as `– SKIPPED` with `restored before posting`, and this line follows only if the alert posted. If channels go missing again before this line has been sent (a send being retried, or one paused or blocked), the new episode closes it as `– SKIPPED` with `superseded by a new episode`, so "complete again" never posts while channels are missing; one already being sent is left to finish.

A degraded notice that completes `– SKIPPED` with `recovered before posting` (the roster was accepted during the hold, while it was paused or blocked, or while the bot was out of that server) or `FC unlinked` (`/config fc unlink` during an outage) is expected. The queue never claims a job of a server the bot was removed from, so an accepted roster closes such a server's waiting notice too, and posts no recovery line there. `/sync status` lists only unfinished and failed work, so it never shows these closed jobs; this query does:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT dedupe_key, status, created_at, completed_at, message_id, result
FROM jobs
WHERE dedupe_key LIKE 'officer:%:degraded:%' OR dedupe_key LIKE 'officer:%:recovered:%'
   OR dedupe_key LIKE 'officer:%:visibility%'
ORDER BY created_at DESC
LIMIT 10;"
```

Accepted edge cases and assumptions:

- **A send in flight.** A degraded notice being sent when the roster is accepted counts as posted, so the recovery line is queued; one being sent during `/config fc unlink` is left to finish. If that send fails (or its worker dies) and the queue retries it, the degraded line can post after the recovery line, or about the unlinked FC, with nothing after it. The window is one send in flight at that moment.
- **An FC with no active server.** Rosters run only while a server linked to the FC is active. If the bot is removed from every such server during an outage, a waiting notice stays queued until the bot is added back. It can then post before the next roster, which, once accepted, posts the recovery line after it.
- **Clocks.** The outage boundary is the accepted roster's observation time from the bot's clock, compared with job times from PostgreSQL's clock. They must agree to within a few seconds (one roster fetch); NTP on the host keeps them far closer.

The rate limit reads these job rows, so don't prune `officer.notify` jobs ([persistence conventions](https://github.com/deconfined/tarubot/blob/main/docs/PERSISTENCE.md)).

## Status notices

Member status posts ([what officers see](/tarubot/admin/notices-and-updates/#member-status-changes)) come from one `officer.status` job per server, key `officer:<guild>:status`, with an empty payload. Each recorded change queues it (or merges into the one waiting), due about 2 minutes later.

- **What is recorded.** After each successful role update, TaruBot records the member's Member, Guest, Officer and FC Leader, but only decisions that don't depend on the roles the member already holds, so a rebind, an out-of-date roster, an unchecked new link, an unknown rank or a kept hand edit records nothing. A member's first recorded value is a silent baseline. The accepted roster records confirmed departures of linked characters on their owners' rows in the same transaction. All of it lives in three `guild_users` columns: `status_state` (what was last announced, what was last decided, the reasons and unposted departures), `status_since` (when something first waited; NULL when nothing does) and `status_posting` (a member's lines in a post being sent).
- **Waiting.** While the window runs, officers' `/sync status` lists `… QUEUED officer.status 1a2b3c4d …`. If a run starts before the oldest change is 2 minutes old (a change arrived during a run, or `retry.js` released the job), it waits as `↻ WAITING` with the `ordered` diagnostic, logged at debug. Members never see the job, since it has no member.
- **Outcomes.** A post succeeds with its message. A run with nothing left to post completes as `{"skipped": "nothing to post"}`; `/sync status` lists no succeeded job, so read it in `jobs.result`. With no officer notifications channel nothing is saved for a channel set later. Unsetting the channel with `/config officer_notifications unset_channel:true` clears everything the server still has waiting in the same save, lines frozen in a post included, for every member (those who have left the server too), even with Discord changes off, so a job that failed before the unset leaves nothing to post. A job that runs with no channel completes as `{"skipped": "officer notifications unconfigured"}` and clears whatever it still finds, and while the channel stays unset each member's next successful role update clears anything left for that member. With a channel and Discord changes paused, it parks as `‖ PAUSED` and posts on resume.
- **Settings changed mid-run.** If the officer notifications channel is unset or moved, Discord changes are paused, or the bot leaves the server while a run is posting, the run stops before its next post (`superseded`, a wait), and the rerun drops, parks or posts to the new channel.
- **Missing permissions.** The job is `! BLOCKED` and its batch stays frozen. It retries like other [blocked work](#jobs-that-need-attention), and the retry resends the same batch under the same nonce (`status:<batch>`), so a retry within Discord's window returns the first message.
- **Delivery records.** Each send records a `started` delivery attempt, then `failed` or `delivered`. `delivered` holds the message ID and, in `diagnostic`, the nonce key, and is written before the batch is marked as posted. If marking then fails (a database error after Discord took the post), the job retries as usual and the retry only marks the batch, however late, so it never posts twice.
- **A failed job** keeps what waits while the channel is set: [`retry.js`](/tarubot/deploy/tools/#retryjs), or the next change in that server, posts it.

To see what waits, or is being sent, in a server:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -c "
SELECT user_id, status_since, status_posting IS NOT NULL AS sending
FROM guild_users
WHERE guild_id = 'YOUR_GUILD_ID' AND (status_since IS NOT NULL OR status_posting IS NOT NULL)
ORDER BY status_since NULLS LAST;"
```

**Lock order.** Status recording, the roster and the job lock a server's rows in one order: its `guilds` row (shared), then its `guild_users` rows in `(guild_id, user_id)` order, then `jobs` rows. `/config` role adoption, `/setup onboarding confirm:true` and activation take the `guilds` row for update first, so they queue behind a status write instead of deadlocking; unsetting the officer notifications channel likewise locks the waiting `guild_users` rows in user order after its `guilds` row, before it queues any job. Member rows are locked `FOR NO KEY UPDATE`, which never blocks the foreign-key checks of inserts that reference a member. A hand-written transaction that changes these rows should take them in the same order, or run with the bot stopped.

**Manual reversal,** to run a release from before status posts, whose schema ends at `009_changelog_channel.sql`. An older release refuses to start on schema `010_status_notices.sql`, and that migration only adds the three columns, so nothing else is lost. Stop the bot, run the [writer gate](/tarubot/deploy/operations/#single-database-writer), then run the three statements together (psql runs one `-c` string as one transaction):

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot -v ON_ERROR_STOP=1 -c "
ALTER TABLE guild_users DROP COLUMN status_state, DROP COLUMN status_since, DROP COLUMN status_posting;
UPDATE jobs SET status = 'succeeded', completed_at = now(), lease_until = NULL, result = '{\"skipped\":\"reverted\"}'
WHERE kind = 'officer.status' AND status IN ('queued','running','blocked','disabled');
DELETE FROM schema_migrations WHERE version = '010_status_notices.sql';"
```

Then pin the older `TARUBOT_IMAGE_TAG` and start it as in [Rollback](/tarubot/deploy/operations/#rollback). The `UPDATE` matters: an older release would fail those jobs as `invalid_job`.

## Update posts

When the bot starts on a newer version, it posts what's new in each server's changelog channel ([what officers see](/tarubot/admin/notices-and-updates/#update-posts)). The notes live in [`src/domain/release-notes.ts`](https://github.com/deconfined/tarubot/blob/main/src/domain/release-notes.ts): one plain-words sentence for each release that members, guests or officers can notice, in Discord, on the dashboard or on the documentation site. Every release since 2.25.0, when update posts began, has a note or a short recorded reason for having none, such as deployment tooling; a release with a reason is never listed.

- **The baseline.** Each server stores the newest version it was told about, `guilds.changelog_version`. Setting a channel where none was stores the running version (or keeps a higher stored one), so nothing posts at once, and releases published while no channel is set are never posted. Moving or unsetting the channel keeps the baseline, and the bot never lowers it.
- **Startup.** Each present server with a channel and an older baseline gets one `changelog.post` job (`changelog:<guild>`), logged as "Queued update posts" with the count and the version. A restart while one is pending merges into it, so one post covers every release since the last.
- **Outcomes.** The job reads the release range when it runs. It completes as `– SKIPPED` with `changelog unconfigured` (the channel was unset), `already announced` (the baseline is already at or past the running version) or `nothing for members` (no release in the range has a note; the baseline still moves). That reason keeps its original wording. A post succeeds with its `messageId`, `channelId` and `version`, and writes a `changelog.advanced` audit.
- **Missing permissions.** The job is `! BLOCKED` and the baseline doesn't move. The scheduler requeues it about every 10 minutes, and it is released at once by a `/config` save of the FC link, a role or a channel, by `/config guest_applications`, and by [`retry.js`](/tarubot/deploy/tools/#retryjs) or the next startup; `/config officer_rank`, `role_layout` and `fc unlink` don't release it. It never fails on its own, so a problem never fixed leaves a warning line and a delivery attempt about every 10 minutes. A restart merge keeps its attempt count, so about seven restarts inside one scheduler window use up its 8 attempts; the first transient error after that ends it as failed, and the next startup queues it again without a double post.
- **Paused.** With Discord changes off for the deployment or the server, a post parks as `‖ PAUSED`, and each restart on a newer version adds one more parked job. Resuming keeps only the newest and closes the rest as `superseded`, so one post goes out.
- **Duplicates.** A retry within a few minutes is deduplicated by Discord's nonce check (`changelog:<guild>:<running version>`). A kill, out-of-memory stop or host loss between the send and the baseline update, followed by a different version, can repeat that post's releases once, the same risk ledger posts accept. A graceful stop can't cause it.
- **Restores and baselines.** Restoring a backup taken before a post was delivered can post it again: [raise the baseline](/tarubot/deploy/operations/#recovery) before starting the bot. An operator may move a baseline by hand; the column accepts only `MAJOR.MINOR.PATCH` with an optional prerelease, and lowering it announces the notes in between again at the next startup, as one catch-up post: the ten newest releases with notes as fields, newest first, and a footer counting older ones ("…and 2 more in the full changelog"). A note added for a release a server has already run reaches that server only this way. To catch a server up, lower it no further than the `from` of its oldest `changelog.advanced` audit, the version stored when its channel was set, so it never gets releases from before then:

  ```sh
  docker compose exec -T postgres psql -U tarubot -d tarubot \
    -c "UPDATE guilds SET changelog_version = 'X.Y.Z' WHERE id = 'YOUR_GUILD_ID'"
  ```

## Live selectors

The bot's Lodestone parser reads pages with the CSS selectors from [`xivapi/lodestone-css-selectors`](https://github.com/xivapi/lodestone-css-selectors), and keeps them current by itself. It checks the repository every `LODESTONE_SELECTOR_CHECK_SECONDS` (15 minutes by default). A new version is downloaded, checked against the fields the parser reads, and switched to in memory with no restart.

- Readiness shows the active set: `lodestone.selectors.revision`, with `source` `upstream` or `bundled`.
- A switch logs one "Lodestone selectors updated" line with `from` and `to`.
- A version that fails its download or checks logs "Lodestone selector revision rejected; the active set stays", with the reason, and the next check tries again. A rejection that persists means the selector format changed upstream and the parser needs a fix release.
- After a restart, the set bundled with the release runs until the first check, moments later.

Nothing needs doing when selectors switch. `LODESTONE_SELECTOR_CHECK_SECONDS=0` keeps the bundled set, for example on a host that can't reach GitHub.

## Issue reports

With `GITHUB_REPORTS_TOKEN` and your own `GITHUB_REPORTS_REPO` set, TaruBot opens issues in that GitHub repository. Use a **private** repository: reports carry members' details.

**What opens an issue:**

- `/issue` from any member: one per member every 10 minutes, and 20 per server a day.
- Every error-level report: unexpected failures in commands, events, startup and the job worker.
- Every job that ends failed at error level.
- Repeated trouble, checked every five minutes: a linked FC whose roster hasn't been accepted for 12 hours, and no Lodestone answer for an hour while requests keep failing.

**How reports are grouped:**

- Automatic reports share one issue per fingerprint of what failed and where. Repeats are counted, and a comment posts the count with the newest context at most hourly.
- A repeat after you close the issue opens a new one that links the old. Close an issue once it's fixed, so a recurrence shows up as new.
- Each day allows at most 10 new automatic issues and 50 automatic comments; the rest wait for the next day. `/issue` reports don't count toward these.
- Issues carry the labels `tarubot-report`, `source:user|error|job|trouble`, and `env:production` (or `env:devbot` from a development deployment with `TEST_GUILD_ID` set).

**What a report contains:** the version and readiness; the Lodestone's reachability, cooldown and selectors; active and recently failed jobs; the server's settings and roster state; for member reports, the member's links, main character, nickname state, guest and officer standing, recent work other than [role choices](#role-choices), and audit; and the newest log records. Known secret shapes (tokens, authorization headers, passwords in URLs, PEM blocks, ping URLs), the deployment's own secret values, and the values a failed database query was given, since they can hold what someone submitted, are removed first.

**Delivery.** Reports are saved in the database first, then sent by background jobs, so a GitHub outage loses nothing. Without a token, reports stay saved and are sent once a token is set and the bot restarts. A refused token (401, 403 or 404) fails the delivery job with `configuration`: fix the token or repository, then [retry the job](#jobs-that-need-attention).

## Public suggestions

[`/suggest`](/tarubot/reference/commands/#suggest) posts a member's idea as a public issue in TaruBot's repository ([what officers see](/tarubot/admin/suggestions/), [what members see](/tarubot/use/suggest-a-feature/)). Only the TaruBot project's own production deployment posts publicly: as its GitHub App ([settings](/tarubot/deploy/configuration/#upstream-production-only)), from the one FC server that `src/config/deployment.ts` lists. Adding a server there is a code change. Any other deployment answers "Not available here" in every server. A development deployment (`TEST_GUILD_ID` set) previews suggestions into `GITHUB_REPORTS_REPO` with `GITHUB_REPORTS_TOKEN` instead, creating the two labels there, so testing never posts publicly.

**What goes public:** only the member's cleaned text, in a code block under a fixed first line saying it came from Discord, and "Sent by TaruBot X.Y.Z.", with the labels `enhancement` and `from-discord`. Before posting, TaruBot:

- folds compatibility forms (NFKC) and removes controls and invisible characters, so an ID or link split by an invisible mark is seen whole;
- removes links, with or without a scheme and in any script, including a domain followed only by a port, query or fragment; IPv4 addresses; and global IPv6 addresses. A global IPv6 address has a first group of four hex digits starting with 2 or 3, at least two colons, and an address's shape (`::`, or all eight groups), bare or in brackets, with any port, path, query or fragment;
- turns Discord mentions into `[member]`, `[role]` and `[channel]`, and custom emoji and command mentions into their names;
- removes email addresses, the credential shapes issue reports redact, and runs of 17 or more digits;
- turns every `@` into `＠`, and `#` in the title into `＃`.

A final check refuses anything that slipped through, as an unexpected failure with an issue report. The member's name and ID, the server's, channels' and roles' IDs, FC and character data, logs and settings never go public.

**Accepted limits.** These can't be recognised without garbling ordinary text: names typed freely; IDs split with visible separators; a host whose `。` sits next to a Chinese or Japanese label or top-level domain, which reads as the end of a sentence; look-alike dots, slashes and colons with no compatibility form (`discord·gg`, `discord.gg∕x`, `2001∶db8∶∶1`); IPv4 addresses written as one to three decimal numbers (`127.1`), which read like ratings and counts; a global IPv6 address inside a longer run of letters, digits or colons (`ip2001:db8::1`, `2001:db8::1x`; Chinese, Japanese, Korean, Thai, Lao, Khmer and Myanmar text around one doesn't count); and the start of one written without `::` (`2001:db8:1234`), which reads like a date or a score. Non-global IPv6 addresses (link-local `fe80::…`, unique-local `fd00::…`, loopback `::1`) stay, since they don't identify a connection publicly.

**The private record.** Nothing is saved before posting, and there's no table or job for suggestions: the limits and the record of who sent what are `audit` rows. `suggestion.posted`, with the target `#N`, is written once GitHub confirms the issue. `suggestion.unconfirmed`, with no target, is written when GitHub's answer was unclear, because the issue may exist. Both count toward the limits (one per member an hour, three per member and ten in total in any 24 hours, by the database's clock). Submissions run one at a time, so the limits are exact. To find who sent issue `#N`:

```sh
docker compose exec -T postgres psql -U tarubot -d tarubot \
  -c "SELECT guild_id, actor_id, event_at FROM audit WHERE action = 'suggestion.posted' AND target = '#N'"
```

Match an unconfirmed attempt by time against the issue's creation. Removing a member's Guest or Member role (a Guest with `/guest revoke`) ends their access to `/suggest`.

**Failures, and what members see:**

- **The limits, and GitHub's rate limit** on the post or the app's sign-in: "You can suggest again later", with when, logged at info. GitHub's rate limit records nothing.
- **GitHub didn't confirm the post** (an outage, a timeout, an unreadable answer): "GitHub didn't confirm your suggestion", code `unavailable`, logged at warn. The try is recorded as `suggestion.unconfirmed` and counts toward the limits, so the card asks the member to check GitHub before sending it again. An outage during the app's sign-in reads and counts the same, although nothing was posted.
- **A refused key, client ID or installation, or a request GitHub rejects:** the unexpected card, and an [issue report](#issue-reports) naming the app's settings. Nothing is recorded, so the member can try again once it's fixed.
- **Switched off, or another server:** "Not available here", logged at info and never reported.
- **A restart:** a post already at GitHub finishes and records its row before the bot gives up the [writer lease](/tarubot/deploy/operations/#single-database-writer); one still waiting behind it gets "Please wait a moment" ("TaruBot is restarting right now.") and records nothing.

**Moderation.** Suggestions go up immediately. The maintainers close them (for example as not planned), lock or delete them. Deleting an issue can't recall notification emails, GitHub's events feed or archives that already copied it.

## Heartbeat

The optional heartbeat catches what issue reports can't, because they come from inside the bot: the host is down, the container is gone, the process hangs, or the bot stays unready.

1. Create a check at [healthchecks.io](https://healthchecks.io) with a period of 5 minutes and a grace time of about 10 minutes, and point its alerts wherever you'll see them.
2. Copy its private ping URL into `.env` as `HEALTHCHECKS_PING_URL`, and recreate the bot with `docker compose up -d --wait`. Never include the URL in screenshots, issues or repository examples.

While readiness is fully green, the bot pings every five minutes, with a one-line status (version, pending and blocked work, failing FCs, the Lodestone cooldown, the selectors). It never sends a failure ping: an unready bot stays silent, and the check's grace time decides when that alerts, so an update restart or a Discord reconnect doesn't. A failed ping is retried a minute later and logged once as a warning.

Keep the URL private: anyone who has it can ping your check and hide an outage. Pause the check before planned maintenance longer than the grace time.
