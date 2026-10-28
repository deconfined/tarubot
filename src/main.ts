/** Composition root: create capabilities once, discover modules, then connect the bot. */
import { multistream, pino } from "pino";
import { Backups, type SettingsSnapshot, settingsSnapshot } from "./application/backups.js";
import { Dashboard } from "./application/dashboard.js";
import { GuildEvents } from "./application/guild-events.js";
import { GuildAccess } from "./application/guild-access.js";
import { DiscordGuildAccess } from "./discord/guild-access.js";
import {
  applicationKey,
  dashboardKey,
  databaseKey,
  gatewayKey,
  guildEventsKey,
  issueReportsKey,
  lifecycleKey,
  modmailKey,
  moderationKey,
  publicStatusKey,
  synchronizationKey,
  roleAdministrationKey,
  selfRolesKey,
  suggestionsKey,
  versionInformationKey,
} from "./application/keys.js";
import { Heartbeat } from "./application/heartbeat.js";
import { IssueReports } from "./application/issue-reports.js";
import { ApplicationLifecycle } from "./application/lifecycle.js";
import { ModMail, ModMailRetention } from "./application/modmail.js";
import { Moderation } from "./application/moderation.js";
import {
  changesPausedAnywhere,
  PgStatusSamples,
  PublicStatus,
} from "./application/public-status.js";
import { RecentLogs } from "./application/recent-logs.js";
import { createReporter, type Reporter } from "./application/reporting.js";
import { SelfRoles } from "./application/self-roles.js";
import { Service } from "./application/service.js";
import {
  migrateAtStartup,
  pauseAfterFailedMigration,
  registerAtStartup,
} from "./application/startup.js";
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
import { type Configuration, configuration } from "./config/env.js";
import { DiscordGateway } from "./discord/gateway.js";
import { DiscordOverrides } from "./discord/overrides.js";
import { Lodestone } from "./infrastructure/lodestone/client.js";
import {
  INVALID_KEY_PROBLEM,
  type ModMailKey,
  readModMailKey,
} from "./infrastructure/modmail/cipher.js";
import { Database } from "./infrastructure/postgres/database.js";
import { Failure } from "./domain/values.js";
import { dispatcher } from "./jobs/dispatch.js";
import { Queue } from "./jobs/queue.js";
import { startWeb, type WebServer } from "./web/server.js";
import { webSettings } from "./web/settings.js";

/**
 * The configuration, without MODMAIL_KEY (2.43.0): the key is decoded here once into the cipher,
 * deleted from process.env, and left out of the configuration every service receives, so no log,
 * report or later reader of either finds it. The original string can't be wiped (JavaScript
 * strings are immutable); once this function returns, only the cipher and the settings snapshot
 * reference it. The snapshot (2.46.0) is taken first, key included, for the backups' encrypted
 * settings copy (the owner's 2026-10-11 trade-off), and only the backup service holds it.
 */
function startupSettings(): {
  config: Configuration;
  modmail: ModMailKey;
  snapshot: SettingsSnapshot;
} {
  const settings = configuration();
  const snapshot = settingsSnapshot(process.env);
  const modmail = readModMailKey(settings.MODMAIL_KEY);
  delete process.env.MODMAIL_KEY;
  const { MODMAIL_KEY: _key, ...rest } = settings;
  return { config: rest, modmail, snapshot };
}
const { config, modmail: modmailCipher, snapshot } = startupSettings();
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
/** The log shape the backup and startup helpers take. */
const logTo = (level: "info" | "warn", fields: Record<string, unknown>, message: string) =>
  log[level](fields, message);
// Encrypted offsite backups (2.46.0): the pre-migration backup below, then daily at
// BACKUP_TIME_UTC under the writer lease. Settings are read from the snapshot; a bad one never
// stops the bot (it is reported once the lease is held, and each backup then fails).
const backups = new Backups(snapshot, logTo);

