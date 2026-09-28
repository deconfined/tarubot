# TaruBot Requirements

- **Status:** Draft for owner review
- **Prepared:** 2026-09-21
- **Amended:** 2026-09-23 (owner launch decisions; see "Approved launch amendments"); 2026-09-24 (owner reply-session decisions; see "Approved reply-session amendments"); 2026-09-24 (owner hosting decision; see "Approved hosting amendment"); 2026-09-24 (owner Lodestone decisions; see "Approved Lodestone amendments"); 2026-09-24 (owner issue-reporting decisions; see "Approved issue-reporting amendments"); 2026-09-25 (hosting follow-up; see "Approved hosting amendment"); 2026-09-25 (owner officer-notice decisions on issue #29; see "Approved officer-notice amendments"); 2026-09-25 (owner changelog decisions; see "Approved changelog amendments"); 2026-09-25 (owner documentation-site decisions; see "Approved documentation-site amendments"); 2026-09-25 (owner public-suggestion decisions; see "Approved public-suggestion amendments"); 2026-09-25 (owner status-notice decisions on issue #31; see "Approved status-notice amendments"); 2026-09-26 (owner SSH-deploy decisions on issue #41; see "Approved SSH-deploy amendments"); 2026-09-26 (owner channel-obfuscation decision on issue #47; see ACCESS-01); 2026-09-26 (owner staging decisions on issue #50; see "Approved staging amendments")
- **Deliverable:** A TypeScript Discord bot for Final Fantasy XIV Free Companies

### Approved implementation amendments (2026-09-21)

The owner requested `/version [commits]` for any guild user. It displays the installed SemVer and the latest requested number of GitHub commit IDs, links, and titles from `deconfined/tarubot`; show ✅ next to an ID only when GitHub confirms its signature is valid and verified. Default to five commits and bound requests to ten. Record versioned development milestones and retain local version output when GitHub is unavailable.

This implementation is a complete rewrite of TaruBot and uses major version **2**. `package.json` defines its current version, with development milestones recorded in `CHANGELOG.md`. Every coherent change set must increment SemVer appropriately: major for incompatible changes, minor for compatible features, and patch for compatible fixes or maintenance, including documentation and tests.

The owner requires a feature-branch/PR/merge delivery workflow. Pull requests run build and test checks; merges to `main` build and publish both TaruBot and Nodestone images to GHCR. Normal Compose deployments pull published images, with explicit source-build overrides retained for development.

The owner requested non-ephemeral output in the development server so other testers can observe the session. `PUBLIC_TEST_RESPONSES` overrides response visibility for the configured test guild, including command/component success and error replies. Operation authorization and other guilds' default presentation policy remain independently enforced.

The owner additionally requested a development startup announcement in `#chat`, containing the current session's actions grouped by human tester, coding assistant, and bot. The owner requested `/setup` to create/reuse Member, Guest, Officer, and FC Leader roles; the Officer role grants bot-only officer-command access. An optional configured in-game FC rank may derive Officer eligibility from accepted roster evidence. Explicit officer grants/revocations and changes to this authority mapping require a server manager with Manage Roles. This is a specific extension of the original rank-mapping scope, not a general arbitrary role-mapping system.

The owner additionally requested automatic separate member-list display for those four configured roles and descending hierarchy **FC Leader → Officer → Member → Guest** in one consecutive block, without unrelated roles interleaved. Setup must reuse existing canonical roles, including unprefixed Member and Guest roles, before creating new ones; it may rename adopted roles while retaining their IDs, permissions, and assignments. Durable layout reconciliation applies this presentation policy at startup, setup, role-configuration changes, role events, and guild refresh, respecting current effect activation, Discord hierarchy, and the guild's role-layout switch (CFG-07).

(Superseded on 2026-09-25: the sidecar follows the selectors live since 2.19.0, and since 2.20.0 it parses with TaruBot's own parser, with no Nodestone. See "Approved Lodestone amendments".) On 2026-09-22 the owner required ongoing tracking of the latest upstream Nodestone code and CSS selectors, and subsequently required Nodestone as a Git submodule for solution builds. `vendor/nodestone` supplies the parser source through a local dependency; selectors remain an independent Git dependency. A checked update workflow follows both upstream HEADs and advances the submodule pointer, lockfile, and build metadata; deployed images retain exact revision identities and parser-source fingerprints for reproducibility. The sidecar periodically reports upstream freshness so parser dependencies are not silently left on old revisions.

The owner additionally requires modular extension points: command definitions/handlers and gateway event handlers live in separate discoverable modules, loaded dynamically rather than listed in a central dispatch switch. Command deployment and runtime use the same discovered definitions. First-party code, scripts, tests, and supported configuration formats must carry explanatory comments; strict JSON configuration has companion documentation.

The owner approved Bun throughout (package management, tooling, tests, and production runtime), reuse of the existing production Discord application, and interpreting legacy timezone-naïve timestamps as UTC. Runtime versions are pinned in `package.json` and the container definitions. Production first-party code remains compiled ESM with explicit type checking.

The owner subsequently selected a source-built Nodestone Docker sidecar after the published npm package failed its compatibility gate. This supersedes in-process/published-package mandates in Sections 1, 9, 11, 13, and 14. The normal services are now `tarubot`, `nodestone`, and `postgres`; TaruBot accesses Nodestone through a typed HTTP adapter. Nodestone source and selector revisions must be pinned, with any sidecar compatibility changes documented and contract-tested. Lossless IDs, validated completeness, bounded/cancellable upstream work, and all domain invariants remain mandatory.

### Approved launch amendments (2026-09-23)

The owner approved these decisions for the production cutover of guild `1036062273631952955` (linked FC `9232097761132958152`). They supersede conflicting text elsewhere in this document. The referenced numbered requirements carry the normative detail.

**Production hosting.** (Superseded the same day by the "Approved hosting amendment"; the single-writer rule and the authorization rule stand.) Production runs on DigitalOcean App Platform, attached to a separately provisioned DigitalOcean Managed PostgreSQL cluster instead of the inline dev database (DEPLOY-DO-01). Exactly one bot process writes to that database, enforced by a PostgreSQL writer lease (MIG-13). The owner holds the production Discord application `965294750741692416`, whose Server Members intent is enabled. The production application is removed from the development guild `1040379370159743139` before cutover and must not be installed there. Each of the following is a separately authorized operator step: provisioning the cluster, creating or updating the app, changing trusted sources, resetting tokens, and registering production commands. Generating or validating a specification authorizes none of them. (Since 2026-09-26 the owner's approval of a `production` deployment in GitHub authorizes the deploy and command registration its plan lists; see "Approved SSH-deploy amendments".)

**Production token before the window.** Before the maintenance window, the production token may be used only for read-only REST inspection (OPS-14) and for dress-rehearsal runs (the Discord snapshot, roster acquisition, and preview) against a disposable rehearsal database while the legacy bot is still running. The token is reset at the start of the window, after the legacy process stops (MIG-13).

**Multi-character access (standing rule).** A user may verify, be assigned, or be imported with several characters. Access is the union over the user's active trusted links:
- Any linked character with confirmed membership in the guild's linked FC makes the user a Member.
- Any such character holding the configured FC officer rank gives the Officer role and its bot-only officer authority.
- A user with at least one trusted link and no FC-member character is automatically a Guest.

This registered-user Guest applies in every configured guild, whether or not lobby onboarding (`/setup`, ACCESS-01) is enabled; onboarding governs only channel visibility. A pending `/claim` confers nothing (ROLE-07).

**First-activation grandfathering.** At the first activation of an imported guild, every human then in the server who does not qualify for Member receives a durable `grandfathered` guest grant. It behaves exactly like an approved grant: it lasts until an explicit `/guest revoke`, and FC Member precedence still applies. (Revised on 2026-09-24: `/guest reset` also ends it, as it ends every active grant. A grant that `/guest reset` ended before first activation still counts there as an existing grant, so its holder receives no `grandfathered` grant; see MIG-14.) It is created exactly once, with its own provenance and audit, from a complete Discord enumeration and settled roster evidence (no linked FC character still awaiting departure confirmation), and only for the plan whose checksum the operator confirmed from the read-only preview. Existing approved, manual, and imported grants are not duplicated. Afterwards the normal rules apply: later newcomers receive nothing automatically unless ROLE-07 or an officer decision applies, and humans who joined between the enumeration and go-live are reported for an officer decision (MIG-14).

**Role layout switch.** Managed-role presentation is a per-guild setting (CFG-07). This covers separate member-list display and the consecutive FC Leader → Officer → Member → Guest block. Imported guilds, including the production guild, launch with it off; every other guild, including DevBot's existing guild and guilds first configured by `/setup` or `/config`, has it on. A server manager may change it later.

**Launch configuration.** Guest applications (`/apply`) are closed at launch, and `/apply` refuses with a visitor-facing explanation before its form opens. The importer records but does not apply the legacy review channel (`1196246221682131017`), and first activation never opens applications implicitly. Lobby onboarding stays off: `/setup` is not run in the production guild at launch, because it would also enable onboarding, open `/apply`, and adopt Officer-role holders. (Revised on 2026-09-24: applications now have their own switch, and the importer keeps the legacy review channel with that switch off instead of leaving the channel unset. Applications remain closed at launch; see "Approved reply-session amendments".)

**Officer authority at launch.** Officer authority comes from the in-game rank: `/config officer_rank rank:Officer` maps it, and the legacy Officer role is bound with `/config roles officer role:… adopt_holders:false`, so its current holders receive no manual officer grants. Exceptions use explicit `/officer grant`. Without the option, binding an Officer role keeps its existing behavior of adopting current human holders as audited manual grants; the choice is audited either way, and manager authority is unchanged.

**Deferred guest-application form.** The guest application form and its officer review are deferred until after launch. This covers GUEST-01–GUEST-07, the application-specific parts of GUEST-08 and GUEST-09, AC-12, AC-13, and "approval" in the pre-activation smoke test. The implemented behavior and its automated tests remain; launch does not depend on their live acceptance. Officer `/guest grant`, `/guest revoke`, and `/guest status` remain in launch scope, and so do `/guest reset` and `/officer reset` with everything else the 2026-09-24 amendments add (owner decision, 2026-09-24: "everything we've discussed is in launch scope").

**Pre-launch releases.** The 2.12.3 queue-logging patch, the 2.14.0 reply-presentation release (owner-approved embeds replacing every JSON reply), and the 2.15.0 operational telemetry and officer-alert release (OPS-10, OPS-11) come before go-live. The cutover uses a published release at or above 2.15.0. (Revised on 2026-09-24: 2.15.0 ships the reply-session decisions below, OPS-10 and OPS-11 move to 2.16.0, and the cutover uses a published release at or above 2.16.0.) (Revised again on the evening of 2026-09-24, to launch that day: 2.16.0 ships the deployment safeguards instead, and OPS-10/OPS-11 move to 2.17.0, after launch. The cutover floor stays 2.16.0.)

**Production tooling.** Production maintenance tools run from a build of the deployed release, with an explicitly supplied production environment file and never the development `.env`. They verify deployment identity before any I/O (OPS-14) and leave no guild-scoped commands for the production application (UX-04). (Since 2026-09-26 an automated deploy runs `migrate.js`, `register.js --global` and `commands.js list` inside the deployed container on the production host; see "Approved SSH-deploy amendments".)

### Approved reply-session amendments (2026-09-24)

The owner made these decisions during the 2.14.0 reply session on DevBot, which compared every reply with the approved mockups. Release 2.15.0 implements them. They supersede conflicting text elsewhere in this document, including the 2026-09-23 amendments above. The referenced numbered requirements carry the normative detail.

**Guest-application switch.** Whether guest applications are open is a per-guild switch, separate from the review channel (CFG-08). The owner's reason: "The channel setting should be separate from whether applications are enabled." `/apply` is open only when the switch is on and both a review channel and a Guest role are set (GUEST-02). `/config guest_applications` takes `enabled:true|false`, `channel:#…`, and `unset_channel:true` in any combination, except a channel together with `unset_channel:true`. Switching applications off refuses only new `/apply` submissions; applications already waiting stay reviewable. `/setup` switches applications on, first validating a kept review channel it is about to open, as switching on with `/config` does.

The importer keeps the legacy review channel (`1196246221682131017`) and stores the switch off (MIG-03). The 2026-09-23 rule that the legacy review channel must not open `/apply` is therefore enforced by the switch, no longer by leaving the channel unset. Reopening after launch is `/config guest_applications enabled:true`. Activation still never opens applications implicitly. `activate.js --guest-applications open|closed` sets the switch and keeps the channel; without the flag, the switch keeps its imported value (off). Guest applications stay closed at launch, lobby onboarding stays off, and the 2026-09-23 deferral of the application form is unchanged.

**No implied change.** A reply never implies a change that did not happen (UX-02). The owner's words: "Don't imply a change where no change occurred." `/main` naming the current main character, and `/nickname` turning sync on or off when it already is, save nothing, queue no reconciliation, and reply that nothing changed. Resuming nickname sync that a manual nickname suspended is still a change. `/config officer_rank` naming the saved rank, or `unset_rank:true` when no rank is set, likewise replies that nothing changed and advances no configuration revision, audits nothing, and queues no repair pass.

**An example for every option.** Every input failure that names an option shows an example of a valid value for it, and every option of every registered command has one (UX-05). The owner's words: "If there's a parameter to input, it should provide an example."

**Ledger entry number or ID.** `/ledger adjust entry:` accepts the entry number that history, receipts, and posts show (`5` or `#5`, resolved in the current FC account) or the entry ID (LEDGER-07). The owner's words: "Allow it to accept the integer, or the UUID. It's obvious which one is provided."

**Member suggestions.** Every member option autocompletes server members. A pasted user ID or mention is still accepted, so a user who has left stays nameable by ID (UX-06).

**Main character after a re-link.** A new trusted link becomes the member's main character when they have no main and no other active link, for example after removing every link. Unlike a first link, it keeps their nickname-sync setting. Imported users keep their imported state (NICK-01, NICK-06).

**Server owner's nickname.** Discord lets no bot change the server owner's nickname. Reconciliation skips the owner's nickname instead of leaving blocked work that no officer can fix (NICK-05).

**"Unset", not "clear".** No `/config` option is named `clear`. The owner's reason: "Clear sounds like you're erasing the channel's history." Channel settings use `unset_channel:true` (`/config ledger`, `officer_notifications`, and `guest_applications`), role settings use `unset_role:true` (`/config roles …`), and the officer rank uses `unset_rank:true` (`/config officer_rank`). Unsetting stops TaruBot using the channel, role, or rank; the Discord channel or role and its history stay.

**Reset commands.** `/officer` and `/guest` gain a third option beside grant and revoke, one that "removes any override and goes back to membership/rank logic":
- `/officer reset member reason` removes the member's officer grant or revocation, so the configured in-game rank decides again (ROLE-07). Like a grant or revocation, it needs a server manager, whose highest role must be above a bound Officer role (AUTH-03). Like a revocation, it works for someone who has left.
- `/guest reset member reason` lifts a Guest revocation and ends every active grant of any provenance (approved, manual, imported, grandfathered), so FC membership (current or former) and registered characters decide Guest again (ROLE-02, GUEST-08). Ended grants are kept as history and never confer Guest.

Both are audited and reconcile the member. With nothing to remove, they change nothing and audit nothing. They bring the command surface to 19 roots and 43 paths (AC-23).

**Release order.** 2.15.0 ships these decisions with migration `006_guest_application_switch.sql`. The operational telemetry and officer-alert release (OPS-10, OPS-11) moves from 2.15.0 to 2.16.0, and the cutover uses a published release at or above 2.16.0. **Launch-day revision (owner decision, 2026-09-24):** to go live that day, 2.16.0 ships the deployment safeguards of the approved deploy-workflow proposal (a migration guard that takes the writer lease for pending migrations, a schema re-check once a bot holds the lease, and the stale-command card for undeclared subcommands and options), OPS-10/OPS-11 follow in 2.17.0 after launch, and the cutover floor stays 2.16.0. Option names, descriptions, and autocomplete changed, so commands are registered again after 2.15.0 is deployed (UX-04).

### Approved hosting amendment (2026-09-24)

The cutover went live on App Platform, and then every profile refresh failed there. The Lodestone answers DigitalOcean's addresses with HTTP 403, so Nodestone on App Platform could not refresh profiles, verify claims or read rosters. The owner chose to move production that evening rather than proxy its traffic. This amendment supersedes the "Production hosting" launch amendment and DEPLOY-DO-01 as the production target.

**Production host.** Production runs on a Linode Docker host with `docker-compose.production.yml`: the published GHCR bot image (and until 2.21.0 the Nodestone sidecar image), pinned to one release, with no bundled database. It is attached to the owner-provisioned Linode managed PostgreSQL cluster `tarubot-pgsql` (PostgreSQL 18, database and user `tarubot`) over verified TLS on its direct port. Connection pools are never used. The single-writer lease (MIG-13), the production tool profile, and the rule that every provider, token and registration change is a separately authorized owner step all stand unchanged. Updates are a `git pull`, a pinned image tag, and Compose. A release with a migration stops the bot first and takes an independent backup ([docs/HOSTING.md](docs/HOSTING.md)). (Since 2026-09-26 an automated deploy takes the host's encrypted `ops/backup.sh` dump instead, with the restore point and point-in-time recovery; see "Approved SSH-deploy amendments".)

**Follow-up (owner decision, 2026-09-25).** The owner asked whether App Platform for the bot and database, with Nodestone elsewhere behind an API key, would be more robust. Nodestone's outgoing address is a single point either way, and the split would add a public, authenticated endpoint and a second provider, so the owner kept production on the Linode host and asked that it be made robust and disposable:
- rebuildable from Git and an encrypted copy of `.env` kept off the host, with a rebuild runbook (2.23.0: `scripts/host-env-backup.ts` with `age`, and docs/HOSTING.md "Rebuilding the host");
- alerting from outside the host: the issue reporter, plus a heartbeat that notices a silent host (2.22.0: the bot pings a healthchecks.io check every five minutes while ready, and the owner's check alerts through Pushover when the pings stop);
- a deploy workflow over SSH from GitHub Actions (2.30.0: the Deploy production workflow and `ops/deploy.sh`; see "Approved SSH-deploy amendments (2026-09-26)");
- confirmed managed-database backup retention and point-in-time recovery, with scheduled off-site encrypted dumps (2.24.0: point-in-time recovery confirmed back to the cluster's creation; `ops/backup.sh` dumps daily into Linode Object Storage, encrypted with `age`, with its own healthchecks.io check. The owner chose Linode's storage over Backblaze B2, accepting that backups share the Linode account).

The owner considered Terraform with the Linode provider for the infrastructure and declined it for now (2026-09-25): "Sounds like too much trouble at least at this stage." (Revisited on 2026-09-26 for issue #50: OpenTofu takes the provider side, and the owner runs its `apply`; see "Approved staging amendments (2026-09-26)".)

**App Platform.** *(Superseded by the 2026-09-25 retirement below.)* The App Platform spec, its phases and their CI validation stay in the repository as the record and as a fallback, in case DigitalOcean's addresses are admitted again. DEPLOY-DO-01 remains satisfied, but it no longer describes production. The approved GitHub deploy-workflow proposal targeted App Platform. It is on hold until it is re-planned for the Compose host. (Re-planned as issue #41 and released as 2.30.0; see "Approved SSH-deploy amendments (2026-09-26)".)

### Approved Lodestone amendments (2026-09-24)

After the move to Linode, `/sync status` filled with failed profile refreshes, and several failures were for the same character. The investigation found that the scheduler retried failing profiles about every 30 seconds, which deepened the Lodestone's rate limiting; that a deleted character's 404 was retried like an outage; and that a private profile was reported as the Lodestone being down. The owner asked that a character the Lodestone no longer has be unclaimed automatically ("if a character ID isn't found, we should force unclaim/delete it") and decided to "require two 404s before unlinking, just in case". Release 2.17.0 implements these decisions. They refine SYNC-03, NODE-08 and NODE-10.

**Deleted characters (the two-404 rule).** When the Lodestone answers "not found" for a linked character's profile refresh, TaruBot records that first 404 and changes nothing else. A second 404 at least one hour later ends every active link to the character, in every guild:
- each unlink is audited as automatic, with no human actor;
- the owner is reconciled: a main character is cleared for a nickname restore, and access is recomputed from the remaining links and grants;
- officers get a notice naming the character and the owner.

Any sighting in between voids the first 404: a profile read, a private profile, or a roster listing. History is kept: the character row and the ended link remain.

**Private profiles.** The Lodestone answers a private character profile with its own "Access Restricted" page (HTTP 403). That is an answer about the character, not an outage. Links stay, and the refresh waits for the normal profile interval instead of retrying. An interactive command that reads the profile says it is private and asks for it to be made public. An edge or firewall block, such as DigitalOcean's, is still an outage.

**Throttling.** After a Lodestone 429, the sidecar refuses every start for one shared cooldown instead of letting each queued request reach the Lodestone. The cooldown is 15 seconds, doubles on each consecutive 429 up to 5 minutes, and gives way to a longer Retry-After of up to 15 minutes. A rate-limited job waits out the cooldown without spending an attempt. A throttled roster crawl is recorded for `/sync status` but sends officers no "degraded" notice. The sidecar's own full capacity is reported as `busy`, not as Lodestone throttling.

**Refresh pacing.** Scheduled profile refreshes of one character are at least an hour apart, whatever the outcome. Periodic scheduling never pulls a job that is backing off forward, and a startup catch-up is spread over a minute.

**Release order.** 2.17.0 ships these decisions with migration `007_profile_checks.sql`. The GitHub issue reporter and `/issue` follow in 2.18.0, then OPS-10/OPS-11.

**Selectors always current (owner decision, 2026-09-25).** "xivapi/lodestone-css-selectors should ALWAYS be the latest version available." The sidecar follows the selector repository's HEAD at runtime:
- it downloads each new revision's files at that commit, validates them structurally, and activates them for the next parser worker, with no release, rebuild or restart;
- a revision that fails keeps the active set and is logged;
- the build's bundled copy is the fallback;
- parser code stays release-managed.

Release 2.19.0 implements this.

**No Nodestone (owner decision, 2026-09-25).** "Get rid of Nodestone entirely, pull xivapi/lodestone-css-selectors for ourselves, and do the parsing internally." In 2.20.0 the sidecar parses pages with TaruBot's own parser, which applies the selector definitions directly. It keeps the sidecar's HTTP contract, isolation, gate and bounds. The Nodestone submodule, its source patches and its dependencies are removed. Before the switch, both parsers produced identical output on live pages. Where NODE requirements name Nodestone, they now apply to this parser.

**No sidecar (owner decision, 2026-09-25).** Asked what the sidecar still bought once the parser was TaruBot's own, the owner decided: "Remove the sidecar. I would rather reduce complexity and places where things can break." In 2.21.0 the bot runs the Lodestone adapter in process. The bot fetches each page under the same network policy (region, start spacing, the 429 gate, deadlines, body bounds, private-profile detection) and parses it in a fresh isolated worker that it terminates at the deadline, which satisfies NODE-09's worker isolation. Parse slots wait for capacity instead of refusing. The live selector set (2.19.0) is held in memory. Where NODE and OPS requirements name the sidecar, its HTTP envelope or `PAGE_REGION`, they now apply to this in-process adapter, its parse results and `LODESTONE_REGION`.

**App Platform retired (owner decision, 2026-09-25).** Without a separate parser service, App Platform cannot serve even as a fallback: the bot itself would fetch the Lodestone from DigitalOcean's refused addresses. The owner chose to retire it. 2.21.0 removes the spec, its phase tool, their tests and CI's doctl validation; DEPLOY-DO-01 no longer applies, and docs/APP_PLATFORM.md stays as the record.

### Approved issue-reporting amendments (2026-09-24)

The owner asked for "an 'unexpected behavior handler' that will auto-open a GitHub issue when something goes wonky, and include as much context as possible", and for "an /issue command … that accepts a user comment, same data state collection". Their answers set the policy below. Release 2.18.0 implements it with migration `008_issue_reports.sql`.

**Where reports go.** Reports open issues in the private repository `deconfined/tarubot-reports` (`GITHUB_REPORTS_REPO`). They use a fine-grained token limited to that repository's issues (`GITHUB_REPORTS_TOKEN`), which the running bot holds. Maintenance tools never do. Each issue is labelled `tarubot-report`, `source:…` and `env:production|devbot`, and its title starts with the environment.

**/issue.** Every member can report a problem in their own words. There is one report per member per 10 minutes, and at most 20 per server in any 24 hours; each refusal says when to try again. The reply says what the report carries. The member's text goes into the issue as a fenced block, so it can't @mention anyone on GitHub.

**Automatic reports.** Three kinds of trouble open issues:
- unexpected errors: every error-level report from interactions, events, the lifecycle and the queue worker;
- jobs that end failed at error level;
- repeated trouble: a linked FC's roster not accepted for 12 hours, or no Lodestone answer for an hour.

Each is grouped by a fingerprint of what failed and where, so the same trouble is one issue:
- repeats are counted, and a comment posts the count at most hourly;
- a repeat after the issue was closed opens a new issue that refers back to it;
- each day allows at most 10 new automatic issues and 50 comments.

The issue reporter never reports its own delivery failures.

**Context.** Each report carries, as far as each read succeeds:
- the deployment and version;
- readiness;
- the Lodestone's reachability and the sidecar's health;
- the queue's active work and recent failures;
- the server's TaruBot settings and FC roster state;
- for `/issue` and member-scoped work, the member's links, main, nickname state, guest and officer standing, recent work and audit;
- the newest log records.

Known secret shapes and the deployment's own secret values are removed from everything before it is stored.

**Durability.** A report is saved in PostgreSQL first and delivered by a job, so a GitHub outage loses nothing. Without a token, reports are saved and `/issue` says so. They are sent once a token is configured.

**Command surface.** `/issue` brings the command surface to 20 roots and 44 paths (AC-23). It must be registered after the deployment.

### Approved officer-notice amendments (2026-09-25)

Issue #29 found that production officers got a line for every accepted roster ("FC roster accepted: …", with a departures count), and that during a Lodestone outage the "degraded" line could repeat about once a minute. The owner decided in two rounds on the issue: the [first](https://github.com/deconfined/tarubot/issues/29#issuecomment-5834639862) set the direction, and the [second](https://github.com/deconfined/tarubot/issues/29#issuecomment-5836920321) accepted every recommendation of the [revised plan](https://github.com/deconfined/tarubot/issues/29#issuecomment-5836582300) ("Accept all recommendations and we'll tweak as needed"). Release 2.24.3 implements them, with no migration. They refine OPS-11 for the roster notices; the rest of OPS-11 (material membership changes, which is issue #31, and delivery-failure summaries) stays open.

**Roster line.** Routine roster acceptance is a DevBot diagnostic. "FC roster accepted: …" posts only in the test guild (`TEST_GUILD_ID`), and production officers get no line per accepted roster. Production drops the departures count with it; issue #31 reports material membership changes.

**Degraded notice.** The text is unchanged: "Lodestone synchronization is degraded. Existing accepted membership evidence is retained; inspect /sync status." It is rate-limited per guild and FC:
- it is queued on the first roster failure since the FC's last accepted roster that isn't a wait, and posts only if it is still pending 5 minutes later;
- while the FC keeps failing, it repeats at most once every 24 hours, counted from the last post;
- a degraded notice still waiting to post (held, paused or blocked) blocks new ones, however old;
- Lodestone throttling and the queue's other waits never post one.

**Recovery line.** The first accepted roster after a posted degraded notice posts one line: "Lodestone synchronization recovered: the FC roster was accepted again." A degraded notice still waiting to post is closed unposted instead, and no recovery line follows an outage officers weren't told about. Each outage that outlasts the hold gets its own degraded notice and recovery line.

**FC unlink.** Unlinking the FC closes the guild's waiting degraded notice, so nothing posts later about an FC the guild no longer uses.

**Implementation notes (2.24.3; not owner decisions).**
- A degraded notice that finished without posting (no officer notifications channel, a failed delivery, or one closed unposted) also starts the 24 hours, so a guild without a channel doesn't queue a row on every failure. One that hasn't finished counts from when it was queued.
- An accepted roster also closes waiting degraded notices in guilds the bot was removed from, which get no recovery line: the queue never claims an inactive guild's rows, so such a notice would otherwise post about an ended outage once the bot is added back.
- Accepted edge case: a degraded notice already being sent when the roster is accepted, or when the FC is unlinked, is left to finish; one being sent at recovery counts as posted. If that send fails and is retried, the degraded line can post after the recovery line or after the unlink. The window is one send in flight during that transaction, and closing it would need the delivery to know each notice's FC.

### Approved changelog amendments (2026-09-25)

The owner asked, in [issue #30](https://github.com/deconfined/tarubot/issues/30), that TaruBot post an update when it starts on a new version. They approved the plan and answered its questions in the [decision comment](https://github.com/deconfined/tarubot/issues/30#issuecomment-5835854639). Release 2.25.0 implements it with migration `009_changelog_channel.sql` (CFG-09).

**What members see.** Officers choose a channel. When the bot starts on a newer version, it posts one message there: "TaruBot updated to vX.Y.Z", with a one-sentence note for each release since the last post, newest first. A deploy, restart or rollback never posts the same releases again.

**Member notes (decision 1).** Notes are a short list in the code, and a note is optional for each release. The owner: "It should be what's meaningful for users, not the technical side. If people want the commit list, /version will lead them there." A release without a note is never shown. When a release changes something members notice, its change set adds a note (CLAUDE.md "Every change set", step 2).

**Nothing for members (decision 2).** An update whose releases have no notes posts nothing.

**Setting a channel (decision 3).** Setting a channel posts nothing at once; the first post comes with the next update that has a note. Updates released while no channel is set are never posted later.

**Visibility (decision 4).** In servers where TaruBot's onboarding manages channel visibility, the bot only warns when the chosen channel is hidden from members and guests, or is one onboarding doesn't manage. It never makes the channel visible. Elsewhere, server admins own the channel's permissions.

**Release order** (agreed 2026-09-25, revised the same day): #29 is 2.24.3 and #30 is 2.25.0 with migration 009, both merged and deployed on 2026-09-25. #33, the documentation site, merged before #32 as 2.27.0 (PR #37, `a199fab`; documentation only, live at https://deconfined.github.io/tarubot/), so 2.26.0 is skipped: #32 is 2.28.0 and #31 is 2.29.0 with migration 010. The SSH deploy workflow takes the next free minor version after #31. (It is 2.30.0, issue #41; see "Approved SSH-deploy amendments (2026-09-26)".)

**Command surface.** `/config changelog` brings the command surface to 20 roots and 45 paths (AC-23). It must be registered after the deployment.

### Approved documentation-site amendments (2026-09-25)

Issue #33 asked for a documentation site covering architecture and design, deployment, administration and everyday use. The owner decided its shape in three comments on the issue: GitHub Pages first ([comment](https://github.com/deconfined/tarubot/issues/33#issuecomment-5836313261): "Actually, GitHub pages might be even easier. Let's look at that, first."), pnpm for the site ([comment](https://github.com/deconfined/tarubot/issues/33#issuecomment-5837160498): "Personal preference: use `pnpm`."), and answers to the plan's six questions ([comment](https://github.com/deconfined/tarubot/issues/33#issuecomment-5837662307)). Release 2.27.0 implements them. The bot's behavior, commands and schema don't change.

**Site and hosting.** The site is Astro Starlight in `site/`, published to GitHub Pages at `https://deconfined.github.io/tarubot/`. There is no custom domain for now; one would be a later, separately authorized owner step.

**Toolchain.** `site/` is a standalone pnpm package on Node, both pinned in `site/package.json`. pnpm applies to `site/` only: the bot, its tooling, tests and image stay on Bun, which the Bun-throughout decision above otherwise still requires.

**Build and deploy.** The site build runs on pull requests that touch the site as an advisory check, not part of the required `CI result`. It deploys only from `main`, through the `github-pages` environment. The required gate for page content is a unit test in the existing checks.

**Content.** The site is the only home of reader-facing documentation. The setup, operations and roadmap guides and the README's usage sections moved into it. Contributor detail and maintainer records stay in `docs/`, unpublished. Pages use placeholders only, never production or development IDs, member or character data, private hosts or secrets. The command reference is hand-written, and a unit test checks it against the registered commands, options and examples. The `starlight-links-validator` plugin fails the build on a broken internal link or anchor.

### Approved public-suggestion amendments (2026-09-25)

Issue [#32](https://github.com/deconfined/tarubot/issues/32) asked for a command that lets people in the Discord server suggest TaruBot features as public issues in this repository. The owner answered the plan's questions in [the decision comment](https://github.com/deconfined/tarubot/issues/32#issuecomment-5836092045) and clarified who may post in chat the same day, recorded on the issue in [a follow-up comment](https://github.com/deconfined/tarubot/issues/32#issuecomment-5836108245). Release 2.28.0 implements these decisions; it has no migration.

**Command.** `/suggest idea:…` (10–1,000 characters) opens an issue in the public repository `deconfined/tarubot` at once, labelled `enhancement` and `from-discord`, and replies privately with its link. The owner moderates afterwards ("I can close issues as won't implement or deal with abuse on my own"); nothing waits for approval.

**Who may post.** Anyone with server access in the Free Company's own server: "someone that's verified a character and received member/guest, or whom an officer has granted guest access." In practice the person must hold the server's bound Member role or its bound Guest role when they run the command (roles are read fresh from Discord). Officers qualify through their Member role; officer access alone, or a server manager holding neither role, does not qualify, and an unbound role qualifies nobody. The command works only in the servers this deployment serves: production's guild list (`deployments.production.guilds`) and DevBot's test guild. Any other server that adds the bot is refused, even for its managers. The refusal for someone without either role reads "Only members and guests of this server can suggest features."

**What goes public.** Only the member's cleaned text and TaruBot's version, in a fixed format: the start of the text, cut at a word within 80 characters, as the title; a fixed first line saying where the text came from; the text in a `text` code block; and "Sent by TaruBot X.Y.Z." Before posting, TaruBot removes invisible and control characters and folds look-alike forms, then removes links (with or without a scheme, including a domain followed only by a port, query or fragment) and IPv4 addresses, Discord mentions, email addresses, credential shapes and runs of 17 or more digits, and replaces every `@` with `＠` (no GitHub mentions) and `#` in titles with `＃` (no cross-references). A final check refuses anything that still carries an `@`, a long ID, a link or an invisible character. The member's name and Discord ID, server, channel and role IDs, FC and character data, logs and the environment never go public. Who sent which suggestion is recorded privately in the audit table (`suggestion.posted`, target `#N`).

**Limits.** One suggestion per member per hour, three per member in any 24 hours, and ten in any 24 hours for the whole deployment. An attempt GitHub doesn't confirm (`suggestion.unconfirmed`) counts toward every limit, because the issue may exist; its reply asks the member to check GitHub before trying again. An outage while TaruBot signs in as the app is treated the same way, although nothing could have been posted yet, so one path and one reply cover both. GitHub's own rate limit, on the sign-in or on the post, and a refused request count nothing.

**Identity.** Suggestions are posted by the dedicated GitHub App "TaruBot" (App ID 5076273), which has Issues write and Metadata read only, no webhook, and is installed on `deconfined/tarubot` alone. Its issues show the app's bot account as author, never the owner's account. The bot signs a short JWT with the app's private key and mints a one-hour installation token, narrowed to this repository's issues, for each post. The client ID and key (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_PRIVATE_KEY`) are production settings in the host's `.env` only; emptying either switches `/suggest` off, and members are told it is switched off.

**DevBot.** DevBot previews suggestions into the private reports repository (`GITHUB_REPORTS_REPO`) with the reports token, creating the two labels there, so testing never posts publicly. It ignores the app settings.

**Claude workflow.** `.github/workflows/claude.yml` never starts the agent for an issue whose body carries the suggestion marker ("Suggested in Discord with TaruBot"), whatever its author or text.

**Durability.** Unlike `/issue` (see the issue-reporting "Durability" paragraph), a suggestion is **not** saved first and delivered by a job. It is posted in the interaction the router already deferred, so there is no table, job or migration; a GitHub outage refuses the suggestion, and an idea is easy to retype. A shutdown lets a post that is already at GitHub finish and record its audit row before the writer lease is handed over (within the shutdown deadline), and refuses submissions that haven't started ("TaruBot is restarting right now.").

**Accepted risks.** A public post is permanent once GitHub's events, archives and notification emails copy it. Anyone who verifies a character gets Guest, so a few alternate accounts could use up the deployment's daily limit; the owner accepts this and moderates after posting. Names typed freely, IDs deliberately split with visible separators, and IPv6 addresses deliberately disguised (with look-alike colons, or a letter run onto them) can't be recognised. Non-global IPv6 addresses (link-local, unique-local, loopback) are left, since they don't identify a connection publicly, and so is the start of a global one written without `::` (`2001:db8:1234`), which reads like a date or a score. Three forms are left deliberately, because catching them would garble ordinary text ([accepted 2026-09-25](https://github.com/deconfined/tarubot/issues/32#issuecomment-5839799636): "You're never going to catch **everything**."): Chinese and Japanese hosts written with `。`, which reads like a sentence break; look-alike dots such as `·` or `ꓸ`, which browsers send to a different host and which are real punctuation in some languages; and IPv4 written as one to three decimal numbers (`127.1`, `2130706433`), which reads like a rating, time or version. The IPv6 rule (first hex digit 2 or 3, a four-digit first group, at least two colons) is the owner's ([issue comment](https://github.com/deconfined/tarubot/issues/32#issuecomment-5839754397)).

**Command surface.** `/suggest` brings the command surface to 21 roots and 46 paths (AC-23), after 2.25.0's `/config changelog`. It must be registered after the deployment. Release order (revised 2026-09-25; see the changelog amendments): #29 as 2.24.3, #30 as 2.25.0, #33 as 2.27.0, #32 as 2.28.0 (2.26.0 skipped), then #31 as 2.29.0.

### Approved status-notice amendments (2026-09-25)

Issue #31 asked that officers see material membership changes in the officer notifications channel (OPS-11). The owner approved the [plan](https://github.com/deconfined/tarubot/issues/31#issuecomment-5836583557) and accepted all seven of its recommendations in the [decision comment](https://github.com/deconfined/tarubot/issues/31#issuecomment-5836910305): "Accept all recommendations. We'll tweak if needed." Release 2.29.0 implements them with migration `010_status_notices.sql`, and no command change (it was built as 2.27.0 and renumbered when the documentation site and `/suggest` merged first). Together with "Approved officer-notice amendments" (#29), this covers OPS-11's material membership changes and recovery notices; its summaries of repeated delivery failures stay open.

**Scope (decision 1).** A post lists members who gained or lost Member, Guest, Officer or FC Leader, with the reason the bot decided it, and the confirmed FC departures of linked characters, including departures that change nobody's access (the owner's answer on #29: "Let #31 handle" departures). Nothing else.

**Officer-made changes (decision 2).** Grants, revocations, overrides and approvals are announced like automatic changes, without "by @officer". The audit keeps who made them.

**Timing (decision 3).** One post about 2 minutes after the first change, covering every change in that window. A change undone within it cancels out.

**Size (decision 4).** Each post names every member it covers: at most 100, fewer when their lines wouldn't fit one message. Further posts follow straight away.

**Switch (decision 5).** Always on while the officer notifications channel is set, with no separate setting. Changes made while it is unset aren't saved for later. While Discord changes are paused, posts wait until they resume.

**Names (decision 6).** Mentions only; character names appear only on departure lines.

**Silent changes (decision 7).** These stay unannounced:
- role changes that follow a role binding change with `/config roles` or `/setup` (setting up, replacing or removing a role). The exception: when a new Officer role replaces one already set, officers adopted through `adopt_holders` show as Officer added;
- hand edits of roles that the bot keeps while evidence is unconfirmed (an out-of-date roster, an unchecked new link, an unknown rank). Changes decided in those times post once a fresh roster confirms them, if they still differ from what was last announced.

The plan also leaves out roles given on joining or rejoining the server, people who left it, the first check after the deploy or activation (which only records everyone's status), nicknames, FC rank changes that change neither Officer nor FC Leader, characters nobody linked, and FC joins that change no access.

**Implementation notes (2.29.0; not owner decisions).**
- Linking an FC to a server whose roles are already set up lists its confirmed members as Guest → Member after the first roster check, or about 2 minutes after the relink when the same FC is relinked while its last roster is still fresh (`/config fc unlink` keeps the membership rows); unlinking lists the reverse.
- A failed or interrupted post is resent with identical content under the same Discord nonce, and each send is recorded as a delivery attempt. A post Discord accepted is recorded as delivered before it is marked, so a retry after a failed mark only marks it and never posts it twice. After a terminal failure, `retry.js` or the next change in that server posts what waits.
- Decision 5 is applied when a change is recorded: while the channel is unset, a change counts as announced at once and a departure isn't recorded, so setting the channel afterwards posts none of it. Unsetting the channel also drops whatever still waits, so nothing from before the unset posts later either. A post in progress stops before its next message if the channel is unset or moved, or Discord changes are paused.
- The departures count stays in DevBot's "FC roster accepted" line only (#29).

### Approved SSH-deploy amendments (2026-09-26)

Issue #41 asked for production deploys from GitHub Actions over SSH, the last part of the robust-host follow-up of 2026-09-25 (see "Approved hosting amendment"). The owner approved the [plan](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843136740) and answered its ten questions in the [decision comment](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843517579): "Yes" to questions 1 to 8, "Warning" to question 9, and to question 10 "Yes. Itemize what fine-tune permissions are required on the new token." Release 2.30.0 implements them with `.github/workflows/deploy.yml` and `ops/deploy.sh`, with no bot change and no migration. They supersede conflicting text elsewhere in this document, for automated deploys only; the manual procedure in [docs/HOSTING.md](docs/HOSTING.md) is unchanged.

**The owner's GitHub approval is the go-ahead (decisions 1, 2, 4 and 6).** The owner's own approval of a `production` deployment in the GitHub web or mobile interface authorizes what that run's plan lists:
- moving the Linode host to the named release, whose image digest the plan names, or, with `rollback`, back to it from the named live release, never across a migration;
- when the host finds migration files the live release lacks, stopping the bot, an encrypted `ops/backup.sh` dump, `migrate.js` in the new image and the start; otherwise a restart. One approval covers the host's choice between the two;
- restoring the previous release automatically when the new one provably never took the writer lease, or the migration did not commit;
- `register.js --global` with a read-back (`commands.js list`) on every run that starts or verifies a release, rather than only when commands changed.

The host acts only after confirming with GitHub's API that this exact run, titled with this target, is in progress with its Deploy job running and was approved by the owner (by login and account id) for `production`; it checks the run again just before its first change. In such a run:
- `migrate.js`'s own writer-lease wait stands in for the operator's lease check (MIG-13);
- the host's fresh encrypted dump, with point-in-time recovery and the restore point, stands in for the independent operator dump (decision 3; the manual procedure keeps it);
- the tools run inside the deployed container with the Compose-supplied production environment (OPS-14).

**Agent rule (decisions 1 and 10).** This is the canonical wording; AGENTS.md carries it verbatim, and CLAUDE.md, [docs/CI_CD.md](docs/CI_CD.md#agent-access-to-deployments) and [docs/HOSTING.md](docs/HOSTING.md#automated-deploys-2300) point here. It is the owner's decision in full: the first part is the answer to question 1, and the clauses PR #44 proposed after it were confirmed by @deconfined on 2026-09-26, after the merge ("Agreed on the agent rule.", [#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)):

> Confirmed (question 1): the owner's approval of the `production` environment in GitHub is the go-ahead for a production deploy; a chat go-ahead doesn't replace it, and Claude sessions never approve a deployment. As before, a deploy by hand still needs the owner's explicit go-ahead, and provider, token, key, firewall and account changes stay separate owner steps.
>
> Confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)): agents, Claude sessions included, never approve, reject or bypass a deployment; never create, read or hold the deploy key; never change the `production` or `notify` environments, their secrets or their variables, or `DEPLOY_ENABLED`; never enable, disable, cancel or re-run the Deploy production workflow; and dispatch it only when the owner asks in that session.

**Quiet releases (decision 5).** A merge that changes only documentation, tests, CI or the version asks for no approval; a quiet Pushover message says so. If an earlier release wasn't deployed, the owner runs the workflow with the newest version.

**Several requests (decision 7).** Several approval requests may wait at once. One approved after a newer release is live ends as `superseded` and changes nothing; the host runs one deploy at a time.

**Firewall (decision 8).** Port 22 stays open to all sources under the Cloud Firewall, plus ICMP: GitHub's runner addresses can't be listed. SSH accepts keys only, and the deploy key runs nothing but `ops/deploy.sh`.

**Maintenance window (decision 9).** A migration deploy during the cluster's Tuesday 19:00-23:00 UTC maintenance gets a warning, in the plan and from the host when it runs, never a refusal.

**Agent guard (decision 10).** Done on 2026-09-26, following the agent's [token comment](https://github.com/deconfined/tarubot/issues/41#issuecomment-5843540619) (its option A, which the owner chose):
- Claude Code deny rules in the dev VM's user settings refuse any shell command that mentions the pending-deployments endpoint or the GraphQL approve and reject mutations.
- The dev VM's `gh` uses a fine-grained, read-only token on `deconfined/tarubot` (the permissions in that comment). It can't push, merge, comment, approve, dispatch or change settings. The classic all-scopes token is revoked.
- Pushes go over SSH with the owner's account key on the dev VM, and pull-request and issue writes go through the `tarubot-agent` GitHub App (Issues and Pull requests write only).

That SSH key pushes as the owner, so it can push any branch other than `main`, including one whose workflow asks for write permissions on its own `GITHUB_TOKEN` (the repository default is read, and a same-repository workflow may raise it). Such a workflow can dispatch, cancel and re-run runs, including Deploy production on `main`; push release and `sha-` tags to the bot's GHCR image; read repository secrets such as `CLAUDE_CODE_OAUTH_TOKEN`; and merge a pull request whose required checks pass. It can't reach the `production` or `notify` environments, which accept only `main`. So the owner's approval and the written rule are what stop a deploy. The plan resolves the image digest from the tags, and the host checks only that digest and the image's labels, so an approval of a normal-looking plan could deploy an image pushed from a branch. The 2.30.0 design declined signed build-provenance attestation because only the owner could publish images; that no longer holds while an agent-held key can push branch workflows. **Open decisions for the owner** ([docs/CI_CD.md](docs/CI_CD.md#agent-access-to-deployments)): sign build provenance in `publish.yml` and have the plan verify it with `gh attestation verify` (signer workflow `publish.yml` on `refs/heads/main`); and whether the agent should push with its own credential that can't change `.github/workflows/`, so that the owner pushes workflow edits. (The first was adopted with issue #50: `publish.yml` signs build provenance from 2.32.0, and the deploy plan verifies it from 2.33.0; see "Approved staging amendments (2026-09-26)". The second is still open.)

### Approved staging amendments (2026-09-26)

Issue [#50](https://github.com/deconfined/tarubot/issues/50) asked for a staging host that matches production, configured with Ansible. The owner answered its first four questions in [a comment on the issue](https://github.com/deconfined/tarubot/issues/50#issuecomment-5847729593) and made the other decisions in chat the same day; the agent recorded each on the issue as it was made. The [consolidated plan revision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5850822956) summarized them with 27 questions, and the owner accepted every recommendation in chat ("the rest of #50 is ready for launch", [recorded on the issue](https://github.com/deconfined/tarubot/issues/50#issuecomment-5851110558)), with two refinements: question 8 (secrets) and question 20 (the break-glass key). These amendments supersede conflicting text elsewhere in this document for the staging host and for every host the playbook builds. Production keeps its Docker host, Compose file and deploy path until it is rebuilt.

**Releases.** Following the revision's order. The numbers after 2.32.0 are planned: a release that lands in between, such as #46's, takes the next free number and moves these up.
1. **2.32.0** (#50 part 1): the Ansible playbook (`ops/ansible/`), the Quadlet unit files (`ops/quadlet/`), the `staging` tool profile, and signed build provenance in `publish.yml`, built and tested against the staging host by hand.
2. **2.33.0:** the staging deploy target in Quadlet mode, Podman secrets, the provenance check in the deploy plan, and the pull unit. (Built in two releases: 2.33.0 the runtime half, 2.34.0 the pull unit; the later numbers move up. See "Implementation notes (2.33.0)" below.)
3. **cloud-init and OpenTofu,** proven by rebuilding staging from scratch.
4. **The DevBot move,** then a patch that retires local DevBot.
5. **2.34.0:** PR images on staging.
6. **2.35.0:** production rebuilt onto AlmaLinux, rootless Podman and Quadlet, by overlap.
7. **A later cleanup** removes the Compose paths from `ops/deploy.sh` and `ops/backup.sh`.

**A second host ([the owner's answers](https://github.com/deconfined/tarubot/issues/50#issuecomment-5847729593)).**
- Staging is a second Linode, not a second stack on the production host. On one Docker daemon the dev stack would share production's project name, and the docker group would give it root-equivalent control over production.
- Its database is a separate database and role on the managed cluster, both named `tarubot_staging`, and the role owns its database. PUBLIC's CONNECT is revoked on both `tarubot_staging` and production's `tarubot`, so neither role can reach the other's database or hold its writer lease. The tool guard gets a `staging` profile that accepts only that database and role, and production's profile refuses every `tarubot_staging` name.
- DevBot moves there after the Ansible work, as a planned stop, dump and restore. DevBot's token is reset at the move and the new one goes only into staging's `.env`, so two DevBots never run at once.

**Platform ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5847885107)).** The hosts run AlmaLinux 10 with SELinux enforcing, and the bot runs under rootless Podman, so nothing that drives containers is root-equivalent, the deploy key included. Fedora is ruled out, because each release is supported for only about 13 months. Staging is the trial: once it holds up, production is rebuilt from the same playbook, and hosts are disposable. The `tarubot` user's umask is 0022 on every host the playbook manages; `ops/deploy.sh` keeps its own 077. Container hardening shipped first, on the current hosts (2.30.3, #51).

**Quadlet ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5849686005); questions 7 and 9 to 13).** The bot runs as a rootless Quadlet unit under `tarubot`'s systemd on both Podman hosts. The hosts get no Docker packages, no Docker context and no Podman API socket. Compose stays for local development and for self-hosting on Docker.
- The unit files belong to the release (`ops/quadlet/`), and Ansible prepares only the host layer around them, so a rollback brings back that release's unit (question 7).
- A failed health check doesn't kill the bot; systemd's restart policy applies, as Docker's does today (question 9).
- `ops/deploy.sh`'s contract level rises in Quadlet mode only, so production's Compose rollbacks keep working until its rebuild (question 10).
- The backup runs as a systemd timer with a one-off container, because a Quadlet unit would log the plaintext dump (question 11).
- The Compose paths leave the scripts in their own cleanup release, after a settled week on the rebuilt production host (question 12).
- The separate IPv6 release is dropped: rootless networking gives the bot the host's IPv6 from its first start (question 13).

**Secrets (question 8, refined; [decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5851052487)).** Secrets reach the bot as Podman secrets mounted as files, read-only and readable only by the bot, never as environment variables, which every dependency in the process can read. They are the Discord token, the database URL and CA, the GitHub App key, the reports token and the health-check ping URLs. `.env` stays the only place they are kept, so the procedure over SSH, the encrypted settings copy and `scripts/host-env-backup.ts` don't change. A pre-start step copies each value from `.env` into its Podman secret at every start. `src/config/env.ts` accepts the `_FILE` convention, and the plain variables keep working for local development and Compose. This lands with the Quadlet runtime in 2.33.0; production gets it at its rebuild.

**Host configuration: Ansible and a pull unit ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5849936077); questions 14 to 18).** Owner's guidance: "I want this automated as much as is reasonable/responsible."
- One playbook configures both hosts, with `ansible.builtin` only and no Galaxy roles or collections, and runs in check mode first. The repository names no host: the real inventory and host settings live outside it, with examples in it.
- From 2.33.0 (2.34.0 after the split, below) a root-owned timer on each host keeps its own root-owned clone, fetched from `main` only, and applies the playbook to the host itself. It never reads or runs anything the `tarubot` user can write, and no root-capable credential exists off the host. It moves forward only, along `main`'s first-parent history.
- Staging takes the head of `main`, about 5 minutes after a merge. Production takes only the commit of the newest Deploy production run the owner approved that succeeded, about 10 minutes after that deploy, so approving a release also approves its host configuration (question 15). The current commit is re-applied daily, and one health check per host pages only on trouble (question 17).
- Hosts also require the owner's SSH signature on merged pull-request heads that touch `ops/ansible/`, so a stolen GitHub session can't reach root through a merge; squash merging is turned off (question 14).
- `ops/ansible/` stays a runtime path, so each host-configuration change gets its own approval prompt (question 16). Production's automatic updates skip `ansible-core` (question 18).
- Manual runs are for building the playbook, a new host's first setup and emergencies only.

**Bootstrap: cloud-init, with no secrets in user data ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5850199861), [amended](https://github.com/deconfined/tarubot/issues/50#issuecomment-5850417945); questions 19 and 21).**
- A new host is created with a short cloud-config committed in the repository. It installs `ansible-core` and `git` from AlmaLinux's own repositories, runs the playbook once from a named commit, and installs the pull unit.
- User data carries only non-secret settings: the role, the hostname, the commit to start from, and public keys. Any process on the instance can read user data through the metadata API, and the Linode API can't clear it after creation, so keeping a secret there would rely on the host policing itself. Each host generates its own SSH host keys at first boot.
- The deploy key's public line and the operator keys arrive as host settings in user data, never committed to the public repository (question 21).
- At first boot the owner reboots only after the host-key step, so the keys stay visible on the console (question 19). Restoring `.env` stays a manual owner step.

**The host-key step ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5850426312)).** After every build or rebuild, the owner:
1. reads the new host keys from the Lish console, where cloud-init prints them: an off-host channel reached through the owner's Linode account;
2. updates the deploy environment's `DEPLOY_KNOWN_HOSTS` in GitHub (agents never change environment variables);
3. runs `tofu apply` with those keys, which publishes the host's SSHFP records.

Nothing in this step trusts the host's own network.

**Provider side: OpenTofu ([decision](https://github.com/deconfined/tarubot/issues/50#issuecomment-5850218874); questions 22 to 27).** This reverses the 2026-09-25 decision against Terraform (see "Approved hosting amendment").
- OpenTofu owns each Linode with its cloud-config, a Cloud Firewall per host, the managed database's access list only, not the cluster, which keeps its admin password out of state (question 22), and the Cloudflare A, AAAA and SSHFP records.
- Its state holds no private keys: an encrypted local file plus an `age` copy. The owner runs `apply` on the operator machine with no agent session running, using write tokens pasted per session (question 23). Agents may run `plan` with read-only tokens, never `apply`, `import` or state edits (question 24).
- Staging swaps to a new instance in one `apply`. Production rebuilds by overlap: the new host's bot waits on the writer lease while the old one runs, then DNS switches, so downtime is seconds (question 25).
- A host's first start uses an image digest verified on the owner's workstation; for staging an agent may do the verifying (question 26).
- Defaults: a Cloud Firewall per host, disk encryption on, Ed25519 host keys only, and the network interface type pinned (question 27).

**Root access (question 20, refined).** No host has a root password; Linode's Reset Root Password with the Lish console is the break-glass. Production gets one break-glass SSH key: the owner's FIDO2 hardware key (`sk-ssh-ed25519`), never on the operator VM. Its public line goes into user data, root's `authorized_keys` marks it `verify-required`, and it is tried on staging first. Staging's Ansible key from the operator VM is removed once the pull unit is proven.

**Operations (questions 1 to 3 and 6).**
- firewalld stays off; the Cloud Firewall filters. The only listener is sshd, and rootless Podman publishes nothing. Revisit when v3 opens ports 80 and 443 (question 1).
- Both hosts apply security updates automatically. Staging reboots itself when an update needs it, which also tests the boot path with nobody logged in. Production never reboots itself, and its automatic updates skip the container stack, which moves only through a playbook run after a week on staging (question 2).
- Staging backs up to a separate bucket with its own key, because Linode keys can't be limited to a prefix and staging must not hold a key to production's bucket (question 3).
- PR previews that carry new migrations are refused; migrations are tried on staging when they merge, beside production's approval request (question 6).

**Staging deploys and PR images (the owner's answers 2 and 3; question 4).**
- Staging deploys through the same Deploy workflow, with a `staging` environment that needs no approval ("If it breaks, who cares?"). It deploys exactly the merges production is asked about, and PR images only when the owner dispatches one (question 4).
- PR image tags are published, so staging runs from CI/CD as production does ("Dev/staging/whatever we're calling it should run off of CI/CD the same as prod."). They go to a separate package and reach staging only. Production can't be pointed at them: its plan requires the version tag built on `main`, a signature from `main`'s `publish.yml`, and the approved digest. Signed provenance comes first: `publish.yml` signs from 2.32.0, and the plan verifies from 2.33.0.

**Agents and the hosts (question 5).** Agents never approve deploys for either target; never change any deploy environment, its secrets or variables, or either enable switch; never hold either deploy key; never enable, disable, cancel or re-run the Deploy workflow; and never push a workflow that does any of these. Claude runs the playbook in check mode against staging freely, and applies it to staging under a standing go-ahead that covers the build phase only. Starting the bot, stopping DevBot, reboots and the DevBot move each need the owner's go-ahead. Production playbook runs stay the owner's alone, and the production inventory and root key stay off the operator VM. On dispatching, the owner kept the SSH-deploy agent rule's clause ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and withdrew question 5's "never dispatch" on 2026-09-27 ([#50](https://github.com/deconfined/tarubot/issues/50#issuecomment-5852502546)): agents dispatch the Deploy workflow, for either target, only when the owner asks in that session. AGENTS.md quotes that rule unchanged.

**Implementation notes (2.33.0).** How 2.33.0 carries out the decisions above; none changes a decision. [docs/HOSTING.md](docs/HOSTING.md#staging-host-50) has the detail.
- **The release split.** Item 2 of "Releases" ships in two releases: 2.33.0 the runtime half (`ops/deploy.sh`'s Quadlet modes, the staging deploy target, the provenance check, Podman secrets, the Quadlet backup and the first start), and 2.34.0 the pull unit. The later items take the next free numbers.
- **The workflow's name.** `.github/workflows/deploy.yml` is displayed as "Deploy" (it was "Deploy production"). The quoted rule's "the Deploy production workflow" means that file, for both targets; the hosts check its path, not its name.
- **Staging dispatches (questions 4 and 5).** Staging has no approval, so the plan and the staging host accept a staging dispatch only when both the run's actor and its triggering actor are the owner's account, by login and account id. A GitHub App or a workflow token is refused, so an agent could dispatch staging only with a credential of the owner's own, and only when the owner asks in that session.
- **Production's result (question 15).** A run can fail on its staging job while production deployed, so "the newest Deploy run the owner approved that succeeded" means the run whose **Deploy** job succeeded after the production approval, never the run's conclusion. The pull unit reads it that way.
- **The provenance check.** The plan verifies with `gh attestation verify` (the signer by the certificate's exact identity, `publish.yml` on `refs/heads/main`, never by gh's prefix-matched `--signer-workflow`; the commit, SLSA provenance v1, GitHub-hosted runners only) before any early exit, anonymously apart from its own `attestations: read` token: the package is public, so there is no registry login. Releases before 2.32.0 have no attestation and are refused; a production rollback to one goes by hand ([docs/HOSTING.md](docs/HOSTING.md#rolling-back-to-a-release-without-provenance-before-2320)).
- **Secrets (question 8).** The six secrets are the Discord token, the database URL and CA, the GitHub App key, the reports token and the heartbeat's ping URL. The backup's check URL stays with the backup's settings, which `ops/backup.sh` reads from `.env` itself. Podman's file driver keeps its store in rootless storage on disk, as sensitive as `.env`, and gives each container its own copy, mounted read-only only because the container is read-only: every container that mounts a secret is. The pre-start step reads `.env` itself, and the unit's `UnsetEnvironment=` also drops the backup's settings, `POSTGRES_PASSWORD` and `RESTORE_*`, so no secret reaches Podman, conmon or pasta. Setting both `NAME` and `NAME_FILE` is refused.
- **The backup (question 11).** The dump container reads the database URL and CA as the same mounted secrets, synced alone before each run, so a blank Discord token never stops a backup, and it needs no writable path. The timer and its service belong to the release (`ops/systemd/`). The playbook enables the timer from the first start on.
- **The host lock.** Deploys, the playbook's user-manager commands and the pull unit share `/run/tarubot/host.lock`, a root-owned file from tmpfiles, since the pull unit runs as root and must never open a file `tarubot` could replace. A caller that holds it runs the playbook with `tarubot_host_lock_held=true`, which the play checks.
- **The first start (question 26).** The playbook's `start` tag takes a version and digest verified on the workstation, because the hosts hold no GitHub token and the playbook uses no lookups or delegation. On the host it re-checks the digest, the labels, the commit's place on `main`, its version and its `quadlet` contract words.
- **The Quadlet contract level (question 10).** `ops/deploy.sh` keeps `FLOOR` for Compose, and the Quadlet modes require `QUADLET_FLOOR` (2.33.0) and their words on the target's `CAPABILITIES` line, so no floor number is copied into the workflow or the playbook.

**Implementation notes (2.34.0).** How 2.34.0 carries out the pull-unit decisions (questions 14 to 18) and prepares question 20; none changes a decision. [docs/HOSTING.md](docs/HOSTING.md#the-pull-unit-2340) has the detail.
- **Numbering.** 2.34.0 is the pull unit, the second half of "Releases" item 2. The later items, cloud-init and OpenTofu, the DevBot move, PR images and the production rebuild, take the next free numbers when they land.
- **What runs.** `tarubot-host-config` is a root-owned script installed as `/usr/local/sbin/tarubot-host-config`, with a oneshot service and a timer. Its state and clone live in `/var/lib/tarubot-config` (root, 0700), and its settings are root's own files: `/etc/tarubot/host.yml` and `/etc/tarubot/host-config.env`. Its source is `ops/ansible/files/host-config/`, not a separate directory, so the playbook still reads nothing outside `ops/ansible/`, and question 14's signature rule covers the code that root runs. The clone fetches `main` only, over HTTPS, with hooks, fsmonitor, submodules, redirects and the system and global git settings off. Nothing is ever run from it except the playbook after the checks below.
- **Staging and production (questions 15 and 17).** Staging takes the head of `main` every 5 minutes, and production polls every 10 minutes. Production's rule follows the 2.33.0 note, "Production's result":
  - A run counts when it is `deploy.yml` on `main`, first attempt, titled for production (`Deploy <commit>` or `Deploy <version>`), its job **Deploy** succeeded, and @deconfined approved it for `production`, matched by login and account id as `ops/deploy.sh` matches it. Staging titles and rollbacks never count.
  - Only GitHub's anonymous public records are read, never anything `tarubot` wrote.
  - A Deploy success without that approval always pages as `needs-you approval-mismatch`, because `ops/deploy.sh`'s own check makes it an anomaly. Newer than every approved candidate, it stops the host at every poll until a newer approved release or an emergency apply passes it; behind a newer candidate, it pages at the first poll that sees it, and later polls go on to the candidate.
  - The listing reads runs created in the last 31 days, past GitHub's 30 days for a waiting approval, and the newest approved commit is kept until applied, so neither a late approval nor a long pause drops a release.
- **Signatures (question 14).**
  - The check runs when `ops/ansible/` differs between the applied commit and the target. Each first-parent merge in between that changes `ops/ansible/` must have two parents and the same tree as its pull request's head, and its head must contain the previous `main` and carry a good SSH signature (`G`, `fully`).
  - The allowed signers come from the host's own settings (`tarubot_allowed_signers` in `host.yml`), never from the repository. The pull unit reads them from `host.yml` itself at every run, so no file a playbook run rendered, from whatever copy of the settings, decides a signature; the playbook renders them to `/etc/tarubot/allowed_signers` for people, and refuses a pull run whose reading differs from the unit's. So a rotation is a root edit of `host.yml`, not a commit: a changed `host.yml` makes the next poll re-apply the commit the host already runs, before it looks at anything newer.
  - The check reads git's objects, so the files the playbook reads must be exactly those objects: git takes no attributes from the checkout (a `.gitattributes` a runtime-only merge added could otherwise re-encode `ops/ansible/`), and every file under `ops/ansible/` is compared with its blob after each checkout.
  - Squash and rebase merging are off in the repository's settings (@deconfined, 2026-09-28), leaving merge commits only. The **Protect Main** ruleset still allows squash, so setting it to merge commits only is an owner step.
  - The listed key, `id_git`, also signs the agents' commits on the operator machine. The check proves that a head was signed there, not that @deconfined approved it. It stops content a stolen GitHub session wrote, which is question 14's threat, but not the early merge of a head that is already signed and contains the current `main`, such as a pending agent pull request. Until a key only @deconfined holds is the only signer, which would make the check mean his approval, agent pull requests that change `ops/ansible/` stay unpushed or in draft until reviewed.
- **Runtime-only commits and the daily re-apply (question 17).** A commit that changes nothing under `ops/ansible/` since the last full run is recorded without the playbook. The current commit is re-applied at the first poll after 05:00 UTC, clear of the 04:30 backup and dnf-automatic's window. It is also re-applied after a hand run or an interrupted run, which a run marker the playbook writes reveals, on `apply-now`, and hourly while a failed commit is retried.
- **One health check per host (question 17).** Its ping URL lives in a root-only host file, never in the repository or the settings copy. Routine results ping success, which notifies nothing. Trouble pings `/fail` on every poll while it lasts, and healthchecks.io notifies once per change. A pause pages too, as `/fail paused`, by design: pausing the check in healthchecks.io doesn't silence it, since a paused check resumes at the next ping.
- **The lock.** The pull unit holds 2.33.0's `/run/tarubot/host.lock` around each full run and passes `tarubot_host_lock_held=true`. It never waits for a deploy, and a deploy waits up to 5 minutes for it. `ops/deploy.sh` and `deploy.yml` don't change; the no-op guard, the 05:00 window and the order of events keep a deploy's `busy` refusal rare.
- **Hand runs, pause, bootstrap and the emergency apply.** These follow "Manual runs are for building the playbook, a new host's first setup and emergencies only":
  - On a host with pull state, a real hand run, the start tag's included, is refused unless the unit is paused. `pause` waits for a run in progress.
  - `bootstrap COMMIT` starts a host once, with no signature check: @deconfined naming the commit as root is the trust anchor, as a `tofu apply` will be.
  - `apply COMMIT --emergency`, run by @deconfined as root, applies a commit newer than the applied one without the approval and signature checks, and always pages. It and `bootstrap` run detached from the SSH session (`systemd-run`), so a dropped connection can't leave a host half-applied.
  - The playbook keeps the timer enabled only once the host is bootstrapped, and never starts, stops or disables the unit itself.
- **New host settings.** The installed script refuses `host.yml` keys it doesn't know, and it judges the host settings its successor's playbook needs. A release that adds a key therefore adds it to the script's allowlist with a default in the playbook, and only a later release may require it; the owner adds the key to `host.yml` once the host runs the release that knows it.
- **Question 16.** `ops/ansible/` stays a runtime path in the Deploy plan, so every host-configuration change, this release included, asks for production's approval.
- **ansible-core (question 18).** The hosts install AlmaLinux's AppStream build, at least `1:2.16.16-2.el10_2.1`, which carries the CVE-2026-11332 backport. The floor is compared by RPM's own ordering, and the package is installed only when it is missing or older. Production's automatic updates skip it (since 2.33.0), so it moves there only when a commit raises the floor. The playbook's other package tasks also run only when something is missing, so a run with nothing to do loads no repository metadata.
- **No sandboxing on the service.** The service sets no `PrivateTmp` or other namespace option: the `tarubot` play's `podman info` can start the rootless pause process, which would otherwise keep a private `/tmp` that systemd deletes at the unit's stop.
- **Deferred.** A public status file with `ops/deploy.sh`'s host-level gate, the Deploy plan's wording for production approvals that also move host configuration, and cloud-init's bootstrap. Question 20's removal of staging's Ansible key stays an owner step once the unit is proven on staging.

## 1. Purpose and interpretation

TaruBot connects a Final Fantasy XIV Free Company (FC) with its Discord server. It associates Discord users with game characters, observes FC membership through Lodestone, and manages Discord access accordingly. It also supports guest applications, character-based nicknames, and a manually maintained FC gil ledger.

This document is a standalone implementation contract defining TaruBot's behavior, architecture, data interfaces, deployment, and acceptance criteria. Numbered requirements, command contracts, and acceptance criteria are mandatory unless explicitly labeled as recommendations. **MUST** requirements are mandatory. **SHOULD** requirements may be departed from only with a documented reason that preserves the stated behavior and invariants.

### 1.1 Sources of authority

- **Lodestone, accessed through Nodestone:** observed character identity, names, worlds, FC metadata, and FC rosters.
- **PostgreSQL:** character links, verification provenance, guild configuration, access grants, membership history, ledger transactions, pending work, and audit history.
- **Discord:** current guild membership, effective permissions, role/channel existence, observed roles and nicknames, and notification delivery results.
- **Ledger users:** reported gil movements and opening balances. The ledger is a human-maintained accounting record of the FC's gil.

Synchronization combines Lodestone observations with PostgreSQL policy state to determine Discord access. Character ownership is established through the verification, assignment, and import policies below; FC membership is established through accepted roster observations.

### 1.2 Confirmed product decisions

| Decision | Required policy |
| --- | --- |
| Application language | TypeScript, strict mode, modern ECMAScript, native ESM |
| Module format | TaruBot-owned source, scripts, configuration code, and output use ESM; dependencies may use CommonJS |
| Discord library | Discord.js v14 |
| Database | PostgreSQL |
| Application runtime/tooling | Bun throughout, with exact versions and compiled production ESM |
| Lodestone integration | Source-built Nodestone Docker sidecar, accessed through a typed HTTP adapter |
| Runtime containers | TaruBot, Nodestone, and PostgreSQL |
| New self-service character claims | Verify a token in the character's Lodestone biography |
| Imported character links | Trust the supplied ownership links with explicit import provenance |
| Former FC members | Automatically eligible for guest access after confirmed departure |
| Guest-role holders at cutover | Create explicit imported guest grants from a complete Discord snapshot |
| Registered users without an FC character | Automatically Guest while at least one trusted link exists and no linked character is a confirmed FC member (ROLE-07) |
| Humans present at an imported guild's first activation who do not qualify for Member | Durable `grandfathered` guest grants, created once (MIG-14) |
| Other newcomers | An audited officer grant; approved applications once guest applications are switched on after launch (CFG-08) |
| Channel operations | Read-only channel metadata through `/channel` |

### 1.3 Scope boundaries

**SCOPE-01.** Implement the configuration, character ownership, membership synchronization, nickname, guest application, ledger, and utility operations defined in Section 4.

**SCOPE-02.** Channel functionality consists of metadata queries through `/channel` and configured destinations for application messages. Voice-channel conversation controls and color/status workflows are outside the application scope.

**SCOPE-03.** The Lodestone adapter owns Lodestone page acquisition and parsing (with TaruBot's own selector-driven parser since 2.20.0, in the bot process since 2.21.0; a Nodestone sidecar before). TaruBot accesses its results through the typed adapter defined in Section 9, which owns normalization, validation, and application-facing error handling.

**SCOPE-04.** Support independently configured Discord guilds. Each guild may link to at most one FC at a time. Guilds observing the same FC maintain independent permissions, character links, guest grants, and ledger accounts.

**SCOPE-05.** Public character/FC caches and roster fetches may be shared. Authority-bearing application data must be guild-scoped. Every private read and mutation must authorize the actor against the guild that owns the target record.

**SCOPE-06.** A web dashboard, in-game automation, arbitrary FC-rank-to-Discord-role mappings, and production high-availability/sharding infrastructure are outside this release. The initial deployment is one active bot instance with restart-safe persistence.

## 2. Runtime, language, and project standards

**TECH-01.** Use the latest stable TypeScript release and an exact stable Bun release at implementation time, recording exact versions in the repository/build configuration. Use Bun for dependency management, tooling, tests, and production execution. Pin a supported PostgreSQL release; PostgreSQL 18 is the planning baseline.

**TECH-02.** The first-party package must declare `"type": "module"`. TypeScript must use `target: ESNext`, `module: NodeNext`, and `moduleResolution: NodeNext`. The pinned Bun runtime must support the JavaScript features actually emitted and used.

**TECH-03.** Enable `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, and `verbatimModuleSyntax`. Use explicit type-only imports and Node-compatible relative import extensions. Build and type checking must cover first-party application code, scripts, and tests.

**TECH-04.** Author application code, scripts, tests, and executable configuration as ESM, using ESM imports/exports and `.ts`, `.js`, or `.mjs` files as appropriate. Import dependencies using ESM syntax or dynamic `import()`. CommonJS inside a separately packaged third-party dependency is acceptable. Apply first-party module-format checks to the application/tooling boundary.

**TECH-05.** Treat external data and caught exceptions as `unknown` until validated. Use runtime schemas, type narrowing, and explicit optional/error states to establish their application types. Enforce strict typing with an explicit-`any` lint rule. A narrow, documented assertion at Nodestone's request-type compatibility boundary is permitted as described in Section 9.

**TECH-06.** Production must execute compiled JavaScript. Use a committed dependency lockfile, deterministic installation/build commands, exact dependency revisions, and versioned or digest-pinned production images.

**TECH-07.** Use first-party layers with clear responsibilities: domain policy, application operations, Discord interaction handling, Nodestone adaptation, PostgreSQL persistence, background work, and configuration/observability. Domain policy must be testable without a Discord connection or live Lodestone requests.

## 3. Core domain invariants

### 3.1 Identifiers and values

**DATA-01.** Discord snowflakes, character IDs, and FC IDs must be canonical positive decimal strings throughout application interfaces, persistence, logs, and serialized jobs. Use PostgreSQL text columns with positive-decimal validation sufficient for unsigned 64-bit external identifiers. For example, `9232097761132958152` is a valid FC ID that must round-trip exactly through every boundary.

**DATA-02.** At the dependency boundary, accept a canonical decimal-string ID or normalize a positive safe-integer ID to that representation. Return a typed invalid-data result for any other numeric value. Successful identity resolution requires a lossless value from the source.

**DATA-03.** Store names, tags, worlds, and data centers as Unicode display attributes associated with stable IDs. Store a character's canonical full name explicitly. Database text capacity must accommodate complete valid source values; command-specific input limits are validated separately. Preserve canonical spelling and punctuation.

**DATA-04.** Application timestamps must use PostgreSQL `timestamptz` and represent UTC instants. Separate observation time, successful synchronization time, application decision time, and notification delivery time.

**DATA-05.** Gil is integral. Use PostgreSQL `bigint` for known ledger balances and signed entry deltas, and JavaScript `bigint` or an equivalently exact integer representation for arithmetic. Configure database value decoding for exact arithmetic. Serialize large monetary values as decimal strings.

### 3.2 Character links and membership

**DOMAIN-01.** A Discord user may link several characters within a guild. A character may have at most one active linked owner within that guild. Enforce this in PostgreSQL, including under concurrent requests. Links in different guilds are independent.

**DOMAIN-02.** A trusted active link has one of these provenance types: successful profile-token verification, audited officer assignment, or trusted data import. Only trusted active links participate in access eligibility.

**DOMAIN-03.** A user is eligible for the member role when at least one trusted linked character has confirmed membership in the guild's currently linked FC, established through accepted roster observations.

**DOMAIN-04.** Historical FC membership requires a trusted user-character link and an accepted observation of that character in the FC, or imported membership evidence meeting Section 12. Store the link and observation provenance supporting the historical record.

**DOMAIN-05.** Membership history must survive a character unlink, a confirmed FC departure, bot restarts, and a user leaving Discord. Scope former-member eligibility to `(guild, FC)` and evaluate it against the guild's current FC link.

### 3.3 Desired access

**ROLE-01.** Apply the following precedence to non-bot guild members:

| State | Member role | Guest role |
| --- | --- | --- |
| Confirmed FC member | Present | Absent |
| Not an FC member; active approved, manual, imported, or grandfathered guest grant; guest access not revoked | Absent | Present |
| Not an FC member; confirmed former member of the currently linked FC; guest access not revoked | Absent | Present |
| Not an FC member; at least one active trusted link, every linked character confirmed outside the currently linked FC by accepted current evidence (or no FC linked); guest access not revoked | Absent | Present |
| Confirmed ineligible for both | Absent | Absent |
| FC membership uncertain | Preserve existing FC-derived access; new grants await fresh evidence | Preserve guest state, subject to explicit local grants/revocations and member-role precedence |

**ROLE-02.** Guest revocation overrides approved, manual, imported, and grandfathered grants, registered-user eligibility (ROLE-07), and former-member guest eligibility until an officer explicitly restores access. FC-member eligibility is evaluated independently and takes precedence. Persist and audit both revocation and restoration; restoring through an explicit grant creates a durable manual grant. `/guest reset` restores the automatic rules instead: it lifts the revocation without creating a grant and ends every active approved, manual, imported, and grandfathered grant, so FC membership (current or former) and registered-user eligibility (ROLE-07) decide Guest again (GUEST-08).

**ROLE-03.** A confirmed former member becomes a guest automatically. Unlinking a user's last qualifying character is an explicit local loss of member eligibility and may result in former-member guest access. Roster-driven former-member status requires the departure evidence defined in Section 6.

**ROLE-04.** Automatic character-based role and nickname reconciliation applies to human guild members. Retain a departing user's links, history, ledger attribution, and guest grants. Rejoining triggers reconciliation using current configuration and observations.

**ROLE-05.** The configured member and guest roles are authoritative bot-managed access roles for human users, including when someone assigns them manually. Reconcile these roles from persisted policy state. Apply individual role deltas limited to current or explicitly retired bot-managed role IDs, preserving every unrelated role.

**ROLE-06.** During a refresh failure, retain the last confirmed FC-derived access state. Explicit local actions, such as guest revocation or character unlink, remain available when their result can be established entirely from PostgreSQL state.

**ROLE-07.** Evaluate each user's access as the union over their active trusted links in the guild. Imported, officer-assigned, and profile-verified links participate equally; profile FC hints and pending challenges never do.
(1) **Member:** at least one linked character has confirmed membership in the currently linked FC. A character awaiting departure confirmation still qualifies (SYNC-10).
(2) **Officer:** when an Officer role and FC officer rank are configured, at least one linked character with confirmed membership holds that normalized rank in accepted roster evidence. An assignment made by a bot-only officer does not confer it, and explicit manager grants/revocations override the automatic result until `/officer reset` removes the override.
(3) **Guest (registered user):** the user has at least one active trusted link, and no linked character qualifies under (1) according to accepted current evidence. With no FC linked, one active trusted link suffices. This applies in every configured guild regardless of lobby onboarding.
Unknown or stale evidence, including a linked character not yet evaluated against an accepted roster, preserves a role already held but cannot create a new Member, Officer, or registered-user Guest role. Registered-user Guest is derived, not stored: removing the last active link removes that basis, while approved, manual, imported, and grandfathered grants and former-member eligibility keep their own rules. Revocation (ROLE-02) suppresses it, and Member precedence (ROLE-01) always applies. Onboarding (ACCESS-01–ACCESS-05) never changes which access roles a user receives.

## 4. Discord command contract

All commands are guild-only. Unless expressly identified as a channel notification, responses are ephemeral. Commands that require network or database work must acknowledge or defer before Discord's initial response deadline, normally within three seconds. Every `member` option suggests server members as the user types and also accepts a pasted user ID or mention (UX-06).

### 4.1 Authorization definitions

- **Guild user:** a current non-bot member of the invoking guild.
- **Officer:** a guild user with effective `ManageGuild` permission, including the guild owner/administrator through Discord's effective permissions.
- **Ledger member:** a guild user with confirmed FC-member eligibility; an officer may also perform these operations.
- **Self:** the invoking user within the invoking guild.

**AUTH-01.** Enforce permissions in the application operation as well as at the Discord command boundary. Every subcommand, autocomplete that reveals private records, and button interaction must enforce its own applicable authorization and guild scope.

**AUTH-02.** Use Discord command default permissions to control command availability and runtime authorization to enforce each operation's policy. Evaluate mixed-permission subcommands and `force` options explicitly. Every `force: true` request requires officer authorization regardless of cache freshness.

**AUTH-03.** Selecting or unsetting managed roles additionally requires effective `ManageRoles`. Selected roles must be below the actor's highest role unless the actor is the guild owner, and must always be manageable by the bot. Validate member/guest roles as access roles with `Administrator`, `ManageGuild`, and `ManageRoles` permissions disabled.

### 4.2 Configuration commands

| Command | Access | Contract |
| --- | --- | --- |
| `/config fc link fc_id` | Officer | Validate the FC, link it to this guild, and enqueue initial synchronization. An identical existing link is a no-op; a different existing link requires explicit unlinking first. |
| `/config fc unlink fc_id` | Officer | Require the supplied ID to match the currently linked FC. Remove that link locally without requiring Lodestone availability. |
| `/config roles member [role] [unset_role]` | Officer + role authorization | Set or unset the member-role configuration. |
| `/config roles guest [role] [unset_role]` | Officer + role authorization | Set or unset the guest-role configuration. |
| `/config roles officer [role] [unset_role] [adopt_holders]` | Server manager (Manage Server and Manage Roles) + role authorization | Set or unset the bot-only Officer role (approved staff-rank amendment). Binding a role grants its current human holders audited manual officer grants unless `adopt_holders:false`; the choice is audited. |
| `/config roles leader [role] [unset_role]` | Server manager (Manage Server and Manage Roles) + role authorization | Set or unset the FC Leader role. |
| `/config officer_rank [rank] [unset_rank]` | Server manager (Manage Server and Manage Roles) | Set the in-game FC rank that grants bot officer authority (ROLE-07), or unset it so that only manual officer grants apply. Naming the saved rank, or unsetting when no rank is set, changes nothing and says so (UX-02). |
| `/config ledger [channel] [unset_channel]` | Officer | Set or unset the ledger notification channel. |
| `/config officer_notifications [channel] [unset_channel]` | Officer | Set or unset the operational/officer notification channel. |
| `/config changelog [channel] [unset_channel]` | Officer | Set or unset the channel for update posts (CFG-09). Setting it posts nothing at once; the first post comes with the next update that has something for members. |
| `/config guest_applications [enabled] [channel] [unset_channel]` | Officer | Switch guest applications on or off, and set or unset their review channel, in one audited revision (CFG-08). Switching on validates the review channel that will take applications; switching off keeps waiting applications reviewable. |
| `/config role_layout enabled` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks when enabling) | Turn automatic managed-role display and ordering on or off for this guild (CFG-07). Off never changes any role's hoist flag or position; enabling queues one layout pass. |
| `/config show` | Officer | Display configuration, enabled/blocked capabilities, linked FC, and relevant freshness/status information. |
| `/config validate` | Officer | Check stored roles/channels, current bot permissions/hierarchy, and configuration consistency without mutating access. |
| `/setup [fc_id] [prefix] [officer_rank] [lobby] [officers]` | Server manager (Manage Server, Manage Roles, and Manage Channels) | Create or reuse the four access roles and the lobby and officer rooms, and enable onboarding (ACCESS-01). It also switches guest applications on, using the officer room as the review channel when none is set (CFG-08), and adopts the Officer role's current holders. Not run in the production guild at launch. |
| `/officer grant member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Record an audited officer grant for a current member, overriding the rank-derived result (ROLE-07). Works before an Officer role is bound. |
| `/officer revoke member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Record an audited officer revocation, overriding the rank-derived result; works for a user who has left. |
| `/officer reset member reason` | Server manager (Manage Server and Manage Roles; AUTH-03 hierarchy checks on the bound Officer role, if any) | Remove the member's officer grant or revocation, so the configured in-game rank decides again (with no rank set, only manual officer grants confer officer authority); works for a user who has left. Audited; with no override to remove, nothing changes. |

For the set/unset commands (`/config roles …`, `/config ledger`, `/config officer_notifications`, `/config changelog`, and `/config officer_rank`), require exactly one of a value or the command's unset option (`unset_role:true`, `unset_channel:true`, or `unset_rank:true`). `/config guest_applications` requires at least one of `enabled`, `channel`, and `unset_channel`, and refuses `channel` together with `unset_channel`. No `/config` option is named `clear` (2026-09-24 amendment). Unsetting stops TaruBot using the channel, role, or rank and deletes no Discord channel or role; an unset managed role is still removed from its holders by the retired-role cleanup (CFG-04). Validation failures retain the saved configuration and return a corrective instruction.

**CFG-01.** IDs or canonical Lodestone URLs may identify an FC. Extract the ID from an allowed Lodestone host and the expected FC path, validate it, and resolve it through the configured Nodestone adapter.

**CFG-02.** Roles must be distinct, existing, assignable guild roles; exclude `@everyone`, integration-managed roles, and the bot's own role from selection. Channels must be guild text channels belonging to the guild and supporting the required messages/embeds.

**CFG-03.** Check required bot permissions and hierarchy before saving configuration. Recheck them before effects because permissions and role positions can change later. A deleted/misconfigured resource must block only affected operations and produce an actionable diagnostic.

**CFG-04.** Persist configuration revisions. Configuration changes must enqueue reconciliation. Superseded managed roles require durable cleanup of the retired role IDs; preserve unrelated roles. Unsetting a role stops its future assignment and schedules its cleanup.

**CFG-05.** Unlinking an FC removes FC-derived member access and the automatic former-member eligibility associated with that link. With no FC linked, every user with an active trusted link qualifies as a registered Guest under ROLE-07, subject to revocation. Explicit approved, manual, imported, and grandfathered guest grants remain guild-scoped and continue to apply. Record unlinking as a configuration event, retaining existing membership history.

**CFG-06.** Preserve character links, historical membership, ledger accounts/entries, and audit records when unlinking an FC. Relinking the same FC reuses its history and ledger account. Linking a different FC resolves that FC's separate guild-scoped account.

**CFG-07.** Persist a per-guild role-layout switch. When it is on, TaruBot keeps the configured managed roles displayed separately and in one consecutive FC Leader → Officer → Member → Guest block (see the 2026-09-21 amendment). When it is off, TaruBot MUST NOT change any role's display (hoist) or position: layout work completes as skipped; startup, rejoin, role events, configuration, and refresh schedule no layout work; and roles created by `/setup` keep Discord's default display. Role assignment is unaffected.
Starting values: guilds created by the legacy import start with the switch off. Every other guild starts with it on, including guilds first created by `/setup` or `/config` and guilds managed live before migration 005. `/setup` never changes the switch.
`/config role_layout enabled:<true|false>` requires a server manager with Manage Server and Manage Roles, plus AUTH-03 hierarchy checks for each managed role when enabling. A change is audited and advances the configuration revision; repeating the current value changes nothing. Enabling queues one layout pass. Disabling leaves the current display and order unchanged, and a pass already running stops before its next write. The read-only cutover preview reports the switch and the hoist/position changes that enabling it would make.

**CFG-08.** Persist a per-guild guest-application switch, separate from the review channel (2026-09-24 amendment). Guest applications are open only when the switch is on and both a review channel and a Guest role are configured; `/apply`'s pre-form check, submission, activation, and the read-only preview use this one rule (GUEST-02).
`/config guest_applications` takes `enabled:true|false`, `channel:#…`, and `unset_channel:true` in any combination, except a channel together with `unset_channel:true`. It saves them in one configuration revision, audits each changed setting, and enqueues reconciliation like other configuration changes. A request that matches the saved state changes nothing and says so. Before saving, it validates any channel named in the request and, when the request switches applications on, the stored review channel that will then take them, including a legacy channel the import kept (CFG-02). A request that only switches applications off or unsets the channel validates nothing, so a deleted channel never blocks closing. If the saved settings change between that validation and the save, so that applications would take a channel that was not validated, nothing is saved and the reply asks the officer to run the command again. Switching on without a review channel or Guest role saves the switch but leaves `/apply` closed. Switching off refuses only new `/apply` submissions; applications already waiting stay reviewable (GUEST-04).
Starting values: migration 006 turned the switch on for guilds that already had a review channel and were not awaiting first activation, and off everywhere else. A guild created later starts with it off. `/setup` turns it on (ACCESS-01). The legacy import keeps the legacy review channel with the switch off (MIG-03). Activation changes the switch only on an explicit choice (`open` requires a configured review channel), keeps the channel either way, and validates the review channel only when applications will be open. `/config show` reports the switch together with the review channel it keeps, and `/config validate` reports a review-channel check only while applications are on.

**CFG-09.** Persist a per-guild changelog channel and the newest version the guild was told about (2026-09-25 amendment). Update posts are off until a channel is set. Setting a channel where none was sets that version to the running one, or keeps a higher stored one, so nothing is posted at once; moving or unsetting the channel keeps it, and TaruBot never lowers it. The channel is validated like every channel setting (CFG-02).
At startup, each present guild with a channel and an older stored version gets an update post. A guild has at most one active (queued, running or blocked) update post, and a restart merges into it. While Discord changes are paused a parked post isn't merged, so each restart may park another; they collapse to one when changes resume, so one post goes out. The post lists the member note of each release after the stored version up to the running one, newest first, then moves the stored version forward; releases without a note are left out, and a range without notes moves the version without posting. A post never repeats a release already announced, including after a restart or a rollback; a crash just after sending may repeat one post, as for ledger posts. Posts wait while Discord changes are paused and while the channel's permissions are missing.
Where onboarding manages channel visibility (ACCESS-01), `/config changelog` and `/config validate` warn when the channel is hidden from members and guests (the lobby, the officer room, or a staff-only channel) or is not managed by onboarding; TaruBot changes no permissions for it.

### 4.3 Character commands

| Command | Access | Contract |
| --- | --- | --- |
| `/claim [character] [forename] [surname] [world]` | Self | Resolve a character and create a pending profile-token verification challenge. |
| `/verify character` | Self | Verify the caller's pending challenge for this character. A persistent verification button may invoke the same operation. |
| `/unclaim character` | Self | Remove the caller's active local link using stored identity, without depending on Lodestone availability. |
| `/assign member reason [character] [forename] [surname] [world]` | Officer | Make an audited, trusted manual assignment to a current non-bot guild member. |
| `/unassign member character reason` | Officer | Remove that user's local character link. Stored owner IDs must remain usable after the user leaves Discord. |
| `/characters [member]` | Self; officer for another user | List local links, provenance/status, canonical names/worlds, primary character, and known FC information. |
| `/main character` | Self | Select an active trusted linked character as the guild-specific primary character. Naming the current primary character changes nothing and says so. |
| `/nickname enabled` | Self | Enable or disable bot-managed character nicknames for this guild. Repeating the current setting changes nothing and says so; resuming management that a manual nickname suspended is a change. |

**CHAR-01.** For claim/assignment, require exactly one selector form: `character` as a positive ID/canonical character-profile URL, or the complete `forename`, `surname`, `world` triple. Reject incomplete or conflicting selector forms.

**CHAR-02.** Search must use full name and world, normalize comparison whitespace/Unicode/case consistently, and compare exact identity attributes. Return the unique exact match, require explicit selection among multiple exact matches, or report a complete no-match result. Expose incomplete and failed searches as separate outcomes.

**CHAR-03.** Commands operating on existing links must support stable IDs and autocomplete from PostgreSQL, displaying the stored name/world. Unclaim, unassign, and primary selection must work after a character rename, world transfer, or Lodestone outage. Removal must verify the stored owner before changing anything.

**CHAR-04.** Reclaiming/reassigning a character already linked to the same user is idempotent. Return an ownership conflict when a different active owner exists. Reassignment consists of explicit authorized unlinking followed by creation of a new trusted link.

**CHAR-05.** Commit successful local link changes independently of Discord role/nickname delivery. Enqueue affected-user reconciliation in the same transaction and report side effects as queued, applied, or blocked. Verified ownership remains durable throughout delivery retries.

### 4.4 Membership, guest, ledger, and utility commands

| Command | Access | Contract |
| --- | --- | --- |
| `/refresh [force]` | Guild user; officer for force | Refresh when due, or reconcile from usable cached data. Return the run ID, freshness/cooldown, and queued/completed/blocked result. |
| `/sync status [run_id]` | Guild user for their own requests; officer for guild-wide status | Inspect authorized refresh/reconciliation results and pending/blocked work, including after the initiating interaction expires. |
| `/apply` | Guild user | Submit a guest application when applications are open in this guild (the guest-application switch is on and a review channel and Guest role are configured; CFG-08) and the user has no active trusted link, lacks member/guest access, and has no pending application; otherwise explain why. While applications are closed, refuse before the form opens. Closed at launch (see Approved launch amendments). |
| `/guest approve application` | Officer | Approve a pending application through the same operation used by its review button. |
| `/guest deny application [reason]` | Officer | Deny a pending application through the same operation used by its review button. |
| `/guest grant member reason` | Officer | Grant guest access manually, with an audit record; can explicitly restore revoked guest access. |
| `/guest revoke member reason` | Officer | Persistently revoke guest eligibility and cancel unresolved applications for that user. |
| `/guest reset member reason` | Officer | Lift the user's guest revocation and end every active guest grant of any provenance, keeping the ended grants as history, so the automatic rules decide Guest again (ROLE-02). Audited; with nothing to remove, nothing changes. |
| `/guest status [member]` | Self; officer for another user | Show application, grant, revocation, and automatic-guest status within this guild. |
| `/ledger deposit amount note` | Ledger member | Record a positive deposit. |
| `/ledger withdraw amount note` | Officer | Record a positive withdrawal if sufficient recorded funds exist. |
| `/ledger balance [fc_id]` | Ledger member; officer for historical FC | Show the initialized/unknown balance and relevant delivery status. |
| `/ledger history [fc_id] [before]` | Ledger member; officer for historical FC | Paginate durable entries using a stable cursor. |
| `/ledger initialize balance note` | Officer | Set the opening balance of an uninitialized current guild/FC ledger exactly once. |
| `/ledger adjust balance note [entry]` | Officer | Append a correction bringing the recorded balance to the specified value; optionally reference the corrected entry by its entry number (`5` or `#5`) or its entry ID (LEDGER-07). |
| `/ping` | Guild user | Report Discord gateway latency with an appropriate label. |
| `/channel` | Guild user | Report the current channel's ID, name, and type. |
| `/version [commits]` | Guild user | Show the installed SemVer and recent GitHub commit IDs, links, titles, and verified-signature badges. |
| `/issue description` | Guild user | Report a problem to TaruBot's maintainers in the private reports repository, with a snapshot of the member's account and the bot (see Approved issue-reporting amendments). |
| `/suggest idea` | Holder of the bound Member or Guest role, in the deployment's own server | Post a feature suggestion publicly as an issue in `deconfined/tarubot`, with only the cleaned text and the version, and reply with its link (see Approved public-suggestion amendments). |

**UX-01.** Bound input sizes and honor Discord message, embed, autocomplete, and component limits. Escape user-controlled display content and set an explicit allowed-mentions policy, defaulting to no parsed mentions. Authorize any intended recipient mention separately from user-supplied text.

**UX-02.** Distinguish committed application state from pending Discord effects. Long jobs must remain inspectable after an interaction token expires. Use completion wording only for confirmed successful effects, and queued/blocked wording for work awaiting delivery. Never imply a change that did not occur: a request that matches the saved state gets a reply saying that nothing changed, never a change receipt (2026-09-24 amendment). Examples include `/main` naming the current main character, `/nickname` repeating its setting, `/config officer_rank` naming the saved rank (or `unset_rank:true` with none set), `/config guest_applications` or `/config role_layout` matching the saved state, and `/officer reset` or `/guest reset` with nothing to remove.

**UX-03.** Represent an unconfigured guild explicitly and return setup instructions. Read-only commands use read-only persistence operations; configuration is created through authorized configuration commands.

**UX-04.** Register the declared command set through an explicit deployment operation. Support guild-scoped registration for development and intended production registration. Reconcile the bot's registered commands to exactly the command set defined in Section 4. Production registers the declared set in global scope and leaves no guild-scoped commands for the production application. Command maintenance tooling reads back every scope. It clears leftover guild-scoped commands in a named guild only after a dry run and a fingerprint-bound confirmation, and never clears the global scope.

**UX-05.** An input failure caused by an option's value names that option and shows an example of a valid value for it. An input failure that no option value caused names no option and shows no example, which would only repeat the failed command: `/nickname enabled:true` without a main character names `/main` as the step to take instead. Every option of every registered command path has an example, including ID options such as `/ledger adjust entry`, `/sync status run_id`, and `/guest approve|deny application`; automated checks fail on any option without one (2026-09-24 amendment).

**UX-06.** Every member option autocompletes current human server members by display name, username, global name, or nickname, with the user ID as the submitted value. This covers `/characters`, `/assign`, `/unassign`, `/guest status|grant|revoke|reset`, and `/officer grant|revoke|reset`. A pasted user ID or mention is still accepted, so a user who has left the server stays nameable by ID (CHAR-03). Where a member may name only themselves, they are offered only themselves. Suggestions grant nothing: each operation still authorizes its actor and target (AUTH-01) (2026-09-24 amendment).

## 5. Character verification and nickname behavior

### 5.1 Verification protocol

**VERIFY-01.** Generate at least 128 bits of cryptographic randomness for each challenge. Bind it to the guild, Discord user, character ID, issuance time, and expiry. The default lifetime is 30 minutes. A replacement challenge invalidates the previous challenge for that same tuple.

**VERIFY-02.** Present an exact token and instructions for placing it in the character's public Lodestone biography. Verification succeeds when a fresh profile obtained through Nodestone for the bound character ID contains that exact token and the stored challenge remains valid.

**VERIFY-03.** Persist the token hash, retaining plaintext only for its ephemeral presentation and in-memory comparison. Redact tokens, full biographies, and interaction credentials from logs. An unexpired challenge remains usable across a process restart. Authorize every verification component against its stored challenge.

**VERIFY-04.** Challenge completion must atomically check expiry/consumption and tuple binding, enforce ownership uniqueness, create the trusted link, and consume the challenge. Concurrent attempts resolve to one committed ownership decision and a deterministic result for every other attempt.

**VERIFY-05.** Keep pending challenges separate from trusted ownership and its role/nickname effects. Several users may attempt proof of an available character; only successful challenge completion establishes ownership. Bound pending-request volume per user and globally. Retain retryable challenge state after a network failure until expiry.

**VERIFY-06.** Account for Lodestone publication delay. Show pending/not-yet-visible status and permit bounded retries until expiry. Verification must fetch a fresh profile independently of the application profile cache. Existing trusted links remain durable during profile unavailability.

### 5.2 Nicknames

**NICK-01.** Store primary-character selection and nickname preferences per `(guild, user)`. For a new user with no prior links, the first successfully trusted link becomes the initial primary character and enables nickname management. Thereafter the selection changes through `/main` or removal of the selected link. A new trusted link also becomes the primary character when the user has no primary character and no other active link, for example after removing every link; it keeps the user's nickname-management setting. With management on, the new primary character's nickname replaces a restore still pending from removing the previous primary (NICK-04), as `/main` does; with management off, that restore stands. Imported users keep their imported state (NICK-06).

**NICK-02.** The generated nickname is the canonical full character name. Format it within Discord's nickname length limits using Unicode-safe truncation when necessary, and retain the complete canonical name in PostgreSQL.

**NICK-03.** Track the pre-management nickname and the last nickname successfully written by the bot. An independent nickname change suspends automatic nickname management for that user. Explicit re-enablement establishes a new management baseline.

**NICK-04.** Disabling management or unlinking the primary character restores the saved pre-management nickname when the current nickname still matches the last bot-written value. Otherwise retain the current nickname. Unlinking the primary clears the selection and returns instructions for selecting another character.

**NICK-05.** Renames/world changes must update cached identity attributes. A managed nickname follows a confirmed primary-character name update. Report bot permission/hierarchy limitations as scoped blocked effects while retaining the character link. Discord lets no bot change the guild owner's nickname, so reconciliation never writes or restores it, drops any pending nickname write or restore for the owner, and never blocks on it; replies to the owner say so instead of promising a nickname change (2026-09-24 amendment).

**NICK-06.** Imported users start with an unset primary character and nickname management disabled, retaining their current Discord nickname. They can select a primary character and enable management explicitly.

## 6. Synchronization and reconciliation

### 6.1 Scheduling and acquisition

**SYNC-01.** Schedule a complete roster refresh for each actively linked FC every six hours by default, with jitter and startup catch-up. Fetch a shared FC once per refresh even if multiple guilds link to it. Limit scheduled roster acquisition to actively linked FCs.

**SYNC-02.** Trigger targeted reconciliation after successful claims/assignments/unlinks, primary or nickname preference changes, guest decisions/revocations, guild member joins, relevant configuration changes, and managed-role drift. Ignore or coalesce the bot's own resulting Discord events to avoid feedback loops.

**SYNC-03.** Refresh display profiles for trusted linked characters of currently present users on a bounded schedule, defaulting to daily, and on explicit identity/verification operations. Deduplicate shared profile fetches. Store profile FC hints separately from the accepted roster evidence used for access decisions.

**SYNC-04.** A normal `/refresh` before the six-hour roster interval expires may reuse a fresh accepted roster while reconciling Discord state. `force: true` is officer-only and bypasses that freshness interval, not global concurrency/rate limits or an existing refresh lock.

**SYNC-05.** New verified links whose membership cannot be established from fresh cache may request a coalesced early refresh. Departure-confirmation fetches may also run before the periodic interval. Default minimum FC refresh separation is 60 seconds; callers must receive an honest queued/cooldown result.

**SYNC-06.** Acquire a complete roster before publishing membership changes:

1. Fetch and validate FC identity, metadata, and advertised roster count.
2. Fetch every required roster page through Nodestone, with bounded pagination and resource usage.
3. Validate required member identity fields, unique character IDs, page progression, consistent pagination, and total distinct member count.
4. Recheck FC identity/count to detect changes during the crawl. Retry inconsistent observations while retaining the accepted snapshot.
5. Atomically publish an accepted snapshot and its successful observation time, or retain the previous accepted snapshot on failure.

Treat a multi-page crawl as a time-bounded observation. Record its acquisition interval and completeness checks; atomicity applies to publication of the validated observation in PostgreSQL.

**SYNC-07.** A missing page, repeating page, pagination cycle, malformed ID, missing required field, inconsistent count, maintenance response, timeout, or parser failure invalidates the candidate snapshot. Retain the accepted snapshot and record a typed, retryable or terminal acquisition result.

**SYNC-08.** A genuinely empty roster is valid only with affirmative, validated empty/count evidence for the expected FC. Represent missing count/pagination evidence as unknown. Support single-page and empty-page normalization through explicit, tested Nodestone contracts.

### 6.2 Membership transitions

**SYNC-09.** Positive membership may be established from one fresh, complete accepted snapshot. A roster-driven departure of a previously confirmed character requires absence in two complete accepted snapshots at least 60 seconds apart. Schedule confirmation work when needed. Reappearance resets pending departure; only complete accepted observations advance confirmation state.

**SYNC-10.** For users with several trusted characters, remove member eligibility only when none remains confirmed or awaiting departure confirmation. Persist pending/confirmed transition state and resume that state after restart.

**SYNC-11.** Evaluate a newly linked character against a fresh accepted roster. A match establishes current membership; an absent character leaves that link ineligible for current membership. Historical eligibility is evaluated independently using the evidence defined in DOMAIN-04 and Section 12.

**SYNC-12.** When usable current evidence is unavailable, preserve existing FC-derived access and expose stale/degraded status to officers. New member-role grants wait for fresh evidence, and roster-driven demotions wait for confirmed departure evidence.

**SYNC-13.** Update `last_successful_roster_at` only when publishing a complete accepted snapshot. Track attempted/failed acquisition times and Discord reconciliation progress as separate states and timestamps.

### 6.3 Applying Discord effects

**SYNC-14.** Obtain complete Discord guild-member coverage using supported fetching/pagination, recording whether enumeration completed. Scope reconciliation to human users who remain in the guild, and record individual departure/skipped outcomes while continuing the run.

**SYNC-15.** Apply only necessary role deltas and respect Discord.js REST rate-limit handling. Before applying work, recheck current configuration, the member's presence, and current desired state. Supersede or recompute work whose governing configuration or snapshot has changed.

**SYNC-16.** Serialize conflicting effects for a `(guild, user)` and make repeated reconciliation idempotent. Track partially applied role transitions and retry them toward current desired state. Expose role projection as an eventually consistent operation with per-effect completion status.

**SYNC-17.** Missing permissions, missing roles/channels, or hierarchy failures must be scoped, diagnosable blocked work. Continue reconciling other users/capabilities. Resume blocked work when its configuration or permissions change; apply bounded backoff to transient failures.

## 7. Guest applications and grants

**GUEST-01.** Persist applications with guild, applicant, current guild-join context, creation time, review channel/message IDs, state, reviewer, decision time, and optional reason. Enforce at most one pending application per `(guild, user)` in PostgreSQL.

**GUEST-02.** `/apply` requires the guest-application switch to be on and a valid guest role and review channel (CFG-08). Persist the application and its review-message work together. The review message identifies the applicant, submission time, and application ID and provides approval/denial controls. Return the pending application for duplicate requests, or explain existing member/guest eligibility. An unregistered newcomer gains guest eligibility through an explicit officer grant or, while applications are open, approval. A user with an active trusted link receives it through ROLE-07 and is directed away from `/apply`. When applications are closed (switched off, or without a review channel or Guest role), `/apply` refuses with a visitor-facing explanation before its form opens, and again if a form opened earlier is submitted.

**GUEST-03.** Support `pending`, `approved`, `denied`, `cancelled`, and `superseded` application outcomes. Approval/denial must atomically transition only a pending application. Concurrent/repeated decisions return the single committed outcome.

**GUEST-04.** Review buttons must resolve durable application identifiers from PostgreSQL and work after restarts. Validate guild, application/message identity, actor permissions, and current applicant state on every click before invoking the authorized decision operation. Switching applications off (CFG-08) refuses only new submissions; pending applications stay reviewable through their review controls and `/guest approve|deny`.

**GUEST-05.** At decision time, cancel a pending application if the applicant has left or its guild-join context is obsolete. Supersede a pending application if the applicant became an FC member. Retain committed decisions as audit outcomes; effect execution independently rechecks current membership and applies the role precedence in ROLE-01.

**GUEST-06.** Approval creates a durable guest grant and reconciliation work in one transaction. Queue a best-effort DM for approval/denial identifying the guild and outcome, with the decision reason when supplied. Track application outcome, grant state, role-delivery status, and DM-delivery status separately. Retain the decision during delivery failures and expose failed role delivery as retryable or blocked work; `/guest status` provides the applicant's durable outcome.

**GUEST-07.** Retain review history in PostgreSQL, update the review message with its outcome, and disable completed controls. Recreate a missing review message or handle the application through its command ID. Message repair operates from the durable application record.

**GUEST-08.** Persist approved, manual, imported, and grandfathered grants with provenance. Guest revocation must be durable and auditable. An officer's subsequent explicit approval/grant may restore access. Denied applicants may reapply after a configurable cooldown, defaulting to 24 hours. Any existing revocation remains effective until explicit restoration or `/guest reset`. `/guest reset` ends grants instead of deleting them: an ended grant records when, by whom, and why it ended, confers nothing, and no longer appears in `/guest status`. First-activation grandfathering still counts it as an existing grant, so its holder receives no `grandfathered` grant (MIG-14).

**GUEST-09.** Approved/manual/imported/grandfathered grants survive the user's departure from Discord and can apply on rejoin unless revoked or ended by `/guest reset`. Cancel pending applications on an observed departure and require a matching stored guild-join context at decision time. On rejoin, evaluate existing grants and history under current policy.

## 8. Gil ledger

**LEDGER-01.** A ledger account belongs to `(guild, FC)`. Its account ID remains stable when that guild temporarily unlinks/relinks the FC. Guilds observing the same FC have distinct, independently authorized ledger accounts.

**LEDGER-02.** An account is either uninitialized or has an exact, nonnegative balance. New accounts and imported unknown balances require explicit initialization. A known zero balance is initialized state. Enforce a single initialization per account, including under concurrent requests.

**LEDGER-03.** Accept deposits and withdrawals from 1 through 999,999,999 gil. Use Discord integer options for this bounded range and convert to exact arithmetic at the boundary. Initialization and target-balance adjustments accept validated decimal strings sufficient for PostgreSQL `bigint` range.

**LEDGER-04.** Record immutable entries containing account, monotonically ordered account sequence, operation type, signed delta, resulting balance, actor, source guild, note, timestamp, originating interaction/idempotency key, and optional correction reference. Opening entries may have zero delta; deposits and withdrawals have strictly positive input amounts and appropriately signed deltas.

**LEDGER-05.** Notes are required for mutations: trim surrounding whitespace and require 1 through 1,000 UTF-16 code units, with Discord presentation limits also validated. Store the complete accepted note and render it under the allowed-mentions policy. Deposits require ledger-member authorization; withdrawals, initialization, and adjustments require officer authorization.

**LEDGER-06.** In one PostgreSQL transaction, enforce the idempotency key, lock/serialize the account, validate initialization/range/funds, insert the entry, update the balance, and enqueue its notification. Competing withdrawals are evaluated in account order against the resulting available balance, retaining the nonnegative-balance invariant.

**LEDGER-07.** Record corrections as additional signed entries referencing immutable history. `/ledger adjust` records the difference between the current and supplied target balance with an explanation. An identical target is a no-op. A referenced prior entry must belong to the same account. An officer names it by entry number (`5` or `#5`) or entry ID; a number resolves within the current account, and a number or ID that is not in that account is refused as not found.

**LEDGER-08.** Require a linked FC and a valid configured ledger channel before accepting a financial mutation. If delivery fails after the transaction commits, retain the transaction and mark delivery pending/blocked. Return the durable entry ID, delivery state, and a route to inspect or retry notification work independently.

**LEDGER-09.** Ledger-channel notifications include stable entry ID/sequence, actor, operation, amount, note, resulting balance, and event time. Preserve per-account notification order. PostgreSQL is authoritative even when a message is deleted or duplicate notification delivery occurs after an ambiguous network acknowledgement.

**LEDGER-10.** Enforce exactly-once financial mutation per idempotency key. Deliver notifications through a durable at-least-once outbox, using supported deduplication and stored Discord message IDs. Associate every delivery attempt and any duplicate visible notification with the same immutable entry.

**LEDGER-11.** Balance/history default to the currently linked account. Officers may inspect historical accounts belonging to their own guild by FC ID, including while no FC is linked. Authorize normal-user reads against current ledger membership and the current account; authorize historical reads against guild ownership and officer permission.

## 9. Nodestone dependency contract

### 9.1 Source-built sidecar integration

**NODE-01.** Run Nodestone's parsers in an isolated Docker sidecar with outbound HTTPS access to Lodestone. TaruBot accesses a validated HTTP envelope through a single typed adapter. The sidecar uses these parser exports from pinned upstream source:

| Nodestone export | Use | Expected raw result shape to validate |
| --- | --- | --- |
| `CharacterSearch` | Full-name/world search, one page at a time | A root `List` and `Pagination`, with explicit no-results handling where supported |
| `Character` | Canonical profile attributes and biography verification | Direct profile fields such as `Name`, `World`, `DC`, `FreeCompany`, and `Bio` |
| `FreeCompany` | FC identity, display metadata, and roster count | Direct fields including `ID`, `Name`, `Tag`, `World`, `DC`, and the validated member-count field |
| `FCMembers` | One FC roster page | A root `List` and `Pagination` |

Validate these raw shapes against the selected Nodestone package version and convert them into the adapter's normalized application types.

**NODE-02.** Track upstream HEAD of the Nodestone source and selector repositories independently. The checked update workflow must refresh their resolved lockfile/build metadata and rebuild the sidecar. Record exact revisions for each reproducible deployment, periodically check upstream freshness, and document/contract-test compatibility transformations against the selected source.

**NODE-03.** The first implementation milestone must verify a clean Bun installation/build, typed ESM HTTP integration, runtime asset resolution, and all four parser operations for the selected source revision. Run these checks in the intended production images and repeat them when upgrading the dependency.

**NODE-04.** Construct the minimal typed `params`/`query` data required by the parser API in a dedicated request bridge. If the dependency's `Request` declaration requires a compatibility assertion, confine it to that bridge and document the fields supplied. Validate inputs before invocation and expose only application-owned types to domain operations.

**NODE-05.** Normalize results into string IDs, canonical full names, world/DC, optional FC identity, validated counts/page metadata, and plain display text as needed. Associate a requested profile with its validated input ID and check agreement with any returned ID. Include observation time and sufficient completeness metadata for the consuming operation.

### 9.2 Normalization and execution

**NODE-06.** The adapter and installed dependency must jointly satisfy this data contract:

- Identifiers are lossless canonical decimal strings as defined in DATA-01 and DATA-02.
- Explicit zero, confirmed absence, unknown values, and invalid data are distinct results.
- Pagination identifies the current page and total pages with positive integers. Next/previous page values are either valid page numbers or explicit end-of-sequence markers.
- Search names, worlds, and other query values are encoded exactly once as query values.
- Transport outcomes retain useful categories and available status/retry metadata, including when a request receives no HTTP response.
- Display fields are normalized from the parser's output to application text with the expected Unicode/entity semantics.

Contract fixtures must cover every normalization rule used for roster completeness, profile identity, and ownership verification. Document adapter normalization for the selected dependency release and verify it during dependency upgrades.

**NODE-07.** Configure library environment inputs, including its import-time `PAGE_REGION` setting, before loading affected modules. Default to the NA/English Lodestone region. Validate allowed region values and keep language-dependent selector expectations explicit.

**NODE-08.** Bound actual network work and parsing/resource consumption. Default to two concurrent Lodestone operations, at least one second between request starts, a 15-second per-request network deadline, and at most three attempts for retryable failures. Honor a usable upstream retry-after indication and apply exponential backoff with jitter.

**NODE-09.** Configure an overall job deadline and pagination/body-size bounds. A timeout must cancel underlying network work or terminate its isolated execution worker. Keep Discord interaction processing responsive during parsing; use a bounded worker pool within the bot container if needed. Scope HTTP configuration to the Nodestone integration.

**NODE-10.** Expose operation-specific outcomes such as not found, unavailable, rate limited, invalid response, and incomplete result. Retain trusted links during profile unavailability and accepted roster/configuration state during FC acquisition failures. Accept additional upstream fields while validating every required application fact.

**NODE-11.** Select the fields needed by each operation, including its required root/entry/pagination data. Fetch FC metadata at the crawl boundaries required by SYNC-06 and member pages through `FCMembers`. Limit profile requests to identity/display fields and biography data required for verification.

## 10. Persistence, transactions, and durable effects

### Approved onboarding extension

**ACCESS-01.** Explicit `/setup` enables a persisted guild-scoped channel policy and provisions/reuses distinct lobby and officer text rooms alongside the four access roles. Require current Manage Server, Manage Roles, and Manage Channels for setup. Existing guilds remain opted out until that action; enforce the bot's channel and role capabilities before mutation. `/setup` also switches guest applications on, using the officer room as the review channel when none is set (CFG-08). A channel the bot can't view fails that check. Discord hides such channels from bots: from 2026-11-16 they are left out of the REST channel list and sent obfuscated over the gateway. A pass therefore confirms each channel the gateway knows but the list leaves out, and refuses, naming the channel and the fix, rather than leave the channel unmanaged or act on its obfuscated name or overwrites. `/setup` likewise refuses a saved room it can't view rather than create another. @deconfined decided this on [#47](https://github.com/deconfined/tarubot/issues/47#issuecomment-5847261822) on 2026-09-26: "Yes, refuse if it means the result is a broken bot. Warnings and then leaving things nonfunctional is a bad admin experience."

**ACCESS-02.** Role-less newcomers see the lobby; ordinary Members/Guests see ordinary channels and not the lobby. Officers and FC Leaders see the lobby, ordinary channels, and staff areas. Preserve existing private areas as staff-only. Apply visibility to every non-thread guild channel type and categories, with threads inheriting their parent's visibility. Discord owner/Administrator bypass remains intrinsic.

**ACCESS-03.** Own channel visibility overwrites explicitly, retain unrelated permission bits, persist first-observed ACL/parent/default-permission snapshots, and repair drift through deduplicated durable work. Bind writes to current activation/configuration/job ownership, verify the full resulting policy, retain recovery across partial failure/restart, and include channel work in refresh status.

**ACCESS-04.** Registered-user Guest (ROLE-07) is computed identically whether onboarding is enabled or disabled. In enabled guilds, the resulting Member/Guest/Officer/FC Leader roles also select lobby, ordinary, and staff visibility; disabled guilds receive no channel-visibility work. Preserve explicit Guest revocation, FC Member precedence, guild isolation, and conservative treatment of unknown/stale evidence. Derived registration must not recreate a revoked durable grant.

**ACCESS-05.** Exclude Discord's configured community-updates channel and its parent category from onboarding ownership, room selection, permission preflight, new snapshots, and mutations. Use a separate officer chat. Recheck exclusions before writes and reconcile changed community bindings. Preserve the guild visibility default if lowering it would change an excluded area's inherited visibility; use explicit managed-channel gates in that case. An excluded area missing from the bot's channel list (from 2026-11-16, any it can't view) counts as one that would change, because its real overwrites can't be read (2.30.2, #47).

### Database and durable work

**DEPLOY-DO-01.** (Not the production target since the 2026-09-24 hosting amendment; retired in 2.21.0 with the App Platform spec and tooling, and kept here as the record.) Supply an App Platform spec that uses matching published GHCR images for a single bot worker, an internal-only Nodestone service, and a pre-deploy migration job. Attach it to the owner-provisioned DigitalOcean Managed PostgreSQL cluster named in the spec (`production: true`, a dedicated non-admin database and user), through provider-bound runtime credentials and verified TLS with the cluster's CA. Never bind a connection pool. Creating the app must not start a bot writer: the first deployment omits the worker, which is introduced only at activation. A bot process holds a PostgreSQL writer lease on its direct connection before it starts work, so an overlapping deployment waits for the previous writer instead of running beside it (MIG-13). Document the provider prerequisites, the backup/PITR window and independent exports, trusted-source access for maintenance tools, and an update procedure that retains database identity and stops the previous writer before migrations or replacement startup. Validate every deployment phase's configuration without creating cloud resources in tests or CI.

**DB-01.** PostgreSQL is the runtime database. Use Drizzle ORM for typed application persistence over the node-postgres driver, with table mappings and inferred record types maintained alongside explicit versioned SQL migrations. The migrations own foreign keys, unique constraints, indexes, domains, and triggers; already-applied migrations are immutable. Bind ORM work inside an application transaction to its exact checked-out client. Retain narrowly scoped parameterized PostgreSQL control/locking SQL and catalog-based restore verification. Application startup checks the required schema version and checksum.

The physical schema may use different names, but it must represent these logical records and constraints:

| Logical records | Required scope/invariants |
| --- | --- |
| Guild configuration | Guild ID, nullable FC/role/channel IDs, role-layout and guest-application switches, configuration revision, active/disabled state |
| Discord users and guild-user state | Stable user identity; per-guild presence and nickname/primary preferences |
| FCs and characters | Shared public identity/display caches; observation/freshness metadata |
| Character links | Guild, character, owner, active/inactive state, provenance, actor/time; one active owner per guild/character |
| Verification challenges | Bound tuple, token hash, expiry, consumption/replacement state |
| Sync runs and roster snapshots | FC, requested/attempted/completed state, completeness evidence, version, counts/errors |
| Membership observations/history | Pending departures and confirmed periods; guild/user/FC historical eligibility |
| Guest applications/grants/revocations | Durable state machines and one pending application per guild/user; grants ended by `/guest reset` retained with end time, actor, and reason |
| Ledger accounts/entries | Guild/FC account uniqueness, known/unknown state, ordered immutable entries, idempotency |
| Jobs/outbound effects | Durable payload/version, deduplication key, attempts, due time, lease/status, delivery IDs/errors |
| Audit and import provenance | Actor/source, guild, target, decision, timestamps, source checksum/keys and reconciliation results |

**DB-02.** Use short transactions containing database operations for application decisions. Perform Discord and Lodestone I/O outside those transactions. Connect committed decisions to subsequent delivery through persisted work.

**DB-03.** Protect financial operations, ownership claims, application decisions, and snapshot publication with database-enforced invariants that hold under concurrent interactions and process restarts.

**DB-04.** Publish application state and the jobs/outbox records needed to project it in the same transaction. Use PostgreSQL-backed work/outbox persistence within the two-service deployment.

**DB-05.** Jobs require deduplication, bounded retry, due times, recoverable leases, and explicit succeeded/blocked/terminal-failure outcomes. Publication and effect execution require current job ownership plus the applicable state/configuration version; expired workers relinquish their results for recomputation.

**DB-06.** Reconciliation effects derive current desired state. Ledger notifications refer to an immutable committed entry. Store enough information to inspect and retry delivery independently of its committed application decision.

**DB-07.** Audit officer assignments/unassignments, configuration changes, guest decisions/grants/revocations/resets, officer grants/revocations/resets, verification provenance changes, ledger mutations, and migration actions. Record cache acquisition and update results as operational history, with aggregated officer notifications where appropriate.

**DB-08.** Removing the bot from a guild deactivates its work while retaining its history. A documented retention policy may prune expired challenges and bounded diagnostic payloads. Retain ledger entries, active links/grants, and membership evidence required by access policy.

## 11. Containers, configuration, and operations

**OPS-01.** Provide a project-root multi-target `Dockerfile` and `docker-compose.yml`. The normal long-running services are `tarubot` and `postgres`. (Until 2.21.0 a `nodestone` parser sidecar with a private HTTP endpoint ran beside them; the parser now runs in the bot.)

**OPS-02.** The bot image must use a multi-stage reproducible build, run as a non-root user, contain compiled application code and required runtime dependencies/assets, and execute Bun directly with proper signal handling. Install runtime dependencies from the committed lockfile during image construction and retain their required package assets in the final image.

**OPS-03.** PostgreSQL must use a named persistent volume mounted at the correct location for its selected image major. Its port is private to the Compose network by default. Use Compose DNS for connectivity; TaruBot requires outbound access to Discord and Lodestone.

**OPS-04.** Include `.dockerignore`, `.env.example`, and documented install/build/run commands. Build the image from the application, its declared runtime dependencies, and required assets. Keep data-import inputs, credentials, local environment files, and repository metadata outside the image. Supply tokens/database credentials through runtime configuration or mounted secrets.

**OPS-05.** Validate configuration before accepting work. Document, at minimum, Discord token/application ID, PostgreSQL connection settings, environment/log level, Lodestone region, sync/profile intervals, verification expiry, request/retry/concurrency bounds, and health-check configuration. Configuration errors identify the setting and expected format using redacted values.

**OPS-06.** Provide explicit commands for schema migration, data import, application-command registration, build, start, type checking, linting, formatting checks, unit tests, and integration tests. Run migration/registration as one-shot operations using the bot image or its documented tooling.

**OPS-07.** The bot must require the expected schema version. Serialize migration execution and report incompatible schema/configuration clearly. Support dependency-ready startup ordering and runtime reconnection/retry behavior.

**OPS-08.** Provide local process liveness and application readiness/capability status. Readiness reflects initialization, database/schema availability, the database writer lease (MIG-13), and Discord connectivity. Report Lodestone outages as degraded synchronization while allowing available local/ledger capabilities to operate. Health probes use local/dependency connection state independently of scheduled Lodestone acquisition.

**OPS-09.** On termination, stop accepting new work, stop scheduling, settle or safely abandon short transactions, release/recover leases, and close Discord/database resources within the documented container stop period. Restart resumes committed work using its idempotency keys and durable decision state.

**OPS-10.** Use structured logs with operation/run IDs, guild/FC context where appropriate, durations, result categories, retry information, and actionable permission/configuration errors. Track successful refresh age, failures, queue depth/age, reconciliation outcomes, and blocked notification work. Apply redaction to credentials, proof tokens, and profile bodies.

**OPS-11.** Use the officer notification channel for operational summaries, material membership changes, repeated synchronization/delivery failures, and recovery notices. Aggregate and rate-limit messages per guild/run, including during large roster changes and prolonged outages. (Refined on 2026-09-25 for the roster notices: see "Approved officer-notice amendments". The roster line is DevBot-only, and the Lodestone degraded notice is held, rate-limited and followed by a recovery line. Refined again on 2026-09-25 for material membership changes: see "Approved status-notice amendments". One post about 2 minutes after the first change lists gained or lost Member, Guest, Officer and FC Leader, with reasons, and confirmed FC departures. Repeated delivery-failure summaries stay open.)

**OPS-12.** Document Discord setup using the `Guilds` and privileged `GuildMembers` intents, application command installation, and explicit channel/role permissions. Require `ManageRoles`, `ManageNicknames` for enabled nickname management, and the channel viewing/sending/embedding/history permissions needed by configured destinations. Use this explicit permission set with bot `Administrator` permission disabled.

**OPS-13.** Provide PostgreSQL backup/restore instructions and a tested operational recovery procedure. State which commands need a maintenance window and how to observe blocked jobs, stale snapshots, and failed Discord effects.

**OPS-14.** Production and rehearsal maintenance tools run from a build of the deployed release, with an explicitly supplied environment file and never the development `.env`. Before any Discord or database I/O, each tool verifies that its application ID, test-guild scope, target guilds, and database endpoints all belong to exactly one deployment profile (production, production rehearsal, or DevBot). It refuses mixed identities without printing credentials, and a rehearsal never writes to Discord. (2026-09-26: an automated deploy runs `migrate.js`, `register.js --global` and `commands.js list` inside the deployed container on the production host, whose Compose file fixes the production profile and whose image carries no `.env`. Since 2.32.0 there is a fourth managed profile, `staging`: DevBot's application on the staging host against its own `tarubot_staging` database and role, selected only by `TARUBOT_ENVIRONMENT=staging`. Production's tools accept only the `tarubot` and `tarubot_restore` databases, and refuse every `tarubot_staging` name. See "Approved staging amendments (2026-09-26)".) A read-only production inspection reports the production application's intents, guilds, guild permissions (with and without Administrator), managed-role hierarchy, and destination-channel access.

## 12. Data import and activation

### 12.1 Import inputs

The importer accepts a MySQL-compatible SQL dump, such as the supplied `tarubot_backup.sql`, with this input schema. The supplied fixture uses MariaDB 11.8.6 dump syntax.

| Input table | Fields and relationships |
| --- | --- |
| `freecompany` | `fc_id`: string primary key; `name`, `tag`, `world`: strings; `gil_balance`: nullable integer; `last_updated`: nullable timezone-naïve datetime |
| `gamecharacter` | `char_id`: string primary key; `owner`: nullable reference to `member.discord_id`; `fc`: nullable reference to `freecompany.fc_id`; `forename`, `surname`, `world`: strings |
| `member` | `discord_id`: string primary key |
| `guild` | `guild_id`: string primary key; `fc`: nullable reference to `freecompany.fc_id`; `member_role_id`, `guest_role_id`, `ledger_channel_id`, `officer_notifications_channel_id`, `guest_application_channel_id`: string IDs, with empty values representing unconfigured fields |

The supplied acceptance fixture has these expected values:

| Input fact | Expected count or value |
| --- | --- |
| `freecompany` | 40 rows |
| `gamecharacter` | 4,251 rows |
| `member` | 241 rows |
| `guild` | 1 row |
| Non-null `gamecharacter.owner` links | 161 |
| Null FC gil balances | 4 |
| Configured FC's recorded balance | 349,279,945 gil |

The SQL input provides identity records, ownership links, guild configuration, cached FC associations, and balance snapshots. A separate complete Discord snapshot provides current guild presence, configured-role holders, and current nicknames. Fresh Nodestone acquisition provides current game membership. Initialize application-specific state from these inputs according to the following policies.

### 12.2 Import contract

**MIG-01.** Provide a documented one-shot import operation accepting an input file path. Decode the SQL dump through a tested MySQL/MariaDB dump reader or isolated staging database, supporting escaped quoted values, Unicode, nulls, directives, and schema/data ordering. Map validated input records into the PostgreSQL model defined in Section 10. Temporary import infrastructure is scoped to this one-shot operation.

**MIG-02.** Provide a read-only dry run reporting input counts, relationships, mappings, invalid values, normalization, opening balances, and proposed access bootstrap actions. Validate in staging and publish through transactions so live state consists of a complete accepted import or its pre-import state.

**MIG-03.** Import every valid identity and ownership record, including unclaimed characters and users absent from Discord. For the supplied fixture, this includes 40 FCs, 4,251 characters, 241 users, and 161 ownership links. Normalize empty optional role/channel IDs to null. Validate all foreign-key relationships and report conflicts explicitly. Import the legacy guest-application review channel with the guest-application switch off (CFG-08). Imported guilds start with guest applications closed, the role-layout switch off (CFG-07), and grandfathering pending (MIG-14).

**MIG-04.** The input schema associates ownership with users and balances with FCs. For the supplied single-guild fixture, map its 161 ownership links and all 40 FC ledger states to the sole configured guild. Create 40 guild/FC ledger accounts: 36 known opening balances, including explicit zeros, and four uninitialized accounts. Enable mutations for the currently linked account.

Record the mapping in the import report. For a multi-guild input, require an explicit ownership/account mapping that assigns each source balance once and identifies the destination guilds for each ownership record.

**MIG-05.** Mark supplied ownership links as trusted `imported_link` provenance. Record the input keys/checksum and import time. Self-service claims created through the application use profile-token verification provenance.

**MIG-06.** Retain input FC/character relationships as historical cache facts. Create imported historical membership for a `(guild, user, FC)` when the mapped user owns a supplied character whose `fc` matches that guild's linked FC. Record the supporting ownership, character, and guild input keys as evidence.

**MIG-07.** Retain input timestamps as provenance and initialize successful live-synchronization state as pending. Require an explicit source timezone for the input's timezone-naïve datetime values, retain their raw values, and report UTC conversion. Obtain a fresh complete roster before enforcing membership-derived changes.

For imported member-role holders with matching imported FC-membership evidence, apply the two-observation departure confirmation before the first roster-driven demotion. Existing access remains in place during validation; new member grants require fresh roster evidence.

**MIG-08.** Convert each known balance into one immutable import opening entry with input provenance. For the supplied fixture, verify the configured FC's opening balance is exactly 349,279,945. Null balances create uninitialized accounts. Account transaction history starts with its opening entry and subsequent application-recorded entries.

**MIG-09.** Capture a complete live Discord snapshot of human holders of the configured guest role at cutover. Create explicit `imported_guest` grants with guild/user/role IDs, capture time, and snapshot provenance. Require successful complete capture before publishing the grandfathered guest population. Grandfathering of the other humans present at first activation follows MIG-14.

Snapshot users absent from the SQL dump create additional user/guild-user records. Report these additions separately from SQL input counts. Character ownership comes from imported links or subsequent verified/manual assignments; the Discord snapshot supplies presence and role state.

**MIG-10.** Initialize imported users with an unset primary character and nickname management disabled, retaining current Discord nicknames. Application review history for a newly imported guild begins with requests submitted through `/apply` after an officer opens applications. Give users instructions for primary selection, nickname opt-in, and how visitors obtain Guest while applications are closed (verify a character, or ask an officer for `/guest grant`).

**MIG-11.** Make import execution idempotent using input fingerprints and stable source-record identities. Re-running the same import resolves to the same links, opening entries, history, and guest grants while retaining subsequent application decisions. Report conflicting input changes for an explicit mapping/import decision.

### 12.3 Activation and recovery

**MIG-12.** Document and verify this sequence:

1. Rehearse schema creation and import against a disposable PostgreSQL instance using the supplied fixture.
2. Stop the legacy process and prevent its restart, reset the production token, freeze managed-role edits, and retain a final consistent input snapshot and checksums.
3. Capture a complete Discord snapshot for imported grants, validation, and the reconciliation preview.
4. Confirm that no bot writer holds the database, run versioned PostgreSQL migrations and the validated import, and retain the import report. Verify that effects, onboarding, the role-layout switch, and guest applications start off and that grandfathering is pending.
5. Validate current channels, roles, bot permissions/hierarchy, gateway intents, existing command registrations, and configured FC identity using the read-only production inspection.
6. Obtain two complete FC snapshots at least 60 seconds apart, so that imported members absent from the live roster are confirmed as departed, then produce a read-only preview. It covers role/nickname actions, registered-user Guest additions, pending departures, the first-activation grandfathering plan (counts, sample IDs, checksum), and the role-layout switch. Resolve reported input/configuration issues before enabling effects. Activation must follow the last acquisition within the roster freshness interval; any later acquisition requires a new preview and checksum.
7. Record a provider point-in-time-recovery marker and take an independent logical backup.
8. Activate with the reviewed grandfathering checksum; activation writes only to PostgreSQL. Then register exactly the declared command set, clear leftover guild-scoped commands, and read every scope back. Start exactly one application writer, verify representative claim/access/ledger operations, configure officer authority, review humans who joined after activation's enumeration, and monitor queued or blocked work.

The numeric values in Section 12.1 define the supplied acceptance fixture. For another input snapshot, derive IDs, counts, and balances from that input and reconcile its import report accordingly.

**MIG-13.** Maintain one authorized application writer during activation and recovery. Retain input snapshots and PostgreSQL backups. Document recovery before activation and after live transactions have been accepted. Post-activation recovery must retain acknowledged ledger entries, links, and decisions through compatible database restoration or reconciliation/replay of exported changes, then resume pending durable work. Reset the legacy application token after the legacy process stops and before any v2 gateway connection in the window. On App Platform, the worker component is added only after activation. A PostgreSQL writer lease enforces the single writer: each bot process holds a session advisory lock on a direct connection for its lifetime, and a second process waits, unready, until it is released. Before migration, import, activation, or restoration, the operator confirms that no process holds it. (In an automated deploy, approved in GitHub, `migrate.js`'s own lease wait stands in for that check; see "Approved SSH-deploy amendments (2026-09-26)".) A database restore does not revert Discord role changes a writer already applied; recovery after effects began compares current roles with the cutover snapshot and resolves differences explicitly.

**MIG-14.** At an imported guild's first activation, completely enumerate current Discord membership. In the transaction that enables effects, create a `grandfathered` guest grant for each human who is not Member-eligible under ROLE-01/ROLE-07, according to the fresh accepted roster required for activation (a roster accepted after the import, with no linked FC character awaiting departure confirmation).
- Exclude bots, revoked users, and users with an existing grant (evaluation basis `existing_grant`): an active approved, manual, or imported grant, or any grant that `/guest reset` ended, which still counts although it confers nothing. Never clear a revocation.
- Record guild/user IDs, enumeration time, accepted roster time, evaluation basis, and the plan checksum. The checksum covers the guild, the import fingerprint, the latest accepted roster snapshot, and the planned user IDs; it excludes timestamps, roles, and nicknames.
- The read-only preview reports the plan (counts, sample IDs, checksum) and can write it to a file. Activation writes only a plan whose checksum the operator confirmed; otherwise it rolls back unchanged and reports the users added and removed relative to the reviewed plan file.
- Persist a guild-level completion marker so the run happens exactly once. Guilds not created by the import are never grandfathered.
- Audit each grant and the run, retaining the enumeration time.
- Once the writer is live, a read-only report lists present humans who joined after that enumeration and hold neither a guest grant nor an active trusted link; officers decide an explicit grant for each.
Grandfathered grants behave exactly like approved grants (ROLE-02, GUEST-08, GUEST-09).

## 13. Verification and acceptance criteria

Verification must cover observable behavior, policy invariants, concurrency, and recovery. Use deterministic clocks/IDs where needed, real PostgreSQL for persistence integration tests, and controlled Discord/Lodestone fixtures for normal CI.

| ID | Acceptance scenario |
| --- | --- |
| AC-01 | First-party production code, tests, and scripts type-check/build as ESM with the required strict flags. After a clean package-manager installation, the compiled bot imports the published Nodestone package, resolves its required runtime assets, and invokes its parser API within the production image. |
| AC-02 | The FC ID `9232097761132958152` round-trips exactly through input, dependency adaptation, PostgreSQL, jobs, logs, and responses. Unsafe numeric IDs produce typed invalid-data outcomes. Large ledger values retain exact arithmetic and serialization. |
| AC-03 | Character search distinguishes exact match, ambiguity, no results, incomplete pagination, and upstream failure. Names with spaces, apostrophes, hyphens, and supported Unicode are correctly encoded and displayed. |
| AC-04 | A self-claim progresses from pending challenge to trusted link only with valid bound proof. Mismatched, expired, replaced, and consumed challenges return the specified failure state. Pending verification survives restart. |
| AC-05 | Competing claims/assignments resolve to at most one active owner per guild/character. Repeated same-owner operations are idempotent, and every private read/mutation enforces target-guild authorization. |
| AC-06 | Unclaim/unassign resolves stored identity during a Lodestone outage and after a rename/transfer, verifies the target owner, commits the local link change, and queues reconciliation. |
| AC-07 | One complete accepted roster establishes positive membership. Any remaining qualifying character retains member eligibility. Two properly separated complete absence observations confirm departure; invalid/incomplete acquisition retains the prior accepted state. |
| AC-08 | Confirmed former members and registered users with no FC character become guests in every configured guild, with onboarding enabled or disabled. Later unregistered newcomers gain access through an officer grant (or approval while applications are open). Guest revocation survives refresh/restart/rejoin until an explicit grant or `/guest reset`, and current FC-member eligibility takes precedence over guest state. |
| AC-09 | A failed/stale refresh retains existing FC-derived access and the successful-snapshot timestamp while reporting degraded state. A validated empty roster follows the same departure confirmation rules as other complete observations. |
| AC-10 | A run records complete Discord member enumeration, scopes work to humans, and reports individual skipped/blocked outcomes while continuing eligible work. Repeated reconciliation applies only necessary managed-role/nickname deltas. |
| AC-11 | Configuration unlink verifies the linked FC ID and works offline. Role replacement/unsetting cleans up retired managed roles while preserving unrelated roles. Effects use the current applicable configuration/version. |
| AC-12 | Guest review buttons work after restart and authorize each actor/guild. Simultaneous approve/deny actions resolve to one committed outcome. Concurrent/duplicate applications resolve to one pending record. |
| AC-13 | Applicant departure, promotion to FC membership, deleted review messages, failed role writes, and blocked DMs preserve a correct durable application/grant state with visible delivery outcomes. |
| AC-14 | Primary selection and nickname preferences are deterministic. Manual nicknames and guild-owner/hierarchy limitations are respected. Ownership remains committed if nickname application fails. |
| AC-15 | Simultaneous ledger mutations retain account order, exact nonnegative balances, and one entry per idempotency key. Unknown balances transition through a single concurrency-safe initialization. |
| AC-16 | Notification failure after ledger commit retains one durable entry and retryable delivery. Ambiguous acknowledgements and any duplicate messages remain associated with that same entry. Corrections append signed history. |
| AC-17 | Ledger operations authorize the owning guild/account. Unlink/relink resolves the same guild/FC account; linking a different FC resolves its distinct account and balance. |
| AC-18 | Import verifies the fixture counts, 161 trusted imported links, 36 known opening accounts, four unknown accounts, exact configured-FC balance, Unicode/IDs/nulls, explicit timestamp handling, and separately reported Discord-snapshot additions. |
| AC-19 | Re-running an import is idempotent and retains subsequent application decisions. Import publication is complete or rolled back. Guest-role holders receive explicit imported grants, and primary-character preferences use the specified initialization defaults. |
| AC-20 | Crashes after commit, during roster acquisition, during approval, and during notification delivery resume persisted work with the same committed application decisions, entry identities, and confirmed membership evidence. |
| AC-21 | Lodestone operations obey concurrency/rate/deadline bounds, terminate timed-out underlying work, and keep Discord interaction acknowledgement responsive. Library fixtures cover missing selectors, explicit zero, malformed numbers, 404, maintenance, rate limits, and network exceptions. |
| AC-22 | Docker images build reproducibly, Compose validates, PostgreSQL data survives container recreation, and the bot recovers from database/Discord reconnects. Health probes operate independently of Lodestone acquisition. Graceful shutdown and backup restoration are exercised. A second bot process against the same database waits for the writer lease, stays unready, and takes over only after the first releases it or loses its session. |
| AC-23 | The deployed command inventory matches Section 4, and the bot operates with the intents and explicit permissions specified in OPS-12 (21 root commands / 46 paths since 2.28.0, including `/config role_layout`, `/officer reset`, `/guest reset`, `/issue`, `/config changelog`, and `/suggest`). |
| AC-24 | A user with several trusted links becomes Member when any is a confirmed FC member, receives Officer when any holds the configured rank (except through a bot-only officer's assignment), and is Guest when none is in the FC, with onboarding enabled or disabled. Unknown/stale evidence creates no new role, removing the last link removes derived Guest, and onboarding-disabled guilds receive no channel-visibility work. |
| AC-25 | First activation of an imported guild grandfathers exactly the previewed set of current non-member humans, once; reruns and later activations add nothing. Bots, Member-eligible users, existing grant holders (including users whose grant `/guest reset` ended), and revoked users are excluded. A mismatched plan checksum, a stale roster, or a linked FC character awaiting departure confirmation rolls activation back unchanged. Grandfathered grants survive refresh/restart/rejoin, yield to Member precedence and explicit revocation, and can be restored by an explicit grant. |
| AC-26 | With the role-layout switch off, startup, activation, setup, role configuration, role events, refresh, and requeued work make no hoist/position writes, and layout work completes as skipped. Enabling it (manager-only, audited, revision-fenced) queues one pass that converges; disabling during a pass supersedes it before any further write. |
| AC-27 | An imported guild activates with guest applications closed (legacy review channel kept with the guest-application switch off), onboarding off, and the role-layout switch off, and `/apply` refuses with a visitor-facing explanation before its form opens. Production tools refuse mixed application/guild/database identities and development `.env` leakage, and after registration no guild-scoped commands remain for the production application. |
| AC-28 | The guest-application switch is independent of the review channel (CFG-08). `/apply` is open only with the switch on and both a review channel and a Guest role set. Switching off keeps the channel and leaves pending applications reviewable, and a request matching the saved state changes nothing. Switching on validates the review channel that will take applications, including a stored legacy channel, while switching off or unsetting the channel validates nothing. `/setup` switches applications on, an import keeps the legacy channel with the switch off, migration 006 switches on only guilds that already had a review channel and were not awaiting first activation, and activation changes the switch only on an explicit choice. |
| AC-29 | `/officer reset` removes an officer grant or revocation, so the configured rank decides again, including for a user who has left; like grant and revoke, it refuses a manager other than the guild owner whose highest role is not above a bound Officer role. `/guest reset` lifts a revocation and ends every active grant of any provenance; ended grants stay as history, confer nothing, are left out of `/guest status`, and still exclude the user from first-activation grandfathering. Both are audited and reconcile the member, and with nothing to remove they change nothing and audit nothing. |
| AC-30 | `/main` naming the current main and `/nickname` repeating the current setting save nothing, queue no reconciliation, and reply that nothing changed. `/config officer_rank` naming the saved rank, or unsetting when none is set, replies that nothing changed without a revision bump, audit, or repair pass. Every option of every registered command path has an input-failure example. `/ledger adjust entry` accepts `5`, `#5`, or the entry ID within the current account. Member options suggest server members and still accept pasted IDs and mentions. After a non-imported user removes every link, their next link becomes the main without changing nickname sync. Reconciliation never writes, restores, or blocks on the guild owner's nickname. |

Before production activation, perform a smoke test of command registration, proof/assignment, member/guest transitions (including multi-character union and officer guest grant/revoke), nickname handling, and ledger delivery in a dedicated configured test guild. Automated checks use dedicated test credentials and guild identifiers.

## 14. Implementation deliverables and completion gates

**DEL-01.** Deliver first-party TypeScript source, ESM package/build configuration, a committed lockfile, versioned SQL migrations, the tested data importer, the Nodestone adapter, Discord command registration, background processing, automated tests/fixtures, and the container/operational artifacts described above.

**DEL-02.** Provide a README/runbook covering fresh installation, package-manager dependency installation, environment setup, Discord permissions, development/test-guild operation, migration/cutover, backup/restore, dependency upgrades, and diagnosis/recovery of blocked work.

**DEL-03.** Recommended implementation sequence:

1. Verify installation, ESM import, runtime assets, and the data contract of the selected published Nodestone package.
2. Establish strict project boundaries, PostgreSQL migrations, domain invariants, and configuration validation.
3. Implement verification, character/configuration commands, durable jobs, roster acquisition, and role/nickname reconciliation.
4. Implement durable guest workflows and the transactional ledger.
5. Implement/rehearse migration and grandfathering, then complete container/operational recovery checks.
6. Satisfy the acceptance matrix and review the cutover preview before production effects are enabled.

**DEL-04.** Completion requires passing type checking, lint/format checks, meaningful unit/integration/contract tests, container build/configuration checks, and the documented test-guild/activation verification. A clean build must install dependencies and their required runtime assets from the committed package manifest and lockfile, then compile the first-party source.
