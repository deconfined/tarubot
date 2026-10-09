/**
 * A credential-free development harness for the web pages (#43, ADR E13): the real web server
 * (startWeb), with a fake Discord, prototype-backed service fakes, in-memory sessions and invented
 * data. No application environment, real Discord connection or database is used.
 *
 * Run it as `bun --no-env-file tests/fixtures/web-dev.ts`, never through a root `bun run` alias,
 * which would load the checkout's .env (CLAUDE.md). Open the printed address, choose "Sign in with
 * Discord", and pick an invented account on the fake authorize page.
 * IPv6 loopback is the default; --host selects an explicit interface. LAN previews require
 * --cert and --key to serve both listeners over HTTPS without weakening the web's origin policy.
 * For an isolated reverse-proxy lab, --origin supplies the public URL and --port the private
 * HTTP listener; the fake Discord stays on its own local HTTP port.
 *
 * Review states are opt-in, so a reviewer can see every view state; without them the data is the
 * healthy, live default that tests/unit/web-server.test.ts and web-mentions.test.ts rely on. Each
 * flag switches one thing on, and they combine (startHarness takes the same switches as
 * `states`):
 * - --state-checks=warn: Server configuration's checklist has warnings and no failures (a stale
 *   roster, Administrator still needed, a core permission only from @everyone, a permission it
 *   never needs, a channel missing TaruBot's override), and the Lodestone is cooling down as with
 *   --state-cooling: that cooldown is the only process-health check that can wait without a change
 *   of effects mode, so Background work's health shows [WAIT].
 * - --state-checks=fail: failures too (two access roles above TaruBot, a missing core permission,
 *   the officer notifications channel denied to TaruBot and so hidden by name, a stale roster whose
 *   last Lodestone attempt was unavailable and retries), and Background work's health shows the
 *   gateway disconnected: [FAIL] Not ready and Not connected to Discord. The database stays
 *   reachable, since the page itself reads its work from the database.
 * - --state-activation: the server awaits activation; Discord changes are paused, Guest
 *   grandfathering is pending, Discord work is parked (‖ PAUSED) and its refresh run is Paused
 *   with that work held.
 * - --state-deploy-disabled: Discord changes are off for this deployment (ENABLE_EFFECTS=false),
 *   with work parked the same way. It wins over --state-activation, as Service.effectsMode decides.
 * - --state-empty: Background work has no outstanding jobs and no refresh runs, so both tables
 *   show their empty states and every sample count is 0. It wins over the other flags' job and
 *   run samples.
 * - --state-cooling: the Lodestone is cooling down after a 429. Background work's health waits, a
 *   forced roster fetch waits for the cooldown (↻ WAITING, Next) in its In progress run, and the
 *   FC's latest roster attempt failed as rate limited while the roster is still fresh.
 * - --state-hostile-names: long, right-to-left, markup-like and emoji names for the servers (three
 *   more of which the officer can open), the FC, its officer rank, the roles, the channels and the
 *   members, within Discord's lengths; one role name carries U+202E RIGHT-TO-LEFT OVERRIDE.
 * - --state-menu-problems: the Role menu's server has drifted since officers built the menu.
 *   TaruBot holds Administrator again; She/Her gained Mention @everyone; They/Them sits above the
 *   Moderator and Dyno roles; Valheim gained Manage Messages in #valheim; Mahjong night sits above
 *   TaruBot's role; Halloween 2025 was deleted in Discord; and two channels are hidden from
 *   TaruBot, so adding roles asks for the confirmation. Server configuration's "Role menu" and
 *   "TaruBot's role" checks warn about the same drift.
 * - --state-menu-unreadable: the saved role menu is one this build can't read (as after a rollback
 *   from a newer release), so the page offers only Reset role menu.
 * - --state-roles=queued|blocked|failed|skipped|expired: everyone's newest role change on My roles
 *   is in that state, so its banner shows: queued (a change waiting to be applied; with
 *   --state-activation or --state-deploy-disabled it is parked, and the banner says role changes
 *   are paused), blocked (TaruBot can't change roles there right now), failed, skipped (applied a
 *   few minutes ago, with 2 choices left out) or expired (dropped after 7 days). A waiting one asks
 *   for Minecraft instead of Valheim, so the form shows that ticked. Saving again replaces it as a
 *   real save would; under blocked the new change blocks too.
 * The Role menu's default is a healthy menu (Pronouns and Games published, Content a draft,
 *   Retired events no longer offered) over an invented server whose roles and channels the real
 *   rule set (src/domain/self-roles.ts) judges; edits apply to an in-memory copy per server, as
 *   SelfRoles.edit would, so forms can be tried end to end. Server configuration's "Role menu"
 *   check reads the same copy. Second FC, where nobody is an officer, has a menu of its own with a
 *   pick-one category (Main role), whose radios the member sees with two of its roles held.
 * - --state-history=incidents|new: the public status page's 90-day history (2.41.0). incidents has
 *   seven bad stretches: six hours not running 61 days ago, 45 minutes running without Discord 33
 *   days ago, a 20-minute host restart 18 days ago, short deploys of 5 and 10 minutes 12 and 3
 *   days ago (the second also moves the version from 2.40.0 to 2.41.0 that day), a 5-minute
 *   reconnect yesterday and 15 minutes down just after midnight UTC today. new has samples only
 *   since 18:00 UTC yesterday, so the other days show no data. Without it, 90 whole days.
 * The status page's components follow the other flags: --state-checks=fail is Down (Discord not
 *   connected, the Lodestone unanswered), --state-cooling and --state-checks=warn cool the
 *   Lodestone down, and --state-activation or --state-deploy-disabled pause Discord changes (on
 *   their tile only: a setting leaves the headline Operational). Its snapshot is real
 *   (PublicStatus over these sources and an in-memory store), so the first tick writes the current
 *   bucket's sample as production would.
 * My roles (2.40.0) reads the same menus. Each account holds a few invented menu roles (HELD), and
 *   a save runs the real rules (SelfRoles.choose's), then a fake worker applies it about two
 *   seconds later, as the roles.self job would (planSelfRoles, every role checked again), so a
 *   reload shows "Your roles were updated". Without a review state nobody has a change on record.
 * Every state is invented, and new IDs follow the harness's own 1000…/2000… pattern (roles
 * 4000…, channels 5000…).
 *
 * The fake authorize page runs on its own port on the same interface and protocol as the web. It
 * redirects only to the redirect URI the harness configured, and echoes no request data: its page
 * holds fixed wording and an ID it made itself. The token and /users/@me requests keep their
 * https://discord.com URLs and are answered by FakeDiscord through the injected fetch, so
 * oauth4webapi's allowInsecureRequests is never used.
 * tests/unit/web-server.test.ts drives the same harness end to end, and
 * tests/unit/web-harness-states.test.ts each review state.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  ChannelFlagsBitField,
  ChannelType,
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { type Logger, pino } from "pino";
import {
  applicationKey,
  gatewayKey,
  lifecycleKey,
  publicStatusKey,
  selfRolesKey,
} from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import { PublicStatus } from "../../src/application/public-status.js";
import { createReporter } from "../../src/application/reporting.js";
import type {
  ConfigurationReport,
  EffectsMode,
  FcHealthRow,
  SyncRunRow,
  SyncStatusView,
} from "../../src/application/results.js";
import {
  type MyRoles,
  menuRoleNames,
  offersRoles,
  type RoleChoiceOutcome,
  type RoleChoiceStatus,
  SelfRoles,
  type SelfRoleEditOutcome,
  type SelfRoleEditor,
} from "../../src/application/self-roles.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import { effectsPaused } from "../../src/domain/failures.js";
import type { ApiOverwrite, ApiRole } from "../../src/domain/permissions.js";
import { type Actor, authorize, selfServiceAccess } from "../../src/domain/policy.js";
import {
  applyOperation,
  botManagesRoles,
  CHOICE_MESSAGES,
  changedCategories,
  checkRoles,
  choiceHeld,
  choiceMenu,
  EMPTY_MENU,
  holdsAdministrator,
  type MenuFieldError,
  mergeChoice,
  menuRoleIds,
  planSelfRoles,
  type RoleChoicePayload,
  removableBy,
  roleChoicePayload,
  SELF_ROLE_MESSAGES,
  type SelfRoleMenu,
  sameChoice,
  sameMenu,
  selfRoleChecker,
  selfRoleHealth,
  type SelfRoleSettings,
  selfRoleSettings,
  unreadableChannels,
} from "../../src/domain/self-roles.js";
import { Failure } from "../../src/domain/values.js";
import type {
  VisibilityChannel,
  VisibilityGuild,
  VisibilityReport,
} from "../../src/domain/visibility.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import type { WebGuild } from "../../src/web/access.js";
import { startWeb, type WebOptions, type WebServer } from "../../src/web/server.js";
import { type DiscordAccount, FakeDiscord } from "./discord-oauth.js";
import { MemorySessions } from "./web-sessions.js";
import {
  fillHistory,
  HARNESS_HISTORIES,
  type HarnessHistory,
  MemoryStatusSamples,
} from "./status-samples.js";
import {
  CHANNEL,
  configGuild,
  configReport,
  fcRow,
  ROLE,
  visibilityReport,
} from "./replies/configuration.js";

/** The invented application: its ID doubles as the OAuth client ID, as in production. */
export const HARNESS_CLIENT_ID = "300000000000000001";
/** An invented client secret, accepted only by FakeDiscord. */
const HARNESS_CLIENT_SECRET = "harness-client-secret";

