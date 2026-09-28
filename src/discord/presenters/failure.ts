/**
 * The one failure presenter. Every refusal or error an interaction produces is classified once
 * (src/domain/failures.ts) and rendered here, keyed by catalog code and typed detail, never by
 * message text. Group presenters never catch failures, so each concept has one title and tone
 * however it was reached; the interaction scope only picks wording such as the command name, an
 * Example line or the no-change sentence.
 *
 * Anatomy (approved errors-and-style board): the category's tone, a title of at most 60
 * characters without user text, the approved message (or catalog text where members need generic
 * wording), "Nothing was changed." where the concept's approved copy carries it, one next-step
 * field, and the footer 'Code <code> · Ref <interaction ID>', where Ref is the log `operation`.
 * Officers additionally see Diagnostic and Affected fields; members, and replies sent before the
 * actor is known (no viewer), always get member-safe wording.
 */
import {
  classifyFailure,
  type FailureCategory,
  type FailureClassification,
  type FailureDetail,
  type ForbiddenScope,
  type SetupPiece,
} from "../../domain/failures.js";
import { OFFICERS_ONLY } from "../../domain/policy.js";
import { isOfficer, type Viewer } from "./audience.js";
import { verifyButton } from "./controls.js";
import {
  characterName,
  code,
  count,
  cutMarkdown,
  gilText,
  link,
  list,
  lodestone,
  member,
  mentionChannel,
  mentionRole,
  mentionUser,
  plain,
  retryWhen,
  when,
} from "./format.js";
import { applicationsClosedSpec } from "./guests.js";
import { reply, type ButtonSpec, type FieldSpec, type Presented } from "./reply.js";
import { HOUSE_LIMITS, type Tone } from "./style.js";

/**
 * Every failure concept: one title family per entry, whatever command or button reached it. The
 * failure catalog in tests covers each one, and reply-consistency.test pins one title and tone per
 * (concept, audience).
 */
export const FAILURE_CONCEPTS = [
  "input",
  "forbidden.officer",
  "forbidden.owner",
  "forbidden.manager",
  "forbidden.administrator",
  "forbidden.hierarchy",
  "forbidden.membership",
  "forbidden.context",
  "forbidden.test_guild",
  "setup.guild",
  "setup.fc",
  "setup.ledger",
  "setup.officer_role",
  "setup.guest_applications",
  "not_found.character",
  "not_found.freecompany",
  "not_found.link",
  "not_found.member",
  "not_found.application",
  "not_found.entry",
  "not_found.account",
  "not_found.challenge",
  "not_found.fc_link",
  "not_found.other",
  "ambiguous.character",
  "ambiguous.role",
  "ambiguous.channel",
  "ownership_conflict",
  "fc_linked",
  "initialized",
  "uninitialized",
  "insufficient_funds",
  "stale.settings",
  "stale.control",
  "stale.form",
  "stale.review",
  "expired",
  "pending_proof",
  "wait.claims_own",
  "wait.apply",
  "wait.issue",
  "wait.suggest",
  "wait.retry",
  "eligible",
  "upstream.lodestone",
  "upstream.lodestone_incomplete",
  "upstream.lodestone_page",
  "upstream.biography",
  "upstream.private_profile",
  "upstream.member_list",
  "upstream.join_context",
  "upstream.discord",
  "upstream.github",
  "blocked",
  "paused",
  "unexpected",
] as const;

/** A failure concept: the title family a failure renders as. */
export type FailureConcept = (typeof FAILURE_CONCEPTS)[number];

/** How the failure reply is rendered: who for, where it came from, and when. */
export interface FailureReplyOptions {
  /** The interaction ID, shown as the footer's Ref and logged as `operation`. */
  readonly ref: string;
  /** The resolved viewer; absent before the actor is known, which forces member-safe wording. */
  readonly viewer?: Viewer | undefined;
  /** The interaction path from interactionScope(): '/ledger withdraw', 'button guest'. */
  readonly scope?: string | undefined;
  /**
   * The slash command ran with confirm:true (only /setup's subcommands have that option, 2.35.0):
   * without it /setup onboarding is a dry run, whose refusals say nothing was changed rather than
   * promising reuse on a run the person may never have made. Absent means false.
   */
  readonly confirmed?: boolean | undefined;
  /** 'deliver' when the failure happened after execute returned, while showing its result. */
  readonly phase?: "execute" | "deliver" | undefined;
  /** The current time for retry deadlines; tests inject the mockups' clock. */
  readonly now?: Date | undefined;
}

// ---------------------------------------------------------------------------------------------
// Scope

/** The parts of an interaction scope the wording depends on. */
interface Scope {
  /** A slash command's path without the slash: 'ledger withdraw', 'config roles officer'. */
  readonly path?: string;
  /** Its root command: 'ledger'. */
  readonly root?: string;
  /** A component's kind and custom-ID prefix: 'button' and 'guest'. */
  readonly kind?: string;
  readonly prefix?: string;
}

/** Command and component names are Discord-validated; anything else is not echoed. */
const SCOPE_WORD = /^[a-z0-9_-]{1,32}$/u;

/** Split a scope string into the parts wording may name. */
function parseScope(scope: string | undefined): Scope {
  if (!scope) return {};
  if (scope.startsWith("/")) {
    const words = scope.slice(1).split(" ");
    if (!words.every((word) => SCOPE_WORD.test(word))) return {};
    return { path: words.join(" "), root: words[0] ?? "" };
  }
  const [kind = "", prefix = ""] = scope.split(" ");
  return SCOPE_WORD.test(kind) && SCOPE_WORD.test(prefix) ? { kind, prefix } : {};
}

/** Ledger commands that record an entry: their unexpected failures warn about double entry. */
const LEDGER_MUTATIONS: ReadonlySet<string> = new Set([
  "ledger deposit",
  "ledger withdraw",
  "ledger initialize",
  "ledger adjust",
]);

/** Roots whose other subcommands members may run, so a refusal names the subcommand. */
const MIXED_ROOTS: ReadonlySet<string> = new Set(["guest"]);

/**
 * Example commands per command path. An input failure's option detail picks the first example
 * that uses that option, so the Example always shows the value the user got wrong. Every option of
 * every command path has one ("If there's a parameter to input, it should provide an example":
 * owner decision, 2026-09-24); failure-reply.test.ts checks this against the registered commands.
 */
