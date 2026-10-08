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
 * The fake authorize page runs on its own port on the same interface and protocol as the web. It
 * redirects only to the redirect URI the harness configured, and echoes no request data: its page
 * holds fixed wording and an ID it made itself. The token and /users/@me requests keep their
 * https://discord.com URLs and are answered by FakeDiscord through the injected fetch, so
 * oauth4webapi's allowInsecureRequests is never used.
 * tests/unit/web-server.test.ts drives the same harness end to end.
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
import type { SyncStatusView } from "../../src/application/results.js";
import { Service } from "../../src/application/service.js";
import { Services } from "../../src/bot/services.js";
import type { Actor } from "../../src/domain/policy.js";
import { Failure } from "../../src/domain/values.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import type { WebGuild } from "../../src/web/access.js";
import { startWeb, type WebOptions, type WebServer } from "../../src/web/server.js";
import { type DiscordAccount, FakeDiscord } from "./discord-oauth.js";
import { MemorySessions } from "./web-sessions.js";
import { CHANNEL, configGuild, configReport, fcRow, ROLE } from "./replies/configuration.js";

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
function harnessActor(guildId: string, userId: string): Actor | undefined {
  const officer = userId === HARNESS_ACCOUNTS.officer.id && guildId === HARNESS_GUILDS.example.id;
  const member =
    userId === HARNESS_ACCOUNTS.officer.id ||
    userId === HARNESS_ACCOUNTS.member.id ||
    userId === HARNESS_ACCOUNTS.bot.id;
  if (!member) return undefined;
  return { guildId, userId, officer, manageRoles: false, serverManager: false };
}

/** The resolver main.ts builds from gateway.actor and enrichActor, answered from invented data. */
async function resolveActor(guildId: string, userId: string): Promise<Actor> {
  if (userId === HARNESS_ACCOUNTS.bot.id)
    throw new Failure("forbidden", "Bot accounts can't use TaruBot.", 0, {
      kind: "scope",
      scope: "human",
    });
  const actor = harnessActor(guildId, userId);
  if (!actor)
    throw new Failure("forbidden", "That member isn't in this server.", 0, {
      kind: "scope",
      scope: "current_member",
    });
  return actor;
}

/** Background work's invented data: a completed roster run, and work in several states. */
function syncView(): SyncStatusView {
  const at = new Date(Date.now() - 12 * 60_000);
  const job = (kind: string, status: string, last_error: string | null = null) => ({
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
  });
  return {
    effectsMode: "live",
    runs: [
      {
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
      },
    ],
    work: [
      job("reconcile.user", "queued"),
      job("roles.layout", "running"),
      job("guest.dm", "failed", "dm_blocked: invented diagnostic"),
      job("reconcile.user", "blocked", "blocked: Missing Permissions (invented)"),
    ],
  };
}
/** SDK-shaped invented caches: no gateway connection, fetched names or member data. */
export function harnessGateway(): DiscordGateway {
  const gateway: unknown = Object.create(DiscordGateway.prototype);
  if (!(gateway instanceof DiscordGateway)) throw new Error("Invalid gateway fake");
  const roles = new Collection(
    Object.entries(ROLE).map(([label, id]) => [
      id,
      { id, name: label === "bot" ? "TaruBot" : `${label[0]?.toUpperCase()}${label.slice(1)}` },
    ]),
  );
  const channels = new Collection(
    Object.entries(CHANNEL).map(([label, id]) => [
      id,
      {
        id,
        name:
          {
            ledger: "fc-ledger",
            notices: "officer-notices",
            reviews: "guest-review",
            lobby: "lobby",
            officers: "officers",
            changelog: "tarubot-updates",
          }[label] ?? label,
        flags: new ChannelFlagsBitField(),
        isThread: () => false,
        permissionsFor: () => new PermissionsBitField(PermissionFlagsBits.ViewChannel),
      },
    ]),
  );
  const guild = {
    roles: { cache: roles },
    channels: { cache: channels },
    members: {
      me: {},
      cache: new Collection(
        Object.values(HARNESS_ACCOUNTS).map((account) => [
          account.id,
          {
            id: account.id,
            displayName: account.label,
          },
        ]),
      ),
    },
  };
  Object.defineProperty(gateway, "client", {
    value: { guilds: { cache: new Map([[HARNESS_GUILDS.example.id, guild]]) } },
  });
  return gateway;
}

/** Read-only dashboard services, answered with the existing invented configuration fixtures. */
function harnessServices(): Services {
  const app: unknown = Object.create(Service.prototype);
  if (!(app instanceof Service)) throw new Error("Invalid application fake");
  app.syncStatus = async () => syncView();
  app.validate = async () =>
    configReport({
      guild: configGuild({
        id: HARNESS_GUILDS.example.id,
        access_policy_enabled: false,
        lobby_channel_id: null,
        officer_channel_id: null,
      }),
      fc: fcRow({
        last_successful_roster_at: new Date(Date.now() - 12 * 60_000),
        last_attempt_at: new Date(Date.now() - 12 * 60_000),
      }),
    });
  const lifecycle: unknown = Object.create(ApplicationLifecycle.prototype);
  if (!(lifecycle instanceof ApplicationLifecycle)) throw new Error("Invalid lifecycle fake");
  lifecycle.status = () => ({
    live: true,
    ready: true,
    database: true,
    writerLease: true,
    discord: true,
    effects: true,
    publicTestResponses: false,
    capabilities: null,
    lodestone: {
      parsing: 0,
      waiting: 0,
      cooldownSeconds: 0,
      strikes: 0,
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
    .provide(gatewayKey, harnessGateway());
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

/** Default loopback harness; a public origin and private port also exercise real reverse proxies. */
export async function startHarness(
  options: Pick<WebOptions, "hostname" | "tls" | "port"> & { publicOrigin?: string } = {},
  log: Logger = pino({ level: "silent" }),
): Promise<Harness> {
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
        services: harnessServices(),
        allowsGuild: () => true,
        isStopping: () => false,
        resolveActor,
        report: reporter,
        guilds: () => Object.values(HARNESS_GUILDS),
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

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "::1" },
      cert: { type: "string" },
      key: { type: "string" },
      origin: { type: "string" },
      port: { type: "string" },
    },
    allowPositionals: false,
  });
  if (Boolean(values.cert) !== Boolean(values.key))
    throw new Error("Pass --cert and --key together.");
  const tls =
    values.cert && values.key
      ? { cert: Bun.file(values.cert), key: Bun.file(values.key) }
      : undefined;
  const log = pino({ level: "debug" });
  const harness = await startHarness(
    {
      hostname: values.host,
      ...(values.origin && { publicOrigin: values.origin }),
      ...(values.port && { port: Number(values.port) }),
      ...(tls && { tls }),
    },
    log,
  );
  console.log(
    `TaruBot web harness: open ${harness.url.href} (fake Discord: ${harness.authorizeUrl.origin})`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void harness.stop().then(() => process.exit(0));
    });
}
