/**
 * The officer alert about missing channel overrides, and the counts readiness shows (2.35.0, #46;
 * @deconfined's answer 5 and the wording he approved in comment 5869082017).
 *
 * Every scheduler pass (30 s, while the bot holds the writer lease) reads each active server's
 * channels from the gateway cache only, analyses them as if TaruBot's Administrator were off
 * (src/domain/visibility.ts), and counts the channels that would then be missing TaruBot's own
 * override. A server whose count turns positive opens an episode: one `visibility.missing` audit
 * row and one held officer alert. A server whose count returns to 0 closes it: one
 * `visibility.restored` audit row, the alert withdrawn if it hasn't posted, and one recovery line
 * only if it has. The count ignores Administrator on purpose, so the alert posts while TaruBot
 * still holds it (answer 5): Administrator is the temporary state, and the alert says what has to
 * be in place before it comes off. Nothing here reads `administrator.held`.
 *
 * Debounce: a transition needs the new side on VISIBILITY_CONFIRM_PASSES consecutive passes that
 * computed the server's count. One pass's cache blip, such as a channel created a moment before
 * TaruBot's entry was added to it, or a guild delivered with part of its channel list, writes
 * nothing. A pass that doesn't compute the count (no snapshot, an error, or the pass budget spent
 * before the server) neither confirms nor resets the streak; a confirmed streak whose transition
 * couldn't run (another session holds the server's lock, or the budget stopped new transitions)
 * stays, and the next pass that sees the same side tries again.
 *
 * State lives in existing tables, with no migration: the newest episode audit row says whether an
 * episode is open and since when, and the `officer.notify` rows on the two keys (never pruned)
 * are the delivery history. The in-memory map only caches that state (loaded lazily after a
 * restart) and holds the streaks, which start again at 0 after a restart.
 *
 * Onboarding servers count 0 by the analysis itself: onboarding's own channel pass writes
 * TaruBot's access, and the approved text points at /setup overrides, which doesn't apply there.
 * Their pending channels only feed readiness's separate `onboardingPending` count.
 *
 * Accepted edges:
 * - A blocked alert that /setup overrides requeues (requeueParked) can post just before the restore
 *   closes it; the recovery line then follows it, which is the right pair.
 * - When the officer notifications channel is itself missing TaruBot's override, the alert parks
 *   `blocked` there. Readiness's count and /config validate are the fallback.
 * - Without an officer notifications channel the episode opens (its audit row) but no alert is
 *   queued: the alert waits for the channel, so a server set up in the documented order (the FC
 *   first, the officer channel near the end) still gets it, with the usual hold, once the channel
 *   is set. An alert the dispatcher skipped because the channel was unset by then doesn't count
 *   as the episode's alert either: a pass that sees no channel forgets the cached alert, so the
 *   first pass that sees one again queues it anew, with the usual hold, unless the episode's alert
 *   is still pending or has already posted (ensureAlert reads the rows).
 * - An inactive server's queued alert may post when the bot is added back, before the next pass
 *   closes it (the queue never claims an inactive server's rows, and passes skip inactive servers).
 * - A notice `running` at the restore is counted as posted, as #29's degraded notice is: if that
 *   send then fails and is retried, it can post after the recovery line.
 * - Opening an episode withdraws the previous episode's recovery line if it hasn't started
 *   (queued for a retry, blocked or parked), so "complete again" never posts while channels are
 *   missing. One already `running` then is left alone, like a running alert: it can post just
 *   after the episode opens, and the new alert (held, or delayed to the 24-hour window's end)
 *   follows it.
 * - The recovery line says "again" even after the first episode, when the overrides were never
 *   complete before. @deconfined approved the wording verbatim; don't change it.
 */
