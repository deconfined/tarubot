/**
 * The Moderation page (2.45.0, owner decision 3): officers who can see pauses read who is paused
 * from what, find a person by ID or mention or the sender of a suggestion by its number, and those
 * who can change pauses set and lift them. Typed state in (Moderation's ModerationOverview and
 * PauseStatus) and escaped markup out, with no service or gateway I/O.
 *
 * Layout (styles/moderation.ts), dense and horizontal as the other dashboard pages are: one toolbar
 * card on top (the finder and Pause someone), then the pauses as a grid of person cards, each with
 * one chip per paused feature (the feature, its end, the reason, who set it and Lift), then the
 * ended pauses as a grid of small entries. A pause is deny-only and touches no Discord role, so
 * the page says what the person sees: the feature, when it ends and the reason, never who set it.
 * An officer can be paused too (by a server manager) and keeps the page: their own pauses show
 * exactly that, with a sentence in place of Lift, and their own ended ones are not listed. The view
 * decides this on the person (isOwn), not on what the service attached, so an own row never says
 * who set it, who lifted it or why, anywhere on the page.
 *
 * Pause someone and Lift open on top of the page, as the Role menu's editors and Mod mail's Open a
 * case do (views/role-menu.ts, whose stylesheet draws every .overlay): a modal <dialog> opened by
 * its button's invoker command (commandfor, command "show-modal"; no script), a bottom sheet on a
 * phone, and a popover where the browser has no invoker commands. Pause someone opens beside its
 * button on a wide screen (CSS anchor positioning: the toolbar's button and the finder card's
 * Pause each have a static anchor pair in styles/role-menu.ts's PAGE_ANCHORS, named by
 * PAUSE_ANCHOR and FOUND_PAUSE_ANCHOR, as the Role menu's editors do). Lift opens centred: the
 * pairs are static, one per button, and a page holds as many Lift buttons as there are pauses. A
 * refused form comes back drawn open in the centre over its own backdrop, holding the error summary
 * and what was typed, with the page's blocks inert and the shell too (PostOutcome.modal); it takes
 * no anchor classes, since the page loads at its top, where the button may be off the screen, and
 * its Close is a link that loads the page afresh.
 *
 * The finder is a GET form: a lookup changes nothing, so it needs no form token and no recent
 * sign-in, and its address (`?find=`) can be shared. Everything that changes a pause is a POST
 * that needs a sign-in from the last few minutes (Page.recentSignIn); when the session's is older,
 * every change control becomes one link to sign in again, with a sentence on why. Viewers who can
 * see pauses but not change them (no moderation.block) get no change controls at all.
 *
 * Every reason and every name is untrusted text, escaped and isolated (untrusted()); a reason keeps
 * its line breaks through CSS, never markup. Messages are constant wording and never quote it.
 */
import type { ModerationOverview, PauseStatus, PauseView } from "../../application/moderation.js";
import {
  DEFAULT_PAUSE_DURATION,
  featureLabel,
  PAUSE_DURATIONS,
  PAUSE_FEATURES,
} from "../../domain/moderation.js";
import { MANAGER_ONLY_BLOCKS, PERMISSIONS, type PermissionId } from "../../domain/rbac.js";
import { idSchema } from "../../domain/values.js";
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { icon } from "../icons.js";
import { time } from "../time.js";
import {
  choiceGroup,
  context,
  errorSummary,
  type FieldError,
  formActions,
  hidden,
  notice,
  postForm,
  selectField,
  submitButton,
  textField,
} from "./forms.js";

// ---------------------------------------------------------------------------------------------
// The page's vocabulary, shared with the page module

/** The page's path (its page module's). */
export const MODERATION_PATH = "/g/:guild/moderation";

/** The forms' operation field, and the two operations the page takes. */
export const OP_FIELD = "op";
export const OPS = ["block", "lift"] as const;
export type ModerationOp = (typeof OPS)[number];

/** The forms' other fields. `feature` repeats: one value per feature ticked. */
export const MEMBER_FIELD = "member";
export const FEATURE_FIELD = "feature";
export const DURATION_FIELD = "duration";
export const REASON_FIELD = "reason";

/** The reason's longest length, as the service accepts it (UTF-16 units, as the browser counts). */
export const REASON_MAX = 1000;

/** The finder's query parameter. */
export const FIND_PARAM = "find";

/**
 * The fixed success notices, by the token a redirect carries. Past tense, so a reload that shows
 * one again stays true (forms.ts's notice()).
 */
