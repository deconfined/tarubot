# Reply house style

From 2.14.0, every command, button, form and pre-form reply is **one embed** built by a pure presenter in `src/discord/presenters/`, instead of a JSON dump. Ledger channel posts, guest review messages and decision DMs use the same builders. This document is the house style those presenters implement: the owner-approved reply mockups of 2026-09-23, with the amendments recorded at the end. `tests/unit/reply-consistency.test.ts` pins the rules below, and the reply catalog in `tests/fixtures/replies/` renders one case per reply state.

2.15.0 applies the decisions the owner made during the 2.14.0 reply session on DevBot (2026-09-24). A reply never implies a change that didn't happen, and FC tags render once. Every option has an Example, and member options autocomplete. Guest applications have their own switch, `/config` options unset instead of clear, and `/officer reset` and `/guest reset` return a member to the automatic rules. The sections below describe the shipped behavior, and the [deviations table](#deviations-from-approved) records where it now differs from an approved card.

The approved mockups are authoritative. Where this document and an approved card disagree, the card wins unless the [deviations table](#deviations-from-approved) records otherwise.

## Where replies are built

| Module | Responsibility |
| --- | --- |
| `presenters/style.ts` | Tones and colors, status markers, health-check tokens, separators, Discord and house limits |
| `presenters/format.ts` | Escaping, grapheme-safe cutting, gil and counts, Discord timestamps, mentions, links, Lodestone names, FC tags (`fcTagText`), lists |
| `presenters/reply.ts` | `reply()`, `post()` and `dataReply()`, the only builders of a `Presented` message |
| `presenters/audience.ts` | `audienceOf()` and the `Viewer` the router derives once per interaction |
| `presenters/jobs.ts` | The job line, the effects field, the paused-save parts and the roster-evidence field |
| `presenters/labels.ts` | Link and grant provenance, application states |
| `presenters/controls.ts` | Every approved button, built through the custom-ID codec in `src/discord/custom-ids.ts` |
| `presenters/failure.ts` | The one failure presenter |
| `presenters/<group>.ts` | `characters`, `ledger`, `configuration`, `guests`, `synchronization`, `utility`, `version`, `changelog` (the update post, 2.25.0), `officer` (the status post, 2.29.0) |

Commands parse options, call one service method and return that method's presenter reply. They never format text, catch failures, set `flags` or set `allowedMentions`. `Command.execute` and `Component.execute` are typed to return only a `Presented` (and `beforeModal` a `Presented` or `null`), and the router refuses anything else at runtime as an unexpected failure, so no JSON dump or raw option object can reach Discord. Presenters import application results as types only and never touch persistence (`reply-guard.test.ts`).

## Anatomy

- **Title**: sentence case, outcome first, 60 characters or fewer, no trailing period and no IDs. Successes lead with the verb ("Deposit recorded"); refusals lead with the reason ("Officers only"). Sections are joined with ` · ` ("Ledger history · Example Free Company"), never ": ". The only user text allowed in a title is an escaped character or FC name.
- **Description**: what happened, then what happens next, in at most two sentences (1,000 characters). Refusals add the concept's no-change sentence ([below](#the-no-change-sentence)).
- **Fields**: noun labels, short facts inline (at most three per row), at most 10 fields, each value within 1,024 characters. The last field names the next step with the exact command. Long lists end with "…and N more".
- **Footer**: plain text only (Discord renders no markdown, mentions or timestamps there). Failures always end with `Code <code> · Ref <interaction ID>`.
- **Timestamp**: each reply kind records whether its embed carries one, copied from the approved card's `timestamp` value (the `*_REPLY_KINDS` and `*_POST_KINDS` tables in each group presenter). Replies stamp an injected "now"; posts and DMs stamp the stored event's own time (the ledger entry, the application's submission, the decision), so a retried or redrawn post is identical. Failure cards carry none.
- **Buttons**: only the approved ones, in the approved order ([below](#buttons-and-full-details-json)).

Nothing essential appears only in the footer, the timestamp or the color.

### Limits and exemptions

`HOUSE_LIMITS` in `style.ts` holds the house limits (title 60, description 1,000, 10 fields, 300 characters of user text in a field, 100 for a character name, 150 for an officer diagnostic, 10 job lines). Presenters budget within them; tests check them with `expectHouseStyle`. `reply.ts` separately enforces Discord's hard limits deterministically (256/4,096/25 fields/1,024/2,048/6,000 in total), so an oversized value is cut instead of failing with a 400 after the service has committed. Maximal fixtures assert that no reply is ever cut.

Two documented exemptions:

- **`/config show`** keeps the approved one-field-per-setting layout: 13 fields for a configured guild since the changelog channel (2.25.0), 14 once the guild has a grandfathering marker ("Pending · runs once at activation" before activation, "Completed <t:…:R>" after it, per the reply spec; approved configuration#4 draws a guild with no marker). It is tested against its own maximum of 15 fields (critique fix C3), which its widest layout now reaches exactly, so another field would need a new exemption. Unset roles or channels collapse into one field.
- **Channel posts** may exceed the 1,000-character description, because a ledger post shows the entry's full escaped note (C10). Discord's 4,096-character limit still applies.

## Tones

Color only reinforces the title and markers, which carry the meaning in words. The swatches are discord.js `Colors`, with the approved wording:

| Tone | Color | Approved meaning |
| --- | --- | --- |
| success | Green `#57F287` | Saved and confirmed, or nothing left to do |
| pending | Yellow `#FEE75C` | Saved with Discord work queued, or try again later |
| info | Blurple `#5865F2` | Read-only results and harmless refusals |
| warning | Orange `#E67E22` | The user or an officer can fix it |
| error | Red `#ED4245` | Refused for permissions, or failed unexpectedly |
| neutral | Greyple `#99AAB5` | Utilities and reference lists |

### Tone table (C4)

These rules settle the cases where the approved cards and the swatches could be read two ways. `reply-consistency.test.ts` checks each row.

| State | Tone |
| --- | --- |
| A committed change with nothing left to fix, removals included (unlink, revoke, every unset, guest applications closed, layout off, deny, `/unclaim`, `/unassign`, `/officer reset`, `/guest reset`) | success |
| A change saved with a caveat the user or an officer must fix: `/nickname enabled:true` by the server owner when it turns sync on (the sync can't take effect), no FC linked (leader role, ledger channel, officer rank), no officer rank (officer role, `adopt_holders:false`), no Officer role (officer rank), no Guest role (guest applications on, guest grant), no review channel (guest applications on) | warning |
| A change saved while Discord changes are paused | pending, titled "Saved, Discord changes paused" (errors-and-style#26), unless something is also blocked or failed |
| Any other view showing `‖ PAUSED` | pending, unless something is also blocked or failed |
| Officer `/sync status` overview | pending while runs are active or anything is queued, even with a failed job (guests#44); warning only when the view is focused on blocked or failed work (#45) |
| A no-op result ("already set", "already unset", "= NO CHANGE"; see [No-op replies](#no-op-replies)) | info, except the approved neutral cards "No correction needed" and "Nickname sync already off" |
| A time-bound refusal (cooldowns, rate limits, busy, shutdown, the Check again throttle) or a token not yet visible | pending; the time-bound ones add a Try again field (a relative time when known, otherwise "shortly") |
| A harmless refusal: a feature not set up yet (members), closed applications, no application needed | info |
| A refusal the user or an officer can fix: input, not found, ambiguous, out of date, ledger state, FC membership, officer setup, blocked, upstream | warning |
| A permission refusal, an ownership conflict or an unexpected error | error |

## Status markers

Status markers describe saved, queued and delivered work. They are plain Unicode glyphs in inline code, always followed by a word, so Discord never turns them into emoji and color is never the only signal.

| Marker | Meaning | Stored job state |
| --- | --- | --- |
| `✓ DONE` | Discord confirmed it | `succeeded` |
| `• SAVED` | Committed to the database | (the transaction, not a job) |
| `… QUEUED` | Waiting for the worker | `queued` with no `last_error` |
| `… IN PROGRESS` | A worker is running it | `running` |
| `↻ WAITING` | A retry is scheduled | `queued` with a waiting code (`ordered`, `busy`, `cooldown`, `superseded`, `lease_lost`, and since 2.17.0 `rate_limited`: "next"), or any other code ("retrying") |
| `! BLOCKED` | An officer must fix a permission or setting | `blocked` |
| `‖ PAUSED` | Discord changes are off until activation, or for the deployment | `disabled` |
| `✗ FAILED` | Stopped and will not retry | `failed` (`dm_blocked` adds "the decision still stands") |
| `= NO CHANGE` | It was already that way | (a no-op result) |
| `– SKIPPED` | There was nothing to do | `succeeded` with a `skipped` result |

Completion words (applied, posted, sent, secured) belong only to `✓ DONE`, and only a view that reads stored jobs back (`/sync status`, `/guest status`, `/ledger balance` and `history`) can show it. The one exception is a result an outside service confirmed within the same request, with no job behind it: `/suggest`'s "Suggestion posted" (2.28.0) appears only after GitHub returned the new issue's number.

`/config validate` uses a separate health-check vocabulary, never mixed with the markers: `[OK]`, `[WARN]`, `[FAIL]`, `[OFF]` and `[WAIT]` (configuration#7–#9). Awaiting activation is `[WAIT]` where configuration#9 shows it, and `[WARN]` marks the warnings configuration#8 shows, including `ENABLE_EFFECTS=false` and a review channel without a Guest role. From 2.15.0, `[WARN]` also marks guest applications switched on with no review channel ([below](#guest-applications-in-config-show-and-validate)). The one other place these tokens appear is `/setup`'s approved Channel access line (configuration#37).

From 2.35.0 (#46) `/config validate` has two more sections, **TaruBot's role** and **Visibility**, after Onboarding and before Discord changes, so a validate card has at most 9 fields. Both judge TaruBot's access as if Administrator were off (`src/domain/visibility.ts`; a shared role that grants Administrator, such as an Officer role people also hold, is dropped whole in that view) and use the same tokens. Every row is pinned in `tests/unit/replies-configuration.test.ts`:
- **TaruBot's role.** `[OK] Administrator: off`; `[WARN] Administrator: on (from <roles>); still needed until the items below are fixed`; or `[WARN] Administrator: no longer needed; <removal>`, where `administratorRemoval()` joins "turn it off in <TaruBot's role or @everyone>" and "remove <shared roles> from TaruBot" with ", and " (`/setup overrides` reuses it). The core seven are grouped by answer: `[OK]` from TaruBot's own role, `[WARN]` "only from <roles>, so a change to that role removes it", `[FAIL]` "missing", or `[WARN]` "missing without Administrator; grant it before removing Administrator" while it's held. Onboarding servers only: `[OK] Onboarding permissions`, or all five onboarding permissions' `[FAIL]`/`[WARN]` "missing <labels>"; servers without onboarding get no row naming Manage Channels or any onboarding permission. `[OK]` or `[FAIL] Role order: move TaruBot's highest role above <roles>` for roles it sits below whatever it holds; roles it stays above only through a shared Administrator role (`roleOrder.throughShared`, which keeps Administrator needed) get `[WARN] Role order: TaruBot is above <roles> only through <shared>; move <its own highest role> above them before removing that role from TaruBot` ("give TaruBot a role above" when it has none left). `[WARN] Never needed: <labels> (from <roles>)` never counts @everyone, whose default grants Mention Everyone to every member, or `[OK] No permissions it never needs`.
- **Visibility, without onboarding.** `[OK] TaruBot can see every channel`, plus ", except K hidden on purpose: <#…>" (with " (J inside a category hidden from TaruBot)" after the count when some are hidden only through their category's deny, `hiddenByCategory`). Otherwise, in this order and each only when non-empty: `[WARN] Missing TaruBot overrides: <counts>: <#…>` with the held remedy ("; /setup overrides confirm:true adds them while TaruBot holds Administrator", then " (the run re-reads the U TaruBot can't read yet)") or the not-held one ("; turn Administrator on for TaruBot, then run /setup overrides confirm:true", then "; TaruBot can't read U of them until then"); `[WARN] Posting channels without all four posting permissions: <#…> (<labels>)` with the same remedy; `[WARN] Configured channels where TaruBot's own entry denies Read Message History: <#…>; /setup overrides lifts that deny while TaruBot holds Administrator`; "Configured but denied to TaruBot on purpose" (`[WARN]` "…before removing Administrator" while it's held, `[FAIL]` without); `[WARN] Private categories holding a configured channel: <#C> (holds <#L>)…; /setup overrides leaves them alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself` (a warning either way, @deconfined's rule); and `[OFF] Hidden on purpose: <#…>`, with the same " (J inside a category hidden from TaruBot)" clause after the list.
- **Visibility, with onboarding.** `[OK] Onboarding manages TaruBot's channel access`; "Onboarding hasn't reached N channels yet: <#…>" (channels TaruBot can't use yet, and channels whose TaruBot entry still denies Manage Permissions or Manage Channels, or Connect in voice and stage, which refuse the pass without Administrator until its first run with it lifts them; `[WARN]` "keep Administrator on until /sync status shows its channel pass finished", `[FAIL]` "/sync status shows why its channel pass is waiting"); and "Onboarding doesn't manage <#…>" for a configured community-updates channel TaruBot can't post in (`[WARN]` held, `[FAIL]` not).

A row shows at most 3 role or 6 channel mentions (then 2/4, then 1/2, then counts only, until each field fits in 1,024 characters), then "and K more", and @everyone is plain text, never a role mention. When TaruBot's channel view can't be read yet, Visibility is a single `[WARN] Couldn't read TaruBot's channel view; try again in a minute`; an unexpected error there is reported through the caller's reporter and gives the same row, so it never takes `/config show` down. These rows aren't resource checks: `/config show`'s health line only appends "Role and visibility: K to review in /config validate." when K warnings or failures are in the two sections, and no new reply kind or field was added to `/config show`.

### Job lines

The approved job line (errors-and-style#28) is shared by `/guest status`, `/sync status` and `/ledger balance`:

- **Members** see the marker, a label and plain words: `` `↻ WAITING` Ledger post (retrying in 7 minutes) ``. They never see job IDs, attempts or diagnostics. The labels are in `JOB_KIND` (`jobs.ts`): Role update, Server-wide role check, FC roster check, Departure confirmation, Character profile refresh, Channel access, Role layout, Update post, Ledger post, Guest review message, Decision DM, Officer notice, Status notice.
- **Officers** see the marker, the raw job kind and the 8-character job ID, then the attempt and the next time, with the stored diagnostic quoted underneath and cut to 150 characters: `` `↻ WAITING` reconcile.user `1a2b3c4d` · attempt 3 · next in 7 minutes ``.
- At most 10 lines are shown, then "…and N more". Long officer lists split across fields named "Needs attention (1/2)", each sized to the 1,024-character budget (C7).

## Content rules

### Gil, numbers and times

- Gil is exact, digit-grouped and carries its unit: **10,005,000 gil**, never 10M. `gilText` and `signedGilText` format the `bigint` directly, never through `Number()`.
- Changes are signed with `+` or U+2212 `−`: **+10,005,000 gil**, **−2,500,000 gil**. An opening balance is unsigned. Counts are grouped too ("1,204 members").
- Times are Discord timestamps only: `<t:…:R>` for deadlines and freshness, `<t:…:f>` for record times, `<t:…:D>` for dates. A deadline shows both relative and absolute times. ISO strings never appear.

### Names, IDs and mentions

- User text is escaped for where it renders and cut on grapheme boundaries: 100 characters for character names, 300 for notes and reasons in fields. Titles and footers use their own plain-text escaping.
- A character reads "Example Character @ Diabolos". Ledger titles use the plain FC name (`fcTitleName`, C10); the tagged name (`fcName`) appears only where an approved card shows it, such as the receipt footers of ledger#0 and #2.
- An FC tag renders once: "Example Company «EXMPL»", never "««EXMPL»»". The Lodestone delivers a tag with its guillemets (`«Souls»`), and the stored row keeps them. `fcTagText` removes one surrounding pair before a presenter adds its own, so a stored tag and a bare one render the same. This applies to `/config show`, `/config validate`, `/config fc link|unlink` and the ledger receipt footers. On DevBot, 2.14.0 rendered "Woven Souls ««Souls»»" in `/config show`, `/config validate` and the ledger receipt footers.
- `<@id>`, `<#id>` and `<@&id>` render names and never ping inside embeds. Every message is sent with `allowedMentions: { parse: [] }`, which the router forces last. Officers also see a member's raw ID in code, because a departed user renders as unknown.
- Titles never contain IDs. Members never see job, run or entry UUIDs unless they need one as input. Full IDs stay complete and copyable wherever a follow-up option needs them (`run_id`, `application`, `entry`, `before`), in inline code unless the approved card shows them plain (the `/refresh` run, guests#36), and `shortId` is only a label. Member `/sync status` run lines show only the short label, so their footer names where the full `run_id` comes from (the `/refresh` reply) instead of treating the label as input. Member receipts show the entry number `#seq`; officer receipts, history and posts carry the full entry UUID (LEDGER-08). From 2.15.0, `/ledger adjust entry:` accepts either form. A number (`5` or `#5`) is resolved in the current FC account. A number or ID that isn't in that account is "Entry not found". The option reads "Entry this corrects: its number (e.g. 5) or ID from /ledger history".
- Every `member:` option autocompletes server members: `/characters`, `/guest status|grant|revoke|reset`, `/officer grant|revoke|reset`, `/assign` and `/unassign` (`completeMember` in `src/discord/autocomplete.ts`). A suggestion reads "Display Name (@username)", or "@username" when the two match, and its value is the user ID. Typing matches the display name, username, global name or nickname in the member cache. When the cache has no match, Discord's member search runs within about a second. A pasted ID or `<@id>` mention is offered back, labelled "User ID …" when the member cache doesn't have them, so members who have left stay nameable. Where naming someone else is refused (a member's `/characters` and `/guest status`), a member is offered only themselves.

### Saved versus delivered (UX-02)

An immediate reply reports only what its transaction committed. Discord work it queued is described by the effects field (`effectsField` in `jobs.ts`), which branches on the result's `effectsMode`:

| `effectsMode` | Effects field | Receipt |
| --- | --- | --- |
| `live` | `` `… QUEUED` Role update `` | The group's success card; "shortly" is allowed |
| `awaiting_activation` | `` `‖ PAUSED` until activation `` (officers add "Why: Server activation pending") | The pending paused-save card |
| `deployment_disabled` | `` `‖ PAUSED` Discord changes are off for this deployment `` (officers add "Why: Disabled globally (ENABLE_EFFECTS)") | The pending paused-save card, saying they apply once changes are turned back on: a restart with `ENABLE_EFFECTS=true` requeues the held work of every activated guild |

The **paused-save card** (errors-and-style#26) keeps the receipt's own sentence about what was saved and its own facts, and adds the `• SAVED` and `‖ PAUSED` fields and the footer "Check progress any time with /sync status". A paused view never says `… QUEUED` for Discord work or "shortly"; the Lodestone roster read, which still runs while Discord changes are paused, is the only work it may show as queued. Roles are never promised: a new link's Member role is the roster-evidence field on the success card (`↻ WAITING for the next roster check` when the roster is stale), never a separate notice or title.

Held work resumes in three ways, and each keeps one row per dedupe key (`requeueParked` in `queue.ts`): activation, any `/config` change, and a restart with `ENABLE_EFFECTS=true`, which requeues `disabled` work of activated guilds. Requeued work drops its stored paused diagnostic, so it reads `… QUEUED` (and "Queued" in `/ledger`) until it runs, never "retrying". A superseded duplicate's sync runs follow the row that carries its work, so a run never reads Completed before that work has run. A `‖ PAUSED` row that is still there while effects are live has nothing coming to resume it, so it never promises an activation: members read "held from an earlier pause, so ask an officer", a ledger post "held from an earlier pause" with the `/config` step that re-queues it, the officer `/guest status` record "Held from an earlier pause" with the same step, and the officer `/sync status` overview lists it under Needs attention with the `/config` step that re-queues it, never the "Nothing to fix" step.

A receipt reports only what was saved, never Discord work that can't happen. When the server owner's `/verify` link becomes their main, its Nickname field reads "Discord doesn't let bots change the server owner's nickname.", as `/main` does. Both stay success because the owner line is information. The only warning caveat card is `/nickname enabled:true` by the owner when it turns sync on; a repeat is the info no-op card with the same Server owner field. From 2.15.0, reconciliation never writes or restores the owner's nickname, and it drops any pending restore or write. The owner's sync no longer leaves a blocked `reconcile.user` job under Needs attention in the officer `/sync status`.

### No-op replies

A reply never implies a change that didn't happen. The owner decided this on 2026-09-24: "Don't imply a change where no change occurred." A request that matches what is already saved gets an info `= NO CHANGE` card, or one of the approved neutral cards. It is never the paused-save card, even while Discord changes are paused. These requests save nothing and queue nothing, with one exception kept from before 2.15.0: repeating a `/config roles …`, `/config ledger`, `/config officer_notifications` or `/config changelog` value still advances the configuration revision, writes its `config` audit and queues the repair pass, and its card reports any held work that pass requeued.

| Request | Reply |
| --- | --- |
| `/main` naming your current main | "Already your main character": "`= NO CHANGE` **Example Character @ Diabolos** is already your main character in this server.", footer "Switch to another linked character with /main" |
| `/nickname enabled:true` while sync is on | "Nickname sync already on": "`= NO CHANGE` Your server nickname already follows your main, **Example Character**.", footer "Turn off anytime with /nickname enabled:false"; the server owner also gets the Server owner field |
| `/nickname enabled:false` while sync is off | The approved neutral "Nickname sync already off": "`= NO CHANGE` TaruBot isn't managing your nickname, so there was nothing to turn off." |
| `/config` naming the role or channel already saved, or unsetting one that isn't set | "<Setting> already set" or "<Setting> already unset", footer "Audited · configuration revision N", because the repeat is still saved and audited (the exception above) |
| `/config officer_rank` naming the saved rank with the same spelling, or `unset_rank:true` with no rank set | "Officer rank already set": "`= NO CHANGE` **Officer** is already the saved officer rank." It adds "Members who hold it already get bot officer access." only when an FC is linked and an Officer role is bound; otherwise it keeps the saved path's Heads-up field (no FC linked, no Officer role bound). Or "Officer rank already unset": "`= NO CHANGE` No officer rank was set, so officer access already comes only from manual grants." No revision bump, audit or repair pass, and no footer. A new spelling of the saved rank is saved as a change. |
| `/config guest_applications` matching what is saved | "Guest applications already set": "`= NO CHANGE` Applications are already on, reviewed in #channel." ("off" when switched off, and "with no review channel" when none is set), footer "Configuration revision N" |
| `/officer reset` for a member with no grant or revoke | "No officer override to remove", which audits nothing |
| `/guest reset` for a member with no revocation or grant | "No Guest overrides to remove", which audits nothing |

`Service.preferences` saves nothing and queues no reconciliation for the `/main` and `/nickname` repeats. Resuming sync that a manual nickname suspended is a change, so `/nickname enabled:true` then gets "Nickname sync on". The earlier no-op cards are unchanged: "Free Company already linked", "Role layout is already on|off", "Already verified", "Already linked to this member" and the approved neutral "No correction needed".

### Audiences

`audienceOf()` is the only source of the audience: **member**, **officer** (officer access), or **manager** (server manager with Manage Roles). The router derives the viewer once, from the same freshly resolved actor the services authorize against, before authorization, so a refused member still gets member wording. Presenters choose wording and detail from it but never grant anything; the service remains the only authorization and filtering boundary.

- Replies sent before the actor is known (DMs, bots, a restricted guild, an unknown command or button) use member-safe wording.
- `/characters` and `/guest status` use the officer layout only when an officer names a member; an officer's own record uses the personal view.
- Link provenance differs by audience, as both approved cards show: members read "Verified with a Lodestone token", "Assigned by an officer" and "Imported from the previous bot" (characters#18); officers read "Lodestone token", "Officer assignment" and "Imported link" (#20).
- Members never see officer reasons, reviewers, job details or another member's owner. The one exception is an applicant's own denial reason (C6), capped at 300 characters in the decision DM and in their `/guest status`. Grant and revocation reasons stay officer-only.
- Officer and leader role changes, the officer rank, the role layout and `/officer` render to managers, since only managers can make them.
- Replies are ephemeral. The only exception is the observed test guild when `PUBLIC_TEST_RESPONSES` is set, which the router applies; a handler never sets flags.

## Settings, resets and new links

These 2.15.0 receipt families come from owner decisions made on 2026-09-24. Each card follows what actually changed.

### `/config guest_applications`

Guest applications have a switch that is separate from their review channel. The owner's reason: "The channel setting should be separate from whether applications are enabled." One subcommand takes `enabled:true|false`, `channel:#…` and `unset_channel:true` in any combination, saved in one revision and audited per setting. `channel` together with `unset_channel`, or no option at all, is "Check your input". `/apply` opens only when the switch is on and both a review channel and a Guest role are set (`guestApplicationsOpen`). `guestApplicationsReply` in `configuration.ts` picks the card:

| Kind | When | Tone | Title |
| --- | --- | --- | --- |
| `applications.open` | Applications open: the switch turned on, or the missing channel set while on, with a Guest role set | success | Guest applications open (configuration#27) |
| `applications.review_changed` | A new channel for applications that were already open | success | Review channel changed |
| `applications.no_role` | On with a review channel, but no Guest role | warning | "Guest applications on; Guest role still needed" when this call turned the switch on, otherwise "Review channel set; Guest role still needed" (#27) |
| `applications.no_channel` | On with no review channel, including `unset_channel:true` while on | warning | Guest applications on; review channel needed |
| `applications.closed` | Switched off | success | Guest applications closed (#28) |
| `applications.review_set` | A channel set while applications stay off | success | Review channel set |
| `applications.review_unset` | The channel unset while applications stay off | success | Review channel unset |
| `applications.unchanged` | The request matches what is saved | info | Guest applications already set |
| `applications.paused` | Any saved change while Discord changes are paused | pending | Saved, Discord changes paused (errors-and-style#26), with the receipt's own sentence and facts |

- The open, review-changed, Guest-role and review-set cards carry the "Keep it private" field. "Review channel changed" reads "New applications are posted in #channel. Applications already posted stay reviewable in their original channel."
- The closed card quotes the exact refusal `/apply` now shows and says applications already posted stay reviewable. Switching off keeps waiting applications reviewable; only new `/apply` submissions are refused.
- "Review channel set" reads "Applications will be posted in #channel once you turn them on with /config guest_applications enabled:true." "Review channel unset" reads "Applications stay off, and no review channel is set. Choose one before turning them on."
- The closed and review-channel-needed cards add a Review channel field when the same call also changed the channel ("Unset" when it was unset). The review-channel-needed card's next step is "Set one with /config guest_applications channel:#guest-reviews."
- The channel that will take applications is validated before anything is saved. That is a channel the call names, or the stored channel when the call switches applications on without naming one, an imported legacy channel included. A call that only switches applications off or unsets the channel validates nothing, so a deleted channel never blocks closing. If the settings change between that check and the save, so that applications would take a channel that wasn't checked, the reply is "Settings changed — try again" and nothing is saved.
- The live receipts end with the footer "Audited · configuration revision N", as the other `/config` channel receipts do, and carry a timestamp. The no-op card saves and audits nothing, so its footer is "Configuration revision N", and it carries no timestamp. The paused card ends with the paused-save footer and carries no timestamp.

These kinds replace the 2.14.0 `channel.applications_open`, `channel.applications_no_role` and `channel.applications_closed` receipts, which answered the review channel alone.

#### Guest applications in `/config show` and validate

- The `/config show` Guest applications field reads "Open · #channel" (configuration#4). While the switch is on but something is missing, it reads "Closed · no review channel" or "Closed · no Guest role". While the switch is off, it reads "Off · reviews in #channel", or "Off" with no channel kept. When no ledger, notification or review channel is set, the collapsed Channels field still reads "Guest applications: closed".
- `/config validate` lists the review channel only while applications are on. Switched on with a channel, the channel gets its resource check, which is `[WARN] Guest applications #channel: open, but no Guest role is set, so /apply stays closed` without a Guest role. Switched on without a channel, the line is `[WARN] Guest applications: on, but no review channel is set, so /apply stays closed`. Switched off, the line is `[OFF] Guest applications: closed, so /apply refuses`, or "not set, so /apply is closed" on the problems verdict when no channel is set, as configuration#8 draws it. While applications are off, a kept channel is neither listed nor counted in the health line, because an imported legacy channel may no longer exist. Switching applications on validates it ([above](#config-guest_applications)).
- Imports keep the legacy review channel with the switch off. An imported server therefore reads "Off · reviews in #channel" in `/config show` (configuration#6) and `[OFF] Guest applications: closed, so /apply refuses` in its readiness checklist (#9, as drawn), until `/config guest_applications enabled:true` or activation with `--guest-applications open` switches them on.
- `/apply`'s closed card is unchanged for members. An officer with Manage Server also sees the Open applications field: "`/config guest_applications enabled:true channel:#guest-reviews` turns them on with a review channel. `/config roles guest role:@Guest` sets the Guest role. Applications open once all three are set."
- When a submitted `/apply` form is refused because applications are closed, an officer's card has one Next step. While the switch is off or no review channel is set, it reads "Turn applications on with a review channel: `/config guest_applications enabled:true channel:#guest-reviews`." When only the Guest role is missing, it reads "Set the Guest role with `/config roles guest role:@Guest`."
- `/setup` (since 2.35.0 `/setup onboarding confirm:true`) switches applications on, and its receipt still reads "Open · reviews in #channel" (configuration#37). Like `enabled:true`, it first validates a kept review channel it is about to open (an import's legacy channel), and a channel that fails is refused before anything is created.

### `/config changelog`

2.25.0 adds the channel for [update posts](#posts-and-dms), from the owner's decisions of 2026-09-25 on issue #30 (REQUIREMENTS.md "Approved changelog amendments"). Its receipts follow the officer notifications ones:

- **Set** (success), "Changelog channel set": "From the next update on, TaruBot posts what's new for members in #channel. Members and guests need to be able to read this channel." Setting a channel posts nothing at once (decision 3). In a server where onboarding manages visibility and has no record of the channel, a **Visibility** field reads "Onboarding doesn't manage this channel (a new channel joins at the next repair pass), so make sure members and guests can read it." The wording covers both causes: a channel created since the last repair pass, and the Community Updates channel, which onboarding never manages.
- **Hidden** (warning), also "Changelog channel set", when onboarding keeps the channel from members and guests (the lobby, the officer room, or a staff-only channel). Its whole description is two sentences: "Onboarding keeps #channel hidden from members and guests, so they won't see update posts there. Choose a channel they can read." The bot never makes the channel visible (decision 4).
- **Unset** (success), "Changelog posts turned off": "Updates released while no channel is set aren't posted later. Set a channel again to resume posts."
- Repeats are the "Changelog channel already set" or "already unset" no-op card, and a paused save is the #26 card with the receipt's sentence, as for the other channels. A repeated channel that onboarding hides or doesn't manage keeps the info no-op card and adds a **Visibility** field: "Onboarding keeps this channel hidden from members and guests, so they won't see update posts there. Choose a channel they can read.", or the unmanaged text above. Choosing the same channel again (for example, to release a blocked post) still says what `/config validate` warns about.
- `/config show` has a **Changelog** field after Guest applications: the channel, or "Not set". The collapsed Channels field ends "Changelog: not set".
- `/config validate` lists it after Officer notifications: `[OK] Changelog #channel`, `[FAIL] Changelog #channel: …`, or `[OFF] Changelog: not set, so update posts are skipped`. Where onboarding manages visibility, a passing check becomes `[WARN] Changelog #channel: hidden from members and guests by onboarding`, or `…: not managed by onboarding, so check that members and guests can read it`. A failing check stays `[FAIL]`.

### Unset, not cleared

No `/config` option is named `clear`. The owner's reason: "Clear sounds like you're erasing the channel's history." `/config ledger`, `officer_notifications`, `changelog` and `guest_applications` take `unset_channel:true`, `/config roles …` takes `unset_role:true`, and `/config officer_rank` takes `unset_rank:true`. The receipts say unset: "<Role> role unset", "Ledger channel unset", "Review channel unset", "Officer rank unset", and the no-op "<Setting> already unset". "Officer notifications turned off" keeps its title. The input failure names the option: "Choose a role or set unset_role:true, not both.", "Choose a channel or set unset_channel:true, not both." and "Give a rank name or set unset_rank:true, not both." The reply kinds keep their 2.14.0 names (`role.cleared`, `channel.ledger_cleared`, `channel.notifications_cleared`, `rank.cleared`).

### `/officer reset` and `/guest reset`

These commands answer the owner's request for "a third option that removes any override and goes back to membership/rank logic". Both are success, like every committed removal. When there is nothing to remove, the reply is the info `= NO CHANGE` card and nothing is audited. While Discord changes are paused, a saved reset gets the paused-save card.

- **`/officer reset member reason`** needs a server manager, like grant and revoke. When an Officer role is bound, it first checks that role as they do: TaruBot must be able to manage it, and the manager's highest role must be above it unless they own the server ("That role is above yours"). Like a revoke, it works for someone who has left. The title is "Officer override removed", and the lead is two sentences: "@member's officer grant is removed. The in-game rank decides their officer access." The lead says "officer revoke" when a revoke was removed. With no officer rank set, the second sentence is "No officer rank is set, so only /officer grant confers officer access." The fields are Member, Discord role ("Update queued", "Applies if they rejoin" or "Applies once an Officer role is set") and Reason. The footer is "Audited as officer.reset", and the embed carries a timestamp. With nothing to remove, the card is "No officer override to remove": "`= NO CHANGE` @member has no officer grant or revoke." and the same second sentence, with only the Member field, no footer and no timestamp.
- **`/guest reset member reason`** is titled "Guest access reset", with the lead "@member's Guest overrides are removed. FC membership and registered characters now decide their Guest access." The fields are Member, Role update ("Queued", "Applies if they rejoin" or "No Guest role is set"), Removed and Reason. Removed has one line per change: "Revocation lifted", or "Grant ended: <provenance>" with the `/guest status` labels. The footer is "Audited as guest.reset · Ended grants stay in the history", and the embed carries no timestamp. With nothing to remove, the card is "No Guest overrides to remove". An ended grant is stored as history. It no longer confers Guest and no longer appears in `/guest status`. First-activation grandfathering still counts it as an existing grant, so a reset before activation isn't undone by a new grandfathered grant.

The `/officer grant` and `/officer revoke` leads name the reset: "…until a server manager runs /officer revoke or /officer reset" and "…/officer grant or /officer reset". So does the officer `/guest status` footer: "Officer view · Grants last until /guest revoke or /guest reset". See the [deviations table](#deviations-from-approved).

### Main character on a new link

A new link becomes the member's main when they have no main and no other active link. Only a first-ever link did before 2.15.0. Imported members keep their imported state. The `/verify` Main character field says which case applied:

- "Set as your main because it's your first linked character." (characters#9)
- "Set as your main because you didn't have one." (a re-link after every link was removed)
- "Unchanged. Switch with /main …" when the new link isn't the main

Unlike a first link, a re-link keeps the member's nickname sync setting. With sync on, the Nickname field reads as it does for a first link, and the new main's nickname replaces the restore of the original nickname that the last unlink queued, as `/main` does. With sync off, a pending restore still runs, and the Nickname field reads "Nickname sync is off. Turn it on with `/nickname enabled:true` to use this name." instead of promising a change. The `/assign` Effects field says either "It's their first link, so it's also their main, with nickname sync on." or "They had no main character, so it's now their main."

## Buttons and Full details (JSON)

Every button custom ID is built and parsed by one codec, `src/discord/custom-ids.ts`. IDs read `<prefix>:<action>[:<selector>…]`, are at most 100 characters, and carry only selectors (an FC, an entry number, a character, a run, an application or a target member), never the clicker. Every click resolves a fresh actor and is authorized again, because a button on a public test-guild reply can be pressed by anyone. Parsing is strict; a malformed or retired ID is the stale-control card. Grammars only grow, and a retired action keeps parsing for at least one minor release. The component prefixes are `config`, `details`, `guest-apply`, `guest`, `ledger`, `sync` and `verify`.

| Button | Where | Acknowledgement |
| --- | --- | --- |
| Open Lodestone profile, Edit Character Profile (links) | `/claim` | — |
| I've added it — verify now (`verify:claim`) | `/claim` | new reply, so the token message is never edited |
| Check again (`verify:again`) | the pending-token card | updates its own card; refused within 15 seconds of that card's last render |
| View history (`ledger:open`) | `/ledger balance` | new reply, so the balance stays visible |
| Newer, Older, Latest (`ledger:newer`, `ledger:older`, `ledger:latest`) | `/ledger history` | updates the page in place; Newer and Latest are enabled whenever a newer entry exists (C1), and Latest is hidden on the newest page (ledger#21, #23) |
| Run health check, Re-check (`config:validate`) | `/config show`, `/config validate` | updates the view in place with the checklist |
| Check sync status (`sync:status`) | `/setup onboarding confirm:true` | new reply |
| Full details (JSON) (`details:*`) | officer read views below | new reply with a file |
| Approve, Deny (`guest:approve`, `guest:deny`) | the guest review message | unchanged since 2.12.0 |

A component updates its own message only when that message is ephemeral or was created for the presser; anyone else's click gets a new reply. A failure during an update is a private follow-up and leaves the view alone, except the pending-token card, which re-renders the same screen.

**Full details (JSON)** is the only way a result reaches Discord as JSON. It is offered only on officer read views the approved style guide lists that summarize or cut records: `/ledger balance` and the officer `/ledger history`, the officer `/sync status` overview and run detail, and `/guest status member:` and `/characters member:` for an officer. `/config show` and `validate` keep their drawn Run health check and Re-check rows without it, because their embeds are complete. The button re-runs the read with the presser's fresh authorization and replies with `tarubot-<view>.json` attached and a "Full details · <view>" embed; `dataReply()` refuses a member viewer even if the router did not. It is never offered on change results, and the file never contains tokens or application answers.

## Failures

Every refusal and error is rendered by `failureReply()` from the failure catalog in `src/domain/failures.ts`, keyed by code and typed detail, never by message text. Group presenters never catch failures, so each concept has one title and tone however it is reached; the interaction scope only picks wording such as the root command, the Example line or the no-change sentence. The approved Failure message is written at its throw site, so logs, job `last_error` and replies share one wording.

Anatomy: the category's tone; the concept's title; the approved message (or member-safe catalog text); the no-change sentence where the concept's approved copy has one; one next-step field; officers' Diagnostic and Affected fields; and the footer `Code <code> · Ref <interaction ID>`. Ref is the interaction ID, which is also the `operation` field of the log entry ([the site's replies page](../site/src/content/docs/reference/replies.md#reply-references-and-error-codes)). An unexpected error never shows its own text; after a command's work ran it says the request may have been saved, and ledger mutations warn against recording gil twice.

### The no-change sentence

C2 takes the sentence from each concept's approved copy:

- "Nothing was changed." appears on refusals of change commands whose approved copy carries it, and on the read-only `/config validate` and Re-check cards on every verdict.
- The insufficient-funds refusal says "Nothing was recorded." (ledger#7); other ledger refusals say "Nothing was changed." as their approved copy does (errors-and-style#1).
- `/setup onboarding confirm:true` says "Anything already created is reused when you run /setup onboarding confirm:true again." (before 2.35.0, `/setup` and "…when you run /setup again."). Its dry run, which creates nothing and may come before any real run, takes the ordinary sentence, as does `/setup overrides`, which writes only TaruBot's own channel entries. The router tells the presenter whether the command ran with `confirm:true` (`confirmedOption`, never logged or put in the scope).
- The sentence follows the concept, not whether the command reads or changes. A refusal on `/ledger balance`, `/ledger history`, `/sync status`, `/config show` or `/characters` carries it like any other (errors-and-style#1, #2 and #4). These omit it: context and test-instance refusals, "Only your own records", the officer setup card, the closed-applications card, the officer "Linked to another member" card, proofs and the biography card, "No application needed", unexpected errors, and a raw Discord error that may have hit partway through (outside `/setup`). No description repeats it when it already says nothing was saved or changed.
- A retry-timed refusal (the "Please wait a moment" family and the Lodestone, member-list and join-details cards) puts its "Try again …" after the sentence, as errors-and-style#10 and #24 draw it. Other concepts keep their next step where their approved copy puts it.
- No success reply says it.

### Failure catalog

Codes are grouped into categories; each category logs at one level. A concept's title can depend on the detail (which scope refused, which setting is missing) and on the audience; where the tone differs by audience, the Tone column reads members / officers.

| Concept | Codes | Category | Members see | Officers see | Tone | Log level |
| --- | --- | --- | --- | --- | --- | --- |
| input | `input`, `invalid_data` | input | Check your input | Check your input | warning | info |
| forbidden.officer | `forbidden` {officer} | forbidden | Officers only | Officers only | error | info |
| forbidden.owner | `forbidden` {owner} | forbidden | Only your own records | Only your own records | error | info |
| forbidden.manager | `forbidden` {manager, manage_roles, manage_channels} | forbidden | Server managers only | Server managers only | error | info |
| forbidden.administrator | `forbidden` {administrator} | forbidden | Administrator or server owner only | Administrator or server owner only (2.35.0: `/setup overrides confirm:true` run by a server manager with neither Administrator nor ownership of the server; "Missing permission" reads "Administrator", "Who can do this" "Anyone with Administrator, or the server owner") | error | info |
| forbidden.hierarchy | `forbidden` {hierarchy} | forbidden | That role is above yours | That role is above yours | error | info |
| forbidden.membership | `forbidden` {membership} | forbidden | FC membership needed | FC membership needed (on `/suggest`, since 2.28.0, its How to qualify steps lead to the Member or the Guest role) | warning | info |
| forbidden.context | `forbidden` {human, current_member} | forbidden | Not available here | Not available here | error | info |
| forbidden.test_guild | `forbidden` {test_guild} | forbidden | Test instance | Test instance | error | info |
| setup.guild | `setup` {guild} | setup | TaruBot isn't set up here yet | Finish setup first | info / warning | info |
| setup.fc | `setup` {fc} | setup | No Free Company linked | Finish setup first | info / warning | info |
| setup.ledger | `setup` {ledger} | setup | Ledger isn't set up | Finish setup first | info / warning | info |
| setup.officer_role | `setup` {officer_role} | setup | TaruBot isn't set up here yet | Finish setup first | info / warning | info |
| setup.guest_applications | `setup` {guest_applications, guest_role} (switched off or no review channel; no Guest role) | setup | Guest applications are closed | Guest applications are closed, with the commands that open them | info | info |
| not_found.* | `not_found` {resource} | not_found | Character not found, Free Company not found, Link not found, Member not found, Application not found, Entry not found, No ledger for that FC, No active claim for this character, That FC isn't linked, Not found | (same) | warning | info |
| ambiguous.* | `ambiguous` | ambiguous | Several characters match; Choose which role to use; Choose which channel to use | (same) | warning | info |
| ownership_conflict | `ownership_conflict` | conflict | Linked to another member | Linked to another member, with the owner on `/assign` (O3) | error | info |
| fc_linked | `fc_linked` | conflict | Another FC is linked | Another FC is linked | warning | info |
| initialized | `initialized` | conflict | Opening balance already set | Opening balance already set | warning | info |
| uninitialized | `uninitialized` | conflict | Opening balance not set | Opening balance not set (a different next step) | warning | info |
| insufficient_funds | `insufficient_funds` | conflict | Not enough recorded gil | Not enough recorded gil | warning | info |
| stale.settings | `conflict`, `superseded`, `stale` | stale | Settings changed — try again | Settings changed — try again | warning | info |
| stale.control | `stale` {control} | stale | This control is out of date | This control is out of date | warning | info |
| stale.form | `stale` {form, join} | stale | Please reopen /apply | Please reopen /apply | warning | info |
| stale.review | `stale` {review} | stale | This review message is out of date | This review message is out of date | warning | info |
| expired | `expired` | stale | Token expired during verification | Token expired during verification | warning | info |
| pending_proof | `pending_proof` | wait | Token not on the Lodestone yet | Token not on the Lodestone yet | pending | info |
| wait.claims_own | `cooldown` {claims_own} | wait | Too many unfinished claims | Too many unfinished claims | pending | info |
| wait.apply | `cooldown` {apply} | wait | You can apply again later | You can apply again later | pending | info |
| wait.issue | `cooldown` {issue} | wait | You can send another report later | You can send another report later (2.18.0: one report per member per 10 minutes, twenty per server per day) | pending | info |
| wait.suggest | `cooldown`, `rate_limited` {suggest} | wait | You can suggest again later | You can suggest again later (2.28.0: one suggestion per member per hour, three per member and ten in total a day, and GitHub's rate limit on new issues) | pending | info |
| wait.retry | `cooldown`, `rate_limited`, `busy`, `transient`, `stopping` | wait | Please wait a moment | Please wait a moment | pending | info |
| eligible | `eligible` | eligible | No application needed | No application needed | info | info |
| upstream.lodestone | `unavailable` | upstream | The Lodestone isn't responding | The Lodestone isn't responding, with the diagnostic | warning | warn |
| upstream.lodestone_incomplete | `incomplete` | upstream | Lodestone results incomplete | Lodestone results incomplete | warning | warn |
| upstream.lodestone_page | `invalid_response` | upstream | Unexpected Lodestone page | Unexpected Lodestone page | warning | warn |
| upstream.biography | `invalid_response` {biography} | upstream | Couldn't read the biography | Couldn't read the biography | warning | warn |
| upstream.private_profile | `private_profile` | upstream | Lodestone profile is private | Lodestone profile is private: "Make the character's Lodestone profile public, then try again." `/verify` adds "Your token is still valid." (2.17.0) | warning | warn |
| upstream.member_list | `incomplete` {member_list} | upstream | Couldn't read the member list | Couldn't read the member list | warning | warn |
| upstream.join_context | `incomplete` {join_context} | upstream | Couldn't read your join details | Couldn't read your join details; "Couldn't read that member's join details" when it names someone else (an `/assign` or `/officer` target, an applicant) | warning | warn |
| upstream.discord | `unavailable` {api}; raw Discord 429 and 5xx | upstream | Discord isn't responding | Discord isn't responding | warning | warn |
| upstream.github | `unavailable` {github} | upstream | GitHub didn't confirm your suggestion | GitHub didn't confirm your suggestion, with the diagnostic (2.28.0: the post may exist, so the card asks the member to check GitHub first, and the try counts toward the limits) | warning | warn |
| blocked | `blocked`; raw Discord 50001, 50013, 10003, 10011 | blocked | Server setup issue | Discord permissions need attention, with Affected and Then, plus How to fix when the refusal is about TaruBot's role position or channel permissions (errors-and-style#8); since 2.35.0 fix `member_entry` reads "Channel settings → Permissions → TaruBot (the member entry, not the role): remove the denies named above." | warning | warn |
| paused | `disabled` | paused | Discord changes paused | Discord changes paused | pending | warn |
| unexpected | `unexpected` and the internal codes (`idempotency_conflict`, `invalid_job`, `lease_lost`, `ordered`, `dm_blocked`, `configuration`, `schema`, `test_plan`, `writer_lease`) | unexpected | Something went wrong | Something went wrong | error | error |

Raw Discord Unknown Member and Unknown User errors (10007, 10013) in an interaction are `forbidden` {current_member}, "Not available here". A malformed Lodestone ID in parsed output is `invalid_response` ("Unexpected Lodestone page"), never input, and a member list with any member lacking a join time is the member-list card, as is a full member request Discord rate limits (gateway `RATE_LIMITED`) or stops answering (`GuildMembersTimeout`). Every other error that is not a `Failure`, including a `ZodError`, is `unexpected`, with its class in the log's `source` field. Internal codes keep their own code in the footer while showing the unexpected card.

Every time-bound refusal (cooldowns, rate limits, busy, transient and stopping) has a Try again field: a relative time (`<t:…:R>` with the absolute time) when the failure carries a retry deadline, "in a few seconds" when that deadline is under five seconds away, otherwise "shortly" (the `busy`, `stopping` and `transient` throws carry none). The input card's Example field shows the command with the option the user got wrong. From 2.15.0, every option of every registered command path has an example. The owner's reason: "If there's a parameter to input, it should provide an example." `EXAMPLES` in `presenters/failure.ts` covers them all, including `/ledger adjust entry:`, `/sync status run_id:` and `/guest approve|deny application:`, which had none in 2.14.0 (the reply session showed the first two without one). `failure-reply.test.ts` walks the registered commands and fails on any option without an example, and checks that each example starts with its own command path. An input failure that names no option has no Example. `/nickname enabled:true` without a main reads "Choose a main character with /main before turning on nicknames." with no Example, because `enabled:true` was a valid value and an Example would only repeat the command that failed.

Options that autocomplete ask the user to pick a suggestion. A member option's input failure reads "Pick a member from the suggestions, or paste a Discord user ID or @mention."; before 2.15.0, member options were free text and asked only for an ID or mention. An application option reads "That isn't a valid application ID. Pick one from the suggestions, or copy it from /guest status." A bad `/ledger adjust entry:` reads "That isn't an entry number or ID. Use the number from /ledger history, such as 5, or the entry's full ID.", with the example `/ledger adjust balance:10005000 note:Withdrawal #42 was 2,550,000 gil entry:42`. `note()` checks name their option: "Add a note of 1–1,000 characters.", "Add a reason …", "Add a rank …".

## Posts and DMs

Channel posts and DMs are built with `post()` from stored data by the gateway, so jobs pass views instead of message text:

- A **ledger post** reads `<Operation> · <amount>` and is colored by operation as a feed signal: deposit success, withdrawal and opening balance info, correction warning (receipts stay success). It shows the full escaped note, the new balance (a correction also shows the previous balance and the entry it corrects), who recorded it and the entry number, with `Entry <uuid>` in the footer and the entry's own time as the timestamp. Posts have no text content and nothing per attempt, so a retry under the unchanged `ledger:<entry>` nonce sends the same message.
- The **guest review message** is one embed, "Guest application", then "Guest application · approved", "· denied", "· cancelled" or "· no longer needed" once decided, with Approve and Deny disabled. Its first edit clears the pre-2.14.0 text.
- The **decision DM** speaks to the applicant: approved, or not approved with the officers' reason and when they may apply again.
- The **update post** (2.25.0) is info: "TaruBot updated to v<version>", linking CHANGELOG.md on GitHub (its only link), "What's new since v<previous>.", then one field per release with a member note, named `v<version>`, newest first. Notes are escaped like user text and fit the 300-character field limit, so none is cut. At most ten releases are listed; the footer counts the rest ("…and 2 more in the full changelog"). It has no button and no timestamp, so a retry under the `changelog:<guild>:<version>` nonce sends the same message.
- The **status post** (2.29.0, officer notifications channel) is info: "Member status changes", with mention groups named by change and reason ("Member → Guest · no linked character is in the FC", "No access → Guest · guest grant", "Officer added · officer override", "FC Leader removed · no linked character leads the FC"), access changes first (largest group first), then Officer and FC Leader (added before removed), then "Left the FC", one line per departure: `<character> @ <world> (<mention>)`. Mentions are joined with ", " and never ping, and a group that outgrows a field continues as "Name (2/3)". The footer counts the members ("5 members"), and the timestamp is when the batch was frozen. A post fits in nine fields and 5,800 characters (`statusFits`), and the job sizes each batch to fit (at most 100 members), so nothing is cut; a last "Not listed" field with an exact count is only a guard for one member whose own lines exceed that. The post renders only from the frozen entries, so a resend under `status:<batch>` sends the same message.

Two messages are documented exclusions from the presenters:

- **`officer.notify`** stays escaped plain text in 2.14.0 and 2.15.0. 2.35.0 adds two lines @deconfined approved verbatim on [#46](https://github.com/deconfined/tarubot/issues/46#issuecomment-5869082017), `VISIBILITY_MISSING_NOTICE` ("Some channels are missing TaruBot's channel override, so without Administrator TaruBot can't see them or can't post where it should. /config validate lists them and what to do; /setup overrides adds missing overrides while TaruBot holds Administrator.") and `VISIBILITY_RESTORED_NOTICE` ("TaruBot's channel overrides are complete again: /config validate shows every channel visible."); keep them word for word (`src/application/visibility-alerts.ts`, pinned by its tests). This is a deferral, not a limitation: its job payload can gain optional fields under the current payload version. The redesign comes with operational alerting (OPS-11), so the notices aren't restyled first. On 2026-09-24, OPS-10/OPS-11 moved from 2.15.0 to 2.16.0, and then, to launch that day, to 2.17.0.
- The **DevBot test-session announcement** (`src/application/test-session.ts`) already sends an embed, with its own layout: a content line above one embed whose three checklist fields its schema sizes to fit. It is not a user-facing reply, so it keeps that layout.

## Deviations from approved

This table lists every place a shipped reply differs from an approved card, and the authority for it. Sample data (Refs, row counts, commit lists) is not a deviation. The 2.14.0 rows compare against the drawn mockups and are flagged in the 2.14.0 pull request. The 2.15.0 rows are the owner's decisions from the 2.14.0 reply session on DevBot (2026-09-24). They compare against a drawn mockup or against a reply-spec state that 2.14.0 shipped as specified; the row says which.

| Approved card | What ships | Why | Authority |
| --- | --- | --- | --- |
| configuration#18 | Drawn as a success card whose Discord changes read "Queued · applies after activation". Live, it ships as drawn with `` `… QUEUED` Server-wide role check ``; paused, it is the pending "Saved, Discord changes paused" card. | The drawn card shows a paused save as success, which errors-and-style#26 contradicts. | Owner decision O2 |
| characters#31 | The officer card on `/assign` adds a "Linked to" field with the owner's mention and raw ID. Members' cards are unchanged. | The owner asked officers to see the current owner. | Owner decision O3 (2026-09-23) |
| guests#7, #43, #44 | Their job lines use the errors-and-style#28 component: markers, and for officers the raw job kind and short ID (`` `✓ DONE` reconcile.user `4d3c2b1a` ``), instead of the plain "Role update · Done" words drawn on those cards. Role removals use U+2212. | The drawn cards contradict #28; one job line serves every status view. | Owner decision O2 (officer lines show raw kinds as in #28) |
| guests#43 | Paused-only member work ships as pending instead of the drawn warning. "Paused-only" means every outstanding job is `‖ PAUSED`, every run is completed or paused, and nothing is blocked or failed. Runs read "Paused: N of M done", and the footer is the in-progress "Details for one run: /sync status run_id: with the full ID from your /refresh reply" instead of "Ask an officer if this doesn't clear." Blocked or failed member work still ships as drawn (warning, "Ask an officer" footer). | The drawn state groups paused with blocked and failed. The C4 tone table makes a paused view pending unless something is also blocked or failed. | Amendment C4 |
| characters#20, guests#7 | Add **Full details (JSON)**, which these drawn cards do not show. `/config show` and `validate` do not offer it, although the style guide's list names them, because their drawn button rows (#4, #7–#9) don't. | The drawn cards and the style guide's JSON list disagree. | Owner decision O2 (JSON only where the style guide lists it); please confirm the `/config` omission |
| errors-and-style#1 | The note check reads "Add a note of 1–1,000 characters.", not "Add a **note** of 1–1,000 characters that explains the transaction." | One labelled `note()` wording serves notes, reasons and ranks. | Amendment C10 (the approved Rewrites text) |
| errors-and-style#27 | The footer is `Code unexpected · Ref <id>`, and "Share the reference with an officer." moves into a member "What you can do" field; the Reference and Before retrying fields stay. | The house-style board and the Errors board say every error ends with its code and reference; the drawn #27 footer does not. | Needs owner sign-off |
| errors-and-style#26 | Drawn as a generic "(any change)" notice. Each change receipt saved while Discord changes are paused ships as this card, with its own sentence about what it saved in place of "Your change is saved." The drawn sentence follows it, except on two receipts whose held work is not a role, nickname or channel change. A ledger receipt's second line says when its post goes out. The /apply receipt says when officers see the application. The receipt's own fact fields come after the drawn Saved and Discord changes fields, and /setup keeps its approved Check sync status button (configuration#37), which the drawn #26 has no components for. Officers and managers get "Why: Server activation pending", or "Why: Disabled globally (ENABLE_EFFECTS)", as a second line of the Discord changes value rather than a separate field. While the deployment has effects off, the sentence and the field say "Discord changes are off for this deployment" instead of "until activation". | One generic card can't say what each receipt saved, and the drawn card has no officer or deployment-off variant. | Owner decision O2 (paused saves use the pending #26 card); the reply-specs note on notice-effects-paused (officer Why); amendment C5 (all three effects modes) |
| configuration#41 (drawn), and the #42 revoke receipt (reply spec) | 2.15.0: the grant lead ends "…lasts until a server manager runs /officer revoke or /officer reset." instead of "…runs /officer revoke.". The revoke lead, including the one for someone who has left, ends "…until a server manager runs /officer grant or /officer reset." | `/officer reset` is a third way to end the override, so the receipts name it. | Owner decision (2026-09-24): "a third option that removes any override and goes back to membership/rank logic" |
| guests#7 (drawn) | 2.15.0: the footer is "Officer view · Grants last until /guest revoke or /guest reset" instead of "…until /guest revoke". Grants that `/guest reset` ended are kept as history but no longer listed. | `/guest reset` also ends grants. | Owner decision (2026-09-24), as above |
| characters#24 and #26 (reply spec; #26 drawn) | 2.15.0: `/main` naming the current main no longer gets "Main character updated", and `/nickname enabled:true` while sync is already on no longer gets "Nickname sync on". They get the info `= NO CHANGE` cards "Already your main character" and "Nickname sync already on", which save and queue nothing ([No-op replies](#no-op-replies)). A change still gets the specified card, including resuming sync that a manual nickname suspended. | 2.14.0 sent the change card and re-queued reconciliation for a repeat, which implied a change that didn't happen. | Owner decision (2026-09-24): "Don't imply a change where no change occurred." |
| configuration#30 and #31 (reply spec) | 2.15.0: `/config officer_rank` naming the saved rank, or `unset_rank:true` with no rank set, no longer gets the change receipt ("Officer rank set" or "Officer rank unset"). It gets the info `= NO CHANGE` card "Officer rank already set" or "Officer rank already unset", with no revision bump, audit or repair pass ([No-op replies](#no-op-replies)). | 2.14.0 advanced the revision, audited and queued a repair pass for a repeat, and replied as if the rank had changed. | Owner decision (2026-09-24), as above |
| configuration#20, #24 and #31 (reply spec), and the "already cleared" no-op | 2.15.0: the titles read "<Role> role unset", "Ledger channel unset", "Officer rank unset" and "<Setting> already unset" instead of "… cleared". The options are `unset_role:true`, `unset_channel:true` and `unset_rank:true` instead of `clear:true` ([Unset, not cleared](#unset-not-cleared)). | "Clear" read as erasing the channel's history. | Owner decision (2026-09-24): "Clear sounds like you're erasing the channel's history" |
| configuration#27 and #28 (reply spec) | 2.15.0: `/config guest_applications` has its own receipt family ([above](#config-guest_applications)) instead of the `channel.applications_*` receipts. #27's open card ships as specified when applications open, but a new channel for applications that were already open is "Review channel changed". Its Guest-role warning is titled "Guest applications on; Guest role still needed" when the same call turned the switch on, and keeps "Review channel set; Guest role still needed" otherwise. #28's closed card now comes from `enabled:false` and keeps the review channel. `unset_channel:true` no longer closes applications: while they are on, it gives the warning "Guest applications on; review channel needed", and while they are off, "Review channel unset". "Review channel set", "Guest applications on; review channel needed" and "Guest applications already set" are new states. | The review channel and whether applications are open are separate settings. | Owner decision (2026-09-24): "The channel setting should be separate from whether applications are enabled." |
| configuration#6 (reply spec) and the `/config show` Guest applications field | 2.15.0: while the switch is off, the field reads "Off · reviews in #channel", or "Off" with no channel kept. While the switch is on but incomplete, it reads "Closed · no review channel" or "Closed · no Guest role". 2.14.0 showed "Closed" for a server with no review channel. An imported server (#6) now reads "Off · reviews in #channel", because imports keep the legacy review channel with the switch off. #4's "Open · #channel" and the #8 and #9 checklist lines render as drawn. | `/config show` has to show both the switch and the channel. | Owner decision (2026-09-24), as above; imports keep the legacy channel switched off |
| configuration#4, #7, #8 and #9 (drawn) | 2.25.0: #4 has a "Changelog" field ("Not set") after Guest applications, and the checklists list `[OFF] Changelog: not set, so update posts are skipped` after Officer notifications. The verdicts, counts and health line are unchanged, because an unset channel is an `[OFF]` line, not a resource check. | The changelog channel is a new setting, and `/config show` and validate list every channel setting. | Owner decisions (2026-09-25) on issue #30 |
| Resolved inconsistency 22 (reply specs) | 2.15.0: member options autocomplete server members, and their input failure reads "Pick a member from the suggestions, or paste a Discord user ID or @mention." instead of asking only for an ID or mention. | Officers typed names that the ID-only option refused, and a member's `/characters member:` never reached "Only your own records". | Owner decision (2026-09-24): "autocomplete on the member picker" |

## Resolutions record

A short record of how the 2.14.0 plan resolved design conflicts, with the amendments applied.

- **Layout.** Pure group presenters live in `src/discord/presenters/<group>.ts`; the primitives are split into style, format, reply, audience, jobs, labels, controls and failure; the codec is `src/discord/custom-ids.ts`. The pre-2.14.0 `src/discord/replies.ts` JSON dump is deleted.
- **Return type.** A nominal `Presented` only the `reply.ts` builders can create. A transitional `Presented | InteractionEditReplyOptions` union let each group migrate in its own commit and is gone in 2.14.0.
- **Failures.** One central, code-keyed `failureReply` with a typed `FailureDetail` union. Every input failure is "Check your input"; the option detail only selects the Example.
- **Code renames.** `funds` → `insufficient_funds` (below zero only; an overflow is `input`); `pending` → `pending_proof`; idempotency-key collisions → `idempotency_conflict`; `conflict` → `ambiguous` or `fc_linked` where those apply; `input` or `forbidden` → `not_found` or `stale` where those apply. FC membership stays `forbidden` {membership}; the biography failure stays `invalid_response` {biography}. Non-Failure errors log as `unexpected` with their class in `source`.
- **Log levels.** Expected refusals log at info so a Ref stays findable at the default level; upstream, blocked and paused at warn; unexpected at error.
- **Effects state.** An additive `effectsMode` (`live`, `awaiting_activation`, `deployment_disabled`) on every change result, `/apply` included (C5), beside the existing `effects`.
- **Paused saves.** The pending errors-and-style#26 card, not a success card with a PAUSED field (O2, replacing the plan's success-tone resolution). The approved Pending swatch wording is kept.
- **Ownership conflict.** Error tone, "Linked to another member", as approved in characters#31; officers on `/assign` also see the owner (O3).
- **Unexpected errors.** Footer `Code unexpected · Ref <id>`; the Reference field stays; members get "Share the reference with an officer." and officers "Find this reference in the bot logs (operation field)."
- **Health tokens.** The bracket family stays separate from the markers. `[WAIT]` and `[WARN]` appear exactly where configuration#9 and #8 use them (O2). The Guest applications `[OFF]` line reads "closed, so /apply refuses".
- **Job lines.** The errors-and-style#28 component is canonical: raw kinds, short IDs, attempts and next times for officers, labels for members (O2, replacing the plan's labels-for-officers resolution); diagnostics are cut to 150 characters.
- **Provenance labels.** Per audience, as characters#18 and #20 show.
- **Officer layouts.** Only when an officer names a member.
- **Component acknowledgement.** A synchronous `acknowledge` option; updates only for ephemeral or presser-owned sources; custom IDs never carry viewer IDs.
- **Custom-ID grammar.** One codec; prefixes `config`, `details`, `guest-apply`, `guest`, `ledger`, `sync`, `verify`; one officer-only `details` component replaces per-feature JSON actions.
- **Full details (JSON).** See [above](#buttons-and-full-details-json) and the deviations table.
- **View history** opens a new reply; the pager edits in place.
- **Buttons.** Every approved button ships in 2.14.0. `/refresh` has none, as approved (guests#36).
- **Pre-modal check.** `beforeModal` returns `Presented | null`, fails open within 1.5 seconds, is never reported, and the acknowledgement is spread last so its flags can't be overridden.
- **Channel posts.** The Discord port carries view data and the gateway renders it; jobs never import presenters. Ledger posts are embed-only with content `''`.
- **officer.notify** stays plain text until 2.17.0 (OPS-11) — a deferral; the payload could gain optional fields. The plan said 2.15.0; OPS-10/OPS-11 moved to 2.16.0 and then to 2.17.0 on 2026-09-24.
- **Guest application gate.** Open only when both the review channel and the Guest role are set, through one domain predicate shared by the pre-form check, `apply()`, activation and the preview tool (C9). From 2.15.0 the same predicate also requires the applications switch (owner decision, 2026-09-24).
- **Stale titles.** "This control is out of date" for any obsolete command or button; "Please reopen /apply" for a bad form or missing join context before the form; "Couldn't read your join details" when the gateway lacks the viewer's join time ("Couldn't read that member's join details" for someone else's); "This review message is out of date".
- **Ambiguity titles.** "Several characters match"; "Choose which role to use" or "Choose which channel to use".
- **Setup family.** Members see info titles naming the missing piece; officers and managers see "Finish setup first" with the exact commands. The closed-applications case keeps its title and adds an officer next step.
- **Claim and verify titles.** "Too many unfinished claims" and "Please wait a moment" (pending), "No active claim for this character", "Token expired during verification". The copy says claim and token, never challenge.
- **No-change sentence.** See [above](#the-no-change-sentence) (C2).
- **Display helpers** are named `gilText` and `signedGilText`, distinct from the domain `gil()` parser.
- **Tests.** One catalog (`tests/fixtures/replies/`), `expectHouseStyle`, the reply guard and the consistency test, plus the failure, reporting and router tests.
- **Ledger paging.** `older` is exact from an 11-row read, `newer` from an ascending lookup; page = ceil(above/10)+1 and pages = ceil(above/10) + ceil((total−above)/10), so a hand-typed cursor numbers correctly (C1).
- **Member `/refresh`** keeps the full run ID, as approved in guests#36, in the `/sync status run_id:` line and the "Run" footer.
- **Application autocomplete** labels read "display name or ID · submitted YYYY-MM-DD · short ID", with the full UUID as the value, filtered in-process over the newest 25 pending applications (C12).
- **LEDGER-08.** Member receipts show `#seq`; officer receipts, history and posts carry the full UUID.
- **Check again** is throttled at 15 seconds from the source message's own timestamp, which needs no state. The throttle applies only when the click re-renders that card (it is private or the presser's own), the same predicate the router uses (`rendersSourceInPlace`); a click on someone else's public test-guild card replies with the presser's own check, as `/verify` does.
- **Token state.** The pending-token card is characters#10 as drawn, with Check again; its deadline stays on `/claim`'s card (the plan's extra Token expires field was dropped under O2).

The 27 inconsistencies the reply specs recorded are pinned one by one in `reply-consistency.test.ts` ("resolved inconsistencies"). Since 2.15.0, number 22 pins the owner's decision of 2026-09-24 instead of the free-text member wording: member options suggest members and still take an ID or mention. The states the specs listed as missing are implemented by the presenters above and exercised through the catalog, the router and command tests. The 2.15.0 states (the no-op cards, the guest application receipts and the resets) are in the same catalog. The re-link wording is tested in `replies-characters.test.ts`.

## /setup (2.35.0)

2.35.0 (#46) splits `/setup` into `/setup onboarding` and `/setup overrides`, both dry runs unless `confirm:true`. `/setup onboarding confirm:true` keeps `setupReply` and its approved receipt (configuration#37, with Check sync status). The rest are in `src/discord/presenters/setup.ts` (`SETUP_REPLY_KINDS`, `setupPlanReply`, `overridesReply`), cataloged in `tests/fixtures/replies/setup.ts`. Dry runs are read-only and say "Nothing was changed."; none has health tokens or new buttons. N counts what the server owner must fix in Discord: denied channels, private categories and permissions to grant before removing Administrator, plus the channels Discord refused on a real run.

| Kind | Tone | Title | Timestamp | When |
| --- | --- | --- | --- | --- |
| `onboarding.plan` | info | Server setup · dry run | yes | no blockers |
| `onboarding.plan_blocked` | warning | Server setup · dry run · N blockers | yes | every blocker, one line each, packed into as few fields as fit |
| `overrides.plan` | info | Channel overrides · dry run | yes | writes planned, no blockers, N = 0 |
| `overrides.plan_blocked` | warning | Channel overrides · dry run · N blockers | yes | caller, effects, administrator or base_permissions (N counts them) |
| `overrides.plan_attention` | warning | Channel overrides · dry run · N to fix in Discord | yes | no blockers, N > 0 |
| `overrides.nothing` | info (no-op) | Channel overrides · nothing to add | no | nothing to write, N = 0 (a dry run or a real run whose refreshed plan is empty) |
| `overrides.nothing_attention` | warning | Channel overrides · nothing to add · N to fix in Discord | no | nothing to write, N > 0 |
| `overrides.onboarding` | info (no-op) | Channel overrides · onboarding manages them | no | onboarding is on |
| `overrides.applied` | success | Channel overrides added | yes | a real run finished, N = 0 |
| `overrides.applied_attention` | warning | Channel overrides added · N to fix in Discord | yes | a real run finished, N > 0 |
| `overrides.stopped` | warning | Channel overrides stopped | yes | permissions, changed, precondition, time or stopping |

The overrides fields come in a pinned order, each only when non-empty, so denied channels and private categories are never an all-clear: Blockers (dry runs); Configured but denied to TaruBot; Private categories holding a configured channel ("Left alone: move the configured channel out, choose another channel for that setting, or give TaruBot View Channel on the category yourself, then run /setup overrides again."); Grant before removing Administrator; the write groups, one per distinct kind and permission set (categories first; synced children say they copy their category's entry), sharing the slots the other fields leave, with the rest merged into "Other changes"; No longer synced with their category; Not changed (hidden on purpose, with the " (J inside a category hidden from TaruBot)" clause, "Hidden from TaruBot until Administrator is on" in a dry run without it, "TaruBot still can't read" in one with it, and "Discord refused TaruBot's entry" on a real run); Held work (a real run's `applied`, `stopped` or `nothing` that requeued parked jobs: the `/config` saves' "`… QUEUED` N held jobs queued again", or when they retry while Discord changes are paused); Next steps (a dry run's `confirm:true` line; a stopped run's reason and rerun line; and, after a real run or a "nothing to add" answer while TaruBot still holds Administrator, "1. Run /config validate." then "2. When it says Administrator is no longer needed, <removal>." or "2. Fix anything it lists."). A dry run left only with unreadable channels leads with "TaruBot can't read N channels until Administrator is on…" without Administrator and "TaruBot still can't read N channels…" with it. A production-sized fixture (about 100 channels, 6 groups, 2 denied, 2 private categories, 5 unsynced, 3 hidden) fits 10 fields with nothing cut. Lists show 6 mentions, then "and K more", and permissions use the channel-context labels (Manage Roles reads "Manage Permissions").

The refusals, thrown before anything is locked: `forbidden` {administrator} for a caller with neither Administrator nor ownership; `disabled` while Discord changes are paused; `blocked` "TaruBot needs Administrator while /setup overrides confirm:true runs. …" and "Give TaruBot's role View Channel, Send Messages, Embed Links and Read Message History first, …"; and `busy` "Another /setup or channel pass for this server is in progress. Try again in a minute." Two `blocked` refusals carry fix `member_entry` when TaruBot's own member entry denies what it lacks, which no role grant can lift: `validateChannel` for a posting channel ("TaruBot's member entry in <#…> denies Read Message History; remove that deny (on the member, not its role). TaruBot needs View Channel, Send Messages, Embed Links and Read Message History there. Or turn Administrator on for TaruBot, set the channel in /config, and run /setup overrides confirm:true, then remove Administrator once /config validate says it is no longer needed.") and onboarding's channel check, in the dry run, `confirm:true` and the channel pass ("TaruBot's member entry in <#…> denies Manage Channels and Manage Permissions; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels and Manage Permissions there."). Both lead with the channel, the denied bits and where the deny sits, so `/sync status`'s 150-character diagnostic keeps them, and the onboarding dry run bounds each blocker line by its field rather than the 300-character user-text limit, so neither remedy is cut. The onboarding check names each bit once, in the channel's own terms (Manage Permissions, never Manage Roles), and in a voice or stage channel whose TaruBot entry denies Connect it asks for Connect too ("View Channel, Manage Channels, Manage Permissions and Connect"), because Discord's implicit deny makes a Connect deny there take away Manage Channels. Both keep the words "View Channel", so ledger post states still classify them.

## /issue (2.18.0)

`/issue description:…` answers with one of two cards in the utility catalog (`issueReply`):

- **Report received** (success): the report is saved and on its way to the maintainers.
- **Report saved** (pending): issue reporting isn't connected on this deployment yet, so the report waits.

Both list what the report carries under "Sent with it": the description, the member's linked characters and settings in this server, their recent TaruBot activity, and TaruBot's health and recent logs. The footer is `Ref <interaction ID>`, which the issue also carries. A description under 10 characters is an input failure with the command's Example. The limits are `wait.issue`.

## /suggest (2.28.0)

`/suggest idea:…` answers with one card in the utility catalog (`suggestionReply`):

- **Suggestion posted** (success): the embed links to the new issue, and the description names it as `owner/repository#N`, so DevBot's testers see that previews go to the private reports repository. "What was posted" says exactly what went public: the idea without links, Discord mentions, email addresses or long ID numbers, and TaruBot's version, and nothing about the member or the server. "Next" points to GitHub, and to `/issue` for problems. The idea itself is never echoed, and there is no footer or button.

The refusals: outside the deployment's own server, `forbidden.context` ("Suggestions can be sent only from the Free Company server this TaruBot serves."), and the same concept when suggestions are switched off. Without the Member or Guest role, `forbidden.membership` with the lead "Only members and guests of this server can suggest features." and steps to either role. An unconfigured server gets the setup card. An idea under 10 characters once invisible characters are removed is an input failure with the command's Example. The limits and GitHub's rate limit (on the post or the app's sign-in) are `wait.suggest`; an unconfirmed post is `upstream.github`. A submission refused because shutdown began is `wait.retry` ("TaruBot is restarting right now."). A refused GitHub App credential, or a request GitHub rejects, is `unexpected` with a private issue report.
