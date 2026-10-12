/**
 * Discord's own rules for a registered command set, checked against every discovered command.
 * discord.js builds a definition without checking most of them, and the router's shape check
 * (command-shape.test.ts) accepts any order, so a command can pass every other test and still be
 * refused by the bulk PUT that scripts/register.ts sends, which stops a deploy at its register
 * step (2.45.0's /moderate block listed an optional option before a required one).
 */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";

const {
  Subcommand,
  SubcommandGroup,
  String: Text,
  Integer,
  Number: Decimal,
} = ApplicationCommandOptionType;

/** The slice of a command definition these rules read. */
interface Option {
  name: string;
  description?: string;
  type: number;
  required?: boolean;
  autocomplete?: boolean;
  min_length?: number;
  max_length?: number;
  options?: Option[];
  choices?: { name: string; value: unknown }[];
}

/** Discord's name rule for commands and options: lowercase, 1 to 32 letters, digits, - or _. */
const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

/** Characters Discord counts toward a command's 8,000-character total. */
function size(item: Option): number {
  let total = item.name.length + (item.description?.length ?? 0);
  for (const choice of item.choices ?? [])
    total += choice.name.length + (typeof choice.value === "string" ? choice.value.length : 0);
  for (const option of item.options ?? []) total += size(option);
  return total;
}

/** Every way a definition breaks Discord's registration rules, named by its path. */
function registrationProblems(
  path: string,
  options: readonly Option[],
  parent: "command" | "group" | "subcommand" = "command",
): string[] {
  const problems: string[] = [];
  if (options.length > 25) problems.push(`${path}: ${options.length} options (at most 25)`);
  const names = new Set<string>();
  const nested = options.filter((o) => o.type === Subcommand || o.type === SubcommandGroup);
  if (nested.length > 0 && nested.length !== options.length)
    problems.push(`${path}: subcommands mixed with ordinary options`);
  let optionalSeen = false;
  for (const option of options) {
    const here = `${path}/${option.name}`;
    if (names.has(option.name)) problems.push(`${here}: name used twice`);
    names.add(option.name);
    if (!NAME.test(option.name) || option.name !== option.name.toLowerCase())
      problems.push(`${here}: name must be 1-32 lowercase letters, digits, - or _`);
    const description = option.description ?? "";
    if (description.length < 1 || description.length > 100)
      problems.push(`${here}: description is ${description.length} characters (1 to 100)`);
    if (option.type === Subcommand || option.type === SubcommandGroup) {
      // A group sits directly under the command and holds only subcommands, which sit under the
      // command or a group and hold only ordinary options.
      if (parent === "subcommand" || (parent === "group" && option.type === SubcommandGroup))
        problems.push(`${here}: nested too deep`);
      if (
        option.type === SubcommandGroup &&
        (option.options ?? []).some((o) => o.type !== Subcommand)
      )
        problems.push(`${here}: a group holds only subcommands`);
      problems.push(
        ...registrationProblems(
          here,
          option.options ?? [],
          option.type === SubcommandGroup ? "group" : "subcommand",
        ),
      );
      continue;
    }
    // Required options come first; Discord answers a violation with a 400 on the whole PUT.
    if (option.required === true && optionalSeen)
      problems.push(`${here}: required option after an optional one`);
    if (option.required !== true) optionalSeen = true;
    const choices = option.choices ?? [];
    if (choices.length > 25) problems.push(`${here}: ${choices.length} choices (at most 25)`);
    if (choices.length > 0 && option.autocomplete === true)
      problems.push(`${here}: choices and autocomplete together`);
    if (
      choices.length > 0 &&
      option.type !== Text &&
      option.type !== Integer &&
      option.type !== Decimal
    )
      problems.push(`${here}: choices on a type that takes none`);
    for (const choice of choices) {
      if (choice.name.length < 1 || choice.name.length > 100)
        problems.push(
          `${here}: choice name ${JSON.stringify(choice.name)} is not 1 to 100 characters`,
        );
      if (
        typeof choice.value === "string" &&
        (choice.value.length < 1 || choice.value.length > 100)
      )
        problems.push(
          `${here}: choice value ${JSON.stringify(choice.value)} is not 1 to 100 characters`,
        );
    }
    if (option.type === Text) {
      const { min_length: min, max_length: max } = option;
      if (min !== undefined && (min < 0 || min > 6000))
        problems.push(`${here}: min_length out of range`);
      if (max !== undefined && (max < 1 || max > 6000))
        problems.push(`${here}: max_length out of range`);
      if (min !== undefined && max !== undefined && min > max)
        problems.push(`${here}: min_length above max_length`);
    }
  }
  return problems;
}

test("every command is one Discord accepts for registration", async () => {
  const commands = await loadCommands();
  const problems: string[] = [];
  for (const command of commands.values()) {
    const json = command.toJSON() as Option & { options?: Option[] };
    const root = json.name;
    if (!NAME.test(root) || root !== root.toLowerCase())
      problems.push(`${root}: name must be 1-32 lowercase letters, digits, - or _`);
    if ((json.description ?? "").length < 1 || (json.description ?? "").length > 100)
      problems.push(`${root}: description is not 1 to 100 characters`);
    problems.push(...registrationProblems(root, json.options ?? []));
    if (size(json) > 8000)
      problems.push(`${root}: ${size(json)} characters in all (at most 8,000)`);
  }
  expect(problems).toEqual([]);
  // Global commands: Discord allows 100 chat input commands per application.
  expect(commands.size).toBeLessThanOrEqual(100);
});

test("the rules catch what they are here to catch", () => {
  const required = { name: "reason", description: "Why", type: Text, required: true };
  const optional = { name: "length", description: "How long", type: Text, required: false };
  expect(registrationProblems("x", [required, optional])).toEqual([]);
  expect(registrationProblems("x", [optional, required])).toEqual([
    "x/reason: required option after an optional one",
  ]);
  expect(registrationProblems("x", [{ ...required, name: "Reason" }]).length).toBeGreaterThan(0);
  expect(registrationProblems("x", [{ ...required, description: "" }])).toEqual([
    "x/reason: description is 0 characters (1 to 100)",
  ]);
  expect(
    registrationProblems("x", [
      { ...required, autocomplete: true, choices: [{ name: "a", value: "a" }] },
    ]),
  ).toEqual(["x/reason: choices and autocomplete together"]);
  expect(
    registrationProblems("x", [
      {
        ...required,
        choices: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, value: `v${i}` })),
      },
    ]),
  ).toEqual(["x/reason: 26 choices (at most 25)"]);
});
