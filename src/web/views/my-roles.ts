/**
 * My roles (2.40.0): members, guests and officers pick their own self-service roles from the
 * officers' menu, typed state in (SelfRoles.view's MyRoles) and escaped markup out, with no
 * service or gateway I/O.
 *
 * One form, one card per category the person may change, phones first: a fieldset whose legend is
 * also the category's heading, radios starting with "No role from this category" for a pick-one
 * category, checkboxes otherwise, and one Save button that stays in reach at the bottom of a
 * phone's screen. Each row is a native input with its `<label for>`, and the label's hit area
 * covers the whole row, at least 44px tall (styles/my-roles.ts), so a thumb can't miss it.
 *
 * A save touches only the categories the person changed, so a stale tab, Dyno or an officer's hand
 * edit is never undone in a category they left alone. The form tells SelfRoles.choose what it
 * showed, in hidden fields per category it lets them change:
 * - `shown` = the category's ID;
 * - `seen:<categoryId>` = each value ticked when the form was first rendered, "" (NONE) for a
 *   preselected "No role from this category". A 422 re-render carries the first render's values
 *   again, so what counts as changed never drifts with the corrections;
 * and the inputs are named `c-<categoryId>`. A category with nothing to change, a draft (officers
 * only, shown disabled) and a locked form send none of them.
 *
 * What it never shows: anyone else's roles, which roles a person used to hold, or why a role
 * fails the menu's rules (officers see that on Role menu). Role names come from the view
 * (TaruBot's cached view of the server), escaped and isolated; messages use Discord's mention
 * grammar and render through mentionText(). The status banner is the person's own newest change,
 * by state and count only: which roles it named is never stored once it ends, so never shown.
 */
import type { MyRoles, RoleChoiceStatus } from "../../application/self-roles.js";
import {
  CHOICE_MESSAGES,
  type CategoryChoice,
  type ChoiceCategory,
  type ChoiceError,
  type ChoiceOption,
} from "../../domain/self-roles.js";
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { type IconName, icon } from "../icons.js";
import { mentionText, roleName, type WebNames } from "../mentions.js";
import { time } from "../time.js";
import {
  type Choice,
  choiceGroup,
  context,
  errorSummary,
  type FieldError,
  formActions,
  hidden,
  NOTICE_ID,
  NOTICE_PARAM,
  postForm,
  submitButton,
} from "./forms.js";

// ---------------------------------------------------------------------------------------------
// The form's vocabulary, shared with the page module

/** The page's path (its page module's), which Role menu's lead links to and gives to share. */
export const MY_ROLES_PATH = "/g/:guild/my-roles";

/**
 * Role menu's path (its page module's), which the officers' notes here link to. It lives beside
 * MY_ROLES_PATH, since Role menu's view already imports this module and the two pages link to
 * each other.
 */
export const ROLE_MENU_PATH = "/g/:guild/role-menu";

/** The hidden field naming each category the form lets the person change. */
export const SHOWN_FIELD = "shown";

/** The hidden fields with what a category showed ticked when the form was first rendered. */
export const seenField = (categoryId: string): string => `seen:${categoryId}`;

/** The name of a category's inputs. */
export const choiceField = (categoryId: string): string => `c-${categoryId}`;

/** The value of "No role from this category" in a pick-one category. */
export const NONE = "";

/**
 * How many someone may pick from a category, in the words members read here; Role menu shows its
 * categories with the same words, as members will see them.
 */
export function pickRule(max: number | null): string {
  if (max === null) return "Pick any number";
  return max === 1 ? "Pick one" : `Pick up to ${max}`;
}

/**
 * The fixed notices, by the token a redirect carries. A save's own redirect needs none: the status
 * banner says what became of it, from the job. Past tense, so a reload that shows it again stays
 * true (forms.ts's notice()).
 */
export const MY_ROLES_NOTICES = {
  unchanged: "Nothing to save. Those are already your roles.",
} as const;

export type MyRolesNotice = keyof typeof MY_ROLES_NOTICES;

/**
 * The "unchanged" notice while a change still waits (queued, running, paused or blocked). The form
 * shows that change ticked, so sending it back as shown changes nothing, but those roles aren't
 * the person's yet: "Those are already your roles" would contradict the banner beside it. A save
 * that changes nothing writes nothing (SelfRoles.choose's equal-state rule), so it neither retries
 * the waiting change nor moves its 7 days.
 */
export const UNCHANGED_WHILE_WAITING = "Nothing new to save.";

