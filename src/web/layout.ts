/**
 * The page shell (#43, ADR E12): `lang="en"`, the viewport, the dark color scheme, the hashed
 * stylesheet and favicon, one `<h1>`, the server navigation, the sign-out forms and a footer with
 * the version, the source and license links (AGPL-3.0 §13) and the third-party licenses (the
 * fonts' and icons' notices). Pure: it renders what it is given and reads no state.
 *
 * Two frames, styled by styles/shell.ts and styles/entry.ts:
 * - a server page is a console: a sidebar with the wordmark, the server switcher (a link back to
 *   the server list, and the only place the server's name appears), the page navigation and the
 *   account menu, beside a top bar and the page. From 64rem the sidebar is a fixed column; below,
 *   it is a sticky bar with the navigation as a strip under it.
 * - every other page (sign-in, the server list, "no access", errors) is an entry page on the
 *   starfield, under a plain bar with the wordmark and, when signed in, the account menu. The
 *   sign-in page has no bar: its heading is the wordmark.
 *
 * Markup rules every page inherits (tests/unit/web-pages.test.ts checks the rendered output): no
 * `style=` attribute and no script (the CSP allows neither), exactly one `<h1>` (the title), a
 * visible text label on every control, and untrusted text only through untrusted(). Icons are
 * decorative and never change a label's text (icons.ts).
 */
import { project } from "../config/project.js";
import type { Actor } from "../domain/policy.js";
import { admits } from "./access.js";
import { FAVICON, NOTICES, STYLESHEET } from "./assets.js";
import { href, html, type SafeHtml, untrusted } from "./html.js";
import { type ErrorFrame, PATHS, type Problem, SERVER_LIST } from "./http.js";
import { type IconName, icon } from "./icons.js";
import type { Page } from "./page.js";
import { postForm } from "./views/forms.js";

/** One navigation link; `href` is a page href or a PATHS value. */
export interface NavLink {
  readonly href: string;
  /** Constant page wording (Page.nav), not untrusted text. */
  readonly label: string;
  /** Marked aria-current="page". */
  readonly current: boolean;
  /** The page's decorative icon (Page.icon), when it declares one. */
  readonly icon?: IconName;
}

/** A Discord server as the shell shows it. */
export interface ServerIdentity {
  /** The snowflake; picks the initials' color, so a renamed server keeps its color. */
  readonly id: string;
  /** Untrusted text (the Discord server name), always escaped and isolated. */
  readonly name: string;
}

/** What the shell shows around a page's main content, whoever is viewing it. */
interface LayoutFrame {
  /** The `<title>` (with " · TaruBot") and the one `<h1>`. */
  readonly title: string;
  /**
   * A form re-rendered with problems (a 409 or 422): the `<title>` starts with "Error: ", which a
   * screen reader announces first when the page loads, and the tab shows. The `<h1>` is unchanged.
   */
  readonly error?: boolean;
  /** The current server and the pages in it that admit the viewer: a console page. */
  readonly guild?: ServerIdentity & {
    readonly nav: readonly NavLink[];
    /**
     * Who is viewing, for the side navigation's note (server.ts sets it from actor.officer):
     * officers configure, members and guests pick their roles. Omitted, the officers' note.
     */
    readonly audience?: Audience;
  };
}

/** Who a console page is shown to: an officer, or a member or guest (who share every page). */
export type Audience = "officer" | "member";

/** The side navigation's caption and note per audience; constant wording. */
const SIDE_NOTE: Readonly<Record<Audience, { readonly caption: string; readonly note: string }>> = {
  officer: {
    caption: "Settings and background work",
    note: "Most settings are changed in Discord; the role menu is set here.",
  },
  member: {
    caption: "Your roles",
    note: "Pick your roles here. Everything else is in Discord.",
  },
};

/**
 * The shell's model. Signed in, the account menu offers "Sign out" (POST /logout) and "Sign out
 * everywhere" (POST /logout/all) as forms, which carry the session's form token like every POST
 * form (sessions.ts's formToken), so a signed-in model must hold it.
 */
export type LayoutModel = LayoutFrame &
  (
    | { readonly signedIn: false }
    | {
        readonly signedIn: true;
        /** The session's form token (WebVariables.formToken). */
        readonly formToken: string;
      }
  );

