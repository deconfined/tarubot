# Extending the bot

Commands, Discord gateway events, and interaction components are independently discovered modules. `src/main.ts` wires capabilities and starts the application. Feature handlers live in their own files.

```text
src/
  bot/                         # Generic contracts, service registry, discovery, and routing
  commands/
    characters/*.command.ts    # One file per root slash command
    configuration/*.command.ts
    guests/*.command.ts
    ledger/*.command.ts
    synchronization/*.command.ts
    utility/*.command.ts
  events/*.event.ts            # One file per independently identifiable listener
  components/*.component.ts   # One file per custom-ID namespace
  discord/                    # SDK port, option builders, selectors, and the custom-ID codec
    presenters/               # Pure reply presenters: house style, failures, one module per group
  application/                # Injectable feature services and durable business operations
```

## Discovery and deployment

- Discovery is recursive, deterministic, and relative to the loader's `import.meta.url`.
- Source execution discovers `*.command.ts`, `*.event.ts`, and `*.component.ts`. Production discovers their compiled `.js` equivalents under `dist/src/`.
- Helpers and declaration files are ignored. Each executable module default-exports the appropriate `defineCommand`, `defineEvent`, or `defineComponent` result.
- Empty feature groups are supported, including a directory absent after its final module was removed and output rebuilt. Other filesystem failures remain errors.
- Invalid exports, duplicate command names, duplicate component prefixes, duplicate event-handler IDs, and missing declared services fail startup with diagnostics.
- Runtime dispatch and `commands:register` use the same `loadCommands()` function. Registration loads definitions without connecting application services to PostgreSQL or logging a gateway client into Discord.
- `bun run build` cleans generated `dist/` first. Removing or renaming a source module therefore removes its stale compiled route as well.
- Deploy definition changes with `bun run commands:register --guild ID` for development or `--global` at production cutover. Rebuild/restart to load changed execution code. Event/component additions are loaded on restart.
- `scripts/commands.ts` reads back every command scope against the same discovered declarations (`list`, which exits 0 only when the declared scope matches and every other scope is empty) and clears leftover guild-scoped commands after a fingerprint-confirmed dry run (`clear-guild`). Production tools require [launch isolation](CONFIGURATION.md#launch-isolation).

## Maintenance tooling boundaries

One-shot tools under `scripts/` keep their I/O at the edges and put testable logic in exported functions or `src/` modules:

- `src/config/deployment.ts` is the pure deployment-identity guard every Discord/database tool calls before any I/O ([CONFIGURATION.md](CONFIGURATION.md#maintenance-tool-profiles)).
- `src/discord/inspection.ts` holds pure helpers over raw Discord REST payloads (command paths, intents, role order, permissions, inventory differences) shared by `commands.ts`, `register.ts`, `discord-inspect.ts`, and `discord-smoke.ts`.
- `src/domain/permissions.ts` (2.35.0, #46) holds the permission catalog and Discord's permission arithmetic over raw payloads (moved from `inspection.ts`, which re-exports it), with `ignoreAdministrator` for the as-if-Administrator-were-off questions; `src/domain/visibility.ts` is the pure analysis and overrides planner built on it, shared by `/config validate`, `/setup overrides` and the officer alert. Never answer such a question with discord.js `has(bit)`, whose `checkAdmin` defaults to true.
- `src/discord/obfuscation.ts` (2.30.2, #47) holds the shared helpers for Discord's channel obfuscation: the `CHANNEL_OBFUSCATED` flag check, `cachedAsHidden` (whether a cached entry is obfuscated or its cached overwrites deny TaruBot View Channel, which decides a 10003) and the reading of `GET /channels/{id}`'s 50001 and 10003 answers. The onboarding pass (`guild-access.ts`), channel validation (`gateway.ts` `validateChannel`), `/channel` and the inspector's unlisted-destination states use them.
- `src/domain/grandfathering.ts` classifies humans for first-activation grandfathering, computes the plan checksum, and summarizes plans; `src/application/grandfathering.ts` gathers the evidence and writes grants; `src/application/activation.ts` runs activation as one transaction. `scripts/preview.ts` and `scripts/activate.ts` supply Discord validation and enumeration around them.
- `src/infrastructure/lodestone/` is the Lodestone adapter ([LODESTONE.md](LODESTONE.md)): the parser and its workers run in the bot process (2.21.0).

## Add a command

Create `src/commands/utility/hello.command.ts`:

```ts
/** A generic Discord utility; it needs no game-specific service. */
import { defineCommand } from "../../bot/command.js";
import { command } from "../../discord/options.js";
import { mentionUser } from "../../discord/presenters/format.js";
import { reply } from "../../discord/presenters/reply.js";

export default defineCommand({
  data: command("hello", "Say hello"),
  execute({ actor }) {
    // Return a presenter reply; the router has already deferred and owns visibility and mentions.
    return reply({
      tone: "neutral",
      title: "Hello",
      description: `Hello, ${mentionUser(actor.userId)}!`,
    });
  },
});
```

The module owns its builder, `execute`, optional `autocomplete`, and optional required services. Root commands such as `/config` keep their related subcommands together in that feature's module.

The router provides guild/human checks, test-guild scoping, current actor resolution, the viewer, prompt acknowledgement, failure presentation, and mention handling. Replies default to ephemeral; new features with an intentionally public response can declare `ephemeral: false`. Existing product commands retain their ephemeral contract.

For observed development sessions, `PUBLIC_TEST_RESPONSES=true` overrides command/component visibility only in `TEST_GUILD_ID`. It does not bypass authorization. The DevBot Compose overlay enables this policy so the development server can follow testing.

For an officer-only root, set both the Discord builder's default `ManageGuild` permission and `access: "officer"`. Mixed-permission subcommands must authorize their individual operations. Application services recheck authorization independently.

Autocomplete returns up to 25 string choices, built with `choice()` from `src/discord/presenters/format.ts` so labels are cut on character boundaries, and uses Discord's permission-bearing interaction payload, since autocomplete cannot defer. Keep private completion queries inside an authorized application operation.

A command has one `autocomplete` handler for all its options. When several options autocomplete, the handler dispatches on the focused option with `focusedOption()` from `src/discord/autocomplete.ts`, as `/unassign` (member, then character) and `/guest` (member, then application) do. A mixed-permission command authorizes each branch in the handler too, because suggestions can reveal records. Every free-text `member:` option completes with the shared `completeMember()`: it filters the cached server members, falls back to Discord's member search within `SEARCH_BUDGET_MS` (1.2 s) when the cache has no match for two or more typed characters, and offers a pasted ID or mention back so departed users stay nameable. Its values are user IDs, which `userId()` in `src/discord/selectors.ts` parses. Pass `selfOnly` where a member may name only themselves. `member-autocomplete.test.ts` calls the commands' own handlers to check which completer each focused option reaches and who may see its suggestions.

### Present results

`execute` returns exactly one presenter reply (`Presented`), and nothing else: the command and component contracts are typed that way, and the router answers any other value as an unexpected failure instead of sending it. [REPLIES.md](REPLIES.md) is the house style. In short:

- A command parses its options, calls one service method and returns that result's presenter, such as `presenter(await app.method(actor, …), viewer, options)`. Put the presenter in `src/discord/presenters/<group>.ts`; it is a pure function of the typed result (`src/application/results.ts`), the `viewer` and injected options such as `now`, and it imports application types only.
- Build every reply with `reply()` (or `post()` for channel posts and DMs). It produces one embed with a tone, an outcome-first title of at most 60 characters with `·` between sections, short labelled fields, and optional approved buttons, and enforces Discord's limits.
- Format with the shared helpers: `gilText`/`signedGilText` for exact grouped gil with a U+2212 minus, `when()` and `deadline()` for Discord timestamps (never ISO strings), `plain()` and `quote()` to escape and bound user text, and mention helpers that never ping.
- Report what was saved, not what Discord will do: queued work reads `… QUEUED`, paused work `‖ PAUSED`, and completion words wait for a succeeded job. Use `effectsField()` and `pausedSave()` from `jobs.ts` for change receipts.
- Choose wording by audience from `viewer`, never access: members never see job or entry UUIDs, diagnostics or other members' details; officers get full copyable IDs where a follow-up command needs them.
- Throw a `Failure` with a catalog code and typed detail, and let the router present it through the one failure presenter. Never catch a failure to build your own error reply.
- Give every option an Example: the input-failure card shows the first `EXAMPLES` line (`src/discord/presenters/failure.ts`) of that command path that uses the failing option. `failure-reply.test.ts` walks every registered command path and fails on any option without an example. Leave the option detail off a failure whose option value was valid, so no Example repeats the command that failed: `/nickname enabled:true` without a main names the `/main` step instead.
- Never set `flags` or `allowedMentions`; the router applies visibility and forces mentions off.
- JSON reaches Discord only through the officer-only `details` component and `dataReply()`; `reply-guard.test.ts` fails on any other use. The DevBot test-session post and `officer.notify` are the documented exclusions.

### Open a modal

A command can declare a synchronous `modal(interaction)` factory **instead of** `execute`. It returns a `ModalBuilder`, as `/apply` does using labeled text inputs. These openers are user-access only, receive no resolved actor, and must not do network/database work: `showModal` must be Discord's initial acknowledgement. Opening the form does not create a record or grant authority.

An optional `beforeModal({ guildId, services, interaction })` check may refuse a closed feature before the form opens. It receives the router-verified guild but no actor, and returns a presenter reply (`Presented`, built with `reply()` or a group presenter) or `null`. Keep it to one fast local read: the router waits at most `MODAL_GATE_BUDGET_MS` (1.5 s) inside Discord's three-second window, and if the check errors, overruns or returns anything else, the problem is logged at warn and the form opens as before. A refusal is sent as the interaction's only reply, with the default visibility and mentions disabled; it is an expected state, so it is not reported and carries no `Code · Ref` footer. The check is a courtesy, not authorization, so the submission path must repeat it. `/apply` uses it to refuse while guest applications are closed; the constructor rejects `beforeModal` on a non-modal command.

Route submission through a separate discovered component namespace. The router defers that submission, resolves the current actor, and authorizes it before the handler runs. Validate actor/guild bindings, input limits, and current persisted context again in the application operation; custom IDs are context, not credentials. A form may remain open across a process restart. Reject obsolete joins and duplicate submissions according to the feature's durable policy. Pre-acknowledgement failures use the same reply-visibility rules as deferred errors.

## Add an event

Create `src/events/welcome.event.ts`:

```ts
/** A best-effort welcome feature independent of FC membership policy. */
import { Events } from "discord.js";
import { defineEvent } from "../bot/event.js";

export default defineEvent({
  id: "custom-welcome", // Unique handler identity, even when event names are shared.
  event: Events.GuildMemberAdd,
  async execute(context, member) {
    // Scope guild-specific work and exclude bots before sending the notification.
    if (!context.allowsGuild(member.guild.id) || member.user.bot) return;
    await member.send({ content: "Welcome to the server!", allowedMentions: { parse: [] } });
  },
});
```

Handler arguments are inferred from `ClientEvents`: selecting a different event changes the tuple TypeScript requires. Multiple modules may subscribe to the same Discord event. Use `once: true` for once-only listeners. The shared binding layer catches synchronous/asynchronous errors, stops new work during shutdown, and returns listener cleanup functions. An infrastructure listener can opt into `duringShutdown: true`.

Stateful decisions and critical deliveries should use an application service and the durable outbox. The example above intentionally treats the welcome DM as best-effort. Configure any additional Discord intents explicitly in `DiscordGateway` and, for privileged intents, in the developer portal.

The built-in `client-ready.event.ts` invokes application initialization. Its lifecycle service owns readiness and scheduling, while `src/main.ts` owns dependency construction and process-signal housekeeping. One-shot operational scripts await their isolated clients' readiness without installing live bot feature listeners.

## Inject a new service

Capability tokens allow a feature to add dependencies without expanding the router's context contract:

```ts
/** A stateless example feature capability. */
import { ServiceKey } from "../../bot/services.js";

export class Clock {
  /** Return an explicit UTC instant for presentation or application policy. */
  now(): Date { return new Date(); }
}

/** The predicate validates dynamically retrieved providers without unsafe assertions. */
export const clockKey = new ServiceKey("clock", (value): value is Clock => value instanceof Clock);
```

Provide the instance once in the composition root with `services.provide(clockKey, new Clock())`. A module declares `requires: [clockKey]`, then obtains its typed capability with `context.services.get(clockKey)`. Required providers are checked before gateway work is accepted. Import the same exported token in the provider and consumer; token identity and names are validated to prevent ambiguous registrations.

TaruBot's existing tokens are in `src/application/keys.ts`. They expose the application service, synchronization, guild-observation operations, lifecycle, PostgreSQL, and Discord gateway. New capabilities can live alongside their own feature code.

## Add a component

Create a `*.component.ts` default export using `defineComponent` with a unique `prefix`. IDs of the form `prefix:payload` route to that module. Buttons, message-component interactions, and modal submissions share this lookup; the handler narrows the interaction type it supports.

A click is acknowledged with a new reply by default. A component that re-renders its own view (a pager or a re-check) can set `acknowledge: "update"`, or a synchronous `(customId) => "reply" | "update"` that does no I/O. The router edits the source in place only when it is ephemeral or was created for the presser, and otherwise replies, so a click on someone else's public message never rewrites it; the edit replaces the previous content, embeds, buttons and files. A failure during an update is sent as a new private follow-up (public only in the `PUBLIC_TEST_RESPONSES` test guild, like every reply) and leaves the source view alone. The exception is a failure that re-renders that same screen, which replaces the source in place: `rendersInPlace()` in `src/discord/presenters/failure.ts`, currently only the `pending_proof` pending-token card from Check again. Every click still resolves a fresh actor and is authorized before the handler runs.

The `guest` component demonstrates durable officer review IDs: it validates action, application UUID, guild, actor permissions, and stored message identity before committing a decision. The separate user-level `guest-apply` namespace handles application forms and their join bindings. New components should resolve private payloads through the same owning-guild authorization rules.

Reply buttons build and parse their custom IDs with the one codec in `src/discord/custom-ids.ts`. IDs read `prefix:action[:selector…]`, stay within Discord's 100 characters at maximum inputs, and carry selectors only (an FC, entry number, character, run, application or target member), never the clicker. Buttons on a public test-guild reply can be pressed by anyone, so a handler re-authorizes the presser through the service with the fresh actor, and never trusts the ID for authority. Messages outlive deployments: a grammar only gains actions, and a retired action keeps parsing (and answering "out of date") for at least one minor release. Add a new button's grammar, builder and parser tests together (`custom-ids.test.ts`). The `verify` component serves `/claim`'s verify-now button (always a new reply, so the token message is never edited) and the pending-token card's Check again (an in-place update, refused within 15 seconds of the card's last render when the click re-renders that card; `rendersSourceInPlace()` in `src/bot/component.ts` is the one predicate the router and the throttle share). The officer-only `details` component re-runs an officer read view for its presser and replies with the JSON file through `dataReply()`; each read view that offers Full details adds its case there. The `ledger` component serves `/ledger balance`'s View history (always a new reply, so the balance stays visible) and the history pager, which re-reads each page in place as whoever clicked; a pager whose FC was replaced since the page was shown is refused as out of date. The `sync` component serves **Check sync status** (`sync:status[:<run>]`), which always opens a new reply with `/sync status` read for whoever clicked, and the `guest` review buttons answer with the same decision presenter as `/guest approve` and `deny`, parsing their IDs with the shared codec. The officer-only `config` component serves `/config show`'s **Run health check** and `/config validate`'s **Re-check** (`config:validate`), which re-run the read-only validation for whoever clicked and replace their own view with the checklist in place.

## Test a presenter

Every reply state has a case in the reply catalog (`tests/fixtures/replies/<group>.ts`, registered in `index.ts`):

1. Build the typed service result the state needs from the shared samples in `tests/fixtures/results.ts`, and add a `ReplyCase` with its approved `spec` (or `null` for a state without a drawn card), audience, tone, title, timestamp flag and `render()`. A group's catalog is `satisfies ReplyCatalog<Kind>`, so a new reply kind cannot ship without a case; set `concept` when the same concept is reachable from several commands, and `noOp` or `readOnly` where they apply.
2. `catalogTests()` runs `expectHouseStyle` on every case: one embed that the discord.js validators accept, the tone's color and the title, the house and Discord limits, the timestamp flag, no JSON, mentions forced off, nothing cut, and button IDs the codec parses.
3. Pin approved cards exactly in `tests/unit/replies-<group>.test.ts`, and add maximal-data variants for lists (`…and N more`, split fields) so no reply is ever cut.
4. `reply-consistency.test.ts` then checks the case against every other catalog: one title and tone per concept and audience, the tone table, the marker rules, no ISO times, no stray UUIDs in member views, and the banned titles. `reply-guard.test.ts` keeps JSON on the officer details path, and `command-replies.test.ts` runs every registered command path through its presenter.

## Commenting conventions

- File headers explain the module's responsibility and architectural boundary.
- Public contracts and methods document invariants, authorization, side effects, and return semantics.
- Inline comments explain lock ordering, idempotency, stale evidence, ambiguous acknowledgements, and other decisions whose reasons are not obvious from syntax.
- Gateway modules describe filtering and delegation; business rules belong with their application/domain implementation.
- Scripts document inputs, maintenance intent, cleanup, and database/network boundaries.
- Tests explain controlled failures, synthetic data, and the invariant being exercised.
- Strict JSON configuration is explained in [CONFIGURATION.md](CONFIGURATION.md); executable/configuration formats that support comments carry inline documentation.

When extending a feature, update the relevant comments and meaningful behavior tests together. The inventory test documents the current product contract; intentionally adding a public command requires updating that expected inventory as well.
