/** Pure channel-visibility policy; Discord permission aggregation is tested against the SDK. */
import { OverwriteType, PermissionFlagsBits as P } from "discord.js";
import { Failure } from "./values.js";

/**
 * The deny-mask bits onboarding's pass lifts from TaruBot's own member entry: what its channel
 * writes need (Manage Permissions, as the channel screen names Manage Roles, and Manage Channels),
 * plus Connect, whose deny in a voice or stage channel implicitly denies Manage Channels.
 */
export const ONBOARDING_LIFT = P.ManageRoles | P.ManageChannels | P.Connect;

export type ChannelAudience = "lobby" | "members" | "officers";
export interface AccessRoles {
  member: string;
  guest: string;
  officer: string;
  leader: string;
}
export interface AccessOverwrite {
  id: string;
  type: OverwriteType;
  allow: string;
  deny: string;
}
export interface AccessChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  overwrites: AccessOverwrite[];
  everyoneVisible: boolean;
  memberVisible: boolean;
  guestVisible: boolean;
}
export interface AccessSnapshot {
  botId: string;
  everyonePermissions: string;
  /** Discord's community-updates channel and its parent remain outside onboarding ownership. */
  excludedChannelIds: string[];
  /** Preserve the guild default if changing it could affect an excluded channel's visibility. */
  preserveEveryoneView: boolean;
  channels: AccessChannel[];
}

/** An enabled gate needs all four bindings; deleted Discord resources are checked by the adapter. */
export function accessRoles(bindings: {
  member_role_id: string | null;
  guest_role_id: string | null;
  officer_role_id: string | null;
  leader_role_id: string | null;
}): AccessRoles {
  if (
    !bindings.member_role_id ||
    !bindings.guest_role_id ||
    !bindings.officer_role_id ||
    !bindings.leader_role_id
  )
    throw new Failure(
      "blocked",
      "Onboarding requires all four access roles. Run /setup onboarding to repair them.",
    );
  const roles = {
    member: bindings.member_role_id,
    guest: bindings.guest_role_id,
    officer: bindings.officer_role_id,
    leader: bindings.leader_role_id,
  };
  if (new Set(Object.values(roles)).size !== 4)
    throw new Failure("blocked", "Onboarding roles must be distinct.");
  return roles;
}

/** New plain channels start closed after @everyone loses View Channel; that alone is not staff-only. */
export function initiallyStaffOnly(
  channel: AccessChannel,
  alreadyEnabled: boolean,
  staffParent: boolean,
): boolean {
  if (staffParent) return true;
  if (channel.memberVisible || channel.guestVisible || channel.everyoneVisible) return false;
  return (
    !alreadyEnabled ||
    // Any explicit visibility exception is privacy evidence, regardless of overwrite target.
    channel.overwrites.some(
      (overwrite) => ((BigInt(overwrite.allow) | BigInt(overwrite.deny)) & P.ViewChannel) !== 0n,
    )
  );
}

/**
 * Normalize only visibility grants; retain unrelated permission bits and remove empty overwrites.
 * The one exception is ONBOARDING_LIFT on TaruBot's own member entry (2.35.0, below).
 */
