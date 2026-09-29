/** Behavior tests for the generic extension mechanism, independent of Discord credentials. */
import { expect, setDefaultTimeout, test } from "bun:test";
import { Client, Events, ModalBuilder, SlashCommandBuilder } from "discord.js";
import { Command, defineCommand } from "../../src/bot/command.js";
import type { BotContext } from "../../src/bot/context.js";
import { bindEvents, loadCommands, loadComponents, loadEvents } from "../../src/bot/discovery.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { ServiceKey, Services } from "../../src/bot/services.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { Presented, reply } from "../../src/discord/presenters/reply.js";

// Spawned processes run under QEMU in the arm64 image build; Bun scopes this to this file only.
setDefaultTimeout(120_000);

/** Real EventEmitter behavior needs no login, sockets, or game-service mocks. */
function context(client: Client, services = new Services()): BotContext {
  return {
    client,
    services,
    allowsGuild: () => true,
    isStopping: () => false,
    resolveActor: async (guildId, userId) => ({
      guildId,
      userId,
      officer: false,
      manageRoles: false,
    }),
    report: () => {},
  };
}
const fixtures = new URL("../fixtures/modules/", import.meta.url);

test("new nested modules populate definitions and handlers without central registration", async () => {
  const loaded = await loadCommands(new URL("valid/", fixtures));
  expect([...loaded.keys()]).toEqual(["fixture-hello", "fixture-second"]);
  const hello = loaded.get("fixture-hello");
  expect(hello?.toJSON().name).toBe("fixture-hello");
  expect(typeof hello?.execute).toBe("function");
  expect(typeof hello?.autocomplete).toBe("function");
  expect(hello?.ephemeral).toBe(true);
  const copy = hello?.toJSON();
  if (copy) copy.name = "edited-copy";
  expect(hello?.name).toBe("fixture-hello");
  expect(hello?.toJSON().name).toBe("fixture-hello");
});

test("duplicate routes and malformed exports fail discovery with useful diagnostics", async () => {
  await expect(loadCommands(new URL("duplicates/", fixtures))).rejects.toThrow(
    "Duplicate command: duplicate",
  );
  await expect(loadCommands(new URL("invalid/", fixtures))).rejects.toThrow("broken.command.ts");
});

test("pre-modal checks are accepted only as functions on modal commands", () => {
  const data = new SlashCommandBuilder().setName("gated").setDescription("Contract fixture");
  const modal = () => new ModalBuilder().setCustomId("gated").setTitle("Gated");
  expect(typeof defineCommand({ data, modal, beforeModal: () => null }).beforeModal).toBe(
    "function",
  );
  // A refusal is a presenter reply; the router sends it as the only acknowledgement.
  const closed = defineCommand({
    data,
    modal,
    beforeModal: async () => reply({ tone: "info", title: "Closed" }),
  });
  expect(typeof closed.beforeModal).toBe("function");
  expect(defineCommand({ data, modal }).beforeModal).toBeUndefined();
  // Discovered modules are untyped at runtime; Reflect.construct bypasses the compile-time union
  // to prove the constructor rejects what the option types already forbid.
  for (const options of [
    { data, execute: () => ({ content: "ready" }), beforeModal: () => null },
    { data, modal, beforeModal: "closed" },
  ])
    expect(() => Reflect.construct(Command, [options])).toThrow(
      "A pre-modal check must be a function on a modal command.",
    );
});

test("service dependencies are checked before a router can accept interactions", () => {
  const key = new ServiceKey(
    "positive number",
    (value): value is number => typeof value === "number" && value > 0,
  );
  const services = new Services();
  expect(() => services.provide(key, -1)).toThrow("Invalid provider");
  const module = defineCommand({
    data: new SlashCommandBuilder()
      .setName("requires-service")
      .setDescription("Dependency fixture"),
    requires: [key],
    execute: () => reply({ tone: "neutral", title: "Ready" }),
  });
  const client = new Client({ intents: [] });
  try {
    expect(
      () =>
        new InteractionRouter(
          context(client, services),
          new Map([[module.name, module]]),
          new Map(),
        ),
    ).toThrow("Missing or invalid service");
    services.provide(key, 1);
    expect(services.get(key)).toBe(1);
    expect(() => services.provide(key, 2)).toThrow("Duplicate service");
    expect(
      () =>
        new InteractionRouter(
          context(client, services),
          new Map([[module.name, module]]),
          new Map(),
        ),
    ).not.toThrow();
  } finally {
    void client.destroy();
  }
});

