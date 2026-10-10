/** Persistence/port contracts. IDs stay strings and monetary/sequence values stay exact. */
import type {
  guilds,
  guildUsers,
  guestApplications,
  ledgerEntries,
} from "../infrastructure/postgres/schema.js";
import type { AccessRoles, AccessSnapshot, ChannelAudience } from "../domain/channel-access.js";
import type { ReleaseNote } from "../domain/changelog.js";
import type { StatusEntry } from "../domain/status.js";
import type { VisibilityGuild } from "../domain/visibility.js";

/** Configuration revision fences queued effects; activation is separate from bot membership. */
export type GuildRecord = Omit<typeof guilds.$inferSelect, "created_at">;

/** Provisioned identities plus the original snapshot captured before durable ACL enforcement. */
export interface PreparedAccess {
  lobby: { id: string; created: boolean };
  officers: { id: string; created: boolean };
  snapshot: AccessSnapshot;
}
/** One captured inventory per reconciliation; target writes still revalidate their own state. */
export interface GuildAccessSession {
  snapshot: AccessSnapshot;
  channel(channel: string, audience: ChannelAudience, guard: () => Promise<void>): Promise<boolean>;
  restrictEveryone(guard: () => Promise<void>): Promise<boolean>;
}
/** Channel policy has its own port so membership reconciliation remains independently testable. */
export interface GuildAccessPort {
  check(guild: string, actor: string): Promise<void>;
  prepare(
    guild: string,
    actor: string,
    roles: AccessRoles,
    lobby: string | null,
    officers: string | null,
  ): Promise<PreparedAccess>;
  snapshot(guild: string, roles: AccessRoles): Promise<AccessSnapshot>;
  begin(guild: string, roles: AccessRoles): Promise<GuildAccessSession>;
}

/** A nickname baseline distinguishes successful bot writes from pending/ambiguous delivery. */
export type UserRecord = Omit<typeof guildUsers.$inferSelect, "imported" | "local_member_loss">;
/** A review's join context, decision, and message identity survive process restarts. */
export type ApplicationRecord = typeof guestApplications.$inferSelect;
/** Immutable financial decision; delivery status lives in separate outbox records. */
export type EntryRecord = Omit<typeof ledgerEntries.$inferSelect, "correction_id" | "source">;
/** Application-owned snapshot of a current Discord member, avoiding SDK objects in policy. */
export interface MemberView {
  id: string;
  guildId: string;
  joinedAt: Date;
  nickname: string | null;
  roles: string[];
  bot: boolean;
  /**
   * The server owner, whose nickname Discord lets no bot change. Absent in test fakes means not
   * the owner; the gateway always sets it.
   */
  owner?: boolean;
}
/**
 * What a ledger channel post shows: the immutable entry, and the entry number of the entry an
 * adjustment corrects (null when it names none). Only persisted values, so every retry of the
 * same job renders byte-identical JSON and the nonce deduplicates it.
 */
export interface LedgerPostView {
  readonly entry: Pick<
    EntryRecord,
    "id" | "sequence" | "operation" | "delta" | "balance" | "actor_id" | "note" | "event_at"
  >;
  readonly correctionSequence: bigint | null;
}
/**
 * What an update post shows (2.25.0): the running version, the version the guild was last told
 * about, the release notes of the releases in between (newest first), and the CHANGELOG link. Only
 * values fixed for the running build, so every retry of the post renders byte-identical JSON.
 */
export interface ChangelogPostView {
  readonly version: string;
  readonly previous: string;
  readonly notes: readonly ReleaseNote[];
  /** The full CHANGELOG on GitHub; the post's only link. */
  readonly url: string;
}
/**
 * What an officer status post shows (2.29.0, issue #31): one frozen batch's entries in the order
 * they were frozen, and when the batch was frozen (the embed timestamp, ISO). Only stored values,
 * so a resend of the batch renders byte-identical JSON under its status:<batch> nonce key.
 */
export interface StatusPostView {
  readonly frozenAt: string;
  readonly entries: readonly StatusEntry[];
}
/**
 * A channel post as data; the gateway renders it through the reply presenters, so jobs never
 * build message text. `text` is the documented plain-text exclusion (officer.notify, and the
 * DevBot smoke check): already escaped by its caller and sent as content.
 */
export type PostMessage =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "changelog"; readonly view: ChangelogPostView }
  | { readonly kind: "ledger"; readonly view: LedgerPostView }
  | { readonly kind: "review"; readonly application: ApplicationRecord }
  | { readonly kind: "status"; readonly view: StatusPostView };
