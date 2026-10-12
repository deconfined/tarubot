/**
 * Mod mail's Discord messages (2.43.0, issue #60): /modmail's private replies, the officers' ping
 * and the member's DM. Discord carries no mod mail text in any of them: a reply says the case is
 * open and links it, a ping names the case number and links it, a DM names the case number and the
 * server and links it. None names the member or quotes the topic or a message. Pure.
 *
 * Links go to the case page on the dashboard. Discord link buttons need https (reply.ts), so a
 * development origin (http://localhost or http://[::1]) is written as text instead, as /dashboard
 * does (2.42.0); without the web there is no link at all. The ping's role mention isn't part of
 * the post: the gateway adds exactly that one mention at send time (DiscordGateway.render), so
 * every presenter here keeps the house rule of never pinging.
 */
import type { ModMailPingView } from "../../application/records.js";
import {
  MODMAIL_LIMITS,
  MODMAIL_TEXT_ERRORS,
  OPEN_REFUSALS,
  type OpenRefusal,
  type TextError,
} from "../../domain/modmail.js";
import { code, plain } from "./format.js";
import { post, type Presented, reply, type ReplySpec } from "./reply.js";
import { DISCORD_LIMITS } from "./style.js";

/**
 * Every mod mail message kind, with whether its embed carries a timestamp: none do. A ping and a
 * DM must render the same on a retry (the nonce check), and a reply's facts aren't time-bound.
 */
const TIMESTAMP = {
  "modmail.opened": false,
  "modmail.opened.development": false,
  "modmail.opened.offline": false,
  "modmail.refused": false,
  "modmail.invalid": false,
  "modmail.ping.opened": false,
  "modmail.ping.reply": false,
  "modmail.ping.offline": false,
  "modmail.dm.reply": false,
  "modmail.dm.closed": false,
} as const satisfies Record<string, boolean>;

/** A mod mail message state; tests catalogue one case per kind. */
export type ModMailReplyKind = keyof typeof TIMESTAMP;

/** Every mod mail message kind, for catalog completeness checks. */
export const MODMAIL_REPLY_KINDS = Object.keys(TIMESTAMP) as readonly ModMailReplyKind[];

/** Build a reply of `kind`; none carries a timestamp. */
function card(kind: ModMailReplyKind, spec: Omit<ReplySpec, "timestamp">): Presented {
  return reply({ ...spec, timestamp: TIMESTAMP[kind] ? new Date() : null });
}

/** How a link to the case is shown: a button (https), text (development) or nothing (web off). */
type CaseLink =
  | { readonly kind: "button"; readonly url: string }
  | { readonly kind: "text"; readonly url: string }
  | { readonly kind: "none" };

const caseLink = (url: string | null): CaseLink =>
  url === null
    ? { kind: "none" }
    : url.startsWith("https://")
      ? { kind: "button", url }
      : { kind: "text", url };

/** The button's label. */
const openLabel = (number: bigint): string => `Open case #${number}`;

/**
 * /modmail's receipt: the case is open, privately, with a button to its page. Never echoes the
 * topic or message. Officers are pinged without the text; the member hears about replies by DM.
 */
export function modmailOpenedReply(number: bigint, url: string | null): Presented {
  const link = caseLink(url);
  const description = [
    "Only you and this server's officers can see it. The conversation continues on TaruBot's dashboard.",
    link.kind === "text" &&
      `The dashboard is at a development address, ${code(link.url)}, which opens only on the computer running TaruBot.`,
    link.kind === "none" &&
      "TaruBot's dashboard is turned off right now, so the case opens once it's back.",
  ];
  const fields = [
    {
      name: "What happens next",
      value:
        "The officers are told a new case is open, without its text. When one replies, TaruBot sends you a DM with a link (if your DMs are open), and you can always check the dashboard.",
    },
  ];
  if (link.kind === "button")
    return card("modmail.opened", {
      tone: "success",
      title: `Case #${number} opened`,
      description,
      fields,
      buttons: [{ style: "link", label: openLabel(number), url: link.url }],
    });
  return card(link.kind === "text" ? "modmail.opened.development" : "modmail.opened.offline", {
    tone: "success",
    title: `Case #${number} opened`,
    description,
    fields,
  });
}

