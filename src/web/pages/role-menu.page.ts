/**
 * Role menu (2.39.0): this server's officers build the self-service role menu, the dashboard's
 * first writing page. Every form posts here with `op`, its IDs, the menu `revision` it was
 * rendered at and the form token; server.ts has already checked the origin, the token, the
 * shutdown flag, this page's budget and a fresh officer actor before post() runs.
 *
 * post() only parses: SelfRoles.edit authorizes the actor again and applies the edit in one
 * transaction with its audit row (application/self-roles.ts), and decides what an edit means:
 * - saved, or unchanged (the equal-state rule: a double submit, or a change another officer
 *   already made): 303 back here with the operation's notice, so a repeat lands on the same page.
 *   The redirect names the category an edit changed, and the notice shows in its card, so an
 *   officer working down a long page on a phone lands where they were;
 * - conflict: 409, the menu as it is now with what the officer changed kept in the form used, and
 *   the approved sentence (a stale form, or a saved menu this build can't read). Only the fields
 *   whose value differs from what the form showed (its `was:` companions) are kept; the others
 *   show the current menu, so a resubmit at the current revision can't quietly put back another
 *   officer's change in a field this officer never touched;
 * - invalid: 422, the same re-render with every typed value and each refused field marked.
 * A form whose hidden fields this page never renders (an unknown op, a malformed ID or revision)
 * is refused whole, as out of date, before anything is read. Any officer may make every change,
 * with no check of their own Discord permissions (owner decision, 2026-10-09); what may be added
 * is the domain rule set's call alone.
 */
import { z } from "zod";
import { gatewayKey, selfRolesKey } from "../../application/keys.js";
import type { SelfRoleEditor, SelfRoleEditRequest } from "../../application/self-roles.js";
import {
  CATEGORY_STATES,
  cleanText,
  LIMIT_MESSAGES,
  MENU_LIMITS,
  type MenuOperation,
  type OptionRow,
  SELF_ROLE_MESSAGES,
} from "../../domain/self-roles.js";
import { Failure } from "../../domain/values.js";
import { guildNames } from "../mentions.js";
import { definePage, type PageContext } from "../page.js";
import { noticeLocation } from "../views/forms.js";
import {
  ANY_NUMBER,
  NOTICE_CATEGORY,
  noticeCategory,
  noticeFor,
  OPTION_STATES,
  type RefusedEdit,
  type RoleMenuForm,
  renderRoleMenu,
  type ShownValues,
  type SubmittedRow,
  type SubmittedValues,
  WAS,
} from "../views/role-menu.js";

/**
 * The officers' budget: preparing a menu is mostly one Edit roles form per category, and each POST
 * costs three Discord requests for the fresh actor (two more for an add), so 120 in ten minutes
 * covers a long session at a bounded cost.
 */
const ROLE_MENU_POSTS = 120;

/** A revision as rendered: a positive bigint in decimal, no sign or leading zero. */
const REVISION = /^[1-9][0-9]{0,18}$/u;
/** A whole number as a person types one into a small field. */
const WHOLE = /^[0-9]{1,4}$/u;
const uuid = z.uuid();
const categoryState = z.enum(CATEGORY_STATES);
const optionState = z.enum(OPTION_STATES);

/** A form whose hidden fields this page never rendered: refused whole (400), nothing read. */
const outOfDate = (): Failure => new Failure("input", LIMIT_MESSAGES.form);

/** One text field's value; a missing field or a file is "". */
function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value a repeated field carries. */
const texts = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((value): value is string => typeof value === "string");

/** A hidden ID the page rendered, or the whole form is out of date. */
function categoryOf(form: FormData): string {
  const id = text(form, "category");
  if (!uuid.safeParse(id).success) throw outOfDate();
  return id;
}

/**
 * A "How many can someone pick?" choice: null for any number, else the number, or NaN for
 * something the select never offered, which the domain refuses with the field's own message.
 */
const maxOf = (value: string): number | null =>
  value === ANY_NUMBER ? null : WHOLE.test(value) ? Number(value) : Number.NaN;

/** A typed position, or NaN (the domain asks for a whole number of 1 or more). */
const positionOf = (value: string): number =>
  WHOLE.test(value.trim()) ? Number(value.trim()) : Number.NaN;

