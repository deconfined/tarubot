/**
 * The moderation reply catalog (2.45.0): one case per ModerationReplyKind, rendered from typed
 * sample results of src/application/moderation.ts. The samples are exported so the command test
 * can return them from a service stub and expect the same cards. IDs are the mockups' people, and
 * the all-zero UUID stands in for ids and batches no card shows.
 */
import type {
  BlockResult,
  LiftResult,
  PauseStatus,
  PauseView,
} from "../../../src/application/moderation.js";
import {
  blockReply,
  type BlockReceipt,
  liftReply,
  type LiftReceipt,
  type ModerationReplyKind,
  statusReply,
} from "../../../src/discord/presenters/moderation.js";
import { BLOCKABLE, MANAGER_ONLY_BLOCKS } from "../../../src/domain/rbac.js";
import type { PermissionId } from "../../../src/domain/rbac.js";
import { at, GUEST_ID, MEMBER_ID, OFFICER_ID, VIEWERS } from "../results.js";
import type { ReplyCatalog } from "./index.js";

/** The all-zero UUID: a row or batch ID no card shows. */
const NO_ID = "00000000-0000-0000-0000-000000000000";

/** The reason officers wrote, and the one a lift gives. */
export const BLOCK_REASON = "Posting the same suggestion again and again";
export const LIFT_REASON = "Agreed to follow the rules";

/** The member the pauses are on. */
export const PAUSED_ID = MEMBER_ID;

/** What "all member features" pauses: everything pausable except mod mail. */
export const ALL_MEMBER_FEATURES: readonly PermissionId[] = BLOCKABLE.filter(
  (id) => !MANAGER_ONLY_BLOCKS.has(id),
);

/** A pause as a list shows it; overrides state only what a case varies. */
export const pause = (overrides: Partial<PauseView> = {}): PauseView => ({
  id: NO_ID,
  userId: PAUSED_ID,
  permission: "suggest.use",
  reason: BLOCK_REASON,
  createdAt: at(-86_400),
  until: at(518_400),
  ...overrides,
});

/** An officer's view of a pause: who set it, and at what level. */
const setBy = (userId: string, level: "manager" | "moderator" = "moderator") =>
  ({ by: { userId, level } }) as const;

/** A pause that ended: it ran out, or someone lifted it. */
const over = (ended: NonNullable<PauseView["ended"]>) => ({ ended }) as const;

/** A block the service returned. */
export const blockResult = (overrides: Partial<BlockReceipt> = {}): BlockReceipt => {
  const result: BlockResult = {
    target: PAUSED_ID,
    permissions: ["suggest.use"],
    duration: "1w",
    until: at(604_800),
    replaced: [],
    batch: NO_ID,
    ...overrides,
  };
  return { ...result, reason: overrides.reason ?? BLOCK_REASON };
};

/** A lift the service returned, with the reason the officer wrote. */
export const liftResult = (overrides: Partial<LiftReceipt> = {}): LiftReceipt => {
  const result: LiftResult = {
    target: PAUSED_ID,
    lifted: ["suggest.use"],
    notPaused: [],
    ...overrides,
  };
  return { ...result, reason: overrides.reason ?? LIFT_REASON, managerSet: overrides.managerSet };
};

/** A person's own status: reasons and ends, never an issuer. */
export const ownStatus = (active: readonly PauseView[]): PauseStatus => ({
  subject: PAUSED_ID,
  self: true,
  active,
  ended: [],
});

/** An officer's status for someone else: who set each pause, and the newest ended ones. */
export const officerStatus = (
  active: readonly PauseView[],
  ended: readonly PauseView[] = [],
): PauseStatus => ({ subject: PAUSED_ID, self: false, active, ended });

/** The self view's active pauses: one timed, one that lasts until someone lifts it. */
const OWN_ACTIVE = [
  pause(),
  pause({ permission: "issue.use", reason: "Reporting the same problem daily", until: null }),
];

