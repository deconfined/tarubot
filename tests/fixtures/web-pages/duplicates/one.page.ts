/** One of two fixture pages claiming the same path, which must fail discovery. */
import { html } from "../../../../src/web/html.js";
import { definePage } from "../../../../src/web/page.js";

export default definePage({
  path: "/g/:guild/twin",
  title: "Twin",
  access: ["officer"],
  requires: [],
  get: () => html`<p>Twin fixture</p>`,
});