export const MODERATION_NOTICES = {
  paused: "Pause set. They see the feature, when it ends and your reason, never who paused them.",
  lifted: "Pause lifted.",
  "not-paused": "Nothing to lift. That pause had already ended.",
} as const;

export type ModerationNotice = keyof typeof MODERATION_NOTICES;

/** What the finder says about text it can't read. */
export const FIND_UNREADABLE =
  "Enter a member's ID or mention, or a suggestion number such as #123.";
/** What the member field says about text it can't read. */
export const MEMBER_UNREADABLE = "Enter the member's ID, or paste a mention.";

/** A Discord ID has 17 to 20 digits; a shorter number is something else (a suggestion's). */
const SNOWFLAKE = /^[1-9][0-9]{16,19}$/u;
const MENTION = /^<@!?([1-9][0-9]{16,19})>$/u;
const SUGGESTION = /^#([1-9][0-9]{0,14})$/u;

/** A member as someone types one: an ID or a mention (`<@123…>`), else null. */
export function readMember(text: string): string | null {
  const trimmed = text.trim();
  const id = MENTION.exec(trimmed)?.[1] ?? trimmed;
  return SNOWFLAKE.test(id) && idSchema.safeParse(id).success ? id : null;
}

/** What the finder's text asks for. */
export type FindQuery =
  | { readonly kind: "member"; readonly userId: string }
  | { readonly kind: "suggestion"; readonly number: number };

/** The finder's text as a query: a member (ID or mention) or a suggestion (`#123`), else null. */
export function readFind(text: string): FindQuery | null {
  const trimmed = text.trim();
  const number = SUGGESTION.exec(trimmed)?.[1];
  if (number !== undefined) return { kind: "suggestion", number: Number(number) };
  const userId = readMember(trimmed);
  return userId === null ? null : { kind: "member", userId };
}

/** Names for the IDs the page shows: a name, null for someone who left, absent when unknown. */
export type Names = ReadonlyMap<string, string | null>;

/** What the finder found. */
export type FindResult =
  | { readonly kind: "unreadable" }
  | {
      readonly kind: "member";
      readonly status: PauseStatus;
    }
  | {
      readonly kind: "suggestion";
      readonly number: number;
      /** Who sent it, with their pauses; null when TaruBot has no record of it in this server. */
      readonly sender: PauseStatus | null;
    };

/** One problem in a refused form: constant wording, never the submitted text. */
export interface Problem {
  /** The control it belongs to, else the form as a whole. */
  readonly field: "member" | "feature" | "duration" | "reason" | "form";
  readonly message: string;
}

/** A refused Pause someone form, re-rendered drawn open with what was typed. */
export interface RefusedPause {
  readonly form: "block";
  readonly member: string;
  readonly features: readonly string[];
  readonly duration: string;
  readonly reason: string;
  readonly problems: readonly Problem[];
}

/** A refused Lift form, re-rendered drawn open with what was typed. */
export interface RefusedLift {
  readonly form: "lift";
  readonly member: string;
  readonly feature: PermissionId;
  readonly reason: string;
  readonly problems: readonly Problem[];
}

export type Refused = RefusedPause | RefusedLift;

/** What the page knows about the person looking at it. */
export interface Viewer {
  readonly userId: string;
  /** Holds moderation.block: may pause and lift (within the rules the service applies). */
  readonly canChange: boolean;
  /** A server manager: may also pause mod mail and lift a manager's pauses. */
  readonly manager: boolean;
}

export interface ModerationView {
  readonly overview: ModerationOverview;
  readonly names: Names;
  readonly viewer: Viewer;
  /** The session's sign-in is recent enough for a change (PageContext.recentSignIn). */
  readonly recentSignIn: boolean;
  /** How recent that is, in whole minutes (RECENT_SIGN_IN_MS), for the sentence that says so. */
  readonly recentMinutes: number;
  /** Where "Sign in again" goes: /login with this page as the return path. */
  readonly signInHref: string;
  /** The page's own path; the forms post here and the finder reads here. */
  readonly action: string;
  /** PageContext.formToken. */
  readonly token: string;
  /** The request URL, for the notice token. */
  readonly url: URL;
  /** The finder's text as typed, and what it found. */
  readonly findText: string;
  readonly found?: FindResult;
  readonly refused?: Refused;
}

