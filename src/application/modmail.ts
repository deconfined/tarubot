/**
 * Mod mail's application operations (2.43.0, issue #60; owner decisions of 2026-10-11). A member or
 * guest opens a case with /modmail or with the Mod mail page's Open a case form, both through
 * ModMail.open, so the two can't drift apart; the conversation with the server's officers then
 * happens on the dashboard's Mod mail pages. ModMail (modmailKey) serves the command, the pages and the officers'
 * switch; ModMailNotices, which only the job dispatcher builds, sends the pings and DMs; and
 * ModMailRetention deletes closed cases 90 days after they closed.
 *
 * The rules this file keeps, each beside the code that keeps it:
 * - Access: officers of the server see every case; the opener sees their own while they hold
 *   Member or Guest (and TaruBot has no Administrator). Anyone else is told a case doesn't exist,
 *   so a member probing numbers learns nothing (the page answers a plain 404). Every view of a case
 *   page is recorded in its read log.
 * - Encryption: topics and messages are AES-256-GCM ciphertext bound to their server, case and
 *   field (src/infrastructure/modmail/cipher.ts). Plaintext exists only while a page renders and
 *   while a submission is encrypted: it is never logged, never put in a job payload, an audit row,
 *   an issue report, a ping, a DM, an error message or readiness, and never bound as a query value
 *   (only ciphertext is), so even a failed query's bound values carry none. A field that can't be
 *   decrypted shows a fixed sentence and files one issue report without its content.
 * - Writes: one transaction each, in a fixed lock order: the guild row FOR SHARE, then the
 *   member's own advisory lock (opening, and a member's reply that may reopen, both count their
 *   open cases), then the server's settings row (opening), or the case row FOR UPDATE, then jobs.
 *   Close and reopen compare the case's revision (409 on a race); appends don't, but bump it, so a
 *   Close form drawn before a reply is refused and its officer sees the reply first. A reply carries
 *   an ID its page minted, so a double submit finds the message already there. Each write checks for
 *   shutdown just before it commits, as the role menu's do.
 * - Notifications are jobs carrying the case ID only, coalesced to one per case per 10 minutes.
 *   Mod mail events stay in the case's own tables, never the long-lived audit log: only the
 *   officers' on/off switch is audited.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  afterReply,
  type CaseSide,
  type CaseState,
  canEnable,
  cleanText,
  cleanTopic,
  dmKey,
  type InboxFilter,
  MODMAIL_DM_KIND,
  MODMAIL_LIMITS,
  MODMAIL_PING_KIND,
  mayAccess,
  mayOpen,
  NOTIFY_COALESCE_SECONDS,
  type OpenRefusal,
  type PingEvent,
  type Prerequisites,
  pingKey,
  REOPENED_STATE,
  RETENTION_DAYS,
  type ShownAuthor,
  type Signing,
  shownAuthor,
  sideIn,
  type TextError,
  textProblem,
  caseUrl,
} from "../domain/modmail.js";
import { authorize, type Actor } from "../domain/policy.js";
import { holdsAdministrator } from "../domain/self-roles.js";
import { type OfficerPing, officerPing } from "../domain/visibility.js";
import { Failure, stoppingRefusal } from "../domain/values.js";
import { fieldAad, type ModMailKey, type ModMailCipher } from "../infrastructure/modmail/cipher.js";
import { audit, type Connection, orm, type Orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { type Job, scheduleJob } from "../jobs/queue.js";
import type { GuildRecord } from "./records.js";
import type { Reporter } from "./reporting.js";
import type { EffectsMode } from "./results.js";
import type { Service } from "./service.js";

/**
 * Display names for the user IDs a view shows, resolved when it is rendered and never stored: a
 * server display name, null for someone Discord says has left the server ("A former member" or "A
 * former officer"), and no entry when TaruBot can't tell right now.
 */
export type CaseNames = ReadonlyMap<string, string | null>;

/** The officers' switch and what it needs, for the inbox's settings card. */
export interface ModMailSettings {
  readonly guildId: string;
  /** TaruBot has an active configuration here; without one mod mail can't be turned on. */
  readonly configured: boolean;
  readonly enabled: boolean;
  /** Send it back with the switch (the optimistic lock): 1 before the first change. */
  readonly revision: bigint;
  /** Who last turned it on or off, and when; null before the first change. */
  readonly updatedBy: string | null;
  readonly updatedAt: Date | null;
  readonly prerequisites: Prerequisites;
  /** Pings mention the officer role; without one they still post, mentioning nobody. */
  readonly officerRole: boolean;
  /**
   * Whether that mention notifies officers (domain/visibility.ts's OfficerPing): TaruBot needs
   * Mention Everyone in the officer notifications channel, or a mentionable Officer role. A
   * warning on the card, never a prerequisite. Null when it can't be told (no channel, no role,
   * or no view of the server).
   */
  readonly officerPing: OfficerPing | null;
  /** TaruBot holds Administrator here, so members can't open or read cases; null when unknown. */
  readonly administrator: boolean | null;
  /** Pings and DMs wait while Discord changes are paused. */
  readonly effectsMode: EffectsMode;
}

/** One case in a list. `topic` is null when it can't be decrypted with the current key. */
export interface CaseSummary {
  readonly number: bigint;
  readonly openerId: string;
  readonly topic: string | null;
  readonly state: CaseState;
  /** When the current state began: how long it has waited. */
  readonly stateSince: Date;
  readonly lastActivityAt: Date;
  readonly closedAt: Date | null;
}

/** At most this many cases in one list; the page says when there are more. */
export const LIST_LIMIT = 100;

/** The officers' inbox. */
export interface Inbox {
  readonly filter: InboxFilter;
  readonly cases: readonly CaseSummary[];
  /** The filter matched more than LIST_LIMIT cases. */
  readonly more: boolean;
  /** Cases per state in this server, for the filter links. */
  readonly counts: Readonly<Record<CaseState, number>>;
  readonly settings: ModMailSettings;
  /** The openers' names. */
  readonly names: CaseNames;
}

/** A member's own cases in one server. */
export interface MyCases {
  readonly cases: readonly CaseSummary[];
  readonly more: boolean;
  /** Mod mail is on here, so /modmail and the page's form can open a new case. */
  readonly enabled: boolean;
  /**
   * Why they can't open a case right now (the switch, the key, a limit), or null when they can:
   * the page then offers its Open a case form. A courtesy, as /modmail's form check is: the
   * submission checks everything again in its transaction.
   */
  readonly openRefusal: OpenRefusal | null;
}

/** One row of a thread, as its viewer may see it. */
export interface CaseEntry {
  readonly id: string;
  readonly kind: "message" | "closed" | "reopened";
  readonly author: ShownAuthor;
  /** A message's text; null when it can't be decrypted; undefined for a state line. */
  readonly body?: string | null;
  readonly createdAt: Date;
}

/** One read, for officers only. */
export interface CaseRead {
  readonly readerId: string;
  readonly side: CaseSide;
  /** case: opened the case's page; list: saw its topic in a list (the inbox, or their own). */
  readonly kind: "case" | "list";
  readonly readAt: Date;
}

/** At most this many reads are listed; the log says how many there are in all. */
export const READ_LOG_LIMIT = 50;

/** A case page. The member's view never holds who wrote a reply signed as the officers. */
export interface CaseView {
  readonly guildId: string;
  readonly caseId: string;
  readonly number: bigint;
  /** officer: the officer view (every officer, the opener too if they're one); member otherwise. */
  readonly audience: "officer" | "member";
  /** The viewer's side in this case: the opener is the member side. */
  readonly side: CaseSide;
  readonly openerId: string;
  readonly topic: string | null;
  readonly state: CaseState;
  /** Send it back with Close or Reopen. */
  readonly revision: bigint;
  readonly openedAt: Date;
  readonly stateSince: Date;
  readonly closedAt: Date | null;
  readonly deleteAfter: Date | null;
  readonly entries: readonly CaseEntry[];
  /** Messages so far (state lines don't count), against MODMAIL_LIMITS.messagesPerCase. */
  readonly messages: number;
  /** Officers only: the newest reads, and how many there are in all. Null for the member. */
  readonly reads: readonly CaseRead[] | null;
  readonly readCount: number;
  /** Names for every user ID this view shows. */
  readonly names: CaseNames;
  /** Replies can be sent: the key is valid and the case is under its message limit. */
  readonly canReply: boolean;
  /** The key is missing or invalid, so nothing new can be written or read. */
  readonly keyProblem: boolean;
}

