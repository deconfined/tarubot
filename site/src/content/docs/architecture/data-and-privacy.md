---
title: Data and privacy
description: What TaruBot stores, how it keeps values exact and history intact, what it keeps about self-service role choices, what issue reports and public suggestions carry, and what members see.
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
| Records | `audit`, `imports`, `issue_reports` | The audit trail, imports from a previous bot, and saved issue reports. |
| Web sessions | `web_sessions` | Hashed session tokens, Discord user IDs, authentication and activity times, and expiry; never the raw browser token or Discord's OAuth token. |
| Schema | `schema_migrations` | Which migrations were applied, with their checksums. |

The numbered files in [`migrations/`](https://github.com/deconfined/tarubot/tree/main/migrations) define every table, with comments, and are the authority for the schema. The bot refuses to start on a schema it doesn't expect, and an applied migration is never edited: every change is a new file.

## Exact values

- **IDs** from Discord and the Lodestone are stored as decimal text, checked to be valid unsigned 64-bit numbers, never as floating-point numbers.
- **Gil** is a PostgreSQL `bigint`, handled as an exact integer end to end. A balance can't go below zero, and every entry records the balance after it.
- **Times** are UTC instants.

## History is kept

- Ending a link, a grant or a revocation marks it ended; the record stays.
- Ledger entries are immutable: database triggers refuse updates and deletes, and corrections are new entries that name the entry they correct.
- Every officer decision, and every other command decision, is written with its **audit** record and its queued Discord work (the **outbox**) in one transaction, on one database connection. Either all three commit, or none does, so no decision is ever made without its record or its follow-up. A member's own choices for themselves are different: a role save on My roles, like the `/main` and `/nickname` preferences, commits only its state and queued work without an audit record, and Discord is the record (owner decision Q4 A; see [Self-service roles](#self-service-roles)).

Expired claim challenges are deleted a week after they expire. Links, grants, rosters, audits, ledger entries, imports and job history are kept, apart from a member's finished role-choice jobs, which TaruBot deletes after 30 days; an operator can prune diagnostic history, but should keep financial and access records.

## What's stored about a member

For each member, a server's database holds their Discord user ID, whether they're in the server and when they joined; their linked characters and each link's history; their main character and nickname state, including the nickname TaruBot replaced; guest applications with their answers, grants, revocations and officer overrides; ledger entries they recorded; audit records of changes they made or that were made to them; and their queued Discord work.

It doesn't store which self-service roles a member picked: Discord holds them ([self-service roles](#self-service-roles)). It doesn't store Discord messages or online status: Discord sends it no message events and no online status, because TaruBot asks for neither the message intents nor Presence. It doesn't store Discord usernames outside a saved `/issue` report. It never sees Lodestone passwords, and it keeps a claim token only as a hash; the reply that shows the token is private.

## Self-service roles

Officers list existing Discord roles on the [role menu](/tarubot/admin/self-service-roles/): categories with their names, descriptions, limits and states, and the IDs of the roles on offer. That's configuration, and each change to it is audited with the menu's identifiers, never the names or descriptions officers typed.

Members, guests and officers [pick their own roles](/tarubot/use/pick-your-roles/) from it on My roles. Their picks live only in Discord, which is the record of who holds which role:

- **While a change waits**, TaruBot keeps the role IDs involved. It clears them from the live record when the job ends, at most 7 days after your last save. Backups taken while it waited, and the database provider's point-in-time recovery, keep them for their own retention (up to a year). A record that you changed your roles, and when (never which roles), is deleted after 30 days.
- **No audit of choices.** Saving on My roles writes no audit record. The job's result holds counts, such as how many roles were added, never which; its diagnostics, the logs and issue reports never name a role someone picked.
- **Officers don't see who.** Background work shows someone else's role-choice job as "A member", `/sync status` and its **Full details (JSON)** leave the person out too, and a member's `/guest status` record never lists their role-choice jobs, to officers or to the member.
- **Discord shows roles.** A role someone picks is visible to everyone in the server, like any role, and Discord's audit log shows each change, with TaruBot's reason, to staff who can read it. TaruBot can't hide what Discord shows.

After a database restore, the operator closes the changes the backup caught waiting, so a restored copy never applies older choices over newer ones.

## Dashboard sessions and fonts

When the dashboard is enabled, Discord sign-in asks only for `identify`. TaruBot uses Discord's token once to learn the user ID, then drops it. An admitted member, guest or officer receives an opaque browser session; the database stores its hash, user ID and timestamps. Sessions expire after 30 days absolutely or 7 days without activity, and each person keeps at most 10: signing in on another browser ends their oldest. **Sign out** ends the current browser's session; **Sign out everywhere** ends all sessions for that user. Someone no page admits gets no session.

Members and guests see only My roles, where they change only their own roles. Officers also see Server configuration and Background work, which show the admitted server's configuration and work and change nothing, and Role menu, where they change the server's self-service role menu. Member, role and channel names come from that server's gateway cache at render time, not a new stored directory. On Server configuration and Role menu, officers can see the name of any channel TaruBot can see when a check names it or a menu role opens it, including channels their own Discord roles don't open: each menu role's **Opens:** list is how they check the officer-channel heuristic. Application request logs use route patterns and reference IDs, not queries, cookies, form values or client addresses. The limits on how many forms someone can send and how often they can sign in are counted in memory by Discord user ID, never by address, and a restart forgets them. The caps that keep sign-ins from overloading TaruBot's connection to Discord count sign-ins across everyone (how many start each minute and how many run at once), not people.

TaruBot serves the dashboard's stylesheet, fonts and icons itself, from the dashboard's own address. The pages' content security policy admits nothing from another site, so the browser makes no requests to Google Fonts or any other third party while showing them. No client scripts are loaded. If fonts cannot load, local system fonts remain usable.

## Issue reports

When an operator configures a reports repository, `/issue` and automatic reports open issues there. A report carries:

- the deployment's version, readiness and Lodestone status;
- active and recently failed jobs;
- the server's TaruBot settings and roster state;
- for `/issue` and work about one member: the member's Discord username and ID (for `/issue`), links, main character, nickname state, guest and officer standing, recent work other than self-service role choices, and recent audit records (a report about a failed role choice doesn't name the member);
- the newest log records.

