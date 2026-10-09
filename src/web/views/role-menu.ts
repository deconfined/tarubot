/**
 * The Role menu (2.39.0): officers build the server's self-service role menu, typed state in and
 * escaped markup out, with no service or gateway I/O. Members and guests pick from it on My roles
 * (2.40.0, views/my-roles.ts), whose address the lead gives, ready to copy; nothing here changes
 * anyone's roles itself.
 *
 * One page of small native forms (PAGE_PATH takes no parameters), each carrying `op`, the IDs it
 * acts on, the menu `revision` it was rendered at (the officers' optimistic lock) and the session's
 * form token (postForm). Every edit is applied by ID, never by index, and a move names an absolute
 * place, so a repeated submit changes nothing the second time (the equal-state rule).
 *
 * Layout (styles/role-menu.ts): each category is a compact card. Its head is one line (the name,
 * the pick rule and how many roles, then the state badges), its roles wrap as mention chips or
 * line up in two columns when any has a description, and its foot is a line saying what the state
 * means and what each state button does, then one toolbar: the editors (Edit roles, Add roles,
 * Edit category) as disclosures that open in place, across the card, the state buttons, Move up
 * and Move down, and Delete category.
 *
 * Accessibility: every control has a visible label, and controls that repeat per category or role
 * carry a visually hidden suffix naming what they act on (forms.ts's context()), so each name is
 * unique on the page (WCAG 2.4.6). Destructive actions (delete a category, reset the menu) sit
 * only inside a closed disclosure that states the consequence first. A state button submits at
 * once, so what it does is on screen before it, in the card's state line, and that sentence is
 * also the button's description (aria-describedby). A refused form is re-rendered with what was
 * typed, its disclosure open and an error summary linking to its fields.
 *
 * Role and channel names come from the gateway cache (mentions.ts), escaped and isolated; problem
 * messages use Discord's mention grammar and render through mentionText(). Nothing an officer
 * typed is ever quoted in a message.
 */
import type { SelfRoleEditor } from "../../application/self-roles.js";
import {
  type CategoryState,
  MENU_LIMITS,
  type MenuFieldError,
  type MenuOperation,
  menuRoleIds,
  type RoleCheck,
  removableBy,
  type SelfRoleCategory,
  type SelfRoleMenu,
  type SelfRoleOption,
} from "../../domain/self-roles.js";
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { icon } from "../icons.js";
import { channelName, mentionText, roleName, type WebNames } from "../mentions.js";
import {
  type Choice,
  choiceGroup,
  context,
  disclosure,
  errorSummary,
  type FieldError,
  formActions,
  hidden,
  notice,
  numberField,
  postForm,
  type SelectOption,
  selectField,
  submitButton,
  textField,
} from "./forms.js";
import { MY_ROLES_PATH, pickRule } from "./my-roles.js";

// ---------------------------------------------------------------------------------------------
// Notices and the forms' vocabulary, shared with the page module

/**
 * The fixed success notices, by the token a successful edit's redirect carries. Each says what was
 * done, in the past tense, so it stays true when a reload or Back shows it again (forms.ts's
 * notice()); none says how the menu is "now".
 */
export const ROLE_MENU_NOTICES = {
  created: "Category added as a draft. Add its roles, then publish it when it's ready.",
  saved: "Category saved.",
  moved: "Category moved.",
  published: "Category published.",
  stopped: "Category no longer offered. Nobody can add its roles.",
  drafted: "Category moved back to draft.",
  deleted: "Category deleted. People keep its roles in Discord.",
  "published-all": "Every draft category is published.",
  added: "Roles added.",
  options: "Roles saved.",
  reset: "Role menu reset. Every category was removed.",
} as const;

export type RoleMenuNotice = keyof typeof ROLE_MENU_NOTICES;

/** The notice a successful (or already applied) edit shows. */
export function noticeFor(operation: MenuOperation): RoleMenuNotice {
  switch (operation.op) {
    case "category.create":
      return "created";
    case "category.edit":
      return "saved";
    case "category.move":
      return "moved";
    case "category.setState":
      return STATE_NOTICES[operation.state];
    case "category.delete":
      return "deleted";
    case "menu.publishAll":
      return "published-all";
    case "menu.reset":
      return "reset";
    case "options.add":
      return "added";
    case "options.edit":
      return "options";
  }
}

/**
 * The query parameter a success redirect names its category in, so the notice shows in that
 * category's card rather than at the top of a long page (the server never sees a fragment).
 */
export const NOTICE_CATEGORY = "category";

/**
 * The category whose card a successful edit's notice belongs in: the one the edit changed and that
 * stays on the page (a new category's card included). Deleting, publishing every draft and a reset
 * keep the notice at the top.
 */
export function noticeCategory(operation: MenuOperation): string | undefined {
  switch (operation.op) {
    case "category.create":
    case "category.edit":
    case "category.move":
    case "category.setState":
    case "options.add":
    case "options.edit":
      return operation.categoryId;
    case "category.delete":
    case "menu.publishAll":
    case "menu.reset":
      return undefined;
  }
}

const STATE_NOTICES: Readonly<Record<CategoryState, RoleMenuNotice>> = {
  published: "published",
  removal_only: "stopped",
  draft: "drafted",
};

/** The "How many can someone pick?" value for "any number"; the others are the number itself. */
export const ANY_NUMBER = "any";

/** A category's limit as its select value. */
export const maxValue = (max: number | null): string => (max === null ? ANY_NUMBER : String(max));

/** The limit's choices: any number, one, then up to 2…MENU_LIMITS.max. */
const MAX_OPTIONS: readonly SelectOption[] = [
  { value: ANY_NUMBER, label: pickRule(null) },
  ...Array.from({ length: MENU_LIMITS.max }, (_, at) => ({
    value: String(at + 1),
    label: pickRule(at + 1),
  })),
];

/** An option's state in the Edit roles form. */
export const OPTION_STATES = ["offered", "removal_only", "remove"] as const;
export type OptionState = (typeof OPTION_STATES)[number];

/**
 * Short enough that a closed select shows the whole choice at every width, at 320px too (a choice
 * that also said its consequence was cut off mid-sentence). What each does is the line above the
 * rows (OPTION_STATES_HELP), on screen while the officer picks, and each select's description, so
 * a screen reader hears it with the choice; Remove from menu saves without a confirmation, so the
 * line says what it leaves behind.
 */
const OPTION_STATE_LABELS: readonly SelectOption[] = [
  { value: "offered", label: "Offered" },
  { value: "removal_only", label: "Not offered" },
  { value: "remove", label: "Remove from menu" },
];

/** What the two other state choices do: the Edit roles note's last sentences. */
const OPTION_STATES_HELP =
  "Not offered means nobody can add the role, but people who have it can still remove it. Remove from menu means people keep the role in Discord, but can't change it on My roles.";

