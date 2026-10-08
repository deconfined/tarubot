/**
 * The viewer's preferences and the printed page, last in the stylesheet so they win:
 * - reduced motion stops all of the design's motion: the ambient loops it already stopped, plus
 *   the page entrance, the spinner, the button sheen and press, and every lift and transition
 *   (D10);
 * - reduced transparency swaps every glass surface for a solid one;
 * - forced colors (Windows contrast themes) drop the box-shadows the design draws every edge
 *   with, so cards, badges, buttons and the current page get real borders (D33). Focus is already
 *   an outline (base.ts), which forced colors keep.
 * - print is dark text on white without the shell, the backdrops, glass, glow or motion (D18);
 *   a dark-only page would otherwise print pale text that browsers strip of its background.
 *
 * `!important` appears only where a preference must beat every component rule at once.
 */
export const MEDIA_CSS = `/* Preferences and print */
@media (prefers-reduced-motion: reduce) {
  .orr-enter,
  .orr-holo-text,
  .orr-holo-edge::before,
  .orr-starfield::before,
  .orr-orbit__ring,
  .orr-pulse-dot,
  .orr-spinner,
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
  .orr-card--interactive:hover,
  .orr-card--interactive:focus-visible,
  .server-tile__link:hover > .orr-icon:last-child {
    transform: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  .orr-glass,
  .orr-glass-strong,
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
  .orr-badge,
  .check,
  .marker,
  .orr-tag,
  .orr-kbd,
  .notice,
  .empty-state,
  .feature,
  .server-switch,
  .account__summary,
  .account__menu {
    border: 1px solid CanvasText;
  }
  .orr-btn {
    border: 1px solid ButtonText;
  }
  .nav-item[aria-current="page"] {
    outline: 2px solid CanvasText;
    outline-offset: -2px;
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
  .orr-holo-text {
    -webkit-text-fill-color: currentColor;
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
  .orr-badge,
  .orr-btn,
  .check,
  .marker,
  .notice,
  .empty-state,
  .feature {
    border: 1px solid #888;
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