/** Whether the page draws a refused form open on top of it (PostOutcome.modal). */
export const drawsRefused = (view: ModerationView): boolean => view.refused !== undefined;

// ---------------------------------------------------------------------------------------------
// Small pieces

/** The ids the page's elements share. */
const NEW_PAUSE = "mod-pause";
const FOUND_PAUSE = "mod-pause-found";
/**
 * The anchor pairs of the two Pause buttons (styles/role-menu.ts's PAGE_ANCHORS has one static
 * pair for each name): `anchor-<name>` on the button, `overlay--anchored anchored-<name>` on its
 * closed panel. Anchor names are global to the page, so each button has its own.
 */
const PAUSE_ANCHOR = "moderation-pause";
const FOUND_PAUSE_ANCHOR = "moderation-pause-found";
const LIFT_OPEN = "mod-lift-open";
/**
 * A chip's Lift panel is `<prefix>-<pause id>`. The finder's card shows a person's chips again
 * under their own prefix, so no element id is on the page twice (the kit's rule, and what each
 * `<label for>` needs).
 */
const LIFT_PREFIX = "mod-lift";
const FOUND_LIFT_PREFIX = "mod-lift-found";
const FIND_FIELD = "mod-find";
const ACTIVE_HEADING = "mod-active";
const ENDED_HEADING = "mod-ended";
const FOUND_HEADING = "mod-found";

/** `<time>` for an instant; the text names UTC, as every time on the web does. */
function at(instant: Date): SafeHtml {
  const { iso, text } = time(instant);
  return html`<time datetime="${iso}">${text}</time>`;
}

/** A person: their name when known, always their ID (the name is untrusted; the ID is not). */
function who(id: string, names: Names): SafeHtml {
  const name = names.get(id);
  if (typeof name === "string") return html`${untrusted(name)} <code class="mod-id">${id}</code>`;
  return html`<code class="mod-id">${id}</code>${
    name === null ? html` <span class="mod-gone">Left the server</span>` : ""
  }`;
}

/** A person by name alone where known, else their ID. */
function whoShort(id: string, names: Names): SafeHtml {
  const name = names.get(id);
  return typeof name === "string" ? untrusted(name) : html`<code class="mod-id">${id}</code>`;
}

/** A person as text, for a control's hidden name. */
const whoText = (id: string, names: Names): string => {
  const name = names.get(id);
  return typeof name === "string" ? name : id;
};

/** The finder's address for a person. */
const findHref = (view: ModerationView, userId: string): string =>
  href(`${view.action}?${FIND_PARAM}=${encodeURIComponent(userId)}`);

/** Who set a pause, in words: a server manager, or an officer. */
const LEVEL_WORDS = { manager: "server manager", moderator: "officer" } as const;

/** How long a pause lasts, as a chip says it. */
const untilText = (pause: PauseView): SafeHtml =>
  pause.until === null ? html`Until lifted` : html`Until ${at(pause.until)}`;

/** Close's name, told apart from every other Close (WCAG 2.4.6). */
const closeName = (what: string): SafeHtml =>
  html`Close<span class="visually-hidden"> ${what}</span>`;

/** A page block's ` inert` while a refused form is drawn open over it. */
const behind = (view: ModerationView): SafeHtml | "" =>
  view.refused === undefined ? "" : html` inert`;

/** The error summary's entries for a refused form, each linking to its control or the form's line. */
function summaryOf(id: string, problems: readonly Problem[]): FieldError[] {
  return problems.map((problem) => ({
    id: problem.field === "form" ? `${id}-error` : `${id}-${problem.field}`,
    message: problem.message,
  }));
}

/** A control's problem, if the refused form had one for it. */
const problemAt = (problems: readonly Problem[], field: Problem["field"]): string | undefined =>
  problems.find((problem) => problem.field === field)?.message;

/** The form's own problem line at its top. */
function formError(id: string, problems: readonly Problem[]): SafeHtml | "" {
  const message = problemAt(problems, "form");
  return message === undefined
    ? ""
    : html`<p class="orr-field__hint orr-field__hint--error form-error" id="${id}-error" tabindex="-1"><span class="visually-hidden">Error: </span>${message}</p>`;
}

// ---------------------------------------------------------------------------------------------
// Overlays