/**
 * A refused save being re-rendered (PostOutcome.invalid):
 * - conflict (409): officers changed the roles on offer meanwhile; the form shows the menu and the
 *   person's roles as they are now, with CHOICE_MESSAGES.conflict;
 * - invalid (422): too many picked, or a role that can't be picked now; the form keeps what was
 *   submitted (`submitted`, values the page already checked), marks each refused category, and
 *   carries the first render's `seen` again.
 */
export type RefusedChoice =
  | { readonly kind: "conflict" }
  | {
      readonly kind: "invalid";
      readonly errors: readonly ChoiceError[];
      readonly submitted: readonly CategoryChoice[];
    };

export interface MyRolesView {
  readonly roles: MyRoles;
  /** The viewer is an officer here (actor.officer): officer-only notes show. */
  readonly officer: boolean;
  /** The page's own path; the form posts here. */
  readonly action: string;
  /** PageContext.formToken. */
  readonly token: string;
  /** The request URL, for the notice token (only MY_ROLES_NOTICES' tokens are ever shown). */
  readonly url: URL;
  readonly refused?: RefusedChoice;
}

// ---------------------------------------------------------------------------------------------
// Copy

/**
 * The status banner for the person's newest change (RoleChoiceStatus), each true for as long as
 * that state lasts. "Updated" shows only for a change finished within the last 10 minutes, so it
 * never describes an old save as news. A change that ended unapplied, or that dropped choices,
 * says so for as long as it is the newest (up to 30 days), since the roles below may not be what
 * was asked; those banners name when it ended (RoleChoiceStatus.completedAt, in UTC like every
 * time on the web), so a warning that outlives the problem still reads as history, not as news. A
 * save that changes nothing writes nothing, so it can't replace one.
 */
const STATUS_TEXT = {
  waiting:
    "Saved. TaruBot is updating your roles in Discord. This usually takes under a minute; reload to check.",
  // The form is locked while paused, so it never asks for a save the page can't take.
  paused:
    "Saved. Role changes are paused in this server, so yours will be applied when they resume. If that takes more than 7 days, your change is dropped and you can pick again.",
  // Retries happen by themselves (every 10 minutes, and on a save that changes something); a save
  // that changes nothing writes nothing, so it promises no retry and no new 7 days.
  blocked:
    "Saved, but TaruBot can't change roles in this server right now. Officers can see why. TaruBot keeps trying for up to 7 days after your last saved change.",
  // After a change that ended unapplied, the form shows the roles held, not the change, so a plain
  // Save would change nothing: each says to pick again.
  failed: (at: Date | null): SafeHtml =>
    html`TaruBot couldn't apply your last change${at ? html`, and stopped trying on ${when(at)}` : ""}. Check your roles below and pick again, then save. If it keeps happening, ask an officer.`,
  applied: "Your roles were updated in Discord.",
  expired: (at: Date | null): SafeHtml =>
    html`TaruBot couldn't apply your last change within 7 days, so it was dropped${at ? html` on ${when(at)}` : ""}. Pick your roles again, then save.`,
  dropped: (at: Date | null): SafeHtml =>
    html`TaruBot couldn't apply your last change${at ? html`, and dropped it on ${when(at)}` : ""}. Check your roles below and pick again, then save.`,
  // Applied, but every choice it asked was skipped (RoleChoiceStatus.changed false): nothing was
  // updated, so it reads as a change that wasn't applied, dated by when TaruBot tried.
  unapplied: (at: Date | null): SafeHtml =>
    html`TaruBot couldn't apply your last change${at ? html` on ${when(at)}` : ""}. Check your roles below and pick again, then save.`,
} as const;

/** When a change ended, as a `<time>` element; the text names UTC, as every time on the web does. */
function when(at: Date): SafeHtml {
  const { iso, text } = time(at);
  return html`<time datetime="${iso}">${text}</time>`;
}

/**
 * An applied change that changed at least one role and left `count` choices out, dated by when it
 * was applied (`at`) when the row says (one that changed nothing is STATUS_TEXT.unapplied). Nothing records which (owner decision Q4 A: the job counts, never names), so nobody
 * can be pointed at them: the person checks their roles.
 */
export const skippedText = (count: number, at: Date | null = null): SafeHtml =>
  html`Your roles were updated${at ? html` on ${when(at)}` : ""}, but ${count} of your choices couldn't be applied. Check your roles below, or ask an officer.`;

/** A banner's look: its tone class and icon. */
type Tone = "info" | "success" | "warning";

