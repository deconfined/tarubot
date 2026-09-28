/**
 * /setup overrides (2.35.0, #46): TaruBot's own member entry in every channel, written while it
 * holds Administrator, so it keeps seeing (and, where it posts, using) every channel once
 * Administrator comes off. Answers 1–3 of #46 (comment 5866249673) and the follow-ups (comment
 * 5869082017), as src/domain/visibility.ts plans them:
 * - a channel no setting names gets View Channel plus the deny mask (answer 2); a configured one
 *   gets what it needs and never the mask;
 * - a deliberate View deny on TaruBot wins and is never overwritten (answer 3);
 * - a private category holding a configured channel is left alone with everything inside it and
 *   reported, for the server owner to fix;
 * - a synced child copies its category's entry, so it stays synced, including on a rerun after a
 *   stopped run (resumeInherit).
 *
 * Only TaruBot's own member entry is ever written, one PUT per channel (src/discord/overrides.ts);
 * nobody else's entry or bit changes. Without `confirm` it is a dry run that writes nothing, and
 * works without Administrator. A real run holds the setup lock of /setup onboarding and
 * onboarding's channel pass, re-checks everything before each write, reads each channel fresh,
 * checks each write by reading it back, and records itself in one 'setup.overrides' audit row,
 * which also records the channels hidden from TaruBot on purpose (so they stay recognisable once
 * Discord obfuscates them and Administrator is off).
 */
import { ChannelType } from "discord.js";
import { eq } from "drizzle-orm";
import { effectsPaused } from "../domain/failures.js";
import {
  type CorePermission,
  LABELLED_PERMISSIONS,
  type PermissionKey,
  permissionKeys,
  VOICE_DENY_MASK,
} from "../domain/permissions.js";
import type { Actor } from "../domain/policy.js";
import { authorizeRoleManager } from "../domain/policy.js";
import { Failure } from "../domain/values.js";
import {
  analyseVisibility,
  channelState,
  type Inherit,
  type OverrideEntry,
  type OverrideTarget,
  overrideTarget,
  type PrivateCategory,
  planOverrides,
  resumeInherit,
  sameOverwriteSet,
  unreadable,
  type VisibilityChannel,
  type VisibilityGuild,
  type VisibilityReport,
  type VisibilitySettings,
  visibilitySettings,
} from "../domain/visibility.js";
import { audit } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { requeueParked } from "../jobs/queue.js";
import type { GuildRecord } from "./records.js";
import type { EffectsMode } from "./results.js";
import type { Service } from "./service.js";
import { loadVisibilityRecords } from "./visibility-records.js";

/** Why a dry run's confirm:true would refuse, in the order the real run checks. */
export type OverridesBlocker = "caller" | "effects" | "administrator" | "base_permissions";
/** Why a real run stopped before its plan was done. */
export type OverridesStop = "permissions" | "changed" | "precondition" | "time" | "stopping";

/** One write of TaruBot's own entry, as replies show it. */
export interface OverridesWrite {
  readonly id: string;
  readonly kind: "category" | "channel";
  readonly posting: boolean;
  /** Granted bits. */
  readonly allow: readonly PermissionKey[];
  /** Deny-mask bits newly set. */
  readonly deny: readonly PermissionKey[];
  /** Deny bits lifted from a configured channel (only Read Message History). */
  readonly cleared: readonly PermissionKey[];
  readonly inherited: boolean;
  readonly unsyncs: boolean;
}

/** What every result but onboarding's reports. */
interface OverridesCommon {
  readonly hiddenOnPurpose: readonly string[];
  /**
   * Those hidden only through a category hidden from TaruBot on purpose (VisibilityReport's
   * hiddenByCategory; a channel the real run's fresh reads found so is listed as hidden only).
   */
  readonly hiddenByCategory: readonly string[];
  readonly denied: readonly string[];
  /** Left alone, reported with the fix. */
  readonly privateCategories: readonly PrivateCategory[];
  /** Core permissions TaruBot's roles lack once Administrator is off. */
  readonly grantBeforeRemoving: readonly CorePermission[];
  /** The Administrator roles TaruBot holds; guildId stands for @everyone. */
  readonly administratorRoles: readonly string[];
  /** Those that are neither its bot role nor @everyone, removed from TaruBot rather than edited. */
  readonly administratorShared: readonly string[];
  readonly effectsMode: EffectsMode;
}

