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

## Web pages

The web pages (#43) run in the bot process: `src/main.ts` starts a second listener once the writer lease and Discord are ready, and the shutdown drain stops it. They stay off until `WEB_PUBLIC_ORIGIN` is set. `src/web/settings.ts` parses the web settings when the web starts, so a bad value turns the web off with a report naming the setting and never stops the bot. `src/web/http.ts` holds the header set and the POST checks; `src/web/server.ts` owns the fixed routes (`/`, sign-in, sign-out, `/health/ready` and the assets) and wires the request pipeline.

### Add a page

Default-export `definePage` from a `*.page.ts` file under `src/web/pages/`. The path is `/g/:guild/` followed by lowercase segments. `access` is required, with no default, so no page is public by omission. It's an any-of list: `officer` (officer authority, as commands use it) or `manager` (`authorizeRoleManager`). `requires` lists service keys, checked when the web starts; a missing one keeps the web off. `nav` lists the page in the server navigation for viewers it admits.

The server refuses before the page runs: a malformed or unserved server, or someone who isn't a current member, gets 404, a signed-out visitor goes to sign-in, and a missing flag gets 403. `servePage` in `src/web/server.ts` has the exact order.

The actor is resolved exactly as for a slash command: reused for up to 60 seconds on GET, resolved afresh on every POST. Application operations authorize it again.

`get` loads a typed view model through `context.services`, and a pure function in `src/web/views/` renders it, as presenters do for Discord. Views import application, infrastructure, Drizzle and job modules as types only. Templates use `html` from `src/web/html.ts`, which escapes every interpolation:

- untrusted text (server, member and role names, notes) goes through `untrusted()`, links through `href()`, and times through `time()` (UTC);
- never write a `style=` attribute or a script: the CSP allows neither;
- the unescaped `raw()` is allowed only in constant files that `tests/unit/web-boundary.test.ts` allow-lists.

Throw catalog `Failure` values. The error page maps the category to a status and shows the approved message with its code and ref; anything else is a 500 that shows neither its text nor its stack.

### Dashboard data and presentation

The first dashboard remains read-only. `/g/:guild/configuration` uses `Service.validate()` and the same `configurationChecks()` checklist as Discord. Validation is single-flight per application service and server, with successful results reused for 30 seconds from completion. Every lookup, including a memo hit, reauthorizes the officer; rejected checks are not retained. The page prints the check's actual UTC completion time.

`/g/:guild/status` is labelled **Background work** in navigation. Its process health keeps only readiness, Discord, database and the Lodestone cooldown state. It shows up to 10 recent refresh runs and 25 outstanding jobs from `syncStatus()`, with counts explicitly limited to the displayed sample, not server-wide or global totals. Native `<details>` disclose officer diagnostics without scripts; arbitrary job payloads and process-wide diagnostics are not rendered.

`src/web/mentions.ts` snapshots names from this server's gateway cache at render time, never stores them, and turns Discord mentions and timestamps into escaped, isolated text and UTC `<time>` elements. Uncached names fall back to IDs; obfuscated or permission-denied channels never expose cached names. Both pages declare `gatewayKey` alongside their data services.

`src/web/theme.ts` bundles the generated design-system token stylesheet; `assets.ts` adds the responsive console layout. Token changes come from the design export's `tokens.json`, regenerated to `tokens.css` before rebundling. The device's light palette uses the exported light tokens. The only external assets are the design's Chakra Petch and Martian Mono fonts: the CSP admits Google's stylesheet and font hosts, not scripts or inline styles. The supplied `design/` reference mockups are not runtime source and are excluded from Biome checks.

### Forms

`post` runs only after the same-origin and form-type checks, a session and a fresh actor. Parse the form with zod and return `{ invalid }` (422, with messages that never echo values) or `{ redirect }` (303).

Pages make no durable writes yet. The first write brings an idempotency key, one transaction with audit, and these rules for any job kind a page enqueues: carry `guild_id`; validate the payload before `enqueue()`; use a per-action dedupe key; use the `reconcile.` prefix only when generation fencing is intended; add a `JOB_KIND` label. Pages then say "queued", never "done".

### Run and test pages

`bun --no-env-file tests/fixtures/web-dev.ts` runs the real web server on `[::1]` with a fake Discord sign-in, in-memory sessions and invented data. Never start it through a root `bun run` alias, which loads `.env`. Test routes with `createWebApp` and `app.request()` (`tests/unit/web-server.test.ts`), and views with invented data and linkedom (`tests/unit/web-pages.test.ts`).

For a preview from another machine, `--host` selects the VM's LAN interface and `--cert` / `--key` supply its TLS certificate and key. Both the dashboard and fake sign-in bind and advertise that address over HTTPS; production's origin policy still rejects plain HTTP on routable addresses. Replace the documentation address below with the VM's LAN address before generating the certificate:

```sh
mkdir -p .cache/web-preview
openssl req -x509 -newkey rsa:2048 -noenc \
  -keyout .cache/web-preview/key.pem -out .cache/web-preview/cert.pem \
  -days 2 -subj /CN=192.0.2.10 -addext subjectAltName=IP:192.0.2.10
bun --no-env-file tests/fixtures/web-dev.ts --host 192.0.2.10 \
  --cert .cache/web-preview/cert.pem --key .cache/web-preview/key.pem
```

Open the printed HTTPS address. A self-signed certificate may need a browser exception on both the dashboard and fake sign-in ports. The default command remains IPv6-loopback HTTP, and production passes none of these listener overrides.

## Commenting conventions

Explain consequential boundaries and invariants beside the implementation, especially authorization, transactions, stale context and ambiguous side effects. Keep general development rules in [CONTRIBUTING.md](../CONTRIBUTING.md).