/** A direct message as data: the applicant's approval or denial, with the reapply cooldown. */
export interface DirectMessage {
  readonly kind: "decision";
  readonly application: ApplicationRecord;
  readonly cooldownSeconds: number;
}
/**
 * What a self-service role write did: counts only, never which roles (owner decision Q4 A), so a
 * job result built from it can't reveal anyone's choices.
 */
export interface SelfRoleWrite {
  readonly added: number;
  readonly removed: number;
  /** Roles Discord refused one at a time: deleted meanwhile (10011) or moved above TaruBot. */
  readonly skipped: number;
}
/**
 * Why TaruBot changes a self-service role, for Discord's audit log: the member chose it on My
 * roles, or reconciliation takes a channel-opening menu role from someone a reconciliation pass
 * leaves with none of Member, Guest, Officer and FC Leader (owner decision Q3 B).
 */
export type SelfRoleReason = "chosen" | "access";
/** Effect boundary implemented by DiscordGateway and controlled integration-test fixtures. */
export interface DiscordPort {
  /** Null is an observed departure; transport failures reject instead of implying absence. */
  member(guild: string, user: string): Promise<MemberView | null>;
  /** Resolve only after complete member enumeration has been checked. */
  members(guild: string): Promise<MemberView[]>;
  /** Validate access-role permissions and both actor/bot hierarchy where applicable. */
  validateRole(guild: string, role: string, actor?: string, channelAccess?: boolean): Promise<void>;
  /** Check guild ownership and the message/embed/history permissions needed for delivery. */
  validateChannel(guild: string, channel: string): Promise<void>;
  /** Individual deltas must preserve unrelated roles, including concurrent external changes. */
  roles(guild: string, user: string, add: string[], remove: string[]): Promise<void>;
  /** Hoist/reorder only configured role IDs; guard is checked before externally visible writes. */
  layoutRoles(
    guild: string,
    priority: readonly string[],
    guard: () => Promise<void>,
  ): Promise<unknown>;
  /** Return false if a fresh nickname differs from expected; never overwrite that manual change. */
  nickname(
    guild: string,
    user: string,
    value: string | null,
    expected: string | null,
  ): Promise<boolean>;
  /** Stable keys identify retries of the same logical notification. */
  send(guild: string, channel: string, message: PostMessage, key: string): Promise<string>;
  /** Redraw a review message from its durable application record, recreating a deleted one. */
  editReview(application: ApplicationRecord): Promise<string>;
  /** Best-effort delivery is tracked independently from approval/denial. */
  dm(user: string, message: DirectMessage): Promise<void>;
  /**
   * TaruBot's view of the guild from the gateway caches (2.35.0, #46), for /config validate, the
   * officer alert and /setup overrides; null when the gateway can't say yet. `fresh` refetches
   * roles and TaruBot's member first; channels always come from the cache. Optional, so test
   * fakes may omit it (callers then report the view as unknown).
   */
  visibility?(guild: string, fresh: boolean): Promise<VisibilityGuild | null>;
  /**
   * Self-service menu roles, one REST call per role (2.40.0): removes, then adds, each leaving
   * every other role alone. There is no validateRole, whose messages name roles: the "chosen"
   * caller (the roles.self job) checked each role against a fresh snapshot just before, and the
   * "access" caller (reconciliation, owner decision Q3 B) judged TaruBot's cached view and only
   * ever removes, which escalates nothing. Per-role refusals don't fail the whole write: a role
   * deleted meanwhile (10011) is skipped, and so is one that moved above TaruBot (50013 while
   * TaruBot still has Manage Roles); without Manage Roles it throws a role-free `blocked`
   * Failure, a server-wide problem the job waits on. Optional, so test fakes may omit it: without
   * it reconciliation skips the removals, and the roles.self job fails as `configuration`.
   */
  selfRoles?(
    guild: string,
    user: string,
    add: readonly string[],
    remove: readonly string[],
    reason: SelfRoleReason,
  ): Promise<SelfRoleWrite>;
  /**
   * The member's roles from the gateway's member cache, which GuildMemberUpdate keeps current, so
   * My roles reflects a job's change at once without a Discord request; null when the member isn't
   * cached (the caller falls back to the actor's roles). Optional, like visibility.
   */
  cachedRoles?(guild: string, user: string): readonly string[] | null;
}
