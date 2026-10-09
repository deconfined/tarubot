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
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { ASSETS, FONT_FACES, FONTS, NOTICES, STYLESHEET } from "../../src/web/assets.js";
import { html, type SafeHtml } from "../../src/web/html.js";
import { ICON_NAMES, icon } from "../../src/web/icons.js";
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
      expect.arrayContaining([NOTICES, FONTS.display, FONTS.sans, FONTS.mono]),
    );
  });

  test("the notices are UTF-8 text naming every component they license", () => {
    expect(NOTICES.path).toMatch(/^\/assets\/licenses\.[0-9a-f]{12}\.txt$/u);
    expect(NOTICES.contentType).toBe("text/plain; charset=utf-8");
    for (const component of [
      "@fontsource-variable/sora",
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
    expect(urls).toEqual([FONTS.display.path, FONTS.sans.path, FONTS.mono.path]);
    expect(FONT_FACES.match(/@font-face \{/gu)).toHaveLength(3);
    expect(FONT_FACES.match(/font-display: swap;/gu)).toHaveLength(3);
    // Sora ships no italic and none is declared; Sora and Manrope 400-700, JetBrains Mono 400-600.
    expect(FONT_FACES).not.toContain("font-style: italic;");
    expect(FONT_FACES.match(/font-weight: 400 700;/gu)).toHaveLength(2);
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
    expect(families).toEqual(["Sora", "Manrope", "JetBrains Mono"]);
    for (const family of families) expect(FONT_FACES).toContain(`font-family: "${family}";`);
  });
});

describe("icons", () => {
  test("every icon is one a page draws: the shell, a view or a page module names it", async () => {
    // icons.ts holds only the icons in use. An icon name is quoted where it is drawn: icon("…"),
    // a view's readout("…"), or a line of its own in a record (a page's `icon: "…",`, a view's
    // mark table). Any other quoted word doesn't count, as a common one such as "info" or "list"
    // can appear for another reason (http.ts quotes "info" as a log level).
    const web = fileURLToPath(new URL("../../src/web/", import.meta.url));
    const sources: string[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: web }))
      if (path !== "icons.ts") sources.push(await Bun.file(`${web}${path}`).text());
    const source = sources.join("\n");
    const drawn = (name: string): boolean =>
      new RegExp(`(?:icon\\(|readout\\()"${name}"|^\\s*[\\w-]+: "${name}",?$`, "mu").test(source);
    expect(ICON_NAMES.filter((name) => !drawn(name))).toEqual([]);
    expect(ICON_NAMES.length).toBeGreaterThan(0);
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

  /** One rule: its selectors, one per comma-separated entry, and its declarations. */
  interface Rule {
    readonly selectors: readonly string[];
    readonly body: string;
  }

  /** The style rules in `text`, nested ones included; at-rule preludes are left out. */
  const rules = (text: string): Rule[] =>
    [...text.replace(/@[^{;]*\{/gu, "{").matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
      selectors: (match[1] ?? "").split(",").map((selector) => selector.trim()),
      body: match[2] ?? "",
    }));

  /**
   * The selectors of the rules in every `@media <query>` block that make `declaration`: a
   * selector counts only in the rule that declares it, not anywhere in the block.
   */
  const declaring = (query: string, declaration: string): string[] =>
    rules(mediaBlock(query))
      .filter((rule) => rule.body.includes(declaration))
      .flatMap((rule) => rule.selectors);

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
    // An outline that marks a state in forced colors (the current page) outranks the focus ring,
    // so each one gets a focus rule of its own, or focus there would change nothing (WCAG 2.4.7).
    const outlined = declaring("(forced-colors: active)", "outline:");
    expect(outlined.length).toBeGreaterThan(0);
    for (const selector of outlined.filter((entry) => !entry.endsWith(":focus-visible")))
      expect({ selector, focus: outlined.includes(`${selector}:focus-visible`) }).toEqual({
        selector,
        focus: true,
      });
  });

  test("reduced motion stops every animation, the sheen, the press and the nudge", () => {
    const motion = "(prefers-reduced-motion: reduce)";
    // Every rule that starts an animation is named in the rule that stops animations.
    const animated = rules(css)
      .filter((rule) => /(?:^|[;{\s])animation:(?!\s*none\b)/u.test(rule.body))
      .flatMap((rule) => rule.selectors);
    expect(animated).toEqual(
      expect.arrayContaining([
        ".orr-enter",
        ".orr-holo-edge::before",
        ".orr-starfield::before",
        ".orr-orbit__ring",
        ".orr-btn--primary",
      ]),
    );
    const stopped = declaring(motion, "animation: none !important;");
    for (const selector of animated)
      expect({ selector, stopped: stopped.includes(selector) }).toEqual({
        selector,
        stopped: true,
      });
    expect(declaring(motion, "display: none;")).toContain(".orr-btn--primary::after");
    expect(declaring(motion, "transform: none;")).toEqual(
      expect.arrayContaining([
        ".orr-btn:active:not(:disabled)",
        ".server-tile__link:hover > .orr-icon:last-child",
      ]),
    );
    expect(declaring(motion, "transition-duration: 0s !important;")).toEqual(
      expect.arrayContaining(["*", "*::before", "*::after"]),
    );
  });

  test("reduced transparency, forced colors and print each have their fallback", () => {
    expect(declaring("(prefers-reduced-transparency: reduce)", "backdrop-filter: none;")).toEqual(
      expect.arrayContaining([".orr-card", ".sidebar", ".topbar", ".orr-btn--secondary"]),
    );
    expect(declaring("(forced-colors: active)", "border: 1px solid")).toEqual(
      expect.arrayContaining([".orr-card", ".check", ".marker", ".orr-btn"]),
    );
    expect(declaring("print", "color: #000 !important;")).toContain("*");
    expect(declaring("print", "display: none !important;")).toEqual(
      expect.arrayContaining([".sidebar", ".topbar", ".entry-bar", ".entry-backdrop"]),
    );
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