// Discovery is independent of login, database connections, and feature construction.
const [commands, components, events] = await Promise.all([
  loadCommands(),
  loadComponents(),
  loadEvents(),
]);
const db = new Database(config.DATABASE_URL);
// The dashboard's address (2.42.0), for /dashboard's link and TaruBot's custom status: the origin
// from the same parse startWeb repeats, or null while the web is off or its settings are invalid
// (startWeb reports those). Read once at startup, like the web's own settings.
const parsedWeb = webSettings(config);
const dashboard = new Dashboard(parsedWeb.status === "on" ? parsedWeb.settings.origin : null);
const gateway = new DiscordGateway({ dashboardOrigin: dashboard.origin });
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
  // The backups' credentials and check URL (2.46.0) live outside the configuration object.
  ["BACKUP_STORAGE_ACCESS_KEY", "BACKUP_STORAGE_SECRET_KEY", "HEALTHCHECKS_BACKUP_URL"].map(
    (name) => snapshot[name] ?? "",
  ),
);
// Every error-level report (an unexpected failure) also becomes an issue report, grouped by kind.
const report: Reporter = (error, operation, options = {}) => {
  logReport(error, operation, options);
  if ((options.level ?? "error") === "error") void reports.error(error, operation, options.scope);
};
// Mod mail's key (2.43.0), read once by startupSettings above: unset leaves mod mail unavailable
// quietly, a malformed value leaves it unavailable too and is reported once TaruBot holds the
// writer lease (below), by the setting's name, never its value; neither stops the bot.
// Closed cases go 90 days after closing: its own timer, under the writer lease (started below).
const modmailRetention = new ModMailRetention(db.orm);
// Public suggestions (2.28.0): production posts as the GitHub App, DevBot previews into the
// reports repository; without their settings /suggest says it is switched off.
const suggestions = new Suggestions(app, suggestionTarget(config), report);
const queue = new Queue(
  db,
  dispatcher(app, sync, access, reports, undefined, { dashboardOrigin: dashboard.origin }),
  (event) => {
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
  },
);
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
  // Readiness reports only whether the key is valid (2.43.0); the configuration no longer has it.
  modmail: modmailCipher.status === "on",
  // A /suggest post still at GitHub finishes, and records its row, before the lease is released;
  // a /setup overrides run stops and writes its audit row (2.35.0); the web stops listening, and
  // connections still open after 5 s are closed (their handlers aren't cancelled, like in-flight
  // slash commands); the status page's timer stops, and a sample being written finishes (2.41.0);
  // mod mail's retention timer stops, and a pass in progress finishes (2.43.0); a backup in
  // progress, the pre-migration one included, is abandoned: pg_dump is killed and the upload
  // aborted, leaving no object (2.46.0). None ever rejects.
  drain: () =>
    Promise.all([
      suggestions.drain(),
      roleAdministration.drain(),
      web?.stop(),
      publicStatus.stop(),
      modmailRetention.stop(),
      backups.stop(),
    ]).then(() => {}),
});
// The public status page (2.41.0): a snapshot refreshed every minute from readiness, the Lodestone
// client and one query, plus a sample every five minutes for its 90-day history. Started once
// TaruBot is ready; /status reads only the snapshot.
const publicStatus = new PublicStatus(
  {
    readiness: () => lifecycle.status(),
    lodestoneFailing: () => lodestone.reachability().failingSince !== null,
    changesPaused: () =>
      changesPausedAnywhere(db, config.ENABLE_EFFECTS, (guildId) => lifecycle.allowsGuild(guildId)),
    samples: new PgStatusSamples(db),
  },
  { report },
);
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
  .provide(lifecycleKey, lifecycle)
  .provide(publicStatusKey, publicStatus)
  .provide(dashboardKey, dashboard)
  // Mod mail (2.43.0): its writes refuse once shutdown starts and roll back if it starts mid-write.
  .provide(
    modmailKey,
    new ModMail(app, modmailCipher, dashboard.origin, () => lifecycle.isStopping(), report),
  )
  // Per-person moderation (2.45.0): pauses are database writes only (no Discord request, no job),
  // refused once shutdown starts. A target's access is resolved like an actor's, in full.
  .provide(
    moderationKey,
    new Moderation(
      app,
      async (guildId, userId) => app.enrichActor(await gateway.actor(guildId, userId, "full")),
      () => lifecycle.isStopping(),
    ),
  );
