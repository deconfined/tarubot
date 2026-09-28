/**
 * Character, ledger, guest, synchronization, utility and configuration commands end to end at the
 * module boundary: the real option resolver parses raw payloads, prototype-backed Service and
 * RoleAdministration stubs return catalog results, and each command returns its presenter's single
 * embed (no flags: the router owns visibility; content only for the /claim token). Through the
 * router, an ownership conflict shows its current owner to an officer on /assign and to no member
 * (owner decision O3), and malformed ledger options and /config's exactly-one checks are input
 * failures that never reach the service. Together the path tables reach every registered command
 * path but /apply's form and /version, and every command keeps its private default visibility.
 */
import { afterEach, expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import type { APIEmbed } from "discord.js";
import {
  applicationKey,
  issueReportsKey,
  roleAdministrationKey,
  suggestionsKey,
  synchronizationKey,
} from "../../src/application/keys.js";
import { RoleAdministration } from "../../src/application/role-administration.js";
import { Service } from "../../src/application/service.js";
import { Synchronization } from "../../src/application/synchronization.js";
import type { Command } from "../../src/bot/command.js";
import { loadCommands } from "../../src/bot/discovery.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import assignCommand from "../../src/commands/characters/assign.command.js";
import configCommand from "../../src/commands/configuration/config.command.js";
import officerCommand from "../../src/commands/configuration/officer.command.js";
import setupCommand from "../../src/commands/configuration/setup.command.js";
import charactersCommand from "../../src/commands/characters/characters.command.js";
import claimCommand from "../../src/commands/characters/claim.command.js";
import mainCommand from "../../src/commands/characters/main.command.js";
import nicknameCommand from "../../src/commands/characters/nickname.command.js";
import unassignCommand from "../../src/commands/characters/unassign.command.js";
import unclaimCommand from "../../src/commands/characters/unclaim.command.js";
import verifyCommand from "../../src/commands/characters/verify.command.js";
import guestCommand from "../../src/commands/guests/guest.command.js";
import ledgerCommand from "../../src/commands/ledger/ledger.command.js";
import refreshCommand from "../../src/commands/synchronization/refresh.command.js";
import syncCommand from "../../src/commands/synchronization/sync.command.js";
import channelCommand from "../../src/commands/utility/channel.command.js";
import { IssueReports } from "../../src/application/issue-reports.js";
import issueCommand from "../../src/commands/utility/issue.command.js";
import { Suggestions } from "../../src/application/suggestions.js";
import suggestCommand from "../../src/commands/utility/suggest.command.js";
import pingCommand from "../../src/commands/utility/ping.command.js";
import { viewerOf } from "../../src/discord/presenters/audience.js";
import { Presented } from "../../src/discord/presenters/reply.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { interactionFixture, type RecordedRequest } from "../fixtures/interactions.js";
import { CHARACTER_RESULTS as R, TARGET_ID, TOKEN } from "../fixtures/replies/characters.js";
import {
  CHANNEL,
  CONFIG_FC,
  applications,
  CONFIG_RESULTS as C,
  configChange,
  OVERRIDE_USER,
  officerReset,
  override,
  ROLE,
} from "../fixtures/replies/configuration.js";
import {
  ACTION_RESULTS as GA,
  APPLICATION_ID,
  decision,
  GUEST_RESULTS as G,
  guestReset,
} from "../fixtures/replies/guests.js";
import { ENTRY_IDS, LEDGER_RESULTS as L } from "../fixtures/replies/ledger.js";
import { OVERRIDES_RESULTS, SETUP_PLANS } from "../fixtures/replies/setup.js";
import { refreshed, RUN_ID, SYNC_RESULTS as SR } from "../fixtures/replies/sync-utility.js";
import { CHARACTER, GUEST_ID } from "../fixtures/results.js";

/** The fixture's interaction user (400 in guild 100), as a member and as a server manager. */
const MEMBER: Actor = { guildId: "100", userId: "400", officer: false, manageRoles: false };
const MANAGER: Actor = { ...MEMBER, officer: true, manageRoles: true, serverManager: true };
/** The first interaction ID a fresh fixture assigns: /ledger's idempotency key. */
const INTERACTION_ID = "10001";

/** The Lodestone profile the stubbed adapter returns for any character selector. */
const IDENTITY = { ...CHARACTER, dc: "Crystal", fcId: null };

const S = ApplicationCommandOptionType;
/** A raw string option payload. */
const text = (name: string, value: string) => ({ type: S.String, name, value });
/** A raw subcommand payload with its options. */
const subcommand = (name: string, options: unknown[] = []) => ({
  type: S.Subcommand,
  name,
  options,
});

/** One recorded service call: the method, the actor's user ID and the remaining arguments. */
type Call = [string, string, ...unknown[]];

/**
 * A prototype-backed Service whose methods return `results[method]` (or throw it when it is an
 * Error), recording every call; the Lodestone profile lookup returns IDENTITY.
 */
function stubService(results: Readonly<Record<string, unknown>>) {
  const calls: Call[] = [];
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fixture");
  for (const method of [
    "guild",
    "claim",
    "verify",
    "unclaim",
    "characters",
    "preferences",
    "assign",
    "ledger",
    "ledgerRead",
    "guestStatus",
    "guestAction",
    "decide",
    "syncStatus",
    "validate",
    "configure",
    "unlinkCompany",
    "configureOfficerRank",
    "configureRoleLayout",
    "configureGuestApplications",
    "guestReset",
  ] as const)
    Object.assign(app, {
      [method]: async (actor: Actor, ...args: unknown[]) => {
        calls.push([method, actor.userId, ...args]);
        const result = results[method] ?? {};
        if (result instanceof Error) throw result;
        return result;
      },
    });
  // /setup reads the test-guild setting for its default role prefix.
  Object.assign(app, {
    lodestone: { profile: async () => IDENTITY },
    config: { TEST_GUILD_ID: undefined },
  });
  return { app, calls };
}

/** The fixture of the test being run, closed after each test. */
let open: ReturnType<typeof interactionFixture> | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

/**
 * A prototype-backed Synchronization whose refresh returns `result` (or throws it when it is an
 * Error), recording each call in `calls` as the Service stub does.
 */
function stubSynchronization(result: unknown, calls: Call[]): Synchronization {
  const sync: unknown = Object.create(Synchronization.prototype);
  if (!(sync instanceof Synchronization)) throw new Error("Invalid synchronization fixture");
  Object.assign(sync, {
    refresh: async (actor: Actor, force: boolean) => {
      calls.push(["refresh", actor.userId, force]);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return sync;
}

/** Run a command's execute directly with the stub services and the actor's viewer. */
async function run(
  command: Command,
  options: unknown[],
  actor: Actor,
  app: Service,
  sync: Synchronization = stubSynchronization(refreshed(), []),
) {
  // One fixture at a time: the previous path's client is closed first.
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  return command.execute?.({
    client: fixture.client,
    services: new Services().provide(applicationKey, app).provide(synchronizationKey, sync),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => actor,
    actor,
    viewer: viewerOf(actor, "1290000000000000001"),
    interaction: fixture.slash(command.name, options),
  });
}

/** Each character command path: its options, actor, stubbed result, expected title and call. */
const PATHS: readonly {
  readonly command: Command;
  readonly options: unknown[];
  readonly actor: Actor;
  readonly results: Record<string, unknown>;
  readonly title: string;
  readonly call: Call;
  readonly content?: string;
}[] = [
  {
    command: claimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { claim: R.claimPending },
    title: "Verify Example Character @ Diabolos",
    call: ["claim", "400", IDENTITY],
    content: `\`\`\`\n${TOKEN}\n\`\`\``,
  },
  {
    command: claimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { claim: R.claimLinked },
    title: "Already linked to you",
    call: ["claim", "400", IDENTITY],
  },
  {
    command: verifyCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { verify: R.verified },
    title: "Example Character is verified",
    call: ["verify", "400", "12345678"],
  },
  {
    command: verifyCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { verify: R.alreadyVerified },
    title: "Already verified",
    call: ["verify", "400", "12345678"],
  },
  {
    command: unclaimCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { unclaim: R.unclaimed },
    title: "Example Character unlinked",
    call: ["unclaim", "400", "400", "12345678"],
  },
  {
    command: charactersCommand,
    options: [],
    actor: MEMBER,
    results: { characters: R.selfList },
    title: "Your characters",
    call: ["characters", "400", "400"],
  },
  {
    // An officer's own record without the member option stays the personal view.
    command: charactersCommand,
    options: [],
    actor: MANAGER,
    results: { characters: R.selfList },
    title: "Your characters",
    call: ["characters", "400", "400"],
  },
  {
    command: charactersCommand,
    options: [text("member", `<@${TARGET_ID}>`)],
    actor: MANAGER,
    results: { characters: R.officerList },
    title: "Linked characters",
    call: ["characters", "400", TARGET_ID],
  },
  {
    command: mainCommand,
    options: [text("character", "12345678")],
    actor: MEMBER,
    results: { preferences: R.mainSaved },
    title: "Main character updated",
    call: ["preferences", "400", "12345678", null],
  },
  {
    command: nicknameCommand,
    options: [{ type: S.Boolean, name: "enabled", value: true }],
    actor: MEMBER,
    results: { preferences: R.mainSaved },
    title: "Nickname sync on",
    call: ["preferences", "400", null, true],
  },
  {
    command: nicknameCommand,
    options: [{ type: S.Boolean, name: "enabled", value: false }],
    actor: MEMBER,
    results: { preferences: R.nicknameUnchanged },
    title: "Nickname sync already off",
    call: ["preferences", "400", null, false],
  },
  {
    command: assignCommand,
    options: [
      text("member", TARGET_ID),
      text("reason", "Confirmed in-game with the member."),
      text("character", "12345678"),
    ],
    actor: MANAGER,
    results: { assign: R.assigned },
    title: "Character assigned",
    call: ["assign", "400", TARGET_ID, IDENTITY, "Confirmed in-game with the member."],
  },
  {
    command: unassignCommand,
    options: [
      text("member", TARGET_ID),
      text("character", "12345678"),
      text("reason", "Character transferred to another account."),
    ],
    actor: MANAGER,
    results: { unclaim: R.unassigned },
    title: "Character unassigned",
    call: ["unclaim", "400", TARGET_ID, "12345678", "Character transferred to another account."],
  },
  {
    command: ledgerCommand,
    options: [
      subcommand("deposit", [
        { type: S.Integer, name: "amount", value: 10_005_000 },
        text("note", "Sold housing furnishings on the market board"),
      ]),
    ],
    actor: MEMBER,
    results: { ledger: L.deposit },
    title: "Deposit recorded",
    call: [
      "ledger",
      "400",
      "deposit",
      10_005_000,
      "Sold housing furnishings on the market board",
      INTERACTION_ID,
      null,
    ],
  },
  {
    command: ledgerCommand,
    options: [
      subcommand("withdraw", [
        { type: S.Integer, name: "amount", value: 2_500_000 },
        text("note", "Company workshop materials for airship parts"),
      ]),
    ],
    actor: MANAGER,
    results: { ledger: L.withdraw },
    title: "Withdrawal recorded",
    call: [
      "ledger",
      "400",
      "withdraw",
      2_500_000,
      "Company workshop materials for airship parts",
      INTERACTION_ID,
      null,
    ],
  },
  {
    command: ledgerCommand,
    options: [
      subcommand("adjust", [
        text("balance", "117900000"),
        text("note", "Recount"),
        text("entry", ` ${ENTRY_IDS[42]} `),
      ]),
    ],
    actor: MANAGER,
    results: { ledger: L.adjust },
    title: "Correction recorded",
    call: [
      "ledger",
      "400",
      "adjust",
      "117900000",
      "Recount",
      INTERACTION_ID,
      { id: ENTRY_IDS[42] },
    ],
  },
  {
    // The entry number history shows is accepted too, with or without '#' (owner decision).
    command: ledgerCommand,
    options: [
      subcommand("adjust", [
        text("balance", "117900000"),
        text("note", "Recount"),
        text("entry", " #42 "),
      ]),
    ],
    actor: MANAGER,
    results: { ledger: L.adjust },
    title: "Correction recorded",
    call: ["ledger", "400", "adjust", "117900000", "Recount", INTERACTION_ID, { sequence: 42n }],
  },
  {
    command: ledgerCommand,
    options: [
      subcommand("initialize", [text("balance", "95000000"), text("note", "Counted the chest")]),
    ],
    actor: MANAGER,
    results: { ledger: L.unchanged },
    title: "No correction needed",
    call: ["ledger", "400", "initialize", "95000000", "Counted the chest", INTERACTION_ID, null],
  },
  {
    command: ledgerCommand,
    options: [subcommand("balance")],
    actor: MEMBER,
    results: { ledgerRead: L.balance },
    title: "Example Free Company ledger",
    call: ["ledgerRead", "400", null, null, false],
  },
  {
    // A Lodestone link is accepted for fc_id and reduced to the FC ID.
    command: ledgerCommand,
    options: [
      subcommand("balance", [
        text("fc_id", "https://na.finalfantasyxiv.com/lodestone/freecompany/9200000000000000002/"),
      ]),
    ],
    actor: MANAGER,
    results: { ledgerRead: L.historical },
    title: "Historical ledger · Example Old Company",
    call: ["ledgerRead", "400", "9200000000000000002", null, false],
  },
  {
    command: ledgerCommand,
    options: [subcommand("history", [text("before", " 34 ")])],
    actor: MEMBER,
    results: { ledgerRead: L.history },
    title: "Ledger history · Example Free Company",
    call: ["ledgerRead", "400", null, "34", true],
  },
];

test("every character and ledger command returns its presenter's one embed, with content only for /claim", async () => {
  for (const path of PATHS) {
    const { app, calls } = stubService(path.results);
    const result = await run(path.command, path.options, path.actor, app);
    if (!(result instanceof Presented)) throw new Error(`/${path.command.name} returned no reply`);
    expect({ command: path.command.name, title: result.options.embeds[0]?.title }).toEqual({
      command: path.command.name,
      title: path.title,
    });
    expect(result.options.embeds).toHaveLength(1);
    // Visibility belongs to the router's acknowledgement; a handler never sets flags.
    expect(result.options).not.toHaveProperty("flags");
    expect(result.options.content).toBe(path.content ?? "");
    expect(calls.filter(([method]) => method !== "guild")).toEqual([path.call]);
  }
});

/** The one embed a recorded edit carries. */
function embedOf(request: RecordedRequest | undefined): APIEmbed {
  const body = request?.body;
  const embeds = typeof body === "object" && body !== null && "embeds" in body ? body.embeds : [];
  if (!Array.isArray(embeds) || embeds.length !== 1) throw new Error("Expected one embed");
  return embeds[0] as APIEmbed;
}

/** Run one slash command through the router as `actor` and return the card it edited in. */
async function routed(command: Command, options: unknown[], actor: Actor, error: Failure) {
  const { app } = stubService({ claim: error, verify: error, assign: error });
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  const router = new InteractionRouter(
    {
      client: fixture.client,
      services: new Services().provide(applicationKey, app),
      allowsGuild: () => true,
      isStopping: () => false,
      resolveActor: async (guildId, userId) => ({ ...actor, guildId, userId }),
      report: () => {},
    },
    new Map([[command.name, command]]),
    new Map(),
  );
  await router.handle(fixture.slash(command.name, options));
  return { embed: embedOf(fixture.requests.at(-1)), sent: JSON.stringify(fixture.requests) };
}

test("ownership conflicts show the owner to officers on /assign and to no member (O3)", async () => {
  // Built the way the service's throw site builds it: the owner is only in the detail.
  const conflict = new Failure(
    "ownership_conflict",
    "This character is already linked to a different member of this server.",
    0,
    { kind: "ownership", character: CHARACTER, owner: GUEST_ID },
  );
  const officer = await routed(
    assignCommand,
    [text("member", TARGET_ID), text("reason", "Vouched"), text("character", "12345678")],
    MANAGER,
    conflict,
  );
  expect(officer.embed).toMatchObject({
    title: "Linked to another member",
    fields: [{ name: "Linked to", value: `<@${GUEST_ID}> (\`${GUEST_ID}\`)` }],
  });
  expect(officer.embed.description).toContain("`/unassign`");
  for (const command of [claimCommand, verifyCommand]) {
    const member = await routed(command, [text("character", "12345678")], MEMBER, conflict);
    expect(member.embed.title).toBe("Linked to another member");
    expect(member.sent).not.toContain(GUEST_ID);
  }
});

test("malformed ledger options are input failures that name the option and skip the service", async () => {
  const cases: [unknown[], string][] = [
    [[subcommand("history", [text("before", "latest")])], "before"],
    [[subcommand("history", [text("before", "0")])], "before"],
    [[subcommand("balance", [text("fc_id", "Example Free Company")])], "fc_id"],
    [
      [subcommand("adjust", [text("balance", "1"), text("note", "Fix"), text("entry", "#abc")])],
      "entry",
    ],
  ];
  for (const [options, option] of cases) {
    const { app, calls } = stubService({});
    const error = await run(ledgerCommand, options, MANAGER, app).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Failure);
    expect(error).toMatchObject({ code: "input", detail: { kind: "option", option } });
    expect(calls.filter(([method]) => method !== "guild")).toEqual([]);
  }
});

test("the history cursor option describes an entry number", () => {
  const history = ledgerCommand.toJSON().options?.find((option) => option.name === "history");
  const before =
    history && "options" in history
      ? history.options?.find((option) => option.name === "before")
      : undefined;
  expect(before?.description).toBe("Entry number from a previous page (e.g. 34)");
});

// ---------------------------------------------------------------------------------------------
// Guests, synchronization and utilities

/** An officer of the fixture guild without Manage Roles. */
const OFFICER: Actor = { ...MEMBER, officer: true };
const B = ApplicationCommandOptionType.Boolean;

/** Each guest, sync and utility command path: options, actor, stubbed result, title and call. */
const GUEST_SYNC_PATHS: readonly {
  readonly command: Command;
  readonly options: unknown[];
  readonly actor: Actor;
  readonly results: Record<string, unknown>;
  readonly refresh?: unknown;
  readonly title: string;
  readonly call: Call | null;
}[] = [
  {
    command: guestCommand,
    options: [subcommand("status")],
    actor: MEMBER,
    results: { guestStatus: G.granted },
    title: "Your guest access",
    call: ["guestStatus", "400", "400"],
  },
  {
    command: guestCommand,
    options: [subcommand("status", [text("member", `<@${GUEST_ID}>`)])],
    actor: OFFICER,
    results: { guestStatus: G.record },
    title: "Guest access · member record",
    call: ["guestStatus", "400", GUEST_ID],
  },
  {
    command: guestCommand,
    options: [subcommand("grant", [text("member", GUEST_ID), text("reason", "Vouched")])],
    actor: OFFICER,
    results: { guestAction: GA.granted },
    title: "Guest access granted",
    call: ["guestAction", "400", GUEST_ID, false, "Vouched", INTERACTION_ID],
  },
  {
    command: guestCommand,
    options: [subcommand("revoke", [text("member", GUEST_ID), text("reason", "Disruptive")])],
    actor: OFFICER,
    results: { guestAction: GA.revoked },
    title: "Guest access revoked",
    call: ["guestAction", "400", GUEST_ID, true, "Disruptive", INTERACTION_ID],
  },
  {
    // reset removes every override (owner decision, 2026-09-24).
    command: guestCommand,
    options: [subcommand("reset", [text("member", GUEST_ID), text("reason", "Settled")])],
    actor: OFFICER,
    results: { guestReset: guestReset() },
    title: "Guest access reset",
    call: ["guestReset", "400", GUEST_ID, "Settled"],
  },
  {
    command: guestCommand,
    options: [subcommand("approve", [text("application", APPLICATION_ID)])],
    actor: OFFICER,
    results: { decide: decision() },
    title: "Application approved",
    call: ["decide", "400", APPLICATION_ID, true, null],
  },
  {
    command: guestCommand,
    options: [
      subcommand("deny", [text("application", APPLICATION_ID), text("reason", "Not a fit")]),
    ],
    actor: OFFICER,
    results: { decide: decision({ status: "denied", reason: "Not a fit" }) },
    title: "Application denied",
    call: ["decide", "400", APPLICATION_ID, false, "Not a fit"],
  },
  {
    command: refreshCommand,
    options: [],
    actor: MEMBER,
    results: {},
    refresh: refreshed(),
    title: "Refresh requested",
    call: ["refresh", "400", false],
  },
  {
    command: refreshCommand,
    options: [{ type: B, name: "force", value: true }],
    actor: OFFICER,
    results: {},
    refresh: refreshed({ forced: true, cached: false }),
    title: "Forced refresh requested",
    call: ["refresh", "400", true],
  },
  {
    command: syncCommand,
    options: [subcommand("status")],
    actor: MEMBER,
    results: { syncStatus: SR.memberAttention },
    title: "Your sync status",
    call: ["syncStatus", "400", null],
  },
  {
    command: syncCommand,
    options: [subcommand("status", [text("run_id", ` ${RUN_ID} `)])],
    actor: MEMBER,
    results: { syncStatus: SR.run },
    title: "Sync run · completed",
    call: ["syncStatus", "400", RUN_ID],
  },
  {
    command: syncCommand,
    options: [subcommand("status")],
    actor: OFFICER,
    results: { syncStatus: SR.officer },
    title: "Sync status · server",
    call: ["syncStatus", "400", null],
  },
  { command: pingCommand, options: [], actor: MEMBER, results: {}, title: "Pong", call: null },
  {
    command: channelCommand,
    options: [],
    actor: MEMBER,
    results: {},
    title: "Channel details",
    call: null,
  },
];

test("every guest, sync and utility command returns its presenter's one embed", async () => {
  for (const path of GUEST_SYNC_PATHS) {
    const { app, calls } = stubService(path.results);
    const result = await run(
      path.command,
      path.options,
      path.actor,
      app,
      stubSynchronization(path.refresh ?? refreshed(), calls),
    );
    if (!(result instanceof Presented)) throw new Error(`/${path.command.name} returned no reply`);
    expect({ command: path.command.name, title: result.options.embeds[0]?.title }).toEqual({
      command: path.command.name,
      title: path.title,
    });
    expect(result.options.embeds).toHaveLength(1);
    expect(result.options).not.toHaveProperty("flags");
    expect(result.options.content).toBe("");
    expect(calls.filter(([method]) => method !== "guild")).toEqual(path.call ? [path.call] : []);
  }
});

test("/issue passes the member, reporter, Ref and description to the issue reporter (2.18.0)", async () => {
  const calls: unknown[][] = [];
  const reports: unknown = Object.create(IssueReports.prototype);
  if (!(reports instanceof IssueReports)) throw new Error("Invalid issue reports fixture");
  Object.assign(reports, {
    user: async (actor: Actor, reporter: string, ref: string, description: string) => {
      calls.push([actor.userId, reporter, ref, description]);
      return { delivery: "queued", ref };
    },
  });
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  const interaction = fixture.slash("issue", [
    text("description", "My Member role disappeared after I ran /main."),
  ]);
  const result = await issueCommand.execute?.({
    client: fixture.client,
    services: new Services().provide(issueReportsKey, reports),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => MEMBER,
    actor: MEMBER,
    viewer: viewerOf(MEMBER, "1290000000000000001"),
    interaction,
  });
  if (!(result instanceof Presented)) throw new Error("/issue returned no reply");
  expect(result.options.embeds[0]?.title).toBe("Report received");
  expect(calls).toEqual([
    [
      MEMBER.userId,
      interaction.user.username,
      interaction.id,
      "My Member role disappeared after I ran /main.",
    ],
  ]);
});

test("/suggest passes only the member and the idea to the suggestion service (2.28.0)", async () => {
  // Nothing about the member goes public, so the command hands over no username or interaction
  // ID: the service gets the actor (for the checks and the private audit row) and the idea.
  const calls: unknown[][] = [];
  const suggestions: unknown = Object.create(Suggestions.prototype);
  if (!(suggestions instanceof Suggestions)) throw new Error("Invalid suggestions fixture");
  Object.assign(suggestions, {
    submit: async (...args: unknown[]) => {
      calls.push(args);
      return {
        number: 34,
        url: "https://github.com/deconfined/tarubot/issues/34",
        repository: "deconfined/tarubot",
      };
    },
  });
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  const interaction = fixture.slash("suggest", [
    text("idea", "Let officers schedule FC events and remind members an hour before."),
  ]);
  const result = await suggestCommand.execute?.({
    client: fixture.client,
    services: new Services().provide(suggestionsKey, suggestions),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => MEMBER,
    actor: MEMBER,
    viewer: viewerOf(MEMBER, "1290000000000000001"),
    interaction,
  });
  if (!(result instanceof Presented)) throw new Error("/suggest returned no reply");
  expect(result.options.embeds[0]?.title).toBe("Suggestion posted");
  expect(result.options.embeds[0]?.url).toBe("https://github.com/deconfined/tarubot/issues/34");
  expect(calls).toEqual([
    [MEMBER, "Let officers schedule FC events and remind members an hour before."],
  ]);
});

test("a member naming someone else on /guest status is refused before any read", async () => {
  const { app, calls } = stubService({ guestStatus: G.record });
  const error = await run(
    guestCommand,
    [subcommand("status", [text("member", GUEST_ID)])],
    MEMBER,
    app,
  ).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "forbidden", detail: { kind: "scope", scope: "owner" } });
  expect(calls).toEqual([]);
});

test("/refresh passes the service's refusals through to the failure presenter", async () => {
  const refused = new Failure("forbidden", "Only officers can force a refresh.", 0, {
    kind: "scope",
    scope: "officer",
  });
  const { app } = stubService({});
  const error = await run(
    refreshCommand,
    [{ type: B, name: "force", value: true }],
    MEMBER,
    app,
    stubSynchronization(refused, []),
  ).catch((caught: unknown) => caught);
  expect(error).toBe(refused);
});

// ---------------------------------------------------------------------------------------------
// Configuration, setup and officer overrides

/**
 * A prototype-backed RoleAdministration whose setup, planSetup, overrides and officer methods
 * return `results[method]` (or throw it when it is an Error), recording each call in `calls` as
 * the Service stub does.
 */
function stubAdministration(
  results: Readonly<Record<string, unknown>>,
  calls: Call[],
): RoleAdministration {
  const admin: unknown = Object.create(RoleAdministration.prototype);
  if (!(admin instanceof RoleAdministration)) throw new Error("Invalid administration fixture");
  for (const method of ["setup", "planSetup", "overrides", "officer", "officerReset"] as const)
    Object.assign(admin, {
      [method]: async (actor: Actor, ...args: unknown[]) => {
        calls.push([method, actor.userId, ...args]);
        const result = results[method] ?? {};
        if (result instanceof Error) throw result;
        return result;
      },
    });
  return admin;
}

/** Run a configuration command with the Service and RoleAdministration stubs. */
async function runConfig(
  command: Command,
  options: unknown[],
  actor: Actor,
  results: Readonly<Record<string, unknown>>,
  resolved?: unknown,
) {
  const { app, calls } = stubService(results);
  await open?.close();
  const fixture = interactionFixture();
  open = fixture;
  const result = await command.execute?.({
    client: fixture.client,
    services: new Services()
      .provide(applicationKey, app)
      .provide(roleAdministrationKey, stubAdministration(results, calls)),
    allowsGuild: () => true,
    isStopping: () => false,
    report: () => {},
    resolveActor: async () => actor,
    actor,
    viewer: viewerOf(actor, "1290000000000000001"),
    interaction: fixture.slash(command.name, options, resolved),
  });
  return { result, calls };
}

/** A raw subcommand group payload. */
const group = (name: string, options: unknown[]) => ({
  type: S.SubcommandGroup,
  name,
  options,
});

/** A raw role option naming a role by ID. */
const role = (id: string) => ({ type: S.Role, name: "role", value: id });

/** The resolved role objects Discord sends beside role options, keyed by ID. */
const resolvedRoles = (...ids: string[]) => ({
  roles: Object.fromEntries(
    ids.map((id) => [
      id,
      { id, name: "Access role", color: 0, hoist: false, position: 1, permissions: "0" },
    ]),
  ),
});

/** The resolved channel objects Discord sends beside channel options, keyed by ID. */
const resolvedChannels = (...ids: string[]) => ({
  channels: Object.fromEntries(
    ids.map((id) => [id, { id, name: "guest-reviews", type: 0, permissions: "0" }]),
  ),
});

/** Each configuration command path: options, actor, stubbed result, expected title and call. */
const CONFIG_PATHS: readonly {
  readonly command: Command;
  readonly options: unknown[];
  /** Discord's resolved objects for role options, as the raw payload carries them. */
  readonly resolved?: unknown;
  readonly actor: Actor;
  readonly results: Record<string, unknown>;
  readonly title: string;
  readonly call: Call;
}[] = [
  {
    command: configCommand,
    options: [subcommand("show")],
    actor: OFFICER,
    results: { validate: C.healthy },
    title: "Server configuration",
    // 2.35.0: the command passes its reporter, so a bug in the channel view is reported.
    call: ["validate", "400", expect.any(Function)],
  },
  {
    command: configCommand,
    options: [subcommand("validate")],
    actor: OFFICER,
    results: { validate: C.troubled },
    title: "Configuration health · 2 problems, 2 warnings",
    call: ["validate", "400", expect.any(Function)],
  },
  {
    command: configCommand,
    options: [group("fc", [subcommand("link", [text("fc_id", CONFIG_FC.id)])])],
    actor: OFFICER,
    results: { configure: C.linked },
    title: "Free Company linked",
    call: ["configure", "400", "fc_id", CONFIG_FC.id],
  },
  {
    command: configCommand,
    options: [group("fc", [subcommand("unlink", [text("fc_id", CONFIG_FC.id)])])],
    actor: OFFICER,
    results: { unlinkCompany: C.unlinked },
    title: "Free Company unlinked",
    call: ["unlinkCompany", "400", CONFIG_FC.id],
  },
  {
    command: configCommand,
    options: [subcommand("ledger", [{ type: B, name: "unset_channel", value: true }])],
    actor: OFFICER,
    results: { configure: configChange("ledger_channel_id", null) },
    title: "Ledger channel unset",
    call: ["configure", "400", "ledger_channel_id", null, {}],
  },
  {
    command: configCommand,
    options: [group("roles", [subcommand("member", [role(ROLE.member)])])],
    resolved: resolvedRoles(ROLE.member),
    actor: OFFICER,
    results: { configure: C.memberSet },
    title: "Member role set",
    call: ["configure", "400", "member_role_id", ROLE.member, {}],
  },
  {
    command: configCommand,
    options: [
      group("roles", [subcommand("guest", [{ type: B, name: "unset_role", value: true }])]),
    ],
    actor: OFFICER,
    results: { configure: configChange("guest_role_id", null, { previous: ROLE.guest }) },
    title: "Guest role unset",
    call: ["configure", "400", "guest_role_id", null, {}],
  },
  {
    // Only the Officer binding passes adopt_holders on to the service.
    command: configCommand,
    options: [
      group("roles", [
        subcommand("officer", [
          role(ROLE.officer),
          { type: B, name: "adopt_holders", value: false },
        ]),
      ]),
    ],
    resolved: resolvedRoles(ROLE.officer),
    actor: MANAGER,
    results: { configure: C.officerNotAdopted },
    title: "Officer role set without adopting holders",
    call: ["configure", "400", "officer_role_id", ROLE.officer, { adoptHolders: false }],
  },
  {
    command: configCommand,
    options: [group("roles", [subcommand("leader", [role(ROLE.leader)])])],
    resolved: resolvedRoles(ROLE.leader),
    actor: MANAGER,
    results: { configure: configChange("leader_role_id", ROLE.leader) },
    title: "FC Leader role set",
    call: ["configure", "400", "leader_role_id", ROLE.leader, {}],
  },
  {
    command: configCommand,
    options: [
      subcommand("officer_notifications", [{ type: B, name: "unset_channel", value: true }]),
    ],
    actor: OFFICER,
    results: {
      configure: configChange("officer_notifications_channel_id", null, {
        previous: CHANNEL.notices,
      }),
    },
    title: "Officer notifications turned off",
    call: ["configure", "400", "officer_notifications_channel_id", null, {}],
  },
  {
    // /config changelog (2.25.0) routes like the other channel settings.
    command: configCommand,
    options: [
      subcommand("changelog", [{ type: S.Channel, name: "channel", value: CHANNEL.changelog }]),
    ],
    resolved: resolvedChannels(CHANNEL.changelog),
    actor: OFFICER,
    results: { configure: C.changelogSet },
    title: "Changelog channel set",
    call: ["configure", "400", "changelog_channel_id", CHANNEL.changelog, {}],
  },
  {
    command: configCommand,
    options: [subcommand("changelog", [{ type: B, name: "unset_channel", value: true }])],
    actor: OFFICER,
    results: {
      configure: configChange("changelog_channel_id", null, { previous: CHANNEL.changelog }),
    },
    title: "Changelog posts turned off",
    call: ["configure", "400", "changelog_channel_id", null, {}],
  },
  {
    // The switch and the channel go to one service call (owner decision, 2026-09-24).
    command: configCommand,
    options: [subcommand("guest_applications", [{ type: B, name: "enabled", value: false }])],
    actor: OFFICER,
    results: { configureGuestApplications: applications({ enabled: [true, false] }) },
    title: "Guest applications closed",
    call: ["configureGuestApplications", "400", { enabled: false }],
  },
  {
    command: configCommand,
    options: [
      subcommand("guest_applications", [
        { type: B, name: "enabled", value: true },
        { type: S.Channel, name: "channel", value: CHANNEL.reviews },
      ]),
    ],
    resolved: resolvedChannels(CHANNEL.reviews),
    actor: OFFICER,
    results: {
      configureGuestApplications: applications({
        enabled: [false, true],
        channel: [null, CHANNEL.reviews],
      }),
    },
    title: "Guest applications open",
    call: ["configureGuestApplications", "400", { enabled: true, channel: CHANNEL.reviews }],
  },
  {
    command: configCommand,
    options: [subcommand("guest_applications", [{ type: B, name: "unset_channel", value: true }])],
    actor: OFFICER,
    results: {
      configureGuestApplications: applications({
        enabled: [false, false],
        channel: [CHANNEL.reviews, null],
      }),
    },
    title: "Review channel unset",
    call: ["configureGuestApplications", "400", { channel: null }],
  },
  {
    command: configCommand,
    options: [subcommand("officer_rank", [text("rank", "Officer")])],
    actor: MANAGER,
    results: { configureOfficerRank: C.rank },
    title: "Officer rank set",
    call: ["configureOfficerRank", "400", "Officer"],
  },
  {
    command: configCommand,
    options: [subcommand("role_layout", [{ type: B, name: "enabled", value: true }])],
    actor: MANAGER,
    results: { configureRoleLayout: C.layoutOn },
    title: "Role layout turned on",
    call: ["configureRoleLayout", "400", true],
  },
  // 2.35.0 (#46): /setup onboarding writes only with confirm:true; without it, and for /setup
  // overrides, the dry run answers.
  {
    command: setupCommand,
    options: [subcommand("onboarding", [{ type: B, name: "confirm", value: true }])],
    actor: MANAGER,
    results: { setup: C.setup },
    title: "Server setup complete",
    call: ["setup", "400", "", null, null, { lobby: null, officers: null }],
  },
  {
    command: setupCommand,
    options: [subcommand("onboarding", [text("prefix", "EXFC"), text("officer_rank", "Officer")])],
    actor: MANAGER,
    results: { planSetup: SETUP_PLANS.plan },
    title: "Server setup · dry run",
    call: ["planSetup", "400", "EXFC", null, "Officer", { lobby: null, officers: null }],
  },
  {
    command: setupCommand,
    options: [subcommand("overrides")],
    actor: MANAGER,
    results: { overrides: OVERRIDES_RESULTS.planBlocked },
    title: "Channel overrides · dry run · 2 blockers",
    call: ["overrides", "400", false],
  },
  {
    command: setupCommand,
    options: [subcommand("overrides", [{ type: B, name: "confirm", value: true }])],
    actor: MANAGER,
    results: { overrides: OVERRIDES_RESULTS.applied },
    title: "Channel overrides added",
    call: ["overrides", "400", true],
  },
  {
    command: officerCommand,
    options: [
      subcommand("grant", [text("member", `<@${OVERRIDE_USER}>`), text("reason", "New officer")]),
    ],
    actor: MANAGER,
    results: { officer: C.granted },
    title: "Officer access granted",
    call: ["officer", "400", OVERRIDE_USER, true, "New officer"],
  },
  {
    command: officerCommand,
    options: [
      subcommand("revoke", [text("member", OVERRIDE_USER), text("reason", "Stepped down")]),
    ],
    actor: MANAGER,
    results: { officer: override({ status: "revoked" }) },
    title: "Officer access revoked",
    call: ["officer", "400", OVERRIDE_USER, false, "Stepped down"],
  },
  {
    command: officerCommand,
    options: [
      subcommand("reset", [text("member", OVERRIDE_USER), text("reason", "Back to the rank")]),
    ],
    actor: MANAGER,
    results: { officerReset: officerReset() },
    title: "Officer override removed",
    call: ["officerReset", "400", OVERRIDE_USER, "Back to the rank"],
  },
];

test("every configuration, setup and officer command returns its presenter's one embed", async () => {
  for (const path of CONFIG_PATHS) {
    const { result, calls } = await runConfig(
      path.command,
      path.options,
      path.actor,
      path.results,
      path.resolved,
    );
    if (!(result instanceof Presented)) throw new Error(`/${path.command.name} returned no reply`);
    expect({ command: path.command.name, title: result.options.embeds[0]?.title }).toEqual({
      command: path.command.name,
      title: path.title,
    });
    expect(result.options.embeds).toHaveLength(1);
    expect(result.options).not.toHaveProperty("flags");
    expect(result.options.content).toBe("");
    expect(calls).toEqual([path.call]);
  }
});

test("/config's exactly-one checks are input failures that never reach the service", async () => {
  const cases: [unknown[], string, string, unknown?][] = [
    [[subcommand("officer_rank")], "Give a rank name or set unset_rank:true, not both.", "rank"],
    [
      [
        subcommand("officer_rank", [
          text("rank", "Officer"),
          { type: B, name: "unset_rank", value: true },
        ]),
      ],
      "Give a rank name or set unset_rank:true, not both.",
      "rank",
    ],
    [
      [group("roles", [subcommand("member")])],
      "Choose a role or set unset_role:true, not both.",
      "role",
    ],
    [[subcommand("ledger")], "Choose a channel or set unset_channel:true, not both.", "channel"],
    // /config changelog (2.25.0): neither, or both, is refused before the service.
    [[subcommand("changelog")], "Choose a channel or set unset_channel:true, not both.", "channel"],
    [
      [
        subcommand("changelog", [
          { type: S.Channel, name: "channel", value: CHANNEL.changelog },
          { type: B, name: "unset_channel", value: true },
        ]),
      ],
      "Choose a channel or set unset_channel:true, not both.",
      "channel",
      resolvedChannels(CHANNEL.changelog),
    ],
    // /config guest_applications needs at least one option, and never a channel with its unset.
    [
      [subcommand("guest_applications")],
      "Choose enabled, a channel, or unset_channel:true.",
      "enabled",
    ],
    [
      [
        subcommand("guest_applications", [
          { type: S.Channel, name: "channel", value: CHANNEL.reviews },
          { type: B, name: "unset_channel", value: true },
        ]),
      ],
      "Choose a channel or set unset_channel:true, not both.",
      "channel",
      resolvedChannels(CHANNEL.reviews),
    ],
  ];
  // Every service method fails if reached, so only the command's own parse can refuse.
  const reached = new Error("The service was reached with an unparsed option");
  const unreachable = Object.fromEntries(
    [
      "configure",
      "configureOfficerRank",
      "configureRoleLayout",
      "configureGuestApplications",
      "unlinkCompany",
      "validate",
    ].map((method) => [method, reached]),
  );
  for (const [options, message, option, resolved] of cases) {
    const error = await runConfig(configCommand, options, MANAGER, unreachable, resolved).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Failure);
    expect(error).toMatchObject({ code: "input", message, detail: { kind: "option", option } });
  }
});