/** The invented servers the fake gateway has cached. */
export const HARNESS_GUILDS = {
  example: { id: "100000000000000001", name: "Example FC" },
  second: { id: "100000000000000002", name: "Second <FC> & Friends" },
} as const satisfies Record<string, WebGuild>;

/**
 * The invented accounts the fake authorize page offers, and what each one shows (2.40.0: members
 * and guests sign in to My roles). Each holds the configuration fixtures' bound roles (ROLE), and
 * TaruBot's Administrator follows the Role menu's snapshot, so --state-menu-problems, which gives
 * TaruBot Administrator again, refuses the member, the guest and the timed-out member (A2) while
 * the officer still gets in.
 */
export const HARNESS_ACCOUNTS = {
  /**
   * An officer of Example FC who holds Member in both servers: lists Example FC and Second FC
   * (only My roles there).
   */
  officer: { id: "200000000000000001", label: "An officer of Example FC" },
  /** Holds Member in both servers and is an officer of neither: My roles in each. */
  member: { id: "200000000000000002", label: "A member of both servers" },
  /** Holds Guest in Example FC and isn't in Second FC: My roles there. */
  guest: { id: "200000000000000005", label: "A guest of Example FC" },
  /** A member of Example FC in a Discord time-out: opens My roles, but can't save there. */
  timedOut: { id: "200000000000000007", label: "A member of Example FC in a time-out" },
  /** In Example FC with neither Member nor Guest (a lobby newcomer): "no access", no session. */
  lobby: { id: "200000000000000006", label: "A newcomer in Example FC's lobby" },
  /** In neither server (Discord's Unknown Member): "no access" too. */
  outsider: { id: "200000000000000003", label: "Someone in neither server" },
  /** A bot account: refused at sign-in. */
  bot: { id: "200000000000000004", label: "A bot account", bot: true },
} as const;

export type HarnessAccount = keyof typeof HARNESS_ACCOUNTS;

/** The opt-in review states; the header comment describes each one. None is on by default. */
export interface HarnessStates {
  /** --state-checks: configuration warnings, or failures too, and process health to match. */
  readonly checks?: "warn" | "fail";
  /** --state-activation: the server awaits activation. */
  readonly activation?: boolean;
  /** --state-deploy-disabled: Discord changes are off for this deployment. */
  readonly deploymentDisabled?: boolean;
  /** --state-empty: no outstanding work and no refresh runs. */
  readonly empty?: boolean;
  /** --state-cooling: the Lodestone is cooling down after a 429. */
  readonly cooling?: boolean;
  /** --state-hostile-names: long, right-to-left, markup-like and emoji names. */
  readonly hostileNames?: boolean;
  /** --state-menu-problems: the Role menu's roles and channels have drifted into problems. */
  readonly menuProblems?: boolean;
  /** --state-menu-unreadable: the saved role menu is one this build can't read. */
  readonly menuUnreadable?: boolean;
  /** --state-roles: everyone's newest role change on My roles is in this state. */
  readonly roles?: HarnessRolesState;
  /** --state-history: the status page's invented 90-day history. */
  readonly history?: HarnessHistory;
}

/** --state-roles' values, each a banner My roles shows. */
export const HARNESS_ROLES_STATES = ["queued", "blocked", "failed", "skipped", "expired"] as const;
export type HarnessRolesState = (typeof HARNESS_ROLES_STATES)[number];

/**
 * --state-hostile-names' invented names, each within Discord's length for its kind (100 for
 * servers, roles and channels, 32 for members). Example FC keeps its ID under its new name, and
 * the officer can open every server listed here.
 */
export const HOSTILE_NAMES = {
  guilds: [
    {
      id: HARNESS_GUILDS.example.id,
      name: "🌙✨ The Exceedingly Long-Winded Moonlit Lalafell Appreciation Society of Eorzea (Gridania) ✨🌙",
    },
    { id: "100000000000000003", name: "نادي مغامري الفجر (Dawn Adventurers)" },
    { id: "100000000000000004", name: '<script>alert("TaruBot")</script> & <b>Friends</b>' },
    /** No letter or digit to take initials from. */
    { id: "100000000000000005", name: "🐉🔥🐉" },
  ],
  fc: { name: "فجر Dawnbreakers <of> the Exceedingly Long-Named Company 🌅", tag: "<🌙>" },
  rank: "<i>Commander</i> 🛡️",
  roles: {
    leader:
      "👑 FC Leader, Grand Company Liaison and Keeper of the Company Chest (no pings after 22:00 ST)",
    officer: "ضابط الشركة الحرة",
    member: "<img src=x onerror=alert(1)> Member",
    guest: "\u202Eguest-of-honour 🧳",
  },
  channels: {
    ledger: "📒│fc-ledger-and-treasury-records-for-every-gil-spent-on-housing-glamours-and-mounts",
    notices: "إشعارات-الضباط",
    reviews: "<script>alert(1)</script>-reviews",
    lobby: "🚪│lobby",
    officers: "غرفة-الضباط",
    changelog: "📣│tarubot-updates",
  },
  members: {
    officer: "Mogwin Kupoberry, Mailmoogle 📬",
    member: "كوبو <Kupo> 🐾",
  },
} as const satisfies {
  readonly guilds: readonly WebGuild[];
  readonly fc: Pick<FcHealthRow, "name" | "tag">;
  readonly rank: string;
  readonly roles: Partial<Record<keyof typeof ROLE, string>>;
  readonly channels: Record<keyof typeof CHANNEL, string>;
  readonly members: Partial<Record<HarnessAccount, string>>;
};

/** The servers the gateway has cached, in the gateway's order. */
const harnessGuilds = (states: HarnessStates): readonly WebGuild[] =>
  states.hostileNames
    ? [...HOSTILE_NAMES.guilds, HARNESS_GUILDS.second]
    : Object.values(HARNESS_GUILDS);

/** The servers the officer account is an officer of: Example FC, or every hostile-named server. */
const officerGuilds = (states: HarnessStates): ReadonlySet<string> =>
  new Set(
    states.hostileNames
      ? HOSTILE_NAMES.guilds.map((guild) => guild.id)
      : [HARNESS_GUILDS.example.id],
  );

/** The effects mode Service.effectsMode would report: the deployment's switch before activation. */
const harnessEffects = (states: HarnessStates): EffectsMode =>
  states.deploymentDisabled
    ? "deployment_disabled"
    : states.activation
      ? "awaiting_activation"
      : "live";

/** --state-checks=warn implies the Lodestone cooldown (see the header comment). */
const lodestoneCooling = (states: HarnessStates): boolean =>
  states.cooling === true || states.checks === "warn";

/** An instant `minutes` before now. */
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);

/**
 * How long ago the last good roster read was: 12 minutes by default, and 9 hours, stale against
 * the default 6-hour interval, with --state-checks. Both pages date their roster evidence from it.
 */
const rosterMinutes = (states: HarnessStates): number => (states.checks ? 9 * 60 : 12);

/** A running harness. */
export interface Harness {
  /** The web's own address, also its WEB_PUBLIC_ORIGIN. */
  readonly url: URL;
  /** The fake authorize page. */
  readonly authorizeUrl: URL;
  /** Stop the web and the fake authorize page. Never rejects. */
  stop(): Promise<void>;
}

/**
 * Each account's actor in each server, as gateway.actor and enrichActor would make it, or undefined
 * where Discord would answer Unknown Member. The guest, the timed-out member and the lobby
 * newcomer are only in Example FC (under any name --state-hostile-names gives it).
 */
function harnessActor(guildId: string, userId: string, states: HarnessStates): Actor | undefined {
  const accounts = HARNESS_ACCOUNTS;
  const everywhere: readonly string[] = [accounts.officer.id, accounts.member.id, accounts.bot.id];
  const exampleOnly: readonly string[] = [
    accounts.guest.id,
    accounts.timedOut.id,
    accounts.lobby.id,
  ];
  const present =
    everywhere.includes(userId) ||
    (exampleOnly.includes(userId) && guildId === HARNESS_GUILDS.example.id);
  if (!present) return undefined;
  const officer = userId === accounts.officer.id && officerGuilds(states).has(guildId);
  const holdsMember: readonly string[] = [
    accounts.officer.id,
    accounts.member.id,
    accounts.timedOut.id,
  ];
  const member = holdsMember.includes(userId);
  const guest = userId === accounts.guest.id;
  return {
    guildId,
    userId,
    officer,
    manageRoles: false,
    serverManager: false,
    roleIds: [
      ...(officer ? [ROLE.officer] : []),
      ...(member ? [ROLE.member] : []),
      ...(guest ? [ROLE.guest] : []),
    ],
    member,
    guest,
    // The same snapshot Role menu reads, so its Administrator banner and this refusal agree.
    botAdministrator: holdsAdministrator(harnessSnapshot(guildId, states)),
    timedOut: userId === accounts.timedOut.id,
  };
}

