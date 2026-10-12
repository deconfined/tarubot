/**
 * Mod mail's pages (2.43.0, issue #60): the officers' inbox with the on/off card, a member's own
 * cases with the Open a case form, and a case's thread with its reply form. Typed state in
 * (ModMail's Inbox, MyCases and CaseView) and escaped markup out, with no service or gateway I/O.
 *
 * Open a case opens on top of the page, as the Role menu's editors do (views/role-menu.ts, whose
 * stylesheet draws every .overlay): a modal <dialog> opened by its button's invoker command
 * (commandfor, command "show-modal"; no script), beside the button on a wide screen (CSS anchor
 * positioning, styles/modmail.ts's static anchor pair), a bottom sheet on a phone, and a popover
 * where the browser has no invoker commands. Nothing on the page moves when it opens. A refused
 * form (422, or 409 when the state changed under it) comes back drawn open in the centre, as a
 * plain element over its own backdrop with the page's blocks and the shell inert (PostOutcome
 * .modal), holding the error summary and what was typed; its Close is a link that loads the page
 * afresh.
 *
 * Every text a person typed (topics, messages) and every name from Discord goes through untrusted(),
 * so it is escaped and isolated; a message keeps its line breaks through CSS (white-space), never
 * markup. A field the current key can't decrypt shows UNREADABLE_TEXT instead.
 *
 * What each audience sees of a thread (owner decisions 3 and 4): officers see who really wrote
 * each row, the member's side marked, and a "Signed as the officers" badge where an officer chose
 * it; the member sees "You", the officer's server name where they signed with it, and "The
 * officers" otherwise, and their view model never even holds who wrote the rest. Officers also get
 * the read log, folded. Names are resolved when the page renders: someone who left reads as "A
 * former member" or "A former officer"; a name TaruBot can't tell right now shows as an ID to
 * officers and as "An officer" to the member.
 */
import type {
  CaseEntry,
  CaseNames,
  CaseRead,
  CaseSummary,
  CaseView,
  Inbox,
  ModMailSettings,
  MyCases,
  ReplyRefusal,
} from "../../application/modmail.js";
import {
  type CaseSide,
  type CaseState,
  canEnable,
  type InboxFilter,
  MEMBER_STATE_WORDS,
  MODMAIL_CASE_PATH,
  MODMAIL_LIMITS,
  MODMAIL_PATH,
  MODMAIL_TEXT_ERRORS,
  type OpenRefusal,
  type Prerequisites,
  RETENTION_DAYS,
  STATE_WORDS,
  type TextError,
  UNREADABLE_TEXT,
  VISIBILITY_NOTICE,
} from "../../domain/modmail.js";
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { icon } from "../icons.js";
import { time } from "../time.js";
import {
  choiceGroup,
  disclosure,
  errorSummary,
  type FieldError,
  formActions,
  hidden,
  notice,
  postForm,
  submitButton,
  textField,
} from "./forms.js";

// ---------------------------------------------------------------------------------------------
// The forms' vocabulary, shared with the page modules

export { MODMAIL_CASE_PATH, MODMAIL_PATH };

/** Which form a POST came from. */
export const OP_FIELD = "op";
/** The switch's form: the state asked for ("on" or "off") and the revision it was drawn at. */
export const ENABLED_FIELD = "enabled";
export const REVISION_FIELD = "revision";
/** The reply form: its minted message ID, the text and an officer's signing. */
export const MESSAGE_ID_FIELD = "id";
export const BODY_FIELD = "body";
export const SIGNING_FIELD = "signed";
/** The Open a case form: its minted case ID and the topic; the message is BODY_FIELD. */
export const CASE_ID_FIELD = "case";
export const TOPIC_FIELD = "topic";

/**
 * A browser's maxlength counts UTF-16 code units, while mod mail's limits count characters (code
 * points) as Discord's forms do, so one emoji is two units but one character. Twice the limit
 * never stops typing a text the server would take (forms.ts's rule); the server's own check, a
 * 422 with the text kept, holds the real line.
 */
const browserMax = (characters: number): number => characters * 2;

/**
 * The mod mail pages' POST body cap (Page.bodyLimit): the most a form the browser's maxlength
 * allows can take urlencoded. A message of browserMax(4,000) = 8,000 UTF-16 units at up to 9 bytes
 * each (a three-byte character percent-encoded; a line break, CR LF once sent, is 6) is 72,000
 * bytes, a topic 1,800, and the rest (the form token, op, the minted ID, the signing and the field
 * names) under 400: about 74 KB. 96 KiB leaves room, so any text a browser sends comes back as the
 * page's own 422 with the text kept, never a bare 413 that loses it.
 */
export const MODMAIL_BODY_LIMIT = 96 * 1024;

/** The inbox's filter parameter (a query value the page compares with INBOX_FILTERS only). */
export const FILTER_PARAM = "state";

/** The fixed notices on the inbox, by the token a redirect carries; past tense. */
export const INBOX_NOTICES = {
  enabled:
    "Mod mail turned on. Members and guests can now open cases with /modmail or on their Mod mail page.",
  disabled: "Mod mail turned off. Nobody can open a new case; existing cases stay here.",
  unchanged: "Nothing changed: mod mail was already like that.",
} as const;
export type InboxNotice = keyof typeof INBOX_NOTICES;

/** The fixed notices on a case page; a reply's redirect goes to the new message instead. */
export const CASE_NOTICES = {
  opened:
    "Case opened. The officers are told without its text, and TaruBot DMs you when one replies (if your DMs are open).",
  closed: "Case closed.",
  reopened: "Case reopened.",
  unchanged: "Nothing changed: the case was already like that.",
} as const;
export type CaseNotice = keyof typeof CASE_NOTICES;

/** A message row's fragment, which a reply's redirect scrolls to. */
export const messageAnchor = (id: string): string => `message-${id}`;

