# Lodestone adapter

TaruBot reads the Lodestone inside the bot process (`src/infrastructure/lodestone/`). It fetches pages under strict bounds, parses them in isolated workers with TaruBot's own parser, and validates every field before it becomes an application fact. There is no sidecar service and no Nodestone.

## How a request runs

1. **The adapter** (`client.ts`, class `Lodestone`) takes a parse slot. At most `LODESTONE_CONCURRENCY` parses run at once; more requests wait in arrival order until their deadline, and are never refused as busy.
2. **The runner** (`runner.ts`) builds the page URL from the validated operation (`pages.ts`) and fetches it under the network policy:
   - only the configured region's Lodestone (`LODESTONE_REGION`);
   - the gate's start spacing and 429 cooldown (`gate.ts`);
   - a fetch deadline and no redirects;
   - a streamed body bound;
   - private-profile detection.
3. **A fresh worker** (`worker.ts`) receives the page and the active selector files the operation reads, and parses it (`parser.ts`). It never touches the network or the disk. The runner terminates it when the parse ends or the request's deadline or shutdown aborts it, which also ends CPU-bound parsing.
4. **The adapter** maps a failure to its catalog code, retries only transient outages, and validates the parsed record (see "Adapter validation").

## The parser (`parser.ts`)

The parser applies the selector definitions directly:

- A definition selects one element, or all of them with `multiple`, and yields its `innerHTML` or an attribute (`''` when absent). Values stay raw strings, so large IDs and explicit zero survive and the adapter decodes display text.
- A definition's `regex` yields its named groups, spread into the enclosing record (`SERVER` → `World`, `DC`). Python-style `(?P<name>` groups and `(?P=name)` references are translated to JavaScript. A regex column whose element is missing keeps its own `null` field.
- A group of definitions yields a record of its non-null results, or `null` when none matched. A group with a `ROOT` yields `{ List: [...] }`, one record per `ROOT` element, with malformed rows kept as `null` so the adapter sees them.
- The top-level `ROOT` narrows the page, and a page without it is invalid, never an empty roster. `ENTRY`'s list and `PAGE_INFO`'s groups spread into the result. Paginated pages turn the latter into `Pagination {Page, PageTotal, PageNext, PagePrev}`.
- Each operation reads a fixed set of keys (`pagePlan` in `pages.ts`): the profile's `NAME`, `SERVER`, `FREE_COMPANY` (and `BIO` only for proof verification); the FC's `ID`, `NAME`, `TAG`, `SERVER`, `ACTIVE_MEMBER_COUNT`; and `ROOT`, `ENTRY`, `PAGE_INFO` (plus `NO_RESULTS_FOUND` for searches) on member and search pages.
- URLs are built with query values encoded exactly once.

The parser's only dependency is `linkedom`. `pages.ts` is kept apart from it, so the modules that fetch pages and check selector sets never load the DOM library; only workers do.

## Live selectors

`xivapi/lodestone-css-selectors` **follows its latest HEAD** after validation:

- **The bundled set.** `bundled.ts` imports the 6 files the parser reads (`SELECTOR_FILES`) straight from the `lodestone-css-selectors` package that `bun.lock` pins, with the commit recorded in `upstream-revisions.json`. A unit test checks that the two agree. This set runs until the first check, and whenever HEAD is rejected.
- **Following upstream.** The writer checks the repository's HEAD at startup (in the background, so readiness never waits for GitHub), then every `LODESTONE_SELECTOR_CHECK_SECONDS` (15 minutes by default). A new HEAD goes to `SelectorStore.activate()` (`selectors.ts`):
  - It downloads those files from `raw.githubusercontent.com`, pinned to that commit, reading each at most 512 KiB into memory.
  - It validates each file. A definition needs a non-empty `selector` string and correctly typed options. Every column the parser reads (`PARSED_KEYS`, the keys of `pagePlan`) must still exist, with every definition and group inside it, at any depth, of the same kind. Columns the parser never reads may change or go, so they can't hold back an update.
  - It then switches to the new set in memory. The next parse gets it: the adapter hands each worker the files its operation reads.
