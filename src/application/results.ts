/**
 * Typed results of every interaction-facing service method. Types only: the reply presenters
 * import these with `import type`, so no persistence or SDK code reaches a presenter. Every field
 * is read from existing columns or aggregates (no schema change), and fields added in 2.14.0 are
 * additive, so the officer JSON details keep every earlier key.
 */
import type { VisibilityReport } from "../domain/visibility.js";
import type { ApplicationRecord, EntryRecord, GuildRecord } from "./records.js";

/**
 * Whether Discord effects queued by a change run now: 'live', held until this guild is activated
 * ('awaiting_activation'), or held because ENABLE_EFFECTS is off for the whole deployment. The
 * older `effects` fields ('queued', 'unchanged', …) are kept unchanged beside it.
 */
export type EffectsMode = "live" | "awaiting_activation" | "deployment_disabled";

/** A character's public Lodestone identity as stored locally. */
export interface CharacterRef {
  readonly id: string;
  readonly name: string;
  readonly world: string;
}

/** A Free Company's stored public identity; `tag` is empty when the Lodestone shows none. */
export interface FcRef {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly world: string;
}

/**
 * Roster evidence behind a new link's Member access. `fresh` uses the same interval as
 * reconciliation; `listed` means this request recorded the character in that fresh roster.
 */
export interface RosterEvidence {
  readonly fcLinked: boolean;
  readonly fresh: boolean;
  readonly checkedAt: Date | null;
  readonly listed: boolean;
}

/** One queued Discord job as status views show it; last_error is 'code: message'. */
export interface JobView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly attempts: number;
  readonly due_at: Date;
  readonly created_at: Date;
  readonly completed_at: Date | null;
  readonly last_error: string | null;
  readonly result: unknown;
}

/** The ledger channel post for one entry, keyed by the entry it announces. */
export interface DeliveryRow {
  readonly id: string;
  readonly status: string;
  readonly last_error: string | null;
  readonly message_id: string | null;
  /**
   * The channel the post was sent to, from the job result; null for posts made before 2.14.0
   * recorded it, and for posts not sent yet.
   */
  readonly channel_id: string | null;
  readonly entry_id: string;
  readonly sequence: bigint;
  readonly attempts: number;
  readonly due_at: Date;
}

/** One recorded ledger entry, including the correction it points to, if any. */
export type LedgerEntryView = EntryRecord & { readonly correction_id: string | null };

/** A ledger account row: a null balance means the opening balance is not set yet. */
export interface LedgerAccountView {
  readonly id: string;
  readonly guild_id: string;
  readonly fc_id: string;
  readonly balance: bigint | null;
  readonly sequence: bigint;
}

// ---------------------------------------------------------------------------------------------
// Characters

/** /claim: a new token (shown once), or the caller already owns this link. */
export type ClaimResult =
  | {
      readonly status: "pending";
      /** The character ID, kept as the pre-2.14.0 field for the claim command's token reply. */
      readonly character: string;
      readonly name: string;
      readonly world: string;
      readonly token: string;
      readonly challenge: string;
      readonly expiresAt: Date;
      readonly instructions: string;
    }
  | {
      readonly status: "already_linked";
      readonly effects: "queued";
      readonly effectsMode: EffectsMode;
      readonly character: CharacterRef;
    };

/** /verify: the proof completed now, or an earlier verification already consumed the claim. */
export type VerifyResult =
  | {
      readonly status: "verified";
      readonly link: string;
      readonly effects: "queued";
      readonly effectsMode: EffectsMode;
      readonly character: CharacterRef;
      /**
       * True when this link became the member's main character: their first link, or a new link
       * while they had no main and no other active link.
       */
      readonly primary: boolean;
      /** Their first link in this server, which also turned nickname sync on. */
      readonly firstLink: boolean;
      /** Whether nickname sync is on after linking. */
      readonly nicknameSync: boolean;
      readonly roster: RosterEvidence;
    }
  | { readonly status: "already_verified"; readonly character: CharacterRef };

/** /assign: a new officer link, or the same member already owned it (the idempotent repeat). */
export interface AssignResult {
  readonly status: "assigned" | "already_assigned";
  readonly link: string;
  readonly effects: "queued";
  readonly effectsMode: EffectsMode;
  readonly character: CharacterRef;
  readonly owner: string;
  readonly reason: string;
  /**
   * True when this link became the member's main character: their first link, or a new link
   * while they had no main and no other active link.
   */
  readonly primary: boolean;
  /** Their first link in this server, which also turned nickname sync on. */
  readonly firstLink: boolean;
  /** Whether nickname sync is on after linking. */
  readonly nicknameSync: boolean;
  /** Whether the assigning officer may vouch for officer authority (a server manager). */
  readonly officerAuthority: boolean;
  readonly roster: RosterEvidence;
}