export type OverridesResult =
  | { readonly status: "onboarding"; readonly effectsMode: EffectsMode }
  | (OverridesCommon & {
      readonly status: "plan";
      readonly writes: readonly OverridesWrite[];
      /** Missing entries whose real overwrites TaruBot can't read until Administrator is on. */
      readonly unreadable: readonly string[];
      readonly blockers: readonly OverridesBlocker[];
    })
  | (OverridesCommon & {
      readonly status: "nothing";
      /** Parked jobs a real run put back in the queue; always 0 for a dry run. */
      readonly requeued: number;
    })
  | (OverridesCommon & {
      readonly status: "applied" | "stopped";
      readonly written: readonly OverridesWrite[];
      readonly skipped: readonly string[];
      /** The subset of skipped that Discord refused (HTTP 400, or 404 other than 10003). */
      readonly refused: readonly string[];
      /**
       * Writes a shutdown aborted in flight: Discord may or may not have them. (A write that
       * failed any other way throws; the audit row lists it as unconfirmed too.)
       */
      readonly unconfirmed: readonly string[];
      /** Written, but Discord stored other bits than sent beyond what the read-back requires. */
      readonly normalized: readonly string[];
      /** Planned writes not reached. */
      readonly remaining: number;
      readonly stopped: OverridesStop | null;
      /** Parked jobs of the server put back in the queue. */
      readonly requeued: number;
    });

/** What the run needs to know about TaruBot and the person asking. */
export interface OverridesFacts {
  /** A role TaruBot holds (or @everyone) grants Administrator. */
  readonly botAdministrator: boolean;
  /** The caller is the owner or holds Administrator; null when not checked or uncached. */
  readonly callerAllowed: boolean | null;
  /** TaruBot's roles keep all four posting permissions once Administrator is off. */
  readonly basePostingHeld: boolean;
}

/** A fresh read of one channel. An `ok` channel always carries `fetched: true`. */
export type ChannelRead =
  | { readonly state: "ok"; readonly channel: VisibilityChannel }
  | { readonly state: "deleted" }
  | { readonly state: "hidden" };

/** The Discord side of the run (DiscordOverrides; the fixture in tests). */
export interface OverridesPort {
  /**
   * TaruBot's view from the gateway caches; `fresh` fetches roles and its member first (two REST
   * reads no abort signal reaches), otherwise it reads the caches only and makes no request.
   */
  snapshot(guild: string, fresh: boolean): Promise<VisibilityGuild | null>;
  facts(guild: string, caller: string | null, fresh: boolean): Promise<OverridesFacts>;
  read(guild: string, channel: string, signal: AbortSignal): Promise<ChannelRead>;
  write(
    guild: string,
    channel: string,
    entry: OverrideEntry,
    reason: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly state: "written" | "deleted" | "forbidden" }
    | { readonly state: "refused"; readonly code: number }
  >;
}

/** A real run's time budget, the fresh reads of unreadable entries included. */
export const OVERRIDES_TIME_BUDGET_MS = 600_000;
/** How long drain() waits for a stopped run to write its audit. */
const DRAIN_WAIT_MS = 5_000;

/** The approved refusals (#46 spec §9), in the order the real run checks them. */
const CALLER_REFUSAL =
  "Only someone with Administrator, or the server owner, can run /setup overrides confirm:true.";
const ADMINISTRATOR_REFUSAL =
  "TaruBot needs Administrator while /setup overrides confirm:true runs. Turn it on for TaruBot's role, run it again, then remove it once /config validate says it is no longer needed.";
const BASE_REFUSAL =
  "Give TaruBot's role View Channel, Send Messages, Embed Links and Read Message History first, so it keeps them once Administrator is off; /config validate lists what's missing.";
const BUSY_REFUSAL =
  "Another /setup or channel pass for this server is in progress. Try again in a minute.";

/** One target as the reply shows it. */
function writeOf(target: OverrideTarget): OverridesWrite {
  return {
    id: target.channelId,
    kind: target.kind,
    posting: target.posting,
    allow: permissionKeys(target.granted, LABELLED_PERMISSIONS),
    deny: permissionKeys(target.masked, LABELLED_PERMISSIONS),
    cleared: permissionKeys(target.cleared, LABELLED_PERMISSIONS),
    inherited: target.inherited,
    unsyncs: target.unsyncs,
  };
}

