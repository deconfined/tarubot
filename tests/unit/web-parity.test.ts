/**
 * One design source, two copies: the docs site's files are the originals, and the dashboard
 * carries copies because it serves nothing from disk and the site can't import from src/. The
 * design tokens, the favicon, the third-party notices and the four self-hosted fonts must be
 * identical on both surfaces, and each font must be a whole WOFF2 file, the very file its
 * Fontsource package ships. Fixing a failure here means copying the site file over (tokens.ts,
 * notices.ts, the favicon in assets.ts) or regenerating fonts.ts with
 * `bun --no-env-file scripts/web-fonts.ts`; a deliberate font update also updates UPSTREAM.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FAVICON, FONTS, NOTICES } from "../../src/web/assets.js";
import {
  type FontFile,
  INSTRUMENT_SERIF_ITALIC,
  INSTRUMENT_SERIF_NORMAL,
  JETBRAINS_MONO,
  MANROPE,
} from "../../src/web/fonts.js";
import { THIRD_PARTY_NOTICES } from "../../src/web/notices.js";
import { TOKENS_CSS } from "../../src/web/styles/tokens.js";

/** A repository path, resolved relative to this test. */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
/** A repository file's bytes. */
const bytes = async (path: string) => new Uint8Array(await Bun.file(root(path)).arrayBuffer());
/** Hex SHA-256 of some bytes. */
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * The SHA-256 of each font file in its upstream npm package: @fontsource/instrument-serif 5.3.0,
 * @fontsource-variable/manrope 5.3.0 and @fontsource-variable/jetbrains-mono 5.3.0, package/files/.
 * Pinned here, apart from the generated file, because fonts.ts takes its SHA-256 from the same
 * site file it encodes: a damaged site font, regenerated, would otherwise match itself.
 */
const UPSTREAM: Readonly<Record<string, string>> = {
  "instrument-serif-latin-400-normal":
    "5eb09b5ac0e28b67c2f041c8ba6d244604ca0c0980d65912ab2d47fed84ddc31",
  "instrument-serif-latin-400-italic":
    "5a51946dfffa82972bc98745359c46761515641fda557c25116459a9f83da4a7",
  "manrope-latin-wght-normal": "a30ddcd349703aff7464c34bef3fffdff405ee50c113440d7c8693c02d210972",
  "jetbrains-mono-latin-wght-normal":
    "18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e",
};

/** Where the site keeps the fonts, and the generated constant for each file. */
const FONT_DIRECTORY = "site/src/assets/fonts";
const GENERATED: readonly FontFile[] = [
  INSTRUMENT_SERIF_NORMAL,
  INSTRUMENT_SERIF_ITALIC,
  MANROPE,
  JETBRAINS_MONO,
];

describe("the dashboard's copies equal the docs site's files", () => {
  test("the design tokens", async () => {
    expect(TOKENS_CSS).toBe(await Bun.file(root("site/src/styles/tokens.css")).text());
  });

  test("the favicon, byte for byte", async () => {
    if (typeof FAVICON.body !== "string") throw new Error("The favicon is SVG text.");
    expect(new TextEncoder().encode(FAVICON.body)).toEqual(await bytes("site/public/favicon.svg"));
  });

  test("the third-party notices", async () => {
    expect(THIRD_PARTY_NOTICES).toBe(
      await Bun.file(root("site/public/third-party-licenses.txt")).text(),
    );
    expect(NOTICES.body).toBe(THIRD_PARTY_NOTICES);
  });

  test("every site font, and no other, is generated into fonts.ts", async () => {
    const files: string[] = [];
    for await (const path of new Bun.Glob("*.woff2").scan({ cwd: root(FONT_DIRECTORY) }))
      files.push(path);
    expect(files.sort()).toEqual(GENERATED.map((font) => `${font.stem}.woff2`).sort());
  });

  for (const font of GENERATED)
    test(`${font.stem}: the same bytes, a whole WOFF2 file, the upstream SHA-256`, async () => {
      const decoded = Uint8Array.fromBase64(font.base64);
      expect(new TextDecoder().decode(decoded.subarray(0, 4))).toBe("wOF2");
      // The header's total length (bytes 8-11, big-endian) is the file's: nothing cut off.
      expect(new DataView(decoded.buffer, decoded.byteOffset).getUint32(8)).toBe(
        decoded.byteLength,
      );
      expect(sha256(decoded)).toBe(font.sha256);
      expect(font.sha256).toBe(UPSTREAM[font.stem] ?? "no upstream SHA-256 pinned");
      expect(decoded).toEqual(await bytes(`${FONT_DIRECTORY}/${font.stem}.woff2`));
    });

  test("each font travels with its family's OFL text, which the notices quote", async () => {
    for (const family of ["instrument-serif", "manrope", "jetbrains-mono"]) {
      const license = await Bun.file(root(`${FONT_DIRECTORY}/${family}-OFL.txt`)).text();
      expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
      // The family's copyright line opens its license file and appears in the notices.
      const copyright =
        /^Copyright \d{4} The .+? Project Authors \(https:\/\/github\.com\/[^)]+\)/u.exec(
          license,
        )?.[0];
      expect({ family, copyright: copyright !== undefined }).toEqual({ family, copyright: true });
      expect(THIRD_PARTY_NOTICES).toContain(`${copyright}\n`);
    }
    // The license body is quoted once, whole, after the copyright lines.
    const body = (await Bun.file(root(`${FONT_DIRECTORY}/manrope-OFL.txt`)).text())
      .split("\n")
      .slice(2)
      .join("\n");
    expect(THIRD_PARTY_NOTICES.split(body)).toHaveLength(2);
  });
});

describe("the dashboard serves the fonts it was generated from", () => {
  test("each font asset is the decoded file at its hashed path", () => {
    const assets = [FONTS.display, FONTS.displayItalic, FONTS.sans, FONTS.mono];
    expect(assets.map((asset) => asset.path)).toEqual(
      GENERATED.map((font) => `/assets/${font.stem}.${font.sha256.slice(0, 12)}.woff2`),
    );
    for (const [index, asset] of assets.entries()) {
      expect(asset.contentType).toBe("font/woff2");
      expect(asset.body).toEqual(Uint8Array.fromBase64(GENERATED[index]?.base64 ?? ""));
    }
  });
});
