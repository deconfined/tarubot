# Extending the bot

Commands, gateway events and interaction components are discovered from their own files. Keep routing in `src/bot/`, business operations in `src/application/`, Discord formatting in `src/discord/presenters/`, and I/O adapters in `src/infrastructure/`. `src/main.ts` constructs dependencies and starts the application.

Use the [contributor workflow](../CONTRIBUTING.md), [persistence guide](PERSISTENCE.md) and [threat model](THREAT_MODEL.md) for checks, transactions and security boundaries.

## Discovery and deployment

Default-export `defineCommand`, `defineEvent` or `defineComponent` from a `*.command.ts`, `*.event.ts` or `*.component.ts` file in the corresponding `src/` directory. Discovery is recursive and deterministic; production loads the compiled `.js` files. Duplicate identities, invalid exports and missing services fail startup. `bun run build` removes stale compiled routes.

Command registration and runtime use the same definitions. After a definition changes, use `bun run commands:register --guild ID` for development or `--global` for an authorized production cutover, then rebuild/restart execution code. `scripts/commands.ts` also provides command inventory and guild-scope cleanup; see [maintenance-tool profiles](CONFIGURATION.md#maintenance-tool-profiles).

## Maintenance tooling boundaries

Keep tool I/O at the edges and reusable logic in exported functions or `src/`. Discord/database tools use the deployment-identity guard in `src/config/deployment.ts` before I/O. Share existing permission, visibility and inspection helpers instead of duplicating SDK interpretation; `src/domain/permissions.ts` supports checks that deliberately ignore Administrator.

## Add a command

Use an existing command in the same feature group as the starting point. The module owns its Discord builder, `execute`, optional `autocomplete` and `requires` services. Keep related subcommands under their root command.

The router acknowledges interactions, checks guild/human scope, resolves the actor and viewer, and controls reply visibility and mentions. Commands parse options, call an application operation and return its presenter. Application services independently authorize the operation. For an officer-only root, declare `access: "officer"` and the builder's default `ManageGuild` permission; mixed-permission subcommands authorize each operation.

Autocomplete cannot defer and may reveal private records, so authorize each focused-option branch. Use `focusedOption()`, the shared `completeMember()` for member inputs, and `choice()` for bounded labels. Member completion values are user IDs, parsed by `userId()` in `src/discord/selectors.ts`; use `selfOnly` where appropriate.

### Present results

Return one `Presented` reply and throw catalog `Failure` values for errors. Put pure presenters in `src/discord/presenters/`, using typed application results and the viewer. Follow [REPLIES.md](REPLIES.md) for formatting, examples, attachments and presenter tests. Handlers do not set `flags` or `allowedMentions`.

### Open a modal

A command may provide a synchronous `modal(interaction)` instead of `execute`; `/apply` is the current example. Modal openers are user-access only. Opening a form must be the initial acknowledgement and does no database/network work. An optional fast `beforeModal` availability check is only a courtesy: errors or timeouts still open the form.

Handle submissions in a separate component namespace. Recheck actor/guild bindings, input limits and persisted context in the application operation. Forms can survive restarts; opening one does not create a record or authorize submission.

## Add an event

Use `defineEvent` with a unique handler `id` and a Discord `Events` value. Handler arguments follow `ClientEvents`; several handlers may subscribe to the same event. Filter guild scope and bots before feature work. Use `once` for a one-time listener; shutdown listeners may declare `duringShutdown`.

Delegate stateful decisions and critical deliveries to application services and the durable outbox. The binding layer handles errors and listener cleanup. Additional gateway intents must be configured in `DiscordGateway` and, when privileged, in the developer portal.

## Inject a new service

Reuse tokens from `src/application/keys.ts` where possible. A new capability defines one `ServiceKey` with a provider predicate, is registered through `services.provide()` in the composition root, and is declared in the module's `requires` list. Consumers retrieve it with `services.get()`. Import the same token in provider and consumer; startup validates required services.

## Add a component

Use `defineComponent` with a unique custom-ID `prefix`. Narrow the interaction type before reading fields. Build and parse IDs through `src/discord/custom-ids.ts`: they carry selectors, never authority. Every click resolves a fresh actor and the application operation reauthorizes it.

Replies are the default acknowledgement. Use `acknowledge: "update"` only for a component's own view; the router updates a source only when ephemeral or created for the presser. Ordinary failures leave that view intact and normally become private follow-ups; DevBot's public-response override is an exception. See the existing guest review, ledger pager and verification components for their durable context checks.

Messages outlive deployments. Add grammar/builder/parser tests together; retired actions keep parsing and answering “out of date” for at least one minor release.

## Test a presenter

Add cases to `tests/fixtures/replies/` and pin wording in the group's unit tests. [REPLIES.md](REPLIES.md#add-or-change-a-reply) lists the relevant checks. An intentionally added public command also needs the command inventory expectation updated.

## Commenting conventions

Explain consequential boundaries and invariants beside the implementation, especially authorization, transactions, stale context and ambiguous side effects. Keep general development rules in [CONTRIBUTING.md](../CONTRIBUTING.md).