/** What a panel is made of. */
interface Panel {
  readonly id: string;
  /** The action; the dialog's name starts with it. */
  readonly title: string;
  /** What it acts on, under the title (untrusted text goes through untrusted()). */
  readonly subject?: SafeHtml;
  readonly size: "wide" | "narrow";
  /** The id of the body's note, which describes the dialog. */
  readonly describedBy: string;
  readonly body: SafeHtml;
  /** Close's hidden name. */
  readonly closes: string;
  /**
   * The name of the static anchor pair that opens it beside its button on a wide screen. Without
   * one it opens centred; a panel drawn open after a refusal never takes it.
   */
  readonly anchor?: string;
}

/**
 * A panel: closed, a modal dialog in the page, closed by Close, Escape or a click outside
 * (closedby="any"), its popover attribute the fallback for a browser without invoker commands; its
 * title takes focus as it opens, so a phone's keyboard doesn't come up over the sheet. Open (a
 * refused form), a plain element fixed in the centre by its class, as markup can't open a dialog,
 * the error summary first in its body, and Close a link that loads the page afresh; it is never
 * anchored (the page loads at its top, where the button may be off the screen).
 */
function panel(view: ModerationView, options: Panel, errors?: readonly FieldError[]): SafeHtml {
  const { id } = options;
  const title = `${id}-title`;
  const size = `overlay--${options.size}`;
  const anchored =
    options.anchor === undefined ? "" : ` overlay--anchored anchored-${options.anchor}`;
  const words = html`${options.title}${
    options.subject === undefined
      ? ""
      : html`<span class="overlay__subject"><span class="visually-hidden">: </span>${options.subject}</span>`
  }`;
  if (errors !== undefined)
    return html`<div class="overlay-backdrop"></div><div class="overlay overlay--open ${size}" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${title}" aria-describedby="${options.describedBy}">
<div class="overlay__head"><h2 class="overlay__title" id="${title}" tabindex="-1">${words}</h2><a class="orr-btn orr-btn--ghost overlay__close" href="${href(view.action)}">${closeName(options.closes)}</a></div>
<div class="overlay__body">${errorSummary(errors)}${options.body}</div>
</div>`;
  return html`<dialog class="overlay${anchored} ${size}" id="${id}" popover="auto" closedby="any" aria-labelledby="${title}" aria-describedby="${options.describedBy}">
<div class="overlay__head"><h3 class="overlay__title" id="${title}" tabindex="-1" autofocus>${words}</h3><button type="button" class="orr-btn orr-btn--ghost overlay__close" commandfor="${id}" command="close" popovertarget="${id}" popovertargetaction="hide">${closeName(options.closes)}</button></div>
<div class="overlay__body">${options.body}</div>
</dialog>`;
}

/** What the Pause someone form starts with, or holds after a refusal. */
interface PauseValues {
  readonly member: string;
  readonly features: readonly string[];
  readonly duration: string;
  readonly reason: string;
}

const BLANK_PAUSE: PauseValues = {
  member: "",
  features: [],
  duration: DEFAULT_PAUSE_DURATION,
  reason: "",
};

/** The Pause someone form: who, what, for how long, and the reason they will see. */
function pauseForm(
  view: ModerationView,
  id: string,
  values: PauseValues,
  problems: readonly Problem[],
): SafeHtml {
  return postForm(
    { action: view.action, token: view.token, className: "mod-form" },
    html`<p class="note mod-form__note" id="${id}-note">They see the feature, when it ends and your reason, never who paused them. Their Discord roles don't change.</p>
${formError(id, problems)}${hidden(OP_FIELD, "block")}<div class="mod-form__row">${textField({
      id: `${id}-member`,
      name: MEMBER_FIELD,
      label: "Member",
      hint: "Their ID, or paste a mention.",
      error: problemAt(problems, "member"),
      value: values.member,
      required: true,
      maxLength: 64,
    })}${selectField({
      id: `${id}-duration`,
      name: DURATION_FIELD,
      label: "For how long",
      error: problemAt(problems, "duration"),
      value: values.duration,
      options: Object.entries(PAUSE_DURATIONS).map(([value, { label }]) => ({ value, label })),
    })}</div>${choiceGroup({
      id: `${id}-feature`,
      name: FEATURE_FIELD,
      type: "checkbox",
      legend: "What to pause",
      error: problemAt(problems, "feature"),
      checked: values.features,
      choices: PAUSE_FEATURES.map(({ permission, label }) => {
        const managersOnly = MANAGER_ONLY_BLOCKS.has(permission) && !view.viewer.manager;
        return {
          value: permission,
          label,
          disabled: managersOnly,
          hint: managersOnly ? "Only a server manager can pause this." : undefined,
        };
      }),
    })}${textField({
      id: `${id}-reason`,
      name: REASON_FIELD,
      label: "Reason (they'll see this)",
      hint: `Up to ${REASON_MAX.toLocaleString("en-US")} characters.`,
      error: problemAt(problems, "reason"),
      value: values.reason,
      multiline: true,
      required: true,
      maxLength: REASON_MAX,
    })}${formActions(submitButton("Pause", { variant: "primary" }))}`,
  );
}