/** What a category's state looks like: its badge, and its tone. */
const STATE_BADGES: Readonly<Record<CategoryState, { text: string; tone: string }>> = {
  draft: { text: "Draft", tone: "orr-badge--violet" },
  published: { text: "Published", tone: "orr-badge--success" },
  removal_only: { text: "Not offered", tone: "" },
};

/**
 * The state buttons, each with its consequence. The buttons submit at once, with no confirmation,
 * so the consequence is on screen before them: the card's state line says what the card's state
 * means (STATE_LINES), then each button's `help`, a sentence that starts with the button's own
 * label so it reads as that button's; the same sentence is the button's description
 * (aria-describedby), heard with it. What each state does for members and guests is said as what
 * happens on My roles, their own page, never as "here".
 */
const STATE_ACTIONS: Readonly<Record<CategoryState, { label: string; help: string }>> = {
  published: {
    label: "Publish",
    help: "Publish lets members and guests pick these roles.",
  },
  removal_only: {
    label: "Stop offering",
    help: "Stop offering means people can only remove these roles.",
  },
  draft: {
    label: "Move back to draft",
    help: "Move back to draft hides the category from all but officers; people keep these roles but can't change them until you publish again.",
  },
};

/**
 * What a card's state means for members and guests now: the first sentence of its foot's line,
 * before what each of its state buttons would do (STATE_ACTIONS). Short, as the line says up to
 * three things over every card's toolbar.
 */
const STATE_LINES: Readonly<Record<CategoryState, string>> = {
  draft: "Draft: only officers see it.",
  published: "Published: members and guests can pick these roles on My roles.",
  removal_only: "Not offered: people who have these roles can only remove them on My roles.",
};

/**
 * Delete category's consequence, by the category's state: only a published category can offer Stop
 * offering instead (NEXT_STATES). Members and guests don't see a draft now, though one moved back
 * from published may have been on My roles before, so its note promises nothing about the past.
 */
const DELETE_NOTES: Readonly<Record<CategoryState, string>> = {
  published:
    "People keep these roles in Discord, but won't be able to add or remove them themselves. To let people still remove them, choose Stop offering instead.",
  removal_only:
    "People keep these roles in Discord, but won't be able to remove them themselves any more.",
  draft:
    "Members and guests don't see a draft. People keep these roles in Discord, but won't be able to change them on My roles.",
};

/**
 * What Publish N drafts does: members and guests can pick from a published category at once, so a
 * server replacing a reaction-role bot keeps its drafts until the switch (the officer guide's
 * cutover steps). Publishing is also when owner decision Q3 B starts to apply to the category's
 * roles: reconciliation takes those that open channels from anyone with no access role.
 */
const PUBLISH_NOTE =
  "Members and guests can pick from a category on My roles as soon as it's published. From then on, TaruBot also takes its roles that open channels from anyone with none of the Member, Guest, Officer and FC Leader roles. If you're replacing a reaction-role bot, keep drafts until you switch over.";

/** The states a category can move to from each state, in the order the buttons show. */
const NEXT_STATES: Readonly<Record<CategoryState, readonly CategoryState[]>> = {
  draft: ["published"],
  published: ["removal_only", "draft"],
  removal_only: ["published", "draft"],
};

/** Longest a field may grow as browsers count (UTF-16 units): two per character at most. */
const typingLimit = (characters: number): number => characters * 2;

// ---------------------------------------------------------------------------------------------
// The model

/** Which form a refused POST came from, so its values and errors go back into it. */
export type RoleMenuForm =
  | { readonly kind: "create" }
  | { readonly kind: "category"; readonly categoryId: string }
  | { readonly kind: "options"; readonly categoryId: string }
  | { readonly kind: "add"; readonly categoryId: string }
  /** Move, state and delete: buttons only, nothing typed. */
  | { readonly kind: "action"; readonly categoryId: string }
  /** Publish every draft, or reset an unreadable menu. */
  | { readonly kind: "menu" };

/**
 * The prefix of a form field's companion: a hidden `was:<field>` holding the value the form showed
 * in that field when it was rendered, so the page can tell what the officer changed. Edit category
 * has was:name, was:description and was:max; each Edit roles row has was:description:<roleId> and
 * was:state:<roleId>. A row's shown position needs none: it is the row's place in the form.
 */
export const WAS = "was:";

/** The values a form showed, by field (its `was:` companions); one it didn't send is absent. */
export interface ShownValues {
  readonly name?: string;
  readonly description?: string;
  readonly max?: string;
  readonly state?: string;
}

/** An option's row as Edit roles submitted it, kept as typed; an absent field shows the menu's. */
export interface SubmittedRow {
  readonly description?: string;
  readonly position?: string;
  readonly state?: string;
  /** What the row showed (SubmittedValues.was). */
  readonly was?: ShownValues;
}

/**
 * What a refused form held, to show again exactly as typed (escaped like any text). A field left
 * out shows the menu's current value instead: a 409 passes only the fields the officer changed
 * (role-menu.page.ts), so resubmitting after it can't put back another officer's change in a field
 * this officer never touched.
 */
export interface SubmittedValues {
  readonly name?: string;
  readonly description?: string;
  readonly max?: string;
  /** The create form's minted category ID, so a corrected resubmit is still one create. */
  readonly categoryId?: string;
  readonly roleIds?: readonly string[];
  readonly acknowledged?: boolean;
  readonly rows?: ReadonlyMap<string, SubmittedRow>;
  /**
   * What Edit category showed when it was rendered (its `was:` companions). A 422 renders them
   * again unchanged, with the submitted revision, so a corrected resubmit that then meets a 409
   * still tells what this officer changed. A 409 passes none: its form carries the current
   * revision, so its companions are the menu's current values.
   */
  readonly was?: ShownValues;
}

/** A refused POST being re-rendered (PostOutcome.invalid). */
export interface RefusedEdit {
  readonly form: RoleMenuForm;
  readonly values: SubmittedValues;
  /**
   * The revision the refused form carries again: the one it was submitted with on a 422, so a
   * corrected resubmit still meets the lock, or the current one on a 409, after the officer has
   * seen the menu as it is now.
   */
  readonly revision: bigint;
  /** The domain's field keys (MenuFieldError.field), or "form" for the form as a whole. */
  readonly errors: readonly MenuFieldError[];
}

export interface RoleMenuView {
  readonly editor: SelfRoleEditor;
  readonly names: WebNames;
  /** The page's own path; every form posts here. */
  readonly action: string;
  /** PageContext.formToken. */
  readonly token: string;
  /** The request URL, for the success notice (only its fixed tokens are ever shown). */
  readonly url: URL;
  /** A fresh UUID for Add a category, which recognises a repeated submit by it. */
  readonly newCategoryId: string;
  readonly refused?: RefusedEdit;
}

