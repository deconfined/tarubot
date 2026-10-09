/**
 * Self-service roles (2.39.0): the stored menu document and its limits, every officer edit as a
 * pure function with the equal-state rule, what the menu lists, and the one rule set for what may
 * be self-assigned (selfRoleChecker) over invented servers. Any officer may add any role the rules
 * pass (owner decision, 2026-10-09), so the rules take no officer at all. Invented IDs: guild 100
 * (also @everyone's role), TaruBot 900 with its bot role 600, Member 201, Guest 202, Officer 203,
 * FC Leader 204, candidate roles from 300, a moderator role 400, and channels from 700.
 */
import { describe, expect, test } from "bun:test";
import { ChannelType as T, PermissionFlagsBits as P } from "discord.js";
import type { ApiOverwrite, ApiRole } from "../../src/domain/permissions.js";
import {
  addable,
  applyOperation,
  channelOpeningRoles,
  checkRoles,
  cleanText,
  EMPTY_MENU,
  findOption,
  holdsAdministrator,
  LIMIT_MESSAGES,
  listed,
  MENU_LIMITS,
  type MenuEdit,
  type MenuOperation,
  menuRoleIds,
  menuSchema,
  permissionNames,
  readMenu,
  removable,
  type SelfRoleCategory,
  type SelfRoleMenu,
  type SelfRoleSettings,
  sameMenu,
  selfRoleChecker,
  selfRoleHealth,
  selfRoleProblems,
  SELF_ROLE_MESSAGES,
  selfRoleSettings,
  TEXT_MESSAGES,
  UNNAMED_PERMISSION,
  unreadableChannels,
} from "../../src/domain/self-roles.js";
import type { VisibilityChannel, VisibilityGuild } from "../../src/domain/visibility.js";
import type { GuildAccess } from "../../src/application/guild-access.js";
import type { DiscordPort } from "../../src/application/records.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type { Configuration } from "../../src/config/env.js";
import type { Lodestone } from "../../src/infrastructure/lodestone/client.js";
import { type Database, orm } from "../../src/infrastructure/postgres/database.js";
import { dispatcher } from "../../src/jobs/dispatch.js";
import type { PoolClient } from "pg";

const GUILD = "100";
const BOT = "900";
const BOT_ROLE = "600";
const ROLE = { member: "201", guest: "202", officer: "203", leader: "204", mod: "400" } as const;
/** A typical @everyone: view, post, react, embed, read history, join and speak in voice. */
const EVERYONE =
  P.ViewChannel |
  P.SendMessages |
  P.AddReactions |
  P.EmbedLinks |
  P.ReadMessageHistory |
  P.Connect |
  P.Speak |
  P.CreateInstantInvite;

/** Category IDs: UUIDs the page would mint. */
const CAT = {
  pronouns: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
  games: "0b6f3c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  extra: "1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b",
} as const;

/** A raw role below TaruBot by default. */
const role = (
  id: string,
  position: number,
  permissions = 0n,
  extra: Partial<ApiRole> = {},
): ApiRole => ({
  id,
  name: `role ${id}`,
  position,
  permissions: String(permissions),
  hoist: false,
  managed: false,
  ...extra,
});
/** A raw overwrite: type 0 for a role, 1 for a member. */
const ow = (id: string, allow = 0n, deny = 0n, type: 0 | 1 = 0): ApiOverwrite => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});
/** @everyone can't view. */
const PRIVATE = ow(GUILD, 0n, P.ViewChannel);
/** A cached channel. */
const ch = (
  id: string,
  overwrites: ApiOverwrite[] = [],
  extra: Partial<VisibilityChannel> = {},
): VisibilityChannel => ({
  id,
  type: T.GuildText,
  parentId: null,
  position: Number(id) - 700,
  overwrites,
  obfuscated: false,
  ...extra,
});

/** The candidate roles each case looks at, by what they carry. */
const C = {
  cosmetic: "301",
  game: "302",
  above: "303",
  managed: "304",
  retired: "305",
  kick: "306",
  manageChannels: "307",
  administrator: "308",
  everyoneBits: "309",
  unnamed: "310",
  denyOnly: "311",
  /** Same raw position as TaruBot's role, higher ID: Discord shows it lower. */
  tiedBelow: "650",
  /** Same raw position as TaruBot's role, lower ID: Discord shows it higher. */
  tiedAbove: "550",
} as const;

/** The channels: one per situation. */
const CH = {
  general: "700",
  announcements: "701",
  members: "702",
  memberNews: "703",
  game: "704",
  officerRoom: "705",
  leadership: "706",
  mods: "707",
  hidden: "708",
  leaders: "709",
  shared: "710",
  gameVoice: "711",
} as const;

/** The default server. `edit` adjusts its roles and channels for one case. */
function server(
  edit: {
    roles?: (roles: ApiRole[]) => ApiRole[];
    channels?: (channels: VisibilityChannel[]) => VisibilityChannel[];
    botRoles?: string[];
  } = {},
): VisibilityGuild {
  const roles: ApiRole[] = [
    role(GUILD, 0, EVERYONE),
    role(ROLE.member, 1),
    role(ROLE.guest, 2),
    role(C.cosmetic, 3),
    role(C.game, 4),
    role(C.managed, 5, 0n, { managed: true }),
    role(C.retired, 6),
    role(C.manageChannels, 7, P.ManageChannels),
    role(C.everyoneBits, 8, EVERYONE),
    role(C.unnamed, 9, 1n << 60n),
    role(C.denyOnly, 10),
    // The candidates with moderation powers sit above the others, which must stay below every role
    // holding one of those powers (above_staff): Kick's role is the lowest moderation role.
    role(C.kick, 11, P.KickMembers),
    role(C.administrator, 12, P.Administrator),
    role(ROLE.officer, 14),
    role(ROLE.leader, 15),
    role(ROLE.mod, 16, P.KickMembers | P.BanMembers),
    role(C.tiedBelow, 20),
    role(C.tiedAbove, 20),
    role(BOT_ROLE, 20, P.ManageRoles | P.ViewChannel, { managed: true }),
    role(C.above, 30),
  ];
  const channels: VisibilityChannel[] = [
    ch(CH.general, [ow(C.denyOnly, 0n, P.SendMessages)]),
    ch(CH.announcements, [ow(GUILD, 0n, P.SendMessages)]),
    ch(CH.members, [PRIVATE, ow(ROLE.member, P.ViewChannel)]),
    ch(CH.memberNews, [PRIVATE, ow(ROLE.member, P.ViewChannel, P.SendMessages)]),
    ch(CH.game, [PRIVATE, ow(C.game, P.ViewChannel)]),
    ch(CH.officerRoom, [PRIVATE, ow(ROLE.officer, P.ViewChannel)]),
    ch(CH.leadership, [PRIVATE, ow(ROLE.officer, P.ViewChannel)]),
    ch(CH.mods, [PRIVATE, ow(ROLE.mod, P.ViewChannel)]),
    // Obfuscation's synthetic entry: TaruBot can't read the real overwrites.
    ch(CH.hidden, [PRIVATE]),
    ch(CH.leaders, [PRIVATE, ow(ROLE.leader, P.ViewChannel)]),
    // Officers and members alike: an ordinary channel, not an officer one.
    ch(CH.shared, [PRIVATE, ow(ROLE.officer, P.ViewChannel), ow(ROLE.member, P.ViewChannel)]),
    ch(CH.gameVoice, [PRIVATE, ow(C.game, P.ViewChannel | P.Connect | P.Speak)], {
      type: T.GuildVoice,
    }),
  ];
  return {
    guildId: GUILD,
    bot: { id: BOT, roles: edit.botRoles ?? [BOT_ROLE], botRoleId: BOT_ROLE },
    roles: edit.roles ? edit.roles(roles) : roles,
    channels: edit.channels ? edit.channels(channels) : channels,
    heldRoles: [],
    communityUpdatesId: null,
  };
}

/** The default settings: all four roles bound, one retired, the officer room configured. */
const SETTINGS: SelfRoleSettings = selfRoleSettings(
  {
    member_role_id: ROLE.member,
    guest_role_id: ROLE.guest,
    officer_role_id: ROLE.officer,
    leader_role_id: ROLE.leader,
    officer_channel_id: CH.officerRoom,
    officer_notifications_channel_id: null,
    guest_application_channel_id: null,
  },
  [C.retired],
  [],
);

/** One role's problem codes. */
const codes = (roleId: string, guild = server(), settings = SETTINGS) =>
  selfRoleProblems(guild, roleId, settings).map((problem) => problem.code);
/** One role's problem of `code`. */
const problemOf = (roleId: string, code: string, guild = server(), settings = SETTINGS) =>
  selfRoleProblems(guild, roleId, settings).find((problem) => problem.code === code);
/**
 * The default server's channels, with only `roles` between @everyone and TaruBot's role (at 50), so
 * a case shows one ordering of roles.
 */
const ranked = (...roles: ApiRole[]) =>
  server({
    roles: () => [
      role(GUILD, 0, EVERYONE),
      ...roles,
      role(BOT_ROLE, 50, P.ManageRoles | P.ViewChannel, { managed: true }),
    ],
  });
/** Give `roleId` an overwrite in channel `id`. */
const withEntry = (id: string, entry: ApiOverwrite) =>
  server({
    channels: (channels) =>
      channels.map((channel) =>
        channel.id === id ? { ...channel, overwrites: [...channel.overwrites, entry] } : channel,
      ),
  });