/**
 * A Pause someone panel, closed in the page or (a refused form) drawn open. Closed, it takes the
 * anchor pair of the button that opens it, if it has one; drawn open it is centred.
 */
function pausePanel(
  view: ModerationView,
  id: string,
  values: PauseValues,
  refused?: RefusedPause,
  anchor?: string,
): SafeHtml {
  const problems = refused?.problems ?? [];
  return panel(
    view,
    {
      id,
      title: "Pause someone",
      size: "wide",
      describedBy: `${id}-note`,
      body: pauseForm(view, id, values, problems),
      closes: "Pause someone",
      ...(anchor !== undefined && { anchor }),
    },
    refused === undefined ? undefined : summaryOf(id, problems),
  );
}

/** The Lift form: a reason that stays in the history. */
function liftForm(
  view: ModerationView,
  id: string,
  member: string,
  feature: PermissionId,
  reason: string,
  problems: readonly Problem[],
): SafeHtml {
  return postForm(
    { action: view.action, token: view.token, className: "mod-form" },
    html`<p class="note mod-form__note" id="${id}-note">The feature works again at once. Your reason stays in the history for officers; the person isn't shown it.</p>
${formError(id, problems)}${hidden(OP_FIELD, "lift")}${hidden(MEMBER_FIELD, member)}${hidden(FEATURE_FIELD, feature)}${textField(
  {
    id: `${id}-reason`,
    name: REASON_FIELD,
    label: "Reason for lifting",
    hint: `Up to ${REASON_MAX.toLocaleString("en-US")} characters.`,
    error: problemAt(problems, "reason"),
    value: reason,
    multiline: true,
    required: true,
    maxLength: REASON_MAX,
  },
)}${formActions(submitButton("Lift pause", { variant: "primary" }))}`,
  );
}

/**
 * A Lift panel for one pause, closed in the page or (a refused form) drawn open. It opens centred
 * even on a wide screen and is never anchored: anchor pairs are static classes, one per button,
 * and a page has as many Lift buttons as it has pauses (chips, in the finder's card too).
 */
function liftPanel(
  view: ModerationView,
  id: string,
  member: string,
  feature: PermissionId,
  reason: string,
  refused?: RefusedLift,
): SafeHtml {
  const problems = refused?.problems ?? [];
  return panel(
    view,
    {
      id,
      title: "Lift pause",
      subject: html`${featureLabel(feature)} for ${whoShort(member, view.names)}`,
      size: "narrow",
      describedBy: `${id}-note`,
      body: liftForm(view, id, member, feature, reason, problems),
      closes: "Lift pause",
    },
    refused === undefined ? undefined : summaryOf(id, problems),
  );
}

/** The link that replaces a change control while the session's sign-in is too old. */
const signInLink = (view: ModerationView): SafeHtml =>
  html`<a class="orr-btn orr-btn--secondary mod-signin" href="${href(view.signInHref)}">${icon("log-in")}Sign in again to make changes</a>`;

/**
 * An opener button followed by its closed panel, so the dialog gives focus back to the button. An
 * `anchor` names the button an anchor (the panel's own classes point at it, panel()'s).
 */
function opener(
  label: SafeHtml | string,
  id: string,
  variant: "primary" | "secondary",
  panelMarkup: SafeHtml,
  anchor?: string,
): SafeHtml {
  const anchorClass = anchor === undefined ? "" : ` anchor-${anchor}`;
  return html`<button type="button" class="orr-btn orr-btn--${variant} mod-opener${anchorClass}" commandfor="${id}" command="show-modal" popovertarget="${id}" aria-haspopup="dialog">${label}</button>${panelMarkup}`;
}

// ---------------------------------------------------------------------------------------------
// Pauses

/**
 * Whether a pause is the viewer's own. Decided on the person, never on `by`: the service leaves
 * `by` off the viewer's own rows (owner decision Q5 A), and the view keeps the rule itself, so
 * whatever it is handed, an own row never says who set it or who lifted it.
 */
