// Static documentation site: built into site/dist and published to GitHub Pages under /tarubot/.
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

/** The element children of a HAST node. */
const elementsOf = (node) => (node.children ?? []).filter((child) => child.type === "element");

/** A section heading below the page title: h2 to h6. */
const isHeading = (node) => node?.type === "element" && /^h[2-6]$/u.test(node.tagName);

/**
 * The heading a Markdown block sits under: the nearest earlier heading among its siblings, then
 * among each ancestor's. Starlight wraps each heading in a div with its anchor link, so a wrapper
 * whose first element is a heading counts as that heading.
 */
function sectionHeading(node, ctx) {
  let child = node;
  let parent = ctx.parent(child);
  while (parent) {
    for (const sibling of parent.children.slice(0, ctx.indexOf(child)).reverse()) {
      if (sibling.type !== "element") continue;
      const lead = sibling.tagName === "div" ? elementsOf(sibling)[0] : sibling;
      if (isHeading(lead)) return lead;
    }
    child = parent;
    parent = ctx.parent(child);
  }
  return undefined;
}

/**
 * Markdown tables, for the page styles in components.css. Each table goes into a labelled scroll
 * region that the keyboard can focus, so a table wider than the column can be scrolled without a
 * pointer: Chrome and Firefox focus a scrolling box by themselves, Safari doesn't. The region is
 * named by the table's section heading, or else by the page title, with a number from a section's
 * second table on. Each body cell also carries its column's name in data-label, which a narrow
 * column shows when it stacks the rows, and every part keeps its table role explicitly, because
 * changing a table's display drops the implicit roles in WebKit. A factory, so the count of tables
 * per section starts afresh for each page.
 */
const tableRegions = () => {
  const tablesPerSection = new Map();
  return {
    name: "tarubot-table-regions",
    element: {
      filter: ["table"],
      visit(table, ctx) {
        const columns = [];
        ctx.setProperty(table, "role", "table");
        for (const group of elementsOf(table)) {
          ctx.setProperty(group, "role", "rowgroup");
          for (const row of elementsOf(group)) {
            ctx.setProperty(row, "role", "row");
            for (const [index, cell] of elementsOf(row).entries()) {
              if (cell.tagName === "th") {
                columns[index] = ctx.textContent(cell).trim();
                ctx.setProperty(cell, "role", "columnheader");
              } else {
                ctx.setProperty(cell, "role", "cell");
                if (columns[index]) ctx.setProperty(cell, "data-label", columns[index]);
              }
            }
          }
        }
        // Starlight renders every page title as h1#_top, outside the Markdown.
        const heading = sectionHeading(table, ctx);
        const id = typeof heading?.properties?.id === "string" ? heading.properties.id : "_top";
        const title = heading ? ctx.textContent(heading) : ctx.data.astro?.frontmatter?.title;
        const count = (tablesPerSection.get(id) ?? 0) + 1;
        tablesPerSection.set(id, count);
        const name =
          count === 1
            ? { "aria-labelledby": id }
            : { "aria-label": `${title ?? "Table"}, table ${count}` };
        ctx.wrapNode(table, {
          type: "element",
          tagName: "div",
          properties: { class: "table-scroll", role: "region", tabindex: "0", ...name },
          children: [],
        });
      },
    },
  };
};

/**
 * Adds tableRegions to Astro's Markdown processor, the way Starlight adds its own transforms. Astro
 * 7 renders Markdown with Sätteri, which runs HAST plugins of its own shape; markdown.rehypePlugins
 * would need the unified processor this site doesn't install.
 */
const markdownTables = {
  name: "tarubot-markdown-tables",
  hooks: {
    "astro:config:setup": ({ config }) => {
      const { processor } = config.markdown;
      if (processor.name !== "satteri")
        throw new Error(`Markdown tables need the Sätteri processor, not "${processor.name}".`);
      processor.options.hastPlugins.push(tableRegions);
    },
  },
};