const TONES: Readonly<Record<Tone, { readonly className: string; readonly icon: IconName }>> = {
  info: { className: "notice", icon: "clock" },
  success: { className: "notice notice--success", icon: "circle-check" },
  warning: { className: "notice notice--warning", icon: "triangle-alert" },
};

/** What the status banner says for `status`, or null for nothing to say. */
export function statusBanner(
  status: RoleChoiceStatus | null,
): { readonly text: SafeHtml | string; readonly tone: Tone } | null {
  if (!status) return null;
  switch (status.state) {
    case "waiting":
      return { text: STATUS_TEXT.waiting, tone: "info" };
    case "paused":
      return { text: STATUS_TEXT.paused, tone: "info" };
    case "blocked":
      return { text: STATUS_TEXT.blocked, tone: "warning" };
    case "failed":
      return { text: STATUS_TEXT.failed(status.completedAt), tone: "warning" };
    case "applied":
      if (status.skipped > 0 && !status.changed)
        return { text: STATUS_TEXT.unapplied(status.completedAt), tone: "warning" };
      if (status.skipped > 0)
        return { text: skippedText(status.skipped, status.completedAt), tone: "warning" };
      return status.recent ? { text: STATUS_TEXT.applied, tone: "success" } : null;
    case "expired":
      return { text: STATUS_TEXT.expired(status.completedAt), tone: "warning" };
    case "dropped":
      return { text: STATUS_TEXT.dropped(status.completedAt), tone: "warning" };
  }
}

/** Why the form can't be saved now, and the officers' notes, each a constant sentence. */
const CALLOUTS = {
  administrator: html`Members and guests can't open this page while TaruBot has Administrator in this server. Use <code>/setup overrides</code>, then remove Administrator once <code>/config validate</code> says it's no longer needed.`,
  setup: "TaruBot isn't set up in this server yet, so there are no roles to pick here.",
  paused:
    "Role changes are paused in this server right now. You can see your roles here, but changes can't be saved until they resume.",
  /** The locked form's reason when the paused banner already says the pause holds a change. */
  pausedWaiting: "You can't change your roles here until role changes resume.",
  unavailable:
    "TaruBot can't read this server's roles right now, so they can't be changed here. Try again in a minute.",
  unreadable: (roleMenu: SafeHtml): SafeHtml =>
    html`The saved role menu can't be read by this TaruBot version, so members and guests have nothing to pick. Reset it on ${roleMenu}.`,
} as const;

/**
 * "Role menu" as a link to that page in this server, for the officers' notes: each tells them to
 * act there, and on a phone the navigation is a scroll away. Only officers ever see these notes,
 * and only officers can open Role menu.
 */
const roleMenuLink = (guildId: string): SafeHtml =>
  html`<a href="${href(ROLE_MENU_PATH.replace(":guild", guildId))}">Role menu</a>`;

/** The page's opening sentence, and the privacy note under it, always shown. */
const LEAD =
  "Pick the roles you'd like in this server. TaruBot adds or removes them for you in Discord.";
const PRIVACY =
  "Roles you choose appear on your profile in this server, where everyone can see them. TaruBot keeps no record of which roles you choose; Discord holds your roles.";

// ---------------------------------------------------------------------------------------------
// Ids and names

/** A category's fieldset (and the error summary's link target). */
const groupId = (categoryId: string): string => `category-${categoryId}`;
/** The form's own message: a conflict, or a refusal for a category no longer shown. */
const FORM_ERROR = "my-roles-error";
const SAVE_HINT = "my-roles-save-hint";

/** The cached names the page knows: the menu's roles only (MyRoles.roleNames). */
const namesOf = (roles: MyRoles): WebNames => ({
  roles: roles.roleNames,
  channels: new Map(),
  users: new Map(),
});

/** Role names two or more menu roles share, so a label adds the role's ID (WCAG 2.4.6). */
function sharedNames(names: WebNames): ReadonlySet<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const name of names.roles.values()) (seen.has(name) ? twice : seen).add(name);
  return twice;
}

/** A role's label: its cached name (with its ID, hidden, when shared), else its ID. */
function roleLabel(roleId: string, names: WebNames, shared: ReadonlySet<string>): SafeHtml {
  const name = names.roles.get(roleId);
  if (name === undefined) return html`<code>${roleId}</code>`;
  return shared.has(name)
    ? html`${untrusted(name)}<span class="visually-hidden"> (${roleId})</span>`
    : untrusted(name);
}

