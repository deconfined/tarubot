/** A nested fixture page: discovery recurses, and keys pages by path in file-name order. */
import { html } from "../../../../../src/web/html.js";
import { definePage } from "../../../../../src/web/page.js";

export default definePage({
  path: "/g/:guild/alpha",
  title: "Alpha",
  access: ["manager"],
  requires: [],
  get: () => html`<p>Alpha fixture</p>`,
});
