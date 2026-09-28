/**
 * The failure catalog: every Failure code the bot throws, its presentation category, and the log
 * level an interaction reports it at. Pure apart from `instanceof` checks against SDK error types;
 * replies, logs and job diagnostics all key on the code here and never pattern-match message text.
 */
import { DiscordAPIError, HTTPError, RateLimitError } from "discord.js";
import { Failure } from "./values.js";

/**
 * How a failure is presented. Each category has one tone and title family in the reply presenter:
 * refusals the user can fix (input, not_found, ambiguous), permission and setup refusals, state that
 * changed underneath the request (conflict, stale), time-bound refusals (wait), dependency trouble
 * (upstream, blocked, paused), and failures with no approved explanation (unexpected).
 */
export type FailureCategory =
  | "input"
  | "forbidden"
  | "setup"
  | "not_found"
  | "ambiguous"
  | "conflict"
  | "stale"
  | "wait"
  | "eligible"
  | "upstream"
  | "blocked"
  | "paused"
  | "unexpected";

/** The pino levels a failure report uses; debug is reserved for the queue's expected waits. */
export type ReportLevel = "info" | "warn" | "error";

/**
 * Every code thrown anywhere, including job-only, importer, dump and CLI codes. The Failure
 * constructor accepts only these keys, so typecheck proves no throw site uses an uncatalogued code.
 */
export const FAILURE_CATEGORY = {
  // Malformed option or data values; the message says what to change.
  input: "input",
  invalid_data: "input",
  // Permission refusals; the optional scope detail names the rule that refused.
  forbidden: "forbidden",
  // A guild, FC, channel or role the feature needs is not configured yet.
  setup: "setup",
  // A local record or a Lodestone page does not exist; the resource detail says which.
  not_found: "not_found",
  // A search or selection matched more than one candidate.
  ambiguous: "ambiguous",
  // The request conflicts with durable state that the user cannot override from this command.
  ownership_conflict: "conflict",
  fc_linked: "conflict",
  initialized: "conflict",
  uninitialized: "conflict",
  insufficient_funds: "conflict",
  // State changed while the request ran (revision fences, superseded work, out-of-date controls).
  conflict: "stale",
  superseded: "stale",
  stale: "stale",
  expired: "stale",
  // Try again later: a proof not yet visible, cooldowns, contention and shutdown.
  pending_proof: "wait",
  cooldown: "wait",
  rate_limited: "wait",
  busy: "wait",
  transient: "wait",
  stopping: "wait",
  // The user already has the access they asked for.
  eligible: "eligible",
  // The Lodestone or Discord's API failed or returned something unusable.
  unavailable: "upstream",
  incomplete: "upstream",
  invalid_response: "upstream",
  // The character exists, but its owner made the Lodestone profile private, so it can't be read.
  private_profile: "upstream",
  // Discord permissions, hierarchy or a deleted channel/role prevent the change.
  blocked: "blocked",
  // Discord effects are paused (awaiting activation or disabled for the deployment).
  disabled: "paused",
  // No approved user-facing explanation: internal invariants, job-only and operator-tool codes.
  idempotency_conflict: "unexpected",
  invalid_job: "unexpected",
  lease_lost: "unexpected",
  ordered: "unexpected",
  dm_blocked: "unexpected",
  configuration: "unexpected",
  schema: "unexpected",
  test_plan: "unexpected",
  writer_lease: "unexpected",
  // The code logged and shown for every error that is not a Failure.
  unexpected: "unexpected",
} as const satisfies Record<string, FailureCategory>;

/** A catalogued failure code. */
export type FailureCode = keyof typeof FAILURE_CATEGORY;

/**
 * Interaction log level per category, mirroring the 2.12.3 jobOutcome severities: routine refusals
 * at info (so a reply's Ref stays findable at the default LOG_LEVEL), dependency and settings
 * trouble at warn, and only failures without an approved explanation at error.
 */
export const FAILURE_LEVEL = {
  input: "info",
  forbidden: "info",
  setup: "info",
  not_found: "info",
  ambiguous: "info",
  conflict: "info",
  stale: "info",
  wait: "info",
  eligible: "info",
  upstream: "warn",
  blocked: "warn",
  paused: "warn",
  unexpected: "error",
} as const satisfies Record<FailureCategory, ReportLevel>;

/**
 * The `disabled` failure that jobs and reconciliation throw while Discord effects are off. Its
 * stored diagnostic names the switch that holds the work, so officer job lines agree with the view
 * around them: the deployment-wide ENABLE_EFFECTS switch outranks a guild awaiting activation.
 */