/** A short state word beside a name; its text carries the meaning. */
const badge = (text: string): SafeHtml => html`<span class="orr-badge">${text}</span>`;

/**
 * A row a waiting change ticks differently from what the person holds now. The ticks follow the
 * waiting change, so a second save builds on it, but a ticked row isn't a role they have yet, nor
 * an unticked one gone: the badge (inside the label, so it joins the accessible name) says which
 * way it is waiting. A draft's rows show what the officer holds, so they never get one.
 */
function waitingBadge(layout: Layout, row: ChoiceOption): SafeHtml | "" {
  if (layout.draft || !row.changeable || row.ticked === row.held) return "";
  return html` ${badge(row.ticked ? "Waiting to add" : "Waiting to remove")}`;
}

/**
 * Whether a row can come back once it's gone, beside its name (inside the label, so it joins the
 * accessible name):
 * - "No longer offered": officers stopped offering it (a Stop offering category says so once, on
 *   its heading, instead);
 * - "Can't be picked again right now": still offered, but it fails a rule now (say it was moved
 *   above a moderation role), so unticking it removes it with no way to pick it again until
 *   officers fix it. Never why: officers see that on Role menu.
 * A draft previews what its rows will say once published, so only "No longer offered" shows
 * there: none of its rows can be picked yet, held or not.
 */
function stateBadge(layout: Layout, row: ChoiceOption): SafeHtml | "" {
  if (row.notOffered) return layout.removal ? "" : html` ${badge("No longer offered")}`;
  return !layout.draft && row.held && !row.addable
    ? html` ${badge("Can't be picked again right now")}`
    : "";
}

/** A callout: info by default, or a warning. */
const callout = (body: SafeHtml | string, warning = false): SafeHtml =>
  html`<p class="${warning ? "notice notice--warning" : "notice"}">${icon(warning ? "triangle-alert" : "info")}<span>${body}</span></p>`;

// ---------------------------------------------------------------------------------------------
// One category

/** How a category renders for this person. */
interface Layout {
  readonly category: ChoiceCategory;
  readonly draft: boolean;
  readonly removal: boolean;
  /** Radios, starting with "No role from this category". */
  readonly pickOne: boolean;
  /** The rows with an input: every row of a draft (disabled), else the changeable ones. */
  readonly inputs: readonly ChoiceOption[];
  /** Roles held that can't be changed now, shown as a line of text. */
  readonly fixed: readonly ChoiceOption[];
  /** It takes part in a save: `shown` and `seen` are sent for it. */
  readonly submits: boolean;
}

function layoutOf(category: ChoiceCategory, locked: boolean): Layout {
  const draft = category.state === "draft";
  const fixed = draft ? [] : category.options.filter((row) => !row.changeable);
  // Full of roles that can't change (fullOfFixed): no input could do anything here, since any
  // pick goes over the limit and "No role" or unticking changes nothing, so the category is plain
  // text. Deciding it here keeps the inputs, `submits`, firstTicks and the refusal's groups in step.
  const inputs = draft
    ? category.options
    : fullOfFixed(category, fixed.length)
      ? []
      : category.options.filter((row) => row.changeable);
  return {
    category,
    draft,
    removal: category.state === "removal_only",
    // A draft previews what members will get: radios when it will be a pick-one category.
    pickOne: category.input === "one" || (draft && category.max === 1),
    inputs,
    fixed,
    submits: !draft && !locked && inputs.length > 0,
  };
}

/**
 * A published category with a limit, where the person holds as many roles as it allows (or more)
 * that can't be changed now, and has nothing changeable ticked: picking a role there is always
 * refused (CHOICE_MESSAGES.fixedMax, as changedCategories counts the fixed roles), and leaving
 * everything as it is changes nothing.
 */
function fullOfFixed(category: ChoiceCategory, fixed: number): boolean {
  return (
    category.state === "published" &&
    category.max !== null &&
    category.ticked === 0 &&
    fixed >= category.max
  );
}

/**
 * The values ticked when the form is first rendered. A pick-one category ticks its one role, or
 * "No role from this category" when none is held, and nothing when several are held (Dyno
 * leftovers): the person picks one to keep. It ticks nothing either when they hold a role there
 * that can't be changed now: "No role" would say they hold none, and their one role may be that
 * one. A draft ticks what the officer holds.
 */
