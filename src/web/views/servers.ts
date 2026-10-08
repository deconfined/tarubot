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
  html`<li class="server-card">
<p class="eyebrow">Discord server</p>
<h2>${untrusted(server.name)}</h2>
<p class="note">Open a page in this workspace.</p>
<ul class="links workspace-links">${server.links.map((link) => html`<li><a href="${href(link.href)}">${link.label}<span aria-hidden="true">→</span></a></li>`)}</ul>
</li>`;

/** The / page's main content. */
export function renderHome(view: HomeView): SafeHtml {
  if (!view.signedIn)
    return html`<div class="welcome">
<section class="welcome-copy" aria-labelledby="welcome-description">
<h2 id="welcome-description">Your Free Company, at a glance.</h2>
<p class="welcome-lead">A clear view of your server's configuration, health and background work. Connected to Discord, built around your company.</p>
<dl class="welcome-features">
<div><dt>Know what's configured</dt><dd>Review your FC, access roles, channels and onboarding in one place.</dd></div>
<div><dt>See what needs attention</dt><dd>Check server health and inspect the work TaruBot is carrying out.</dd></div>
</dl>
</section>
<section class="entry-card" aria-labelledby="sign-in-heading">
<p class="eyebrow">Your workspace</p>
<h2 id="sign-in-heading">Start with Discord.</h2>
<p>Sign in to find the servers you have access to.</p>
${SIGN_IN}
<p class="note">The dashboard is currently read-only. Changes stay in Discord.</p>
<details class="access-details"><summary>Who can use the dashboard?</summary>
<p>${AUDIENCE}</p>
<p>Signing in asks Discord only who you are. TaruBot checks your server access and keeps no Discord token.</p>
</details>
</section>
</div>`;
  if (view.servers.length === 0)
    return html`<section class="empty-state">
<h2>No workspaces available</h2>
<p>You don't have access to TaruBot's pages in any server right now.</p>
<p>${AUDIENCE} If you've just been given access, check again in a minute.</p>
</section>`;
  return html`<p class="lead">Choose a workspace to review its configuration and see how TaruBot is doing.</p>
<ul class="servers">${view.servers.map(serverItem)}</ul>`;
}

/** After a sign-in that admits no server: what the web pages are for, and who may use them. */
export function renderNoAccess(): SafeHtml {
  return html`<section class="empty-state">
<p>You signed in with Discord, but you don't have access to TaruBot's pages in any server.</p>
<p>${AUDIENCE} If you think you should have access, ask an officer.</p>
<p class="note">TaruBot didn't keep a session for you, so you aren't signed in.</p>
<p><a class="button secondary" href="${PATHS.home}">Go to the TaruBot start page</a></p>
</section>`;
}