/** A case page's path in a server (both IDs already validated). */
export const casePath = (guildId: string, number: bigint): string =>
  MODMAIL_CASE_PATH.replace(":guild", guildId).replace(":number", String(number));

/** The inbox's path in a server. */
const inboxPath = (guildId: string): string => MODMAIL_PATH.replace(":guild", guildId);

// ---------------------------------------------------------------------------------------------
// Copy

/** The privacy facts every audience reads, in one place. */
const PRIVACY = `All of this server's officers can read every case. TaruBot keeps the text encrypted, never posts it in Discord, records who reads each case, and deletes a closed case ${RETENTION_DAYS} days after it's closed.`;

/** Each refused reply's sentence; constant, never quoting the text. */
export const REPLY_ERRORS: Readonly<Record<ReplyRefusal, string>> = {
  ...MODMAIL_TEXT_ERRORS.message,
  case_full: `This case has reached ${MODMAIL_LIMITS.messagesPerCase} messages. Close it, and open a new case to carry on.`,
  open_limit: `You already have ${MODMAIL_LIMITS.openCases} open cases in this server. Close one of them before reopening this one.`,
};

/** A reply form whose minted ID belongs to another message: a form this page didn't make. */
export const REPLY_CONFLICT = "This form is out of date. Your reply is still below; send it again.";

/** Close or Reopen met a newer case: the page shows it as it is now. */
export const STATE_CONFLICT =
  "The case changed while you were reading it. Check the newest messages, then try again.";

/** The switch met a newer setting. */
export const SETTINGS_CONFLICT =
  "Another officer changed this setting meanwhile. Check it below, then try again.";

/** The switch refused for a missing prerequisite. */
export const SETTINGS_MISSING = "Mod mail can't be turned on until every check below passes.";

/**
 * Why the Open a case button is unavailable, or a submitted form was refused, in the page's own
 * words (the /modmail reply's are domain/modmail.ts's OPEN_REFUSALS, written for Discord). The
 * page admits only members and guests while TaruBot has no Administrator, and only with the web
 * on, so the first four show only after a change between the page and its form.
 */
export const WEB_OPEN_REFUSALS: Readonly<Record<OpenRefusal, string>> = {
  not_configured: "TaruBot isn't set up in this server any more, so no new case can be opened.",
  not_member: "Mod mail is for this server's members and guests.",
  administrator:
    "Members can't open cases while TaruBot has Administrator in this server. Ask an officer to remove it.",
  web: "Mod mail needs TaruBot's web pages, which aren't turned on for this TaruBot.",
  off: "Mod mail is turned off in this server, so you can't open a new case. Your cases stay here, and you can still reply to them.",
  key: "Mod mail's encryption key isn't set up on this TaruBot, so no new case can be opened right now. Ask an officer.",
  open_limit: `You have ${MODMAIL_LIMITS.openCases} open cases in this server, the most at once. Add to one of them below, or close one first.`,
  daily_limit: `You've opened ${MODMAIL_LIMITS.dailyCases} cases in this server in the last 24 hours. Add to an open case below, or try again later.`,
};

/** An Open a case form whose minted ID already names another case: a form this page didn't make. */
export const OPEN_CONFLICT =
  "This form is out of date. What you typed is still here; send it again.";

/**
 * The same form sent again with other text, after it opened a case: the text isn't added there
 * (one form opens one case), so it comes back here, with a link to the case to reply in.
 */
export const openedAlready = (number: bigint): string =>
  `This form already opened case #${number}. What you typed now is still here: add it to that case as a reply, or send it again to open a new case.`;

/** A reply form sent again with other text: the first send is in the thread above. */
export const REPLY_RESENT =
  "This form already sent a reply, shown above. What you typed now is still here: send it again to add it as a new reply.";

/** A duration in plain words, rounded down: "under a minute", "5 minutes", "3 hours", "2 days". */
export function waited(since: Date, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - since.getTime()) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.floor(hours / 24);
  return `${days} days`;
}

/** An instant as a `<time>` element; the text names UTC, as every time on the web does. */
function at(instant: Date): SafeHtml {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
}

/** A decrypted text, or the fixed sentence when it can't be read. */
const textOf = (text: string | null): SafeHtml =>
  text === null
    ? html`<span class="modmail-unreadable">${UNREADABLE_TEXT}</span>`
    : untrusted(text);

/** A state as a badge, in the viewer's words; the words carry the meaning, the tone repeats it. */
function stateBadge(state: CaseState, audience: "officer" | "member"): SafeHtml {
  const words = audience === "member" ? MEMBER_STATE_WORDS : STATE_WORDS;
  return html`<span class="orr-badge modmail-state modmail-state--${state}">${words[state]}</span>`;
}

/**
 * A person by ID: their server name; "A former member" or "A former officer" when Discord says
 * they left; otherwise (TaruBot can't tell right now) the ID for officers, "An officer" or "A
 * member" for the member.
 */
function person(
  id: string,
  side: CaseSide,
  names: CaseNames,
  audience: "officer" | "member",
): SafeHtml {
  const name = names.get(id);
  if (name !== undefined && name !== null) return untrusted(name);
  if (name === null) return html`${side === "member" ? "A former member" : "A former officer"}`;
  return audience === "officer"
    ? html`<code>${id}</code>`
    : html`${side === "member" ? "A member" : "An officer"}`;
}

/** A callout: info by default, or a warning. */
const callout = (body: SafeHtml | string, warning = false): SafeHtml =>
  html`<p class="${warning ? "notice notice--warning" : "notice"}">${icon(warning ? "triangle-alert" : "info")}<span>${body}</span></p>`;

/** The privacy line, with its lock; ` inert` (behind()) while a form is drawn open over it. */
const privacyNote = (inert: SafeHtml | "" = ""): SafeHtml =>
  html`<p class="note modmail-privacy"${inert}>${icon("lock")}<span>${PRIVACY}</span></p>`;

