/**
 * Member suggestions on every free-text member option (owner decision, 2026-09-24): officers typed
 * names into ID-only options during the 2.14.0 reply session and got "Check your input".
 */
import { expect, test } from "bun:test";
import type { AutocompleteContext } from "../../src/bot/command.js";
import { completeMember, focusedOption } from "../../src/discord/autocomplete.js";
import { actorOf } from "../fixtures/actors.js";

// Invented user IDs for the owner, an officer and a visitor (the visitor's has 19 digits).
const OWNER = "300000000000000001";
const OFFICER = "300000000000000002";
const VISITOR = "1300000000000000003";
const BOT = "943291473477128243";

/** A cached guild member as completeMember reads it. */
const member = (
  id: string,
  username: string,
  displayName = username,
  extra: { nickname?: string; globalName?: string; bot?: boolean } = {},
) => ({
  id,
  displayName,
  nickname: extra.nickname ?? null,
  user: { username, globalName: extra.globalName ?? null, bot: extra.bot ?? false },
});

const CACHED = [
  member(OWNER, "juniperfox"),
  member(OFFICER, "wyvernmoth", "WyvernMoth", { globalName: "WyvernMoth" }),
  member(VISITOR, "wrenfield", "Wren", { nickname: "Wren" }),
  member(BOT, "devbot", "DevBot", { bot: true }),
];

/** An autocomplete context over a member cache, optionally with Discord's member search. */
function context(
  typed: string,
  options: {
    cached?: ReturnType<typeof member>[];
    officer?: boolean;
    userId?: string;
    search?: (query: { query: string; limit: number }) => Promise<Map<string, unknown>>;
  } = {},
): AutocompleteContext {
  const cached = options.cached ?? CACHED;
  return {
    actor: actorOf({
      guildId: "1040379370159743139",
      userId: options.userId ?? OWNER,
      officer: options.officer ?? true,
      manageRoles: false,
    }),
    interaction: {
      options: {
        getFocused: (full?: boolean) => (full ? { name: "member", value: typed } : typed),
      },
      guild: {
        members: {
          cache: new Map(cached.map((row) => [row.id, row])),
          search: options.search ?? (async () => new Map()),
        },
      },
    },
  } as unknown as AutocompleteContext;
}

test("typing filters cached members by display name, username, global name or nickname", async () => {
  expect(focusedOption(context("wyv"))).toBe("member");
  expect(await completeMember(context("wyv"))).toEqual([
    { name: "WyvernMoth (@wyvernmoth)", value: OFFICER },
  ]);
  expect((await completeMember(context("WREN"))).map((choice) => choice.value)).toEqual([VISITOR]);
  // A display name equal to the username shows once; bots are never suggested.
  expect(await completeMember(context("juni"))).toEqual([{ name: "@juniperfox", value: OWNER }]);
  expect(await completeMember(context("devbot"))).toEqual([]);
});

test("an empty query lists members, names that start with the query first, at most 25", async () => {
  expect((await completeMember(context(""))).map((choice) => choice.value)).toEqual([
    OWNER,
    VISITOR,
    OFFICER,
  ]);
  // 'w' starts Wren and WyvernMoth, and only appears inside no other name.
  expect((await completeMember(context("w"))).map((choice) => choice.value)).toEqual([
    VISITOR,
    OFFICER,
  ]);
  const many = Array.from({ length: 30 }, (_, index) =>
    member(`1000000000000000${String(index).padStart(3, "0")}`, `tester${index}`),
  );
  expect(await completeMember(context("tester", { cached: many }))).toHaveLength(25);
});

test("a pasted ID or mention is offered back, cached or not, so departed owners stay nameable", async () => {
  expect(await completeMember(context(` ${OFFICER} `))).toEqual([
    { name: "WyvernMoth (@wyvernmoth)", value: OFFICER },
  ]);
  expect(await completeMember(context(`<@!${VISITOR}>`))).toEqual([
    { name: "Wren (@wrenfield)", value: VISITOR },
  ]);
  expect(await completeMember(context("123456789012345678"))).toEqual([
    { name: "User ID 123456789012345678", value: "123456789012345678" },
  ]);
});