// ---------------------------------------------------------------------------------------------
// Ids and names

const categoryKey = (id: string): string => `category-${id}`;
const titleId = (id: string): string => `${categoryKey(id)}-title`;
const optionKey = (roleId: string): string => `option-${roleId}`;
/** A category's form-level message for its buttons (Move, the states, Delete), in its foot. */
const actionsId = (id: string): string => `${categoryKey(id)}-actions`;
const CREATE = "new-category";
const INTRO = "role-menu-intro";
const SUMMARY = "role-menu-summary";
/** The line that says what Publish N drafts does, which describes that button. */
const PUBLISH_HELP = "role-menu-publish-help";
const CATEGORIES = "role-menu-categories";
const ADD_CATEGORY = "role-menu-add";
const RESET = "role-menu-reset";

/** The cached role names more than one role in the server has, per names snapshot. */
const sharedNames = new WeakMap<WebNames, ReadonlySet<string>>();

/**
 * Role names two or more roles share. Discord allows that, so a control named after its role adds
 * the role's ID to its hidden suffix when the name alone wouldn't be unique (WCAG 2.4.6).
 */
function rolesSharing(names: WebNames): ReadonlySet<string> {
  let shared = sharedNames.get(names);
  if (!shared) {
    const seen = new Set<string>();
    const twice = new Set<string>();
    for (const name of names.roles.values()) (seen.has(name) ? twice : seen).add(name);
    shared = twice;
    sharedNames.set(names, shared);
  }
  return shared;
}

/** A role's name as plain text for a hidden suffix: the cached name (with its ID when shared). */
function roleText(roleId: string, names: WebNames): string {
  const name = names.roles.get(roleId);
  if (name === undefined) return roleId;
  return rolesSharing(names).has(name) ? `${name} (${roleId})` : name;
}

/** The hidden ID after a visible role name that another role shares, or nothing. */
function roleTwin(roleId: string, names: WebNames): SafeHtml | "" {
  const name = names.roles.get(roleId);
  return name !== undefined && rolesSharing(names).has(name)
    ? html`<span class="visually-hidden"> (${roleId})</span>`
    : "";
}

/** A category's name in the suffixes that tell its controls apart. */
const named = (category: SelfRoleCategory): SafeHtml => context(category.name);

// ---------------------------------------------------------------------------------------------
// Derived state

/** One role's verdict, when TaruBot's view could be read. */
type Checks = ReadonlyMap<string, RoleCheck> | null;

/**
 * Whether an option needs an officer's attention: the "Role menu" health check's per-role rule. The
 * page also counts roles in drafts, which the health check skips (it judges only what members and
 * guests can see), so a draft's problems show here alone.
 */
function needsAttention(
  category: SelfRoleCategory,
  option: SelfRoleOption,
  check: RoleCheck | undefined,
): boolean {
  if (!check) return false;
  const offered = category.state !== "removal_only" && !option.removalOnly;
  return offered ? check.problems.length > 0 : !removableBy(check);
}

/**
 * How many of a category's roles need attention: what its card's badge and heading say, and what
 * the summary adds up and links to, so the three always agree.
 */
const attentionIn = (category: SelfRoleCategory, checks: Checks): number =>
  category.options.filter((option) => needsAttention(category, option, checks?.get(option.roleId)))
    .length;

/** "1 role needs" or "N roles need", ahead of "attention". */
const needWord = (count: number): string => `${count} ${count === 1 ? "role needs" : "roles need"}`;

/** How many more roles a category can take: its own cap, and the menu's. */
function room(menu: SelfRoleMenu, category: SelfRoleCategory): number {
  return Math.min(
    MENU_LIMITS.optionsPerCategory - category.options.length,
    MENU_LIMITS.options - menuRoleIds(menu).length,
  );
}

/** The roles an add can offer (none on the menu, every check passing), in Discord's order. */
function eligible(menu: SelfRoleMenu, roles: readonly RoleCheck[]): RoleCheck[] {
  const onMenu = new Set(menuRoleIds(menu));
  return roles.filter((check) => !onMenu.has(check.roleId) && check.problems.length === 0);
}

/** The roles an add can't offer (off the menu, failing a check), each with its problems. */
function ineligible(menu: SelfRoleMenu, roles: readonly RoleCheck[]): RoleCheck[] {
  const onMenu = new Set(menuRoleIds(menu));
  return roles.filter((check) => !onMenu.has(check.roleId) && check.problems.length > 0);
}

/** Whether the category's Add roles form renders (otherwise a note says why not). */
const addFormShown = (view: RoleMenuView, menu: SelfRoleMenu, category: SelfRoleCategory) =>
  view.editor.roles !== null &&
  room(menu, category) > 0 &&
  eligible(menu, view.editor.roles).length > 0;

/**
 * The element a refused field's error links to and is shown beside: the control when this page
 * renders it, the message itself for a form of buttons alone (a category's Move, state and Delete
 * buttons, whose errors are all about the form as a whole), the summary card's heading for Publish
 * N drafts, else the nearest thing that is there (the category's title, or the section), so every
 * error summary link resolves even after another officer removed what the form edited.
 * Every target takes focus when its link is followed: a control, a choice group's fieldset or a
 * heading or paragraph with tabindex="-1", so keyboard focus lands beside the problem.
 */
function errorTarget(view: RoleMenuView, form: RoleMenuForm, field: string): string {
  // Without a configuration the page renders only the lead and the setup callout.
  if (!view.editor.configured) return INTRO;
  const menu = view.editor.menu;
  if (!menu) return RESET;
  // The summary card holds Publish N drafts and shows the form's message; an empty menu has none.
  if (form.kind === "menu") return menu.categories.length > 0 ? SUMMARY : CATEGORIES;
  if (form.kind === "create") {
    if (menu.categories.length >= MENU_LIMITS.categories) return ADD_CATEGORY;
    if (field === "description" || field === "max") return `${CREATE}-${field}`;
    return `${CREATE}-name`;
  }
  const category = menu.categories.find((candidate) => candidate.id === form.categoryId);
  if (!category) return CATEGORIES;
  const key = categoryKey(category.id);
  switch (form.kind) {
    case "category":
      return field === "description" || field === "max" ? `${key}-${field}` : `${key}-name`;
    case "options": {
      const [kind, roleId] = field.split(":");
      if (
        (kind === "description" || kind === "position") &&
        roleId !== undefined &&
        category.options.some((option) => option.roleId === roleId)
      )
        return `${optionKey(roleId)}-${kind}`;
      const [first] = category.options;
      return first ? `${optionKey(first.roleId)}-description` : titleId(category.id);
    }
    case "add":
      if (!addFormShown(view, menu, category)) return titleId(category.id);
      return field === "acknowledged" && view.editor.unreadableChannels > 0
        ? `${key}-acknowledged`
        : `${key}-roles`;
    case "action":
      return actionsId(category.id);
  }
}