export default defineConfig({
  site: "https://deconfined.github.io",
  base: "/tarubot",
  // Guide screenshots (src/assets) are committed already compressed and served as they are, with
  // their size read from the file, so the docs toolchain needs no image-processing package (sharp).
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "TaruBot",
      description: "A Discord bot for Final Fantasy XIV Free Companies.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/deconfined/tarubot" }],
      editLink: { baseUrl: "https://github.com/deconfined/tarubot/edit/main/site/" },
      // Dark only, like the dashboard: the browser paints its own UI dark before any CSS loads.
      head: [{ tag: "meta", attrs: { name: "color-scheme", content: "dark" } }],
      // The design tokens (shared with the dashboard), the self-hosted fonts, then the Starlight
      // theme built on them. Order matters where rules meet: each file overrides those before it.
      customCss: [
        "./src/styles/tokens.css",
        "./src/styles/fonts.css",
        "./src/styles/theme.css",
        "./src/styles/effects.css",
        "./src/styles/components.css",
      ],
      // Both or neither: the stock ThemeSelect's inline script calls a global that only the stock
      // ThemeProvider defines. Emptied together, no script switches html[data-theme] away from the
      // "dark" that Starlight renders on the server.
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      // One dark code theme, so no light code CSS ships. Naming a theme turns off Starlight's own
      // binding of code frames to its palette, so the frames are bound to the design tokens here.
      expressiveCode: {
        themes: ["starlight-dark"],
        styleOverrides: {
          borderRadius: "var(--radius-md)",
          borderColor: "var(--border-default)",
          codeBackground: "var(--surface-1)",
          focusBorder: "var(--focus-ring)",
          // A restyled thumb is the only cue that a long line scrolls, so like the dashboard's it
          // keeps 3:1 against the code background: night-400 is 4:1 on surface-1, night-600 1.5:1.
          scrollbarThumbColor: "var(--night-400)",
          scrollbarThumbHoverColor: "var(--night-300)",
          frames: {
            editorBackground: "var(--surface-1)",
            editorTabBarBackground: "var(--bg-raised)",
            editorTabBarBorderBottomColor: "var(--border-subtle)",
            editorActiveTabBackground: "var(--surface-1)",
            editorActiveTabForeground: "var(--text-secondary)",
            editorActiveTabIndicatorTopColor: "var(--accent)",
            terminalBackground: "var(--surface-1)",
            terminalTitlebarBackground: "var(--bg-raised)",
            terminalTitlebarForeground: "var(--text-muted)",
            terminalTitlebarBorderBottomColor: "var(--border-subtle)",
            terminalTitlebarDotsForeground: "var(--night-500)",
            terminalTitlebarDotsOpacity: "1",
            inlineButtonForeground: "var(--text-secondary)",
            inlineButtonBorder: "var(--border-strong)",
            tooltipSuccessBackground: "var(--green-900)",
            tooltipSuccessForeground: "var(--text-primary)",
            frameBoxShadowCssValue: "var(--shadow-1)",
          },
        },
      },
      // Fails the build on broken internal links and #anchors; external links are not checked.
      plugins: [starlightLinksValidator()],
      // Starlight 0.39+ accepts autogenerate only inside a group's items array.
      sidebar: [
        { label: "Use TaruBot", items: [{ autogenerate: { directory: "use" } }] },
        { label: "Run a server", items: [{ autogenerate: { directory: "admin" } }] },
        { label: "Deploy and operate", items: [{ autogenerate: { directory: "deploy" } }] },
        {
          label: "Architecture and design",
          items: [{ autogenerate: { directory: "architecture" } }],
        },
        { label: "Reference", items: [{ autogenerate: { directory: "reference" } }] },
        {
          label: "Project",
          items: [
            { label: "Roadmap", slug: "project/roadmap" },
            { label: "Thank you", slug: "project/credits" },
            {
              label: "Changelog",
              link: "https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md",
            },
            {
              label: "Security policy",
              link: "https://github.com/deconfined/tarubot/security/policy",
            },
            {
              label: "License (AGPL-3.0)",
              link: "https://github.com/deconfined/tarubot/blob/main/LICENSE",
            },
          ],
        },
      ],
    }),
    markdownTables,
  ],
});