const isOwn = (pause: PauseView, view: ModerationView): boolean =>
  pause.userId === view.viewer.userId;

/**
 * What stands in a chip for Lift when it isn't one. Only when the viewer could change pauses at
 * all: the reason is shown where the button would be, so nobody wonders where it went.
 */
function liftNote(pause: PauseView, view: ModerationView): string | null {
  if (isOwn(pause, view)) return "Your own pause. Someone else lifts it.";
  if (pause.by?.level === "manager" && !view.viewer.manager)
    return "A server manager set this, so only a server manager can lift it.";
  return null;
}

/**
 * Whether Lift is within a viewer who may change pauses' reach: not their own, not a manager's
 * they can't lift, and the issuer is known. A pause without one, other than the viewer's own, is
 * not something the service sends; it is left alone rather than guessed at.
 */
const liftable = (pause: PauseView, view: ModerationView): boolean =>
  pause.by !== undefined && liftNote(pause, view) === null;

/**
 * One paused feature as a chip: the feature and its end on a line, the reason, and who set it with
 * Lift. The viewer's own pauses never say who set them, and their Lift is a sentence saying why
 * there isn't one.
 */
function chip(pause: PauseView, view: ModerationView, prefix = LIFT_PREFIX): SafeHtml {
  const { viewer, names } = view;
  const lift = `${prefix}-${pause.id}`;
  let control: SafeHtml | "" = "";
  if (viewer.canChange) {
    const note = liftNote(pause, view);
    if (note !== null) control = html`<span class="note mod-pause__note">${note}</span>`;
    else if (liftable(pause, view) && view.recentSignIn)
      control = opener(
        html`Lift${context(`${featureLabel(pause.permission)} for ${whoText(pause.userId, names)}`)}`,
        lift,
        "secondary",
        liftPanel(view, lift, pause.userId, pause.permission, ""),
      );
  }
  const setBy =
    pause.by === undefined || isOwn(pause, view)
      ? ""
      : html`<span class="mod-pause__by">Set by ${whoShort(pause.by.userId, names)} (${LEVEL_WORDS[pause.by.level]}) on ${at(pause.createdAt)}</span>`;
  return html`<li class="mod-pause">
<p class="mod-pause__head"><span class="mod-pause__feature">${featureLabel(pause.permission)}</span><span class="mod-until">${untilText(pause)}</span></p>
<p class="mod-pause__reason">${untrusted(pause.reason)}</p>
<div class="mod-pause__foot">${setBy}${control}</div>
</li>`;
}

/** One person's card: who, and a chip per paused feature. */
function personCard(userId: string, pauses: readonly PauseView[], view: ModerationView): SafeHtml {
  const stale =
    !view.recentSignIn && view.viewer.canChange && pauses.some((pause) => liftable(pause, view));
  return html`<li class="orr-card mod-person">
<h3 class="mod-person__name"><a href="${findHref(view, userId)}">${whoLinkText(userId, view.names)}</a>${
    view.names.get(userId) === null ? html` <span class="mod-gone">Left the server</span>` : ""
  }</h3>
<ul class="mod-pauses">${pauses.map((pause) => chip(pause, view))}</ul>
${stale ? html`<div class="mod-person__foot">${signInLink(view)}</div>` : ""}
</li>`;
}

/** A person's name as a link's text: the name and the ID, else the ID. */
function whoLinkText(id: string, names: Names): SafeHtml {
  const name = names.get(id);
  return typeof name === "string"
    ? html`${untrusted(name)} <code class="mod-id">${id}</code>`
    : html`<code class="mod-id">${id}</code>`;
}

/** The active pauses grouped by person, in the order the first of each was set (newest first). */
function byPerson(pauses: readonly PauseView[]): Map<string, PauseView[]> {
  const groups = new Map<string, PauseView[]>();
  for (const pause of pauses) {
    const group = groups.get(pause.userId);
    if (group) group.push(pause);
    else groups.set(pause.userId, [pause]);
  }
  return groups;
}

/**
 * The ended pauses a viewer is shown: other people's. Who lifted a pause, and why, is for officers
 * about other people (owner decision Q5 A), so the viewer's own are left out of every list of them,
 * whatever the service sent; the service leaves them out as well.
 */
