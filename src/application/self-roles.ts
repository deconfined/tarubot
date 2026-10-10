/**
 * The Role menu's application operations (2.39.0, the first web writes): officers read the editor
 * and apply one edit at a time to the server's self-service role menu (src/domain/self-roles.ts).
 * Members and guests pick roles from 2.40.0; this release only configures the menu.
 *
 * Every edit is one transaction in a fixed order: the guild row FOR SHARE (configure() and /setup
 * take it FOR UPDATE, so binding an access role and adding a menu role can't interleave), the menu
 * row (created if missing) FOR UPDATE, then parse, apply the operation (its field refusals and
 * gone), the equal-state rule, the reset and revision checks, the invariant checks, the schema
 * check, the write, its audit row, and a last check that shutdown hasn't started, which rolls
 * everything back if it has. Discord is read before the transaction, never
 * inside it, and nothing here writes to Discord or queues work: a menu edit changes nobody's roles.
 *
 * Any officer may make every change (owner decision, 2026-10-09): there is no Discord Manage Roles
 * requirement and no check of the officer's own role position. What may be added is decided by the
 * domain rule set and TaruBot's own position alone.
 */
import { and, eq, sql } from "drizzle-orm";
import { authorize, type Actor } from "../domain/policy.js";
import {
  applyOperation,
  checkRoles,
  EMPTY_MENU,
  holdsAdministrator,
  type MenuFieldError,
  type MenuOperation,
  menuRoleIds,
  menuSchema,
  type RoleCheck,
  readMenu,
  SELF_ROLE_MESSAGES,
  type SelfRoleHealth,
  type SelfRoleMenu,
  type SelfRoleSettings,
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
import type { GuildRecord } from "./records.js";
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

/** The Role menu's operations; main.ts provides one as selfRolesKey. */
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
}