/** Whether `form` is the refused one. */
function isRefused(view: RoleMenuView, form: RoleMenuForm): boolean {
  const refused = view.refused?.form;
  if (!refused || refused.kind !== form.kind) return false;
  return (
    !("categoryId" in form) || ("categoryId" in refused && refused.categoryId === form.categoryId)
  );
}

/** Errors about a form as a whole, shown at its top rather than beside one control. */
const FORM_LEVEL: ReadonlySet<string> = new Set(["form", "rows"]);

/** Messages as one Text, several sentences joined by spaces. */
const joined = (messages: readonly SafeHtml[]): SafeHtml =>
  html`${messages.map((message, at) => (at === 0 ? message : html` ${message}`))}`;

/** "a", "a and b", "a, b and c". */
const listOf = (items: readonly SafeHtml[]): SafeHtml =>
  html`${items.map((item, at) =>
    at === 0 ? item : at === items.length - 1 ? html` and ${item}` : html`, ${item}`,
  )}`;

/** A role ID as an Edit roles row's field key carries it. */
const ROLE_ID = /^[0-9]+$/u;

/**
 * A refused field's message, the same in the error summary and beside its control. An Edit roles
 * row's message names its role first ("@She/Her: Use a whole number of 1 or more."): the domain's
 * wording is the same for every row, so the summary's links would otherwise read alike (WCAG 2.4.4,
 * 3.3.1), and on a phone the row's legend sits out of view above a field its link scrolls to.
 */
function fieldMessage(view: RoleMenuView, form: RoleMenuForm, error: MenuFieldError): SafeHtml {
  const message = mentionText(error.message, view.names);
  const [kind, roleId] = error.field.split(":");
  if (
    form.kind !== "options" ||
    (kind !== "description" && kind !== "position") ||
    roleId === undefined ||
    !ROLE_ID.test(roleId)
  )
    return message;
  return html`${roleName(roleId, view.names)}${roleTwin(roleId, view.names)}: ${message}`;
}

/** The refused form's messages for the control `id`, or undefined when it has none. */
function errorsAt(view: RoleMenuView, form: RoleMenuForm, id: string): SafeHtml | undefined {
  const refused = view.refused;
  if (!refused || !isRefused(view, form)) return undefined;
  const messages = refused.errors
    .filter((error) => !FORM_LEVEL.has(error.field) && errorTarget(view, form, error.field) === id)
    .map((error) => fieldMessage(view, form, error));
  return messages.length === 0 ? undefined : joined(messages);
}

/** The revision a form carries: the refused form's own, else the menu's current one. */
function revisionFor(view: RoleMenuView, form: RoleMenuForm): string {
  return String(
    isRefused(view, form) && view.refused ? view.refused.revision : view.editor.revision,
  );
}

/** A form's hidden fields: the operation, the revision and, when it acts on one, the category. */
function fields(view: RoleMenuView, form: RoleMenuForm, op: MenuOperation["op"]): SafeHtml {
  return html`${hidden("op", op)}${hidden("revision", revisionFor(view, form))}${
    "categoryId" in form ? hidden("category", form.categoryId) : ""
  }`;
}

/** One of this page's forms. */
const pageForm = (view: RoleMenuView, body: SafeHtml, className?: string): SafeHtml =>
  postForm(
    className === undefined
      ? { action: view.action, token: view.token }
      : { action: view.action, token: view.token, className },
    body,
  );

// ---------------------------------------------------------------------------------------------
// Pieces

/**
 * A badge: a short mono word whose text carries the meaning. `repeated` hides it from assistive
 * technology where nearby text already says the same in words (a category's heading).
 */
const badge = (text: string, tone = "", repeated = false): SafeHtml => {
  const className = tone === "" ? "orr-badge" : `orr-badge ${tone}`;
  return repeated
    ? html`<span class="${className}" aria-hidden="true">${text}</span>`
    : html`<span class="${className}">${text}</span>`;
};

/** A callout: info by default, or a warning. */
const callout = (body: SafeHtml | string, warning = false): SafeHtml =>
  html`<p class="${warning ? "notice notice--warning" : "notice"}">${icon(warning ? "triangle-alert" : "info")}<span>${body}</span></p>`;

/** "Opens: #a, #b": the channels a role makes visible, or nothing. */
function opens(check: RoleCheck | undefined, names: WebNames): SafeHtml | "" {
  if (!check || check.opens.length === 0) return "";
  const channels = check.opens.map((id, at) =>
    at === 0 ? channelName(id, names) : html`, ${channelName(id, names)}`,
  );
  return html`Opens: ${channels}`;
}

/** A role's problems as warning lines. */
function problems(check: RoleCheck | undefined, names: WebNames): SafeHtml | "" {
  if (!check || check.problems.length === 0) return "";
  return html`<ul class="menu-problems">${check.problems.map(
    (problem) =>
      html`<li>${icon("triangle-alert")}<span>${mentionText(problem.message, names)}</span></li>`,
  )}</ul>`;
}

/**
 * A refused form's messages about the form as a whole (a conflict, an out-of-date form, a cap), at
 * its top; the error summary links to its first control. A form of buttons alone has no control to
 * link to, so `id` makes the message itself the link's target (errorTarget), focusable.
 */
function formErrors(view: RoleMenuView, form: RoleMenuForm, id?: string): SafeHtml | "" {
  const refused = view.refused;
  if (!refused || !isRefused(view, form)) return "";
  const messages = refused.errors
    .filter((error) => FORM_LEVEL.has(error.field))
    .map((error) => mentionText(error.message, view.names));
  if (messages.length === 0) return "";
  const body = html`<span class="visually-hidden">Error: </span>${joined(messages)}`;
  return id === undefined
    ? html`<p class="orr-field__hint orr-field__hint--error form-error">${body}</p>`
    : html`<p class="orr-field__hint orr-field__hint--error form-error" id="${id}" tabindex="-1">${body}</p>`;
}

/** The three text fields a category has, for Add a category and Edit category. */
function categoryFields(
  view: RoleMenuView,
  form: RoleMenuForm,
  prefix: string,
  values: { name: string; description: string; max: string },
  suffix: SafeHtml | "",
): SafeHtml {
  return html`${textField({
    id: `${prefix}-name`,
    name: "name",
    label: html`Name${suffix}`,
    hint: `Up to ${MENU_LIMITS.name} characters, such as Pronouns or Games.`,
    value: values.name,
    maxLength: typingLimit(MENU_LIMITS.name),
    required: true,
    error: errorsAt(view, form, `${prefix}-name`),
  })}${textField({
    id: `${prefix}-description`,
    name: "description",
    label: html`Description${suffix}`,
    hint: `Optional. One line of up to ${MENU_LIMITS.description} characters, shown above the roles.`,
    value: values.description,
    maxLength: typingLimit(MENU_LIMITS.description),
    error: errorsAt(view, form, `${prefix}-description`),
  })}${selectField({
    id: `${prefix}-max`,
    name: "max",
    label: html`How many can someone pick?${suffix}`,
    options: MAX_OPTIONS,
    value: values.max,
    error: errorsAt(view, form, `${prefix}-max`),
  })}`;
}

