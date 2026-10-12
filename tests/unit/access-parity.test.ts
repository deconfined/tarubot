/**
 * Differential access parity (2.44.0, RBAC): the permission model must give everyone exactly the
 * access 2.43.0 gave them, apart from the owner-approved deltas in DELTAS. The 2.43.0 predicates are
 * frozen below, copied verbatim from origin/main (174ecd1), and every decision point that 2.43.0
 * made from `officer`, `serverManager` and `manageRoles` is evaluated both ways, for every
 * combination of Discord authority, managed roles, TaruBot's Administrator state and the facts
 * that decision reads. A disagreement fails unless it takes access away and a delta names it; a
 * delta no disagreement needs fails too, so the list can't hide a stale entry.
 *
 * Rank evidence is an input here, not computed: `officerRoleCounts` is given to both sides, so
 * D1–D3 (which links and roster states make the Officer role count) are tests/unit/ranks.test.ts's
 * subject. memberEligible is an input (`eligible`) for the same reason, which makes D6 visible.
 *
 * 2.45.0 (per-person moderation) adds pauses, which 2.43.0 had no notion of. The comparison runs
 * on people with no pause, so every decision point that gained a pause check (/suggest, mod mail,
 * My roles, the ledger, the baseline commands) is shown to answer as 2.43.0 did for everyone not
 * paused; a separate test shows what a pause takes away and what it deliberately leaves open. The
 * modules and pages 2.45.0 introduced (NEW_IN_2_45_0) have nothing to compare with and are held
 * to their own stated rules instead, so the inventory check stays exact.
 */
import { describe, expect, test } from "bun:test";
import { CONFIG_PERMISSION, LEDGER_PERMISSION } from "../../src/application/service.js";
import { loadCommands, loadComponents } from "../../src/bot/discovery.js";
import { type Audience, audienceOf, viewerOf } from "../../src/discord/presenters/audience.js";
import { mayAccess, mayUse } from "../../src/domain/modmail.js";
import {
  type Actor,
  authorize,
  authorizeOwner,
  can,
  isStaff,
  requireAnyPermission,
  requireNotPaused,
  requirePermission,
  selfServiceAccess,
} from "../../src/domain/policy.js";
import { PERMISSION_IDS, type PermissionId } from "../../src/domain/rbac.js";
import { maySuggest } from "../../src/domain/suggestions.js";
import { Failure } from "../../src/domain/values.js";
import { admits } from "../../src/web/access.js";
import { loadPages } from "../../src/web/pages.js";
import { type ActorSpec, accessOf } from "../fixtures/actors.js";

// ================================================================================================
// FROZEN 2.43.0 (origin/main at 174ecd1). Copied verbatim from src/domain/policy.ts,
// src/web/access.ts, src/domain/modmail.ts, src/domain/suggestions.ts and
// src/discord/presenters/audience.ts; only the names gain a `legacy` prefix and the actor type is
// LegacyActor. Never edit this block to match src: it is the reference 2.44.0 is held to.
// ================================================================================================

/** 2.43.0's Actor (src/domain/policy.ts), its comments trimmed. */
interface LegacyActor {
  guildId: string;
  userId: string;
  officer: boolean;
  manageRoles: boolean;
  serverManager?: boolean;
  roleIds?: readonly string[];
  member?: boolean;
  guest?: boolean;
  botAdministrator?: boolean;
  timedOut?: boolean;
}

// src/domain/policy.ts
const legacySelfServiceAccess = (actor: LegacyActor): boolean =>
  actor.officer ||
  ((actor.member === true || actor.guest === true) && actor.botAdministrator === false);

function legacyAuthorizeRoleManager(actor: LegacyActor): void {
  if (!(actor.serverManager ?? actor.officer) || !actor.manageRoles) {
    throw new Failure(
      "forbidden",
      "Changing who has officer authority needs Discord's Manage Server and Manage Roles permissions. Bot officer access isn't enough.",
      0,
      { kind: "scope", scope: "manager" },
    );
  }
}

const LEGACY_OFFICERS_ONLY = "Only FC officers can do that.";

function legacyAuthorize(
  actor: LegacyActor,
  guildId: string,
  level: "user" | "officer",
  owner?: string,
): void {
  if (actor.guildId !== guildId)
    throw new Failure("forbidden", "That record belongs to another server.", 0, {
      kind: "scope",
      scope: "test_guild",
    });
  if (level === "officer" && !actor.officer)
    throw new Failure("forbidden", LEGACY_OFFICERS_ONLY, 0, {
      kind: "scope",
      scope: "officer",
    });
  if (owner !== undefined && owner !== actor.userId && !actor.officer)
    throw new Failure(
      "forbidden",
      "You can view only your own records. Officers can look up other members.",
      0,
      { kind: "scope", scope: "owner" },
    );
}

// src/web/access.ts
const LEGACY_PAGE_ACCESS = ["officer", "manager", "member", "guest"] as const;

type LegacyPageAccess = (typeof LEGACY_PAGE_ACCESS)[number];

const LEGACY_FLAG: Readonly<Record<LegacyPageAccess, (actor: LegacyActor) => boolean>> = {
  officer: (actor) => actor.officer,
  manager: (actor) => {
    try {
      legacyAuthorizeRoleManager(actor);
      return true;
    } catch (error) {
      // The rule refuses with a Failure; anything else is a bug and must not read as "no".
      if (error instanceof Failure) return false;
      throw error;
    }
  },
  member: (actor) => actor.member === true && actor.botAdministrator === false,
  guest: (actor) => actor.guest === true && actor.botAdministrator === false,
};

function legacyAdmits(actor: LegacyActor, access: readonly LegacyPageAccess[]): boolean {
  return access.some((flag) => Object.hasOwn(LEGACY_FLAG, flag) && LEGACY_FLAG[flag](actor));
}

// src/domain/modmail.ts
const legacyMayOpen = (actor: LegacyActor): boolean =>
  (actor.member === true || actor.guest === true) && actor.botAdministrator === false;

function legacyMayAccess(actor: LegacyActor, openerId: string): boolean {
  if (actor.officer) return true;
  return (
    actor.userId === openerId &&
    (actor.member === true || actor.guest === true) &&
    actor.botAdministrator === false
  );
}

// src/domain/suggestions.ts
function legacyMaySuggest(
  actor: Pick<LegacyActor, "roleIds">,
  roles: { readonly member_role_id: string | null; readonly guest_role_id: string | null },
): boolean {
  const held = actor.roleIds ?? [];
  return [roles.member_role_id, roles.guest_role_id].some(
    (role) => role !== null && held.includes(role),
  );
}

// src/discord/presenters/audience.ts (audienceOf, and viewerOf's manageGuild)
function legacyAudienceOf(actor: LegacyActor): Audience {
  if ((actor.serverManager ?? actor.officer) && actor.manageRoles) return "manager";
  return actor.officer ? "officer" : "member";
}