/** /unclaim and /unassign: the ended link and what it changed for the owner. */
export interface UnlinkResult {
  readonly status: "unlinked";
  readonly effects: "queued";
  readonly effectsMode: EffectsMode;
  readonly instructions: string;
  readonly link: string;
  readonly owner: string;
  readonly character: CharacterRef;
  /** The ended link was the owner's main character, which is now cleared. */
  readonly primaryCleared: boolean;
  /** The owner's active links left after this one ended. */
  readonly remainingActive: number;
  /** The officer's audited reason; null for a member's own /unclaim without one. */
  readonly reason: string | null;
}

/** One stored link, active or ended, with the owner's nickname preferences. */
export interface CharacterRow {
  readonly id: string;
  readonly character_id: string;
  readonly active: boolean;
  readonly provenance: string;
  readonly created_at: Date;
  readonly ended_at: Date | null;
  readonly name: string;
  readonly world: string;
  readonly primary_character_id: string | null;
  readonly nickname_enabled: boolean;
  readonly nickname_suspended: boolean;
}

/** /characters: every link for the owner, oldest first. */
export interface CharactersResult {
  readonly characters: readonly CharacterRow[];
}

/**
 * /main and /nickname: the saved preferences, or 'unchanged' when the request matched what was
 * already saved (the current main, or sync already on or off); an unchanged result queued nothing.
 */
export interface PreferencesResult {
  readonly status: "saved" | "unchanged";
  readonly effects: "queued" | "unchanged";
  readonly effectsMode: EffectsMode;
  readonly primary: CharacterRef | null;
  readonly nickname: { readonly enabled: boolean; readonly suspended: boolean };
}

// ---------------------------------------------------------------------------------------------
// Ledger

/** Where the corrected entry sits, so receipts can say "Corrects #n". */
export interface CorrectionRef {
  readonly id: string;
  readonly sequence: bigint;
}

/** Fields every ledger mutation result shares. */
interface LedgerContext {
  readonly effectsMode: EffectsMode;
  /** The linked FC's stored identity; null only before its first Lodestone read. */
  readonly fc: FcRef | null;
  readonly channelId: string;
}

/** A ledger mutation: recorded now, replayed by a retried interaction, or a no-op correction. */
export type LedgerReceipt =
  | (LedgerContext & {
      readonly status: "recorded";
      readonly entry: LedgerEntryView;
      readonly delivery: "queued";
      readonly inspect: string;
      readonly correction: CorrectionRef | null;
    })
  | (LedgerContext & {
      readonly status: "already_recorded";
      readonly entry: LedgerEntryView;
      readonly correction: CorrectionRef | null;
      /** The entry's channel-post job, read by its dedupe key; null if none exists. */
      readonly post: {
        readonly status: string;
        readonly message_id: string | null;
        readonly last_error: string | null;
        /** The channel the post went to; null before it is sent or for pre-2.14.0 posts. */
        readonly channel_id: string | null;
      } | null;
    })
  | (LedgerContext & { readonly status: "unchanged"; readonly balance: bigint });

/** Fields both ledger read views share. */
interface LedgerViewContext {
  readonly account: LedgerAccountView;
  readonly fc: FcRef | null;
  /** The account belongs to the currently linked FC (false for a historical account). */
  readonly current: boolean;
  readonly channelId: string | null;
  readonly effectsMode: EffectsMode;
}

/** /ledger balance. */
export interface LedgerBalanceView extends LedgerViewContext {
  readonly view: "balance";
  readonly balanceState: "uninitialized" | "known";
  /** Channel posts for the newest ten entries. */
  readonly delivery: readonly DeliveryRow[];
  readonly latest: {
    readonly sequence: bigint;
    readonly operation: string;
    readonly event_at: Date;
  } | null;
}

/**
 * /ledger history: up to ten entries newest first, below `before` (an entry number) or from the
 * newest entry. Page numbers come from the counts, never from sequence arithmetic.
 */
