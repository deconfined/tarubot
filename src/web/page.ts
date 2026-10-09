/**
 * A web page module (#43, ADR D12): a discovered `*.page.ts` under src/web/pages/ whose default
 * export is definePage(...). Like a slash command, a page declares who may open it and which
 * services it needs, and reads state only through those services; unlike a command, `access` has
 * no default, so a page can't be public by omission.
 */
import type { Reporter } from "../application/reporting.js";
import { ServiceKey, type Services } from "../bot/services.js";
import type { Actor } from "../domain/policy.js";
import { PAGE_ACCESS, type PageAccess } from "./access.js";
import type { SafeHtml } from "./html.js";
import { ICON_NAMES, type IconName } from "./icons.js";
import type { Session } from "./sessions.js";

/** Every page is a server page: `/g/:guild/` and lowercase segments, with no other parameter. */
export const PAGE_PATH = /^\/g\/:guild(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;

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
  /** The bot's services; a page may get only the keys it declared in `requires`. */
  readonly services: Services;
  readonly report: Reporter;
  /** The request reference, for a report's operation. */
  readonly ref: string;
}

/**
 * A POST's result, the page's part of the form pipeline: a same-origin path to answer 303 to
 * (post-redirect-get), or the form re-rendered for a 422 when zod refused it (messages never echo
 * the submitted values).
 */
export type PostOutcome = { readonly redirect: string } | { readonly invalid: SafeHtml };

/** definePage's argument. */
export interface PageOptions {
  /** `/g/:guild/…`, matching PAGE_PATH. */
  readonly path: string;
  /** The `<title>` and the page's one `<h1>`. */
  readonly title: string;
  /** Required, any-of, non-empty, from PAGE_ACCESS. */
  readonly access: readonly PageAccess[];
  /** Service keys checked with services.require() when the web starts. */
  readonly requires: readonly ServiceKey<unknown>[];
  /** Load a typed view model through context.services and render it with a pure views/*.ts. */
  readonly get: (context: PageContext) => Promise<SafeHtml> | SafeHtml;
  /**
   * Handle a form after the same-origin and form-type checks, a session and a fresh actor the page
   * admits; validate `form`, the urlencoded body, with zod and return a PostOutcome.
   */
  readonly post?: (context: PageContext, form: FormData) => Promise<PostOutcome>;
  /** The page's label in the server navigation; omitted pages aren't listed there. */
  readonly nav?: string;
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
  readonly nav: string | undefined;
  readonly icon: IconName | undefined;

  constructor(options: PageOptions) {
    // Discovered modules are untyped at runtime, so re-check what the options type promises.
    if (typeof options.path !== "string" || !PAGE_PATH.test(options.path))
      throw new Error("A page path must be /g/:guild/ followed by lowercase segments.");
    if (typeof options.title !== "string" || options.title.trim() === "")
      throw new Error("A page needs a title.");
    if (
      !Array.isArray(options.access) ||
      options.access.length === 0 ||
      !options.access.every((flag) => (PAGE_ACCESS as readonly unknown[]).includes(flag))
    )
      throw new Error(`A page must declare access, any of: ${PAGE_ACCESS.join(", ")}.`);
    if (
      !Array.isArray(options.requires) ||
      !options.requires.every((key) => key instanceof ServiceKey)
    )
      throw new Error("A page must declare the services it requires, as service keys.");
    if (typeof options.get !== "function") throw new Error("A page needs a get handler.");
    if (options.post !== undefined && typeof options.post !== "function")
      throw new Error("A page's post handler must be a function.");
    if (options.nav !== undefined && (typeof options.nav !== "string" || options.nav.trim() === ""))
      throw new Error("A page's navigation label must be text.");
    if (options.icon !== undefined && !(ICON_NAMES as readonly unknown[]).includes(options.icon))
      throw new Error("A page's icon must name one of the icons in icons.ts.");
    this.path = options.path;
    this.title = options.title;
    this.access = [...new Set(options.access)];
    this.requires = [...options.requires];
    this.get = options.get;
    this.post = options.post;
    this.nav = options.nav;
    this.icon = options.icon;
  }

  /** This page's path in one server; `guildId` must already have passed idSchema. */
  href(guildId: string): string {
    return this.path.replace(":guild", guildId);
  }
}

/** Define a discoverable default export with handler parameters inferred from the contract. */
export const definePage = (options: PageOptions): Page => new Page(options);