import { and, desc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import {
  analyseVisibility,
  type VisibilityGuild,
  type VisibilityRecords,
  type VisibilityReport,
  visibilitySettings,
} from "../domain/visibility.js";
import { audit, type Connection, type Orm, orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { closeUnstarted, enqueue } from "../jobs/queue.js";
import type { Service } from "./service.js";
import { loadVisibilityRecords } from "./visibility-records.js";

/** The alert's key: one per server, apart from every other officer notice. */
export const visibilityNoticeKey = (guild: string): string => `officer:${guild}:visibility`;
/** The recovery line that follows a posted alert. */
export const visibilityRestoredKey = (guild: string): string =>
  `officer:${guild}:visibility:restored`;
/** How long a new alert waits before posting, so a quick /setup overrides run withdraws it. */
export const VISIBILITY_HOLD_SECONDS = 300;
/** At most one alert posts per server in any 24 hours; a later one waits for the window's end. */
export const VISIBILITY_REPEAT_SECONDS = 86_400;
/** No new transition starts once a pass has run this long (and no further server is analysed). */
export const VISIBILITY_PASS_BUDGET_MS = 10_000;
/** How long a server's stored records are reused between passes; transitions always reload them. */
export const VISIBILITY_RECORDS_TTL_MS = 600_000;
/** A transition needs the new side on this many consecutive passes that computed the count. */
export const VISIBILITY_CONFIRM_PASSES = 2;
// Approved verbatim by @deconfined (#46 comment 5869082017); never reword:
export const VISIBILITY_MISSING_NOTICE =
  "Some channels are missing TaruBot's channel override, so without Administrator TaruBot can't see them or can't post where it should. /config validate lists them and what to do; /setup overrides adds missing overrides while TaruBot holds Administrator.";
export const VISIBILITY_RESTORED_NOTICE =
  "TaruBot's channel overrides are complete again: /config validate shows every channel visible.";

/**
 * What readiness shows, from the last completed pass; every field is null before the first. Both
 * counts are informational and never change readiness. `missing` is the alert's count (servers
 * without onboarding); `onboardingPending` counts onboarding servers' channels that onboarding's
 * pass hasn't reached, and configured Community Updates channels it never manages.
 */
export interface VisibilityStatus {
  readonly missing: number | null;
  readonly onboardingPending: number | null;
  /** Servers analysed in that pass. */
  readonly checked: number | null;
  /** When that pass ended (ISO 8601). */
  readonly checkedAt: string | null;
}
export interface VisibilityMonitor {
  /** One pass; resolves at once while another pass is running. */
  check(): Promise<void>;
  /** A stored plain object; never throws. */
  status(): VisibilityStatus;
}
/** The lifecycle's logger and reporter, so this module holds no logger of its own. */
export interface VisibilityAlertHooks {
  readonly log: (level: "info" | "warn", fields: Record<string, unknown>, message: string) => void;
  readonly report: (error: unknown, operation: string) => void;
}

/** Nothing known yet: before the first pass. */
const UNKNOWN: VisibilityStatus = {
  missing: null,
  onboardingPending: null,
  checked: null,
  checkedAt: null,
};

/** Which side of zero a server's count is on. */
type Side = "missing" | "clear";
const sideOf = (count: number): Side => (count > 0 ? "missing" : "clear");

/**
 * A server's episode as the database says: `opened` is the ID of its newest episode audit row
 * when that is a 'visibility.missing' (an open episode), else null. `alertQueued` says this
 * process has seen the episode's alert row, so passes stop looking for it.
 */
interface Episode {
  readonly opened: bigint | null;
  readonly alertQueued: boolean;
}
/** The side a server's count was on in the last passes that computed it, and for how many. */
interface Streak {
  readonly side: Side;
  readonly passes: number;
}
/** What a pass does under the server's lock. */
type Step = "open" | "restore" | "ensure";

/** The guild row's columns the analysis reads (VisibilityConfig), with the ID. */
const GUILD_COLUMNS = {
  id: t.guilds.id,
  access_policy_enabled: t.guilds.access_policy_enabled,
  ledger_channel_id: t.guilds.ledger_channel_id,
  officer_notifications_channel_id: t.guilds.officer_notifications_channel_id,
  changelog_channel_id: t.guilds.changelog_channel_id,
  guest_application_channel_id: t.guilds.guest_application_channel_id,
  guest_applications_enabled: t.guilds.guest_applications_enabled,
  lobby_channel_id: t.guilds.lobby_channel_id,
  officer_channel_id: t.guilds.officer_channel_id,
  member_role_id: t.guilds.member_role_id,
  guest_role_id: t.guilds.guest_role_id,
  officer_role_id: t.guilds.officer_role_id,
  leader_role_id: t.guilds.leader_role_id,
};

/**
 * The result the dispatcher gives an officer notice when no officer notifications channel is set
 * (src/jobs/dispatch.ts). Such a row never reached officers, so it isn't an episode's alert.
 */
const NO_CHANNEL_SKIP = "officer notifications unconfigured";

/** The two audit actions that open and close an episode. */
const EPISODE_ACTIONS = ["visibility.missing", "visibility.restored"];

/**
 * A 'visibility.missing' audit row's details, also logged: `channels` counts missing channels
 * inside and outside missing categories, and `private` counts each private category and the
 * channels inside it that would otherwise be written (Σ(1 + inside)).
 */
const missingDetails = (report: VisibilityReport) => ({
  categories: report.missing.categories.length,
  channels: report.missing.inside.length + report.missing.channels.length,
  masked: report.masked.length,
  denied: report.denied.length,
  private: report.privateCategories.reduce((total, entry) => total + 1 + entry.inside.length, 0),
});

/** Onboarding's pending channels in a report (0 in checked mode). */
const onboardingPending = (report: VisibilityReport): number =>
  report.onboardingPending
    ? report.onboardingPending.managed.length + report.onboardingPending.unmanaged.length
    : 0;

/**
 * When the episode began: its audit row's event_at, read in SQL so the comparison keeps
 * PostgreSQL's microseconds (a JavaScript Date keeps milliseconds). The audit row and the alert
 * queued with it share one transaction, so their now() is equal.
 */
const episodeStart = (opened: bigint): SQL =>
  sql`(SELECT ${t.auditEvents.event_at} FROM ${t.auditEvents} WHERE ${t.auditEvents.id} = ${opened})`;

/** The newest episode audit row: its ID when it opened an episode, else null. */
async function openedEpisode(db: Orm, guild: string): Promise<bigint | null> {
  const [latest] = await db
    .select({ id: t.auditEvents.id, action: t.auditEvents.action })
    .from(t.auditEvents)
    .where(and(eq(t.auditEvents.guild_id, guild), inArray(t.auditEvents.action, EPISODE_ACTIONS)))
    .orderBy(desc(t.auditEvents.id))
    .limit(1);
  return latest?.action === "visibility.missing" ? latest.id : null;
}

/**
 * Make sure the open episode has its alert, in the caller's transaction (which holds the server's
 * lock and its guild row). Returns whether the alert is now in place (false only while an earlier
 * episode's notice is still sending) and the delay a new row got.
 * - Any row created since the episode began is this episode's alert, whatever became of it
 *   (posted, waiting, withdrawn), except one skipped because no officer notifications channel was
 *   set when it came due: that one reached nobody, so the alert is queued again (callers queue it
 *   only while a channel is set).
 * - A running notice belongs to an earlier episode and is never merged into, since enqueue would
 *   bump its generation and post it twice; the next pass after it finishes queues this one.
 * - An earlier episode's unstarted row (a failed send the queue retries) is closed first, so the
 *   new row carries this episode's delay instead of merging into an old one.
 * - At most one alert posts per server in any 24 hours: within 24 hours of the newest posted one,
 *   the new row waits until the window ends instead of being dropped, so a problem still there
 *   then is still reported.
 */
async function ensureAlert(
  client: Connection,
  guild: string,
  opened: bigint,
): Promise<{ readonly queued: boolean; readonly delaySeconds: number | null }> {
  const db = orm(client);
  const key = visibilityNoticeKey(guild);
  const [current] = await db
    .select({ id: t.jobs.id })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.dedupe_key, key),
        sql`${t.jobs.created_at} >= ${episodeStart(opened)}`,
        sql`coalesce(${t.jobs.result}->>'skipped', '') <> ${NO_CHANNEL_SKIP}`,
      ),
    )
    .limit(1);
  if (current) return { queued: true, delaySeconds: null };
  // Row-locked (after the guild row, the codebase's lock order), so no worker claims a waiting
  // row between this read and closeUnstarted; the claim skips locked rows.
  const active = await db
    .select({ status: t.jobs.status })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.dedupe_key, key),
        inArray(t.jobs.status, ["queued", "running", "blocked", "disabled"]),
      ),
    )
    .for("update");
  if (active.some((row) => row.status === "running")) return { queued: false, delaySeconds: null };
  await closeUnstarted(client, key, "superseded by a new episode");
  const [window] = await db
    .select({
      wait: sql<
        number | null
      >`ceil(extract(epoch FROM max(coalesce(${t.jobs.completed_at},${t.jobs.created_at}))+${VISIBILITY_REPEAT_SECONDS}*interval '1 second'-now()))::int`,
    })
    .from(t.jobs)
    .where(and(eq(t.jobs.dedupe_key, key), isNotNull(t.jobs.message_id)));
  // No posted alert, or none within 24 hours, leaves the wait at or below 0: the ordinary hold.
  const delaySeconds = Math.max(VISIBILITY_HOLD_SECONDS, window?.wait ?? 0);
  await enqueue(
    client,
    "officer.notify",
    key,
    { message: VISIBILITY_MISSING_NOTICE },
    guild,
    null,
    delaySeconds,
  );
  return { queued: true, delaySeconds };
}

