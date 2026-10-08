/**
 * The dashboard's static assets and the shell's use of them (#43, ADR D11): each path names the
 * SHA-256 of its body, the stylesheet opens with the self-hosted font faces at their hashed paths
 * (and is hashed after they are put in), the inline icons are decorative constant markup that
 * never changes a label's text, and every page declares the dark color scheme, loads its
 * stylesheet and icon from this origin only and links the third-party notices from its footer.
 * web-parity.test.ts proves the copies equal the docs site's files; web-server.test.ts serves them.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { parseHTML } from "linkedom";
import { ASSETS, FONT_FACES, FONTS, NOTICES, STYLESHEET } from "../../src/web/assets.js";
import { html, type SafeHtml } from "../../src/web/html.js";
import { ICON_NAMES, type IconName, icon } from "../../src/web/icons.js";
import { errorPage, layout } from "../../src/web/layout.js";
import { TOKENS_CSS } from "../../src/web/styles/tokens.js";
import { renderHome, renderNoAccess } from "../../src/web/views/servers.js";

/** The markup a template produced. */
const render = async (value: SafeHtml): Promise<string> => String(await value);

/** A fragment's body, parsed the way the page tests parse whole documents. */
const fragment = (markup: string): HTMLElement =>
  parseHTML(`<!doctype html><html lang="en"><body>${markup}</body></html>`).document.body;