/** Distinct IDs in first-seen order. */
const distinct = (ids: readonly string[]): string[] => [...new Set(ids)];

/** A snapshot with one channel replaced (or dropped when `channel` is null). */
function replaced(
  guild: VisibilityGuild,
  id: string,
  channel: VisibilityChannel | null,
): VisibilityGuild {
  return {
    ...guild,
    channels: guild.channels.flatMap((entry) =>
      entry.id !== id ? [entry] : channel ? [channel] : [],
    ),
  };
}

/** TaruBot's own member entry in a channel, or 0/0. */
function ownEntry(guild: VisibilityGuild, channel: VisibilityChannel): OverrideEntry {
  const entry = channel.overwrites.find((item) => item.type === 1 && item.id === guild.bot.id);
  return entry ? { allow: BigInt(entry.allow), deny: BigInt(entry.deny) } : { allow: 0n, deny: 0n };
}

/**
 * The planned inherit Discord already carried out, as this run's write, or null. Discord copies a
 * category's overwrite changes to the children synced with it (Topics › Permissions, "Permission
 * Syncing"), so after this run writes a category, a child `planned` to copy its entry may read
 * fresh with that entry in place and still synced: the category's overwrites before the write,
 * with TaruBot's entry as written. That child is visible, so overrideTarget returns null, but the
 * change is this run's, and the reply and the audit count it with the dry run's before (the
 * snapshot's), flagged propagated. `inherit` must be the entry this run wrote to the child's
 * category; a resumed one never qualifies.
 */
function propagatedWrite(
  guild: VisibilityGuild,
  planned: OverrideTarget,
  fresh: VisibilityChannel,
  inherit: Inherit,
): OverrideTarget | null {
  if (!planned.inherited || fresh.parentId !== inherit.parentId) return null;
  const after = inherit.parentAfter;
  const copied = [
    ...inherit.parentBefore.filter((entry) => !(entry.type === 1 && entry.id === guild.bot.id)),
    { id: guild.bot.id, type: 1, allow: String(after.allow), deny: String(after.deny) },
  ];
  if (!sameOverwriteSet(fresh.overwrites, copied, guild.guildId)) return null;
  const before = planned.before ?? { allow: 0n, deny: 0n };
  return {
    ...planned,
    after,
    granted: after.allow & ~before.allow,
    masked: after.deny & ~before.deny & VOICE_DENY_MASK,
    cleared: before.deny & ~after.deny & VOICE_DENY_MASK,
    inherited: true,
    unsyncs: false,
  };
}

/**
 * The read-back rule: every planned allow bit is allowed and not denied, and no planned deny bit
 * is allowed. "pass" when Discord stored exactly what was sent, "normalized" when it passes with
 * other differences (Discord may drop a deny bit it doesn't apply to that channel type).
 */
function readBack(after: OverrideEntry, got: OverrideEntry): "pass" | "normalized" | "fail" {
  if ((got.allow & after.allow) !== after.allow || (got.deny & after.allow) !== 0n) return "fail";
  if ((got.allow & after.deny) !== 0n) return "fail";
  return got.allow === after.allow && got.deny === after.deny ? "pass" : "normalized";
}

/** A thrown abort, from the run's own controller (drain) rather than Discord. */
const aborted = (signal: AbortSignal): boolean => signal.aborted;

/** One real run in progress, for drain(). */
interface ActiveRun {
  stop: boolean;
  readonly controller: AbortController;
  /** Settles once the run has written its audit (never rejects). */
  done: Promise<void>;
}

/**
 * The /setup overrides runs of this process. RoleAdministration owns one and delegates to it;
 * drain() stops every real run in progress at shutdown.
 */
export class ChannelOverrides {
  private readonly runs = new Set<ActiveRun>();
  /** Set once shutdown drains: real runs that haven't started are refused. */
  private draining = false;

  constructor(
    private readonly app: Service,
    private readonly port: OverridesPort,
  ) {}

