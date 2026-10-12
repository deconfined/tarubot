---
title: Roadmap
description: TaruBot's major versions, from the current bot to web pages for officers and members, ModMail (released in 2.43.0) and richer Lodestone profiles.
---

TaruBot's major versions are planned outcomes, not release numbers: their features ship in ordinary 2.x releases as they're ready. Dates, detailed feature lists and implementation technology are decided when each milestone is planned.

| Version | Milestone | Intended outcome |
| --- | --- | --- |
| **v2: Released; being stabilized** | Production-ready bot | Character verification, roster-based access, guest applications, nicknames and the gil ledger, running in production and supportable. |
| **v3: In progress** | Stabilization and web baseline | Finish stabilizing v2, and add the web front end's baseline: a dashboard where officers and administrators sign in with Discord and see the bot's status, configuration and task queues, released in 2.37.0 as a view-only baseline. v4's first feature, self-service roles, didn't wait for the rest of v3's stabilization, which is tracked in [#108](https://github.com/deconfined/tarubot/issues/108). |
| **v4: In progress** | Member web app | Members and guests sign in to their own pages, and can make the first changes on the web. The first feature is self-service roles, replacing reaction roles: officers build a menu of roles such as pronouns or games, and members and guests pick their own. Next is raid and activity scheduling with party composition and reminders, which came from a member's suggestion ([#45](https://github.com/deconfined/tarubot/issues/45)). |
| **v5: Released** | ModMail | Members and guests reach their officers privately: `/modmail` or the dashboard opens a case, and the conversation happens on the dashboard's Mod mail page, encrypted at rest, with pings that carry only a case number. Released in 2.43.0. |
| **v6: Planned** | Expanded Lodestone profiles | Add richer Lodestone profile features, comparable to Kupo Bot or Ser Aymeric. |

Self-service roles shipped in two releases: the officers' role menu in 2.39.0, the first officer action on the web, and members' and guests' My roles page in 2.40.0, the first member action. Other officer actions come later, and their version isn't decided yet.

**Permissions and moderation:** 2.44.0 gives every TaruBot function a named [permission](/tarubot/admin/access/), carried only by the roles TaruBot manages. Next come pausing one person's use of a feature (such as `/suggest`), choosing on the dashboard which permissions each role carries, starting from named templates, and roles that follow the FC's in-game ranks. Their versions aren't decided yet.

**Sequence:** stable bot with an officer view → member self-service → private support → expanded character features.

## Continuity across versions

- v2 already uses the Lodestone for ownership verification and for FC roster and rank evidence. v6 expands the profile-facing features.
- The web front end, from v3's officer dashboard to v4's member pages, should reuse the established verified identity, FC membership and rank evidence, and authorization rules, so Discord and the web agree about access. A displayed rank or role is not a substitute for the authorization checks.
- As web actions arrive, starting with v4's self-service role menu, they keep the bot's transactional decisions and durable delivery and recovery. Member self-service keeps Discord as the record of who holds which role; officer changes are audited.
- What each page shows to whom, web actions, scheduling details and profile features are defined when their milestones are planned. ModMail's behavior was decided with the owner for 2.43.0: see [Mod mail](/tarubot/admin/mod-mail/).
