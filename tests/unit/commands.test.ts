/** Snapshot the declared feature surface through real discovery, including nested subcommands. */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { applicationKey } from "../../src/application/keys.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import assignCommand from "../../src/commands/characters/assign.command.js";
import charactersCommand from "../../src/commands/characters/characters.command.js";
import configCommand from "../../src/commands/configuration/config.command.js";
import guestCommand from "../../src/commands/guests/guest.command.js";
import ledgerCommand from "../../src/commands/ledger/ledger.command.js";
import syncCommand from "../../src/commands/synchronization/sync.command.js";
import type { Command } from "../../src/bot/command.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { cursor, entryRef, userId, uuid } from "../../src/discord/selectors.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure, lodestoneId } from "../../src/domain/values.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { configChange, layoutOn } from "../fixtures/replies/configuration.js";

test("command inventory exactly matches the declared public surface", async () => {
  const commands = await loadCommands();
  const inventory: string[] = [];
  interface Option {
    type: number;
    name: string;
    options?: readonly Option[] | undefined;
  }
  const visit = (prefix: string, options: readonly Option[]): void => {
    // Flatten command groups while ignoring ordinary argument options.
    const nested = options.filter(
      (option) =>
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup,
    );
    if (!nested.length) {
      inventory.push(prefix);
      return;
    }
    for (const option of nested) {
      if ("options" in option) visit(`${prefix} ${option.name}`, option.options ?? []);
      else inventory.push(`${prefix} ${option.name}`);
    }
  };
  for (const command of commands.values()) {
    const data = command.toJSON();
    expect(data.contexts).toEqual([InteractionContextType.Guild]);
    visit(data.name, data.options ?? []);
  }
  expect(inventory.sort()).toEqual(
    [
      "config fc link",
      "config fc unlink",
      "config roles member",
      "config roles guest",
      "config roles officer",
      "config roles leader",
      "config officer_rank",
      "config role_layout",
      // 2.35.0 (#46): /setup split in two, both dry runs unless confirm:true.
      "setup onboarding",
      "setup overrides",
      "officer grant",
      "officer revoke",
      "officer reset",
      "config ledger",
      "config officer_notifications",
      "config changelog",
      "config guest_applications",
      "config show",
      "config validate",
      "claim",
      "verify",
      "unclaim",
      "assign",
      "unassign",
      "characters",
      "main",
      "nickname",
      "refresh",
      "sync status",
      "apply",
      "guest approve",
      "guest deny",
      "guest grant",
      "guest revoke",
      "guest reset",
      "guest status",
      "ledger deposit",
      "ledger withdraw",
      "ledger balance",
      "ledger history",
      "ledger initialize",
      "ledger adjust",
      "ping",
      "channel",
      "version",
      // 2.18.0: any member reports a problem to the maintainers.
      "issue",
      // 2.28.0: members and guests suggest features publicly on GitHub.
      "suggest",
    ].sort(),
  );
});

test("every member option suggests server members (owner decision, 2026-09-24)", async () => {
  interface Option {
    type: number;
    name: string;
    autocomplete?: boolean;
    options?: readonly Option[] | undefined;
  }
  const members: { path: string; autocomplete: boolean }[] = [];
  const visit = (path: string, options: readonly Option[]): void => {
    for (const option of options) {
      if (
        option.type === ApplicationCommandOptionType.Subcommand ||
        option.type === ApplicationCommandOptionType.SubcommandGroup
      )
        visit(`${path} ${option.name}`, option.options ?? []);
      else if (option.name === "member")
        members.push({ path, autocomplete: option.autocomplete === true });
    }
  };
  const commands = await loadCommands();
  for (const command of commands.values()) {
    const data = command.toJSON();
    visit(data.name, (data.options ?? []) as readonly Option[]);
    // A command with an autocomplete option must have a handler for it.
    if (JSON.stringify(data.options ?? []).includes('"autocomplete":true'))
      expect(typeof command.autocomplete).toBe("function");
  }
  expect(members.map((row) => row.path).sort()).toEqual(
    [
      "assign",
      "characters",
      "guest grant",
      "guest reset",
      "guest revoke",
      "guest status",
      "officer grant",
      "officer reset",
      "officer revoke",
      "unassign",
    ].sort(),
  );
  expect(members.filter((row) => !row.autocomplete)).toEqual([]);
});