const context: BotContext = {
  client: gateway.client,
  services,
  report,
  allowsGuild: (guildId) => lifecycle.allowsGuild(guildId),
  isStopping: () => lifecycle.isStopping(),
  publicResponseGuildId:
    config.PUBLIC_TEST_RESPONSES && config.TEST_GUILD_ID ? config.TEST_GUILD_ID : undefined,
  resolveActor: async (guildId, userId, mode) =>
    app.enrichActor(await gateway.actor(guildId, userId, mode)),
  enrichActor: (actor) => app.enrichActor(actor),
};
services.provide(interactionRouterKey, new InteractionRouter(context, commands, components));
const unbind = bindEvents(events, context);
log.info(
  { commands: commands.size, components: components.size, events: events.size },
  "Modules loaded",
);

// OS signals are process housekeeping; all Discord gateway subscriptions are discovered. They also
// end the pause after a failed startup migration (below) at once: lifecycle.stop() returns the
// same finished promise a second time, and unbinding twice removes nothing more.
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
let migrated = false;
try {
  // Starting the image is the whole upgrade (2.46.0): pending migrations apply here, behind the
  // deployment guard and a pre-migration backup, before this process waits for the writer lease.
  // A refusal or failure leaves the schema as it was and stops the start: after the pause below,
  // the process exits non-zero.
  await migrateAtStartup({ db, backups, env: process.env, log: logTo });
  migrated = true;
  await lifecycle.prepare();
  await Promise.all([gateway.client.login(config.DISCORD_TOKEN), lifecycle.whenReady()]);
} catch (error) {
  unbind();
  await lifecycle.stop();
  // Only a failed migration pauses (10 minutes, holding nothing): each restart would otherwise
  // repeat it, and its full pre-migration backup, at Docker's restart pace. A later failure
  // (Discord login, say) exits at once as before.
  if (!migrated)
    await pauseAfterFailedMigration(error, {
      log: (fields, message) => log.error(fields, message),
    });
  throw error;
}
// The writer lease is held and Discord is ready: sample from now on, web or no web, so the history
// is complete when the page is turned on. Never rejects.
publicStatus.start();
// Mod mail retention (2.43.0) on its own timer, while this process holds the writer lease; deleted
// counts reach the log, never which cases. Never rejects.
modmailRetention.start(() => lifecycle.status().writerLease, {
  deleted: (deleted) => log.info({ deleted }, "Mod mail cases deleted after retention"),
  report,
});
// Daily backups (2.46.0) on their own timer, under the writer lease like retention; invalid
// backup settings are reported here, so only the writer files them. Never rejects.
backups.start(() => lifecycle.status().writerLease, report);
// Reported here, under the lease like the web's invalid settings, so only the writer files it.
if (modmailCipher.status === "invalid")
  report(new Failure("configuration", INVALID_KEY_PROBLEM), "modmail key");
// Never rejects: with WEB_PUBLIC_ORIGIN unset it returns null and nothing listens, and a web fault
// is reported and leaves the bot running.
web = await startWeb(
  config,
  { ...context, guilds: () => gateway.client.guilds.cache.map(({ id, name }) => ({ id, name })) },
  log,
);
// The declared commands, in this profile's registration scope (2.46.0). Never rejects: a refusal
// or a Discord error is reported and the bot keeps the command set Discord already holds.
await registerAtStartup({
  env: process.env,
  rest: gateway.client.rest,
  applicationId: config.DISCORD_APPLICATION_ID,
  commands: [...commands.values()].map((command) => command.toJSON()),
  log: logTo,
  report,
});