const legacyManageGuild = (actor: LegacyActor): boolean => actor.serverManager ?? actor.officer;

/** 2.43.0's router access per command root (`access`, "user" when absent): all 23 roots. */
const LEGACY_COMMANDS: Readonly<Record<string, "user" | "officer">> = {
  assign: "officer",
  characters: "user",
  claim: "user",
  main: "user",
  nickname: "user",
  unassign: "officer",
  unclaim: "user",
  verify: "user",
  config: "officer",
  officer: "officer",
  setup: "officer",
  apply: "user",
  guest: "user",
  ledger: "user",
  refresh: "user",
  sync: "user",
  channel: "user",
  dashboard: "user",
  issue: "user",
  modmail: "user",
  ping: "user",
  suggest: "user",
  version: "user",
};

/** 2.43.0's router access per component prefix. */
const LEGACY_COMPONENTS: Readonly<Record<string, "user" | "officer">> = {
  config: "officer",
  details: "officer",
  "guest-apply": "user",
  guest: "officer",
  ledger: "user",
  modmail: "user",
  sync: "user",
  verify: "user",
};

/** 2.43.0's page flags per path. */
const LEGACY_PAGES: Readonly<Record<string, readonly LegacyPageAccess[]>> = {
  "/g/:guild/configuration": ["officer"],
  "/g/:guild/modmail/:number": ["member", "guest", "officer"],
  "/g/:guild/modmail": ["member", "guest", "officer"],
  "/g/:guild/my-roles": ["member", "guest", "officer"],
  "/g/:guild/role-menu": ["officer"],
  "/g/:guild/status": ["officer"],
};

/**
 * What 2.45.0 added, which has no 2.43.0 behavior to compare (per-person moderation). Each entry
 * is the permissions its gate declares. The inventory check is exactly 2.43.0's list plus these,
 * so a module or page that appears without being named here, or one named here that goes missing,
 * fails it; the comparison skips them, and "what 2.45.0 added" holds each to its stated rule.
 */
const NEW_IN_2_45_0 = {
  // /moderate's router gate admits any human member of the server: its status subcommand shows
  // anyone their own pauses. block and lift ask for moderation.block inside the service, and
  // reading someone else's status for moderation.view.
  commands: { moderate: [] },
  components: {},
  // The Moderation page: moderation.view, which only the Officer role and server managers carry.
  pages: { "/g/:guild/moderation": ["moderation.view"] },
} as const satisfies {
  commands: Readonly<Record<string, readonly PermissionId[]>>;
  components: Readonly<Record<string, readonly PermissionId[]>>;
  pages: Readonly<Record<string, readonly PermissionId[]>>;
};

/** Whether a module or page is one 2.45.0 added. */
const isNew = (kind: keyof typeof NEW_IN_2_45_0, key: string): boolean =>
  Object.hasOwn(NEW_IN_2_45_0[kind], key);

/** 2.43.0's Service.configure allowlist (src/application/service.ts), in its order. */
const LEGACY_CONFIG_FIELDS = [
  "fc_id",
  "member_role_id",
  "guest_role_id",
  "officer_role_id",
  "leader_role_id",
  "ledger_channel_id",
  "officer_notifications_channel_id",
  "changelog_channel_id",
] as const;

/** The operations 2.43.0's /ledger subcommands passed to Service.ledger. */
const LEGACY_LEDGER_OPERATIONS = ["deposit", "withdraw", "initialize", "adjust"] as const;

// ================================================================================================
// END OF FROZEN 2.43.0.
// ================================================================================================

/** One person, as both releases see them. */
interface Person {
  /** Discord's Manage Server. */
  readonly manageServer: boolean;
  /** Discord's Manage Roles. */
  readonly manageRoles: boolean;
  /** The Officer role counts for them: held, and backed by rank or a manager's grant. */
  readonly officerRoleCounts: boolean;
  /** Holds the bound Member role. */
  readonly member: boolean;
  /** Holds the bound Guest role. */
  readonly guest: boolean;
  /** TaruBot holds Administrator (undefined: not resolved, which members' gates treat as true). */
  readonly botAdministrator: boolean | undefined;
}

/** What a decision reads besides the person; each decision names the facts it varies. */
interface Facts {
  /** The record's owner, or the case's opener, is the actor. */
  readonly self: boolean;
  /** The link counts for rank: verified, imported, or assigned by a server manager. */
  readonly confersRank: boolean;
  /** Lobby onboarding is on (guilds.access_policy_enabled). */
  readonly onboarding: boolean;
  /** An officer rank is chosen (guilds.officer_rank_key). */
  readonly rankSet: boolean;
  /** TaruBot has an active guild row here; the first /config creates it. */
  readonly configured: boolean;
  /** Confirmed FC membership (Service.memberEligible). */
  readonly eligible: boolean;
  /** Mod mail is switched on (ModMail.enabledIn). */
  readonly modmailOn: boolean;
}

const FACT_DEFAULTS: Facts = {
  self: false,
  confersRank: false,
  onboarding: false,
  rankSet: false,
  configured: true,
  eligible: false,
  modmailOn: false,
};

/** A decision's answer: allowed or not, or who a reply or page is written for. */
type Outcome = boolean | Audience | "none";

/** One decision point: 2.43.0's rule over its actor, and the 2.44.0 code over the new one. */
interface Decision {
  readonly name: string;
  readonly reads?: readonly (keyof Facts)[];
  readonly legacy: (actor: LegacyActor, facts: Facts) => Outcome;
  readonly next: (actor: Actor, facts: Facts) => Outcome;
}

const GUILD = "guild";
const SELF = "actor";
const OTHER = "someone-else";
const BINDINGS = { member_role_id: "member-role", guest_role_id: "guest-role" } as const;

/** The owner or opener the facts describe. */
const ownerOf = (facts: Facts): string => (facts.self ? SELF : OTHER);

const BOOLS = [false, true] as const;

/** Every person: 2^5 authority and role combinations, times three Administrator states. */
const PEOPLE: readonly Person[] = BOOLS.flatMap((manageServer) =>
  BOOLS.flatMap((manageRoles) =>
    BOOLS.flatMap((officerRoleCounts) =>
      BOOLS.flatMap((member) =>
        BOOLS.flatMap((guest) =>
          [true, false, undefined].map((botAdministrator) => ({
            manageServer,
            manageRoles,
            officerRoleCounts,
            member,
            guest,
            botAdministrator,
          })),
        ),
      ),
    ),
  ),
);

/** Without a guild row no role is bound, so none is held, and nothing is switched on. */
const possible = (person: Person, facts: Facts): boolean =>
  facts.configured ||
  (!person.officerRoleCounts &&
    !person.member &&
    !person.guest &&
    !facts.onboarding &&
    !facts.rankSet);

