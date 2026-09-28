/**
 * Router replies through real discord.js interactions and a local REST recorder: every failure is
 * one approved card with 'Code · Ref', reported once at its category's level; update-mode clicks
 * edit only messages the presser owns; and nothing the router sends can reject handle().
 */
import { expect, spyOn, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  DiscordjsError,
  DiscordjsErrorCodes,
  GatewayOpcodes,
  GatewayRateLimitError,
  InteractionResponseType,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { APIEmbed } from "discord.js";
import { defineCommand } from "../../src/bot/command.js";
import { Component, defineComponent, type ComponentOptions } from "../../src/bot/component.js";
import type { BotContext } from "../../src/bot/context.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { dataReply, reply, type Presented } from "../../src/discord/presenters/reply.js";
import type { ReportOptions } from "../../src/domain/failures.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { interactionFixture, type RecordedRequest } from "../fixtures/interactions.js";
import { discordError } from "../fixtures/replies/failures.js";
import { CHARACTER, at } from "../fixtures/results.js";

/** One report() call. */
interface Report {
  readonly error: unknown;
  readonly operation: string;
  readonly options: ReportOptions | undefined;
}

/** Actors the fixture member can resolve as. */
const MEMBER: Actor = { guildId: "100", userId: "400", officer: false, manageRoles: false };
const OFFICER: Actor = { ...MEMBER, officer: true };

/** The failure a command or component throws next; tests set it per case. */
let next: unknown = new Error("unset");

/** A slash command that throws `next`. */
const failing = defineCommand({
  data: new SlashCommandBuilder().setName("boom").setDescription("Failing fixture"),
  execute() {
    throw next;
  },
});

/** A /config command that throws `next`, so a failure is scoped '/config roles officer'. */
const configuring = defineCommand({
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Config fixture")
    .addSubcommandGroup((group) =>
      group
        .setName("roles")
        .setDescription("Roles fixture")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("officer")
            .setDescription("Officer fixture")
            .addBooleanOption((option) =>
              option.setName("unset_role").setDescription("Unset fixture"),
            ),
        ),
    ),
  execute() {
    executions++;
    throw next;
  },
});

/** A /setup onboarding with a confirm option that throws `next` (2.35.0's dry-run default). */
const settingUp = defineCommand({
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Setup fixture")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("onboarding")
        .setDescription("Onboarding fixture")
        .addBooleanOption((option) => option.setName("confirm").setDescription("Confirm fixture")),
    ),
  execute() {
    throw next;
  },
});

/** A slash command whose autocomplete suggests one choice. */
const suggesting = defineCommand({
  data: new SlashCommandBuilder()
    .setName("suggest")
    .setDescription("Autocomplete fixture")
    .addStringOption((option) =>
      option.setName("query").setDescription("Query fixture").setAutocomplete(true),
    ),
  autocomplete: () => [{ name: "Example", value: "1" }],
  execute: () => reply({ tone: "info", title: "Suggested" }),
});

/** A slash command that succeeds with a presenter reply. */
const working = defineCommand({
  data: new SlashCommandBuilder().setName("fine").setDescription("Working fixture"),
  execute: () => reply({ tone: "info", title: "Fine" }),
});

/**
 * A discovered module compiled without the type check, still returning pre-2.14.0 edit options:
 * the cast stands in for untyped JavaScript. The router must never send them.
 */
const legacy = defineCommand({
  data: new SlashCommandBuilder().setName("legacy").setDescription("Legacy fixture"),
  execute: () => ({ content: '```json\n{"secret":1}\n```' }) as unknown as Presented,
});

/** Counts executions of the officer-only component. */
let executions = 0;

/** Component fixtures: an officer-only button, update-mode pages, a throwing chooser, details. */
const components: readonly Component[] = [
  defineComponent({
    prefix: "secure",
    access: "officer",
    execute: () => {
      executions++;
      return reply({ tone: "info", title: "Secret" });
    },
  }),
  defineComponent({
    prefix: "page",
    acknowledge: (customId) => (customId === "page:new" ? "reply" : "update"),
    execute: ({ interaction }) => {
      if (interaction.customId === "page:fail") throw next;
      return reply({ tone: "info", title: "Page 2" });
    },
  }),
  defineComponent({
    prefix: "chooser",
    acknowledge: () => {
      throw new Error("Malformed ID");
    },
    execute: () => reply({ tone: "info", title: "Chosen" }),
  }),
  defineComponent({
    prefix: "plain",
    execute: () => reply({ tone: "info", title: "Plain" }),
  }),
  defineComponent({
    prefix: "details",
    access: "officer",
    execute: ({ viewer }) => dataReply(viewer, "sample", { amount: 10005000n }),
  }),
];

