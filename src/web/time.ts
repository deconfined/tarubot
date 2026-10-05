/**
 * The one place web pages turn an instant into text (#43). Server-rendered pages lose Discord's
 * per-viewer <t:…> timestamps, so v3 shows UTC and says so; #45 adds a zone parameter here and
 * nowhere else.
 */

/** A rendered instant: `iso` for `<time datetime>`, `text` for people to read. */
export interface TimeText {
  /** The instant in UTC, exactly as Date.prototype.toISOString gives it. */
  readonly iso: string;
  /** Minute precision with the zone named, for example "2026-10-04 21:37 UTC". */
  readonly text: string;
}

/**
 * Plain data for a view, which renders `<time datetime="{iso}">{text}</time>`. UTC only: the text
 * is cut from toISOString, which is always UTC, so the host's TZ can't change what a page says.
 * Seconds are cut, never rounded, so the text never shows a minute that hasn't started yet. An
 * invalid Date throws RangeError (from toISOString); stored times are always valid, so that is a
 * bug to report, not text to show.
 */
export function time(instant: Date): TimeText {
  const iso = instant.toISOString();
  return { iso, text: `${iso.slice(0, 16).replace("T", " ")} UTC` };
}
