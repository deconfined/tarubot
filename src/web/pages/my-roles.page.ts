/**
 * My roles (2.40.0): members, guests and officers pick their own roles from the officers' menu
 * (owner decisions Q6 A and Q3 B). The form posts here with each category it let the person change
 * (`shown`), what that category showed ticked (`seen:<id>`) and what came back (`c-<id>`), plus the
 * form token; server.ts has already checked the origin, the token, the shutdown flag, this page's
 * budget and a fresh, full actor the page admits before post() runs.
 *
 * post() only parses: SelfRoles.choose authorizes the actor again (self-service access, and no
 * Discord time-out), finds what changed, and queues the change in one transaction; nothing here
 * writes to Discord, which only the roles.self job does, under the writer lease.
 * - saved: 303 to the page's status banner, which says what became of the change (from its job),
 *   so a double submit lands on the same answer;
 * - unchanged: 303 with the "unchanged" notice;
 * - conflict: 409, the page as it is now with the approved sentence;
 * - invalid: 422, the page with what was picked kept and each refused category marked.
 * A form whose hidden fields this page never renders (a category that isn't a UUID, a value that
 * isn't a role ID or "", more of them than a menu can hold) is refused whole, as out of date,
 * before anything is read.
 *
 * It declares only selfRolesKey (docs/MODULES.md, "Add a page"): every member and guest reaches
 * this code, so it can reach no other service; the role names it shows come with the view.
 */
import { z } from "zod";
import { selfRolesKey } from "../../application/keys.js";
import type { RoleChoiceRequest } from "../../application/self-roles.js";
import { type CategoryChoice, LIMIT_MESSAGES, MENU_LIMITS } from "../../domain/self-roles.js";
import { Failure, idSchema } from "../../domain/values.js";
import { definePage, type PageContext } from "../page.js";
import { NOTICE_ID, noticeLocation } from "../views/forms.js";
import {
  choiceField,
  MY_ROLES_PATH,
  type MyRolesNotice,
  NONE,
  type RefusedChoice,
  renderMyRoles,
  SHOWN_FIELD,
  seenField,
} from "../views/my-roles.js";

/**
 * A member's budget: each POST costs three Discord requests for the fresh actor, and a save queues
 * one job, so ten in ten minutes covers changing one's mind a few times at a small, bounded cost.
 */
const MY_ROLES_POSTS = 10;

const uuid = z.uuid();

/** A form whose hidden fields this page never rendered: refused whole (400), nothing read. */
const outOfDate = (): Failure => new Failure("input", LIMIT_MESSAGES.form);

/** Every text value a repeated field carries; a file is never one this page asked for. */
const texts = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((value): value is string => typeof value === "string");

/**
 * A category's values as the form rendered them: role IDs, and NONE for "No role from this
 * category", at most one per option plus NONE. Anything else is a form this page never made.
 */
function values(form: FormData, name: string): string[] {
  const all = texts(form, name);
  if (all.length > MENU_LIMITS.optionsPerCategory + 1) throw outOfDate();
  for (const value of all)
    if (value !== NONE && !idSchema.safeParse(value).success) throw outOfDate();
  return all;
}

/** Read the form into a save: one entry per category it showed, in the form's order. */
function parseChoices(form: FormData): RoleChoiceRequest {
  const shown = texts(form, SHOWN_FIELD);
  if (shown.length > MENU_LIMITS.categories) throw outOfDate();
  const categories: CategoryChoice[] = shown.map((categoryId) => {
    if (!uuid.safeParse(categoryId).success) throw outOfDate();
    return {
      categoryId,
      seen: values(form, seenField(categoryId)),
      picked: values(form, choiceField(categoryId)),
    };
  });
  return { categories };
}

/** The page's main content for `context`, with a refused save when re-rendering one. */
async function render(context: PageContext, refused?: RefusedChoice) {
  // view() authorizes the actor again, and reads the database and the gateway's caches only: no
  // Discord request.
  const roles = await context.services.get(selfRolesKey).view(context.actor);
  return renderMyRoles({
    roles,
    officer: context.actor.officer,
    action: context.url.pathname,
    token: context.formToken,
    url: context.url,
    ...(refused && { refused }),
  });
}

export default definePage({
  path: MY_ROLES_PATH,
  title: "My roles",
  access: ["member", "guest", "officer"],
  requires: [selfRolesKey],
  nav: "My roles",
  icon: "user",
  get: (context) => render(context),
  async post(context, form) {
    const request = parseChoices(form);
    const outcome = await context.services.get(selfRolesKey).choose(context.actor, request);
    const path = context.url.pathname;
    switch (outcome.status) {
      case "saved":
        // The banner says what became of it, from the job, so the redirect needs no notice.
        return { redirect: `${path}#${NOTICE_ID}` };
      case "unchanged":
        return { redirect: noticeLocation(path, "unchanged" satisfies MyRolesNotice) };
      case "conflict":
        return { invalid: await render(context, { kind: "conflict" }), status: 409 };
      case "invalid":
        return {
          invalid: await render(context, {
            kind: "invalid",
            errors: outcome.errors,
            submitted: request.categories,
          }),
          status: 422,
        };
    }
  },
  postLimit: MY_ROLES_POSTS,
});
