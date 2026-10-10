/**
 * The / page body (#43, ADR D17): a sign-in link for visitors, or the servers the signed-in user
 * may open, each with links to the pages that admit them. Also the "no access" body shown after a
 * sign-in that admits no server (no session is created then). Pure: typed data in, markup out.
 *
 * These are entry pages (layout.ts): the sign-in is the design's login card beside the welcome
 * copy, and each server is a tile with its initials, its name and its page links
 * (styles/entry.ts).
 */
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { PATHS } from "../http.js";
import { icon } from "../icons.js";
import { type NavLink, type ServerIdentity, serverAvatar } from "../layout.js";

/** One listed server: its ID and untrusted name (always escaped), and its admitted pages. */
export interface ServerLink extends ServerIdentity {
  /** The server's admitted pages; never empty. */
  readonly links: readonly NavLink[];
}

/**
 * / for a visitor (a sign-in link to /login: a plain link, because browsers apply form-action to
 * the redirect) or for a signed-in user.
 */
export type HomeView =
  | { readonly signedIn: false }
  | { readonly signedIn: true; readonly servers: readonly ServerLink[] };

/**
 * Who the pages are for, in the words of the access rule (access.ts's flags, 2.40.0): the bound
 * Member or Guest role held now, which opens My roles, and actor.officer, which opens the officers'
 * pages too.
 */
const AUDIENCE =
  "Anyone with the server's Member or Guest role can sign in to pick their roles. Officers can also sign in to manage TaruBot.";

/**
 * The exception to AUDIENCE, for the "no access" answers only: members and guests are refused
 * while TaruBot holds Administrator in the server (owner decision A2), however briefly (drift
 * after members were let in, say). Someone with Member reading AUDIENCE alone would be told the
 * opposite of what just happened to them. A constant sentence: it never says which server, or
 * that TaruBot holds Administrator there, to someone who may not belong to it.
 */
const EXCEPTION =
  "While officers sort out TaruBot's permissions in a server, only officers can sign in there. If you already have the Member or Guest role, ask an officer.";

/**
 * The sign-in link (/login takes no return path here, so it comes back to this list): the view's
 * one primary, holographic button, the design's whole holographic budget for a button.
 */
const SIGN_IN = html`<a class="orr-btn orr-btn--primary orr-btn--lg orr-btn--block" href="${PATHS.login}">${icon("log-in")}Sign in with Discord</a>`;

/** The visitor's page: what the dashboard is for, and the sign-in card. */
const WELCOME = html`<section class="welcome-copy" aria-labelledby="welcome-description">
<h2 id="welcome-description" class="welcome-copy__title">Your Free Company, at a glance.</h2>
<p class="welcome-copy__lead">Pick your roles in your FC's server. Officers also get a clear view of its configuration, health and background work.</p>
<dl class="features">
<div class="feature"><dt><span class="feature__icon">${icon("user")}</span>Pick your roles</dt><dd>Choose from the roles your officers offer, like pronouns and games. Discord shows them on your profile.</dd></div>
<div class="feature"><dt><span class="feature__icon">${icon("settings")}</span>Know what's configured</dt><dd>Officers review the FC, access roles, channels and onboarding in one place.</dd></div>
<div class="feature"><dt><span class="feature__icon feature__icon--violet">${icon("activity")}</span>See what needs attention</dt><dd>Officers check server health and inspect the work TaruBot is carrying out.</dd></div>
</dl>
</section>
<section class="sign-in orr-card orr-card--holo orr-holo-edge" aria-labelledby="sign-in-heading">
<p class="orr-label">Your workspace</p>
<h2 id="sign-in-heading" class="sign-in__title">Start with Discord.</h2>
<p class="sign-in__text">Sign in to find the servers you have access to.</p>
${SIGN_IN}
<div class="orr-hairline"></div>
<details class="disclosure"><summary>Who can sign in?</summary>
<p>${AUDIENCE}</p>
<p>Signing in asks Discord only who you are. TaruBot checks your server access and keeps no Discord token.</p>
</details>
<p class="sign-in__status">${icon("activity")}<span>Is TaruBot up? <a href="${PATHS.status}">Check its status</a> without signing in.</span></p>
</section>`;

/** One page link on a server tile. */
const pageLink = (link: NavLink): SafeHtml =>
  html`<li><a class="server-tile__link" href="${href(link.href)}">${link.icon ? icon(link.icon) : ""}<span class="server-tile__label">${link.label}</span>${icon("chevron-right")}</a></li>`;

/** One server: its initials, its name (isolated once) and its page links. */
const serverTile = (server: ServerLink): SafeHtml =>
  html`<li class="server-tile orr-card">
<div class="server-tile__head">${serverAvatar(server)}<div class="server-tile__titles"><p class="orr-label">Discord server</p><h2 class="server-tile__name">${untrusted(server.name)}</h2></div></div>
<p class="note">Open a page in this workspace.</p>
<ul class="server-tile__links">${server.links.map(pageLink)}</ul>
</li>`;

/** The / page's main content. */
export function renderHome(view: HomeView): SafeHtml {
  if (!view.signedIn) return WELCOME;
  if (view.servers.length === 0)
    return html`<section class="orr-card entry-panel" aria-labelledby="no-servers">
<h2 id="no-servers">No workspaces available</h2>
<p>You don't have access to TaruBot's pages in any server right now.</p>
<p>${AUDIENCE} If you've just been given access, check again in a minute.</p>
<p>${EXCEPTION}</p>
</section>`;
  return html`<p class="lead">Choose a workspace. Each one lists the pages open to you there.</p>
<ul class="servers">${view.servers.map(serverTile)}</ul>`;
}

/**
 * After a sign-in that admits no server: what the web pages are for, and who may use them. It asks
 * someone just given access to sign in again, so it offers that first (a plain link to /login, as
 * on the welcome page), then the start page.
 */
export function renderNoAccess(): SafeHtml {
  return html`<div class="orr-card entry-panel">
<p class="entry-panel__lead">You signed in with Discord, but you don't have access to TaruBot's pages in any server.</p>
<p>${AUDIENCE} If you've just been given access, wait a minute and sign in again.</p>
<p>${EXCEPTION}</p>
<p class="note">TaruBot didn't keep a session for you, so you aren't signed in.</p>
<p class="entry-panel__actions"><a class="orr-btn orr-btn--secondary" href="${PATHS.login}">${icon("log-in")}Sign in again</a><a class="orr-btn orr-btn--secondary" href="${PATHS.home}">Go to the TaruBot start page</a></p>
</div>`;
}