function firstTicks(layout: Layout): string[] {
  const ticked = layout.inputs
    .filter((row) => (layout.draft ? row.held : row.ticked))
    .map((row) => row.roleId);
  if (!layout.pickOne) return ticked;
  if (layout.fixed.length > 0) return [];
  if (ticked.length === 0) return [NONE];
  return ticked.length === 1 ? ticked : [];
}

/** The values a category may carry: its input rows, and NONE in a pick-one category. */
function valuesOf(layout: Layout): ReadonlySet<string> {
  return new Set([...(layout.pickOne ? [NONE] : []), ...layout.inputs.map((row) => row.roleId)]);
}

/**
 * A category with nothing to tick (layoutOf gave it no input): only roles held that can't be
 * changed now, or as many of them as its limit allows. Never a draft, whose rows are all inputs.
 */
const textOnly = (layout: Layout): boolean => !layout.draft && layout.inputs.length === 0;

/**
 * The roles a text-only category holds for the person, said once: "You have @A and @B. They
 * can't be changed here right now." Named with Discord's mention grammar, as every held role that
 * isn't an input is.
 */
function keptSentence(rows: readonly ChoiceOption[], names: WebNames): SafeHtml {
  const mentions = rows.map((row) => roleName(row.roleId, names));
  const listed =
    mentions.length === 1
      ? html`${mentions[0] ?? ""}`
      : html`${mentions.slice(0, -1).map((mention, at) => (at === 0 ? mention : html`, ${mention}`))} and ${mentions.at(-1) ?? ""}`;
  return html`You have ${listed}. ${rows.length === 1 ? "It" : "They"} can't be changed here right now.`;
}

/**
 * The lines under a category's legend: its rule, description, the roles the person holds there
 * that can't be changed now, and any note about its state. They are the group's hint, which the
 * fieldset names with aria-describedby, so someone moving through the inputs hears the roles
 * they keep along with the choices. A text-only category's rule would ask for a pick nobody can
 * make there, so it says there is nothing to pick instead, and its roles are one sentence, not a
 * framed line each that could pass for a row to tap. The draft note's "Role menu" links to that
 * page (`guildId`'s), where officers publish it.
 */
function hintFor(layout: Layout, names: WebNames, guildId: string): SafeHtml {
  const { category } = layout;
  const plain = textOnly(layout);
  // A Stop offering category's badge says nobody can add its roles; its rule says what's left.
  const rule = plain
    ? "Nothing to pick right now"
    : layout.removal
      ? "You can remove these"
      : pickRule(category.max);
  // An odd state needs the person's attention (the warning tone); a draft is only a fact.
  const draft = layout.draft
    ? html`<span class="my-category__draft">Draft: only officers can see this. Publish it on ${roleMenuLink(guildId)}.</span>`
    : "";
  const odd = oddState(layout);
  const kept = plain
    ? [html`<span class="my-category__kept">${keptSentence(layout.fixed, names)}</span>`]
    : layout.fixed.map(
        (row) =>
          html`<span class="my-category__fixed">You have ${roleName(row.roleId, names)}; it can't be changed here right now.</span>`,
      );
  // One line each on screen; the spaces (and the rule's hidden full stop) keep them apart where
  // they are read as one description, by aria-describedby or as text.
  const parts = [
    html`<span class="my-category__rule">${rule}<span class="visually-hidden">.</span></span>`,
    ...(category.description === ""
      ? []
      : [html`<span class="my-category__desc">${untrusted(category.description)}</span>`]),
    ...(draft === "" ? [] : [draft]),
    ...kept,
    ...(odd === null ? [] : [html`<span class="my-category__note">${odd}</span>`]),
  ];
  return html`${parts.map((part, at) => (at === 0 ? part : html` ${part}`))}`;
}

/**
 * A note when what the person has doesn't fit the category's rule: several roles of a pick-one
 * category (Dyno leftovers), a pick-one category where a role they hold can't be changed now
 * beside others they can, or more than a lowered limit. Either way the category counts as
 * unchanged until they change it. The roles they hold that can't be changed count toward the
 * limit, as they do when a save is checked (changedCategories), so the page and the save agree.
 * `ticked` counts changeable roles only and a draft has no fixed rows, so a draft never gets one.
 * A text-only category (fullOfFixed among them) already says it has nothing to pick and that its
 * roles can't be changed, so it gets a note only for a lowered limit, which is news.
 *
 * Whether a note shows follows the rows as ticked, which a waiting change overlays, since that is
 * what the form shows and the next save is judged against. The words never say "You have" of a
 * role the person doesn't hold, though: while a change waits in this category, they speak of
 * what the saved change would leave them with.
 */