/** The product name, in every `<title>` and the header, and the / page's whole title. */
export const BRAND = "TaruBot";

/**
 * A server's navigation: the pages that declare a `nav` label and admit this actor (the same
 * admits() that routing applies), in path order, linked in the actor's server. `currentPath` is the
 * route pattern being shown ("/g/:guild/status"), which gets aria-current.
 */
export function navLinks(pages: Iterable<Page>, actor: Actor, currentPath?: string): NavLink[] {
  return [...pages]
    .filter((page) => page.nav !== undefined && admits(actor, page.access))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((page) => ({
      href: page.href(actor.guildId),
      label: page.nav ?? page.title,
      current: page.path === currentPath,
      ...(page.icon === undefined ? {} : { icon: page.icon }),
    }));
}

/** Anything but letters, digits and spaces: punctuation, symbols, marks and bidi controls. */
const NOT_INITIAL = /[^\p{L}\p{N}\s]/gu;

/** One of the eight avatar hues: an FNV-1a hash of the ID, the same on every page and restart. */
function hue(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1)
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193);
  return (hash >>> 0) % 8;
}

/**
 * A server's initials avatar: the first letter or digit of each of the name's first two words, on
 * a hue picked by the ID. It is decorative and aria-hidden, since the name sits beside it. The
 * initials are deliberately not isolated: they hold letters and digits only, so no bidi control,
 * and each page must still isolate a server's name exactly once (web-pages.test.ts). A name with
 * neither shows the server icon instead.
 */
export function serverAvatar(server: ServerIdentity): SafeHtml {
  const initials = server.name
    .replace(NOT_INITIAL, "")
    .split(/\s+/u)
    .filter((word) => word !== "")
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
  return html`<span class="orr-avatar orr-avatar--square orr-avatar--hue-${hue(server.id)}" aria-hidden="true">${initials === "" ? icon("server") : initials}</span>`;
}

/** The type-only wordmark (the design has no logo), a link to the start page. */
const WORDMARK = html`<a class="wordmark" href="${PATHS.home}">${BRAND}</a>`;

/** One navigation item; the label is constant wording and the target passes href(). */
const navItem = (link: NavLink): SafeHtml => {
  const label = html`${link.icon ? icon(link.icon) : ""}${link.label}`;
  return link.current
    ? html`<li><a class="nav-item" href="${href(link.href)}" aria-current="page">${label}</a></li>`
    : html`<li><a class="nav-item" href="${href(link.href)}">${label}</a></li>`;
};

/**
 * The server switcher: a link to the server list, styled as the design's switcher. It is the one
 * place a server page shows the server's name; the shell knows no member count or other server
 * data, so it shows none. It links to the list itself (SERVER_LIST), never plain /, which sends
 * someone with one server and one page straight back to that page.
 */
const switcher = (guild: ServerIdentity): SafeHtml =>
  html`<a class="server-switch" href="${SERVER_LIST}">${serverAvatar(guild)}<span class="server-switch__text"><span class="server-switch__name">${untrusted(guild.name)}</span> <span class="server-switch__hint">Switch server</span></span>${icon("chevron-right")}</a>`;

/**
 * The account menu: a disclosure, so it opens without script. Sign-out is a POST (E1), so each
 * action is a form, and each carries the session's form token like every other POST form; the
 * form still sends the urlencoded type that formOnly() requires. Sign-in, by contrast, is a link
 * (views/servers.ts).
 */
const account = (token: string): SafeHtml => html`<details class="account">
<summary class="account__summary">Account${icon("chevron-down")}</summary>
<div class="account__menu">
<p class="orr-label account__caption">Signed-in session</p>
${postForm(
  { action: PATHS.logout, token },
  html`<button type="submit" class="orr-btn orr-btn--ghost orr-btn--block account__action">${icon("log-out")}Sign out</button>`,
)}
${postForm(
  { action: PATHS.logoutAll, token },
  html`<button type="submit" class="orr-btn orr-btn--ghost orr-btn--block account__action">${icon("log-out")}Sign out everywhere</button>`,
)}
</div>
</details>`;