const heldRoles = (person: Person): string[] => [
  ...(person.member ? [BINDINGS.member_role_id] : []),
  ...(person.guest ? [BINDINGS.guest_role_id] : []),
];

const administrator = (person: Person) =>
  person.botAdministrator === undefined ? {} : { botAdministrator: person.botAdministrator };

/**
 * 2.43.0's resolved actor (gateway.actor, then Service.enrichActor): Manage Server made an officer
 * outright, and otherwise the Officer role made one when it counted.
 */
const legacyActorOf = (person: Person): LegacyActor => ({
  guildId: GUILD,
  userId: SELF,
  officer: person.manageServer || person.officerRoleCounts,
  manageRoles: person.manageRoles,
  serverManager: person.manageServer,
  roleIds: heldRoles(person),
  member: person.member,
  guest: person.guest,
  ...administrator(person),
});

/**
 * 2.43.0's actor as owner decision Q2 A would have left it: Manage Server makes no officer, so only
 * the Officer role does. Everything else is as 2.43.0 resolved it, Manage Server included.
 */
const legacyNoQ2AActorOf = (person: Person): LegacyActor => ({
  ...legacyActorOf(person),
  officer: person.officerRoleCounts,
});

/**
 * 2.44.0's resolved actor, its access from the fixture that mirrors Service.enrichActor; with
 * `paused` (2.45.0), the pauses the resolver would have read for them.
 */
function nextActorOf(person: Person, paused?: ActorSpec["paused"]): Actor {
  const spec = {
    guildId: GUILD,
    userId: SELF,
    manageRoles: person.manageRoles,
    serverManager: person.manageServer,
    roleIds: heldRoles(person),
    member: person.member,
    guest: person.guest,
    ...administrator(person),
  };
  return {
    ...spec,
    access: accessOf({ ...spec, officer: person.officerRoleCounts, ...(paused && { paused }) }),
  };
}

/** Each person with both releases' actors, and 2.43.0's without Q2A's officer, built once. */
const ACTORS = PEOPLE.map((person) => ({
  person,
  legacy: legacyActorOf(person),
  legacyNoQ2A: legacyNoQ2AActorOf(person),
  next: nextActorOf(person),
}));

/** Every assignment of the facts a decision reads, the rest at their defaults. */
function situations(reads: readonly (keyof Facts)[]): Facts[] {
  let all: Facts[] = [FACT_DEFAULTS];
  for (const key of reads)
    all = all.flatMap((facts) => BOOLS.map((value) => ({ ...facts, [key]: value })));
  return all;
}

/** True when `check` returns, false when it refuses with a forbidden Failure; else a bug. */
function passes(check: () => void): boolean {
  try {
    check();
    return true;
  } catch (error) {
    if (error instanceof Failure && error.code === "forbidden") return false;
    throw error;
  }
}

/** Service.configure's Manage Roles refusal for role fields, the same in both releases. */
const manageRolesRefusal = (): Failure =>
  new Failure("forbidden", "Choosing access roles needs Discord's Manage Roles permission.", 0, {
    kind: "scope",
    scope: "manage_roles",
  });

/** Service's membershipNeeded refusal, the same in both releases. */
const membershipNeeded = (): Failure =>
  new Failure(
    "forbidden",
    "The FC ledger is for confirmed members of this server's Free Company.",
    0,
    { kind: "scope", scope: "membership" },
  );

/** Service's memberRoleNeeded refusal (2.44.0): confirmed membership, but not the permission. */
const memberRoleNeeded = (permission: "ledger.view" | "ledger.deposit"): Failure =>
  new Failure(
    "forbidden",
    "The FC ledger is for confirmed members of this server's Free Company who hold its Member role.",
    0,
    { kind: "scope", scope: "membership", permission },
  );

/** The actor half of ModMail.staticRefusal, unchanged: Member or Guest, and no Administrator. */
const staticAllows = (actor: Pick<Actor, "member" | "guest" | "botAdministrator">): boolean =>
  (actor.member === true || actor.guest === true) && actor.botAdministrator === false;

/** A 2.43.0 officer-level check that names one permission now. */
const officerLevel = (name: string, id: PermissionId): Decision => ({
  name,
  legacy: (actor) => passes(() => legacyAuthorize(actor, actor.guildId, "officer")),
  next: (actor) => passes(() => requirePermission(actor, actor.guildId, id)),
});

/** A 2.43.0 authorizeRoleManager check that names one fixed permission now. */
const managerLevel = (name: string, id: PermissionId): Decision => ({
  name,
  legacy: (actor) => passes(() => legacyAuthorizeRoleManager(actor)),
  next: (actor) => passes(() => requirePermission(actor, actor.guildId, id)),
});

/** A 2.43.0 check that admitted anyone in the server, which names a baseline permission now. */
const anyone = (name: string, id: PermissionId): Decision => ({
  name,
  legacy: (actor) => passes(() => legacyAuthorize(actor, actor.guildId, "user")),
  next: (actor) => passes(() => requirePermission(actor, actor.guildId, id)),
});

/** A 2.43.0 `actor.officer` read that only shapes a result, which reads something else now. */
const officerFlag = (name: string, read: (actor: Actor) => boolean): Decision => ({
  name,
  legacy: (actor) => actor.officer,
  next: read,
});

/** A record lookup that 2.43.0 authorized with an owner, authorizeOwner now. */
const ownRecord = (name: string): Decision => ({
  name,
  reads: ["self"],
  legacy: (actor, facts) =>
    passes(() => legacyAuthorize(actor, actor.guildId, "user", ownerOf(facts))),
  next: (actor, facts) => passes(() => authorizeOwner(actor, actor.guildId, ownerOf(facts))),
});

/**
 * Service.configure's authorization in each release, in its own order, for one field and the
 * permission src's CONFIG_PERMISSION names for it.
 */
const configure = (field: string, id: PermissionId): Decision => ({
  name: `Service.configure(${field})`,
  reads: ["onboarding", "rankSet", "configured"],
  legacy: (actor, facts) =>
    passes(() => {
      legacyAuthorize(actor, actor.guildId, "officer");
      if (field === "officer_role_id" || field === "leader_role_id")
        legacyAuthorizeRoleManager(actor);
      if (facts.onboarding && field.endsWith("role_id")) legacyAuthorizeRoleManager(actor);
      if (field === "fc_id" && facts.rankSet) legacyAuthorizeRoleManager(actor);
      if (field.endsWith("role_id") && !actor.manageRoles) throw manageRolesRefusal();
    }),
  next: (actor) =>
    passes(() => {
      authorize(actor, actor.guildId);
      requirePermission(actor, actor.guildId, id);
      if (field.endsWith("role_id") && !actor.manageRoles) throw manageRolesRefusal();
    }),
});

const WITHDRAWALS =
  "Only officers can record withdrawals, opening balances and corrections. Members can record deposits with /ledger deposit.";

