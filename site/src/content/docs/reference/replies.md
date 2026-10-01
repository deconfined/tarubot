---
title: Replies and error codes
description: What each failure code means, the status markers, health-check tokens, buttons, and the posts TaruBot sends.
sidebar:
  order: 2
---

Every TaruBot reply is one embed: a title that leads with the outcome, a short description, a few fields, and the next step as an exact command. Replies are private to the person who ran the command, and never ping anyone.

## Reply references and error codes

Every failure reply ends with `Code <code> · Ref <interaction ID>`. **Ref is the interaction ID, and the bot's log entry for that failure carries the same value in its `operation` field**, so a member's screenshot leads straight to the log entry and its `code`, `source`, `scope` and `diagnostic`:

```sh
docker compose logs tarubot | grep '"operation":"123456789012345678"'
```

Officers see more than members: a diagnostic, what's affected, and how to fix it. Members see a plain explanation and what to try.

| Code | Members see | Cause | What officers or operators do |
| --- | --- | --- | --- |
| `input`, `invalid_data` | Check your input | A malformed option: a typed name not picked from the member suggestions, a blank note, a bad page cursor | None. The reply names the option and shows an example. |
| `forbidden` | Officers only, Server managers only, Administrator or server owner only, Only your own records, FC membership needed, That role is above yours, Not available here, Test instance | The person lacks the access the command needs, or used a DM, a bot account or another server; for `/suggest`, a server outside the FC's own, suggestions switched off, or neither the Member nor the Guest role (FC membership needed, with steps to either role); for `/setup overrides confirm:true`, neither Administrator nor owning the server | None, unless they should have access: check `/config officer_rank`, the Officer role and `/officer` overrides. `/officer reset` removes an override so the rank decides. |
| `setup` | TaruBot isn't set up here yet, No Free Company linked, Ledger isn't set up, Guest applications are closed (officers: Finish setup first) | A server, FC, ledger channel, Officer role, review channel or Guest role isn't configured, or guest applications are switched off | Run the command the officer reply names, then `/config validate`. Reopen switched-off applications with `/config guest_applications enabled:true`. |
| `not_found` | Character not found, Link not found, Entry not found, … | The record or Lodestone page doesn't exist | None; check the ID that was given. |
| `ambiguous` | Several characters match, Choose which role or channel to use | A search or a `/setup onboarding` name matched several candidates | Run it again with an ID, or choose the role or channel explicitly with `/config`. |
| `ownership_conflict` | Linked to another member | The character is linked to someone else | If the link is wrong, an officer runs `/unassign` first. |
| `fc_linked` | Another FC is linked | `/config fc link` while a different FC is linked | Unlink the current FC first. |
| `initialized`, `uninitialized` | Opening balance already set, or not set | The ledger's opening balance state | An officer runs `/ledger initialize` once, or `/ledger adjust`. |
| `insufficient_funds` | Not enough recorded gil | A withdrawal that would go below zero | None; check `/ledger balance`. |
| `conflict`, `superseded` | Settings changed — try again | The server's settings changed while the command ran | None; run it again. |
| `stale` | This control is out of date, Please reopen /apply, This review message is out of date | A button, form or review message from an older state or release | Register the commands again after an update if it persists. |
| `expired` | Token expired during verification | The claim token expired while it was being checked | None; `/claim` again. |
| `pending_proof` | Token not on the Lodestone yet | The Lodestone hasn't published the biography token yet | None; wait and use **Check again**. |
| `cooldown`, `rate_limited`, `busy`, `transient`, `stopping` | Please wait a moment, and the claim, application, report and suggestion limits, which have their own titles | A limit, contention, a temporary Discord change or a shutdown; for `/suggest`, also GitHub's rate limit | None; the reply says when to try again. |
| `eligible` | No application needed | The visitor already qualifies for access | None. |
| `private_profile` | Lodestone profile is private | The character's Lodestone profile is private, so TaruBot can't read it | The owner makes the profile public on the Lodestone, then tries again. A pending claim's token stays valid meanwhile. |
| `unavailable`, `incomplete`, `invalid_response` | The Lodestone isn't responding, Discord isn't responding, GitHub didn't confirm your suggestion, … | The Lodestone or Discord failed or returned something unusable, such as a malformed ID in a parsed page (`invalid_response`) or a member Discord sent without a join time (`incomplete`); or GitHub didn't confirm a `/suggest` post | Check readiness's `lodestone` object and Discord's status. For `/suggest`, check the repository's issues ([public suggestions](/tarubot/deploy/monitoring/#public-suggestions)). Logged at warn. |
| `blocked` | Server setup issue (officers: Discord permissions need attention) | A missing permission, the role hierarchy, or a deleted role or channel; for `/setup overrides confirm:true`, TaruBot without Administrator or without the four posting permissions on its own role | Fix what the officer reply names, then `/config validate`. When TaruBot's own entry in a channel denies what it needs, the reply says so: remove that deny from TaruBot's member entry (not its role) in the channel's permissions, or turn Administrator on for the step it names. |
| `disabled` | Discord changes paused | Discord changes are off for the whole deployment (`ENABLE_EFFECTS=false`), or for a server imported from the previous bot that hasn't been activated yet; the job's diagnostic says which | Restart with `ENABLE_EFFECTS=true`: startup requeues the held work of every active server. Saving a `/config` role or channel, the FC link or `/config guest_applications` also requeues it, and [`retry.js`](/tarubot/deploy/tools/#retryjs) is the fallback. |
| `unexpected` (and internal codes such as `idempotency_conflict`) | Something went wrong | An error with no approved explanation | Find the Ref in the logs (`source`, `scope`) and investigate. Logged at error, and reported to the maintainers when issue reports are on. |

`/suggest` has three cards of its own: **Suggestion posted** (`suggest.posted`), which links the new issue and says exactly what was posted; **You can suggest again later** (`wait.suggest`, codes `cooldown` and `rate_limited`), for its limits and GitHub's; and **GitHub didn't confirm your suggestion** (`upstream.github`, code `unavailable`), which asks the member to check GitHub before sending it again. The names in parentheses are the reply concepts of the contributor style guide linked at the end of this page.

### Log levels

Each interaction failure is logged once, at the level its category sets:

| Level | Message | Categories |
| --- | --- | --- |
| info | `Interaction refused with an approved reason.` | input, forbidden, setup, not found, ambiguous, conflict, stale, wait, eligible |
| warn | `Operation could not complete; a dependency or setting needs attention.` | upstream (the Lodestone, Discord), blocked, paused; also an interaction that can no longer be answered, a failure while sending a reply, and a pre-form check that failed (the form opened anyway) |
| error | `Operation failed; inspect scoped work status.` | unexpected, and every lifecycle, gateway-event, queue-worker and shutdown report |

Each entry carries these fields. Option values, message payloads, tokens and library error text are never logged.

| Field | Content |
| --- | --- |
| `operation` | The interaction ID, which replies show as **Ref** (a job ID or task name for reports from background work) |
| `code` | The failure code: the failure's own, a mapped Discord error's (`blocked`, `forbidden`, `unavailable`), or `unexpected` for anything else |
| `category` | The code's presentation category |
| `source` | The error class: `Failure`, `DiscordAPIError[50013]`, `ZodError`, or `unknown` |
| `scope` | The interaction path, such as `/ledger withdraw`, `button ledger` or `modal guest-apply`, never option values |
| `diagnostic` | The approved failure message only |

Routine refusals log at info, so a Ref stays findable at the default `LOG_LEVEL`. Autocomplete failures log with the scope `autocomplete /<command>` and show an empty suggestion list.

## Status markers

Replies describe saved and background work with text markers, so color is never the only signal:

| Stored job | Marker | Member wording |
| --- | --- | --- |
| Succeeded | `✓ DONE` | The kind's completion phrase, such as "Roles and nickname updated" |
| Succeeded with nothing to do | `– SKIPPED` | "nothing to do" |
| Running | `… IN PROGRESS` | The kind's label |
| Queued | `… QUEUED` | The kind's label |
| Queued behind other work, or waiting out a Lodestone rate limit | `↻ WAITING` | "next" and the due time |
| Queued to retry after an error | `↻ WAITING` | "retrying" and the due time |
| Blocked | `! BLOCKED` | "an officer needs to fix permissions" |
| Paused | `‖ PAUSED` | "waiting for activation" or "Discord changes are off for this deployment" |
| Failed | `✗ FAILED` | "stopped and won't retry"; a decision DM to closed DMs says the decision still stands |

Two more markers describe the request itself: `• SAVED` (committed to the database) and `= NO CHANGE` (it was already that way, so nothing was saved or queued).

Members see labels: Role update, Server-wide role check, FC roster check, Departure confirmation, Character profile refresh, Channel access, Role layout, Update post, Ledger post, Guest review message, Decision DM, Officer notice, Status notice. Officers see the raw job kind (such as `reconcile.user`), the first 8 characters of the job ID, the attempt, the next time and the stored diagnostic, cut to 150 characters.

An immediate reply never uses completion words. `… QUEUED` or `‖ PAUSED` there means the work was saved; only a view that reads stored jobs back (`/sync status`, `/guest status`, `/ledger balance` and `/ledger history`) can show `✓ DONE`.

## Health-check tokens

`/config validate` and the **Run health check** and **Re-check** buttons list each check with a token instead of a marker:

| Token | Meaning |
| --- | --- |
| `[OK]` | The check passed. |
| `[WARN]` | It works, but something needs attention, such as `ENABLE_EFFECTS=false`, a review channel without a Guest role, guest applications switched on with no review channel, or a changelog channel that onboarding hides from members or doesn't manage. |
| `[FAIL]` | A missing resource, permission or hierarchy problem stops a feature. |
| `[OFF]` | The feature is switched off. |
| `[WAIT]` | Waiting, for example for the server's activation or a first roster. |

The title gives the verdict: problems, warnings, or all checks passed. The **TaruBot's role** and **Visibility** sections use the same tokens, judged as if TaruBot's Administrator were off; [Health checks](/tarubot/admin/health-checks/#tarubots-role-and-channel-view) explains each row.

## Setup replies

Both `/setup` subcommands are dry runs unless `confirm:true`. A dry run says "Nothing was changed." and changes nothing.

| Title | When |
| --- | --- |
| Server setup · dry run | `/setup onboarding` without `confirm:true`, with nothing in the way: the roles, rooms, settings and channel changes it would make. |
| Server setup · dry run · N blockers | The same, listing every blocker that would stop `confirm:true`, each on its own line. |
| Channel overrides · dry run | `/setup overrides` without `confirm:true`: the entries it would add, grouped by what they allow and deny. |
| Channel overrides · dry run · N blockers | The same, with what stops `confirm:true` first: who may run it, paused Discord changes, TaruBot without Administrator, or TaruBot's role without the four posting permissions. |
| Channel overrides · dry run · N to fix in Discord | The plan, plus what only you can fix: configured channels denied to TaruBot, private categories holding a configured channel, and permissions to give TaruBot's role before Administrator comes off. |
| Channel overrides · nothing to add | Every entry TaruBot can add is there. While TaruBot still holds Administrator, its next steps are `/config validate`, then removing Administrator once it says so. |
| Channel overrides · nothing to add · N to fix in Discord | Nothing to add, but something above still needs fixing in Discord. |
| Channel overrides · onboarding manages them | The server has lobby onboarding, whose own pass gives TaruBot its channel access. |
| Channel overrides added | `confirm:true` wrote them. Next: run `/config validate`, and remove Administrator as soon as it says so. |
| Channel overrides added · N to fix in Discord | Written, with something left to fix in Discord, listed. |
| Channel overrides stopped | The run stopped (the 10-minute limit, a restart, a channel or setting that changed, or a permission Discord refused); running it again continues. |

A real `/setup overrides` run, one with nothing to add included, also puts work that was waiting on a channel back in the queue, and says how many held jobs it queued again, as a `/config` save does.

`/setup onboarding confirm:true` keeps its receipt: what it created or reused, and **Check sync status**.

## Buttons

| Button | Where | What it does |
| --- | --- | --- |
| Open Lodestone profile, Edit Character Profile | `/claim` | Links to the character's Lodestone page and the profile editor. |
| I've added it — verify now | `/claim` | Runs `/verify` in a new reply, so the token message stays as it was. |
| Check again | The "Token not on the Lodestone yet" card | Checks again in place. It waits 15 seconds after the card was last shown. |
| View history | `/ledger balance` | Opens `/ledger history` in a new reply. |
| Newer, Older, Latest | `/ledger history` | Pages through the history in place. |
| Run health check, Re-check | `/config show`, `/config validate` | Runs the checks and updates the view in place. |
| Check sync status | `/setup onboarding confirm:true` | Opens `/sync status` in a new reply. |
| Full details (JSON) | Officer views that summarize records | Re-runs the read for the officer who clicked and attaches the complete result as a file. |
| Approve, Deny | The guest review message | Decides the application. |

Every click is authorized again for the person who clicked.

## Posts and direct messages

- **Ledger posts** in the ledger channel read `<Operation> · <amount>`, with the full note, the new balance, who recorded it and the entry number. A correction also shows the previous balance and the entry it corrects.
- **The guest review message** in the review channel holds the applicant, the submission time, both answers, and **Approve** and **Deny**. Once decided, its title reads approved, denied, cancelled or no longer needed, and the buttons are disabled.
- **The decision DM** tells the applicant whether they were approved. A denial includes the officers' reason, if one was given, and when they may apply again.
- **Officer notices** in the officer notifications channel are plain text: Lodestone trouble, its recovery, characters unlinked automatically, and missing channel overrides and their recovery. See [Officer notices](/tarubot/admin/notices-and-updates/#officer-notices). The channel-override lines read, word for word:
  - "Some channels are missing TaruBot's channel override, so without Administrator TaruBot can't see them or can't post where it should. /config validate lists them and what to do; /setup overrides adds missing overrides while TaruBot holds Administrator."
  - "TaruBot's channel overrides are complete again: /config validate shows every channel visible."
- **Status notices** in the officer notifications channel read "Member status changes": members grouped by change and reason ("Member → Guest · no linked character is in the FC"), then "Left the FC" with each departed character and its owner's mention. The footer counts the members. See [Member status changes](/tarubot/admin/notices-and-updates/#member-status-changes).
- **Update posts** in the changelog channel read "TaruBot updated to vX.Y.Z", linking the changelog, with "What's new since" the last version announced and one field per release with a member note, newest first. At most ten are listed; the footer counts the rest. See [Update posts](/tarubot/admin/notices-and-updates/#update-posts).

Every message is sent with mentions turned off, so no reply or post pings anyone.

Presenter authors: the reply house style and links to the executable card examples are in [docs/REPLIES.md](https://github.com/deconfined/tarubot/blob/main/docs/REPLIES.md) in the repository.