/**
 * The officer alert and readiness counts (see the module comment). The lifecycle runs check()
 * after each scheduler pass and reads status() for /health/ready.
 */
export class VisibilityAlerts implements VisibilityMonitor {
  /** The overlap guard: set while a pass runs. */
  private running = false;
  private stored: VisibilityStatus = UNKNOWN;
  /** Each server's episode, loaded lazily from the audit table and changed only after commit. */
  private readonly episodes = new Map<string, Episode>();
  private readonly streaks = new Map<string, Streak>();
  /** Each server's stored records, reused for VISIBILITY_RECORDS_TTL_MS (Date.now() milliseconds). */
  private readonly records = new Map<
    string,
    { readonly at: number; readonly records: VisibilityRecords }
  >();

  /** Stores its collaborators only: nothing reaches the database or Discord before check(). */
  constructor(
    private readonly app: Service,
    private readonly allowsGuild: (guild: string) => boolean,
    private readonly hooks: VisibilityAlertHooks,
  ) {}

  status(): VisibilityStatus {
    return this.stored;
  }

  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
    } finally {
      this.running = false;
    }
  }

  /** One pass over the active servers this deployment serves, each isolated from the others. */
  private async pass(): Promise<void> {
    const started = Date.now();
    const spent = () => Date.now() - started >= VISIBILITY_PASS_BUDGET_MS;
    const rows = await this.app.db.orm
      .select(GUILD_COLUMNS)
      .from(t.guilds)
      .where(eq(t.guilds.active, true))
      .orderBy(t.guilds.id);
    const guilds = rows.filter((row) => this.allowsGuild(row.id));
    // A server that left, or that this deployment doesn't serve, starts afresh if it comes back.
    const served = new Set(guilds.map((row) => row.id));
    for (const cache of [this.episodes, this.streaks, this.records])
      for (const id of cache.keys()) if (!served.has(id)) cache.delete(id);
    let missing = 0;
    let pending = 0;
    let checked = 0;
    let skipped = 0;
    for (const [index, row] of guilds.entries()) {
      if (spent()) {
        skipped = guilds.length - index;
        break;
      }
      try {
        const counted = await this.guild(row, spent);
        if (!counted) continue;
        missing += counted.missing;
        pending += counted.pending;
        checked++;
      } catch (error) {
        // One server's failure never stops the others; its streak is unchanged or kept.
        this.hooks.report(error, "visibility alerts");
      }
    }
    if (skipped)
      this.hooks.log(
        "warn",
        { checked, skipped, budgetMs: VISIBILITY_PASS_BUDGET_MS },
        "Channel override check stopped at its time budget",
      );
    this.stored = {
      missing,
      onboardingPending: pending,
      checked,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * One server: its counts from the cached channels, the streak, and at most one locked step.
   * Returns null when the count couldn't be computed (no snapshot), which leaves the streak alone.
   */
  private async guild(
    row: { readonly id: string } & Parameters<typeof visibilitySettings>[0],
    spent: () => boolean,
  ): Promise<{ readonly missing: number; readonly pending: number } | null> {
    // Cache only: a pass never calls Discord.
    const snapshot = await this.app.discord.visibility?.(row.id, false);
    if (!snapshot) return null;
    // The alert is owed only once there is a channel to post it in (see the module comment).
    const noticesSet = row.officer_notifications_channel_id !== null;
    const known = this.episodes.get(row.id) ?? {
      opened: await openedEpisode(this.app.db.orm, row.id),
      alertQueued: false,
    };
    // With the channel unset, a queued alert may come due and be skipped by the dispatcher, which
    // uses it up. Forgetting it here makes the first pass that sees a channel again check the
    // database (ensureAlert): a row still pending is found and kept, and a skipped one doesn't
    // count, so the alert is queued again, in this process as after a restart.
    const episode = !noticesSet && known.alertQueued ? { ...known, alertQueued: false } : known;
    this.episodes.set(row.id, episode);
    const report = analyseVisibility(
      snapshot,
      visibilitySettings(row, await this.recordsFor(row.id)),
    );
    const side = sideOf(report.missingCount);
    const previous = this.streaks.get(row.id);
    const streak: Streak = {
      side,
      passes: previous?.side === side ? previous.passes + 1 : 1,
    };
    this.streaks.set(row.id, streak);
    const confirmed = streak.passes >= VISIBILITY_CONFIRM_PASSES;
    const step: Step | null =
      episode.opened === null
        ? side === "missing" && confirmed
          ? "open"
          : null
        : side === "clear"
          ? confirmed
            ? "restore"
            : null
          : episode.alertQueued || !noticesSet
            ? null
            : "ensure";
    // The budget stops new steps; a confirmed streak is kept for the next pass.
    if (!step || spent())
      return { missing: report.missingCount, pending: onboardingPending(report) };
    const observed = await this.step(row.id, snapshot, side, step);
    // null: another session holds the server's lock, or the server left; try again next pass.
    if (!observed) return { missing: report.missingCount, pending: onboardingPending(report) };
    return { missing: observed.missingCount, pending: onboardingPending(observed) };
  }

  /** A server's stored records, from the cache while it is younger than the TTL. */
  private async recordsFor(guild: string): Promise<VisibilityRecords> {
    const cached = this.records.get(guild);
    if (cached && Date.now() - cached.at < VISIBILITY_RECORDS_TTL_MS) return cached.records;
    const records = await loadVisibilityRecords(this.app.db.orm, guild);
    this.records.set(guild, { at: Date.now(), records });
    return records;
  }

  /**
   * One step in a transaction that holds the server's advisory lock (skipped when another session
   * holds it) and its guild row FOR SHARE, the lock order the rest of the code uses before job
   * rows. The episode, the stored records and the guild row are read again under the lock, and
   * the count recomputed from them is this pass's observation: on the other side of zero it
   * cancels the step and restarts the streak there. The map changes only after commit, so a
   * failed transaction leaves everything to retry next pass. Returns the recomputed report, or
   * null when nothing was examined.
   */
  private async step(
    guild: string,
    snapshot: VisibilityGuild,
    seen: Side,
    planned: Step,
  ): Promise<VisibilityReport | null> {
    const outcome = await this.app.db.transaction(async (client) => {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [`visibility:${guild}`],
      );
      if (!lock.rows[0]?.locked) return null;
      const db = orm(client);
      const [row] = await db
        .select(GUILD_COLUMNS)
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guild), eq(t.guilds.active, true)))
        .for("share");
      if (!row) return null;
      const opened = await openedEpisode(db, guild);
      const records = await loadVisibilityRecords(db, guild);
      this.records.set(guild, { at: Date.now(), records });
      const report = analyseVisibility(snapshot, visibilitySettings(row, records));
      const side = sideOf(report.missingCount);
      const known = this.episodes.get(guild);
      // The alert found earlier belongs to this episode only if the database agrees it is open.
      const alertQueued = known?.opened === opened && opened !== null && known.alertQueued;
      if (side !== seen) return { report, episode: { opened, alertQueued }, restart: side };
      if (opened === null && side === "missing" && planned === "open") {
        const details = missingDetails(report);
        await audit(client, guild, null, "visibility.missing", guild, details);
        const episode = await openedEpisode(db, guild);
        if (episode === null) throw new Error("The visibility.missing audit row wasn't read back.");
        // The previous episode's recovery line, if it hasn't posted (a retry after a failed send,
        // or parked), would now say "complete again" while channels are missing: withdraw it, also
        // without an officer notifications channel, since it could post once one is set.
        await closeUnstarted(client, visibilityRestoredKey(guild), "superseded by a new episode");
        // Without an officer notifications channel the alert waits for one (the module comment).
        const alert =
          row.officer_notifications_channel_id !== null
            ? await ensureAlert(client, guild, episode)
            : { queued: false, delaySeconds: null };
        return {
          report,
          episode: { opened: episode, alertQueued: alert.queued },
          note: {
            fields: {
              guild,
              missing: report.missingCount,
              ...details,
              delaySeconds: alert.delaySeconds,
            },
            message: "Channel overrides missing",
          },
        };
      }
      if (opened !== null && side === "clear" && planned === "restore") {
        await audit(client, guild, null, "visibility.restored", guild, {});
        await closeUnstarted(client, visibilityNoticeKey(guild), "restored before posting");
        // Creation places a notice in this episode; one posted (or posting) earns the recovery
        // line, and officers who were never told get none.
        const [posted] = await db
          .select({ id: t.jobs.id })
          .from(t.jobs)
          .where(
            and(
              eq(t.jobs.dedupe_key, visibilityNoticeKey(guild)),
              sql`${t.jobs.created_at} >= ${episodeStart(opened)}`,
              or(isNotNull(t.jobs.message_id), eq(t.jobs.status, "running")),
            ),
          )
          .limit(1);
        if (posted)
          await enqueue(
            client,
            "officer.notify",
            visibilityRestoredKey(guild),
            { message: VISIBILITY_RESTORED_NOTICE },
            guild,
            null,
            5,
          );
        return {
          report,
          episode: { opened: null, alertQueued: false },
          note: {
            fields: { guild, recovery: Boolean(posted) },
            message: "Channel overrides restored",
          },
        };
      }
      // Still missing with the episode open (or opened elsewhere since this process read it):
      // the alert may still be owed.
      if (
        opened !== null &&
        side === "missing" &&
        !alertQueued &&
        row.officer_notifications_channel_id !== null
      ) {
        // As when the episode opened (in case another session opened it): no stale recovery line.
        await closeUnstarted(client, visibilityRestoredKey(guild), "superseded by a new episode");
        const alert = await ensureAlert(client, guild, opened);
        return { report, episode: { opened, alertQueued: alert.queued } };
      }
      return { report, episode: { opened, alertQueued } };
    });
    if (!outcome) return null;
    this.episodes.set(guild, outcome.episode);
    if ("restart" in outcome) this.streaks.set(guild, { side: outcome.restart, passes: 1 });
    // Logged once committed, with IDs and counts only.
    if ("note" in outcome) this.hooks.log("info", outcome.note.fields, outcome.note.message);
    return outcome.report;
  }
}
