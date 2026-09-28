/**
 * The failure catalog: every failure concept, rendered by the one failure presenter for the
 * audiences and commands that reach it. Errors are built the way their throw sites build them
 * (the same codes, approved messages and details), so these cases double as the reference for how
 * each refusal reads. Cases that reproduce an approved card name it in `spec`.
 */
import { DiscordAPIError } from "discord.js";
import type { Audience } from "../../../src/discord/presenters/audience.js";
import { failureReply } from "../../../src/discord/presenters/failure.js";
import { userId } from "../../../src/discord/selectors.js";
import type { FailureCode, FailureDetail } from "../../../src/domain/failures.js";
import { authorize, authorizeRoleManager } from "../../../src/domain/policy.js";
import { suggestionAccessRefused } from "../../../src/domain/suggestions.js";
import { Failure, id, note } from "../../../src/domain/values.js";
import { ACTORS, at, CHARACTER, GUEST_ID, MEMBER_ID, NOW, REF, VIEWERS } from "../results.js";
import type { ReplyCase, ReplyCatalog } from "./index.js";

/** The error a thrown call raised, so cases reuse the real throw sites where they are pure. */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw");
}

/** A raw Discord REST error, as discord.js raises it from an interaction path. */
export function discordError(code: number, status: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "Raw Discord text that must never be shown" },
    code,
    status,
    "POST",
    "/guilds/123456789012345678/roles",
    { body: undefined, files: undefined },
  );
}

/** A Failure as a throw site builds it. */
const failure = (code: FailureCode, message: string, detail?: FailureDetail, retryAfter = 0) =>
  new Failure(code, message, retryAfter, detail);

/** Render with the mockups' clock and Ref, for an audience or for no viewer at all ('any'). */
function render(error: unknown, audience: Audience | "any", scope?: string) {
  return () =>
    failureReply(error, {
      ref: REF,
      viewer: audience === "any" ? undefined : VIEWERS[audience],
      scope,
      now: NOW,
    });
}

/** What each case rendered, so tests can re-render it or check its concept directly. */
export interface FailureSource {
  readonly error: unknown;
  readonly audience: Audience | "any";
  readonly scope: string | undefined;
}

/** The error, audience and scope behind every case, keyed by the case itself. */
export const FAILURE_SOURCES = new Map<ReplyCase, FailureSource>();

/** One failure case; failure cards never carry an embed timestamp (the approved cards don't). */
function card(
  concept: string,
  audience: Audience | "any",
  expected: Pick<ReplyCase, "tone" | "title"> & { readonly spec?: string },
  error: unknown,
  scope?: string,
): ReplyCase {
  const reply: ReplyCase = {
    spec: expected.spec ?? null,
    concept,
    audience,
    tone: expected.tone,
    title: expected.title,
    timestamp: false,
    render: render(error, audience, scope),
  };
  FAILURE_SOURCES.set(reply, { error, audience, scope });
  return reply;
}

/** The generic officer refusal, from the real policy check. */
const officerOnly = thrown(() => authorize(ACTORS.member, ACTORS.member.guildId, "officer"));
/** The manager refusal, from the real policy check for an officer without Manage Roles. */
const managerOnly = thrown(() => authorizeRoleManager(ACTORS.officer));
/** The approved revision-fence message. */
const SETTINGS_CHANGED =
  "Server settings changed while this was running, so nothing was saved. Run the command again.";
/** The approved ownership detail: the character and its current owner. */
const OWNED: FailureDetail = { kind: "ownership", character: CHARACTER, owner: GUEST_ID };
/** An unexpected error whose text must never reach Discord. */
const SECRET = new Error('postgres://tarubot:secret@db relation "jobs" secret token abc');

/** Tone and title shorthands for the recurring concepts. */
const OFFICERS_ONLY = { tone: "error", title: "Officers only" } as const;
const NOT_AVAILABLE = { tone: "error", title: "Not available here" } as const;
const FINISH_SETUP = { tone: "warning", title: "Finish setup first" } as const;
const LINKED = { tone: "error", title: "Linked to another member" } as const;
const WAIT = { tone: "pending", title: "Please wait a moment" } as const;
const BLOCKED_OFFICER = { tone: "warning", title: "Discord permissions need attention" } as const;
const BLOCKED_MEMBER = { tone: "warning", title: "Server setup issue" } as const;
const UNEXPECTED = { tone: "error", title: "Something went wrong" } as const;
const CLOSED = { tone: "info", title: "Guest applications are closed" } as const;

