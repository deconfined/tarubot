/**
 * The viewer's preferences and the printed page, last in the stylesheet so they win:
 * - reduced motion stops all of the design's motion: the ambient loops it already stopped, plus
 *   the page entrance, the button sheen and press, the server links' arrow nudge and every
 *   transition. Every rule that starts an animation lists its selector here, and
 *   web-assets.test.ts checks that none is missing. This is the loops' only off switch: they keep
 *   looping otherwise (the owner accepted the WCAG 2.2.2 finding on 2026-10-08, see effects.ts);
 * - reduced transparency swaps every glass surface for a solid one;
 * - forced colors (Windows contrast themes) drop the box-shadows the design draws every edge
 *   with, so cards, status badges, buttons, the error summary and the current page get real
 *   borders, and form fields a CanvasText one. Focus is already an outline (base.ts), which forced
 *   colors keep; checkboxes and radios are native, so the theme draws them itself.
 * - print is dark text on white without the shell, the backdrops, glass, glow or motion; a
 *   dark-only page would otherwise print pale text that browsers strip of its background. A
 *   form's button row stays in its place on paper rather than stick to a page's foot.
 *
 * `!important` appears only where a preference must beat every component rule at once.
 */
export const MEDIA_CSS = `/* Preferences and print */
@media (prefers-reduced-motion: reduce) {
  .orr-enter,
  .orr-holo-edge::before,
  .orr-starfield::before,
  .orr-orbit__ring,
  .orr-btn--primary {
    animation: none !important;
  }
  *,
  *::before,
  *::after {
    transition-duration: 0s !important;
  }
  .orr-btn--primary::after {
    display: none;
  }
  .orr-btn:active:not(:disabled),
  .server-tile__link:hover > .orr-icon:last-child {
    transform: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .orr-card,
  .orr-btn--secondary,
  .feature {
    background: var(--surface-1);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .sidebar,
  .topbar {
    background: var(--bg-raised);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .server-switch {
    background: var(--surface-2);
  }
}

@media (forced-colors: active) {
  .orr-card,
  .check,
  .marker,
  .notice,
  .empty-state,
  .feature,
  .server-switch,
  .account__summary,
  .account__menu,
  .orr-input,
  .error-summary {
    border: 1px solid CanvasText;
  }
  .orr-btn {
    border: 1px solid ButtonText;
  }
  .nav-item[aria-current="page"] {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
  }
  /* The current page's outline marks the page, so focus there needs a ring of its own. */
  .nav-item[aria-current="page"]:focus-visible {
    outline: 2px solid Highlight;
    outline-offset: 2px;
  }
  .orr-holo-edge::before,
  .orr-starfield::before,
  .entry-orbit,
  .console-page::before {
    display: none;
  }
}

@media print {
  /* Light paper: without this the dark color scheme would give the canvas a dark default. */
  :root {
    color-scheme: light;
  }
  *,
  *::before,
  *::after {
    color: #000 !important;
    background: transparent !important;
    box-shadow: none !important;
    text-shadow: none !important;
    filter: none !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    animation: none !important;
    transition: none !important;
  }
  html {
    background: #fff !important;
  }
  .skip,
  .sidebar,
  .topbar,
  .entry-bar,
  .entry-backdrop,
  .console-page::before,
  .orr-holo-edge::before {
    display: none !important;
  }
  .app {
    display: block;
  }
  .main,
  .entry {
    max-width: none;
    padding: 0;
  }
  a {
    text-decoration: underline;
  }
  .orr-card,
  .orr-btn,
  .check,
  .marker,
  .notice,
  .empty-state,
  .feature,
  .orr-input,
  .error-summary {
    border: 1px solid #888;
  }
  .form-actions {
    position: static;
    border: 0;
  }
  .orr-card,
  .feature,
  .orr-table tr {
    break-inside: avoid;
  }
  .table-scroll {
    overflow: visible;
  }
}
`;