// ---------------------------------------------------------------------------------------------
// The menu's summary and banners

/**
 * The page's one featured card, once there is a category (an empty menu has the empty state
 * instead): what needs doing, the counts, and Publish N drafts.
 */
function summary(view: RoleMenuView, menu: SelfRoleMenu, checks: Checks): SafeHtml | "" {
  const categories = menu.categories;
  if (categories.length === 0) return "";
  const drafts = categories.filter((category) => category.state === "draft").length;
  const published = categories.filter((category) => category.state === "published").length;
  const notOffered = categories.length - drafts - published;
  const roles = menuRoleIds(menu).length;
  const counts = categories.map((category) => ({ category, count: attentionIn(category, checks) }));
  const attention = counts.reduce((total, entry) => total + entry.count, 0);
  const title =
    attention > 0
      ? `${needWord(attention)} attention.`
      : drafts > 0
        ? `${drafts} ${drafts === 1 ? "draft isn't" : "drafts aren't"} published yet.`
        : published === categories.length
          ? "Every category is published."
          : "Every category is published or no longer offered.";
  const mark = attention > 0 ? "warn" : drafts > 0 ? "wait" : "ok";
  // Where the problems are, as links to each card's focusable heading, so an officer on a phone
  // needn't read every role to find them.
  const affected = counts.filter((entry) => entry.count > 0);
  const where =
    affected.length === 0
      ? ""
      : html`<p class="menu-summary__where">In ${listOf(
          affected.map(
            ({ category, count }) =>
              html`<a href="#${titleId(category.id)}">${untrusted(category.name)}</a> (${count})`,
          ),
        )}.</p>`;
  const errors = formErrors(view, { kind: "menu" });
  const readout = (label: string, value: number) =>
    html`<div class="orr-stat menu-summary__count"><dt class="orr-stat__label orr-label">${label}</dt><dd class="orr-stat__value">${value}</dd></div>`;
  const publish =
    drafts > 0
      ? pageForm(
          view,
          html`${fields(view, { kind: "menu" }, "menu.publishAll")}${submitButton(
            `Publish ${drafts} ${drafts === 1 ? "draft" : "drafts"}`,
            { variant: "primary", describedBy: PUBLISH_HELP },
          )}`,
        )
      : "";
  return html`<section class="orr-card orr-card--holo orr-holo-edge featured menu-summary" aria-labelledby="role-menu-summary">
<div class="orr-card__head">
<span class="menu-summary__mark menu-summary__mark--${mark}">${icon(mark === "warn" ? "triangle-alert" : mark === "wait" ? "clock" : "circle-check")}</span>
<div class="orr-card__titles">
<p class="orr-label">Role menu</p>
<h2 id="${SUMMARY}" class="menu-summary__title" tabindex="-1">${title}</h2>
${where}
</div>
</div>
<div class="orr-card__body">
<dl class="menu-summary__counts">${readout("Published", published)}${readout("Not offered", notOffered)}${readout("Drafts", drafts)}${readout("Roles", roles)}</dl>
</div>
${
  drafts > 0 || errors !== ""
    ? html`<div class="orr-card__foot menu-summary__foot">${errors}${
        drafts > 0 ? html`<p class="note" id="${PUBLISH_HELP}">${PUBLISH_NOTE}</p>${publish}` : ""
      }</div>`
    : ""
}
</section>`;
}

/** The callouts that apply to this server. */
function banners(view: RoleMenuView): SafeHtml[] {
  const editor = view.editor;
  const out: SafeHtml[] = [];
  if (editor.administrator === true)
    out.push(
      callout(
        html`Members and guests won't be able to pick roles while TaruBot has Administrator in this server. Use <code>/setup overrides</code>, then remove Administrator once <code>/config validate</code> says it's no longer needed.`,
        true,
      ),
    );
  if (editor.roles === null)
    out.push(
      callout(
        "TaruBot can't read this server's roles right now, so it can't show which roles have a problem, or add roles. Try again in a minute.",
        true,
      ),
    );
  // A menu this build can't read offers only Reset role menu, so nothing there adds roles.
  if (editor.unreadableChannels > 0)
    out.push(
      callout(
        `TaruBot can't see ${editor.unreadableChannels} ${editor.unreadableChannels === 1 ? "channel" : "channels"} in this server, so it can't check roles there.${editor.menu === null ? "" : " Adding roles asks you to confirm you've checked."}`,
        true,
      ),
    );
  if (editor.memberRoleId === null && editor.guestRoleId === null)
    out.push(
      callout(
        html`Members and guests won't be able to pick these roles until a Member or Guest role is set with <code>/config roles</code>.`,
      ),
    );
  else if (editor.memberRoleId === null)
    out.push(
      callout(
        html`Members won't be able to pick these roles until a Member role is set with <code>/config roles</code>.`,
      ),
    );
  if (editor.onboarding)
    out.push(
      callout(
        "TaruBot's onboarding controls channel access here, so these roles can't open channels.",
      ),
    );
  if (editor.effectsMode === "awaiting_activation")
    out.push(
      callout(
        "Discord changes are paused in this server until TaruBot is activated, so members and guests won't be able to save role choices until then. You can still build the menu.",
      ),
    );
  else if (editor.effectsMode === "deployment_disabled")
    out.push(
      callout(
        "Discord changes are off for this TaruBot deployment, so members and guests won't be able to save role choices. You can still build the menu.",
      ),
    );
  return out;
}

/** The banners as one block under the lead, or nothing. */
function bannerBlock(view: RoleMenuView): SafeHtml | "" {
  const shown = banners(view);
  return shown.length === 0 ? "" : html`<div class="menu-banners">${shown}</div>`;
}

// ---------------------------------------------------------------------------------------------
// A category's card

/**
 * One role on the menu, as members will see it, with what an officer should know: its mention chip
 * and badge, then its description and the channels it opens (beside the chip in a card with room,
 * styles/role-menu.ts), and any problems as warning lines (the item then takes a row of its own,
 * tinted, so drift stands out).
 */