/** The resolver main.ts builds from gateway.actor and enrichActor, answered from invented data. */
function actorResolver(states: HarnessStates) {
  return async (guildId: string, userId: string): Promise<Actor> => {
    if (userId === HARNESS_ACCOUNTS.bot.id)
      throw new Failure("forbidden", "Bot accounts can't use TaruBot.", 0, {
        kind: "scope",
        scope: "human",
      });
    const actor = harnessActor(guildId, userId, states);
    if (!actor)
      throw new Failure("forbidden", "That member isn't in this server.", 0, {
        kind: "scope",
        scope: "current_member",
      });
    return actor;
  };
}

type WorkRow = SyncStatusView["work"][number];

/** Newest first by creation time, as syncStatus orders its runs and work. */
const latestFirst = (a: { created_at: Date }, b: { created_at: Date }): number =>
  b.created_at.getTime() - a.created_at.getTime();

/**
 * Background work's invented data. By default: a completed roster run, and work in several states
 * with Discord changes live. The review states replace it with what syncStatus would return then:
 * while Discord changes are paused, the dispatcher's effects gate parks Discord work as `disabled`
 * (roster acquisition is never gated), and a refresh run counts parked children as blocked.
 */
function syncView(states: HarnessStates = {}): SyncStatusView {
  const effectsMode = harnessEffects(states);
  if (states.empty) return { effectsMode, runs: [], work: [] };
  const at = new Date(Date.now() - 12 * 60_000);
  const job = (
    kind: string,
    status: string,
    last_error: string | null = null,
    overrides: Partial<WorkRow> = {},
  ): WorkRow => ({
    id: randomUUID(),
    kind,
    status,
    attempts: status === "queued" ? 0 : 1,
    due_at: at,
    created_at: at,
    completed_at: null,
    last_error,
    result: null,
    user_id: HARNESS_ACCOUNTS.member.id,
    ...overrides,
  });
  const run = (overrides: Partial<SyncRunRow>): SyncRunRow => ({
    id: randomUUID(),
    created_at: at,
    enumeration_completed_at: at,
    requester_id: HARNESS_ACCOUNTS.officer.id,
    acquisition_kind: "roster",
    acquisition_status: "succeeded",
    last_error: null,
    result: null,
    status: "completed",
    work_total: 12,
    work_completed: 12,
    work_blocked: 0,
    work_failed: 0,
    completed_at: at,
    ...overrides,
  });

  // The roster acquisition still outstanding, if any: jobs share its dedupe key, so at most one.
  // A Lodestone refusal is stored as jobOutcome writes it, `${code}: ${message}` (lodestone/
  // client.ts words a throttled request "Lodestone rate limited."). Rate limiting is a waiting
  // code, so the job keeps its attempt and is due when the gate's cooldown ends; "unavailable"
  // spends attempts and retries after a short backoff.
  const roster = lodestoneCooling(states)
    ? job("roster", "queued", "rate_limited: Lodestone rate limited.", {
        attempts: 0,
        created_at: minutesAgo(4),
        due_at: new Date(Date.now() + 60_000),
        user_id: null,
      })
    : states.checks === "fail"
      ? job("roster", "queued", "unavailable: The Lodestone is unavailable.", {
          attempts: 2,
          created_at: minutesAgo(20),
          due_at: new Date(Date.now() + 7_000),
          user_id: null,
        })
      : null;
  // An officer's forced refresh, still waiting on its own acquisition: the run's only child so far.
  const coolingRun = lodestoneCooling(states)
    ? run({
        created_at: minutesAgo(4),
        enumeration_completed_at: null,
        acquisition_status: "queued",
        last_error: roster?.last_error ?? null,
        status: "queued",
        work_total: 1,
        work_completed: 0,
        completed_at: null,
      })
    : null;
  // The last good roster read (the default sample's own time unless --state-checks made it
  // stale): the completed fetch's, or what a cached pass three minutes later reused while paused.
  const read = states.checks ? minutesAgo(rosterMinutes(states)) : at;
  const pass = new Date(read.getTime() + 3 * 60_000);
  const paused = effectsMode !== "live";
  const parked = effectsPaused(effectsMode !== "deployment_disabled");
  const pause = (kind: string, created_at: Date, user_id: string | null) =>
    job(kind, "disabled", `${parked.code}: ${parked.message}`, {
      created_at,
      due_at: created_at,
      user_id,
    });
  const runs = [
    ...(coolingRun ? [coolingRun] : []),
    paused
      ? // A cached-roster pass: its acquisition enumerated two people and attached their role
        // updates and the role layout, all three parked, so the run waits with them held.
        run({
          created_at: pass,
          enumeration_completed_at: pass,
          acquisition_kind: "reconcile.guild",
          result: { enumerationComplete: true, humans: 2, effects: "queued" },
          status: "blocked",
          work_total: 4,
          work_completed: 1,
          work_blocked: 3,
          completed_at: null,
        })
      : run({ created_at: read, enumeration_completed_at: read, completed_at: read }),
  ];
  const work = [
    ...(roster ? [roster] : []),
    ...(paused
      ? [
          pause("reconcile.user", pass, HARNESS_ACCOUNTS.member.id),
          pause("reconcile.user", pass, HARNESS_ACCOUNTS.officer.id),
          pause("roles.layout", pass, null),
          pause("officer.notify", read, null),
        ]
      : [
          job("reconcile.user", "queued"),
          job("roles.layout", "running"),
          job("guest.dm", "failed", "dm_blocked: invented diagnostic"),
          job("reconcile.user", "blocked", "blocked: Missing Permissions (invented)"),
        ]),
  ];
  // syncStatus orders both newest first; the sort is stable, so equal times keep this order.
  return {
    effectsMode,
    runs: runs.sort(latestFirst),
    work: work.sort(latestFirst),
  };
}

/**
 * SDK-shaped invented caches: no gateway connection, fetched names or member data. The review
 * states rename everything (--state-hostile-names) and, with --state-checks=fail, deny TaruBot
 * View Channel on the officer notifications channel, so the web treats it as hidden.
 */
export function harnessGateway(states: HarnessStates = {}): DiscordGateway {
  const gateway: unknown = Object.create(DiscordGateway.prototype);
  if (!(gateway instanceof DiscordGateway)) throw new Error("Invalid gateway fake");
  const hostile = states.hostileNames === true;
  const roleNames: Readonly<Record<string, string>> = hostile ? HOSTILE_NAMES.roles : {};
  const channelNames: Readonly<Record<string, string>> = hostile ? HOSTILE_NAMES.channels : {};
  const memberNames: Readonly<Record<string, string>> = hostile ? HOSTILE_NAMES.members : {};
  const roles = new Collection<string, { id: string; name: string }>([
    ...Object.entries(ROLE).map(([label, id]): [string, { id: string; name: string }] => [
      id,
      {
        id,
        name:
          roleNames[label] ??
          (label === "bot" ? "TaruBot" : `${label[0]?.toUpperCase()}${label.slice(1)}`),
      },
    ]),
    // The Role menu's invented roles (harnessSnapshot), whose names the page reads from here.
    ...(Object.keys(MENU_ROLE) as (keyof typeof MENU_ROLE)[]).map(
      (key): [string, { id: string; name: string }] => [
        MENU_ROLE[key],
        { id: MENU_ROLE[key], name: MENU_ROLE_NAMES[key] },
      ],
    ),
  ]);
  const channels = new Collection<
    string,
    {
      id: string;
      name: string;
      flags: ChannelFlagsBitField;
      isThread: () => boolean;
      permissionsFor: () => PermissionsBitField;
    }
  >(
    Object.entries(CHANNEL).map(([label, id]) => [
      id,
      {
        id,
        name:
          channelNames[label] ??
          {
            ledger: "fc-ledger",
            notices: "officer-notices",
            reviews: "guest-review",
            lobby: "lobby",
            officers: "officers",
            changelog: "tarubot-updates",
          }[label] ??
          label,
        flags: new ChannelFlagsBitField(),
        isThread: () => false,
        permissionsFor: () =>
          states.checks === "fail" && id === CHANNEL.notices
            ? new PermissionsBitField()
            : new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      },
    ]),
  );
  // The Role menu's readable channels (harnessSnapshot); the hidden ones never show a name.
  for (const key of Object.keys(MENU_CHANNEL) as (keyof typeof MENU_CHANNEL)[]) {
    if (key === "hiddenOne" || key === "hiddenTwo") continue;
    const id = MENU_CHANNEL[key];
    channels.set(id, {
      id,
      name: MENU_CHANNEL_NAMES[key],
      flags: new ChannelFlagsBitField(),
      isThread: () => false,
      permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel),
    });
  }
  const guild = {
    roles: { cache: roles },
    channels: { cache: channels },
    members: {
      me: {},
      cache: new Collection(
        Object.entries(HARNESS_ACCOUNTS).map(([key, account]) => [
          account.id,
          {
            id: account.id,
            displayName: memberNames[key] ?? account.label,
          },
        ]),
      ),
    },
  };
  // Every server the officer can open shares the one invented cache, so each resolves names.
  Object.defineProperty(gateway, "client", {
    value: { guilds: { cache: new Map([...officerGuilds(states)].map((id) => [id, guild])) } },
  });
  return gateway;
}

