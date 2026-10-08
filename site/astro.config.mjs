// Static documentation site: built into site/dist and published to GitHub Pages under /tarubot/.
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

export default defineConfig({
  site: "https://deconfined.github.io",
  base: "/tarubot",
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
          scrollbarThumbColor: "var(--night-600)",
          scrollbarThumbHoverColor: "var(--night-500)",
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
  ],
});
