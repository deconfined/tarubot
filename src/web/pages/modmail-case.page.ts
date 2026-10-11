/**
 * A mod mail case (2.43.0, issue #60): the thread, the reply form, Close, and for officers Reopen
 * and the read log. Its opener and the server's officers may see it; for anyone else, and for a
 * number that doesn't exist, the page answers the same plain 404 as an unknown address (never a
 * 403), so case numbers reveal nothing. Every view is recorded in the case's read log.
 *
 * Its forms post here with `op` and the form token; server.ts has already checked the origin, the
 * token, the shutdown flag, this page's budget and a fresh actor this page admits before post()
 * runs. post() only parses; ModMail authorizes the actor again and writes in one transaction:
 * - reply (`id`, minted with the page, `body`, and an officer's `signed`): saved or unchanged (the
 *   same form twice, with the same text) is 303 to the new message's fragment; refused text or a
 *   full case is 422 with what was typed kept; a minted ID that names another message, or the same
 *   form sent again with other text, is 409, also with what was typed kept;
 * - close and reopen (`revision`): saved or unchanged is 303 with the notice; a stale revision is
 *   409, the case as it is now.
 * Any other form is refused whole as out of date, before anything is read. Nothing here writes to
 * Discord: pings and DMs are jobs.
 *
 * It declares only modmailKey, like every member-facing page.
 */
import { z } from "zod";
import { modmailKey } from "../../application/keys.js";
import type { Signing } from "../../domain/modmail.js";
import { Failure } from "../../domain/values.js";
import { pageNotFound } from "../http.js";
import { definePage, type PageContext } from "../page.js";
import { noticeLocation } from "../views/forms.js";
import {
  BODY_FIELD,
  type CaseNotice,
  type CaseRefusal,
  casePath,
  MESSAGE_ID_FIELD,
  MODMAIL_BODY_LIMIT,
  MODMAIL_CASE_PATH,
  messageAnchor,
  OP_FIELD,
  REVISION_FIELD,
  renderCase,
  SIGNING_FIELD,
} from "../views/modmail.js";

/**
 * A conversation's budget, per person and server across every case: each POST costs three Discord
 * requests for the fresh actor, and forty in ten minutes covers an officer answering a busy inbox
 * while bounding what anyone can spend.
 */
const CASE_POSTS = 40;

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

/** The page's number; server.ts set it from the path, so it is always there on this page. */
function numberOf(context: PageContext): bigint {
  if (context.number === null) throw new Error("A case page needs its number.");
  return context.number;
}

/** The case's main content, with a refused form when re-rendering one; 404 when it isn't theirs. */
async function render(context: PageContext, refused?: CaseRefusal) {
  // caseView() authorizes the actor again, records the read, and returns null for a case that
  // doesn't exist or isn't the actor's to see: both are the same 404.
  const view = await context.services.get(modmailKey).caseView(context.actor, numberOf(context));
  if (!view) return pageNotFound();
  return renderCase({
    view,
    action: context.url.pathname,
    token: context.formToken,
    url: context.url,
    // Minted per render, so a double submit of one form finds the message it made.
    messageId: crypto.randomUUID(),
    ...(refused && { refused }),
  });
}

export default definePage({
  path: MODMAIL_CASE_PATH,
  title: "Mod mail case",
  access: ["member", "guest", "officer"],
  requires: [modmailKey],
  // Private text: someone removed or demoted loses the page on their next request (no memo).
  freshActor: true,
  get: (context) => render(context),
  async post(context, form) {
    const modmail = context.services.get(modmailKey);
    const number = numberOf(context);
    // The redirect target is built from the checked IDs, never from the request's text.
    const path = casePath(context.guildId, number);
    const op = text(form, OP_FIELD);
    if (op === "reply") {
      // Lowercase, as PostgreSQL stores it: the message's AAD is built from the stored spelling
      // (an uppercase ID would be sealed under an AAD the row never matches again).
      const messageId = text(form, MESSAGE_ID_FIELD).toLowerCase();
      if (!uuid.safeParse(messageId).success) throw outOfDate();
      const signed = text(form, SIGNING_FIELD);
      // Only officers get the radios; a member's form sends none, and anything else is refused.
      if (signed !== "" && signed !== "name" && signed !== "officers") throw outOfDate();
      const body = text(form, BODY_FIELD);
      const outcome = await modmail.reply(context.actor, number, {
        messageId,
        body,
        signing: signed === "" ? null : (signed as Signing),
      });
      if (!outcome) return pageNotFound();
      switch (outcome.status) {
        case "saved":
        case "unchanged":
          return { redirect: `${path}#${messageAnchor(outcome.messageId)}` };
        case "invalid":
          return {
            invalid: await render(context, {
              kind: "reply",
              reason: outcome.reason,
              body,
              signing: signed,
            }),
            status: 422,
          };
        case "conflict":
        case "resent":
          // A form this page didn't make, or this form sent again with other text: what was typed
          // comes back with a freshly minted ID, so sending it again adds a new reply.
          return {
            invalid: await render(context, {
              kind: "reply",
              reason: outcome.status,
              body,
              signing: signed,
            }),
            status: 409,
          };
      }
    }
    if (op !== "close" && op !== "reopen") throw outOfDate();
    const revision = text(form, REVISION_FIELD);
    if (!REVISION.test(revision)) throw outOfDate();
    const outcome =
      op === "close"
        ? await modmail.close(context.actor, number, BigInt(revision))
        : await modmail.reopen(context.actor, number, BigInt(revision));
    if (!outcome) return pageNotFound();
    switch (outcome.status) {
      case "saved":
        return {
          redirect: noticeLocation(
            path,
            (op === "close" ? "closed" : "reopened") satisfies CaseNotice,
          ),
        };
      case "unchanged":
        return { redirect: noticeLocation(path, "unchanged" satisfies CaseNotice) };
      case "conflict":
        return { invalid: await render(context, { kind: "state" }), status: 409 };
    }
  },
  postLimit: CASE_POSTS,
  // Text the forms' maxlength allows always reaches post(), for a 422 that keeps it.
  bodyLimit: MODMAIL_BODY_LIMIT,
});
