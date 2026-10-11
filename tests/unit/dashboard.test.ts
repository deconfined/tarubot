/**
 * /dashboard and TaruBot's custom status (2.42.0). The command answers through its service with a
 * Link button to the parsed dashboard origin, the address as text for a development origin, or a
 * plain "not turned on" with no link. The gateway's client carries a Custom activity reading
 * "Dashboard: <origin>" in the presence option discord.js sends with every IDENTIFY, and none while
 * the web is off, its settings are invalid, or the text would pass Discord's limit. Clients are
 * built without logging in: the constructor opens no gateway session and sends no request.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { ActivityType, ButtonStyle, ComponentType } from "discord.js";
import { Dashboard } from "../../src/application/dashboard.js";
import { dashboardKey } from "../../src/application/keys.js";
import { Services } from "../../src/bot/services.js";
import dashboardCommand from "../../src/commands/utility/dashboard.command.js";
import {
  CUSTOM_STATUS_LIMIT,
  DiscordGateway,
  dashboardPresence,
} from "../../src/discord/gateway.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import { dashboardReply } from "../../src/discord/presenters/utility.js";
import { webSettings, type WebSettingsInput } from "../../src/web/settings.js";
import { buttonsOf, expectHouseStyle, onlyEmbed, visibleText } from "../fixtures/replies.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { ACTORS, REF } from "../fixtures/results.js";

const ORIGIN = "https://tarubot.example.org";

/** Valid web settings; the client secret is readable placeholder text, never a real one. */
const WEB: WebSettingsInput = {
  WEB_PUBLIC_ORIGIN: ORIGIN,
  WEB_PORT: "",
  DISCORD_CLIENT_SECRET: "placeholder-client-secret",
  DISCORD_APPLICATION_ID: "000000000000000001",
};

/** The origin main.ts hands both the service and the gateway, from the same parse. */
function originOf(input: WebSettingsInput): string | null {
  const parsed = webSettings(input);
  return parsed.status === "on" ? parsed.settings.origin : null;
}

describe("/dashboard's reply", () => {
  test("links the dashboard's home page with one Link button, labelled for what it does", () => {
    const presented = dashboardReply(ORIGIN);
    const embed = expectHouseStyle(presented, { tone: "neutral", title: "Dashboard" });
    expect(embed.description).toBe(
      "Open TaruBot's dashboard and sign in with Discord to see the pages open to you.",
    );
    expect(embed.footer?.text).toBe(ORIGIN);
    expect(buttonsOf(presented)).toEqual([
      {
        type: ComponentType.Button,
        style: ButtonStyle.Link,
        label: "Open the dashboard",
        url: ORIGIN,
      },
    ]);
    expect(presented.options.content).toBe("");
  });

  test("shows a development origin as text, since link buttons open only https", () => {
    for (const origin of ["http://localhost:8080", "http://[::1]"]) {
      const presented = dashboardReply(origin);
      const embed = expectHouseStyle(presented, { tone: "neutral", title: "Dashboard" });
      expect(embed.description).toBe(
        `This TaruBot's dashboard is at a development address, \`${origin}\`, which opens only on the computer running TaruBot.`,
      );
      expect(buttonsOf(presented)).toEqual([]);
    }
  });

  test("says plainly that the dashboard is off, with no link, code or Ref", () => {
    const presented = dashboardReply(null);
    const embed = expectHouseStyle(presented, { tone: "info", title: "Dashboard not turned on" });
    expect(embed.description).toBe(
      "The dashboard isn't turned on for this TaruBot. Whoever runs your TaruBot can turn it on.",
    );
    expect(embed.footer).toBeUndefined();
    expect(buttonsOf(presented)).toEqual([]);
    expect(visibleText(presented)).not.toMatch(/https?:|Ref|Code/u);
  });
});

