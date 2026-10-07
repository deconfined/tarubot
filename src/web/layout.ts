/**
 * The page shell (#43, ADR E12): `lang="en"`, the viewport, the hashed stylesheet and favicon, one
 * `<h1>`, the server navigation, the sign-out forms and a footer with the version and the source
 * and license links (AGPL-3.0 §13). Pure: it renders what it is given and reads no state.
 *
 * Markup rules every page inherits (tests/unit/web-pages.test.ts checks the rendered output): no
 * `style=` attribute and no script (the CSP allows neither), exactly one `<h1>` (the title), a
 * visible text label on every control, and untrusted text only through untrusted().
 */
import { project } from "../config/project.js";
import type { Actor } from "../domain/policy.js";
import { admits } from "./access.js";
import { FAVICON, STYLESHEET } from "./assets.js";
import { href, html, type SafeHtml, untrusted } from "./html.js";
import { PATHS, type Problem } from "./http.js";
import type { Page } from "./page.js";

/** One navigation link; `href` is a page href or a PATHS value. */
export interface NavLink {
  readonly href: string;
  /** Constant page wording (Page.nav), not untrusted text. */
  readonly label: string;
  /** Marked aria-current="page". */
  readonly current: boolean;
}

/** What the shell shows around a page's main content. */
export interface LayoutModel {
  /** The `<title>` (with " · TaruBot") and the one `<h1>`. */
  readonly title: string;
  /**
   * Signed in: the header shows "Sign out" (POST /logout) and "Sign out everywhere" (POST
   * /logout/all), as forms.
   */
  readonly signedIn: boolean;
  /** The current server: its name (untrusted text) and the pages in it that admit the viewer. */
  readonly guild?: { readonly name: string; readonly nav: readonly NavLink[] };
}

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
    }));
}

/** One navigation item; the label is constant wording and the target passes href(). */
const navItem = (link: NavLink): SafeHtml =>
  link.current
    ? html`<li><a href="${href(link.href)}" aria-current="page">${link.label}</a></li>`
    : html`<li><a href="${href(link.href)}">${link.label}</a></li>`;

/**
 * Sign-out is a POST (E1), so it is a form; the empty form still sends the urlencoded type that
 * formOnly() requires. Sign-in, by contrast, is a link (servers.ts).
 */
const ACCOUNT = html`<details class="account">
  <summary>Account</summary>
  <div class="account-menu">
    <form method="post" action="${PATHS.logout}">
      <button type="submit" class="secondary">Sign out</button>
    </form>
    <form method="post" action="${PATHS.logoutAll}">
      <button type="submit" class="secondary">Sign out everywhere</button>
    </form>
  </div>
</details>`;

/** The whole document around `main`. Views never render `<h1>`, `<html>` or the sign-out forms. */
export function layout(model: LayoutModel, main: SafeHtml): SafeHtml {
  const title = model.title === BRAND ? BRAND : `${model.title} · ${BRAND}`;
  const guild = model.guild;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${FAVICON.path}" type="${FAVICON.contentType}">
<link rel="stylesheet" href="${STYLESHEET.path}">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600&amp;family=Martian+Mono:wght@400;500&amp;display=swap">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="masthead">
<div class="bar">
<a class="brand" href="${PATHS.home}"><img src="${FAVICON.path}" alt="" width="28" height="28">${BRAND}</a>
${guild ? html`<a class="server-switch" href="${PATHS.home}">Switch server</a>` : ""}
${model.signedIn ? ACCOUNT : ""}
</div>
</header>
<div class="${guild ? "workspace console" : "workspace landing"}">
${
  guild
    ? html`<nav class="server-nav" aria-label="Server pages">
<p class="server">${untrusted(guild.name)}</p>
<ul class="links">${guild.nav.map(navItem)}</ul>
</nav>`
    : ""
}
<main id="main">
<h1>${model.title}</h1>
${main}
</main>
</div>
<footer class="site-footer">
<p>${BRAND} ${project.version} · <a href="${href(project.url)}">Source code</a> · <a href="${href(`${project.url}/blob/${project.branch}/LICENSE`)}">License (${project.license})</a></p>
</footer>
</body>
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
 * covers both a missing page flag and a refused cross-site form, so neither leaks which it was.
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

/** For a status the table doesn't name; every status the app answers has its own entry. */
const GENERIC_WORDING: ErrorWording = {
  heading: "Error",
  sentence: "TaruBot couldn't complete that request.",
};

/**
 * An error document: a heading by status, the approved message as escaped text when there is one
 * (a fixed sentence per status otherwise), and `Code <code> · Ref <ref>`. Never the error's own
 * text: Problem.message is already null for anything that isn't an approved Failure.
 */
export function errorPage(details: Problem, signedIn: boolean): SafeHtml {
  const wording = ERROR_WORDING[details.status] ?? GENERIC_WORDING;
  const wait =
    details.retryAfter > 0
      ? html`<p>Try again in about ${details.retryAfter} ${details.retryAfter === 1 ? "second" : "seconds"}.</p>`
      : "";
  return layout(
    { title: wording.heading, signedIn },
    html`<p>${details.message ?? wording.sentence}</p>
${wait}
<p class="ref">Code <code>${details.code}</code> · Ref <code>${details.ref}</code></p>
<p><a href="${PATHS.home}">Go to the ${BRAND} start page</a></p>`,
  );
}
