/**
 * Self-service roles' application operations (src/domain/self-roles.ts): officers read the editor
 * and apply one edit at a time to the server's self-service role menu (2.39.0, the first web
 * writes); from 2.40.0 members, guests and officers read My roles and save their own choices
 * (SelfRoles' view and choose, below the menu edits), and the roles.self job applies them
 * (RoleChoiceJob, which only the job dispatcher holds).
 *
 * Every edit is one transaction in a fixed order: the guild row FOR SHARE (configure() and /setup
 * take it FOR UPDATE, so binding an access role and adding a menu role can't interleave), the menu
 * row (created if missing) FOR UPDATE, then parse, apply the operation (its field refusals and
 * gone), the equal-state rule, the reset and revision checks, the invariant checks, the schema
 * check, the write, its audit row, and a last check that shutdown hasn't started, which rolls
 * everything back if it has. Discord is read before the transaction, never inside it, and a menu
 * edit writes nothing to Discord and queues no work: it changes nobody's roles.
 *
 * Any officer may make every change (owner decision, 2026-10-09): there is no Discord Manage Roles
 * requirement and no check of the officer's own role position. What may be added is decided by the
 * domain rule set and TaruBot's own position alone.
 *
 * Members' choices (2.40.0). Discord is the record of who holds which role (owner decision Q4 A):
 * a save stores nothing but the waiting roles.self job, whose payload holds role IDs only until the
 * job ends (migration 012's trigger clears it), at most 7 days after the last save; no audit row is
 * written per save; and results, diagnostics, logs and issue reports carry counts and fixed
 * sentences, never which roles. A save is one transaction under the member's own advisory lock:
 * read the newest waiting change, merge the categories this save changed into it, apply the
 * equal-state rule, enqueue, and the pre-commit shutdown check. Web handlers never write to
 * Discord: the job does, under the writer lease, after checking every role again.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { authorize, selfServiceAccess, type Actor } from "../domain/policy.js";
import {
  accessLossRemovals,
  applyOperation,
  botManagesRoles,
  CHOICE_MESSAGES,
  type CategoryChoice,
  type ChoiceCategory,
  type ChoiceError,
  changedCategories,
  checkRoles,
  choiceHeld,
  choiceMenu,
  EMPTY_MENU,
  holdsAdministrator,
  listed,
  type MenuFieldError,
  type MenuOperation,
  mergeChoice,
  menuRoleIds,
  menuSchema,
  NO_MANAGE_ROLES,
  planSelfRoles,
  ROLE_CHOICE_KIND,
  type RoleCheck,
  readMenu,
  readRoleChoice,
  removableBy,
  roleChoiceKey,
  roleChoicePayload,
  SELF_ROLE_MESSAGES,
  type SelfRoleHealth,
  type SelfRoleMenu,
  type SelfRoleSettings,
  sameChoice,
  sameMenu,
  selfRoleChecker,
  selfRoleHealth,
  selfRoleSettings,
  unreadableChannels,
} from "../domain/self-roles.js";
import { Failure, stoppingRefusal } from "../domain/values.js";
import type { VisibilityGuild } from "../domain/visibility.js";
import { audit, type Connection, orm, type Orm } from "../infrastructure/postgres/database.js";
import * as t from "../infrastructure/postgres/schema.js";
import { enqueue, type Job } from "../jobs/queue.js";
import type { DiscordPort, GuildRecord } from "./records.js";
import type { EffectsMode } from "./results.js";
import type { Service } from "./service.js";

/** The saved menu: the document (null when this build can't read it), raw value and revision. */
export interface StoredMenu {
  readonly menu: SelfRoleMenu | null;
  /** The stored JSON as read, for the invariant scan of a document this build can't parse. */
  readonly raw: unknown;
  /** The officers' optimistic lock: 1 before the first edit, as the row's default. */
  readonly revision: bigint;
}

/** The server's saved menu; a server without a row has the empty menu at revision 1. */
export async function loadMenu(db: Orm, guildId: string): Promise<StoredMenu> {
  const [row] = await db
    .select({ menu: t.selfRoleMenus.menu, revision: t.selfRoleMenus.revision })
    .from(t.selfRoleMenus)
    .where(eq(t.selfRoleMenus.guild_id, guildId));
  if (!row) return { menu: EMPTY_MENU, raw: EMPTY_MENU, revision: 1n };
  return { menu: readMenu(row.menu), raw: row.menu, revision: row.revision };
}

/** The rule set's settings: the guild row, retired roles and onboarding's staff-only channels. */
export async function loadSelfRoleSettings(db: Orm, guild: GuildRecord): Promise<SelfRoleSettings> {
  const retired = await db
    .select({ role: t.retiredRoles.role_id })
    .from(t.retiredRoles)
    .where(eq(t.retiredRoles.guild_id, guild.id));
  const staff = await db
    .select({ channel: t.channelAccessPolicies.channel_id })
    .from(t.channelAccessPolicies)
    .where(
      and(
        eq(t.channelAccessPolicies.guild_id, guild.id),
        eq(t.channelAccessPolicies.staff_only, true),
      ),
    );
  return selfRoleSettings(
    guild,
    retired.map((row) => row.role),
    staff.map((row) => row.channel),
  );
}

/** Every string anywhere in a JSON value: its string values and its object keys. */
function stringsIn(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") into.add(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, into);
  else if (typeof value === "object" && value !== null)
    for (const [key, item] of Object.entries(value)) {
      into.add(key);
      stringsIn(item, into);
    }
  return into;
}