Before a report is saved, TaruBot removes known secret shapes (Discord and GitHub tokens, authorization headers, passwords in URLs, PEM blocks, heartbeat ping URLs), the deployment's own secret values, and the values a failed database query was given, since they can hold what someone submitted. A member's own description goes into the issue as a quoted block, so it can't mention anyone on GitHub. Reports go to the repository the operator chose; the operator should keep it private.

## Public suggestions

`/suggest` is the one command whose words go public. In the FC server the TaruBot project's own deployment serves, it posts a member's idea as an issue in TaruBot's public GitHub repository, as the project's GitHub App. Other servers refuse it, except a development deployment's test server (`TEST_GUILD_ID`), which previews suggestions into the operator's private reports repository instead and never posts publicly.

- **Posted:** the idea, after TaruBot removes links, IP addresses, Discord mentions, email addresses, credential shapes, long ID numbers and invisible characters, and turns `@` into `＠`; a fixed first line; and the running version. A final check refuses the post if anything slipped through.
- **Never posted:** the member's Discord name or ID, the server, its channels and roles, characters and FC data, logs and settings.
- **Kept privately:** an `audit` row per suggestion records who sent which issue, and the limits count those rows. Nothing else about a suggestion is saved.

A public issue can be closed or deleted, but GitHub's notification emails, event feed and archives may already hold a copy. [Suggest a feature](/tarubot/use/suggest-a-feature/#what-goes-public) is the members' version of this list.

## Replies and messages

- **Replies are private** to the person who ran the command. Officers see more detail than members, but members never see officers' reasons, other members' records, job internals or diagnostics. The one exception: an applicant sees the denial reason for their own application.
- **No pings.** Every message is sent with mentions disabled, so names in replies and posts never notify anyone.
- **Guest answers** appear only in the review message in the officers' channel, never in replies, status views or downloads.
- **Full details (JSON)**, the only way records reach Discord as a file, is offered only to officers, and never includes tokens or application answers.

## Logs

The bot's logs are structured JSON. They never contain tokens, passwords, message or job payloads, command option values, or library error text; a failure is logged with its code, the command path and the approved message. See [Replies and error codes](/tarubot/reference/replies/#log-levels).