/**
 * How opening a case went. Refusals are expected states, answered without Code or Ref. The last
 * two come only from the web form and its minted case ID: `conflict` when it names someone else's
 * case (a form the page didn't make), `already_opened` when this form already opened a case with
 * different text (sent again after an edit), so the new text isn't silently dropped. The same form
 * sent twice with the same text is `opened` again, with the case it made.
 */
export type OpenOutcome =
  | { readonly status: "opened"; readonly number: bigint; readonly url: string | null }
  | { readonly status: "refused"; readonly reason: OpenRefusal }
  | { readonly status: "invalid"; readonly field: "topic" | "message"; readonly error: TextError }
  | { readonly status: "conflict" }
  | { readonly status: "already_opened"; readonly number: bigint; readonly url: string | null };

/** Why a reply was refused (422), each with its sentence in the view. */
export type ReplyRefusal = TextError | "case_full" | "open_limit";

/**
 * How a reply went: saved (303 to the new message), unchanged (the same form sent twice: 303 to the
 * message it already made), invalid (422 with the text kept), or conflict (409: the form's minted ID
 * names another message, so the form isn't this page's).
 */
export type ReplyOutcome =
  | { readonly status: "saved"; readonly messageId: string }
  | { readonly status: "unchanged"; readonly messageId: string }
  | { readonly status: "invalid"; readonly reason: ReplyRefusal }
  | { readonly status: "conflict" }
  /** The same form already sent a different reply: the new text isn't silently dropped (409). */
  | { readonly status: "resent"; readonly messageId: string };

/** How Close or Reopen went: saved, unchanged (already so), or conflict (409: a stale revision). */
export type StateOutcome =
  | { readonly status: "saved" }
  | { readonly status: "unchanged" }
  | { readonly status: "conflict" };

/** How the officers' switch went; invalid when a prerequisite is missing for turning it on. */
export type ToggleOutcome =
  | { readonly status: "saved" }
  | { readonly status: "unchanged" }
  | { readonly status: "conflict" }
  | { readonly status: "invalid"; readonly prerequisites: Prerequisites };

/** The member's own transaction lock, shared by opening a case and a reply that reopens one. */
const memberLock = (guildId: string, userId: string): string => `modmail:${guildId}:${userId}`;

/** The refusal for writes while the key is missing or invalid (a 503 on the page). */
const keyUnavailable = (): Failure =>
  new Failure(
    "unavailable",
    "Mod mail's encryption key isn't set up on this TaruBot, so nothing can be sent right now. An officer can see why on the Mod mail page.",
  );

/** A UUID as PostgreSQL spells it, the only spelling a form's minted ID is taken in. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A form whose minted ID isn't a UUID: a form the page never made. */
const outOfDateForm = (): Failure =>
  new Failure("input", "This form is out of date. Open the page again, then redo your change.");

/**
 * Whether a query failed on `constraint`'s unique index (SQLSTATE 23505). Drizzle wraps the driver
 * error, so its `cause` is checked too, as the queue's activeJobConflict does.
 */
function uniqueViolation(error: unknown, constraint: string): boolean {
  return [error, error instanceof Error ? error.cause : undefined].some(
    (cause) =>
      typeof cause === "object" &&
      cause !== null &&
      Reflect.get(cause, "code") === "23505" &&
      Reflect.get(cause, "constraint") === constraint,
  );
}

/** A whole number of seconds from a numeric SQL value, never negative. */
const seconds = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.ceil(parsed) : 0;
};

/**
 * Seconds until a new `kind` job for `key` may run: NOTIFY_COALESCE_SECONDS after the last one
 * finished (sent, or failed, so a failing DM never turns into a storm), or 0. The partial index
 * modmail_jobs serves it.
 */
async function caseDelay(client: Connection, kind: string, key: string): Promise<number> {
  const [row] = await orm(client)
    .select({
      wait: sql<number>`extract(epoch FROM max(${t.jobs.completed_at}) + make_interval(secs => ${NOTIFY_COALESCE_SECONDS}) - now())::float8`,
    })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.kind, kind),
        eq(t.jobs.dedupe_key, key),
        inArray(t.jobs.status, ["succeeded", "failed"]),
      ),
    );
  return seconds(row?.wait);
}

/**
 * Seconds until a reply ping for one member may go out: NOTIFY_COALESCE_SECONDS after their
 * latest reply ping in this server, sent or still due, across all their cases, so one member
 * writing in three cases pings the officers at most once per window, not once per case. The
 * cases come from the member's own rows (modmail_cases_opener); the jobs carry no member.
 */
async function memberDelay(client: Connection, guildId: string, openerId: string): Promise<number> {
  const db = orm(client);
  const cases = await db
    .select({ id: t.modmailCases.id })
    .from(t.modmailCases)
    .where(and(eq(t.modmailCases.guild_id, guildId), eq(t.modmailCases.opener_id, openerId)));
  if (cases.length === 0) return 0;
  const [row] = await db
    .select({
      wait: sql<number>`extract(epoch FROM max(CASE WHEN ${t.jobs.status} IN ('succeeded','failed') THEN ${t.jobs.completed_at} ELSE ${t.jobs.due_at} END) + make_interval(secs => ${NOTIFY_COALESCE_SECONDS}) - now())::float8`,
    })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.kind, MODMAIL_PING_KIND),
        inArray(
          t.jobs.dedupe_key,
          cases.map((entry) => pingKey(entry.id)),
        ),
        sql`${t.jobs.payload}->>'event' = 'reply'`,
      ),
    );
  return seconds(row?.wait);
}

/**
 * Schedule a notification job, or make sure the one already holding its key covers this event.
 * A queued one does by itself: it reads the case when it sends. A running one may already have
 * read it (a reply DM mid-send while the officer closes the case), and scheduleJob adds nothing
 * while it holds the key, so the event would be lost. Instead it gets a new generation, which
 * makes the queue run it again once it finishes (queue.ts's completion), due one coalescing
 * window later with this event's payload; the next run decides what to say from the case then.
 */
async function notify(
  client: Connection,
  kind: string,
  key: string,
  payload: Record<string, string>,
  guildId: string,
  delay: number,
): Promise<void> {
  if (await scheduleJob(client, kind, key, payload, guildId, delay)) return;
  await orm(client)
    .update(t.jobs)
    .set({
      generation: sql`${t.jobs.generation}+1`,
      due_at: sql`now() + make_interval(secs => ${Math.max(delay, NOTIFY_COALESCE_SECONDS)})`,
      payload,
    })
    .where(and(eq(t.jobs.dedupe_key, key), eq(t.jobs.status, "running")));
}

/**
 * Queue the officers' ping for a case: the payload is the case ID and what happened, never the
 * text or the member. No user is attached to the job, so no officer view or report names them.
 * A reply ping also waits for the member's own window across their cases (memberDelay).
 */
async function queuePing(
  client: Connection,
  guildId: string,
  caseId: string,
  event: PingEvent,
  openerId: string,
): Promise<void> {
  const key = pingKey(caseId);
  let delay = await caseDelay(client, MODMAIL_PING_KIND, key);
  if (event === "reply") delay = Math.max(delay, await memberDelay(client, guildId, openerId));
  await notify(client, MODMAIL_PING_KIND, key, { caseId, event }, guildId, delay);
}

/** Queue the member's DM for a case; the job reads at send time what to say (reply or close). */
async function queueDm(client: Connection, guildId: string, caseId: string): Promise<void> {
  const key = dmKey(caseId);
  const delay = await caseDelay(client, MODMAIL_DM_KIND, key);
  await notify(client, MODMAIL_DM_KIND, key, { caseId }, guildId, delay);
}