/**
 * --state-checks=warn's view of TaruBot's role and channels, on a server without onboarding:
 * Administrator held and still needed for a channel missing TaruBot's override, Manage Nicknames
 * only from @everyone, and Manage Messages, which it never needs, from its own role.
 */
function warningView(guildId: string): VisibilityReport {
  const healthy = visibilityReport({}, false);
  return visibilityReport(
    {
      administrator: { held: true, roles: [ROLE.bot], shared: [] },
      administratorNeeded: true,
      core: healthy.core.map((row) =>
        row.permission === "ManageNicknames"
          ? { ...row, source: "everyone", roles: [guildId] }
          : row,
      ),
      neverNeeded: [{ permission: "ManageMessages", roles: [ROLE.bot] }],
      missing: { ...healthy.missing, channels: [CHANNEL.ledger] },
      missingCount: 1,
    },
    false,
  );
}

/**
 * --state-checks=fail's view, without Administrator: Attach Files missing, TaruBot's role below FC
 * Leader and Officer, and the officer notifications channel denied to it on purpose. missingCount
 * counts that denied channel; at 0 the checklist would report every channel visible.
 */
function failingView(): VisibilityReport {
  const healthy = visibilityReport({}, false);
  return visibilityReport(
    {
      core: healthy.core.map((row) =>
        row.permission === "AttachFiles" ? { ...row, source: "missing" } : row,
      ),
      roleOrder: { highest: ROLE.bot, notBelow: [ROLE.leader, ROLE.officer], throughShared: [] },
      denied: [CHANNEL.notices],
      missingCount: 1,
    },
    false,
  );
}

/**
 * --state-checks=fail's resource checks, as Service.validate stores each Failure message: the
 * gateway's own wording for a role above TaruBot's and for a channel it can't view.
 */
const failingCapabilities = (): Readonly<Record<string, string>> => {
  const role = (id: string) =>
    `TaruBot can't manage <@&${id}>. Its own role must be above that role, and it needs Manage Roles.`;
  return {
    leader_role_id: role(ROLE.leader),
    officer_role_id: role(ROLE.officer),
    officer_notifications_channel_id: `TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#${CHANNEL.notices}>, and it must be a text channel in this server.`,
  };
};

/**
 * Server configuration's report for `guildId`, from the existing invented configuration fixtures:
 * by default a live server without onboarding whose roster was read 12 minutes ago (see
 * rosterMinutes). A failed roster attempt is the bare code Synchronization.roster stores.
 */
export function harnessReport(
  guildId: string,
  states: HarnessStates,
  menus: HarnessMenus = new Map(),
): ConfigurationReport {
  const cooling = lodestoneCooling(states);
  const failedAttempt = cooling || states.checks !== undefined;
  // --state-menu-problems' TaruBot holds Administrator (harnessSnapshot), which the Role menu page
  // warns about; its report says so too, unless a --state-checks view replaces it.
  const administrator =
    states.menuProblems && !states.checks
      ? {
          visibility: visibilityReport(
            { administrator: { held: true, roles: [ROLE.bot], shared: [] } },
            false,
          ),
        }
      : {};
  return configReport({
    guild: configGuild({
      id: guildId,
      access_policy_enabled: false,
      lobby_channel_id: null,
      officer_channel_id: null,
      // An imported server keeps Discord changes off, and grandfathers Guests once activated.
      ...(states.activation && { effects_enabled: false, guest_grandfather: "pending" as const }),
      ...(states.hostileNames && { officer_rank_name: HOSTILE_NAMES.rank }),
    }),
    // Otherwise configReport derives it from the guild, as Service.effectsMode does.
    ...(states.deploymentDisabled && { effectsMode: "deployment_disabled" as const }),
    ...(states.checks === "fail" && { capabilities: failingCapabilities() }),
    fc: fcRow({
      ...(states.hostileNames && HOSTILE_NAMES.fc),
      last_successful_roster_at: minutesAgo(rosterMinutes(states)),
      last_attempt_at: failedAttempt ? minutesAgo(cooling ? 1 : 20) : minutesAgo(12),
      ...(failedAttempt && {
        last_error: cooling ? "rate_limited" : "unavailable",
        attemptFailed: true,
      }),
      ...(states.checks && { fresh: false }),
    }),
    ...(states.checks && {
      visibility: states.checks === "warn" ? warningView(guildId) : failingView(),
    }),
    ...administrator,
    // The "Role menu" check over the menu the Role menu page shows (edits included) and the same
    // invented server, as Service.validate judges it.
    selfRoles: selfRoleHealth(
      savedMenu(guildId, states, menus).menu,
      harnessSnapshot(guildId, states),
      HARNESS_MENU_SETTINGS,
    ),
  });
}

// ---------------------------------------------------------------------------------------------
// The Role menu (2.39.0): an invented server for the rule set, and the officers' saved menu

/** The Role menu's invented roles: on the menu, addable, and refused for each kind of reason. */
export const MENU_ROLE = {
  heHim: "400000000000000001",
  sheHer: "400000000000000002",
  theyThem: "400000000000000003",
  askMe: "400000000000000004",
  valheim: "400000000000000005",
  minecraft: "400000000000000006",
  savage: "400000000000000007",
  maps: "400000000000000008",
  mahjong: "400000000000000009",
  halloween: "400000000000000010",
  healer: "400000000000000011",
  tank: "400000000000000012",
  dps: "400000000000000013",
  moderator: "400000000000000014",
  announcer: "400000000000000015",
  council: "400000000000000016",
  dyno: "400000000000000017",
  booster: "400000000000000018",
} as const;

const MENU_ROLE_NAMES: Readonly<Record<keyof typeof MENU_ROLE, string>> = {
  heHim: "He/Him",
  sheHer: "She/Her",
  theyThem: "They/Them",
  askMe: "Ask my pronouns",
  valheim: "Valheim",
  minecraft: "Minecraft",
  savage: "Savage raiding",
  maps: "Treasure maps",
  mahjong: "Mahjong night",
  halloween: "Halloween 2025",
  healer: "Healer",
  tank: "Tank",
  dps: "DPS",
  moderator: "Moderator",
  announcer: "Announcer",
  council: "Council",
  dyno: "Dyno",
  booster: "Server Booster",
};

/** The Role menu's invented channels; the two hidden ones exist only under --state-menu-problems. */
export const MENU_CHANNEL = {
  general: "500000000000000001",
  announcements: "500000000000000002",
  valheim: "500000000000000003",
  valheimVoice: "500000000000000004",
  minecraft: "500000000000000005",
  council: "500000000000000006",
  hiddenOne: "500000000000000007",
  hiddenTwo: "500000000000000008",
} as const;

const MENU_CHANNEL_NAMES: Readonly<Record<keyof typeof MENU_CHANNEL, string>> = {
  general: "general",
  announcements: "announcements",
  valheim: "valheim",
  valheimVoice: "valheim-voice",
  minecraft: "minecraft",
  council: "council",
  hiddenOne: "hidden-one",
  hiddenTwo: "hidden-two",
};

/** The menu's category IDs: UUIDs, as the page mints them. */
export const MENU_CATEGORY = {
  pronouns: "6f9619ff-8b86-4011-b42d-00c04fc964ff",
  games: "0b6f3c2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  content: "1e2d3c4b-5a69-4788-9a6b-5c4d3e2f1a0b",
  retired: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
} as const;

/** The saved menu's revision before any edit in a harness run. */
export const MENU_REVISION = 7n;

/** The officers' saved menu: two published categories, a draft, and one no longer offered. */
export const HARNESS_MENU: SelfRoleMenu = {
  v: 1,
  categories: [
    {
      id: MENU_CATEGORY.pronouns,
      name: "Pronouns",
      description: "Shown on your profile, so people know how to refer to you.",
      max: null,
      state: "published",
      options: [
        { roleId: MENU_ROLE.heHim, description: "", removalOnly: false },
        { roleId: MENU_ROLE.sheHer, description: "", removalOnly: false },
        { roleId: MENU_ROLE.theyThem, description: "", removalOnly: false },
        {
          roleId: MENU_ROLE.askMe,
          description: "Replaced by your profile's own pronouns field.",
          removalOnly: true,
        },
      ],
    },
    {
      id: MENU_CATEGORY.games,
      name: "Games",
      description: "Each game's role opens its channels.",
      max: null,
      state: "published",
      options: [
        { roleId: MENU_ROLE.valheim, description: "Our dedicated server.", removalOnly: false },
        {
          roleId: MENU_ROLE.minecraft,
          description: "The FC's survival world.",
          removalOnly: false,
        },
      ],
    },
    {
      id: MENU_CATEGORY.content,
      name: "Content",
      description: "What you'd like to be pinged for.",
      max: 2,
      state: "draft",
      options: [
        { roleId: MENU_ROLE.savage, description: "Weekly static nights.", removalOnly: false },
        { roleId: MENU_ROLE.maps, description: "", removalOnly: false },
        { roleId: MENU_ROLE.mahjong, description: "Doman Mahjong on Fridays.", removalOnly: false },
      ],
    },
    {
      id: MENU_CATEGORY.retired,
      name: "Retired events",
      description: "Event roles from past seasons.",
      max: 1,
      state: "removal_only",
      options: [{ roleId: MENU_ROLE.halloween, description: "", removalOnly: false }],
    },
  ],
};

