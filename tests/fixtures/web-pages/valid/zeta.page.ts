/** A discovered fixture page for officers, with a navigation label and no services. */
import { html } from "../../../../src/web/html.js";
import { definePage } from "../../../../src/web/page.js";

export default definePage({
  path: "/g/:guild/zeta",
  title: "Zeta",
  access: ["officer"],
  requires: [],
  nav: "Zeta",
  get: () => html`<p>Zeta fixture</p>`,
});