export function channelAccessOverwrites(
  current: readonly AccessOverwrite[],
  guild: string,
  bot: string,
  roles: AccessRoles,
  audience: ChannelAudience,
): AccessOverwrite[] {
  const values = new Map(
    current.map((overwrite) => [
      overwrite.id,
      {
        id: overwrite.id,
        type: overwrite.type,
        allow: BigInt(overwrite.allow) & ~P.ViewChannel,
        deny: BigInt(overwrite.deny) & ~P.ViewChannel,
      },
    ]),
  );
  const set = (id: string, type: OverwriteType, allow: bigint, deny: bigint): void => {
    const before = values.get(id) ?? { id, type, allow: 0n, deny: 0n };
    values.set(id, {
      ...before,
      type,
      allow: (before.allow & ~deny) | allow,
      deny: (before.deny & ~allow) | deny,
    });
  };
  const lobbyChat =
    P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.UseApplicationCommands;
  const threadCreation = P.CreatePublicThreads | P.CreatePrivateThreads;
  set(
    guild,
    OverwriteType.Role,
    audience === "lobby" ? lobbyChat : 0n,
    audience === "lobby" ? threadCreation : P.ViewChannel,
  );
  for (const id of [roles.member, roles.guest])
    set(
      id,
      OverwriteType.Role,
      audience === "members" ? P.ViewChannel : 0n,
      audience === "members" ? 0n : P.ViewChannel,
    );
  // Role allows take precedence over role denies: an Officer who also holds Member can see the lobby.
  for (const id of [roles.officer, roles.leader])
    set(id, OverwriteType.Role, audience === "members" ? P.ViewChannel : lobbyChat, 0n);
  set(
    bot,
    OverwriteType.Member,
    P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles,
    0n,
  );
  // TaruBot's own entry never keeps a deny that stops onboarding's own writes (2.35.0, #46).
  // /setup overrides' mask denies Manage Permissions and Manage Channels on that entry in channels
  // no setting names, and Connect in voice and stage channels and categories (in a voice or stage
  // channel a Connect deny also denies Manage Channels). Onboarding manages every channel itself,
  // so its pass lifts exactly those three. The mask's Read Message History deny is already
  // overridden by the allow above, and its Create Invite deny stays, like every other bit on the
  // entry. A server that turns onboarding on after /setup overrides therefore needs Administrator
  // only for that first pass (the mask's Manage Permissions deny otherwise refuses the write).
  // Where onboarding runs without Administrator (DevBot's test guild), observe() already refuses a
  // Manage Permissions or Manage Channels deny on that entry, so only a Connect deny put there by
  // hand would change a pass: one write that removes it.
  const own = values.get(bot);
  if (own?.type === OverwriteType.Member) own.deny &= ~ONBOARDING_LIFT;
  return [...values.values()]
    .filter((value) => value.allow !== 0n || value.deny !== 0n)
    .map((value) => ({ ...value, allow: String(value.allow), deny: String(value.deny) }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** Ignore API ordering and empty entries when deciding whether another write is necessary. */
export function sameOverwrites(
  left: readonly AccessOverwrite[],
  right: readonly AccessOverwrite[],
): boolean {
  const canonical = (items: readonly AccessOverwrite[]) =>
    JSON.stringify(
      items
        .filter((item) => BigInt(item.allow) !== 0n || BigInt(item.deny) !== 0n)
        .map((item) => ({
          id: item.id,
          type: item.type,
          allow: String(BigInt(item.allow)),
          deny: String(BigInt(item.deny)),
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  return canonical(left) === canonical(right);
}

/** One per-entry write of a channel's overwrites: an entry's exact bits (PUT), or its removal. */
export type OverwriteWrite =
  | {
      readonly kind: "put";
      readonly id: string;
      readonly type: OverwriteType;
      readonly allow: string;
      readonly deny: string;
    }
  | { readonly kind: "delete"; readonly id: string };

/**
 * The per-entry writes that take a channel's overwrites from `before` to `desired` (2.43.0), for
 * onboarding's pass, which once sent the whole list in one PATCH. Only entries that change are
 * written, so an entry the policy doesn't touch is never resent: Discord lets a bot allow or deny
 * only permissions it holds itself, and resending an unchanged entry that carries one it lacks
 * (Mention Everyone, set by hand on TaruBot's role in the officer notifications channel for mod
 * mail's pings) could be refused. Empty entries count as absent, as in sameOverwrites.
 *
 * The writes land one at a time, so the order keeps every state in between no more open than the
 * channel before or after the pass. Discord's overwrite algorithm only ever grants more as an
 * entry gains allow bits or loses deny bits, so:
 * 1. TaruBot's own member entry first, at its desired value: it only ever widens TaruBot's own
 *    access (the policy gives TaruBot View, Send, History, Embed and Attach, and lifts the denies
 *    that would stop its writes), never anyone else's, and it keeps TaruBot able to finish, where
 *    a restricted @everyone written first could otherwise hide the channel from it mid-pass;
 * 2. every other changed entry at its restrictive meet: the allow bits both values share and the
 *    deny bits either has (removed, when nothing is left), which is no more open than before;
 * 3. then each of those at its desired value, opening only towards what the policy wants.
 * An entry whose change is only restrictive is final after step 2, and one whose change is only
 * permissive skips it, so most changes are one request each. Sorted by ID within each step.
 */
export function overwriteWrites(
  before: readonly AccessOverwrite[],
  desired: readonly AccessOverwrite[],
  bot: string,
): OverwriteWrite[] {
  interface Bits {
    readonly type: OverwriteType;
    readonly allow: bigint;
    readonly deny: bigint;
  }
  const entries = (items: readonly AccessOverwrite[]) =>
    new Map<string, Bits>(
      items
        .filter((item) => BigInt(item.allow) !== 0n || BigInt(item.deny) !== 0n)
        .map((item) => [
          item.id,
          { type: item.type, allow: BigInt(item.allow), deny: BigInt(item.deny) },
        ]),
    );
  const from = entries(before);
  const to = entries(desired);
  const same = (a: Bits | undefined, b: Bits | undefined) =>
    (a === undefined && b === undefined) ||
    (a !== undefined &&
      b !== undefined &&
      a.type === b.type &&
      a.allow === b.allow &&
      a.deny === b.deny);
  const write = (id: string, value: Bits | undefined): OverwriteWrite =>
    value === undefined || (value.allow === 0n && value.deny === 0n)
      ? { kind: "delete", id }
      : { kind: "put", id, type: value.type, allow: String(value.allow), deny: String(value.deny) };
  const changed = [...new Set([...from.keys(), ...to.keys()])]
    .filter((id) => !same(from.get(id), to.get(id)))
    .sort((left, right) => left.localeCompare(right));
  const writes: OverwriteWrite[] = [];
  const own = changed.filter((id) => id === bot && to.get(id)?.type === OverwriteType.Member);
  for (const id of own) writes.push(write(id, to.get(id)));
  const others = changed.filter((id) => !own.includes(id));
  const finals: string[] = [];
  for (const id of others) {
    const a = from.get(id);
    const b = to.get(id);
    const type = b?.type ?? a?.type ?? OverwriteType.Role;
    const allow = (a?.allow ?? 0n) & (b?.allow ?? 0n);
    const meet: Bits = { type, allow, deny: ((a?.deny ?? 0n) | (b?.deny ?? 0n)) & ~allow };
    const empty = meet.allow === 0n && meet.deny === 0n;
    // Already as restrictive as it gets: the change only opens it, so it waits for step 3.
    if (!same(empty ? undefined : meet, a)) writes.push(write(id, meet));
    if (!same(empty ? undefined : meet, b)) finals.push(id);
  }
  for (const id of finals) writes.push(write(id, to.get(id)));
  return writes;
}