// ---------------------------------------------------------------------------------------------
// The whole command surface

/** A raw option payload as the path walk reads it. */
interface RawOption {
  readonly type: number;
  readonly name: string;
  readonly options?: readonly RawOption[];
}

/** Whether a raw option selects a subcommand or subcommand group rather than a value. */
const isRoute = (option: RawOption): boolean =>
  option.type === S.Subcommand || option.type === S.SubcommandGroup;

/** The registered path a raw payload selects: 'config roles officer', 'ledger deposit', 'claim'. */
function pathOf(command: Command, options: readonly unknown[]): string {
  const parts = [command.name];
  let level = options as readonly RawOption[];
  for (let route = level.find(isRoute); route; route = level.find(isRoute)) {
    parts.push(route.name);
    level = route.options ?? [];
  }
  return parts.join(" ");
}

/** Every registered path, flattened from the discovered builders as commands.test does. */
async function registeredPaths(): Promise<string[]> {
  const paths: string[] = [];
  const visit = (prefix: string, options: readonly RawOption[]): void => {
    const nested = options.filter(isRoute);
    if (!nested.length) paths.push(prefix);
    for (const option of nested) visit(`${prefix} ${option.name}`, option.options ?? []);
  };
  for (const command of (await loadCommands()).values()) {
    const data = command.toJSON();
    visit(data.name, (data.options ?? []) as readonly RawOption[]);
  }
  return paths.sort();
}

