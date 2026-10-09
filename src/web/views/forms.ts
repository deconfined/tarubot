/**
 * The form view kit (#43): pure templates for the forms pages render, styled by
 * styles/forms.ts. Pages compose these rather than write form markup, so every form gets the same
 * guarantees:
 * - postForm() is the only way to open a form: method="post", a same-origin action, and the
 *   session's form token (sessions.ts's formToken) as its first field, so no POST form can forget
 *   it;
 * - every control has a visible `<label for>` (or a `<legend>` for a group), an id unique on the
 *   page, its hint and error tied to it with aria-describedby, and aria-invalid when it has an
 *   error; native inputs throughout, so focus, forced colors and assistive technology work
 *   without script;
 * - a re-render passes the submitted values back in, escaped like any text, so a refused form
 *   keeps what was typed; messages are constant wording and never quote it;
 * - errorSummary() lists each problem as a link to its control, and becomes the page's focus;
 * - buttons carry visible text; a destructive one belongs inside a closed disclosure(), or a page's
 *   closed overlay (Role menu's Delete category), that states the consequence first, so one stray
 *   tap can't delete anything.
 *
 * Labels, hints and legends take constant wording, or markup that escaped its own values (such as
 * context()'s suffix with a role or category name). Nothing here writes a style attribute or a
 * script, and no value reaches the page unescaped (web-boundary.test.ts).
 */
import { href, html, type SafeHtml, untrusted } from "../html.js";
import { FORM_TOKEN_FIELD } from "../http.js";

/** Constant wording, or a template that escaped its own values. */
export type Text = string | SafeHtml;

/**
 * An element id the kit renders and links to (`#id`): a letter, then letters, digits, "-" or "_".
 * Ids come from page code (a field's name, a category's UUID, a role's snowflake with a prefix),
 * never from a request, and anything else is a page bug, refused when the form renders.
 */
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function checkedId(id: string): string {
  if (!ID.test(id))
    throw new Error(`A form control id must be a letter, then letters, digits, "-" or "_".`);
  return id;
}

/**
 * The ids of a control's hint and error, then of a line elsewhere that also describes it (`also`),
 * in that order, for aria-describedby; "" when none.
 */