/** The columns a list needs, read with the topic's ciphertext. */
const SUMMARY = {
  id: t.modmailCases.id,
  number: t.modmailCases.number,
  openerId: t.modmailCases.opener_id,
  state: t.modmailCases.state,
  stateSince: t.modmailCases.state_since,
  lastActivityAt: t.modmailCases.last_activity_at,
  closedAt: t.modmailCases.closed_at,
  topic: t.modmailCases.topic,
  topicKeyId: t.modmailCases.topic_key_id,
};

/** One list row as SUMMARY reads it. */
interface SummaryRow {
  readonly id: string;
  readonly number: bigint;
  readonly openerId: string;
  readonly state: CaseState;
  readonly stateSince: Date;
  readonly lastActivityAt: Date;
  readonly closedAt: Date | null;
  readonly topic: Buffer;
  readonly topicKeyId: string;
}

/** The listed cases whose topic a list showed readable, with the reader's side in each. */
function listed(
  rows: readonly SummaryRow[],
  cases: readonly CaseSummary[],
  readerId: string,
): { caseId: string; side: CaseSide }[] {
  return rows.flatMap((row, index) =>
    cases[index]?.topic === null || cases[index] === undefined
      ? []
      : [{ caseId: row.id, side: sideIn(row.openerId, readerId) }],
  );
}

/**
 * What decryption found in one view: fields written under the current key that failed (altered,
 * moved or re-attributed data), and fields written under another key ID (a changed MODMAIL_KEY).
 */
interface Unreadable {
  altered: number;
  otherKey: number;
}

/**
 * Mod mail for the command, the pages and the officers' switch; main.ts provides one as
 * modmailKey. Nothing here writes to Discord: pings and DMs go through jobs (ModMailNotices).
 */
export class ModMail {
  constructor(
    // Private, like SelfRoles': a page that declares only modmailKey must not reach the database,
    // the gateway or the configuration through it.
    private readonly app: Service,
    /** MODMAIL_KEY as startup read it (cipher.ts's readModMailKey). */
    private readonly key: ModMailKey,
    /** The dashboard's origin (Dashboard.origin): null while the web is off. */
    private readonly origin: string | null,
    /** The lifecycle's shutdown flag: writes refuse once it is set, and roll back if set mid-write. */
    private readonly isStopping: () => boolean,
    /** For a field that won't decrypt: one issue report, without its content. */
    private readonly report: Reporter,
  ) {}

  /** The cipher, or null while the key is missing or invalid. */
  private get cipher(): ModMailCipher | null {
    return this.key.status === "on" ? this.key.cipher : null;
  }

  /** What turning mod mail on needs, from the guild row (null: not configured). */
  private prerequisites(guild: Pick<GuildRecord, "officer_notifications_channel_id"> | undefined) {
    const key = this.key.status === "on" ? "ok" : this.key.status === "off" ? "missing" : "invalid";
    return {
      key,
      web: this.origin !== null,
      channel: (guild?.officer_notifications_channel_id ?? null) !== null,
    } as const satisfies Prerequisites;
  }

  /** The active guild row, or undefined. */
  private async guildRow(db: Orm, guildId: string): Promise<GuildRecord | undefined> {
    const [guild] = await db
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
    return guild;
  }

  /** Whether mod mail is on in a server (the navigation shows it to members only then). */
  async enabledIn(guildId: string): Promise<boolean> {
    const [row] = await this.app.db.orm
      .select({ enabled: t.modmailSettings.enabled })
      .from(t.modmailSettings)
      .where(eq(t.modmailSettings.guild_id, guildId));
    return row?.enabled === true;
  }

  /** The officers' settings card. */
  async settings(actor: Actor): Promise<ModMailSettings> {
    authorize(actor, actor.guildId, "officer");
    const db = this.app.db.orm;
    const guild = await this.guildRow(db, actor.guildId);
    const [row] = await db
      .select()
      .from(t.modmailSettings)
      .where(eq(t.modmailSettings.guild_id, actor.guildId));
    // TaruBot's own view from the gateway cache (no request), as Role menu reads it.
    const snapshot = (await this.app.discord.visibility?.(actor.guildId, false)) ?? null;
    return {
      guildId: actor.guildId,
      configured: guild !== undefined,
      enabled: row?.enabled === true,
      revision: row?.revision ?? 1n,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row ? row.updated_at : null,
      prerequisites: this.prerequisites(guild),
      officerRole: (guild?.officer_role_id ?? null) !== null,
      officerPing:
        snapshot && guild
          ? officerPing(snapshot, guild.officer_notifications_channel_id, guild.officer_role_id)
          : null,
      administrator: snapshot ? holdsAdministrator(snapshot) : null,
      effectsMode: this.app.effectsMode(guild ?? { effects_enabled: false }),
    };
  }