/** Service.ledger's authorization for one operation and src's LEDGER_PERMISSION for it. */
const ledger = (operation: string, id: PermissionId): Decision => ({
  name: `Service.ledger(${operation})`,
  reads: ["eligible"],
  legacy: (actor, facts) =>
    passes(() => {
      if (operation !== "deposit") {
        if (!actor.officer)
          throw new Failure("forbidden", WITHDRAWALS, 0, { kind: "scope", scope: "officer" });
        legacyAuthorize(actor, actor.guildId, "officer");
      }
      if (!actor.officer && !facts.eligible) throw membershipNeeded();
    }),
  // Without ledger.audit a deposit checks membership first, then the permission (memberRoleNeeded).
  next: (actor, facts) =>
    passes(() => {
      if (operation !== "deposit") requirePermission(actor, actor.guildId, id, WITHDRAWALS);
      if (operation === "deposit") {
        // A pause is reported first, as one (Service.ledger); nobody in this comparison is paused.
        requireNotPaused(actor, "ledger.deposit");
        if (!can(actor, "ledger.audit") && !facts.eligible) throw membershipNeeded();
        if (!can(actor, "ledger.deposit")) throw memberRoleNeeded("ledger.deposit");
      }
    }),
});

/** Service.ledgerRead's authorization, for the current FC's ledger or a previous one's. */
const ledgerRead = (current: boolean): Decision => ({
  name: `Service.ledgerRead(${current ? "current" : "previous"} FC)`,
  reads: ["eligible"],
  legacy: (actor, facts) =>
    passes(() => {
      if (!current) {
        if (!actor.officer)
          throw new Failure("forbidden", "Only officers can view a previous FC's ledger.", 0, {
            kind: "scope",
            scope: "officer",
          });
        legacyAuthorize(actor, actor.guildId, "officer");
      }
      if (!actor.officer && !facts.eligible) throw membershipNeeded();
    }),
  // The real order: a pause on ledger.view first and for everyone, ledger.audit holders included
  // (it is what opens the ledger for them, so a pause must not hide behind it); then the previous
  // FC's ledger.audit; then, only without ledger.audit, membership and ledger.view
  // (memberRoleNeeded).
  next: (actor, facts) =>
    passes(() => {
      requireNotPaused(actor, "ledger.view");
      if (!current)
        requirePermission(
          actor,
          actor.guildId,
          "ledger.audit",
          "Only officers can view a previous FC's ledger.",
        );
      if (!can(actor, "ledger.audit")) {
        if (!facts.eligible) throw membershipNeeded();
        if (!can(actor, "ledger.view")) throw memberRoleNeeded("ledger.view");
      }
    }),
});

/** A mod mail case reached through ModMail.accessible (null, a 404, when not). */
const reaches = {
  legacy: (actor: LegacyActor, facts: Facts) => legacyMayAccess(actor, ownerOf(facts)),
  next: (actor: Actor, facts: Facts) => mayAccess(actor, ownerOf(facts)),
};

/** ModMail.reply, close and reopen: reach the case, then write on the side the actor is on. */
const caseWrite = (name: string, reopen: boolean): Decision => ({
  name,
  reads: ["self"],
  // 2.43.0: reaching the case was enough on either side; only a member's reopen was refused.
  legacy: (actor, facts) => reaches.legacy(actor, facts) && !(reopen && facts.self),
  next: (actor, facts) =>
    reaches.next(actor, facts) &&
    passes(() => {
      if (!facts.self) requirePermission(actor, actor.guildId, "modmail.respond");
    }) &&
    !(reopen && facts.self),
});