function describedBy(
  id: string,
  hint: Text | undefined,
  error: Text | undefined,
  also?: string,
): string {
  return [
    hint === undefined ? "" : `${id}-hint`,
    error === undefined ? "" : `${id}-error`,
    also === undefined ? "" : checkedId(also),
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** ` aria-describedby="…"` when there is something to point at. */
const describedByAttribute = (ids: string): SafeHtml =>
  ids === "" ? html`` : html` aria-describedby="${ids}"`;

/** The hint and error paragraphs under a label or legend, with the ids describedBy() names. */
function messages(id: string, hint: Text | undefined, error: Text | undefined): SafeHtml {
  return html`${hint === undefined ? "" : html`<p class="orr-field__hint" id="${id}-hint">${hint}</p>`}${
    error === undefined
      ? ""
      : html`<p class="orr-field__hint orr-field__hint--error" id="${id}-error"><span class="visually-hidden">Error: </span>${error}</p>`
  }`;
}

/** The hidden field with the session's form token; postForm() puts it first in every form. */
export function tokenField(token: string): SafeHtml {
  return html`<input type="hidden" name="${FORM_TOKEN_FIELD}" value="${token}">`;
}

/**
 * A hidden field: an operation name, an ID, a revision, or a minted ID for a create. The token
 * field is postForm()'s alone.
 */
export function hidden(name: string, value: string): SafeHtml {
  if (name === FORM_TOKEN_FIELD) throw new Error("The form token field is postForm()'s alone.");
  return html`<input type="hidden" name="${name}" value="${value}">`;
}

/** postForm()'s options. */
export interface PostFormOptions {
  /** A same-origin path, normally the page's own href; anything else is refused. */
  readonly action: string;
  /** PageContext.formToken. */
  readonly token: string;
  /** Classes beside `form`, which stacks the fields (styles/forms.ts). */
  readonly className?: string;
}

/**
 * A POST form with the token first. `novalidate`: the server checks every field and answers with
 * the error summary, so a browser's own bubbles (which differ between browsers and vanish before
 * they can be read) never stand in for it; `required` still tells assistive technology.
 */
export function postForm(options: PostFormOptions, body: SafeHtml): SafeHtml {
  if (!options.action.startsWith("/") || href(options.action) !== options.action)
    throw new Error("A form must post to a same-origin path.");
  const className = options.className === undefined ? "form" : `form ${options.className}`;
  return html`<form class="${className}" method="post" action="${options.action}" novalidate>${tokenField(options.token)}${body}</form>`;
}

/** What every single control takes. */
export interface FieldOptions {
  /** Unique on the page: the label's `for`, the error summary's link target. */
  readonly id: string;
  /** The form field's name. */
  readonly name: string;
  /** Visible label text; add context() to tell repeated controls apart. */
  readonly label: Text;
  /** One line of help under the label. */
  readonly hint?: Text | undefined;
  /**
   * Constant wording for this field's problem, never the submitted text; marks it invalid. Markup
   * only as approved wording rendered by mentions.ts (a refused role named by its cached name).
   */
  readonly error?: Text | undefined;
  /**
   * The id of a short line elsewhere on the page that also describes the control, heard after its
   * own hint and error: such as the note above Role menu's Edit roles rows, which says what each
   * state choice does where a closed select has no room to. Never a long note, which would be
   * read out with every control it describes.
   */
  readonly describedBy?: string | undefined;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

/** A field's frame: the label, then its hint and error, then the control. */
function field(options: FieldOptions, control: SafeHtml): SafeHtml {
  return html`<div class="orr-field"><label class="orr-field__label" for="${options.id}">${options.label}</label>${messages(options.id, options.hint, options.error)}${control}</div>`;
}

/** The attributes every control shares, after its id and name. */
function shared(options: FieldOptions): SafeHtml {
  const id = checkedId(options.id);
  return html`${describedByAttribute(describedBy(id, options.hint, options.error, options.describedBy))}${
    options.error === undefined ? "" : html` aria-invalid="true"`
  }${options.required ? html` required` : ""}${options.disabled ? html` disabled` : ""}`;
}

/** textField()'s options. */
export interface TextFieldOptions extends FieldOptions {
  /** The current or submitted value. */
  readonly value?: string | undefined;
  /**
   * The longest value the schema accepts, so typing stops there too. Browsers count UTF-16 code
   * units, so give the schema's limit only where it counts the same way (or allows more). A longer
   * submitted value still comes back whole on a re-render.
   */
  readonly maxLength?: number;
  /** A textarea instead of a one-line input. */
  readonly multiline?: boolean;
}

/** A text input or textarea in its field. Browsers' autofill stays off: these are settings. */
export function textField(options: TextFieldOptions): SafeHtml {
  const value = options.value ?? "";
  const maxLength =
    options.maxLength === undefined ? "" : html` maxlength="${String(options.maxLength)}"`;
  // A textarea drops one newline right after its start tag, so one is written there: a value
  // that itself starts with a newline then keeps it.
  const control = options.multiline
    ? html`<textarea class="orr-input" id="${options.id}" name="${options.name}" rows="3" autocomplete="off"${maxLength}${shared(options)}>
${value}</textarea>`
    : html`<input class="orr-input" type="text" id="${options.id}" name="${options.name}" value="${value}" autocomplete="off"${maxLength}${shared(options)}>`;
  return field(options, control);
}

/** numberField()'s options. */
export interface NumberFieldOptions extends FieldOptions {
  /** The current or submitted value; a submitted one is kept as typed, even when it isn't a number. */
  readonly value?: string | number | undefined;
  readonly min?: number;
  readonly max?: number;
}

/** A whole-number input in its field, with the numeric keyboard on phones. */
export function numberField(options: NumberFieldOptions): SafeHtml {
  const min = options.min === undefined ? "" : html` min="${String(options.min)}"`;
  const max = options.max === undefined ? "" : html` max="${String(options.max)}"`;
  return field(
    options,
    html`<input class="orr-input" type="number" inputmode="numeric" step="1" id="${options.id}" name="${options.name}" value="${String(options.value ?? "")}"${min}${max}${shared(options)}>`,
  );
}

/** One `<option>`. */
export interface SelectOption {
  readonly value: string;
  readonly label: Text;
}

/** selectField()'s options. */
export interface SelectFieldOptions extends FieldOptions {
  readonly options: readonly SelectOption[];
  /** The current or submitted value; an unknown one selects the first option. */
  readonly value?: string | undefined;
}

/** A native `<select>` in its field: the platform's own picker, which phones present best. */
export function selectField(options: SelectFieldOptions): SafeHtml {
  const choices = options.options.map(
    (choice) =>
      html`<option value="${choice.value}"${choice.value === options.value ? html` selected` : ""}>${choice.label}</option>`,
  );
  return field(
    options,
    html`<select class="orr-input" id="${options.id}" name="${options.name}"${shared(options)}>${choices}</select>`,
  );
}

/** One checkbox or radio in a choiceGroup(). */
export interface Choice {
  readonly value: string;
  readonly label: Text;
  /** A line under the label, tied to the input with aria-describedby (not part of its name). */
  readonly hint?: Text | undefined;
  readonly disabled?: boolean;
}

/** choiceGroup()'s options. */
export interface ChoiceGroupOptions {
  /** The fieldset's id (the error summary links here); input ids are `<id>-1`, `<id>-2`, … */
  readonly id: string;
  /** Every input's name; checkboxes submit one value each. */
  readonly name: string;
  readonly type: "checkbox" | "radio";
  /** The group's visible question, as its `<legend>`. */
  readonly legend: Text;
  readonly choices: readonly Choice[];
  /** The values to show checked: the current state, or the submitted one on a re-render. */
  readonly checked?: readonly string[] | undefined;
  readonly hint?: Text | undefined;
  /** Constant wording for the group's problem (markup as for FieldOptions.error). */
  readonly error?: Text | undefined;
  readonly disabled?: boolean;
  /**
   * The first control of an editor that opens on top of the page (Role menu's Add roles): opening
   * it moves focus to the first choice that can take it, with no script. Only inside a closed
   * dialog, where page load skips it (a hidden control can't take focus); never on a re-render,
   * whose error summary takes focus.
   */
  readonly autofocus?: boolean;
}

/**
 * A fieldset of native checkboxes or radios, each a row with its own `<label for>`. The real input
 * stays visible (styles/forms.ts colors it with accent-color), so it keeps the platform's focus
 * ring, forced-colors look and hit area; the row's label widens what a tap can hit. The fieldset
 * takes focus (tabindex="-1", so never in the tab order) when an error summary link to it is
 * followed: its legend, hint and error are announced, and the next Tab reaches its first input.
 */
export function choiceGroup(options: ChoiceGroupOptions): SafeHtml {
  const id = checkedId(options.id);
  const checked = new Set(options.checked ?? []);
  const focused = options.autofocus
    ? options.choices.findIndex((choice) => !(choice.disabled || options.disabled))
    : -1;
  const rows = options.choices.map((choice, index) => {
    const input = `${id}-${index + 1}`;
    const hint = choice.hint === undefined ? "" : `${input}-hint`;
    return html`<div class="orr-check"><input class="orr-check__input" type="${options.type}" id="${input}" name="${options.name}" value="${choice.value}"${
      checked.has(choice.value) ? html` checked` : ""
    }${choice.disabled || options.disabled ? html` disabled` : ""}${describedByAttribute(hint)}${
      index === focused ? html` autofocus` : ""
    }><div class="orr-check__text"><label class="orr-check__label" for="${input}">${choice.label}</label>${
      choice.hint === undefined
        ? ""
        : html`<p class="orr-check__desc" id="${hint}">${choice.hint}</p>`
    }</div></div>`;
  });
  return html`<fieldset class="choice-group" id="${id}" tabindex="-1"${describedByAttribute(describedBy(id, options.hint, options.error))}><legend class="choice-group__legend">${options.legend}</legend>${messages(id, options.hint, options.error)}<div class="choice-group__choices">${rows}</div></fieldset>`;
}

/** One problem in a refused form. */
export interface FieldError {
  /**
   * The control's id, a choice group's fieldset id, or another element with tabindex="-1": the
   * link moves focus there, so it must be something that can take it.
   */
  readonly id: string;
  /**
   * Constant wording, the same as the field's own message or that message with the field's name in
   * front (a category's name, untrusted(), where the message alone says only "here"); never the
   * submitted text. Markup only as approved wording rendered by mentions.ts, so a role or channel
   * shows by its cached name, and that untrusted() name.
   */
  readonly message: Text;
}

/**
 * The error summary for a re-render, first in the page's main content, or first in the overlay
 * that shows the refused form on top of the page (Role menu's editors): "There's a problem" and a
 * link to each control with its message. It takes focus when the page loads (autofocus on a
 * tabindex="-1" element, no script), and role="alert" announces it, so a screen reader hears what
 * went wrong at once. Nothing when there are no errors. A page has at most one.
 */
export function errorSummary(errors: readonly FieldError[]): SafeHtml {
  if (errors.length === 0) return html``;
  const items = errors.map(
    (error) => html`<li><a href="#${checkedId(error.id)}">${error.message}</a></li>`,
  );
  return html`<div class="error-summary" role="alert" tabindex="-1" autofocus aria-labelledby="error-summary-title"><h2 class="error-summary__title" id="error-summary-title">There's a problem</h2><ul class="error-summary__list">${items}</ul></div>`;
}

/**
 * A visually hidden suffix that names what a repeated control acts on (": Pronouns"), so "Move
 * up" or "Description" is unique for assistive technology (WCAG 2.4.6) while the visible label
 * stays short. Its text is untrusted (a role or category name): escaped and isolated.
 */
export function context(text: string): SafeHtml {
  return html`<span class="visually-hidden">: ${untrusted(text)}</span>`;
}

/** A button's look: secondary by default; primary is the page's one holographic button. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** submitButton()'s options. */
export interface ButtonOptions {
  readonly variant?: ButtonVariant;
  /** Sent with the form when this button submits it, for a form with more than one action. */
  readonly name?: string;
  readonly value?: string | undefined;
  readonly disabled?: boolean;
  /**
   * The id of a short line on the page that says what the button does, such as a state button's
   * help: tied with aria-describedby, so it is heard with the button. Never a long note shared by
   * many controls, which would be read out with every one.
   */
  readonly describedBy?: string;
}

/**
 * A submit button with visible text ("Move up", never an arrow alone). A "danger" one belongs
 * inside a disclosure() or a closed overlay whose body says what it does.
 */
export function submitButton(label: Text, options: ButtonOptions = {}): SafeHtml {
  const name =
    options.name === undefined ? "" : html` name="${options.name}" value="${options.value ?? ""}"`;
  const described =
    options.describedBy === undefined
      ? html``
      : describedByAttribute(checkedId(options.describedBy));
  return html`<button type="submit" class="orr-btn orr-btn--${options.variant ?? "secondary"}"${name}${described}${
    options.disabled ? html` disabled` : ""
  }>${label}</button>`;
}

/** A form's buttons, in a row that wraps (and stays in reach at the bottom on phones). */
export function formActions(...buttons: SafeHtml[]): SafeHtml {
  return html`<div class="form-actions">${buttons}</div>`;
}

/**
 * A disclosure that opens without script: an editor ("Edit category") or a confirmation ("Delete
 * category", whose body states the consequence before its danger button). Render it `open` when
 * its form is being re-rendered with errors, or the error summary would link into a closed box.
 */
export function disclosure(
  summary: Text,
  body: SafeHtml,
  options: { open?: boolean } = {},
): SafeHtml {
  return html`<details class="disclosure"${options.open ? html` open` : ""}><summary>${summary}</summary><div class="disclosure__body">${body}</div></details>`;
}

/** The query parameter a post-redirect-get carries its notice token in. */
export const NOTICE_PARAM = "notice";

/** The id of the notice a redirect scrolls to. */
export const NOTICE_ID = "status";

/**
 * Where a successful POST redirects (PostOutcome.redirect): `path` (the page's own) with a notice
 * token and the notice's fragment. The token names a sentence in the page's fixed table. `extra`
 * adds query parameters the page chose, such as the ID of the part of the page the notice belongs
 * in; a page reads them back only to match its own data, never to show them.
 */
export function noticeLocation(
  path: string,
  token: string,
  extra: Readonly<Record<string, string>> = {},
): string {
  const query = [[NOTICE_PARAM, token] as const, ...Object.entries(extra)]
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${path}?${query}#${NOTICE_ID}`;
}

/**
 * The success notice after a post-redirect-get: the sentence `notices` holds for the URL's notice
 * token. A token the table doesn't hold renders nothing, so a crafted link can't put words on the
 * page, and the token itself is never shown. role="status" is polite; the fragment scrolls to it.
 *
 * The URL carries it, so reloading the page, or going back to an earlier redirect, shows it again,
 * scrolled to and focused, though nothing was saved that time. Accepted knowingly: a one-time
 * cookie or session flag would add state for a cosmetic issue, and a timestamp in the token would
 * need signing, or a crafted link could carry it. So every notice is worded in the past tense
 * ("Category saved."), true however often it is shown, never as news ("Saving…", "Just now").
 */
export function notice<T extends string>(url: URL, notices: Readonly<Record<T, string>>): SafeHtml {
  const token = url.searchParams.get(NOTICE_PARAM);
  if (token === null || !Object.hasOwn(notices, token)) return html``;
  return html`<p class="notice notice--success" id="${NOTICE_ID}" role="status" tabindex="-1">${notices[token as T]}</p>`;
}