// ---------------------------------------------------------------------------------------------
// The officers' settings card

/** One checklist row, with its status token as the configuration checklist draws them. */
function checkRow(check: "ok" | "warn" | "fail", text: SafeHtml | string): SafeHtml {
  return html`<li class="check-row"><span class="check check-${check}">${CHECK_TOKEN[check]}</span><span class="check-copy">${text}</span></li>`;
}

/** The bracket tokens the configuration checklist uses. */
const CHECK_TOKEN = { ok: "[OK]", warn: "[WARN]", fail: "[FAIL]" } as const;

/** One prerequisite row: [OK] or [FAIL]. */
const prerequisiteRow = (ok: boolean, text: SafeHtml | string): SafeHtml =>
  checkRow(ok ? "ok" : "fail", text);

/**
 * Where to allow Mention Everyone for TaruBot, in Discord's own words, as /config validate says it
 * too: only in the officer notifications channel's own permissions, set by hand (TaruBot never
 * grants itself a permission).
 */
export const MENTION_FIX =
  "In Discord, open the officer notifications channel's settings, then Permissions, add the TaruBot role, and allow Mention @everyone, @here and All Roles.";

/**
 * Whether the officers' ping reaches them: a warning row when it won't be posted, won't notify
 * anyone, or would stop once Administrator or a server-wide grant comes off; never a
 * prerequisite, so it doesn't stop mod mail being turned on. Nothing when it can't be told (no
 * Officer role, or no view of the server).
 */
function pingRow(settings: ModMailSettings): SafeHtml | "" {
  switch (settings.officerPing) {
    case null:
      return "";
    case "missing":
      return checkRow(
        "warn",
        html`Pings can't be posted: TaruBot can't find the officer notifications channel, which may have been deleted. Choose it again with <code>/config officer_notifications</code>.`,
      );
    case "cannot_post":
      return checkRow(
        "warn",
        html`Pings can't be posted: TaruBot can't see or post in the officer notifications channel. In Discord, give TaruBot View Channel, Send Messages, Embed Links and Read Message History there; <code>/config validate</code> says which are missing.`,
      );
    case "mentionable":
    case "allowed":
      return checkRow("ok", "Pings notify officers: TaruBot can mention the Officer role there");
    case "server_wide":
      return checkRow(
        "warn",
        `Pings notify officers only through Mention Everyone granted server-wide, which TaruBot shouldn't keep. Before it's removed: ${MENTION_FIX}`,
      );
    case "administrator":
      return checkRow(
        "warn",
        `Pings reach officers only while TaruBot has Administrator. Before removing it, fix what /config validate lists for that channel, and allow the mention: ${MENTION_FIX}`,
      );
    case "silent":
      return checkRow(
        "warn",
        `Pings will post but notify nobody: TaruBot can't mention the Officer role there. ${MENTION_FIX}`,
      );
  }
}

/** The prerequisites, each with its state and, when it fails, what fixes it. */
function prerequisites(state: Prerequisites, settings: ModMailSettings): SafeHtml {
  const key =
    state.key === "ok"
      ? "Encryption key is set (MODMAIL_KEY)"
      : state.key === "missing"
        ? html`Encryption key isn't set: whoever runs TaruBot sets <code>MODMAIL_KEY</code> on the host`
        : html`Encryption key isn't valid: <code>MODMAIL_KEY</code> must be base64 for 32 bytes`;
  const channel = state.channel
    ? "Officer notifications channel is set"
    : html`Officer notifications channel isn't set: set it with <code>/config officer_notifications</code>, or officers would never be pinged`;
  return html`<ul class="checklist modmail-checks">
${prerequisiteRow(state.key === "ok", key)}
${prerequisiteRow(state.web, state.web ? "Dashboard is on" : "Dashboard is off")}
${prerequisiteRow(state.channel, channel)}
${state.channel ? pingRow(settings) : ""}
</ul>
${
  settings.officerRole
    ? ""
    : html`<p class="note">No Officer role is set, so pings mention nobody. Set one with <code>/config roles officer</code>.</p>`
}`;
}

/** The settings card's refusal, when re-rendering a refused switch. */
export type SettingsRefusal = "conflict" | "missing";