/** The decisions that need no module discovery, by source file. */
const DECISIONS: readonly Decision[] = [
  // src/application/service.ts
  ownRecord("Service.characters"),
  ownRecord("Service.guestStatus"),
  officerFlag("Service.syncStatus lists everyone's work", (actor) => can(actor, "sync.view_all")),
  officerLevel("Service.validate", "config.view"),
  officerLevel("Service.applicationChoices", "guests.decide"),
  ownRecord("Service.autocomplete(verify)"),
  {
    name: "Service.autocomplete(character)",
    reads: ["self", "confersRank"],
    legacy: (actor, facts) =>
      passes(() => legacyAuthorize(actor, actor.guildId, "user", ownerOf(facts))),
    // Someone without admin.links is offered only the other member's links they may remove.
    next: (actor, facts) =>
      passes(() => authorizeOwner(actor, actor.guildId, ownerOf(facts))) &&
      (facts.self || can(actor, "admin.links") || !facts.confersRank),
  },
  ...Object.entries(CONFIG_PERMISSION).map(([field, id]) => configure(field, id)),
  officerLevel("Service.configureGuestApplications", "config.guest_applications"),
  managerLevel("Service.configureOfficerRank", "admin.ranks"),
  managerLevel("Service.configureRoleLayout", "admin.roles"),
  {
    name: "Service.unlinkCompany",
    reads: ["rankSet"],
    legacy: (actor, facts) =>
      passes(() => {
        legacyAuthorize(actor, actor.guildId, "officer");
        if (facts.rankSet) legacyAuthorizeRoleManager(actor);
      }),
    next: (actor) => passes(() => requirePermission(actor, actor.guildId, "admin.fc")),
  },
  anyone("Service.claim", "characters.claim"),
  anyone("Service.verify", "characters.claim"),
  officerLevel("Service.assign", "characters.assign"),
  {
    name: "Service.assign records rank authority",
    legacy: (actor) => (actor.serverManager ?? actor.officer) && actor.manageRoles,
    next: (actor) => can(actor, "admin.links"),
  },
  {
    name: "Service.unclaim",
    reads: ["self", "confersRank"],
    legacy: (actor, facts) =>
      passes(() => legacyAuthorize(actor, actor.guildId, facts.self ? "user" : "officer")),
    next: (actor, facts) =>
      passes(() => {
        if (facts.self) authorize(actor, actor.guildId);
        else requirePermission(actor, actor.guildId, "characters.unassign");
        if (!facts.self && facts.confersRank)
          requirePermission(actor, actor.guildId, "admin.links");
      }),
  },
  ...Object.entries(LEDGER_PERMISSION).map(([operation, id]) => ledger(operation, id)),
  ledgerRead(true),
  ledgerRead(false),
  anyone("Service.apply", "guests.apply"),
  officerLevel("Service.decide", "guests.decide"),
  officerLevel("Service.guestAction", "guests.manage"),
  officerLevel("Service.guestReset", "guests.manage"),
  // src/application/modmail.ts
  officerLevel("ModMail.settings", "modmail.settings"),
  officerLevel("ModMail.toggle", "modmail.settings"),
  {
    name: "ModMail.open",
    legacy: (actor) => staticAllows(actor) && legacyMayOpen(actor),
    // ModMail.open: the pause first, then the static checks on what is held (mayUse).
    next: (actor) =>
      passes(() => requireNotPaused(actor, "modmail.open")) && staticAllows(actor) && mayUse(actor),
  },
  officerLevel("ModMail.inbox", "modmail.inbox"),
  {
    name: "ModMail.mine",
    legacy: (actor) => legacyMayAccess({ ...actor, officer: false }, actor.userId),
    // The list needs mod mail held, not usable: a person who can't open cases still lists theirs.
    next: (actor) => mayUse(actor),
  },
  { name: "ModMail.caseView reaches the case", reads: ["self"], ...reaches },
  {
    name: "ModMail.caseView audience",
    reads: ["self"],
    legacy: (actor, facts) =>
      reaches.legacy(actor, facts) ? (actor.officer ? "officer" : "member") : "none",
    next: (actor, facts) =>
      reaches.next(actor, facts) ? (can(actor, "modmail.inbox") ? "officer" : "member") : "none",
  },
  {
    name: "ModMail.caseView read log",
    reads: ["self"],
    legacy: (actor, facts) => reaches.legacy(actor, facts) && actor.officer,
    next: (actor, facts) => reaches.next(actor, facts) && can(actor, "modmail.read_log"),
  },
  caseWrite("ModMail.reply", false),
  caseWrite("ModMail.close", false),
  caseWrite("ModMail.reopen", true),
  // src/application/self-roles.ts
  officerLevel("SelfRoles.editor", "rolemenu.view"),
  {
    name: "SelfRoles.edit (shaping the menu)",
    legacy: (actor) => passes(() => legacyAuthorize(actor, actor.guildId, "officer")),
    next: (actor) =>
      passes(() => {
        requirePermission(actor, actor.guildId, "rolemenu.view");
        requirePermission(actor, actor.guildId, "rolemenu.edit");
      }),
  },
  {
    name: "SelfRoles.edit (adding roles, publishing)",
    legacy: (actor) => passes(() => legacyAuthorize(actor, actor.guildId, "officer")),
    next: (actor) =>
      passes(() => {
        requirePermission(actor, actor.guildId, "rolemenu.view");
        requirePermission(actor, actor.guildId, "rolemenu.publish");
      }),
  },
  {
    name: "SelfRoles.view",
    legacy: (actor) => legacySelfServiceAccess(actor),
    next: (actor) => selfServiceAccess(actor),
  },
  {
    name: "SelfRoles.choose",
    legacy: (actor) => legacySelfServiceAccess(actor),
    // The A2 gate first, then the pause (a paused person still opens the page, view above).
    next: (actor) =>
      selfServiceAccess(actor) && passes(() => requireNotPaused(actor, "selfroles.use")),
  },
  {
    name: "SelfRoles.view shows drafts and officer notes",
    legacy: (actor) => legacySelfServiceAccess(actor) && actor.officer,
    next: (actor) => selfServiceAccess(actor) && can(actor, "rolemenu.view"),
  },
  {
    name: "SelfRoles.view checks TaruBot's Administrator",
    legacy: (actor) => legacySelfServiceAccess(actor) && actor.officer,
    next: (actor) => selfServiceAccess(actor) && isStaff(actor),
  },
  // src/application/synchronization.ts
  anyone("Synchronization.refresh", "roster.refresh"),
  {
    name: "Synchronization.refresh(force)",
    legacy: (actor) => passes(() => legacyAuthorize(actor, actor.guildId, "officer")),
    next: (actor) =>
      passes(() => {
        requirePermission(actor, actor.guildId, "roster.refresh");
        requirePermission(actor, actor.guildId, "roster.refresh_force");
      }),
  },
  // src/application/role-administration.ts and overrides.ts
  managerLevel("RoleAdministration.planSetup", "admin.setup"),
  managerLevel("RoleAdministration.setup", "admin.setup"),
  managerLevel("RoleAdministration.officer", "admin.grants"),
  managerLevel("RoleAdministration.officerReset", "admin.grants"),
  managerLevel("ChannelOverrides.run", "admin.setup"),
  // src/application/suggestions.ts and issue-reports.ts
  {
    name: "Suggestions.submit",
    legacy: (actor) => legacyMaySuggest(actor, BINDINGS),
    // The pause is reported before the membership card (Suggestions.submit).
    next: (actor) => passes(() => requireNotPaused(actor, "suggest.use")) && maySuggest(actor),
  },
  anyone("IssueReports.report", "issue.use"),
  // src/commands
  officerLevel("/assign", "characters.assign"),
  officerLevel("/assign autocomplete", "characters.assign"),
  officerLevel("/unassign", "characters.unassign"),
  officerLevel("/unassign autocomplete", "characters.unassign"),
  ownRecord("/characters"),
  officerFlag("/characters suggests every member", (actor) => can(actor, "members.view")),
  ownRecord("/guest status"),
  officerFlag("/guest status suggests every member", (actor) => can(actor, "members.view")),
  officerLevel("/guest grant, revoke, reset member autocomplete", "guests.manage"),
  officerLevel("/guest approve, deny application autocomplete", "guests.decide"),
  // src/discord/presenters/audience.ts
  { name: "audienceOf", legacy: legacyAudienceOf, next: audienceOf },
  {
    name: "viewerOf manageGuild",
    legacy: legacyManageGuild,
    next: (actor) => viewerOf(actor, "ref").manageGuild,
  },
  // src/web
  officerLevel("validateConfiguration (Configuration page)", "config.view"),
  {
    // Which view the page renders, and so which form a POST is taken as: the officers' inbox and
    // settings, or the member's cases and Open a case. A side, not a grant: each form's own
    // service call authorizes it.
    name: "Mod mail page side (view, POST op)",
    legacy: (actor) => (actor.officer ? "officer" : "member"),
    next: (actor) => (can(actor, "modmail.inbox") ? "officer" : "member"),
  },
  {
    name: "Mod mail page navigation entry",
    reads: ["modmailOn"],
    legacy: (actor, facts) => actor.officer || facts.modmailOn,
    next: (actor, facts) => can(actor, "modmail.inbox") || facts.modmailOn,
  },
  officerFlag("My roles page officer notes", isStaff),
  {
    name: "Side navigation note",
    legacy: (actor) => (actor.officer ? "officer" : "member"),
    next: (actor) => (isStaff(actor) ? "officer" : "member"),
  },
];

/** One 2.43.0 router check for a module's access level. */
const legacyGate = (actor: LegacyActor, level: "user" | "officer" | undefined): boolean =>
  passes(() => legacyAuthorize(actor, actor.guildId, level ?? "user"));

/** One 2.44.0 router check for a module's permissions. */
const nextGate = (actor: Actor, permissions: readonly PermissionId[]): boolean =>
  passes(() => requireAnyPermission(actor, actor.guildId, permissions));

type Modules = ReadonlyMap<string, { readonly permissions: readonly PermissionId[] }>;