export const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  "ledger deposit": ["/ledger deposit amount:10005000 note:Weekly FC chest deposit"],
  "ledger withdraw": ["/ledger withdraw amount:2500000 note:Housing materials"],
  "ledger initialize": ["/ledger initialize balance:10005000 note:Opening balance from FC chest"],
  "ledger adjust": [
    "/ledger adjust balance:10005000 note:Recount after chest audit",
    "/ledger adjust balance:10005000 note:Withdrawal #42 was 2,550,000 gil entry:42",
  ],
  "ledger balance": ["/ledger balance fc_id:9230000000000000001"],
  "ledger history": ["/ledger history before:34", "/ledger history fc_id:9230000000000000001"],
  claim: ["/claim character:99000001", "/claim forename:Example surname:Character world:Diabolos"],
  verify: ["/verify character:99000001"],
  main: ["/main character:99000001"],
  unclaim: ["/unclaim character:99000001"],
  nickname: ["/nickname enabled:true"],
  assign: [
    "/assign member:123456789012345678 reason:Confirmed in voice chat character:99000001",
    "/assign member:123456789012345678 reason:Confirmed in voice chat forename:Example surname:Character world:Diabolos",
  ],
  unassign: ["/unassign member:123456789012345678 character:99000001 reason:Linked by mistake"],
  issue: ["/issue description:My Member role disappeared after I ran /main this morning."],
  suggest: ["/suggest idea:Let officers schedule FC events and remind members an hour before."],
  characters: ["/characters member:123456789012345678"],
  "guest approve": ["/guest approve application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f"],
  "guest deny": [
    "/guest deny application:3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f reason:Not part of our community",
  ],
  "guest grant": ["/guest grant member:123456789012345678 reason:Friend of the FC"],
  "guest revoke": ["/guest revoke member:123456789012345678 reason:Left the community"],
  "guest reset": ["/guest reset member:123456789012345678 reason:Back to the automatic rules"],
  "guest status": ["/guest status member:123456789012345678"],
  "officer grant": ["/officer grant member:123456789012345678 reason:New FC officer"],
  "officer revoke": ["/officer revoke member:123456789012345678 reason:Stepped down"],
  "officer reset": ["/officer reset member:123456789012345678 reason:Back to the in-game rank"],
  "config officer_rank": [
    "/config officer_rank rank:Officer",
    "/config officer_rank unset_rank:true",
  ],
  "config fc link": ["/config fc link fc_id:9230000000000000001"],
  "config fc unlink": ["/config fc unlink fc_id:9230000000000000001"],
  "config roles member": [
    "/config roles member role:@Member",
    "/config roles member unset_role:true",
  ],
  "config roles guest": ["/config roles guest role:@Guest", "/config roles guest unset_role:true"],
  "config roles officer": [
    "/config roles officer role:@Officer adopt_holders:false",
    "/config roles officer unset_role:true",
  ],
  "config roles leader": [
    "/config roles leader role:@FC Leader",
    "/config roles leader unset_role:true",
  ],
  "config role_layout": ["/config role_layout enabled:true"],
  "config ledger": ["/config ledger channel:#fc-ledger", "/config ledger unset_channel:true"],
  "config officer_notifications": [
    "/config officer_notifications channel:#officer-chat",
    "/config officer_notifications unset_channel:true",
  ],
  "config changelog": [
    "/config changelog channel:#tarubot-updates",
    "/config changelog unset_channel:true",
  ],
  "config guest_applications": [
    "/config guest_applications enabled:true channel:#officer-chat",
    "/config guest_applications unset_channel:true",
  ],
  // 2.35.0 (#46) split /setup; both subcommands are dry runs unless confirm:true.
  "setup onboarding": [
    "/setup onboarding fc_id:9230000000000000001",
    "/setup onboarding prefix:EXFC",
    "/setup onboarding officer_rank:Officer lobby:#lobby officers:#officer-chat confirm:true",
  ],
  "setup overrides": ["/setup overrides", "/setup overrides confirm:true"],
  refresh: ["/refresh force:true"],
  "sync status": ["/sync status run_id:9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"],
  version: ["/version commits:10"],
};

/** The Example for an input failure's option in this scope, if the scope has one. */
function exampleFor(scope: Scope, option: string | undefined): string | undefined {
  if (!option || !scope.path) return undefined;
  return EXAMPLES[scope.path]?.find((example) => example.includes(` ${option}:`));
}

// ---------------------------------------------------------------------------------------------
// Views

/** Which no-change sentence the concept's approved copy carries. */
type Unchanged =
  /** "Nothing was changed." */
  | "changed"
  /** "Nothing was recorded." (approved ledger#7). */
  | "recorded"
  /** The approved copy has none (context refusals, officer setup, proofs, closed card). */
  | "none"
  /** A raw Discord error may have hit partway through, so only /setup's reuse sentence is safe. */
  | "unknown";

/** A failure's rendering before the shared parts (sentence, diagnostic, footer) are added. */
interface FailureView {
  readonly concept: FailureConcept;
  readonly tone: Tone;
  readonly title: string;
  /** What happened, as approved; the no-change sentence follows it. */
  readonly lead: string;
  /** A closing sentence after the no-change sentence ("Try again in a few minutes."). */
  readonly tail?: string | undefined;
  readonly unchanged: Unchanged;
  readonly fields?: readonly (FieldSpec | false | null | undefined)[];
  readonly buttons?: readonly ButtonSpec[];
  /** The officer Diagnostic field applies: the description doesn't show the stored message. */
  readonly diagnostic?: boolean;
}

/** Everything a view is computed from. */
interface Situation {
  readonly c: FailureClassification;
  /** The approved Failure message; absent for errors that are not Failures. */
  readonly message: string | undefined;
  readonly detail: FailureDetail | undefined;
  readonly viewer: Viewer | undefined;
  /** Officer wording applies: a resolved officer or manager viewer. */
  readonly officer: boolean;
  readonly scope: Scope;
  /** The command ran with confirm:true (FailureReplyOptions.confirmed). */
  readonly confirmed: boolean;
  readonly now: Date;
}

const NOTHING_CHANGED = "Nothing was changed.";
const NOTHING_RECORDED = "Nothing was recorded.";
/** /setup onboarding reuses what it already created, which is the reassurance its failures need. */
const SETUP_REUSE =
  "Anything already created is reused when you run /setup onboarding confirm:true again.";
