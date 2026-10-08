/**
 * The Orrery design system's effect utilities (styles/effects.css) that TaruBot's pages render:
 * keyframes, the holographic edge, the mono instrument label, the scale and hairline dividers, the
 * starfield, the orbit rings and the page entrance. The glass utilities (cards and the shell draw
 * their own glass), the holographic text, the glows, the pulse dot and the spinner are not ported
 * until a page renders them.
 *
 * Changes from the export:
 * - the holographic edge draws its own conic gradient from --holo-angle, so its rotation shows
 *   (tokens.ts explains why no token can hold that gradient), with a 0deg fallback for browsers
 *   without @property;
 * - the orbit rings' geometry, which the design's kit sets in style attributes the CSP refuses,
 *   is a set of modifier classes;
 * - every reduced-motion rule lives in styles/media.ts, which also stops what the export's own
 *   rule missed (the entrance, the button sheen and press, the server links' arrow nudge).
 */
export const EFFECTS_CSS = `/* Effects: from the Orrery design system's styles/effects.css */
@keyframes orr-holo-drift {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 200% 50%;
  }
}

@keyframes orr-holo-spin {
  to {
    --holo-angle: 360deg;
  }
}

@keyframes orr-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes orr-twinkle {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@keyframes orr-rise-in {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/*
 * Holographic edge: a 1px iridescent border that slowly turns, on at most one card per page. The
 * host needs a border-radius; the mask cuts the gradient down to the padding ring.
 */
.orr-holo-edge {
  position: relative;
}

.orr-holo-edge::before {
  content: "";
  position: absolute;
  inset: 0;
  padding: 1px;
  border-radius: inherit;
  background: conic-gradient(from var(--holo-angle, 0deg), var(--holo-stops));
  -webkit-mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  animation: orr-holo-spin var(--dur-holo) linear infinite;
  pointer-events: none;
  opacity: var(--holo-edge-opacity, 0.85);
  transition: opacity var(--dur-slow) var(--ease-out);
}

/* The mono instrument label: written in sentence case, uppercased here. */
.orr-label {
  font: var(--type-label);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--text-muted);
}

/* Instrument scale: astrolabe graduation ticks, used as a divider. */
.orr-scale {
  height: 7px;
  background-image:
    repeating-linear-gradient(90deg, var(--border-strong) 0 1px, transparent 1px 40px),
    repeating-linear-gradient(90deg, var(--border-default) 0 1px, transparent 1px 8px);
  background-position:
    0 0,
    0 100%;
  background-size:
    100% 7px,
    100% 3px;
  background-repeat: no-repeat;
  -webkit-mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
  mask: linear-gradient(90deg, transparent, #000 15%, #000 85%, transparent);
}

.orr-hairline {
  height: 1px;
  background: linear-gradient(
    90deg,
    transparent,
    var(--border-strong) 20%,
    var(--border-strong) 80%,
    transparent
  );
}

/*
 * Starfield: CSS only, behind the entry pages. Two static layers on coprime tiles (613px and
 * 877px) and a third that twinkles (719px), so the repetition never lines up.
 */
.orr-starfield {
  position: relative;
  background-color: var(--bg-void);
  background-image:
    var(--nebula-cyan),
    var(--nebula-violet),
    radial-gradient(1px 1px at 177px 129px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1.2px 1.2px at 202px 461px, oklch(0.97 0.01 280 / 0.6), transparent 70%),
    radial-gradient(1.2px 1.2px at 420px 390px, oklch(0.97 0.01 280 / 0.6), transparent 70%),
    radial-gradient(1.2px 1.2px at 229px 434px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1.2px 1.2px at 419px 287px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1.2px 1.2px at 75px 315px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1.2px 1.2px at 395px 354px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1.2px 1.2px at 228px 206px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1.2px 1.2px at 94px 182px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1px 1px at 575px 342px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1.2px 1.2px at 36px 168px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1px 1px at 258px 118px, oklch(0.97 0.01 280 / 0.6), transparent 70%),
    radial-gradient(1.2px 1.2px at 224px 211px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1px 1px at 316px 101px, oklch(0.97 0.01 280 / 0.45), transparent 70%),
    radial-gradient(1px 1px at 223px 260px, oklch(0.97 0.01 280 / 0.9), transparent 70%),
    radial-gradient(1px 1px at 376px 143px, oklch(0.97 0.01 280 / 0.6), transparent 70%),
    radial-gradient(1.8px 1.8px at 757px 557px, oklch(0.92 0.05 298 / 0.75), transparent 70%),
    radial-gradient(1.8px 1.8px at 443px 604px, oklch(0.92 0.05 298 / 0.75), transparent 70%),
    radial-gradient(1.8px 1.8px at 621px 220px, oklch(0.92 0.05 298 / 0.75), transparent 70%),
    radial-gradient(1.8px 1.8px at 290px 343px, oklch(0.92 0.05 298 / 0.75), transparent 70%),
    radial-gradient(1.8px 1.8px at 97px 718px, oklch(0.97 0.01 280 / 0.8), transparent 70%),
    radial-gradient(1.5px 1.5px at 135px 68px, oklch(0.92 0.05 298 / 0.75), transparent 70%),
    radial-gradient(1.8px 1.8px at 555px 127px, oklch(0.93 0.05 210 / 0.85), transparent 70%);
  background-size:
    100% 100%,
    100% 100%,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    613px 613px,
    877px 877px,
    877px 877px,
    877px 877px,
    877px 877px,
    877px 877px,
    877px 877px,
    877px 877px;
  overflow: hidden;
}

.orr-starfield::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image:
    radial-gradient(2px 2px at 99px 663px, oklch(0.93 0.06 210), transparent 70%),
    radial-gradient(2.4px 2.4px at 636px 653px, oklch(0.92 0.05 298), transparent 70%),
    radial-gradient(2.4px 2.4px at 8px 179px, oklch(0.98 0.01 280), transparent 70%),
    radial-gradient(2px 2px at 444px 166px, oklch(0.98 0.01 280), transparent 70%),
    radial-gradient(2.4px 2.4px at 494px 171px, oklch(0.93 0.06 210), transparent 70%),
    radial-gradient(2.4px 2.4px at 269px 643px, oklch(0.98 0.01 280), transparent 70%),
    radial-gradient(2.8px 2.8px at 2px 656px, oklch(0.95 0.06 85), transparent 70%);
  background-size: 719px 719px;
  animation: orr-twinkle var(--dur-twinkle) var(--ease-in-out) infinite;
}

.orr-starfield > * {
  position: relative;
}

/* Orbit rings: the astrolabe motif. Rings nest inside .orr-orbit, a planet rides a ring. */
.orr-orbit {
  position: relative;
  aspect-ratio: 1;
  pointer-events: none;
}

.orr-orbit__ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--border-default);
  animation: orr-spin var(--dur-orbit) linear infinite;
}

.orr-orbit__ring--dashed {
  border-style: dashed;
  border-color: var(--border-strong);
}

/* The kit's three-ring composition: 60s outer, 90s reversed middle, 40s inner. */
.orr-orbit__ring--middle {
  inset: 14%;
  animation-duration: calc(var(--dur-orbit) * 1.5);
  animation-direction: reverse;
}

.orr-orbit__ring--inner {
  inset: 28%;
  animation-duration: calc(var(--dur-orbit) * 2 / 3);
}

.orr-orbit__planet {
  position: absolute;
  top: -4px;
  left: 50%;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: var(--planet, var(--cyan-400));
  box-shadow: 0 0 12px var(--planet, var(--cyan-400));
}

.orr-orbit__planet--violet {
  --planet: var(--violet-400);
}

/* The page entrance; server-rendered pages replay it on every load. */
.orr-enter {
  animation: orr-rise-in var(--dur-enter) var(--ease-out) backwards;
}
`;