/** The officers' on/off card, with its form. */
function settingsCard(
  settings: ModMailSettings,
  options: { action: string; token: string; refused?: SettingsRefusal | undefined },
): SafeHtml {
  const state = settings.prerequisites;
  const ready = canEnable(state);
  const warnings: SafeHtml[] = [];
  // Turned on with a prerequisite since lost: still on, but say what's wrong.
  if (settings.enabled && !ready)
    warnings.push(
      callout(
        "Mod mail is on, but a check below fails, so new cases can't be opened or officers can't be pinged until it's fixed.",
        true,
      ),
    );
  if (settings.administrator === true)
    warnings.push(
      callout(
        html`Members and guests can't open or read cases while TaruBot has Administrator in this server. Use <code>/setup overrides</code>, then remove Administrator once <code>/config validate</code> says it's no longer needed.`,
        true,
      ),
    );
  if (settings.enabled && settings.effectsMode !== "live")
    warnings.push(
      callout(
        "Discord changes are paused in this server, so pings and DMs wait until they resume.",
      ),
    );
  const error =
    options.refused === undefined
      ? ""
      : html`<p class="orr-field__hint orr-field__hint--error form-error" id="modmail-settings-error" tabindex="-1"><span class="visually-hidden">Error: </span>${options.refused === "conflict" ? SETTINGS_CONFLICT : SETTINGS_MISSING}</p>`;
  const changed =
    settings.updatedAt === null
      ? ""
      : html`<p class="note">Turned ${settings.enabled ? "on" : "off"} ${at(settings.updatedAt)}.</p>`;
  const form = postForm(
    { action: options.action, token: options.token, className: "modmail-switch" },
    html`${hidden(OP_FIELD, "settings")}${hidden(ENABLED_FIELD, settings.enabled ? "off" : "on")}${hidden(REVISION_FIELD, String(settings.revision))}${
      settings.enabled
        ? formActions(submitButton("Turn mod mail off"))
        : formActions(
            submitButton("Turn mod mail on", {
              variant: "primary",
              disabled: !ready || !settings.configured,
              describedBy: "modmail-switch-hint",
            }),
          )
    }${
      settings.enabled
        ? html`<p class="note">Turning it off stops new cases only. Existing cases stay readable, and officers and members can still reply and close them.</p>`
        : html`<p class="note" id="modmail-switch-hint">${ready ? "Members and guests then open cases with /modmail or on their Mod mail page, and both forms tell them all officers can read it." : "It can be turned on once every check above passes."}</p>`
    }`,
  );
  return html`<section class="orr-card modmail-settings" aria-labelledby="modmail-settings-title">
<div class="orr-card__body">
<div class="modmail-settings__head"><h2 id="modmail-settings-title" class="modmail-settings__title">Mod mail is ${settings.enabled ? "on" : "off"}</h2>${
    settings.enabled
      ? html`<span class="check check-ok">[ON]</span>`
      : html`<span class="check check-off">[OFF]</span>`
  }</div>
${changed}
${error}
${warnings}
<div class="modmail-settings__grid">
<div>${settings.configured ? prerequisites(state, settings) : callout("TaruBot isn't set up in this server yet, so mod mail can't be turned on.", true)}</div>
${form}
</div>
</div>
</section>`;
}

// ---------------------------------------------------------------------------------------------
// Lists

/**
 * A column's name inside one of its cells, shown only where the row is a stacked card and the
 * column header is out of sight, as Background work does; hidden from assistive technology, which
 * reads the cell's column header from the table roles.
 */
const cellLabel = (column: string): SafeHtml =>
  html`<span class="orr-label cell-label" aria-hidden="true">${column}</span>`;

/** A case table in its own labelled scroll region; rows stack into cards on a phone. */
function caseTable(
  name: string,
  caption: string,
  columns: readonly string[],
  rows: readonly SafeHtml[],
): SafeHtml {
  return html`<div class="orr-card table-scroll modmail-table" tabindex="0" role="region" aria-labelledby="${name}-caption"><table class="orr-table" role="table">
<caption id="${name}-caption" class="visually-hidden">${caption}</caption>
<thead role="rowgroup"><tr role="row">${columns.map((column) => html`<th scope="col" role="columnheader">${column}</th>`)}</tr></thead>
<tbody role="rowgroup">${rows}</tbody>
</table></div>`;
}

/** An officer's inbox row: number, opener, topic, state and how long it has waited. */
function inboxRow(entry: CaseSummary, guildId: string, names: CaseNames, now: Date): SafeHtml {
  const closed = entry.state === "closed";
  return html`<tr role="row">
<th scope="row" role="rowheader"><a class="modmail-case-link" href="${href(casePath(guildId, entry.number))}">Case #${String(entry.number)}</a></th>
<td role="cell">${cellLabel("Opened by")}${person(entry.openerId, "member", names, "officer")}</td>
<td role="cell" class="modmail-topic">${cellLabel("Topic")}${textOf(entry.topic)}</td>
<td role="cell">${stateBadge(entry.state, "officer")}</td>
<td role="cell">${cellLabel(closed ? "Closed" : "Waiting")}${
    closed && entry.closedAt
      ? at(entry.closedAt)
      : html`<span>${waited(entry.stateSince, now)}</span><span class="cell-meta">since ${at(entry.stateSince)}</span>`
  }</td>
</tr>`;
}

/** The filter links: every case not closed, then each state, with counts. */
function filters(inbox: Inbox, guildId: string): SafeHtml {
  const { counts } = inbox;
  const items: { filter: InboxFilter; label: string; count: number }[] = [
    { filter: "open", label: "Open", count: counts.officers + counts.member },
    { filter: "officers", label: STATE_WORDS.officers, count: counts.officers },
    { filter: "member", label: STATE_WORDS.member, count: counts.member },
    { filter: "closed", label: STATE_WORDS.closed, count: counts.closed },
  ];
  const base = inboxPath(guildId);
  return html`<nav class="modmail-filters" aria-label="Filter cases"><ul>${items.map(
    ({ filter, label, count }) => {
      const target = filter === "open" ? base : `${base}?${FILTER_PARAM}=${filter}`;
      const text = html`${label} <span class="modmail-filters__count">${String(count)}</span>`;
      return filter === inbox.filter
        ? html`<li><a class="modmail-filter" href="${href(target)}" aria-current="page">${text}</a></li>`
        : html`<li><a class="modmail-filter" href="${href(target)}">${text}</a></li>`;
    },
  )}</ul></nav>`;
}

/** The officers' inbox page view. */
export interface InboxView {
  readonly inbox: Inbox;
  readonly guildId: string;
  /** The page's own path; the switch posts here. */
  readonly action: string;
  readonly token: string;
  /** The request URL, for the notice token (only INBOX_NOTICES' tokens are ever shown). */
  readonly url: URL;
  /** The render time, for how long each case has waited. */
  readonly now: Date;
  readonly refused?: SettingsRefusal;
}

/** What the inbox says when a filter shows nothing. */
const EMPTY_INBOX: Readonly<Record<InboxFilter, string>> = {
  open: "No open cases. Everything is answered.",
  officers: "No case is waiting on officers.",
  member: "No case is waiting on a member.",
  closed: "No closed cases. Closed cases are deleted 90 days after they're closed.",
};

