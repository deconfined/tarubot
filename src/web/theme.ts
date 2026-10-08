/** Bundled generated design-system v4 CSS. Regenerate token values from the supplied tokens.json. */
export const DESIGN_TOKENS = `/* TaruBot — generated from tokens.json by tokens-to-css.py. Edit tokens.json, not this file. */
/* Themes: dark is the default; set data-theme="<id>" on <html> for another (light). */

:root,
[data-theme="dark"] {
  --mark: #3b5bdb;
  --on-mark: #ffffff;
  --void: #0a0f1d;
  --hull: #111a2e;
  --signal: #3dd6f5;
  --flare: #ffb547;
  --starlight: #f4f6fc;
  --glass: rgba(17, 26, 46, 0.8);
  --glass-edge: rgba(166, 239, 255, 0.22);
  --holo-cyan: #2bb8d9;
  --holo-violet: #8a7cff;
  --holo-rose: #f070c0;
  --holo-amber: #f5a524;
  --tone-success: #57f287;
  --tone-pending: #fee75c;
  --tone-info: #5865f2;
  --tone-warning: #e67e22;
  --tone-error: #ed4245;
  --tone-neutral: #99aab5;
  --sl-color-white: var(--starlight);
  --sl-color-gray-1: #e2e7f4;
  --sl-color-gray-2: #c3cce3;
  --sl-color-gray-3: #8391b5;
  --sl-color-gray-4: #34436a;
  --sl-color-gray-5: #1c2742;
  --sl-color-gray-6: var(--hull);
  --sl-color-black: var(--void);
  --sl-color-accent-low: #0c3340;
  --sl-color-accent: var(--signal);
  --sl-color-accent-high: #a6efff;
  --sl-color-text: var(--sl-color-gray-2);
  --sl-color-text-accent: var(--sl-color-accent-high);
  --sl-color-bg: var(--sl-color-black);
  --sl-color-bg-nav: var(--sl-color-gray-6);
  --sl-color-bg-sidebar: var(--sl-color-gray-6);
  --sl-color-bg-inline-code: var(--sl-color-gray-5);
  --sl-color-hairline: var(--sl-color-gray-6);
  --sl-color-blue-low: var(--sl-color-accent-low);
  --sl-color-blue: var(--sl-color-accent);
  --sl-color-blue-high: var(--sl-color-accent-high);
  --sl-color-orange-low: #3a2a0e;
  --sl-color-orange: var(--flare);
  --sl-color-orange-high: #ffdca3;
  --sl-color-red-low: #3d1320;
  --sl-color-red: #ff5c7a;
  --sl-color-red-high: #ffc2cd;
  --sl-shadow-sm: 0px 1px 1px hsla(0, 0%, 0%, 0.12), 0px 2px 1px hsla(0, 0%, 0%, 0.24);
  --sl-shadow-md: 0px 8px 4px hsla(0, 0%, 0%, 0.08), 0px 5px 2px hsla(0, 0%, 0%, 0.08), 0px 3px 2px hsla(0, 0%, 0%, 0.12), 0px 1px 1px hsla(0, 0%, 0%, 0.15);
  --sl-shadow-lg: 0px 25px 7px hsla(0, 0%, 0%, 0.03), 0px 16px 6px hsla(0, 0%, 0%, 0.1), 0px 9px 5px hsla(223, 13%, 10%, 0.33), 0px 4px 4px hsla(0, 0%, 0%, 0.75), 0px 4px 2px hsla(0, 0%, 0%, 0.25);
  --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 12px 32px rgba(2, 6, 18, 0.5);
}

[data-theme="light"] {
  --glass: rgba(247, 249, 253, 0.92);
  --glass-edge: rgba(0, 73, 91, 0.2);
  --sl-color-white: #0a0f1d;
  --sl-color-gray-1: #1a2340;
  --sl-color-gray-2: #2b3654;
  --sl-color-gray-3: #536080;
  --sl-color-gray-4: #8a96b4;
  --sl-color-gray-5: #c3cde1;
  --sl-color-gray-6: #e3e9f4;
  --sl-color-black: #f7f9fd;
  --sl-color-accent-low: #d2f3fa;
  --sl-color-accent: #00708a;
  --sl-color-accent-high: #00495b;
  --sl-color-text: var(--sl-color-gray-2);
  --sl-color-text-accent: var(--sl-color-accent);
  --sl-color-bg: var(--sl-color-black);
  --sl-color-bg-nav: #eef2f9;
  --sl-color-bg-sidebar: var(--sl-color-bg);
  --sl-color-bg-inline-code: var(--sl-color-gray-6);
  --sl-color-hairline: var(--sl-color-gray-6);
  --sl-color-blue-low: var(--sl-color-accent-low);
  --sl-color-blue: var(--sl-color-accent);
  --sl-color-blue-high: var(--sl-color-accent-high);
  --sl-color-orange-low: #fff0d6;
  --sl-color-orange: #c77800;
  --sl-color-orange-high: #6b4100;
  --sl-color-red-low: #ffe3e8;
  --sl-color-red: #d6264a;
  --sl-color-red-high: #8a0f2a;
  --sl-shadow-sm: 0px 1px 1px hsla(0, 0%, 0%, 0.06), 0px 2px 1px hsla(0, 0%, 0%, 0.06);
  --sl-shadow-md: 0px 8px 4px hsla(0, 0%, 0%, 0.03), 0px 5px 2px hsla(0, 0%, 0%, 0.03), 0px 3px 2px hsla(0, 0%, 0%, 0.06), 0px 1px 1px hsla(0, 0%, 0%, 0.06);
  --sl-shadow-lg: 0px 25px 7px rgba(0, 0, 0, 0.01), 0px 16px 6px hsla(0, 0%, 0%, 0.03), 0px 9px 5px hsla(223, 13%, 10%, 0.08), 0px 4px 4px hsla(0, 0%, 0%, 0.16), 0px 4px 2px hsla(0, 0%, 0%, 0.04);
  --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 8px 24px rgba(10, 15, 29, 0.1);
}

:root {
  --sl-content-pad-x: 1rem;
  --sl-content-gap-y: 1rem;
  --sl-nav-pad-x: 1rem;
  --sl-nav-pad-y: 0.75rem;
  --sl-sidebar-pad-x: 1rem;
  --radius-mark: 7px;
  --radius-pip: 2px;
  --radius-mention: 4px;
  --sl-content-width: 45rem;
  --sl-sidebar-width: 18.75rem;
  --sl-nav-height: 3.5rem;
  --holo-foil: linear-gradient(115deg, #2bb8d9 0%, #8a7cff 38%, #f070c0 68%, #f5a524 100%);
  --glass-filter: blur(14px) saturate(140%);
  --font-display: "Chakra Petch", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: "Martian Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.type-hero { font-family: var(--font-display); font-size: 64px; line-height: 1.0; font-weight: 600; letter-spacing: -0.01em; }
.type-h1 { font-family: var(--font-display); font-size: 35px; line-height: 1.2; font-weight: 600; }
.type-h2 { font-family: var(--font-display); font-size: 29px; line-height: 1.2; font-weight: 600; }
.type-h3 { font-family: var(--font-display); font-size: 24px; line-height: 1.2; font-weight: 600; }
.type-h4 { font-family: var(--font-display); font-size: 20px; line-height: 1.2; font-weight: 600; }
.type-h5 { font-family: var(--font-display); font-size: 18px; line-height: 1.2; font-weight: 600; }
.type-body { font-family: var(--font-sans); font-size: 16px; line-height: 1.75; font-weight: 400; }
.type-body-sm { font-family: var(--font-sans); font-size: 13px; line-height: 1.75; font-weight: 400; }
.type-code { font-family: var(--font-mono); font-size: 14px; font-weight: 400; }
.type-code-sm { font-family: var(--font-mono); font-size: 13px; font-weight: 400; }
.type-readout { font-family: var(--font-mono); font-size: 13px; font-weight: 500; }

/* The console follows the device without a script or a saved preference. */
@media (prefers-color-scheme: light) {
  :root {
  --glass: rgba(247, 249, 253, 0.92);
  --glass-edge: rgba(0, 73, 91, 0.2);
  --sl-color-white: #0a0f1d;
  --sl-color-gray-1: #1a2340;
  --sl-color-gray-2: #2b3654;
  --sl-color-gray-3: #536080;
  --sl-color-gray-4: #8a96b4;
  --sl-color-gray-5: #c3cde1;
  --sl-color-gray-6: #e3e9f4;
  --sl-color-black: #f7f9fd;
  --sl-color-accent-low: #d2f3fa;
  --sl-color-accent: #00708a;
  --sl-color-accent-high: #00495b;
  --sl-color-text: var(--sl-color-gray-2);
  --sl-color-text-accent: var(--sl-color-accent);
  --sl-color-bg: var(--sl-color-black);
  --sl-color-bg-nav: #eef2f9;
  --sl-color-bg-sidebar: var(--sl-color-bg);
  --sl-color-bg-inline-code: var(--sl-color-gray-6);
  --sl-color-hairline: var(--sl-color-gray-6);
  --sl-color-blue-low: var(--sl-color-accent-low);
  --sl-color-blue: var(--sl-color-accent);
  --sl-color-blue-high: var(--sl-color-accent-high);
  --sl-color-orange-low: #fff0d6;
  --sl-color-orange: #c77800;
  --sl-color-orange-high: #6b4100;
  --sl-color-red-low: #ffe3e8;
  --sl-color-red: #d6264a;
  --sl-color-red-high: #8a0f2a;
  --sl-shadow-sm: 0px 1px 1px hsla(0, 0%, 0%, 0.06), 0px 2px 1px hsla(0, 0%, 0%, 0.06);
  --sl-shadow-md: 0px 8px 4px hsla(0, 0%, 0%, 0.03), 0px 5px 2px hsla(0, 0%, 0%, 0.03), 0px 3px 2px hsla(0, 0%, 0%, 0.06), 0px 1px 1px hsla(0, 0%, 0%, 0.06);
  --sl-shadow-lg: 0px 25px 7px rgba(0, 0, 0, 0.01), 0px 16px 6px hsla(0, 0%, 0%, 0.03), 0px 9px 5px hsla(223, 13%, 10%, 0.08), 0px 4px 4px hsla(0, 0%, 0%, 0.16), 0px 4px 2px hsla(0, 0%, 0%, 0.04);
  --glass-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 8px 24px rgba(10, 15, 29, 0.1);
  }
}
`;
