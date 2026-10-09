/** Composition root: create capabilities once, discover modules, then connect the bot. */
import { multistream, pino } from "pino";
import { GuildEvents } from "./application/guild-events.js";
import { GuildAccess } from "./application/guild-access.js";
import { DiscordGuildAccess } from "./discord/guild-access.js";
import {
  applicationKey,
  databaseKey,
  gatewayKey,
  guildEventsKey,
  issueReportsKey,
  lifecycleKey,
  synchronizationKey,
  roleAdministrationKey,
  selfRolesKey,
  suggestionsKey,
  versionInformationKey,
} from "./application/keys.js";
import { Heartbeat } from "./application/heartbeat.js";
import { IssueReports } from "./application/issue-reports.js";
import { ApplicationLifecycle } from "./application/lifecycle.js";
import { RecentLogs } from "./application/recent-logs.js";
import { createReporter, type Reporter } from "./application/reporting.js";
import { SelfRoles } from "./application/self-roles.js";
import { Service } from "./application/service.js";
import { Suggestions, suggestionTarget } from "./application/suggestions.js";
import { Synchronization } from "./application/synchronization.js";
import { RoleAdministration } from "./application/role-administration.js";
import { VersionInformation } from "./application/version-information.js";
import { GitHubHistory } from "./infrastructure/github/client.js";
import { GitHubIssues } from "./infrastructure/github/issues.js";
import type { BotContext } from "./bot/context.js";
import { bindEvents, loadCommands, loadComponents, loadEvents } from "./bot/discovery.js";
import { InteractionRouter, interactionRouterKey } from "./bot/router.js";
import { Services } from "./bot/services.js";
import { configuration } from "./config/env.js";
import { DiscordGateway } from "./discord/gateway.js";
import { DiscordOverrides } from "./discord/overrides.js";
import { Lodestone } from "./infrastructure/lodestone/client.js";
import { Database } from "./infrastructure/postgres/database.js";
import { dispatcher } from "./jobs/dispatch.js";
import { Queue } from "./jobs/queue.js";
import { startWeb, type WebServer } from "./web/server.js";

const config = configuration();
// Issue reports include the newest log records (info and above, after this redaction).
const recentLogs = new RecentLogs();
const log = pino(
  {
    level: config.LOG_LEVEL,
    redact: ["token", "biography", "authorization", "password", "interaction.token"],
  },
  multistream([
    { level: config.LOG_LEVEL, stream: process.stdout },
    { level: "info", stream: recentLogs },
  ]),
);
// Error objects may contain transport credentials or page bodies; the reporter logs only the
// catalog code, error class and approved Failure messages. Interactions pass their classified
// level; lifecycle, gateway-event, queue-worker and shutdown reports keep the error default.
const logReport = createReporter(log);

