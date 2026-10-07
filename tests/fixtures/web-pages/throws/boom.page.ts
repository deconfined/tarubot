/**
 * A discovered fixture page whose get() throws a string, not an Error. Hono's onError receives
 * only Errors and rethrows anything else, so this reaches Bun.serve's error() on the real
 * listener (tests/unit/web-server.test.ts), the path no app.request() test can exercise.
 */
import { definePage } from "../../../../src/web/page.js";

/** The thrown value; it must never reach a response body, a header or a log line. */
export const THROWN = "non-error secret 9f1 that must never reach a page";

export default definePage({
  path: "/g/:guild/boom",
  title: "Boom",
  access: ["officer"],
  requires: [],
  get: () => {
    throw THROWN;
  },
});
