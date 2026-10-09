---
title: Roadmap
description: TaruBot's planned major versions, from the current bot to web pages for officers and members, ModMail and richer Lodestone profiles.
---

TaruBot's major versions are planned outcomes, not release numbers: their features ship in ordinary 2.x releases as they're ready. Dates, detailed feature lists and implementation technology are decided when each milestone is planned.

| Version | Milestone | Intended outcome |
| --- | --- | --- |
| **v2: Released; being stabilized** | Production-ready bot | Character verification, roster-based access, guest applications, nicknames and the gil ledger, running in production and supportable. |
| **v3: In progress** | Stabilization and web baseline | Finish stabilizing v2, and add the web front end's baseline: a dashboard where officers and administrators sign in with Discord and see the bot's status, configuration and task queues, released in 2.37.0. This phase is view only. v4's first feature doesn't wait for the rest of v3's stabilization. |
| **v4: In progress** | Member web app | Members and guests sign in to their own pages, and can make the first changes on the web. The first feature is self-service roles, replacing reaction roles: officers build a menu of roles such as pronouns or games, and members and guests pick their own. Next is raid and activity scheduling with party composition and reminders, which came from a member's suggestion ([#45](https://github.com/deconfined/tarubot/issues/45)). |
| **v5: Planned** | ModMail | Bring ModMail functionality into TaruBot. |
| **v6: Planned** | Expanded Lodestone profiles | Add richer Lodestone profile features, comparable to Kupo Bot or Ser Aymeric. |

The officers' role menu, released in 2.39.0, is the first officer action on the web; others come later, and their version isn't decided yet.

**Sequence:** stable bot with an officer view → member self-service → private support → expanded character features.

## Continuity across versions

- v2 already uses the Lodestone for ownership verification and for FC roster and rank evidence. v6 expands the profile-facing features.
- The web front end, from v3's officer dashboard to v4's member pages, should reuse the established verified identity, FC membership and rank evidence, and authorization rules, so Discord and the web agree about access. A displayed rank or role is not a substitute for the authorization checks.
- As web actions arrive, starting with v4's self-service role menu, they keep the bot's transactional decisions and durable delivery and recovery. Member self-service keeps Discord as the record of who holds which role; officer changes are audited.
- What each page shows to whom, web actions, scheduling details, ModMail behavior and profile features are defined when their milestones are planned.