const endedFor = (pauses: readonly PauseView[], view: ModerationView): PauseView[] =>
  pauses.filter((pause) => !isOwn(pause, view));

/** One ended pause: who, what, how it ended and why. */
function endedEntry(pause: PauseView, view: ModerationView, linked = true): SafeHtml {
  const { names } = view;
  const ended = pause.ended;
  // A pause that ran out has nobody who ended it, and the service reports its own end (not the
  // later time a write only closed it) as `ended.at`; a lift is when the person lifted it.
  const how =
    ended === undefined
      ? html``
      : ended.by === null
        ? html`Ran out ${at(ended.at)}`
        : html`Lifted by ${whoShort(ended.by, names)} on ${at(ended.at)}`;
  const lifted = ended?.by !== null && ended?.reason ? ended.reason : null;
  const person = linked
    ? html`<a href="${findHref(view, pause.userId)}">${whoLinkText(pause.userId, names)}</a>`
    : html``;
  return html`<li class="mod-done">
<p class="mod-done__head">${person}<span class="mod-done__feature">${featureLabel(pause.permission)}</span></p>
<p class="mod-done__how">${how}</p>
${lifted === null ? "" : html`<p class="mod-done__why">${untrusted(lifted)}</p>`}
<p class="mod-done__was note">Paused for: ${untrusted(pause.reason)}</p>
</li>`;
}

// ---------------------------------------------------------------------------------------------
// The finder

/** The finder: one text field and its button, a GET form (see the module comment). */
function finder(view: ModerationView): SafeHtml {
  const unreadable = view.found?.kind === "unreadable";
  return html`<form class="mod-finder" method="get" action="${href(view.action)}" role="search">${textField(
    {
      id: FIND_FIELD,
      name: FIND_PARAM,
      label: "Find someone",
      hint: "A member's ID or mention, or a suggestion number such as #123 to see who sent it.",
      error: unreadable ? FIND_UNREADABLE : undefined,
      value: view.findText,
      maxLength: 64,
    },
  )}${submitButton("Find")}</form>`;
}

/** The found person: their pauses (or none), what happened before, and Pause for those who may. */
function foundPerson(status: PauseStatus, view: ModerationView): SafeHtml {
  const { viewer, names } = view;
  const subject = status.subject;
  const mayPause = viewer.canChange && !status.self;
  const earlier = endedFor(status.ended, view);
  const prefill = { ...BLANK_PAUSE, member: subject };
  const control = !mayPause
    ? ""
    : view.recentSignIn
      ? opener(
          "Pause",
          FOUND_PAUSE,
          "primary",
          pausePanel(view, FOUND_PAUSE, prefill, undefined, FOUND_PAUSE_ANCHOR),
          FOUND_PAUSE_ANCHOR,
        )
      : signInLink(view);
  return html`<div class="orr-card mod-found">
<div class="mod-found__head"><h3 class="mod-found__name">${who(subject, names)}</h3>${control}</div>
${status.self ? html`<p class="note">This is you. You see your own pauses and their reasons here, but not who set them.</p>` : ""}
${
  status.active.length === 0
    ? html`<p class="mod-found__none">Not paused.</p>`
    : html`<ul class="mod-pauses">${status.active.map((pause) => chip(pause, view, FOUND_LIFT_PREFIX))}</ul>`
}
${
  earlier.length === 0
    ? ""
    : html`<h4 class="mod-found__sub">Earlier pauses</h4><ul class="mod-dones">${earlier.map((pause) => endedEntry(pause, view, false))}</ul>`
}
</div>`;
}

/** The finder's result, under the toolbar. */
function foundSection(view: ModerationView): SafeHtml | "" {
  const found = view.found;
  if (found === undefined || found.kind === "unreadable") return "";
  const body =
    found.kind === "member"
      ? foundPerson(found.status, view)
      : found.sender === null
        ? html`<div class="empty-state"><p>There is no record of who sent suggestion #${String(found.number)} in this server.</p><p class="note">It may be older than TaruBot's records, or have been posted in another server.</p></div>`
        : html`<p class="mod-found__line">Suggestion #${String(found.number)} was sent by ${who(found.sender.subject, view.names)}.</p>${foundPerson(found.sender, view)}`;
  return html`<section class="mod-section" aria-labelledby="${FOUND_HEADING}"${behind(view)}>
<div class="section-heading"><h2 id="${FOUND_HEADING}" tabindex="-1">Result</h2></div>
${body}
</section>`;
}