/**
 * Which of `roleIds` are on the server's saved menu, drafts included. A document this build can't
 * read still counts: any string in it equal to a role ID, as a value or as an object key (a newer
 * menu might key its options by role), is taken as that role, so a newer release's menu keeps the
 * invariant after a rollback (failing closed: at worst a role can't be bound until the menu is
 * reset).
 */
export async function rolesOnMenu(
  db: Orm,
  guildId: string,
  roleIds: readonly string[],
): Promise<string[]> {
  if (roleIds.length === 0) return [];
  const stored = await loadMenu(db, guildId);
  const present = stored.menu ? new Set(menuRoleIds(stored.menu)) : stringsIn(stored.raw);
  return roleIds.filter((id) => present.has(id));
}

/** configure()'s refusal, with the approved wording. */
export const ON_MENU =
  "That role is on the self-service role menu. Remove it on the Role menu page first, or choose another role.";

/**
 * The invariant that a menu role is never a bound access role: refuse binding any of `roleIds`
 * while it is on the menu. Call it inside the transaction that holds the guild row FOR UPDATE, so
 * a concurrent menu edit (which takes the row FOR SHARE first) can't add one in between.
 */
export async function assertNotOnMenu(
  client: Connection,
  guildId: string,
  roleIds: readonly string[],
): Promise<void> {
  if ((await rolesOnMenu(orm(client), guildId, roleIds)).length > 0)
    throw new Failure("input", ON_MENU, 0, { kind: "option", option: "role" });
}

/** /setup onboarding's refusal for a role it would bind as `label` that is on the menu. */
export const onMenuForSetup = (roleId: string, label: string): Failure =>
  new Failure(
    "input",
    `<@&${roleId}> is on the self-service role menu, so /setup onboarding can't use it as the ${label} role. Remove it on the Role menu page first, rename it in Discord, or choose the access role with /config roles first.`,
    0,
    { kind: "resource", resource: "role", id: roleId },
  );

/** The "Role menu" health check for Service.validate(), over the view it already read. */
export async function selfRolesHealth(
  db: Orm,
  guild: GuildRecord,
  snapshot: VisibilityGuild | null,
): Promise<SelfRoleHealth> {
  const stored = await loadMenu(db, guild.id);
  return selfRoleHealth(stored.menu, snapshot, await loadSelfRoleSettings(db, guild));
}

/**
 * Owner decision Q3 B for reconciliation (Synchronization.user): the self-service roles to take from
 * someone the pass leaves with none of TaruBot's access roles, given what they hold now (see the
 * domain's accessLossRemovals). One menu read; TaruBot's cached view of the server (no Discord
 * request) only when they hold a listed menu role at all. Without that view nothing is removed
 * this pass, since cosmetic roles must never go: the next pass for this person tries again.
 */
export async function accessLossRoles(
  db: Orm,
  discord: DiscordPort,
  guild: GuildRecord,
  held: readonly string[],
): Promise<string[]> {
  const stored = await loadMenu(db, guild.id);
  const menu = stored.menu;
  if (!menu || !menuRoleIds(menu).some((id) => held.includes(id) && listed(menu, id))) return [];
  const snapshot = (await discord.visibility?.(guild.id, false)) ?? null;
  if (!snapshot) return [];
  return accessLossRemovals(menu, snapshot, await loadSelfRoleSettings(db, guild), held);
}

/** What the Role menu page shows. */
export interface SelfRoleEditor {
  readonly guildId: string;
  /** TaruBot has an active configuration here; without one the page says to set it up first. */
  readonly configured: boolean;
  /** Send it back with every edit (the optimistic lock). */
  readonly revision: bigint;
  /** Null when the saved menu can't be read: show the warning and offer only Reset role menu. */
  readonly menu: SelfRoleMenu | null;
  /**
   * Every role but @everyone, highest first as Discord lists them, then any menu role the server no
   * longer has (reading `missing`), each with its problems and the channels it opens. Null when
   * TaruBot's view of the server couldn't be read (not delivered yet): problems are then unknown.
   */
  readonly roles: readonly RoleCheck[] | null;
  /** Channels TaruBot can't read; an add needs the officer's confirmation while there are any. */
  readonly unreadableChannels: number;
  /**
   * TaruBot holds Administrator here (from 2.40.0 members and guests are refused while it does);
   * null when unknown.
   */
  readonly administrator: boolean | null;
  /** The bound Member and Guest roles; members can't use My roles while neither is set. */
  readonly memberRoleId: string | null;
  readonly guestRoleId: string | null;
  /** TaruBot's lobby onboarding is on: its channel pass strips the channels these roles open. */
  readonly onboarding: boolean;
  readonly effectsMode: EffectsMode;
}

/** One edit from the page: the operation, and the revision the form was rendered at. */
export interface SelfRoleEditRequest {
  readonly revision: bigint;
  readonly operation: MenuOperation;
}

/**
 * What an edit did:
 * - saved: written and audited, now at `revision`;
 * - unchanged: the menu already was what the edit asks (a double submit, or a repeat after
 *   another officer made the same change), so nothing was written: answer as a success;
 * - conflict (409): `changed` when the form is stale and would change something, names a category
 *   or option another officer removed, or resets a menu that reads fine; `unreadable` when the
 *   saved menu can't be read and the edit isn't a reset. SELF_ROLE_MESSAGES[reason] is the
 *   approved sentence;
 * - invalid (422): the refused fields, for the re-rendered form.
 * Refusals that aren't about the form are thrown as Failures: forbidden (not an officer here),
 * setup (no TaruBot configuration), stopping (shutdown started; nothing was saved) and unavailable
 * (an add while TaruBot can't read the server's roles).
 */
