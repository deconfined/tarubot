/**
 * A web page module (#43, ADR D12): a discovered `*.page.ts` under src/web/pages/ whose default
 * export is definePage(...). Like a slash command, a page declares who may open it and which
 * services it needs, and reads state only through those services; unlike a command, `access` has
 * no default, so a page can't be public by omission. A page that takes forms also declares its
 * POST budget next to its handler, and gets only the services it declared.
 */
import type { Reporter } from "../application/reporting.js";
import { ServiceKey, type Services } from "../bot/services.js";
import type { Actor } from "../domain/policy.js";
import type { PageAccess } from "./access.js";
import { isPermissionId } from "../domain/rbac.js";
import type { SafeHtml } from "./html.js";
import { ICON_NAMES, type IconName } from "./icons.js";
import { POST_WINDOW_MS } from "./limits.js";
import type { Session } from "./sessions.js";

/**
 * Every page is a server page: `/g/:guild/` and lowercase segments, optionally ending in one
 * `/:number` (2.43.0, mod mail's case pages), a positive whole number server.ts validates before
 * the page runs. No other parameter.
 */
export const PAGE_PATH = /^\/g\/:guild(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+(?:\/:number)?$/u;

/** A path's `:number`, as server.ts accepts it: a positive whole number without a leading zero. */
export const PAGE_NUMBER = /^[1-9][0-9]{0,15}$/u;

/** The request-body cap for every route (Bun's and hono/body-limit's), 64 KiB. */
export const WEB_BODY_LIMIT = 65536;

/**
 * The most a page may raise its own POSTs' body cap to (PageOptions.bodyLimit), 256 KiB: enough
 * for any form TaruBot draws, small enough that a page can't make the listener take much more.
 */
export const PAGE_BODY_LIMIT_MAX = 262144;

/**
 * The services a page sees: get() only. server.ts hands each page a view that throws "Page used
 * an undeclared service" for any key outside its `requires`, so a bug in one page can't reach a
 * service it never declared, once members and guests reach page code.
 */
export type PageServices = Pick<Services, "get">;

/** What a page handler receives. Built by server.ts after the session, server and access checks. */
export interface PageContext {
  readonly request: Request;
  /** The request URL rebuilt on WEB_PUBLIC_ORIGIN; nothing reads Host. */
  readonly url: URL;
  readonly session: Session;
  /** Resolved for this request (memoized up to 60 s on GET, fresh on POST); the page admits it. */
  readonly actor: Actor;
  /** The `:guild` parameter, validated with idSchema; equals actor.guildId. */
  readonly guildId: string;
  /**
   * The `:number` parameter of a page whose path ends in one (PAGE_NUMBER, so 1 or more); null for
   * every other page.
   */
  readonly number: bigint | null;
  /** The bot's services, limited to the keys the page declared in `requires`. */
  readonly services: PageServices;
  /**
   * The session's form token. Every POST form the page renders carries it (views/forms.ts's
   * postForm puts it in), and server.ts refuses a POST without it before post() runs.
   */
  readonly formToken: string;
  readonly report: Reporter;
  /** The request reference, for a report's operation. */
  readonly ref: string;
}

/**
 * A POST's result, the page's part of the form pipeline:
 * - `redirect`: a same-origin path to answer 303 to (post-redirect-get), with a notice token from
 *   the page's fixed list when it has something to say (views/forms.ts's noticeLocation);
 * - `invalid`: the page's main content re-rendered with the submitted values kept (escaped, so
 *   nothing typed is lost) and an error summary, at `status`: 422 (the default) when the input
 *   was refused, 409 when it was valid but the state changed underneath it (a stale revision).
 *   The layout prefixes the document title with "Error: ". Messages never echo submitted text.
 *   `modal` says the re-render draws the refused form open on top of the page (Role menu's
 *   editors), its own blocks inert under it: the layout then makes the shell inert too.
 * Refusals that end the request rather than re-render (403, 429, 503 and the rest) are thrown as
 * a Failure; server.ts renders those through the error page.
 */
export type PostOutcome =
  | { readonly redirect: string }
  | { readonly invalid: SafeHtml; readonly status?: 409 | 422; readonly modal?: boolean };

/** definePage's argument. */
export interface PageOptions {
  /** `/g/:guild/…`, matching PAGE_PATH. */
  readonly path: string;
  /** The `<title>` and the page's one `<h1>`. */
  readonly title: string;
  /** Required, any-of, non-empty: TaruBot permission ids (src/domain/rbac.ts). */
  readonly access: readonly PageAccess[];
  /** Service keys checked with services.require() when the web starts. */
  readonly requires: readonly ServiceKey<unknown>[];
  /** Load a typed view model through context.services and render it with a pure views/*.ts. */
  readonly get: (context: PageContext) => Promise<SafeHtml> | SafeHtml;
  /**
   * Handle a form after the same-origin and form-type checks, a session, its form token, the
   * shutdown check, the page's budget and a fresh actor the page admits; validate `form`, the
   * urlencoded body without the token field, with zod and return a PostOutcome. Write through one
   * application operation that authorizes the actor again and commits in one transaction.
   */
  readonly post?: (context: PageContext, form: FormData) => Promise<PostOutcome>;
  /**
   * Required with `post`, and only with it: how many POSTs one user may make to this page in one
   * server per POST_WINDOW_MS (ten minutes), counted in memory (limits.ts) before the fresh actor,
   * so a POST over budget costs no Discord request. Each POST costs three Discord REST calls for
   * the fresh actor, so the budget bounds what one user can spend. Over it: a 429 with
   * Retry-After. Declared here, beside the handler, so a page can't ship without one.
   */
  readonly postLimit?: number;
  /** The page's label in the server navigation; omitted pages aren't listed there. */
  readonly nav?: string;
  /**
   * Whether the navigation lists the page for this viewer, beyond `access` (2.43.0: Mod mail is
   * listed to members and guests only while it's on). Only ever hides a link: the page itself still
   * opens for anyone `access` admits. It gets the page's own scoped services. Omitted: listed for
   * everyone the page admits.
   */
  readonly navWhen?: (actor: Actor, services: PageServices) => Promise<boolean> | boolean;
  /**
   * Resolve the actor afresh on every GET too (2.43.0), never from the minute-long memo: for a page
   * whose content is private enough that someone removed from the server, or demoted from
   * officer, must lose it on their next request (mod mail's pages). Costs one Discord request per
   * GET (the light resolution); POSTs are always fresh.
   */
  readonly freshActor?: boolean;
  /**
   * Only with `post`: this page's POST body cap in bytes, above WEB_BODY_LIMIT and at most
   * PAGE_BODY_LIMIT_MAX (2.43.0), for a form whose fields the browser lets grow past 64 KiB once
   * urlencoded, so text it allowed comes back as the page's own 422 with the text kept rather than
   * a bare 413 that loses it. Size it for the worst case: 9 bytes per UTF-16 unit of each field's
   * maxlength (a three-byte character percent-encoded), plus the other fields. Omitted:
   * WEB_BODY_LIMIT.
   */
  readonly bodyLimit?: number;
  /**
   * The decorative icon beside the page's navigation label and its link on the server list, by
   * icons.ts name; omitted, the label stands alone.
   */
  readonly icon?: IconName;
}

/** Nominal page type, so discovery can validate an unknown import with instanceof. */
export class Page {
  readonly path: string;
  readonly title: string;
  readonly access: readonly PageAccess[];
  readonly requires: readonly ServiceKey<unknown>[];
  readonly get: PageOptions["get"];
  readonly post: PageOptions["post"];
  /** POSTs per user and server in each POST_WINDOW_MS; set exactly when `post` is. */
  readonly postLimit: number | undefined;
  readonly nav: string | undefined;
  readonly navWhen: PageOptions["navWhen"];
  readonly freshActor: boolean;
  /** This page's POST body cap in bytes (WEB_BODY_LIMIT unless it declared more). */
  readonly bodyLimit: number;
  readonly icon: IconName | undefined;
  /** The path ends in `/:number`. */
  readonly numbered: boolean;

  constructor(options: PageOptions) {
    // Discovered modules are untyped at runtime, so re-check what the options type promises.
    if (typeof options.path !== "string" || !PAGE_PATH.test(options.path))
      throw new Error("A page path must be /g/:guild/ followed by lowercase segments.");
    if (typeof options.title !== "string" || options.title.trim() === "")
      throw new Error("A page needs a title.");
    if (
      !Array.isArray(options.access) ||
      options.access.length === 0 ||
      !options.access.every((id) => isPermissionId(id))
    )
      throw new Error("A page must declare access: one or more TaruBot permission ids.");
    if (
      !Array.isArray(options.requires) ||
      !options.requires.every((key) => key instanceof ServiceKey)
    )
      throw new Error("A page must declare the services it requires, as service keys.");
    if (typeof options.get !== "function") throw new Error("A page needs a get handler.");
    if (options.post !== undefined && typeof options.post !== "function")
      throw new Error("A page's post handler must be a function.");
    if (
      options.post !== undefined &&
      (!Number.isSafeInteger(options.postLimit) || (options.postLimit ?? 0) < 1)
    )
      throw new Error(
        `A page with a post handler must declare postLimit, a positive whole number of POSTs per ${POST_WINDOW_MS / 60_000} minutes.`,
      );
    if (options.post === undefined && options.postLimit !== undefined)
      throw new Error("A page's postLimit needs a post handler.");
    if (options.nav !== undefined && (typeof options.nav !== "string" || options.nav.trim() === ""))
      throw new Error("A page's navigation label must be text.");
    if (options.icon !== undefined && !(ICON_NAMES as readonly unknown[]).includes(options.icon))
      throw new Error("A page's icon must name one of the icons in icons.ts.");
    if (options.freshActor !== undefined && typeof options.freshActor !== "boolean")
      throw new Error("A page's freshActor must be true or false.");
    if (
      options.bodyLimit !== undefined &&
      (options.post === undefined ||
        !Number.isSafeInteger(options.bodyLimit) ||
        options.bodyLimit <= WEB_BODY_LIMIT ||
        options.bodyLimit > PAGE_BODY_LIMIT_MAX)
    )
      throw new Error(
        `A page's bodyLimit needs a post handler, and must be a whole number of bytes above ${WEB_BODY_LIMIT} and at most ${PAGE_BODY_LIMIT_MAX}.`,
      );
    if (options.navWhen !== undefined && typeof options.navWhen !== "function")
      throw new Error("A page's navWhen must be a function.");
    if (options.navWhen !== undefined && options.nav === undefined)
      throw new Error("A page's navWhen needs a navigation label.");
    // A navigation link has no number to fill in.
    if (options.path.endsWith("/:number") && options.nav !== undefined)
      throw new Error("A page whose path ends in /:number can't be in the navigation.");
    this.path = options.path;
    this.title = options.title;
    this.access = [...new Set(options.access)];
    this.requires = [...options.requires];
    this.get = options.get;
    this.post = options.post;
    this.postLimit = options.postLimit;
    this.nav = options.nav;
    this.navWhen = options.navWhen;
    this.freshActor = options.freshActor === true;
    this.bodyLimit = options.bodyLimit ?? WEB_BODY_LIMIT;
    this.icon = options.icon;
    this.numbered = options.path.endsWith("/:number");
  }

  /**
   * This page's path in one server; `guildId` must already have passed idSchema, and a numbered
   * page needs its `number` (already PAGE_NUMBER).
   */
  href(guildId: string, number?: bigint | null): string {
    const path = this.path.replace(":guild", guildId);
    if (!this.numbered) return path;
    if (number === undefined || number === null || number < 1n)
      throw new Error("A numbered page's link needs its number.");
    return path.replace(":number", String(number));
  }
}

/** Define a discoverable default export with handler parameters inferred from the contract. */
export const definePage = (options: PageOptions): Page => new Page(options);
