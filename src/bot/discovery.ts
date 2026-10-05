/** Deterministic, recursive filesystem discovery shared by deployment and the bot runtime. */
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "./command.js";
import { Component } from "./component.js";
import { GatewayEvent } from "./event.js";
import type { BotContext } from "./context.js";

/** Defaults resolve relative to this module in either source or compiled output. */
export const moduleDirectories = {
  commands: new URL("../commands/", import.meta.url),
  events: new URL("../events/", import.meta.url),
  components: new URL("../components/", import.meta.url),
};

/** Scan only the active source/output extension; helpers and symlinks are not modules. */
async function files(directory: URL, kind: string): Promise<URL[]> {
  const extension = extname(fileURLToPath(import.meta.url));
  const found: URL[] = [];
  const walk = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(`.${kind}${extension}`))
        found.push(pathToFileURL(child));
    }
  };
  const root = fileURLToPath(directory);
  try {
    await walk(root);
  } catch (error) {
    // A removed final module leaves no compiled directory. Treat only that root as empty;
    // permission errors and disappearing nested directories still fail discovery.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      error.path === root
    )
      return [];
    throw error;
  }
  return found;
}

/**
 * Imported JavaScript is unknown until its default export passes the module-type guard. Exported
 * for web page discovery (src/web/pages.ts), so the registration and command tools never import
 * web code.
 */
export async function load<T>(
  directory: URL,
  kind: string,
  accepts: (value: unknown) => value is T,
): Promise<T[]> {
  const modules: T[] = [];
  for (const file of await files(directory, kind)) {
    const imported: unknown = await import(file.href);
    if (
      typeof imported !== "object" ||
      imported === null ||
      !("default" in imported) ||
      !accepts(imported.default)
    ) {
      throw new Error(`Invalid ${kind} module default export: ${fileURLToPath(file)}`);
    }
    modules.push(imported.default);
  }
  return modules;
}

/** Duplicate routes fail startup instead of silently replacing a handler by load order. */
export function index<T>(
  items: T[],
  key: (item: T) => string,
  kind: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const name = key(item);
    if (result.has(name)) throw new Error(`Duplicate ${kind}: ${name}`);
    result.set(name, item);
  }
  return result;
}

/** Registration imports exactly the same command modules as the running process. */
export async function loadCommands(
  directory = moduleDirectories.commands,
): Promise<ReadonlyMap<string, Command>> {
  return index(
    await load(directory, "command", (value): value is Command => value instanceof Command),
    (value) => value.name,
    "command",
  );
}

/** Load custom-ID namespaces independently from slash command names. */
export async function loadComponents(
  directory = moduleDirectories.components,
): Promise<ReadonlyMap<string, Component>> {
  return index(
    await load(directory, "component", (value): value is Component => value instanceof Component),
    (value) => value.prefix,
    "component prefix",
  );
}

/** Handler IDs, rather than Discord event names, distinguish multiple event subscribers. */
export async function loadEvents(
  directory = moduleDirectories.events,
): Promise<ReadonlyMap<string, GatewayEvent>> {
  return index(
    await load(directory, "event", (value): value is GatewayEvent => value instanceof GatewayEvent),
    (value) => value.id,
    "event handler",
  );
}

/** Bind an already validated inventory and expose one teardown function for shutdown. */
export function bindEvents(
  events: ReadonlyMap<string, GatewayEvent>,
  context: BotContext,
): () => void {
  for (const event of events.values()) context.services.require(event.requires);
  const cleanup = [...events.values()].map((event) => event.bind(context));
  return () => {
    for (const remove of cleanup) remove();
  };
}