describe("assets", () => {
  test("each path is /assets/<name>.<first 12 hex digits of the body's SHA-256>.<ext>", () => {
    for (const asset of ASSETS) {
      const hash = createHash("sha256").update(asset.body).digest("hex").slice(0, 12);
      expect(asset.path).toMatch(
        new RegExp(`^/assets/[a-z0-9-]+\\.${hash}\\.(?:css|svg|txt|woff2)$`, "u"),
      );
    }
    expect(new Set(ASSETS.map((asset) => asset.path)).size).toBe(ASSETS.length);
    // Every font and the notices are served, not just built.
    expect(ASSETS).toEqual(
      expect.arrayContaining([NOTICES, FONTS.display, FONTS.displayItalic, FONTS.sans, FONTS.mono]),
    );
  });

  test("the notices are UTF-8 text naming every component they license", () => {
    expect(NOTICES.path).toMatch(/^\/assets\/licenses\.[0-9a-f]{12}\.txt$/u);
    expect(NOTICES.contentType).toBe("text/plain; charset=utf-8");
    for (const component of [
      "@fontsource/instrument-serif",
      "@fontsource-variable/manrope",
      "@fontsource-variable/jetbrains-mono",
      "lucide-static",
      "SIL OPEN FONT LICENSE Version 1.1",
      "ISC License",
      "The MIT License (MIT)",
    ])
      expect(NOTICES.body).toContain(component);
  });

  test("the stylesheet opens with the font faces and is hashed after they were put in", () => {
    const body = String(STYLESHEET.body);
    expect(body.startsWith(FONT_FACES)).toBe(true);
    expect(STYLESHEET.path).toContain(createHash("sha256").update(body).digest("hex").slice(0, 12));
    // One face per font file, each at its hashed path, all shown with fallback text first.
    const urls = [...FONT_FACES.matchAll(/url\("([^"]+)"\)/gu)].map((match) => match[1]);
    expect(urls).toEqual([
      FONTS.display.path,
      FONTS.displayItalic.path,
      FONTS.sans.path,
      FONTS.mono.path,
    ]);
    expect(FONT_FACES.match(/@font-face \{/gu)).toHaveLength(4);
    expect(FONT_FACES.match(/font-display: swap;/gu)).toHaveLength(4);
    expect(FONT_FACES).toContain("font-weight: 400 700;");
    expect(FONT_FACES).toContain("font-weight: 400 600;");
    expect(FONT_FACES).toContain(NOTICES.path);
    // Whatever else the stylesheet holds, every url() in it is one of these assets: the CSP's
    // 'self' would refuse a font, image or data: URL from anywhere else.
    const served = new Set(ASSETS.map((asset) => asset.path));
    for (const match of body.matchAll(/url\(\s*["']?([^"')]+)/gu))
      expect({ url: match[1], served: served.has(match[1] ?? "") }).toEqual({
        url: match[1],
        served: true,
      });
  });

  test("the font faces declare the families the token font stacks name first", () => {
    const families = [...TOKENS_CSS.matchAll(/--font-(?:display|sans|mono): "([^"]+)"/gu)].map(
      (match) => match[1],
    );
    expect(families).toEqual(["Instrument Serif", "Manrope", "JetBrains Mono"]);
    for (const family of families) expect(FONT_FACES).toContain(`font-family: "${family}";`);
  });
});

describe("icons", () => {
  /** The vocabulary the dashboard's pages draw on (D11). */
  const REQUIRED: readonly IconName[] = [
    "activity",
    "arrow-up-right",
    "book-open",
    "chevron-down",
    "chevron-right",
    "circle-check",
    "circle-x",
    "clock",
    "compass",
    "external-link",
    "inbox",
    "info",
    "layout-dashboard",
    "list",
    "log-in",
    "log-out",
    "orbit",
    "refresh-cw",
    "scroll-text",
    "server",
    "settings",
    "shield-check",
    "telescope",
    "triangle-alert",
    "users",
  ];

  test("every required icon exists, and the names list is complete", () => {
    expect([...ICON_NAMES].sort()).toEqual([...REQUIRED].sort());
  });

  for (const name of ICON_NAMES)
    test(`${name} is a decorative svg with drawing elements only`, async () => {
      const markup = await render(icon(name));
      // The shared element, then upstream drawing elements with no whitespace, title, style or
      // link between them.
      expect(markup).toMatch(
        /^<svg class="orr-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">(?:<(?:path|circle|rect|line|polyline|polygon)(?: [a-z0-9-]+="[-0-9a-zA-Z. ]*")+\/>)+<\/svg>$/u,
      );
      const svg = fragment(markup).firstElementChild;
      expect(svg?.tagName.toLowerCase()).toBe("svg");
      expect(svg?.textContent).toBe("");
    });

  test("an icon beside a label leaves the label's text exactly as it was", async () => {
    const link = fragment(
      await render(
        html`<a href="/login">${icon("log-in")}Sign in with Discord${icon("chevron-right")}</a>`,
      ),
    ).querySelector("a");
    expect(link?.textContent).toBe("Sign in with Discord");
  });
});

describe("the shell", () => {
  const models = [
    { title: "TaruBot", signedIn: false },
    {
      title: "Background work",
      signedIn: true,
      guild: { id: "100000000000000001", name: "Example FC", nav: [] },
    },
  ];

  for (const model of models)
    test(`dark, same-origin, and links the notices (${model.guild ? "a server page" : "/"})`, async () => {
      const { document } = parseHTML(await render(layout(model, html`<p>Body</p>`)));
      expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
        "dark",
      );
      // Stylesheets, icons and images all come from the hashed assets: no font host, no CDN.
      const served = new Set(ASSETS.map((asset) => asset.path));
      for (const element of document.querySelectorAll("link[href], img[src], [srcset]")) {
        const target = element.getAttribute("href") ?? element.getAttribute("src");
        expect({ target, served: served.has(target ?? "") }).toEqual({ target, served: true });
      }
      const notices = document.querySelector(`footer a[href="${NOTICES.path}"]`);
      expect(notices?.textContent).toBe("Third-party licenses");
    });
});

describe("the stylesheet", () => {
  /** The served stylesheet without its comments, which may name what the rules avoid. */
  const css = String(STYLESHEET.body).replace(/\/\*[\s\S]*?\*\//gu, "");

  /** A rule body for `selector`, from the first rule that lists it. */
  const ruleFor = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
  };

  /** Every `@media <query>` block's text, each up to its closing brace at the start of a line. */
  const mediaBlock = (query: string): string => {
    const blocks: string[] = [];
    for (
      let at = css.indexOf(`@media ${query} {`);
      at >= 0;
      at = css.indexOf(`@media ${query} {`, at + 1)
    )
      blocks.push(css.slice(at, css.indexOf("\n}\n", at)));
    expect({ query, found: blocks.length > 0 }).toEqual({ query, found: true });
    return blocks.join("\n");
  };

  test("is dark only, with no light palette or theme switch", () => {
    expect(css).toContain("color-scheme: dark;");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain("data-theme");
    expect(css).not.toMatch(/color-scheme: dark light/u);
  });

  test("the holographic edge turns: it draws its own conic gradient from the animated angle", () => {
    // A token holding the gradient would resolve --holo-angle once, on :root, and never turn.
    expect(css).not.toContain("--holo-conic");
    expect(ruleFor(".orr-holo-edge::before")).toContain(
      "background: conic-gradient(from var(--holo-angle, 0deg), var(--holo-stops));",
    );
    expect(ruleFor(".orr-holo-edge::before")).toContain("animation: orr-holo-spin");
  });

  test("backdrops are fixed layers, and the link hover can't bleed into link components", () => {
    expect(css).not.toContain("background-attachment: fixed");
    expect(ruleFor(".console-page::before")).toContain("position: fixed;");
    expect(ruleFor(".orr-starfield.entry-backdrop")).toContain("position: fixed;");
    // At zero specificity, so a button or nav item that is a link keeps its own color.
    expect(css).toContain(":where(a:hover) {");
    expect(css).not.toMatch(/^a:hover/mu);
  });

  test("focus is an outline, which forced colors keep, not only a box-shadow ring", () => {
    expect(ruleFor(":focus-visible")).toContain("outline: 2px solid var(--focus-ring);");
    expect(css).not.toMatch(/outline: none/u);
  });

  test("reduced motion stops the loops, the entrance, the spinner, the sheen, lift and press", () => {
    const block = mediaBlock("(prefers-reduced-motion: reduce)");
    for (const selector of [
      ".orr-enter",
      ".orr-holo-text",
      ".orr-holo-edge::before",
      ".orr-starfield::before",
      ".orr-orbit__ring",
      ".orr-pulse-dot",
      ".orr-spinner",
      ".orr-btn--primary",
      ".orr-btn--primary::after",
      ".orr-btn:active:not(:disabled)",
      ".orr-card--interactive:hover",
    ])
      expect({ selector, stopped: block.includes(selector) }).toEqual({ selector, stopped: true });
    expect(block).toContain("animation: none !important;");
    expect(block).toContain("transition-duration: 0s !important;");
  });

  test("reduced transparency, forced colors and print each have their fallback", () => {
    for (const glass of [".orr-card", ".sidebar", ".topbar", ".orr-btn--secondary"])
      expect(mediaBlock("(prefers-reduced-transparency: reduce)")).toContain(glass);
    const forced = mediaBlock("(forced-colors: active)");
    for (const edged of [".orr-card", ".orr-badge", ".check", ".marker", ".orr-btn"])
      expect(forced).toContain(edged);
    expect(forced).toContain("border: 1px solid");
    const print = mediaBlock("print");
    expect(print).toContain("color: #000 !important;");
    for (const chrome of [".sidebar", ".topbar", ".entry-bar", ".entry-backdrop"])
      expect(print).toContain(chrome);
  });

  test("every class the shell and the entry pages render has a rule", async () => {
    const pages = [
      layout({ title: "TaruBot", signedIn: false }, renderHome({ signedIn: false })),
      layout(
        { title: "Your servers", signedIn: true },
        renderHome({
          signedIn: true,
          servers: [
            {
              id: "100000000000000001",
              name: "Example FC",
              links: [{ href: "/g/100000000000000001/status", label: "Status", current: false }],
            },
          ],
        }),
      ),
      layout(
        { title: "Your servers", signedIn: true },
        renderHome({ signedIn: true, servers: [] }),
      ),
      layout({ title: "No access", signedIn: false }, renderNoAccess()),
      errorPage(
        { status: 404, code: "not_found", ref: "r", message: null, retryAfter: 0, level: "info" },
        true,
      ),
      layout(
        {
          title: "Background work",
          signedIn: true,
          guild: {
            id: "100000000000000001",
            name: "Example FC",
            nav: [
              {
                href: "/g/100000000000000001/status",
                label: "Background work",
                current: true,
                icon: "activity",
              },
            ],
          },
        },
        html`<p>Body</p>`,
      ),
    ];
    const classes = new Set<string>();
    for (const markup of await Promise.all(pages.map(render)))
      for (const element of parseHTML(markup).document.querySelectorAll("[class]"))
        for (const name of element.classList) classes.add(name);
    expect(classes.size).toBeGreaterThan(40);
    for (const name of classes)
      expect({ name, styled: new RegExp(`\\.${name}(?![\\w-])`, "u").test(css) }).toEqual({
        name,
        styled: true,
      });
  });
});