/** A router over the fixtures, recording reports; overrides adjust the context per case. */
function harness(overrides: Partial<BotContext> = {}, actor: Actor = MEMBER) {
  const fixture = interactionFixture();
  const reports: Report[] = [];
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services(),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: (error, operation, options) => reports.push({ error, operation, options }),
      ...overrides,
    },
    new Map([
      [failing.name, failing],
      [configuring.name, configuring],
      [working.name, working],
      [legacy.name, legacy],
      [suggesting.name, suggesting],
      [settingUp.name, settingUp],
    ]),
    new Map(components.map((component) => [component.prefix, component])),
  );
  return { fixture, reports, router };
}

/** The one embed a recorded body carries (a callback's data, a follow-up or an edit). */
function embedOf(request: RecordedRequest | undefined): APIEmbed {
  const body = request?.body;
  const data =
    typeof body === "object" && body !== null && "data" in body && body.data ? body.data : body;
  const embeds =
    typeof data === "object" && data !== null && "embeds" in data ? data.embeds : undefined;
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

/** The interaction callback type a recorded acknowledgement used. */
const callbackType = (request: RecordedRequest | undefined): unknown =>
  typeof request?.body === "object" && request.body !== null && "type" in request.body
    ? request.body.type
    : undefined;

test("DMs, bots and restricted guilds get one member-safe ephemeral card, reported at info", async () => {
  for (const [kind, title] of [
    ["dm", "Not available here"],
    ["bot", "Not available here"],
    ["restricted", "Test instance"],
  ] as const) {
    const { fixture, reports, router } = harness(
      { allowsGuild: () => kind !== "restricted" },
      OFFICER,
    );
    try {
      fixture.member.guildId = kind === "dm" ? "" : "100";
      fixture.member.bot = kind === "bot";
      const interaction = fixture.slash("boom");
      await router.handle(interaction);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral, content: "", allowed_mentions: { parse: [] } },
      });
      expect(embedOf(fixture.requests[0])).toMatchObject({
        title,
        footer: { text: `Code forbidden · Ref ${interaction.id}` },
      });
      expect(reports).toEqual([
        {
          error: expect.any(Failure),
          operation: interaction.id,
          options: { level: "info", scope: "/boom" },
        },
      ]);
    } finally {
      await fixture.close();
    }
  }
});