/** The router's gates and every page's admission, from the modules src ships. */
async function discovered(): Promise<{
  decisions: Decision[];
  commands: Modules;
  components: Modules;
  pages: ReadonlyMap<string, { readonly access: readonly PermissionId[] }>;
}> {
  const [commands, components, pages] = await Promise.all([
    loadCommands(),
    loadComponents(),
    loadPages(),
  ]);
  const gate = (name: string) => commands.get(name)?.permissions ?? [];
  const decisions: Decision[] = [
    ...[...commands]
      .filter(([name]) => !isNew("commands", name))
      .map(
        ([name, command]): Decision => ({
          name: `router /${name}`,
          legacy: (actor) => legacyGate(actor, LEGACY_COMMANDS[name]),
          next: (actor) => nextGate(actor, command.permissions),
        }),
      ),
    ...[...components]
      .filter(([prefix]) => !isNew("components", prefix))
      .map(
        ([prefix, component]): Decision => ({
          name: `router component ${prefix}`,
          legacy: (actor) => legacyGate(actor, LEGACY_COMPONENTS[prefix]),
          next: (actor) => nextGate(actor, component.permissions),
        }),
      ),
    {
      // 2.43.0's execute repeated the officer check; 2.44.0's leaves it to the router and services.
      name: "/config (router, then execute)",
      legacy: (actor) =>
        legacyGate(actor, LEGACY_COMMANDS.config) &&
        passes(() => legacyAuthorize(actor, actor.guildId, "officer")),
      next: (actor) =>
        nextGate(actor, gate("config")) && passes(() => authorize(actor, actor.guildId)),
    },
    {
      // Its autocomplete has no check of its own: the router's gate is the whole decision.
      name: "/officer autocomplete",
      legacy: (actor) => legacyGate(actor, LEGACY_COMMANDS.officer),
      next: (actor) => nextGate(actor, gate("officer")),
    },
    ...[...pages]
      .filter(([path]) => !isNew("pages", path))
      .map(
        ([path, page]): Decision => ({
          name: `page ${path}`,
          legacy: (actor) => legacyAdmits(actor, LEGACY_PAGES[path] ?? []),
          next: (actor) => admits(actor, page.access),
        }),
      ),
    {
      // listServers: a server is listed, and sign-in admitted, when any page admits the person.
      // Over every page, the new ones included: that is what shows a new page widens nobody's
      // sign-in beyond what 2.43.0's pages admitted.
      name: "server list and sign-in",
      legacy: (actor) => Object.values(LEGACY_PAGES).some((flags) => legacyAdmits(actor, flags)),
      next: (actor) => [...pages.values()].some((page) => admits(actor, page.access)),
    },
    {
      // 2.43.0's get relied on the page's flags; 2.44.0's also checks sync.view_all itself.
      name: "Background work page get",
      legacy: (actor) => legacyAdmits(actor, LEGACY_PAGES["/g/:guild/status"] ?? []),
      next: (actor) =>
        admits(actor, pages.get("/g/:guild/status")?.access ?? []) &&
        passes(() => requirePermission(actor, actor.guildId, "sync.view_all")),
    },
  ];
  return { decisions, commands, components, pages };
}

/** One evaluated disagreement. */
interface Case {
  readonly decision: string;
  readonly person: Person;
  readonly facts: Facts;
  readonly legacy: Outcome;
  /** 2.43.0's answer had Manage Server made no officer (legacyNoQ2AActorOf). */
  readonly legacyNoQ2A: Outcome;
  readonly next: Outcome;
}

/** An owner-approved change: which disagreements it explains. */
interface Delta {
  readonly name: string;
  readonly covers: (disagreement: Case) => boolean;
}

const isManager = (person: Person): boolean => person.manageServer && person.manageRoles;

const UNASSIGN = new Set(["Service.unclaim", "Service.autocomplete(character)"]);
const FC_LINK = new Set(["Service.configure(fc_id)", "Service.unlinkCompany"]);
const ROLE_BINDINGS = new Set([
  "Service.configure(member_role_id)",
  "Service.configure(guest_role_id)",
  "Service.configure(officer_role_id)",
  "Service.configure(leader_role_id)",
  "Service.configureRoleLayout",
]);
const LEDGER_MEMBERSHIP = new Set(["Service.ledger(deposit)", "Service.ledgerRead(current FC)"]);
const OFFICER_COMPLETION = new Set(["router /officer", "/officer autocomplete"]);

/**
 * Every intended change, each a predicate over a disagreement. All of them take access away; a
 * disagreement that gives some is never explained by one (see narrows).
 */
const DELTAS: readonly Delta[] = [
  {
    // Owner decision Q2 A: Manage Server without Manage Roles was a full officer; it grants nothing.
    // It explains only the officer Manage Server made: 2.44.0 must still answer as 2.43.0 would
    // have without it (legacyNoQ2A), so what the person's roles gave them is kept. With the Officer
    // role counting, their officer came from the role, so nothing is Q2A's.
    name: "Q2A",
    covers: ({ person, legacyNoQ2A, next }) =>
      person.manageServer &&
      !person.manageRoles &&
      !person.officerRoleCounts &&
      legacyNoQ2A === next,
  },
  {
    // D4: removing someone else's link that counts for rank needs admin.links (server managers).
    name: "D4 /unassign",
    covers: ({ decision, person, facts }) =>
      UNASSIGN.has(decision) && !facts.self && facts.confersRank && !isManager(person),
  },
  {
    // D4: /config fc link and unlink always need a server manager (admin.fc).
    name: "D4 /config fc",
    covers: ({ decision, person }) => FC_LINK.has(decision) && !isManager(person),
  },
  {
    // D4: /config roles and role_layout always need a server manager (admin.roles).
    name: "D4 /config roles",
    covers: ({ decision, person }) => ROLE_BINDINGS.has(decision) && !isManager(person),
  },
  {
    // D5: bootstrapping an unconfigured server (the first /config) needs a server manager. With no
    // guild row no Officer role is bound, so in 2.43.0 only Manage Server could do it: every D5
    // case is also a Q2A case, and the entry stays so the delta keeps its own name.
    name: "D5",
    covers: ({ decision, person, facts }) =>
      decision.startsWith("Service.configure(") && !facts.configured && !isManager(person),
  },
  {
    // D6: the ledger's member side needs ledger.view or ledger.deposit (Member or Officer role)
    // as well as confirmed FC membership, refused with memberRoleNeeded once membership is
    // confirmed; ledger.audit still skips both.
    name: "D6",
    covers: ({ decision, person, facts }) =>
      LEDGER_MEMBERSHIP.has(decision) &&
      facts.eligible &&
      !person.member &&
      !person.officerRoleCounts &&
      !isManager(person),
  },
  {
    // /setup refuses non-managers at the router with the manager card (its service always did).
    name: "/setup router",
    covers: ({ decision, person }) => decision === "router /setup" && !isManager(person),
  },
  {
    // /officer, its autocomplete included, admits server managers only (admin.grants).
    name: "/officer autocomplete",
    covers: ({ decision, person }) => OFFICER_COMPLETION.has(decision) && !isManager(person),
  },
];

