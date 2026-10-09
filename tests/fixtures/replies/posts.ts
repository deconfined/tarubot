/**
 * The channel post and DM catalog: one case per ledger post kind (approved ledger#29 and #32,
 * reply specs ledger#30 and #31), per review message and decision DM kind (reply specs
 * guests#29–#32 and the legacy review gap), the update post (2.25.0) and the officer status post
 * (2.29.0). Each renders a stored record the way the gateway renders it for the ledger.notify,
 * guest.review, guest.dm, changelog.post and officer.status jobs. The samples are exported so the
 * gateway tests send the same posts through the REST recorder.
 */
import type {
  ApplicationRecord,
  ChangelogPostView,
  LedgerPostView,
  StatusPostView,
} from "../../../src/application/records.js";
import type { Flags, StatusEntry } from "../../../src/domain/status.js";
import {
  changelogPost,
  type ChangelogPostKind,
} from "../../../src/discord/presenters/changelog.js";
import {
  decisionDm,
  guestReviewPost,
  type GuestPostKind,
} from "../../../src/discord/presenters/guests.js";
import { ledgerPost, type LedgerPostKind } from "../../../src/discord/presenters/ledger.js";
import { statusPost, type StatusPostKind } from "../../../src/discord/presenters/officer.js";
import { GUEST_ID, GUILD_ID, MEMBER_ID, OFFICER_ID } from "../results.js";
import { APPLICATION_ID } from "./guests.js";
import { E41, E42, E43, ENTRY_IDS, entry } from "./ledger.js";
import type { ReplyCatalog } from "./index.js";

/** The approved deposit post (ledger#29): entry #41, recorded by a member. */
export const DEPOSIT_POST: LedgerPostView = { entry: E41, correctionSequence: null };
/** The withdrawal post (reply spec ledger#30): entry #42, recorded by an officer. */
export const WITHDRAW_POST: LedgerPostView = { entry: E42, correctionSequence: null };
/** The opening balance post (reply spec ledger#31): entry #1, unsigned and without a Balance. */
export const OPENING_POST: LedgerPostView = {
  entry: entry({
    id: ENTRY_IDS.opening,
    sequence: 1n,
    operation: "initialize",
    delta: 95_000_000n,
    balance: 95_000_000n,
    actor_id: OFFICER_ID,
    note: "Counted the FC chest after the weekly reset",
    event_at: new Date(1_790_139_600_000),
  }),
  correctionSequence: null,
};
/** The approved correction post (ledger#32): entry #43 corrects #42. */
export const CORRECTION_POST: LedgerPostView = { entry: E43, correctionSequence: 42n };

/**
 * The update post a guild last told about 2.24.2 sees when 2.25.0 starts: that release's own
 * release note, linking the CHANGELOG on main as the dispatcher does.
 */
export const CHANGELOG_POST: ChangelogPostView = {
  version: "2.25.0",
  previous: "2.24.2",
  notes: [
    {
      version: "2.25.0",
      note: "Officers can now pick a channel where TaruBot shares what's new for members when an update changes something for them.",
    },
  ],
  url: "https://github.com/deconfined/tarubot/blob/main/CHANGELOG.md",
};

/** Access flags for a status entry; unset flags are null (unbound, or never decided). */
export const statusFlags = (values: Partial<Flags> = {}): Flags => ({
  member: null,
  guest: null,
  officer: null,
  leader: null,
  ...values,
});

/** One member's frozen status lines: announced `from`, posted `to`, reasons and departures. */
export const statusEntry = (
  user: string,
  from: Partial<Flags>,
  to: Partial<Flags> = from,
  extra: Partial<StatusEntry> = {},
): StatusEntry => ({
  user,
  joined: "2026-01-01T00:00:00.000Z",
  from: statusFlags(from),
  to: statusFlags(to),
  reasons: {},
  departed: [],
  ...extra,
});

/** Two more members for the status post: an officer whose access was revoked, and an alt's owner. */
export const STATUS_USERS = {
  a: MEMBER_ID,
  b: "567890123456789012",
  c: GUEST_ID,
  d: OFFICER_ID,
  e: "678901234567890124",
} as const;

/**
 * The status post of the plan approved on #31: two members lost Member (one's alt left the FC), a
 * guest grant, an officer revocation, and an alt's departure whose owner keeps Member elsewhere.
 */
export const STATUS_POST: StatusPostView = {
  frozenAt: "2026-09-25T18:00:00.000Z",
  entries: [
    statusEntry(
      STATUS_USERS.a,
      { member: true, guest: false },
      { member: false, guest: true },
      {
        reasons: { member: "not_in_fc", guest: "former_member" },
        departed: [
          { character: "1001", name: "Example Alt", world: "Example World", snapshot: "s1" },
        ],
      },
    ),
    statusEntry(
      STATUS_USERS.b,
      { member: true, guest: false },
      { member: false, guest: true },
      { reasons: { member: "not_in_fc", guest: "registered" } },
    ),
    statusEntry(
      STATUS_USERS.c,
      { member: false, guest: false },
      { member: false, guest: true },
      { reasons: { guest: "guest_grant" } },
    ),
    statusEntry(
      STATUS_USERS.d,
      { member: true, guest: false, officer: true },
      { member: true, guest: false, officer: false },
      { reasons: { officer: "officer_revoked" } },
    ),
    statusEntry(
      STATUS_USERS.e,
      {},
      {},
      {
        joined: null,
        departed: [
          { character: "1002", name: "Second Alt", world: "Example World", snapshot: "s1" },
        ],
      },
    ),
  ],
};