test("members are offered only themselves, since naming anyone else is refused", async () => {
  expect(await completeMember(context("wyv", { officer: false, userId: VISITOR }), true)).toEqual([
    { name: "Wren (@wrenfield)", value: VISITOR },
  ]);
  expect(
    await completeMember(context("", { officer: false, userId: "555555555555555555" }), true),
  ).toEqual([{ name: "You", value: "555555555555555555" }]);
});

test("Discord's member search runs only when the cache has no match, within its budget", async () => {
  const searched: string[] = [];
  const found = member("222222222222222222", "uncached", "Uncached Member");
  const search = async ({ query }: { query: string; limit: number }) => {
    searched.push(query);
    return new Map([[found.id, found]]);
  };
  expect(await completeMember(context("wyv", { search }))).toHaveLength(1);
  expect(searched).toEqual([]);
  expect(await completeMember(context("Uncached", { search }))).toEqual([
    { name: "Uncached Member (@uncached)", value: found.id },
  ]);
  expect(searched).toEqual(["Uncached"]);
  // One character never searches; a failing search suggests nothing instead of failing.
  expect(await completeMember(context("q", { search }))).toEqual([]);
  expect(searched).toEqual(["Uncached"]);
  const failing = async () => {
    throw new Error("rate limited");
  };
  expect(await completeMember(context("nobody", { search: failing }))).toEqual([]);
});

/**
 * The commands' own autocomplete handlers: which option is focused decides the completer, and the
 * audience decides what a member may see (members: themselves; grant/revoke/reset: officers).
 */
function commandContext(
  typed: string,
  focused: string,
  subcommand: string | null,
  officer: boolean,
): AutocompleteContext {
  const base = context(typed, { officer, userId: officer ? OWNER : VISITOR });
  return {
    ...base,
    actor: actorOf({ ...base.actor, officer, manageRoles: officer }),
    interaction: {
      ...base.interaction,
      options: {
        getFocused: (full?: boolean) => (full ? { name: focused, value: typed } : typed),
        getSubcommand: () => subcommand,
      },
    },
  } as unknown as AutocompleteContext;
}

test("/characters and /guest status offer a member only themselves; officers see everyone", async () => {
  const { default: characters } = await import(
    "../../src/commands/characters/characters.command.js"
  );
  const { default: guest } = await import("../../src/commands/guests/guest.command.js");
  const values = async (choices: unknown) =>
    ((await choices) as { value: string }[]).map((choice) => choice.value);
  expect(
    await values(characters.autocomplete?.(commandContext("wyv", "member", null, false))),
  ).toEqual([VISITOR]);
  expect(
    await values(characters.autocomplete?.(commandContext("wyv", "member", null, true))),
  ).toEqual([OFFICER]);
  expect(await values(guest.autocomplete?.(commandContext("", "member", "status", false)))).toEqual(
    [VISITOR],
  );
  expect(
    (await values(guest.autocomplete?.(commandContext("", "member", "status", true)))).length,
  ).toBe(3);
});

test("grant, revoke and reset suggestions are officer-only before any lookup", async () => {
  const { default: guest } = await import("../../src/commands/guests/guest.command.js");
  const { default: unassign } = await import("../../src/commands/characters/unassign.command.js");
  const { default: assign } = await import("../../src/commands/characters/assign.command.js");
  for (const subcommand of ["grant", "revoke", "reset"])
    await expect(
      Promise.resolve().then(() =>
        guest.autocomplete?.(commandContext("wyv", "member", subcommand, false)),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  for (const command of [unassign, assign])
    await expect(
      Promise.resolve().then(() =>
        command.autocomplete?.(commandContext("wyv", "member", null, false)),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  // An officer's member focus on /unassign completes members, not the character query.
  if (!unassign.autocomplete) throw new Error("/unassign has no autocomplete");
  const choices = (await unassign.autocomplete(commandContext("wyv", "member", null, true))) as {
    value: string;
  }[];
  expect(choices.map((choice) => choice.value)).toEqual([OFFICER]);
});
