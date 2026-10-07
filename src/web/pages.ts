/**
 * Web page discovery (#43, ADR D12), on the same deterministic loader as commands, components and
 * events. It lives here rather than in src/bot/discovery.ts so the registration and command tools,
 * which import discovery, never load web code.
 */
import { index, load } from "../bot/discovery.js";
import { Page } from "./page.js";

/** Resolves relative to this module in either source or compiled output. */
export const pagesDirectory = new URL("./pages/", import.meta.url);

/**
 * Every `*.page.ts` (or compiled `.page.js`) under the directory, keyed by path. A default export
 * that isn't a Page or a duplicate path throws; startWeb reports that and keeps the web off.
 */
export async function loadPages(
  directory: URL = pagesDirectory,
): Promise<ReadonlyMap<string, Page>> {
  return index(
    await load(directory, "page", (value): value is Page => value instanceof Page),
    (page) => page.path,
    "page path",
  );
}