  /** The dry run (confirm false) or the real run (true); see the module comment. */
  async run(actor: Actor, confirm: boolean): Promise<OverridesResult> {
    authorizeRoleManager(actor);
    const guild = await this.app.guild(actor);
    const effectsMode = this.app.effectsMode(guild);
    // Onboarding writes TaruBot's channel access itself (its channel pass), for both kinds of run.
    if (guild.access_policy_enabled) return { status: "onboarding", effectsMode };
    const facts = await this.port.facts(guild.id, actor.userId, true);
    if (!confirm) return this.plan(guild, facts);
    if (this.draining)
      throw new Failure("stopping", "Shutdown began before /setup overrides could start.");
    // The real run's preconditions, which throw in this order before anything is locked or read.
    if (facts.callerAllowed !== true)
      throw new Failure("forbidden", CALLER_REFUSAL, 0, { kind: "scope", scope: "administrator" });
    if (!this.effectsOn(guild)) throw effectsPaused(this.app.config.ENABLE_EFFECTS);
    if (!facts.botAdministrator) throw new Failure("blocked", ADMINISTRATOR_REFUSAL);
    if (!facts.basePostingHeld) throw new Failure("blocked", BASE_REFUSAL);
    const run: ActiveRun = {
      stop: false,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    const work = this.apply(actor, run);
    run.done = work.then(
      () => {},
      () => {},
    );
    this.runs.add(run);
    try {
      return await work;
    } finally {
      this.runs.delete(run);
    }
  }

  /**
   * Stop every real run in progress: set its stop flag, abort its in-flight request, and wait
   * (about 5 s at most) until it has written its audit. Runs that haven't started are refused
   * from now on. Never rejects.
   */
  async drain(): Promise<void> {
    this.draining = true;
    const runs = [...this.runs];
    for (const run of runs) {
      run.stop = true;
      run.controller.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(runs.map((run) => run.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DRAIN_WAIT_MS);
      }),
    ]).catch(() => {});
    if (timer) clearTimeout(timer);
  }

  /** Deployment and server switches both allow Discord changes. */
  private effectsOn(guild: Pick<GuildRecord, "effects_enabled">): boolean {
    return this.app.config.ENABLE_EFFECTS && guild.effects_enabled;
  }

  /**
   * The view the plan is made from: the snapshot with unreadable entries read fresh. With
   * Administrator TaruBot can read every channel, so an entry whose cached overwrites are
   * synthetic (obfuscated, or option-patched) is read fresh and judged on its real ones: a deleted
   * one drops out, one still hidden stays unreadable. Without it they stay listed. The reads stop
   * at the deadline or a drain (`cut`), leaving the rest unreadable.
   */
  private async view(
    guild: GuildRecord,
    administrator: boolean,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{
    snapshot: VisibilityGuild;
    settings: VisibilitySettings;
    recorded: string[];
    cut: "time" | "stopping" | null;
  }> {
    const records = await loadVisibilityRecords(this.app.db.orm, guild.id);
    const settings = visibilitySettings(guild, records);
    const cached = await this.port.snapshot(guild.id, true);
    if (!cached)
      throw new Failure(
        "transient",
        "Discord hasn't delivered this server's channels yet. Try again in a minute.",
      );
    let snapshot = cached;
    let cut: "time" | "stopping" | null = null;
    if (administrator)
      for (const channel of cached.channels) {
        if (!unreadable(cached, channel)) continue;
        if (signal.aborted) cut = "stopping";
        else if (performance.now() >= deadline) cut = "time";
        if (cut) break;
        let read: ChannelRead;
        try {
          read = await this.port.read(guild.id, channel.id, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
          cut = "stopping";
          break;
        }
        if (read.state === "ok") snapshot = replaced(snapshot, channel.id, read.channel);
        else if (read.state === "deleted") snapshot = replaced(snapshot, channel.id, null);
      }
    return { snapshot, settings, recorded: [...records.recordedHidden], cut };
  }

  /** The fields every result but onboarding's carries. */
  private common(
    guild: GuildRecord,
    report: VisibilityReport,
    extra: { hidden?: readonly string[]; denied?: readonly string[] } = {},
  ): OverridesCommon {
    return {
      hiddenOnPurpose: distinct([...report.hiddenOnPurpose, ...(extra.hidden ?? [])]),
      hiddenByCategory: report.hiddenByCategory,
      denied: distinct([...report.denied, ...(extra.denied ?? [])]),
      privateCategories: report.privateCategories,
      grantBeforeRemoving: report.core
        .filter((row) => row.source === "missing")
        .map((row) => row.permission),
      administratorRoles: report.administrator.roles,
      administratorShared: report.administrator.shared,
      effectsMode: this.app.effectsMode(guild),
    };
  }

  /** The dry run: what confirm:true would write and what would refuse it. Writes nothing. */
  private async plan(guild: GuildRecord, facts: OverridesFacts): Promise<OverridesResult> {
    const deadline = performance.now() + OVERRIDES_TIME_BUDGET_MS;
    const { snapshot, settings } = await this.view(
      guild,
      facts.botAdministrator,
      new AbortController().signal,
      deadline,
    );
    const report = analyseVisibility(snapshot, settings);
    const writes = planOverrides(snapshot, settings).map(writeOf);
    const blockers: OverridesBlocker[] = [];
    if (facts.callerAllowed !== true) blockers.push("caller");
    if (!this.effectsOn(guild)) blockers.push("effects");
    if (!facts.botAdministrator) blockers.push("administrator");
    if (!facts.basePostingHeld) blockers.push("base_permissions");
    const common = this.common(guild, report);
    const unreadableIds = report.missing.unreadable;
    if (writes.length === 0 && unreadableIds.length === 0)
      return { ...common, status: "nothing", requeued: 0 };
    return { ...common, status: "plan", writes, unreadable: unreadableIds, blockers };
  }

  /** The real run under the setup lock; the preconditions have passed. */
  private async apply(actor: Actor, run: ActiveRun): Promise<OverridesResult> {
    const guildId = actor.guildId;
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [`setup:${guildId}`],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("busy", BUSY_REFUSAL);
      return await this.locked(actor, run);
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`setup:${guildId}`])
          .catch(() => {});
      connection.release();
    }
  }

  /**
   * The real run's body, holding the lock: the baseline, the view and plan, the loop, and then
   * always (even when something threw) one audit row with the parked jobs requeued.
   */
  private async locked(actor: Actor, run: ActiveRun): Promise<OverridesResult> {
    // The baseline: the server row as the lock found it. Every write re-checks its revision.
    const baseline = await this.app.guild(actor);
    if (baseline.access_policy_enabled)
      return { status: "onboarding", effectsMode: this.app.effectsMode(baseline) };
    if (!this.effectsOn(baseline)) throw effectsPaused(this.app.config.ENABLE_EFFECTS);
    const signal = run.controller.signal;
    const deadline = performance.now() + OVERRIDES_TIME_BUDGET_MS;
    // What the audit records, filled as the run goes.
    const context: Omit<LoopContext, "snapshot" | "settings" | "report" | "plan"> = {
      baseline,
      run,
      deadline,
      reason: `TaruBot /setup overrides by ${actor.userId}`,
      written: [],
      skipped: [],
      refused: [],
      unconfirmed: [],
      normalized: [],
      freshHidden: [],
      freshDenied: [],
    };
    let stopped: OverridesStop | null = null;
    // The plan's length once made (the audit's `remaining`); null while no plan exists.
    let planned: number | null = null;
    let recordedBefore: string[] = [];
    let recorded: string[] | null = null;
    let result: OverridesResult | undefined;
    let failure: { error: unknown } | undefined;
    try {
      // The preconditions confirmed Administrator, so unreadable entries are read fresh.
      const view = await this.view(baseline, true, signal, deadline);
      recordedBefore = view.recorded;
      const { snapshot, settings } = view;
      const report = analyseVisibility(snapshot, settings);
      const plan = planOverrides(snapshot, settings);
      planned = plan.length;
      // What this run judged hidden on purpose or denied from real data: readable entries only,
      // since an unreadable one is judged from the recorded set itself.
      const readable = new Set(
        snapshot.channels
          .filter((channel) => !unreadable(snapshot, channel))
          .map((channel) => channel.id),
      );
      const judged = [...report.hiddenOnPurpose, ...report.denied].filter((id) => readable.has(id));
      // Recorded before and still unreadable here: this run couldn't look (still hidden, or the
      // deadline or a drain ended the fresh reads first), so the earlier judgement stands.
      const unexamined = recordedBefore.filter(
        (id) => snapshot.channels.some((channel) => channel.id === id) && !readable.has(id),
      );
      recorded = [...judged, ...unexamined];
      const common = this.common(baseline, report);
      if (view.cut) {
        stopped = view.cut;
        result = {
          ...common,
          status: "stopped",
          written: [],
          skipped: [],
          refused: [],
          unconfirmed: [],
          normalized: [],
          remaining: plan.length,
          stopped,
          requeued: 0,
        };
      } else if (plan.length === 0) result = { ...common, status: "nothing", requeued: 0 };
      else {
        const loop = await this.loop({ ...context, snapshot, settings, report, plan });
        stopped = loop.stopped;
        result = {
          ...this.common(baseline, report, {
            hidden: context.freshHidden,
            denied: context.freshDenied,
          }),
          status: stopped ? "stopped" : "applied",
          written: context.written.map(({ target }) => writeOf(target)),
          skipped: [...context.skipped],
          refused: context.refused.map((entry) => entry.id),
          unconfirmed: [...context.unconfirmed],
          normalized: [...context.normalized],
          remaining: loop.remaining,
          stopped,
          requeued: 0,
        };
      }
    } catch (error) {
      failure = { error };
    }
    // Always, even after a throw: one audit row (and the requeue) on one client.
    let requeued = 0;
    try {
      requeued = await this.record(actor, context, {
        stopped,
        failed: failure !== undefined,
        planned,
        nothing: result?.status === "nothing",
        recordedBefore,
        recorded,
      });
    } catch (auditError) {
      if (failure) throw new AggregateError([failure.error, auditError], "/setup overrides failed");
      throw auditError;
    }
    if (failure) throw failure.error;
    if (!result) throw new Error("/setup overrides ended without a result");
    return "requeued" in result ? { ...result, requeued } : result;
  }

  /**
   * The run's audit row, written when anything was written, refused or left unconfirmed, or when
   * the recorded hidden set changed. Bits are decimal strings, and only IDs are stored. `failed`
   * marks a run that threw (its reply was a failure card), and `remaining` counts the planned
   * channels it never reached (null when it threw before planning): a run that threw partway
   * never reads as a complete one.
   *
   * requeueParked runs in the same transaction, or alone when no audit row is due, whenever the
   * channels may have changed for the better: something was written, a write's outcome is unknown
   * (Discord may have applied it), or a real run found nothing to add (TaruBot's entries are
   * already in place, perhaps from such a write or by hand). Jobs parked on a channel TaruBot
   * couldn't use run again; requeueing work parked for another reason is harmless, as after a
   * /config save. No revision bump and no repair pass, since no setting changed. Returns the
   * number of jobs requeued.
   */
  private async record(
    actor: Actor,
    context: Omit<LoopContext, "snapshot" | "settings" | "report" | "plan">,
    run: {
      readonly stopped: OverridesStop | null;
      readonly failed: boolean;
      readonly planned: number | null;
      readonly nothing: boolean;
      readonly recordedBefore: readonly string[];
      readonly recorded: readonly string[] | null;
    },
  ): Promise<number> {
    const { stopped, recordedBefore, recorded } = run;
    const guildId = context.baseline.id;
    // Nothing examined (a throw before the view): the recorded set stays as it was. Deliberate
    // denies the loop found on its fresh reads join it, even when the run then threw.
    const hidden = distinct([
      ...(recorded ?? recordedBefore),
      ...context.freshHidden,
      ...context.freshDenied,
    ]).sort();
    const changed = hidden.join(",") !== distinct(recordedBefore).sort().join(",");
    const { written, skipped, refused, unconfirmed, normalized } = context;
    const audited = written.length > 0 || unconfirmed.length > 0 || refused.length > 0 || changed;
    const requeue = written.length > 0 || unconfirmed.length > 0 || run.nothing;
    if (!audited && !requeue) return 0;
    // Every planned channel the loop dealt with is in written, skipped or unconfirmed (refused and
    // hidden ones are skipped too), so the rest were never reached, as the stopped reply counts.
    const reached = new Set([
      ...written.map(({ target }) => target.channelId),
      ...skipped,
      ...unconfirmed,
    ]);
    const remaining = run.planned === null ? null : Math.max(0, run.planned - reached.size);
    return this.app.db.transaction(async (client) => {
      if (!audited) return (await requeueParked(client, [guildId], ["blocked", "disabled"])).length;
      await audit(client, guildId, actor.userId, "setup.overrides", guildId, {
        written: written.map(({ target, propagated }) => ({
          id: target.channelId,
          kind: target.kind,
          before: target.before
            ? { allow: String(target.before.allow), deny: String(target.before.deny) }
            : null,
          after: { allow: String(target.after.allow), deny: String(target.after.deny) },
          // Discord copied the category's write here; TaruBot sent no PUT for this channel.
          ...(propagated ? { propagated: true } : {}),
        })),
        skipped,
        refused,
        unconfirmed,
        normalized,
        hiddenOnPurpose: hidden,
        stopped,
        failed: run.failed,
        remaining,
      });
      if (!requeue) return 0;
      return (await requeueParked(client, [guildId], ["blocked", "disabled"])).length;
    });
  }

  /** The write loop over the plan, categories first; returns why it stopped and what's left. */
  private async loop(
    context: LoopContext,
  ): Promise<{ stopped: OverridesStop | null; remaining: number }> {
    const { baseline, snapshot, settings, report, plan, run, deadline, reason } = context;
    const guildId = baseline.id;
    const signal = run.controller.signal;
    const privateIds = new Set(report.privateCategories.map((entry) => entry.id));
    const configured = new Set(settings.configured);
    const plannedCategories = new Set(
      plan.filter((target) => target.kind === "category").map((target) => target.channelId),
    );
    // Categories this run wrote: their synced children copy the entry (fresh pre-write state).
    const writtenCategories = new Map<string, Inherit>();
    // Categories an interrupted earlier run wrote, which this plan doesn't: read fresh once each.
    const resumable = new Set(
      snapshot.channels
        .filter(
          (channel) =>
            channel.type === ChannelType.GuildCategory &&
            !plannedCategories.has(channel.id) &&
            resumeInherit(snapshot, channel, settings) !== null,
        )
        .map((channel) => channel.id),
    );
    const resumed = new Map<string, Inherit>();
    let index = 0;
    const stop = (why: OverridesStop) => ({ stopped: why, remaining: plan.length - index });
    for (; index < plan.length; index++) {
      const target = plan[index];
      if (!target) break;
      const id = target.channelId;
      // 1. Re-check everything the preconditions and the baseline established.
      if (run.stop) return stop("stopping");
      if (performance.now() >= deadline) return stop("time");
      if (!(await this.current(baseline))) return stop("precondition");
      const facts = await this.port.facts(guildId, null, false);
      if (!facts.botAdministrator || !facts.basePostingHeld) return stop("precondition");
      if (target.kind === "category") {
        // A configured channel moved into this category since the plan would make it a private
        // category, which the server owner decides about; the rerun plans from the new state.
        // Parent IDs come from the gateway's channel cache either way, so this reads the caches
        // only: a REST read here would take no abort signal, and a drain landing during a slow one
        // could outlast DRAIN_WAIT_MS and lose the audit of writes already made.
        const now = await this.port.snapshot(guildId, false);
        if (!now) return stop("precondition");
        if (now.channels.some((channel) => channel.parentId === id && configured.has(channel.id)))
          return stop("changed");
      }
      // 2. Read the channel fresh.
      let read: ChannelRead;
      try {
        read = await this.port.read(guildId, id, signal);
      } catch (error) {
        if (run.stop && aborted(signal)) return stop("stopping");
        throw error;
      }
      if (read.state === "deleted") {
        context.skipped.push(id);
        continue;
      }
      if (read.state === "hidden") return stop("permissions");
      const fresh = read.channel;
      // Never inside a private category, whatever the fresh read says.
      if (privateIds.has(id) || (fresh.parentId !== null && privateIds.has(fresh.parentId))) {
        context.skipped.push(id);
        continue;
      }
      // 3. Recompute on the fresh read, with the inherit its category gives it.
      let inherit: Inherit | null = null;
      const parent = fresh.parentId;
      if (parent !== null && writtenCategories.has(parent))
        inherit = writtenCategories.get(parent) ?? null;
      else if (parent !== null && plannedCategories.has(parent)) {
        // Its category was planned but not written (Discord refused it, or it was deleted):
        // writing the child alone would unsync it, masking the siblings one by one, which
        // @deconfined rejected. It is left for the rerun.
        context.skipped.push(id);
        continue;
      } else if (parent !== null && resumable.has(parent)) {
        let lent = resumed.get(parent);
        if (!lent) {
          let category: ChannelRead;
          try {
            category = await this.port.read(guildId, parent, signal);
          } catch (error) {
            if (run.stop && aborted(signal)) return stop("stopping");
            throw error;
          }
          if (category.state !== "ok") return stop("changed");
          const fromFresh = resumeInherit(
            replaced(snapshot, parent, category.channel),
            category.channel,
            settings,
          );
          if (!fromFresh) return stop("changed");
          lent = fromFresh;
          resumed.set(parent, lent);
        }
        inherit = lent;
      }
      const recomputed = overrideTarget(snapshot, fresh, settings, inherit);
      if (!recomputed) {
        // Discord may already have copied this run's category write here (propagatedWrite).
        const copied =
          parent !== null && writtenCategories.get(parent) === inherit && inherit !== null
            ? propagatedWrite(snapshot, target, fresh, inherit)
            : null;
        if (copied) {
          context.written.push({ target: copied, propagated: true });
          continue;
        }
        const state = channelState(snapshot, fresh, settings);
        if (state === "hidden_on_purpose") context.freshHidden.push(id);
        else if (state === "denied") context.freshDenied.push(id);
        context.skipped.push(id);
        continue;
      }
      // 4. Write TaruBot's own entry, and nothing else.
      let outcome: Awaited<ReturnType<OverridesPort["write"]>>;
      try {
        outcome = await this.port.write(guildId, id, recomputed.after, reason, signal);
      } catch (error) {
        // Discord may or may not have applied a PUT that ended this way: a drain's abort, or a
        // 5xx, timeout or socket error that outlasted discord.js's retries. The audit lists it as
        // unconfirmed either way, before the stop or the rethrow (the Discord-unavailable card).
        context.unconfirmed.push(id);
        if (run.stop && aborted(signal)) {
          index++;
          return stop("stopping");
        }
        throw error;
      }
      if (outcome.state === "deleted") {
        context.skipped.push(id);
        continue;
      }
      if (outcome.state === "forbidden") return stop("permissions");
      if (outcome.state === "refused") {
        context.skipped.push(id);
        context.refused.push({ id, code: outcome.code });
        continue;
      }
      context.written.push({ target: recomputed });
      if (recomputed.kind === "category")
        writtenCategories.set(id, {
          parentId: id,
          parentBefore: fresh.overwrites,
          parentAfter: recomputed.after,
        });
      // 5. Read it back.
      let back: ChannelRead;
      try {
        back = await this.port.read(guildId, id, signal);
      } catch (error) {
        if (run.stop && aborted(signal)) {
          index++;
          return stop("stopping");
        }
        throw error;
      }
      if (back.state === "deleted") continue;
      if (back.state === "hidden") {
        index++;
        return stop("changed");
      }
      const check = readBack(recomputed.after, ownEntry(snapshot, back.channel));
      if (check === "fail") {
        index++;
        return stop("changed");
      }
      if (check === "normalized") context.normalized.push(id);
    }
    return { stopped: null, remaining: 0 };
  }

  /** The server row still matches the baseline: active, onboarding off, effects on, same revision. */
  private async current(baseline: GuildRecord): Promise<boolean> {
    if (!this.app.config.ENABLE_EFFECTS) return false;
    const [row] = await this.app.db.orm
      .select({
        active: t.guilds.active,
        onboarding: t.guilds.access_policy_enabled,
        effects: t.guilds.effects_enabled,
        revision: t.guilds.revision,
      })
      .from(t.guilds)
      .where(eq(t.guilds.id, baseline.id));
    return (
      row?.active === true && !row.onboarding && row.effects && row.revision === baseline.revision
    );
  }
}

/** What one real run's loop reads and records. */
interface LoopContext {
  readonly baseline: GuildRecord;
  readonly snapshot: VisibilityGuild;
  readonly settings: VisibilitySettings;
  readonly report: VisibilityReport;
  readonly plan: readonly OverrideTarget[];
  readonly run: ActiveRun;
  readonly deadline: number;
  readonly reason: string;
  /** Every write of this run; `propagated` when Discord copied its category's write there. */
  readonly written: { target: OverrideTarget; propagated?: boolean }[];
  readonly skipped: string[];
  readonly refused: { id: string; code: number }[];
  readonly unconfirmed: string[];
  readonly normalized: string[];
  readonly freshHidden: string[];
  readonly freshDenied: string[];
}