export interface LedgerHistoryView extends LedgerViewContext {
  readonly view: "history";
  readonly before: bigint | null;
  readonly entries: readonly LedgerEntryView[];
  /** Channel posts for exactly the entries on this page. */
  readonly delivery: readonly DeliveryRow[];
  /** Cursor for the next older page; null when this page holds the oldest entry. */
  readonly older: bigint | null;
  /** Cursor for the next newer page, 'latest' when that page is the newest one, or null. */
  readonly newer: bigint | "latest" | null;
  /** Pre-2.14.0 name of `older`, as a decimal string. */
  readonly next: string | null;
  /** Entries in the account. */
  readonly total: number;
  /** Entries newer than this page. */
  readonly above: number;
  /** Entry number of each correction's target, keyed by the target entry's ID. */
  readonly corrections: Readonly<Record<string, bigint>>;
}

// ---------------------------------------------------------------------------------------------
// Configuration

/** The linked FC as /config validate reports it. `last_error` holds the failed attempt's code. */
export interface FcHealthRow {
  readonly id: string;
  readonly name: string;
  readonly tag: string;
  readonly world: string;
  readonly last_successful_roster_at: Date | null;
  readonly last_attempt_at: Date | null;
  readonly last_error: string | null;
  /** The last successful roster read is within ROSTER_INTERVAL_SECONDS. */
  readonly fresh: boolean;
  /** The most recent attempt came after the last success, so it failed. */
  readonly attemptFailed: boolean;
}

/**
 * Who can read a changelog channel in a guild whose onboarding manages channel visibility (2.25.0):
 * 'members' when onboarding shows it to members and guests; 'hidden' for the lobby, the officer
 * room or a channel it keeps staff-only; 'unmanaged' when onboarding has no record of it (a channel
 * created since the last repair pass, or the Community Updates channel, which it never manages).
 */
export type ChangelogAudience = "members" | "hidden" | "unmanaged";

/** /config show and /config validate: stored configuration plus live resource checks. */
export interface ConfigurationReport {
  readonly configuration: GuildRecord;
  readonly effectsGloballyEnabled: boolean;
  readonly effectsMode: EffectsMode;
  readonly roleLayout: string;
  /** Per role or channel column: 'available', 'unconfigured', or the check's failure message. */
  readonly capabilities: Readonly<Record<string, string>>;
  /** Applications open only when both the review channel and the Guest role are set. */
  readonly guestApplicationsOpen: boolean;
  readonly fc: readonly FcHealthRow[] | null;
  /** The changelog channel's audience; absent with onboarding off or no changelog channel set. */
  readonly changelogAudience?: ChangelogAudience;
  /**
   * TaruBot's role and channel view as if Administrator were off (2.35.0, #46), for the "TaruBot's
   * role" and "Visibility" sections; null when TaruBot's view couldn't be read.
   */
  readonly visibility: VisibilityReport | null;
}

/** Holders an Officer-role binding adopted as manual officer grants. */
export interface OfficerHolders {
  readonly adopt: boolean;
  readonly adopted: number;
  /** The first twenty adopted user IDs. */
  readonly sample: readonly string[];
  readonly note?: string;
}

/** /config fc link, roles and channel settings. */
export type ConfigChange =
  | { readonly status: "unchanged"; readonly field: "fc_id"; readonly value: string }
  | {
      readonly status: "saved";
      readonly effects: "queued";
      readonly effectsMode: EffectsMode;
      readonly field: string;
      readonly value: string | null;
      readonly previous: string | null;
      /** The same value was saved again (for an Officer role, nobody new is adopted). */
      readonly rebound: boolean;
      /** Blocked or paused jobs queued again by this change. */
      readonly requeued: number;
      /** The newly linked FC's identity, for an FC link. */
      readonly company: FcRef | null;
      /** The configuration row after the change. */
      readonly guild: GuildRecord;
      readonly officerHolders?: OfficerHolders;
      /** A changelog channel's audience, when onboarding manages channel visibility (2.25.0). */
      readonly audience?: ChangelogAudience;
    };

/**
 * /config guest_applications: the switch and the review channel, changed together in one revision
 * (owner decision, 2026-09-24). 'unchanged' when the request matched what was saved; it bumped no
 * revision and queued nothing.
 */
export type GuestApplicationsResult =
  | {
      readonly status: "unchanged";
      readonly effectsMode: EffectsMode;
      readonly enabled: boolean;
      readonly channel: string | null;
      readonly guild: GuildRecord;
    }
  | {
      readonly status: "saved";
      readonly effects: "queued";
      readonly effectsMode: EffectsMode;
      readonly enabled: { readonly previous: boolean; readonly value: boolean };
      readonly channel: { readonly previous: string | null; readonly value: string | null };
      /** Blocked or paused jobs queued again by this change. */
      readonly requeued: number;
      /** The configuration row after the change. */
      readonly guild: GuildRecord;
    };