function optionItem(option: SelfRoleOption, check: RoleCheck | undefined, names: WebNames) {
  const opened = opens(check, names);
  const flagged = check !== undefined && check.problems.length > 0;
  return html`<li class="${flagged ? "menu-option menu-option--attention" : "menu-option"}">
<p class="menu-option__role">${roleName(option.roleId, names)}${option.removalOnly ? badge("Not offered") : ""}</p>
${option.description === "" ? "" : html`<p class="menu-option__desc">${untrusted(option.description)}</p>`}
${opened === "" ? "" : html`<p class="menu-option__opens">${opened}</p>`}
${problems(check, names)}
</li>`;
}

/**
 * A disclosure in a card's toolbar. The wrapper lets the stylesheet make each summary one of the
 * toolbar's items, and an open one a row of its own with its panel; `danger` marks Delete category.
 */
const tool = (body: SafeHtml | "", danger = false): SafeHtml | "" =>
  body === ""
    ? ""
    : html`<div class="${danger ? "menu-tool menu-tool--danger" : "menu-tool"}">${body}</div>`;

/** Move up and Move down: absolute places, so a repeat changes nothing. */
function moves(view: RoleMenuView, category: SelfRoleCategory, at: number, last: number): SafeHtml {
  const form: RoleMenuForm = { kind: "action", categoryId: category.id };
  const move = (label: string, to: number) =>
    pageForm(
      view,
      html`${fields(view, form, "category.move")}${hidden("to", String(to))}${submitButton(
        html`${label}${named(category)}`,
      )}`,
      "menu-move",
    );
  return html`${at > 0 ? move("Move up", at - 1) : ""}${at < last ? move("Move down", at + 1) : ""}`;
}

/** The id of the sentence that says what the state button to `state` does, in the card's foot. */
const stateHelpId = (category: SelfRoleCategory, state: CategoryState): string =>
  `${categoryKey(category.id)}-${state}-help`;

/**
 * The card's state line, over its toolbar: what its state means, then what each state button this
 * category offers does, a sentence each (STATE_ACTIONS), each the description of its button.
 */
function stateLine(category: SelfRoleCategory): SafeHtml {
  return html`<p class="menu-category__state">${STATE_LINES[category.state]}${NEXT_STATES[
    category.state
  ].map(
    (state) =>
      html` <span id="${stateHelpId(category, state)}">${STATE_ACTIONS[state].help}</span>`,
  )}</p>`;
}

/** The state buttons this category can take, each described by its sentence in the state line. */
function stateActions(view: RoleMenuView, category: SelfRoleCategory): SafeHtml {
  const form: RoleMenuForm = { kind: "action", categoryId: category.id };
  return html`<div class="menu-states">${NEXT_STATES[category.state].map((state) =>
    pageForm(
      view,
      html`${fields(view, form, "category.setState")}${hidden("state", state)}${submitButton(
        html`${STATE_ACTIONS[state].label}${named(category)}`,
        { describedBy: stateHelpId(category, state) },
      )}`,
      "menu-state",
    ),
  )}</div>`;
}

/** Edit category: its name, description and limit. */
function editCategory(view: RoleMenuView, category: SelfRoleCategory): SafeHtml {
  const form: RoleMenuForm = { kind: "category", categoryId: category.id };
  const refused = isRefused(view, form) ? view.refused?.values : undefined;
  const key = categoryKey(category.id);
  const was = refused?.was;
  const shown = html`${hidden(`${WAS}name`, was?.name ?? category.name)}${hidden(
    `${WAS}description`,
    was?.description ?? category.description,
  )}${hidden(`${WAS}max`, was?.max ?? maxValue(category.max))}`;
  return disclosure(
    html`Edit category${named(category)}`,
    pageForm(
      view,
      html`${fields(view, form, "category.edit")}${shown}${formErrors(view, form)}${categoryFields(
        view,
        form,
        key,
        {
          name: refused?.name ?? category.name,
          description: refused?.description ?? category.description,
          max: refused?.max ?? maxValue(category.max),
        },
        named(category),
      )}${formActions(submitButton(html`Save category${named(category)}`))}`,
      "menu-form",
    ),
    { open: isRefused(view, form) },
  );
}

/**
 * Edit roles: every option's description, place and state in one form (one POST). The note above
 * the rows ends with what Not offered and Remove from menu do (OPTION_STATES_HELP), which also
 * describes every row's state select.
 */
function editOptions(view: RoleMenuView, category: SelfRoleCategory): SafeHtml | "" {
  if (category.options.length === 0) return "";
  const form: RoleMenuForm = { kind: "options", categoryId: category.id };
  const statesHelp = `${categoryKey(category.id)}-states-help`;
  const submitted = isRefused(view, form) ? view.refused?.values.rows : undefined;
  const rows = category.options.map((option, at) => {
    const kept = submitted?.get(option.roleId);
    const key = optionKey(option.roleId);
    const role = roleText(option.roleId, view.names);
    const state = option.removalOnly ? "removal_only" : "offered";
    return html`<fieldset class="option-row">
<legend class="option-row__role">${roleName(option.roleId, view.names)}</legend>
${hidden("role", option.roleId)}${hidden(
  `${WAS}description:${option.roleId}`,
  kept?.was?.description ?? option.description,
)}${hidden(`${WAS}state:${option.roleId}`, kept?.was?.state ?? state)}
<div class="option-row__fields">
${textField({
  id: `${key}-description`,
  name: `description:${option.roleId}`,
  label: html`Description${context(role)}`,
  value: kept?.description ?? option.description,
  maxLength: typingLimit(MENU_LIMITS.optionDescription),
  error: errorsAt(view, form, `${key}-description`),
})}
${numberField({
  id: `${key}-position`,
  name: `position:${option.roleId}`,
  label: html`Position${context(role)}`,
  value: kept?.position ?? String(at + 1),
  min: 1,
  max: category.options.length,
  error: errorsAt(view, form, `${key}-position`),
})}
${selectField({
  id: `${key}-state`,
  name: `state:${option.roleId}`,
  label: html`On the menu${context(role)}`,
  options: OPTION_STATE_LABELS,
  value: kept?.state ?? state,
  describedBy: statesHelp,
})}
</div>
</fieldset>`;
  });
  return disclosure(
    html`Edit roles${named(category)}`,
    pageForm(
      view,
      html`${fields(view, form, "options.edit")}${formErrors(view, form)}<p class="note">Roles are shown in position order. Descriptions are optional, up to ${MENU_LIMITS.optionDescription} characters each. <span id="${statesHelp}">${OPTION_STATES_HELP}</span></p><div class="option-rows">${rows}</div>${formActions(
        submitButton(html`Save roles${named(category)}`),
      )}`,
    ),
    { open: isRefused(view, form) },
  );
}

