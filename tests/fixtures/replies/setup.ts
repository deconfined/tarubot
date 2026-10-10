/**
 * The setup reply catalog (2.35.0, #46): one case per SetupReplyKind, for /setup onboarding's dry
 * run and /setup overrides, rendered from typed sample results. The samples are exported so the
 * command tests can return them from service stubs and expect the same cards, and so
 * replies-setup.test can vary them. IDs are invented.
 */
import type { OverridesResult, OverridesWrite } from "../../../src/application/overrides.js";
import { onMenuForSetup } from "../../../src/application/self-roles.js";
import { blockerOf, type SetupPlan } from "../../../src/application/setup-plan.js";
import {
  overridesReply,
  type SetupReplyKind,
  setupPlanReply,
} from "../../../src/discord/presenters/setup.js";
import {
  DENY_MASK,
  LABELLED_PERMISSIONS,
  permissionKeys,
  VOICE_DENY_MASK,
} from "../../../src/domain/permissions.js";
import { FC, GUILD_ID, NOW, VIEWERS } from "../results.js";
import type { ReplyCase, ReplyCatalog } from "./index.js";

/** An invented channel ID; `n` keeps them distinct. */
export const channelId = (n: number): string => String(700_000_000_000_000_000n + BigInt(n));
/** An invented role ID. */
export const roleId = (n: number): string => String(600_000_000_000_000_000n + BigInt(n));
/** TaruBot's own bot role in the samples. */
export const BOT_ROLE = roleId(1);
/** A shared Administrator role (an Officer role people also hold). */
export const SHARED_ROLE = roleId(2);

/** The deny masks as reply keys, in the catalog's order. */
const MASK = permissionKeys(DENY_MASK, LABELLED_PERMISSIONS);
const VOICE_MASK = permissionKeys(VOICE_DENY_MASK, LABELLED_PERMISSIONS);

/** One write; an unconfigured text channel given View Channel and the text mask by default. */
export const write = (id: string, overrides: Partial<OverridesWrite> = {}): OverridesWrite => ({
  id,
  kind: "channel",
  posting: false,
  allow: ["ViewChannel"],
  deny: MASK,
  cleared: [],
  inherited: false,
  unsyncs: false,
  ...overrides,
});
/** A category write: View Channel and the voice mask (its children's template). */
export const categoryWrite = (id: string): OverridesWrite =>
  write(id, { kind: "category", deny: VOICE_MASK });
/** A synced child copying its category's entry. */
export const inheritedWrite = (id: string): OverridesWrite =>
  write(id, { deny: VOICE_MASK, inherited: true });
/** A posting channel gets the four posting permissions and no mask. */
export const postingWrite = (id: string, unsyncs = false): OverridesWrite =>
  write(id, {
    posting: true,
    allow: ["ViewChannel", "SendMessages", "EmbedLinks", "ReadMessageHistory"],
    deny: [],
    unsyncs,
  });

/** The fields every result but onboarding's carries, with nothing to fix. */
const COMMON = {
  hiddenOnPurpose: [],
  hiddenByCategory: [],
  denied: [],
  privateCategories: [],
  grantBeforeRemoving: [],
  administratorRoles: [BOT_ROLE],
  administratorShared: [],
  effectsMode: "live",
} as const satisfies Omit<Nothing, "status" | "requeued">;

type Nothing = Extract<OverridesResult, { status: "nothing" }>;
/** A nothing result, as a dry run returns it (nothing requeued). */
export const nothing = (overrides: Partial<Nothing> = {}): Nothing => ({
  ...COMMON,
  status: "nothing",
  requeued: 0,
  ...overrides,
});

type Plan = Extract<OverridesResult, { status: "plan" }>;
/** A dry-run plan: one category, its two synced children, and the ledger. */
export const plan = (overrides: Partial<Plan> = {}): Plan => ({
  ...COMMON,
  status: "plan",
  writes: [
    categoryWrite(channelId(10)),
    inheritedWrite(channelId(11)),
    inheritedWrite(channelId(12)),
    postingWrite(channelId(1)),
  ],
  unreadable: [],
  blockers: [],
  ...overrides,
});

type Applied = Extract<OverridesResult, { status: "applied" | "stopped" }>;
/** A real run that wrote the plan above. */
export const applied = (overrides: Partial<Applied> = {}): Applied => ({
  ...COMMON,
  status: "applied",
  written: plan().writes,
  skipped: [],
  refused: [],
  unconfirmed: [],
  normalized: [],
  remaining: 0,
  stopped: null,
  requeued: 1,
  ...overrides,
});

/** A private category holding the ledger, with two channels inside TaruBot would otherwise write. */
export const PRIVATE_CATEGORY = {
  id: channelId(50),
  configured: [channelId(51)],
  inside: [channelId(51), channelId(52)],
};

