---
title: Data and privacy
description: What TaruBot stores, how it keeps values exact and history intact, what it keeps about self-service role choices, mod mail and pauses, what the public status page records, what issue reports and public suggestions carry, and what members see.
sidebar:
  order: 3
---

Everything TaruBot knows lives in one PostgreSQL database per deployment, run by that deployment's operator. Nothing is sent to the TaruBot project unless the operator points issue reports there. The one exception is [public suggestions](#public-suggestions), which only the project's own deployment accepts.

## The data model

| Area | Tables | What they hold |
| --- | --- | --- |
| Lodestone cache | `free_companies`, `characters` | Public facts read from the Lodestone: IDs, names, worlds, FC tags, the FC a profile shows, and when each was last read. |
| Rosters | `roster_snapshots`, `roster_members`, `membership`, `membership_history` | Accepted roster observations (members, ranks, leadership), each member character's current membership state, and when membership was observed for a link. |
| People and servers | `users`, `guilds`, `guild_users` | Discord user IDs; each server's settings and revision, and the newest version its update posts announced; per-member presence, join time, main character and nickname state, and what officers' status posts last said about the member, with departed characters' names and worlds until they are posted. |
| Links | `links`, `challenges` | Character links with their provenance, who made them and why, and when they ended; pending claims, as token hashes. |
| Access decisions | `guest_state`, `guest_grants`, `guest_applications`, `officer_overrides` | Guest revocations, grants with provenance (ended grants kept), applications with their answers and outcomes, and officer grants and revocations. |
| Ledger | `ledger_accounts`, `ledger_entries` | One account per server and FC; numbered, immutable entries with their note, amount, resulting balance and who recorded them. |
| Work | `jobs`, `delivery_attempts`, `sync_runs`, `sync_run_jobs` | The durable queue of Discord effects, their attempts and outcomes, and `/refresh` runs. A member's [role choice](#self-service-roles) is held there only while it waits. |
| Server structure | `retired_roles`, `channel_access_policies` | Roles being cleaned up after a change, and each managed channel's original permissions under onboarding. |
| Self-service roles | `self_role_menus` | Each server's role menu as its officers set it up: categories with their names, descriptions, limits and states, and the IDs of the roles on offer, each with a description. Never who picked which role: Discord holds that. |
| Mod mail | `modmail_settings`, `modmail_cases`, `modmail_messages`, `modmail_reads` | Whether each server turned mod mail on, and its case counter; each case's number, opener, state and times, with its topic encrypted; each message's author, side, signing choice and time, with its text encrypted; and who opened each case's page, when. Closed cases are deleted 90 days after closing ([mod mail](#mod-mail)). |
| Pauses | `member_blocks` | One row per pause of a person's use of a feature: who, which feature, the reason, when it was set and when it ends, who set it and at what level (server manager or officer), and how it ended. Kept as history ([pauses](#pauses)). |
| Records | `audit`, `imports`, `issue_reports` | The audit trail, imports from a previous bot, and saved issue reports. |
| Web sessions | `web_sessions` | Hashed session tokens, Discord user IDs, authentication and activity times (the authentication time is how the Moderation page knows you signed in within the last 15 minutes), and expiry; never the raw browser token or Discord's OAuth token. |
| Status page | `status_samples` | One sample every five minutes while TaruBot runs: whether it was ready, the state of its Discord connection, database, Lodestone and Discord changes, and its version. Nothing about a server, member or visitor; deleted after 90 days, apart from the very first ([status page](#status-page)). |
| Schema | `schema_migrations` | Which migrations were applied, with their checksums. |

The numbered files in [`migrations/`](https://github.com/deconfined/tarubot/tree/main/migrations) define every table, with comments, and are the authority for the schema. The bot refuses to start on a schema it doesn't expect, and an applied migration is never edited: every change is a new file.

## Exact values

- **IDs** from Discord and the Lodestone are stored as decimal text, checked to be valid unsigned 64-bit numbers, never as floating-point numbers.
- **Gil** is a PostgreSQL `bigint`, handled as an exact integer end to end. A balance can't go below zero, and every entry records the balance after it.
- **Times** are UTC instants.

## History is kept

- Ending a link, a grant or a revocation marks it ended; the record stays.
- Ledger entries are immutable: database triggers refuse updates and deletes, and corrections are new entries that name the entry they correct.
- A pause is never deleted or edited: a database trigger refuses both, and only its lift can be written, once. A pause that ended stays in the history.
- Every officer decision, and every other command decision, is written with its **audit** record and its queued Discord work (the **outbox**) in one transaction, on one database connection. Either all three commit, or none does, so no decision is ever made without its record or its follow-up. A member's own choices for themselves are different: a role save on My roles, like the `/main` and `/nickname` preferences, commits only its state and queued work without an audit record, and Discord is the record (owner decision Q4 A; see [Self-service roles](#self-service-roles)). Mod mail is the other exception: only turning it on or off is audited, while cases, replies, closes and reopens stay in mod mail's own tables and go when a case is deleted (see [Mod mail](#mod-mail)).

Expired claim challenges are deleted a week after they expire, and a closed [mod mail](#mod-mail) case, with its messages and read log, 90 days after it closed. Links, grants, rosters, audits, ledger entries, pauses, imports and job history are kept, apart from a member's finished role-choice jobs, which TaruBot deletes after 30 days, and the status page's samples, deleted after 90 days apart from the very first; an operator can prune diagnostic history, but should keep financial and access records.

## What's stored about a member

For each member, a server's database holds their Discord user ID, whether they're in the server and when they joined; their linked characters and each link's history; their main character and nickname state, including the nickname TaruBot replaced; guest applications with their answers, grants, revocations and officer overrides; pauses on their use of a feature, with the reasons; ledger entries they recorded; audit records of changes they made or that were made to them; their queued Discord work; and the mod mail cases they opened or wrote in, with the text encrypted, until 90 days after each closed.

It doesn't store which self-service roles a member picked: Discord holds them ([self-service roles](#self-service-roles)). It doesn't store Discord messages or online status: Discord sends it no message events and no online status, because TaruBot asks for neither the message intents nor Presence. It doesn't store Discord usernames outside a saved `/issue` report. It never sees Lodestone passwords, and it keeps a claim token only as a hash; the reply that shows the token is private.

## Self-service roles

Officers list existing Discord roles on the [role menu](/tarubot/admin/self-service-roles/): categories with their names, descriptions, limits and states, and the IDs of the roles on offer. That's configuration, and each change to it is audited with the menu's identifiers, never the names or descriptions officers typed.

Members, guests and officers [pick their own roles](/tarubot/use/pick-your-roles/) from it on My roles. Their picks live only in Discord, which is the record of who holds which role:

- **While a change waits**, TaruBot keeps the role IDs involved. It clears them from the live record when the job ends, at most 7 days after your last save. Backups taken while it waited, and the database provider's point-in-time recovery, keep them for their own retention (up to a year). A record that you changed your roles, and when (never which roles), is deleted after 30 days.
- **No audit of choices.** Saving on My roles writes no audit record. The job's result holds counts, such as how many roles were added, never which; its diagnostics, the logs and issue reports never name a role someone picked.
- **Officers don't see who.** Background work shows someone else's role-choice job as "A member", `/sync status` and its **Full details (JSON)** leave the person out too, and a member's `/guest status` record never lists their role-choice jobs, to officers or to the member.
- **Discord shows roles.** A role someone picks is visible to everyone in the server, like any role, and Discord's audit log shows each change, with TaruBot's reason, to staff who can read it. TaruBot can't hide what Discord shows.

After a database restore, the changes the backup caught waiting are closed before TaruBot starts on it (the restore tool does it), so a restored copy never applies older choices over newer ones.

## Mod mail

A member or guest opens a [mod mail](/tarubot/use/mod-mail/) case with `/modmail` or on the dashboard, and talks with the server's officers there ([officers' guide](/tarubot/admin/mod-mail/)). Mod mail holds the most private text TaruBot keeps, so:

- **The text is encrypted.** Each case's topic and every message are padded (so their stored length says little) and encrypted with AES-256-GCM under the deployment's `MODMAIL_KEY` ([configuration](/tarubot/deploy/configuration/#optional-mod-mail)), which lives in the deployment's settings, never in the database. A database dump, the provider's point-in-time recovery and anyone who can only read the database see it encrypted. Each piece of text is bound to its server, case and opener, and a message also to who wrote it and how it was signed, so text copied to another row, or re-attributed to someone else, can't be read there. Losing the key loses every case.
- **What encryption doesn't cover:** someone who can write to the database could delete cases, or make themselves an officer through TaruBot's settings tables and read cases on the dashboard.
- **Backups can read cases, on purpose.** TaruBot's own encrypted backups, where the deployment sets them up, keep an encrypted copy of the bot's settings, `MODMAIL_KEY` included, next to each database dump, encrypted to the same recipients. So **whoever holds the backups' age identity can read every mod mail case in them**. That's a deliberate trade-off: a lost installation can be restored in full, cases included, and that copy is how a lost key is recovered.
- **What isn't encrypted:** who opened each case and when, its number and state, who wrote each message and how they signed it, and the read log. That's what access and retention work with.
- **Who can read it:** the server's officers, all of them, and the member who opened the case while they hold Member or Guest. Anyone else gets the same "Page not found" as a case that doesn't exist. Officers always see who opened a case and who wrote each reply; the member sees an officer's name, or "The officers" where the officer chose that.
- **Every read is recorded:** who opened a case's page and when (repeat views within a minute count once), and whose list showed a case's topic (once an hour), shown to officers only. An officer removed from the server or demoted loses the pages on their next request.
- **Nothing in Discord:** `/modmail`'s form text comes with the command, and a case opened on the dashboard never touches Discord; TaruBot reads no messages or DMs. `/modmail`'s replies are always private. Pings to officers and DMs to the member carry a case number, a link and the server's name, never the text or the member's name. The background jobs that send them hold the case's ID and nothing else.
- **Not in logs or reports:** the text never reaches TaruBot's logs, issue reports, audit log or error messages. Text that can't be decrypted files one issue report that says so, without the text.
- **Deleted after 90 days:** a closed case, its messages, read log and history are deleted 90 days after it closed; reopening cancels that. Nobody deletes a case by hand. Only turning mod mail on or off goes in the long-lived audit log, so nothing there records who opened cases once they're gone. Backups keep what they captured for their own retention, and restoring an older backup brings back cases that have since expired until TaruBot's next pass deletes them.
- **The runtime is trusted:** the key sits in the bot's own settings, so someone who controls its container, its settings or the Docker host it runs on, or a bug that lets code run inside the bot, could read every case still held. Encryption protects a copy of the database on its own, not the backups, which carry the key.

## Pauses

An officer with the right permission can [pause](/tarubot/admin/moderation/) one person's use of one feature for a while. Pauses are officer-side records, and the person paused can read their own:

- **What's kept.** One `member_blocks` row per pause and feature: the person, the feature, the reason, when it was set and when it ends, who set it and at what level (server manager or officer), and, once it ends early, who lifted it and why. A pause that ran out is closed the next time anything is written for that person, with no lifter and the reason "expired"; it is still shown as ending when it was due to, not when it was closed. Pauses are never deleted or edited, by a database trigger, and stay until a server's data is removed; there is no retention pass.
- **The reason is private text,** kept like a guest revocation. The paused person is shown it, with the feature and the end, and **never who set the pause** (owner decision, 2026-10-12). Officers who can see pauses see it too, and also who set each pause and who lifted it, except for their own pauses if they are paused themselves, which they read as the paused person does. It never goes in the audit log, TaruBot's logs, issue reports, Discord messages or DMs.
- **The audit log** records that someone paused or lifted which features for which person, and when a pause was due to end, with no reason.
- **Nothing is sent.** A pause posts nothing and sends no DM; Discord learns nothing of it, and the person's roles are never touched.
- **Anyone can read their own,** with [`/moderate status`](/tarubot/reference/commands/#moderate-status), or on the Moderation page if they are an officer: the features, ends and reasons, not who set them or who lifted them.
- **Server managers and bots can't be paused.** TaruBot refuses to pause either, and ignores any pause stored for a server manager.
- **Backups.** A restore brings back the pauses its backup held, so they can differ from the current ones: a pause lifted since can reappear (unless its own end has passed) and one set since can be missing. Officers check the Moderation page after one.

## The sender of a suggestion

A [public suggestion](#public-suggestions) never names its sender, and nothing public does. TaruBot does record the sender privately, in an audit entry written once GitHub confirms the issue, and **since 2.45.0 officers who can see pauses can look that sender up by the issue's number** on the Moderation page, to pause their `/suggest`. This is new visibility (owner decision, 2026-10-12); before, only the deployment's operator, reading the database, could. The lookup covers the officer's own server and reads only that entry, so it finds nothing for an attempt GitHub didn't confirm or an entry a restore lost.

## Dashboard sessions and fonts

When the dashboard is enabled, Discord sign-in asks only for `identify`. TaruBot uses Discord's token once to learn the user ID, then drops it. An admitted member, guest or officer receives an opaque browser session; the database stores its hash, user ID and timestamps. Sessions expire after 30 days absolutely or 7 days without activity, and each person keeps at most 10: signing in on another browser ends their oldest. **Sign out** ends the current browser's session; **Sign out everywhere** ends all sessions for that user. Someone no page admits gets no session.

Members and guests see only My roles, where they change only their own roles, and Mod mail, where they open, see and write in only their own cases. Officers also see Server configuration and Background work, which show the admitted server's configuration and work and change nothing, Role menu, where they change the server's self-service role menu, Mod mail's inbox, where they read and answer every case, and Moderation, where they see who is paused and why, who set each pause (but not their own, if they are paused themselves) and who sent a suggestion, and pause and lift people within their limits (a change needs a Discord sign-in from the last 15 minutes). Member, role and channel names come from that server's gateway cache at render time, not a new stored directory. On Server configuration and Role menu, officers can see the name of any channel TaruBot can see when a check names it or a menu role opens it, including channels their own Discord roles don't open: each menu role's **Opens:** list is how they check the officer-channel heuristic. Application request logs use route patterns and reference IDs, not queries, cookies, form values or client addresses. The limits on how many forms someone can send and how often they can sign in are counted in memory by Discord user ID, never by address, and a restart forgets them. The caps that keep sign-ins from overloading TaruBot's connection to Discord count sign-ins across everyone (how many start each minute and how many run at once), not people.

TaruBot serves the dashboard's stylesheet, fonts and icons itself, from the dashboard's own address. The pages' content security policy admits nothing from another site, so the browser makes no requests to Google Fonts or any other third party while showing them. No client scripts are loaded. If fonts cannot load, local system fonts remain usable.

## Status page

Once the dashboard is on, anyone can open its [status page](/tarubot/deploy/monitoring/#public-status-page), `/status`, without signing in. It shows whether TaruBot is working now and its daily uptime over the last 90 days, and nothing about any server or person: no server names, no counts of servers or members.

- **What's recorded.** Every five minutes while it runs, TaruBot stores one sample: whether it was ready, whether its Discord connection and database were up, whether the Lodestone was answering, whether Discord changes were live, and its version. Samples are deleted after 90 days, apart from the very first, which TaruBot keeps to know when its history began.
- **Visitors.** The page needs no sign-in and sets no cookie. TaruBot stores nothing about who opens it; the request log records the route, status and timing as for every page, never an address. Its visit limit counts every visitor together.
- **When TaruBot is down,** a deployment with bundled Caddy shows a static offline page in its place. Caddy keeps no access log.

## Issue reports

When an operator configures a reports repository, `/issue` and automatic reports open issues there. A report carries:

- the deployment's version, readiness and Lodestone status;
- active and recently failed jobs, where a self-service role choice shows only by kind, never with its member;
- the server's TaruBot settings and roster state;
- for `/issue` and work about one member: the member's Discord username and ID (for `/issue`), links, main character, nickname state, guest and officer standing, recent work other than self-service role choices (not even in the member's own `/issue`), and recent audit records (a report about a failed role choice doesn't name the member);
- the newest log records.

Before a report is saved, TaruBot removes known secret shapes (Discord and GitHub tokens, authorization headers, passwords in URLs, PEM blocks, heartbeat ping URLs), the deployment's own secret values, and the values a failed database query was given, since they can hold what someone submitted. A member's own description goes into the issue as a quoted block, so it can't mention anyone on GitHub. Reports go to the repository the operator chose; the operator should keep it private.

## Public suggestions

`/suggest` is the one command whose words go public. In the FC server the TaruBot project's own deployment serves, it posts a member's idea as an issue in TaruBot's public GitHub repository, as the project's GitHub App. Other servers refuse it, except a development deployment's test server (`TEST_GUILD_ID`), which previews suggestions into the operator's private reports repository instead and never posts publicly.

- **Posted:** the idea, after TaruBot removes links, IP addresses, Discord mentions, email addresses, credential shapes, long ID numbers and invisible characters, and turns `@` into `＠`; a fixed first line; and the running version. A final check refuses the post if anything slipped through.
- **Never posted:** the member's Discord name or ID, the server, its channels and roles, characters and FC data, logs and settings.
- **Kept privately:** an `audit` row per suggestion records who sent which issue, and the limits count those rows. Nothing else about a suggestion is saved. Officers who can see pauses can look the sender up by the issue's number ([the sender of a suggestion](#the-sender-of-a-suggestion)), and so can the operator in the database.

A public issue can be closed or deleted, but GitHub's notification emails, event feed and archives may already hold a copy. [Suggest a feature](/tarubot/use/suggest-a-feature/#what-goes-public) is the members' version of this list.

## Replies and messages

- **Replies are private** to the person who ran the command. Officers see more detail than members, but members never see officers' reasons, other members' records, job internals or diagnostics. The exceptions: an applicant sees the denial reason for their own application, and a paused person sees the reason for their own [pause](#pauses), never who set it.
- **No pings.** Every message is sent with mentions disabled, so names in replies and posts never notify anyone. The one exception is a [mod mail](#mod-mail) ping, which mentions the Officer role, and only it, in the officer notifications channel.
- **Guest answers** appear only in the review message in the officers' channel, never in replies, status views or downloads.
- **Full details (JSON)**, the only way records reach Discord as a file, is offered only to officers, and never includes tokens or application answers.

## Logs

The bot's logs are structured JSON. They never contain tokens, passwords, message or job payloads, command option values, or library error text; a failure is logged with its code, the command path and the approved message. See [Replies and error codes](/tarubot/reference/replies/#log-levels).