/** /config fc unlink. */
export interface FcUnlinkResult {
  readonly status: "unlinked";
  readonly effects: "queued";
  readonly effectsMode: EffectsMode;
  readonly company: FcRef | null;
}

/** /config officer_rank. */
export interface OfficerRankResult {
  /** 'unchanged' when the rank named (or unset) is already the saved one; nothing was saved. */
  readonly status: "saved" | "unchanged";
  readonly officerRank: string | null;
  readonly previous: string | null;
  readonly mode: "rank_and_manual_overrides" | "manual_only";
  readonly effects: "queued" | "unchanged";
  readonly effectsMode: EffectsMode;
  readonly fcLinked: boolean;
  readonly officerRoleId: string | null;
}

/** /config role_layout. */
export type RoleLayoutResult =
  | {
      readonly status: "unchanged";
      readonly roleLayout: "enabled" | "disabled";
      readonly effectsMode: EffectsMode;
    }
  | {
      readonly status: "saved";
      readonly roleLayout: "enabled" | "disabled";
      readonly effects: "queued" | "none";
      readonly effectsMode: EffectsMode;
      readonly layoutJob: string | null;
      /** Managed role IDs from FC Leader down to Guest. */
      readonly order: readonly string[];
      readonly note: string;
    };

/** A room /setup reused (`created: false`) or created. */
export interface ProvisionedChannel {
  readonly id: string;
  readonly created: boolean;
}

/** /setup. */
export interface SetupResult {
  readonly status: "configured";
  readonly roles: readonly {
    readonly field: "member_role_id" | "guest_role_id" | "officer_role_id" | "leader_role_id";
    readonly name: string;
    readonly id: string;
    readonly created: boolean;
  }[];
  readonly fcId: string | null;
  readonly company: FcRef | null;
  readonly officerRank: string | null;
  readonly effects: "queued";
  readonly effectsMode: EffectsMode;
  readonly roleLayout: string;
  readonly roleLayoutEnabled: boolean;
  readonly layoutJob: string | null;
  readonly lobby: ProvisionedChannel;
  readonly officerChannel: ProvisionedChannel;
  readonly accessPolicy: "queued";
  readonly accessJob: string;
  /** Existing Officer-role holders granted manual officer access by this run. */
  readonly adopted: number;
  /** `defaulted` means /setup filled the unset setting with the officer room. */
  readonly officerNotifications: { readonly id: string; readonly defaulted: boolean };
  readonly guestApplications: { readonly id: string; readonly defaulted: boolean };
  readonly ledgerChannelId: string | null;
  readonly instructions: string;
}

/** /officer grant and revoke. */
export interface OfficerOverrideResult {
  readonly status: "granted" | "revoked";
  /** 'recorded' means no Officer role is bound yet, so nothing is applied until one is. */
  readonly effects: "queued" | "recorded";
  readonly effectsMode: EffectsMode;
  readonly user: string;
  readonly reason: string;
  /** The user is a current member of this server. */
  readonly present: boolean;
  /** The override state before this change, or null when there was none. */
  readonly previous: "granted" | "revoked" | null;
}

/**
 * /officer reset (owner decision, 2026-09-24): the override removed, so the in-game rank decides
 * again. 'unchanged' when there was none.
 */
export interface OfficerResetResult {
  readonly status: "reset" | "unchanged";
  /** 'recorded' means no Officer role is bound yet, so nothing is applied until one is. */
  readonly effects: "queued" | "recorded" | "unchanged";
  readonly effectsMode: EffectsMode;
  readonly user: string;
  readonly reason: string;
  readonly present: boolean;
  /** The override removed, or null when there was none. */
  readonly previous: "granted" | "revoked" | null;
  /** An in-game officer rank is configured, so it decides now; otherwise nobody gets officer. */
  readonly rankConfigured: boolean;
}

// ---------------------------------------------------------------------------------------------
// Guests

/** Stored application states. */
export type ApplicationState = "pending" | "approved" | "denied" | "cancelled" | "superseded";

/** An application as status views show it; the answers are never included. */
export interface ApplicationStatusRow {
  readonly id: string;
  readonly guild_id: string;
  readonly user_id: string;
  readonly joined_at: Date;
  readonly created_at: Date;
  readonly state: string;
  readonly channel_id: string;
  readonly message_id: string | null;
  readonly reviewer_id: string | null;
  readonly decided_at: Date | null;
  readonly reason: string | null;
}