/**
 * A production-sized dry run: about 100 channels in 10 categories, 6 write groups (categories,
 * synced children, text channels, voice channels, posting channels, masked configured channels),
 * 2 denied channels, 2 private categories, 5 channels that stop being synced, 3 hidden on
 * purpose, and TaruBot without Administrator yet.
 */
export function productionPlan(): Plan {
  const range = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => channelId(from + i));
  return plan({
    blockers: ["administrator"],
    writes: [
      ...range(100, 10).map(categoryWrite),
      ...range(200, 70).map(inheritedWrite),
      ...range(300, 8).map((id) => write(id)),
      ...range(400, 3).map((id) => write(id, { deny: VOICE_MASK })),
      ...range(500, 3).map((id) => postingWrite(id, true)),
      ...range(600, 2).map((id) =>
        write(id, { allow: [], deny: [], cleared: ["ReadMessageHistory"], unsyncs: true }),
      ),
    ],
    unreadable: range(700, 4),
    denied: range(800, 2),
    privateCategories: [
      PRIVATE_CATEGORY,
      { id: channelId(60), configured: range(61, 3), inside: range(61, 4) },
    ],
    hiddenOnPurpose: range(900, 3),
    grantBeforeRemoving: ["ManageNicknames"],
    administratorRoles: [],
  });
}

/** Sample /setup overrides results, one per reply kind. */
export const OVERRIDES_RESULTS = {
  plan: plan(),
  planBlocked: plan({ blockers: ["caller", "administrator"], unreadable: [channelId(70)] }),
  planAttention: plan({ denied: [channelId(80)], privateCategories: [PRIVATE_CATEGORY] }),
  nothing: nothing(),
  nothingAttention: nothing({
    denied: [channelId(80)],
    privateCategories: [PRIVATE_CATEGORY],
    hiddenOnPurpose: [channelId(90)],
  }),
  onboarding: { status: "onboarding", effectsMode: "live" } as const satisfies OverridesResult,
  applied: applied({
    administratorRoles: [BOT_ROLE, SHARED_ROLE],
    administratorShared: [SHARED_ROLE],
  }),
  appliedAttention: applied({
    refused: [channelId(20)],
    skipped: [channelId(20)],
    privateCategories: [PRIVATE_CATEGORY],
  }),
  stopped: applied({
    status: "stopped",
    stopped: "time",
    remaining: 12,
    written: [categoryWrite(channelId(10))],
    requeued: 0,
  }),
} as const;

/** Sample /setup onboarding dry runs: a clean plan and one with blockers. */
export const SETUP_PLANS = {
  plan: {
    roles: [
      { field: "member_role_id", name: "EXFC Member", action: "rename", id: roleId(11) },
      { field: "guest_role_id", name: "EXFC Guest", action: "create", id: null },
      { field: "officer_role_id", name: "EXFC Officer", action: "reuse", id: roleId(13) },
      { field: "leader_role_id", name: "EXFC FC Leader", action: "create", id: null },
    ],
    lobby: { action: "create", id: null },
    officerRoom: { action: "reuse", id: channelId(2) },
    onboarding: {
      alreadyOn: false,
      channels: 14,
      sample: [1, 2, 3, 4, 5, 6].map(channelId),
      everyoneLosesView: true,
    },
    guestApplications: { switchesOn: true, channel: null },
    officerNotifications: { channel: channelId(2), defaulted: true },
    adopt: 2,
    fc: { id: FC.id, company: FC },
    officerRank: "Officer",
    roleLayout: false,
    blockers: [],
    effectsMode: "live",
  } satisfies SetupPlan,
  blocked: {
    roles: [
      { field: "member_role_id", name: "Member", action: "reuse", id: roleId(11) },
      { field: "guest_role_id", name: "Guest", action: "create", id: null },
      { field: "officer_role_id", name: "Officer", action: "create", id: null },
      { field: "leader_role_id", name: "FC Leader", action: "create", id: null },
    ],
    lobby: { action: "unknown", id: null },
    officerRoom: { action: "unknown", id: null },
    onboarding: { alreadyOn: false, channels: null, sample: [], everyoneLosesView: null },
    guestApplications: { switchesOn: true, channel: null },
    officerNotifications: { channel: null, defaulted: true },
    adopt: 0,
    fc: { id: null, company: null },
    officerRank: null,
    roleLayout: false,
    blockers: [
      {
        code: "fc_linked",
        message: "This server is already linked to another Free Company.",
      },
      {
        code: "blocked",
        message: `TaruBot can't manage <@&${roleId(11)}>. Its own role must be above that role, and it needs Manage Roles.`,
        detail: { kind: "resource", resource: "role", id: roleId(11), fix: "hierarchy" },
      },
      {
        code: "blocked",
        message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${channelId(3)}>.`,
        detail: {
          kind: "resource",
          resource: "channel",
          id: channelId(3),
          fix: "channel_permissions",
        },
      },
      {
        code: "blocked",
        message: `TaruBot needs View Channel, Manage Channels and Manage Roles in <#${channelId(4)}>.`,
        detail: {
          kind: "resource",
          resource: "channel",
          id: channelId(4),
          fix: "channel_permissions",
        },
      },
    ],
    effectsMode: "live",
  } satisfies SetupPlan,
  /**
   * The Member role setup would reuse is on the self-service role menu (2.39.0), which no access
   * role may be: the only blocker.
   */
  onMenu: {
    roles: [
      { field: "member_role_id", name: "Member", action: "reuse", id: roleId(11) },
      { field: "guest_role_id", name: "Guest", action: "create", id: null },
      { field: "officer_role_id", name: "Officer", action: "create", id: null },
      { field: "leader_role_id", name: "FC Leader", action: "create", id: null },
    ],
    lobby: { action: "create", id: null },
    officerRoom: { action: "create", id: null },
    onboarding: { alreadyOn: false, channels: 3, sample: [], everyoneLosesView: false },
    guestApplications: { switchesOn: true, channel: null },
    officerNotifications: { channel: null, defaulted: true },
    adopt: 0,
    fc: { id: null, company: null },
    officerRank: null,
    roleLayout: false,
    blockers: [blockerOf(onMenuForSetup(roleId(11), "Member"))],
    effectsMode: "live",
  } satisfies SetupPlan,
} as const;