/** The officers' Mod mail page: the inbox beside the on/off card. */
export function renderInbox(view: InboxView): SafeHtml {
  const { inbox } = view;
  const summary: FieldError[] =
    view.refused === undefined
      ? []
      : [
          {
            id: "modmail-settings-error",
            message: view.refused === "conflict" ? SETTINGS_CONFLICT : SETTINGS_MISSING,
          },
        ];
  const rows = inbox.cases.map((entry) => inboxRow(entry, view.guildId, inbox.names, view.now));
  const caption =
    inbox.filter === "open"
      ? "Open cases, waiting on officers first"
      : `Cases: ${STATE_WORDS[inbox.filter as CaseState]}`;
  return html`${errorSummary(summary)}
<p class="lead">Private cases members and guests opened with /modmail or on the dashboard. Reply to them here; Discord only gets a ping with the case number.</p>
${notice(view.url, INBOX_NOTICES)}
<div class="modmail-inbox">
<section class="modmail-inbox__cases" aria-labelledby="modmail-cases">
<div class="section-heading"><h2 id="modmail-cases">Cases</h2><p class="section-description">Waiting on officers comes first, the longest waiting at the top. Times are UTC.</p></div>
${filters(inbox, view.guildId)}
${
  rows.length === 0
    ? html`<div class="empty-state"><p>${EMPTY_INBOX[inbox.filter]}</p></div>`
    : caseTable("modmail-inbox", caption, ["Case", "Opened by", "Topic", "State", "Waiting"], rows)
}
${inbox.more ? html`<p class="note">Showing the first 100 cases. Close answered cases, or filter by state, to see the rest.</p>` : ""}
</section>
<aside class="modmail-inbox__side" aria-label="Mod mail settings">
${settingsCard(inbox.settings, { action: view.action, token: view.token, refused: view.refused })}
${privacyNote()}
</aside>
</div>`;
}

/** A member's own case row. */
function myRow(entry: CaseSummary, guildId: string): SafeHtml {
  return html`<tr role="row">
<th scope="row" role="rowheader"><a class="modmail-case-link" href="${href(casePath(guildId, entry.number))}">Case #${String(entry.number)}</a></th>
<td role="cell" class="modmail-topic">${cellLabel("Topic")}${textOf(entry.topic)}</td>
<td role="cell">${stateBadge(entry.state, "member")}</td>
<td role="cell">${cellLabel("Last activity")}${at(entry.lastActivityAt)}</td>
</tr>`;
}

/** What was wrong with a submitted Open a case form. */
export type OpenProblem =
  | { readonly kind: "invalid"; readonly field: "topic" | "message"; readonly error: TextError }
  | { readonly kind: "refused"; readonly reason: OpenRefusal }
  | { readonly kind: "conflict" }
  /** This form already opened case `number` with other text. */
  | { readonly kind: "already"; readonly number: bigint };

/** A refused Open a case form, re-rendered drawn open with what was typed. */
export interface OpenRefused {
  readonly problem: OpenProblem;
  readonly topic: string;
  readonly body: string;
}

/** A member's or guest's Mod mail page view. */
export interface MyCasesView {
  readonly cases: MyCases;
  readonly guildId: string;
  /** The page's own path; the Open a case form posts here. */
  readonly action: string;
  readonly token: string;
  /** A case ID minted for this render's Open a case form (a repeat finds its case). */
  readonly caseId: string;
  readonly refused?: OpenRefused;
}

/** The Open a case dialog, its title (which names it), its note (which describes it) and more. */
const OPEN_DIALOG = "modmail-open";
const OPEN_TITLE = "modmail-open-title";
const OPEN_NOTE = "modmail-open-note";
const OPEN_ERROR = "modmail-open-error";
const OPEN_WHY = "modmail-open-why";
const TOPIC_ID = "modmail-topic";
const OPEN_BODY_ID = "modmail-open-body";

/** The refused form's problem as one sentence, and the control or line it belongs to. */
function openProblem(problem: OpenProblem): FieldError {
  switch (problem.kind) {
    case "invalid":
      return {
        id: problem.field === "topic" ? TOPIC_ID : OPEN_BODY_ID,
        message: MODMAIL_TEXT_ERRORS[problem.field][problem.error],
      };
    case "refused":
      return { id: OPEN_ERROR, message: WEB_OPEN_REFUSALS[problem.reason] };
    case "conflict":
      return { id: OPEN_ERROR, message: OPEN_CONFLICT };
    case "already":
      return { id: OPEN_ERROR, message: openedAlready(problem.number) };
  }
}

/**
 * The Open a case form: the sentence both opening forms show first (owner decision 6), the topic
 * and the message, and Open case, which stays disabled while the member can't open one (a form
 * drawn open after a refusal still shows what they typed, to copy).
 */