/** The fields a form's `was:` companions cover (views/role-menu.ts's WAS). */
type Shown = keyof ShownValues;

/**
 * What the form showed in each of `fields` (`was:<field><suffix>`), leaving out any it didn't send.
 */
function shownValues(form: FormData, fields: readonly Shown[], suffix = ""): ShownValues {
  const shown: { [K in Shown]?: string } = {};
  for (const field of fields) {
    const value = form.get(`${WAS}${field}${suffix}`);
    if (typeof value === "string") shown[field] = value;
  }
  return shown;
}

/** Two texts the domain stores alike: it keeps every text trimmed and in NFC. */
const sameText = (left: string, right: string): boolean => cleanText(left) === cleanText(right);

/**
 * The typed values a 409 shows again: each that differs from what the form showed (`was`),
 * compared as stored (texts through sameText). A field the form sent no companion for counts as
 * changed, so typed text is never dropped.
 */
function changedValues(typed: { readonly [K in Shown]?: string }, was: ShownValues): ShownValues {
  const changed: { [K in Shown]?: string } = {};
  for (const field of ["name", "description", "max", "state"] as const) {
    const value = typed[field];
    if (value === undefined) continue;
    const before = was[field];
    const same =
      before !== undefined &&
      (field === "name" || field === "description" ? sameText(value, before) : value === before);
    if (!same) changed[field] = value;
  }
  return changed;
}

/** A POST, read: the edit to make, and what to show again if it is refused. */
interface ParsedEdit {
  readonly request: SelfRoleEditRequest;
  readonly form: RoleMenuForm;
  /** Everything typed, with what the form showed: a 422 shows it all again. */
  readonly values: SubmittedValues;
  /** Only what the officer changed from what the form showed: a 409 shows it again. */
  readonly changed: SubmittedValues;
}

/** Read one of this page's forms into an edit. Typed text is passed on as typed. */
function parseEdit(form: FormData): ParsedEdit {
  const revisionText = text(form, "revision");
  if (!REVISION.test(revisionText)) throw outOfDate();
  const revision = BigInt(revisionText);
  const edit = (
    operation: MenuOperation,
    target: RoleMenuForm,
    values: SubmittedValues = {},
    changed: SubmittedValues = values,
  ): ParsedEdit => ({ request: { revision, operation }, form: target, values, changed });
  const op = text(form, "op");
  switch (op) {
    case "category.create": {
      const categoryId = text(form, "id");
      if (!uuid.safeParse(categoryId).success) throw outOfDate();
      const values = {
        name: text(form, "name"),
        description: text(form, "description"),
        max: text(form, "max"),
      };
      return edit(
        {
          op,
          categoryId,
          name: values.name,
          description: values.description,
          max: maxOf(values.max),
        },
        { kind: "create" },
        { ...values, categoryId },
      );
    }
    case "category.edit": {
      const categoryId = categoryOf(form);
      const values = {
        name: text(form, "name"),
        description: text(form, "description"),
        max: text(form, "max"),
      };
      const was = shownValues(form, ["name", "description", "max"]);
      return edit(
        {
          op,
          categoryId,
          name: values.name,
          description: values.description,
          max: maxOf(values.max),
        },
        { kind: "category", categoryId },
        { ...values, was },
        changedValues(values, was),
      );
    }
    case "category.move": {
      const categoryId = categoryOf(form);
      const to = text(form, "to");
      if (!WHOLE.test(to)) throw outOfDate();
      return edit({ op, categoryId, to: Number(to) }, { kind: "action", categoryId });
    }
    case "category.setState": {
      const categoryId = categoryOf(form);
      const state = categoryState.safeParse(text(form, "state"));
      if (!state.success) throw outOfDate();
      return edit({ op, categoryId, state: state.data }, { kind: "action", categoryId });
    }
    case "category.delete": {
      const categoryId = categoryOf(form);
      return edit({ op, categoryId }, { kind: "action", categoryId });
    }
    case "menu.publishAll":
    case "menu.reset":
      return edit({ op }, { kind: "menu" });
    case "options.add": {
      const categoryId = categoryOf(form);
      const roleIds = texts(form, "roles");
      const acknowledged = text(form, "acknowledged") === "yes";
      return edit(
        { op, categoryId, roleIds, unreadableAcknowledged: acknowledged },
        { kind: "add", categoryId },
        { roleIds, acknowledged },
      );
    }
    case "options.edit": {
      const categoryId = categoryOf(form);
      // One row per option the form rendered, named by its role; a category holds at most
      // MENU_LIMITS.optionsPerCategory, so more is a form this page never made.
      const roleIds = texts(form, "role");
      if (roleIds.length > MENU_LIMITS.optionsPerCategory) throw outOfDate();
      const rows: OptionRow[] = [];
      const kept = new Map<string, SubmittedRow>();
      const changed = new Map<string, SubmittedRow>();
      for (const [at, roleId] of roleIds.entries()) {
        const typed = {
          description: text(form, `description:${roleId}`),
          position: text(form, `position:${roleId}`),
          state: text(form, `state:${roleId}`),
        };
        const state = optionState.safeParse(typed.state);
        if (!state.success) throw outOfDate();
        // In the form's order, which is the order it rendered the rows in (OptionRow).
        rows.push({
          roleId,
          description: typed.description,
          position: positionOf(typed.position),
          state: state.data,
        });
        const was = shownValues(form, ["description", "state"], `:${roleId}`);
        kept.set(roleId, { ...typed, was });
        // The position the form showed is the row's place in it, so it needs no companion.
        changed.set(roleId, {
          ...changedValues({ description: typed.description, state: typed.state }, was),
          ...(positionOf(typed.position) !== at + 1 && { position: typed.position }),
        });
      }
      return edit(
        { op, categoryId, rows },
        { kind: "options", categoryId },
        { rows: kept },
        { rows: changed },
      );
    }
    default:
      throw outOfDate();
  }
}