/** The account menu when the model is signed in, else nothing. */
const accountMenu = (model: LayoutModel): SafeHtml | "" =>
  model.signedIn ? account(model.formToken) : "";

/**
 * The entry pages' backdrop: the starfield and the orbit rings, fixed behind the page so they take
 * no space (nothing moves on a phone), and hidden from assistive technology as pure decoration.
 */
const BACKDROP = html`<div class="orr-starfield entry-backdrop" aria-hidden="true"><div class="orr-orbit entry-orbit"><div class="orr-orbit__ring"><span class="orr-orbit__planet orr-orbit__planet--violet"></span></div><div class="orr-orbit__ring orr-orbit__ring--dashed orr-orbit__ring--middle"></div><div class="orr-orbit__ring orr-orbit__ring--inner"><span class="orr-orbit__planet"></span></div></div></div>`;

const FOOTER = html`<footer class="site-footer">
<p>${BRAND} ${project.version} · <a href="${href(project.url)}">Source code</a> · <a href="${href(`${project.url}/blob/${project.branch}/LICENSE`)}">License (${project.license})</a> · <a href="${NOTICES.path}">Third-party licenses</a></p>
</footer>`;

/**
 * The page header: the one `<h1>`, after an eyebrow on server pages and the sign-in page. Error
 * pages never get the eyebrow, because their message must be main's first paragraph.
 */
const pageHeader = (title: string, eyebrow: boolean): SafeHtml =>
  html`<header class="page-header">
${eyebrow ? html`<p class="orr-label page-header__eyebrow">Free Company workspace</p>` : ""}
<h1 class="page-header__title">${title}</h1>
</header>`;

/** A server page: the sidebar, the top bar with the page's label, then the page. */
function consolePage(
  model: LayoutModel,
  guild: NonNullable<LayoutModel["guild"]>,
  main: SafeHtml,
): SafeHtml {
  const side = SIDE_NOTE[guild.audience ?? "officer"];
  return html`<body class="console-page">
<a class="skip" href="#main">Skip to content</a>
<div class="app">
<header class="sidebar">
${WORDMARK}
${switcher(guild)}
<nav class="side-nav" aria-label="Server pages">
<p class="orr-label side-nav__caption">Workspace</p>
<ul class="side-nav__list">${guild.nav.map(navItem)}</ul>
<div class="side-nav__context"><p>${side.caption}</p><p class="side-nav__note">${icon("info")}${side.note}</p></div>
</nav>
${accountMenu(model)}
</header>
<div class="frame">
<div class="topbar" aria-hidden="true"><p class="orr-label">Workspace<span class="topbar__separator">/</span><span class="topbar__page">${model.title}</span></p></div>
<main id="main" class="main orr-enter">
${pageHeader(model.title, true)}
${main}
</main>
${FOOTER}
</div>
</div>
</body>`;
}

/** Any other page, on the starfield; the sign-in page (titled with the brand) is the welcome. */
function entryPage(model: LayoutModel, main: SafeHtml): SafeHtml {
  const welcome = model.title === BRAND;
  return html`<body class="entry-page">
<a class="skip" href="#main">Skip to content</a>
${BACKDROP}
${welcome ? "" : html`<header class="entry-bar">${WORDMARK}${accountMenu(model)}</header>`}
<main id="main" class="${welcome ? "entry entry--welcome" : "entry"} orr-enter">
${pageHeader(model.title, welcome)}
${main}
</main>
${FOOTER}
</body>`;
}

/** The whole document around `main`. Views never render `<h1>`, `<html>` or the sign-out forms. */
export function layout(model: LayoutModel, main: SafeHtml): SafeHtml {
  const named = model.title === BRAND ? BRAND : `${model.title} · ${BRAND}`;
  const title = model.error ? `Error: ${named}` : named;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title}</title>