/** A description that already says nothing happened, or that /setup reuses, needs no repeat. */
const ALREADY_SAID =
  /nothing was (?:changed|saved|recorded|linked)|(?:was|were)n't changed|(?:was|were) not changed|reused/iu;

/**
 * Split a lead's trailing 'Try again …' sentence into the tail, so the retry follows the no-change
 * sentence as approved errors-and-style#10 and #24 (and spec #25) draw it. Only retry-timed views
 * use it: other concepts' approved copy puts their next step before the no-change sentence.
 */
function retryLast(lead: string): { lead: string; tail?: string } {
  const match = /^(.*[.!?])\s+(Try again\b.*)$/su.exec(lead);
  return match?.[1] && match[2] ? { lead: match[1], tail: match[2] } : { lead };
}

/** Decimal Discord and Lodestone IDs, the only values mentions, links and buttons accept. */
const DECIMAL = /^[1-9][0-9]{0,19}$/u;
const decimal = (value: string | undefined): value is string =>
  value !== undefined && DECIMAL.test(value);

/** The approved 'What you can do' for members who hit setup gaps. */
const ASK_AN_OFFICER: FieldSpec = {
  name: "What you can do",
  value: "Ask an officer, and try again once setup is done.",
};

/** The approved officer follow-up after any setup step. */
const THEN_CHECK: FieldSpec = {
  name: "Then check",
  value: "`/config validate` lists anything still missing.",
};

// input ---------------------------------------------------------------------------------------

/** Every input failure is 'Check your input'; the option detail only selects the Example. */
function inputView(s: Situation): FailureView {
  const option = s.detail?.kind === "option" ? s.detail.option : undefined;
  const example = exampleFor(s.scope, option);
  return {
    concept: "input",
    tone: "warning",
    title: "Check your input",
    lead: s.message ?? "One of the values you entered can't be used.",
    unchanged: "changed",
    fields: [example !== undefined && { name: "Example", value: code(example) }],
  };
}

// forbidden -----------------------------------------------------------------------------------

/**
 * The officer refusal's sentence: its own approved wording when the throw site wrote one,
 * otherwise the command or control the member tried (approved errors-and-style#2).
 */
function officerSentence(s: Situation): string {
  if (s.message !== undefined && s.message !== OFFICERS_ONLY) return s.message;
  const { path, root, kind, prefix } = s.scope;
  if (root) return `Only FC officers can use **/${MIXED_ROOTS.has(root) ? path : root}**.`;
  if (prefix === "guest") return "Only officers can decide guest access.";
  if (kind === "button") return "Only FC officers can use this button.";
  return OFFICERS_ONLY;
}

/**
 * The Discord permissions a manager refusal says are missing, from the viewer's own flags. The
 * viewer carries no Manage Channels flag, so /setup's three-permission check names Manage Channels
 * only when both known permissions are present: then it must be the one missing.
 */
function missingPermissions(s: Situation, scope: ForbiddenScope | undefined): string | undefined {
  if (scope === "manage_roles") return "Manage Roles";
  const missing = [
    !(s.viewer?.manageGuild ?? false) && "Manage Server",
    !(s.viewer?.manageRoles ?? false) && "Manage Roles",
  ].filter((name): name is string => Boolean(name));
  if (scope === "manage_channels" && !missing.length && s.viewer !== undefined)
    return "Manage Channels";
  return missing.length ? missing.join(" and ") : undefined;
}

/** Permission refusals, by the scope detail naming the rule that refused. */
function forbiddenView(s: Situation): FailureView {
  const scope = s.detail?.kind === "scope" ? s.detail.scope : undefined;
  switch (scope) {
    case "officer":
      return {
        concept: "forbidden.officer",
        tone: "error",
        title: "Officers only",
        lead: officerSentence(s),
        unchanged: "changed",
        fields: [
          {
            name: "What you can do",
            value: "If you think you should have officer access, ask a server manager.",
          },
        ],
      };
    case "owner":
      return {
        concept: "forbidden.owner",
        tone: "error",
        title: "Only your own records",
        lead:
          s.message ?? "You can view only your own records. Officers can look up other members.",
        unchanged: "none",
        fields: [
          s.scope.path !== undefined && {
            name: "What you can do",
            value: `Run ${code(`/${s.scope.path}`)} without the member option to see your own.`,
          },
        ],
      };
    case "administrator":
      // /setup overrides confirm:true (2.35.0): the caller already passed the server-manager
      // check, so "Server managers only" would contradict the lead; Administrator is what's missing.
      return {
        concept: "forbidden.administrator",
        tone: "error",
        title: "Administrator or server owner only",
        lead:
          s.message ??
          "Only someone with Administrator, or the server owner, can run /setup overrides confirm:true.",
        unchanged: "changed",
        fields: [
          { name: "Missing permission", value: "Administrator", inline: true },
          {
            name: "Who can do this",
            value: "Anyone with Administrator, or the server owner",
            inline: true,
          },
        ],
      };
    case "manager":
    case "manage_roles":
    case "manage_channels": {
      const missing = missingPermissions(s, scope);
      return {
        concept: "forbidden.manager",
        tone: "error",
        title: "Server managers only",
        lead:
          s.message ??
          "This needs Discord's Manage Server and Manage Roles permissions. Bot officer access isn't enough.",
        unchanged: "changed",
        fields: [
          missing !== undefined && { name: "Missing permission", value: missing, inline: true },
          {
            name: "Who can do this",
            value:
              scope === "manage_roles"
                ? "Anyone with Manage Roles, such as the server owner"
                : scope === "manage_channels"
                  ? "Anyone with all three permissions, such as the server owner"
                  : "Anyone with both permissions, such as the server owner",
            inline: true,
          },
        ],
      };
    }
    case "hierarchy":
      return {
        concept: "forbidden.hierarchy",
        tone: "error",
        title: "That role is above yours",
        lead: s.message ?? "Your highest Discord role must be above that role to select it.",
        unchanged: "changed",
      };
    case "membership":
      return {
        concept: "forbidden.membership",
        tone: "warning",
        title: "FC membership needed",
        lead: s.message ?? "The FC ledger is for confirmed members of this server's Free Company.",
        unchanged: "changed",
        fields: [
          {
            name: "How to qualify",
            // /suggest (2.28.0) also accepts guests, so its steps lead to either role.
            value: (s.scope.root === "suggest"
              ? [
                  "1. Link your character with /claim and /verify, or ask an officer to /assign it.",
                  "2. TaruBot then gives you the Guest role, or the Member role once a roster check finds the character in the Free Company.",
                  "3. An officer can also give you guest access with /guest grant.",
                ]
              : [
                  "1. Link your character with /claim and /verify, or ask an officer to /assign it.",
                  "2. Make sure that character is in the Free Company on the Lodestone.",
                  "3. Once a roster check confirms you, try again. /refresh can start one.",
                ]
            ).join("\n"),
          },
        ],
      };
    case "test_guild":
      return {
        concept: "forbidden.test_guild",
        tone: "error",
        title: "Test instance",
        lead:
          s.message ?? "This copy of TaruBot is a test instance and only works in its test server.",
        unchanged: "none",
      };
    default:
      // human and current_member, plus any refusal without a scope detail.
      return {
        concept: "forbidden.context",
        tone: "error",
        title: "Not available here",
        lead:
          s.message ??
          (scope === "current_member"
            ? "You need to be a current member of this server to do that."
            : "TaruBot commands work only inside the server, for human members."),
        unchanged: "none",
      };
  }
}

