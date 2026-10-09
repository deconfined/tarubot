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
import { errorPage, type LayoutModel, layout } from "../../src/web/layout.js";
import { TOKENS_CSS } from "../../src/web/styles/tokens.js";
import { notice } from "../../src/web/views/forms.js";
import { renderHome, renderNoAccess } from "../../src/web/views/servers.js";
import { KIT_DEFAULTS, KIT_ERRORS, kitForm } from "../fixtures/web-forms.js";

/** An invented form token for the signed-in shells. */
const TOKEN = Buffer.from("form-token-for-tests-00000000000").toString("base64url");

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
  const models: LayoutModel[] = [
    { title: "TaruBot", signedIn: false },
    {
      title: "Background work",
      signedIn: true,
      formToken: TOKEN,
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

  /** A selector list's entries: split at its own commas, not those inside :is() or :where(). */
  const entries = (list: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (const [at, character] of [...list].entries()) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      else if (character === "," && depth === 0) {
        out.push(list.slice(start, at));
        start = at + 1;
      }
    }
    return [...out, list.slice(start)].map((selector) => selector.trim());
  };

  /** The style rules in `text`, nested ones included; at-rule preludes are left out. */
  const rules = (text: string): Rule[] =>
    [...text.replace(/@[^{;]*\{/gu, "{").matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
      selectors: entries(match[1] ?? ""),
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

  test("form fields have a real border frame and native checks, so forced colors keep both", () => {
    // The frame is a border, never only the export's inset box-shadow, which forced colors drop.
    const input = ruleFor(".orr-input");
    expect(input).toContain("border: 1px solid var(--border-control);");
    // That frame is the only sign of where to type, so it is opaque (WCAG 1.4.11's 3:1), and
    // hover lightens it rather than fading it to a translucent border.
    expect(css).toContain("--border-control: oklch(0.6 0.04 280);");
    expect(css).toContain("--border-control-hover: oklch(0.72 0.05 280);");
    expect(ruleFor(".orr-input:hover:not(:disabled)")).toContain(
      "border-color: var(--border-control-hover);",
    );
    expect(input).not.toMatch(/box-shadow:[^;]*inset 0 0 0 1px/u);
    // The control keeps base.ts's focus outline: nothing turns it off (the stylesheet test above
    // pins "outline: none" absent), and the glow only adds to it.
    expect(ruleFor(".orr-input:focus-visible")).not.toContain("outline");
    // Checkboxes and radios are the real inputs, tinted, never hidden under a drawn box.
    expect(ruleFor(".orr-check__input")).toContain("accent-color: var(--accent);");
    expect(css).not.toContain(".orr-check__box");
    expect(css).not.toMatch(/\.orr-check[^{]*\{[^}]*opacity: 0;/u);
    expect(css).not.toMatch(/appearance: none/u);
    // An invalid field shows it in the border too, not by color of the text alone.
    expect(css).toContain('.orr-input[aria-invalid="true"]');
    // Phones zoom into fields under 16px, so the controls' text is 1rem; only a mouse on a wide
    // screen gets the kit's dense 14px.
    expect(input).toContain("font-size: 1rem;");
    expect(declaring("(min-width: 64rem) and (pointer: fine)", "font-size:")).toEqual([
      ".orr-input",
    ]);
    // The fieldset's own frame is reset for choice groups.
    expect(ruleFor(".choice-group")).toContain("border: 0;");
    expect(declaring("(forced-colors: active)", "border: 1px solid CanvasText;")).toEqual(
      expect.arrayContaining([".orr-input", ".error-summary"]),
    );
    expect(declaring("print", "border: 1px solid #888;")).toEqual(
      expect.arrayContaining([".orr-input", ".error-summary"]),
    );
    // On phones tall enough to spare the room, the buttons stick in reach, clear of the home
    // indicator, and focus scrolls clear of them (WCAG 2.4.11); on paper they don't stick.
    const phone = "(max-width: 63.99rem) and (min-height: 30rem)";
    expect(declaring(phone, "position: sticky;")).toContain(".form-actions");
    expect(declaring(phone, "env(safe-area-inset-bottom)")).toEqual(
      expect.arrayContaining([".form-actions", "html:has(.form-actions)"]),
    );
    expect(declaring(phone, "scroll-padding-bottom:")).toContain("html:has(.form-actions)");
    expect(css).not.toMatch(/@media \(max-width: 63\.99rem\) \{[^@]*\.form-actions \{[^}]*sticky/u);
    expect(declaring("print", "position: static;")).toContain(".form-actions");
  });

  test("My roles' pills keep a 44px touch target, and the Save hint joins its row only off phones", () => {
    // Every pill is the label's to tap; only a mouse on a wider screen gets the denser 36px.
    expect(ruleFor(".my-category .orr-check")).toContain("min-height: 2.75rem;");
    expect(declaring("(min-width: 40rem) and (pointer: fine)", "min-height:")).toEqual([
      ".my-category .orr-check",
    ]);
    // The button and its hint share a row only from 64rem, where the Save row no longer sticks.
    expect(declaring("(min-width: 64rem)", "order: 1;")).toEqual([
      ".my-roles-form > .form-actions",
    ]);
    expect(declaring("(min-width: 64rem)", "order: 2;")).toEqual([
      ".my-roles-form > .my-roles-form__hint",
    ]);
  });

  test("Role menu's editors open on top of the page, so nothing in a card changes; targets 32px", () => {
    // No editor opens in place any more: no rule draws an open disclosure in a card's toolbar, or
    // changes the cards' grid while one is open (the owner's ask: nothing on the page moves).
    expect(css).not.toContain("::details-content");
    expect(css).not.toMatch(/\.menu-[\w-]+[^{}]*details/u);
    expect(css).not.toContain(".menu-categories:has(");
    expect(ruleFor(".menu-categories")).not.toContain("align-items");
    expect(css).not.toMatch(/\.menu-(?:tool|toolbar|states|moves)[^{]*\{[^}]*\border:/u);
    // The toolbar: a wrapper keeps each button with its panel, the button one of the row's items;
    // the state buttons and the moves each wrap as a unit, never a pair split across rows.
    expect(ruleFor(".menu-tool")).toContain("display: contents;");
    expect(ruleFor(".menu-moves")).toContain("display: flex;");
    expect(css).toContain(".menu-states,\n.menu-moves {");
    // A closed dialog stays display: none (the browser's rule): no rule for a panel that isn't
    // open sets its display. The base rules replace the browser's dialog and popover look.
    const panelRules = rules(css).filter((rule) =>
      rule.selectors.some((selector) =>
        /(?:^|[\s>])\.overlay(?:--(?:wide|narrow))?$/u.test(selector),
      ),
    );
    expect(panelRules.length).toBeGreaterThan(0);
    for (const rule of panelRules)
      expect({ selectors: rule.selectors, display: rule.body.includes("display:") }).toEqual({
        selectors: rule.selectors,
        display: false,
      });
    for (const declaration of ["max-width: none;", "padding: 0;", "border: 0;"])
      expect(ruleFor(".overlay")).toContain(declaration);
    // Open (a modal dialog or a popover in the top layer, or a refused editor drawn open), it is
    // fixed over the page, its top a fixed way down so it only ever grows downward, its body
    // scrolling under its head; centred over the page's column beside the fixed sidebar.
    const open = ":is(.overlay--open, .overlay:popover-open, .overlay:modal)";
    for (const declaration of [
      "position: fixed;",
      "margin: min(12dvh, 6rem) auto auto;",
      "max-height: calc(100dvh - 2 * min(12dvh, 6rem));",
      "width: min(100% - 2 * var(--space-4), var(--overlay-width));",
      "backdrop-filter: var(--glass-blur);",
    ])
      expect(ruleFor(open)).toContain(declaration);
    expect(ruleFor(`${open} > .overlay__body`)).toContain("overflow: auto;");
    expect(ruleFor(".overlay--wide")).toContain("--overlay-width: 48rem;");
    expect(declaring("(min-width: 64rem)", "inset-inline-start: var(--sidebar-w);")).toEqual([
      open,
    ]);
    // While it is open the page under it neither scrolls nor, under a popover (no invoker
    // commands), takes the click that closes it; the scrollbar's gutter stays, so nothing moves.
    expect(ruleFor(":root:has(.overlay:popover-open) .app")).toContain("pointer-events: none;");
    expect(ruleFor(".overlay")).toContain("pointer-events: auto;");
    expect(ruleFor(":root:has(.overlay)")).toContain("scrollbar-gutter: stable;");
    expect(ruleFor(`:root:has(${open})`)).toContain("overflow: hidden;");
    // On a phone, a sheet from the bottom edge, as tall as its content (the owner finds empty
    // bands hard to read): no fixed height, only a ceiling. A short screen gives the panel nearly
    // its height.
    expect(declaring("(max-width: 39.99rem)", "inset: auto 0 0;")).toEqual([open]);
    expect(declaring("(max-width: 39.99rem)", "env(safe-area-inset-bottom)")).toEqual([open]);
    expect(declaring("(max-width: 39.99rem)", "max-height: 85dvh;")).toEqual([open]);
    expect(
      rules(mediaBlock("(max-width: 39.99rem)")).filter((rule) =>
        /(?:^|\s)height: 85dvh;/u.test(rule.body),
      ),
    ).toEqual([]);
    expect(declaring("(max-width: 39.99rem)", "margin-top: auto;")).toEqual([]);
    expect(declaring("(max-height: 29.99rem)", "max-height: calc(100dvh - 1rem);")).toEqual([open]);
    // Its button row is its foot at every width where there is room: stuck to the panel's own
    // bottom edge, flush with it whether or not the body scrolls.
    for (const declaration of [
      "position: sticky;",
      "bottom: calc(-1 * var(--overlay-foot));",
      "margin: 0 calc(1px - var(--card-pad)) calc(-1 * var(--overlay-foot));",
    ])
      expect(declaring("(min-height: 30rem)", declaration)).toEqual([`${open} .form-actions`]);
    expect(css).not.toContain(".menu-tool > .overlay");
    // A form's own message (a 409's, in the editor holding it) stays at the form's top: Edit
    // category's side-by-side layout reorders each field's hint and error within the field only.
    expect(ruleFor(".menu-form .orr-field > .orr-field__hint--error")).toContain("order: 1;");
    expect(css).not.toMatch(/\.menu-form \.orr-field__hint/u);
    // The page under it dims and blurs a little, fading in; a refused editor's backdrop is an
    // element.
    expect(ruleFor(".overlay::backdrop")).toContain("backdrop-filter: blur(2px);");
    expect(ruleFor(".overlay::backdrop")).toContain("transition: opacity");
    expect(ruleFor(":is(.overlay:popover-open, .overlay:modal)::backdrop")).toContain(
      "opacity: 0;",
    );
    expect(ruleFor(".overlay-backdrop")).toContain("position: fixed;");
    expect(ruleFor(".overlay-backdrop")).toContain("inset: 0;");
    // Its button is lit while it is open, or while it holds a refused form.
    expect(
      ruleFor(
        ".menu-toolbar .menu-opener:is(a, .menu-opener--kept, :has(+ :is(.overlay:modal, .overlay:popover-open)))",
      ),
    ).toContain("color: var(--accent-strong);");
    // The page entrance would make main the fixed panel's frame while it plays.
    expect(ruleFor("main.orr-enter:has(.overlay--open)")).toContain("animation: none;");
    // Each preference has its fallback: no rise or fade, solid surfaces, real borders and no
    // blur under forced colors, nothing on paper.
    expect(declaring("(prefers-reduced-motion: reduce)", "transition: none;")).toEqual(
      expect.arrayContaining([":is(.overlay:popover-open, .overlay:modal)", ".overlay::backdrop"]),
    );
    expect(declaring("(prefers-reduced-transparency: reduce)", "backdrop-filter: none;")).toEqual(
      expect.arrayContaining([open, ".overlay::backdrop", ".overlay-backdrop"]),
    );
    expect(declaring("(forced-colors: active)", "border: 1px solid CanvasText;")).toContain(
      ".overlay",
    );
    expect(declaring("(forced-colors: active)", "background: Canvas;")).toEqual([open]);
    expect(declaring("(forced-colors: active)", "backdrop-filter: none;")).toEqual(
      expect.arrayContaining([open, ".overlay::backdrop", ".overlay-backdrop"]),
    );
    expect(declaring("print", "display: none;")).toEqual(
      expect.arrayContaining([".overlay-backdrop", ".overlay--open"]),
    );
    // The toolbar's buttons: 32px tall, 40px for a finger. Add roles' rows: the label covers each
    // row, at least 32px tall, 44px for a finger.
    expect(ruleFor(".menu-states .orr-btn,\n.menu-moves .orr-btn,\n.menu-opener")).toContain(
      "min-height: 2rem;",
    );
    expect(declaring("(pointer: coarse)", "min-height: 2.5rem;")).toEqual(
      expect.arrayContaining([".menu-opener", ".overlay__close"]),
    );
    expect(ruleFor(".menu-add .orr-check")).toContain("min-height: 2rem;");
    expect(ruleFor(".menu-add .orr-check__label::after")).toContain("inset: 0;");
    expect(declaring("(pointer: coarse)", "min-height: 2.75rem;")).toContain(
      ".menu-add .orr-check",
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
        { title: "Your servers", signedIn: true, formToken: TOKEN },
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
        { title: "Your servers", signedIn: true, formToken: TOKEN },
        renderHome({ signedIn: true, servers: [] }),
      ),
      layout({ title: "No access", signedIn: false }, renderNoAccess()),
      errorPage(
        { status: 404, code: "not_found", ref: "r", message: null, retryAfter: 0, level: "info" },
        TOKEN,
      ),
      layout(
        {
          title: "Background work",
          signedIn: true,
          formToken: TOKEN,
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
      // A form page: every piece of the form kit, refused (the summary and field errors) and
      // after a save (the notice).
      layout(
        {
          title: "Role menu",
          signedIn: true,
          formToken: TOKEN,
          error: true,
          guild: { id: "100000000000000001", name: "Example FC", nav: [] },
        },
        html`${notice(new URL("https://example.org/g/1/x?notice=saved"), { saved: "Saved." })}${kitForm("/g/100000000000000001/role-menu", TOKEN, KIT_DEFAULTS, KIT_ERRORS)}`,
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