// ---------------------------------------------------------------------------------------------
// Menus

/** A category; draft and empty unless given. */
const category = (id: string, extra: Partial<SelfRoleCategory> = {}): SelfRoleCategory => ({
  id,
  name: "Pronouns",
  description: "",
  max: null,
  state: "draft",
  options: [],
  ...extra,
});
/** An offered option. */
const option = (roleId: string, extra: { description?: string; removalOnly?: boolean } = {}) => ({
  roleId,
  description: extra.description ?? "",
  removalOnly: extra.removalOnly ?? false,
});
const menu = (...categories: SelfRoleCategory[]): SelfRoleMenu => ({ v: 1, categories });
/** The default menu: published pronouns (one offered, one not offered) and a draft of games. */
const MENU = menu(
  category(CAT.pronouns, {
    state: "published",
    max: 1,
    options: [option("401"), option("402", { removalOnly: true })],
  }),
  category(CAT.games, { name: "Games", options: [option("403"), option("404")] }),
);

/** The menu an edit produced, failing the test otherwise. */
function applied(result: MenuEdit): SelfRoleMenu {
  if (result.kind !== "menu") throw new Error(`Expected a menu, got ${JSON.stringify(result)}`);
  return result.menu;
}
/** The errors an edit refused with. */
function refused(result: MenuEdit) {
  if (result.kind !== "invalid") throw new Error(`Expected invalid, got ${JSON.stringify(result)}`);
  return result.errors;
}

describe("the stored document", () => {
  test("the empty menu and a full one read back; the caps are the owner's", () => {
    expect(MENU_LIMITS).toMatchObject({ categories: 10, optionsPerCategory: 25, options: 50 });
    expect(readMenu(EMPTY_MENU)).toEqual(EMPTY_MENU);
    expect(readMenu(MENU)).toEqual(MENU);
    // jsonb doesn't keep key order: a reordered copy is the same document.
    const reordered = JSON.parse(
      '{"categories":[{"options":[{"removalOnly":false,"description":"","roleId":"401"}],"state":"draft","max":null,"description":"","name":"Pronouns","id":"6f9619ff-8b86-4011-b42d-00c04fc964ff"}],"v":1}',
    );
    const parsed = readMenu(reordered);
    expect(parsed).not.toBeNull();
    if (parsed)
      expect(
        sameMenu(parsed, menu(category(CAT.pronouns, { options: [option("401")] }))),
      ).toBeTrue();
  });

  test("an unknown version, shape or broken rule makes the document unreadable", () => {
    const one = (extra: Partial<SelfRoleCategory>) => ({
      v: 1,
      categories: [category(CAT.pronouns, extra)],
    });
    const many = (n: number, per: number) => ({
      v: 1,
      categories: Array.from({ length: n }, (_, c) =>
        category(`${String(c).padStart(8, "0")}-1111-4111-8111-111111111111`, {
          options: Array.from({ length: per }, (_, o) => option(String(1000 + c * 100 + o))),
        }),
      ),
    });
    for (const bad of [
      null,
      { v: 2, categories: [] },
      { v: 1 },
      { v: 1, categories: [], extra: true },
      one({ name: "" }),
      one({ name: "x".repeat(41) }),
      one({ name: " Pronouns" }),
      one({ name: "Café" }),
      one({ name: "Pro‮nouns" }),
      one({ description: "line\nbreak" }),
      one({ max: 0 }),
      one({ max: 26 }),
      one({ max: 1.5 }),
      one({ state: "archived" as never }),
      one({ id: "not-a-uuid" }),
      one({ options: [option("401"), option("401")] }),
      one({ options: [option("0")] }),
      { v: 1, categories: [category(CAT.pronouns), category(CAT.pronouns, { name: "Other" })] },
      {
        v: 1,
        categories: [
          category(CAT.pronouns, { options: [option("401")] }),
          category(CAT.games, { options: [option("401")] }),
        ],
      },
      many(11, 0),
      many(1, 26),
      many(3, 17),
    ])
      expect({ bad, read: readMenu(bad) }).toEqual({ bad, read: null });
    // At the caps exactly: 10 categories, 25 in one, 50 in all.
    expect(readMenu(many(10, 5))).not.toBeNull();
    expect(readMenu(many(2, 25))).not.toBeNull();
    expect(() => menuSchema.parse(many(3, 17))).toThrow();
  });

  test("text is trimmed and normalized to NFC before it is checked or stored", () => {
    expect(cleanText("  Café  ")).toBe("Café");
    const created = applied(
      applyOperation(EMPTY_MENU, {
        op: "category.create",
        categoryId: CAT.pronouns,
        name: "  Café ",
        description: " Pick one ",
        max: 1,
      }),
    );
    expect(created.categories[0]).toMatchObject({ name: "Café", description: "Pick one" });
    expect(readMenu(created)).not.toBeNull();
  });
});

