/**
 * Moderation (2.45.0, owner decision 3): officers who can see pauses list them, find a person by
 * ID or mention or the sender of a suggestion by its number, and those who hold moderation.block
 * pause people's use of a feature and lift pauses. A pause is deny-only and touches no Discord
 * role; src/application/moderation.ts holds every rule, and this module only reads forms and
 * shows what it answers.
 *
 * The page needs a sign-in from the last few minutes for a change (recentSignIn): server.ts
 * answers an older session's POST with a 303 to /login, back to this page, before post() runs, and
 * the GET says so in place of its change controls (PageContext.recentSignIn). Looking people up
 * needs no such sign-in: the finder is a GET (`?find=`), read by this page's GET alone. Both the
 * lookups and the changes are fresh: freshActor, so someone who loses moderation.view loses the
 * page on their next request.
 *
 * Two forms post here, each with `op`, and the form token; server.ts has already checked the
 * origin, the token, the shutdown flag, the sign-in's age, this page's budget and a fresh (full)
 * actor this page admits before post() runs.
 * - `op=block`: the member (an ID or a mention), the features ticked (`feature`, repeated), the
 *   length (one of PAUSE_DURATIONS) and the reason the person is shown. Moderation.block authorizes
 *   again and writes in one transaction with its audit row.
 * - `op=lift`: the member and the one feature of a chip, and a reason kept in the history.
 *   Moderation.lift does the same.
 * Done, or nothing to do (a pause that had ended meanwhile): 303 back here with the operation's
 * notice and the person as the finder's query, so the result card shows them. The service's own
 * refusals about the input or the person (a missing reason, no feature ticked, yourself, a server
 * manager, someone it has never seen) are 422, the form drawn open over the page with what was
 * typed (PostOutcome.modal); each message is constant wording that never quotes the typed text. A
 * refusal about the actor (no permission, a pause on the actor's own use, shutdown) ends the
 * request and shows on the error page. A form whose hidden fields this page never rendered (an
 * unknown op or length, a feature that isn't one) is refused whole as out of date, before
 * anything is read.
 *
 * It declares only moderationKey (docs/MODULES.md, "Add a page"): the names it shows come with
 * Moderation's own names().
 */
import { moderationKey } from "../../application/keys.js";
import type { PauseStatus, PauseView } from "../../application/moderation.js";
import { type Actor, can } from "../../domain/policy.js";
import { isPauseDuration } from "../../domain/moderation.js";
import { isPermissionId, type PermissionId } from "../../domain/rbac.js";
import { Failure, note } from "../../domain/values.js";
import { loginLocation } from "../http.js";
import { definePage, type PageContext, type PostOutcome } from "../page.js";
import { RECENT_SIGN_IN_MS } from "../sessions.js";
import { noticeLocation } from "../views/forms.js";
import {
  DURATION_FIELD,
  FEATURE_FIELD,
  FIND_PARAM,
  type FindResult,
  MEMBER_FIELD,
  MEMBER_UNREADABLE,
  MODERATION_PATH,
  type ModerationNotice,
  OP_FIELD,
  type Problem,
  type Refused,
  REASON_FIELD,
  readFind,
  readMember,
  renderModeration,
} from "../views/moderation.js";

/**
 * The page's budget per person and server. Each POST costs three Discord requests for the fresh
 * actor, and one more for a member the database hasn't seen; thirty in ten minutes is generous
 * for pausing a handful of people and fixing a refused form, and bounded.
 */
const MODERATION_POSTS = 30;

/** The longest finder text read; the field stops at 64, so more is somebody editing the address. */
const FIND_MAX = 200;

/** A form whose hidden fields this page never rendered: refused whole (400), nothing read. */
const outOfDate = (): Failure =>
  new Failure("input", "This form is out of date. Open the page again, then redo your change.");

/** One text field's value; a missing field or a file is "". */
function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** Every text value a repeated field carries. */
const texts = (form: FormData, name: string): string[] =>
  form.getAll(name).filter((value): value is string => typeof value === "string");

/** What the service says when no feature is ticked, for the form to say it beside the others. */
const NO_FEATURE = "Pick at least one feature.";

/**
 * A refusal the form shows again: the service's input refusals (a missing reason, no feature) and
 * its refusals about the person (yourself, a server manager, someone it has never seen). Anything
 * else, a permission or a shutdown among them, is not this form's to fix, and ends the request.
 */
function problemOf(error: unknown): Problem | undefined {
  if (!(error instanceof Failure)) return undefined;
  const { detail } = error;
  if (error.code === "input") {
    const option = detail?.kind === "option" ? detail.option : undefined;
    const field = option === "reason" ? "reason" : option === "feature" ? "feature" : "form";
    return { field, message: error.message };
  }
  if (
    error.code === "forbidden" &&
    detail?.kind === "scope" &&
    (detail.scope === "protected" || detail.scope === "self")
  )
    return { field: detail.scope === "self" ? "member" : "form", message: error.message };
  if (error.code === "not_found" && detail?.kind === "resource" && detail.resource === "member")
    return { field: "member", message: error.message };
  return undefined;
}

/** Every person a list or a result names: the paused, who set it, who lifted it. */
function peopleIn(pauses: readonly PauseView[], ids: Set<string>): void {
  for (const pause of pauses) {
    ids.add(pause.userId);
    if (pause.by) ids.add(pause.by.userId);
    if (pause.ended?.by) ids.add(pause.ended.by);
  }
}

/** The found person's status, and the sender of a suggestion with theirs. */
async function lookup(context: PageContext, query: string): Promise<FindResult> {
  const moderation = context.services.get(moderationKey);
  const asked = readFind(query);
  if (asked === null) return { kind: "unreadable" };
  if (asked.kind === "member")
    return { kind: "member", status: await moderation.status(context.actor, asked.userId) };
  const sender = await moderation.senderOfSuggestion(context.actor, asked.number);
  return {
    kind: "suggestion",
    number: asked.number,
    sender: sender === null ? null : await moderation.status(context.actor, sender),
  };
}