/** A time as the reply specs' <t:…> values write it. */
const unix = (seconds: number): Date => new Date(seconds * 1_000);

/** The review channel the reply specs' review message is posted in. */
export const REVIEW_CHANNEL = "678901234567890123";

/** The reply specs' application (guests#29–#32); overrides state only what a case varies. */
export const application = (overrides: Partial<ApplicationRecord> = {}): ApplicationRecord => ({
  id: APPLICATION_ID,
  guild_id: GUILD_ID,
  user_id: GUEST_ID,
  joined_at: unix(1_789_905_600),
  created_at: unix(1_790_150_400),
  state: "pending",
  channel_id: REVIEW_CHANNEL,
  message_id: null,
  reviewer_id: null,
  decided_at: null,
  reason: null,
  introduction:
    "Hi! I play Example Character on Diabolos and met a few of you in a raid party last week.",
  interest:
    "I'm looking for a friendly group for weekly content, and an FC member suggested I apply here.",
  ...overrides,
});

/** The reply specs' decision time and denial reason. */
const DECIDED_AT = unix(1_790_164_800);
const DENIAL = "Please tell us a little more about how you found the Free Company.";

/** Each review state the catalog renders. */
export const APPLICATIONS = {
  pending: application(),
  legacy: application({ introduction: null, interest: null }),
  approved: application({ state: "approved", reviewer_id: OFFICER_ID, decided_at: DECIDED_AT }),
  denied: application({
    state: "denied",
    reviewer_id: OFFICER_ID,
    decided_at: DECIDED_AT,
    reason: DENIAL,
  }),
  cancelled: application({ state: "cancelled", decided_at: DECIDED_AT }),
  superseded: application({ state: "superseded", decided_at: DECIDED_AT }),
} as const;

/** The default reapply cooldown (GUEST_COOLDOWN_SECONDS), 24 hours. */
export const COOLDOWN = 86_400;

/** Every post and DM kind, rendered as the gateway renders it. */
export const POST_CASES = {
  "post.deposit": {
    spec: "ledger#29",
    audience: "channel",
    tone: "success",
    title: "Deposit · +10,005,000 gil",
    timestamp: true,
    render: () => ledgerPost(DEPOSIT_POST),
  },
  "post.withdraw": {
    spec: "ledger#30 delivered-withdraw",
    audience: "channel",
    tone: "info",
    title: "Withdrawal · −2,500,000 gil",
    timestamp: true,
    render: () => ledgerPost(WITHDRAW_POST),
  },
  "post.opening": {
    spec: "ledger#31 delivered-initialize",
    audience: "channel",
    tone: "info",
    title: "Opening balance · 95,000,000 gil",
    timestamp: true,
    render: () => ledgerPost(OPENING_POST),
  },
  "post.correction": {
    spec: "ledger#32",
    audience: "channel",
    tone: "warning",
    title: "Correction · −50,000 gil",
    timestamp: true,
    render: () => ledgerPost(CORRECTION_POST),
  },
  "review.pending": {
    spec: "guests#29 pending",
    audience: "channel",
    tone: "pending",
    title: "Guest application",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.pending),
  },
  "review.legacy": {
    spec: null,
    audience: "channel",
    tone: "pending",
    title: "Guest application",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.legacy),
  },
  "review.approved": {
    spec: "guests#30 decided",
    audience: "channel",
    tone: "success",
    title: "Guest application · approved",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.approved),
  },
  "review.denied": {
    spec: "guests#30 decided",
    audience: "channel",
    tone: "warning",
    title: "Guest application · denied",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.denied),
  },
  "review.cancelled": {
    spec: "guests#30 decided",
    audience: "channel",
    tone: "neutral",
    title: "Guest application · cancelled",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.cancelled),
  },
  "review.superseded": {
    spec: "guests#30 decided",
    audience: "channel",
    tone: "info",
    title: "Guest application · no longer needed",
    timestamp: true,
    render: () => guestReviewPost(APPLICATIONS.superseded),
  },
  "dm.approved": {
    spec: "guests#31 approved",
    audience: "member",
    tone: "success",
    title: "Your guest application was approved",
    timestamp: true,
    render: () =>
      decisionDm(APPLICATIONS.approved, { cooldownSeconds: COOLDOWN, serverName: null }),
  },
  "dm.denied": {
    spec: "guests#32 denied",
    audience: "member",
    tone: "warning",
    title: "Your guest application was not approved",
    timestamp: true,
    render: () => decisionDm(APPLICATIONS.denied, { cooldownSeconds: COOLDOWN, serverName: null }),
  },
  "changelog.update": {
    spec: null,
    audience: "channel",
    tone: "info",
    title: "TaruBot updated to v2.25.0",
    timestamp: false,
    render: () => changelogPost(CHANGELOG_POST),
  },
  "status.changes": {
    spec: null,
    audience: "channel",
    tone: "info",
    title: "Member status changes",
    timestamp: true,
    render: () => statusPost(STATUS_POST),
  },
} as const satisfies ReplyCatalog<
  LedgerPostKind | GuestPostKind | ChangelogPostKind | StatusPostKind
>;