  /**
   * Turn mod mail on or off (officers; audited with the actor and the time, the one mod mail event
   * the audit log keeps). Turning it on needs every prerequisite; turning it off needs none and
   * stops new cases only: existing ones stay readable, repliable and closable.
   */
  async toggle(
    actor: Actor,
    request: { readonly enabled: boolean; readonly revision: bigint },
  ): Promise<ToggleOutcome> {
    authorize(actor, actor.guildId, "officer");
    if (this.isStopping()) throw stoppingRefusal();
    return this.app.db.transaction(async (client) => {
      const db = orm(client);
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.active, true)))
        .for("share");
      if (!guild)
        throw new Failure(
          "setup",
          "This server has no TaruBot configuration yet. Start with /config fc link and /config roles, or /setup onboarding for lobby onboarding.",
          0,
          { kind: "setup", missing: "guild" },
        );
      await db.insert(t.modmailSettings).values({ guild_id: guild.id }).onConflictDoNothing();
      const [row] = await db
        .select()
        .from(t.modmailSettings)
        .where(eq(t.modmailSettings.guild_id, guild.id))
        .for("update");
      if (!row) throw new Error("Missing mod mail settings row");
      // The equal-state rule: already so, whatever revision the form carried.
      if (row.enabled === request.enabled) return { status: "unchanged" };
      if (row.revision !== request.revision) return { status: "conflict" };
      const prerequisites = this.prerequisites(guild);
      if (request.enabled && !canEnable(prerequisites)) return { status: "invalid", prerequisites };
      const [saved] = await db
        .update(t.modmailSettings)
        .set({
          enabled: request.enabled,
          revision: sql`${t.modmailSettings.revision}+1`,
          updated_by: actor.userId,
          updated_at: sql`now()`,
        })
        .where(eq(t.modmailSettings.guild_id, guild.id))
        .returning({ revision: t.modmailSettings.revision });
      if (!saved) throw new Error("Missing mod mail settings row");
      await audit(
        client,
        guild.id,
        actor.userId,
        "modmail",
        request.enabled ? "enable" : "disable",
        {
          revision: saved.revision,
        },
      );
      if (this.isStopping()) throw stoppingRefusal();
      return { status: "saved" };
    });
  }

  /** A member's open and 24-hour case counts in one server (the limits). */
  private async counts(db: Orm, guildId: string, userId: string) {
    const [row] = await db
      .select({
        open: sql<number>`(count(*) FILTER (WHERE ${t.modmailCases.state} <> 'closed'))::int`,
        daily: sql<number>`(count(*) FILTER (WHERE ${t.modmailCases.opened_at} > now() - interval '24 hours'))::int`,
      })
      .from(t.modmailCases)
      .where(and(eq(t.modmailCases.guild_id, guildId), eq(t.modmailCases.opener_id, userId)));
    return { open: row?.open ?? 0, daily: row?.daily ?? 0 };
  }

  /** The refusals that need no database: the key, the web, and who may open. */
  private staticRefusal(actor: Pick<Actor, "member" | "guest" | "botAdministrator">) {
    if (this.key.status !== "on") return "key";
    if (this.origin === null) return "web";
    if (actor.member !== true && actor.guest !== true) return "not_member";
    if (actor.botAdministrator !== false) return "administrator";
    return null;
  }

  /**
   * /modmail's check before its form opens (the router's beforeModal: a courtesy, never
   * authorization). It has no resolved actor, only what the interaction carried: the member's role
   * IDs and whether TaruBot holds Administrator in the channel, both free of requests. Two quick
   * reads decide the rest: the guild's bound roles with the switch, then the limits. The
   * submission checks everything again in its transaction.
   */
  async openGate(
    guildId: string,
    userId: string,
    roleIds: readonly string[],
    botAdministrator: boolean,
  ): Promise<OpenRefusal | null> {
    if (this.key.status !== "on") return "key";
    if (this.origin === null) return "web";
    const db = this.app.db.orm;
    const [row] = await db
      .select({
        member: t.guilds.member_role_id,
        guest: t.guilds.guest_role_id,
        enabled: t.modmailSettings.enabled,
      })
      .from(t.guilds)
      .leftJoin(t.modmailSettings, eq(t.modmailSettings.guild_id, t.guilds.id))
      .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
    if (!row) return "not_configured";
    const holds = (role: string | null) => role !== null && roleIds.includes(role);
    const refusal = this.staticRefusal({
      member: holds(row.member),
      guest: holds(row.guest),
      botAdministrator,
    });
    if (refusal) return refusal;
    if (row.enabled !== true) return "off";
    const { open, daily } = await this.counts(db, guildId, userId);
    if (open >= MODMAIL_LIMITS.openCases) return "open_limit";
    if (daily >= MODMAIL_LIMITS.dailyCases) return "daily_limit";
    return null;
  }

  /**
   * Why `actor` can't open a case right now, or null when they can: the Mod mail page's courtesy
   * before it offers its form, as openGate is /modmail's. The same rules in the same order as
   * open(), read outside a transaction; the submission checks them all again under its locks.
   */
  private async openRefusal(db: Orm, actor: Actor, enabled: boolean): Promise<OpenRefusal | null> {
    const refusal = this.staticRefusal(actor);
    if (refusal) return refusal;
    if (!enabled) return "off";
    const { open, daily } = await this.counts(db, actor.guildId, actor.userId);
    if (open >= MODMAIL_LIMITS.openCases) return "open_limit";
    if (daily >= MODMAIL_LIMITS.dailyCases) return "daily_limit";
    return null;
  }

  /**
   * The case a web form's minted ID already names: anyone else's is a conflict. This member's in
   * this server is the same form sent again: opened, with its number, when its topic and first
   * message decrypt to the text just sent; already_opened when they don't (the form was edited and
   * sent again, or the stored text can't be read), so the new text comes back to the member rather
   * than being dropped. Null when the ID is new. Called under the member's lock, so the first
   * message can't change underneath.
   */
  private async openedBefore(
    db: Orm,
    caseId: string,
    guildId: string,
    userId: string,
    sent: { readonly topic: string; readonly body: string },
  ): Promise<OpenOutcome | null> {
    const [existing] = await db
      .select({
        guildId: t.modmailCases.guild_id,
        openerId: t.modmailCases.opener_id,
        number: t.modmailCases.number,
        topic: t.modmailCases.topic,
        topicKeyId: t.modmailCases.topic_key_id,
      })
      .from(t.modmailCases)
      .where(eq(t.modmailCases.id, caseId));
    if (!existing) return null;
    if (existing.guildId !== guildId || existing.openerId !== userId) return { status: "conflict" };
    const [first] = await db
      .select({
        id: t.modmailMessages.id,
        body: t.modmailMessages.body,
        keyId: t.modmailMessages.key_id,
      })
      .from(t.modmailMessages)
      .where(and(eq(t.modmailMessages.case_id, caseId), eq(t.modmailMessages.kind, "message")))
      .orderBy(asc(t.modmailMessages.seq))
      .limit(1);
    const cipher = this.cipher;
    const binding = { guildId, caseId, openerId: userId };
    const topic = cipher?.decrypt(
      existing.topic,
      existing.topicKeyId,
      fieldAad(binding, { topic: true }),
    );
    const body =
      cipher && first?.body && first.keyId
        ? cipher.decrypt(
            first.body,
            first.keyId,
            fieldAad(binding, {
              message: {
                id: first.id,
                authorId: userId,
                side: "member",
                signedAs: null,
                kind: "message",
              },
            }),
          )
        : null;
    const url = this.origin === null ? null : caseUrl(this.origin, guildId, existing.number);
    return topic === sent.topic && body === sent.body
      ? { status: "opened", number: existing.number, url }
      : { status: "already_opened", number: existing.number, url };
  }

  /**
   * Open a case: the one path for /modmail's form and the Mod mail page's Open a case form, so the
   * rules can't drift between them (the actor resolved fresh either way, as for any command or
   * page POST). Everything the forms' checks looked at is checked again here, the switch and the
   * limits inside the transaction, under the member's own lock (two forms at once, from Discord
   * and the web say, can't both pass the limits) and the settings row's (which also numbers the
   * case: one UPDATE, so concurrent opens in one server get distinct numbers in order). Then the
   * case and its first message, encrypted, and the officers' ping. A member in a Discord time-out
   * may open one (mayOpen says why; only the web form can reach them then).
   *
   * The web form carries a case ID minted with its page (`caseId`), so the same form sent twice
   * finds the case it made instead of opening another; /modmail's form can't be submitted twice,
   * and leaves it out.
   */
  async open(
    actor: Actor,
    input: { readonly topic: string; readonly body: string; readonly caseId?: string },
  ): Promise<OpenOutcome> {
    authorize(actor, actor.guildId, "user");
    // Lowercase, as PostgreSQL stores it: the AAD names the case ID as stored.
    const minted = input.caseId?.toLowerCase();
    if (minted !== undefined && !CANONICAL_UUID.test(minted)) throw outOfDateForm();
    const refusal = this.staticRefusal(actor);
    if (refusal) return { status: "refused", reason: refusal };
    const cipher = this.cipher;
    if (!cipher || !mayOpen(actor)) throw new Error("Mod mail's static checks disagree");
    const topic = cleanTopic(input.topic);
    const body = cleanText(input.body);
    const topicError = textProblem(topic, MODMAIL_LIMITS.topicChars);
    if (topicError) return { status: "invalid", field: "topic", error: topicError };
    const bodyError = textProblem(body, MODMAIL_LIMITS.messageChars);
    if (bodyError) return { status: "invalid", field: "message", error: bodyError };
    if (this.isStopping()) throw stoppingRefusal();
    const guildId = actor.guildId;
    const userId = actor.userId;
    try {
      return await this.openCase(cipher, guildId, userId, topic, body, minted);
    } catch (error) {
      // The same minted ID sent by two people at once (a copied form): the loser meets the primary
      // key after the winner committed, under a different member lock. The same member's two
      // sends are serialized by their lock, so the second finds the case first.
      if (minted === undefined || !uniqueViolation(error, "modmail_cases_pkey")) throw error;
      return (
        (await this.openedBefore(this.app.db.orm, minted, guildId, userId, { topic, body })) ?? {
          status: "conflict",
        }
      );
    }
  }

  /** open()'s transaction, once the text and the static checks passed. */
  private async openCase(
    cipher: ModMailCipher,
    guildId: string,
    userId: string,
    topic: string,
    body: string,
    minted: string | undefined,
  ): Promise<OpenOutcome> {
    return this.app.db.transaction(async (client): Promise<OpenOutcome> => {
      const db = orm(client);
      const [guild] = await db
        .select({ id: t.guilds.id })
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)))
        .for("share");
      if (!guild) return { status: "refused", reason: "not_configured" };
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        memberLock(guildId, userId),
      ]);
      // A repeat of the same web form finds its case before the switch and the limits, which the
      // case it made may itself have reached.
      if (minted !== undefined) {
        const repeat = await this.openedBefore(db, minted, guildId, userId, { topic, body });
        if (repeat) return repeat;
      }
      const [settings] = await db
        .select({ enabled: t.modmailSettings.enabled })
        .from(t.modmailSettings)
        .where(eq(t.modmailSettings.guild_id, guildId))
        .for("update");
      if (settings?.enabled !== true) return { status: "refused", reason: "off" };
      const { open, daily } = await this.counts(db, guildId, userId);
      if (open >= MODMAIL_LIMITS.openCases) return { status: "refused", reason: "open_limit" };
      if (daily >= MODMAIL_LIMITS.dailyCases) return { status: "refused", reason: "daily_limit" };
      const [counter] = await db
        .update(t.modmailSettings)
        .set({ last_number: sql`${t.modmailSettings.last_number}+1` })
        .where(eq(t.modmailSettings.guild_id, guildId))
        .returning({ number: t.modmailSettings.last_number });
      if (!counter) throw new Error("Missing mod mail settings row");
      // Both IDs are settled here, before encrypting, since the AAD names them.
      const caseId = minted ?? randomUUID();
      const messageId = randomUUID();
      const binding = { guildId, caseId, openerId: userId };
      const sealedTopic = cipher.encrypt(topic, fieldAad(binding, { topic: true }), "topic");
      const sealedBody = cipher.encrypt(
        body,
        fieldAad(binding, {
          message: {
            id: messageId,
            authorId: userId,
            side: "member",
            signedAs: null,
            kind: "message",
          },
        }),
        "message",
      );
      await db.insert(t.modmailCases).values({
        id: caseId,
        guild_id: guildId,
        number: counter.number,
        opener_id: userId,
        state: "officers",
        topic: sealedTopic.data,
        topic_key_id: sealedTopic.keyId,
      });
      await db.insert(t.modmailMessages).values({
        id: messageId,
        case_id: caseId,
        kind: "message",
        author_id: userId,
        side: "member",
        signed_as: null,
        body: sealedBody.data,
        key_id: sealedBody.keyId,
      });
      await queuePing(client, guildId, caseId, "opened", userId);
      if (this.isStopping()) throw stoppingRefusal();
      return {
        status: "opened",
        number: counter.number,
        url: this.origin === null ? null : caseUrl(this.origin, guildId, counter.number),
      };
    });
  }

  /** A case by number in the actor's server, if the actor may see it; otherwise null (a 404). */
  private async accessible(db: Orm, actor: Actor, number: bigint) {
    const [row] = await db
      .select()
      .from(t.modmailCases)
      .where(and(eq(t.modmailCases.guild_id, actor.guildId), eq(t.modmailCases.number, number)));
    return row && mayAccess(actor, row.opener_id) ? row : null;
  }

  /** Decrypt one field, counting a failure instead of throwing. */
  private decrypt(data: Buffer, keyId: string, aad: Buffer, unreadable: Unreadable): string | null {
    const cipher = this.cipher;
    const text = cipher ? cipher.decrypt(data, keyId, aad) : null;
    if (text === null && cipher) {
      if (keyId === cipher.keyId) unreadable.altered += 1;
      else unreadable.otherKey += 1;
    }
    return text;
  }

  /**
   * At most one issue report of each kind per view with fields that wouldn't decrypt, each a fixed
   * message, never which case, member or text: rows written under this key that failed (altered,
   * moved or re-attributed data, possible tampering) and rows under another key ID (a changed
   * MODMAIL_KEY). Their scopes differ, so their fingerprints do too: a real tamper report is never
   * folded into the noise of a key change. Repeats of each group into their own issue. Without a
   * key nothing is reported: the pages already say it's missing.
   */
  private reportUnreadable(unreadable: Unreadable): void {
    if (unreadable.altered > 0)
      this.report(
        new Failure(
          "configuration",
          "Mod mail text written under the current MODMAIL_KEY failed to decrypt: the stored data was altered, moved or re-attributed.",
        ),
        "modmail",
        { scope: "modmail:decrypt-altered" },
      );
    if (unreadable.otherKey > 0)
      this.report(
        new Failure(
          "configuration",
          "Mod mail text was written under another MODMAIL_KEY (its key ID differs), so this TaruBot can't read it.",
        ),
        "modmail",
        { scope: "modmail:decrypt-key" },
      );
  }

  /** Names for the IDs a view shows, from the gateway (cache first); empty when it can't say. */
  private async names(guildId: string, ids: readonly string[]): Promise<CaseNames> {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || !this.app.discord.displayNames) return new Map();
    try {
      return await this.app.discord.displayNames(guildId, unique);
    } catch {
      // Names are decoration: a Discord outage shows IDs (officers) or "An officer" (members).
      return new Map();
    }
  }

  /** Decrypt a list's topics. */
  private summaries(
    guildId: string,
    rows: readonly SummaryRow[],
    unreadable: Unreadable,
  ): CaseSummary[] {
    return rows.map((row) => ({
      number: row.number,
      openerId: row.openerId,
      topic: this.decrypt(
        row.topic,
        row.topicKeyId,
        fieldAad({ guildId, caseId: row.id, openerId: row.openerId }, { topic: true }),
        unreadable,
      ),
      state: row.state,
      stateSince: row.stateSince,
      lastActivityAt: row.lastActivityAt,
      closedAt: row.closedAt,
    }));
  }

  /**
   * The officers' inbox: by default every case not closed, waiting on officers first, each group
   * oldest waiting first; or one state (closed newest first). At most LIST_LIMIT rows.
   */
  async inbox(actor: Actor, filter: InboxFilter): Promise<Inbox> {
    authorize(actor, actor.guildId, "officer");
    const db = this.app.db.orm;
    const guildId = actor.guildId;
    const c = t.modmailCases;
    const where =
      filter === "open"
        ? and(eq(c.guild_id, guildId), ne(c.state, "closed"))
        : and(eq(c.guild_id, guildId), eq(c.state, filter));
    const order =
      filter === "closed"
        ? [desc(c.closed_at), desc(c.number)]
        : [
            sql`CASE WHEN ${c.state} = 'officers' THEN 0 ELSE 1 END`,
            asc(c.state_since),
            asc(c.number),
          ];
    const rows = await db
      .select(SUMMARY)
      .from(c)
      .where(where)
      .orderBy(...order)
      .limit(LIST_LIMIT + 1);
    const grouped = await db
      .select({ state: c.state, count: sql<number>`count(*)::int` })
      .from(c)
      .where(eq(c.guild_id, guildId))
      .groupBy(c.state);
    const counts = { officers: 0, member: 0, closed: 0 };
    for (const row of grouped) counts[row.state] = row.count;
    const unreadable: Unreadable = { altered: 0, otherKey: 0 };
    const shown = rows.slice(0, LIST_LIMIT);
    const cases = this.summaries(guildId, shown, unreadable);
    this.reportUnreadable(unreadable);
    await this.recordListReads(actor.userId, listed(shown, cases, actor.userId));
    return {
      filter,
      cases,
      more: rows.length > LIST_LIMIT,
      counts,
      settings: await this.settings(actor),
      names: await this.names(
        guildId,
        cases.map((entry) => entry.openerId),
      ),
    };
  }

  /**
   * A member's or guest's own cases in this server: open ones first, then by last activity. Only
   * for someone who may use member pages now (the page's flags admit them; this checks again).
   */
  async mine(actor: Actor): Promise<MyCases> {
    authorize(actor, actor.guildId, "user");
    if (!mayAccess({ ...actor, officer: false }, actor.userId))
      throw new Failure("forbidden", "Mod mail is for this server's members and guests.");
    const db = this.app.db.orm;
    const c = t.modmailCases;
    const rows = await db
      .select(SUMMARY)
      .from(c)
      .where(and(eq(c.guild_id, actor.guildId), eq(c.opener_id, actor.userId)))
      .orderBy(sql`CASE WHEN ${c.state} = 'closed' THEN 1 ELSE 0 END`, desc(c.last_activity_at))
      .limit(LIST_LIMIT + 1);
    const unreadable: Unreadable = { altered: 0, otherKey: 0 };
    const shown = rows.slice(0, LIST_LIMIT);
    const cases = this.summaries(actor.guildId, shown, unreadable);
    this.reportUnreadable(unreadable);
    await this.recordListReads(actor.userId, listed(shown, cases, actor.userId));
    const enabled = await this.enabledIn(actor.guildId);
    return {
      cases,
      more: rows.length > LIST_LIMIT,
      enabled,
      openRefusal: await this.openRefusal(db, actor, enabled),
    };
  }

  /**
   * Record that `readerId` viewed a case: one row, unless the same reader already has one from the
   * last minute (a reload, or the page drawn again after a refused form), which bounds what a
   * reader holding F5 can add while keeping who read it and when, to the minute.
   */
  private async recordRead(caseId: string, readerId: string, side: CaseSide): Promise<void> {
    const db = this.app.db.orm;
    const [recent] = await db
      .select({ id: t.modmailReads.id })
      .from(t.modmailReads)
      .where(
        and(
          eq(t.modmailReads.case_id, caseId),
          eq(t.modmailReads.reader_id, readerId),
          eq(t.modmailReads.kind, "case"),
          sql`${t.modmailReads.read_at} > now() - interval '1 minute'`,
        ),
      )
      .limit(1);
    if (!recent)
      await db
        .insert(t.modmailReads)
        .values({ case_id: caseId, reader_id: readerId, side, kind: "case" });
  }

  /**
   * Record that a list showed `readerId` these cases' decrypted topics (#60: every read is
   * recorded): one `list` row per case, unless the same reader already has one for it from the
   * last hour, so the inbox reloaded all afternoon adds a row per case per hour, not per view.
   * Only cases whose topic was readable count; `side` is the reader's in each case.
   */
  private async recordListReads(
    readerId: string,
    seen: readonly { readonly caseId: string; readonly side: CaseSide }[],
  ): Promise<void> {
    if (seen.length === 0) return;
    const db = this.app.db.orm;
    const recent = await db
      .select({ caseId: t.modmailReads.case_id })
      .from(t.modmailReads)
      .where(
        and(
          inArray(
            t.modmailReads.case_id,
            seen.map((entry) => entry.caseId),
          ),
          eq(t.modmailReads.reader_id, readerId),
          eq(t.modmailReads.kind, "list"),
          sql`${t.modmailReads.read_at} > now() - interval '1 hour'`,
        ),
      );
    const already = new Set(recent.map((entry) => entry.caseId));
    const fresh = seen.filter((entry) => !already.has(entry.caseId));
    if (fresh.length > 0)
      await db.insert(t.modmailReads).values(
        fresh.map((entry) => ({
          case_id: entry.caseId,
          reader_id: readerId,
          side: entry.side,
          kind: "list" as const,
        })),
      );
  }

  /**
   * A case page, or null when the case doesn't exist or isn't the actor's to see (the page answers
   * 404 for both). Every view is recorded in the read log first. The member's view names only what
   * they may see: themselves as "you", officers by the name each one signed with, and "the
   * officers" for the rest; officers see the true author of every row and the read log.
   */
  async caseView(actor: Actor, number: bigint): Promise<CaseView | null> {
    authorize(actor, actor.guildId, "user");
    const db = this.app.db.orm;
    const row = await this.accessible(db, actor, number);
    if (!row) return null;
    const side = sideIn(row.opener_id, actor.userId);
    const audience = actor.officer ? "officer" : "member";
    await this.recordRead(row.id, actor.userId, side);
    const stored = await db
      .select()
      .from(t.modmailMessages)
      .where(eq(t.modmailMessages.case_id, row.id))
      .orderBy(asc(t.modmailMessages.seq));
    const unreadable: Unreadable = { altered: 0, otherKey: 0 };
    const guildId = actor.guildId;
    // What every field's AAD binds: a row moved to another case or opener doesn't decrypt.
    const binding = { guildId, caseId: row.id, openerId: row.opener_id };
    const entries: CaseEntry[] = stored.map((entry) => {
      const author = shownAuthor(
        { authorId: entry.author_id, side: entry.side, signedAs: entry.signed_as },
        audience,
      );
      const base = { id: entry.id, kind: entry.kind, author, createdAt: entry.created_at };
      if (entry.kind !== "message" || !entry.body || !entry.key_id) return base;
      return {
        ...base,
        body: this.decrypt(
          entry.body,
          entry.key_id,
          fieldAad(binding, {
            message: {
              id: entry.id,
              authorId: entry.author_id,
              side: entry.side,
              signedAs: entry.signed_as,
              kind: entry.kind,
            },
          }),
          unreadable,
        ),
      };
    });
    const topic = this.decrypt(
      row.topic,
      row.topic_key_id,
      fieldAad(binding, { topic: true }),
      unreadable,
    );
    this.reportUnreadable(unreadable);
    let reads: CaseRead[] | null = null;
    let readCount = 0;
    if (audience === "officer") {
      reads = (
        await db
          .select({
            readerId: t.modmailReads.reader_id,
            side: t.modmailReads.side,
            kind: t.modmailReads.kind,
            readAt: t.modmailReads.read_at,
          })
          .from(t.modmailReads)
          .where(eq(t.modmailReads.case_id, row.id))
          .orderBy(desc(t.modmailReads.read_at), desc(t.modmailReads.id))
          .limit(READ_LOG_LIMIT)
      ).map((read) => ({
        readerId: read.readerId,
        side: read.side,
        kind: read.kind,
        readAt: read.readAt,
      }));
      const [total] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(t.modmailReads)
        .where(eq(t.modmailReads.case_id, row.id));
      readCount = total?.count ?? 0;
    }
    // Only IDs this viewer may see: the member's view holds no officer who signed as the officers.
    const ids = [
      row.opener_id,
      ...entries.flatMap((entry) =>
        entry.author.kind === "person" || entry.author.kind === "officer"
          ? [entry.author.userId]
          : [],
      ),
      ...(reads ?? []).map((read) => read.readerId),
    ];
    const messages = stored.filter((entry) => entry.kind === "message").length;
    return {
      guildId,
      caseId: row.id,
      number: row.number,
      audience,
      side,
      openerId: row.opener_id,
      topic,
      state: row.state,
      revision: row.revision,
      openedAt: row.opened_at,
      stateSince: row.state_since,
      closedAt: row.closed_at,
      deleteAfter: row.delete_after,
      entries,
      messages,
      reads,
      readCount,
      names: await this.names(guildId, ids),
      canReply: this.cipher !== null && messages < MODMAIL_LIMITS.messagesPerCase,
      keyProblem: this.cipher === null,
    };
  }

  /** The signing an officer's close or reopen line takes: their newest reply's here, else officers. */
  private async signingOf(db: Orm, caseId: string, userId: string): Promise<Signing> {
    const [latest] = await db
      .select({ signedAs: t.modmailMessages.signed_as })
      .from(t.modmailMessages)
      .where(
        and(
          eq(t.modmailMessages.case_id, caseId),
          eq(t.modmailMessages.author_id, userId),
          eq(t.modmailMessages.side, "officer"),
          eq(t.modmailMessages.kind, "message"),
        ),
      )
      .orderBy(desc(t.modmailMessages.seq))
      .limit(1);
    return latest?.signedAs ?? "officers";
  }

  /**
   * Add a reply (null: no such case for this actor, a 404). The member's reply waits on officers
   * and pings them; an officer's waits on the member and DMs them. A reply to a closed case reopens
   * it first (a "Reopened" line, the deletion date cleared), unless it is the member's and they
   * already have the most open cases allowed.
   */
  async reply(
    actor: Actor,
    number: bigint,
    input: { readonly messageId: string; readonly body: string; readonly signing: Signing | null },
  ): Promise<ReplyOutcome | null> {
    authorize(actor, actor.guildId, "user");
    if (this.isStopping()) throw stoppingRefusal();
    // PostgreSQL stores a UUID lowercase, and the AAD is built from the ID as stored, so a form's
    // ID is taken in that spelling: an uppercase one would otherwise be sealed under an AAD the
    // stored row never matches again (fieldAad lowercases too, as a backstop).
    const messageId = input.messageId.toLowerCase();
    if (!CANONICAL_UUID.test(messageId)) throw outOfDateForm();
    const found = await this.accessible(this.app.db.orm, actor, number);
    if (!found) return null;
    const cipher = this.cipher;
    if (!cipher) throw keyUnavailable();
    const body = cleanText(input.body);
    const problem = textProblem(body, MODMAIL_LIMITS.messageChars);
    if (problem) return { status: "invalid", reason: problem };
    const side = sideIn(found.opener_id, actor.userId);
    const signing: Signing | null = side === "officer" ? (input.signing ?? "name") : null;
    const guildId = actor.guildId;
    try {
      return await this.app.db.transaction(async (client): Promise<ReplyOutcome | null> => {
        const db = orm(client);
        // A member's reply may reopen the case, which counts against their open cases like
        // opening one, so it takes the same lock first.
        if (side === "member")
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            memberLock(guildId, found.opener_id),
          ]);
        const [row] = await db
          .select()
          .from(t.modmailCases)
          .where(eq(t.modmailCases.id, found.id))
          .for("update");
        // Deleted by retention since the page loaded.
        if (!row) return null;
        // A repeat of the same form finds its message (the ID was minted with the page).
        const repeat = await this.repeated(db, messageId, row, actor.userId, body);
        if (repeat) return repeat;
        const [counted] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(t.modmailMessages)
          .where(and(eq(t.modmailMessages.case_id, row.id), eq(t.modmailMessages.kind, "message")));
        if ((counted?.count ?? 0) >= MODMAIL_LIMITS.messagesPerCase)
          return { status: "invalid", reason: "case_full" };
        const reopening = row.state === "closed";
        // Only the member's own reply counts against their open cases. An officer's reply (or
        // Reopen) may take a member past MODMAIL_LIMITS.openCases on purpose: the limit stops a
        // member flooding the officers, and officers decide which cases they want open.
        if (reopening && side === "member") {
          const { open } = await this.counts(db, guildId, row.opener_id);
          if (open >= MODMAIL_LIMITS.openCases) return { status: "invalid", reason: "open_limit" };
        }
        if (reopening)
          await db.insert(t.modmailMessages).values({
            id: randomUUID(),
            case_id: row.id,
            kind: "reopened",
            author_id: actor.userId,
            side,
            signed_as: signing,
          });
        const sealed = cipher.encrypt(
          body,
          fieldAad(
            { guildId, caseId: row.id, openerId: row.opener_id },
            {
              message: {
                id: messageId,
                authorId: actor.userId,
                side,
                signedAs: signing,
                kind: "message",
              },
            },
          ),
          "message",
        );
        await db.insert(t.modmailMessages).values({
          id: messageId,
          case_id: row.id,
          kind: "message",
          author_id: actor.userId,
          side,
          signed_as: signing,
          body: sealed.data,
          key_id: sealed.keyId,
        });
        const next = afterReply(side);
        await db
          .update(t.modmailCases)
          .set({
            state: next,
            state_since: next === row.state ? row.state_since : sql`now()`,
            last_activity_at: sql`now()`,
            closed_at: null,
            delete_after: null,
            revision: sql`${t.modmailCases.revision}+1`,
          })
          .where(eq(t.modmailCases.id, row.id));
        if (side === "member") await queuePing(client, guildId, row.id, "reply", row.opener_id);
        else await queueDm(client, guildId, row.id);
        if (this.isStopping()) throw stoppingRefusal();
        return { status: "saved", messageId };
      });
    } catch (error) {
      // The same minted ID sent at once twice (two tabs, or one form posted to two cases): the
      // loser meets the primary key after the winner committed. That's the form's repeat or a
      // form this page didn't make, never a fault, so it gets the repeat check's answer.
      if (!uniqueViolation(error, "modmail_messages_pkey")) throw error;
      return (
        (await this.repeated(this.app.db.orm, messageId, found, actor.userId, body)) ?? {
          status: "conflict",
        }
      );
    }
  }

  /**
   * A reply form sent again: its minted ID already names a message. Anyone else's, or one in
   * another case, is a conflict, a form this page didn't make. The same person's in the same case
   * is unchanged when it decrypts to the text just sent (a double submit lands on the same
   * message), and resent when it doesn't (the form was edited and sent again), so the new text
   * comes back rather than being dropped. Null when the ID is new.
   */
  private async repeated(
    db: Orm,
    messageId: string,
    found: Pick<typeof t.modmailCases.$inferSelect, "id" | "guild_id" | "opener_id">,
    userId: string,
    body: string,
  ): Promise<ReplyOutcome | null> {
    const [existing] = await db
      .select({
        caseId: t.modmailMessages.case_id,
        authorId: t.modmailMessages.author_id,
        side: t.modmailMessages.side,
        signedAs: t.modmailMessages.signed_as,
        kind: t.modmailMessages.kind,
        body: t.modmailMessages.body,
        keyId: t.modmailMessages.key_id,
      })
      .from(t.modmailMessages)
      .where(eq(t.modmailMessages.id, messageId));
    if (!existing) return null;
    if (existing.caseId !== found.id || existing.authorId !== userId) return { status: "conflict" };
    const stored =
      this.cipher && existing.kind === "message" && existing.body && existing.keyId
        ? this.cipher.decrypt(
            existing.body,
            existing.keyId,
            fieldAad(
              { guildId: found.guild_id, caseId: found.id, openerId: found.opener_id },
              {
                message: {
                  id: messageId,
                  authorId: userId,
                  side: existing.side,
                  signedAs: existing.signedAs,
                  kind: "message",
                },
              },
            ),
          )
        : null;
    return stored === body ? { status: "unchanged", messageId } : { status: "resent", messageId };
  }

  /**
   * Close a case (either side; null: not this actor's, a 404). Already closed is unchanged, whatever
   * the revision; otherwise a stale revision is a conflict. The deletion date is 90 days on, and an
   * officer's close DMs the member.
   */
  async close(actor: Actor, number: bigint, revision: bigint): Promise<StateOutcome | null> {
    return this.changeState(actor, number, revision, "close");
  }

  /**
   * An officer's Reopen without a reply: the case waits on officers again and its deletion date is
   * cleared. Members reopen by replying, so a member's Reopen is refused.
   */
  async reopen(actor: Actor, number: bigint, revision: bigint): Promise<StateOutcome | null> {
    return this.changeState(actor, number, revision, "reopen");
  }

  private async changeState(
    actor: Actor,
    number: bigint,
    revision: bigint,
    change: "close" | "reopen",
  ): Promise<StateOutcome | null> {
    authorize(actor, actor.guildId, "user");
    if (this.isStopping()) throw stoppingRefusal();
    const found = await this.accessible(this.app.db.orm, actor, number);
    if (!found) return null;
    const side = sideIn(found.opener_id, actor.userId);
    if (change === "reopen" && side === "member")
      throw new Failure("forbidden", "Reply to your case to reopen it.");
    return this.app.db.transaction(async (client): Promise<StateOutcome | null> => {
      const db = orm(client);
      const [row] = await db
        .select()
        .from(t.modmailCases)
        .where(eq(t.modmailCases.id, found.id))
        .for("update");
      if (!row) return null;
      const closed = row.state === "closed";
      if ((change === "close") === closed) return { status: "unchanged" };
      if (row.revision !== revision) return { status: "conflict" };
      await db.insert(t.modmailMessages).values({
        id: randomUUID(),
        case_id: row.id,
        kind: change === "close" ? "closed" : "reopened",
        author_id: actor.userId,
        side,
        signed_as: side === "officer" ? await this.signingOf(db, row.id, actor.userId) : null,
      });
      await db
        .update(t.modmailCases)
        .set(
          change === "close"
            ? {
                state: "closed",
                closed_at: sql`now()`,
                delete_after: sql`now() + make_interval(days => ${RETENTION_DAYS})`,
                state_since: sql`now()`,
                last_activity_at: sql`now()`,
                revision: sql`${t.modmailCases.revision}+1`,
              }
            : {
                state: REOPENED_STATE,
                closed_at: null,
                delete_after: null,
                state_since: sql`now()`,
                last_activity_at: sql`now()`,
                revision: sql`${t.modmailCases.revision}+1`,
              },
        )
        .where(eq(t.modmailCases.id, row.id));
      if (change === "close" && side === "officer") await queueDm(client, actor.guildId, row.id);
      if (this.isStopping()) throw stoppingRefusal();
      return { status: "saved" };
    });
  }
}

