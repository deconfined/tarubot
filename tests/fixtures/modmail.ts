/**
 * Mod mail for the web harness (2.43.0): a prototype-backed ModMail over an in-memory store, applying
 * the real rules from src/domain/modmail.ts (who may see a case, sides, states, signing, limits and
 * text checks) and ModMail's own permission checks (2.44.0: modmail.settings, modmail.inbox,
 * modmail.read_log and, on the officer side, modmail.respond), so the pages' forms can be tried end
 * to end without a database or a key. Every case, name and message is invented.
 *
 * --state-modmail picks what the store starts with (the default is off, with no cases, so the pages
 * the other tests rely on keep their navigation):
 * - cases: on in Example FC, with cases in every state: the member's case waiting on officers (a
 *   markup-like topic, which must show as text), the guest's waiting on them after a reply the
 *   officer signed as the officers, the timed-out member's (opened during their time-out), a case
 *   from someone who has left, and a closed one with its deletion date;
 * - empty: on, with no cases yet;
 * - off: turned off after cases were opened: they stay readable and repliable, and members no
 *   longer see Mod mail in their navigation;
 * - unreadable: cases, but one topic and one message were written under another key;
 * - nokey: MODMAIL_KEY isn't set, so mod mail can't be turned on, and the cases can't be read or
 *   answered;
 * - long: a case with long messages, line breaks and a long unbroken word, for wrapping checks;
 * - limit: cases, plus two more open ones of the member's, so they hold the 3 open cases allowed
 *   and the Open a case button is unavailable, with its reason;
 * - quiet: cases, but TaruBot can't mention the Officer role in the officer notifications channel
 *   (no Mention Everyone allow there, and the role isn't mentionable), so the settings card warns
 *   that pings notify nobody. Every other state can mention it.
 * Open a case works on the store too, with the real rules (a pause on modmail.open first, mayUse,
 * the switch, the limits and the text checks), and a repeat of the same form finds the case it made.
 * A pause on opening (2.45.0) stops new cases only: the person still lists, reads, answers and
 * closes the cases they have, as ModMail does (mayUse holds the permission, can doesn't).
 */
import { randomUUID } from "node:crypto";
import type {
  CaseEntry,
  CaseNames,
  CaseSummary,
  CaseView,
  Inbox,
  ModMailSettings,
  MyCases,
  OpenOutcome,
  ReplyOutcome,
  StateOutcome,
  ToggleOutcome,
} from "../../src/application/modmail.js";
import { ModMail } from "../../src/application/modmail.js";
import type { EffectsMode } from "../../src/application/results.js";
import {
  afterReply,
  type CaseSide,
  type CaseState,
  canEnable,
  cleanText,
  cleanTopic,
  type InboxFilter,
  MODMAIL_LIMITS,
  mayAccess,
  mayOpen,
  mayUse,
  type OpenRefusal,
  type Prerequisites,
  REOPENED_STATE,
  RETENTION_DAYS,
  type Signing,
  shownAuthor,
  sideIn,
  textProblem,
} from "../../src/domain/modmail.js";
import {
  type Actor,
  authorize,
  can,
  holds,
  pauseOn,
  requireNotPaused,
  requirePermission,
} from "../../src/domain/policy.js";
import type { OfficerPing } from "../../src/domain/visibility.js";
import { Failure } from "../../src/domain/values.js";

/** --state-modmail's values. */
export const HARNESS_MODMAIL_STATES = [
  "cases",
  "empty",
  "off",
  "unreadable",
  "nokey",
  "long",
  "limit",
  "quiet",
] as const;
export type HarnessModMailState = (typeof HARNESS_MODMAIL_STATES)[number];

/** The harness's people, as the fixture needs them (web-dev.ts's HARNESS_ACCOUNTS ids). */
export interface ModMailPeople {
  readonly guild: string;
  readonly officer: string;
  readonly member: string;
  readonly guest: string;
  readonly timedOut: string;
}