test("events support multiple subscribers, once semantics, failure containment and cleanup", async () => {
  const client = new Client({ intents: [] });
  const observations: { operation: string; message: string }[] = [];
  let stopping = false;
  const runtime = {
    ...context(client),
    isStopping: () => stopping,
    report: (error: unknown, operation: string) =>
      observations.push({ operation, message: error instanceof Error ? error.message : "unknown" }),
  };
  const loaded = await loadEvents(new URL("events/", fixtures));
  const cleanup = bindEvents(loaded, runtime);
  try {
    client.emit(Events.Debug, "one");
    client.emit(Events.Debug, "two");
    expect(observations.map((item) => item.message)).toEqual([
      "first:one",
      "once:one",
      "first:two",
    ]);
    client.emit(Events.Warn, "handler failed");
    await Bun.sleep(0);
    expect(observations.at(-1)).toEqual({
      operation: "event:fixture-failure",
      message: "handler failed",
    });
    stopping = true;
    client.emit(Events.Debug, "stopping");
    expect(observations).toHaveLength(4);
    cleanup();
    stopping = false;
    client.emit(Events.Debug, "removed");
    expect(observations).toHaveLength(4);
    expect(client.listenerCount(Events.Debug)).toBe(0);
  } finally {
    cleanup();
    await client.destroy();
  }
});

test("component discovery owns custom-ID namespaces independently", async () => {
  const components = await loadComponents(new URL("components/", fixtures));
  expect([...components.keys()]).toEqual(["fixture"]);
  expect(components.get("fixture")?.access).toBe("user");
  // Components acknowledge with a new reply unless they choose to update their message.
  expect(components.get("fixture")?.acknowledge).toBe("reply");
});

test("duplicate component prefixes fail discovery instead of shadowing a namespace", async () => {
  // Two modules claiming one prefix would route every click to whichever loaded last.
  await expect(loadComponents(new URL("duplicate-components/", fixtures))).rejects.toThrow(
    "Duplicate component prefix: collide",
  );
});

test("discovered fixtures answer with presenter replies and receive a viewer", async () => {
  const client = new Client({ intents: [] });
  try {
    const actor = { guildId: "100", userId: "400", officer: false, manageRoles: false };
    const viewer = viewerOf(actor, "1290000000000000001");
    const runtime = { ...context(client), actor, viewer };
    const second = (await loadCommands(new URL("valid/", fixtures))).get("fixture-second");
    const component = (await loadComponents(new URL("components/", fixtures))).get("fixture");
    // The handlers ignore the interaction, so a placeholder stands in for Discord's payload.
    const interaction = {} as never;
    expect(await second?.execute?.({ ...runtime, interaction })).toBeInstanceOf(Presented);
    expect(await component?.execute({ ...runtime, interaction })).toBeInstanceOf(Presented);
  } finally {
    await client.destroy();
  }
});

test("removing the final module permits an empty feature directory after clean compilation", async () => {
  const missing = new URL("intentionally-absent/", fixtures);
  expect((await loadCommands(missing)).size).toBe(0);
  expect((await loadEvents(missing)).size).toBe(0);
  expect((await loadComponents(missing)).size).toBe(0);
});

test("compiled output discovers the same module inventory as source", async () => {
  const source = await loadCommands();
  // A subprocess imports compiled JS, avoiding mixed source/output class identities.
  // Its cold startup needs bounded headroom when image tests run under CPU emulation.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import {loadCommands,loadEvents,loadComponents} from './dist/src/bot/discovery.js';console.log(JSON.stringify({commands:[...(await loadCommands()).keys()],events:(await loadEvents()).size,components:[...(await loadComponents()).keys()]}));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(errors).toBe("");
  // Component prefixes in discovery (file-name) order: the seven 2.14.0 namespaces.
  expect(JSON.parse(output)).toEqual({
    commands: [...source.keys()],
    events: 15,
    components: ["config", "details", "guest-apply", "guest", "ledger", "sync", "verify"],
  });
}, 30000);
