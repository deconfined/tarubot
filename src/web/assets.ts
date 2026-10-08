/**
 * The web's only static files (#43, ADR D11): the stylesheet, the site favicon, the four
 * self-hosted fonts and the third-party notices, kept as constants so the image needs no asset
 * directory and nothing is served from disk. Each path carries a hash of its body, so a response
 * can be cached as immutable and a new release's change gets a new path. The favicon, the fonts,
 * the notices and the design tokens are copies of the docs site's files;
 * tests/unit/web-parity.test.ts keeps each copy identical to its site original.
 */
import { createHash } from "node:crypto";
import {
  type FontFile,
  INSTRUMENT_SERIF_ITALIC,
  INSTRUMENT_SERIF_NORMAL,
  JETBRAINS_MONO,
  MANROPE,
} from "./fonts.js";
import { THIRD_PARTY_NOTICES } from "./notices.js";
import { BASE_CSS } from "./styles/base.js";
import { COMPONENTS_CSS } from "./styles/components.js";
import { CONFIGURATION_CSS } from "./styles/configuration.js";
import { EFFECTS_CSS } from "./styles/effects.js";
import { ENTRY_CSS } from "./styles/entry.js";
import { MEDIA_CSS } from "./styles/media.js";
import { SHELL_CSS } from "./styles/shell.js";
import { STATUS_CSS } from "./styles/status.js";
import { TOKENS_CSS } from "./styles/tokens.js";

/** One static file. */
export interface Asset {
  /** `/assets/<name>.<hash>.<ext>`; the hash is the first 12 hex digits of the body's SHA-256. */
  readonly path: string;
  readonly contentType: string;
  /** Text (sent as UTF-8), or a binary file's bytes. */
  readonly body: string | Uint8Array<ArrayBuffer>;
}

/** Hashed paths never change content, so browsers may keep them for a year without revalidating. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Build an asset whose path is derived from its body. */
function asset(name: string, extension: string, contentType: string, body: Asset["body"]): Asset {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 12);
  return { path: `/assets/${name}.${hash}.${extension}`, contentType, body };
}

/** A self-hosted font, decoded once at startup and served under its site file's name. */
const font = (file: FontFile): Asset =>
  asset(file.stem, "woff2", "font/woff2", Uint8Array.fromBase64(file.base64));

/**
 * The four fonts (fonts.ts, generated from the site's copies), by role: Instrument Serif for
 * display (regular and italic), Manrope for text, JetBrains Mono for labels and readouts. Latin
 * subsets only; the token font stacks fall back to system fonts for anything else.
 */
export const FONTS = {
  display: font(INSTRUMENT_SERIF_NORMAL),
  displayItalic: font(INSTRUMENT_SERIF_ITALIC),
  sans: font(MANROPE),
  mono: font(JETBRAINS_MONO),
} as const;

/**
 * The third-party notices (notices.ts): the fonts' OFL and the icons' ISC and MIT texts, which must
 * travel with every copy. The layout's footer links here as "Third-party licenses".
 */
export const NOTICES: Asset = asset(
  "licenses",
  "txt",
  "text/plain; charset=utf-8",
  THIRD_PARTY_NOTICES,
);

/**
 * The fonts' `@font-face` rules, pointing at their hashed paths, under the family names the token
 * font stacks use. `swap` shows fallback text at once instead of invisible text while a font
 * loads; the weight ranges clamp the variable fonts to the weights the design uses (Manrope
 * 400–700, JetBrains Mono 400–600). STYLESHEET puts these first and is hashed after they are
 * interpolated, so a changed font also gives the stylesheet a new path. The site declares its own
 * rules for the same files, because its URLs differ.
 */
export const FONT_FACES = `/* Fonts: SIL Open Font License 1.1, notices at ${NOTICES.path} */
@font-face {
  font-family: "Instrument Serif";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("${FONTS.display.path}") format("woff2");
}

@font-face {
  font-family: "Instrument Serif";
  font-style: italic;
  font-weight: 400;
  font-display: swap;
  src: url("${FONTS.displayItalic.path}") format("woff2");
}

@font-face {
  font-family: "Manrope";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url("${FONTS.sans.path}") format("woff2");
}

@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 400 600;
  font-display: swap;
  src: url("${FONTS.mono.path}") format("woff2");
}
`;

/**
 * The dashboard's stylesheet: the design tokens shared with the docs site, then the Orrery design
 * system's base, effects and components as ported in styles/, the console and entry frames, each
 * page's own rules, and last the viewer's preferences and print, which must win. One file at one
 * hashed path; STYLESHEET puts the font faces before it.
 */
const CSS = [
  TOKENS_CSS,
  BASE_CSS,
  EFFECTS_CSS,
  COMPONENTS_CSS,
  SHELL_CSS,
  ENTRY_CSS,
  CONFIGURATION_CSS,
  STATUS_CSS,
  MEDIA_CSS,
].join("\n");

/**
 * The site's favicon (site/public/favicon.svg), byte for byte: the "T" in --cyan-400 (#2fd4ec) on
 * --night-900 (#08091a), the tokens' sRGB equivalents, since a favicon can't read the tokens.
 */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <title>TaruBot</title>
  <rect width="32" height="32" rx="7" fill="#08091a"/>
  <path d="M8 9h16v4h-6v12h-4V13H8z" fill="#2fd4ec"/>
</svg>
`;

/** The font faces, then the rest; hashed after composing, so the path covers the font paths too. */
export const STYLESHEET: Asset = asset(
  "site",
  "css",
  "text/css; charset=utf-8",
  `${FONT_FACES}\n${CSS}`,
);
export const FAVICON: Asset = asset("favicon", "svg", "image/svg+xml", FAVICON_SVG);

/** Every asset, each served by server.ts at its own hashed path. */
export const ASSETS: readonly Asset[] = [
  STYLESHEET,
  FAVICON,
  NOTICES,
  FONTS.display,
  FONTS.displayItalic,
  FONTS.sans,
  FONTS.mono,
];