export type SelfRoleEditOutcome =
  | { readonly status: "saved"; readonly revision: bigint }
  | { readonly status: "unchanged"; readonly revision: bigint }
  | { readonly status: "conflict"; readonly reason: "changed" | "unreadable" }
  | { readonly status: "invalid"; readonly errors: readonly MenuFieldError[] };

/** The setup refusal Service.guild() uses, for a server TaruBot isn't configured in. */
const notConfigured = (): Failure =>
  new Failure(
    "setup",
    "This server has no TaruBot configuration yet. Start with /config fc link and /config roles, or /setup onboarding for lobby onboarding.",
    0,
    { kind: "setup", missing: "guild" },
  );

/** No guild row: no bound roles, retired roles or staff channels. */
const NO_SETTINGS = selfRoleSettings(
  {
    member_role_id: null,
    guest_role_id: null,
    officer_role_id: null,
    leader_role_id: null,
    officer_channel_id: null,
    officer_notifications_channel_id: null,
    guest_application_channel_id: null,
  },
  [],
  [],
);

/**
 * The states a member's change waits in: queued or running, blocked, or parked as disabled. The
 * migration's self_role_waiting index covers exactly these.
 */
const WAITING_STATES = ["queued", "running", "blocked", "disabled"] as const;

/**
 * My roles' status banner, from the person's newest roles.self job: what happened to their last
 * change, never which roles it named.
 * - waiting: queued or running ("Saved. TaruBot is updating your roles in Discord…");
 * - paused: parked while Discord changes are paused;
 * - blocked: TaruBot can't change roles in this server right now (officers can see why);
 * - failed: TaruBot couldn't apply it;
 * - applied: done, `skipped` of the choices not applied (roles unavailable at the time), and
 *   `changed` whether any role was added or removed at all;
 * - expired: still waiting 7 days after the last save, so dropped;
 * - dropped: closed without applying for any other reason (a restore, an older TaruBot after a
 *   rollback, nothing left to apply).
 */
export interface RoleChoiceStatus {
  readonly state: "waiting" | "paused" | "blocked" | "failed" | "applied" | "expired" | "dropped";
  /** Choices an applied change left out; 0 in every other state. */
  readonly skipped: number;
  /**
   * An applied change added or removed at least one role (the job's added + removed > 0); false
   * in every other state. One that changed nothing but skipped choices applied none of them, so
   * the page mustn't say "Your roles were updated".
   */
  readonly changed: boolean;
  /**
   * It finished within the last 10 minutes (the database clock), so "Your roles were updated"
   * still describes what the page shows; always false while waiting.
   */
  readonly recent: boolean;
  /**
   * When it ended (jobs.completed_at), so a warning that lasts as long as the row (30 days) says
   * when; null while waiting, or for a row without the time.
   */
  readonly completedAt: Date | null;
}

/** What My roles shows one person (SelfRoles.view). */
export interface MyRoles {
  readonly guildId: string;
  /** TaruBot has an active configuration here; without one there is nothing to pick. */
  readonly configured: boolean;
  /**
   * The saved menu can't be read by this build (written by a newer release, or damaged): nothing
   * is offered, so members see nothing to pick, and officers can reset it on Role menu.
   */
  readonly unreadableMenu: boolean;
  /**
   * TaruBot's view of the server's roles was read (the gateway cache). False: nothing can be
   * changed or even named now, so the page shows only the unavailable callout (no categories),
   * and a save is refused.
   */
  readonly available: boolean;
  /** The categories to render, in menu order (see the domain's choiceMenu). Empty: nothing yet. */
  readonly categories: readonly ChoiceCategory[];
  /**
   * The saved menu offers roles to members: a published or Stop offering category with at least
   * one role, whether or not any can be picked now. With no categories to show, it tells "nothing
   * can be picked right now" (every role fails a rule, say because TaruBot lost Manage Roles) from
   * "officers haven't set anything up".
   */
  readonly offers: boolean;
  /** The person's newest role change, or null when they have none on record (30 days). */
  readonly status: RoleChoiceStatus | null;
  /** Discord changes run now only when "live"; otherwise the form is disabled. */
  readonly effectsMode: EffectsMode;
  /** In a Discord time-out: may look, but the form is disabled until it ends. */
  readonly timedOut: boolean;
  /** A save can be accepted now: configured, live, not timed out, and the view was read. */
  readonly canSave: boolean;
  /**
   * For officers: TaruBot holds Administrator here (members and guests are refused until it
   * doesn't, owner decision A2; the page's banner says so), or null when unknown. Always null for
   * anyone else.
   */
  readonly administrator: boolean | null;
  /**
   * The cached names of the menu's roles, from the same view of the server (empty when it couldn't
   * be read), so the page names them without the gateway: My roles declares only selfRolesKey, as
   * members and guests reach its code (docs/MODULES.md, "Add a page"). Menu roles only, never
   * anyone's other roles.
   */
  readonly roleNames: ReadonlyMap<string, string>;
}

/**
 * A My roles save: one entry per category the form rendered (its hidden `shown` fields), each with
 * what the form showed ticked and what came back (see the domain's CategoryChoice).
 */
