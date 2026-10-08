/**
 * The dashboard's inline icons: Lucide path data from lucide-static 0.460.0, under the ISC license
 * with portions from Feather under MIT. notices.ts carries both notices, served as the
 * "Third-party licenses" asset every page footer links to.
 *
 * Each icon is constant markup: the children of the upstream package/icons/<name>.svg inside one
 * shared `<svg class="orr-icon">`. Icons are decorative: aria-hidden (and focusable="false" for
 * old Edge), no `<title>` and no whitespace inside, so the text beside an icon stays the accessible
 * name and an icon never changes an element's textContent, which tests compare exactly. The
 * stylesheet sets the 1em size and the 1.85 stroke width; nothing here writes inline styles, which
 * the CSP blocks. Only icons a page draws are here (web-assets.test.ts checks); to add one, copy
 * the children of its file from the same lucide-static version, with the whitespace between
 * elements removed.
 */
import { html, type SafeHtml } from "./html.js";

/** The element every icon shares; only the children differ. */
const svg = (children: SafeHtml): SafeHtml =>
  html`<svg class="orr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;

/** The icons the dashboard's pages draw, by lucide-static name. */
const ICONS = {
  activity: svg(
    html`<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>`,
  ),
  "chevron-down": svg(html`<path d="m6 9 6 6 6-6"/>`),
  "chevron-right": svg(html`<path d="m9 18 6-6-6-6"/>`),
  "circle-check": svg(html`<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>`),
  "circle-x": svg(html`<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>`),
  clock: svg(html`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`),
  compass: svg(
    html`<path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z"/><circle cx="12" cy="12" r="10"/>`,
  ),
  info: svg(html`<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>`),
  list: svg(
    html`<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>`,
  ),
  "log-in": svg(
    html`<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/>`,
  ),
  "log-out": svg(
    html`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>`,
  ),
  "refresh-cw": svg(
    html`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  ),
  server: svg(
    html`<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>`,
  ),
  settings: svg(
    html`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>`,
  ),
  "triangle-alert": svg(
    html`<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  ),
} as const;

/** An icon's lucide-static name. */
export type IconName = keyof typeof ICONS;

/** Every icon name, for code that checks a name it was given at run time. */
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

/** The decorative inline icon `name`, ready to place before or after a label. */
export function icon(name: IconName): SafeHtml {
  return ICONS[name];
}