/** Second FC's menu's category IDs, visibly invented. */
export const SECOND_CATEGORY = {
  mainRole: "00000000-0000-4000-8000-000000000201",
  pronouns: "00000000-0000-4000-8000-000000000202",
} as const;

/**
 * Second FC's own menu (2.40.0), where nobody is an officer, so only My roles reads it: a pick-one
 * category, whose radios start with "No role from this category", and pronouns.
 */
export const SECOND_MENU: SelfRoleMenu = {
  v: 1,
  categories: [
    {
      id: SECOND_CATEGORY.mainRole,
      name: "Main role",
      description: "What you usually play in duties.",
      max: 1,
      state: "published",
      options: [
        { roleId: MENU_ROLE.healer, description: "", removalOnly: false },
        { roleId: MENU_ROLE.tank, description: "", removalOnly: false },
        { roleId: MENU_ROLE.dps, description: "Melee, ranged or caster.", removalOnly: false },
      ],
    },
    {
      id: SECOND_CATEGORY.pronouns,
      name: "Pronouns",
      description: "",
      max: null,
      state: "published",
      options: [
        { roleId: MENU_ROLE.heHim, description: "", removalOnly: false },
        { roleId: MENU_ROLE.sheHer, description: "", removalOnly: false },
        { roleId: MENU_ROLE.theyThem, description: "", removalOnly: false },
      ],
    },
  ],
};

const P = PermissionFlagsBits;
/** A typical @everyone: view, post, react, embed, attach, read history, join and speak in voice. */
const EVERYONE_BITS =
  P.ViewChannel |
  P.SendMessages |
  P.AddReactions |
  P.EmbedLinks |
  P.AttachFiles |
  P.ReadMessageHistory |
  P.UseApplicationCommands |
  P.Connect |
  P.Speak |
  P.CreateInstantInvite |
  P.ChangeNickname;

/** TaruBot's own role: what onboarding and the role checks need, Administrator only on demand. */
const botRolePermissions = (administrator: boolean): bigint =>
  P.ManageRoles |
  P.ManageChannels |
  P.ManageNicknames |
  EVERYONE_BITS |
  (administrator ? P.Administrator : 0n);

/** A raw role in the snapshot. */
const apiRole = (
  id: string,
  name: string,
  position: number,
  permissions = 0n,
  managed = false,
): ApiRole => ({ id, name, position, permissions: String(permissions), hoist: false, managed });

/** A raw overwrite on a role (type 0). */
const roleOverwrite = (id: string, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type: 0,
  allow: String(allow),
  deny: String(deny),
});

/**
 * The Role menu's server as the gateway cache would hold it (src/domain/visibility.ts's
 * VisibilityGuild), for TaruBot in `guildId`: the configuration fixtures' access roles and
 * TaruBot's role, the menu's roles below them, and channels each of which shows one rule. Healthy
 * by default; --state-menu-problems makes the drift its header line describes.
 */
export function harnessSnapshot(guildId: string, states: HarnessStates = {}): VisibilityGuild {
  const problems = states.menuProblems === true;
  const role = (key: keyof typeof MENU_ROLE, position: number, permissions = 0n, managed = false) =>
    apiRole(MENU_ROLE[key], MENU_ROLE_NAMES[key], position, permissions, managed);
  const roles: ApiRole[] = [
    apiRole(guildId, "@everyone", 0, EVERYONE_BITS),
    role("heHim", 1),
    role("sheHer", 2, problems ? P.MentionEveryone : 0n),
    // Dragged above the moderation roles in Discord: whoever picks it would be out of their reach.
    role("theyThem", problems ? 19 : 3),
    role("askMe", 4),
    role("valheim", 5),
    role("minecraft", 6),
    role("savage", 7),
    role("maps", 8),
    // Moved above TaruBot's role in Discord, out of TaruBot's reach.
    role("mahjong", problems ? 40 : 9),
    // Deleted in Discord: still on the menu, missing here.
    ...(problems ? [] : [role("halloween", 10)]),
    role("healer", 11),
    role("tank", 12),
    role("dps", 13),
    role("announcer", 14),
    role("council", 15),
    // The moderation roles, which every menu role must sit below, a moderation bot's included.
    role("moderator", 16, P.KickMembers | P.BanMembers | P.ManageMessages | P.ModerateMembers),
    role("booster", 17, 0n, true),
    role(
      "dyno",
      18,
      P.KickMembers | P.BanMembers | P.ModerateMembers | P.ManageRoles | P.ManageMessages,
      true,
    ),
    apiRole(ROLE.guest, "Guest", 20),
    apiRole(ROLE.member, "Member", 21),
    apiRole(ROLE.officer, "Officer", 22, P.KickMembers | P.ManageMessages | P.ModerateMembers),
    apiRole(ROLE.leader, "FC Leader", 23, P.ManageGuild | P.KickMembers | P.BanMembers),
    apiRole(ROLE.bot, "TaruBot", 30, botRolePermissions(problems), true),
  ];
  const channel = (
    key: keyof typeof MENU_CHANNEL,
    position: number,
    overwrites: ApiOverwrite[] = [],
    type: number = ChannelType.GuildText,
    obfuscated = false,
  ): VisibilityChannel => ({
    id: MENU_CHANNEL[key],
    type,
    parentId: null,
    position,
    overwrites,
    obfuscated,
  });
  /** @everyone can't see the channel. */
  const hidden = roleOverwrite(guildId, 0n, P.ViewChannel);
  const channels: VisibilityChannel[] = [
    channel("general", 0),
    // Everyone reads announcements; only staff post. Announcer's Send Messages allow is refused.
    channel("announcements", 1, [
      roleOverwrite(guildId, 0n, P.SendMessages),
      roleOverwrite(MENU_ROLE.announcer, P.SendMessages),
    ]),
    // A game role opens its channels, carrying only @everyone's own permissions there.
    channel("valheim", 2, [
      hidden,
      roleOverwrite(MENU_ROLE.valheim, P.ViewChannel | (problems ? P.ManageMessages : 0n)),
    ]),
    channel(
      "valheimVoice",
      3,
      [hidden, roleOverwrite(MENU_ROLE.valheim, P.ViewChannel | P.Connect | P.Speak)],
      ChannelType.GuildVoice,
    ),
    channel("minecraft", 4, [hidden, roleOverwrite(MENU_ROLE.minecraft, P.ViewChannel)]),
    // The officers' room: a role that opens it is refused, as an officer channel.
    channel("council", 5, [
      hidden,
      roleOverwrite(ROLE.officer, P.ViewChannel),
      roleOverwrite(MENU_ROLE.council, P.ViewChannel),
    ]),
    // Channels hidden from TaruBot on purpose (#46): it can't tell what a role does there.
    ...(problems
      ? [
          channel("hiddenOne", 6, [hidden], ChannelType.GuildText, true),
          channel("hiddenTwo", 7, [hidden], ChannelType.GuildText, true),
        ]
      : []),
  ];
  return {
    guildId,
    bot: { id: HARNESS_CLIENT_ID, roles: [ROLE.bot], botRoleId: ROLE.bot },
    roles,
    channels,
    heldRoles: [],
  };
}

/** One server's saved menu: the document (null when this build can't read it) and its revision. */
export interface HarnessMenu {
  menu: SelfRoleMenu | null;
  revision: bigint;
}

/** Saved menus by server ID; a server not in it starts from the review state's menu. */
export type HarnessMenus = Map<string, HarnessMenu>;

/** The rules' settings in the harness: the configuration fixtures' four bound roles, nothing else. */
const HARNESS_MENU_SETTINGS: SelfRoleSettings = selfRoleSettings(
  configGuild({ officer_channel_id: null }),
  [],
  [],
);

/**
 * One server's saved menu in `menus`, starting from the review state's menu: the officer's servers
 * have HARNESS_MENU, and Second FC, where nobody is an officer, SECOND_MENU.
 */