test("/config role_layout and /config roles officer adopt_holders reach the service as parsed", async () => {
  // A prototype-backed application records calls; the real option resolver parses raw payloads.
  const calls: unknown[][] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  // The stubs return typed catalog results, so each reply is the presenter's embed.
  app.configure = async (...args) => {
    calls.push(["configure", ...args.slice(1)]);
    const [, field, value] = args;
    return configChange(field, value);
  };
  app.configureRoleLayout = async (...args) => {
    calls.push(["configureRoleLayout", ...args.slice(1)]);
    return layoutOn({ roleLayout: args[1] ? "enabled" : "disabled" });
  };
  const replies: unknown[] = [];
  const fixture = interactionFixture();
  const actor: Actor = { guildId: "100", userId: "400", officer: true, manageRoles: true };
  const run = async (options: unknown[], resolved?: unknown) => {
    const reply = await configCommand.execute?.({
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      report: () => {},
      resolveActor: async () => actor,
      actor,
      // The router derives the viewer from the same actor; these officers render officer views.
      viewer: viewerOf(actor, "1290000000000000001"),
      interaction: fixture.slash("config", options, resolved),
    });
    replies.push(reply);
  };
  const S = ApplicationCommandOptionType;
  // Only the officer binding declares adopt_holders; role_layout's single boolean is required.
  const declared = configCommand.toJSON().options ?? [];
  const group = declared.find((option) => option.name === "roles");
  if (group?.type !== S.SubcommandGroup) throw new Error("Missing /config roles group");
  expect(
    (group.options ?? []).map((sub) => [
      sub.name,
      (sub.options ?? []).map((option) => option.name),
    ]),
  ).toEqual([
    ["member", ["role", "unset_role"]],
    ["guest", ["role", "unset_role"]],
    ["officer", ["role", "unset_role", "adopt_holders"]],
    ["leader", ["role", "unset_role"]],
  ]);
  // No /config option is named "clear" (owner decision, 2026-09-24: it sounds like erasing).
  expect(JSON.stringify(declared)).not.toContain('"name":"clear"');
  expect(declared.find((option) => option.name === "guest_applications")).toMatchObject({
    type: S.Subcommand,
    options: [
      { type: S.Boolean, name: "enabled" },
      { type: S.Channel, name: "channel" },
      { type: S.Boolean, name: "unset_channel" },
    ],
  });
  expect(declared.find((option) => option.name === "role_layout")).toMatchObject({
    type: S.Subcommand,
    options: [{ type: S.Boolean, name: "enabled", required: true }],
  });
  const role = { id: "555", name: "Legacy Officer", color: 0, hoist: false, position: 1 };
  const roles = {
    roles: { "555": { ...role, permissions: "0", managed: false, mentionable: false } },
  };
  // Bind the officer role with, without and against holder adoption, then another role.
  const officer = (extra: unknown[]) => [
    {
      type: S.SubcommandGroup,
      name: "roles",
      options: [
        {
          type: S.Subcommand,
          name: "officer",
          options: [{ type: S.Role, name: "role", value: "555" }, ...extra],
        },
      ],
    },
  ];
  try {
    await run(officer([]), roles);
    await run(officer([{ type: S.Boolean, name: "adopt_holders", value: false }]), roles);
    await run(officer([{ type: S.Boolean, name: "adopt_holders", value: true }]), roles);
    await run(
      [
        {
          type: S.SubcommandGroup,
          name: "roles",
          options: [
            {
              type: S.Subcommand,
              name: "guest",
              options: [{ type: S.Role, name: "role", value: "555" }],
            },
          ],
        },
      ],
      roles,
    );
    for (const enabled of [true, false])
      await run([
        {
          type: S.Subcommand,
          name: "role_layout",
          options: [{ type: S.Boolean, name: "enabled", value: enabled }],
        },
      ]);
    expect(calls).toEqual([
      ["configure", "officer_role_id", "555", {}],
      ["configure", "officer_role_id", "555", { adoptHolders: false }],
      ["configure", "officer_role_id", "555", { adoptHolders: true }],
      ["configure", "guest_role_id", "555", {}],
      ["configureRoleLayout", true],
      ["configureRoleLayout", false],
    ]);
    // Every reply is one presenter embed, never the JSON dump.
    for (const reply of replies) {
      expect(reply).toBeInstanceOf(Presented);
      if (reply instanceof Presented) {
        expect(reply.options.embeds).toHaveLength(1);
        expect(reply.options.content).toBe("");
      }
    }
    expect(
      replies.map((reply) => (reply instanceof Presented ? reply.options.embeds[0]?.title : null)),
    ).toEqual([
      "Officer role set",
      "Officer role set",
      "Officer role set",
      "Guest role set",
      "Role layout turned on",
      "Role layout turned off",
    ]);
  } finally {
    await fixture.close();
  }
});

/** The input failure a parser raised, for asserting its code and option detail. */
function inputFailure(run: () => unknown): Failure {
  try {
    run();
  } catch (error) {
    if (error instanceof Failure) return error;
    throw new Error(`Expected a Failure, got ${String(error)}`);
  }
  throw new Error("Expected the parser to refuse its input");
}