// setup ---------------------------------------------------------------------------------------

/** Officer next steps per missing piece, with the exact commands. */
const SETUP_NEXT: Readonly<
  Record<Exclude<SetupPiece, "guest_applications" | "guest_role">, string>
> = {
  guild: [
    "`/config fc link fc_id:9230000000000000001` links the Free Company by its Lodestone ID or link.",
    "`/config roles member role:@Member` binds an existing role; do the same for guest, officer and leader.",
    "Or preview lobby onboarding with `/setup onboarding fc_id:9230000000000000001`; `confirm:true` creates the roles and rooms.",
  ].join("\n"),
  fc: "`/config fc link fc_id:9230000000000000001` links the Free Company by its Lodestone ID or link.",
  ledger: "`/config ledger channel:#fc-ledger` chooses the channel for ledger posts.",
  officer_role:
    "`/config roles officer role:@Officer` binds the Officer role, or `/setup onboarding confirm:true` creates one.",
};

/** What an officer runs to open guest applications, by the piece still missing. */
const GUEST_NEXT: Readonly<Record<"guest_applications" | "guest_role", string>> = {
  guest_applications:
    "Turn applications on with a review channel: `/config guest_applications enabled:true channel:#guest-reviews`.",
  guest_role: "Set the Guest role with `/config roles guest role:@Guest`.",
};

/**
 * Setup gaps have two presentations: members get info tone and a title naming the missing piece;
 * officers and managers get 'Finish setup first' in warning tone with the exact commands. Closed
 * guest applications reuse the closed card for everyone, adding an officer next step.
 */
function setupView(s: Situation): FailureView {
  const missing = s.detail?.kind === "setup" ? s.detail.missing : "guild";
  if (missing === "guest_applications" || missing === "guest_role") {
    const card = applicationsClosedSpec(
      s.officer ? [{ name: "Next step", value: GUEST_NEXT[missing] }] : [],
    );
    return {
      concept: "setup.guest_applications",
      tone: card.tone,
      title: card.title,
      lead: typeof card.description === "string" ? card.description : "",
      unchanged: "none",
      fields: card.fields ?? [],
    };
  }
  // A missing FC on a ledger command is the ledger's setup gap, as members see it.
  const ledger = missing === "ledger" || (missing === "fc" && s.scope.root === "ledger");
  const piece = ledger ? "ledger" : missing === "fc" ? "fc" : missing;
  const concept = `setup.${piece}` as const;
  if (s.officer)
    return {
      concept,
      tone: "warning",
      title: "Finish setup first",
      lead:
        piece === "guild"
          ? "This server has no TaruBot configuration yet. Start with **/config fc link** and **/config roles**, or **/setup onboarding** for lobby onboarding."
          : (s.message ?? "An officer step is still missing."),
      unchanged: "none",
      fields: [
        {
          name: "Next step",
          value:
            missing === "fc" && ledger
              ? `${SETUP_NEXT.fc}\n${SETUP_NEXT.ledger}`
              : SETUP_NEXT[piece],
        },
        THEN_CHECK,
      ],
    };
  const command = s.scope.root ? `**/${s.scope.root}**` : undefined;
  const lead = {
    guild: command
      ? `An officer needs to finish setting up TaruBot in this server before ${command} works.`
      : "An officer needs to finish setting up TaruBot in this server first.",
    officer_role: command
      ? `An officer needs to finish setting up TaruBot in this server before ${command} works.`
      : "An officer needs to finish setting up TaruBot in this server first.",
    fc: command
      ? `An officer needs to link this server's Free Company before ${command} works.`
      : "An officer needs to link this server's Free Company first.",
    ledger:
      "An officer needs to link the Free Company and choose a ledger channel before the FC ledger can be used.",
  }[piece];
  return {
    concept,
    tone: "info",
    title: {
      guild: "TaruBot isn't set up here yet",
      officer_role: "TaruBot isn't set up here yet",
      fc: "No Free Company linked",
      ledger: "Ledger isn't set up",
    }[piece],
    lead,
    unchanged: "changed",
    fields: [ASK_AN_OFFICER],
  };
}

// not_found -----------------------------------------------------------------------------------

/** Titles for missing records and Lodestone pages, by resource. */
const NOT_FOUND = {
  character: "Character not found",
  freecompany: "Free Company not found",
  link: "Link not found",
  member: "Member not found",
  application: "Application not found",
  entry: "Entry not found",
  account: "No ledger for that FC",
  challenge: "No active claim for this character",
  fc_link: "That FC isn't linked",
} as const;

