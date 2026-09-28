/**
 * /setup onboarding's dry run (2.35.0, #46): what `/setup onboarding confirm:true` would create,
 * reuse and change, and every refusal it would hit, read without writing anything. Since 2.35.0
 * both /setup subcommands are dry runs unless `confirm:true`, so a server manager sees the whole
 * picture first; the production rule is "never run /setup onboarding confirm:true".
 *
 * The real run stops at its first refusal. The dry run instead collects each one the real run
 * would throw as a SetupBlocker, so a server with two hidden channels and a role above TaruBot
 * sees all three at once. Only the refusals about the person asking stay thrown (their role
 * permissions and bad option values), since no blocker list can help them. A check whose
 * prerequisite failed is skipped, and its field reads null or 'unknown'.
 *
 * This module holds the plan's types, the read-only port DiscordGuildAccess implements for it, and
 * the pure pieces RoleAdministration.planSetup assembles the plan from.
 */
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import {
  type AccessChannel,
  type AccessRoles,
  type AccessSnapshot,
  type ChannelAudience,
  channelAccessOverwrites,
  initiallyStaffOnly,
  sameOverwrites,
} from "../domain/channel-access.js";
import type { FailureCode, FailureDetail } from "../domain/failures.js";
import { existingRoleId } from "../domain/role-selection.js";
import { Failure, normalized } from "../domain/values.js";
import type { EffectsMode, FcRef } from "./results.js";

/** A refusal the real run would throw, as the dry run lists it. */
export interface SetupBlocker {
  readonly code: FailureCode;
  readonly message: string;
  readonly detail?: FailureDetail;
}

/** Where a room comes from: an existing channel, a new one, or unknown behind a blocker. */
export interface RoomPlan {
  readonly action: "create" | "reuse" | "unknown";
  readonly id: string | null;
}

/** The access-role fields, in the order setup creates them. */
export type SetupRoleField =
  | "member_role_id"
  | "guest_role_id"
  | "officer_role_id"
  | "leader_role_id";

/** One access role the real run would create, reuse, or reuse under the new prefix. */
export interface SetupRolePlan {
  readonly field: SetupRoleField;
  /** The name it would carry (the prefix and its label). */
  readonly name: string;
  readonly action: "create" | "reuse" | "rename";
  /** Null when it would be created. */
  readonly id: string | null;
}

/** What `/setup onboarding confirm:true` would do, and what stops it. */
export interface SetupPlan {
  /** A role left out is ambiguous; its blocker says why. */
  readonly roles: readonly SetupRolePlan[];
  readonly lobby: RoomPlan;
  readonly officerRoom: RoomPlan;
  readonly onboarding: {
    /** Onboarding is already on (setup then only refreshes it). */
    readonly alreadyOn: boolean;
    /** Existing managed channels whose overwrites its first pass would change; null unknown. */
    readonly channels: number | null;
    /** The first few of them, in the channel list's order. */
    readonly sample: readonly string[];
    /** Its pass would take View Channel away from @everyone; null unknown. */
    readonly everyoneLosesView: boolean | null;
  };
  readonly guestApplications: {
    /** Applications are off now, and setup turns them on. */
    readonly switchesOn: boolean;
    /** The review channel; null means the officer room. */
    readonly channel: string | null;
  };
  /** Officer notifications' channel; `defaulted` means it would be set to the officer room. */
  readonly officerNotifications: { readonly channel: string | null; readonly defaulted: boolean };
  /** Holders of an existing Officer role adopted as manual grants; null unknown. */
  readonly adopt: number | null;
  readonly fc: { readonly id: string | null; readonly company: FcRef | null };
  readonly officerRank: string | null;
  /** The role-layout switch the server would have (a new server starts with it off). */
  readonly roleLayout: boolean;
  /** Every blocker; each channel blocker separately. */
  readonly blockers: readonly SetupBlocker[];
  readonly effectsMode: EffectsMode;
}

/** What DiscordGuildAccess reads for the dry run in place of prepare(). */
export interface PreparePlan {
  /** Every refusal prepare() would throw, each channel separately. */
  readonly blockers: readonly SetupBlocker[];
  readonly lobby: RoomPlan;
  readonly officerRoom: RoomPlan;
  /** The managed channels and scope as prepare() would snapshot them; null when unreadable. */
  readonly snapshot: AccessSnapshot | null;
}

/**
 * The read-only counterparts of GuildAccessPort that the dry run needs (implemented by
 * DiscordGuildAccess; FakeGuildAccess in tests). None of them writes to Discord.
 */
export interface SetupPlanningPort {
  /**
   * The caller half of check(): the person must hold Manage Server, Manage Roles and Manage
   * Channels. Thrown as check() throws it; it is not a blocker.
   */
  checkCaller(guild: string, actor: string): Promise<void>;
  /** Every role's ID and name, read fresh, for existingRoleId. */
  roleCandidates(guild: string): Promise<readonly { readonly id: string; readonly name: string }[]>;
  /**
   * prepare() without creating anything: the management checks, the access roles that already
   * exist (`roles`), the channel scope with every hidden or unmanageable channel, and the rooms
   * it would reuse or create, with each refusal collected instead of thrown.
   */
  planPrepare(
    guild: string,
    roles: Partial<AccessRoles>,
    lobby: string | null,
    officers: string | null,
  ): Promise<PreparePlan>;
}

/** A Failure as a blocker: its code, approved message and detail. */
export function blockerOf(failure: Failure): SetupBlocker {
  return {
    code: failure.code,
    message: failure.message,
    ...(failure.detail !== undefined && { detail: failure.detail }),
  };
}