/** The officer view's active pauses, as set by a moderator and by a server manager. */
export const OFFICER_ACTIVE = [
  pause({ ...setBy(OFFICER_ID) }),
  pause({
    permission: "modmail.open",
    reason: "Opening cases without a reason",
    until: null,
    createdAt: at(-172_800),
    ...setBy(GUEST_ID, "manager"),
  }),
];

/** The officer view's earlier pauses: one lifted with a reason, one that ran out. */
export const OFFICER_ENDED = [
  pause({
    permission: "ledger.deposit",
    createdAt: at(-1_209_600),
    until: at(-604_800),
    ...setBy(OFFICER_ID),
    ...over({ at: at(-691_200), by: OFFICER_ID, reason: "Apologised and promised to be careful" }),
  }),
  pause({
    permission: "selfroles.use",
    createdAt: at(-2_592_000),
    until: at(-1_728_000),
    ...setBy(OFFICER_ID),
    ...over({ at: at(-1_728_000), by: null, reason: null }),
  }),
];

/** Every moderation reply state, rendered for the audience its card is written for. */
export const MODERATION_CASES = {
  "block.paused": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Use paused",
    timestamp: false,
    render: () => blockReply(blockResult(), VIEWERS.officer),
  },
  "block.forever": {
    spec: null,
    audience: "manager",
    tone: "success",
    title: "Use paused",
    timestamp: false,
    render: () =>
      blockReply(
        blockResult({ permissions: ["modmail.open"], duration: "forever", until: null }),
        VIEWERS.manager,
      ),
  },
  "block.many": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Use paused",
    timestamp: false,
    render: () =>
      blockReply(
        blockResult({ permissions: ALL_MEMBER_FEATURES, duration: "1d", until: at(86_400) }),
        VIEWERS.officer,
      ),
  },
  "block.replaced": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Use paused",
    timestamp: false,
    render: () => blockReply(blockResult({ replaced: ["suggest.use"] }), VIEWERS.officer),
  },
  "lift.lifted": {
    spec: null,
    audience: "officer",
    tone: "success",
    title: "Pause lifted",
    timestamp: false,
    render: () => liftReply(liftResult(), VIEWERS.officer),
  },
  "lift.many": {
    spec: null,
    audience: "manager",
    tone: "success",
    title: "Pauses lifted",
    timestamp: false,
    render: () =>
      liftReply(
        liftResult({
          lifted: ["suggest.use", "issue.use"],
          notPaused: ["ledger.view"],
          managerSet: ["modmail.open"],
        }),
        VIEWERS.manager,
      ),
  },
  "lift.none": {
    spec: null,
    audience: "officer",
    tone: "info",
    title: "Nothing to lift",
    noOp: true,
    timestamp: false,
    render: () =>
      liftReply(liftResult({ lifted: [], notPaused: ["suggest.use"] }), VIEWERS.officer),
  },
  "lift.held": {
    spec: null,
    audience: "officer",
    tone: "info",
    title: "Nothing to lift",
    noOp: true,
    timestamp: false,
    render: () =>
      liftReply(liftResult({ lifted: [], managerSet: ["modmail.open"] }), VIEWERS.officer),
  },
  "status.self": {
    spec: null,
    audience: "member",
    tone: "info",
    title: "What's paused for you",
    timestamp: false,
    render: () => statusReply(ownStatus(OWN_ACTIVE), VIEWERS.member),
  },
  "status.self_clear": {
    spec: null,
    audience: "member",
    tone: "info",
    title: "Nothing is paused for you",
    timestamp: false,
    render: () => statusReply(ownStatus([]), VIEWERS.member),
  },
  "status.officer": {
    spec: null,
    audience: "officer",
    tone: "info",
    title: "Pauses for this member",
    timestamp: false,
    render: () => statusReply(officerStatus(OFFICER_ACTIVE, OFFICER_ENDED), VIEWERS.officer),
  },
  "status.officer_clear": {
    spec: null,
    audience: "officer",
    tone: "info",
    title: "Nothing is paused for this member",
    timestamp: false,
    render: () => statusReply(officerStatus([], OFFICER_ENDED), VIEWERS.officer),
  },
} satisfies ReplyCatalog<ModerationReplyKind>;