/** A second officer who reads cases, and someone who left, both invented. */
export const HARNESS_SECOND_OFFICER = "200000000000000011";
export const HARNESS_FORMER_MEMBER = "200000000000000012";

/** One stored row of a thread. */
interface StoredEntry {
  readonly id: string;
  readonly kind: "message" | "closed" | "reopened";
  readonly authorId: string;
  readonly side: CaseSide;
  readonly signedAs: Signing | null;
  /** A message's text; null when it was written under another key. */
  readonly body?: string | null;
  readonly createdAt: Date;
}

/** One stored case. */
interface StoredCase {
  readonly id: string;
  readonly guildId: string;
  readonly number: bigint;
  readonly openerId: string;
  state: CaseState;
  revision: bigint;
  readonly openedAt: Date;
  stateSince: Date;
  lastActivityAt: Date;
  closedAt: Date | null;
  deleteAfter: Date | null;
  readonly topic: string | null;
  readonly entries: StoredEntry[];
  readonly reads: { readerId: string; side: CaseSide; kind: "case" | "list"; readAt: Date }[];
}

/** The switch per server. */
interface StoredSettings {
  enabled: boolean;
  revision: bigint;
  updatedBy: string | null;
  updatedAt: Date | null;
  lastNumber: bigint;
}

/** The harness's mod mail store, shared by the fake's methods. */
export interface ModMailStore {
  readonly settings: Map<string, StoredSettings>;
  readonly cases: StoredCase[];
  readonly key: Prerequisites["key"];
  /** Whether the officers' ping notifies them (the settings card's Mention Everyone check). */
  readonly ping: OfficerPing;
}

/** What the fake needs from the harness besides its store. */
export interface ModMailOptions {
  readonly people: ModMailPeople;
  /** Display names by user ID; null for someone who left. */
  readonly names: CaseNames;
  /** TaruBot holds Administrator in a server (members can't open or read cases). */
  readonly administrator: (guildId: string) => boolean;
  readonly effectsMode: EffectsMode;
  /** The clock; tests pass their own. */
  readonly now?: () => number;
}

/** An instant `minutes` before `now`. */
const before = (now: number, minutes: number): Date => new Date(now - minutes * 60_000);

/** A stored message. */
const message = (
  authorId: string,
  side: CaseSide,
  body: string | null,
  at: Date,
  signedAs: Signing | null = side === "officer" ? "name" : null,
): StoredEntry => ({
  id: randomUUID(),
  kind: "message",
  authorId,
  side,
  signedAs,
  body,
  createdAt: at,
});