function openForm(view: MyCasesView): SafeHtml {
  const problem = view.refused?.problem;
  const fieldError = (field: "topic" | "message") =>
    problem?.kind === "invalid" && problem.field === field
      ? MODMAIL_TEXT_ERRORS[field][problem.error]
      : undefined;
  // A form that already opened a case links it, to reply there instead.
  const caseLink =
    problem?.kind === "already"
      ? html` <a href="${href(casePath(view.guildId, problem.number))}">Open case #${String(problem.number)}</a>`
      : "";
  const formError =
    problem === undefined || problem.kind === "invalid"
      ? ""
      : html`<p class="orr-field__hint orr-field__hint--error form-error" id="${OPEN_ERROR}" tabindex="-1"><span class="visually-hidden">Error: </span>${openProblem(problem).message}${caseLink}</p>`;
  return postForm(
    { action: view.action, token: view.token, className: "modmail-open-form" },
    html`<p class="note modmail-privacy" id="${OPEN_NOTE}">${icon("lock")}<span>${VISIBILITY_NOTICE}</span></p>
${formError}${hidden(OP_FIELD, "open")}${hidden(CASE_ID_FIELD, view.caseId)}${textField({
  id: TOPIC_ID,
  name: TOPIC_FIELD,
  label: "Topic",
  hint: `A few words on what it's about, up to ${MODMAIL_LIMITS.topicChars} characters. Officers see it in their inbox.`,
  error: fieldError("topic"),
  value: view.refused?.topic,
  required: true,
  maxLength: browserMax(MODMAIL_LIMITS.topicChars),
})}${textField({
  id: OPEN_BODY_ID,
  name: BODY_FIELD,
  label: "Message",
  hint: `Up to ${MODMAIL_LIMITS.messageChars.toLocaleString("en-US")} characters.`,
  error: fieldError("message"),
  value: view.refused?.body,
  multiline: true,
  required: true,
  maxLength: browserMax(MODMAIL_LIMITS.messageChars),
})}${formActions(
  submitButton("Open case", { variant: "primary", disabled: view.cases.openRefusal !== null }),
)}`,
  );
}

/** Close's name, told apart from every other control (WCAG 2.4.6). */
const CLOSE_OPEN = html`Close<span class="visually-hidden"> Open a case</span>`;

/**
 * The Open a case panel. Closed (a GET) it is a modal dialog in the page, opened by its button,
 * closed by Close, Escape or a click outside (closedby="any"), its popover attribute the fallback
 * for a browser without invoker commands; its title takes focus as it opens, so a phone's keyboard
 * doesn't come up over the sheet, and the privacy sentence describes it. Drawn open (a refused
 * form) it is a plain element fixed in the centre by its class, as markup can't open a dialog, the
 * error summary first in its body, and Close a link that loads the page afresh (dropping what was
 * typed); it takes no anchor classes, since that page loads at its top, where the button may be
 * off the screen.
 */
function openPanel(view: MyCasesView, open: boolean): SafeHtml {
  if (open)
    return html`<div class="overlay overlay--open" id="${OPEN_DIALOG}" role="dialog" aria-modal="true" aria-labelledby="${OPEN_TITLE}" aria-describedby="${OPEN_NOTE}">
<div class="overlay__head"><h2 class="overlay__title" id="${OPEN_TITLE}" tabindex="-1">Open a case</h2><a class="orr-btn orr-btn--ghost overlay__close" href="${href(inboxPath(view.guildId))}">${CLOSE_OPEN}</a></div>
<div class="overlay__body">${errorSummary(view.refused ? [openProblem(view.refused.problem)] : [])}${openForm(view)}</div>
</div>`;
  return html`<dialog class="overlay overlay--anchored anchored-modmail-open" id="${OPEN_DIALOG}" popover="auto" closedby="any" aria-labelledby="${OPEN_TITLE}" aria-describedby="${OPEN_NOTE}">
<div class="overlay__head"><h2 class="overlay__title" id="${OPEN_TITLE}" tabindex="-1" autofocus>Open a case</h2><button type="button" class="orr-btn orr-btn--ghost overlay__close" commandfor="${OPEN_DIALOG}" command="close" popovertarget="${OPEN_DIALOG}" popovertargetaction="hide">${CLOSE_OPEN}</button></div>
<div class="overlay__body">${openForm(view)}</div>
</dialog>`;
}

/**
 * ` inert` on the page's own blocks while a refused form is drawn open over them: its backdrop
 * takes their clicks, and unlike a dialog it can't be closed with Escape, so Tab must not reach a
 * control under it (WCAG 2.4.11). The layout makes the shell inert too (PostOutcome.modal).
 */
const behind = (view: MyCasesView): SafeHtml | "" =>
  view.refused === undefined ? "" : html` inert`;

/**
 * The Open a case button with its closed panel right after it (so the dialog gives focus back to
 * it), or, while the member can't open one, the button disabled with the plain reason beside it.
 * While a refused form is drawn open, a link to its title takes the button's place (a button there
 * would name a panel that is no dialog).
 */
function openBar(view: MyCasesView): SafeHtml {
  const refusal = view.cases.openRefusal;
  if (view.refused !== undefined)
    return html`<div class="modmail-open-bar"${behind(view)}><a class="orr-btn orr-btn--primary modmail-opener" href="#${OPEN_TITLE}">Open a case</a></div>`;
  if (refusal !== null)
    return html`<div class="modmail-open-bar"><button type="button" class="orr-btn orr-btn--primary modmail-opener" disabled aria-describedby="${OPEN_WHY}">Open a case</button><p class="note modmail-open-bar__note" id="${OPEN_WHY}">${WEB_OPEN_REFUSALS[refusal]}</p></div>`;
  return html`<div class="modmail-open-bar"><button type="button" class="orr-btn orr-btn--primary modmail-opener anchor-modmail-open" commandfor="${OPEN_DIALOG}" command="show-modal" popovertarget="${OPEN_DIALOG}" aria-haspopup="dialog">Open a case</button>${openPanel(view, false)}<p class="note modmail-open-bar__note">Or use <code>/modmail</code> in Discord. Officers are pinged without your text.</p></div>`;
}

/**
 * A member's or guest's Mod mail page: Open a case, then their own cases in this server. A refused
 * form comes back drawn open over the page, last in the main content (after the page's blocks, so
 * the page under it lays out as on a GET).
 */
export function renderMyCases(view: MyCasesView): SafeHtml {
  const { cases } = view;
  return html`<p class="lead"${behind(view)}>Your private conversations with this server's officers. Open a new case here, or with <code>/modmail</code> in Discord.</p>