// ---------------------------------------------------------------------------------------------
// The page

/** The toolbar card: the finder, and Pause someone (or the sign-in link, or nothing). */
function toolbar(view: ModerationView): SafeHtml {
  const { viewer } = view;
  let control: SafeHtml | "" = "";
  if (viewer.canChange) {
    if (view.refused?.form === "block")
      // The refused form is drawn open at the page's end; a link to it stands in for the button.
      control = html`<a class="orr-btn orr-btn--primary mod-opener" href="#${NEW_PAUSE}-title">Pause someone</a>`;
    else if (!view.recentSignIn) control = signInLink(view);
    else
      control = opener(
        "Pause someone",
        NEW_PAUSE,
        "primary",
        pausePanel(view, NEW_PAUSE, BLANK_PAUSE, undefined, PAUSE_ANCHOR),
        PAUSE_ANCHOR,
      );
  }
  return html`<div class="orr-card mod-toolbar"${behind(view)}>
${finder(view)}
${control === "" ? "" : html`<div class="mod-toolbar__tool">${control}</div>`}
</div>`;
}

/** The sentences about changing: why it needs a new sign-in, or why it isn't offered at all. */
function changeNotes(view: ModerationView): SafeHtml | "" {
  const { viewer } = view;
  if (!viewer.canChange)
    return html`<p class="notice"${behind(view)}>${icon("info")}<span>You can see who is paused here. ${PERMISSIONS["moderation.block"].label} is a separate permission, which you don't have.</span></p>`;
  if (!view.recentSignIn)
    return html`<p class="notice notice--warning"${behind(view)}>${icon("triangle-alert")}<span>Pausing and lifting need a sign-in from the last ${String(view.recentMinutes)} minutes, and yours is older. Sign in again to make changes; you can look people up without.</span></p>`;
  if (!viewer.manager)
    return html`<p class="note mod-limits"${behind(view)}>Officers can pause members and guests who hold no officer permissions, and lift pauses officers set. Only server managers can pause mod mail or change a pause a server manager set.</p>`;
  return "";
}

/** The Moderation page's main content. */
export function renderModeration(view: ModerationView): SafeHtml {
  const { overview, refused } = view;
  const groups = byPerson(overview.active);
  const endedList = endedFor(overview.ended, view);
  const open =
    refused?.form === "block"
      ? pausePanel(
          view,
          NEW_PAUSE,
          {
            member: refused.member,
            features: refused.features,
            duration: refused.duration,
            reason: refused.reason,
          },
          refused,
        )
      : refused?.form === "lift"
        ? liftPanel(view, LIFT_OPEN, refused.member, refused.feature, refused.reason, refused)
        : "";
  return html`<p class="lead"${behind(view)}>Pause one person's use of one feature, such as /suggest or reporting a problem, without touching their Discord roles.</p>
<p class="note mod-intro"${behind(view)}>They see the feature, when it ends and your reason, never who paused them. Times are UTC.</p>
${notice(view.url, MODERATION_NOTICES)}
${changeNotes(view)}
${toolbar(view)}
${foundSection(view)}
<section class="mod-section" aria-labelledby="${ACTIVE_HEADING}"${behind(view)}>
<div class="section-heading"><h2 id="${ACTIVE_HEADING}" tabindex="-1">Paused now</h2><p class="section-description section-count">${String(groups.size)} ${groups.size === 1 ? "person" : "people"}</p></div>
${
  groups.size === 0
    ? html`<div class="empty-state"><p>Nobody is paused.</p><p class="note">Pause someone with the button above, or find a member or a suggestion's sender first.</p></div>`
    : html`<ul class="mod-people">${[...groups].map(([userId, pauses]) => personCard(userId, pauses, view))}</ul>`
}
${overview.truncated ? html`<p class="note">Showing the newest pauses only. Lift some to see the rest.</p>` : ""}
</section>
<section class="mod-section" aria-labelledby="${ENDED_HEADING}"${behind(view)}>
<div class="section-heading"><h2 id="${ENDED_HEADING}" tabindex="-1">Recently ended</h2><p class="section-description">Newest first. A pause that ran out has nobody who lifted it.</p></div>
${
  endedList.length === 0
    ? html`<div class="empty-state"><p>No pause has ended yet.</p></div>`
    : html`<ul class="mod-dones">${endedList.map((pause) => endedEntry(pause, view))}</ul>`
}
</section>
${open}`;
}