/** The return path for signing in again: this page, with the lookup if it was readable. */
function returnPath(context: PageContext, query: string): string {
  const asked = query === "" ? null : readFind(query);
  const find =
    asked === null
      ? ""
      : `?${FIND_PARAM}=${encodeURIComponent(asked.kind === "member" ? asked.userId : `#${asked.number}`)}`;
  return `${context.url.pathname}${find}`;
}

/** The viewer's part of the view: what they may change. */
const viewerOf = (actor: Actor) => ({
  userId: actor.userId,
  canChange: can(actor, "moderation.block"),
  manager: actor.access.manager,
});

/** The page's main content, with a refused form when re-rendering one. */
async function render(context: PageContext, refused?: Refused) {
  const moderation = context.services.get(moderationKey);
  // Each authorizes the actor again and reads the database (and the gateway's name cache) only.
  const overview = await moderation.overview(context.actor);
  const findText = (context.url.searchParams.get(FIND_PARAM) ?? "").slice(0, FIND_MAX);
  const found = findText.trim() === "" ? undefined : await lookup(context, findText);
  const ids = new Set<string>();
  peopleIn([...overview.active, ...overview.ended], ids);
  const statuses: PauseStatus[] =
    found?.kind === "member"
      ? [found.status]
      : found?.kind === "suggestion" && found.sender
        ? [found.sender]
        : [];
  for (const status of statuses) {
    ids.add(status.subject);
    peopleIn([...status.active, ...status.ended], ids);
  }
  return renderModeration({
    overview,
    names: await moderation.names(context.guildId, [...ids]),
    viewer: viewerOf(context.actor),
    recentSignIn: context.recentSignIn,
    recentMinutes: Math.round(RECENT_SIGN_IN_MS / 60_000),
    signInHref: loginLocation(returnPath(context, findText)),
    action: context.url.pathname,
    token: context.formToken,
    url: context.url,
    findText,
    ...(found && { found }),
    ...(refused && { refused }),
  });
}

/** A refused form's re-render, drawn open over the page. */
async function refusal(context: PageContext, refused: Refused): Promise<PostOutcome> {
  return { invalid: await render(context, refused), status: 422, modal: true };
}

/** The redirect after a change: back here with the notice, and the person as the finder's query. */
const done = (context: PageContext, notice: ModerationNotice, userId: string): PostOutcome => ({
  redirect: noticeLocation(context.url.pathname, notice, { [FIND_PARAM]: userId }),
});

/** Pause someone (op=block). */
async function block(context: PageContext, form: FormData): Promise<PostOutcome> {
  const features = texts(form, FEATURE_FIELD);
  // The form renders one checkbox per feature; more values than the catalog has, or one it has
  // never had, is a form this page never made.
  if (features.length > 32 || !features.every((id): id is PermissionId => isPermissionId(id)))
    throw outOfDate();
  const duration = text(form, DURATION_FIELD);
  if (!isPauseDuration(duration)) throw outOfDate();
  const typed = {
    member: text(form, MEMBER_FIELD),
    features,
    duration,
    reason: text(form, REASON_FIELD),
  };
  // Everything wrong with the form is said at once, as the service would say them one at a time.
  const target = readMember(typed.member);
  const problems: Problem[] = [];
  if (target === null) problems.push({ field: "member", message: MEMBER_UNREADABLE });
  if (features.length === 0) problems.push({ field: "feature", message: NO_FEATURE });
  try {
    note(typed.reason, "reason");
  } catch (error) {
    const problem = problemOf(error);
    if (!problem) throw error;
    problems.push(problem);
  }
  if (problems.length > 0 || target === null)
    return refusal(context, { form: "block", ...typed, problems });
  try {
    await context.services
      .get(moderationKey)
      .block(context.actor, target, features as PermissionId[], duration, typed.reason);
  } catch (error) {
    const problem = problemOf(error);
    if (!problem) throw error;
    return refusal(context, { form: "block", ...typed, problems: [problem] });
  }
  return done(context, "paused", target);
}

/** Lift a pause (op=lift). */
async function lift(context: PageContext, form: FormData): Promise<PostOutcome> {
  // Both are hidden fields of a chip's form: not what anyone types.
  const target = readMember(text(form, MEMBER_FIELD));
  const feature = text(form, FEATURE_FIELD);
  if (target === null || !isPermissionId(feature)) throw outOfDate();
  const reason = text(form, REASON_FIELD);
  try {
    const result = await context.services
      .get(moderationKey)
      .lift(context.actor, target, [feature], reason);
    return done(context, result.lifted.length > 0 ? "lifted" : "not-paused", target);
  } catch (error) {
    const problem = problemOf(error);
    if (!problem) throw error;
    return refusal(context, { form: "lift", member: target, feature, reason, problems: [problem] });
  }
}

export default definePage({
  path: MODERATION_PATH,
  title: "Moderation",
  access: ["moderation.view"],
  requires: [moderationKey],
  // Private text and a lookup of who sent a suggestion: someone who loses moderation.view, or the
  // server, loses the page on their next request (no memo).
  freshActor: true,
  // Pausing and lifting need a sign-in from the last few minutes.
  recentSignIn: true,
  nav: "Moderation",
  icon: "clock",
  get: (context) => render(context),
  async post(context, form) {
    const op = text(form, OP_FIELD);
    if (op === "block") return block(context, form);
    if (op === "lift") return lift(context, form);
    throw outOfDate();
  },
  postLimit: MODERATION_POSTS,
});
