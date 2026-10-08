/**
 * Base element styles for the dashboard: the Orrery design system's styles/base.css (box sizing,
 * the dark body, quiet headings, links, code, selection and scrollbars), plus what every TaruBot
 * page needs on top of it: an outline focus ring, the skip link, a visually hidden utility and the
 * default look of headings inside a page.
 *
 * The page background is split in two. The root carries the flat --bg-app color, and the body
 * stays transparent, so a backdrop that a frame fixes behind the page at z-index -1 (the console's
 * nebula wash, the entry pages' starfield) paints above the root color and below the content.
 * A body background would paint over that backdrop.
 */
export const BASE_CSS = `/* Base: from the Orrery design system's styles/base.css */
*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
  background: var(--bg-app);
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100dvh;
  color: var(--text-primary);
  font: var(--type-body);
  letter-spacing: var(--tracking-ui);
  overflow-wrap: anywhere;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

h1,
h2,
h3,
h4,
p {
  margin: 0;
}

h1,
h2,
h3 {
  font-weight: 400;
  letter-spacing: var(--tracking-display);
  text-wrap: balance;
}

p {
  text-wrap: pretty;
}

a {
  color: var(--text-link);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease-out);
}

/*
 * The design's link hover, at zero specificity: a component that is a link (a button, a card, a
 * nav item, the wordmark) sets its own color and decoration, and the underline and link color must
 * not bleed into it, such as the holographic sign-in button turning cyan and underlined.
 */
:where(a:hover) {
  color: var(--text-link-hover);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-thickness: 1px;
}

code,
kbd {
  font: var(--type-code);
}

::selection {
  background: oklch(0.8 0.13 210 / 0.32);
  color: var(--text-primary);
}

* {
  scrollbar-width: thin;
  scrollbar-color: var(--night-600) transparent;
}

button,
input,
select,
textarea {
  font: inherit;
  color: inherit;
  letter-spacing: inherit;
}

/*
 * Focus is an outline, which forced-colors mode keeps; the design's box-shadow ring would vanish
 * there. Components may add a glow beside it, as decoration only.
 */
:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.skip {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: calc(var(--z-tooltip) + 1);
  padding: 8px 14px;
  border-radius: var(--radius-md);
  background: var(--surface-2);
  color: var(--text-primary);
  font: var(--type-ui);
  transform: translateY(calc(-100% - 24px));
}

.skip:focus {
  transform: none;
}

/* Present for assistive technology, invisible on screen. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* Headings in a page: section titles in the serif at 28px, its smallest size; the rest in sans. */
main h2 {
  color: var(--text-primary);
  font: var(--type-h3);
  font-synthesis: none;
}

main h3 {
  color: var(--text-primary);
  font: var(--type-subtitle);
  letter-spacing: var(--tracking-ui);
}
`;