test("the path tables return one embed for every registered command path", async () => {
  const covered = new Set(
    [...PATHS, ...GUEST_SYNC_PATHS, ...CONFIG_PATHS].map((path) =>
      pathOf(path.command, path.options),
    ),
  );
  const paths = await registeredPaths();
  // 41 in 2.14.0, plus /officer reset and /guest reset (owner decision, 2026-09-24), plus /issue
  // (2.18.0), /config changelog (2.25.0) and /suggest (2.28.0); 2.35.0 split /setup in two.
  expect(paths).toHaveLength(47);
  // /apply opens a form, whose refusal and receipt the router and guest-application tests cover,
  // /version reads GitHub, which version.test stubs, and /issue and /suggest have their own tests
  // below; every other path is exercised above.
  expect(paths.filter((path) => !covered.has(path))).toEqual([
    "apply",
    "issue",
    "suggest",
    "version",
  ]);
});

test("every registered command keeps its private default visibility", async () => {
  // Replies stay ephemeral; only the DevBot test guild's PUBLIC_TEST_RESPONSES override (applied
  // by the router, not the command) makes them public there.
  for (const command of (await loadCommands()).values())
    expect({ command: command.name, ephemeral: command.ephemeral }).toEqual({
      command: command.name,
      ephemeral: true,
    });
});
