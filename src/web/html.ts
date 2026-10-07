/**
 * Escaping templates for web pages (#43). Hono's `html` tag escapes every interpolated string,
 * number and array item unless the value is already a template result, so nested templates compose
 * without double escaping, and a promise resolves before it is escaped. The unescaped bypass is
 * re-exported for constant markup only: tests/unit/web-boundary.test.ts allows calling it only in
 * allow-listed constant files, so stored or upstream text can never reach a page unescaped.
 * tests/unit/web-html.test.ts proves these properties against the pinned Hono version.
 */
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";

export { html, raw };

/** What a template produces: escaped markup, or a promise of it when an interpolation was async. */
export type SafeHtml = HtmlEscapedString | Promise<HtmlEscapedString>;

/**
 * A same-origin path: one leading "/" not followed by another, then visible ASCII with no "\"
 * anywhere (browsers read "\" as "/", so "/\evil.example" would be protocol-relative). Tabs,
 * newlines and spaces are refused too, because URL parsers strip them, which would turn
 * "/\t/evil.example" into "//evil.example".
 */
const SAME_ORIGIN_PATH = /^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/u;

/** C0 controls, space and DEL, which URL parsers strip or trim before deciding what a link is. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding controls is the point.
const STRIPPED = /[\u0000- \u007f]/u;

/**
 * A link target that is safe to interpolate into `href`: a same-origin path (one leading "/", never
 * "//" or "/\") or an absolute `https:` URL. Anything else, `javascript:`, `data:`, `http:` and
 * protocol-relative URLs included, becomes "#". The template still escapes the result as text.
 */
export function href(value: string): string {
  if (typeof value !== "string" || STRIPPED.test(value)) return "#";
  if (value.startsWith("/")) return SAME_ORIGIN_PATH.test(value) ? value : "#";
  if (!URL.canParse(value)) return "#";
  const url = new URL(value);
  // Credentials in a link are a phishing device ("https://discord.com@evil.example"), never ours.
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return "#";
  // The parsed form, so the browser and this check agree on what the link points at.
  return url.href;
}

/**
 * Untrusted text (nicknames, server and role names, Lodestone names, ledger notes, reasons),
 * escaped inside `<span dir="auto">`. Browsers isolate a dir="auto" element, so bidirectional
 * control characters in the text can't reorder the page around it; nothing strips them.
 */
export function untrusted(value: string): SafeHtml {
  return html`<span dir="auto">${value}</span>`;
}