/** The page's main content over `editor`, with a refused form when re-rendering one. */
function render(context: PageContext, editor: SelfRoleEditor, refused?: RefusedEdit) {
  return renderRoleMenu({
    editor,
    names: guildNames(context.services.get(gatewayKey), context.guildId),
    action: context.url.pathname,
    token: context.formToken,
    url: context.url,
    // Add a category's ID, minted per render: a repeated submit of one form names the same ID.
    newCategoryId: crypto.randomUUID(),
    ...(refused && { refused }),
  });
}

export default definePage({
  path: "/g/:guild/role-menu",
  title: "Role menu",
  access: ["officer"],
  requires: [selfRolesKey, gatewayKey],
  nav: "Role menu",
  icon: "list",
  async get(context) {
    // editor() authorizes the actor again, as REQUIREMENTS.md asks ("reauthorize the current
    // actor"), and reads the database and the gateway cache only: no Discord request.
    return render(context, await context.services.get(selfRolesKey).editor(context.actor));
  },
  async post(context, form) {
    const parsed = parseEdit(form);
    const roles = context.services.get(selfRolesKey);
    const outcome = await roles.edit(context.actor, parsed.request);
    if (outcome.status === "saved" || outcome.status === "unchanged") {
      // The category's ID passed parseEdit as a UUID; the page shows the notice in its card.
      const { operation } = parsed.request;
      const category = noticeCategory(operation);
      return {
        redirect: noticeLocation(
          context.url.pathname,
          noticeFor(operation),
          category === undefined ? {} : { [NOTICE_CATEGORY]: category },
        ),
      };
    }
    // Refused: the menu as it is now, with the refused form's typed values kept.
    const editor = await roles.editor(context.actor);
    if (outcome.status === "conflict")
      return {
        invalid: render(context, editor, {
          form: parsed.form,
          // Only what this officer changed: the rest shows the menu as it is now.
          values: parsed.changed,
          // The officer has now seen the current menu, so a resubmit may deliberately replace it.
          revision: editor.revision,
          errors: [{ field: "form", message: SELF_ROLE_MESSAGES[outcome.reason] }],
        }),
        status: 409,
      };
    return {
      invalid: render(context, editor, {
        form: parsed.form,
        values: parsed.values,
        // Still the submitted revision: a corrected resubmit of a stale form meets the lock.
        revision: parsed.request.revision,
        errors: outcome.errors,
      }),
      status: 422,
    };
  },
  postLimit: ROLE_MENU_POSTS,
});
