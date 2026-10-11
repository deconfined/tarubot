/**
 * The synchronization, utility and /version reply catalog: one case per SyncReplyKind,
 * UtilityReplyKind and VersionReplyKind, rendered from typed sample results that reproduce the
 * approved mockups (guests#36, #43, #44 and #54) and the reply-specs states. The sample results
 * are exported so command and component tests can return them from service stubs.
 */
import { ChannelType } from "discord.js";
import type {
  JobView,
  RefreshResult,
  SyncRunRow,
  SyncStatusView,
} from "../../../src/application/results.js";
import type { VersionReport } from "../../../src/application/version-information.js";
import { project } from "../../../src/config/project.js";
import {
  refreshReply,
  syncStatusReply,
  type SyncReplyKind,
} from "../../../src/discord/presenters/synchronization.js";
import {
  channelReply,
  dashboardReply,
  issueReply,
  pingReply,
  suggestionReply,
  type UtilityReplyKind,
} from "../../../src/discord/presenters/utility.js";
import { versionReply, type VersionReplyKind } from "../../../src/discord/presenters/version.js";
import { job, NOW, OFFICER_ID, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** The approved cards' runs (guests#36, #43 and #44). */
export const RUN_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const CACHED_RUN_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

/** A time as the approved cards' <t:…> values write it. */
const unix = (seconds: number): Date => new Date(seconds * 1_000);

/** A /refresh result: the approved cached run unless overridden (guests#36). */
export const refreshed = (overrides: Partial<RefreshResult> = {}): RefreshResult => ({
  runId: RUN_ID,
  status: "queued",
  cached: true,
  forced: false,
  cooldownSeconds: 0,
  intervalSeconds: 21_600,
  lastSuccessfulRosterAt: unix(1_790_161_200),
  effectsMode: "live",
  ...overrides,
});

/** A sync run with its child-work totals; overrides state only what a case varies. */
export const syncRun = (overrides: Partial<SyncRunRow> = {}): SyncRunRow => ({
  id: RUN_ID,
  created_at: unix(1_790_164_800),
  enumeration_completed_at: unix(1_790_164_920),
  requester_id: OFFICER_ID,
  acquisition_kind: "roster",
  acquisition_status: "succeeded",
  last_error: null,
  result: { snapshotId: "0f1e2d3c-4b5a-4968-8776-655443322110", count: 187, pages: 4 },
  status: "queued",
  work_total: 40,
  work_completed: 38,
  work_blocked: 0,
  work_failed: 0,
  completed_at: null,
  ...overrides,
});

/** Outstanding work as /sync status reads it (with the owning user, null for FC-wide work). */
type WorkRow = SyncStatusView["work"][number];
const work = (overrides: Partial<JobView> & { user_id?: string | null } = {}): WorkRow => ({
  ...job(overrides),
  user_id: overrides.user_id ?? null,
});

/** The approved officer overview (guests#44): a run in progress and a completed cached run. */
const OVERVIEW_RUNS = [
  syncRun(),
  syncRun({
    id: CACHED_RUN_ID,
    created_at: unix(1_790_078_400),
    acquisition_kind: "reconcile.guild",
    result: null,
    status: "completed",
    work_total: 212,
    work_completed: 212,
    completed_at: unix(1_790_079_000),
  }),
];

/** Three queued role updates, a running server-wide check and a failed officer notice (#44). */
const OVERVIEW_WORK = [
  work({ id: "a1a1a1a1-0000-4000-8000-000000000001", due_at: unix(1_790_164_830) }),
  work({ id: "a1a1a1a1-0000-4000-8000-000000000002", due_at: unix(1_790_164_890) }),
  work({ id: "a1a1a1a1-0000-4000-8000-000000000003", due_at: unix(1_790_164_950) }),
  work({
    id: "c0c0c0c0-0000-4000-8000-000000000004",
    kind: "reconcile.guild",
    status: "running",
    attempts: 1,
  }),
  work({
    id: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    kind: "officer.notify",
    status: "failed",
    attempts: 8,
    last_error: "transient",
  }),
];

/** Sample service results for every synchronization state, named by the kind they render as. */
export const SYNC_RESULTS = {
  /** guests#43: the member's refresh waiting on a blocked role update. */
  memberAttention: {
    runs: [syncRun({ status: "blocked" })],
    work: [
      work({
        status: "blocked",
        attempts: 3,
        last_error: "blocked: Missing Permissions",
        user_id: VIEWERS.member.userId,
      }),
    ],
    effectsMode: "live",
  },
  memberEmpty: { runs: [], work: [], effectsMode: "live" },
  memberDone: {
    runs: [syncRun({ status: "completed", work_completed: 40, completed_at: unix(1_790_165_400) })],
    work: [],
    effectsMode: "live",
  },
  memberActive: {
    runs: [syncRun({ work_completed: 12 }), syncRun({ id: CACHED_RUN_ID, status: "completed" })],
    work: [
      work({ status: "running", attempts: 1, user_id: VIEWERS.member.userId }),
      work({ kind: "profile", user_id: null }),
    ],
    effectsMode: "live",
  },
  memberPaused: {
    runs: [syncRun({ status: "blocked", work_blocked: 2 })],
    work: [work({ status: "disabled", user_id: VIEWERS.member.userId })],
    effectsMode: "awaiting_activation",
  },
  /** guests#44: the officer overview. */
  officer: { runs: OVERVIEW_RUNS, work: OVERVIEW_WORK, effectsMode: "live" },
  /** guests#45: a blocked run with blocked and failed work and a roster fetch retrying. */
  officerAttention: {
    runs: [syncRun({ status: "blocked", work_blocked: 1, work_failed: 1 })],
    work: [
      work({
        status: "blocked",
        attempts: 3,
        last_error:
          "blocked: Recheck Discord roles, channel permissions, and bot hierarchy with /config validate.",
      }),
      OVERVIEW_WORK[4] ?? work(),
      work({
        id: "c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f",
        kind: "roster",
        attempts: 2,
        due_at: unix(1_790_164_860),
        last_error: "cooldown: FC refresh cooldown.",
      }),
    ],
    effectsMode: "live",
  },
  /** guests#46: an imported guild before activation, with only held work. */
  officerPaused: {
    runs: [syncRun({ status: "blocked", work_blocked: 25, work_completed: 15 })],
    work: Array.from({ length: 25 }, (_, index) =>
      work({
        id: `d0d0d0d0-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        status: "disabled",
        last_error: "disabled: Effects are disabled pending activation.",
      }),
    ),
    effectsMode: "awaiting_activation",
  },
  /** guests#47: one completed run, as its requester sees it. */
  run: {
    runs: [
      syncRun({
        status: "completed",
        work_total: 212,
        work_completed: 212,
        completed_at: unix(1_790_165_400),
      }),
    ],
    work: [],
    effectsMode: "live",
  },
} as const satisfies Record<string, SyncStatusView>;

/** A /version report: the approved card's commits (guests#54) padded to five. */
export const report = (overrides: Partial<VersionReport> = {}): VersionReport => ({
  ...project,
  version: "2.13.0",
  commits: [
    {
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      title: "Add launch access policy and cutover tooling",
      url: `${project.url}/commit/a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`,
      verified: true,
    },
    {
      sha: "2dc82b5000000000000000000000000000000000",
      title: "Log queue outcomes by severity",
      url: `${project.url}/commit/2dc82b5000000000000000000000000000000000`,
      verified: true,
    },
    ...["3", "4", "5"].map((digit) => ({
      sha: digit.repeat(40),
      title: `Earlier change ${digit}`,
      url: `${project.url}/commit/${digit.repeat(40)}`,
      verified: false,
    })),
  ],
  checkedAt: NOW.toISOString(),
  warning: null,
  ...overrides,
});

/** Shorthands for the sample results. */
const S = SYNC_RESULTS;
/** Every case renders against the mockups' clock. */
const now = NOW;
/** Overview options: no run asked about. */
const overview = { run: null, now } as const;

/** Every synchronization reply state, rendered for the audience its card is written for. */
export const SYNC_CASES = {
  "refresh.cached": {
    spec: "guests-sync-utility#36",
    audience: "member",
    tone: "pending",
    title: "Refresh requested",
    timestamp: false,
    render: () => refreshReply(refreshed(), VIEWERS.member, { now }),
  },
  "refresh.acquisition": {
    spec: "guests-sync-utility#37",
    audience: "member",
    tone: "pending",
    title: "Refresh requested",
    timestamp: false,
    render: () =>
      refreshReply(
        refreshed({
          cached: false,
          cooldownSeconds: 42,
          lastSuccessfulRosterAt: unix(1_790_139_600),
        }),
        VIEWERS.member,
        { now },
      ),
  },
  "refresh.officer": {
    spec: "guests-sync-utility#38",
    audience: "officer",
    tone: "pending",
    title: "Refresh requested",
    timestamp: false,
    render: () =>
      refreshReply(
        refreshed({
          cached: false,
          cooldownSeconds: 42,
          lastSuccessfulRosterAt: unix(1_790_139_600),
        }),
        VIEWERS.officer,
        { now },
      ),
  },
  "refresh.forced": {
    spec: "guests-sync-utility#39",
    audience: "officer",
    tone: "pending",
    title: "Forced refresh requested",
    timestamp: false,
    render: () =>
      refreshReply(refreshed({ cached: false, forced: true }), VIEWERS.officer, { now }),
  },
  "refresh.paused": {
    spec: "guests-sync-utility#36",
    audience: "member",
    tone: "pending",
    title: "Refresh requested",
    timestamp: false,
    render: () =>
      refreshReply(refreshed({ effectsMode: "awaiting_activation" }), VIEWERS.member, { now }),
  },
  "status.member_empty": {
    spec: "guests-sync-utility#41",
    audience: "member",
    tone: "neutral",
    title: "Your sync status",
    timestamp: false,
    render: () => syncStatusReply(S.memberEmpty, VIEWERS.member, overview),
  },
  "status.member_done": {
    spec: "guests-sync-utility#41",
    audience: "member",
    tone: "success",
    title: "Your sync status",
    timestamp: false,
    render: () => syncStatusReply(S.memberDone, VIEWERS.member, overview),
  },
  "status.member_active": {
    spec: "guests-sync-utility#42",
    audience: "member",
    tone: "pending",
    title: "Your sync status",
    timestamp: false,
    render: () => syncStatusReply(S.memberActive, VIEWERS.member, overview),
  },
  "status.member_paused": {
    spec: "guests-sync-utility#43",
    audience: "member",
    tone: "pending",
    title: "Your sync status",
    timestamp: false,
    render: () => syncStatusReply(S.memberPaused, VIEWERS.member, overview),
  },
  "status.member_attention": {
    spec: "guests-sync-utility#43",
    audience: "member",
    tone: "warning",
    title: "Your sync status",
    timestamp: false,
    render: () => syncStatusReply(S.memberAttention, VIEWERS.member, overview),
  },
  "status.officer": {
    spec: "guests-sync-utility#44",
    audience: "officer",
    concept: "sync_overview_active",
    tone: "pending",
    title: "Sync status · server",
    timestamp: true,
    render: () => syncStatusReply(S.officer, VIEWERS.officer, overview),
  },
  "status.officer_attention": {
    spec: "guests-sync-utility#45",
    audience: "officer",
    concept: "sync_overview_focused",
    tone: "warning",
    title: "Sync status · server",
    timestamp: true,
    render: () => syncStatusReply(S.officerAttention, VIEWERS.officer, overview),
  },
  "status.officer_paused": {
    spec: "guests-sync-utility#46",
    audience: "officer",
    concept: "sync_overview_paused",
    tone: "pending",
    title: "Sync status · server",
    timestamp: true,
    render: () => syncStatusReply(S.officerPaused, VIEWERS.officer, overview),
  },
  "run.detail": {
    spec: "guests-sync-utility#47",
    audience: "member",
    tone: "success",
    title: "Sync run · completed",
    timestamp: false,
    render: () => syncStatusReply(S.run, VIEWERS.member, { run: RUN_ID, now }),
  },
  "run.missing": {
    spec: "guests-sync-utility#48",
    audience: "member",
    tone: "neutral",
    title: "No matching run",
    timestamp: false,
    render: () => syncStatusReply(S.memberEmpty, VIEWERS.member, { run: RUN_ID, now }),
  },
} as const satisfies ReplyCatalog<SyncReplyKind>;

/** Every utility reply state; anyone may run them. */
export const UTILITY_CASES = {
  "ping.measured": {
    spec: "guests-sync-utility#50",
    audience: "member",
    tone: "neutral",
    title: "Pong",
    timestamp: false,
    render: () => pingReply(42),
  },
  "ping.unmeasured": {
    spec: "guests-sync-utility#51",
    audience: "member",
    tone: "neutral",
    title: "Pong",
    timestamp: false,
    render: () => pingReply(null),
  },
  "channel.details": {
    spec: "guests-sync-utility#52",
    audience: "member",
    tone: "neutral",
    title: "Channel details",
    timestamp: false,
    render: () =>
      channelReply({ id: "678901234567890123", name: "officer-chat", type: ChannelType.GuildText }),
  },
  "channel.unavailable": {
    spec: "guests-sync-utility#53",
    audience: "member",
    tone: "neutral",
    title: "Channel details",
    timestamp: false,
    render: () => channelReply({ id: "678901234567890123", name: null, type: null }),
  },
  // 2.18.0: /issue's confirmation, delivered or saved until reporting is connected.
  "issue.received": {
    spec: "2.18.0 issue reports",
    audience: "member",
    tone: "success",
    title: "Report received",
    timestamp: false,
    render: () => issueReply({ delivery: "queued", ref: "1290000000000000001" }),
  },
  "issue.saved": {
    spec: "2.18.0 issue reports",
    audience: "member",
    tone: "pending",
    title: "Report saved",
    timestamp: false,
    render: () => issueReply({ delivery: "saved", ref: "1290000000000000001" }),
  },
  // 2.28.0: /suggest's confirmation, linking the public issue.
  "suggest.posted": {
    spec: "2.28.0 public suggestions",
    audience: "member",
    tone: "success",
    title: "Suggestion posted",
    timestamp: false,
    render: () =>
      suggestionReply({
        number: 34,
        url: "https://github.com/deconfined/tarubot/issues/34",
        repository: "deconfined/tarubot",
      }),
  },
  // 2.42.0: /dashboard's link, a development address shown as text, or the web turned off.
  "dashboard.link": {
    spec: "2.42.0 dashboard link",
    audience: "member",
    tone: "neutral",
    title: "Dashboard",
    timestamp: false,
    render: () => dashboardReply("https://tarubot.example.org"),
  },
  "dashboard.development": {
    spec: "2.42.0 dashboard link",
    audience: "member",
    tone: "neutral",
    title: "Dashboard",
    timestamp: false,
    render: () => dashboardReply("http://localhost:8080"),
  },
  "dashboard.off": {
    spec: "2.42.0 dashboard link",
    audience: "member",
    tone: "info",
    title: "Dashboard not turned on",
    timestamp: false,
    render: () => dashboardReply(null),
  },
} as const satisfies ReplyCatalog<UtilityReplyKind>;

/** Every /version reply state. */
export const VERSION_CASES = {
  "version.commits": {
    spec: "guests-sync-utility#54",
    audience: "member",
    tone: "info",
    title: "TaruBot v2.13.0",
    timestamp: true,
    render: () => versionReply(report()),
  },
  "version.unavailable": {
    spec: "guests-sync-utility#55",
    audience: "member",
    tone: "warning",
    title: "TaruBot v2.13.0",
    timestamp: true,
    render: () =>
      versionReply(
        report({
          commits: [],
          warning: "GitHub commit history is temporarily unavailable. Please try again shortly.",
        }),
      ),
  },
  "version.empty": {
    spec: "guests-sync-utility#56",
    audience: "member",
    tone: "neutral",
    title: "TaruBot v2.13.0",
    timestamp: true,
    render: () => versionReply(report({ commits: [] })),
  },
} as const satisfies ReplyCatalog<VersionReplyKind>;