/** One setup case, rendered for a server manager at the mockups' clock. */
function setupCase(
  expected: Pick<ReplyCase, "tone" | "title" | "timestamp"> & {
    readonly noOp?: boolean;
    readonly readOnly?: boolean;
  },
  render: () => ReturnType<typeof overridesReply>,
): ReplyCase {
  return { spec: null, audience: "manager", ...expected, render };
}

const overrides = (result: OverridesResult) => () =>
  overridesReply(result, VIEWERS.manager, { now: NOW });

/** Every setup reply kind, with its tone, title and timestamp flag. */
export const SETUP_CASES = {
  "onboarding.plan": setupCase(
    { tone: "info", title: "Server setup · dry run", timestamp: true, readOnly: true },
    () => setupPlanReply(SETUP_PLANS.plan, VIEWERS.manager, { now: NOW }),
  ),
  "onboarding.plan_blocked": setupCase(
    {
      tone: "warning",
      title: "Server setup · dry run · 4 blockers",
      timestamp: true,
      readOnly: true,
    },
    () => setupPlanReply(SETUP_PLANS.blocked, VIEWERS.manager, { now: NOW }),
  ),
  "overrides.plan": setupCase(
    { tone: "info", title: "Channel overrides · dry run", timestamp: true, readOnly: true },
    overrides(OVERRIDES_RESULTS.plan),
  ),
  "overrides.plan_blocked": setupCase(
    {
      tone: "warning",
      title: "Channel overrides · dry run · 2 blockers",
      timestamp: true,
      readOnly: true,
    },
    overrides(OVERRIDES_RESULTS.planBlocked),
  ),
  "overrides.plan_attention": setupCase(
    {
      tone: "warning",
      title: "Channel overrides · dry run · 2 to fix in Discord",
      timestamp: true,
      readOnly: true,
    },
    overrides(OVERRIDES_RESULTS.planAttention),
  ),
  "overrides.nothing": setupCase(
    {
      tone: "info",
      title: "Channel overrides · nothing to add",
      timestamp: false,
      noOp: true,
      readOnly: true,
    },
    overrides(OVERRIDES_RESULTS.nothing),
  ),
  "overrides.nothing_attention": setupCase(
    {
      tone: "warning",
      title: "Channel overrides · nothing to add · 2 to fix in Discord",
      timestamp: false,
      readOnly: true,
    },
    overrides(OVERRIDES_RESULTS.nothingAttention),
  ),
  "overrides.onboarding": setupCase(
    {
      tone: "info",
      title: "Channel overrides · onboarding manages them",
      timestamp: false,
      noOp: true,
      readOnly: true,
    },
    overrides(OVERRIDES_RESULTS.onboarding),
  ),
  "overrides.applied": setupCase(
    { tone: "success", title: "Channel overrides added", timestamp: true },
    overrides(OVERRIDES_RESULTS.applied),
  ),
  "overrides.applied_attention": setupCase(
    { tone: "warning", title: "Channel overrides added · 2 to fix in Discord", timestamp: true },
    overrides(OVERRIDES_RESULTS.appliedAttention),
  ),
  "overrides.stopped": setupCase(
    { tone: "warning", title: "Channel overrides stopped", timestamp: true },
    overrides(OVERRIDES_RESULTS.stopped),
  ),
} satisfies ReplyCatalog<SetupReplyKind>;

/** The guild the samples' viewer belongs to (administratorRemoval's @everyone). */
export const SETUP_GUILD = GUILD_ID;
