/**
 * A form built from every piece of the form view kit (src/web/views/forms.ts), with invented
 * wording and hostile values, for the kit's markup tests (web-forms.test.ts), the stylesheet's
 * "every rendered class has a rule" check (web-assets.test.ts) and the fixture page that drives
 * the POST pipeline (web-server.test.ts). `refused` renders it as a 422 re-render would: the
 * error summary, field errors and the submitted values.
 */
import { html, type SafeHtml } from "../../src/web/html.js";
import {
  choiceGroup,
  context,
  disclosure,
  errorSummary,
  type FieldError,
  formActions,
  hidden,
  numberField,
  postForm,
  selectField,
  submitButton,
  textField,
} from "../../src/web/views/forms.js";

/** Text a hostile officer or member could type: it must come back escaped, never as markup. */
export const HOSTILE_INPUT = '"><img src=x onerror=alert(1)>';

/** The values a refused form was submitted with. */
export interface KitValues {
  readonly name: string;
  readonly description: string;
  readonly position: string;
  readonly max: string;
  readonly roles: readonly string[];
  readonly state: string;
}

export const KIT_DEFAULTS: KitValues = {
  name: "Pronouns",
  description: "Pick the ones you use.",
  position: "1",
  max: "",
  roles: ["300000000000000002"],
  state: "offered",
};

/** A kit form's problem: plain wording, as the fixture's fields take it. */
export type KitError = FieldError & { readonly message: string };

/** The problems a refused kit form shows, in page order. */
export const KIT_ERRORS: readonly KitError[] = [
  { id: "kit-name", message: "Enter a name of at most 40 characters." },
  { id: "kit-roles", message: "Choose at most 2 roles." },
];

/** The kit form for `action`, as first shown (`errors` empty) or re-rendered with problems. */
export function kitForm(
  action: string,
  token: string,
  values: KitValues = KIT_DEFAULTS,
  errors: readonly KitError[] = [],
): SafeHtml {
  const error = (id: string): string | undefined =>
    errors.find((problem) => problem.id === id)?.message;
  // A re-render passes each field's message straight through; undefined means no problem.
  return html`${errorSummary(errors)}
${postForm(
  { action, token },
  html`${hidden("op", "category.edit")}${hidden("revision", "7")}
${textField({
  id: "kit-name",
  name: "name",
  label: "Name",
  hint: "Members see this above the roles.",
  value: values.name,
  maxLength: 40,
  required: true,
  error: error("kit-name"),
})}
${textField({
  id: "kit-description",
  name: "description",
  label: html`Description${context("Pronouns")}`,
  value: values.description,
  multiline: true,
  maxLength: 200,
})}
${numberField({ id: "kit-position", name: "position", label: "Position", value: values.position, min: 1, max: 10 })}
${selectField({
  id: "kit-max",
  name: "max",
  label: "How many can someone pick?",
  value: values.max,
  options: [
    { value: "", label: "Any number" },
    { value: "1", label: "One" },
    { value: "2", label: "Up to 2" },
  ],
})}
${choiceGroup({
  id: "kit-roles",
  name: "roles",
  type: "checkbox",
  legend: "Roles to add",
  hint: "Roles in Discord's order.",
  checked: values.roles,
  choices: [
    { value: "300000000000000001", label: "He/Him", hint: "Opens: nothing" },
    { value: "300000000000000002", label: "She/Her" },
    { value: "300000000000000003", label: "They/Them", disabled: true },
  ],
  error: error("kit-roles"),
})}
${choiceGroup({
  id: "kit-state",
  name: "state",
  type: "radio",
  legend: html`State${context("Pronouns")}`,
  checked: [values.state],
  choices: [
    { value: "offered", label: "Offered" },
    { value: "removal_only", label: "Not offered", hint: "People who have it can remove it." },
  ],
})}
${formActions(submitButton("Save"), submitButton("Publish", { variant: "primary", name: "after", value: "publish" }))}`,
)}
${disclosure(
  html`Delete category${context("Pronouns")}`,
  postForm(
    { action, token },
    html`<p>People keep these roles in Discord, but won't be able to add or remove them themselves.</p>${hidden("op", "category.delete")}${formActions(submitButton(html`Delete category${context("Pronouns")}`, { variant: "danger" }))}`,
  ),
)}`;
}
