/**
 * Mod mail's rules (2.43.0, issue #60; owner decisions of 2026-10-11): who may open a case, the
 * limits, the states and how replies and closes move between them, how text is checked, how the
 * thread names its authors to each audience, and the fixed sentences every surface uses. Pure; the
 * application (src/application/modmail.ts) applies them inside its transactions, and the harness
 * and tests use the same functions.
 *
 * A case is opened with /modmail's form in Discord or the Mod mail page's Open a case form; the
 * conversation lives on the dashboard. Officer pings and member DMs carry a case number and a link,
 * never the text or the member's name, and TaruBot never reads messages or DMs (no message
 * intents).
 */
import { can, holds, type Actor } from "./policy.js";

/** A case's state: waiting on officers, waiting on the member, or closed. */
export type CaseState = "officers" | "member" | "closed";

/** Every state, in the inbox's order: what needs officers first. */
export const CASE_STATES = ["officers", "member", "closed"] as const satisfies readonly CaseState[];

/** The inbox's filters: every case not closed (the default), one state, or the closed ones. */
export const INBOX_FILTERS = ["open", "officers", "member", "closed"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** Who wrote a row or did a thing: the member who opened the case, or an officer. */
export type CaseSide = "member" | "officer";

/** How an officer signs one reply or close: with their server name, or as "The officers". */
export type Signing = "name" | "officers";

/** A thread row: a message, or a line of the state history. */
export type EntryKind = "message" | "closed" | "reopened";

/**
 * The limits (the owner's defaults, kept here so each is one edit):
 * - openCases: cases per member per server that aren't closed;
 * - dailyCases: new cases per member per server in any 24 hours;
 * - messageChars and topicChars: text length, counted in characters (code points) as Discord's
 *   form counts them, so a form Discord accepted is never refused for its emoji;
 * - messagesPerCase: messages in one case, the opening one included (state lines don't count).
 * The web's own POST budget per user is the page's postLimit.
 */
export const MODMAIL_LIMITS = {
  openCases: 3,
  dailyCases: 5,
  topicChars: 100,
  messageChars: 4000,
  messagesPerCase: 500,
} as const;

/** A closed case is deleted this many days after it closed (owner decision 2). */
export const RETENTION_DAYS = 90;

/**
 * Officer pings and member DMs are coalesced per case: at most one of each kind per this many
 * seconds, through a delayed job (a reply while one waits adds nothing).
 */
export const NOTIFY_COALESCE_SECONDS = 600;

/** The officers' ping (case opened, member replied); carries the case ID and the event only. */
export const MODMAIL_PING_KIND = "modmail.ping";
/** The member's DM (officer replied or closed); carries the case ID only. */
export const MODMAIL_DM_KIND = "modmail.dm";
/** The two notification kinds. */
export const MODMAIL_JOB_KINDS = [MODMAIL_PING_KIND, MODMAIL_DM_KIND] as const;

/** One active ping per case: the dedupe key names the case, never the member. */
export const pingKey = (caseId: string): string => `modmail:ping:${caseId}`;
/** One active DM per case. */
export const dmKey = (caseId: string): string => `modmail:dm:${caseId}`;

/** What a ping announces. */
export type PingEvent = "opened" | "reply";

/** The dashboard path of the inbox and of one case (the web pages' own paths). */
export const MODMAIL_PATH = "/g/:guild/modmail";
export const MODMAIL_CASE_PATH = "/g/:guild/modmail/:number";

/**
 * A case's page on the dashboard at `origin` (the parsed WEB_PUBLIC_ORIGIN, no trailing slash).
 * Both IDs are already validated (a snowflake, a positive number), so nothing here is request text.
 */
export function caseUrl(origin: string, guildId: string, number: bigint): string {
  return `${origin}${MODMAIL_CASE_PATH.replace(":guild", guildId).replace(":number", String(number))}`;
}

/**
 * Who may use mod mail as a member (owner decision 5): someone holding the server's Member or Guest role now,
 * while TaruBot holds no Administrator there (the A2 gate, as for My roles). Being an officer is
 * neither needed nor enough: an officer who also holds Member or Guest may open one, an officer
 * with neither may not, and lobby newcomers never can. A Discord time-out doesn't matter: mod mail
 * is how someone timed out reaches the officers, for example to appeal, so unlike a My roles save
 * (Q6) it stays open to them. Discord takes Use Application Commands away during a time-out, so
 * /modmail can't run then; the Mod mail page's Open a case form and its replies are how they get
 * through (owner decision of 2026-10-11). The limits still apply.
 */
export const mayUse = (actor: Actor): boolean =>
  holds(actor, "modmail.open") && actor.botAdministrator === false;

/**
 * Whether they may open a new case right now: mayUse, and not paused (2.45.0). A pause on
 * modmail.open stops new cases only; the person still reads, replies to and closes the cases they
 * have, which is why those check mayUse.
 */
export const mayOpen = (actor: Actor): boolean => mayUse(actor) && can(actor, "modmail.open");

/**
 * Who may read a case: anyone with modmail.inbox in its server (every officer, owner decision 6),
 * or its opener while they may still open cases (mayOpen: modmail.open, which the Member and Guest
 * roles carry, and no Administrator for TaruBot). Anyone else is told the case doesn't exist
 * (404), so case numbers reveal nothing. Writing on the officer side also needs modmail.respond.
 */
export function mayAccess(actor: Actor, openerId: string): boolean {
  if (can(actor, "modmail.inbox")) return true;
  return actor.userId === openerId && mayUse(actor);
}

/**
 * The side someone acts on in a case: the opener is the member side, even an officer who opened a
 * case of their own (they reach the other officers through it), and every other officer is the
 * officer side.
 */
export const sideIn = (openerId: string, userId: string): CaseSide =>
  userId === openerId ? "member" : "officer";

/** The state a reply leaves a case in: waiting on whoever didn't write it. */
export const afterReply = (side: CaseSide): CaseState =>
  side === "member" ? "officers" : "member";

/**
 * The state an officer's Reopen (without a reply) leaves a case in: back in the officers' queue,
 * so it isn't forgotten. A reply to a closed case reopens it too, and then the state follows who
 * replied (afterReply).
 */
export const REOPENED_STATE: CaseState = "officers";

/** Plain words for a state, as members and officers read it. */
export const STATE_WORDS: Readonly<Record<CaseState, string>> = {
  officers: "Waiting on officers",
  member: "Waiting on member",
  closed: "Closed",
};

/** The member's own words: the officers wait on "you". */
export const MEMBER_STATE_WORDS: Readonly<Record<CaseState, string>> = {
  officers: "Waiting on the officers",
  member: "Waiting on you",
  closed: "Closed",
};

/** Text after its line endings are made "\n" and its ends trimmed, as it is checked and stored. */
export function cleanText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

/** A topic is one line: any run of whitespace, line breaks included, becomes one space. */
export const cleanTopic = (value: string): string => cleanText(value).replace(/\s+/gu, " ");

/** Characters as Discord's form counts them: code points, so an emoji is one. */
export const characters = (text: string): number => [...text].length;

/** A text problem, as a key into MODMAIL_TEXT_ERRORS. */
export type TextError = "empty" | "long" | "unsavable";

/**
 * Check a cleaned text against a length limit: 1 to `max` characters, well-formed Unicode and no
 * NUL (PostgreSQL text can't hold one, and the ciphertext round trip must give back what was
 * typed). Returns the problem or null.
 */
export function textProblem(text: string, max: number): TextError | null {
  if (text === "") return "empty";
  if (characters(text) > max) return "long";
  if (!text.isWellFormed() || text.includes("\0")) return "unsavable";
  return null;
}

/** The sentences for a refused text, per field; constant, never quoting what was typed. */
export const MODMAIL_TEXT_ERRORS: Readonly<
  Record<"topic" | "message", Readonly<Record<TextError, string>>>
> = {
  topic: {
    empty: "Add a topic.",
    long: `Keep the topic to ${MODMAIL_LIMITS.topicChars} characters.`,
    unsavable: "The topic contains characters that can't be saved. Retype it.",
  },
  message: {
    empty: "Write a message.",
    long: `Keep the message to ${MODMAIL_LIMITS.messageChars.toLocaleString("en-US")} characters.`,
    unsavable: "The message contains characters that can't be saved. Retype it.",
  },
};

/** Why opening a case is refused, before a form opens or when it comes back. */
export type OpenRefusal =
  | "not_configured"
  | "not_member"
  | "administrator"
  | "off"
  | "key"
  | "web"
  | "paused"
  | "open_limit"
  | "daily_limit";

/**
 * Each refusal in plain words (the /modmail reply's body; the Mod mail page words its own, as it
 * sits on the dashboard). They name the rule and what to do, never another member, and never
 * which officers are involved.
 */
export const OPEN_REFUSALS: Readonly<Record<Exclude<OpenRefusal, "paused">, string>> = {
  not_configured: "TaruBot isn't set up in this server yet, so mod mail isn't available here.",
  not_member:
    "Mod mail is for this server's members and guests. If you've just been given Member or Guest, try again in a minute.",
  administrator:
    "Members can't use TaruBot's web pages while it has Administrator in this server, and mod mail lives there. Ask an officer to remove Administrator from TaruBot.",
  off: "Mod mail isn't turned on in this server. Ask an officer if you need to reach them.",
  key: "Mod mail isn't available on this TaruBot right now: its encryption key isn't set up. Ask an officer.",
  web: "Mod mail needs TaruBot's web pages, which aren't turned on for this TaruBot. Ask an officer.",
  open_limit: `You already have ${MODMAIL_LIMITS.openCases} open cases in this server. Add to one of them on the dashboard, or close one first.`,
  daily_limit: `You've opened ${MODMAIL_LIMITS.dailyCases} cases in this server in the last 24 hours. Add to an open case on the dashboard, or try again later.`,
};

/**
 * The sentence both opening forms (/modmail's and the Mod mail page's) show above their fields
 * (owner decision 6: say it plainly).
 */
export const VISIBILITY_NOTICE =
  "All of this server's officers can read it. Only you and the officers can see your case, on TaruBot's dashboard; it is deleted 90 days after it's closed.";

/** The sentence a page shows in place of text it can't decrypt with the current key. */
export const UNREADABLE_TEXT = "This message can't be read with this TaruBot's current key.";

/** Prerequisites for turning mod mail on, each told apart on the settings card. */
export interface Prerequisites {
  /** MODMAIL_KEY: set and valid, not set, or set but not valid. */
  readonly key: "ok" | "missing" | "invalid";
  /** The web pages are on (WEB_PUBLIC_ORIGIN parsed). */
  readonly web: boolean;
  /** The officer notifications channel is set: without it there are no pings. */
  readonly channel: boolean;
}

/** Whether mod mail can be turned on: a valid key, the web, and somewhere to ping officers. */
export const canEnable = (prerequisites: Prerequisites): boolean =>
  prerequisites.key === "ok" && prerequisites.web && prerequisites.channel;

/**
 * Who a thread row is shown as, per audience (owner decisions 3 and 4):
 * - officers always see who really wrote or did it, and whether an officer signed it as "The
 *   officers" (`asOfficers`);
 * - the member sees "you" for their own rows, an officer's server name where that officer signed
 *   with it, and "the officers" otherwise. The member's view never carries the real author of a
 *   row signed as the officers: the application leaves the ID out of their view model entirely.
 */
export type ShownAuthor =
  | {
      readonly kind: "person";
      readonly userId: string;
      readonly side: CaseSide;
      readonly asOfficers: boolean;
    }
  | { readonly kind: "you" }
  | { readonly kind: "officers" }
  | { readonly kind: "officer"; readonly userId: string };

/** A stored row's authorship, as the application reads it. */
export interface Authorship {
  readonly authorId: string;
  readonly side: CaseSide;
  readonly signedAs: Signing | null;
}

/** How `row` is shown to an officer, or to the case's member. */
export function shownAuthor(row: Authorship, audience: "officer" | "member"): ShownAuthor {
  if (audience === "officer")
    return {
      kind: "person",
      userId: row.authorId,
      side: row.side,
      asOfficers: row.side === "officer" && row.signedAs === "officers",
    };
  if (row.side === "member") return { kind: "you" };
  return row.signedAs === "name" ? { kind: "officer", userId: row.authorId } : { kind: "officers" };
}
