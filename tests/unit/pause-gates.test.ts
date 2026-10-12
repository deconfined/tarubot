/**
 * The checks that run before a form opens or a lookup starts, for a person whose use of the
 * feature is paused (2.45.0): /modmail's and /apply's pre-form gates, which have no resolved actor
 * and read the person's pauses themselves, and /claim, which refuses a pause before it asks the
 * Lodestone anything. Everything runs through the real router and the real commands over stand-ins
 * for the database and the Lodestone that count their reads; the same refusals against real
 * PostgreSQL are in tests/integration/modmail.test.ts. Invented IDs; keys from readable phrases.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { InteractionResponseType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { APIEmbed } from "discord.js";
import { applicationKey, modmailKey } from "../../src/application/keys.js";
import { ModMail } from "../../src/application/modmail.js";
import { Service } from "../../src/application/service.js";
import type { BotContext } from "../../src/bot/context.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import applyCommand from "../../src/commands/guests/apply.command.js";
import claimCommand from "../../src/commands/characters/claim.command.js";
import modmailCommand from "../../src/commands/utility/modmail.command.js";
import modmailComponent from "../../src/components/modmail.component.js";
import { pausedFormReply, failureReply } from "../../src/discord/presenters/failure.js";
import type { ReportOptions } from "../../src/domain/failures.js";
import { type Actor, type Pause, pausedFailure } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { readModMailKey } from "../../src/infrastructure/modmail/cipher.js";
import * as t from "../../src/infrastructure/postgres/schema.js";
import { actorOf } from "../fixtures/actors.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { onlyEmbed } from "../fixtures/replies.js";

const GUILD = "100";
const MEMBER_ROLE = "523456789012345801";
const GUEST_ROLE = "523456789012345802";
/** The fixture interaction's member (interactionFixture: userId "400" in guild "100"). */
const PERSON = "400";
const ENDS = new Date("2026-10-20T12:00:00.000Z");
const REASON = "Opening cases without a reason";
const MANAGER_BITS = PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles;

type Row = Readonly<Record<string, unknown>>;

/**
 * A stand-in for the Drizzle client the gates read through: each `select().from(table)` answers
 * with the rows `answer` gives for that table (it may throw), and every table read is recorded.
 * `.leftJoin()` and `.where()` are accepted and ignored; the read happens at `.where()`, which the
 * gates' queries all end with.
 */
function stubDatabase(answer: (table: unknown) => readonly Row[] | Promise<readonly Row[]>) {
  const reads: unknown[] = [];
  const where = (table: unknown) => async (): Promise<readonly Row[]> => {
    reads.push(table);
    return answer(table);
  };
  const from = (table: unknown) => ({
    leftJoin: () => ({ where: where(table) }),
    where: where(table),
  });
  return {
    reads,
    db: { orm: { select: () => ({ from }) } },
    /** How many times `table` was read. */
    count: (table: unknown) => reads.filter((read) => read === table).length,
  };
}

/** The pause rows activeBlocks maps, as the database returns them. */
const pauseRow = (permission: string, until: Date | null = ENDS, reason = REASON): Row => ({
  permission,
  until,
  reason,
});

