/**
 * Mod mail (2.43.0, issue #60): the officers' inbox and on/off card, or a member's or guest's own
 * cases with Open a case. One path for both audiences, so a link someone shares lands each viewer
 * on their own view: officers (actor.officer) get the inbox, everyone else the page admits gets
 * their cases.
 *
 * Two forms post here, each with `op` and the form token. server.ts has already checked the
 * origin, the token, the shutdown flag, this page's budget and a fresh (full) actor this page
 * admits before post() runs: Member or Guest now with no Administrator for TaruBot (A2), or an
 * officer. post() only parses; ModMail authorizes again and writes in one transaction.
 * - The officers' switch (`op=settings`, the state asked for and the revision it was drawn at):
 *   ModMail.toggle saves it with its audit row. Saved or unchanged is 303 back here with the
 *   notice; a stale revision is 409, the page as it is now; a prerequisite missing for turning it
 *   on is 422, the same.
 * - Open a case (`op=open`, members and guests only: the officers' view has no such form, and
 *   they keep /modmail): the topic, the message and a case ID minted with the page. ModMail.open
 *   is the same path /modmail's form takes, so the gates and limits can't drift: Member or Guest
 *   now, A2, mod mail on, a valid key, 3 open cases and 5 a day, and the text's lengths. A Discord
 *   time-out is no bar: Discord takes Use Application Commands away during one, so this form is
 *   how a member in a time-out reaches the officers (to appeal, say), and the case's replies are
 *   on the dashboard too. Opened, or the same form sent again with the same text, is 303 to the
 *   case; refused text is 422; a refusal the page didn't foresee (the switch turned off, a limit
 *   reached from /modmail meanwhile), a minted ID naming someone else's case, and the same form
 *   sent again with other text (it already opened a case, which the error links) are 409. Each
 *   re-renders the form drawn open with what was typed (PostOutcome.modal).
 * Any other form is refused whole as out of date, before anything is read.
 *
 * It declares only modmailKey (docs/MODULES.md, "Add a page"): every member and guest reaches this
 * code, so it can reach no other service; names come with ModMail's views. The navigation lists
 * it to officers always, and to members and guests only while mod mail is on, though their cases
 * stay open to them here either way.
 */
import { z } from "zod";
import { modmailKey } from "../../application/keys.js";
import { INBOX_FILTERS, type InboxFilter } from "../../domain/modmail.js";
import { can } from "../../domain/policy.js";
import { Failure } from "../../domain/values.js";
import { definePage, type PageContext, type PostOutcome } from "../page.js";
import { noticeLocation } from "../views/forms.js";
import {
  BODY_FIELD,
  CASE_ID_FIELD,
  type CaseNotice,
  casePath,
  drawsOpenForm,
  ENABLED_FIELD,
  FILTER_PARAM,
  type InboxNotice,
  MODMAIL_BODY_LIMIT,
  MODMAIL_PATH,
  type MyCasesView,
  OP_FIELD,
  type OpenRefused,
  REVISION_FIELD,
  renderInbox,
  renderMyCases,
  type SettingsRefusal,
  TOPIC_FIELD,
} from "../views/modmail.js";

/**
 * The page's budget per person and server: officers rarely flip the switch, and a member opens at
 * most five cases a day, but a refused form is sent again after a fix. Each POST costs three
 * Discord requests for the fresh actor, so twenty in ten minutes is plenty and cheap.
 */
const MODMAIL_POSTS = 20;

/** A revision as rendered: a positive bigint in decimal. */
const REVISION = /^[1-9][0-9]{0,18}$/u;
const uuid = z.uuid();

/** A form whose hidden fields this page never rendered: refused whole (400), nothing read. */
const outOfDate = (): Failure =>
  new Failure("input", "This form is out of date. Open the page again, then redo your change.");

/** One text field's value; a missing field or a file is "". */
function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The inbox filter the URL asks for, compared with the known filters only; "open" otherwise. */
function filterOf(url: URL): InboxFilter {
  const asked = url.searchParams.get(FILTER_PARAM);
  return (INBOX_FILTERS as readonly string[]).includes(asked ?? "")
    ? (asked as InboxFilter)
    : "open";
}

/**
 * A member's view, with a refused Open a case form when re-rendering one. `caseId` is the form's
 * minted ID, kept across a refusal so a corrected resend is still one form; a fresh one otherwise.
 */
async function memberView(
  context: PageContext,
  refused?: OpenRefused,
  caseId: string = crypto.randomUUID(),
): Promise<MyCasesView> {
  // mine() authorizes the actor again and reads the database only.
  return {
    cases: await context.services.get(modmailKey).mine(context.actor),
    guildId: context.guildId,
    action: context.url.pathname,
    token: context.formToken,
    caseId,
    ...(refused && { refused }),
  };
}