/** A missing record or Lodestone page, titled by its resource detail. */
function notFoundView(s: Situation): FailureView {
  const detail = s.detail?.kind === "resource" ? s.detail : undefined;
  const resource =
    detail && Object.hasOwn(NOT_FOUND, detail.resource)
      ? (detail.resource as keyof typeof NOT_FOUND)
      : undefined;
  const lead = s.message ?? "TaruBot couldn't find that.";
  if (!resource)
    return {
      concept: "not_found.other",
      tone: "warning",
      title: "Not found",
      lead,
      unchanged: "changed",
    };
  const searched = resource === "character" && detail?.name && detail.world;
  return {
    concept: `not_found.${resource}` as const,
    tone: "warning",
    title: NOT_FOUND[resource],
    lead: searched
      ? `The Lodestone has no character named **${plain(detail.name ?? "", HOUSE_LIMITS.characterName)}** on **${plain(detail.world ?? "", HOUSE_LIMITS.characterName)}**.`
      : lead,
    unchanged: "changed",
    fields: [
      resource === "character" && {
        name: "Tips",
        value:
          "Search needs the exact full first name, last name and home world. You can also paste the character's Lodestone profile link into `character:`.",
      },
      resource === "freecompany" && {
        name: "Tips",
        value: "Check the FC ID, or paste the Free Company's Lodestone link into `fc_id:`.",
      },
      resource === "link" && {
        name: "Check",
        value: s.officer
          ? "`/characters member:` lists that member's current links."
          : "`/characters` lists your linked characters.",
      },
    ],
  };
}

// ambiguous -----------------------------------------------------------------------------------

/** The command a player reruns with one of the matching character IDs. */
function characterExample(scope: Scope, id: string): string | undefined {
  if (scope.root === "claim" || scope.root === "verify") return `/${scope.root} character:${id}`;
  if (scope.root === "assign")
    return `/assign member:123456789012345678 reason:Confirmed in voice chat character:${id}`;
  return undefined;
}

/** Several candidates matched a name: characters list their profiles; roles and channels ask. */
function ambiguousView(s: Situation): FailureView {
  const matches = s.detail?.kind === "matches" ? s.detail : undefined;
  const ids = (matches?.ids ?? []).filter(decimal);
  if (!matches || matches.resource === "character") {
    const name = matches ? plain(matches.name, HOUSE_LIMITS.characterName) : undefined;
    const world = matches?.world ? plain(matches.world, HOUSE_LIMITS.characterName) : undefined;
    const first = ids[0];
    const example = first ? characterExample(s.scope, first) : undefined;
    return {
      concept: "ambiguous.character",
      tone: "warning",
      title: "Several characters match",
      lead: name
        ? `${count(matches?.ids.length ?? 0, "character")} named **${name}**${world ? ` on **${world}**` : ""} were found. Run the command again with the right one's ID or Lodestone link.`
        : (s.message ??
          "Several characters match. Run the command again with the right one's ID or Lodestone link."),
      unchanged: "changed",
      fields: [
        ids.length > 0 && {
          name: "Matches",
          value: list(
            ids.map((id) => `${code(id)} · ${link("Lodestone profile", lodestone.character(id))}`),
            { max: HOUSE_LIMITS.jobLines },
          ),
        },
        example !== undefined && { name: "Example", value: code(example) },
      ],
    };
  }
  const role = matches.resource === "role";
  const name = plain(matches.name, HOUSE_LIMITS.characterName);
  return {
    concept: role ? "ambiguous.role" : "ambiguous.channel",
    tone: "warning",
    title: role ? "Choose which role to use" : "Choose which channel to use",
    lead: role
      ? `Several roles are named **${name}**, so TaruBot didn't guess.`
      : `Several channels match **${name}**, so TaruBot didn't guess.`,
    unchanged: "changed",
    fields: [
      s.officer &&
        ids.length > 0 && {
          name: "Matches",
          value: list(
            ids.map((id) => `${role ? mentionRole(id) : mentionChannel(id)} (${code(id)})`),
            { max: HOUSE_LIMITS.jobLines },
          ),
        },
      {
        name: "Next step",
        value: role
          ? "Pick the role with `/config roles`, then run `/setup onboarding` again."
          : "Run `/setup onboarding` again and pick the channel in its `lobby` or `officers` option.",
      },
    ],
  };
}

// conflict ------------------------------------------------------------------------------------

/**
 * The character is linked to someone else. Members never learn who (approved characters#31 and
 * the style guide). Only officers on /assign see the current owner as a mention and raw ID (owner
 * decision O3, 2026-09-23) beside the approved /unassign next step; an officer's own /claim,
 * /verify or verify button gets the member card, whose next step fits a self-claim.
 */
function ownershipView(s: Situation): FailureView {
  const detail = s.detail?.kind === "ownership" ? s.detail : undefined;
  const name = detail ? `**${characterName(detail.character)}**` : "This character";
  if (s.officer && s.viewer && s.scope.root === "assign")
    return {
      concept: "ownership_conflict",
      tone: "error",
      title: "Linked to another member",
      lead: `${name} is already linked to a different member. Remove that link with \`/unassign\` first, then assign it again.`,
      unchanged: "none",
      fields: [
        detail &&
          decimal(detail.owner) && {
            name: "Linked to",
            value: member(detail.owner, s.viewer),
            inline: true,
          },
      ],
    };
  return {
    concept: "ownership_conflict",
    tone: "error",
    title: "Linked to another member",
    lead: `${name} is already linked to another member of this server.`,
    unchanged: "changed",
    fields: [
      {
        name: "What you can do",
        value: "If this is your character, ask an officer to review the link.",
      },
    ],
  };
}

/** Durable state the request conflicts with: another FC, the opening balance, funds, owners. */
function conflictView(s: Situation): FailureView {
  switch (s.c.code) {
    case "ownership_conflict":
      return ownershipView(s);
    case "fc_linked":
      return {
        concept: "fc_linked",
        tone: "warning",
        title: "Another FC is linked",
        lead: s.message ?? "This server is already linked to another Free Company.",
        unchanged: "changed",
      };
    case "initialized":
      return {
        concept: "initialized",
        tone: "warning",
        title: "Opening balance already set",
        lead: s.message ?? "This FC's ledger already has an opening balance.",
        unchanged: "changed",
        fields: [
          {
            name: "Next step",
            value:
              "To correct the balance, use `/ledger adjust balance:10005000 note:Recount after chest audit`.",
          },
        ],
      };
    case "uninitialized":
      return {
        concept: "uninitialized",
        tone: "warning",
        title: "Opening balance not set",
        lead:
          s.message ?? "This FC's ledger has no opening balance yet, so it can't record changes.",
        unchanged: "changed",
        fields: [
          {
            name: "Next step",
            value: s.officer
              ? "Record it once with `/ledger initialize balance:10005000 note:Opening balance from FC chest`."
              : "Ask an officer to record the opening balance with `/ledger initialize`.",
          },
        ],
      };
    default: {
      // insufficient_funds: approved ledger#7, warning with Requested and Recorded balance.
      const funds = s.detail?.kind === "funds" ? s.detail : undefined;
      return {
        concept: "insufficient_funds",
        tone: "warning",
        title: "Not enough recorded gil",
        lead: funds
          ? `Withdrawing **${gilText(funds.amount)}** would take the recorded balance below zero.`
          : (s.message ?? "That would take the recorded balance below zero."),
        unchanged: "recorded",
        fields: funds
          ? [
              { name: "Requested", value: gilText(funds.amount), inline: true },
              { name: "Recorded balance", value: gilText(funds.balance), inline: true },
            ]
          : [],
      };
    }
  }
}