/**
 * Add a blocker unless the same refusal is already listed: the room choice and the hidden-channel
 * probe can both refuse the same saved room with the same words.
 */
export function addBlocker(blockers: SetupBlocker[], blocker: SetupBlocker): void {
  if (!blockers.some((item) => item.code === blocker.code && item.message === blocker.message))
    blockers.push(blocker);
}

/**
 * Run one check the real run would make, turning a Failure into a blocker (and undefined) so the
 * dry run carries on. Anything else, a bug or an outage, propagates.
 */
export async function collected<T>(
  blockers: SetupBlocker[],
  check: () => Promise<T> | T,
): Promise<T | undefined> {
  try {
    return await check();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    addBlocker(blockers, blockerOf(error));
    return undefined;
  }
}

/**
 * What the real run's ensureRole would do with one access role, over a read-only role list:
 * reuse the configured or same-named role (renaming it when only the prefix differs), or create
 * one. existingRoleId's ambiguity refusal is thrown, for the caller to collect.
 */
export function roleAction(
  candidates: readonly { readonly id: string; readonly name: string }[],
  name: string,
  label: string,
  configured: string | null,
): { readonly action: "create" | "reuse" | "rename"; readonly id: string | null } {
  const id = existingRoleId(candidates, name, label, configured);
  if (id === null) return { action: "create", id: null };
  const role = candidates.find((candidate) => candidate.id === id);
  // ensureRole's rename rule: the canonical label under another prefix takes the new name.
  const rename =
    role !== undefined && role.name !== name && normalized(role.name) === normalized(label);
  return { action: rename ? "rename" : "reuse", id };
}

/** The real run's distinctness refusal, when two reused roles are the same role. */
export function duplicateRoles(roles: readonly SetupRolePlan[]): Failure | null {
  const ids = roles.flatMap((role) => (role.id === null ? [] : [role.id]));
  return new Set(ids).size === ids.length
    ? null
    : new Failure("input", "Member, Guest, Officer and FC Leader must be four different roles.");
}

/**
 * The bindings onboarding's first pass would use: reused role IDs, and a stand-in for each role
 * the real run would create. A stand-in's entries would be new in every channel, so every managed
 * channel then counts as changing, which is what the real run does. Stand-ins are never valid
 * snowflakes, so they can't match a real role or overwrite.
 */
export function plannedBindings(roles: readonly SetupRolePlan[]): AccessRoles {
  const id = (field: SetupRoleField, key: keyof AccessRoles) =>
    roles.find((role) => role.field === field)?.id ?? `planned-${key}`;
  return {
    member: id("member_role_id", "member"),
    guest: id("guest_role_id", "guest"),
    officer: id("officer_role_id", "officer"),
    leader: id("leader_role_id", "leader"),
  };
}

/**
 * Each managed channel's audience, as GuildAccess.remember would record it and reconcile read it,
 * without writing: the lobby and the officer room by ID, then a stored policy, then the first
 * observation's privacy evidence (initiallyStaffOnly), categories before their children.
 */
export function plannedAudiences(
  snapshot: AccessSnapshot,
  lobby: string | null,
  officers: string | null,
  known: ReadonlyMap<string, boolean>,
  alreadyEnabled: boolean,
): Map<string, ChannelAudience> {
  const staff = new Map(known);
  const channels = snapshot.channels
    .filter((channel) => !snapshot.excludedChannelIds.includes(channel.id))
    .sort(
      (a, b) =>
        Number(b.type === ChannelType.GuildCategory) - Number(a.type === ChannelType.GuildCategory),
    );
  for (const channel of channels) {
    if (channel.id === lobby) staff.set(channel.id, false);
    else if (channel.id === officers) staff.set(channel.id, true);
    else if (!staff.has(channel.id))
      staff.set(
        channel.id,
        initiallyStaffOnly(
          channel,
          alreadyEnabled,
          channel.parentId ? staff.get(channel.parentId) === true : false,
        ),
      );
  }
  const audiences = new Map<string, ChannelAudience>();
  for (const channel of channels)
    audiences.set(
      channel.id,
      channel.id === lobby
        ? "lobby"
        : channel.id === officers || staff.get(channel.id)
          ? "officers"
          : "members",
    );
  return audiences;
}

/** How many channels a dry run names before counting the rest. */
export const SAMPLE_CHANNELS = 6;

/**
 * The existing managed channels whose overwrites onboarding's first pass would change, in the
 * snapshot's order, and whether it would take View Channel from @everyone.
 */
export function onboardingChanges(
  snapshot: AccessSnapshot,
  bindings: AccessRoles,
  audiences: ReadonlyMap<string, ChannelAudience>,
  guildId: string,
): { readonly channels: readonly string[]; readonly everyoneLosesView: boolean } {
  const changing = snapshot.channels
    .filter((channel: AccessChannel) => !snapshot.excludedChannelIds.includes(channel.id))
    .filter((channel) => {
      const audience = audiences.get(channel.id) ?? "members";
      return !sameOverwrites(
        channel.overwrites,
        channelAccessOverwrites(channel.overwrites, guildId, snapshot.botId, bindings, audience),
      );
    })
    .map((channel) => channel.id);
  return {
    channels: changing,
    everyoneLosesView:
      !snapshot.preserveEveryoneView &&
      (BigInt(snapshot.everyonePermissions) & P.ViewChannel) !== 0n,
  };
}