/** Add roles: a checkbox per eligible role, and why every other role isn't one. */
function addRoles(view: RoleMenuView, menu: SelfRoleMenu, category: SelfRoleCategory): SafeHtml {
  const form: RoleMenuForm = { kind: "add", categoryId: category.id };
  const roles = view.editor.roles;
  const key = categoryKey(category.id);
  const open = isRefused(view, form) || category.options.length === 0;
  // Always a disclosure, so the toolbar keeps its shape: when nothing can be added, its panel says
  // why, where the officer looked for the form.
  const panel = (body: SafeHtml) =>
    disclosure(html`Add roles${named(category)}`, html`<div class="menu-add">${body}</div>`, {
      open,
    });
  if (roles === null)
    return panel(
      html`<p class="note">TaruBot can't read this server's roles right now, so roles can't be added. Try again in a minute.</p>`,
    );
  const space = room(menu, category);
  const refused = ineligible(menu, roles);
  const refusedList =
    refused.length === 0
      ? ""
      : disclosure(
          html`Roles you can't add (${refused.length})${named(category)}`,
          html`<ul class="menu-refusals">${refused.map(
            (check) =>
              html`<li><p class="menu-refusals__role">${roleName(check.roleId, view.names)}</p><p class="note">${mentionText(check.problems[0]?.message ?? "", view.names)}</p></li>`,
          )}</ul>`,
        );
  if (space <= 0) {
    const full =
      MENU_LIMITS.optionsPerCategory - category.options.length <= 0
        ? `This category has the most roles a category can hold (${MENU_LIMITS.optionsPerCategory}).`
        : `The role menu has the most roles it can hold (${MENU_LIMITS.options}).`;
    return panel(html`<p class="note">${full}</p>`);
  }
  const choices = eligible(menu, roles);
  if (choices.length === 0)
    return panel(
      html`<p class="note">No other role can be added: every role in this server is on the menu already or fails a check.</p>${refusedList}`,
    );
  const submitted = isRefused(view, form) ? view.refused?.values : undefined;
  const unreadable = view.editor.unreadableChannels;
  const acknowledgement =
    unreadable > 0
      ? choiceGroup({
          id: `${key}-acknowledged`,
          name: "acknowledged",
          type: "checkbox",
          legend: html`Channels TaruBot can't see${named(category)}`,
          hint: `TaruBot can't see ${unreadable} ${unreadable === 1 ? "channel" : "channels"} in this server, so it can't check these roles there.`,
          checked: submitted?.acknowledged ? ["yes"] : [],
          choices: [
            {
              value: "yes",
              label: html`I've checked that these roles don't open ${unreadable === 1 ? "it or give any permission in it" : "any of them or give any permission in them"}${named(category)}`,
            },
          ],
          error: errorsAt(view, form, `${key}-acknowledged`),
        })
      : "";
  const options: Choice[] = choices.map((check) => {
    const opened = opens(check, view.names);
    return {
      value: check.roleId,
      label: html`${roleName(check.roleId, view.names)}${roleTwin(check.roleId, view.names)}${named(category)}`,
      ...(opened === "" ? {} : { hint: opened }),
    };
  });
  return panel(
    html`${pageForm(
      view,
      html`${fields(view, form, "options.add")}${formErrors(view, form)}${choiceGroup({
        id: `${key}-roles`,
        name: "roles",
        type: "checkbox",
        legend: html`Roles to add${named(category)}`,
        hint: `Roles that pass every check, in Discord's order. ${space < choices.length ? `This category can take ${space} more.` : "Pick as many as you like."}`,
        checked: submitted?.roleIds ?? [],
        choices: options,
        error: errorsAt(view, form, `${key}-roles`),
      })}${acknowledgement}${formActions(submitButton(html`Add selected roles${named(category)}`))}`,
    )}${refusedList}`,
  );
}

/** Delete category, behind its consequence. */
function deleteCategory(view: RoleMenuView, category: SelfRoleCategory): SafeHtml {
  const form: RoleMenuForm = { kind: "action", categoryId: category.id };
  return disclosure(
    html`Delete category${named(category)}`,
    pageForm(
      view,
      html`${fields(view, form, "category.delete")}<p class="note">${DELETE_NOTES[category.state]}</p>${formActions(
        submitButton(html`Yes, delete category${named(category)}`, { variant: "danger" }),
      )}`,
    ),
  );
}

/**
 * The card a success notice shows in: the category the redirect named (NOTICE_CATEGORY), when it is
 * on the menu. The ID from the URL is only compared with the menu's, never shown, so a crafted link
 * can at most move a fixed notice to another card; with no match the notice stays at the top.
 */
function noticeCard(view: RoleMenuView, menu: SelfRoleMenu | null): string | null {
  const id = view.url.searchParams.get(NOTICE_CATEGORY);
  return id !== null && menu?.categories.some((category) => category.id === id) ? id : null;
}

/** "1 role", "N roles", or "No roles". */
const roleCount = (count: number): string =>
  count === 0 ? "No roles" : `${count} ${count === 1 ? "role" : "roles"}`;

/**
 * One category's card: a one-line head, the roles as members will see them, then the foot: a line
 * on what the state means and what each state button does, and the officer's one toolbar, whose
 * editors open in place, across the card.
 */
function categoryCard(
  view: RoleMenuView,
  menu: SelfRoleMenu,
  category: SelfRoleCategory,
  at: number,
  checks: Checks,
): SafeHtml {
  // The success notice, ahead of the head's line, when this card's edit sent the officer here:
  // the #status fragment then lands on this card, and keeps its focus and entrance rules.
  const saved = noticeCard(view, menu) === category.id ? notice(view.url, ROLE_MENU_NOTICES) : "";
  const state = STATE_BADGES[category.state];
  const attention = attentionIn(category, checks);
  // The heading carries the state and any problems in words, since the badges come before it in
  // the markup (the stylesheet draws them at the line's end) and someone moving by heading would
  // skip them; the badges are hidden from assistive technology so that reading on doesn't repeat
  // them.
  const status = `${state.text.toLowerCase()}${attention > 0 ? `, ${needWord(attention)} attention` : ""}`;
  // With any description, the roles line up in two columns where the card has room, each
  // description beside its chip; without, the chips simply wrap.
  const described = category.options.some((option) => option.description !== "");
  const options =
    category.options.length === 0
      ? html`<p class="note">No roles yet. Add the roles people can pick from this category.</p>`
      : html`<ul class="${described ? "menu-options menu-options--described" : "menu-options"}">${category.options.map(
          (option) => optionItem(option, checks?.get(option.roleId), view.names),
        )}</ul>`;
  return html`<li class="orr-card menu-category" id="${categoryKey(category.id)}">
<div class="menu-category__head">
${saved}
<p class="menu-category__meta">${badge(state.text, state.tone, true)}${
    attention > 0 ? badge(`${attention} to check`, "orr-badge--warning", true) : ""
  }</p>
<h3 class="menu-category__title" id="${titleId(category.id)}" tabindex="-1">${untrusted(category.name)}<span class="visually-hidden"> (${status})</span></h3>
<p class="menu-category__facts"><span class="orr-label">${pickRule(category.max)}</span><span class="orr-label">${roleCount(category.options.length)}</span></p>
${category.description === "" ? "" : html`<p class="menu-category__desc">${untrusted(category.description)}</p>`}
</div>
<div class="menu-category__body">
${options}
</div>
<div class="menu-category__foot">
${formErrors(view, { kind: "action", categoryId: category.id }, actionsId(category.id))}
${stateLine(category)}
<div class="menu-toolbar">
${tool(editOptions(view, category))}
${tool(addRoles(view, menu, category))}
${tool(editCategory(view, category))}
${stateActions(view, category)}
<div class="menu-moves">${moves(view, category, at, menu.categories.length - 1)}</div>
${tool(deleteCategory(view, category), true)}
</div>
</div>
</li>`;
}