// stale ---------------------------------------------------------------------------------------

/** Something changed underneath the request, or the control or form is out of date. */
function staleView(s: Situation): FailureView {
  if (s.c.code === "expired")
    return {
      concept: "expired",
      tone: "warning",
      title: "Token expired during verification",
      lead:
        s.message ??
        "The token expired just before verification finished. Run /claim for a new token.",
      unchanged: "changed",
    };
  const what = s.detail?.kind === "stale" ? s.detail.what : undefined;
  if (what === "control")
    return {
      concept: "stale.control",
      tone: "warning",
      title: "This control is out of date",
      lead: s.message ?? "This button or command is out of date. Run the command again.",
      unchanged: "changed",
    };
  if (what === "form" || what === "join")
    return {
      concept: "stale.form",
      tone: "warning",
      title: "Please reopen /apply",
      lead: s.message ?? "This form is out of date. Run /apply again.",
      unchanged: "changed",
    };
  if (what === "review")
    return {
      concept: "stale.review",
      tone: "warning",
      title: "This review message is out of date",
      lead: s.message ?? "A newer review message replaced this one.",
      unchanged: "changed",
    };
  // Revision fences (conflict), superseded work and other stale state (approved errors#17).
  return {
    concept: "stale.settings",
    tone: "warning",
    title: "Settings changed — try again",
    lead:
      s.message ??
      "Server settings changed while this was running, so nothing was saved. Run the command again.",
    unchanged: "changed",
  };
}

// wait ----------------------------------------------------------------------------------------

/** Seconds until a limit lifts: its own end time when known, else the failure's retryAfter. */
function waitSeconds(s: Situation): number {
  const until = s.detail?.kind === "limit" ? s.detail.until : undefined;
  if (until) return Math.max(0, (until.getTime() - s.now.getTime()) / 1_000);
  return s.c.failure?.retryAfter ?? 0;
}

/** 'shortly', 'in a few seconds' or a relative timestamp, for the approved description tail. */
function retryPhrase(seconds: number, now: Date): string {
  if (!(seconds > 0)) return "shortly";
  if (seconds < 5) return "in a few seconds";
  return when(new Date(now.getTime() + Math.ceil(seconds) * 1_000), "R");
}

/** Catalog wording for waits whose stored messages are internal (approved errors-and-style#10). */
const WAIT_TEXT: Readonly<Record<string, string>> = {
  rate_limited: "The Lodestone is limiting requests right now.",
  transient: "Discord settings changed while TaruBot was working on this.",
  stopping: "TaruBot is restarting right now.",
};

/**
 * A token not yet visible (approved characters#10, reproduced as drawn): pending, the checklist,
 * and Check again in place. The card adds no deadline field; the approved description's "before
 * your token expires" points back to the Token expires field on /claim's card.
 */
function pendingProofView(s: Situation): FailureView {
  const proof = s.detail?.kind === "proof" ? s.detail : undefined;
  if (!proof)
    return {
      concept: "pending_proof",
      tone: "pending",
      title: "Token not on the Lodestone yet",
      lead: s.message ?? "The Lodestone hasn't published your token yet.",
      unchanged: "none",
    };
  const id = decimal(proof.character.id) ? proof.character.id : undefined;
  return {
    concept: "pending_proof",
    tone: "pending",
    title: "Token not on the Lodestone yet",
    lead: [
      `The Lodestone hasn't published the token for **${plain(proof.character.name, HOUSE_LIMITS.characterName)}** yet. This often takes a few minutes after you save.`,
      "",
      "• Check that you saved the exact token from your latest `/claim`.",
      "• If you ran `/claim` more than once, only the newest token works.",
      "",
      `Then run ${code(id ? `/verify character:${id}` : "/verify")} again before your token expires.`,
    ].join("\n"),
    unchanged: "none",
    buttons: id ? [verifyButton("again", id)] : [],
  };
}

/** Time-bound refusals: pending tone with a Try again field. */
function waitView(s: Situation): FailureView {
  if (s.c.code === "pending_proof") return pendingProofView(s);
  const limit = s.detail?.kind === "limit" ? s.detail.limit : undefined;
  const seconds = waitSeconds(s);
  const tryAgain: FieldSpec = { name: "Try again", value: retryWhen(seconds, s.now), inline: true };
  const catalog = WAIT_TEXT[s.c.code];
  const base = {
    tone: "pending" as const,
    unchanged: "changed" as const,
    fields: [tryAgain],
  };
  if (limit === "claims_own")
    return {
      ...base,
      concept: "wait.claims_own",
      title: "Too many unfinished claims",
      lead: s.message ?? "You have several claims waiting to be verified.",
    };
  if (limit === "apply")
    return {
      ...base,
      concept: "wait.apply",
      title: "You can apply again later",
      lead: s.message ?? "Your last application was declined recently.",
    };
  if (limit === "issue")
    return {
      ...base,
      concept: "wait.issue",
      title: "You can send another report later",
      lead: s.message ?? "A report was sent a few minutes ago.",
    };
  // 2.28.0: /suggest's own limits, and GitHub's rate limit on new issues, read alike.
  if (limit === "suggest")
    return {
      ...base,
      concept: "wait.suggest",
      title: "You can suggest again later",
      lead: s.message ?? "You sent a suggestion recently.",
    };
  return {
    ...base,
    concept: "wait.retry",
    title: "Please wait a moment",
    // Catalog wording says when; a stored message's own 'Try again …' moves after the no-change.
    ...(catalog
      ? { lead: catalog, tail: `You can try again ${retryPhrase(seconds, s.now)}.` }
      : retryLast(s.message ?? "TaruBot is busy right now.")),
    diagnostic: catalog !== undefined,
  };
}

// upstream ------------------------------------------------------------------------------------