/** A notification job's payload: the case, and for a ping what happened. Nothing else. */
const notificationPayload = z.object({
  caseId: z.uuid(),
  event: z.enum(["opened", "reply"]).optional(),
});

/** What a ping or DM job needs from its case: never the text. */
interface NotifiedCase {
  readonly id: string;
  readonly number: bigint;
  readonly openerId: string;
  readonly state: CaseState;
}

/**
 * The pings and DMs (modmail.ping, modmail.dm). It lives apart from ModMail on purpose: it DMs any
 * member from whatever job it is handed, so like RoleChoiceJob it is built only by the job
 * dispatcher (jobs/dispatch.ts) and no service key provides it, so no page can reach it. It reads
 * no text and has no cipher: a ping says which case, a DM which case and server, and both link to
 * the case page.
 */
export class ModMailNotices {
  constructor(
    private readonly app: Service,
    /** The dashboard's origin for the links; null while the web is off. */
    private readonly origin: string | null,
  ) {}

  /** The job's case in its server; null once retention (or a restore) removed it. */
  private async notifiedCase(job: Job): Promise<NotifiedCase | null> {
    if (!job.guild_id) throw new Failure("invalid_job", "A mod mail job needs a server.");
    // Fixed text, never zod's message.
    const parsed = notificationPayload.safeParse(job.payload);
    if (!parsed.success)
      throw new Failure("invalid_job", "A mod mail job's payload can't be read.");
    const [row] = await this.app.db.orm
      .select({
        id: t.modmailCases.id,
        number: t.modmailCases.number,
        openerId: t.modmailCases.opener_id,
        state: t.modmailCases.state,
      })
      .from(t.modmailCases)
      .where(
        and(eq(t.modmailCases.id, parsed.data.caseId), eq(t.modmailCases.guild_id, job.guild_id)),
      );
    return row ?? null;
  }