export function effectsPaused(deploymentEnabled: boolean): Failure {
  return new Failure(
    "disabled",
    deploymentEnabled
      ? "Discord effects are disabled pending activation."
      : "Discord changes are off for this deployment (ENABLE_EFFECTS=false).",
  );
}

/**
 * Codes a queued job waits on instead of failing: ordering, locks, cooldowns, superseding inputs,
 * a lost lease, or Lodestone throttling. Shared by jobOutcome and the job-line presenter so both
 * agree on "waiting". Throttling is not the job's fault (2.17.0): a rate-limited job waits out the
 * gate's cooldown (its retryAfter) without spending an attempt, so a burst of 429s no longer ends
 * work as failed. Typed as strings because jobOutcome also tests its own non-Failure
 * classifications against it.
 */
export const WAITING_CODES: ReadonlySet<string> = new Set<string>([
  "ordered",
  "busy",
  "cooldown",
  "superseded",
  "lease_lost",
  "rate_limited",
] as const satisfies readonly FailureCode[]);

/**
 * Discord API codes that mean the bot's permissions, hierarchy, or a deleted channel or role
 * blocked the change: Missing Access, Missing Permissions, Unknown Channel and Unknown Role.
 * Shared with jobOutcome so interaction and job classifications agree.
 */
export const DISCORD_BLOCKED_CODES: ReadonlySet<number> = new Set([50001, 50013, 10003, 10011]);
/** Unknown Member and Unknown User: in an interaction, the actor is no longer a current member. */
const DISCORD_GONE_ACTOR_CODES: ReadonlySet<number> = new Set([10007, 10013]);

/** Who a forbidden action is reserved for, or which rule refused it. */
export type ForbiddenScope =
  | "officer"
  | "owner"
  | "manager"
  | "manage_roles"
  /** /setup's channel provisioning: Manage Server, Manage Roles and Manage Channels together. */
  | "manage_channels"
  /**
   * /setup overrides confirm:true (2.35.0, #46): Administrator itself, or the server owner, since
   * the run needs TaruBot to hold Administrator and changes TaruBot's access in every channel.
   */
  | "administrator"
  | "hierarchy"
  | "membership"
  | "human"
  | "test_guild"
  | "current_member";

/** The configuration a setup failure is missing. */
export type SetupPiece =
  | "guild"
  | "fc"
  | "ledger"
  | "guest_applications"
  | "guest_role"
  | "officer_role";

/** The kind of record or page a not_found, blocked or upstream failure concerns. */
export type FailureResource =
  | "character"
  | "freecompany"
  | "link"
  | "member"
  | "application"
  | "entry"
  | "account"
  | "challenge"
  | "fc_link"
  | "role"
  | "channel"
  | "biography";

/** Public Lodestone identity of a character, as the reply shows it. */
export interface FailureCharacter {
  readonly id: string;
  readonly name: string;
  readonly world: string;
}

/**
 * Optional structured context for the reply presenter. Every variant is presentation-safe: public
 * Lodestone identities, Discord IDs, dates and amounts, never tokens, payloads or raw SDK text.
 * The presenter still decides per audience what to show (members never see an ownership owner).
 */
export type FailureDetail =
  | { readonly kind: "scope"; readonly scope: ForbiddenScope }
  | { readonly kind: "setup"; readonly missing: SetupPiece }
  | {
      readonly kind: "resource";
      readonly resource: FailureResource;
      readonly id?: string;
      readonly name?: string;
      readonly world?: string;
      /**
       * The remedy, set only where the throw site's message is about TaruBot's own role position
       * or channel permissions; the presenter shows a How to fix step only when it is named, so a
       * refusal about the chosen role itself (an integration role, admin permissions) never gets one.
       * `member_entry` (2.35.0): TaruBot's own member entry in the channel denies what it needs,
       * which no role permission can lift.
       */
      readonly fix?: "hierarchy" | "channel_permissions" | "member_entry";
    }
  /** The character is already linked to another Discord user, identified by `owner`. */
  | { readonly kind: "ownership"; readonly character: FailureCharacter; readonly owner: string }
  /** A search by `name` (and, for characters, `world`) matched several candidates, by ID. */
  | {
      readonly kind: "matches";
      readonly resource: "character" | "role" | "channel";
      readonly name: string;
      readonly world?: string;
      readonly ids: readonly string[];
    }
  /** What went out of date: a button or command, a submitted form, a review post, or join data. */
  | { readonly kind: "stale"; readonly what: "control" | "form" | "review" | "join" }
  /** Which limit refused the request, and when it lifts if known. */
  | {
      readonly kind: "limit";
      /**
       * `issue`: /issue's per-member and per-server limits (2.18.0). `suggest`: /suggest's limits,
       * and GitHub's own rate limit on new issues while posting one (2.28.0).
       */
      readonly limit: "claims_own" | "claims_all" | "apply" | "issue" | "suggest";
      readonly until?: Date;
    }
  /** The recorded balance and the requested amount, both exact. */
  | { readonly kind: "funds"; readonly balance: bigint; readonly amount: bigint }
  /** The profile token is not visible yet; the claim stays valid until `expiresAt`. */
  | { readonly kind: "proof"; readonly character: FailureCharacter; readonly expiresAt: Date }
  /**
   * Discord data the bot could not read: the member list, or the API itself (a raw rate limit or
   * server error with no narrower context).
   */
  | { readonly kind: "discord"; readonly what: "member_list" | "api" }
  /**
   * A member's join time was missing. `user` names that member, so the reply says "your" only to
   * the member it is about; an officer acting on someone else reads neutral wording.
   */
  | { readonly kind: "discord"; readonly what: "join_context"; readonly user?: string }
  /** The command option the input failure concerns, which selects the reply's Example. */
  | { readonly kind: "option"; readonly option: string }
  /**
   * GitHub didn't confirm a /suggest post (2.28.0): it may or may not exist, so the reply asks the
   * member to check before sending it again, and never blames the Lodestone.
   */
  | { readonly kind: "github" };