- **Regexes aren't compiled during validation.** They are applied per column, and upstream already ships one that doesn't compile (achievements' `ENTRY.NAME`), which only affects that unused column.
- **Failures and restarts.** A download or validation failure keeps the active set and logs "Lodestone selector revision rejected; the active set stays" once per revision. A switch logs "Lodestone selectors updated" (from and to). Nothing is written to disk: after a restart the bundled set runs until the first check brings HEAD back, moments later.
- **Maintenance tools** that read the Lodestone (`acquire.js`) run one check before parsing, so they use HEAD too.

### Refreshing the bundled set

```sh
# Read-only: nonzero exit status means bun.lock's selector commit is behind upstream HEAD.
bun run selectors:check

# Advance the lockfile, record the commit in upstream-revisions.json, rebuild and test.
bun run selectors:update
```

Commit the lockfile and the metadata together. Refreshing the bundled set is housekeeping: the running bot already follows HEAD.

## Status

`/health/ready` carries a `lodestone` object. It is informational: a Lodestone outage never fails readiness. It holds:

- `parsing` and `waiting`: parse slots in use, and requests waiting for one;
- `cooldownSeconds` and `strikes`: the gate's remaining 429 cooldown, and the 429s in a row;
- `selectors`: `{revision, source: upstream|bundled, activatedAt, bundled}`;
- `upstream`: the last check, with the deployed and latest commits.

Issue reports show the same, with whether and when the Lodestone last answered. Probes never fetch a Lodestone page.

## Failure categories

A parse ends in data or one of these, mapped to the failure catalog:

- `not_found`: HTTP 404.
- `rate_limited`: the Lodestone answered 429, or the gate is still cooling down from one; `retryAfter` is the remaining cooldown in seconds.
- `private` → `private_profile`: a character page answered with the Lodestone's own "Access Restricted" page (HTTP 403 carrying its `ldst__error` window markup), which it serves for a private profile. Any other 403, such as an edge or firewall block, is `unavailable`.
- `unavailable`: any other HTTP error, a network failure, a timeout, a redirect, an oversized body, or a cancelled request.
- `invalid_response`: the worker couldn't parse the page, such as a missing page root.

Verification always requests biography data through a new operation, independently of persisted display caches. Concurrent requests for the same profile operation share one in-flight acquisition.

## Settings

The `LODESTONE_*` settings, with their defaults and ranges, are on the documentation site's [configuration page](../site/src/content/docs/deploy/configuration.md#lodestone). `client.ts` validates them at startup.

**Lodestone gate (2.17.0).** Start spacing and a shared cooldown live in `gate.ts`, one per process. The first Lodestone 429 closes the gate for every request: new starts are refused locally with the remaining cooldown, without contacting the Lodestone. The cooldown starts at 15 s and doubles on each consecutive 429 up to 5 min, or follows a longer Retry-After of up to 15 min. Any other Lodestone answer resets the escalation. Each 429 logs one "The Lodestone throttled TaruBot" line. A maintenance tool that reads the Lodestone has a gate of its own, so avoid running `acquire.js` alongside a busy bot.

**Retries (2.17.0).** Within one request the adapter retries only `unavailable`, up to `LODESTONE_ATTEMPTS`, with exponential backoff and jitter. It does not retry `rate_limited`: the gate would refuse again until the cooldown ends. Instead, the job queue waits the `retryAfter` without spending an attempt, and a command tells the user when to try again.

## Adapter validation

The adapter:

- Accepts canonical string IDs or positive safe integers, rejecting already-unsafe numeric IDs.
- Decodes display entities while retaining canonical Unicode text.
- Requires valid identity fields, unique IDs, consistent page progression, and matching distinct counts.
- Rechecks FC identity and count after the crawl.
- Accepts pager-less single/empty rosters only when an independently validated FC count exactly establishes completeness.
- Distinguishes affirmative empty search results from malformed or incomplete search output.

## Tests

- `tests/unit/lodestone-parser.test.ts` pins each parsing rule.
- `tests/unit/selectors.test.ts` covers selector validation and activation.
- `tests/contract/lodestone-worker.test.ts` runs the real worker with the bundled selectors, and the adapter's failure naming and retry policy.
- `tests/contract/lodestone-runner.test.ts` covers the runner:
  - request-start spacing, and parse slots that wait;
  - cancellation, and a spinning worker terminated at its deadline;
  - private profiles and the 429 gate;
  - a newly activated selector set reaching the parser.

Repeat the live-page parity check when changing the parser or linkedom.