  /** The case page's link, or null while the web is off. */
  private url(guildId: string, number: bigint): string | null {
    return this.origin === null ? null : caseUrl(this.origin, guildId, number);
  }

  /**
   * Whether the job has nothing to send, decided before the effects gate so nothing parks for
   * nothing (the officer.status precedent): the case is gone; a ping with no officer notifications
   * channel (nothing is saved for later, as for status posts); a DM about nothing an officer did,
   * or that the member has already seen, having viewed the case since the officers' latest reply
   * or close. Returns the skip reason, or null to send.
   */
  async skip(job: Job, guild: GuildRecord): Promise<string | null> {
    const notified = await this.notifiedCase(job);
    if (!notified) return "case gone";
    if (job.kind === MODMAIL_PING_KIND)
      return guild.officer_notifications_channel_id ? null : "officer notifications unconfigured";
    const db = this.app.db.orm;
    const [latest] = await db
      .select({ at: sql<Date | null>`max(${t.modmailMessages.created_at})` })
      .from(t.modmailMessages)
      .where(
        and(eq(t.modmailMessages.case_id, notified.id), eq(t.modmailMessages.side, "officer")),
      );
    const officerAt = latest?.at ? new Date(latest.at) : null;
    if (!officerAt) return "nothing to announce";
    const [seen] = await db
      .select({ id: t.modmailReads.id })
      .from(t.modmailReads)
      .where(
        and(
          eq(t.modmailReads.case_id, notified.id),
          eq(t.modmailReads.reader_id, notified.openerId),
          // Opening the case page, not seeing its topic in a list: that shows no reply.
          eq(t.modmailReads.kind, "case"),
          sql`${t.modmailReads.read_at} >= ${officerAt.toISOString()}::timestamptz`,
        ),
      )
      .limit(1);
    return seen ? "seen on the dashboard" : null;
  }