function savedMenu(guildId: string, states: HarnessStates, menus: HarnessMenus): HarnessMenu {
  let entry = menus.get(guildId);
  if (!entry) {
    const menu = officerGuilds(states).has(guildId) ? HARNESS_MENU : SECOND_MENU;
    entry = { menu: states.menuUnreadable ? null : menu, revision: MENU_REVISION };
    menus.set(guildId, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------------------------
// My roles (2.40.0): the menu roles each account holds, and each person's newest change

/**
 * The invented menu roles each account holds in Discord, by server ID then user ID. Each shows
 * something: in Example FC the member holds a role no longer offered (Ask my pronouns) and one
 * in a category no longer offered (Halloween 2025), and the officer one in the Content draft; in
 * Second FC the member holds two roles of the pick-one Main role (Dyno leftovers).
 */
export const HELD: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  [HARNESS_GUILDS.example.id]: {
    [HARNESS_ACCOUNTS.officer.id]: [MENU_ROLE.theyThem, MENU_ROLE.valheim, MENU_ROLE.savage],
    [HARNESS_ACCOUNTS.member.id]: [
      MENU_ROLE.sheHer,
      MENU_ROLE.askMe,
      MENU_ROLE.valheim,
      MENU_ROLE.halloween,
    ],
    [HARNESS_ACCOUNTS.guest.id]: [MENU_ROLE.heHim, MENU_ROLE.minecraft],
    [HARNESS_ACCOUNTS.timedOut.id]: [MENU_ROLE.sheHer, MENU_ROLE.valheim],
  },
  [HARNESS_GUILDS.second.id]: {
    [HARNESS_ACCOUNTS.officer.id]: [MENU_ROLE.heHim],
    [HARNESS_ACCOUNTS.member.id]: [MENU_ROLE.healer, MENU_ROLE.tank, MENU_ROLE.sheHer],
  },
};

/** A person's newest roles.self job, as the harness keeps it (the jobs row's parts My roles reads). */
export interface HarnessJob {
  status: "queued" | "blocked" | "disabled" | "succeeded" | "failed";
  /** The change's role IDs, only while it waits: migration 012's trigger clears them at the end. */
  payload: RoleChoicePayload | null;
  /** Counts and fixed reasons only, as RoleChoiceJob.apply and the expiry write them. */
  result:
    | {
        readonly status: "applied";
        readonly added: number;
        readonly removed: number;
        readonly skipped: number;
      }
    | { readonly skipped: string }
    | null;
  /** The latest save and the end, on the harness clock (milliseconds). */
  savedAt: number;
  completedAt: number | null;
  /** A --state-roles sample, which the fake worker leaves as it is. */
  readonly sample: boolean;
}

/** My roles' side of the harness: who holds which menu roles now, and each person's newest change. */
export interface HarnessPeople {
  /** Menu roles held, by `<guild>:<user>`; a person not in it starts from HELD. */
  readonly held: Map<string, Set<string>>;
  /** Each person's newest change, by `<guild>:<user>`. */
  readonly jobs: Map<string, HarnessJob>;
  /** The harness clock, in milliseconds. */
  readonly now: () => number;
}

/** A fresh HarnessPeople on `now` (the wall clock by default). */
export const harnessPeople = (now: () => number = Date.now): HarnessPeople => ({
  held: new Map(),
  jobs: new Map(),
  now,
});

/** How long after a save the fake worker applies it: long enough to see "Saved…" first. */
export const HARNESS_APPLY_MS = 2_000;

/** A finished change still counts as recent this long (SelfRoles.view's 10 minutes). */
const RECENT_MS = 10 * 60_000;

/** The states a change waits in (SelfRoles' WAITING_STATES; nothing runs here, so no "running"). */
const WAITING: ReadonlySet<HarnessJob["status"]> = new Set(["queued", "blocked", "disabled"]);

/**
 * --state-roles' sample change for one person: a waiting change that asks for Minecraft instead of
 * Valheim (parked while Discord changes are paused, as the dispatcher's effects gate parks it), or
 * a finished one as each end writes it.
 */
function sampleJob(state: HarnessRolesState, states: HarnessStates, now: number): HarnessJob {
  const savedAt = now - 5 * 60_000;
  const waiting: RoleChoicePayload = {
    chosen: [MENU_ROLE.minecraft],
    offered: [MENU_ROLE.valheim, MENU_ROLE.minecraft],
    savedAt: new Date(savedAt).toISOString(),
  };
  const job = { savedAt, completedAt: null, result: null, payload: null, sample: true };
  switch (state) {
    case "queued":
      return {
        ...job,
        status: harnessEffects(states) === "live" ? "queued" : "disabled",
        payload: waiting,
      };
    case "blocked":
      return { ...job, status: "blocked", payload: waiting };
    case "failed":
      return { ...job, status: "failed", completedAt: now - 20 * 60_000 };
    case "skipped":
      return {
        ...job,
        status: "succeeded",
        completedAt: now - 2 * 60_000,
        result: { status: "applied", added: 1, removed: 0, skipped: 2 },
      };
    case "expired":
      return {
        ...job,
        savedAt: now - 8 * 24 * 60 * 60_000,
        status: "succeeded",
        completedAt: now - 24 * 60 * 60_000,
        result: { skipped: "expired" },
      };
  }
}

/** The banner state SelfRoles.view derives from a job row (its choiceStatus). */
function jobStatus(job: HarnessJob | undefined, now: number): RoleChoiceStatus | null {
  if (!job) return null;
  const recent = job.completedAt !== null && now - job.completedAt < RECENT_MS;
  const completedAt = job.completedAt === null ? null : new Date(job.completedAt);
  const waiting = { skipped: 0, changed: false, recent: false, completedAt: null };
  switch (job.status) {
    case "queued":
      return { state: "waiting", ...waiting };
    case "disabled":
      return { state: "paused", ...waiting };
    case "blocked":
      return { state: "blocked", ...waiting };
    case "failed":
      return { state: "failed", skipped: 0, changed: false, recent, completedAt };
    case "succeeded": {
      const result = job.result;
      if (result && "status" in result)
        return {
          state: "applied",
          skipped: result.skipped,
          changed: result.added + result.removed > 0,
          recent,
          completedAt,
        };
      return {
        state: result?.skipped === "expired" ? "expired" : "dropped",
        skipped: 0,
        changed: false,
        recent,
        completedAt,
      };
    }
  }
}

/**
 * The SelfRoles service over invented data: editor() and edit() as src/application/self-roles.ts
 * has them, with an in-memory menu per server in `menus` instead of PostgreSQL and the invented
 * snapshot instead of Discord. The order of checks and the outcomes are the real operation's: an
 * unreadable menu refuses all but a reset, the equal-state rule answers before the revision check,
 * a reset of a menu that reads fine is a conflict, and an add passes the rule set and the channel
 * confirmation. Nothing is audited.
 *
 * view() and choose() (2.40.0) over `people`: the real domain rules in the real order (access, a
 * time-out, Discord changes paused, changedCategories, the merge into a waiting change and the
 * equal-state rules), with the person's held menu roles from `people` (HELD at first) in place of
 * Discord. A saved change waits HARNESS_APPLY_MS on `people.now`, then the next read applies it as
 * the roles.self job would: planSelfRoles over the menu as it is then, each role checked again on
 * the snapshot, results in counts. Under --state-roles=blocked it blocks instead, and while
 * Discord changes are paused it parks.
 */
export function harnessSelfRoles(
  states: HarnessStates = {},
  menus: HarnessMenus = new Map(),
  people: HarnessPeople = harnessPeople(),
) {
  const roles: unknown = Object.create(SelfRoles.prototype);
  if (!(roles instanceof SelfRoles)) throw new Error("Invalid self-roles fake");
  const settings = HARNESS_MENU_SETTINGS;
  const saved = (guildId: string): HarnessMenu => savedMenu(guildId, states, menus);
  roles.editor = async (actor: Actor): Promise<SelfRoleEditor> => {
    authorize(actor, actor.guildId, "officer");
    const { menu, revision } = saved(actor.guildId);
    const snapshot = harnessSnapshot(actor.guildId, states);
    return {
      guildId: actor.guildId,
      configured: true,
      revision,
      menu,
      roles: checkRoles(snapshot, settings, menu ? menuRoleIds(menu) : []),
      unreadableChannels: unreadableChannels(snapshot),
      administrator: holdsAdministrator(snapshot),
      memberRoleId: ROLE.member,
      guestRoleId: ROLE.guest,
      onboarding: false,
      effectsMode: harnessEffects(states),
    };
  };
  roles.edit = async (actor, request): Promise<SelfRoleEditOutcome> => {
    authorize(actor, actor.guildId, "officer");
    const entry = saved(actor.guildId);
    const { operation } = request;
    const current = entry.menu;
    if (!current && operation.op !== "menu.reset")
      return { status: "conflict", reason: "unreadable" };
    const applied = applyOperation(current ?? EMPTY_MENU, operation);
    if (applied.kind === "gone") return { status: "conflict", reason: "changed" };
    if (applied.kind === "invalid") return { status: "invalid", errors: applied.errors };
    if (current && sameMenu(applied.menu, current))
      return { status: "unchanged", revision: entry.revision };
    if (operation.op === "menu.reset" && current) return { status: "conflict", reason: "changed" };
    if (entry.revision !== request.revision) return { status: "conflict", reason: "changed" };
    if (operation.op === "options.add" && current) {
      const snapshot = harnessSnapshot(actor.guildId, states);
      const had = new Set(menuRoleIds(current));
      const check = selfRoleChecker(snapshot, settings);
      const errors: MenuFieldError[] = [];
      for (const roleId of menuRoleIds(applied.menu).filter((id) => !had.has(id))) {
        const [problem] = check(roleId).problems;
        if (problem)
          errors.push({
            field: "roleIds",
            message: SELF_ROLE_MESSAGES.refusedRole(roleId, problem),
          });
      }
      const unreadable = unreadableChannels(snapshot);
      if (unreadable > 0 && !operation.unreadableAcknowledged)
        errors.push({ field: "acknowledged", message: SELF_ROLE_MESSAGES.acknowledge(unreadable) });
      if (errors.length > 0) return { status: "invalid", errors };
    }
    entry.menu = applied.menu;
    entry.revision += 1n;
    return { status: "saved", revision: entry.revision };
  };

  const key = (guildId: string, userId: string): string => `${guildId}:${userId}`;
  /** The menu roles a person holds now, starting from HELD. */
  const heldBy = (guildId: string, userId: string): Set<string> => {
    const at = key(guildId, userId);
    let held = people.held.get(at);
    if (!held) {
      held = new Set(HELD[guildId]?.[userId] ?? []);
      people.held.set(at, held);
    }
    return held;
  };
  /** The roles.self job for a change due now: RoleChoiceJob.apply's plan, checks and counts. */
  const work = (guildId: string, userId: string, job: HarnessJob): void => {
    if (harnessEffects(states) !== "live") {
      job.status = "disabled";
      return;
    }
    if (states.roles === "blocked") {
      job.status = "blocked";
      return;
    }
    const held = heldBy(guildId, userId);
    const bound = Object.values(settings.boundRoles).filter((id): id is string => id !== null);
    const plan = job.payload
      ? planSelfRoles(
          job.payload,
          saved(guildId).menu,
          [...held],
          new Set([...bound, ...settings.retiredRoles]),
        )
      : { add: [], remove: [], skipped: 0 };
    const snapshot = harnessSnapshot(guildId, states);
    // As RoleChoiceJob.apply: without Manage Roles the whole change waits as blocked.
    if ((plan.add.length > 0 || plan.remove.length > 0) && !botManagesRoles(snapshot)) {
      job.status = "blocked";
      return;
    }
    const check = selfRoleChecker(snapshot, settings);
    const add = plan.add.filter((roleId) => check(roleId).problems.length === 0);
    const remove = plan.remove.filter((roleId) => removableBy(check(roleId)));
    for (const roleId of add) held.add(roleId);
    for (const roleId of remove) held.delete(roleId);
    job.status = "succeeded";
    job.payload = null;
    job.completedAt = people.now();
    job.result = {
      status: "applied",
      added: add.length,
      removed: remove.length,
      skipped: plan.skipped + plan.add.length - add.length + plan.remove.length - remove.length,
    };
  };
  /** The person's newest change, after the fake worker had its turn (and the sample, if any). */
  const newest = (guildId: string, userId: string): HarnessJob | undefined => {
    const at = key(guildId, userId);
    let job = people.jobs.get(at);
    if (!job && states.roles) {
      job = sampleJob(states.roles, states, people.now());
      people.jobs.set(at, job);
    }
    if (
      job &&
      !job.sample &&
      job.status === "queued" &&
      people.now() >= job.savedAt + HARNESS_APPLY_MS
    )
      work(guildId, userId, job);
    return job;
  };
  /** SelfRoles' refusal for anyone without self-service access. */
  const admitted = (actor: Actor): void => {
    authorize(actor, actor.guildId, "user");
    if (!selfServiceAccess(actor)) throw new Failure("forbidden", CHOICE_MESSAGES.noAccess);
  };
  roles.view = async (actor: Actor): Promise<MyRoles> => {
    admitted(actor);
    const { menu } = saved(actor.guildId);
    const snapshot = harnessSnapshot(actor.guildId, states);
    const job = newest(actor.guildId, actor.userId);
    const effectsMode = harnessEffects(states);
    const timedOut = actor.timedOut === true;
    return {
      guildId: actor.guildId,
      configured: true,
      unreadableMenu: menu === null,
      available: true,
      offers: offersRoles(menu),
      categories: menu
        ? choiceMenu(menu, {
            held: [...heldBy(actor.guildId, actor.userId)],
            waiting: job && WAITING.has(job.status) ? job.payload : null,
            check: selfRoleChecker(snapshot, settings),
            officer: actor.officer,
          })
        : [],
      status: jobStatus(job, people.now()),
      effectsMode,
      timedOut,
      canSave: effectsMode === "live" && !timedOut,
      administrator: actor.officer ? holdsAdministrator(snapshot) : null,
      roleNames: menuRoleNames(menu, snapshot),
    };
  };
  roles.choose = async (actor, request): Promise<RoleChoiceOutcome> => {
    admitted(actor);
    if (actor.timedOut === true) throw new Failure("forbidden", CHOICE_MESSAGES.timedOut);
    if (harnessEffects(states) !== "live") throw new Failure("disabled", CHOICE_MESSAGES.paused);
    const { menu } = saved(actor.guildId);
    const held = [...heldBy(actor.guildId, actor.userId)];
    const change = changedCategories(
      menu ?? EMPTY_MENU,
      held,
      selfRoleChecker(harnessSnapshot(actor.guildId, states), settings),
      request.categories,
    );
    if (change.kind === "conflict") return { status: "conflict" };
    if (change.kind === "invalid") return { status: "invalid", errors: change.errors };
    if (change.choice.offered.length === 0) return { status: "unchanged" };
    const job = newest(actor.guildId, actor.userId);
    const row = job && WAITING.has(job.status) ? job : undefined;
    const waiting = row?.payload ?? null;
    const merged = mergeChoice(waiting, change.choice, menu);
    if (waiting && sameChoice(merged, waiting)) return { status: "saved" };
    if (!row && choiceHeld(merged, held)) return { status: "unchanged" };
    const now = people.now();
    people.jobs.set(key(actor.guildId, actor.userId), {
      status: "queued",
      payload: roleChoicePayload.parse({
        chosen: merged.chosen,
        offered: merged.offered,
        savedAt: new Date(now).toISOString(),
      }),
      result: null,
      savedAt: now,
      completedAt: null,
      sample: false,
    });
    return { status: "saved" };
  };
  return roles;
}

/**
 * The dashboard's services, answered with the existing invented configuration fixtures, and the
 * in-memory SelfRoles of Role menu and My roles.
 */
function harnessServices(states: HarnessStates, statusNow: () => Date): Services {
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fake");
  // One saved menu per server for Role menu, My roles and the health check on Server
  // configuration.
  const menus: HarnessMenus = new Map();
  app.syncStatus = async () => syncView(states);
  app.validate = async (actor) => harnessReport(actor.guildId, states, menus);
  const lifecycle: unknown = Object.create(ApplicationLifecycle.prototype);
  if (!(lifecycle instanceof ApplicationLifecycle)) throw new Error("Invalid lifecycle fake");
  // A disconnected gateway also fails readiness, as ApplicationLifecycle.status computes it. The
  // cooldown is what the gate has left of a fourth strike's 120 s, a minute after it began.
  const disconnected = states.checks === "fail";
  const cooling = lodestoneCooling(states);
  lifecycle.status = () => ({
    live: true,
    ready: !disconnected,
    database: true,
    writerLease: true,
    discord: !disconnected,
    effects: !states.deploymentDisabled,
    publicTestResponses: false,
    capabilities: null,
    lodestone: {
      parsing: 0,
      waiting: cooling ? 1 : 0,
      cooldownSeconds: cooling ? 60 : 0,
      strikes: cooling ? 4 : 0,
      selectors: {
        repository: "xivapi/lodestone-css-selectors",
        revision: "invented",
        source: "bundled",
        activatedAt: null,
        bundled: "invented",
      },
      upstream: { status: "current", checkedAt: null, components: [] },
    },
    visibility: { missing: null, onboardingPending: null, checked: null, checkedAt: null },
  });
  return new Services()
    .provide(applicationKey, app)
    .provide(lifecycleKey, lifecycle)
    .provide(gatewayKey, harnessGateway(states))
    .provide(selfRolesKey, harnessSelfRoles(states, menus, harnessPeople()))
    .provide(
      publicStatusKey,
      harnessStatus(states, () => lifecycle.status(), statusNow),
    );
}

/**
 * The status page's PublicStatus (2.41.0) over the harness's state: readiness from the lifecycle
 * fake, the Lodestone unanswered under --state-checks=fail, Discord changes paused whenever the
 * effects mode isn't live, and an in-memory store filled with --state-history's history up to
 * `now`, its clock (the wall clock by default). Not started: startHarness starts it before the
 * web, as main.ts does, and stops it with the web.
 */
export function harnessStatus(
  states: HarnessStates = {},
  readiness: () => ReturnType<ApplicationLifecycle["status"]>,
  now: () => Date = () => new Date(),
  samples: MemoryStatusSamples = new MemoryStatusSamples(),
): PublicStatus {
  fillHistory(samples, now(), states.history);
  return new PublicStatus(
    {
      readiness,
      lodestoneFailing: () => states.checks === "fail",
      changesPaused: async () => harnessEffects(states) !== "live",
      samples,
    },
    { now },
  );
}

/**
 * The fake authorize page. GET /oauth2/authorize keeps the request under an ID it makes and shows
 * one link per invented account (and Cancel); following one issues FakeDiscord's code and sends
 * the browser to the configured redirect URI. Any other redirect URI is refused.
 */
function authorizePage(discord: FakeDiscord, redirectUri: string) {
  /** Authorize requests waiting for an account choice, by the page's own ID; each is single-use. */
  const pending = new Map<string, URL>();
  const page = (status: number, body: string) =>
    new Response(`<!doctype html><html lang="en"><title>Fake Discord</title><body>${body}</body>`, {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (url.pathname === "/oauth2/authorize") {
      if (url.searchParams.get("redirect_uri") !== redirectUri)
        return page(400, "<p>This fake answers only the harness's own redirect URI.</p>");
      const id = randomUUID();
      pending.set(id, url);
      const links = Object.entries(HARNESS_ACCOUNTS).map(
        ([key, account]) => `<li><a href="/oauth2/approve/${id}/${key}">${account.label}</a></li>`,
      );
      return page(
        200,
        `<h1>Fake Discord: sign in as</h1><ul>${links.join("")}</ul><p><a href="/oauth2/cancel/${id}">Cancel</a></p>`,
      );
    }
    const [, scope, action, id = "", key = ""] = url.pathname.split("/");
    const authorize = scope === "oauth2" ? pending.get(id) : undefined;
    if (!authorize) return page(404, "<p>Not found.</p>");
    pending.delete(id);
    if (action === "cancel") return Response.redirect(discord.cancel(authorize).href, 302);
    const account: DiscordAccount | undefined =
      action === "approve" && Object.hasOwn(HARNESS_ACCOUNTS, key)
        ? HARNESS_ACCOUNTS[key as HarnessAccount]
        : undefined;
    if (!account) return page(404, "<p>Not found.</p>");
    return Response.redirect(discord.authorize(authorize, account).href, 302);
  };
}

/** Choose a free origin on the selected interface before startWeb uses it for redirects. */
async function freeOrigin(hostname: string, tls: WebOptions["tls"]): Promise<string> {
  const probe = Bun.serve({
    hostname,
    ...(tls && { tls }),
    port: 0,
    fetch: () => new Response(null),
  });
  const origin = probe.url.origin;
  await probe.stop(true);
  return origin;
}

/** startHarness's options: where it listens, and the review states (none unless given). */
export type HarnessOptions = Pick<WebOptions, "hostname" | "tls" | "port"> & {
  readonly publicOrigin?: string;
  readonly states?: HarnessStates;
  /**
   * The status page's clock (2.41.0), for its invented history and its snapshots; the wall clock
   * by default. Tests pin it so what the page shows doesn't depend on the time of day.
   */
  readonly statusNow?: () => Date;
};

/** Default loopback harness; a public origin and private port also exercise real reverse proxies. */
export async function startHarness(
  options: HarnessOptions = {},
  log: Logger = pino({ level: "silent" }),
): Promise<Harness> {
  const states = options.states ?? {};
  const discord = new FakeDiscord(HARNESS_CLIENT_ID, HARNESS_CLIENT_SECRET);
  const hostname = options.hostname ?? "::1";
  const listenerOrigin = await freeOrigin(hostname, options.tls);
  const origin = options.publicOrigin ?? listenerOrigin;
  const port = options.port ?? Number(new URL(listenerOrigin).port);
  const authorize = Bun.serve({
    hostname,
    ...(options.tls && { tls: options.tls }),
    port: 0,
    development: false,
    fetch: authorizePage(discord, `${new URL(origin).origin}/auth/callback`),
  });
  const reporter = createReporter(log);
  const services = harnessServices(states, options.statusNow ?? (() => new Date()));
  const status = services.get(publicStatusKey);
  status.start();
  let web: WebServer | null = null;
  try {
    web = await startWeb(
      {
        WEB_PUBLIC_ORIGIN: origin,
        WEB_PORT: String(port),
        DISCORD_CLIENT_SECRET: HARNESS_CLIENT_SECRET,
        DISCORD_APPLICATION_ID: HARNESS_CLIENT_ID,
      },
      {
        services,
        allowsGuild: () => true,
        isStopping: () => false,
        resolveActor: actorResolver(states),
        report: reporter,
        guilds: () => harnessGuilds(states),
      },
      log,
      {
        sessions: new MemorySessions(),
        fetch: discord.fetch,
        authorizeUrl: new URL("/oauth2/authorize", authorize.url).href,
        hostname,
        port,
        ...(options.tls && { tls: options.tls }),
      },
    );
  } finally {
    if (!web) {
      await status.stop();
      await authorize.stop(true);
    }
  }
  if (!web) throw new Error("The web didn't start; see the reported problem above");
  const running = web;
  return {
    url: new URL(origin),
    authorizeUrl: new URL("/oauth2/authorize", authorize.url),
    stop: async () => {
      await running.stop();
      await status.stop();
      await authorize.stop(true).catch(() => {});
    },
  };
}

/** The command line as startHarness options; throws on an unknown or incomplete flag. */
export function harnessOptions(args: readonly string[]): HarnessOptions {
  const { values } = parseArgs({
    args: [...args],
    options: {
      host: { type: "string", default: "::1" },
      cert: { type: "string" },
      key: { type: "string" },
      origin: { type: "string" },
      port: { type: "string" },
      "state-checks": { type: "string" },
      "state-activation": { type: "boolean", default: false },
      "state-deploy-disabled": { type: "boolean", default: false },
      "state-empty": { type: "boolean", default: false },
      "state-cooling": { type: "boolean", default: false },
      "state-hostile-names": { type: "boolean", default: false },
      "state-menu-problems": { type: "boolean", default: false },
      "state-menu-unreadable": { type: "boolean", default: false },
      "state-roles": { type: "string" },
      "state-history": { type: "string" },
    },
    allowPositionals: false,
  });
  if (Boolean(values.cert) !== Boolean(values.key))
    throw new Error("Pass --cert and --key together.");
  const checks = values["state-checks"];
  if (checks !== undefined && checks !== "warn" && checks !== "fail")
    throw new Error("Pass --state-checks=warn or --state-checks=fail.");
  const roles = values["state-roles"];
  const rolesState = HARNESS_ROLES_STATES.find((state) => state === roles);
  if (roles !== undefined && rolesState === undefined)
    throw new Error("Pass --state-roles=queued, blocked, failed, skipped or expired.");
  const history = values["state-history"];
  const historyState = HARNESS_HISTORIES.find((state) => state === history);
  if (history !== undefined && historyState === undefined)
    throw new Error("Pass --state-history=incidents or --state-history=new.");
  const tls =
    values.cert && values.key
      ? { cert: Bun.file(values.cert), key: Bun.file(values.key) }
      : undefined;
  return {
    hostname: values.host,
    ...(values.origin && { publicOrigin: values.origin }),
    ...(values.port && { port: Number(values.port) }),
    ...(tls && { tls }),
    states: {
      ...((checks === "warn" || checks === "fail") && { checks }),
      ...(values["state-activation"] && { activation: true }),
      ...(values["state-deploy-disabled"] && { deploymentDisabled: true }),
      ...(values["state-empty"] && { empty: true }),
      ...(values["state-cooling"] && { cooling: true }),
      ...(values["state-hostile-names"] && { hostileNames: true }),
      ...(values["state-menu-problems"] && { menuProblems: true }),
      ...(values["state-menu-unreadable"] && { menuUnreadable: true }),
      ...(rolesState && { roles: rolesState }),
      ...(historyState && { history: historyState }),
    },
  };
}

if (import.meta.main) {
  const options = harnessOptions(process.argv.slice(2));
  const log = pino({ level: "debug" });
  const harness = await startHarness(options, log);
  console.log(
    `TaruBot web harness: open ${harness.url.href} (fake Discord: ${harness.authorizeUrl.origin})`,
  );
  // Name each review state by the flag that turned it on, so the reviewer sees what is invented.
  const flags = {
    checks: "--state-checks",
    activation: "--state-activation",
    deploymentDisabled: "--state-deploy-disabled",
    empty: "--state-empty",
    cooling: "--state-cooling",
    hostileNames: "--state-hostile-names",
    menuProblems: "--state-menu-problems",
    menuUnreadable: "--state-menu-unreadable",
    roles: "--state-roles",
    history: "--state-history",
  } as const satisfies Record<keyof HarnessStates, string>;
  const states = Object.entries(options.states ?? {}).map(([state, value]) => {
    const flag = flags[state as keyof HarnessStates];
    return value === true ? flag : `${flag}=${String(value)}`;
  });
  if (states.length > 0) console.log(`Review states: ${states.join(" ")}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void harness.stop().then(() => process.exit(0));
    });
}
