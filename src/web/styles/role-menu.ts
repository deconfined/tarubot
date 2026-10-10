/**
 * The Role menu page's own rules (views/role-menu.ts), phones first and dense: the intro (one
 * sentence, a small line, the address to share), the banners under it, the summary card (the
 * view's one holographic card), then the categories as compact cards, one column on phones and
 * tablets and two from 72rem, and Add a category as one row on a wide screen.
 *
 * A category's card reads in three bands: a head of one line (the name, the pick rule and how many
 * roles, then the state badges at the line's end) with the description under it; the roles as
 * mention chips that wrap or, when any role has a description, a two-column list: the names in one
 * column, each description and its "Opens:" line beside its name; and a foot with a line on what
 * the state means and what each state button does, then one toolbar. The toolbar holds every
 * action as a compact button: the editors' buttons, the state buttons and the moves (each group
 * wrapping as one unit, never split across rows), and Delete category.
 *
 * The editors (Edit roles, Add roles, Edit category, and Delete category's confirmation) open on
 * top of the page, so nothing on it moves or changes its spacing when one opens (the owner's ask,
 * 2026-10-09): a modal dialog in the top layer (a popover where the browser has no invoker
 * commands), a glass panel over the dimmed, lightly blurred page, which neither scrolls nor takes
 * clicks under it. On a wide screen it opens beside the button that opened it, just under it or
 * above it (the owner's ask, 2026-10-10; anchor positioning, below), or near the top of the screen
 * where the browser can't anchor it; on a phone it is a sheet from the bottom edge. Its body
 * scrolls under its head, so Close stays in view, and its button row is its foot. A refused editor
 * comes back drawn the same way (.overlay--open), centred, fixed over a backdrop of its own. The
 * cards lay out the same whether or not an editor is open.
 *
 * Forms inside a panel or the Add a category card are laid out by its own width (container
 * queries): fields go side by side where there is room, each hint and error under its control so
 * the controls line up.
 *
 * Shared vocabulary (cards, stats, notes, notices, mentions, disclosures, empty states) lives in
 * components.ts and the form controls in forms.ts; this module only arranges them, plus the
 * design's badge, ported here because this was the first view that renders it (My roles uses it
 * too). The one glass added here is an open editor's panel, which has its own reduced-motion,
 * reduced-transparency, forced-colors and print rules below; every other surface is an .orr-card,
 * which media.ts's fallbacks already cover. What is drawn with an inset shadow here (the badge, a
 * panel, a role that needs attention) gets its own forced-colors border, and every control keeps
 * base.ts's focus outline.
 */
import { MENU_LIMITS } from "../../domain/self-roles.js";

/**
 * The editors a card's toolbar opens, as views/role-menu.ts names them after the category's key
 * (EDITOR_IDS), and so in their anchor classes.
 */
const ANCHORED_EDITORS = ["edit-roles", "add-roles", "edit-category", "delete"] as const;

/**
 * One static rule pair per card place and editor, which ties a panel to its button with no style
 * attribute or script (the CSP allows neither): `.anchor-c3-add-roles` names the fourth card's Add
 * roles button `--c3-add-roles`, and `.anchored-c3-add-roles` points that button's panel at it.
 * Anchor names are global to the page, so each takes the card's place as well as the editor;
 * views/role-menu.ts gives the classes by both. A menu holds at most MENU_LIMITS.categories cards,
 * so these cover every one.
 */
const ANCHOR_PAIRS = Array.from({ length: MENU_LIMITS.categories }, (_, at) =>
  ANCHORED_EDITORS.map(
    (editor) => `    .anchor-c${at}-${editor} {
      anchor-name: --c${at}-${editor};
    }

    .anchored-c${at}-${editor} {
      position-anchor: --c${at}-${editor};
    }`,
  ),
)
  .flat()
  .join("\n\n");

