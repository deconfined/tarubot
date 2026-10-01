# Discord replies

Use [presenters](../src/discord/presenters/) and the [executable catalog](../tests/fixtures/replies/) for current wording and layouts.

## House style

- Return one `Presented` reply, built with `reply()` for interactions or `post()` for channel posts/DMs. The router owns acknowledgement, visibility and mentions.
- Presenters are pure functions of typed application results, the viewer and injected options such as time. Keep database/network work in the application operation.
- Use one embed, an outcome-first title of at most 60 characters, a tone and short labelled fields. Separate title sections with `·`.
- Report saved state accurately: use `effectsField()`/`pausedSave()` for queued or paused effects; completion wording requires confirmed effects.
- Choose detail by audience. Members must not see UUIDs, diagnostics or another member's records; officers get copyable IDs when needed for follow-up.
- Use shared exact-gil, escaped-text, mention and Discord-timestamp helpers. Bound lists with paging, split fields or an explicit overflow count. Do not enable pings.
- Throw catalog `Failure` values and let the shared failure presenter render them. Add an example for each input option; omit option detail when its value was valid.
- JSON attachments use the officer-only `details` component and `dataReply()`. Startup plans and plain officer notices are existing exceptions.

## Buttons and modals

Use `src/discord/custom-ids.ts`; IDs carry selectors, not authority. Every click reauthorizes the current actor. Messages survive deployments, so retired actions keep answering “out of date” for at least one minor release.

Update acknowledgement is for a component's own view. Modal openers are synchronous; availability prechecks do not authorize submission. See [module guidance](MODULES.md#add-a-component) and [modal handling](MODULES.md#open-a-modal).

## Add or change a reply

1. Add the state to its `ReplyCatalog` using invented samples. Record audience, tone, timestamps and shared concepts.
2. Pin wording/layout in `tests/unit/replies-<group>.test.ts`, including maximum-size lists and IDs.
3. Run the group tests and applicable `reply-consistency`, `reply-guard`, `command-replies`, `failure-reply` and `custom-ids` checks. `catalogTests()` checks Discord validation, house limits, mentions and button grammar.
4. Update the affected [site reference](../site/src/content/docs/reference/commands.md) when behavior changes. General checks are in [CONTRIBUTING.md](../CONTRIBUTING.md).

Keep unrelated approved wording unchanged, including officer visibility notices pinned in `src/application/visibility-alerts.ts`. Member-facing update notes and DevBot session plans have their own formats.
