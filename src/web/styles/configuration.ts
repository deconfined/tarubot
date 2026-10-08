/**
 * The Server configuration page's own rules (views/configuration.ts), phones first: the health
 * snapshot (the view's one holographic card) and the state readouts under it, the Settings cards
 * in a grid that adds columns as the page widens, and the health checklist as one card of
 * grouped rows. Shared vocabulary (cards, stats, status tokens, notes, notices, mentions,
 * checklist rows, disclosures) lives in components.ts; this module only arranges it.
 *
 * Nothing here adds glass: every surface is an .orr-card, so the reduced-transparency, forced-colors
 * and print fallbacks in media.ts already cover it.
 */
export const CONFIGURATION_CSS = `/* Server configuration */

/* The summary: the health snapshot and the state readouts, closer together than sections. */
.config-summary {
  display: grid;
  gap: var(--space-3);
}

/*
 * Health snapshot. Phones stack the head, the readouts and the foot; from 48rem the readouts sit
 * beside the heading. The instrument scale divides both from the foot.
 */
.health-card > .orr-card__head {
  justify-content: flex-start;
  align-items: center;
  gap: var(--space-4);
}

.health-card__title {
  font-size: clamp(24px, 6vw, var(--display-sm));
}

/* A tone tile behind the mark, by the worst check; the heading's words carry the meaning. */
.health-card__mark {
  display: inline-grid;
  place-items: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
  font-size: 22px;
}

.health-card__mark--ok {
  color: var(--success);
  background: var(--success-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 162 / 0.3);
}

.health-card__mark--wait {
  color: var(--cyan-400);
  background: var(--info-bg);
  box-shadow: inset 0 0 0 1px oklch(0.8 0.13 210 / 0.3);
}

.health-card__mark--warn {
  color: var(--warning);
  background: var(--warning-bg);
  box-shadow: inset 0 0 0 1px oklch(0.82 0.13 78 / 0.3);
}

.health-card__mark--fail {
  color: var(--danger);
  background: var(--danger-bg);
  box-shadow: inset 0 0 0 1px oklch(0.74 0.15 18 / 0.32);
}

/* The counts sit side by side, wrapping whole rather than breaking a label on the narrowest phones. */
.health-card__counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-4) var(--space-5);
  margin: 0;
}

.health-count {
  min-width: 4rem;
}

.health-count > .orr-stat__label {
  white-space: nowrap;
}

/* Each count's tone, as a dot before its label: passed, waiting, off. */
.health-count > .orr-stat__label::before {
  content: "";
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.health-count--ok > .orr-stat__label::before {
  background: var(--success);
  box-shadow: 0 0 8px var(--success);
}

.health-count--wait > .orr-stat__label::before {
  background: var(--cyan-400);
  box-shadow: 0 0 8px var(--cyan-400);
}

.health-count--off > .orr-stat__label::before {
  background: var(--night-300);
}

.health-card__scale {
  margin: 0 var(--card-pad);
}

.health-card__foot {
  justify-content: space-between;
  border-top: 0;
}

/*
 * The state readouts: three small cards side by side from 40rem. On phones they stack, each a
 * single line with its label at the start and the state at the end, so the stack stays short.
 */
.state-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.state-readout {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2) var(--space-3);
}

/* A state in words, with its check token (if any) level with the first line when the words wrap. */
.state-readout > .orr-stat__value {
  align-items: flex-start;
  gap: var(--space-2);
  font: var(--type-subtitle);
  letter-spacing: var(--tracking-ui);
}

.state-readout > .orr-stat__value > .check {
  margin-top: 1px;
}

/* Settings: the read-only notice, then cards that add a column whenever one fits. */
.settings-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.settings-notice > .orr-icon {
  margin-top: 1px;
  font-size: 16px;
  color: var(--info);
}

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-4);
}

/* A card's facts: each mono label over its value, rows split by hairlines. */
.settings-facts {
  margin: 0;
}

.settings-facts > dt {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border-subtle);
}

.settings-facts > dt:first-of-type {
  padding-top: 0;
  border-top: 0;
}

.settings-facts > dd {
  margin: 6px 0 0;
  padding-bottom: var(--space-3);
  color: var(--text-primary);
}

.settings-facts > dd:last-of-type {
  padding-bottom: 0;
}

/* A command, ID or mode stays whole; untrusted names around it still wrap. */
.settings-facts code {
  white-space: nowrap;
}

/* The roster diagnostic, opened in place: untrusted text, wrapped rather than scrolled. */
.roster-diagnostic pre {
  max-width: 100%;
  margin: var(--space-2) 0 0;
  white-space: pre-wrap;
}

.roster-diagnostic pre code {
  display: block;
  padding: var(--space-3);
  white-space: inherit;
  overflow-wrap: anywhere;
}

/* The health checklist: one card of groups, each group's name above (later beside) its rows. */
.checklist-note {
  margin-bottom: var(--space-4);
}

.checklist-card > .orr-card__body {
  padding-block: var(--space-1);
}

.check-group {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-4) 0 var(--space-2);
}

.check-group + .check-group {
  border-top: 1px solid var(--border-subtle);
}

.check-group__title {
  font: 600 var(--text-md) / 1.3 var(--font-sans);
}

.check-group__fold > summary .orr-icon {
  font-size: 16px;
  color: var(--success);
}

@media (min-width: 40rem) {
  .state-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .state-readout {
    display: grid;
    justify-content: normal;
  }
}

@media (min-width: 48rem) {
  .health-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
  .health-card > .orr-card__head {
    padding-bottom: var(--card-pad);
  }
  .health-card > .orr-card__body {
    padding: var(--card-pad) var(--card-pad) var(--card-pad) 0;
  }
  .health-card__counts {
    flex-wrap: nowrap;
    gap: var(--space-8);
  }
  .health-count {
    min-width: 5.5rem;
  }
  .health-card__scale,
  .health-card__foot {
    grid-column: 1 / -1;
  }
  .check-group {
    grid-template-columns: 11rem minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
    padding-bottom: var(--space-1);
  }
  /* Level with the first row's text (the rows' own 10px top padding). */
  .check-group__title {
    padding-top: 10px;
  }
}

@media print {
  /* A long checklist may break between groups, though never inside one. */
  .checklist-card.orr-card {
    break-inside: auto;
  }
  .check-group {
    break-inside: avoid;
  }
  .health-card__scale {
    display: none;
  }
}
`;