  /**
   * Post the officers' ping (after the effects gate): "Mod mail case #N opened" or "New reply on mod
   * mail case #N", the officer role mentioned (and only it may ping) when one is set, and a link.
   * No text, no member. The nonce key makes a retry of the same run the same message.
   */
  async ping(job: Job, guild: GuildRecord): Promise<{ messageId: string; channelId: string }> {
    const notified = await this.notifiedCase(job);
    const channel = guild.officer_notifications_channel_id;
    if (!notified || !channel)
      throw new Failure("invalid_job", "Mod mail ping state is unavailable.");
    const parsed = notificationPayload.parse(job.payload);
    const messageId = await this.app.discord.send(
      guild.id,
      channel,
      {
        kind: "modmail",
        view: {
          number: notified.number,
          event: parsed.event ?? "reply",
          url: this.url(guild.id, notified.number),
          // Never @everyone (the server's own ID), whatever the setting says; the gateway checks too.
          roleId: guild.officer_role_id === guild.id ? null : guild.officer_role_id,
        },
      },
      `${job.id}:${job.generation}`,
    );
    return { messageId, channelId: channel };
  }

  /**
   * DM the member (after the effects gate): "An officer replied to…" or, when the case is closed by
   * an officer now, "An officer closed…", with the server's name and a link. DMs closed or the
   * member gone end the job without retries, as decision DMs do (dm_blocked, Unknown User).
   */
  async dm(job: Job, guild: GuildRecord): Promise<void> {
    const notified = await this.notifiedCase(job);
    if (!notified) throw new Failure("invalid_job", "Mod mail DM state is unavailable.");
    const [last] = await this.app.db.orm
      .select({ kind: t.modmailMessages.kind, side: t.modmailMessages.side })
      .from(t.modmailMessages)
      .where(eq(t.modmailMessages.case_id, notified.id))
      .orderBy(desc(t.modmailMessages.seq))
      .limit(1);
    const closed =
      notified.state === "closed" && last?.kind === "closed" && last.side === "officer";
    await this.app.discord.dm(notified.openerId, {
      kind: "modmail",
      guildId: guild.id,
      number: notified.number,
      event: closed ? "closed" : "reply",
      url: this.url(guild.id, notified.number),
    });
  }
}