function oddState(layout: Layout): string | null {
  const { category } = layout;
  const fixed = layout.fixed.length;
  const ticked = category.ticked + fixed;
  const waiting = category.options.some((row) => row.changeable && row.ticked !== row.held);
  const have = (count: number) =>
    waiting ? `With your saved change you'd have ${count}` : `You have ${count}`;
  // With nothing changeable ticked, a pick-one category is full of what can't change: text only.
  if (layout.pickOne && fixed > 0)
    return category.ticked === 0
      ? null
      : `${have(ticked)} of these roles, and ${fixed === 1 ? "one" : fixed} can't be changed here right now. Choose No role from this category to remove the others.`;
  if (layout.pickOne && category.ticked > 1)
    return `${have(category.ticked)} of these roles. Pick one to keep it and remove the others.`;
  if (category.state === "published" && category.max !== null && ticked > category.max)
    return `${have(ticked)}; the limit is now ${category.max}.`;
  return null;
}

/**
 * The category's name as its heading, with a badge for a state that isn't plain published. It is
 * the fieldset's legend too (a legend may hold a heading), so someone moving by heading reaches
 * each category, and the group is announced by the same name.
 */
function titleFor(layout: Layout): SafeHtml {
  const state = layout.draft ? badge("Draft") : layout.removal ? badge("No longer offered") : "";
  return html`<h2 class="my-category__title">${untrusted(layout.category.name)}</h2>${state === "" ? "" : html` ${state}`}`;
}

/** One category's card. */
function categoryCard(
  view: MyRolesView,
  layout: Layout,
  names: WebNames,
  shared: ReadonlySet<string>,
  locked: boolean,
): SafeHtml {
  const { category } = layout;
  const id = groupId(category.id);
  const refused = view.refused?.kind === "invalid" ? view.refused : undefined;
  const submitted = refused?.submitted.find((entry) => entry.categoryId === category.id);
  const allowed = valuesOf(layout);
  // A re-render keeps what came back, and what the first render showed, within the values the
  // form offers now (the page checked them as IDs already; this keeps a re-render to its own).
  const kept = (values: readonly string[]) => values.filter((value) => allowed.has(value));
  const ticks = firstTicks(layout);
  const checked = submitted ? kept(submitted.picked) : ticks;
  const seen = submitted ? kept(submitted.seen) : ticks;
  const errors = (refused?.errors ?? []).filter((error) => error.categoryId === category.id);
  const error =
    errors.length === 0
      ? undefined
      : html`${errors.map((entry, at) =>
          at === 0
            ? mentionText(entry.message, names)
            : html` ${mentionText(entry.message, names)}`,
        )}`;
  const guildId = view.roles.guildId;
  let body: SafeHtml;
  if (layout.inputs.length === 0) {
    // Nothing to tick (only roles held that can't change now): a heading and its lines, no group.
    body = html`<div class="my-category__plain"><div class="my-category__head">${titleFor(layout)}</div><p class="orr-field__hint">${hintFor(layout, names, guildId)}</p></div>`;
  } else {
    // A pick-one category that preselects no radio (several roles held, or one that can't be
    // changed) marks each role held there that can still be changed, so the form says what's held.
    const several = layout.pickOne && !layout.draft && ticks.length === 0;
    const choices: Choice[] = [
      ...(layout.pickOne
        ? [{ value: NONE, label: html`No role from this category${context(category.name)}` }]
        : []),
      ...layout.inputs.map(
        (row): Choice => ({
          value: row.roleId,
          label: html`${roleLabel(row.roleId, names, shared)}${stateBadge(layout, row)}${
            several && row.held ? html` ${badge("You have this")}` : ""
          }${waitingBadge(layout, row)}`,
          hint: row.description === "" ? undefined : untrusted(row.description),
        }),
      ),
    ];
    body = choiceGroup({
      id,
      name: choiceField(category.id),
      type: layout.pickOne ? "radio" : "checkbox",
      legend: titleFor(layout),
      hint: hintFor(layout, names, guildId),
      choices,
      checked,
      error,
      disabled: layout.draft || locked,
    });
  }
  const fields = layout.submits
    ? html`${hidden(SHOWN_FIELD, category.id)}${seen.map((value) =>
        hidden(seenField(category.id), value),
      )}`
    : "";
  const className = layout.draft
    ? "orr-card my-category my-category--draft"
    : "orr-card my-category";
  return html`<div class="${className}"><div class="orr-card__body">${body}${fields}</div></div>`;
}