/** Every failure concept, per audience and the commands that reach it. */
export const FAILURE_CASES = {
  // input -------------------------------------------------------------------------------------
  "input · /ledger deposit note · member": card(
    "input",
    "member",
    { spec: "errors-and-style#1", tone: "warning", title: "Check your input" },
    thrown(() => note(" ", "note")),
    "/ledger deposit",
  ),
  "input · /assign typed member name · officer": card(
    "input",
    "officer",
    { tone: "warning", title: "Check your input" },
    thrown(() => userId("Wrenfield")),
    "/assign",
  ),
  "input · invalid ID · any": card(
    "input",
    "any",
    { tone: "warning", title: "Check your input" },
    thrown(() => id("@Wrenfield", "member")),
    "/characters",
  ),

  // forbidden ---------------------------------------------------------------------------------
  "forbidden officer · /config show · member": card(
    "forbidden.officer",
    "member",
    { spec: "errors-and-style#2", ...OFFICERS_ONLY },
    officerOnly,
    "/config show",
  ),
  "forbidden officer · guest review button · member": card(
    "forbidden.officer",
    "member",
    OFFICERS_ONLY,
    officerOnly,
    "button guest",
  ),
  "forbidden officer · /ledger withdraw · member": card(
    "forbidden.officer",
    "member",
    OFFICERS_ONLY,
    failure(
      "forbidden",
      "Only officers can record withdrawals, opening balances and corrections. Members can record deposits with /ledger deposit.",
      { kind: "scope", scope: "officer" },
    ),
    "/ledger withdraw",
  ),
  "forbidden owner · /characters member: · member": card(
    "forbidden.owner",
    "member",
    { tone: "error", title: "Only your own records" },
    thrown(() => authorize(ACTORS.member, ACTORS.member.guildId, "user", GUEST_ID)),
    "/characters",
  ),
  "forbidden manager · /config roles officer · officer": card(
    "forbidden.manager",
    "officer",
    { spec: "errors-and-style#3", tone: "error", title: "Server managers only" },
    managerOnly,
    "/config roles officer",
  ),
  "forbidden manage_roles · /config roles member · officer": card(
    "forbidden.manager",
    "officer",
    { tone: "error", title: "Server managers only" },
    failure("forbidden", "Choosing access roles needs Discord's Manage Roles permission.", {
      kind: "scope",
      scope: "manage_roles",
    }),
    "/config roles member",
  ),
  // 2.35.0 (#46): /setup overrides confirm:true needs Administrator itself, or the server owner.
  "forbidden administrator · /setup overrides · manager": card(
    "forbidden.administrator",
    "manager",
    { tone: "error", title: "Administrator or server owner only" },
    failure(
      "forbidden",
      "Only someone with Administrator, or the server owner, can run /setup overrides confirm:true.",
      { kind: "scope", scope: "administrator" },
    ),
    "/setup overrides",
  ),
  "forbidden hierarchy · /config roles member · manager": card(
    "forbidden.hierarchy",
    "manager",
    { tone: "error", title: "That role is above yours" },
    failure(
      "forbidden",
      "Your highest Discord role must be above <@&223456789012345601> to select it (the server owner is exempt). Ask someone higher in the role list, or move the role lower.",
      { kind: "scope", scope: "hierarchy" },
    ),
    "/config roles member",
  ),
  "forbidden membership · /ledger deposit · member": card(
    "forbidden.membership",
    "member",
    { spec: "errors-and-style#4", tone: "warning", title: "FC membership needed" },
    failure("forbidden", "The FC ledger is for confirmed members of this server's Free Company.", {
      kind: "scope",
      scope: "membership",
    }),
    "/ledger deposit",
  ),
  // 2.28.0: /suggest accepts guests too, so its "How to qualify" steps lead to either role.
  "forbidden membership · /suggest · member": card(
    "forbidden.membership",
    "member",
    { tone: "warning", title: "FC membership needed" },
    suggestionAccessRefused(),
    "/suggest",
  ),
  // 2.28.0: a server outside the allowlist is refused even for its managers.
  "forbidden foreign server · /suggest · manager": card(
    "forbidden.context",
    "manager",
    NOT_AVAILABLE,
    failure(
      "forbidden",
      "Suggestions can be sent only from the Free Company server this TaruBot serves.",
    ),
    "/suggest",
  ),
  "forbidden human · DM · any": card(
    "forbidden.context",
    "any",
    { spec: "errors-and-style#5", ...NOT_AVAILABLE },
    failure("forbidden", "TaruBot commands work only inside the server, for human members.", {
      kind: "scope",
      scope: "human",
    }),
    "/claim",
  ),
  "forbidden current_member · raw Unknown Member · any": card(
    "forbidden.context",
    "any",
    NOT_AVAILABLE,
    discordError(10007, 404),
    "/ledger deposit",
  ),
  "forbidden test_guild · any": card(
    "forbidden.test_guild",
    "any",
    { tone: "error", title: "Test instance" },
    failure(
      "forbidden",
      "This copy of TaruBot is a test instance and only works in its test server.",
      { kind: "scope", scope: "test_guild" },
    ),
    "/ping",
  ),

  // setup -------------------------------------------------------------------------------------
  "setup guild · /claim · member": card(
    "setup.guild",
    "member",
    { spec: "errors-and-style#6", tone: "info", title: "TaruBot isn't set up here yet" },
    failure(
      "setup",
      "This server has no TaruBot configuration yet. Start with /config fc link and /config roles, or /setup onboarding for lobby onboarding.",
      { kind: "setup", missing: "guild" },
    ),
    "/claim",
  ),
  "setup guild · /config show · officer": card(
    "setup.guild",
    "officer",
    { spec: "errors-and-style#7", ...FINISH_SETUP },
    failure(
      "setup",
      "This server has no TaruBot configuration yet. Start with /config fc link and /config roles, or /setup onboarding for lobby onboarding.",
      { kind: "setup", missing: "guild" },
    ),
    "/config show",
  ),
  "setup fc · /refresh · member": card(
    "setup.fc",
    "member",
    { tone: "info", title: "No Free Company linked" },
    failure("setup", "There's no FC roster to refresh until an officer links the Free Company.", {
      kind: "setup",
      missing: "fc",
    }),
    "/refresh",
  ),
  "setup fc · /refresh · officer": card(
    "setup.fc",
    "officer",
    FINISH_SETUP,
    failure("setup", "There's no FC roster to refresh until an officer links the Free Company.", {
      kind: "setup",
      missing: "fc",
    }),
    "/refresh",
  ),
  "setup ledger · /ledger deposit without an FC · member": card(
    "setup.ledger",
    "member",
    { tone: "info", title: "Ledger isn't set up" },
    failure("setup", "Link the Free Company and choose a ledger channel before recording gil.", {
      kind: "setup",
      missing: "fc",
    }),
    "/ledger deposit",
  ),
  "setup ledger · /ledger withdraw · officer": card(
    "setup.ledger",
    "officer",
    FINISH_SETUP,
    failure("setup", "Choose a ledger channel with /config ledger before recording gil.", {
      kind: "setup",
      missing: "ledger",
    }),
    "/ledger withdraw",
  ),
  "setup officer_role · /officer grant · manager": card(
    "setup.officer_role",
    "manager",
    FINISH_SETUP,
    failure("setup", "Bind the Officer role with /config roles officer first.", {
      kind: "setup",
      missing: "officer_role",
    }),
    "/officer grant",
  ),
  "setup guest_applications · form submit · member": card(
    "setup.guest_applications",
    "member",
    { spec: "guests-sync-utility#21", ...CLOSED },
    failure(
      "setup",
      "Guest applications are not open in this server. Ask an officer about Guest access.",
      { kind: "setup", missing: "guest_applications" },
    ),
    "modal guest-apply",
  ),
  "setup guest_role · form submit · officer": card(
    "setup.guest_applications",
    "officer",
    CLOSED,
    failure(
      "setup",
      "Guest applications are not open in this server. Ask an officer about Guest access.",
      { kind: "setup", missing: "guest_role" },
    ),
    "modal guest-apply",
  ),

  // not_found ---------------------------------------------------------------------------------
  "not_found character search · /claim · any": card(
    "not_found.character",
    "any",
    { spec: "errors-and-style#11", tone: "warning", title: "Character not found" },
    failure("not_found", "The Lodestone has no character with that exact name on that world.", {
      kind: "resource",
      resource: "character",
      name: "Example Character",
      world: "Diabolos",
    }),
    "/claim",
  ),
  "not_found freecompany · /config fc link · officer": card(
    "not_found.freecompany",
    "officer",
    { tone: "warning", title: "Free Company not found" },
    failure("not_found", "The Lodestone has no Free Company with ID 9230000000000000001.", {
      kind: "resource",
      resource: "freecompany",
      id: "9230000000000000001",
    }),
    "/config fc link",
  ),
  "not_found link · /unclaim · member": card(
    "not_found.link",
    "member",
    { spec: "errors-and-style#12", tone: "warning", title: "Link not found" },
    failure(
      "not_found",
      "That character isn't one of your linked characters. Pick one from the suggestions.",
      { kind: "resource", resource: "link", id: CHARACTER.id },
    ),
    "/unclaim",
  ),
  "not_found member · /guest grant · officer": card(
    "not_found.member",
    "officer",
    { tone: "warning", title: "Member not found" },
    failure("not_found", "That user isn't a current member of this server, or is a bot.", {
      kind: "resource",
      resource: "member",
      id: MEMBER_ID,
    }),
    "/guest grant",
  ),
  "not_found application · /guest approve · officer": card(
    "not_found.application",
    "officer",
    { tone: "warning", title: "Application not found" },
    failure(
      "not_found",
      "There's no guest application with that ID in this server. Pick one from the suggestions.",
      { kind: "resource", resource: "application" },
    ),
    "/guest approve",
  ),
  "not_found entry · /ledger adjust · officer": card(
    "not_found.entry",
    "officer",
    { tone: "warning", title: "Entry not found" },
    failure(
      "not_found",
      "That entry isn't in this FC's ledger. Copy the entry ID from /ledger history.",
      { kind: "resource", resource: "entry" },
    ),
    "/ledger adjust",
  ),
  "not_found account · /ledger balance · officer": card(
    "not_found.account",
    "officer",
    { tone: "warning", title: "No ledger for that FC" },
    failure("not_found", "This server has no ledger for FC 9230000000000000001.", {
      kind: "resource",
      resource: "account",
      id: "9230000000000000001",
    }),
    "/ledger balance",
  ),
  "not_found challenge · /verify · member": card(
    "not_found.challenge",
    "member",
    { tone: "warning", title: "No active claim for this character" },
    failure(
      "not_found",
      "You don't have an unexpired claim for this character. Run /claim for a new token, then /verify.",
      { kind: "resource", resource: "challenge", id: CHARACTER.id },
    ),
    "/verify",
  ),
  "not_found fc_link · /config fc unlink · manager": card(
    "not_found.fc_link",
    "manager",
    { tone: "warning", title: "That FC isn't linked" },
    failure(
      "not_found",
      "FC 9230000000000000001 isn't the linked Free Company. Unlinking needs the linked FC's exact ID; /config show lists it.",
      { kind: "resource", resource: "fc_link", id: "9230000000000000001" },
    ),
    "/config fc unlink",
  ),
  "not_found without a resource · any": card(
    "not_found.other",
    "any",
    { tone: "warning", title: "Not found" },
    failure("not_found", "Lodestone not found."),
  ),

  // ambiguous ---------------------------------------------------------------------------------
  "ambiguous characters · /claim · any": card(
    "ambiguous.character",
    "any",
    { spec: "errors-and-style#13", tone: "warning", title: "Several characters match" },
    failure(
      "ambiguous",
      "3 characters with that name were found. Run the command again with the right one's ID or Lodestone link.",
      {
        kind: "matches",
        resource: "character",
        name: "Example Character",
        world: "Diabolos",
        ids: ["99000001", "99000002", "99000003"],
      },
    ),
    "/claim",
  ),
  "ambiguous roles · /setup onboarding · manager": card(
    "ambiguous.role",
    "manager",
    { tone: "warning", title: "Choose which role to use" },
    failure(
      "ambiguous",
      "Several roles are named Member. Choose the one to use with /config roles, then run /setup onboarding again.",
      {
        kind: "matches",
        resource: "role",
        name: "Member",
        ids: ["223456789012345601", "223456789012345605"],
      },
    ),
    "/setup",
  ),
  "ambiguous channels · /setup onboarding · manager": card(
    "ambiguous.channel",
    "manager",
    { spec: "errors-and-style#14", tone: "warning", title: "Choose which channel to use" },
    failure(
      "ambiguous",
      "More than one channel is named #lobby, so TaruBot didn't guess. Pick the right one in /setup onboarding.",
      {
        kind: "matches",
        resource: "channel",
        name: "lobby",
        ids: ["323456789012345604", "323456789012345606"],
      },
    ),
    "/setup",
  ),

  // conflict ----------------------------------------------------------------------------------
  "ownership · /assign · officer": card(
    "ownership_conflict",
    "officer",
    { spec: "characters#31", ...LINKED },
    failure(
      "ownership_conflict",
      "This character is already linked to a different member of this server.",
      OWNED,
    ),
    "/assign",
  ),
  "ownership · /claim · member": card(
    "ownership_conflict",
    "member",
    LINKED,
    failure(
      "ownership_conflict",
      "This character is already linked to a different member of this server.",
      OWNED,
    ),
    "/claim",
  ),
  "ownership · /verify · member": card(
    "ownership_conflict",
    "member",
    LINKED,
    failure(
      "ownership_conflict",
      "This character is already linked to a different member of this server.",
      OWNED,
    ),
    "/verify",
  ),
  // An officer's own /claim or /verify gets the member card: the owner shows only on /assign (O3).
  "ownership · /claim · officer": card(
    "ownership_conflict",
    "officer",
    LINKED,
    failure(
      "ownership_conflict",
      "This character is already linked to a different member of this server.",
      OWNED,
    ),
    "/claim",
  ),
  "ownership · /verify · officer": card(
    "ownership_conflict",
    "officer",
    LINKED,
    failure(
      "ownership_conflict",
      "This character is already linked to a different member of this server.",
      OWNED,
    ),
    "/verify",
  ),
  "fc_linked · /config fc link · officer": card(
    "fc_linked",
    "officer",
    { tone: "warning", title: "Another FC is linked" },
    failure(
      "fc_linked",
      "This server is linked to FC 9234567890123456789. Unlink it with /config fc unlink fc_id:9234567890123456789, then link the new one. History and ledgers are kept.",
      { kind: "resource", resource: "freecompany", id: "9234567890123456789" },
    ),
    "/config fc link",
  ),
  "initialized · /ledger initialize · officer": card(
    "initialized",
    "officer",
    { spec: "errors-and-style#16", tone: "warning", title: "Opening balance already set" },
    failure("initialized", "This FC's ledger already has an opening balance."),
    "/ledger initialize",
  ),
  "uninitialized · /ledger deposit · member": card(
    "uninitialized",
    "member",
    { tone: "warning", title: "Opening balance not set" },
    failure(
      "uninitialized",
      "This FC's ledger has no opening balance yet, so it can't record changes.",
    ),
    "/ledger deposit",
  ),
  "uninitialized · /ledger withdraw · officer": card(
    "uninitialized",
    "officer",
    { spec: "errors-and-style#23", tone: "warning", title: "Opening balance not set" },
    failure(
      "uninitialized",
      "This FC's ledger has no opening balance yet, so it can't record changes.",
    ),
    "/ledger withdraw",
  ),
  "insufficient funds · /ledger withdraw · officer": card(
    "insufficient_funds",
    "officer",
    { spec: "ledger#7", tone: "warning", title: "Not enough recorded gil" },
    failure(
      "insufficient_funds",
      "Withdrawing 150,000,000 gil would take the recorded balance below zero.",
      { kind: "funds", balance: 117_900_000n, amount: 150_000_000n },
    ),
    "/ledger withdraw",
  ),

  // stale -------------------------------------------------------------------------------------
  "stale settings · /config ledger · any": card(
    "stale.settings",
    "any",
    { spec: "errors-and-style#17", tone: "warning", title: "Settings changed — try again" },
    failure("conflict", SETTINGS_CHANGED),
    "/config ledger",
  ),
  "stale settings · /setup onboarding · manager": card(
    "stale.settings",
    "manager",
    { tone: "warning", title: "Settings changed — try again" },
    failure(
      "conflict",
      "Server settings changed during setup, so nothing was saved. Run /setup onboarding confirm:true again; anything already created is reused.",
    ),
    "/setup onboarding",
  ),
  "stale control · unknown button · any": card(
    "stale.control",
    "any",
    { tone: "warning", title: "This control is out of date" },
    failure(
      "stale",
      "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
      { kind: "stale", what: "control" },
    ),
    "button unknown",
  ),
  "stale form · forged form · any": card(
    "stale.form",
    "any",
    { tone: "warning", title: "Please reopen /apply" },
    failure(
      "stale",
      "This form belongs to someone else or to another server. Run /apply yourself.",
      { kind: "stale", what: "form" },
    ),
    "modal guest-apply",
  ),
  "stale join · /apply · any": card(
    "stale.form",
    "any",
    { tone: "warning", title: "Please reopen /apply" },
    failure(
      "stale",
      "Discord didn't send your join details. Run /apply again from inside the server.",
      { kind: "stale", what: "join" },
    ),
    "/apply",
  ),
  "stale review · review button · officer": card(
    "stale.review",
    "officer",
    { tone: "warning", title: "This review message is out of date" },
    failure(
      "stale",
      "A newer review message replaced this one. Use the latest message in the review channel, or /guest approve.",
      { kind: "stale", what: "review" },
    ),
    "button guest",
  ),
  "expired · /verify · member": card(
    "expired",
    "member",
    { tone: "warning", title: "Token expired during verification" },
    failure(
      "expired",
      "The token expired just before verification finished. Run /claim for a new token.",
    ),
    "/verify",
  ),

  // wait --------------------------------------------------------------------------------------
  "pending proof · /verify · member": card(
    "pending_proof",
    "member",
    { spec: "characters#10", tone: "pending", title: "Token not on the Lodestone yet" },
    failure(
      "pending_proof",
      "The Lodestone hasn't published the token for this character yet. This often takes a few minutes after you save; the token is still valid.",
      { kind: "proof", character: CHARACTER, expiresAt: at(1_200) },
    ),
    "/verify",
  ),
  "pending proof · Check again · officer": card(
    "pending_proof",
    "officer",
    { tone: "pending", title: "Token not on the Lodestone yet" },
    failure(
      "pending_proof",
      "The Lodestone hasn't published the token for this character yet. This often takes a few minutes after you save; the token is still valid.",
      { kind: "proof", character: CHARACTER, expiresAt: at(1_200) },
    ),
    "button verify",
  ),
  "claims limit · /claim · member": card(
    "wait.claims_own",
    "member",
    { tone: "pending", title: "Too many unfinished claims" },
    failure(
      "cooldown",
      "You already have 5 unfinished claims. Finish one with /verify, or wait until the oldest token expires.",
      { kind: "limit", limit: "claims_own", until: at(900) },
      900,
    ),
    "/claim",
  ),
  "apply cooldown · form submit · member": card(
    "wait.apply",
    "member",
    { tone: "pending", title: "You can apply again later" },
    failure(
      "cooldown",
      "Your last application was declined recently. You can apply again later.",
      { kind: "limit", limit: "apply", until: at(86_400) },
      86_400,
    ),
    "modal guest-apply",
  ),
  // 2.18.0: /issue's limits, one per member per 10 minutes and twenty per server per day.
  "issue limit · /issue · member": card(
    "wait.issue",
    "member",
    { tone: "pending", title: "You can send another report later" },
    failure(
      "cooldown",
      "You sent a report a few minutes ago. You can send one every 10 minutes.",
      { kind: "limit", limit: "issue", until: at(600) },
      600,
    ),
    "/issue",
  ),
  // 2.28.0: /suggest's limits (one an hour and three a day per member, ten a day in total), and
  // GitHub's rate limit on new issues, share one card.
  "suggest limit · /suggest · member": card(
    "wait.suggest",
    "member",
    { tone: "pending", title: "You can suggest again later" },
    failure(
      "cooldown",
      "You sent a suggestion in the last hour. You can send one an hour, and three a day.",
      { kind: "limit", limit: "suggest", until: at(3600) },
      3600,
    ),
    "/suggest",
  ),
  "github rate limit · /suggest · member": card(
    "wait.suggest",
    "member",
    { tone: "pending", title: "You can suggest again later" },
    failure(
      "rate_limited",
      "GitHub is limiting new issues right now.",
      { kind: "limit", limit: "suggest", until: at(60) },
      60,
    ),
    "/suggest",
  ),
  "rate limited · /claim · any": card(
    "wait.retry",
    "any",
    { spec: "errors-and-style#10", ...WAIT },
    failure("rate_limited", "Lodestone rate limited.", undefined, 420),
    "/claim",
  ),
  "global claim limit · /claim · member": card(
    "wait.retry",
    "member",
    WAIT,
    failure(
      "cooldown",
      "Verification is busy right now. Try again in a few minutes.",
      { kind: "limit", limit: "claims_all", until: at(300) },
      300,
    ),
    "/claim",
  ),
  "busy · /setup onboarding · manager": card(
    "wait.retry",
    "manager",
    WAIT,
    failure("busy", "Another /setup for this server is in progress. Try again in a few seconds."),
    "/setup onboarding",
  ),
  // 2.35.0 (#46): /setup overrides shares the setup lock with onboarding's channel pass.
  "busy · /setup overrides · manager": card(
    "wait.retry",
    "manager",
    WAIT,
    failure(
      "busy",
      "Another /setup or channel pass for this server is in progress. Try again in a minute.",
    ),
    "/setup overrides",
  ),
  "eligible · form submit · member": card(
    "eligible",
    "member",
    { spec: "errors-and-style#20", tone: "info", title: "No application needed" },
    failure(
      "eligible",
      "You already have member or guest access here. If a role looks missing, TaruBot will restore it automatically.",
    ),
    "modal guest-apply",
  ),

  // upstream ----------------------------------------------------------------------------------
  "lodestone unavailable · /claim · any": card(
    "upstream.lodestone",
    "any",
    { spec: "errors-and-style#24", tone: "warning", title: "The Lodestone isn't responding" },
    failure("unavailable", "Lodestone work was cancelled or exceeded its job deadline.", {
      kind: "resource",
      resource: "character",
      id: CHARACTER.id,
    }),
    "/claim",
  ),
  "lodestone unavailable · /verify · officer": card(
    "upstream.lodestone",
    "officer",
    { tone: "warning", title: "The Lodestone isn't responding" },
    failure("unavailable", "Lodestone work was cancelled or exceeded its job deadline.", {
      kind: "resource",
      resource: "character",
      id: CHARACTER.id,
    }),
    "/verify",
  ),
  "lodestone incomplete · /config fc link · officer": card(
    "upstream.lodestone_incomplete",
    "officer",
    { tone: "warning", title: "Lodestone results incomplete" },
    failure("incomplete", "Roster pagination changed.", {
      kind: "resource",
      resource: "freecompany",
      id: "9230000000000000001",
    }),
    "/config fc link",
  ),
  "lodestone page · /claim · member": card(
    "upstream.lodestone_page",
    "member",
    { tone: "warning", title: "Unexpected Lodestone page" },
    failure("invalid_response", "The Lodestone page lacked required fields.", {
      kind: "resource",
      resource: "character",
      id: CHARACTER.id,
    }),
    "/claim",
  ),
  "biography · /verify · member": card(
    "upstream.biography",
    "member",
    { tone: "warning", title: "Couldn't read the biography" },
    failure(
      "invalid_response",
      "TaruBot couldn't read the biography section of the Lodestone page. Your token is still valid; try again in a few minutes.",
      { kind: "resource", resource: "biography", id: CHARACTER.id },
    ),
    "/verify",
  ),
  // 2.17.0: a private profile is the owner's setting, not an outage; /verify keeps the token.
  "private profile · /verify · member": card(
    "upstream.private_profile",
    "member",
    { tone: "warning", title: "Lodestone profile is private" },
    failure(
      "private_profile",
      `The Lodestone profile for character ID ${CHARACTER.id} is private.`,
      {
        kind: "resource",
        resource: "character",
        id: CHARACTER.id,
      },
    ),
    "/verify",
  ),
  "member list · /config roles officer · manager": card(
    "upstream.member_list",
    "manager",
    { spec: "errors-and-style#25", tone: "warning", title: "Couldn't read the member list" },
    failure(
      "incomplete",
      "Discord didn't return the complete member list. Try again in a minute.",
      {
        kind: "discord",
        what: "member_list",
      },
    ),
    "/config roles officer",
  ),
  // The gateway names the member it lacked a join time for; "your" only when that is the viewer.
  "join context · form submit · member": card(
    "upstream.join_context",
    "member",
    { tone: "warning", title: "Couldn't read your join details" },
    failure(
      "incomplete",
      `Discord didn't include join details for <@${MEMBER_ID}>. Try again in a moment.`,
      { kind: "discord", what: "join_context", user: MEMBER_ID },
    ),
    "modal guest-apply",
  ),
  "join context · /assign · officer": card(
    "upstream.join_context",
    "officer",
    { tone: "warning", title: "Couldn't read that member's join details" },
    failure(
      "incomplete",
      `Discord didn't include join details for <@${GUEST_ID}>. Try again in a moment.`,
      { kind: "discord", what: "join_context", user: GUEST_ID },
    ),
    "/assign",
  ),
  "discord server error · /setup onboarding · manager": card(
    "upstream.discord",
    "manager",
    { tone: "warning", title: "Discord isn't responding" },
    discordError(0, 502),
    "/setup onboarding",
  ),

  // 2.28.0: GitHub didn't confirm a /suggest post; it may exist, and the try counts.
  "github unconfirmed · /suggest · member": card(
    "upstream.github",
    "member",
    { tone: "warning", title: "GitHub didn't confirm your suggestion" },
    failure("unavailable", "GitHub didn't confirm the suggestion.", { kind: "github" }, 60),
    "/suggest",
  ),
  "github unconfirmed · /suggest · officer": card(
    "upstream.github",
    "officer",
    { tone: "warning", title: "GitHub didn't confirm your suggestion" },
    failure("unavailable", "GitHub didn't confirm the suggestion.", { kind: "github" }, 60),
    "/suggest",
  ),

  // blocked, paused, unexpected ---------------------------------------------------------------
  "blocked role · /config roles guest · officer": card(
    "blocked",
    "officer",
    { spec: "errors-and-style#8", ...BLOCKED_OFFICER },
    failure(
      "blocked",
      "TaruBot can't manage <@&223456789012345602>. Its own role must be above that role, and it needs Manage Roles.",
      { kind: "resource", resource: "role", id: "223456789012345602", fix: "hierarchy" },
    ),
    "/config roles guest",
  ),
  // Refusals about the chosen role or channel itself name it but give no hierarchy or permission
  // remedy, since dragging TaruBot's role or granting it permissions would not help.
  "blocked ordinary role · /config roles member · officer": card(
    "blocked",
    "officer",
    BLOCKED_OFFICER,
    failure(
      "blocked",
      "Pick an ordinary role: not @everyone, not a bot or integration role, and not TaruBot's own role.",
      { kind: "resource", resource: "role", id: "223456789012345601" },
    ),
    "/config roles member",
  ),
  "blocked admin role · /officer grant · manager": card(
    "blocked",
    "manager",
    BLOCKED_OFFICER,
    failure(
      "blocked",
      "Access roles can't have Administrator, Manage Server or Manage Roles. Remove those from <@&223456789012345603> or pick another role.",
      { kind: "resource", resource: "role", id: "223456789012345603" },
    ),
    "/officer grant",
  ),
  "blocked reserved channel · /setup onboarding · manager": card(
    "blocked",
    "manager",
    BLOCKED_OFFICER,
    failure(
      "blocked",
      "The Community Updates channel and its category are reserved. Choose a different officer channel.",
      { kind: "resource", resource: "channel", id: "323456789012345603" },
    ),
    "/setup onboarding",
  ),
  // 2.35.0 (#46): a channel an earlier /setup overrides masked, without Administrator (text 22):
  // TaruBot's own member entry denies what onboarding needs, which no role grant can lift.
  "blocked member entry · /setup onboarding · manager": card(
    "blocked",
    "manager",
    BLOCKED_OFFICER,
    failure(
      "blocked",
      "TaruBot's member entry in <#323456789012345607> denies Manage Channels and Manage Permissions; remove that deny (on the member, not its role), or turn Administrator on for TaruBot until onboarding's first channel pass has run, which clears it. Onboarding needs View Channel, Manage Channels and Manage Permissions there.",
      { kind: "resource", resource: "channel", id: "323456789012345607", fix: "member_entry" },
    ),
    "/setup onboarding",
  ),
  // 2.35.0 (#46): /setup overrides confirm:true without Administrator on TaruBot.
  "blocked administrator · /setup overrides · manager": card(
    "blocked",
    "manager",
    BLOCKED_OFFICER,
    failure(
      "blocked",
      "TaruBot needs Administrator while /setup overrides confirm:true runs. Turn it on for TaruBot's role, run it again, then remove it once /config validate says it is no longer needed.",
    ),
    "/setup overrides",
  ),
  "blocked channel · /ledger deposit · member": card(
    "blocked",
    "member",
    { spec: "errors-and-style#9", ...BLOCKED_MEMBER },
    failure(
      "blocked",
      "TaruBot needs View Channel, Send Messages, Embed Links and Read Message History in <#323456789012345601>, and it must be a text channel in this server.",
      {
        kind: "resource",
        resource: "channel",
        id: "323456789012345601",
        fix: "channel_permissions",
      },
    ),
    "/ledger deposit",
  ),
  "blocked raw Missing Permissions · /setup onboarding · manager": card(
    "blocked",
    "manager",
    BLOCKED_OFFICER,
    discordError(50013, 403),
    "/setup onboarding",
  ),
  "blocked raw Missing Access · before the actor · any": card(
    "blocked",
    "any",
    BLOCKED_MEMBER,
    discordError(50001, 403),
    "/claim",
  ),
  "paused · /setup onboarding · manager": card(
    "paused",
    "manager",
    { tone: "pending", title: "Discord changes paused" },
    failure("disabled", "Discord effects are disabled pending activation."),
    "/setup onboarding",
  ),
  "unexpected · /ledger deposit · member": card(
    "unexpected",
    "member",
    { spec: "errors-and-style#27", ...UNEXPECTED },
    SECRET,
    "/ledger deposit",
  ),
  "unexpected · /config show · officer": card(
    "unexpected",
    "officer",
    UNEXPECTED,
    SECRET,
    "/config show",
  ),
  "unexpected internal code · button ledger · any": card(
    "unexpected",
    "any",
    UNEXPECTED,
    failure("idempotency_conflict", "Idempotency key belongs to another account."),
    "button ledger",
  ),
} satisfies ReplyCatalog<string>;