describe("officer edits", () => {
  const createOperation: Extract<MenuOperation, { op: "category.create" }> = {
    op: "category.create",
    categoryId: CAT.extra,
    name: "Roles",
    description: "",
    max: null,
  };
  const create = (extra: Partial<Extract<MenuOperation, { op: "category.create" }>> = {}) =>
    applyOperation(MENU, { ...createOperation, ...extra });

  test("category.create appends a draft, and a repeat with the same minted ID changes nothing", () => {
    const created = applied(create());
    expect(created.categories.map((c) => c.id)).toEqual([CAT.pronouns, CAT.games, CAT.extra]);
    expect(created.categories[2]).toEqual(category(CAT.extra, { name: "Roles" }));
    // A double submit: the category already exists, whatever the form says.
    expect(
      sameMenu(
        applied(
          applyOperation(created, {
            op: "category.create",
            categoryId: CAT.extra,
            name: "Other",
            description: "",
            max: 3,
          }),
        ),
        created,
      ),
    ).toBeTrue();
  });

  test("category text and limits are refused field by field, never quoting what was typed", () => {
    expect(refused(create({ name: "  " }))).toEqual([
      { field: "name", message: TEXT_MESSAGES.name },
    ]);
    expect(refused(create({ name: "x".repeat(41) }))).toEqual([
      { field: "name", message: TEXT_MESSAGES.tooLong(40) },
    ]);
    // Code points, not UTF-16 units: forty emoji fit.
    expect(applied(create({ name: "🌙".repeat(40) })).categories).toHaveLength(3);
    // Every Bidi_Control character, the LRM, RLM and ALM marks included, C0 and C1 controls, line
    // and paragraph separators, and every other invisible format or default-ignorable character:
    // zero-width space, word joiner, byte order mark, soft hyphen, a stray tag character, and a
    // Hangul filler, which would make a name look blank.
    for (const hidden of [
      "Pro‮nouns",
      "a⁦b",
      "He\u200fHim",
      "a\u200eb",
      "x\u061cy",
      "bell\u0007",
      "two\nlines",
      "c1\u0085",
      "Pro\u200bnouns",
      "A\u2060B",
      "A\ufeffB",
      "A\u2028B",
      "A\u2029B",
      "soft\u00adhyphen",
      "A\u{E0041}B",
      "\u{1F3F4}\u{E0067}\u{E0062}",
      "\u3164",
      "Pronouns\u3164",
    ])
      expect({ hidden, errors: refused(create({ name: hidden })) }).toEqual({
        hidden,
        errors: [{ field: "name", message: TEXT_MESSAGES.hidden }],
      });
    // Text that draws nothing isn't a name, and isn't a description either.
    for (const blank of ["\u200d", "\ufe0f", "\u0301", "\u2800"])
      expect({ blank, errors: refused(create({ name: blank })) }).toEqual({
        blank,
        errors: [{ field: "name", message: TEXT_MESSAGES.name }],
      });
    expect(refused(create({ description: "\u200d" }))).toEqual([
      { field: "description", message: TEXT_MESSAGES.hidden },
    ]);
    // What emoji and scripts need stays: a subdivision flag (a tag sequence), a ZWJ sequence with
    // its variation selector, a keycap, and a Persian word with its zero-width non-joiner.
    for (const name of [
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} Scotland",
      "\u{1F3F3}\ufe0f\u200d\u{1F308} Pride",
      "1\ufe0f\u20e3 First",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    ])
      expect({ name, created: applied(create({ name })).categories[2]?.name }).toEqual({
        name,
        created: name,
      });
    expect(refused(create({ description: "y".repeat(201) }))).toEqual([
      { field: "description", message: TEXT_MESSAGES.tooLong(200) },
    ]);
    for (const max of [0, 26, 1.5, -1])
      expect(refused(create({ max }))).toEqual([{ field: "max", message: LIMIT_MESSAGES.max }]);
    for (const max of [null, 1, 25]) expect(applied(create({ max })).categories).toHaveLength(3);
    expect(refused(create({ categoryId: "not-a-uuid" }))).toEqual([
      { field: "form", message: LIMIT_MESSAGES.form },
    ]);
    // Several fields at once.
    expect(refused(create({ name: "", description: "‮", max: 30 })).map((e) => e.field)).toEqual([
      "name",
      "description",
      "max",
    ]);
  });

  test("an eleventh category is refused", () => {
    let full = EMPTY_MENU;
    for (let n = 0; n < 10; n++)
      full = applied(
        applyOperation(full, {
          op: "category.create",
          categoryId: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`,
          name: `Category ${n}`,
          description: "",
          max: null,
        }),
      );
    expect(
      refused(
        applyOperation(full, {
          op: "category.create",
          categoryId: CAT.extra,
          name: "One more",
          description: "",
          max: null,
        }),
      ),
    ).toEqual([{ field: "form", message: LIMIT_MESSAGES.categories }]);
  });

  test("a name another category has is refused, ignoring case; a category keeps its own", () => {
    const duplicate = [{ field: "name", message: LIMIT_MESSAGES.duplicateName }];
    expect(refused(create({ name: " games " }))).toEqual(duplicate);
    expect(refused(create({ name: "PRONOUNS" }))).toEqual(duplicate);
    // A joiner or variation selector it may keep doesn't make it another name.
    expect(refused(create({ name: "Pro\u200dnouns" }))).toEqual(duplicate);
    expect(refused(create({ name: "Games\ufe0f" }))).toEqual(duplicate);
    // A name with a problem of its own reports only that.
    expect(refused(create({ name: "Games‮" }))).toEqual([
      { field: "name", message: TEXT_MESSAGES.hidden },
    ]);
    const rename = (name: string) =>
      applyOperation(MENU, {
        op: "category.edit",
        categoryId: CAT.games,
        name,
        description: "",
        max: null,
      });
    expect(refused(rename("pronouns"))).toEqual(duplicate);
    expect(applied(rename("GAMES")).categories[1]?.name).toBe("GAMES");
    // A repeated create is recognised by its minted ID first: still a success, not a duplicate.
    const created = applied(create({ name: "Raids" }));
    expect(
      sameMenu(applied(applyOperation(created, { ...createOperation, name: "Raids" })), created),
    ).toBeTrue();
  });

  test("category.edit keeps the state and options; a removed category is gone", () => {
    const edited = applied(
      applyOperation(MENU, {
        op: "category.edit",
        categoryId: CAT.games,
        name: "Games we play",
        description: "Pick any",
        max: 3,
      }),
    );
    expect(edited.categories[1]).toEqual(
      category(CAT.games, {
        name: "Games we play",
        description: "Pick any",
        max: 3,
        options: [option("403"), option("404")],
      }),
    );
    expect(
      applyOperation(MENU, {
        op: "category.edit",
        categoryId: CAT.extra,
        name: "x",
        description: "",
        max: null,
      }),
    ).toEqual({ kind: "gone" });
  });

  test("category.move names an absolute place, clamped, so a repeat is the same menu", () => {
    const three = applied(create());
    const order = (result: MenuEdit) => applied(result).categories.map((c) => c.id);
    const move = (categoryId: string, to: number, from = three) =>
      applyOperation(from, { op: "category.move", categoryId, to });
    expect(order(move(CAT.extra, 0))).toEqual([CAT.extra, CAT.pronouns, CAT.games]);
    expect(order(move(CAT.pronouns, 2))).toEqual([CAT.games, CAT.extra, CAT.pronouns]);
    expect(order(move(CAT.pronouns, 99))).toEqual([CAT.games, CAT.extra, CAT.pronouns]);
    expect(order(move(CAT.extra, -4))).toEqual([CAT.extra, CAT.pronouns, CAT.games]);
    const once = applied(move(CAT.games, 0));
    expect(sameMenu(applied(move(CAT.games, 0, once)), once)).toBeTrue();
    expect(sameMenu(applied(move(CAT.games, 1)), three)).toBeTrue();
    expect(refused(move(CAT.games, 0.5))).toEqual([
      { field: "form", message: LIMIT_MESSAGES.form },
    ]);
    expect(move(CAT.extra, 0, MENU)).toEqual({ kind: "gone" });
  });

  test("category.setState sets each state; publishAll publishes only drafts", () => {
    for (const state of ["draft", "published", "removal_only"] as const)
      expect(
        applied(applyOperation(MENU, { op: "category.setState", categoryId: CAT.games, state }))
          .categories[1]?.state,
      ).toBe(state);
    expect(
      applyOperation(MENU, { op: "category.setState", categoryId: CAT.extra, state: "published" }),
    ).toEqual({ kind: "gone" });
    const withNotOffered = applied(
      applyOperation(MENU, {
        op: "category.setState",
        categoryId: CAT.pronouns,
        state: "removal_only",
      }),
    );
    const published = applied(applyOperation(withNotOffered, { op: "menu.publishAll" }));
    expect(published.categories.map((c) => c.state)).toEqual(["removal_only", "published"]);
    expect(
      sameMenu(applied(applyOperation(published, { op: "menu.publishAll" })), published),
    ).toBeTrue();
  });

  test("category.delete removes it; deleting it again is the same menu; reset empties the menu", () => {
    const deleted = applied(applyOperation(MENU, { op: "category.delete", categoryId: CAT.games }));
    expect(deleted.categories.map((c) => c.id)).toEqual([CAT.pronouns]);
    expect(
      sameMenu(
        applied(applyOperation(deleted, { op: "category.delete", categoryId: CAT.games })),
        deleted,
      ),
    ).toBeTrue();
    expect(applied(applyOperation(MENU, { op: "menu.reset" }))).toEqual(EMPTY_MENU);
    expect(
      sameMenu(applied(applyOperation(EMPTY_MENU, { op: "menu.reset" })), EMPTY_MENU),
    ).toBeTrue();
  });

  test("options.add appends several roles in order, once each, within the caps", () => {
    const add = (roleIds: string[], categoryId: string = CAT.games, from = MENU) =>
      applyOperation(from, {
        op: "options.add",
        categoryId,
        roleIds,
        unreadableAcknowledged: false,
      });
    expect(applied(add(["406", "405", "406"])).categories[1]?.options).toEqual([
      option("403"),
      option("404"),
      option("406"),
      option("405"),
    ]);
    // Already in this category: a repeat, the same menu.
    expect(sameMenu(applied(add(["403", "404"])), MENU)).toBeTrue();
    expect(refused(add(["401"]))).toEqual([
      { field: "roleIds", message: "<@&401> is already in another category." },
    ]);
    expect(refused(add([]))).toEqual([{ field: "roleIds", message: LIMIT_MESSAGES.roleIds }]);
    expect(refused(add(["@everyone"]))).toEqual([
      { field: "roleIds", message: LIMIT_MESSAGES.unknownRole },
    ]);
    expect(add(["405"], CAT.extra)).toEqual({ kind: "gone" });
    const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(from + i));
    expect(refused(add(ids(500, 24)))).toEqual([
      { field: "roleIds", message: LIMIT_MESSAGES.optionsPerCategory },
    ]);
    expect(applied(add(ids(500, 23))).categories[1]?.options).toHaveLength(25);
    // 50 in all: 2 + 2 already, so 46 more fit across two categories, and not 47.
    const big = applied(add(ids(600, 21), CAT.pronouns, applied(add(ids(500, 23)))));
    expect(menuRoleIds(big)).toHaveLength(48);
    const room = applied(
      applyOperation(big, {
        op: "category.create",
        categoryId: CAT.extra,
        name: "More",
        description: "",
        max: null,
      }),
    );
    expect(applied(add(ids(700, 2), CAT.extra, room)).categories[2]?.options).toHaveLength(2);
    expect(refused(add(ids(700, 3), CAT.extra, room))).toEqual([
      { field: "roleIds", message: LIMIT_MESSAGES.options },
    ]);
  });

  test("options.edit sets every row's description, place and state in one form", () => {
    const four = applied(
      applyOperation(MENU, {
        op: "options.add",
        categoryId: CAT.games,
        roleIds: ["405", "406"],
        unreadableAcknowledged: false,
      }),
    );
    const edit = (rows: Extract<MenuOperation, { op: "options.edit" }>["rows"], from = four) =>
      applyOperation(from, { op: "options.edit", categoryId: CAT.games, rows });
    const result = applied(
      edit([
        { roleId: "403", description: " Valheim ", position: 3, state: "offered" },
        { roleId: "404", description: "", position: 1, state: "removal_only" },
        { roleId: "405", description: "", position: 2, state: "remove" },
        { roleId: "406", description: "FFXIV", position: 1, state: "offered" },
      ]),
    );
    // Ordered by position, ties keeping their current order; removed rows are dropped.
    expect(result.categories[1]?.options).toEqual([
      option("404", { removalOnly: true }),
      option("406", { description: "FFXIV" }),
      option("403", { description: "Valheim" }),
    ]);
    // A repeat of the same form is the same menu.
    expect(
      sameMenu(
        applied(
          edit(
            [
              { roleId: "404", description: "", position: 1, state: "removal_only" },
              { roleId: "406", description: "FFXIV", position: 2, state: "offered" },
              { roleId: "403", description: "Valheim", position: 3, state: "offered" },
            ],
            result,
          ),
        ),
        result,
      ),
    ).toBeTrue();
    // A role the form didn't name (added since it was rendered) keeps its place and values.
    expect(
      applied(
        edit([{ roleId: "403", description: "", position: 1, state: "offered" }]),
      ).categories[1]?.options.map((o) => o.roleId),
    ).toEqual(["403", "404", "405", "406"]);
    // Removing the last option leaves an empty category.
    expect(
      applied(
        applyOperation(MENU, {
          op: "options.edit",
          categoryId: CAT.pronouns,
          rows: [
            { roleId: "401", description: "", position: 1, state: "remove" },
            { roleId: "402", description: "", position: 2, state: "remove" },
          ],
        }),
      ).categories[0]?.options,
    ).toEqual([]);
  });

  test("options.edit: a typed position lands where it was typed, read from the form's own order", () => {
    // A form over A, B and C shows them at 1, 2 and 3; the officer types over one position, so the
    // moved row ties with the row left showing that number.
    const three = menu(
      category(CAT.games, { options: [option("401"), option("402"), option("403")] }),
    );
    const typed = (positions: readonly number[]): MenuOperation => ({
      op: "options.edit",
      categoryId: CAT.games,
      rows: ["401", "402", "403"].map((roleId, at) => ({
        roleId,
        description: "",
        position: positions[at] ?? Number.NaN,
        state: "offered",
      })),
    });
    const order = (from: SelfRoleMenu, operation: MenuOperation) =>
      applied(applyOperation(from, operation)).categories[0]?.options.map((o) => o.roleId);
    for (const [positions, expected] of [
      // B moved up to 1: first, not a no-op that still says "Roles saved".
      [
        [1, 1, 3],
        ["402", "401", "403"],
      ],
      // C moved up to 1: first, not second.
      [
        [1, 2, 1],
        ["403", "401", "402"],
      ],
      // A moved down to 3: last, not second.
      [
        [3, 2, 3],
        ["402", "403", "401"],
      ],
    ] as const) {
      const operation = typed(positions);
      const once = applied(applyOperation(three, operation));
      expect({ positions, order: order(three, operation) }).toEqual({
        positions,
        order: [...expected],
      });
      // The same form again (a double submit) gives the same menu: the equal-state rule.
      expect({ positions, same: sameMenu(applied(applyOperation(once, operation)), once) }).toEqual(
        { positions, same: true },
      );
    }
    // The tie-break reads the form, not the menu: the same form gives the same order from any
    // current order of the same roles.
    const shuffled = menu(
      category(CAT.games, { options: [option("403"), option("401"), option("402")] }),
    );
    expect(order(shuffled, typed([1, 1, 3]))).toEqual(["402", "401", "403"]);
  });

  test("options.edit refusals: bad rows per field, duplicates, and rows for removed roles", () => {
    const edit = (rows: Extract<MenuOperation, { op: "options.edit" }>["rows"]) =>
      applyOperation(MENU, { op: "options.edit", categoryId: CAT.games, rows });
    expect(
      refused(
        edit([
          { roleId: "403", description: "z".repeat(101), position: 0, state: "offered" },
          { roleId: "404", description: "‮", position: 1.5, state: "offered" },
        ]),
      ),
    ).toEqual([
      { field: "description:403", message: TEXT_MESSAGES.tooLong(100) },
      { field: "position:403", message: LIMIT_MESSAGES.position },
      { field: "description:404", message: TEXT_MESSAGES.hidden },
      { field: "position:404", message: LIMIT_MESSAGES.position },
    ]);
    expect(
      refused(
        edit([
          { roleId: "403", description: "", position: 1, state: "offered" },
          { roleId: "403", description: "", position: 2, state: "offered" },
        ]),
      ),
    ).toEqual([{ field: "rows", message: LIMIT_MESSAGES.rows }]);
    expect(edit([{ roleId: "401", description: "", position: 1, state: "offered" }])).toEqual({
      kind: "gone",
    });
    // Removing a role that is already gone is the repeat of a removal (a double submit): done.
    const removed = applied(
      edit([
        { roleId: "403", description: "", position: 1, state: "offered" },
        { roleId: "404", description: "", position: 2, state: "remove" },
      ]),
    );
    expect(
      sameMenu(
        applied(
          applyOperation(removed, {
            op: "options.edit",
            categoryId: CAT.games,
            rows: [
              { roleId: "403", description: "", position: 1, state: "offered" },
              { roleId: "404", description: "", position: 2, state: "remove" },
            ],
          }),
        ),
        removed,
      ),
    ).toBeTrue();
    expect(applyOperation(MENU, { op: "options.edit", categoryId: CAT.extra, rows: [] })).toEqual({
      kind: "gone",
    });
  });

  test("the equal-state rule: every edit applied twice gives the menu of applying it once", () => {
    const operations: MenuOperation[] = [
      { op: "category.create", categoryId: CAT.extra, name: "New", description: "", max: 2 },
      { op: "category.edit", categoryId: CAT.games, name: "Games!", description: "d", max: 5 },
      { op: "category.move", categoryId: CAT.games, to: 0 },
      { op: "category.setState", categoryId: CAT.games, state: "published" },
      { op: "category.delete", categoryId: CAT.pronouns },
      { op: "menu.publishAll" },
      { op: "menu.reset" },
      { op: "options.add", categoryId: CAT.games, roleIds: ["405"], unreadableAcknowledged: true },
      {
        op: "options.edit",
        categoryId: CAT.games,
        rows: [
          { roleId: "403", description: "x", position: 2, state: "removal_only" },
          { roleId: "404", description: "", position: 1, state: "remove" },
        ],
      },
      // Tied positions: 403 typed down onto 404's place, so 404 comes first.
      {
        op: "options.edit",
        categoryId: CAT.games,
        rows: [
          { roleId: "403", description: "", position: 2, state: "offered" },
          { roleId: "404", description: "", position: 2, state: "offered" },
        ],
      },
    ];
    for (const operation of operations) {
      const once = applied(applyOperation(MENU, operation));
      expect({ op: operation.op, changed: !sameMenu(once, MENU) }).toEqual({
        op: operation.op,
        changed: true,
      });
      expect({
        op: operation.op,
        same: sameMenu(applied(applyOperation(once, operation)), once),
      }).toEqual({
        op: operation.op,
        same: true,
      });
      expect(readMenu(once)).not.toBeNull();
    }
  });
});

describe("what the menu lists", () => {
  test("addable needs a published category and an offered option; listed is anything not a draft", () => {
    const states = menu(
      category(CAT.pronouns, {
        state: "published",
        options: [option("401"), option("402", { removalOnly: true })],
      }),
      category(CAT.games, { state: "draft", options: [option("403")] }),
      category(CAT.extra, { state: "removal_only", options: [option("404")] }),
    );
    expect(
      ["401", "402", "403", "404", "405"].map((id) => [addable(states, id), listed(states, id)]),
    ).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [false, true],
      [false, false],
    ]);
    expect(findOption(states, "404")?.category.id).toBe(CAT.extra);
    expect(menuRoleIds(states)).toEqual(["401", "402", "403", "404"]);
  });
});

describe("selfRoleChecker: what may be self-assigned", () => {
  test("a cosmetic role passes, and so does one carrying exactly @everyone's bits", () => {
    expect(codes(C.cosmetic)).toEqual([]);
    expect(codes(C.everyoneBits)).toEqual([]);
    expect(selfRoleChecker(server(), SETTINGS)(C.cosmetic).opens).toEqual([]);
  });

  test("roles nobody can self-assign: missing, @everyone, managed, TaruBot's own", () => {
    expect(codes("999")).toEqual(["missing"]);
    expect(codes(GUILD)).toEqual(["everyone"]);
    expect(codes(C.managed)).toEqual(["managed"]);
    expect(codes(BOT_ROLE)).toEqual(["bot_role"]);
  });

  test("access roles and retired roles are refused, naming the access role", () => {
    expect(codes(ROLE.member)).toEqual(["access_role"]);
    expect(problemOf(ROLE.member, "access_role")?.message).toBe(
      "It's TaruBot's Member role. Access roles can't be on the role menu.",
    );
    expect(problemOf(ROLE.leader, "access_role")?.message).toContain("FC Leader role");
    expect(codes(ROLE.officer)).toContain("access_role");
    expect(codes(C.retired)).toEqual(["retired_role"]);
    // Unbound, the Member role is just a role.
    const unbound = selfRoleSettings(
      {
        member_role_id: null,
        guest_role_id: null,
        officer_role_id: null,
        leader_role_id: null,
        officer_channel_id: null,
        officer_notifications_channel_id: null,
        guest_application_channel_id: null,
      },
      [],
      [],
    );
    expect(codes(ROLE.member, server(), unbound)).toEqual([]);
  });

  test("server permissions: staff powers always, anything else @everyone lacks", () => {
    expect(codes(C.manageChannels)).toEqual(["staff_permissions"]);
    expect(problemOf(C.manageChannels, "staff_permissions")?.message).toBe(
      "It has Manage Channels. A self-service role can never have Administrator, Manage Server, Manage Roles or Manage Channels.",
    );
    // Administrator is also a moderation power, and this role sits above Kick's.
    expect(codes(C.administrator)).toEqual(["staff_permissions", "above_staff"]);
    // Even when @everyone holds them.
    const generous = server({
      roles: (roles) =>
        roles.map((r) =>
          r.id === GUILD
            ? { ...r, permissions: String(EVERYONE | P.ManageChannels | P.ManageRoles) }
            : r,
        ),
    });
    expect(codes(C.manageChannels, generous)).toEqual(["staff_permissions"]);
    expect(codes(C.kick)).toEqual(["permissions"]);
    expect(problemOf(C.kick, "permissions")?.message).toBe(
      "It has Kick Members, which @everyone doesn't have in this server. A self-service role can't give server permissions.",
    );
    // A bit no flag names yet fails closed, and says how to find it.
    expect(problemOf(C.unnamed, "permissions")?.message).toBe(
      `It has ${UNNAMED_PERMISSION}, which @everyone doesn't have in this server. A self-service role can't give server permissions. Compare this role's permissions with @everyone's.`,
    );
  });

  test("TaruBot must sit above the role and hold Manage Roles; tied positions follow Discord", () => {
    // Each of these is above every moderation role too (see the next block).
    expect(codes(C.above)).toEqual(["above_bot", "above_staff"]);
    expect(codes(C.tiedBelow)).toEqual(["above_staff"]);
    expect(codes(C.tiedAbove)).toEqual(["above_bot", "above_staff"]);
    const weak = server({
      roles: (roles) => roles.map((r) => (r.id === BOT_ROLE ? { ...r, permissions: "0" } : r)),
    });
    expect(codes(C.cosmetic, weak)).toEqual(["bot_cannot_manage"]);
    // Administrator implies Manage Roles, as Discord grants it.
    const admin = server({
      roles: (roles) =>
        roles.map((r) => (r.id === BOT_ROLE ? { ...r, permissions: String(P.Administrator) } : r)),
    });
    expect(codes(C.cosmetic, admin)).toEqual([]);
    expect(holdsAdministrator(admin)).toBeTrue();
    expect(holdsAdministrator(server())).toBeFalse();
  });

  test("a change in a channel everyone, members or guests already see is refused", () => {
    // Posting in #announcements, where @everyone may read but not post.
    const announce = withEntry(CH.announcements, ow(C.cosmetic, P.SendMessages));
    expect(codes(C.cosmetic, announce)).toEqual(["visible_channel"]);
    expect(problemOf(C.cosmetic, "visible_channel", announce)).toEqual({
      code: "visible_channel",
      message: `It gives extra permissions in <#${CH.announcements}> (Send Messages). A self-service role can't change channels that everyone, members or guests can already see.`,
      channels: [CH.announcements],
    });
    // Mention Everyone in #general (also beyond @everyone's bits: one problem, not two).
    expect(codes(C.cosmetic, withEntry(CH.general, ow(C.cosmetic, P.MentionEveryone)))).toEqual([
      "visible_channel",
    ]);
    // Members see #member-news but can't post there; the role would let them.
    const news = withEntry(CH.memberNews, ow(C.cosmetic, P.SendMessages));
    expect(problemOf(C.cosmetic, "visible_channel", news)?.channels).toEqual([CH.memberNews]);
    // Allowing what everyone already has there changes nothing, unless another role denies it
    // there: the deny-only role mutes #general, and Send Messages would lift that mute.
    expect(
      codes(C.cosmetic, withEntry(CH.general, ow(C.cosmetic, P.ViewChannel | P.EmbedLinks))),
    ).toEqual([]);
    expect(
      codes(C.cosmetic, withEntry(CH.general, ow(C.cosmetic, P.ViewChannel | P.SendMessages))),
    ).toEqual(["channel_deny"]);
  });

  test("a role must sit below Officer, FC Leader and every moderation role (SEC-R1)", () => {
    const above = (guild: VisibilityGuild, settings = SETTINGS) =>
      problemOf(C.cosmetic, "above_staff", guild, settings)?.message;
    // Above the Officer role, then above the FC Leader role: each named as TaruBot's. Neither holds
    // a moderation power here, so the message claims none, only the rank (UX-6).
    const officerFirst = ranked(role(ROLE.officer, 1), role(C.cosmetic, 2), role(ROLE.leader, 3));
    expect(codes(C.cosmetic, officerFirst)).toEqual(["above_staff"]);
    expect(above(officerFirst)).toBe(
      `It's above <@&${ROLE.officer}>, TaruBot's Officer role, so it would rank above your officers. Move it below <@&${ROLE.officer}>.`,
    );
    const leaderFirst = ranked(role(ROLE.leader, 1), role(C.cosmetic, 2), role(ROLE.officer, 3));
    expect(above(leaderFirst)).toBe(
      `It's above <@&${ROLE.leader}>, TaruBot's FC Leader role, so it would rank above your FC Leader. Move it below <@&${ROLE.leader}>.`,
    );
    // A bound role with moderation powers names what its holders would lose, from its own bits.
    const kickingOfficer = ranked(
      role(ROLE.officer, 1, P.KickMembers | P.ModerateMembers),
      role(C.cosmetic, 2),
      role(ROLE.leader, 3),
    );
    expect(above(kickingOfficer)).toBe(
      `It's above <@&${ROLE.officer}>, TaruBot's Officer role, so people with that role couldn't kick or time out anyone who picks it. Move it below <@&${ROLE.officer}>.`,
    );
    // Above several: the lowest is named, since below it is below them all.
    const both = ranked(role(ROLE.leader, 1), role(ROLE.officer, 2), role(C.cosmetic, 3));
    expect(above(both)).toEndWith(`Move it below <@&${ROLE.leader}>.`);
    // Each moderation power, on a role below TaruBot, with only what that power does to someone;
    // Administrator holds them all, and the hierarchy limits it too.
    for (const [power, name, verbs] of [
      [P.KickMembers, "Kick Members", "kick"],
      [P.BanMembers, "Ban Members", "ban"],
      [P.ModerateMembers, "Time Out Members", "time out"],
      [P.ManageNicknames, "Manage Nicknames", "rename"],
      [P.Administrator, "Administrator", "kick, ban, time out or rename"],
    ] as const) {
      const guild = ranked(
        role(ROLE.mod, 1, power),
        role(C.cosmetic, 2),
        role(ROLE.officer, 3),
        role(ROLE.leader, 4),
      );
      expect({ name, message: above(guild) }).toEqual({
        name,
        message: `It's above <@&${ROLE.mod}>, which has ${name}, so people with that role couldn't ${verbs} anyone who picks it. Move it below <@&${ROLE.mod}>.`,
      });
    }
    // A moderation bot's own role, managed by its integration, as Dyno's is.
    const DYNO = "450";
    const dyno = ranked(
      role(DYNO, 1, P.KickMembers | P.BanMembers | P.ModerateMembers | P.ManageRoles, {
        managed: true,
      }),
      role(C.cosmetic, 2),
      role(ROLE.officer, 3),
      role(ROLE.leader, 4),
    );
    expect(above(dyno)).toBe(
      `It's above <@&${DYNO}>, which has Kick Members, Ban Members and Time Out Members, so people with that role couldn't kick, ban or time out anyone who picks it. Move it below <@&${DYNO}>.`,
    );
    // Below all of them: allowed. Other staff powers don't make a moderation role.
    expect(
      codes(
        C.cosmetic,
        ranked(
          role(C.cosmetic, 1),
          role(ROLE.mod, 2, P.KickMembers),
          role(ROLE.officer, 3),
          role(ROLE.leader, 4),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        C.cosmetic,
        ranked(
          role(ROLE.mod, 1, P.ManageMessages | P.ManageEvents | P.MuteMembers | P.MoveMembers),
          role(C.cosmetic, 2),
          role(ROLE.officer, 3),
          role(ROLE.leader, 4),
        ),
      ),
    ).toEqual([]);
    // The default server: every candidate below Kick's role is clear of it (the deny-only role
    // fails only for its mute: see SEC-1 below); the access and moderation roles above it are
    // refused too, besides their own problems.
    expect(codes(C.denyOnly)).toEqual(["restricts"]);
    expect(codes(C.kick)).toEqual(["permissions"]);
    expect(codes(ROLE.officer).slice(0, 2)).toEqual(["access_role", "above_staff"]);
  });

  test("tied raw positions follow Discord's order: the lower ID ranks higher", () => {
    const LOWER = "150";
    // Officer 203 and two roles at its raw position: 150 shows above it, 301 below.
    const officerTie = ranked(
      role(LOWER, 2),
      role(ROLE.officer, 2),
      role(C.cosmetic, 2),
      role(ROLE.leader, 3),
    );
    expect(codes(LOWER, officerTie)).toEqual(["above_staff"]);
    expect(codes(C.cosmetic, officerTie)).toEqual([]);
    // The same against a moderation role (400).
    const modTie = ranked(
      role(LOWER, 2),
      role(ROLE.mod, 2, P.BanMembers),
      role("401", 2),
      role(ROLE.officer, 3),
      role(ROLE.leader, 4),
    );
    expect(codes(LOWER, modTie)).toEqual(["above_staff"]);
    expect(codes("401", modTie)).toEqual([]);
  });

  test("TaruBot's own managed role is no moderation role; any other role TaruBot holds still is (CDI-R3-2)", () => {
    const SHARED = "651";
    const LOW = "652";
    // TaruBot's managed role low down, with Manage Nicknames as its core permissions give it, and
    // its reach from a shared "Bots" role at the top: TaruBot is the managed role's only holder.
    const BOT_LOW = role(BOT_ROLE, 1, P.ManageRoles | P.ManageNicknames, { managed: true });
    const TOP = role(SHARED, 50, P.ManageRoles | P.ViewChannel);
    const shared = server({
      botRoles: [BOT_ROLE, SHARED],
      roles: () => [role(GUILD, 0, EVERYONE), BOT_LOW, role(C.cosmetic, 2), TOP],
    });
    expect(codes(C.cosmetic, shared)).toEqual([]);
    // A lower, non-managed role TaruBot shares with people or other bots ("Mods", with Kick
    // Members): whoever's highest role it is must still reach someone who picks a menu role.
    const mods = server({
      botRoles: [BOT_ROLE, LOW, SHARED],
      roles: () => [
        role(GUILD, 0, EVERYONE),
        BOT_LOW,
        role(LOW, 2, P.KickMembers),
        role(C.cosmetic, 3),
        TOP,
      ],
    });
    expect(codes(C.cosmetic, mods)).toEqual(["above_staff"]);
    expect(problemOf(C.cosmetic, "above_staff", mods)?.message).toBe(
      `It's above <@&${LOW}>, which has Kick Members, so people with that role couldn't kick anyone who picks it. Move it below <@&${LOW}>.`,
    );
  });

  test("an unbound Officer or FC Leader role is just a role, and a deleted one binds nothing", () => {
    const unbound = selfRoleSettings(
      {
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: null,
        leader_role_id: null,
        officer_channel_id: null,
        officer_notifications_channel_id: null,
        guest_application_channel_id: null,
      },
      [],
      [],
    );
    const plain = ranked(role(ROLE.officer, 1), role(ROLE.leader, 2), role(C.cosmetic, 3));
    expect(codes(C.cosmetic, plain, unbound)).toEqual([]);
    // Unbound but holding a moderation power, it still counts, by that power.
    const kicking = ranked(role(ROLE.officer, 1, P.KickMembers), role(C.cosmetic, 2));
    expect(problemOf(C.cosmetic, "above_staff", kicking, unbound)?.message).toStartWith(
      `It's above <@&${ROLE.officer}>, which has Kick Members, so`,
    );
    // Bound, but deleted in Discord.
    expect(codes(C.cosmetic, ranked(role(C.cosmetic, 1)))).toEqual([]);
  });

  test("a role can't lift what another role denies, nor @everyone's deny where it opens nothing (SEC-R2)", () => {
    const RAIDERS = "320";
    const MUTED = "321";
    const RAID_NEWS = "712";
    const OPT_IN = "713";
    const withChannel = (...channels: VisibilityChannel[]) =>
      server({
        roles: (roles) => [...roles, role(RAIDERS, 2), role(MUTED, 2)],
        channels: (existing) => [...existing, ...channels],
      });
    // #raid-news: read-only, and seen only through Raiders, which officers assign. Send Messages
    // there would let every raider who picks the role post.
    const raidNews = withChannel(
      ch(RAID_NEWS, [
        ow(GUILD, 0n, P.ViewChannel | P.SendMessages),
        ow(RAIDERS, P.ViewChannel),
        ow(C.cosmetic, P.SendMessages),
      ]),
    );
    expect(selfRoleChecker(raidNews, SETTINGS)(C.cosmetic)).toEqual({
      roleId: C.cosmetic,
      problems: [
        {
          code: "channel_deny",
          message: `It overrides what @everyone or another role is denied in <#${RAID_NEWS}> (Send Messages). A self-service role can't lift a channel's restrictions, such as a read-only channel, a mute role or a jail role, apart from @everyone's in a channel it opens.`,
          channels: [RAID_NEWS],
        },
      ],
      opens: [],
    });
    // A mute role's deny in #general, which everyone sees.
    const muted = server({
      roles: (roles) => [...roles, role(MUTED, 2)],
      channels: (channels) =>
        channels.map((channel) =>
          channel.id === CH.general
            ? {
                ...channel,
                overwrites: [
                  ow(MUTED, 0n, P.SendMessages | P.AddReactions),
                  ow(C.cosmetic, P.AddReactions),
                ],
              }
            : channel,
        ),
    });
    expect(problemOf(C.cosmetic, "channel_deny", muted)?.message).toContain(
      `<#${CH.general}> (Add Reactions)`,
    );
    // An opt-in channel: @everyone may neither see nor post there, and the role lets its people do
    // both. Lifting @everyone's own deny where the role opens the channel is what opt-in means.
    const optIn = withChannel(
      ch(OPT_IN, [
        ow(GUILD, 0n, P.ViewChannel | P.SendMessages),
        ow(C.cosmetic, P.ViewChannel | P.SendMessages),
      ]),
    );
    expect(selfRoleChecker(optIn, SETTINGS)(C.cosmetic)).toEqual({
      roleId: C.cosmetic,
      problems: [],
      opens: [OPT_IN],
    });
    // Even there, another role's deny stays: a muted member who picks the role can't post.
    const mutedOptIn = withChannel(
      ch(OPT_IN, [
        ow(GUILD, 0n, P.ViewChannel),
        ow(MUTED, 0n, P.SendMessages),
        ow(C.cosmetic, P.ViewChannel | P.SendMessages),
      ]),
    );
    expect(codes(C.cosmetic, mutedOptIn)).toEqual(["channel_deny"]);
  });

  test("a role that takes anything away is refused, and its holders can't remove it (SEC-1)", () => {
    const takesAway =
      "A self-service role can't take anything away from the people who have it, so a mute, jail or quarantine role can't be on the role menu: the people it restricts could remove it.";
    // The default deny-only role mutes #general, as a Dyno-style Muted role does: listed, the
    // people it mutes could drop it, so it is refused and never removable, even Not offered.
    expect(selfRoleChecker(server(), SETTINGS)(C.denyOnly)).toEqual({
      roleId: C.denyOnly,
      problems: [
        {
          code: "restricts",
          message: `It takes permissions away in <#${CH.general}> (Send Messages). ${takesAway}`,
          channels: [CH.general],
        },
      ],
      opens: [],
    });
    expect(removable(server(), C.denyOnly, SETTINGS)).toBeFalse();
    expect(
      selfRoleHealth(
        menu(category(CAT.pronouns, { state: "removal_only", options: [option(C.denyOnly)] })),
        server(),
        SETTINGS,
      ).problems,
    ).toBe(1);
    // A jail role: View Channel denied in every channel TaruBot reads but #jail, which it opens.
    const JAIL = "322";
    const JAIL_ROOM = "714";
    const jail = server({
      roles: (roles) => [...roles, role(JAIL, 2)],
      channels: (channels) => [
        ...channels.map((channel) =>
          channel.id === CH.hidden
            ? channel
            : { ...channel, overwrites: [...channel.overwrites, ow(JAIL, 0n, P.ViewChannel)] },
        ),
        ch(JAIL_ROOM, [PRIVATE, ow(JAIL, P.ViewChannel | P.SendMessages)]),
      ],
    });
    const jailed = selfRoleChecker(jail, SETTINGS)(JAIL);
    expect(jailed.problems.map((problem) => problem.code)).toEqual(["restricts"]);
    expect(jailed.problems[0]?.channels).toHaveLength(11);
    expect(jailed.problems[0]?.message).toStartWith(
      `It takes permissions away in <#${CH.general}> (View Channel), <#${CH.announcements}> (View Channel),`,
    );
    expect(jailed.opens).toEqual([JAIL_ROOM]);
    expect(removable(jail, JAIL, SETTINGS)).toBeFalse();
    // Where it opens a channel for guests, what members already see there can't shrink either.
    const narrowed = selfRoleChecker(
      withEntry(CH.members, ow(C.cosmetic, P.ViewChannel, P.SendMessages)),
      SETTINGS,
    )(C.cosmetic);
    expect(narrowed).toEqual({
      roleId: C.cosmetic,
      problems: [
        {
          code: "restricts",
          message: `It takes permissions away in <#${CH.members}> (Send Messages). ${takesAway}`,
          channels: [CH.members],
        },
      ],
      opens: [CH.members],
    });
    // A deny in a channel nobody else sees only shapes what the role opens: still allowed.
    const shaped = server({
      channels: (channels) => [
        ...channels,
        ch("715", [PRIVATE, ow(C.cosmetic, P.ViewChannel, P.EmbedLinks)]),
      ],
    });
    expect(selfRoleChecker(shaped, SETTINGS)(C.cosmetic)).toEqual({
      roleId: C.cosmetic,
      problems: [],
      opens: ["715"],
    });
  });

  test("a View Channel allow can't undo a jail role's View Channel deny, opened or not (SEC-2)", () => {
    const JAIL = "322";
    const OPT_IN = "713";
    const withJail = (channels: (existing: VisibilityChannel[]) => VisibilityChannel[]) =>
      server({ roles: (roles) => [...roles, role(JAIL, 2)], channels });
    // #general, which everyone sees: Jail hides it from the people it holds, and the role's View
    // Channel allow, which gives everyone else nothing there, would show it to them again.
    const general = withJail((channels) =>
      channels.map((channel) =>
        channel.id === CH.general
          ? { ...channel, overwrites: [ow(JAIL, 0n, P.ViewChannel), ow(C.cosmetic, P.ViewChannel)] }
          : channel,
      ),
    );
    expect(selfRoleChecker(general, SETTINGS)(C.cosmetic)).toEqual({
      roleId: C.cosmetic,
      problems: [
        {
          code: "channel_deny",
          message: `It overrides what @everyone or another role is denied in <#${CH.general}> (View Channel). A self-service role can't lift a channel's restrictions, such as a read-only channel, a mute role or a jail role, apart from @everyone's in a channel it opens.`,
          channels: [CH.general],
        },
      ],
      opens: [],
    });
    // An opt-in channel: lifting @everyone's deny is opening it, but Jail's deny still stands.
    const optIn = withJail((channels) => [
      ...channels,
      ch(OPT_IN, [PRIVATE, ow(JAIL, 0n, P.ViewChannel), ow(C.cosmetic, P.ViewChannel)]),
    ]);
    const lifted = selfRoleChecker(optIn, SETTINGS)(C.cosmetic);
    expect(lifted.problems.map((problem) => [problem.code, problem.channels])).toEqual([
      ["channel_deny", [OPT_IN]],
    ]);
    expect(lifted.opens).toEqual([OPT_IN]);
    // A members-only channel the role opens for guests: Jail's deny there stands too.
    expect(
      problemOf(
        C.cosmetic,
        "channel_deny",
        withJail((channels) =>
          channels.map((channel) =>
            channel.id === CH.members
              ? {
                  ...channel,
                  overwrites: [
                    ...channel.overwrites,
                    ow(JAIL, 0n, P.ViewChannel),
                    ow(C.cosmetic, P.ViewChannel),
                  ],
                }
              : channel,
          ),
        ),
      )?.channels,
    ).toEqual([CH.members]);
  });

  test("opening channels within @everyone's bits is allowed (opt-in channels), and listed under Opens", () => {
    const game = selfRoleChecker(server(), SETTINGS)(C.game);
    expect(game.problems).toEqual([]);
    // Display order, the voice channel with its Connect and Speak, which @everyone holds.
    expect(game.opens).toEqual([CH.game, CH.gameVoice]);
    // Members see #members already; for guests the role opens it, which is allowed.
    const membersOnly = selfRoleChecker(
      withEntry(CH.members, ow(C.cosmetic, P.ViewChannel)),
      SETTINGS,
    )(C.cosmetic);
    expect(membersOnly).toEqual({ roleId: C.cosmetic, problems: [], opens: [CH.members] });
  });

  test("permissions @everyone lacks are refused in an opened channel and in any other", () => {
    const moderator = withEntry(CH.game, ow(C.cosmetic, P.ViewChannel | P.ManageMessages));
    expect(problemOf(C.cosmetic, "channel_permissions", moderator)).toEqual({
      code: "channel_permissions",
      message: `It gives permissions @everyone doesn't have in this server: <#${CH.game}> (Manage Messages). A self-service role can only carry @everyone's own permissions in a channel.`,
      channels: [CH.game],
    });
    // Without View Channel, in a channel only the moderators see: a moderator who picks the role
    // would gain Manage Messages there, though the role opens nothing.
    const hidden = selfRoleChecker(
      withEntry(CH.mods, ow(C.cosmetic, P.ManageMessages)),
      SETTINGS,
    )(C.cosmetic);
    expect(hidden.problems.map((problem) => problem.code)).toEqual(["channel_permissions"]);
    expect(hidden.opens).toEqual([]);
    // In a channel members already see, the same allow is a change there.
    expect(codes(C.cosmetic, withEntry(CH.members, ow(C.cosmetic, P.ManageMessages)))).toEqual([
      "visible_channel",
    ]);
    // Manage Roles reads Manage Permissions in a channel.
    expect(
      problemOf(
        C.cosmetic,
        "channel_permissions",
        withEntry(CH.game, ow(C.cosmetic, P.ViewChannel | P.ManageRoles)),
      )?.message,
    ).toContain("(Manage Permissions)");
  });

  test("officer-facing channels can't be opened: configured, Officer, FC Leader or staff-powered allows", () => {
    for (const channel of [CH.officerRoom, CH.leadership, CH.leaders, CH.mods]) {
      const guild = withEntry(channel, ow(C.cosmetic, P.ViewChannel));
      expect({ channel, codes: codes(C.cosmetic, guild) }).toEqual({
        channel,
        codes: ["staff_channel"],
      });
    }
    expect(
      problemOf(
        C.cosmetic,
        "staff_channel",
        withEntry(CH.leadership, ow(C.cosmetic, P.ViewChannel)),
      )?.message,
    ).toBe(
      `It opens <#${CH.leadership}>, which looks like an officer channel. A self-service role can't open officer channels.`,
    );
    // Officers and members both see #shared, so it isn't an officer channel: guests may be let in.
    const shared = selfRoleChecker(
      withEntry(CH.shared, ow(C.cosmetic, P.ViewChannel)),
      SETTINGS,
    )(C.cosmetic);
    expect(shared).toEqual({ roleId: C.cosmetic, problems: [], opens: [CH.shared] });
    // A channel onboarding classified staff-only, from the settings.
    const staffOnly = selfRoleSettings(
      {
        member_role_id: ROLE.member,
        guest_role_id: ROLE.guest,
        officer_role_id: ROLE.officer,
        leader_role_id: ROLE.leader,
        officer_channel_id: null,
        officer_notifications_channel_id: null,
        guest_application_channel_id: null,
      },
      [],
      [CH.game],
    );
    expect(codes(C.game, server(), staffOnly)).toEqual(["staff_channel"]);
  });

  test("channels TaruBot can't read are never judged, only counted", () => {
    expect(unreadableChannels(server())).toBe(1);
    const unreadableGrant = withEntry(CH.hidden, ow(C.cosmetic, P.ManageMessages));
    // The synthetic-looking channel's entries now differ, so it reads as real: use a flagged one.
    const flagged = server({
      channels: (channels) =>
        channels.map((channel) =>
          channel.id === CH.hidden
            ? {
                ...channel,
                obfuscated: true,
                overwrites: [...channel.overwrites, ow(C.cosmetic, P.ManageMessages)],
              }
            : channel,
        ),
    });
    expect(unreadableChannels(unreadableGrant)).toBe(0);
    expect(unreadableChannels(flagged)).toBe(1);
    expect(codes(C.cosmetic, flagged)).toEqual([]);
  });

  test("a role's own entry in a channel TaruBot can't read escapes every channel rule, so officers confirm it", () => {
    // A Raider role with a Manage Messages allow in #raid-planning, which members see. Readable,
    // it's refused; hidden from TaruBot (obfuscated, as every such channel is from 2026-11-16),
    // nothing about the channel can be judged, so the role passes and opens nothing there. The
    // add's confirmation covers this, not only opening the channel.
    const raid = (obfuscated: boolean) =>
      server({
        channels: (channels) => [
          ...channels,
          ch("712", [PRIVATE, ow(ROLE.member, P.ViewChannel), ow(C.cosmetic, P.ManageMessages)], {
            obfuscated,
          }),
        ],
      });
    expect(codes(C.cosmetic, raid(false))).toEqual(["visible_channel"]);
    expect(selfRoleChecker(raid(true), SETTINGS)(C.cosmetic)).toEqual({
      roleId: C.cosmetic,
      problems: [],
      opens: [],
    });
    expect(unreadableChannels(raid(true))).toBe(2);
    expect(SELF_ROLE_MESSAGES.acknowledge(2)).toBe(
      "Confirm you've checked that these roles don't open the 2 channels TaruBot can't see or give any permission in them.",
    );
    expect(SELF_ROLE_MESSAGES.acknowledge(1)).toBe(
      "Confirm you've checked that these roles don't open the channel TaruBot can't see or give any permission in it.",
    );
  });

  test("a server private by default: opening a channel is judged as opening, never as a permission", () => {
    // @everyone has no View Channel; Member and Guest have it server-wide; the lobby lets
    // @everyone in, and a game channel shuts Member and Guest out unless they pick its role.
    const shut = [ow(ROLE.member, 0n, P.ViewChannel), ow(ROLE.guest, 0n, P.ViewChannel)];
    const lobbyFirst = (
      entries: ApiOverwrite[],
      officerEntries: ApiOverwrite[] = [],
      memberEntries: ApiOverwrite[] = [],
    ) =>
      server({
        roles: (roles) =>
          roles.map((candidate) =>
            candidate.id === GUILD
              ? { ...candidate, permissions: String(EVERYONE & ~P.ViewChannel) }
              : candidate.id === ROLE.member || candidate.id === ROLE.guest
                ? { ...candidate, permissions: String(P.ViewChannel) }
                : candidate.id === C.cosmetic
                  ? { ...candidate, permissions: String(P.ViewChannel) }
                  : candidate,
          ),
        channels: () => [
          ch(CH.general, [ow(GUILD, P.ViewChannel)]),
          ch(CH.members, memberEntries),
          ch(CH.game, [...shut, ...entries]),
          ch(CH.officerRoom, [...shut, ow(ROLE.officer, P.ViewChannel), ...officerEntries]),
        ],
      });
    const optIn = selfRoleChecker(lobbyFirst([ow(C.game, P.ViewChannel)]), SETTINGS)(C.game);
    expect(optIn).toEqual({ roleId: C.game, problems: [], opens: [CH.game] });
    // More than View Channel is still refused there.
    expect(codes(C.game, lobbyFirst([ow(C.game, P.ViewChannel | P.ManageMessages)]))).toEqual([
      "channel_permissions",
    ]);
    expect(
      problemOf(
        C.game,
        "channel_permissions",
        lobbyFirst([ow(C.game, P.ViewChannel | P.ManageMessages)]),
      )?.message,
    ).toContain(`<#${CH.game}> (Manage Messages)`);
    // View Channel server-wide is a server permission @everyone lacks: refused once, there.
    expect(codes(C.cosmetic, lobbyFirst([]))).toEqual(["permissions"]);
    // The officer room still can't be opened.
    expect(codes(C.game, lobbyFirst([], [ow(C.game, P.ViewChannel)]))).toEqual(["staff_channel"]);
    // A jail role (the deny-only role here) hides a channel from the people it holds. In the
    // opt-in channel, lifting Member's and Guest's View Channel deny is opening it, but lifting
    // Jail's is not (SEC-2).
    const JAILED = ow(C.denyOnly, 0n, P.ViewChannel);
    expect(
      problemOf(C.game, "channel_deny", lobbyFirst([JAILED, ow(C.game, P.ViewChannel)]))?.channels,
    ).toEqual([CH.game]);
    // #members, which Member and Guest see through their server-wide View Channel: the role's View
    // Channel allow "opens" it only for @everyone alone, and gives members and guests nothing but
    // a way past Jail's deny (CDI-R3-1).
    const membersJail = lobbyFirst([], [], [JAILED, ow(C.game, P.ViewChannel)]);
    expect(selfRoleChecker(membersJail, SETTINGS)(C.game)).toMatchObject({
      problems: [{ code: "channel_deny", channels: [CH.members] }],
      opens: [CH.members],
    });
  });

  test("long channel lists name five and count the rest", () => {
    const many = server({
      channels: (channels) => [
        ...channels,
        ...Array.from({ length: 7 }, (_, i) =>
          ch(String(720 + i), [ow(GUILD, 0n, P.SendMessages), ow(C.cosmetic, P.SendMessages)]),
        ),
      ],
    });
    const problem = problemOf(C.cosmetic, "visible_channel", many);
    expect(problem?.channels).toHaveLength(7);
    expect(problem?.message).toContain("<#724> (Send Messages) and 2 more channels.");
  });

  test("checkRoles lists every role but @everyone, highest first, then missing menu roles", () => {
    const checks = checkRoles(server(), SETTINGS, ["999", C.cosmetic]);
    expect(checks[0]?.roleId).toBe(C.above);
    expect(checks.map((check) => check.roleId)).not.toContain(GUILD);
    expect(checks.at(-1)).toEqual({
      roleId: "999",
      problems: [{ code: "missing", message: "This role no longer exists in this server." }],
      opens: [],
    });
    expect(checks.filter((check) => check.roleId === C.cosmetic)).toHaveLength(1);
  });
});

describe("removal, channel-opening roles and the health check", () => {
  test("removable: anything TaruBot can take away, even a role that grants too much", () => {
    expect(removable(server(), C.kick, SETTINGS)).toBeTrue();
    // Above every moderation role: it can't be given, but whoever holds it can still drop it.
    expect(removable(server(), C.tiedBelow, SETTINGS)).toBeTrue();
    expect(
      removable(withEntry(CH.announcements, ow(C.cosmetic, P.SendMessages)), C.cosmetic, SETTINGS),
    ).toBeTrue();
    for (const roleId of [C.above, ROLE.member, C.retired, C.managed, "999", GUILD, BOT_ROLE])
      expect({ roleId, removable: removable(server(), roleId, SETTINGS) }).toEqual({
        roleId,
        removable: false,
      });
  });

  test("channelOpeningRoles: listed roles that open a channel, never drafts or cosmetic ones", () => {
    const games = menu(
      category(CAT.games, { state: "published", options: [option(C.game), option(C.cosmetic)] }),
    );
    expect(channelOpeningRoles(games, server(), SETTINGS)).toEqual([C.game]);
    const draft = menu(category(CAT.games, { options: [option(C.game)] }));
    expect(channelOpeningRoles(draft, server(), SETTINGS)).toEqual([]);
  });

  test("selfRoleHealth counts what members see and what fails its check", () => {
    const shown = menu(
      category(CAT.pronouns, {
        state: "published",
        options: [option(C.cosmetic), option(C.kick), option(C.above, { removalOnly: true })],
      }),
      category(CAT.games, { state: "removal_only", options: [option(C.game)] }),
      category(CAT.extra, { options: [option(C.unnamed)] }),
    );
    // Kick Members fails the add rules; the role above TaruBot can't be removed either.
    expect(selfRoleHealth(shown, server(), SETTINGS)).toEqual({
      listed: 4,
      problems: 2,
      unreadableChannels: 1,
      unreadableMenu: false,
    });
    expect(selfRoleHealth(shown, null, SETTINGS)).toEqual({
      listed: 4,
      problems: null,
      unreadableChannels: 0,
      unreadableMenu: false,
    });
    expect(selfRoleHealth(null, server(), SETTINGS)).toMatchObject({ unreadableMenu: true });
    expect(selfRoleHealth(EMPTY_MENU, server(), SETTINGS)).toMatchObject({
      listed: 0,
      problems: 0,
    });
    // A role above the moderation roles is a problem while it's offered, not once it isn't: its
    // holders can still remove it.
    const placed = (removalOnly: boolean) =>
      menu(
        category(CAT.pronouns, {
          state: "published",
          options: [option(C.cosmetic), option(C.tiedBelow, { removalOnly })],
        }),
      );
    expect(selfRoleHealth(placed(false), server(), SETTINGS).problems).toBe(1);
    expect(selfRoleHealth(placed(true), server(), SETTINGS).problems).toBe(0);
  });
});

test("permission names follow Discord, once per bit, with one phrase for unknown bits", () => {
  expect(permissionNames(P.ManageRoles, "server")).toEqual(["Manage Roles"]);
  expect(permissionNames(P.ManageRoles, "channel")).toEqual(["Manage Permissions"]);
  expect(permissionNames(P.ManageGuild | P.AddReactions | P.Stream, "server")).toEqual([
    "Manage Server",
    "Add Reactions",
    "Video",
  ]);
  // Manage Expressions has two discord.js names for one bit.
  expect(permissionNames(P.ManageGuildExpressions, "server")).toEqual(["Manage Expressions"]);
  expect(permissionNames((1n << 61n) | (1n << 62n), "server")).toEqual([UNNAMED_PERMISSION]);
  expect(permissionNames(0n, "server")).toEqual([]);
});

describe("the roles.self stub (2.39.0)", () => {
  test("the schedule pass closes every waiting role choice at once, and no other kind", async () => {
    // Drizzle over a client that records each statement and answers no rows, so no roster is due.
    const sent: { text: string; values: unknown[] }[] = [];
    const client = {
      query: async (config: { text: string }, values: unknown[] = []) => {
        sent.push({ text: config.text, values });
        return { rows: [], rowCount: 0, fields: [] };
      },
    };
    const app = {
      db: { orm: orm(client as unknown as PoolClient) },
      config: { ROSTER_INTERVAL_SECONDS: 21600 },
    } as unknown as Service;
    await new Synchronization(app).schedule();
    // Each statement with its bound values written in, so the whole condition reads at once.
    const statements = sent.map(({ text, values }) =>
      text.replace(/\$(\d+)/g, (_, n: string) => JSON.stringify(values[Number(n) - 1])),
    );
    const choices = statements.filter((text) => text.includes('"jobs"."kind" = "roles.self"'));
    // One close and the 30-day retention, both limited to role choices by their outermost AND.
    // The close has no age, server or due-time condition: 2.39.0 never runs these jobs, so every
    // waiting one ends now, whatever holds it, except a running one with a live lease. Its
    // status, succeeded, is one the payload-clearing trigger fires on.
    expect(choices).toEqual([
      'update "jobs" set "status" = "succeeded", "lease_until" = null, "completed_at" = now(), "last_error" = null, "result" = "{\\"skipped\\":\\"needs a newer TaruBot\\"}" where ("jobs"."kind" = "roles.self" and ("jobs"."status" in ("queued", "blocked", "disabled") or ("jobs"."status" = "running" and ("jobs"."lease_until" is null or "jobs"."lease_until" < now()))))',
      'delete from "jobs" where ("jobs"."kind" = "roles.self" and "jobs"."status" in ("succeeded", "failed") and "jobs"."completed_at" < now()-30*interval \'1 day\')',
    ]);
  });

  test("a member's role choice left by 2.40.0 completes as skipped, touching nothing", async () => {
    // Every dependency throws on first use and records it: the stub must answer before any
    // database read, Discord call or delivery_attempts row.
    const touched: string[] = [];
    const trap = <T>(name: string): T =>
      new Proxy(
        {},
        {
          get(_, key) {
            touched.push(`${name}.${String(key)}`);
            throw new Error(`${name} used`);
          },
        },
      ) as T;
    const app = new Service(
      trap<Database>("db"),
      trap<DiscordPort>("discord"),
      trap<Lodestone>("lodestone"),
      trap<Configuration>("config"),
    );
    const run = dispatcher(app, trap<Synchronization>("sync"), trap<GuildAccess>("access"));
    let guarded = 0;
    const result = await run(
      {
        id: "9f1c2b3a-4d5e-4f60-8a7b-1c2d3e4f5a6b",
        kind: "roles.self",
        guild_id: GUILD,
        user_id: "200",
        payload: { chosen: [C.cosmetic], offered: [C.cosmetic], savedAt: "2026-10-09T12:00:00Z" },
        payload_version: 1,
        generation: 1,
        attempts: 1,
        message_id: null,
        created_at: new Date("2026-10-09T12:00:00Z"),
        due_at: new Date("2026-10-09T12:00:00Z"),
        lease_token: "00000000-0000-4000-8000-000000000001",
      },
      async () => {
        guarded++;
      },
    );
    expect(result).toEqual({ skipped: "needs a newer TaruBot" });
    expect(touched).toEqual([]);
    expect(guarded).toBe(0);
  });
});