/** The store a review state starts with. */
export function modmailStore(
  state: HarnessModMailState | undefined,
  people: ModMailPeople,
  now: number = Date.now(),
): ModMailStore {
  const settings = new Map<string, StoredSettings>();
  const cases: StoredCase[] = [];
  const key = state === "nokey" ? "missing" : "ok";
  const ping: OfficerPing = state === "quiet" ? "silent" : "allowed";
  if (state === undefined) return { settings, cases, key, ping };
  const enabled = state !== "off" && state !== "nokey";
  settings.set(people.guild, {
    enabled,
    revision: 3n,
    updatedBy: people.officer,
    updatedAt: before(now, 3 * 24 * 60),
    lastNumber: 0n,
  });
  if (state === "empty") return { settings, cases, key, ping };
  const stored = settings.get(people.guild);
  const add = (
    openerId: string,
    topic: string | null,
    state: CaseState,
    openedMinutes: number,
    entries: StoredEntry[],
  ): void => {
    if (!stored) return;
    stored.lastNumber += 1n;
    const last = entries.at(-1)?.createdAt ?? before(now, openedMinutes);
    const closed = state === "closed" ? last : null;
    cases.push({
      id: randomUUID(),
      guildId: people.guild,
      number: stored.lastNumber,
      openerId,
      state,
      revision: BigInt(entries.length + 1),
      openedAt: before(now, openedMinutes),
      stateSince: last,
      lastActivityAt: last,
      closedAt: closed,
      deleteAfter: closed ? new Date(closed.getTime() + RETENTION_DAYS * 86_400_000) : null,
      topic,
      entries,
      reads: [
        {
          readerId: people.officer,
          side: "officer",
          kind: "case",
          readAt: before(now, Math.max(1, openedMinutes - 30)),
        },
        {
          readerId: HARNESS_SECOND_OFFICER,
          side: "officer",
          kind: "list",
          readAt: before(now, Math.max(1, openedMinutes - 40)),
        },
        {
          readerId: HARNESS_SECOND_OFFICER,
          side: "officer",
          kind: "case",
          readAt: before(now, Math.max(1, openedMinutes - 45)),
        },
      ],
    });
  };
  const unreadable = state === "unreadable";
  // A closed case from weeks ago, with its deletion date.
  add(people.member, "Ledger question from last month", "closed", 40 * 24 * 60, [
    message(
      people.member,
      "member",
      "Who approved the chest withdrawal on the 3rd?",
      before(now, 40 * 24 * 60),
    ),
    message(
      people.officer,
      "officer",
      "That was me, for the housing materials. It's in the ledger as #42.",
      before(now, 40 * 24 * 60 - 90),
    ),
    {
      id: randomUUID(),
      kind: "closed",
      authorId: people.officer,
      side: "officer",
      signedAs: "name",
      createdAt: before(now, 40 * 24 * 60 - 100),
    },
  ]);
  // The member's case, waiting on officers, with a topic that looks like markup.
  add(people.member, unreadable ? null : "<b>Raid night</b> & schedule clash", "officers", 5 * 60, [
    message(
      people.member,
      "member",
      "Hi officers,\nThe new raid night clashes with my work shifts.\n\nCould we look at Thursdays instead?",
      before(now, 5 * 60),
    ),
  ]);
  // The guest's case, waiting on them, after a reply signed as the officers.
  add(people.guest, "Can I join the Saturday maps?", "member", 26 * 60, [
    message(
      people.guest,
      "member",
      "I'm a guest here. Am I allowed to join the Saturday treasure maps?",
      before(now, 26 * 60),
    ),
    message(
      people.officer,
      "officer",
      unreadable ? null : "Of course! Guests are welcome. Ping us in #maps on the day.",
      before(now, 25 * 60),
      "officers",
    ),
  ]);
  // The timed-out member's case: mod mail stays open to them during a time-out (to appeal).
  add(people.timedOut, "Appeal: my time-out", "officers", 50, [
    message(
      people.timedOut,
      "member",
      "I think my time-out was a misunderstanding. Can we talk?",
      before(now, 50),
    ),
  ]);
  // Someone who has since left the server.
  add(HARNESS_FORMER_MEMBER, "Leaving the FC", "member", 6 * 24 * 60, [
    message(
      HARNESS_FORMER_MEMBER,
      "member",
      "I'm moving servers, thanks for everything.",
      before(now, 6 * 24 * 60),
    ),
    message(
      HARNESS_SECOND_OFFICER,
      "officer",
      "Safe travels! You're welcome back any time.",
      before(now, 6 * 24 * 60 - 60),
    ),
  ]);
  if (state === "long") {
    const word = "Supercalifragilisticexpialidocious".repeat(6);
    add(
      people.member,
      "A very long topic that keeps going to show how a topic wraps in a narrow column",
      "officers",
      15,
      [
        message(
          people.member,
          "member",
          `${"This is a long message that wraps over several lines. ".repeat(30)}\n\nAnd a long word: ${word}`,
          before(now, 15),
        ),
        message(
          people.officer,
          "officer",
          "Line one\nLine two\n\n    Indented line four\nhttps://example.org/a/really/long/path/that/should/wrap/without/pushing/the/page/sideways",
          before(now, 10),
        ),
        message(people.member, "member", "x".repeat(MODMAIL_LIMITS.messageChars), before(now, 5)),
      ],
    );
  }
  if (state === "limit") {
    // Two more open cases of the member's: with case 2 they hold the most allowed at once.
    add(people.member, "Housing plot for the FC", "member", 3 * 24 * 60, [
      message(
        people.member,
        "member",
        "Could the FC buy the medium plot in the Goblet?",
        before(now, 3 * 24 * 60),
      ),
      message(
        people.officer,
        "officer",
        "We'll vote on it on Sunday. Any ward you'd prefer?",
        before(now, 2 * 24 * 60),
      ),
    ]);
    add(people.member, "Crafting orders", "officers", 2 * 60, [
      message(
        people.member,
        "member",
        "Is there a list of the crafting orders the FC still needs?",
        before(now, 2 * 60),
      ),
    ]);
  }
  return { settings, cases, key, ping };
}