/**
 * /modmail refused, before its form opens or when the form comes back: an expected state in plain
 * words (OPEN_REFUSALS), so it has no Code or Ref and is never reported, like /apply's closed card.
 * A pause is not one of these in Discord: the gate and the submission both show the person's own
 * Paused for you card (failure.ts's pausedFormReply and pausedFailure), with the end and the
 * reason, so "paused" has no entry here; only the Mod mail page words it (WEB_OPEN_REFUSALS).
 */
export function modmailRefusedReply(reason: Exclude<OpenRefusal, "paused">): Presented {
  const limit = reason === "open_limit" || reason === "daily_limit";
  return card("modmail.refused", {
    tone: limit ? "pending" : "info",
    title: limit ? "No new case right now" : "Mod mail isn't available",
    description: OPEN_REFUSALS[reason],
  });
}

/**
 * The form came back with text TaruBot can't keep (Discord's own limits normally stop that, so it
 * is a rare corner: characters PostgreSQL can't hold, say). The form can't be shown again with what
 * was typed, so it says what to fix; it never quotes the text.
 */
export function modmailInvalidReply(field: "topic" | "message", error: TextError): Presented {
  return card("modmail.invalid", {
    tone: "info",
    title: "Nothing was sent",
    description: [
      MODMAIL_TEXT_ERRORS[field][error],
      `Run /modmail again: topics take up to ${MODMAIL_LIMITS.topicChars} characters and messages up to ${MODMAIL_LIMITS.messageChars.toLocaleString("en-US")}.`,
    ],
  });
}

/**
 * The officers' ping in the officer notifications channel: which case and what happened, with a
 * link. It names neither the member nor any text, so it's safe in a channel every officer reads
 * and in Discord's search. Rendered only from stored values, so a retry is byte-identical.
 */
export function modmailPing(view: ModMailPingView): Presented {
  const link = caseLink(view.url);
  const title =
    view.event === "opened"
      ? `Mod mail case #${view.number} opened`
      : `New reply on mod mail case #${view.number}`;
  const description =
    link.kind === "button"
      ? "Read it and reply on TaruBot's dashboard."
      : link.kind === "text"
        ? `Read it and reply on TaruBot's dashboard: ${code(link.url)}`
        : "TaruBot's dashboard is turned off, so the case can be read once it's back on.";
  return post({
    tone: "info",
    title,
    description,
    buttons:
      link.kind === "button"
        ? [{ style: "link", label: openLabel(view.number), url: link.url }]
        : [],
  });
}

/** The ping's kind, for the catalog. */
export const pingKind = (view: ModMailPingView): ModMailReplyKind =>
  view.url === null ? "modmail.ping.offline" : `modmail.ping.${view.event}`;

/**
 * The member's DM when an officer replied to or closed their case: the case number, the server's
 * name (from the gateway cache, escaped; "the server" without it) and a link, never the reply.
 */
export function modmailDm(
  view: {
    readonly number: bigint;
    readonly event: "reply" | "closed";
    readonly url: string | null;
  },
  serverName: string | null,
): Presented {
  const server = serverName?.trim()
    ? `**${plain(serverName, DISCORD_LIMITS.fieldName)}**`
    : "the server";
  const link = caseLink(view.url);
  const lead =
    view.event === "closed"
      ? `An officer closed your mod mail case #${view.number} in ${server}.`
      : `An officer replied to your mod mail case #${view.number} in ${server}.`;
  return post({
    tone: view.event === "closed" ? "neutral" : "info",
    title: view.event === "closed" ? "Mod mail case closed" : "New reply to your mod mail",
    description: [
      lead,
      view.event === "closed" &&
        "You can reopen it by replying on TaruBot's dashboard. A closed case is deleted after 90 days.",
      link.kind === "text" && `Read it on TaruBot's dashboard: ${code(link.url)}`,
      link.kind === "none" && "Read it on TaruBot's dashboard once it's back on.",
    ],
    buttons:
      link.kind === "button"
        ? [{ style: "link", label: openLabel(view.number), url: link.url }]
        : [],
  });
}