/** Options a reporter accepts: the classified level, and the interaction path for context. */
export interface ReportOptions {
  /** Defaults to error, the level for lifecycle, gateway-event, worker and shutdown reports. */
  readonly level?: ReportLevel;
  /** Interaction path such as '/ledger withdraw' or 'button guest'. */
  readonly scope?: string;
}

/** One caught error, classified once for both its log entry and its reply. */
export interface FailureClassification {
  /** Catalog code: the Failure's own, a mapped raw Discord error, or 'unexpected'. */
  readonly code: FailureCode;
  readonly category: FailureCategory;
  readonly level: ReportLevel;
  /**
   * Error class for logs, matching jobOutcome's field: 'Failure', 'DiscordAPIError[50013]',
   * 'ZodError', or 'unknown' for a thrown non-Error. Never the error's message or body.
   */
  readonly source: string;
  /** The approved Failure itself; absent for other errors, whose text is never shown or logged. */
  readonly failure?: Failure;
  /** The Failure's own detail, or one derived from a raw Discord error. */
  readonly detail?: FailureDetail;
}

/** Build a classification from a catalog code, deriving its category and level. */
function classified(
  code: FailureCode,
  source: string,
  detail?: FailureDetail,
  failure?: Failure,
): FailureClassification {
  const category = FAILURE_CATEGORY[code];
  return {
    code,
    category,
    level: FAILURE_LEVEL[category],
    source,
    ...(failure && { failure }),
    ...(detail && { detail }),
  };
}

/** Detail for Discord API outages, so the presenter never blames the Lodestone for them. */
const API: FailureDetail = { kind: "discord", what: "api" };

/**
 * Map raw Discord REST errors that reach interaction paths (role creation during /setup, channel
 * edits, the actor's member fetch) to catalog codes, so a missing permission reads as a blocked
 * change rather than an unexpected failure. Returns undefined for errors with no mapping.
 */
function discordClassification(error: unknown): FailureClassification | undefined {
  if (error instanceof RateLimitError) return classified("unavailable", error.name, API);
  if (error instanceof HTTPError)
    // The REST client throws HTTPError for server errors that outlast its own retries.
    return error.status >= 500 ? classified("unavailable", error.name, API) : undefined;
  if (!(error instanceof DiscordAPIError)) return undefined;
  const code = Number(error.code);
  if (DISCORD_BLOCKED_CODES.has(code)) return classified("blocked", error.name);
  if (DISCORD_GONE_ACTOR_CODES.has(code))
    return classified("forbidden", error.name, { kind: "scope", scope: "current_member" });
  if (error.status === 429 || error.status >= 500)
    return classified("unavailable", error.name, API);
  return undefined;
}

/**
 * Classify any caught error once. A Failure keeps its code and detail; mapped raw Discord errors
 * get catalog codes; everything else, including a ZodError, is 'unexpected' with its class name as
 * `source`. DiscordAPIError names already include the numeric code, e.g. 'DiscordAPIError[50013]'.
 */
export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof Failure)
    // Typecheck keeps codes catalogued; a cast or untyped caller still must not break reporting.
    return classified(
      Object.hasOwn(FAILURE_CATEGORY, error.code) ? error.code : "unexpected",
      error.name,
      error.detail,
      error,
    );
  return (
    discordClassification(error) ??
    classified("unexpected", error instanceof Error ? error.name : "unknown")
  );
}