/** Order for "takes access away": allowed over refused, and wider audiences over narrower. */
const RANK: Readonly<Record<string, number>> = {
  false: 0,
  true: 1,
  none: 0,
  member: 1,
  officer: 2,
  manager: 3,
};

/** Whether 2.44.0's answer gives less than 2.43.0's. */
const narrows = (legacy: Outcome, next: Outcome): boolean =>
  typeof legacy === typeof next && (RANK[String(next)] ?? 0) < (RANK[String(legacy)] ?? 0);

/** A disagreement in words, for a failing assertion. */
function explain(disagreement: Case, reads: readonly (keyof Facts)[]): string {
  const { person, facts } = disagreement;
  const flags = Object.entries(person)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  const read = reads.map((key) => `${key}=${String(facts[key])}`).join(" ");
  return `${disagreement.decision} | ${flags}${read ? ` | ${read}` : ""} | 2.43.0=${String(disagreement.legacy)} 2.44.0=${String(disagreement.next)}`;
}

/** Evaluate every decision for every person and situation; report what no delta explains. */
function compare(decisions: readonly Decision[], deltas: readonly Delta[] = DELTAS) {
  const unexplained: string[] = [];
  const exercised = new Set<string>();
  let evaluated = 0;
  for (const decision of decisions) {
    const reads = decision.reads ?? [];
    for (const facts of situations(reads))
      for (const { person, legacy: before, legacyNoQ2A: withoutQ2A, next: after } of ACTORS) {
        if (!possible(person, facts)) continue;
        evaluated += 1;
        const legacy = decision.legacy(before, facts);
        const next = decision.next(after, facts);
        if (legacy === next) continue;
        const disagreement: Case = {
          decision: decision.name,
          person,
          facts,
          legacy,
          legacyNoQ2A: decision.legacy(withoutQ2A, facts),
          next,
        };
        const explaining = narrows(legacy, next)
          ? deltas.filter((delta) => delta.covers(disagreement))
          : [];
        for (const delta of explaining) exercised.add(delta.name);
        if (explaining.length === 0) unexplained.push(explain(disagreement, reads));
      }
  }
  return { unexplained, exercised, evaluated };
}