/** How often retention runs at most. */
export const RETENTION_INTERVAL_MS = 10 * 60_000;
/** How often its timer checks whether a pass is due. */
export const RETENTION_TICK_MS = 60_000;

/** What retention reports to: deleted counts to the log, failures to the reporter. */
export interface RetentionOutput {
  readonly deleted: (count: number) => void;
  readonly report: Reporter;
}

/**
 * Retention (owner decision 2): delete every case whose delete_after has passed, 90 days after it
 * closed; the cascades delete its messages, reads and state lines. It has its own timer (start(),
 * from main.ts once TaruBot is ready), separate from the scheduler's chain of periodic work, so a
 * failure elsewhere never skips it, and each pass catches and reports its own errors. A pass runs
 * only while this process holds the writer lease, at most every RETENTION_INTERVAL_MS by a
 * monotonic clock (performance.now), so a wall-clock step back can't pause it. After a restore
 * the first pass deletes whatever the backup brought back that has since expired.
 */
export class ModMailRetention {
  private last = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(
    private readonly db: Orm,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Prune when RETENTION_INTERVAL_MS has passed since the last pass; returns the cases deleted. */
  async tick(): Promise<number> {
    const now = this.now();
    if (now - this.last < RETENTION_INTERVAL_MS) return 0;
    this.last = now;
    return pruneModMail(this.db);
  }

  /**
   * Check every RETENTION_TICK_MS, while `writer()` says this process holds the writer lease. The
   * timer is unref'd and never rejects; stop() ends it and waits for a pass in progress.
   */
  start(writer: () => boolean, output: RetentionOutput): void {
    if (this.timer) return;
    const pass = () => {
      if (this.running || !writer()) return;
      this.running = this.tick();
      this.running
        .then((deleted) => {
          if (deleted > 0) output.deleted(deleted);
        })
        .catch((error: unknown) => output.report(error, "modmail retention"))
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(pass, RETENTION_TICK_MS);
    this.timer.unref();
    pass();
  }

  /** Stop the timer, letting a pass in progress finish. Never rejects. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running?.catch(() => {});
  }
}

/** Delete the cases past their deletion date; returns how many. Counts only, never which. */
export async function pruneModMail(db: Orm): Promise<number> {
  const deleted = await db
    .delete(t.modmailCases)
    .where(lt(t.modmailCases.delete_after, sql`now()`))
    .returning({ id: t.modmailCases.id });
  return deleted.length;
}
