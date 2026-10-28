/**
 * Discord's own rules for a registered command set, as one pure function over definitions. The
 * bulk PUT registration sends (the bot at startup, and register.js) refuses a whole set for a
 * single violation, and neither discord.js (it builds a definition without checking most of these)
 * nor the router's shape check (which accepts any option order) notices first: 2.45.0's /moderate
 * block listed an optional option before a required one, so its delivery stopped at the register
 * step with the bot down.
 *
 * tests/unit/command-registration.test.ts runs them on every discovered command in CI, before
 * merge. They are a hand-written approximation of Discord's rules, so a pass proves only that the
 * rules written here hold; a rule Discord enforces and this file doesn't model still fails at the
 * PUT, which the bot reports while it keeps running (2.46.0). Nothing here is imported by the bot
 * at runtime, because a false positive there would withhold a set Discord would have accepted;
 * in CI it only fails a pull request.
 */
import { ApplicationCommandOptionType } from "discord.js";

const {
  Subcommand,
  SubcommandGroup,
  String: Text,
  Integer,
  Number: Decimal,
} = ApplicationCommandOptionType;

/** The slice of a command or option definition these rules read; toJSON() output satisfies it. */
export interface RegistrableOption {
  name: string;
  description?: string;
  type: number;
  required?: boolean;
  autocomplete?: boolean;
  min_length?: number;
  max_length?: number;
  options?: readonly RegistrableOption[];
  choices?: readonly { name: string; value: unknown }[];
}

/** A chat-input command as the bulk PUT receives it: an option without a type. */
export interface RegistrableCommand {
  name: string;
  description?: string;
  options?: readonly RegistrableOption[];
}

/** Discord's name rule for commands and options: lowercase, 1 to 32 letters, digits, - or _. */
const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

/** Discord allows 100 chat input commands per application. */
export const MAX_COMMANDS = 100;

/** Characters Discord counts toward a command's 8,000-character total. */
function size(item: {
  name: string;
  description?: string;
  choices?: RegistrableOption["choices"];
  options?: RegistrableOption["options"];
}): number {
  let total = item.name.length + (item.description?.length ?? 0);
  for (const choice of item.choices ?? [])
    total += choice.name.length + (typeof choice.value === "string" ? choice.value.length : 0);
  for (const option of item.options ?? []) total += size(option);
  return total;
}

/** Every way a definition breaks Discord's registration rules, named by its path. */
export function optionProblems(
  path: string,
  options: readonly RegistrableOption[],
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
        ...optionProblems(
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
        problems.push(`${here}: choice name "${choice.name}" is not 1 to 100 characters`);
      if (
        typeof choice.value === "string" &&
        (choice.value.length < 1 || choice.value.length > 100)
      )
        problems.push(`${here}: choice value "${choice.value}" is not 1 to 100 characters`);
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

/**
 * Every way a whole command set breaks Discord's registration rules, each naming its path and
 * holding only names and counts from the definitions, never a setting or an ID.
 */
export function commandSetProblems(commands: readonly RegistrableCommand[]): string[] {
  const problems: string[] = [];
  const roots = new Set<string>();
  for (const command of commands) {
    const root = command.name;
    if (roots.has(root)) problems.push(`${root}: name used twice`);
    roots.add(root);
    if (!NAME.test(root) || root !== root.toLowerCase())
      problems.push(`${root}: name must be 1-32 lowercase letters, digits, - or _`);
    const description = command.description ?? "";
    if (description.length < 1 || description.length > 100)
      problems.push(`${root}: description is not 1 to 100 characters`);
    problems.push(...optionProblems(root, command.options ?? []));
    const total = size(command);
    if (total > 8000) problems.push(`${root}: ${total} characters in all (at most 8,000)`);
  }
  if (commands.length > MAX_COMMANDS)
    problems.push(`${commands.length} commands (at most ${MAX_COMMANDS})`);
  return problems;
}