export interface RoleChoiceRequest {
  readonly categories: readonly CategoryChoice[];
}

/**
 * What a save did:
 * - saved: the change is queued, or merged into the one already waiting, or it equals the one
 *   already waiting (a double submit lands on the same answer): 303 to the page, whose banner
 *   comes from the job;
 * - unchanged: nothing to save (the form came back as it was shown, or the person already holds
 *   exactly what it asks): 303 with the "unchanged" notice;
 * - conflict (409): officers changed the roles on offer meanwhile (CHOICE_MESSAGES.conflict);
 *   re-render with the current state;
 * - invalid (422): `errors` per category, for the re-rendered form.
 * Refusals that aren't about the form are thrown as Failures: forbidden (no self-service access
 * here, or a Discord time-out), setup (no TaruBot configuration), disabled (Discord changes paused),
 * unavailable (TaruBot can't read the server's roles) and stopping (shutdown started).
 */
export type RoleChoiceOutcome =
  | { readonly status: "saved" }
  | { readonly status: "unchanged" }
  | { readonly status: "conflict" }
  | { readonly status: "invalid"; readonly errors: readonly ChoiceError[] };

/**
 * A roles.self job's result: counts and fixed reasons only (owner decision Q4 A). `skipped`
 * counts every choice that differed from the member's roles and wasn't applied.
 */
export type RoleChoiceResult =
  | {
      readonly status: "applied";
      readonly added: number;
      readonly removed: number;
      readonly skipped: number;
    }
  | { readonly skipped: "guild inactive" | "member left" };

/**
 * Whether one of the person's role changes ended within the last 5 minutes (the database clock), in
 * any state, so choose()'s "nothing to do" shortcut can't trust `held`. That was read when the POST
 * resolved the person, before choose()'s transaction, and a job that wrote Discord in between makes
 * it stale: a save undoing that change (A to B, then A again from a page the waiting change ticked)
 * would match the old roles and be answered "unchanged", and silently lost. The margin covers a
 * slow resolution (Discord's timeouts and retries) many times over; within it the save is queued
 * instead, and a job with nothing to do costs one member read.
 */
async function endedLately(tx: Orm, key: string): Promise<boolean> {
  const [ended] = await tx
    .select({ id: t.jobs.id })
    .from(t.jobs)
    .where(
      and(
        eq(t.jobs.kind, ROLE_CHOICE_KIND),
        eq(t.jobs.dedupe_key, key),
        sql`${t.jobs.completed_at} > now() - interval '5 minutes'`,
      ),
    )
    .limit(1);
  return ended !== undefined;
}

/** The refusal for anyone without self-service access here (the page flags normally stop them). */
const noAccess = (): Failure => new Failure("forbidden", CHOICE_MESSAGES.noAccess);

/** The banner state for a stored job row (see RoleChoiceStatus). */
function choiceStatus(row: {
  status: string;
  result: unknown;
  recent: boolean;
  completed_at: Date | null;
}): RoleChoiceStatus {
  const result = typeof row.result === "object" && row.result !== null ? row.result : {};
  const skipped = Reflect.get(result, "skipped");
  const completedAt = row.completed_at;
  const waiting = (state: RoleChoiceStatus["state"]): RoleChoiceStatus => ({
    state,
    skipped: 0,
    changed: false,
    recent: false,
    completedAt: null,
  });
  switch (row.status) {
    case "queued":
    case "running":
      return waiting("waiting");
    case "disabled":
      return waiting("paused");
    case "blocked":
      return waiting("blocked");
    case "failed":
      return { state: "failed", skipped: 0, changed: false, recent: row.recent, completedAt };
  }
  if (Reflect.get(result, "status") === "applied") {
    const count = (name: string): number => {
      const value = Reflect.get(result, name);
      return typeof value === "number" && value > 0 ? value : 0;
    };
    return {
      state: "applied",
      skipped: count("skipped"),
      changed: count("added") + count("removed") > 0,
      recent: row.recent,
      completedAt,
    };
  }
  return {
    state: skipped === "expired" ? "expired" : "dropped",
    skipped: 0,
    changed: false,
    recent: row.recent,
    completedAt,
  };
}

/** MyRoles.offers: a published or Stop offering category with a role in it. */
export const offersRoles = (menu: SelfRoleMenu | null): boolean =>
  menu?.categories.some((category) => category.state !== "draft" && category.options.length > 0) ??
  false;

/** MyRoles.roleNames: each menu role's name in `snapshot`; none without a readable menu or view. */
export function menuRoleNames(
  menu: SelfRoleMenu | null,
  snapshot: VisibilityGuild | null,
): ReadonlyMap<string, string> {
  if (!menu || !snapshot) return new Map();
  const onMenu = new Set(menuRoleIds(menu));
  return new Map(
    snapshot.roles.filter((role) => onMenu.has(role.id)).map((role) => [role.id, role.name]),
  );
}

/**
 * The audit row's details: configuration identifiers only, never names or descriptions officers
 * typed. `revision` is the menu's revision after the edit.
 */
