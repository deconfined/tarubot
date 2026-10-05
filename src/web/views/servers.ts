/**
 * The / page body (#43, ADR D17): a sign-in link for visitors, or the servers the signed-in user
 * may open, each with links to the pages that admit them. Also the "no access" body shown after a
 * sign-in that admits no server (no session is created then). Pure: typed data in, markup out.
 */
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { PATHS } from "../http.js";
import type { NavLink } from "../layout.js";

/** One listed server. `name` is untrusted text (the Discord server name) and is always escaped. */
export interface ServerLink {
  readonly name: string;
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
 * Who the pages are for, in the words of the access rule: actor.officer after enrichment, which
 * is Discord's Manage Server permission or the server's Officer role with officer rank access.
 */
const AUDIENCE =
  "The pages are for FC officers: members with Discord's Manage Server permission, or with the server's Officer role and officer rank access.";

/** The sign-in link (/login takes no return path here, so it comes back to this list). */
const SIGN_IN = html`<p><a class="button" href="${PATHS.login}">Sign in with Discord</a></p>`;

/** One server and its page links. */
const serverItem = (server: ServerLink): SafeHtml =>
  html`<li>
<p class="server">${untrusted(server.name)}</p>
<ul class="links">${server.links.map((link) => html`<li><a href="${href(link.href)}">${link.label}</a></li>`)}</ul>
</li>`;

/** The / page's main content. */
export function renderHome(view: HomeView): SafeHtml {
  if (!view.signedIn)
    return html`<p>TaruBot's web pages show a server's officers how TaruBot is doing there.</p>
<p>${AUDIENCE}</p>
${SIGN_IN}
<p class="note">Signing in asks Discord only who you are. TaruBot then checks your roles in each server, the same way it does for slash commands, and keeps no Discord token.</p>`;
  if (view.servers.length === 0)
    return html`<p>You don't have access to TaruBot's pages in any server right now.</p>
<p>${AUDIENCE} If you've just been given access, check again in a minute.</p>`;
  return html`<h2>Your servers</h2>
<ul class="servers">${view.servers.map(serverItem)}</ul>`;
}

/** After a sign-in that admits no server: what the web pages are for, and who may use them. */
export function renderNoAccess(): SafeHtml {
  return html`<p>You signed in with Discord, but you don't have access to TaruBot's pages in any server.</p>
<p>${AUDIENCE} If you think you should have access, ask an officer.</p>
<p>TaruBot didn't keep a session for you, so you aren't signed in.</p>
<p><a href="${PATHS.home}">Go to the TaruBot start page</a></p>`;
}
