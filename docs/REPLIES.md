# Discord replies

Reply behavior is defined by the pure presenters in `src/discord/presenters/` and the executable catalog in `tests/fixtures/replies/`. The [archived design record](https://github.com/deconfined/tarubot/blob/b7ab3bc73f1107ad98fb12864c0cb8ffdb50f0d8/docs/REPLIES.md) preserves approved cards and their discussion; use the current catalog for exact output.

## House style

- Commands/components return one `Presented` reply. The router owns acknowledgement, visibility and mentions; handlers never set `flags` or `allowedMentions`.
- Use `reply()` for interactions and `post()` for channel posts/DMs: one embed, an outcome-first title of at most 60 characters, a tone and short labelled fields. Use `·` between title sections.
- Present the typed result of an application operation. Presenters depend on application **types**, a viewer and injected options such as time, never database/network I/O.
- Say what was saved, not what a queued Discord job might eventually do. Use `effectsField()`/`pausedSave()` for `… QUEUED` and `‖ PAUSED`; reserve completion wording for confirmed effects.
- Choose wording by audience (`viewer`), not merely authorization. Members must not see UUIDs, diagnostics or another member's records; officers get copyable IDs when a follow-up command needs them.
- Use the shared exact-gil, mention, escaped-text and Discord-timestamp helpers. Never float-convert gil, output raw user text, show ISO timestamps or enable pings.
- Bound lists intentionally (`…and N more`, paging or split fields), rather than silently truncate. Respect Discord's field and total-embed limits.
- Throw catalog `Failure` values with typed detail and let the shared failure presenter render them. Give each input option an example; omit option detail when the value itself was valid.
- JSON attachments are officer-only through the `details` component and `dataReply()`. Startup plans and plain officer notices are deliberate exceptions, not patterns for new command replies.

## Buttons and modals

Build/parse custom IDs through `src/discord/custom-ids.ts`; IDs carry selectors, not authority. Every click resolves and reauthorizes the current actor. A public test reply may be clicked by anyone. Messages survive deployments: retired actions keep parsing and answering “out of date” for at least one minor release.

Use update acknowledgement only for a view the component owns. The router edits a source message only when private or created for the presser; ordinary failures become private follow-ups. Modal openers are synchronous and user-access only; their optional fast precheck is a courtesy, not authorization. Revalidate on submission. See [module examples](MODULES.md).

## Add or change a reply

1. Add a typed state to the appropriate `ReplyCatalog`, using shared synthetic samples. Every reply kind needs a case; identify shared concepts, audience, tone, no-op/read-only status and timestamp expectations.
2. Pin approved wording/layout in `tests/unit/replies-<group>.test.ts`. Add maximum-size and overflow cases for lists and IDs.
3. Run the group tests plus `reply-consistency`, `reply-guard`, `command-replies`, `failure-reply` and `custom-ids` tests as applicable. `catalogTests()` checks Discord validation, house limits, mentions and button grammar.
4. Update the affected [site reference](../site/src/content/docs/reference/commands.md) if behavior changes; use invented names and IDs in tests.

Do not restyle owner-approved officer visibility notices incidentally: their two texts are pinned in `src/application/visibility-alerts.ts` and its tests. Member-facing update notes and DevBot's responsibility-separated session plan are separate formats.