function auditDetails(
  operation: MenuOperation,
  before: SelfRoleMenu | null,
  after: SelfRoleMenu,
  revision: bigint,
  unreadable: number,
): Record<string, unknown> {
  const category = (menu: SelfRoleMenu | null, id: string) =>
    menu?.categories.find((candidate) => candidate.id === id);
  switch (operation.op) {
    case "category.create":
    case "category.edit":
      return { revision, categoryId: operation.categoryId, max: operation.max };
    case "category.move":
      return {
        revision,
        categoryId: operation.categoryId,
        to: after.categories.findIndex((candidate) => candidate.id === operation.categoryId),
      };
    case "category.setState":
      return { revision, categoryId: operation.categoryId, state: operation.state };
    case "category.delete":
      return {
        revision,
        categoryId: operation.categoryId,
        roleIds: category(before, operation.categoryId)?.options.map((o) => o.roleId) ?? [],
      };
    case "menu.publishAll":
      return {
        revision,
        categoryIds: (before?.categories ?? [])
          .filter((candidate) => candidate.state === "draft")
          .map((candidate) => candidate.id),
      };
    case "menu.reset":
      return { revision, unreadable: before === null };
    case "options.add": {
      const had = new Set(before ? menuRoleIds(before) : []);
      return {
        revision,
        categoryId: operation.categoryId,
        roleIds: menuRoleIds(after).filter((id) => !had.has(id)),
        // The officer confirmed they checked this many channels TaruBot can't read.
        ...(unreadable > 0 ? { unreadableChannels: unreadable } : {}),
      };
    }
    case "options.edit": {
      // What became of each changed option: offered again, not offered, removed, or edited (its
      // description or its place). Its place is its order among the options that remain, so
      // removing one doesn't mark every option after it as moved; options.edit never adds one, so
      // `kept` holds the same roles as `now`. A move still marks each option it shifts.
      const old = category(before, operation.categoryId)?.options ?? [];
      const now = category(after, operation.categoryId)?.options ?? [];
      const kept = old.filter((option) => now.some((next) => next.roleId === option.roleId));
      const changes: Record<string, string> = {};
      for (const option of old) {
        const index = now.findIndex((candidate) => candidate.roleId === option.roleId);
        const next = now[index];
        if (!next) changes[option.roleId] = "removed";
        else if (next.removalOnly !== option.removalOnly)
          changes[option.roleId] = next.removalOnly ? "not_offered" : "offered";
        else if (next.description !== option.description || index !== kept.indexOf(option))
          changes[option.roleId] = "edited";
      }
      return { revision, categoryId: operation.categoryId, changes };
    }
  }
}

/**
 * The Role menu's operations and My roles' (editor, edit, view, choose); main.ts provides one as
 * selfRolesKey. Nothing here writes to Discord: a member's saved choices reach it only through
 * RoleChoiceJob, in the job worker.
 */
export class SelfRoles {
  constructor(
    // Private, like the other operations' Service: a page that declares only selfRolesKey must not
    // reach the database, the gateway or the configuration through it.
    private readonly app: Service,
    /** The lifecycle's shutdown flag: edits refuse once it is set, and roll back if set mid-edit. */
    private readonly isStopping: () => boolean,
  ) {}