/** The recorded response's single embed. */
function embedOf(body: unknown): APIEmbed {
  const data =
    typeof body === "object" && body !== null && "data" in body && body.data ? body.data : body;
  const embeds =
    typeof data === "object" && data !== null && "embeds" in data ? data.embeds : undefined;
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

const fieldValue = (embed: APIEmbed, name: string) =>
  embed.fields?.find((field) => field.name === name)?.value;

/** What the router is given besides the services: no actor, since the gates run without one. */
function gateContext(
  fixture: ReturnType<typeof interactionFixture>,
  services: Services,
  reports: { error: unknown; options: ReportOptions | undefined }[] = [],
): BotContext {
  return {
    client: fixture.client,
    services,
    allowsGuild: () => true,
    isStopping: () => false,
    report: (error: unknown, _operation: string, options?: ReportOptions) =>
      reports.push({ error, options }),
    resolveActor: async () => {
      throw new Error("A pre-form check must not resolve an actor");
    },
  };
}

describe("/modmail's gate for a person whose opening of cases is paused", () => {
  const KEY = readModMailKey(createHash("sha256").update("pause gate test key").digest("base64"));
  /** What the guild-row read, the pause read and the counts read answer, per test. */
  interface World {
    guild?: Row | null;
    pauses?: readonly Row[];
    counts?: Row;
    failPauseRead?: boolean;
  }
  /** A real ModMail over stand-in reads, the router, and the fixture member holding `roles`. */
  function setup(
    world: World = {},
    options: {
      roles?: string[];
      permissions?: bigint;
      appPermissions?: bigint;
      key?: unknown;
    } = {},
  ) {
    const fixture = interactionFixture();
    fixture.member.roles = options.roles ?? [MEMBER_ROLE];
    fixture.member.permissions = String(options.permissions ?? 0n);
    fixture.member.appPermissions = String(options.appPermissions ?? 0n);
    const stub = stubDatabase((table) => {
      if (table === t.guilds)
        return world.guild === null
          ? []
          : [world.guild ?? { member: MEMBER_ROLE, guest: GUEST_ROLE, enabled: true }];
      if (table === t.memberBlocks) {
        if (world.failPauseRead) throw new Error("Injected pause read failure");
        return world.pauses ?? [];
      }
      if (table === t.modmailCases) return [world.counts ?? { open: 0, daily: 0 }];
      throw new Error("The gate read a table it has no reason to");
    });
    const modmail = new ModMail(
      { db: stub.db } as unknown as Service,
      (options.key ?? KEY) as ConstructorParameters<typeof ModMail>[1],
      "https://tarubot.example.org",
      () => false,
      () => {},
    );
    const reports: { error: unknown; options: ReportOptions | undefined }[] = [];
    const router = new InteractionRouter(
      gateContext(fixture, new Services().provide(modmailKey, modmail), reports),
      new Map([[modmailCommand.name, modmailCommand]]),
      new Map([[modmailComponent.prefix, modmailComponent]]),
    );
    return { fixture, stub, reports, run: () => router.handle(fixture.slash("modmail")) };
  }

  test("a paused person gets the Paused for you card and no form, and it is the only acknowledgement", async () => {
    const { fixture, stub, reports, run } = setup({ pauses: [pauseRow("modmail.open")] });
    try {
      await run();
      expect(fixture.requests).toHaveLength(1);
      const [response] = fixture.requests;
      expect(response?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { flags: MessageFlags.Ephemeral },
      });
      const embed = embedOf(response?.body);
      expect(embed.title).toBe("Paused for you");
      expect(embed.description).toBe(
        "Your use of **Opening mod mail cases** here is paused until <t:1792497600:f> (<t:1792497600:R>). Nothing was changed.",
      );
      expect(fieldValue(embed, "Reason")).toBe(REASON);
      // The way out is an officer in the server, not the command that is paused.
      expect(fieldValue(embed, "What you can do")).toBe(
        "Run `/moderate status` to see everything that is paused for you, or ask an officer in the server. Cases you already have stay open on the dashboard.",
      );
      // An expected state: no Code or Ref footer, nothing reported, and no one who set it.
      expect(embed.footer).toBeUndefined();
      expect(reports).toEqual([]);
      expect(JSON.stringify(embed)).not.toContain("/modmail");
      // One pause read, and the limits were never counted.
      expect(stub.count(t.memberBlocks)).toBe(1);
      expect(stub.count(t.modmailCases)).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("an unpaused person's form opens as before, after one pause read", async () => {
    const { fixture, stub, reports, run } = setup({ pauses: [pauseRow("suggest.use")] });
    try {
      await run();
      expect(fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(stub.count(t.memberBlocks)).toBe(1);
      expect(reports).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("a server manager's gate reads no pauses; Manage Server alone is not a manager", async () => {
    const manager = setup({ pauses: [pauseRow("modmail.open")] }, { permissions: MANAGER_BITS });
    try {
      await manager.run();
      expect(manager.fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(manager.stub.count(t.memberBlocks)).toBe(0);
    } finally {
      await manager.fixture.close();
    }
    for (const bits of [
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ManageRoles,
    ] as const) {
      const half = setup({ pauses: [pauseRow("modmail.open")] }, { permissions: bits });
      try {
        await half.run();
        expect(embedOf(half.fixture.requests.at(-1)?.body).title).toBe("Paused for you");
        expect(half.stub.count(t.memberBlocks)).toBe(1);
      } finally {
        await half.fixture.close();
      }
    }
  });

  test("a failing pause read opens the form and reports a warning", async () => {
    const { fixture, reports, run } = setup({
      pauses: [pauseRow("modmail.open")],
      failPauseRead: true,
    });
    try {
      await run();
      expect(fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.error).toMatchObject({ message: "Injected pause read failure" });
      expect(reports[0]?.options).toEqual({ level: "warn", scope: "/modmail" });
    } finally {
      await fixture.close();
    }
  });

  test("the refusals that need no database still come first, and read no pauses", async () => {
    const paused = [pauseRow("modmail.open")];
    const cases = [
      {
        name: "not a member or guest",
        made: setup({ pauses: paused }, { roles: [] }),
        text: "Mod mail is for this server's members and guests.",
      },
      {
        name: "TaruBot is Administrator",
        made: setup({ pauses: paused }, { appPermissions: PermissionFlagsBits.Administrator }),
        text: "Members can't use TaruBot's web pages while it has Administrator",
      },
      {
        name: "no key",
        made: setup({ pauses: paused }, { key: readModMailKey("") }),
        text: "its encryption key isn't set up",
      },
    ];
    for (const { name, made, text } of cases)
      try {
        await made.run();
        const embed = embedOf(made.fixture.requests.at(-1)?.body);
        expect({ name, title: embed.title }).toEqual({ name, title: "Mod mail isn't available" });
        expect(embed.description).toContain(text);
        expect(made.stub.count(t.memberBlocks)).toBe(0);
      } finally {
        await made.fixture.close();
      }
  });

  test("a pause is reported ahead of the switch and the limits", async () => {
    const worlds: readonly World[] = [
      { pauses: [pauseRow("modmail.open")], guild: { member: MEMBER_ROLE, enabled: false } },
      { pauses: [pauseRow("modmail.open")], guild: { member: MEMBER_ROLE, enabled: null } },
      { pauses: [pauseRow("modmail.open")], counts: { open: 3, daily: 5 } },
    ];
    for (const world of worlds) {
      const { fixture, run } = setup(world);
      try {
        await run();
        expect(embedOf(fixture.requests.at(-1)?.body).title).toBe("Paused for you");
      } finally {
        await fixture.close();
      }
    }
    // Without the pause the same worlds give their own reasons.
    const off = setup({ guild: { member: MEMBER_ROLE, enabled: false } });
    const full = setup({ counts: { open: 3, daily: 5 } });
    try {
      await off.run();
      await full.run();
      expect(embedOf(off.fixture.requests.at(-1)?.body).title).toBe("Mod mail isn't available");
      expect(embedOf(full.fixture.requests.at(-1)?.body).title).toBe("No new case right now");
    } finally {
      await off.fixture.close();
      await full.fixture.close();
    }
  });

  test("an end that is not set says an officer lifts it", async () => {
    const { fixture, run } = setup({ pauses: [pauseRow("modmail.open", null)] });
    try {
      await run();
      expect(embedOf(fixture.requests.at(-1)?.body).description).toBe(
        "Your use of **Opening mod mail cases** here is paused until an officer lifts it. Nothing was changed.",
      );
    } finally {
      await fixture.close();
    }
  });
});

describe("/apply's gate for a person whose use of it is paused", () => {
  /** /apply needs the application capability; only its two pre-form reads run here. */
  function setup(
    world: {
      open?: boolean;
      pauses?: readonly Row[];
      failPauseRead?: boolean;
    } = {},
    permissions = 0n,
  ) {
    const fixture = interactionFixture();
    fixture.member.permissions = String(permissions);
    const stub = stubDatabase((table) => {
      if (table !== t.memberBlocks) throw new Error("The gate read a table it has no reason to");
      if (world.failPauseRead) throw new Error("Injected pause read failure");
      return world.pauses ?? [];
    });
    const app: unknown = Object.create(Service.prototype);
    if (!(app instanceof Service)) throw new Error("Invalid application fixture");
    Object.assign(app, { db: stub.db });
    let opened = 0;
    app.guestApplicationsOpen = async () => {
      opened++;
      return world.open ?? true;
    };
    const reports: { error: unknown; options: ReportOptions | undefined }[] = [];
    const router = new InteractionRouter(
      gateContext(fixture, new Services().provide(applicationKey, app), reports),
      new Map([[applyCommand.name, applyCommand]]),
      new Map(),
    );
    return {
      fixture,
      stub,
      reports,
      opened: () => opened,
      run: () => router.handle(fixture.slash()),
    };
  }

  test("a paused person gets the Paused for you card and no form, with no footer", async () => {
    const { fixture, stub, reports, run } = setup({ pauses: [pauseRow("guests.apply")] });
    try {
      await run();
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]?.body).toMatchObject({
        type: InteractionResponseType.ChannelMessageWithSource,
      });
      const embed = embedOf(fixture.requests[0]?.body);
      expect(embed.title).toBe("Paused for you");
      expect(embed.description).toStartWith(
        "Your use of **Guest applications (/apply)** here is paused until <t:1792497600:f>",
      );
      expect(fieldValue(embed, "Reason")).toBe(REASON);
      // Lobby newcomers apply, and they can't use /modmail: the way out is an officer.
      expect(fieldValue(embed, "What you can do")).toBe(
        "Run `/moderate status` to see everything that is paused for you, or ask an officer in the server.",
      );
      expect(embed.footer).toBeUndefined();
      expect(reports).toEqual([]);
      expect(stub.count(t.memberBlocks)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("an unpaused person's form opens, and a pause on another feature changes nothing", async () => {
    const { fixture, stub, run } = setup({ pauses: [pauseRow("suggest.use")] });
    try {
      await run();
      expect(fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(stub.count(t.memberBlocks)).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("a server manager's gate reads no pauses", async () => {
    const { fixture, stub, run } = setup({ pauses: [pauseRow("guests.apply")] }, MANAGER_BITS);
    try {
      await run();
      expect(fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(stub.count(t.memberBlocks)).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("closed applications still read as closed, and read no pauses", async () => {
    const { fixture, stub, run } = setup({ open: false, pauses: [pauseRow("guests.apply")] });
    try {
      await run();
      expect(embedOf(fixture.requests.at(-1)?.body).title).toBe("Guest applications are closed");
      expect(stub.count(t.memberBlocks)).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("a failing pause read opens the form and reports a warning", async () => {
    const { fixture, reports, run } = setup({
      pauses: [pauseRow("guests.apply")],
      failPauseRead: true,
    });
    try {
      await run();
      expect(fixture.requests.map((request) => request.body)).toMatchObject([
        { type: InteractionResponseType.Modal },
      ]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.options).toEqual({ level: "warn", scope: "/apply" });
    } finally {
      await fixture.close();
    }
  });
});

describe("the card a gate shows is the card the submission shows", () => {
  const pauses: readonly [Parameters<typeof pausedFormReply>[0], Pause][] = [
    ["modmail.open", { until: ENDS, reason: REASON }],
    ["guests.apply", { until: null, reason: "Applying again and again" }],
  ];

  test("same title, description and fields; only the Code and Ref footer differs", () => {
    for (const [permission, pause] of pauses) {
      const before = onlyEmbed(pausedFormReply(permission, pause));
      const after = onlyEmbed(
        failureReply(pausedFailure(permission, pause), { ref: "123456789012345678" }),
      );
      expect([before.title, before.description, before.fields, before.color]).toEqual([
        after.title,
        after.description,
        after.fields,
        after.color,
      ]);
      expect(before.footer).toBeUndefined();
      expect(after.footer?.text).toBe("Code forbidden · Ref 123456789012345678");
    }
  });
});

describe("/claim refuses a pause before it asks the Lodestone anything", () => {
  /** The calls the paused or unpaused /claim made, counted at the seams that cost a request. */
  function setup(paused: boolean) {
    const fixture = interactionFixture();
    const calls = { guild: 0, roster: 0, profile: 0, search: 0, claim: 0 };
    const app: unknown = Object.create(Service.prototype);
    if (!(app instanceof Service)) throw new Error("Invalid application fixture");
    Object.assign(app, {
      guild: async () => {
        calls.guild++;
        return {};
      },
      // Not on the FC roster, so a lookup would go to the Lodestone.
      rosterCharacter: async () => {
        calls.roster++;
        return undefined;
      },
      lodestone: {
        profile: async () => {
          calls.profile++;
          throw new Failure("unavailable", "The Lodestone fixture stops here.");
        },
        search: async () => {
          calls.search++;
          throw new Failure("unavailable", "The Lodestone fixture stops here.");
        },
      },
      claim: async () => {
        calls.claim++;
        throw new Failure("unavailable", "The claim fixture stops here.");
      },
    });
    const actor: Actor = actorOf({
      guildId: GUILD,
      userId: PERSON,
      manageRoles: false,
      member: true,
      ...(paused && {
        paused: {
          "characters.claim": { until: ENDS, reason: "Claiming characters that aren't yours" },
        },
      }),
    });
    const router = new InteractionRouter(
      {
        ...gateContext(fixture, new Services().provide(applicationKey, app)),
        resolveActor: async () => actor,
      },
      new Map([[claimCommand.name, claimCommand]]),
      new Map(),
    );
    const byId = [{ type: 3, name: "character", value: "99000001" }];
    const byName = [
      { type: 3, name: "forename", value: "Example" },
      { type: 3, name: "surname", value: "Character" },
      { type: 3, name: "world", value: "Diabolos" },
    ];
    return {
      fixture,
      calls,
      byId: () => router.handle(fixture.slash("claim", byId)),
      byName: () => router.handle(fixture.slash("claim", byName)),
    };
  }

  test("a paused member's claim, by ID or by name, makes no roster or Lodestone request", async () => {
    for (const how of ["byId", "byName"] as const) {
      const { fixture, calls, ...run } = setup(true);
      try {
        await run[how]();
        expect(calls).toEqual({ guild: 1, roster: 0, profile: 0, search: 0, claim: 0 });
        const embed = embedOf(fixture.requests.at(-1)?.body);
        expect(embed.title).toBe("Paused for you");
        expect(embed.description).toStartWith(
          "Your use of **Linking characters (/claim and /verify)** here is paused until",
        );
        expect(fieldValue(embed, "Reason")).toBe("Claiming characters that aren't yours");
        // A real refusal, so it carries the failure footer a feature's refusals do.
        expect(embed.footer?.text).toStartWith("Code forbidden · Ref ");
      } finally {
        await fixture.close();
      }
    }
  });

  test("the same claim from an unpaused member still reaches the Lodestone", async () => {
    const byId = setup(false);
    try {
      await byId.byId();
      expect(byId.calls).toEqual({ guild: 1, roster: 1, profile: 1, search: 0, claim: 0 });
      expect(embedOf(byId.fixture.requests.at(-1)?.body).title).not.toBe("Paused for you");
    } finally {
      await byId.fixture.close();
    }
    const byName = setup(false);
    try {
      await byName.byName();
      expect(byName.calls).toEqual({ guild: 1, roster: 1, profile: 0, search: 1, claim: 0 });
      expect(embedOf(byName.fixture.requests.at(-1)?.body).title).not.toBe("Paused for you");
    } finally {
      await byName.fixture.close();
    }
  });
});