// ---------------------------------------------------------------------------------------------
// The page

/** The status region: the "unchanged" notice and the newest change's banner, or nothing. */
function statusRegion(view: MyRolesView): SafeHtml | "" {
  const items: SafeHtml[] = [];
  const token = view.url.searchParams.get(NOTICE_PARAM);
  const state = view.roles.status?.state;
  const waiting = state === "waiting" || state === "paused" || state === "blocked";
  // Only the table's own sentences: a token it doesn't hold shows nothing, and is never shown.
  // While a change waits, "unchanged" says only that nothing new was saved (UNCHANGED_WHILE_WAITING).
  if (token !== null && Object.hasOwn(MY_ROLES_NOTICES, token))
    items.push(
      banner(
        token === "unchanged" && waiting
          ? UNCHANGED_WHILE_WAITING
          : MY_ROLES_NOTICES[token as MyRolesNotice],
        "info",
        "info",
      ),
    );
  const job = statusBanner(view.roles.status);
  if (job) items.push(banner(job.text, job.tone));
  if (items.length === 0) return "";
  // The id is the fragment a save's redirect scrolls to; tabindex lets it take that focus.
  return html`<div class="my-roles-status" id="${NOTICE_ID}" role="status" tabindex="-1">${items}</div>`;
}

/** One banner in the status region. */
function banner(
  text: SafeHtml | string,
  tone: Tone,
  iconName: IconName = TONES[tone].icon,
): SafeHtml {
  return html`<p class="${TONES[tone].className}">${icon(iconName)}<span>${text}</span></p>`;
}

/** Why nothing can be saved now, and the officers' notes. */
function callouts(view: MyRolesView): SafeHtml[] {
  const { roles } = view;
  const out: SafeHtml[] = [];
  if (view.officer && roles.administrator === true) out.push(callout(CALLOUTS.administrator, true));
  if (!roles.configured) return [...out, callout(CALLOUTS.setup)];
  if (view.officer && roles.unreadableMenu)
    out.push(callout(CALLOUTS.unreadable(roleMenuLink(roles.guildId)), true));
  if (roles.timedOut) out.push(callout(CHOICE_MESSAGES.timedOut, true));
  // A change parked by the pause already says so in the status banner, so only the locked form's
  // reason is added: the banner alone wouldn't explain the missing Save button.
  if (roles.effectsMode !== "live")
    out.push(
      callout(roles.status?.state === "paused" ? CALLOUTS.pausedWaiting : CALLOUTS.paused, true),
    );
  if (!roles.available) out.push(callout(CALLOUTS.unavailable, true));
  return out;
}

/** The categories in a form with Save, or on their own when nothing can be saved now. */
function categories(view: MyRolesView, names: WebNames, formError: SafeHtml | ""): SafeHtml {
  const { roles } = view;
  const locked = !roles.canSave;
  const layouts = roles.categories.map((category) => layoutOf(category, locked));
  const shared = sharedNames(names);
  // A locked form (a time-out, or changes paused) is still the person's own view of their roles,
  // so its rows stay readable rather than dimmed like one disabled row (styles/my-roles.ts).
  const cards = html`<div class="${locked ? "my-categories my-categories--locked" : "my-categories"}">${layouts.map(
    (layout) => categoryCard(view, layout, names, shared, locked),
  )}</div>`;
  // Only a category with something to change makes a form worth sending.
  if (!layouts.some((layout) => layout.submits)) return html`${formError}${cards}`;
  // The hint sits above the Save row, not in it: on phones the row sticks to the bottom of the
  // screen, and with enlarged text a hint beside the button grew it into a tall column that
  // covered the focused input, past the page's scroll padding (WCAG 2.4.11). It is still the
  // button's description.
  return postForm(
    { action: view.action, token: view.token, className: "my-roles-form" },
    html`${formError}${cards}<p class="note my-roles-form__hint" id="${SAVE_HINT}">Only the categories you change are saved.</p>${formActions(
      submitButton("Save my roles", { variant: "primary", describedBy: SAVE_HINT }),
    )}`,
  );
}

/**
 * The empty state, when there is nothing to show and nothing else explains why. It blames nobody
 * for a menu that offers roles none of which can be picked now (MyRoles.offers): that is usually
 * a server-wide problem, such as TaruBot losing Manage Roles or its role being moved down, which
 * officers find on Role menu, not a menu they haven't set up.
 */