export const ROLE_MENU_CSS = `/* Role menu */

/*
 * Badge: the design's short mono, uppercase state word (styles/components.css's .orr-badge), for
 * a category's or a role's state. The text carries the meaning; the tone only reinforces it.
 */
.orr-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 20px;
  padding: 0 8px;
  border-radius: var(--radius-pill);
  font: 500 0.65625rem / 1 var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  white-space: nowrap;
  color: var(--text-secondary);
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-default);
}

.orr-badge--violet {
  color: var(--violet-400);
  background: oklch(0.8 0.13 298 / 0.12);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 298 / 0.3);
}

.orr-badge--success {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.orr-badge--warning {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

/* A callout that needs acting on: the notice in the warning tone. */
.notice--warning {
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.28);
}

.notice--warning > .orr-icon {
  color: var(--warning);
}

/*
 * The intro: the opening sentence, a small line on the one change TaruBot makes unasked, and My
 * roles' address to share, joined to the page header as its description (as shell.ts's
 * .page-header + .lead).
 */
.menu-intro {
  display: grid;
  gap: var(--space-1-5);
  min-width: 0;
}

.page-header + .menu-intro {
  margin-top: calc(var(--space-2) - var(--section-gap));
}

.menu-intro__note {
  max-width: 80ch;
  color: var(--text-muted);
  font: var(--type-caption);
}

/* My roles' address: a label, then the chip, which one click selects whole, ready to copy. */
.menu-share {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-1) var(--space-2);
  min-width: 0;
}

.menu-share > code {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: all;
}

/* The banners, or the setup callout: close under the intro, like a page's notice under its lead. */
.menu-banners {
  display: grid;
  gap: var(--space-2);
}

.menu-intro + .menu-banners,
.menu-intro + .notice {
  margin-top: calc(var(--space-3) - var(--section-gap));
}

/*
 * The summary card, compact. Phones stack the head, the counts and the foot; from 48rem the counts
 * sit beside the heading, as on Server configuration's health snapshot.
 */
.menu-summary > .orr-card__head {
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-3);
}

.menu-summary .orr-card__titles {
  gap: var(--space-1);
}

.menu-summary__title {
  font-size: 1.125rem;
  letter-spacing: var(--tracking-title);
}

/* Where the problems are: links to the cards' headings, under the summary's title. */
.menu-summary__where {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

/* A tone tile behind the mark; the heading's words carry the meaning. */
.menu-summary__mark {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  font-size: 18px;
}

.menu-summary__mark--ok {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.menu-summary__mark--wait {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

.menu-summary__mark--warn {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

/* The counts: two by two on phones, so the columns line up; four across from 40rem. */
.menu-summary__counts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-3) var(--space-6);
  margin: 0;
}

.menu-summary .menu-summary__count {
  gap: var(--space-1);
}

/* A label may wrap on a phone (at 200% text "Not offered" is wider than its column). */
.menu-summary__count > .orr-stat__label {
  overflow-wrap: anywhere;
}

.menu-summary__count > .orr-stat__value {
  font-size: 1.5rem;
}

/*
 * The foot: why publishing matters, at a readable measure, then the page's one primary button at
 * the row's end.
 */
.menu-summary__foot {
  justify-content: space-between;
  gap: var(--space-2) var(--space-4);
}

.menu-summary__foot > .note {
  flex: 1 1 16rem;
  max-width: 80ch;
}

/* A refused Publish N drafts says why on a row of its own, above the button. */
.menu-summary__foot > .form-error {
  flex-basis: 100%;
}

/*
 * Categories: one card each, in the members' order, one column until 72rem and two from there.
 * Cards in a row share its height, so their toolbars line up at the foot. No editor opens inside a
 * card, so that never changes while one is open.
 */
.menu-categories {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

/*
 * The Add a category card's form follows its own width (container queries below); a card is a
 * container too, so its head and roles follow the card's width, which two columns halve.
 */
.menu-category,
.menu-create {
  container-type: inline-size;
}

/*
 * The head: the name, the pick rule and how many roles, then the badges, on one line that wraps,
 * so every card's name starts at its left edge; the description goes under them. The markup puts
 * the badges first, hidden from assistive technology (the heading says the state in words), so
 * only their place on screen moves: nothing in the head takes focus.
 */
.menu-category__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1-5) var(--space-2);
  padding: var(--card-pad) var(--card-pad) 0;
}

/* The success notice (order 0, first), and the description, each take a line of their own. */
.menu-category__head > .notice,
.menu-category__desc {
  flex-basis: 100%;
}

.menu-category__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1-5);
  order: 3;
}

.menu-category__title {
  order: 1;
  min-width: 0;
  font: 600 1.0625rem / 1.3 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
  /*
   * A link to the heading (the error summary's, the summary card's) keeps the card's top edge in
   * view too, clear of the sticky bars the shell's scroll padding already clears.
   */
  scroll-margin-top: 1.5rem;
}

/* The pick rule and the count, set apart by a small dot drawn between them (no text). */
.menu-category__facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  order: 2;
}

.menu-category__facts > * + *::before {
  content: "";
  display: inline-block;
  width: 3px;
  height: 3px;
  margin-inline-end: var(--space-2);
  border-radius: 50%;
  background: currentColor;
  vertical-align: middle;
}

.menu-category__desc {
  order: 4;
  color: var(--text-muted);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/* The roles take what height the row gives the card, so the foot stays at the card's bottom. */
.menu-category__body {
  flex: 1;
  min-width: 0;
  padding: var(--space-3) var(--card-pad) var(--card-pad);
}

/*
 * The roles, as members will see them: mention chips that wrap side by side, a role with a
 * description taking at least 13rem (its description, then "Opens:", under its chip). With any
 * description, a card with room lists its roles in two columns instead (container query below):
 * the names in the first, each description and "Opens:" beside its name. A phone keeps the
 * wrapping chips, so roles without one still share a line.
 */
.menu-options {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu-option {
  display: grid;
  gap: 2px;
  min-width: 0;
  max-width: 100%;
}

.menu-option:has(> .menu-option__desc) {
  flex: 1 1 13rem;
}

/* Without descriptions, "Opens:" follows its chip on the chip's line while it fits. */
.menu-options:not(.menu-options--described) > .menu-option {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: var(--space-2);
}

.menu-options:not(.menu-options--described) > .menu-option > .menu-problems {
  flex-basis: 100%;
}

.menu-option__role {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  overflow-wrap: anywhere;
}

.menu-option__desc {
  color: var(--text-muted);
  font: var(--type-caption);
  overflow-wrap: anywhere;
}

/*
 * "Opens:" and its channel chips, after the role's description, small and muted. A chip moves to
 * the next line whole rather than split at a hyphen ("#valheim-" / "voice"); only a name wider
 * than the line wraps inside its chip.
 */
.menu-option__opens {
  color: var(--text-muted);
  font: var(--type-caption);
}

.menu-option__opens > .mention {
  display: inline-block;
  max-width: 100%;
}

/*
 * A role with a problem takes a row of its own, tinted like a warning callout, so drift stands out
 * among the chips; the warning lines say what is wrong, across the row's full width.
 */
.menu-options > .menu-option--attention {
  flex-basis: 100%;
  grid-column: 1 / -1;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.28);
}

/* A role's problems: warning lines, the icon level with the first line. */
.menu-problems {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
  color: var(--text-secondary);
  font: var(--type-caption);
}

.menu-problems > li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.menu-problems .orr-icon {
  margin-top: 2px;
  color: var(--warning);
}

/* The foot: what the state means and what each state button does, then the toolbar. */
.menu-category__foot {
  display: grid;
  gap: var(--space-2);
  padding: var(--space-3) var(--card-pad) var(--card-pad);
  border-top: 1px solid var(--border-subtle);
}

.menu-category__state {
  max-width: 80ch;
  color: var(--text-muted);
  font: var(--type-caption);
}

/*
 * The toolbar: one row that wraps. A .menu-tool wrapper only keeps an editor's button and its
 * panel together in the markup, so the button is one of the row's items (a closed panel draws
 * nothing, an open one is on top of the page); the state buttons and the moves are each one item,
 * a group that wraps as a unit, so a pair is never split across rows (Move up ending one row, Move
 * down starting the next).
 */
.menu-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.menu-tool {
  display: contents;
}

.menu-states,
.menu-moves {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/*
 * The row's buttons, compact: 32px tall for a mouse, 40px where the pointer is a finger. The
 * forms' own buttons, in the panels, keep their size.
 */
.menu-states .orr-btn,
.menu-moves .orr-btn,
.menu-opener {
  min-height: 2rem;
  padding: var(--space-1) 10px;
  border-radius: var(--radius-sm);
  font: var(--type-ui-sm);
  font-weight: var(--weight-semibold);
}

@media (pointer: coarse) {
  .menu-states .orr-btn,
  .menu-moves .orr-btn,
  .menu-opener {
    min-height: 2.5rem;
  }
}

/* A state or move form in the toolbar is its one button. */
.menu-state,
.menu-move {
  display: flex;
}

/*
 * Move up and Move down only reorder the menu, so they are the row's quietest buttons, apart from
 * the state buttons that change what members see: secondary text on a hairline, with no fill.
 * Hover and focus keep the shared button's look; forced colors keep its border (media.ts).
 */
.menu-moves .orr-btn:not(:hover):not(:focus-visible) {
  color: var(--text-secondary);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

/*
 * An editor's button looks like the state buttons beside it (a secondary button, solid in the
 * card), with a small chevron first that marks it as one that opens a panel rather than acting at
 * once; set a little closer than a button's, so a phone's first row holds the three editors.
 */
.menu-opener {
  gap: var(--space-1-5);
  padding-inline-start: var(--space-2);
}

.menu-opener::before {
  content: "";
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  margin-inline: 1px 2px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: rotate(-45deg);
}

/*
 * While its panel is open the button stays lit, and while it holds a refused form (a conflict,
 * views/role-menu.ts's .menu-opener--kept); a link stands in for it while a refused editor is
 * drawn open. So it is plain which button the panel belongs to once it closes.
 */
.menu-toolbar .menu-opener:is(a, .menu-opener--kept, :has(+ :is(.overlay:modal, .overlay:popover-open))) {
  color: var(--accent-strong);
  background: oklch(0.8 0.13 210 / 0.12);
  box-shadow: inset 0 0 0 1px var(--border-accent);
}

/* Delete category: the row's last item, at its end, in the danger tone. */
.menu-toolbar .menu-opener--danger {
  margin-inline-start: auto;
  color: var(--danger);
}

.menu-toolbar .menu-opener--danger:is(:hover, :focus-visible, :has(+ :is(.overlay:modal, .overlay:popover-open))) {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.45);
}

/*
 * An editor's panel (views/role-menu.ts's panel()): a <dialog>, which a browser without invoker
 * commands opens as a popover instead. A head holds the title (the action, the category's name
 * under it) and Close, then the body, laid out by its own width (a container). A closed one
 * is display: none by the browser's own rules, so nothing here sets the panel's display unless it
 * is open; these base rules replace the browser's dialog and popover look. The panel takes clicks
 * while the page under a popover doesn't (below).
 */
.overlay {
  --card-pad: var(--space-5);
  --overlay-width: 40rem;
  --overlay-foot: var(--card-pad);
  min-width: 0;
  max-width: none;
  padding: 0;
  border: 0;
  color: var(--text-primary);
  pointer-events: auto;
}

/* Edit roles and Add roles put their rows and checklist in columns; a confirmation is short. */
.overlay--wide {
  --overlay-width: 48rem;
}

.overlay--narrow {
  --overlay-width: 32rem;
}

.overlay__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--card-pad) var(--card-pad) var(--space-3);
  border-bottom: 1px solid var(--border-subtle);
}

.overlay__title {
  display: grid;
  gap: 2px;
  min-width: 0;
  color: var(--text-primary);
  font: 600 1.125rem / 1.3 var(--font-display);
  font-synthesis: none;
  letter-spacing: var(--tracking-title);
  overflow-wrap: anywhere;
}

.overlay__subject {
  color: var(--text-muted);
  font: var(--type-caption);
  letter-spacing: normal;
}

.overlay__close {
  flex-shrink: 0;
  min-height: 2rem;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  font: var(--type-ui-sm);
  font-weight: var(--weight-semibold);
  box-shadow: inset 0 0 0 1px var(--border-subtle);
}

@media (pointer: coarse) {
  .overlay__close {
    min-height: 2.5rem;
  }
}

.overlay__body {
  display: grid;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--card-pad) var(--card-pad) var(--overlay-foot);
  container-type: inline-size;
}

/*
 * Open, on top of the page: a modal dialog or a popover in the top layer, or a refused editor
 * drawn open, fixed over its backdrop. As wide as its form needs, its top a fixed way down the
 * screen, so a panel whose content grows (Add roles' list of the roles it can't add) grows
 * downward only and its title stays where it was; at most the screen's height less that margin
 * twice. That is where a panel opens when it isn't anchored to its button (below). The body
 * scrolls under the head, so Close and the title stay in view. Glass over the dimmed page (it sits
 * on no other glass). :is() keeps the rule working in a browser without :popover-open, which would
 * otherwise drop it whole.
 */
:is(.overlay--open, .overlay:popover-open, .overlay:modal) {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-overlay) + 1);
  display: flex;
  flex-direction: column;
  width: min(100% - 2 * var(--space-4), var(--overlay-width));
  height: fit-content;
  max-height: calc(100dvh - 2 * min(12dvh, 6rem));
  margin: min(12dvh, 6rem) auto auto;
  overflow: hidden;
  border-radius: var(--radius-xl);
  background: var(--glass-fill-strong);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  box-shadow:
    inset 0 0 0 1px var(--glass-border),
    var(--glass-edge),
    var(--shadow-3);
}

:is(.overlay--open, .overlay:popover-open, .overlay:modal) > .overlay__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

/* A panel rises into place as it opens (never with reduced motion, below). */
:is(.overlay:popover-open, .overlay:modal) {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}

@starting-style {
  :is(.overlay:popover-open, .overlay:modal) {
    opacity: 0;
    transform: translateY(8px);
  }
}

/*
 * What lies under an open panel: the page, dimmed and lightly blurred, fading in as the panel
 * rises, which a click on closes the panel. A refused editor's backdrop is an element of its own,
 * which takes the page's clicks (only its Close link closes it). Literal values: a ::backdrop may
 * not inherit the tokens.
 */
.overlay::backdrop {
  background: oklch(0.08 0.02 280 / 0.55);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
  transition: opacity 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

@starting-style {
  :is(.overlay:popover-open, .overlay:modal)::backdrop {
    opacity: 0;
  }
}

.overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-overlay);
  background: oklch(0.08 0.02 280 / 0.55);
  -webkit-backdrop-filter: blur(2px);
  backdrop-filter: blur(2px);
}

/*
 * A popover (where the browser has no invoker commands) isn't modal: a click outside it would close
 * it and also press whatever lies under the pointer, such as a state button. While one is open the
 * page takes no clicks, so a click outside only closes it (the panel takes clicks again, .overlay).
 * A modal dialog's page is inert already.
 */
:root:has(.overlay:popover-open) .app {
  pointer-events: none;
}

/*
 * The page doesn't scroll under an open panel, where a wheel or a swipe over the backdrop would
 * slide it along, blurred. Its scrollbar's gutter is kept whether or not it is locked, so locking
 * it moves nothing sideways where scrollbars take room.
 */
:root:has(.overlay) {
  scrollbar-gutter: stable;
}

:root:has(:is(.overlay--open, .overlay:popover-open, .overlay:modal)) {
  overflow: hidden;
}

/*
 * A page drawn with a panel open skips the page entrance, as reduced motion does: the entrance's
 * transform would make main the fixed panel's frame while it plays, drawing it off-centre.
 */
main.orr-enter:has(.overlay--open) {
  animation: none;
}

/* The Edit roles rows: each role's fields under its name, split by hairlines. */
.option-rows {
  display: grid;
  gap: var(--space-3);
}

.option-row {
  display: grid;
  gap: var(--space-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.option-row + .option-row {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.option-row__role {
  float: left;
  width: 100%;
  padding: 0;
  overflow-wrap: anywhere;
}

.option-row__role + * {
  clear: both;
}

.option-row__fields {
  display: grid;
  gap: var(--space-2) var(--space-3);
}

/* Add roles: the form, then why the other roles can't be added. */
.menu-add {
  display: grid;
  gap: var(--space-3);
}

/*
 * Each role to add is a row at least 32px tall (44px for a finger) whose whole area is its label's,
 * as on My roles: the label's ::after covers the row, so a click anywhere on it ticks the box, and
 * the box stays above the cover, real and visible, with its own focus outline.
 */
.menu-add .orr-check {
  position: relative;
  align-items: center;
  min-height: 2rem;
}

.menu-add .orr-check__input {
  position: relative;
  z-index: 1;
}

.menu-add .orr-check__label::after {
  content: "";
  position: absolute;
  inset: 0;
}

@media (pointer: coarse) {
  .menu-add .orr-check {
    min-height: 2.75rem;
  }
}

.menu-refusals {
  margin: 0;
  padding: 0;
  list-style: none;
}

.menu-refusals > li {
  display: grid;
  gap: 2px;
  padding: var(--space-2) 0;
}

.menu-refusals > li + li {
  border-top: 1px solid var(--border-subtle);
}

.menu-refusals__role {
  overflow-wrap: anywhere;
}

/* A refused form's message about the form as a whole, at its top. */
.form-error {
  margin: 0;
}

/* The unreadable menu's card: the warning, then Reset role menu behind its consequence. */
.menu-reset {
  display: grid;
  gap: var(--space-3);
}

/*
 * Side by side in a card with room: a role's place and state share a line under its description,
 * and all three share one in a wider card (the state choices are short enough for a 13rem select);
 * Edit category and Add a category put the name and description side by side, the limit and the
 * button under them; Add roles lists its roles in columns. Each field's error, then its hint, go
 * under its control (order: the stacked field's label, hint, error, control, mirrored), so the
 * controls in a row line up whatever their hints' lengths.
 */
@container (min-width: 22rem) {
  .option-row__fields {
    grid-template-columns: 4.5rem minmax(0, 1fr);
    align-items: start;
  }
  .option-row__fields > :first-child {
    grid-column: 1 / -1;
  }
  .option-row__fields .orr-field__hint {
    order: 2;
  }
  .option-row__fields .orr-field__hint--error {
    order: 1;
  }
}

/*
 * A card with room puts its state badges at the head's end, like the kit's status badge, and lists
 * described roles in two columns: each role is a row of the list, its own columns the list's
 * (subgrid), so every name lines up in the first column (up to 45% of the card) and every
 * description and "Opens:" line in the second, beside its name; a role's warnings span both.
 * Without subgrid, a role's description and "Opens:" sit beside its own name instead.
 */
@container (min-width: 28rem) {
  .menu-category__meta {
    margin-inline-start: auto;
  }
  .menu-options--described {
    display: grid;
    grid-template-columns: fit-content(45%) minmax(0, 1fr);
    gap: var(--space-2) var(--space-4);
  }
  .menu-options--described > .menu-option {
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: baseline;
    /* A subgrid's "normal" column gap is the list's. */
    gap: 2px normal;
  }
  .menu-options--described > .menu-option > .menu-option__role {
    grid-row: span 2;
    grid-column: 1;
    align-self: start;
  }
  .menu-options--described > .menu-option > :is(.menu-option__desc, .menu-option__opens) {
    grid-column: 2;
  }
  .menu-options--described > .menu-option > .menu-problems {
    grid-column: 1 / -1;
    margin-top: var(--space-1);
  }
  .menu-add .choice-group[id$="-roles"] > .choice-group__choices {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr));
    gap: var(--space-2) var(--space-4);
  }
}

@container (min-width: 30rem) {
  .menu-form {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr);
    align-items: start;
    column-gap: var(--space-3);
  }
  .menu-form > .form-error,
  .menu-form > .form-actions {
    grid-column: 1 / -1;
  }
  /* Within each field only: the form's own message (.form-error) stays at the form's top. */
  .menu-form .orr-field > .orr-field__hint {
    order: 2;
  }
  .menu-form .orr-field > .orr-field__hint--error {
    order: 1;
  }
}

@container (min-width: 32rem) {
  .option-row__fields {
    grid-template-columns: minmax(0, 1fr) 4.5rem minmax(0, 13rem);
  }
  .option-row__fields > :first-child {
    grid-column: auto;
  }
}

@media (min-width: 40rem) {
  .menu-summary__counts {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .menu-summary__count > .orr-stat__label {
    white-space: nowrap;
  }
}

@media (min-width: 48rem) {
  .menu-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .menu-summary > .orr-card__head {
    padding-bottom: var(--card-pad);
  }
  .menu-summary > .orr-card__body {
    padding: var(--card-pad) var(--card-pad) var(--card-pad) 0;
  }
  .menu-summary__counts {
    grid-template-columns: repeat(4, auto);
    gap: var(--space-6);
  }
  .menu-summary__foot {
    grid-column: 1 / -1;
  }
}

/*
 * A wide form on a wide screen, where its button row no longer sticks: the name, the description,
 * the limit and the button in one row, the button level with the controls (under the labels).
 */
@media (min-width: 64rem) {
  @container (min-width: 56rem) {
    .menu-form {
      grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) minmax(0, 13rem) auto;
    }
    .menu-form > .form-actions {
      grid-column: auto;
      margin-top: calc(0.8125rem * 1.2 + 7px);
    }
  }
}

@media (min-width: 72rem) {
  .menu-categories {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/*
 * On a wide screen beside the fixed sidebar, a panel is centred over the page's own column rather
 * than the whole screen, clear of the sidebar.
 */
@media (min-width: 64rem) {
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) {
    inset-inline-start: var(--sidebar-w);
    width: min(100% - var(--sidebar-w) - 2 * var(--space-6), var(--overlay-width));
  }
}

/*
 * On a phone, an open panel is a sheet from the bottom edge, the full width, its body clear of the
 * home indicator. It is as tall as its content (up to 85% of the screen), so it never shows an
 * empty band; a disclosure opening inside it (Add roles' list of the roles it can't add) grows the
 * sheet upward from the bottom edge, as sheets do, while the page under it stays where it was.
 */
@media (max-width: 39.99rem) {
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) {
    --overlay-foot: calc(var(--card-pad) + env(safe-area-inset-bottom));
    inset: auto 0 0;
    width: 100%;
    max-height: 85dvh;
    margin: 0;
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  }
}

/*
 * A short screen (a phone on its side, or 400% zoom): the panel takes all but a little of the
 * screen's height, and its title shares one line with the category's name, so the body keeps room.
 */
@media (max-height: 29.99rem) {
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) {
    max-height: calc(100dvh - 1rem);
    margin-top: 0.5rem;
  }
  .overlay__title {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: var(--space-2);
  }
}

/*
 * Beside its button (the owner's ask, 2026-10-10: bring the panel closer to the button that opened
 * it), where the browser has anchor positioning and the screen has room: from 40rem wide and 30rem
 * tall. A phone keeps its sheet and a short screen its near-full panel (above), and so does a
 * browser without anchor positioning, which keeps the centred panel. A refused editor drawn open
 * (.overlay--open) stays centred too: its page loads at the top, where the button may be off the
 * screen, so views/role-menu.ts gives it no anchor class, and these rules name only open dialogs and
 * popovers. They override the centred rules above at the same specificity, so they stay after them.
 *
 * Each editor's button is an anchor and its panel points at it (ANCHOR_PAIRS). The panel opens just
 * under the button, a small gap between them, its start edge at the button's, as wide as before; it
 * moves back toward the start only as far as it takes to stay on the screen, clear of the sidebar
 * from 64rem. The area spans the screen's whole width and the start is clamped, rather than an
 * area beside the button that flips to its other side: a panel wider than the room on either side
 * (Edit roles at 48rem on a 768px screen) would then overflow every option, and the browser would
 * fall back to the first one, off the bottom of the screen.
 *
 * When its content doesn't fit under the button it opens above it (flip-block). When it fits on
 * neither side it fills the side with more room, its body scrolling: the capped options' floor,
 * half the screen less 4rem, is what the larger side always holds (for a button up to 5rem tall)
 * and the smaller one only when the two are about equal, so the first is skipped when below is the
 * smaller; the content is taller than that floor by then, so it never adds an empty band. The page
 * still never moves: the panel is in the top layer, and the anchor only reads where the button is.
 * A modal panel never hides itself, even where the browser would judge its button clipped
 * (position-visibility).
 */
@supports (anchor-name: --a) {
  @position-try --overlay-below {
    position-area: block-end span-all;
    margin: var(--overlay-gap) 0 var(--overlay-edge);
    min-height: calc(50dvh - 4rem);
    max-height: calc(100% - var(--overlay-gap) - var(--overlay-edge));
  }

  @position-try --overlay-above {
    position-area: block-start span-all;
    margin: var(--overlay-edge) 0 var(--overlay-gap);
    min-height: calc(50dvh - 4rem);
    max-height: calc(100% - var(--overlay-gap) - var(--overlay-edge));
  }

  @media (min-width: 40rem) and (min-height: 30rem) {
${ANCHOR_PAIRS}

    .overlay--anchored:is(:popover-open, :modal) {
      --overlay-gap: var(--space-2);
      --overlay-edge: var(--space-4);
      --overlay-start: var(--overlay-edge);
      --overlay-fit: min(100% - var(--overlay-start) - var(--overlay-edge), var(--overlay-width));
      position-area: block-end span-all;
      position-try-fallbacks: flip-block, --overlay-below, --overlay-above;
      position-visibility: always;
      inset-block: 0;
      inset-inline: clamp(
          var(--overlay-start),
          anchor(start, var(--overlay-start)),
          100% - var(--overlay-edge) - var(--overlay-fit)
        )
        0;
      justify-self: start;
      width: var(--overlay-fit);
      max-height: calc(100dvh - 2 * var(--overlay-edge));
      margin: var(--overlay-gap) 0 var(--overlay-edge);
    }

    /*
     * While one is open the page is locked, so the root's scroll padding (shell.ts's, which keeps
     * focus clear of the sticky bars, and forms.ts's) has nothing to do. WebKit would still scroll
     * the page under the panel to keep its focused title clear of it, by as much as the title sits
     * inside it near the top of the screen, though scrolling can't move a fixed panel. Two classes
     * outrank the shell's rule for an open account menu.
     */
    :root:has(.overlay.overlay--anchored:is(:popover-open, :modal)) {
      scroll-padding: 0;
    }
  }

  @media (min-width: 64rem) and (min-height: 30rem) {
    .overlay--anchored:is(:popover-open, :modal) {
      --overlay-start: calc(var(--sidebar-w) + var(--overlay-edge));
    }
  }
}

/*
 * An open panel's form ends in its button row, its foot: the row sticks to the panel's bottom edge
 * while the body scrolls, solid, set off by a hairline and reaching the panel's sides (1px short,
 * so the panel's hairline edge stays whole beside it). It takes the body's bottom padding (a
 * sticky offset counts from inside the scroller's padding), so it sits flush with the bottom edge
 * whether or not the body scrolls, and nothing scrolls by under it; on a phone its padding clears
 * the home indicator, and focus scrolls clear of it (WCAG 2.4.11). A short screen can't spare the
 * room, so there the row stays in its place, as forms.ts's does.
 */
@media (min-height: 30rem) {
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) .form-actions {
    position: sticky;
    bottom: calc(-1 * var(--overlay-foot));
    z-index: var(--z-sticky);
    margin: 0 calc(1px - var(--card-pad)) calc(-1 * var(--overlay-foot));
    padding: var(--space-2) calc(var(--card-pad) - 1px)
      calc(var(--space-2) + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-1);
  }
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) > .overlay__body {
    scroll-padding-bottom: 5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  :is(.overlay:popover-open, .overlay:modal),
  .overlay::backdrop {
    transition: none;
  }
}

@media (prefers-reduced-transparency: reduce) {
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) {
    background: var(--surface-1);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .overlay::backdrop,
  .overlay-backdrop {
    background: oklch(0.08 0.02 280 / 0.85);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}

@media (forced-colors: active) {
  .orr-badge,
  .menu-options > .menu-option--attention,
  .overlay {
    border: 1px solid CanvasText;
  }
  :is(.overlay--open, .overlay:popover-open, .overlay:modal) {
    color: CanvasText;
    background: Canvas;
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  /* The system palette isn't blurred under a panel; the dimming still marks the page inactive. */
  .overlay::backdrop,
  .overlay-backdrop {
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .menu-toolbar .menu-opener:is(a, .menu-opener--kept, :has(+ :is(.overlay:modal, .overlay:popover-open))) {
    border-color: Highlight;
  }
}

@media print {
  .orr-badge,
  .menu-options > .menu-option--attention {
    border: 1px solid #888;
  }
  /* The editors and buttons are for the screen; paper keeps the menu itself. */
  .menu-category__foot,
  .menu-summary__foot,
  .overlay-backdrop,
  .overlay--open {
    display: none;
  }
}
`;