describe("/dashboard", () => {
  let open: ReturnType<typeof interactionFixture> | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  /** Run /dashboard as a member with the dashboard service the composition root provides. */
  async function run(origin: string | null): Promise<Presented> {
    open = interactionFixture();
    const result = await dashboardCommand.execute?.({
      client: open.client,
      services: new Services().provide(dashboardKey, new Dashboard(origin)),
      allowsGuild: () => true,
      isStopping: () => false,
      report: () => {},
      resolveActor: async () => ACTORS.member,
      actor: ACTORS.member,
      viewer: viewerOf(ACTORS.member, REF),
      interaction: open.slash("dashboard"),
    });
    if (!(result instanceof Presented)) throw new Error("/dashboard returned no reply");
    return result;
  }

  test("is open to every member, private, needs only the dashboard service and has no options", () => {
    expect(dashboardCommand.name).toBe("dashboard");
    expect(dashboardCommand.access).toBe("user");
    expect(dashboardCommand.ephemeral).toBe(true);
    expect(dashboardCommand.requires).toEqual([dashboardKey]);
    const data = dashboardCommand.toJSON();
    expect(data.description).toBe("Get a link to TaruBot's dashboard");
    expect(data.options ?? []).toEqual([]);
  });

  test("links the origin parsed from WEB_PUBLIC_ORIGIN, without its trailing slash", async () => {
    const origin = originOf({ ...WEB, WEB_PUBLIC_ORIGIN: `${ORIGIN}/` });
    expect(origin).toBe(ORIGIN);
    const presented = await run(origin);
    expect(onlyEmbed(presented).title).toBe("Dashboard");
    expect(buttonsOf(presented).map((button) => ("url" in button ? button.url : null))).toEqual([
      ORIGIN,
    ]);
  });

  test("says the dashboard isn't turned on while the web is off or its settings are invalid", async () => {
    const off = originOf({ ...WEB, WEB_PUBLIC_ORIGIN: "" });
    const invalid = originOf({ ...WEB, DISCORD_CLIENT_SECRET: "" });
    const notAnOrigin = originOf({ ...WEB, WEB_PUBLIC_ORIGIN: `${ORIGIN}/dashboard` });
    expect([off, invalid, notAnOrigin]).toEqual([null, null, null]);
    for (const origin of [off, invalid, notAnOrigin]) {
      const presented = await run(origin);
      expect(onlyEmbed(presented).title).toBe("Dashboard not turned on");
      expect(buttonsOf(presented)).toEqual([]);
    }
  });
});

describe("TaruBot's custom status", () => {
  const gateways: DiscordGateway[] = [];
  /** A gateway as main.ts builds it, destroyed after the tests. */
  const gateway = (origin?: string | null): DiscordGateway => {
    const built = new DiscordGateway(origin === undefined ? {} : { dashboardOrigin: origin });
    gateways.push(built);
    return built;
  };
  afterAll(async () => {
    await Promise.all(gateways.map((built) => built.client.destroy()));
  });

  test("reads 'Dashboard: <origin>' as a Custom activity while the web is on", () => {
    expect(dashboardPresence(ORIGIN)).toEqual({
      activities: [
        { type: ActivityType.Custom, name: "Custom Status", state: `Dashboard: ${ORIGIN}` },
      ],
    });
    // The client option, which discord.js sends with every IDENTIFY, so a new session after an
    // invalid session or a failed resume shows it again.
    const presence = gateway(originOf(WEB)).client.options.presence;
    expect(presence?.activities).toEqual([
      {
        type: ActivityType.Custom,
        name: "Custom Status",
        state: "Dashboard: https://tarubot.example.org",
      },
    ]);
  });

  test("is the presence login hands the gateway for every IDENTIFY", async () => {
    // login() parses the presence option into options.ws.presence, which discord.js passes to
    // @discordjs/ws as initialPresence, the `presence` of each IDENTIFY. The connection itself is
    // replaced, so nothing leaves the process; the token is a readable placeholder.
    const { client } = gateway(ORIGIN);
    Object.assign(client.ws, { connect: async () => {} });
    await client.login("placeholder-token-never-sent");
    expect((client.options.ws as { presence?: unknown }).presence).toEqual({
      activities: [
        {
          type: ActivityType.Custom,
          name: "Custom Status",
          state: "Dashboard: https://tarubot.example.org",
          url: undefined,
        },
      ],
      afk: false,
      since: null,
      status: "online",
    });
  });

  test("is absent while the web is off or its settings are invalid, and for tools and tests", () => {
    expect(dashboardPresence(null)).toEqual({});
    for (const built of [
      gateway(originOf({ ...WEB, WEB_PUBLIC_ORIGIN: "" })),
      gateway(originOf({ ...WEB, WEB_PORT: "0" })),
      gateway(null),
      gateway(),
    ])
      expect(built.client.options.presence?.activities ?? []).toEqual([]);
  });

  test("is left out rather than cut when the text would pass Discord's 128 characters", () => {
    expect(CUSTOM_STATUS_LIMIT).toBe(128);
    const prefix = "Dashboard: https://";
    const fits = `https://${"a".repeat(CUSTOM_STATUS_LIMIT - prefix.length - ".org".length)}.org`;
    expect(`Dashboard: ${fits}`).toHaveLength(CUSTOM_STATUS_LIMIT);
    expect(dashboardPresence(fits).activities?.[0]?.state).toBe(`Dashboard: ${fits}`);
    expect(dashboardPresence(fits.replace("https://", "https://b"))).toEqual({});
  });

  test("is a fresh object each time, since discord.js writes into the presence it is given", () => {
    const first = dashboardPresence(ORIGIN);
    const second = dashboardPresence(ORIGIN);
    expect(first).not.toBe(second);
    expect(first.activities?.[0]).not.toBe(second.activities?.[0]);
    expect(Object.isFrozen(first)).toBe(false);
  });
});