/** The fake ModMail over `store`. */
export function harnessModMail(store: ModMailStore, options: ModMailOptions): ModMail {
  const modmail: unknown = Object.create(ModMail.prototype);
  if (!(modmail instanceof ModMail)) throw new Error("Invalid mod mail fake");
  const now = (): Date => new Date((options.now ?? Date.now)());
  const settingsOf = (guildId: string): StoredSettings => {
    let entry = store.settings.get(guildId);
    if (!entry) {
      entry = { enabled: false, revision: 1n, updatedBy: null, updatedAt: null, lastNumber: 0n };
      store.settings.set(guildId, entry);
    }
    return entry;
  };
  const prerequisites = (): Prerequisites => ({ key: store.key, web: true, channel: true });
  const caseOf = (actor: Actor, number: bigint): StoredCase | null => {
    const found = store.cases.find(
      (entry) => entry.guildId === actor.guildId && entry.number === number,
    );
    return found && mayAccess(actor, found.openerId) ? found : null;
  };
  const summary = (entry: StoredCase): CaseSummary => ({
    number: entry.number,
    openerId: entry.openerId,
    topic: store.key === "ok" ? entry.topic : null,
    state: entry.state,
    stateSince: entry.stateSince,
    lastActivityAt: entry.lastActivityAt,
    closedAt: entry.closedAt,
  });
  const namesFor = (ids: readonly string[]): CaseNames =>
    new Map(
      ids.filter((id) => options.names.has(id)).map((id) => [id, options.names.get(id) ?? null]),
    );
  const settings = (actor: Actor): ModMailSettings => {
    const stored = settingsOf(actor.guildId);
    return {
      guildId: actor.guildId,
      configured: true,
      enabled: stored.enabled,
      revision: stored.revision,
      updatedBy: stored.updatedBy,
      updatedAt: stored.updatedAt,
      prerequisites: prerequisites(),
      officerRole: true,
      officerPing: store.ping,
      administrator: options.administrator(actor.guildId),
      effectsMode: options.effectsMode,
    };
  };
  modmail.enabledIn = async (guildId: string) => settingsOf(guildId).enabled;
  modmail.settings = async (actor: Actor) => {
    requirePermission(actor, actor.guildId, "modmail.settings");
    return settings(actor);
  };
  modmail.toggle = async (actor, request): Promise<ToggleOutcome> => {
    requirePermission(actor, actor.guildId, "modmail.settings");
    const stored = settingsOf(actor.guildId);
    if (stored.enabled === request.enabled) return { status: "unchanged" };
    if (stored.revision !== request.revision) return { status: "conflict" };
    if (request.enabled && !canEnable(prerequisites()))
      return { status: "invalid", prerequisites: prerequisites() };
    stored.enabled = request.enabled;
    stored.revision += 1n;
    stored.updatedBy = actor.userId;
    stored.updatedAt = now();
    return { status: "saved" };
  };
  /** A list showed these cases' topics: one list read per reader per case per hour. */
  const listRead = (actor: Actor, cases: readonly StoredCase[]): void => {
    if (store.key !== "ok") return;
    const at = now();
    for (const entry of cases) {
      if (entry.topic === null) continue;
      const recent = entry.reads.some(
        (read) =>
          read.readerId === actor.userId &&
          read.kind === "list" &&
          at.getTime() - read.readAt.getTime() < 3_600_000,
      );
      if (!recent)
        entry.reads.unshift({
          readerId: actor.userId,
          side: sideIn(entry.openerId, actor.userId),
          kind: "list",
          readAt: at,
        });
    }
  };
  modmail.inbox = async (actor: Actor, filter: InboxFilter): Promise<Inbox> => {
    requirePermission(actor, actor.guildId, "modmail.inbox");
    const mine = store.cases.filter((entry) => entry.guildId === actor.guildId);
    const counts = { officers: 0, member: 0, closed: 0 };
    for (const entry of mine) counts[entry.state] += 1;
    const shown = mine
      .filter((entry) => (filter === "open" ? entry.state !== "closed" : entry.state === filter))
      .sort((a, b) =>
        filter === "closed"
          ? (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0)
          : (a.state === "officers" ? 0 : 1) - (b.state === "officers" ? 0 : 1) ||
            a.stateSince.getTime() - b.stateSince.getTime(),
      );
    listRead(actor, shown);
    return {
      filter,
      cases: shown.map(summary),
      more: false,
      counts,
      settings: settings(actor),
      names: namesFor(shown.map((entry) => entry.openerId)),
    };
  };
  modmail.mine = async (actor: Actor): Promise<MyCases> => {
    authorize(actor, actor.guildId);
    // mayUse, not mayOpen: a pause on opening leaves the person their list of cases.
    if (!mayUse(actor))
      throw new Failure("forbidden", "Mod mail is for this server's members and guests.");
    const mine = store.cases
      .filter((entry) => entry.guildId === actor.guildId && entry.openerId === actor.userId)
      .sort(
        (a, b) =>
          (a.state === "closed" ? 1 : 0) - (b.state === "closed" ? 1 : 0) ||
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
      );
    listRead(actor, mine);
    return {
      cases: mine.map(summary),
      more: false,
      enabled: settingsOf(actor.guildId).enabled,
      openRefusal: openRefusal(actor),
    };
  };
  /** Why `actor` can't open a case now, in ModMail.open's order; null when they can. */
  const openRefusal = (actor: Actor): OpenRefusal | null => {
    if (store.key !== "ok") return "key";
    if (!holds(actor, "modmail.open")) return "not_member";
    if (actor.botAdministrator !== false) return "administrator";
    // After the static refusals and before the switch and the limits, as ModMail.openRefusal.
    if (pauseOn(actor, "modmail.open")) return "paused";
    if (!settingsOf(actor.guildId).enabled) return "off";
    const mine = store.cases.filter(
      (entry) => entry.guildId === actor.guildId && entry.openerId === actor.userId,
    );
    if (mine.filter((entry) => entry.state !== "closed").length >= MODMAIL_LIMITS.openCases)
      return "open_limit";
    const day = now().getTime() - 86_400_000;
    if (mine.filter((entry) => entry.openedAt.getTime() > day).length >= MODMAIL_LIMITS.dailyCases)
      return "daily_limit";
    return null;
  };
  modmail.open = async (actor, input): Promise<OpenOutcome> => {
    authorize(actor, actor.guildId);
    // A pause is its own refusal, ahead of everything else, a repeat of a form that made a case
    // included (the real ModMail.open does the same before it reads anything).
    requireNotPaused(actor, "modmail.open");
    const caseId = input.caseId?.toLowerCase();
    const topic = cleanTopic(input.topic);
    const body = cleanText(input.body);
    // A repeat of the same web form finds the case it made, opened again only with the same text;
    // anyone else's is a conflict.
    const existing = store.cases.find((entry) => entry.id === caseId);
    if (existing) {
      if (existing.guildId !== actor.guildId || existing.openerId !== actor.userId)
        return { status: "conflict" };
      const first = existing.entries.find((entry) => entry.kind === "message");
      return existing.topic === topic && first?.body === body
        ? { status: "opened", number: existing.number, url: null }
        : { status: "already_opened", number: existing.number, url: null };
    }
    const topicError = textProblem(topic, MODMAIL_LIMITS.topicChars);
    if (topicError) return { status: "invalid", field: "topic", error: topicError };
    const bodyError = textProblem(body, MODMAIL_LIMITS.messageChars);
    if (bodyError) return { status: "invalid", field: "message", error: bodyError };
    const refusal = openRefusal(actor);
    if (refusal) return { status: "refused", reason: refusal };
    if (!mayOpen(actor)) throw new Error("The fake's checks disagree");
    const settings = settingsOf(actor.guildId);
    settings.lastNumber += 1n;
    const at = now();
    store.cases.push({
      id: caseId ?? randomUUID(),
      guildId: actor.guildId,
      number: settings.lastNumber,
      openerId: actor.userId,
      state: "officers",
      revision: 1n,
      openedAt: at,
      stateSince: at,
      lastActivityAt: at,
      closedAt: null,
      deleteAfter: null,
      topic,
      entries: [message(actor.userId, "member", body, at)],
      reads: [],
    });
    return { status: "opened", number: settings.lastNumber, url: null };
  };
  modmail.caseView = async (actor: Actor, number: bigint): Promise<CaseView | null> => {
    authorize(actor, actor.guildId);
    const found = caseOf(actor, number);
    if (!found) return null;
    const side = sideIn(found.openerId, actor.userId);
    const audience = can(actor, "modmail.inbox") ? "officer" : "member";
    const at = now();
    const recent = found.reads.find(
      (read) =>
        read.readerId === actor.userId &&
        read.kind === "case" &&
        at.getTime() - read.readAt.getTime() < 60_000,
    );
    if (!recent) found.reads.unshift({ readerId: actor.userId, side, kind: "case", readAt: at });
    const readable = store.key === "ok";
    const entries: CaseEntry[] = found.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      author: shownAuthor(
        { authorId: entry.authorId, side: entry.side, signedAs: entry.signedAs },
        audience,
      ),
      createdAt: entry.createdAt,
      ...(entry.kind === "message" && { body: readable ? (entry.body ?? null) : null }),
    }));
    // Newest first, as the read log query orders them; only with modmail.read_log.
    const readLog = can(actor, "modmail.read_log");
    const reads = readLog
      ? [...found.reads].sort((a, b) => b.readAt.getTime() - a.readAt.getTime()).slice(0, 50)
      : null;
    const ids = [
      found.openerId,
      ...entries.flatMap((entry) =>
        entry.author.kind === "person" || entry.author.kind === "officer"
          ? [entry.author.userId]
          : [],
      ),
      ...(reads ?? []).map((read) => read.readerId),
    ];
    const messages = found.entries.filter((entry) => entry.kind === "message").length;
    return {
      guildId: actor.guildId,
      caseId: found.id,
      number: found.number,
      audience,
      side,
      openerId: found.openerId,
      topic: readable ? found.topic : null,
      state: found.state,
      revision: found.revision,
      openedAt: found.openedAt,
      stateSince: found.stateSince,
      closedAt: found.closedAt,
      deleteAfter: found.deleteAfter,
      entries,
      messages,
      reads,
      readCount: readLog ? found.reads.length : 0,
      names: namesFor(ids),
      canReply: readable && messages < MODMAIL_LIMITS.messagesPerCase,
      canRespond: side === "member" || can(actor, "modmail.respond"),
      keyProblem: !readable,
    };
  };
  modmail.reply = async (actor, number, input): Promise<ReplyOutcome | null> => {
    authorize(actor, actor.guildId);
    const found = caseOf(actor, number);
    if (!found) return null;
    if (store.key !== "ok")
      throw new Failure("unavailable", "Mod mail's encryption key isn't set up on this TaruBot.");
    const body = cleanText(input.body);
    const problem = textProblem(body, MODMAIL_LIMITS.messageChars);
    if (problem) return { status: "invalid", reason: problem };
    const side = sideIn(found.openerId, actor.userId);
    // As ModMail.reply: reading every case isn't answering them; the opener's side needs no more.
    if (side === "officer") requirePermission(actor, actor.guildId, "modmail.respond");
    const existing = store.cases
      .flatMap((entry) => entry.entries.map((row) => ({ entry, row })))
      .find(({ row }) => row.id === input.messageId);
    if (existing)
      return existing.entry !== found || existing.row.authorId !== actor.userId
        ? { status: "conflict" }
        : existing.row.body === body
          ? { status: "unchanged", messageId: input.messageId }
          : { status: "resent", messageId: input.messageId };
    if (
      found.entries.filter((entry) => entry.kind === "message").length >=
      MODMAIL_LIMITS.messagesPerCase
    )
      return { status: "invalid", reason: "case_full" };
    const signedAs = side === "officer" ? (input.signing ?? "name") : null;
    const at = now();
    if (found.state === "closed") {
      if (side === "member") {
        const open = store.cases.filter(
          (entry) =>
            entry.guildId === found.guildId &&
            entry.openerId === found.openerId &&
            entry.state !== "closed",
        ).length;
        if (open >= MODMAIL_LIMITS.openCases) return { status: "invalid", reason: "open_limit" };
      }
      found.entries.push({
        id: randomUUID(),
        kind: "reopened",
        authorId: actor.userId,
        side,
        signedAs,
        createdAt: at,
      });
    }
    found.entries.push({
      id: input.messageId,
      kind: "message",
      authorId: actor.userId,
      side,
      signedAs,
      body,
      createdAt: at,
    });
    const next = afterReply(side);
    if (next !== found.state) found.stateSince = at;
    found.state = next;
    found.lastActivityAt = at;
    found.closedAt = null;
    found.deleteAfter = null;
    found.revision += 1n;
    return { status: "saved", messageId: input.messageId };
  };
  const change = (
    actor: Actor,
    number: bigint,
    revision: bigint,
    to: "close" | "reopen",
  ): StateOutcome | null => {
    authorize(actor, actor.guildId);
    const found = caseOf(actor, number);
    if (!found) return null;
    const side = sideIn(found.openerId, actor.userId);
    if (side === "officer") requirePermission(actor, actor.guildId, "modmail.respond");
    if (to === "reopen" && side === "member")
      throw new Failure("forbidden", "Reply to your case to reopen it.");
    if ((to === "close") === (found.state === "closed")) return { status: "unchanged" };
    if (found.revision !== revision) return { status: "conflict" };
    const at = now();
    const signedAs: Signing | null =
      side === "officer"
        ? (found.entries.findLast(
            (entry) => entry.authorId === actor.userId && entry.kind === "message",
          )?.signedAs ?? "officers")
        : null;
    found.entries.push({
      id: randomUUID(),
      kind: to === "close" ? "closed" : "reopened",
      authorId: actor.userId,
      side,
      signedAs,
      createdAt: at,
    });
    found.state = to === "close" ? "closed" : REOPENED_STATE;
    found.stateSince = at;
    found.lastActivityAt = at;
    found.closedAt = to === "close" ? at : null;
    found.deleteAfter =
      to === "close" ? new Date(at.getTime() + RETENTION_DAYS * 86_400_000) : null;
    found.revision += 1n;
    return { status: "saved" };
  };
  modmail.close = async (actor, number, revision) => change(actor, number, revision, "close");
  modmail.reopen = async (actor, number, revision) => change(actor, number, revision, "reopen");
  modmail.openGate = async () => (store.key === "ok" ? null : "key");
  return modmail;
}