  /**
   * The Role menu page's state for the actor's server, from the database and the gateway cache (no
   * Discord request): the menu, its revision, every role's verdict and the banners' facts.
   */
  async editor(actor: Actor): Promise<SelfRoleEditor> {
    authorize(actor, actor.guildId, "officer");
    const db = this.app.db.orm;
    const [guild] = await db
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, actor.guildId), eq(t.guilds.active, true)));
    const stored = await loadMenu(db, actor.guildId);
    const settings = guild ? await loadSelfRoleSettings(db, guild) : NO_SETTINGS;
    const snapshot = (await this.app.discord.visibility?.(actor.guildId, false)) ?? null;
    return {
      guildId: actor.guildId,
      configured: guild !== undefined,
      revision: stored.revision,
      menu: stored.menu,
      roles: snapshot
        ? checkRoles(snapshot, settings, stored.menu ? menuRoleIds(stored.menu) : [])
        : null,
      unreadableChannels: snapshot ? unreadableChannels(snapshot) : 0,
      administrator: snapshot ? holdsAdministrator(snapshot) : null,
      memberRoleId: guild?.member_role_id ?? null,
      guestRoleId: guild?.guest_role_id ?? null,
      onboarding: guild?.access_policy_enabled ?? false,
      effectsMode: this.app.effectsMode(guild ?? { effects_enabled: false }),
    };
  }

  /**
   * Apply one edit (see SelfRoleEditOutcome). An add first reads a fresh view of the server's roles
   * and TaruBot's member (2 Discord requests), outside the transaction; every added role must pass
   * the rule set on it, re-checked against the bound and retired roles under the locks.
   */
  async edit(actor: Actor, request: SelfRoleEditRequest): Promise<SelfRoleEditOutcome> {
    authorize(actor, actor.guildId, "officer");
    if (this.isStopping()) throw stoppingRefusal();
    const { operation } = request;
    const guildId = actor.guildId;
    let snapshot: VisibilityGuild | null = null;
    if (operation.op === "options.add") {
      snapshot = (await this.app.discord.visibility?.(guildId, true)) ?? null;
      if (!snapshot)
        throw new Failure(
          "unavailable",
          "TaruBot can't read this server's roles right now. Try again in a minute.",
        );
    }
    return this.app.db.transaction(async (client) => {
      const db = orm(client);
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)))
        .for("share");
      if (!guild) throw notConfigured();
      await db.insert(t.selfRoleMenus).values({ guild_id: guildId }).onConflictDoNothing();
      const [row] = await db
        .select({ menu: t.selfRoleMenus.menu, revision: t.selfRoleMenus.revision })
        .from(t.selfRoleMenus)
        .where(eq(t.selfRoleMenus.guild_id, guildId))
        .for("update");
      if (!row) throw new Error("Missing role menu row");
      const current = readMenu(row.menu);
      // A document this build can't read is never edited; only a reset replaces it.
      if (!current && operation.op !== "menu.reset")
        return { status: "conflict", reason: "unreadable" };
      const applied = applyOperation(current ?? EMPTY_MENU, operation);
      if (applied.kind === "gone") return { status: "conflict", reason: "changed" };
      if (applied.kind === "invalid") return { status: "invalid", errors: applied.errors };
      // The equal-state rule: an edit that changes nothing succeeds without writing, whatever
      // revision the form carried, so a double submit lands on the same success.
      if (current && sameMenu(applied.menu, current))
        return { status: "unchanged", revision: row.revision };
      // Reset is only for a menu this build can't read, the one place the page offers it. On a
      // readable menu (another officer reset it and built on it since, or a hand-made POST) it
      // would wipe every category at once, so it is refused; a repeat after a reset already met
      // the empty menu above.
      if (operation.op === "menu.reset" && current)
        return { status: "conflict", reason: "changed" };
      if (row.revision !== request.revision) return { status: "conflict", reason: "changed" };
      let unreadable = 0;
      if (operation.op === "options.add" && snapshot && current) {
        // The rule set over the fresh view, with the bound and retired roles read under this
        // transaction's guild row lock, for exactly the roles this edit adds.
        const had = new Set(menuRoleIds(current));
        const added = menuRoleIds(applied.menu).filter((id) => !had.has(id));
        const check = selfRoleChecker(snapshot, await loadSelfRoleSettings(db, guild));
        const errors: MenuFieldError[] = [];
        for (const roleId of added) {
          const [problem] = check(roleId).problems;
          if (problem)
            errors.push({
              field: "roleIds",
              message: SELF_ROLE_MESSAGES.refusedRole(roleId, problem),
            });
        }
        unreadable = unreadableChannels(snapshot);
        if (unreadable > 0 && !operation.unreadableAcknowledged)
          errors.push({
            field: "acknowledged",
            message: SELF_ROLE_MESSAGES.acknowledge(unreadable),
          });
        if (errors.length > 0) return { status: "invalid", errors };
      }
      // Never write a document the next read would refuse.
      const menu = menuSchema.parse(applied.menu);
      const [saved] = await db
        .update(t.selfRoleMenus)
        .set({ menu, revision: sql`${t.selfRoleMenus.revision}+1`, updated_at: sql`now()` })
        .where(eq(t.selfRoleMenus.guild_id, guildId))
        .returning({ revision: t.selfRoleMenus.revision });
      if (!saved) throw new Error("Missing role menu row");
      await audit(
        client,
        guildId,
        actor.userId,
        "self_roles",
        operation.op,
        auditDetails(operation, current, menu, saved.revision, unreadable),
      );
      // Shutdown may have started while this ran: throwing rolls the whole edit back, so nothing
      // commits once the drain has begun (the web refuses new POSTs before this point).
      if (this.isStopping()) throw stoppingRefusal();
      return { status: "saved", revision: saved.revision };
    });
  }

  /** The person's newest roles.self row: its status, payload, result and whether it is recent. */
  private async latestChoice(db: Orm, guildId: string, userId: string) {
    const [row] = await db
      .select({
        status: t.jobs.status,
        payload: t.jobs.payload,
        result: t.jobs.result,
        completed_at: t.jobs.completed_at,
        recent: sql<boolean>`coalesce(${t.jobs.completed_at}>now()-interval '10 minutes',false)`,
      })
      .from(t.jobs)
      .where(
        and(
          eq(t.jobs.kind, ROLE_CHOICE_KIND),
          eq(t.jobs.dedupe_key, roleChoiceKey(guildId, userId)),
        ),
      )
      .orderBy(desc(t.jobs.created_at))
      .limit(1);
    return row;
  }

  /**
   * My roles for the actor (members, guests and officers, owner decision Q6): the published menu,
   * Stop offering categories where they can remove a role, and drafts for officers, each with the
   * person's roles ticked, from the database and the gateway caches (no Discord request). Held
   * roles come from the gateway's member cache, which reflects a finished job at once, falling
   * back to the actor's; the newest waiting change is overlaid, so a second save builds on it.
   */
  async view(actor: Actor): Promise<MyRoles> {
    authorize(actor, actor.guildId, "user");
    if (!selfServiceAccess(actor)) throw noAccess();
    const db = this.app.db.orm;
    const guildId = actor.guildId;
    const [guild] = await db
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
    const stored = await loadMenu(db, guildId);
    const snapshot = guild ? ((await this.app.discord.visibility?.(guildId, false)) ?? null) : null;
    const settings = guild ? await loadSelfRoleSettings(db, guild) : NO_SETTINGS;
    const held = this.app.discord.cachedRoles?.(guildId, actor.userId) ?? actor.roleIds ?? [];
    const latest = await this.latestChoice(db, guildId, actor.userId);
    const waiting =
      latest && (WAITING_STATES as readonly string[]).includes(latest.status)
        ? readRoleChoice(latest.payload)
        : null;
    const categories =
      guild && stored.menu
        ? choiceMenu(stored.menu, {
            held,
            waiting,
            check: snapshot ? selfRoleChecker(snapshot, settings) : null,
            officer: actor.officer,
          })
        : [];
    const effectsMode = this.app.effectsMode(guild ?? { effects_enabled: false });
    const timedOut = actor.timedOut === true;
    return {
      guildId,
      configured: guild !== undefined,
      unreadableMenu: stored.menu === null,
      available: snapshot !== null,
      categories,
      offers: offersRoles(stored.menu),
      status: latest ? choiceStatus(latest) : null,
      effectsMode,
      timedOut,
      canSave: guild !== undefined && snapshot !== null && effectsMode === "live" && !timedOut,
      administrator: actor.officer && snapshot ? holdsAdministrator(snapshot) : null,
      roleNames: menuRoleNames(stored.menu, snapshot),
    };
  }

  /**
   * Save the actor's own choices (see RoleChoiceOutcome and the module comment). The categories
   * the person changed are found against the roles they hold now (the fresh actor a POST
   * resolves) and the rule set over the gateway cache, outside the transaction; nothing here reads
   * or writes Discord beyond that cache. Saves are refused while Discord changes are paused, so no
   * new choice ever waits on a pause.
   */
  async choose(actor: Actor, request: RoleChoiceRequest): Promise<RoleChoiceOutcome> {
    authorize(actor, actor.guildId, "user");
    if (!selfServiceAccess(actor)) throw noAccess();
    // Discord blocks reactions during a time-out too, so this matches Dyno (owner decision Q6).
    if (actor.timedOut === true) throw new Failure("forbidden", CHOICE_MESSAGES.timedOut);
    if (this.isStopping()) throw stoppingRefusal();
    const db = this.app.db.orm;
    const guildId = actor.guildId;
    const userId = actor.userId;
    const [guild] = await db
      .select()
      .from(t.guilds)
      .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
    if (!guild) throw notConfigured();
    if (this.app.effectsMode(guild) !== "live")
      throw new Failure("disabled", CHOICE_MESSAGES.paused);
    const snapshot = (await this.app.discord.visibility?.(guildId, false)) ?? null;
    if (!snapshot) throw new Failure("unavailable", CHOICE_MESSAGES.unavailable);
    const stored = await loadMenu(db, guildId);
    const held = actor.roleIds ?? this.app.discord.cachedRoles?.(guildId, userId) ?? [];
    // An unreadable menu lists nothing, so every pick is a conflict and nothing is changeable.
    const change = changedCategories(
      stored.menu ?? EMPTY_MENU,
      held,
      selfRoleChecker(snapshot, await loadSelfRoleSettings(db, guild)),
      request.categories,
    );
    if (change.kind === "conflict") return { status: "conflict" };
    if (change.kind === "invalid") return { status: "invalid", errors: change.errors };
    if (change.choice.offered.length === 0) return { status: "unchanged" };
    const key = roleChoiceKey(guildId, userId);
    return this.app.db.transaction(async (client) => {
      // One save at a time per person (the /issue pattern), so two tabs saving at once merge
      // rather than one overwriting the other.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const tx = orm(client);
      const [row] = await tx
        .select({ status: t.jobs.status, payload: t.jobs.payload })
        .from(t.jobs)
        .where(
          and(
            eq(t.jobs.kind, ROLE_CHOICE_KIND),
            eq(t.jobs.dedupe_key, key),
            inArray(t.jobs.status, [...WAITING_STATES]),
          ),
        )
        .orderBy(desc(t.jobs.created_at))
        .limit(1)
        .for("update");
      // A waiting row with an unreadable payload (a failed change an operator retried, cleared
      // by the trigger) asks nothing; this save replaces it.
      const waiting = row ? readRoleChoice(row.payload) : null;
      const merged = mergeChoice(waiting, change.choice, stored.menu);
      // The equal-state rule: the same change as the one already waiting (a double submit) is
      // the same success; with nothing waiting, a change the person already holds is nothing,
      // unless a change of theirs ended so lately that what they hold may have moved since.
      if (waiting && sameChoice(merged, waiting)) return { status: "saved" };
      if (!row && choiceHeld(merged, held) && !(await endedLately(tx, key)))
        return { status: "unchanged" };
      const clock = await client.query<{ now: Date }>("SELECT now() AS now");
      const now = clock.rows[0]?.now;
      if (!now) throw new Error("Missing database clock");
      // Only a validated payload is queued. A refusal is a bug, reported with fixed text: zod's
      // own message could quote the role IDs it refused.
      const parsed = roleChoicePayload.safeParse({
        chosen: merged.chosen,
        offered: merged.offered,
        savedAt: now.toISOString(),
      });
      if (!parsed.success) throw new Error("A role choice failed its payload schema");
      const payload = parsed.data;
      // A running job gets a new generation, and completion runs it again with this payload
      // (queue.ts); a queued or blocked one is replaced in place, blocked going back to queued.
      await enqueue(client, ROLE_CHOICE_KIND, key, payload, guildId, userId);
      // A parked (disabled) row is outside the active_job index, so enqueue() made a new row
      // beside it, carrying everything it asked (the merge above). Close it, so its role IDs
      // don't linger until a resume supersedes it: the trigger clears its payload.
      await tx
        .update(t.jobs)
        .set({
          status: "succeeded",
          completed_at: sql`now()`,
          lease_until: null,
          last_error: null,
          result: { skipped: "superseded" },
        })
        .where(
          and(
            eq(t.jobs.kind, ROLE_CHOICE_KIND),
            eq(t.jobs.dedupe_key, key),
            eq(t.jobs.status, "disabled"),
          ),
        );
      // Shutdown may have started meanwhile: throwing rolls the save back (as edit() does).
      if (this.isStopping()) throw stoppingRefusal();
      return { status: "saved" };
    });
  }
}