test("unknown commands and custom-ID prefixes are out-of-date controls", async () => {
  const { fixture, reports, router } = harness();
  try {
    for (const interaction of [fixture.slash("retired"), fixture.button("retired:action")]) {
      await router.handle(interaction);
      expect(callbackType(fixture.requests.at(-1))).toBe(
        InteractionResponseType.ChannelMessageWithSource,
      );
      expect(embedOf(fixture.requests.at(-1))).toMatchObject({
        title: "This control is out of date",
        footer: { text: `Code stale · Ref ${interaction.id}` },
      });
    }
    expect(reports.map((report) => report.options)).toEqual([
      { level: "info", scope: "/retired" },
      { level: "info", scope: "button retired" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("a member pressing an officer button gets 'Officers only' and the handler never runs", async () => {
  const { fixture, router } = harness();
  try {
    executions = 0;
    const press = fixture.button("secure:open", "123456789", { ephemeral: true });
    await router.handle(press);
    expect(executions).toBe(0);
    expect(embedOf(fixture.requests.at(-1))).toMatchObject({
      title: "Officers only",
      description: "Only FC officers can use this button. Nothing was changed.",
      footer: { text: `Code forbidden · Ref ${press.id}` },
    });
  } finally {
    await fixture.close();
  }
});

test("an unexpected error shows no text of its own and is reported at error", async () => {
  const { fixture, reports, router } = harness();
  try {
    next = new Error("boom secret postgres://user:hunter2@db");
    const interaction = fixture.slash("boom");
    await router.handle(interaction);
    expect(fixture.requests.map((request) => request.method)).toEqual(["post", "patch"]);
    // discord.js percent-encodes the @original message reference in the webhook route.
    expect(fixture.requests[1]?.route).toEndWith("/messages/%40original");
    expect(embedOf(fixture.requests[1])).toMatchObject({
      title: "Something went wrong",
      footer: { text: `Code unexpected · Ref ${interaction.id}` },
    });
    expect(JSON.stringify(fixture.requests)).not.toMatch(/secret|hunter2|postgres/u);
    expect(reports).toEqual([
      { error: next, operation: interaction.id, options: { level: "error", scope: "/boom" } },
    ]);
  } finally {
    await fixture.close();
  }
});

test("the resolved actor decides officer or member wording for the same failure", async () => {
  next = new Failure("blocked", "TaruBot can't manage <@&223456789012345602>.", 0, {
    kind: "resource",
    resource: "role",
    id: "223456789012345602",
  });
  for (const [actor, title] of [
    [MEMBER, "Server setup issue"],
    [OFFICER, "Discord permissions need attention"],
  ] as const) {
    const { fixture, reports, router } = harness({}, actor);
    try {
      await router.handle(fixture.slash("boom"));
      expect(embedOf(fixture.requests.at(-1)).title).toBe(title);
      expect(reports[0]?.options).toEqual({ level: "warn", scope: "/boom" });
    } finally {
      await fixture.close();
    }
  }
});

test("only /setup onboarding confirm:true promises reuse; its dry run says nothing was changed", async () => {
  next = new Failure("input", "Bad prefix.");
  const run = (confirm: boolean | null) => [
    {
      type: ApplicationCommandOptionType.Subcommand,
      name: "onboarding",
      options:
        confirm === null
          ? []
          : [{ type: ApplicationCommandOptionType.Boolean, name: "confirm", value: confirm }],
    },
  ];
  for (const [confirm, sentence] of [
    [true, "Anything already created is reused when you run /setup onboarding confirm:true again."],
    [false, "Nothing was changed."],
    [null, "Nothing was changed."],
  ] as const) {
    const { fixture, reports, router } = harness({}, OFFICER);
    try {
      await router.handle(fixture.slash("setup", run(confirm)));
      expect(embedOf(fixture.requests.at(-1)).description).toBe(`Bad prefix. ${sentence}`);
      // The option's value never reaches the report's scope.
      expect(reports[0]?.options).toEqual({ level: "info", scope: "/setup onboarding" });
    } finally {
      await fixture.close();
    }
  }
});

test("raw Discord errors in interactions are classified, presented and reported (C8)", async () => {
  const cases = [
    [discordError(50013, 403), "Discord permissions need attention", "warn", "blocked"],
    [discordError(50001, 403), "Discord permissions need attention", "warn", "blocked"],
    [discordError(10003, 404), "Discord permissions need attention", "warn", "blocked"],
    [discordError(10011, 404), "Discord permissions need attention", "warn", "blocked"],
    [discordError(10007, 404), "Not available here", "info", "forbidden"],
    [discordError(10013, 404), "Not available here", "info", "forbidden"],
    [discordError(0, 429), "Discord isn't responding", "warn", "unavailable"],
    [discordError(0, 503), "Discord isn't responding", "warn", "unavailable"],
  ] as const;
  for (const [error, title, level, code] of cases) {
    const { fixture, reports, router } = harness({}, OFFICER);
    try {
      next = error;
      const interaction = fixture.slash("boom");
      await router.handle(interaction);
      expect(embedOf(fixture.requests.at(-1))).toMatchObject({
        title,
        footer: { text: `Code ${code} · Ref ${interaction.id}` },
      });
      expect(JSON.stringify(fixture.requests)).not.toContain("Raw Discord text");
      expect(reports.map((report) => report.options?.level)).toEqual([level]);
    } finally {
      await fixture.close();
    }
  }
  // A member who left between the click and the actor lookup gets the member-safe card.
  const { fixture, router } = harness({
    resolveActor: async () => {
      throw discordError(10007, 404);
    },
  });
  try {
    await router.handle(fixture.slash("fine"));
    expect(embedOf(fixture.requests.at(-1)).title).toBe("Not available here");
  } finally {
    await fixture.close();
  }
});

test("a member list Discord won't return (rate limit, timeout) is the member-list card at warn", async () => {
  // discord.js 14.27 rejects a full member request with GatewayRateLimitError when Discord
  // answers RATE_LIMITED, and with GuildMembersTimeout when chunks stop arriving.
  const limited = new GatewayRateLimitError(
    {
      opcode: GatewayOpcodes.RequestGuildMembers,
      retry_after: 29.5,
      meta: { guild_id: "100", nonce: "fixture" },
    },
    {},
  );
  const timeout: unknown = Reflect.construct(DiscordjsError, [
    DiscordjsErrorCodes.GuildMembersTimeout,
  ]);
  for (const raised of [limited, timeout]) {
    const gateway = new DiscordGateway();
    let fetches = 0;
    const guild = {
      id: "100",
      memberCount: 3,
      members: {
        fetch: async () => {
          fetches++;
          throw raised;
        },
      },
    };
    spyOn(gateway.client.guilds, "fetch").mockImplementation(async () => guild as never);
    // The gateway stops at the first refusal instead of re-requesting into another rate limit.
    next = await gateway.members("100").then(
      () => new Error("Expected members() to fail"),
      (error: unknown) => error,
    );
    expect(fetches).toBe(1);
    await gateway.client.destroy();
    const { fixture, reports, router } = harness({}, OFFICER);
    try {
      const interaction = fixture.slash("config", [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: "roles",
          options: [
            { type: ApplicationCommandOptionType.Subcommand, name: "officer", options: [] },
          ],
        },
      ]);
      await router.handle(interaction);
      const embed = embedOf(fixture.requests.at(-1));
      expect(embed).toMatchObject({
        title: "Couldn't read the member list",
        footer: { text: `Code incomplete · Ref ${interaction.id}` },
      });
      expect(embed.fields?.map((item) => item.name)).toContain("Tip");
      expect(reports.map((report) => report.options)).toEqual([
        { level: "warn", scope: "/config roles officer" },
      ]);
    } finally {
      await fixture.close();
    }
  }
});

test("an expired interaction is reported at warn and never answered twice", async () => {
  const { fixture, reports, router } = harness();
  try {
    fixture.failNext("post", discordError(10062, 404));
    const interaction = fixture.slash("fine");
    await router.handle(interaction);
    expect(fixture.requests).toHaveLength(0);
    expect(reports).toEqual([
      {
        error: expect.anything(),
        operation: interaction.id,
        options: { level: "warn", scope: "/fine" },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("an autocomplete that can no longer be answered is reported at warn, without a fallback", async () => {
  // Autocomplete can't be deferred, so a late respond() hits Discord's Unknown Interaction.
  const { fixture, reports, router } = harness();
  try {
    fixture.failNext("post", discordError(10062, 404));
    const interaction = fixture.autocomplete("suggest");
    await router.handle(interaction);
    expect(fixture.requests).toHaveLength(0);
    expect(reports).toEqual([
      {
        error: expect.anything(),
        operation: interaction.id,
        options: { level: "warn", scope: "autocomplete /suggest" },
      },
    ]);
  } finally {
    await fixture.close();
  }
});

test("a failure while sending the failure card is reported at warn and swallowed", async () => {
  const { fixture, reports, router } = harness();
  try {
    next = new Failure("input", "Bad value.");
    fixture.failNext("patch", discordError(0, 500));
    const interaction = fixture.slash("boom");
    await router.handle(interaction);
    expect(reports.map((report) => report.options)).toEqual([
      { level: "info", scope: "/boom" },
      { level: "warn", scope: "/boom" },
    ]);
  } finally {
    await fixture.close();
  }
});

test("a failure after execute says the request may have been saved", async () => {
  const { fixture, router } = harness();
  try {
    fixture.failNext("patch", new Error("socket hang up"));
    const interaction = fixture.slash("fine");
    await router.handle(interaction);
    expect(embedOf(fixture.requests.at(-1))).toMatchObject({
      title: "Something went wrong",
      description: "Your request may have been saved, but TaruBot couldn't show the result.",
    });
  } finally {
    await fixture.close();
  }
});

test("a handler result that is not a presenter reply is never sent", async () => {
  const { fixture, reports, router } = harness();
  try {
    const interaction = fixture.slash("legacy");
    await router.handle(interaction);
    // The work ran, so the card says it may have been saved; the legacy text never leaves.
    expect(embedOf(fixture.requests.at(-1))).toMatchObject({
      title: "Something went wrong",
      description: "Your request may have been saved, but TaruBot couldn't show the result.",
      footer: { text: `Code unexpected · Ref ${interaction.id}` },
    });
    expect(JSON.stringify(fixture.requests)).not.toMatch(/secret|```json/u);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.options).toEqual({ level: "error", scope: "/legacy" });
  } finally {
    await fixture.close();
  }
});

test("the observed test guild sees failures publicly; other guilds keep them ephemeral", async () => {
  for (const publicGuild of ["100", "999"]) {
    const { fixture, router } = harness({ publicResponseGuildId: publicGuild });
    try {
      next = new Failure("input", "Bad value.");
      await router.handle(fixture.slash("boom"));
      await router.handle(fixture.slash("retired"));
      const flags = publicGuild === "100" ? 0 : MessageFlags.Ephemeral;
      expect(fixture.requests[0]?.body).toMatchObject({
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags },
      });
      expect(fixture.requests.at(-1)?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { flags: flags || undefined },
      });
    } finally {
      await fixture.close();
    }
  }
});

test("an ephemeral source updates in place, fully replacing the previous view", async () => {
  const { fixture, router } = harness();
  try {
    await router.handle(fixture.button("page:2", "123456789", { ephemeral: true }));
    expect(callbackType(fixture.requests[0])).toBe(InteractionResponseType.DeferredMessageUpdate);
    // The update carries no visibility of its own: an edit can't change it.
    expect(fixture.requests[0]?.body).not.toHaveProperty("data");
    expect(fixture.requests[1]).toMatchObject({
      method: "patch",
      route: expect.stringMatching(/\/messages\/%40original$/u),
      body: {
        content: "",
        components: [],
        attachments: [],
        embeds: [{ title: "Page 2" }],
        allowed_mentions: { parse: [] },
      },
    });
    expect(fixture.requests[1]?.body).toMatchObject({ flags: undefined });
  } finally {
    await fixture.close();
  }
});

test("only the presser's own public message updates; others and channel posts get a new reply", async () => {
  const { fixture, router } = harness({ publicResponseGuildId: "100" });
  try {
    await router.handle(fixture.button("page:2", "1", { ownerId: "400" }));
    expect(callbackType(fixture.requests.at(-2))).toBe(
      InteractionResponseType.DeferredMessageUpdate,
    );
    for (const source of [{ ownerId: "401" }, {}]) {
      const before = fixture.requests.length;
      await router.handle(fixture.button("page:2", "2", source));
      const sent = fixture.requests.slice(before);
      expect(callbackType(sent[0])).toBe(InteractionResponseType.DeferredChannelMessageWithSource);
      // The new reply is the interaction's own response; the source message is never edited.
      expect(sent.every((request) => callbackType(request) !== 6)).toBe(true);
    }
  } finally {
    await fixture.close();
  }
});

test("update-mode failures follow up and keep the source; the pending card edits in place", async () => {
  const { fixture, router } = harness();
  try {
    next = new Failure("input", "Bad page.");
    const press = fixture.button("page:fail", "123456789", { ephemeral: true });
    await router.handle(press);
    expect(fixture.requests.map((request) => request.method)).toEqual(["post", "post"]);
    expect(fixture.requests[1]).toMatchObject({
      route: expect.stringMatching(/^\/webhooks\/900\/fixture-interaction-token$/u),
      body: { flags: MessageFlags.Ephemeral },
    });
    expect(embedOf(fixture.requests[1])).toMatchObject({
      title: "Check your input",
      footer: { text: `Code input · Ref ${press.id}` },
    });
    // Check again re-renders the same screen, so its pending card replaces the source.
    next = new Failure("pending_proof", "Not yet.", 0, {
      kind: "proof",
      character: CHARACTER,
      expiresAt: at(600),
    });
    const before = fixture.requests.length;
    await router.handle(fixture.button("page:fail", "123456789", { ephemeral: true }));
    const sent = fixture.requests.slice(before);
    expect(sent.map((request) => request.method)).toEqual(["post", "patch"]);
    expect(sent[1]?.body).toMatchObject({
      content: "",
      attachments: [],
      embeds: [{ title: "Token not on the Lodestone yet" }],
      components: [{ components: [{ custom_id: "verify:again:12345678" }] }],
    });
  } finally {
    await fixture.close();
  }
});

test("a throwing acknowledge choice and default components reply with a new message", async () => {
  const { fixture, router } = harness();
  try {
    for (const customId of ["chooser:x", "plain:x", "page:new"]) {
      const before = fixture.requests.length;
      await router.handle(fixture.button(customId, "123456789", { ephemeral: true }));
      expect(callbackType(fixture.requests[before])).toBe(
        InteractionResponseType.DeferredChannelMessageWithSource,
      );
    }
  } finally {
    await fixture.close();
  }
});

test("the component constructor rejects an invalid acknowledge option", () => {
  const base = { prefix: "bad", execute: () => reply({ tone: "info", title: "Bad" }) };
  for (const acknowledge of ["sometimes", 42, async () => "update" as const])
    expect(() =>
      Reflect.construct(Component, [{ ...base, acknowledge } as unknown as ComponentOptions]),
    ).toThrow(
      "A component's acknowledge option must be 'reply', 'update' or a synchronous function.",
    );
  expect(defineComponent(base).acknowledge).toBe("reply");
  expect(defineComponent({ ...base, acknowledge: "update" }).acknowledge).toBe("update");
});

test("officer details arrive as a JSON attachment in a new reply", async () => {
  const { fixture, router } = harness({}, OFFICER);
  try {
    await router.handle(fixture.button("details:sample", "123456789", { ephemeral: true }));
    expect(callbackType(fixture.requests[0])).toBe(
      InteractionResponseType.DeferredChannelMessageWithSource,
    );
    expect(fixture.requests[1]).toMatchObject({
      method: "patch",
      files: ["tarubot-sample.json"],
      body: { embeds: [{ title: "Full details · sample" }] },
    });
  } finally {
    await fixture.close();
  }
});

test("a subcommand or option this release doesn't declare gets the stale card, never the handler", async () => {
  // Another release's registration can deliver shapes this one doesn't define; handlers that read
  // them would guess (the pre-2.16 /officer handler treated any other subcommand as a revoke).
  for (const [label, options] of [
    [
      "an undeclared subcommand",
      [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: "roles",
          options: [{ type: ApplicationCommandOptionType.Subcommand, name: "leader", options: [] }],
        },
      ],
    ],
    [
      "an undeclared option",
      [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: "roles",
          options: [
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "officer",
              options: [{ type: ApplicationCommandOptionType.Boolean, name: "clear", value: true }],
            },
          ],
        },
      ],
    ],
    [
      "an option with another type",
      [
        {
          type: ApplicationCommandOptionType.SubcommandGroup,
          name: "roles",
          options: [
            {
              type: ApplicationCommandOptionType.Subcommand,
              name: "officer",
              options: [
                { type: ApplicationCommandOptionType.String, name: "unset_role", value: "x" },
              ],
            },
          ],
        },
      ],
    ],
    ["a missing subcommand", []],
  ] as const) {
    const { fixture, reports, router } = harness({}, OFFICER);
    try {
      executions = 0;
      const interaction = fixture.slash("config", [...options]);
      await router.handle(interaction);
      expect(executions, label).toBe(0);
      expect(embedOf(fixture.requests.at(-1)), label).toMatchObject({
        title: "This control is out of date",
        footer: { text: `Code stale · Ref ${interaction.id}` },
      });
      expect(reports.map((report) => report.options?.level)).toEqual(["info"]);
    } finally {
      await fixture.close();
    }
  }
});

test("autocomplete for an option this release doesn't declare suggests nothing", async () => {
  const { fixture, router } = harness();
  try {
    await router.handle(fixture.autocomplete("suggest", "other"));
    expect(fixture.requests.at(-1)?.body).toMatchObject({ data: { choices: [] } });
    await router.handle(fixture.autocomplete("suggest"));
    expect(fixture.requests.at(-1)?.body).toMatchObject({
      data: { choices: [{ name: "Example", value: "1" }] },
    });
  } finally {
    await fixture.close();
  }
});
