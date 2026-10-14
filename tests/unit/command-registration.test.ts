/**
 * Discord's own rules for a registered command set, checked against every discovered command.
 * discord.js builds a definition without checking most of them, and the router's shape check
 * (command-shape.test.ts) accepts any order, so a command can pass every other test and still be
 * refused by the bulk PUT that scripts/register.ts sends, which stops a deploy at its register
 * step (2.45.0's /moderate block listed an optional option before a required one). The rules
 * themselves live in src/discord/registration-rules.ts, which the candidate check
 * (scripts/candidate-check.ts) runs in the release image before a delivery stops anything.
 */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import {
  commandSetProblems,
  MAX_COMMANDS,
  optionProblems,
  type RegistrableCommand,
} from "../../src/discord/registration-rules.js";

const { Subcommand, SubcommandGroup, String: Text } = ApplicationCommandOptionType;

test("every command is one Discord accepts for registration", async () => {
  const commands = await loadCommands();
  const definitions = [...commands.values()].map((command) => command.toJSON());
  expect(commandSetProblems(definitions as RegistrableCommand[])).toEqual([]);
  // Global commands: Discord allows 100 chat input commands per application.
  expect(commands.size).toBeLessThanOrEqual(MAX_COMMANDS);
});

test("the rules catch what they are here to catch", () => {
  const required = { name: "reason", description: "Why", type: Text, required: true };
  const optional = { name: "length", description: "How long", type: Text, required: false };
  expect(optionProblems("x", [required, optional])).toEqual([]);
  expect(optionProblems("x", [optional, required])).toEqual([
    "x/reason: required option after an optional one",
  ]);
  expect(optionProblems("x", [{ ...required, name: "Reason" }]).length).toBeGreaterThan(0);
  expect(optionProblems("x", [{ ...required, description: "" }])).toEqual([
    "x/reason: description is 0 characters (1 to 100)",
  ]);
  expect(
    optionProblems("x", [
      { ...required, autocomplete: true, choices: [{ name: "a", value: "a" }] },
    ]),
  ).toEqual(["x/reason: choices and autocomplete together"]);
  expect(
    optionProblems("x", [
      {
        ...required,
        choices: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` })),
      },
    ]),
  ).toEqual(["x/reason: 26 choices (at most 25)"]);
  expect(optionProblems("x", [{ ...required, choices: [{ name: "", value: "" }] }])).toEqual([
    'x/reason: choice name "" is not 1 to 100 characters',
    'x/reason: choice value "" is not 1 to 100 characters',
  ]);
  expect(optionProblems("x", [{ ...required, min_length: 10, max_length: 5 }])).toEqual([
    "x/reason: min_length above max_length",
  ]);
});

test("each remaining rule names what it refuses", () => {
  const base = { name: "reason", description: "Why", type: Text };
  const Boolean_ = ApplicationCommandOptionType.Boolean;
  expect(
    optionProblems(
      "x",
      Array.from({ length: 26 }, (_, i) => ({ ...base, name: `o${i}` })),
    ),
  ).toEqual(["x: 26 options (at most 25)"]);
  expect(optionProblems("x", [base, base])).toEqual(["x/reason: name used twice"]);
  expect(optionProblems("x", [{ ...base, description: "d".repeat(101) }])).toEqual([
    "x/reason: description is 101 characters (1 to 100)",
  ]);
  expect(optionProblems("x", [{ ...base, name: "has space" }]).length).toBe(1);
  expect(
    optionProblems("x", [{ ...base, type: Boolean_, choices: [{ name: "a", value: "a" }] }]),
  ).toEqual(["x/reason: choices on a type that takes none"]);
  expect(optionProblems("x", [{ ...base, min_length: -1, max_length: 6001 }])).toEqual([
    "x/reason: min_length out of range",
    "x/reason: max_length out of range",
  ]);
  const inner = { name: "deep", description: "Deep", type: Subcommand };
  expect(
    optionProblems("x", [{ name: "sub", description: "Sub", type: Subcommand, options: [inner] }]),
  ).toEqual(["x/sub/deep: nested too deep"]);
  expect(
    commandSetProblems([
      { name: "Bad", description: "" },
      { name: "ok", description: "d".repeat(101) },
    ]),
  ).toEqual([
    "Bad: name must be 1-32 lowercase letters, digits, - or _",
    "Bad: description is not 1 to 100 characters",
    "ok: description is not 1 to 100 characters",
  ]);
});

test("the 2.45.0 /moderate block shape is refused, and its 2.45.1 order is not", () => {
  const option = (name: string, required: boolean) => ({
    name,
    description: name,
    type: Text,
    required,
  });
  const block = (options: ReturnType<typeof option>[]) => ({
    name: "moderate",
    description: "Moderation tools",
    options: [
      { name: "block", description: "Pause a feature for a member", type: Subcommand, options },
    ],
  });
  const broken = block([
    option("member", true),
    option("feature", true),
    option("duration", false),
    option("reason", true),
  ]);
  expect(commandSetProblems([broken])).toEqual([
    "moderate/block/reason: required option after an optional one",
  ]);
  expect(
    commandSetProblems([
      block([
        option("member", true),
        option("feature", true),
        option("reason", true),
        option("duration", false),
      ]),
    ]),
  ).toEqual([]);
});

test("whole-set rules: roots, subcommand shape, size and count", () => {
  const leaf = (name: string) => ({ name, description: name, type: Subcommand, options: [] });
  const group = (name: string, options: unknown[]) => ({
    name,
    description: name,
    type: SubcommandGroup,
    options,
  });
  const root = (name: string, options: unknown[] = []) => ({
    name,
    description: name,
    options,
  });
  expect(commandSetProblems([root("same"), root("same")] as RegistrableCommand[])).toEqual([
    "same: name used twice",
  ]);
  expect(
    commandSetProblems([
      root("deep", [group("g", [group("h", [leaf("s")])])]),
    ] as RegistrableCommand[]),
  ).toEqual(["deep/g: a group holds only subcommands", "deep/g/h: nested too deep"]);
  expect(
    commandSetProblems([
      root("mixed", [leaf("s"), { name: "o", description: "o", type: Text }]),
    ] as RegistrableCommand[]),
  ).toEqual(["mixed: subcommands mixed with ordinary options"]);
  const long = "x".repeat(100);
  const heavy = root(
    "heavy",
    Array.from({ length: 25 }, (_, i) => ({
      name: `o${i}`,
      description: long,
      type: Text,
      choices: Array.from({ length: 25 }, (_, j) => ({
        name: long,
        value: `${j}`.padEnd(100, "v"),
      })),
    })),
  );
  expect(commandSetProblems([heavy] as RegistrableCommand[])).toEqual([
    expect.stringMatching(/^heavy: \d+ characters in all \(at most 8,000\)$/u),
  ]);
  const many = Array.from({ length: MAX_COMMANDS + 1 }, (_, i) => root(`c${i}`));
  expect(commandSetProblems(many as RegistrableCommand[])).toEqual([
    `${MAX_COMMANDS + 1} commands (at most ${MAX_COMMANDS})`,
  ]);
});