/** A refused Open a case form's re-render at `status`, drawn open over the page. */
async function openRefusal(
  context: PageContext,
  refused: OpenRefused,
  status: 409 | 422,
  caseId?: string,
): Promise<PostOutcome> {
  const view = await memberView(context, refused, caseId);
  return { invalid: renderMyCases(view), status, modal: drawsOpenForm(view) };
}

/** Open a case from the member's form (op=open); see the module comment for each outcome. */
async function openCase(context: PageContext, form: FormData): Promise<PostOutcome> {
  // Lowercase, as PostgreSQL stores it: the case's AAD names the ID as stored.
  const caseId = text(form, CASE_ID_FIELD).toLowerCase();
  if (!uuid.safeParse(caseId).success) throw outOfDate();
  const topic = text(form, TOPIC_FIELD);
  const body = text(form, BODY_FIELD);
  const outcome = await context.services
    .get(modmailKey)
    .open(context.actor, { topic, body, caseId });
  switch (outcome.status) {
    case "opened":
      // The redirect target is built from the checked IDs, never from the request's text.
      return {
        redirect: noticeLocation(
          casePath(context.guildId, outcome.number),
          "opened" satisfies CaseNotice,
        ),
      };
    case "invalid":
      return openRefusal(
        context,
        { problem: { kind: "invalid", field: outcome.field, error: outcome.error }, topic, body },
        422,
        caseId,
      );
    case "refused":
      return openRefusal(
        context,
        { problem: { kind: "refused", reason: outcome.reason }, topic, body },
        409,
        caseId,
      );
    case "conflict":
      // The ID is someone else's case: a fresh one, so the resend is a new form.
      return openRefusal(context, { problem: { kind: "conflict" }, topic, body }, 409);
    case "already_opened":
      // This form already opened a case with other text: what was typed now comes back, with a
      // link to that case, and a fresh ID, so sending it again opens a new case.
      return openRefusal(
        context,
        { problem: { kind: "already", number: outcome.number }, topic, body },
        409,
      );
  }
}

/** The page's main content for `context`, with a refused switch when re-rendering one. */
async function render(context: PageContext, refused?: SettingsRefusal) {
  const modmail = context.services.get(modmailKey);
  // Both authorize the actor again and read the database and the gateway caches only.
  if (!can(context.actor, "modmail.inbox")) return renderMyCases(await memberView(context));
  return renderInbox({
    inbox: await modmail.inbox(context.actor, filterOf(context.url)),
    guildId: context.guildId,
    action: context.url.pathname,
    token: context.formToken,
    url: context.url,
    now: new Date(),
    ...(refused && { refused }),
  });
}

export default definePage({
  path: MODMAIL_PATH,
  title: "Mod mail",
  access: ["modmail.inbox", "modmail.open"],
  requires: [modmailKey],
  // Private text: someone removed or demoted loses the page on their next request (no memo).
  freshActor: true,
  nav: "Mod mail",
  icon: "mail",
  navWhen: (actor, services) =>
    can(actor, "modmail.inbox") || services.get(modmailKey).enabledIn(actor.guildId),
  get: (context) => render(context),
  async post(context, form) {
    const op = text(form, OP_FIELD);
    // Open a case is the member's view's form; the officers' view never draws it.
    if (op === "open" && !can(context.actor, "modmail.inbox")) return openCase(context, form);
    if (op !== "settings") throw outOfDate();
    const asked = text(form, ENABLED_FIELD);
    const revision = text(form, REVISION_FIELD);
    if ((asked !== "on" && asked !== "off") || !REVISION.test(revision)) throw outOfDate();
    const outcome = await context.services
      .get(modmailKey)
      .toggle(context.actor, { enabled: asked === "on", revision: BigInt(revision) });
    const path = context.url.pathname;
    switch (outcome.status) {
      case "saved":
        return {
          redirect: noticeLocation(
            path,
            (asked === "on" ? "enabled" : "disabled") satisfies InboxNotice,
          ),
        };
      case "unchanged":
        return { redirect: noticeLocation(path, "unchanged" satisfies InboxNotice) };
      case "conflict":
        return { invalid: await render(context, "conflict"), status: 409 };
      case "invalid":
        return { invalid: await render(context, "missing"), status: 422 };
    }
  },
  postLimit: MODMAIL_POSTS,
  // Text the forms' maxlength allows always reaches post(), for a 422 that keeps it.
  bodyLimit: MODMAIL_BODY_LIMIT,
});