/** The Lodestone, Discord's API or GitHub failed or returned something unusable. */
function upstreamView(s: Situation): FailureView {
  // 2.28.0: GitHub didn't confirm a /suggest post, which may exist anyway. The attempt counts
  // toward the member's limits, so the card asks them to look before sending it again.
  if (s.detail?.kind === "github")
    return {
      concept: "upstream.github",
      tone: "warning",
      title: "GitHub didn't confirm your suggestion",
      lead: "TaruBot couldn't get an answer from GitHub, so your suggestion may or may not have been posted.",
      tail: "Check TaruBot's GitHub issues before sending it again. This try counts toward your limits either way.",
      unchanged: "unknown",
      diagnostic: true,
    };
  const discord = s.detail?.kind === "discord" ? s.detail.what : undefined;
  if (discord === "member_list")
    return {
      concept: "upstream.member_list",
      tone: "warning",
      title: "Couldn't read the member list",
      ...retryLast(
        s.message ?? "Discord didn't return the complete member list. Try again in a minute.",
      ),
      unchanged: "changed",
      fields: [
        s.scope.path === "config roles officer" && {
          name: "Tip",
          value:
            "If current Officer-role holders don't need to stay officers, use `adopt_holders:false`. That doesn't need the member list.",
        },
      ],
    };
  if (discord === "join_context") {
    // The gateway names the member it lacked a join time for: "your" only when that is the
    // viewer (or no member is named, or no viewer is known yet, when only the presser can have
    // been read); an officer acting on someone else gets neutral wording.
    const user =
      s.detail?.kind === "discord" && s.detail.what === "join_context" ? s.detail.user : undefined;
    const self = user === undefined || s.viewer === undefined || user === s.viewer.userId;
    return {
      concept: "upstream.join_context",
      tone: "warning",
      title: self ? "Couldn't read your join details" : "Couldn't read that member's join details",
      ...retryLast(
        self
          ? "Discord didn't include your join details. Try again in a moment."
          : (s.message ??
              `Discord didn't include join details for ${decimal(user) ? mentionUser(user) : "that member"}. Try again in a moment.`),
      ),
      unchanged: "changed",
    };
  }
  if (discord === "api")
    return {
      concept: "upstream.discord",
      tone: "warning",
      title: "Discord isn't responding",
      lead: "Discord didn't answer TaruBot just now.",
      tail: "Try again in a minute.",
      unchanged: "unknown",
      diagnostic: true,
    };
  if (s.detail?.kind === "resource" && s.detail.resource === "biography")
    return {
      concept: "upstream.biography",
      tone: "warning",
      title: "Couldn't read the biography",
      lead:
        s.message ??
        "TaruBot couldn't read the biography section of the Lodestone page. Your token is still valid; try again in a few minutes.",
      unchanged: "none",
    };
  // A token stays valid through a Lodestone outage, which /verify says (the copy never says
  // "challenge").
  const verifying = s.scope.root === "verify" || s.scope.prefix === "verify";
  const still = verifying ? " Your token is still valid." : "";
  // Not an outage: the owner made the profile private, and only they can make it public again.
  if (s.c.code === "private_profile")
    return {
      concept: "upstream.private_profile",
      tone: "warning",
      title: "Lodestone profile is private",
      lead: `${s.message ?? "That character's Lodestone profile is private."} TaruBot can't read a private profile.${still}`,
      tail: "Make the character's Lodestone profile public, then try again.",
      unchanged: "changed",
    };
  const base = {
    tone: "warning" as const,
    unchanged: "changed" as const,
    tail: "Try again in a few minutes.",
    diagnostic: true,
  };
  if (s.c.code === "incomplete")
    return {
      ...base,
      concept: "upstream.lodestone_incomplete",
      title: "Lodestone results incomplete",
      lead: `The Lodestone returned incomplete results just now.${still}`,
    };
  if (s.c.code === "invalid_response")
    return {
      ...base,
      concept: "upstream.lodestone_page",
      title: "Unexpected Lodestone page",
      lead: `The Lodestone returned a page TaruBot couldn't read.${still}`,
    };
  return {
    ...base,
    concept: "upstream.lodestone",
    title: "The Lodestone isn't responding",
    lead: `TaruBot couldn't reach the Lodestone just now; it may be down for maintenance.${still}`,
  };
}

// blocked, paused, eligible -------------------------------------------------------------------

/**
 * Discord permissions, hierarchy or a deleted role or channel stopped the change. Members get
 * 'Server setup issue' and the reference to pass on; officers get the approved message, the
 * affected role or channel, and how to fix it (approved errors-and-style#8 and #9).
 */
function blockedView(s: Situation): FailureView {
  // A raw Discord error may have arrived partway through the operation.
  const unchanged: Unchanged = s.c.failure ? "changed" : "unknown";
  if (!s.officer)
    return {
      concept: "blocked",
      tone: "warning",
      title: "Server setup issue",
      lead: "Something in this server's Discord setup is stopping TaruBot from doing this.",
      unchanged,
      fields: [
        {
          name: "What you can do",
          value:
            "Tell an officer and include the reference below. They can see exactly what to fix with /config validate.",
        },
      ],
    };
  const resource = s.detail?.kind === "resource" ? s.detail : undefined;
  const id = decimal(resource?.id) ? resource?.id : undefined;
  const role = resource?.resource === "role" ? id : undefined;
  const channel = resource?.resource === "channel" ? id : undefined;
  return {
    concept: "blocked",
    tone: "warning",
    title: "Discord permissions need attention",
    lead:
      s.message ??
      "Discord refused the change: TaruBot is missing a permission, or a role or channel it needs was deleted.",
    unchanged,
    diagnostic: !s.c.failure,
    fields: [
      role !== undefined && {
        name: "Affected",
        value: `${mentionRole(role)} (${code(role)})`,
        inline: true,
      },
      channel !== undefined && {
        name: "Affected",
        value: `${mentionChannel(channel)} (${code(channel)})`,
        inline: true,
      },
      // How to fix only when the throw site names that remedy: a refusal about the chosen role or
      // channel itself (an integration role, admin permissions, a reserved channel) has none.
      role !== undefined &&
        resource?.fix === "hierarchy" && {
          name: "How to fix",
          value:
            "Server Settings → Roles: drag the TaruBot role above this role and give it Manage Roles.",
        },
      channel !== undefined &&
        resource?.fix === "channel_permissions" && {
          name: "How to fix",
          value:
            "Channel settings → Permissions: give the TaruBot role the permissions listed above.",
        },
      // TaruBot's own member entry denies it (2.35.0): a role allow can't lift a member deny.
      channel !== undefined &&
        resource?.fix === "member_entry" && {
          name: "How to fix",
          value:
            "Channel settings → Permissions → TaruBot (the member entry, not the role): remove the denies named above.",
        },
      { name: "Then", value: "Run `/config validate` to re-check every role and channel." },
    ],
  };
}