function emptyState(view: MyRolesView): SafeHtml | "" {
  const { roles } = view;
  if (!roles.configured || roles.categories.length > 0) return "";
  const nothingNow = html`<p>There are no roles to pick here right now.</p>`;
  if (roles.unreadableMenu) return html`<div class="empty-state">${nothingNow}</div>`;
  // Without TaruBot's view of the roles the callout already says why nothing shows.
  if (!roles.available) return "";
  const roleMenu = roleMenuLink(roles.guildId);
  if (roles.offers)
    return html`<div class="empty-state">${nothingNow}${view.officer ? html`<p class="note">${roleMenu} shows which roles have a problem.</p>` : ""}</div>`;
  // Officers see drafts here as cards, so for them an empty page means an empty menu.
  if (view.officer)
    return html`<div class="empty-state"><p>Nothing is published yet.</p><p class="note">Add a category with roles on ${roleMenu}, then publish it.</p></div>`;
  return html`<div class="empty-state"><p>Your officers haven't set up any roles to pick yet.</p><p class="note">Roles they offer, such as pronouns or games, will show up here.</p></div>`;
}

/**
 * The errors of a refused save: for the summary at the top (each linking to its category, or to
 * the form's own message), and that message, which carries a conflict and any refusal for a
 * category this render doesn't show as a group.
 */
function refusal(
  view: MyRolesView,
  names: WebNames,
): { summary: FieldError[]; formError: SafeHtml | "" } {
  const refused = view.refused;
  if (!refused) return { summary: [], formError: "" };
  const formMessage = (messages: readonly SafeHtml[]): SafeHtml =>
    html`<p class="orr-field__hint orr-field__hint--error form-error" id="${FORM_ERROR}" tabindex="-1"><span class="visually-hidden">Error: </span>${messages.map(
      (message, at) => (at === 0 ? message : html` ${message}`),
    )}</p>`;
  if (refused.kind === "conflict") {
    const message = mentionText(CHOICE_MESSAGES.conflict, names);
    return { summary: [{ id: FORM_ERROR, message }], formError: formMessage([message]) };
  }
  const locked = !view.roles.canSave;
  // The groups this render shows (none without TaruBot's view of the roles: no card shows then).
  const grouped = new Set(
    view.roles.available
      ? view.roles.categories
          .filter((category) => layoutOf(category, locked).inputs.length > 0)
          .map((category) => category.id)
      : [],
  );
  // A limit's message says only "here", which the card makes clear but the summary at the top
  // (and the form's own message, away from any card) can't: there it names the category (WCAG
  // 2.4.4, 3.3.1). A role's own refusal names its role, so it stands as it is. A category this
  // person can't see (a draft, for a member) has no name to give.
  const away = (error: ChoiceError, message: SafeHtml): SafeHtml => {
    const category = view.roles.categories.find((entry) => entry.id === error.categoryId);
    if (!category || error.roleId !== undefined) return message;
    if (error.max !== undefined)
      return html`${untrusted(category.name)}: ${error.max === 1 ? "pick only one role." : `pick at most ${error.max} roles.`}`;
    return html`${untrusted(category.name)}: ${message}`;
  };
  const summary: FieldError[] = [];
  const elsewhere: SafeHtml[] = [];
  for (const error of refused.errors) {
    const message = mentionText(error.message, names);
    if (grouped.has(error.categoryId))
      summary.push({ id: groupId(error.categoryId), message: away(error, message) });
    else {
      summary.push({ id: FORM_ERROR, message: away(error, message) });
      elsewhere.push(away(error, message));
    }
  }
  return { summary, formError: elsewhere.length === 0 ? "" : formMessage(elsewhere) };
}

/** The My roles page's main content. */
export function renderMyRoles(view: MyRolesView): SafeHtml {
  const names = namesOf(view.roles);
  const { summary, formError } = refusal(view, names);
  const notes = callouts(view);
  return html`${errorSummary(summary)}
<div class="my-roles-intro">
<p class="lead">${LEAD}</p>
<p class="note my-roles-intro__privacy">${PRIVACY}</p>
</div>
${statusRegion(view)}
${notes.length === 0 ? "" : html`<div class="my-roles-callouts">${notes}</div>`}
${
  // Without TaruBot's view of the server's roles nothing can be changed or even named, so the
  // callout says why and no card shows (held roles would show as bare IDs).
  view.roles.configured && view.roles.available && view.roles.categories.length > 0
    ? categories(view, names, formError)
    : formError
}
${emptyState(view)}`;
}
