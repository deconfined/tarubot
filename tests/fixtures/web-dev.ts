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
 * Every state is invented, and new IDs follow the harness's own 1000…/2000… pattern.
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
  Collection,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import { type Logger, pino } from "pino";
import { applicationKey, gatewayKey, lifecycleKey } from "../../src/application/keys.js";
import { ApplicationLifecycle } from "../../src/application/lifecycle.js";
import { createReporter } from "../../src/application/reporting.js";
import type {
  ConfigurationReport,
  EffectsMode,
  FcHealthRow,
  SyncRunRow,
  SyncStatusView,
} from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import { effectsPaused } from "../../src/domain/failures.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import type { VisibilityReport } from "../../src/domain/visibility.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import type { WebGuild } from "../../src/web/access.js";
import { startWeb, type WebOptions, type WebServer } from "../../src/web/server.js";
import { type DiscordAccount, FakeDiscord } from "./discord-oauth.js";
import { MemorySessions } from "./web-sessions.js";
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

/** The invented accounts the fake authorize page offers, and what each one shows. */
export const HARNESS_ACCOUNTS = {
  /** An officer of Example FC and a plain member of Second FC: lists Example FC only. */
  officer: { id: "200000000000000001", label: "An officer of Example FC" },
  /** A member of both servers and an officer of neither: "no access", and no session. */
  member: { id: "200000000000000002", label: "A member who isn't an officer" },
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
}

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

/** Each account's actor in each server, or undefined where Discord would answer Unknown Member. */
function harnessActor(
  guildId: string,
  userId: string,
  officerOf: ReadonlySet<string>,
): Actor | undefined {
  const officer = userId === HARNESS_ACCOUNTS.officer.id && officerOf.has(guildId);
  const member =
    userId === HARNESS_ACCOUNTS.officer.id ||
    userId === HARNESS_ACCOUNTS.member.id ||
    userId === HARNESS_ACCOUNTS.bot.id;
  if (!member) return undefined;
  return { guildId, userId, officer, manageRoles: false, serverManager: false };
}

/** The resolver main.ts builds from gateway.actor and enrichActor, answered from invented data. */
function actorResolver(states: HarnessStates) {
  const officerOf = officerGuilds(states);
  return async (guildId: string, userId: string): Promise<Actor> => {
    if (userId === HARNESS_ACCOUNTS.bot.id)
      throw new Failure("forbidden", "Bot accounts can't use TaruBot.", 0, {
        kind: "scope",
        scope: "human",
      });
    const actor = harnessActor(guildId, userId, officerOf);
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
  const roles = new Collection(
    Object.entries(ROLE).map(([label, id]) => [
      id,
      {
        id,
        name:
          roleNames[label] ??
          (label === "bot" ? "TaruBot" : `${label[0]?.toUpperCase()}${label.slice(1)}`),
      },
    ]),
  );
  const channels = new Collection(
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
function harnessReport(guildId: string, states: HarnessStates): ConfigurationReport {
  const cooling = lodestoneCooling(states);
  const failedAttempt = cooling || states.checks !== undefined;
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
  });
}

/** Read-only dashboard services, answered with the existing invented configuration fixtures. */
function harnessServices(states: HarnessStates): Services {
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fake");
  app.syncStatus = async () => syncView(states);
  app.validate = async (actor) => harnessReport(actor.guildId, states);
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
    .provide(gatewayKey, harnessGateway(states));
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
        services: harnessServices(states),
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
    if (!web) await authorize.stop(true);
  }
  if (!web) throw new Error("The web didn't start; see the reported problem above");
  const running = web;
  return {
    url: new URL(origin),
    authorizeUrl: new URL("/oauth2/authorize", authorize.url),
    stop: async () => {
      await running.stop();
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
    },
    allowPositionals: false,
  });
  if (Boolean(values.cert) !== Boolean(values.key))
    throw new Error("Pass --cert and --key together.");
  const checks = values["state-checks"];
  if (checks !== undefined && checks !== "warn" && checks !== "fail")
    throw new Error("Pass --state-checks=warn or --state-checks=fail.");
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