/** Discord changes are off (awaiting activation, or for the whole deployment). */
function pausedView(s: Situation): FailureView {
  return {
    concept: "paused",
    tone: "pending",
    title: "Discord changes paused",
    lead: "TaruBot won't change roles, nicknames or channels in this server until activation finishes.",
    unchanged: "changed",
    diagnostic: true,
    fields: [
      s.officer && {
        name: "Next step",
        value: "`/config validate` shows whether this server is ready for activation.",
      },
    ],
  };
}

/** The user already has the access they asked for (approved errors-and-style#20). */
function eligibleView(s: Situation): FailureView {
  return {
    concept: "eligible",
    tone: "info",
    title: "No application needed",
    lead:
      s.message ??
      "You already have member or guest access here. If a role looks missing, TaruBot will restore it automatically.",
    unchanged: "none",
    fields: [
      {
        name: "If something looks wrong",
        value: "Run /refresh, or ask an officer to check /guest status.",
      },
    ],
  };
}

// unexpected ----------------------------------------------------------------------------------

/**
 * No approved explanation (approved errors-and-style#27). The description never includes the
 * error's message, stack or SDK text. After execute returned (phase 'deliver') the request may
 * have been saved, so the card says so instead; ledger commands warn about recording twice.
 */
function unexpectedView(s: Situation, ref: string, deliver: boolean): FailureView {
  return {
    concept: "unexpected",
    tone: "error",
    title: "Something went wrong",
    lead: deliver
      ? "Your request may have been saved, but TaruBot couldn't show the result."
      : "TaruBot hit an unexpected problem and didn't finish this request.",
    unchanged: "none",
    diagnostic: true,
    fields: [
      decimal(ref) && { name: "Reference", value: code(ref), inline: true },
      {
        name: "What you can do",
        value: s.officer
          ? "Find this reference in the bot logs (operation field)."
          : "Share the reference with an officer.",
      },
      s.scope.path !== undefined &&
        LEDGER_MUTATIONS.has(s.scope.path) && {
          name: "Before retrying",
          value:
            "If you were recording gil, check `/ledger history` first so the entry isn't recorded twice.",
        },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Assembly

/** Category to view; each view picks its concept from the code and detail. */
const VIEWS: Readonly<
  Record<Exclude<FailureCategory, "unexpected">, (s: Situation) => FailureView>
> = {
  input: inputView,
  forbidden: forbiddenView,
  setup: setupView,
  not_found: notFoundView,
  ambiguous: ambiguousView,
  conflict: conflictView,
  stale: staleView,
  wait: waitView,
  eligible: eligibleView,
  upstream: upstreamView,
  blocked: blockedView,
  paused: pausedView,
};

/** Build the situation and view for a caught error. */
function view(error: unknown, options: FailureReplyOptions): { s: Situation; v: FailureView } {
  const c = classifyFailure(error);
  const s: Situation = {
    c,
    message: c.failure?.message,
    detail: c.detail,
    viewer: options.viewer,
    officer: options.viewer !== undefined && isOfficer(options.viewer),
    scope: parseScope(options.scope),
    confirmed: options.confirmed === true,
    now: options.now ?? new Date(),
  };
  const deliver = options.phase === "deliver";
  const v =
    deliver || c.category === "unexpected"
      ? unexpectedView(s, options.ref, deliver)
      : VIEWS[c.category](s);
  return { s, v };
}

/** The no-change sentence for this view and scope, if any. */
function unchangedSentence(v: FailureView, s: Situation): string | undefined {
  if (v.unchanged === "none") return undefined;
  if (ALREADY_SAID.test(v.lead)) return undefined;
  // Only /setup onboarding confirm:true creates roles and rooms to reuse; its dry run creates
  // nothing, and /setup overrides (2.35.0) writes only TaruBot's own channel entries, so their
  // refusals take the ordinary sentence.
  if (s.scope.root === "setup" && s.scope.path !== "setup overrides" && s.confirmed)
    return SETUP_REUSE;
  if (v.unchanged === "unknown") return undefined;
  return v.unchanged === "recorded" ? NOTHING_RECORDED : NOTHING_CHANGED;
}

/** The officer Diagnostic field: the catalog code and the stored message or error class. */
function diagnosticField(v: FailureView, s: Situation): FieldSpec | undefined {
  if (!s.officer || !v.diagnostic) return undefined;
  const text = s.message ?? s.c.source;
  return {
    name: "Diagnostic (officers only)",
    value: `${code(s.c.code)}: ${cutMarkdown(text, HOUSE_LIMITS.userText)}`,
  };
}

/**
 * Render any caught error as its approved failure card. Pure apart from reading the clock when no
 * `now` is given; the router reports the error separately with the same classification, so the
 * footer's code and Ref always match the log entry.
 */
export function failureReply(error: unknown, options: FailureReplyOptions): Presented {
  const { s, v } = view(error, options);
  const description = [v.lead, unchangedSentence(v, s), v.tail]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return reply({
    tone: v.tone,
    title: v.title,
    description: cutMarkdown(description, HOUSE_LIMITS.description),
    fields: [...(v.fields ?? []), diagnosticField(v, s)],
    footer: [`Code ${s.c.code}`, `Ref ${options.ref}`],
    buttons: v.buttons ?? [],
  });
}

/** The concept a caught error renders as, for consistency tests and docs. */
export function failureConcept(error: unknown, options: FailureReplyOptions): FailureConcept {
  return view(error, options).v.concept;
}

/**
 * Whether a failure re-renders the screen its button came from, so an update-mode click edits
 * the source in place instead of sending a follow-up: the pending-token card, whose Check again
 * button re-runs the same check.
 */
export function rendersInPlace(error: unknown): boolean {
  const c = classifyFailure(error);
  return c.code === "pending_proof" && c.detail?.kind === "proof";
}