<link rel="icon" href="${FAVICON.path}" type="${FAVICON.contentType}">
<link rel="stylesheet" href="${STYLESHEET.path}">
</head>
${model.guild ? consolePage(model, model.guild, main) : entryPage(model, main)}
</html>
`;
}

/** An error page's heading and the sentence shown when there is no approved message. */
interface ErrorWording {
  readonly heading: string;
  readonly sentence: string;
}

/**
 * Fixed wording per status. A 404 never says whether a server exists or uses TaruBot, and a 403
 * covers both a missing page flag and a refused cross-site form, so neither leaks which it was. A
 * page refusing a GET for access says so in its own words instead (server.ts's notOpen): a GET
 * is never a form, so there is nothing to leak.
 */
const ERROR_WORDING: Readonly<Partial<Record<number, ErrorWording>>> = {
  400: { heading: "Request not valid", sentence: "TaruBot couldn't use that request." },
  403: {
    heading: "Not allowed",
    sentence: "You don't have access to this, or the request didn't come from TaruBot's own pages.",
  },
  404: {
    heading: "Page not found",
    sentence: "There's no page here, or it isn't open to you.",
  },
  405: { heading: "Not allowed here", sentence: "This page can't be used that way." },
  409: {
    heading: "That didn't go through",
    sentence: "Something changed while you were working. Go back, reload and try again.",
  },
  413: { heading: "Request too large", sentence: "TaruBot didn't read a request this large." },
  415: { heading: "Unsupported request", sentence: "TaruBot accepts only its own forms here." },
  429: { heading: "Too many requests", sentence: "Wait a moment, then try again." },
  500: {
    heading: "Something went wrong",
    sentence:
      "TaruBot hit an unexpected problem. If it keeps happening, tell an officer and include the Ref below.",
  },
  503: {
    heading: "Temporarily unavailable",
    sentence: "TaruBot can't do this right now. Try again in a few minutes.",
  },
};

/**
 * Headings for a refusal its status would misname, by its catalog code. A restart answers 429,
 * whose "Too many requests" would blame the person for something they didn't do; the shutdown
 * check in server.ts and an application's pre-commit check throw the same refusal, so the heading
 * goes with the code, not with the route that threw it.
 */
const CODE_HEADINGS: Readonly<Partial<Record<string, string>>> = {
  stopping: "TaruBot is restarting",
};

/** For a status the table doesn't name; every status the app answers has its own entry. */
const GENERIC_WORDING: ErrorWording = {
  heading: "Error",
  sentence: "TaruBot couldn't complete that request.",
};

/**
 * A Retry-After in words: seconds up to two minutes, then whole minutes, rounded up so the reader
 * never retries early (a page's POST budget can ask for up to ten minutes).
 */
function waitText(seconds: number): string {
  if (seconds < 120) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * An error document: a heading by status, then a card with the approved message as escaped text
 * when there is one (a fixed sentence per status otherwise), `Code <code> · Ref <ref>` and a way
 * home. Never the error's own text: Problem.message is already null for anything that isn't an
 * approved Failure. The message stays main's first paragraph, which tests read as the message.
 * `formToken` is the session's when the request was signed in (the account menu's forms carry
 * it), null otherwise. `frame` is what the route added (ErrorFrame): another heading, and a link
 * back to the page a refused form came from, ahead of the start page's.
 */
export function errorPage(
  details: Problem,
  formToken: string | null,
  frame: ErrorFrame = {},
): SafeHtml {
  const wording = ERROR_WORDING[details.status] ?? GENERIC_WORDING;
  const heading = frame.heading ?? CODE_HEADINGS[details.code] ?? wording.heading;
  const wait =
    details.retryAfter > 0 ? html`<p>Try again in about ${waitText(details.retryAfter)}.</p>` : "";
  const back = frame.back
    ? html`<a class="orr-btn orr-btn--secondary" href="${href(frame.back.href)}">Back to ${frame.back.label}</a>`
    : "";
  return layout(
    formToken === null
      ? { title: heading, signedIn: false }
      : { title: heading, signedIn: true, formToken },
    html`<div class="orr-card entry-panel">
<p class="entry-panel__lead">${details.message ?? wording.sentence}</p>
${wait}
<p class="ref">Code <code>${details.code}</code> · Ref <code>${details.ref}</code></p>
<p class="entry-panel__actions">${back}<a class="orr-btn orr-btn--secondary" href="${PATHS.home}">Go to the ${BRAND} start page</a></p>
</div>`,
  );
}