/** /guest status: durable grants, revocation, history, delivery and the facts behind them. */
export interface GuestStatusView {
  readonly applications: readonly ApplicationStatusRow[];
  /** Newest first. */
  readonly grants: readonly {
    readonly provenance: string;
    readonly created_at: Date;
    readonly reason: string | null;
  }[];
  readonly revocation: readonly {
    readonly revoked: boolean;
    readonly changed_at: Date;
    readonly reason: string | null;
  }[];
  readonly formerMember: readonly { readonly eligible: boolean }[];
  readonly delivery: readonly JobView[];
  readonly verifiedGuestEligible: boolean;
  /** FC membership over the user's active links, from accepted roster evidence only. */
  readonly membership: "member" | "ineligible" | "uncertain";
  readonly rosterFresh: boolean;
  /** At least one active trusted character link. */
  readonly registered: boolean;
  readonly cooldownSeconds: number;
  readonly effectsMode: EffectsMode;
}

/** /guest grant and revoke. */
export interface GuestActionResult {
  readonly status: "granted" | "revoked";
  readonly effects: "queued";
  readonly effectsMode: EffectsMode;
  readonly user: string;
  readonly reason: string;
  /** A grant lifted an earlier revocation. */
  readonly restored: boolean;
  /** Pending applications a revocation cancelled. */
  readonly cancelledApplications: number;
  readonly present: boolean;
  readonly guestRoleConfigured: boolean;
}

/**
 * /guest reset (owner decision, 2026-09-24): the revocation lifted and every active grant ended, so
 * FC membership and registered characters decide Guest again. 'unchanged' when there was neither.
 */
export interface GuestResetResult {
  readonly status: "reset" | "unchanged";
  readonly effects: "queued" | "unchanged";
  readonly effectsMode: EffectsMode;
  readonly user: string;
  readonly reason: string;
  /** A revocation was lifted. */
  readonly revocationLifted: boolean;
  /** The provenance of each grant ended ('approved', 'manual', 'imported_guest', 'grandfathered'). */
  readonly grantsEnded: readonly string[];
  readonly present: boolean;
  readonly guestRoleConfigured: boolean;
}

/** /guest approve and deny, and the review buttons. */
export interface DecisionResult {
  readonly id: string;
  readonly status: ApplicationState;
  /** 'unchanged' when the application was already decided before this request. */
  readonly effects: "queued" | "unchanged";
  readonly effectsMode: EffectsMode;
  readonly userId: string;
  readonly reason: string | null;
  readonly reviewerId: string | null;
  readonly decidedAt: Date | null;
  readonly cooldownSeconds: number;
}

/** A submitted application and whether this submission created it. */
export type ApplyResult = ApplicationRecord & {
  /** 'replaced' closed an earlier pending application from a previous join. */
  readonly outcome: "created" | "existing" | "replaced";
  readonly effectsMode: EffectsMode;
};

/** Pending applications for officer autocomplete, newest first. */
export interface ApplicationChoiceRow {
  readonly id: string;
  readonly user_id: string;
  readonly created_at: Date;
}

// ---------------------------------------------------------------------------------------------
// Synchronization

/** /refresh. */
export interface RefreshResult {
  readonly runId: string;
  readonly status: "queued";
  /** Reconcile from the fresh cached roster rather than fetching a new one. */
  readonly cached: boolean;
  readonly forced: boolean;
  readonly cooldownSeconds: number;
  readonly intervalSeconds: number;
  readonly lastSuccessfulRosterAt: Date | null;
  readonly effectsMode: EffectsMode;
}

/** One sync run with its child-work totals. */
export interface SyncRunRow {
  readonly id: string;
  readonly created_at: Date;
  readonly enumeration_completed_at: Date | null;
  readonly requester_id: string | null;
  readonly acquisition_kind: string | null;
  readonly acquisition_status: string | null;
  readonly last_error: string | null;
  readonly result: unknown;
  readonly status: "failed" | "blocked" | "queued" | "completed";
  readonly work_total: number;
  readonly work_completed: number;
  readonly work_blocked: number;
  readonly work_failed: number;
  /** When the last child job finished, for a completed run; null otherwise. */
  readonly completed_at: Date | null;
}

/** /sync status: recent runs and outstanding work, scoped to the caller unless an officer. */
export interface SyncStatusView {
  readonly runs: readonly SyncRunRow[];
  readonly work: readonly (JobView & { readonly user_id: string | null })[];
  readonly effectsMode: EffectsMode;
}