${privacyNote(behind(view))}
${openBar(view)}
<section class="modmail-mine" aria-labelledby="modmail-mine"${behind(view)}>
<div class="section-heading"><h2 id="modmail-mine">Your cases</h2><p class="section-description">Open cases first. Times are UTC.</p></div>
${
  cases.cases.length === 0
    ? html`<div class="empty-state"><p>You haven't opened a case here.</p><p class="note">Open one with the button above, or with <code>/modmail</code> in this server.</p></div>`
    : caseTable(
        "modmail-mine-table",
        "Your mod mail cases",
        ["Case", "Topic", "State", "Last activity"],
        cases.cases.map((entry) => myRow(entry, view.guildId)),
      )
}
${cases.more ? html`<p class="note">Showing your 100 most recent cases.</p>` : ""}
</section>
${view.refused === undefined ? "" : html`<div class="overlay-backdrop"></div>${openPanel(view, true)}`}`;
}

/**
 * Whether the page draws a refused Open a case form open on top of it: the page module then asks
 * the layout to make the shell around the main content inert too (PostOutcome.modal).
 */
export const drawsOpenForm = (view: MyCasesView): boolean => view.refused !== undefined;

// ---------------------------------------------------------------------------------------------
// A case

/** Who a row is by, for this page's audience (ModMail already decided what each may see). */
function authorOf(entry: CaseEntry, view: CaseView): { name: SafeHtml; badge: SafeHtml | "" } {
  const author = entry.author;
  switch (author.kind) {
    case "you":
      return { name: html`You`, badge: "" };
    case "officers":
      return { name: html`The officers`, badge: "" };
    case "officer":
      return { name: person(author.userId, "officer", view.names, "member"), badge: "" };
    case "person":
      return {
        name: person(author.userId, author.side, view.names, "officer"),
        badge:
          author.side === "member"
            ? html` <span class="orr-badge">Member</span>`
            : author.asOfficers
              ? html` <span class="orr-badge orr-badge--violet">Signed as the officers</span>`
              : "",
      };
  }
}

/** A state line's words: "Closed by you", "Closed by the officers", "Reopened by Name". */
function stateLine(entry: CaseEntry, view: CaseView): SafeHtml {
  const verb = entry.kind === "closed" ? "Closed" : "Reopened";
  const { name, badge } = authorOf(entry, view);
  const who =
    entry.author.kind === "you"
      ? html`you`
      : entry.author.kind === "officers"
        ? html`the officers`
        : name;
  return html`<li class="modmail-line" id="${messageAnchor(entry.id)}"><span>${verb} by ${who}${badge}</span> <span class="modmail-line__time">${at(entry.createdAt)}</span></li>`;
}

/** One message in the thread, as a card; its side decides which edge it leans to. */
function messageItem(entry: CaseEntry, view: CaseView): SafeHtml {
  const { name, badge } = authorOf(entry, view);
  const side =
    entry.author.kind === "person"
      ? entry.author.side
      : entry.author.kind === "you"
        ? "member"
        : "officer";
  // The viewer's side leans right, like a chat, and the other side left.
  const own = side === view.side;
  return html`<li class="modmail-message modmail-message--${side}${own ? " modmail-message--own" : ""}" id="${messageAnchor(entry.id)}"><article class="orr-card modmail-message__card" aria-labelledby="${messageAnchor(entry.id)}-by">
<header class="modmail-message__head"><h3 class="modmail-message__by" id="${messageAnchor(entry.id)}-by">${name}${badge}</h3><span class="modmail-message__time">${at(entry.createdAt)}</span></header>
<p class="modmail-message__body">${textOf(entry.body ?? null)}</p>
</article></li>`;
}

/** A refused form on a case page, re-rendered: what was sent, and why it was refused. */
export type CaseRefusal =
  | {
      readonly kind: "reply";
      readonly reason: ReplyRefusal | "conflict" | "resent";
      readonly body: string;
      readonly signing: string;
    }
  | { readonly kind: "state" };

/** A case page view. */
export interface CaseViewModel {
  readonly view: CaseView;
  readonly action: string;
  readonly token: string;
  readonly url: URL;
  /** A message ID minted for this render's reply form (a repeat finds its message). */
  readonly messageId: string;
  readonly refused?: CaseRefusal;
}

/** A refused reply's sentence. */
const replyError = (reason: ReplyRefusal | "conflict" | "resent"): string =>
  reason === "conflict"
    ? REPLY_CONFLICT
    : reason === "resent"
      ? REPLY_RESENT
      : REPLY_ERRORS[reason];

/** The reply form: the text, an officer's signing radios, and Send. */
function replyForm(model: CaseViewModel, refusedReply: CaseRefusal | undefined): SafeHtml {
  const { view } = model;
  const reply = refusedReply?.kind === "reply" ? refusedReply : undefined;
  const closed = view.state === "closed";
  const error = reply === undefined ? undefined : replyError(reply.reason);
  const signing =
    view.side === "officer"
      ? choiceGroup({
          id: "modmail-signing",
          name: SIGNING_FIELD,
          type: "radio",
          legend: "Sign this reply",
          choices: [
            {
              value: "name",
              label: "Sign with my name",
              hint: "The member sees your server name.",
            },
            {
              value: "officers",
              label: "Sign as the officers",
              hint: "The member sees “The officers”. Other officers still see it was you.",
            },
          ],
          checked: [reply?.signing === "officers" ? "officers" : "name"],
        })
      : "";
  return postForm(
    { action: model.action, token: model.token, className: "modmail-reply" },
    html`${hidden(OP_FIELD, "reply")}${hidden(MESSAGE_ID_FIELD, model.messageId)}${textField({
      id: "modmail-body",
      name: BODY_FIELD,
      label: closed ? "Reply to reopen this case" : "Your reply",
      hint: closed
        ? "This case is closed. Sending a reply reopens it."
        : view.side === "member"
          ? "All of this server's officers can read it."
          : "The member and every officer can read it.",
      error,
      value: reply?.body,
      multiline: true,
      required: true,
      maxLength: browserMax(MODMAIL_LIMITS.messageChars),
    })}${signing}${formActions(submitButton(closed ? "Reopen and send" : "Send reply", { variant: "primary" }))}`,
  );
}

/** Close (inside a disclosure that says what it does first) or, for officers, Reopen. */
function stateForms(model: CaseViewModel): SafeHtml | "" {
  const { view } = model;
  if (!view.canRespond) return "";
  if (view.state === "closed")
    return view.side === "officer"
      ? postForm(
          { action: model.action, token: model.token, className: "modmail-state-form" },
          html`${hidden(OP_FIELD, "reopen")}${hidden(REVISION_FIELD, String(view.revision))}<p class="note">Reopening puts the case back in the officers' queue and cancels its deletion. Replying reopens it too.</p>${formActions(submitButton("Reopen case"))}`,
        )
      : "";
  return disclosure(
    "Close this case",
    postForm(
      { action: model.action, token: model.token, className: "modmail-state-form" },
      html`${hidden(OP_FIELD, "close")}${hidden(REVISION_FIELD, String(view.revision))}<p>Closing ends the conversation for now. Either side can reopen it by replying, and TaruBot deletes a closed case ${RETENTION_DAYS} days after it's closed.</p>${formActions(submitButton("Close case"))}`,
    ),
  );
}

