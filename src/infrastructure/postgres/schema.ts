/** Drizzle maps the existing schema; numbered SQL migrations own its constraints and triggers. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { json } from "../../domain/values.js";

/** Preserve the database's unsigned-decimal domain rather than narrowing external IDs to bigint. */
const externalId = customType<{ data: string; driverData: string }>({
  dataType: () => "external_id",
});
/** Audit/job payloads can contain exact bigint values, serialized using the application's policy. */
const payload = customType<{ data: unknown; driverData: unknown }>({
  dataType: () => "jsonb",
  toDriver: (value) => json(value),
  // node-postgres already decodes JSONB, including scalar JSON strings.
  fromDriver: (value) => value,
});
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const money = (name: string) => bigint(name, { mode: "bigint" });

export const freeCompanies = pgTable("free_companies", {
  id: externalId("id").primaryKey(),
  name: text("name").notNull(),
  tag: text("tag").notNull().default(""),
  world: text("world").notNull(),
  dc: text("dc"),
  profile_at: instant("profile_at"),
  last_successful_roster_at: instant("last_successful_roster_at"),
  last_attempt_at: instant("last_attempt_at"),
  last_error: text("last_error"),
  source_timestamp: text("source_timestamp"),
});
export const characters = pgTable("characters", {
  id: externalId("id").primaryKey(),
  name: text("name").notNull(),
  world: text("world").notNull(),
  dc: text("dc"),
  fc_hint: externalId("fc_hint"),
  profile_at: instant("profile_at"),
  /** The scheduler queues no profile refresh before this (migration 007). */
  profile_retry_at: instant("profile_retry_at"),
  /** The first Lodestone 404 of the two-404 unlink rule; cleared by any later sighting. */
  profile_missing_at: instant("profile_missing_at"),
});
export const users = pgTable("users", { id: externalId("id").primaryKey() });
export const guilds = pgTable("guilds", {
  id: externalId("id").primaryKey(),
  fc_id: externalId("fc_id"),
  member_role_id: externalId("member_role_id"),
  guest_role_id: externalId("guest_role_id"),
  officer_role_id: externalId("officer_role_id"),
  leader_role_id: externalId("leader_role_id"),
  officer_rank_name: text("officer_rank_name"),
  officer_rank_key: text("officer_rank_key"),
  ledger_channel_id: externalId("ledger_channel_id"),
  officer_notifications_channel_id: externalId("officer_notifications_channel_id"),
  guest_application_channel_id: externalId("guest_application_channel_id"),
  /**
   * Guest-application switch (migration 006, owner decision 2026-09-24), separate from the review
   * channel: /apply opens only when it is on and a review channel and a Guest role are set. Guilds
   * start off; /setup onboarding turns it on, and imports keep it off with their legacy channel
   * stored.
   */
  guest_applications_enabled: boolean("guest_applications_enabled").notNull().default(false),
  lobby_channel_id: externalId("lobby_channel_id"),
  officer_channel_id: externalId("officer_channel_id"),
  access_policy_enabled: boolean("access_policy_enabled").notNull().default(false),
  access_everyone_before: text("access_everyone_before"),
  revision: money("revision").notNull().default(1n),
  active: boolean("active").notNull().default(true),
  effects_enabled: boolean("effects_enabled").notNull().default(false),
  /**
   * Managed-role layout switch (CFG-07). On: keep the managed roles displayed separately in one
   * consecutive FC Leader > Officer > Member > Guest block. Off: never change any role's hoist flag
   * or position; access roles are still assigned. Since 2.35.0 a guild first configured by /config
   * or /setup onboarding starts off, because the application inserts it with NEW_GUILD_ROW
   * (src/application/guild-defaults.ts); imported guilds start off too. The column default stays
   * on (schema 010, no migration), and existing rows keep their saved value.
   */
  role_layout_enabled: boolean("role_layout_enabled").notNull().default(true),
  /**
   * First-activation grandfathering: NULL never applies (guilds not imported from the legacy bot),
   * 'pending' awaits the imported guild's single first-activation run, 'completed' records that run.
   */
  guest_grandfather: text("guest_grandfather", { enum: ["pending", "completed"] }),
  /** Set exactly when guest_grandfather is 'completed' (the guest_grandfather_completion CHECK). */
  guest_grandfathered_at: instant("guest_grandfathered_at"),
  /**
   * Where update posts go (migration 009, owner decisions 2026-09-25); NULL means posts are off.
   * The changelog_baseline CHECK requires changelog_version whenever this is set.
   */
  changelog_channel_id: externalId("changelog_channel_id"),
  /**
   * The newest version this guild was told about: MAJOR.MINOR.PATCH[-pre] (the migration's CHECK).
   * Setting a channel for the first time raises it to the running version, so nothing is posted
   * until the next release with a member note; a delivered or empty post moves it forward with a
   * compare-and-set. The bot never lowers it, so restarts and rollbacks never post again.
   */
  changelog_version: text("changelog_version"),
  created_at: instant("created_at").notNull().defaultNow(),
});
export const guildUsers = pgTable(
  "guild_users",
  {
    guild_id: externalId("guild_id").notNull(),
    user_id: externalId("user_id").notNull(),
    present: boolean("present").notNull().default(false),
    joined_at: instant("joined_at"),
    imported: boolean("imported").notNull().default(false),
    primary_character_id: externalId("primary_character_id"),
    nickname_enabled: boolean("nickname_enabled").notNull().default(false),
    nickname_baseline_set: boolean("nickname_baseline_set").notNull().default(false),
    nickname_before: text("nickname_before"),
    /** NULL is a real last-written value when restoring a member's absence of a nickname. */
    nickname_last: text("nickname_last"),
    nickname_written: boolean("nickname_written").notNull().default(false),
    /** Pending/expected distinguishes a late bot acknowledgement from an independent manual edit. */
    nickname_expected: text("nickname_expected"),
    nickname_pending: boolean("nickname_pending").notNull().default(false),
    nickname_restore: boolean("nickname_restore").notNull().default(false),
    nickname_suspended: boolean("nickname_suspended").notNull().default(false),
    local_member_loss: boolean("local_member_loss").notNull().default(false),
    /**
     * Officer status notices (migration 010, issue #31): the member's last announced and last
     * decisive access, and confirmed FC departures not yet posted. NULL until first observed;
     * src/domain/status.ts validates it on every read, and an unreadable value counts as NULL.
     */
    status_state: payload("status_state"),
    /** When something first waited to be announced (database clock); NULL when nothing waits. */
    status_since: instant("status_since"),
    /** The member's frozen lines in the status post being sent; NULL outside a post in flight. */
    status_posting: payload("status_posting"),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.user_id] })],
);
export const links = pgTable("links", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  user_id: externalId("user_id").notNull(),
  character_id: externalId("character_id").notNull(),
  active: boolean("active").notNull().default(true),
  provenance: text("provenance").notNull(),
  actor_id: externalId("actor_id"),
  reason: text("reason"),
  source: payload("source").notNull().default(sql`'{}'::jsonb`),
  created_at: instant("created_at").notNull().defaultNow(),
  ended_at: instant("ended_at"),
});
export const challenges = pgTable("challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  user_id: externalId("user_id").notNull(),
  character_id: externalId("character_id").notNull(),
  token_hash: text("token_hash").notNull(),
  issued_at: instant("issued_at").notNull().defaultNow(),
  expires_at: instant("expires_at").notNull(),
  consumed_at: instant("consumed_at"),
  replaced_at: instant("replaced_at"),
});
export const rosterSnapshots = pgTable("roster_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  fc_id: externalId("fc_id").notNull(),
  started_at: instant("started_at").notNull(),
  observed_at: instant("observed_at").notNull(),
  member_count: integer("member_count").notNull(),
  evidence: payload("evidence").notNull(),
});
export const rosterMembers = pgTable(
  "roster_members",
  {
    snapshot_id: uuid("snapshot_id").notNull(),
    character_id: externalId("character_id").notNull(),
    fc_rank_name: text("fc_rank_name"),
    fc_rank_key: text("fc_rank_key"),
    is_fc_leader: boolean("is_fc_leader"),
  },
  (table) => [primaryKey({ columns: [table.snapshot_id, table.character_id] })],
);
export const membership = pgTable(
  "membership",
  {
    guild_id: externalId("guild_id").notNull(),
    fc_id: externalId("fc_id").notNull(),
    character_id: externalId("character_id").notNull(),
    state: text("state", { enum: ["present", "missing", "absent"] }).notNull(),
    first_absence_at: instant("first_absence_at"),
    snapshot_id: uuid("snapshot_id"),
    confirmed_snapshot_id: uuid("confirmed_snapshot_id"),
    source: payload("source").notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.fc_id, table.character_id] })],
);
export const membershipHistory = pgTable("membership_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  user_id: externalId("user_id").notNull(),
  fc_id: externalId("fc_id").notNull(),
  link_id: uuid("link_id").notNull(),
  snapshot_id: uuid("snapshot_id"),
  source: payload("source").notNull().default(sql`'{}'::jsonb`),
  observed_at: instant("observed_at").notNull().defaultNow(),
});
export const guestState = pgTable(
  "guest_state",
  {
    guild_id: externalId("guild_id").notNull(),
    user_id: externalId("user_id").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    changed_at: instant("changed_at").notNull().defaultNow(),
    actor_id: externalId("actor_id"),
    reason: text("reason"),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.user_id] })],
);
export const guestGrants = pgTable("guest_grants", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  user_id: externalId("user_id").notNull(),
  /**
   * 'approved' (application review), 'manual' (/guest grant), 'imported_guest' (legacy import) or
   * 'grandfathered' (first activation of an imported guild); every provenance is equally durable.
   */
  provenance: text("provenance").notNull(),
  source_key: text("source_key").notNull(),
  actor_id: externalId("actor_id"),
  reason: text("reason"),
  source: payload("source").notNull().default(sql`'{}'::jsonb`),
  created_at: instant("created_at").notNull().defaultNow(),
  /**
   * Set by /guest reset (migration 006): the grant is history, no longer conferring Guest. Rows are
   * never deleted, so a repeated import's source key still finds them.
   */
  ended_at: instant("ended_at"),
  ended_by: externalId("ended_by"),
  ended_reason: text("ended_reason"),
});
export const guestApplications = pgTable("guest_applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  user_id: externalId("user_id").notNull(),
  joined_at: instant("joined_at").notNull(),
  created_at: instant("created_at").notNull().defaultNow(),
  state: text("state").notNull().default("pending"),
  channel_id: externalId("channel_id").notNull(),
  message_id: externalId("message_id"),
  reviewer_id: externalId("reviewer_id"),
  decided_at: instant("decided_at"),
  reason: text("reason"),
  introduction: text("introduction"),
  interest: text("interest"),
});
export const ledgerAccounts = pgTable("ledger_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  fc_id: externalId("fc_id").notNull(),
  balance: money("balance"),
  sequence: money("sequence").notNull().default(0n),
});
export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  account_id: uuid("account_id").notNull(),
  sequence: money("sequence").notNull(),
  operation: text("operation").notNull(),
  delta: money("delta").notNull(),
  balance: money("balance").notNull(),
  actor_id: externalId("actor_id"),
  guild_id: externalId("guild_id").notNull(),
  note: text("note").notNull(),
  event_at: instant("event_at").notNull().defaultNow(),
  idempotency_key: text("idempotency_key").notNull(),
  correction_id: uuid("correction_id"),
  source: payload("source").notNull().default(sql`'{}'::jsonb`),
});
export const jobs = pgTable("jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  guild_id: externalId("guild_id"),
  user_id: externalId("user_id"),
  payload: payload("payload").notNull(),
  payload_version: integer("payload_version").notNull().default(1),
  dedupe_key: text("dedupe_key").notNull(),
  status: text("status").notNull().default("queued"),
  generation: integer("generation").notNull().default(1),
  attempts: integer("attempts").notNull().default(0),
  due_at: instant("due_at").notNull().defaultNow(),
  lease_until: instant("lease_until"),
  lease_token: uuid("lease_token"),
  created_at: instant("created_at").notNull().defaultNow(),
  completed_at: instant("completed_at"),
  last_error: text("last_error"),
  result: payload("result"),
  message_id: externalId("message_id"),
});
export const deliveryAttempts = pgTable("delivery_attempts", {
  id: money("id").primaryKey().generatedAlwaysAsIdentity(),
  job_id: uuid("job_id"),
  attempted_at: instant("attempted_at").notNull().defaultNow(),
  status: text("status").notNull(),
  message_id: externalId("message_id"),
  diagnostic: text("diagnostic"),
});
export const syncRuns = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  guild_id: externalId("guild_id").notNull(),
  requester_id: externalId("requester_id"),
  job_id: uuid("job_id"),
  created_at: instant("created_at").notNull().defaultNow(),
  enumeration_completed_at: instant("enumeration_completed_at"),
  status: text("status").notNull().default("queued"),
  result: payload("result"),
});
export const syncRunJobs = pgTable(
  "sync_run_jobs",
  {
    run_id: uuid("run_id").notNull(),
    job_id: uuid("job_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.run_id, table.job_id] })],
);
export const retiredRoles = pgTable(
  "retired_roles",
  {
    guild_id: externalId("guild_id").notNull(),
    role_id: externalId("role_id").notNull(),
    revision: money("revision").notNull(),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.role_id] })],
);
export const auditEvents = pgTable("audit", {
  id: money("id").primaryKey().generatedAlwaysAsIdentity(),
  guild_id: externalId("guild_id").notNull(),
  actor_id: externalId("actor_id"),
  action: text("action").notNull(),
  target: text("target"),
  details: payload("details").notNull().default(sql`'{}'::jsonb`),
  event_at: instant("event_at").notNull().defaultNow(),
});
export const imports = pgTable("imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  fingerprint: text("fingerprint").notNull(),
  report: payload("report").notNull(),
  source_timezone: text("source_timezone").notNull(),
  snapshot_checksum: text("snapshot_checksum").notNull(),
  imported_at: instant("imported_at").notNull().defaultNow(),
});
export const officerOverrides = pgTable(
  "officer_overrides",
  {
    guild_id: externalId("guild_id").notNull(),
    user_id: externalId("user_id").notNull(),
    state: text("state").notNull(),
    actor_id: externalId("actor_id").notNull(),
    reason: text("reason").notNull(),
    changed_at: instant("changed_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.user_id] })],
);

/** First-observed ACLs support recovery; stored audience classification survives role replacement. */
export const channelAccessPolicies = pgTable(
  "channel_access_policies",
  {
    guild_id: externalId("guild_id").notNull(),
    channel_id: externalId("channel_id").notNull(),
    staff_only: boolean("staff_only").notNull(),
    original_state: payload("original_state").notNull(),
    created_at: instant("created_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guild_id, table.channel_id] })],
);
/**
 * Issue reports (migration 008): one row per fingerprint, saved before delivery so nothing is lost
 * while GitHub or the token is unavailable. See src/application/issue-reports.ts.
 */
export const issueReports = pgTable("issue_reports", {
  fingerprint: text("fingerprint").primaryKey(),
  source: text("source").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  latest: text("latest"),
  guild_id: externalId("guild_id"),
  user_id: externalId("user_id"),
  occurrences: integer("occurrences").notNull().default(1),
  posted_occurrences: integer("posted_occurrences").notNull().default(0),
  issue_number: integer("issue_number"),
  issue_created_at: instant("issue_created_at"),
  posted_at: instant("posted_at"),
  first_at: instant("first_at").notNull().defaultNow(),
  last_at: instant("last_at").notNull().defaultNow(),
});
/**
 * Browser sessions for the web pages (migration 011, issue #43): the SHA-256 of each cookie token,
 * never the token, with the user and timestamps only. src/web/sessions.ts decides every expiry on
 * the database clock; a restore deletes every row.
 */
export const webSessions = pgTable("web_sessions", {
  /** 64 lowercase hex characters (the migration's CHECK). */
  token_hash: text("token_hash").primaryKey(),
  user_id: externalId("user_id").notNull(),
  created_at: instant("created_at").notNull().defaultNow(),
  /** When the user last signed in with Discord; v4 can require a recent one for sensitive writes. */
  authenticated_at: instant("authenticated_at").notNull().defaultNow(),
  /** Written at most every SESSION_TOUCH_MS; the idle expiry counts from it. */
  last_seen_at: instant("last_seen_at").notNull().defaultNow(),
  /** The absolute expiry, set at sign-in. */
  expires_at: instant("expires_at").notNull(),
});