// ---------------------------------------------------------------------------------------------
// Sections

function categoriesSection(view: RoleMenuView, menu: SelfRoleMenu, checks: Checks): SafeHtml {
  const count = menu.categories.length;
  return html`<section aria-labelledby="${CATEGORIES}">
<div class="section-heading">
<h2 id="${CATEGORIES}" tabindex="-1">Categories</h2>
<p class="section-description section-count">${count} of ${MENU_LIMITS.categories}</p>
<p class="section-description">Members and guests see published categories on My roles in this order, each with its roles.</p>
</div>
${
  count === 0
    ? // No summary card, so a refused Publish N drafts says why here (errorTarget: this section).
      html`${formErrors(view, { kind: "menu" })}<div class="empty-state"><p>No categories yet.</p><p class="note">Add the first one below, such as Pronouns or Games, then add its roles.</p></div>`
    : html`<ol class="menu-categories">${menu.categories.map((category, at) =>
        categoryCard(view, menu, category, at, checks),
      )}</ol>`
}
</section>`;
}

function addCategorySection(view: RoleMenuView, menu: SelfRoleMenu): SafeHtml {
  const form: RoleMenuForm = { kind: "create" };
  const refused = isRefused(view, form) ? view.refused?.values : undefined;
  const full = menu.categories.length >= MENU_LIMITS.categories;
  const body = full
    ? html`<p class="note">The role menu has the most categories it can hold (${MENU_LIMITS.categories}). Delete one to add another.</p>${formErrors(view, form)}`
    : pageForm(
        view,
        html`${fields(view, form, "category.create")}${hidden("id", refused?.categoryId ?? view.newCategoryId)}${formErrors(view, form)}${categoryFields(
          view,
          form,
          CREATE,
          {
            name: refused?.name ?? "",
            description: refused?.description ?? "",
            max: refused?.max ?? ANY_NUMBER,
          },
          "",
        )}${formActions(submitButton("Add category"))}`,
        "menu-form",
      );
  return html`<section aria-labelledby="${ADD_CATEGORY}">
<div class="section-heading">
<h2 id="${ADD_CATEGORY}" tabindex="-1">Add a category</h2>
<p class="section-description">New categories start as drafts, which only officers see.</p>
</div>
<div class="orr-card menu-create"><div class="orr-card__body">${body}</div></div>
</section>`;
}

/** A saved menu this TaruBot can't read: say so, and offer only Reset role menu. */
function unreadableSection(view: RoleMenuView): SafeHtml {
  const form: RoleMenuForm = { kind: "menu" };
  return html`<section aria-labelledby="${RESET}">
<div class="section-heading"><h2 id="${RESET}" tabindex="-1">Saved role menu</h2></div>
<div class="orr-card"><div class="orr-card__body menu-reset">
${callout("The saved role menu was written by a different TaruBot version, or is damaged, so it can't be changed here. Members and guests won't see anything to pick from it.", true)}
${formErrors(view, form)}
${disclosure(
  "Reset role menu",
  pageForm(
    view,
    html`${fields(view, form, "menu.reset")}<p class="note">This replaces the saved menu with an empty one, which you can then build again. Nobody's roles change in Discord.</p>${formActions(
      submitButton("Yes, reset role menu", { variant: "danger" }),
    )}`,
  ),
  { open: isRefused(view, form) },
)}
</div></div>
</section>`;
}

/** Every error of the refused form, for the summary at the top of the page. */
function summaryErrors(view: RoleMenuView): FieldError[] {
  const refused = view.refused;
  if (!refused) return [];
  return refused.errors.map((error) => ({
    id: errorTarget(view, refused.form, error.field),
    message: fieldMessage(view, refused.form, error),
  }));
}

/** The Role menu page's main content. */
export function renderRoleMenu(view: RoleMenuView): SafeHtml {
  const { editor } = view;
  // My roles' address on this server, from the request URL rebuilt on WEB_PUBLIC_ORIGIN (never the
  // Host header), for officers to share with members, such as in the old reaction-roles channel.
  const myRoles = MY_ROLES_PATH.replace(":guild", editor.guildId);
  // The intro: one sentence, then a small line with the one change TaruBot makes unasked, owner
  // decision Q3 B's (Synchronization.user), said where officers read what the menu does (it covers
  // people who never had Member or Guest too, such as lobby users given a game role by another
  // bot), then My roles' address as a chip to copy.
  const lead = html`<div class="menu-intro" id="${INTRO}" tabindex="-1">
<p class="lead">Members and guests pick their own roles from this menu on <a href="${href(myRoles)}">My roles</a>.</p>
<p class="menu-intro__note">TaruBot adds or removes a listed role only when that person asks, apart from roles that open channels, which it takes from anyone with none of the Member, Guest, Officer and FC Leader roles.</p>
<p class="menu-share"><span class="orr-label">Link to share</span> <code>${new URL(myRoles, view.url).href}</code></p>
</div>`;
  // The success notice goes in its category's card when the redirect named one on the menu.
  const top = html`${errorSummary(summaryErrors(view))}${
    noticeCard(view, editor.menu) === null ? notice(view.url, ROLE_MENU_NOTICES) : ""
  }`;
  if (!editor.configured)
    return html`${top}${lead}
${callout(html`Set TaruBot up first: this server has no TaruBot configuration yet. Start with <code>/config fc link</code> and <code>/config roles</code>, or <code>/setup onboarding</code>.`, true)}`;
  const menu = editor.menu;
  if (!menu) return html`${top}${lead}${bannerBlock(view)}${unreadableSection(view)}`;
  const checks: Checks = editor.roles
    ? new Map(editor.roles.map((check) => [check.roleId, check]))
    : null;
  return html`${top}${lead}
${bannerBlock(view)}
${summary(view, menu, checks)}
${categoriesSection(view, menu, checks)}
${addCategorySection(view, menu)}`;
}
