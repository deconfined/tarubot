/**
 * gateway.actor's two modes (#43's "actor cache for member GETs", 2.40.0): `full` fetches the
 * guild, its roles and the member (three Discord requests), as every slash command and web POST
 * does; `light` reads the guild and its roles from the gateway cache and fetches only the member
 * (one request), and falls back to `full` for a guild that isn't cached and available. Both read
 * the A2 fact (TaruBot's own cached member holding Administrator, unknown counting as holding it)
 * and the member's Discord time-out. The SDK's managers are stubbed, so no credentials are needed.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { Collection, PermissionFlagsBits as P, PermissionsBitField } from "discord.js";
import type { Guild } from "discord.js";
import { DiscordGateway } from "../../src/discord/gateway.js";

const GUILD = "100000000000000001";
const USER = "200000000000000002";
/** Invented role IDs. */
const ROLE = { member: "400000000000000001", pronoun: "400000000000000002" } as const;

/** Gateways created by a test, destroyed afterwards so no client outlives it. */
const created: DiscordGateway[] = [];
afterEach(async () => {
  for (const gateway of created.splice(0)) await gateway.client.destroy();
});

/** What a member fetch answers: its permissions, roles, bot flag and time-out. */
interface MemberShape {
  readonly permissions?: bigint;
  readonly roleIds?: readonly string[];
  readonly bot?: boolean;
  readonly timedOut?: boolean;
}

/** An SDK-shaped member: only what gateway.actor reads. */
const memberOf = (shape: MemberShape) => ({
  user: { bot: shape.bot ?? false },
  permissions: new PermissionsBitField(shape.permissions ?? 0n),
  roles: { cache: new Collection((shape.roleIds ?? []).map((id) => [id, { id }])) },
  isCommunicationDisabled: () => shape.timedOut ?? false,
});

/** The world one test sets up: where the guild is, and how TaruBot's own member looks. */
interface World {
  /** Whether the gateway cache holds the guild, and whether it is available. */
  readonly cached?: "available" | "unavailable" | "absent";
  /** TaruBot's cached member: its permissions, or null when it isn't cached. */
  readonly bot?: bigint | null;
  readonly member?: MemberShape;
}

/** A gateway over one stubbed guild, recording every Discord request actor() makes. */
function gatewayWith(world: World = {}) {
  const gateway = new DiscordGateway();
  created.push(gateway);
  const requests: string[] = [];
  const bot = world.bot === undefined ? 0n : world.bot;
  const guild = {
    id: GUILD,
    available: world.cached !== "unavailable",
    roles: {
      fetch: async () => {
        requests.push("roles");
        return new Collection();
      },
    },
    members: {
      me: bot === null ? null : memberOf({ permissions: bot }),
      fetch: async (options: { user: string; force: boolean }) => {
        requests.push(`member ${options.user}${options.force ? " forced" : ""}`);
        return memberOf(world.member ?? { roleIds: [ROLE.member] });
      },
    },
  };
  if ((world.cached ?? "available") !== "absent")
    gateway.client.guilds.cache.set(GUILD, guild as unknown as Guild);
  spyOn(gateway.client.guilds, "fetch").mockImplementation((async (options: {
    guild: string;
    force: boolean;
  }) => {
    requests.push(`guild ${options.guild}${options.force ? " forced" : ""}`);
    return guild;
  }) as never);
  return { gateway, requests };
}

test("light mode makes exactly one Discord request: the member, forced", async () => {
  const { gateway, requests } = gatewayWith();
  const actor = await gateway.actor(GUILD, USER, "light");
  expect(requests).toEqual([`member ${USER} forced`]);
  expect(actor).toEqual({
    guildId: GUILD,
    userId: USER,
    officer: false,
    manageRoles: false,
    serverManager: false,
    roleIds: [ROLE.member],
    botAdministrator: false,
    timedOut: false,
  });
});

test("full mode, every command's default, fetches the guild, its roles and the member", async () => {
  for (const mode of ["full", undefined] as const) {
    const { gateway, requests } = gatewayWith();
    await gateway.actor(GUILD, USER, mode);
    expect({ mode, requests }).toEqual({
      mode,
      requests: [`guild ${GUILD} forced`, "roles", `member ${USER} forced`],
    });
  }
});

test("light mode falls back to full for a guild that isn't cached or available", async () => {
  for (const cached of ["absent", "unavailable"] as const) {
    const { gateway, requests } = gatewayWith({ cached });
    await gateway.actor(GUILD, USER, "light");
    expect({ cached, requests }).toEqual({
      cached,
      requests: [`guild ${GUILD} forced`, "roles", `member ${USER} forced`],
    });
  }
});

test("botAdministrator: TaruBot's cached member with Administrator, or none cached, is true", async () => {
  const cases: [bigint | null, boolean][] = [
    [P.ManageRoles | P.ViewChannel, false],
    [P.Administrator, true],
    [P.Administrator | P.ManageRoles, true],
    // Not cached: A2 can't be told, so the web's gate fails closed.
    [null, true],
  ];
  for (const [bot, expected] of cases)
    for (const mode of ["light", "full"] as const) {
      const { gateway } = gatewayWith({ bot });
      const { botAdministrator } = await gateway.actor(GUILD, USER, mode);
      expect({ bot: String(bot), mode, botAdministrator }).toEqual({
        bot: String(bot),
        mode,
        botAdministrator: expected,
      });
    }
});

test("timedOut follows the member's Discord time-out; officer facts are unchanged", async () => {
  const { gateway } = gatewayWith({
    member: { timedOut: true, roleIds: [ROLE.member, ROLE.pronoun] },
  });
  expect(await gateway.actor(GUILD, USER, "light")).toMatchObject({
    timedOut: true,
    roleIds: [ROLE.member, ROLE.pronoun],
  });
  const officer = gatewayWith({ member: { permissions: P.ManageGuild | P.ManageRoles } });
  expect(await officer.gateway.actor(GUILD, USER, "light")).toMatchObject({
    officer: true,
    serverManager: true,
    manageRoles: true,
    timedOut: false,
  });
});

test("a bot account is refused in either mode, after the one member request", async () => {
  for (const mode of ["light", "full"] as const) {
    const { gateway, requests } = gatewayWith({ member: { bot: true } });
    await expect(gateway.actor(GUILD, USER, mode)).rejects.toMatchObject({
      code: "forbidden",
      detail: { kind: "scope", scope: "human" },
    });
    expect(requests.at(-1)).toBe(`member ${USER} forced`);
  }
});
