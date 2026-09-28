---
title: Access and synchronization
description: How TaruBot proves ownership, reads rosters, decides access, and brings Discord in line.
sidebar:
  order: 2
---

TaruBot separates **evidence** (what it has proved or observed) from **decisions** (what access each member should have) and **effects** (the Discord changes that make it so). Evidence and decisions live in PostgreSQL; effects are durable jobs that can wait, retry and resume.

## Proof of ownership

A link between a Discord member and a character is **trusted** when it came from:

- **a Lodestone token**: `/claim` issues a random token; the member puts it in the character's public biography; `/verify` reads the profile fresh and compares. The token is bound to the server, the member and the character, only its hash is stored, it expires (30 minutes by default), and it can be used once;
- **an officer's assignment** with a recorded reason; or
- **an import** from the server's previous bot.

One character can be linked to only one member in a server. A pending claim, or a character's FC as its profile shows it, never counts as evidence of anything.

## Rosters

Membership comes only from the FC's roster on the Lodestone. TaruBot reads each linked FC's complete member list on a schedule (every six hours by default, with jitter), on `/refresh` when the last one is stale, and early to confirm a departure. A roster read shared by several servers is fetched once.

A roster is **accepted** only when it's complete and consistent: the FC's identity and member count are checked before and after the crawl, every page must be present and in order, member IDs must be valid and unique, and the distinct count must match. A missing page, a repeated page, a timeout or a parser failure rejects the whole observation, and the previous accepted roster stays. An empty roster is accepted only with affirmative evidence that the FC is empty.

A **fresh** roster is one accepted within the roster interval. Positive membership can come from one fresh, complete roster.

## Deciding access

Access is recomputed from the evidence, never accumulated. For each member, TaruBot takes the **union over all their trusted links**:

- any character with confirmed membership in the linked FC gives **Member**;
- any such character holding the configured officer rank adds **Officer**, unless its link came from an assignment by an officer without server-manager authority;
- if none is in the FC, the member gets **Guest**: automatically from a trusted link (while evidence is fresh), from former membership, or from a durable grant;
- the linked FC's leader character gives **FC Leader**.

Overrides sit on top: an officer's Guest **revocation** suppresses every kind of Guest access, and a manager's officer **grant** or **revocation** overrides the rank. FC membership always gives Member, even with Guest revoked.

When evidence is **uncertain**, such as a stale roster or a link not yet checked against one, TaruBot never adds a new automatic role, but keeps roles a member already holds. Explicit grants and revocations still apply.

## Departures

A character leaves the FC only when **two complete accepted rosters, at least 60 seconds apart**, both lack it. The first absence marks it as missing and schedules a confirming read about a minute later; reappearing in between clears the mark. The state survives restarts. A member with several characters loses Member only when none is confirmed or awaiting confirmation. A confirmed former member keeps Guest for the FC that is currently linked, unless revoked.

## Grants and first activation

Durable Guest grants record their provenance: an approved application, an officer, the previous bot, or first activation. `/guest reset` ends grants without deleting them.

When a server migrates from a previous bot, its first activation writes one-time grants for existing Guest holders from a preview plan that the operator confirms by checksum, so nobody loses access at the switch. New servers skip this: they go live with their first `/config` change or `/setup onboarding confirm:true`.

## Revisions and reconciliation

Each server's configuration carries a **revision**. Every configuration change advances it and queues a full repair pass for the server. Queued work records the revision it was computed for, and a worker checks it again before each Discord write: work computed under an older configuration is superseded and recomputed, never applied.

Reconciliation happens at two scopes:

- **One member** (`reconcile.user`), after a link, unlink, main or nickname change, grant, revocation, or a member event such as a join or a role changed by hand.
- **The whole server** (`reconcile.guild`), after an accepted roster, a configuration change, startup, or the bot rejoining.

A pass compares desired roles and nicknames with Discord's current state and sends only the differences. TaruBot recognizes the Discord events its own changes cause, so they don't set off more work.

Other passes: **channel access** (`channels.access`) keeps onboarding's visibility policy, and **role layout** (`roles.layout`) keeps the managed roles' display and order while the switch is on.

After a pass writes a member's roles, TaruBot records their Member, Guest, Officer and FC Leader for the officers' [status posts](/tarubot/admin/notices-and-updates/#member-status-changes), but only decisions that don't depend on the roles the member already holds: a decision kept on unconfirmed evidence, such as an out-of-date roster, waits until a fresh roster confirms it. The accepted roster records confirmed departures in the same transaction, and one job per server posts what changed about 2 minutes after the first change.

## Nicknames

With nickname sync on, a member's nickname is their main character's name, cut to 32 characters, and follows a confirmed rename. TaruBot records the nickname it replaced and restores it when sync is turned off or the main link ends, unless the member changed it in the meantime. A nickname changed by anyone else suspends sync instead of being overwritten. Discord never lets a bot change the server owner's nickname, so TaruBot doesn't try.

## Profile refreshes

Each linked character's profile is refreshed about daily, to keep names and worlds current; FC hints from profiles are stored separately from roster evidence and never decide access.

- A character is queued at most once an hour, whatever the outcome, so a failing profile can't hammer the Lodestone.
- A private profile is an answer, not an outage: the refresh completes as private and waits for the next interval, and links stay.
- A "not found" is recorded; a second one at least an hour later ends every link to the character, audited as automatic, with an officer notice. Any sighting in between clears the first.
- After a Lodestone 429, every request waits out a shared cooldown, and queued jobs wait without spending attempts.

## Effects and delivery

Every Discord change is a job in PostgreSQL. Workers lease a job, check that the configuration and their lease are still current, make the change, read it back where it matters, and record the outcome. A missing permission or a deleted role parks the job as **blocked** until an officer fixes the cause; a temporary error retries with backoff; after repeated failures it stops as **failed** and is reported. While Discord changes are switched off, jobs are parked as **paused** and resume when they're switched back on. Each outcome is visible in `/sync status`.