/**
 * The roles.self job: the one place a member's saved choices reach Discord. It lives apart from
 * SelfRoles on purpose. SelfRoles is provided under selfRolesKey, which My roles declares, and
 * every member and guest reaches that page's code; this writes any user's roles from whatever job
 * it is handed, trusting the caller's lease guard, so it must never be reachable from a page. Only
 * the job dispatcher constructs it (jobs/dispatch.ts), and no service key provides it. It needs no
 * shutdown flag: the worker runs under the writer lease, whose guard fences every write.
 */
export class RoleChoiceJob {
  // Private, as in SelfRoles: nothing outside this class reaches the services through it.
  constructor(private readonly app: Service) {}

  /**
   * Run one roles.self job, after the dispatcher's guild read and effects gate. It shares
   * `user:<guild>:<user>`, the lock reconcile.user takes, so access reconciliation and a member's
   * choices never write the same person's roles at once; a busy lock waits without spending an
   * attempt. Then: the member now (1 request; gone: skipped), the plan from the menu as it is now,
   * a fresh snapshot (2 requests) on which the whole job blocks while TaruBot lacks Manage Roles
   * and every planned role is checked again, skipped and counted if it fails, the lease fence,
   * and the per-role write. Nothing here names a role in a
   * result, diagnostic or log line: a member's choices can reveal pronouns or gender identity.
   */
  async apply(job: Job, guard: () => Promise<void>): Promise<RoleChoiceResult> {
    if (!job.guild_id || !job.user_id)
      throw new Failure("invalid_job", "A role choice job needs a server and a member.");
    // Fixed text, never zod's message: that could quote the role IDs it refused.
    const choice = readRoleChoice(job.payload);
    if (!choice) throw new Failure("invalid_job", "A role choice job's payload can't be read.");
    const guildId = job.guild_id;
    const userId = job.user_id;
    const lock = `user:${guildId}:${userId}`;
    const connection = await this.app.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await connection.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
            [lock],
          )
        ).rows[0]?.locked ?? false;
      if (!locked) throw new Failure("busy", "This member's roles are already being updated.");
      const db = this.app.db.orm;
      const [guild] = await db
        .select()
        .from(t.guilds)
        .where(and(eq(t.guilds.id, guildId), eq(t.guilds.active, true)));
      if (!guild) return { skipped: "guild inactive" };
      const member = await this.app.discord.member(guildId, userId);
      if (!member || member.bot) return { skipped: "member left" };
      const stored = await loadMenu(db, guildId);
      const settings = await loadSelfRoleSettings(db, guild);
      const bound = Object.values(settings.boundRoles).filter((id): id is string => id !== null);
      const plan = planSelfRoles(
        choice,
        stored.menu,
        member.roles,
        new Set([...bound, ...settings.retiredRoles]),
      );
      let add = plan.add;
      let remove = plan.remove;
      if (add.length > 0 || remove.length > 0) {
        const snapshot = (await this.app.discord.visibility?.(guildId, true)) ?? null;
        if (!snapshot) throw new Failure("unavailable", CHOICE_MESSAGES.unavailable);
        // Without Manage Roles every role fails `bot_cannot_manage`, which blocks adding and
        // removing alike, so the filter below would drop every change and finish the job as
        // applied with all of it skipped, its payload cleared and never retried. A server-wide
        // problem instead waits as blocked, role-free, keeping the payload until it is fixed or
        // the 7 days run out, as the gateway's own 50013 re-read does.
        if (!botManagesRoles(snapshot)) throw new Failure("blocked", NO_MANAGE_ROLES);
        // Just before the write, on fresh Discord state: an add must pass every rule, and a
        // removal needs only the weaker removable rule (taking a role away escalates nothing).
        // Someone who lost every access role since saving gets no role that opens a channel:
        // reconciliation would only take it away again (owner decision Q3 B), and Discord would
        // open the channel in between.
        const check = selfRoleChecker(snapshot, settings);
        const { member: memberRole, guest: guestRole } = settings.boundRoles;
        const withoutAccess =
          (memberRole !== null || guestRole !== null) &&
          !bound.some((roleId) => member.roles.includes(roleId));
        add = add.filter((roleId) => {
          const verdict = check(roleId);
          return verdict.problems.length === 0 && !(withoutAccess && verdict.opens.length > 0);
        });
        remove = remove.filter((roleId) => removableBy(check(roleId)));
      }
      let skipped =
        plan.skipped + plan.add.length - add.length + plan.remove.length - remove.length;
      if (add.length === 0 && remove.length === 0)
        return { status: "applied", added: 0, removed: 0, skipped };
      if (!this.app.discord.selfRoles)
        throw new Failure(
          "configuration",
          "Self-service role writes aren't wired in this process.",
        );
      await guard();
      const write = await this.app.discord.selfRoles(guildId, userId, add, remove, "chosen");
      skipped += write.skipped;
      return { status: "applied", added: write.added, removed: write.removed, skipped };
    } finally {
      if (locked)
        await connection
          .query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lock])
          .catch(() => {});
      connection.release();
    }
  }
}