describe("2.43.0 to 2.44.0 access parity", () => {
  test("every module and page 2.43.0 had is compared, and none is left out", async () => {
    const { decisions, commands, components, pages } = await discovered();
    // The inventory is exactly 2.43.0's plus what 2.45.0 names as new: a module or page added
    // without a line in NEW_IN_2_45_0 fails here, and so does one that went missing.
    expect([...commands.keys()].sort()).toEqual(
      [...Object.keys(LEGACY_COMMANDS), ...Object.keys(NEW_IN_2_45_0.commands)].sort(),
    );
    expect([...components.keys()].sort()).toEqual(
      [...Object.keys(LEGACY_COMPONENTS), ...Object.keys(NEW_IN_2_45_0.components)].sort(),
    );
    expect([...pages.keys()].sort()).toEqual(
      [...Object.keys(LEGACY_PAGES), ...Object.keys(NEW_IN_2_45_0.pages)].sort(),
    );
    // What is new was never in 2.43.0, so none of it hides behind a legacy entry.
    for (const [legacy, added] of [
      [LEGACY_COMMANDS, NEW_IN_2_45_0.commands],
      [LEGACY_COMPONENTS, NEW_IN_2_45_0.components],
      [LEGACY_PAGES, NEW_IN_2_45_0.pages],
    ] as const)
      for (const key of Object.keys(added)) expect(Object.hasOwn(legacy, key)).toBe(false);
    // The configure and ledger decisions come from src's maps, so each must still name them all.
    expect(Object.keys(CONFIG_PERMISSION).sort()).toEqual([...LEGACY_CONFIG_FIELDS].sort());
    expect(Object.keys(LEDGER_PERMISSION).sort()).toEqual([...LEGACY_LEDGER_OPERATIONS].sort());
    const names = [...DECISIONS, ...decisions].map((decision) => decision.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("2.44.0 reproduces 2.43.0 everywhere except the listed deltas, each of them needed", async () => {
    const { decisions } = await discovered();
    const { unexplained, exercised, evaluated } = compare([...DECISIONS, ...decisions]);
    // A floor, not a pin: 96 people for each of the ~120 decisions, more where facts vary.
    expect(evaluated).toBeGreaterThan(10_000);
    expect({ count: unexplained.length, first: unexplained.slice(0, 20) }).toEqual({
      count: 0,
      first: [],
    });
    expect([...exercised].sort()).toEqual(DELTAS.map((delta) => delta.name).sort());
  });

  test("the comparison notices a change no delta names, and one that gives access", () => {
    // A staff permission swapped for a baseline one: every member would pass an officer check.
    const widened: Decision = {
      ...officerLevel("mutant: widened", "config.view"),
      next: (actor) => passes(() => requirePermission(actor, actor.guildId, "issue.use")),
    };
    expect(compare([widened]).unexplained.length).toBeGreaterThan(0);
    // A narrowing outside every delta's predicate: officers lose a check they had.
    const narrowed: Decision = {
      ...officerLevel("mutant: narrowed", "config.view"),
      next: (actor) => passes(() => requirePermission(actor, actor.guildId, "admin.setup")),
    };
    const { unexplained } = compare([narrowed]);
    expect(unexplained.some((line) => line.includes("officerRoleCounts=true"))).toBe(true);
    // Q2A takes away only Manage Server's own officer, never what a role gave beside it.
    const manageServerOnly = (actor: Actor) => actor.serverManager === true && !actor.manageRoles;
    const officerRoleIgnored: Decision = {
      ...officerLevel("mutant: Officer role ignored beside Manage Server", "config.view"),
      next: (actor) =>
        !manageServerOnly(actor) &&
        passes(() => requirePermission(actor, actor.guildId, "config.view")),
    };
    expect(
      compare([officerRoleIgnored]).unexplained.some((line) =>
        line.includes("manageServer=true manageRoles=false officerRoleCounts=true"),
      ),
    ).toBe(true);
    const memberIgnored: Decision = {
      name: "mutant: Member ignored beside Manage Server",
      legacy: (actor) => legacyMaySuggest(actor, BINDINGS),
      next: (actor) => !manageServerOnly(actor) && maySuggest(actor),
    };
    expect(
      compare([memberIgnored]).unexplained.some((line) =>
        line.includes("manageServer=true manageRoles=false officerRoleCounts=false member=true"),
      ),
    ).toBe(true);
    // Each delta explains only what it names: with none listed, the real decisions all fail.
    expect(compare(DECISIONS, []).unexplained.length).toBeGreaterThan(0);
  });
});

describe("2.45.0: what is new, and what a pause takes away", () => {
  test("/moderate's router gate declares nothing, so it admits every human in the server", async () => {
    const { commands } = await discovered();
    const moderate = commands.get("moderate");
    expect(moderate?.permissions).toEqual(NEW_IN_2_45_0.commands.moderate);
    // Everyone, the lobby and the unconfigured included: status shows a person their own pauses,
    // and block and lift check moderation.block in the service, not at the door.
    for (const { next } of ACTORS) expect(nextGate(next, moderate?.permissions ?? [])).toBe(true);
    // The server check still comes first.
    expect(passes(() => requireAnyPermission(ACTORS[0]?.next as Actor, "another-server", []))).toBe(
      false,
    );
  });

  test("the Moderation page admits exactly the holders of moderation.view, and no one 2.43.0 kept out of every page", async () => {
    const { pages } = await discovered();
    const page = pages.get("/g/:guild/moderation");
    if (!page) throw new Error("The Moderation page is not discovered");
    expect(page.access).toEqual(NEW_IN_2_45_0.pages["/g/:guild/moderation"]);
    let admitted = 0;
    for (const { person, legacy, next } of ACTORS) {
      // moderation.view is in the Officer template and a server manager holds every permission;
      // Manage Server alone grants nothing (Q2 A), and a Member, Guest or lobby visitor holds none.
      const holder = isManager(person) || person.officerRoleCounts;
      expect(can(next, "moderation.view")).toBe(holder);
      expect(admits(next, page.access)).toBe(holder);
      if (!holder) continue;
      admitted += 1;
      // A holder was an officer in 2.43.0 (or a manager, one of them), so already had a page.
      expect(Object.values(LEGACY_PAGES).some((flags) => legacyAdmits(legacy, flags))).toBe(true);
    }
    expect(admitted).toBeGreaterThan(0);
  });

  /**
   * The decisions a pause on a feature refuses: the writes, and the ledger's read. `bites` says when
   * the pause matters at all; it is for a decision that exempts someone from it, and none does
   * now: Service.ledgerRead reports a pause on ledger.view first, for ledger.audit holders too.
   */
  const REFUSED_WHILE_PAUSED: readonly {
    readonly decision: string;
    readonly feature: PermissionId;
    readonly bites?: (actor: Actor) => boolean;
  }[] = [
    { decision: "Suggestions.submit", feature: "suggest.use" },
    { decision: "Service.claim", feature: "characters.claim" },
    { decision: "Service.verify", feature: "characters.claim" },
    { decision: "Service.apply", feature: "guests.apply" },
    { decision: "Synchronization.refresh", feature: "roster.refresh" },
    { decision: "IssueReports.report", feature: "issue.use" },
    { decision: "ModMail.open", feature: "modmail.open" },
    { decision: "SelfRoles.choose", feature: "selfroles.use" },
    { decision: "Service.ledger(deposit)", feature: "ledger.deposit" },
    { decision: "Service.ledgerRead(current FC)", feature: "ledger.view" },
    { decision: "Service.ledgerRead(previous FC)", feature: "ledger.view" },
  ];

  /**
   * The decisions a pause leaves open, because they read what the person holds: the pages they
   * still open, and the records they already have.
   */
  const OPEN_WHILE_PAUSED: readonly {
    readonly decision: string;
    readonly features: readonly PermissionId[];
  }[] = [
    { decision: "SelfRoles.view", features: ["selfroles.use"] },
    { decision: "page /g/:guild/my-roles", features: ["selfroles.use"] },
    { decision: "ModMail.mine", features: ["modmail.open"] },
    { decision: "ModMail.caseView reaches the case", features: ["modmail.open"] },
    { decision: "ModMail.caseView audience", features: ["modmail.open"] },
    { decision: "ModMail.reply", features: ["modmail.open"] },
    { decision: "ModMail.close", features: ["modmail.open"] },
    { decision: "page /g/:guild/modmail", features: ["modmail.open"] },
    { decision: "page /g/:guild/modmail/:number", features: ["modmail.open"] },
    // Sign-in and the server list ask whether any page admits the person.
    { decision: "server list and sign-in", features: ["selfroles.use", "modmail.open"] },
  ];

  const pausedOn = (features: readonly PermissionId[]) =>
    Object.fromEntries(features.map((feature) => [feature, { reason: "Paused." }]));

  test("a pause refuses the write it names, for exactly the people it can apply to", async () => {
    const { decisions } = await discovered();
    const byName = new Map([...DECISIONS, ...decisions].map((d) => [d.name, d]));
    for (const { decision: name, feature, bites = () => true } of REFUSED_WHILE_PAUSED) {
      const decision = byName.get(name);
      if (!decision) throw new Error(`No decision named ${name}`);
      let refused = 0;
      for (const facts of situations(decision.reads ?? []))
        for (const { person, next: unpaused } of ACTORS) {
          if (!possible(person, facts)) continue;
          const paused = nextActorOf(person, pausedOn([feature]));
          const was = decision.next(unpaused, facts);
          const now = decision.next(paused, facts);
          // A pause applies to someone who holds the feature and is no server manager.
          if (paused.access.blocked.has(feature) && bites(paused)) {
            expect({ name, now }).toEqual({ name, now: false });
            if (was === true) refused += 1;
          } else expect({ name, now }).toEqual({ name, now: was });
        }
      // Not vacuous: somebody could use the feature, and was refused for the pause.
      expect({ name, refused: refused > 0 }).toEqual({ name, refused: true });
    }
  });

  test("a pause leaves the pages and records the person already has open", async () => {
    const { decisions } = await discovered();
    const byName = new Map([...DECISIONS, ...decisions].map((d) => [d.name, d]));
    for (const { decision: name, features } of OPEN_WHILE_PAUSED) {
      const decision = byName.get(name);
      if (!decision) throw new Error(`No decision named ${name}`);
      let kept = 0;
      for (const facts of situations(decision.reads ?? []))
        for (const { person, next: unpaused } of ACTORS) {
          if (!possible(person, facts)) continue;
          const paused = nextActorOf(person, pausedOn(features));
          const was = decision.next(unpaused, facts);
          expect({ name, now: decision.next(paused, facts) }).toEqual({ name, now: was });
          if (features.some((feature) => paused.access.blocked.has(feature)) && was) kept += 1;
        }
      // Not vacuous: somebody was paused and still got through.
      expect({ name, kept: kept > 0 }).toEqual({ name, kept: true });
    }
  });

  test("a server manager is never paused, whatever is stored for them", () => {
    const everything = pausedOn(PERMISSION_IDS);
    for (const { person } of ACTORS.filter(({ person }) => isManager(person))) {
      const paused = nextActorOf(person, everything);
      expect(paused.access.blocked.size).toBe(0);
      expect(paused.access.permissions).toEqual(nextActorOf(person).access.permissions);
    }
  });
});
