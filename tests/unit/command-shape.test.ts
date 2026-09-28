/**
 * The router's shape check against every discovered command: each declared path, with every one
 * of its options, is accepted, and anything another release could register instead is refused.
 */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { type DeclaredOption, type InvokedOption, undeclaredShape } from "../../src/bot/shape.js";

const {
  Subcommand,
  SubcommandGroup,
  String: Text,
  Channel,
  Boolean: Flag,
} = ApplicationCommandOptionType;

/** Every invocable path of a command: the nested subcommand options down to a leaf, and its options. */
function invocations(
  options: readonly DeclaredOption[],
): { path: InvokedOption[]; leaf: readonly DeclaredOption[] }[] {
  const nested = options.filter(
    (option) => option.type === Subcommand || option.type === SubcommandGroup,
  );
  if (!nested.length) return [{ path: [], leaf: options }];
  return nested.flatMap((option) =>
    invocations(option.options ?? []).map(({ path, leaf }) => ({
      path: [{ name: option.name, type: option.type, options: path }],
      leaf,
    })),
  );
}

/** Wrap leaf options into the innermost level of an invocation path. */
function invoke(path: readonly InvokedOption[], leaf: InvokedOption[]): InvokedOption[] {
  const [first] = path;
  if (!first) return leaf;
  return [{ ...first, options: invoke(first.options ?? [], leaf) }];
}

test("every declared path, with all of its options, fits its own command's shape", async () => {
  let paths = 0;
  for (const command of (await loadCommands()).values()) {
    const declared = command.toJSON().options ?? [];
    for (const { path, leaf } of invocations(declared)) {
      paths++;
      const supplied = leaf.map((option) => ({ name: option.name, type: option.type }));
      expect(undeclaredShape(declared, invoke(path, supplied)), command.name).toBeNull();
    }
  }
  // The registered surface: 47 paths across 21 roots (a root without subcommands is one path);
  // 2.18.0 added /issue, 2.25.0 /config changelog, 2.28.0 /suggest, and 2.35.0 split /setup into
  // /setup onboarding and /setup overrides.
  expect(paths).toBe(47);
  expect((await loadCommands()).size).toBe(21);
});

/** /setup as 2.34.0 registered it: options only, no subcommand. */
const SETUP_2_34: readonly DeclaredOption[] = [
  { name: "fc_id", type: Text },
  { name: "prefix", type: Text },
  { name: "officer_rank", type: Text },
  { name: "lobby", type: Channel },
  { name: "officers", type: Channel },
];

test("the /setup split (2.35.0) keeps its options and descriptions, and both stale shapes are refused", async () => {
  const setup = (await loadCommands()).get("setup")?.toJSON();
  if (!setup) throw new Error("No /setup command");
  // The pinned descriptions (#46 spec §8), each within Discord's 100 characters.
  const confirm = "Make the changes; without it, only show what would change";
  expect(setup.description).toBe(
    "Set up TaruBot: lobby onboarding, or TaruBot's own channel overrides",
  );
  const [onboarding, overrides] = setup.options ?? [];
  expect(onboarding).toMatchObject({
    name: "onboarding",
    type: Subcommand,
    description:
      "Access roles, a newcomer lobby and officer-only channels; a dry run unless confirm:true",
  });
  expect(overrides).toMatchObject({
    name: "overrides",
    type: Subcommand,
    description:
      "TaruBot's own channel overrides, added while it holds Administrator; a dry run unless confirm:true",
  });
  for (const text of [setup.description, onboarding?.description, overrides?.description, confirm])
    expect((text ?? "").length).toBeLessThanOrEqual(100);
  // onboarding keeps 2.34.0's five options in order and type, then confirm; overrides only confirm.
  const shape = (option: typeof onboarding) =>
    (option && "options" in option ? (option.options ?? []) : []).map((entry) => ({
      name: entry.name,
      type: entry.type,
      description: entry.description,
      required: entry.required ?? false,
    }));
  expect(shape(onboarding).map(({ name, type }) => ({ name, type }))).toEqual([
    ...SETUP_2_34,
    { name: "confirm", type: Flag },
  ]);
  expect(shape(onboarding).at(-1)).toEqual({
    name: "confirm",
    type: Flag,
    description: confirm,
    required: false,
  });
  expect(shape(overrides)).toEqual([
    { name: "confirm", type: Flag, description: confirm, required: false },
  ]);
  // The 2.34.0 invocation against this release, and this release's against 2.34.0's shape: the
  // router answers both with the stale-command card.
  const declared = setup.options ?? [];
  expect(undeclaredShape(declared, [{ name: "fc_id", type: Text }])).toBe(
    'a missing subcommand after ""',
  );
  expect(undeclaredShape(declared, [])).toBe('a missing subcommand after ""');
  expect(
    undeclaredShape(SETUP_2_34, [
      { name: "onboarding", type: Subcommand, options: [{ name: "confirm", type: Flag }] },
    ]),
  ).toBe('the subcommand "onboarding"');
  expect(undeclaredShape(SETUP_2_34, [{ name: "overrides", type: Subcommand }])).toBe(
    'the subcommand "overrides"',
  );
});

test("shapes another release could register are refused", async () => {
  const commands = await loadCommands();
  const officer = commands.get("officer")?.toJSON().options ?? [];
  const config = commands.get("config")?.toJSON().options ?? [];
  // An /officer subcommand this release doesn't have (the pre-2.16 handler revoked on it).
  expect(undeclaredShape(officer, [{ name: "promote", type: Subcommand, options: [] }])).toBe(
    'the subcommand "promote"',
  );
  // A declared subcommand with an option it doesn't have, or with another type.
  expect(
    undeclaredShape(officer, [
      { name: "reset", type: Subcommand, options: [{ name: "note", type: Text }] },
    ]),
  ).toBe('the option "note"');
  expect(
    undeclaredShape(config, [
      {
        name: "guest_applications",
        type: Subcommand,
        options: [{ name: "enabled", type: Text }],
      },
    ]),
  ).toBe('the option "enabled"');
  // A command that requires a subcommand, invoked without one, and a mixed level.
  expect(undeclaredShape(officer, [])).toBe('a missing subcommand after ""');
  expect(
    undeclaredShape(officer, [
      { name: "reset", type: Subcommand, options: [] },
      { name: "reason", type: Text },
    ]),
  ).toBe('a mixed option list at ""');
});