// Discovery is independent of login, database connections, and feature construction.
const [commands, components, events] = await Promise.all([
  loadCommands(),
  loadComponents(),
  loadEvents(),
]);
const db = new Database(config.DATABASE_URL);
const gateway = new DiscordGateway();
// The Lodestone parser runs in this process (2.21.0); its own events join the bot's log.
const lodestone = new Lodestone({ log: (level, fields, message) => log[level](fields, message) });
const app = new Service(db, gateway, lodestone, config);
const sync = new Synchronization(app);
const access = new GuildAccess(app, new DiscordGuildAccess(gateway.client));
// Issue reports (2.18.0): without a token they are saved, and sent once one is configured.
const reports = new IssueReports(
  config,
  db,
  lodestone,
  recentLogs,
  config.GITHUB_REPORTS_TOKEN
    ? new GitHubIssues(config.GITHUB_REPORTS_TOKEN, config.GITHUB_REPORTS_REPO)
    : null,
);
// Every error-level report (an unexpected failure) also becomes an issue report, grouped by kind.
const report: Reporter = (error, operation, options = {}) => {
  logReport(error, operation, options);
  if ((options.level ?? "error") === "error") void reports.error(error, operation, options.scope);
};
// Public suggestions (2.28.0): production posts as the GitHub App, DevBot previews into the
// reports repository; without their settings /suggest says it is switched off.
const suggestions = new Suggestions(app, suggestionTarget(config), report);
const queue = new Queue(db, dispatcher(app, sync, access, reports), (event) => {
  if (event.type === "worker") return report(event.error, event.job?.id ?? "queue");
  // Classified attempts log at their own level: expected waits stay at debug unless they stall.
  // Only identifiers, codes, approved diagnostics and timings are logged, never payloads or tokens.
  const { job, outcome } = event;
  log[outcome.level](
    {
      operation: job.id,
      kind: job.kind,
      generation: job.generation,
      attempts: job.attempts,
      code: outcome.code,
      status: outcome.status,
      category: outcome.category,
      source: outcome.source,
      diagnostic: outcome.diagnostic,
      delaySeconds: Math.ceil(outcome.delaySeconds),
      durationMs: event.durationMs,
      waitMs: event.waitMs,
      ageMs: event.ageMs,
    },
    "Job attempt outcome classified; inspect scoped work status.",
  );
  // A job that ended failed at error level is reported; repeats of a kind group into one issue.
  if (outcome.status === "failed" && outcome.level === "error")
    void reports.jobFailed(job, outcome);
});
// /setup (2.35.0, #46): onboarding, and TaruBot's own channel overrides written over raw REST. It is
// built before the lifecycle so shutdown can drain a /setup overrides run in progress.
const roleAdministration = new RoleAdministration(
  app,
  gateway,
  access,
  new DiscordOverrides(gateway.client),
);
// The outside dead-man's switch (2.22.0): pings healthchecks.io while ready; off when unset.
const heartbeat = new Heartbeat(
  config.HEALTHCHECKS_PING_URL,
  config.TEST_GUILD_ID ? "devbot" : "production",
  (level, fields, message) => log[level](fields, message),
);
// The web pages (#43): started below once the lease and Discord are ready; null while dormant.
let web: WebServer | null = null;
const lifecycle = new ApplicationLifecycle(config, db, gateway, app, sync, queue, log, report, {
  // The heartbeat never throws; the reporter's errors are reported by the lifecycle.
  tick: async () => {
    await heartbeat.tick();
    await reports.tick();
  },
  // A /suggest post still at GitHub finishes, and records its row, before the lease is released;
  // a /setup overrides run stops and writes its audit row (2.35.0); the web stops listening, and
  // connections still open after 5 s are closed (their handlers aren't cancelled, like in-flight
  // slash commands). None ever rejects.
  drain: () =>
    Promise.all([suggestions.drain(), roleAdministration.drain(), web?.stop()]).then(() => {}),
});
reports.useStatus(() => lifecycle.status());
heartbeat.useStatus(() => lifecycle.status());
const services = new Services()
  .provide(applicationKey, app)
  .provide(synchronizationKey, sync)
  .provide(databaseKey, db)
  .provide(gatewayKey, gateway)
  .provide(roleAdministrationKey, roleAdministration)
  .provide(versionInformationKey, new VersionInformation(new GitHubHistory()))
  .provide(guildEventsKey, new GuildEvents(db))
  .provide(issueReportsKey, reports)
  .provide(suggestionsKey, suggestions)
  // The Role menu's edits (2.39.0) refuse once shutdown starts and roll back if it starts mid-edit.
  .provide(selfRolesKey, new SelfRoles(app, () => lifecycle.isStopping()))
  .provide(lifecycleKey, lifecycle);
const context: BotContext = {
  client: gateway.client,
  services,
  report,
  allowsGuild: (guildId) => lifecycle.allowsGuild(guildId),
  isStopping: () => lifecycle.isStopping(),
  publicResponseGuildId:
    config.PUBLIC_TEST_RESPONSES && config.TEST_GUILD_ID ? config.TEST_GUILD_ID : undefined,
  resolveActor: async (guildId, userId) => app.enrichActor(await gateway.actor(guildId, userId)),
  enrichActor: (actor) => app.enrichActor(actor),
};
services.provide(interactionRouterKey, new InteractionRouter(context, commands, components));
const unbind = bindEvents(events, context);
log.info(
  { commands: commands.size, components: components.size, events: events.size },
  "Modules loaded",
);

// OS signals are process housekeeping; all Discord gateway subscriptions are discovered.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void lifecycle
      .stop()
      .then(() => {
        unbind();
        process.exit(0);
      })
      .catch((error: unknown) => {
        report(error, "shutdown");
        process.exit(1);
      });
  });
try {
  await lifecycle.prepare();
  await Promise.all([gateway.client.login(config.DISCORD_TOKEN), lifecycle.whenReady()]);
} catch (error) {
  unbind();
  await lifecycle.stop();
  throw error;
}
// Never rejects: with WEB_PUBLIC_ORIGIN unset it returns null and nothing listens, and a web fault
// is reported and leaves the bot running.
web = await startWeb(
  config,
  { ...context, guilds: () => gateway.client.guilds.cache.map(({ id, name }) => ({ id, name })) },
  log,
);
