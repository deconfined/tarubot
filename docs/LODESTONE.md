# Lodestone adapter

The adapter in `src/infrastructure/lodestone/` fetches bounded pages, parses them in workers inside the bot process, and validates the results before application use.

## How a request runs

`client.ts` owns concurrency, validation and retry policy. Requests wait for a parse slot until their deadline. `runner.ts` builds URLs from validated operations in `pages.ts`, permits only the configured Lodestone region, refuses redirects, bounds response bodies and terminates workers on completion, cancellation or timeout. Workers parse supplied HTML and selectors without network or disk access.

## The parser (`parser.ts`)

`parser.ts` uses `linkedom` and upstream selector definitions. Raw strings preserve large IDs and explicit zero; the adapter decodes display text and validates identity fields. Missing page roots and malformed rows are invalid data, not empty rosters. URL query values are encoded once.

`pagePlan` in `pages.ts` defines the columns each operation reads. Change it with the parser and selector tests when adding a field. Biography verification uses a new operation independently of persisted display caches; concurrent matching profile operations share an in-flight acquisition.

## Live selectors

The bot follows [xivapi/lodestone-css-selectors](https://github.com/xivapi/lodestone-css-selectors) HEAD after validation. It starts with the bundled files pinned by `bun.lock` and `upstream-revisions.json`, checks upstream in the background at startup and periodically, and activates accepted revisions in memory. Readiness never waits for GitHub.

`selectors.ts` downloads only `SELECTOR_FILES`, pinned to the selected commit and bounded to 512 KiB each. Validation requires every parsed column and its nested definitions to retain the expected shape. Unused columns may change without blocking an update. A rejected download or revision leaves the active set unchanged; after a restart the bundled set runs until the next successful check.

Regexes are applied during parsing rather than compiled during selector validation. A syntactically accepted selector revision can therefore still fail on a page; use parser fixtures to check behavior. Maintenance acquisition tools perform their own selector check before parsing.

### Refreshing the bundled set

```sh
bun run selectors:check
bun run selectors:update
```

`selectors:check` exits nonzero when the bundled revision is behind HEAD. `selectors:update` advances the lockfile and revision metadata, rebuilds and tests. Commit `bun.lock` and `src/infrastructure/lodestone/upstream-revisions.json` together. The running bot already follows HEAD, so this refresh updates its fallback.

## Status

`/health/ready` and issue reports expose parse/wait counts, cooldown, selector revisions and the last upstream check. Lodestone availability is informational and does not fail readiness. Health probes do not fetch Lodestone pages.

## Failure categories

| Failure | Meaning |
| --- | --- |
| `not_found` | HTTP 404. |
| `rate_limited` | HTTP 429 or the shared cooldown; `retryAfter` gives remaining seconds. |
| `private_profile` | The Lodestone's recognized private-profile 403 page. Other 403s are unavailable. |
| `unavailable` | Other HTTP/network errors, timeout, redirect, oversized body or cancellation. |
| `invalid_response` | A page could not be parsed or validated. |

## Settings

Defaults and ranges for `LODESTONE_*` are on the [configuration page](../site/src/content/docs/deploy/configuration.md#lodestone); `client.ts` validates them at startup.

The process-wide gate spaces starts and pauses all requests after a 429. Cooldown starts at 15 seconds, doubles to five minutes, or honors a longer `Retry-After` up to 15 minutes. Only `unavailable` is retried within an acquisition. Background jobs wait out rate limits without spending an attempt. Separate maintenance tools have their own gates, so avoid competing with a busy bot.

## Adapter validation

Keep IDs exact: canonical strings or positive safe integers. Roster acquisition must check unique IDs, page progression, distinct counts, and the FC identity/count again after crawling. A pager-less empty or single-page roster is complete only when the independently validated FC count agrees. An incomplete response or missing page must never be treated as an empty roster; search likewise distinguishes affirmative no-results markup from malformed output.

## Tests

Parser rules live in `tests/unit/lodestone-parser.test.ts`; selector activation in `tests/unit/selectors.test.ts`. The worker and runner contract tests cover real parsing, bounds, cancellation, private profiles, cooldown and selector changes. When changing the parser or `linkedom`, compare representative page results as well as selector syntax. See [CONTRIBUTING.md](../CONTRIBUTING.md) for running checks.