test("option parsers refuse typed names, role mentions and malformed UUIDs as input failures", () => {
  // DevBot 2.12.3: /assign member:<typed name> reached BigInt() and replied "Operation failed".
  for (const valid of ["123456789012345678", "<@123456789012345678>", "<@!123456789012345678>"])
    expect(userId(valid)).toBe("123456789012345678");
  for (const typed of ["Wrenfield", "@Wrenfield", "12 34", "<@&123456789012345678>", ""])
    expect(inputFailure(() => userId(typed, "member"))).toMatchObject({
      code: "input",
      message: "Pick a member from the suggestions, or paste a Discord user ID or @mention.",
      detail: { kind: "option", option: "member" },
    });
  const uuidCases = [
    ["application", "application", "Pick one from the suggestions"],
    ["run", "run_id", "Copy it from your /refresh reply"],
  ] as const;
  for (const [kind, option, hint] of uuidCases) {
    const failure = inputFailure(() => uuid("not-a-uuid", kind));
    expect(failure).toMatchObject({ code: "input", detail: { kind: "option", option } });
    expect(failure.message).toContain(hint);
  }
  expect(uuid(" 3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f98 ", "run")).toBe(
    "3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f98",
  );
  // /ledger adjust's entry is the number history shows, with or without '#', or the entry ID.
  expect(entryRef("5")).toEqual({ sequence: 5n });
  expect(entryRef(" #42 ")).toEqual({ sequence: 42n });
  expect(entryRef("# 7")).toEqual({ sequence: 7n });
  expect(entryRef(" 3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f98 ")).toEqual({
    id: "3f2c9a4e-8b1d-4c6f-9e2a-7d5b1c0e4f98",
  });
  for (const bad of ["0", "#0", "05", "-5", "5.0", "five", "9223372036854775808", "#"]) {
    const failure = inputFailure(() => entryRef(bad));
    expect(failure).toMatchObject({ code: "input", detail: { kind: "option", option: "entry" } });
    expect(failure.message).toContain("such as 5");
  }
  expect(cursor(null)).toBeNull();
  expect(cursor("34")).toBe("34");
  expect(inputFailure(() => cursor("page 2"))).toMatchObject({
    code: "input",
    detail: { kind: "option", option: "before" },
  });
  expect(inputFailure(() => lodestoneId("https://evil.test/", "freecompany"))).toMatchObject({
    code: "input",
    detail: { kind: "option", option: "fc_id" },
  });
});

test("commands reject malformed IDs with an option detail before any service call, never a ZodError", async () => {
  // Every service method throws if reached: the parse must refuse first.
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  const reached = () => {
    throw new Error("The service was reached with an unparsed option");
  };
  for (const method of [
    "decide",
    "guestAction",
    "guestStatus",
    "ledger",
    "ledgerRead",
    "syncStatus",
    "characters",
    "assign",
  ] as const)
    Object.assign(app, { [method]: reached });
  // /assign reads the configuration before parsing its member option.
  Object.assign(app, { guild: async () => ({}) });
  const fixture = interactionFixture();
  const actor: Actor = { guildId: "100", userId: "400", officer: true, manageRoles: true };
  const S = ApplicationCommandOptionType;
  const text = (name: string, value: string) => ({ type: S.String, name, value });
  const sub = (name: string, options: unknown[]) => [{ type: S.Subcommand, name, options }];
  const run = (command: Command, name: string, options: unknown[]) =>
    command.execute?.({
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      report: () => {},
      resolveActor: async () => actor,
      actor,
      viewer: viewerOf(actor, "1290000000000000001"),
      interaction: fixture.slash(name, options),
    });
  const cases: [Command, string, unknown[], string][] = [
    [guestCommand, "guest", sub("approve", [text("application", "nope")]), "application"],
    [
      guestCommand,
      "guest",
      sub("grant", [text("member", "Wrenfield"), text("reason", "r")]),
      "member",
    ],
    [guestCommand, "guest", sub("status", [text("member", "@Wrenfield")]), "member"],
    [
      ledgerCommand,
      "ledger",
      sub("adjust", [text("balance", "5"), text("note", "n"), text("entry", "12a")]),
      "entry",
    ],
    [ledgerCommand, "ledger", sub("balance", [text("fc_id", "Example FC")]), "fc_id"],
    [ledgerCommand, "ledger", sub("history", [text("before", "page 2")]), "before"],
    [syncCommand, "sync", sub("status", [text("run_id", "9d8c7b6a")]), "run_id"],
    [charactersCommand, "characters", [text("member", "12 34")], "member"],
    [
      assignCommand,
      "assign",
      [text("member", "Wrenfield"), text("reason", "Vouched"), text("character", "12345678")],
      "member",
    ],
  ];
  try {
    for (const [command, name, options, option] of cases) {
      const outcome = await Promise.resolve()
        .then(() => run(command, name, options))
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(outcome).toBeInstanceOf(Failure);
      expect(outcome).toMatchObject({ code: "input", detail: { kind: "option", option } });
    }
  } finally {
    await fixture.close();
  }
});