/** What a read was, in the log's words. */
const READ_KIND: Readonly<Record<CaseRead["kind"], string>> = {
  case: "Opened the case",
  list: "Saw the topic in a list",
};

/**
 * The read log, folded: who opened the case's page, and whose list showed its topic, and when,
 * newest first.
 */
function readLog(view: CaseView): SafeHtml | "" {
  if (view.reads === null) return "";
  const rows = view.reads.map(
    (read: CaseRead) =>
      html`<tr role="row"><td role="cell">${person(read.readerId, read.side, view.names, "officer")}</td><td role="cell">${read.side === "member" ? "Member" : "Officer"}</td><td role="cell">${READ_KIND[read.kind]}</td><td role="cell">${at(read.readAt)}</td></tr>`,
  );
  const more =
    view.readCount > view.reads.length
      ? html`<p class="note">Showing the newest ${String(view.reads.length)} of ${String(view.readCount)} reads.</p>`
      : "";
  return html`<details class="disclosure modmail-reads"><summary>Read log (${String(view.readCount)} ${view.readCount === 1 ? "read" : "reads"})</summary><div class="disclosure__body">
<p class="note">Every view of this page is recorded, by members and officers, and so is every list that showed this case's topic (the inbox, or the member's own list). Views of the page by one person within a minute count once, and list views once an hour. Times are UTC.</p>
<div class="table-scroll" tabindex="0" role="region" aria-label="Read log"><table class="orr-table" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Who</th><th scope="col" role="columnheader">As</th><th scope="col" role="columnheader">What</th><th scope="col" role="columnheader">When</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>
${more}
</div></details>`;
}

/** The case's facts: state, opener (officers), opened, and when it closed and will be deleted. */
function caseFacts(view: CaseView): SafeHtml {
  return html`<dl class="facts modmail-facts">
<dt>State</dt><dd>${stateBadge(view.state, view.audience)}</dd>
${view.audience === "officer" ? html`<dt>Opened by</dt><dd>${person(view.openerId, "member", view.names, "officer")}</dd>` : ""}
<dt>Opened</dt><dd>${at(view.openedAt)}</dd>
${view.closedAt ? html`<dt>Closed</dt><dd>${at(view.closedAt)}</dd>` : ""}
${view.deleteAfter ? html`<dt>Deleted on</dt><dd>${at(view.deleteAfter)}</dd>` : ""}
</dl>`;
}

/** A case page's main content. */
export function renderCase(model: CaseViewModel): SafeHtml {
  const { view } = model;
  const refused = model.refused;
  const summary: FieldError[] =
    refused === undefined
      ? []
      : refused.kind === "state"
        ? [{ id: "modmail-state-error", message: STATE_CONFLICT }]
        : [
            {
              id: "modmail-body",
              message: replyError(refused.reason),
            },
          ];
  const stateError =
    refused?.kind === "state"
      ? html`<p class="orr-field__hint orr-field__hint--error form-error" id="modmail-state-error" tabindex="-1"><span class="visually-hidden">Error: </span>${STATE_CONFLICT}</p>`
      : "";
  const entries = view.entries.map((entry) =>
    entry.kind === "message" ? messageItem(entry, view) : stateLine(entry, view),
  );
  const back = view.audience === "officer" ? "Back to the inbox" : "Back to your cases";
  return html`${errorSummary(summary)}
<p class="modmail-back"><a href="${href(inboxPath(view.guildId))}">${back}</a></p>
${notice(model.url, CASE_NOTICES)}
${view.keyProblem ? callout("Mod mail's encryption key isn't set up on this TaruBot, so this case can't be read or answered right now.", true) : ""}
<div class="modmail-case">
<section class="orr-card modmail-case__head" aria-labelledby="modmail-case-title">
<div class="orr-card__body">
<h2 id="modmail-case-title" class="modmail-case__title"><span class="modmail-case__number">Case #${String(view.number)}</span> <span class="modmail-case__topic">${textOf(view.topic)}</span></h2>
${caseFacts(view)}
${privacyNote()}
</div>
</section>
<section class="modmail-case__thread" aria-labelledby="modmail-thread">
<h2 id="modmail-thread" class="visually-hidden">Conversation</h2>
<ol class="modmail-thread">${entries}</ol>
${stateError}
${
  !view.canRespond
    ? ""
    : view.canReply
      ? replyForm(model, refused)
      : view.keyProblem
        ? ""
        : callout(REPLY_ERRORS.case_full, true)
}
<div class="modmail-case__actions">${stateForms(model)}</div>
${readLog(view)}
</section>
</div>`;
}
