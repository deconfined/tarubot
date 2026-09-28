/**
 * TaruBot's channel view as if Administrator were off (2.35.0, #46): the pure analysis behind
 * /config validate, the officer alert, readiness and the /setup overrides planner. Every case uses
 * invented IDs: guild 100 (whose ID is also @everyone's role), TaruBot 900 with its bot role 600,
 * access roles 201–204, an unrelated role 500, and channels from 700 up.
 *
 * The last tests are property checks over generated servers: applying every planned write as
 * TaruBot's member entry, without Discord propagating anything, leaves only what no write may fix
 * (unreadable entries, deliberate denies on configured channels and private categories), and
 * keeps every synced child synced unless the plan says it won't be, also when a run stops partway
 * and a second run finishes it.
 */
import { describe, expect, test } from "bun:test";
import { ChannelType as T, PermissionFlagsBits as P } from "discord.js";
import {
  type ApiOverwrite,
  type ApiRole,
  CORE_PERMISSIONS,
  DENY_MASK,
  POSTING_PERMISSIONS,
  VOICE_DENY_MASK,
} from "../../src/domain/permissions.js";
import {
  analyseVisibility,
  asIfBase,
  asIfRoles,
  channelState,
  NO_RECORDS,
  type OverrideTarget,
  overrideTarget,
  planOverrides,
  privateCategoryIds,
  resumeInherit,
  sameOverwriteSet,
  unreadable,
  type VisibilityChannel,
  type VisibilityConfig,
  type VisibilityGuild,
  type VisibilityRecords,
  type VisibilitySettings,
  visibilitySettings,
} from "../../src/domain/visibility.js";

const GUILD = "100";
const BOT = "900";
const BOT_ROLE = "600";
/** One mask from a catalog. */
const total = (catalog: Readonly<Record<string, bigint>>): bigint =>
  Object.values(catalog).reduce((bits, bit) => bits | bit, 0n);
const CORE = total(CORE_PERMISSIONS);
const POSTING = total(POSTING_PERMISSIONS);
/** Onboarding's five, which onboarding servers' role checks also want. */
const ONBOARDING =
  P.ManageChannels |
  P.UseApplicationCommands |
  P.CreatePublicThreads |
  P.CreatePrivateThreads |
  P.Connect;
/** A typical @everyone: members see and post, join voice, and create invites. */
const EVERYONE =
  P.ViewChannel |
  P.SendMessages |
  P.EmbedLinks |
  P.ReadMessageHistory |
  P.Connect |
  P.CreateInstantInvite;

/** A raw role. */
const role = (id: string, position: number, permissions = 0n): ApiRole => ({
  id,
  name: `role ${id}`,
  position,
  permissions: String(permissions),
  hoist: false,
  managed: id === BOT_ROLE,
});
/** A raw overwrite: type 0 for a role, 1 for a member. */
const ow = (id: string, type: 0 | 1, allow = 0n, deny = 0n): ApiOverwrite => ({
  id,
  type,
  allow: String(allow),
  deny: String(deny),
});
/** The entry that makes a channel private: @everyone can't view it. */
const PRIVATE = ow(GUILD, 0, 0n, P.ViewChannel);
/** Members may view the channel (keeps a private channel from looking synthetic). */
const MEMBERS = ow("201", 0, P.ViewChannel);
/** A private channel TaruBot can't see. */
const HIDDEN = [PRIVATE, MEMBERS];
/** Obfuscation's synthetic overwrite: exactly one @everyone View deny. */
const SYNTHETIC = [ow(GUILD, 0, 0n, P.ViewChannel)];

/** A cached channel. */
function ch(
  id: string,
  options: Partial<Omit<VisibilityChannel, "id">> & { parent?: string | null } = {},
): VisibilityChannel {
  const { parent, ...rest } = options;
  return {
    id,
    type: T.GuildText,
    parentId: parent ?? null,
    position: 0,
    overwrites: [],
    obfuscated: false,
    ...rest,
  };
}

/** The default roles: @everyone, the four access roles, an unrelated role and TaruBot's. */
const ROLES = (bot = CORE): ApiRole[] => [
  role(GUILD, 0, EVERYONE),
  role("201", 1),
  role("202", 2),
  role("203", 3),
  role("204", 4),
  role("500", 5),
  role(BOT_ROLE, 6, bot),
];

/** A guild with these channels; TaruBot holds its bot role unless told otherwise. */
function world(
  channels: readonly VisibilityChannel[],
  options: {
    roles?: ApiRole[];
    botRoles?: string[];
    botRoleId?: string | null;
    heldRoles?: string[];
    communityUpdatesId?: string | null;
  } = {},
): VisibilityGuild {
  return {
    guildId: GUILD,
    bot: {
      id: BOT,
      roles: options.botRoles ?? [BOT_ROLE],
      botRoleId: options.botRoleId === undefined ? BOT_ROLE : options.botRoleId,
    },
    roles: options.roles ?? ROLES(),
    channels,
    heldRoles: options.heldRoles ?? [],
    ...(options.communityUpdatesId === undefined
      ? {}
      : { communityUpdatesId: options.communityUpdatesId }),
  };
}

/** A server without onboarding: ledger 701, officer notifications 702, reviews 703 (open). */
const CONFIG: VisibilityConfig = {
  access_policy_enabled: false,
  ledger_channel_id: "701",
  officer_notifications_channel_id: "702",
  changelog_channel_id: null,
  guest_application_channel_id: "703",
  guest_applications_enabled: true,
  lobby_channel_id: null,
  officer_channel_id: null,
  member_role_id: "201",
  guest_role_id: "202",
  officer_role_id: "203",
  leader_role_id: "204",
};
/** The settings for CONFIG with these changes. */
const settings = (
  config: Partial<VisibilityConfig> = {},
  records: Partial<VisibilityRecords> = {},
): VisibilitySettings =>
  visibilitySettings({ ...CONFIG, ...config }, { ...NO_RECORDS, ...records });
const SETTINGS = settings();

/** The guild after these writes land as TaruBot's member entry, nothing propagated. */
function applied(guild: VisibilityGuild, plan: readonly OverrideTarget[]): VisibilityGuild {
  const writes = new Map(plan.map((target) => [target.channelId, target.after]));
  return {
    ...guild,
    channels: guild.channels.map((channel) => {
      const after = writes.get(channel.id);
      if (!after) return channel;
      const others = channel.overwrites.filter((entry) => !(entry.type === 1 && entry.id === BOT));
      return { ...channel, overwrites: [...others, ow(BOT, 1, after.allow, after.deny)] };
    }),
  };
}

describe("settings", () => {
  test("posting channels include an open review channel and every pending one", () => {
    expect(SETTINGS.posting).toEqual(["701", "702", "703"]);
    const closed = settings(
      { guest_applications_enabled: false },
      { pendingReviewChannels: ["704"] },
    );
    // A kept review channel is configured but not a posting channel while applications are off,
    // unless an application still waits there.
    expect(closed.posting).toEqual(["701", "702", "704"]);
    expect(closed.configured).toEqual(["701", "702", "704", "703"]);
    expect(closed.accessRoles).toEqual(["201", "202", "203", "204"]);
  });

  test("a pending review channel is judged as a posting channel", () => {
    // History is denied to everyone there: a plain channel would be visible, a posting one isn't.
    const channel = ch("704", { overwrites: [ow(GUILD, 0, 0n, P.ReadMessageHistory)] });
    expect(channelState(world([channel]), channel, SETTINGS)).toBe("visible");
    const pending = settings({}, { pendingReviewChannels: ["704"] });
    expect(channelState(world([channel]), channel, pending)).toBe("missing");
  });
});

describe("channel states", () => {
  test("@everyone's deny, then a role's allow, then TaruBot's own entry apply in that order", () => {
    const roleAllows = ch("710", { overwrites: [PRIVATE, ow(BOT_ROLE, 0, P.ViewChannel)] });
    expect(channelState(world([roleAllows]), roleAllows, SETTINGS)).toBe("visible");
    // TaruBot's own member entry comes last and wins over its role's allow: a deliberate deny.
    const ownDenies = ch("711", {
      overwrites: [PRIVATE, ow(BOT_ROLE, 0, P.ViewChannel), ow(BOT, 1, 0n, P.ViewChannel)],
    });
    expect(channelState(world([ownDenies]), ownDenies, SETTINGS)).toBe("hidden_on_purpose");
    // And its own allow wins over a role's deny.
    const ownAllows = ch("712", {
      overwrites: [ow("500", 0, 0n, P.ViewChannel), ow(BOT, 1, P.ViewChannel)],
    });
    const held = world([ownAllows], { botRoles: [BOT_ROLE, "500"] });
    expect(channelState(held, ownAllows, SETTINGS)).toBe("visible");
  });

  test("Administrator is ignored: it hides nothing and reveals nothing", () => {
    const channel = ch("710", { overwrites: HIDDEN });
    const roles = [...ROLES(P.Administrator)];
    const guild = world([channel], { roles });
    expect(channelState(guild, channel, SETTINGS)).toBe("missing");
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.administrator).toEqual({ held: true, roles: [BOT_ROLE], shared: [] });
    // Without Administrator the role grants none of the core seven.
    expect(report.core.every((row) => row.source === "everyone" || row.source === "missing")).toBe(
      true,
    );
    expect(report.administratorNeeded).toBe(true);
    // Nor does it reveal a posting permission no role grants: Embed Links comes from nowhere.
    const ledger = ch("701");
    const bare = world([ledger], {
      roles: [
        role(GUILD, 0, P.ViewChannel | P.SendMessages | P.ReadMessageHistory),
        role(BOT_ROLE, 6, P.Administrator),
      ],
    });
    expect(analyseVisibility(bare, SETTINGS).missing.posting).toEqual([
      { id: "701", lacks: ["EmbedLinks"] },
    ]);
  });

  test("a posting channel @everyone can't view is missing, with View Channel among what it lacks", () => {
    // The guild grants Send, Embed and History, but the channel denies @everyone View.
    const ledger = ch("701", { overwrites: HIDDEN });
    const report = analyseVisibility(world([ledger]), SETTINGS);
    expect(channelState(world([ledger]), ledger, SETTINGS)).toBe("missing");
    expect(report.missing.posting).toEqual([{ id: "701", lacks: ["ViewChannel"] }]);
    expect(report.missing.channels).toEqual(["701"]);
    // It needs all four posting permissions (84992), View included.
    expect(POSTING).toBe(84992n);
    expect(overrideTarget(world([ledger]), ledger, SETTINGS)?.after).toEqual({
      allow: P.ViewChannel,
      deny: 0n,
    });
  });

  test("a posting channel lacking only Embed Links or only History is missing", () => {
    for (const bit of [P.EmbedLinks, P.ReadMessageHistory]) {
      const ledger = ch("701", { overwrites: [ow(GUILD, 0, 0n, bit)] });
      const report = analyseVisibility(world([ledger]), SETTINGS);
      expect(report.missing.posting).toEqual([
        { id: "701", lacks: [bit === P.EmbedLinks ? "EmbedLinks" : "ReadMessageHistory"] },
      ]);
      // The same channel unconfigured only needs View Channel.
      const plain = ch("720", { overwrites: [ow(GUILD, 0, 0n, bit)] });
      expect(channelState(world([plain]), plain, SETTINGS)).toBe("visible");
    }
  });

  test("hidden on purpose comes from TaruBot's own entry or its bot role's, not another role's", () => {
    const own = ch("710", { overwrites: [ow(BOT, 1, 0n, P.ViewChannel)] });
    const botRole = ch("711", { overwrites: [ow(BOT_ROLE, 0, 0n, P.ViewChannel)] });
    const other = ch("712", { overwrites: [ow("500", 0, 0n, P.ViewChannel)] });
    const guild = world([own, botRole, other], { botRoles: [BOT_ROLE, "500"] });
    expect(channelState(guild, own, SETTINGS)).toBe("hidden_on_purpose");
    expect(channelState(guild, botRole, SETTINGS)).toBe("hidden_on_purpose");
    expect(channelState(guild, other, SETTINGS)).toBe("missing");
    // Without a known bot role, its entry is just another role's.
    const unknown = world([botRole], { botRoleId: null });
    expect(channelState(unknown, botRole, SETTINGS)).toBe("missing");
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.hiddenOnPurpose).toEqual(["710", "711"]);
    expect(report.missingCount).toBe(1);
  });

  test("a channel with no TaruBot entry inside a category hidden from TaruBot is hidden too", () => {
    // The review's probe: TaruBot's own entry denies View on category 800 and its synced child 801;
    // 802 is a staff channel no longer synced, with no entry for TaruBot. A category's deny reaches
    // only its synced children, so an entry on 802 would partly undo it: Discord shows a category
    // to anyone who can view a channel inside.
    const hide = ow(BOT, 1, 0n, P.ViewChannel);
    const category = ch("800", { type: T.GuildCategory, overwrites: [...HIDDEN, hide] });
    const synced = ch("801", { parent: "800", overwrites: [...HIDDEN, hide] });
    const staff = ch("802", { parent: "800", overwrites: HIDDEN });
    // An entry of its own for TaruBot, or for its bot role, is a choice about that channel.
    const own = ch("803", { parent: "800", overwrites: [...HIDDEN, ow(BOT, 1, P.AttachFiles)] });
    const byRole = ch("804", {
      parent: "800",
      overwrites: [...HIDDEN, ow(BOT_ROLE, 0, P.AttachFiles)],
    });
    // A configured channel there is judged on its own too: TaruBot needs it.
    const ledger = ch("701", { parent: "800", overwrites: HIDDEN });
    const guild = world([category, synced, staff, own, byRole, ledger]);
    expect(channelState(guild, staff, SETTINGS)).toBe("hidden_on_purpose");
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.hiddenOnPurpose).toEqual(["800", "801", "802"]);
    expect(report.hiddenByCategory).toEqual(["802"]);
    expect(report.missing.channels).toEqual(["701", "803", "804"]);
    expect(report.missingCount).toBe(3);
    expect(planOverrides(guild, SETTINGS).map((target) => target.channelId)).toEqual([
      "701",
      "803",
      "804",
    ]);
    // The same channel in a category that is merely private, or hidden by another role's deny, is
    // missing and planned as before.
    const plain = world([ch("800", { type: T.GuildCategory, overwrites: HIDDEN }), staff]);
    expect(channelState(plain, staff, SETTINGS)).toBe("missing");
    expect(analyseVisibility(plain, SETTINGS).hiddenByCategory).toEqual([]);
  });

  test("a configured channel denied on purpose is 'denied', counted, and still never planned", () => {
    const ledger = ch("701", { overwrites: [ow(BOT, 1, 0n, P.ViewChannel)] });
    const guild = world([ledger], { roles: ROLES(CORE | P.Administrator) });
    expect(channelState(guild, ledger, SETTINGS)).toBe("denied");
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.denied).toEqual(["701"]);
    expect(report.hiddenOnPurpose).toEqual([]);
    expect(report.missingCount).toBe(1);
    expect(report.administratorNeeded).toBe(true);
    expect(overrideTarget(guild, ledger, SETTINGS)).toBeNull();
    expect(planOverrides(guild, SETTINGS)).toEqual([]);
  });
});

describe("masked means Read Message History only", () => {
  const closed = settings({ guest_applications_enabled: false });

  test("a configured channel whose own entry denies only Manage Permissions is visible", () => {
    const reviews = ch("703", { overwrites: [ow(BOT, 1, 0n, P.ManageRoles)] });
    const guild = world([reviews]);
    expect(channelState(guild, reviews, closed)).toBe("visible");
    expect(analyseVisibility(guild, closed)).toMatchObject({ masked: [], missingCount: 0 });
    expect(planOverrides(guild, closed)).toEqual([]);
  });

  test("a kept review channel denying History, Manage Permissions and Create Invite is masked", () => {
    // TaruBot sees it, but an earlier run masked it while no setting named it.
    const reviews = ch("703", {
      overwrites: [
        ow(
          BOT,
          1,
          P.ViewChannel | P.AttachFiles,
          P.ReadMessageHistory | P.ManageRoles | P.CreateInstantInvite,
        ),
      ],
    });
    const guild = world([reviews]);
    expect(channelState(guild, reviews, closed)).toBe("masked");
    expect(analyseVisibility(guild, closed)).toMatchObject({ masked: ["703"], missingCount: 1 });
    // The write lifts only the History deny; the other denies stay (least privilege).
    expect(overrideTarget(guild, reviews, closed)).toEqual({
      channelId: "703",
      kind: "channel",
      posting: false,
      before: {
        allow: P.ViewChannel | P.AttachFiles,
        deny: P.ReadMessageHistory | P.ManageRoles | P.CreateInstantInvite,
      },
      after: { allow: P.ViewChannel | P.AttachFiles, deny: P.ManageRoles | P.CreateInstantInvite },
      granted: 0n,
      masked: 0n,
      cleared: P.ReadMessageHistory,
      inherited: false,
      unsyncs: false,
    });
    // An unconfigured channel with the same entry is simply visible.
    const plain = ch("720", { overwrites: reviews.overwrites });
    expect(channelState(world([plain]), plain, closed)).toBe("visible");
  });
});

describe("unreadable entries", () => {
  test("an obfuscated entry, or one left with only the synthetic deny, is unreadable and missing", () => {
    const flagged = ch("710", { obfuscated: true, overwrites: SYNTHETIC });
    const patched = ch("711", { overwrites: SYNTHETIC });
    const guild = world([flagged, patched]);
    expect(unreadable(guild, flagged)).toBe(true);
    expect(unreadable(guild, patched)).toBe(true);
    // A fresh REST read of the same shape is a real private channel.
    expect(unreadable(guild, { ...patched, fetched: true })).toBe(false);
    expect(unreadable(guild, { ...flagged, fetched: true })).toBe(true);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.missing).toMatchObject({ channels: ["710", "711"], unreadable: ["710", "711"] });
    expect(planOverrides(guild, SETTINGS)).toEqual([]);
  });

  test("an obfuscated entry TaruBot's role could view is still missing, never visible", () => {
    const flagged = ch("710", { obfuscated: true, overwrites: [] });
    expect(channelState(world([flagged]), flagged, SETTINGS)).toBe("missing");
  });

  test("the recorded set makes an unreadable entry hidden on purpose, or denied when configured", () => {
    const flagged = ch("710", { obfuscated: true, overwrites: SYNTHETIC });
    const ledger = ch("701", { obfuscated: true, overwrites: SYNTHETIC });
    const guild = world([flagged, ledger]);
    const recorded = settings({}, { recordedHidden: ["710", "701"] });
    expect(channelState(guild, flagged, recorded)).toBe("hidden_on_purpose");
    expect(channelState(guild, ledger, recorded)).toBe("denied");
    // The recorded set never overrides a readable entry's own data.
    const readable = ch("720", { overwrites: HIDDEN });
    const withReadable = settings({}, { recordedHidden: ["720"] });
    expect(channelState(world([readable]), readable, withReadable)).toBe("missing");
  });

  test("an unrecorded unreadable channel inside a category recorded as hidden is hidden too", () => {
    // After 2026-11-16 with Administrator off: category 710 and child 711 were recorded hidden on
    // purpose by the last run; 712 was created in 710 afterwards, so Discord copied the category's
    // TaruBot deny into it and now sends it obfuscated. Only its parent_id is real.
    const category = ch("710", { type: T.GuildCategory, obfuscated: true, overwrites: SYNTHETIC });
    const recordedChild = ch("711", { parent: "710", obfuscated: true, overwrites: SYNTHETIC });
    const later = ch("712", {
      parent: "710",
      position: 1,
      obfuscated: true,
      overwrites: SYNTHETIC,
    });
    const guild = world([category, recordedChild, later]);
    const recorded = settings({}, { recordedHidden: ["710", "711"] });
    expect(channelState(guild, later, recorded)).toBe("hidden_on_purpose");
    const report = analyseVisibility(guild, recorded);
    expect(report.missing.channels).toEqual([]);
    expect(report.missing.unreadable).toEqual([]);
    expect(report.hiddenOnPurpose).toEqual(["710", "711", "712"]);
    expect(report.hiddenByCategory).toEqual(["712"]);
    expect(report.missingCount).toBe(0);
    // A configured channel there is still judged on its own, and so is one in a category the
    // record doesn't name.
    expect(channelState(guild, { ...later, id: "701" }, recorded)).toBe("missing");
    expect(channelState(guild, later, SETTINGS)).toBe("missing");
  });
});

describe("private categories", () => {
  /**
   * Category 730, which TaruBot can't see, holds the ledger (synced), a synced text sibling, an
   * unsynced voice sibling and a text channel with its own private overwrites; 720 is an ordinary
   * missing channel elsewhere.
   */
  const privateWorld = (options: { roles?: ApiRole[] } = {}) => {
    const category = ch("730", { type: T.GuildCategory, overwrites: HIDDEN, position: 1 });
    const ledger = ch("701", { parent: "730", overwrites: HIDDEN, position: 0 });
    const synced = ch("731", { parent: "730", overwrites: HIDDEN, position: 1 });
    const voice = ch("732", {
      parent: "730",
      type: T.GuildVoice,
      overwrites: [PRIVATE, ow("202", 0, P.ViewChannel)],
      position: 2,
    });
    const own = ch("733", {
      parent: "730",
      overwrites: [PRIVATE, ow("500", 0, P.ViewChannel)],
      position: 3,
    });
    const loose = ch("720", { overwrites: HIDDEN });
    return world([own, voice, synced, ledger, category, loose], options);
  };

  test("a missing category holding the ledger is reported with everything inside, never planned", () => {
    const guild = privateWorld();
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.privateCategories).toEqual([
      { id: "730", configured: ["701"], inside: ["701", "731", "732", "733"] },
    ]);
    // None of it is a missing override; the loose channel still is.
    expect(report.missing).toEqual({
      categories: [],
      inside: [],
      channels: ["720"],
      posting: [],
      unreadable: [],
    });
    // One for the category plus the four inside it, plus the loose channel.
    expect(report.missingCount).toBe(6);
    expect([...privateCategoryIds(guild, SETTINGS)]).toEqual(["730"]);
    expect(planOverrides(guild, SETTINGS).map((target) => target.channelId)).toEqual(["720"]);
    for (const channel of guild.channels.filter((c) => c.id !== "720"))
      expect({ id: channel.id, target: overrideTarget(guild, channel, SETTINGS) }).toEqual({
        id: channel.id,
        target: null,
      });
    // Administrator stays needed while it is held: removing it would hide the ledger.
    const admin = privateWorld({ roles: ROLES(CORE | P.Administrator) });
    const fixedLoose = {
      ...admin,
      channels: admin.channels.map((channel) =>
        channel.id === "720"
          ? { ...channel, overwrites: [...HIDDEN, ow(BOT, 1, P.ViewChannel)] }
          : channel,
      ),
    };
    expect(analyseVisibility(fixedLoose, SETTINGS)).toMatchObject({
      missingCount: 5,
      administratorNeeded: true,
    });
  });

  test("an unreadable (obfuscated) category the ledger names as parent is still private", () => {
    const category = ch("730", { type: T.GuildCategory, obfuscated: true, overwrites: SYNTHETIC });
    const ledger = ch("701", { parent: "730", obfuscated: true, overwrites: SYNTHETIC });
    const guild = world([category, ledger]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.privateCategories).toEqual([{ id: "730", configured: ["701"], inside: ["701"] }]);
    expect(report.missing.unreadable).toEqual([]);
    expect(report.missingCount).toBe(2);
  });

  test("a category holding only a configured channel and no siblings is still private", () => {
    const category = ch("730", { type: T.GuildCategory, overwrites: HIDDEN });
    const ledger = ch("701", { parent: "730", overwrites: HIDDEN });
    const guild = world([category, ledger]);
    expect(analyseVisibility(guild, SETTINGS).privateCategories).toEqual([
      { id: "730", configured: ["701"], inside: ["701"] },
    ]);
    expect(planOverrides(guild, SETTINGS)).toEqual([]);
  });

  test("a category TaruBot sees, holding the ledger, is not private; its children are planned", () => {
    const category = ch("740", { type: T.GuildCategory, overwrites: [] });
    const ledger = ch("701", { parent: "740", overwrites: HIDDEN });
    const text = ch("741", { parent: "740", overwrites: HIDDEN, position: 1 });
    const guild = world([category, ledger, text]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.privateCategories).toEqual([]);
    expect(report.missing.channels).toEqual(["701", "741"]);
    expect(planOverrides(guild, SETTINGS)).toMatchObject([
      { channelId: "701", after: { allow: P.ViewChannel, deny: 0n }, unsyncs: false },
      { channelId: "741", after: { allow: P.ViewChannel, deny: DENY_MASK }, unsyncs: false },
    ]);
  });

  test("a category hidden from TaruBot on purpose, holding the ledger, is not private", () => {
    const category = ch("750", {
      type: T.GuildCategory,
      overwrites: [ow(BOT, 1, 0n, P.ViewChannel)],
    });
    const ledger = ch("701", { parent: "750", overwrites: HIDDEN });
    const guild = world([category, ledger]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.privateCategories).toEqual([]);
    expect(report.hiddenOnPurpose).toEqual(["750"]);
    // The ledger itself is missing, and its own write makes it visible.
    expect(report.missing.channels).toEqual(["701"]);
    expect(planOverrides(guild, SETTINGS).map((target) => target.channelId)).toEqual(["701"]);
  });

  test("a deliberate deny inside a private category is still reported as one", () => {
    const category = ch("730", { type: T.GuildCategory, overwrites: HIDDEN });
    const ledger = ch("701", { parent: "730", overwrites: HIDDEN });
    const notices = ch("702", { parent: "730", overwrites: [ow(BOT, 1, 0n, P.ViewChannel)] });
    const off = ch("733", { parent: "730", overwrites: [ow(BOT, 1, 0n, P.ViewChannel)] });
    const report = analyseVisibility(world([category, ledger, notices, off]), SETTINGS);
    expect(report.privateCategories).toEqual([
      { id: "730", configured: ["701", "702"], inside: ["701"] },
    ]);
    expect(report.denied).toEqual(["702"]);
    expect(report.hiddenOnPurpose).toEqual(["733"]);
    // The category, the ledger inside it, and the denied channel.
    expect(report.missingCount).toBe(3);
  });

  test("onboarding servers have no private categories", () => {
    const guild = privateWorld();
    const onboarding = settings({ access_policy_enabled: true });
    expect(privateCategoryIds(guild, onboarding).size).toBe(0);
    expect(analyseVisibility(guild, onboarding).privateCategories).toEqual([]);
  });
});

describe("shared Administrator roles", () => {
  test("a shared Administrator role is dropped whole, with its permissions and overwrites", () => {
    // The reviewer's probe: TaruBot holds its bot role plus the Officer role, which has
    // Administrator and Manage Nicknames and is allowed into the private officer notifications.
    const roles = [
      role(GUILD, 0, EVERYONE),
      role("201", 1),
      role("202", 2),
      role("203", 3, P.Administrator | P.ManageNicknames),
      role("204", 4),
      role(BOT_ROLE, 6, CORE & ~P.ManageNicknames),
    ];
    const notices = ch("702", { overwrites: [PRIVATE, ow("203", 0, P.ViewChannel)] });
    const guild = world([notices], { roles, botRoles: [BOT_ROLE, "203"] });
    expect(asIfRoles(guild)).toEqual([BOT_ROLE]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.administrator).toEqual({ held: true, roles: ["203"], shared: ["203"] });
    expect(channelState(guild, notices, SETTINGS)).toBe("missing");
    expect(report.missing.channels).toEqual(["702"]);
    expect(report.administratorNeeded).toBe(true);
    // Manage Nicknames came only from the shared role.
    expect(report.core.find((row) => row.permission === "ManageNicknames")?.source).toBe("missing");
    expect(asIfBase(guild) & P.ManageNicknames).toBe(0n);
  });

  test("Administrator on TaruBot's bot role only: nothing is shared and nothing else changes", () => {
    const notices = ch("702", { overwrites: [PRIVATE, ow(BOT_ROLE, 0, P.ViewChannel)] });
    const guild = world([notices], { roles: ROLES(CORE | P.Administrator) });
    expect(asIfRoles(guild)).toEqual([BOT_ROLE]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.administrator).toEqual({ held: true, roles: [BOT_ROLE], shared: [] });
    expect(channelState(guild, notices, SETTINGS)).toBe("visible");
    expect(report.core.every((row) => row.source === "own_role")).toBe(true);
    expect(report.administratorNeeded).toBe(false);
  });

  test("without a known bot role every Administrator role is shared; unknown roles are kept", () => {
    const roles = [...ROLES(CORE | P.Administrator)];
    const guild = world([], { roles, botRoleId: null, botRoles: [BOT_ROLE, "999"] });
    // Conservative: nothing says 600 is TaruBot's own, so it may be taken away.
    expect(asIfRoles(guild)).toEqual(["999"]);
    expect(analyseVisibility(guild, SETTINGS).administrator.shared).toEqual([BOT_ROLE]);
  });
});

describe("the report", () => {
  test("missing categories are counted with the missing channels inside them", () => {
    const category = ch("730", { type: T.GuildCategory, overwrites: HIDDEN });
    const inside = ch("731", { parent: "730", overwrites: HIDDEN });
    const visibleInside = ch("732", {
      parent: "730",
      overwrites: [ow(BOT_ROLE, 0, P.ViewChannel)],
    });
    const loose = ch("733", { overwrites: HIDDEN, position: 3 });
    const openCategory = ch("740", { type: T.GuildCategory, position: 1 });
    const inOpen = ch("741", { parent: "740", overwrites: HIDDEN });
    const guild = world([inOpen, openCategory, loose, visibleInside, inside, category]);
    const report = analyseVisibility(guild, SETTINGS);
    expect(report.missing).toEqual({
      categories: ["730"],
      inside: ["731"],
      channels: ["733", "741"],
      posting: [],
      unreadable: [],
    });
    expect(report.privateCategories).toEqual([]);
    expect(report.onboardingPending).toBeNull();
    expect(report.missingCount).toBe(4);
  });

  test("core rows say where each permission comes from", () => {
    const roles = [
      role(GUILD, 0, EVERYONE),
      role("500", 5, P.ManageNicknames | P.AttachFiles),
      role("501", 6, P.AttachFiles),
      role(BOT_ROLE, 7, P.ManageRoles | P.SendMessages),
    ];
    const guild = world([], { roles, botRoles: [BOT_ROLE, "500", "501"] });
    const rows = Object.fromEntries(
      analyseVisibility(guild, SETTINGS).core.map((row) => [row.permission, row]),
    );
    expect(Object.keys(rows)).toEqual(Object.keys(CORE_PERMISSIONS));
    expect(rows.ManageRoles).toEqual({ permission: "ManageRoles", source: "own_role", roles: [] });
    // SendMessages comes from TaruBot's role and @everyone: still its own.
    expect(rows.SendMessages).toMatchObject({ source: "own_role", roles: [GUILD] });
    expect(rows.ManageNicknames).toMatchObject({ source: "other_roles", roles: ["500"] });
    // Highest first.
    expect(rows.AttachFiles).toMatchObject({ source: "other_roles", roles: ["501", "500"] });
    expect(rows.ViewChannel).toMatchObject({ source: "everyone", roles: [GUILD] });
    expect(rows.EmbedLinks).toMatchObject({ source: "everyone", roles: [GUILD] });
    // A role that grants it besides @everyone is 'other_roles', listing @everyone too.
    const both = world([], {
      roles: [...roles, role("502", 4, P.ViewChannel)],
      botRoles: [BOT_ROLE, "502"],
    });
    expect(analyseVisibility(both, SETTINGS).core[2]).toMatchObject({
      permission: "ViewChannel",
      source: "other_roles",
      roles: ["502", GUILD],
    });
    const bare = world([], { roles: [role(GUILD, 0), role(BOT_ROLE, 1)] });
    expect(analyseVisibility(bare, SETTINGS).core.map((row) => row.source)).toEqual(
      Array(7).fill("missing"),
    );
  });

  test("Administrator's holders include @everyone; never-needed rows never name @everyone", () => {
    const roles = [
      role(GUILD, 0, EVERYONE | P.Administrator | P.MentionEveryone),
      role("500", 5, P.KickMembers | P.ManageGuild),
      role(BOT_ROLE, 6, CORE | P.Administrator | P.ManageGuild),
    ];
    const report = analyseVisibility(world([], { roles, botRoles: [BOT_ROLE, "500"] }), SETTINGS);
    expect(report.administrator).toEqual({ held: true, roles: [BOT_ROLE, GUILD], shared: [] });
    // @everyone's Mention Everyone isn't TaruBot's to shed, so its row is dropped.
    expect(report.neverNeeded).toEqual([
      { permission: "ManageGuild", roles: [BOT_ROLE, "500"] },
      { permission: "KickMembers", roles: ["500"] },
    ]);
    // Nothing depends on Administrator here: every channel is visible and the core seven held.
    expect(report.administratorNeeded).toBe(false);
  });

  test("Discord's default @everyone (104324673) gives no never-needed row", () => {
    const roles = [role(GUILD, 0, 104_324_673n), role(BOT_ROLE, 6, CORE)];
    expect(104_324_673n & P.MentionEveryone).toBe(P.MentionEveryone);
    expect(analyseVisibility(world([], { roles }), SETTINGS).neverNeeded).toEqual([]);
    // Manage Messages on TaruBot's own role names that role.
    const managing = [role(GUILD, 0, 104_324_673n), role(BOT_ROLE, 6, CORE | P.ManageMessages)];
    expect(analyseVisibility(world([], { roles: managing }), SETTINGS).neverNeeded).toEqual([
      { permission: "ManageMessages", roles: [BOT_ROLE] },
    ]);
  });

  test("role order: access roles and retired roles someone holds must sit below TaruBot", () => {
    const roles = [
      role(GUILD, 0, EVERYONE),
      role("201", 1),
      role("202", 2),
      role(BOT_ROLE, 3, CORE),
      role("203", 4),
      role("204", 3),
      role("650", 3),
      role("205", 5),
      role("206", 6),
    ];
    const retired = settings({}, { retiredRoles: ["205", "206", "650"] });
    const guild = world([], { roles, heldRoles: ["205", "201", "650"] });
    // Equal raw positions sort the higher ID lower (as Discord shows them): 204 shares TaruBot's
    // position with a lower ID, so it sits above; 650 has a higher ID, so it sits below. 206 is
    // retired and held by nobody, so it doesn't matter.
    expect(analyseVisibility(guild, retired).roleOrder).toEqual({
      highest: BOT_ROLE,
      notBelow: ["203", "204", "205"],
      throughShared: [],
    });
    // Holding only @everyone, every access role is above TaruBot.
    const bare = world([], { roles, botRoles: [], botRoleId: null });
    expect(analyseVisibility(bare, SETTINGS).roleOrder).toEqual({
      highest: null,
      notBelow: ["201", "202", "203", "204"],
      throughShared: [],
    });
  });

  test("role order kept only by a shared Administrator role keeps Administrator needed", () => {
    // The review's probe: TaruBot's own role sits at the bottom, below the access roles, and a
    // shared Administrator role (650) at the top is its highest. Discord's hierarchy applies with
    // Administrator, so TaruBot manages the access roles today only through 650.
    const roles = [
      role(GUILD, 0, EVERYONE),
      role(BOT_ROLE, 1, CORE),
      role("201", 2),
      role("202", 3),
      role("203", 4),
      role("204", 5),
      role("650", 10, P.Administrator),
    ];
    const shared = world([ch("710")], { roles, botRoles: [BOT_ROLE, "650"] });
    expect(analyseVisibility(shared, SETTINGS)).toMatchObject({
      administrator: { held: true, roles: ["650"], shared: ["650"] },
      roleOrder: {
        highest: BOT_ROLE,
        notBelow: ["201", "202", "203", "204"],
        throughShared: ["201", "202", "203", "204"],
      },
      missingCount: 0,
      administratorNeeded: true,
    });
    // Administrator on TaruBot's own role doesn't lift it in the hierarchy: the order is wrong
    // now and after, so it is a plain failure and Administrator isn't what keeps it working.
    const own = world([ch("710")], {
      roles: roles.map((entry) =>
        entry.id === BOT_ROLE ? role(BOT_ROLE, 1, CORE | P.Administrator) : entry,
      ),
    });
    expect(analyseVisibility(own, SETTINGS)).toMatchObject({
      administrator: { held: true, shared: [] },
      roleOrder: { notBelow: ["201", "202", "203", "204"], throughShared: [] },
      administratorNeeded: false,
    });
    // A shared role in the middle: TaruBot is below 202, 203 and 204 whatever it holds, and above
    // 201 only through it.
    const middle = world([ch("710")], {
      roles: roles.map((entry) => (entry.id === "650" ? role("650", 3, P.Administrator) : entry)),
      botRoles: [BOT_ROLE, "650"],
    });
    // 650 shares 202's raw position with a higher ID, so it sorts below 202.
    expect(analyseVisibility(middle, SETTINGS).roleOrder).toEqual({
      highest: BOT_ROLE,
      notBelow: ["201", "202", "203", "204"],
      throughShared: ["201"],
    });
    // The same on an onboarding server, whose own rule for Administrator counts it too.
    const onboarding = settings({ access_policy_enabled: true });
    const full = roles.map((entry) =>
      entry.id === BOT_ROLE ? role(BOT_ROLE, 1, CORE | ONBOARDING) : entry,
    );
    const everywhere = world([ch("710", { overwrites: [ow(BOT, 1, POSTING)] })], {
      roles: full,
      botRoles: [BOT_ROLE, "650"],
    });
    expect(analyseVisibility(everywhere, onboarding)).toMatchObject({
      onboardingPending: { managed: [], unmanaged: [] },
      administratorNeeded: true,
    });
  });

  test("Administrator is needed while anything counts as missing, and not once nothing does", () => {
    const hidden = ch("710", { overwrites: HIDDEN });
    const roles = ROLES(CORE | P.Administrator);
    expect(analyseVisibility(world([hidden], { roles }), SETTINGS).administratorNeeded).toBe(true);
    const seen = ch("710", { overwrites: [...HIDDEN, ow(BOT, 1, P.ViewChannel)] });
    expect(analyseVisibility(world([seen], { roles }), SETTINGS).administratorNeeded).toBe(false);
    // Without Administrator, it is never "needed".
    expect(analyseVisibility(world([hidden]), SETTINGS).administratorNeeded).toBe(false);
  });
});

describe("onboarding servers", () => {
  const onboarding = settings({ access_policy_enabled: true });
  /** TaruBot's role with the core seven and onboarding's five, plus Administrator when asked. */
  const full = (administrator: boolean) =>
    ROLES(CORE | ONBOARDING | (administrator ? P.Administrator : 0n));

  test("the role checks include onboarding's permissions", () => {
    const report = analyseVisibility(world([]), onboarding);
    // CORE alone lacks four of the five; @everyone's Connect counts.
    expect(report.onboardingMissing).toEqual([
      "ManageChannels",
      "UseApplicationCommands",
      "CreatePublicThreads",
      "CreatePrivateThreads",
    ]);
    expect(analyseVisibility(world([]), SETTINGS).onboardingMissing).toBeNull();
    // With Administrator on, those gaps are what it still covers.
    const admin = world([], { roles: ROLES(CORE | P.Administrator) });
    expect(analyseVisibility(admin, onboarding).administratorNeeded).toBe(true);
    expect(analyseVisibility(world([], { roles: full(true) }), onboarding)).toMatchObject({
      onboardingMissing: [],
      administratorNeeded: false,
    });
  });

  test("a channel onboarding's pass hasn't reached keeps Administrator needed", () => {
    const hidden = ch("710", { overwrites: HIDDEN });
    const report = analyseVisibility(world([hidden], { roles: full(true) }), onboarding);
    expect(report).toMatchObject({
      mode: "onboarding",
      missing: { categories: [], inside: [], channels: [], posting: [], unreadable: [] },
      masked: [],
      denied: [],
      hiddenOnPurpose: [],
      privateCategories: [],
      onboardingPending: { managed: ["710"], unmanaged: [] },
      missingCount: 0,
      administratorNeeded: true,
    });
    // Without Administrator it is reported, but nothing is "needed".
    expect(analyseVisibility(world([hidden], { roles: full(false) }), onboarding)).toMatchObject({
      onboardingPending: { managed: ["710"], unmanaged: [] },
      administratorNeeded: false,
    });
    // Once the pass has written TaruBot's own entry there, nothing is pending.
    const reached = ch("710", {
      overwrites: [
        ...HIDDEN,
        ow(
          BOT,
          1,
          P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles,
        ),
      ],
    });
    expect(analyseVisibility(world([reached], { roles: full(true) }), onboarding)).toMatchObject({
      onboardingPending: { managed: [], unmanaged: [] },
      administratorNeeded: false,
    });
  });

  test("a channel still carrying /setup overrides' mask waits on onboarding's first pass", () => {
    // A server that ran /setup overrides and turned onboarding on later: TaruBot sees both
    // channels, but its own entry denies Manage Permissions and Manage Channels (and Connect in
    // the voice channel), which refuse onboarding's write without Administrator (channelRefusal).
    const text = ch("710", { overwrites: [...HIDDEN, ow(BOT, 1, P.ViewChannel, DENY_MASK)] });
    const voice = ch("711", {
      type: T.GuildVoice,
      overwrites: [...HIDDEN, ow(BOT, 1, P.ViewChannel, VOICE_DENY_MASK)],
    });
    // Connect alone denied on TaruBot's entry in a text channel refuses nothing there.
    const connect = ch("712", { overwrites: [...HIDDEN, ow(BOT, 1, P.ViewChannel, P.Connect)] });
    const masked = [text, voice, connect];
    expect(analyseVisibility(world(masked, { roles: full(true) }), onboarding)).toMatchObject({
      onboardingPending: { managed: ["710", "711"], unmanaged: [] },
      missingCount: 0,
      administratorNeeded: true,
    });
    expect(analyseVisibility(world(masked, { roles: full(false) }), onboarding)).toMatchObject({
      onboardingPending: { managed: ["710", "711"], unmanaged: [] },
      administratorNeeded: false,
    });
    // After the first pass with Administrator: onboarding's allows, and only Create Invite denied.
    const lifted = ow(
      BOT,
      1,
      P.ViewChannel | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks | P.AttachFiles,
      P.CreateInstantInvite,
    );
    const after = world(
      [
        { ...text, overwrites: [...HIDDEN, lifted] },
        { ...voice, overwrites: [...HIDDEN, lifted] },
      ],
      { roles: full(true) },
    );
    expect(analyseVisibility(after, onboarding)).toMatchObject({
      onboardingPending: { managed: [], unmanaged: [] },
      administratorNeeded: false,
    });
  });

  test("the Community Updates channel and its category are never pending unless configured", () => {
    const category = ch("760", { type: T.GuildCategory, overwrites: HIDDEN });
    const updates = ch("761", { parent: "760", overwrites: HIDDEN });
    const sibling = ch("762", { parent: "760", overwrites: HIDDEN });
    const guild = world([category, updates, sibling], {
      roles: full(true),
      communityUpdatesId: "761",
    });
    // The category and the updates channel are onboarding's exclusions; their sibling isn't.
    expect(analyseVisibility(guild, onboarding).onboardingPending).toEqual({
      managed: ["762"],
      unmanaged: [],
    });
    // Chosen as the changelog, and TaruBot can't post there: onboarding never manages it.
    const changelog = settings({ access_policy_enabled: true, changelog_channel_id: "761" });
    const report = analyseVisibility(guild, changelog);
    expect(report.onboardingPending).toEqual({ managed: ["762"], unmanaged: ["761"] });
    expect(report.missingCount).toBe(0);
    expect(report.administratorNeeded).toBe(true);
    // Once TaruBot can post there itself (and the pass has reached the sibling), it is fine.
    const posting = ow(BOT, 1, POSTING);
    const fixed = world(
      [
        category,
        { ...updates, overwrites: [...HIDDEN, posting] },
        { ...sibling, overwrites: [...HIDDEN, posting] },
      ],
      { roles: full(true), communityUpdatesId: "761" },
    );
    expect(analyseVisibility(fixed, changelog)).toMatchObject({
      onboardingPending: { managed: [], unmanaged: [] },
      administratorNeeded: false,
    });
  });
});

describe("planned writes", () => {
  test("a text channel gets View plus the deny mask, other entries' bits untouched", () => {
    const text = ch("720", {
      overwrites: [...HIDDEN, ow(BOT, 1, P.AttachFiles | P.ReadMessageHistory, P.SendMessages)],
    });
    expect(overrideTarget(world([text]), text, SETTINGS)).toMatchObject({
      kind: "channel",
      posting: false,
      before: { allow: P.AttachFiles | P.ReadMessageHistory, deny: P.SendMessages },
      after: { allow: P.ViewChannel | P.AttachFiles, deny: P.SendMessages | DENY_MASK },
      granted: P.ViewChannel,
      masked: DENY_MASK,
      cleared: 0n,
      inherited: false,
      unsyncs: false,
    });
  });

  test("voice, stage and categories get the voice mask, Connect included", () => {
    for (const type of [T.GuildVoice, T.GuildStageVoice, T.GuildCategory]) {
      const channel = ch("720", { type, overwrites: HIDDEN });
      expect(overrideTarget(world([channel]), channel, SETTINGS)?.after).toEqual({
        allow: P.ViewChannel,
        deny: VOICE_DENY_MASK,
      });
    }
    const forum = ch("720", { type: T.GuildForum, overwrites: HIDDEN });
    expect(overrideTarget(world([forum]), forum, SETTINGS)?.after.deny).toBe(DENY_MASK);
  });

  test("a posting channel gets exactly the posting bits it lacks, and never the mask", () => {
    // TaruBot's own entry also denies Connect (an admin's choice), which stays: only History
    // would ever be lifted.
    const ledger = ch("701", {
      overwrites: [
        ow(GUILD, 0, 0n, P.ViewChannel | P.EmbedLinks),
        MEMBERS,
        ow(BOT, 1, 0n, P.Connect),
      ],
    });
    expect(overrideTarget(world([ledger]), ledger, SETTINGS)).toMatchObject({
      posting: true,
      after: { allow: P.ViewChannel | P.EmbedLinks, deny: P.Connect },
      granted: P.ViewChannel | P.EmbedLinks,
      masked: 0n,
      cleared: 0n,
    });
  });

  test("a kept review channel (applications off) gets View only, no mask", () => {
    const closed = settings({ guest_applications_enabled: false });
    const reviews = ch("703", { overwrites: HIDDEN });
    expect(overrideTarget(world([reviews]), reviews, closed)).toMatchObject({
      posting: false,
      after: { allow: P.ViewChannel, deny: 0n },
    });
  });

  test("synced children copy their category's planned entry; an unsynced one gets its own", () => {
    // The category also keeps Embed Links from @everyone.
    const quiet = [ow(GUILD, 0, 0n, P.ViewChannel | P.EmbedLinks), MEMBERS];
    const category = ch("730", { type: T.GuildCategory, overwrites: quiet, position: 1 });
    const text = ch("731", { parent: "730", overwrites: quiet });
    const voice = ch("732", { parent: "730", type: T.GuildVoice, overwrites: quiet, position: 1 });
    const own = ch("733", {
      parent: "730",
      overwrites: [PRIVATE, ow("202", 0, P.ViewChannel)],
      position: 2,
    });
    const top = ch("720", { overwrites: HIDDEN });
    const guild = world([own, voice, text, top, category]);
    const plan = planOverrides(guild, SETTINGS);
    // Categories first, then channels in display order (top level, then each category's).
    expect(plan.map((target) => target.channelId)).toEqual(["730", "720", "731", "732", "733"]);
    const byId = Object.fromEntries(plan.map((target) => [target.channelId, target]));
    expect(byId["730"]?.after).toEqual({ allow: P.ViewChannel, deny: VOICE_DENY_MASK });
    for (const id of ["731", "732"])
      expect(byId[id]).toMatchObject({
        inherited: true,
        unsyncs: false,
        after: byId["730"]?.after,
      });
    expect(byId["733"]).toMatchObject({
      inherited: false,
      unsyncs: false,
      after: { allow: P.ViewChannel, deny: DENY_MASK },
    });
  });

  test("a configured child synced with a category TaruBot sees gets its own write and unsyncs", () => {
    // TaruBot sees the category, but its @everyone entry denies Embed Links, which the ledger needs.
    const noEmbeds = [ow(GUILD, 0, 0n, P.EmbedLinks)];
    const category = ch("740", { type: T.GuildCategory, overwrites: noEmbeds });
    const ledger = ch("701", { parent: "740", overwrites: noEmbeds });
    expect(planOverrides(world([category, ledger]), SETTINGS)).toMatchObject([
      {
        channelId: "701",
        inherited: false,
        unsyncs: true,
        after: { allow: P.EmbedLinks, deny: 0n },
      },
    ]);
  });

  test("a configured child whose write equals its category's stays synced all the same", () => {
    const noEmbeds = [ow(GUILD, 0, 0n, P.EmbedLinks)];
    const category = ch("740", { type: T.GuildCategory, overwrites: noEmbeds });
    const ledger = ch("701", { parent: "740", overwrites: noEmbeds });
    const inherit = {
      parentId: "740",
      parentBefore: noEmbeds,
      parentAfter: { allow: P.EmbedLinks, deny: 0n },
    };
    // A configured channel never copies an entry, but one equal to its own keeps it synced.
    expect(overrideTarget(world([category, ledger]), ledger, SETTINGS, inherit)).toMatchObject({
      inherited: false,
      unsyncs: false,
      after: inherit.parentAfter,
    });
  });

  test("a synced text child of a masked category copies its entry exactly, Connect included", () => {
    const category = ch("730", { type: T.GuildCategory, overwrites: HIDDEN });
    const text = ch("731", { parent: "730", overwrites: HIDDEN });
    const guild = world([category, text]);
    const [planned, child] = planOverrides(guild, SETTINGS);
    expect(planned?.after).toEqual({ allow: P.ViewChannel, deny: VOICE_DENY_MASK });
    expect(child).toMatchObject({ channelId: "731", inherited: true, after: planned?.after });
    // Without the category's plan it would have had the text mask, and lost its sync.
    expect(overrideTarget(guild, text, SETTINGS)).toMatchObject({
      after: { allow: P.ViewChannel, deny: DENY_MASK },
      unsyncs: true,
    });
  });

  test("sameOverwriteSet ignores order but not empty entries, types or bits", () => {
    const a = [ow("1", 0, 1n), ow("2", 1, 0n, 4n)];
    expect(sameOverwriteSet(a, [...a].reverse(), GUILD)).toBe(true);
    expect(sameOverwriteSet(a, [...a, ow("3", 0)], GUILD)).toBe(false);
    expect(sameOverwriteSet(a, [ow("1", 1, 1n), ow("2", 1, 0n, 4n)], GUILD)).toBe(false);
    expect(sameOverwriteSet(a, [ow("1", 0, 1n), ow("2", 1, 0n, 5n)], GUILD)).toBe(false);
    expect(sameOverwriteSet([{ ...ow("1", 0), allow: "01" }], [ow("1", 0, 1n)], GUILD)).toBe(true);
  });

  test("sameOverwriteSet counts an empty @everyone entry as none, as discord.js's permissionsLocked does", () => {
    const a = [ow("201", 0, P.ViewChannel)];
    // On either side, and on both; only @everyone's (the guild ID's) entry, and only with no bits.
    expect(sameOverwriteSet(a, [...a, ow(GUILD, 0)], GUILD)).toBe(true);
    expect(sameOverwriteSet([ow(GUILD, 0), ...a], a, GUILD)).toBe(true);
    expect(sameOverwriteSet([ow(GUILD, 0), ...a], [...a, ow(GUILD, 0)], GUILD)).toBe(true);
    expect(sameOverwriteSet(a, [...a, ow(GUILD, 0, 0n, P.EmbedLinks)], GUILD)).toBe(false);
    expect(sameOverwriteSet(a, [...a, ow("500", 0)], GUILD)).toBe(false);
  });

  test("a child that differs from its category only by an empty @everyone entry is synced", () => {
    // Private without an @everyone deny: another role TaruBot holds (500) denies View Channel.
    const staff = ow("500", 0, 0n, P.ViewChannel);
    // Both directions: the category holds the empty entry, or the child does.
    for (const [categoryOverwrites, childOverwrites] of [
      [[ow(GUILD, 0), staff], [staff]],
      [[staff], [ow(GUILD, 0), staff]],
    ] as const) {
      const category = ch("800", { type: T.GuildCategory, overwrites: categoryOverwrites });
      const child = ch("801", { parent: "800", overwrites: childOverwrites });
      const guild = world([category, child], { botRoles: [BOT_ROLE, "500"] });
      expect(channelState(guild, child, SETTINGS)).toBe("missing");
      const [planned, copy] = planOverrides(guild, SETTINGS);
      expect(planned).toMatchObject({ channelId: "800", after: { deny: VOICE_DENY_MASK } });
      // It copies the category's voice mask and stays synced, instead of its own text mask.
      expect(copy).toMatchObject({
        channelId: "801",
        inherited: true,
        unsyncs: false,
        after: planned?.after,
      });
      const [after800, after801] = applied(guild, [planned, copy] as OverrideTarget[]).channels;
      expect(sameOverwriteSet(after801?.overwrites ?? [], after800?.overwrites ?? [], GUILD)).toBe(
        true,
      );
    }
  });
});

describe("resuming an interrupted run", () => {
  /**
   * A private category's and its synced child's overwrites before any run (with the Member role's
   * allow, so neither looks like obfuscation's synthetic shape).
   */
  const DENY_EVERYONE = HIDDEN;
  /** The entry a /setup overrides category write leaves: View, and the whole voice mask. */
  const E = ow(BOT, 1, P.ViewChannel, VOICE_DENY_MASK);
  /** Category 3000 (with `categoryEntry` added to its overwrites) and child 3001. */
  const resumeWorld = (categoryEntry: ApiOverwrite | null, child: readonly ApiOverwrite[]) =>
    world([
      ch("3000", {
        type: T.GuildCategory,
        overwrites: categoryEntry ? [...DENY_EVERYONE, categoryEntry] : DENY_EVERYONE,
      }),
      ch("3001", { parent: "3000", overwrites: child }),
    ]);
  /** No setting names either channel. */
  const nothing = settings({
    ledger_channel_id: null,
    officer_notifications_channel_id: null,
    guest_application_channel_id: null,
  });
  const categoryOf = (guild: VisibilityGuild) => guild.channels[0] as VisibilityChannel;

  test("the probe: a synced child of a category an earlier run wrote copies its entry", () => {
    // A complete run would have written the category and copied E into the child.
    const complete = planOverrides(resumeWorld(null, DENY_EVERYONE), nothing);
    expect(complete.map((target) => [target.channelId, target.after, target.inherited])).toEqual([
      ["3000", { allow: P.ViewChannel, deny: VOICE_DENY_MASK }, false],
      ["3001", { allow: P.ViewChannel, deny: VOICE_DENY_MASK }, true],
    ]);
    // The run stopped after the category's write: the rerun resumes it.
    const guild = resumeWorld(E, DENY_EVERYONE);
    expect(resumeInherit(guild, categoryOf(guild), nothing)).toEqual({
      parentId: "3000",
      parentBefore: DENY_EVERYONE,
      parentAfter: { allow: P.ViewChannel, deny: VOICE_DENY_MASK },
    });
    const plan = planOverrides(guild, nothing);
    expect(plan).toEqual([
      {
        channelId: "3001",
        kind: "channel",
        posting: false,
        before: null,
        after: { allow: P.ViewChannel, deny: VOICE_DENY_MASK },
        granted: P.ViewChannel,
        masked: VOICE_DENY_MASK,
        cleared: 0n,
        inherited: true,
        unsyncs: false,
      },
    ]);
    const [category, child] = applied(guild, plan).channels;
    expect(sameOverwriteSet(child?.overwrites ?? [], category?.overwrites ?? [], GUILD)).toBe(true);
  });

  test("a configured child in the same place gets its own write and is listed as unsynced", () => {
    const guild = resumeWorld(E, DENY_EVERYONE);
    const ledger = settings({ ledger_channel_id: "3001", officer_notifications_channel_id: null });
    expect(planOverrides(guild, ledger)).toMatchObject([
      {
        channelId: "3001",
        inherited: false,
        unsyncs: true,
        after: { allow: P.ViewChannel, deny: 0n },
      },
    ]);
  });

  test("a configured channel set later in a category a complete run masked unsyncs", () => {
    // Both carry E: the run finished, and the child copied it. Then an officer chose the child
    // as the ledger: it gets its own write, which lifts only the History deny (and, as a posting
    // channel, allows it), and is listed as unsynced.
    const guild = resumeWorld(E, [...DENY_EVERYONE, E]);
    expect(resumeInherit(guild, categoryOf(guild), nothing)).not.toBeNull();
    const ledger = settings({ ledger_channel_id: "3001", officer_notifications_channel_id: null });
    expect(planOverrides(guild, ledger)).toMatchObject([
      {
        channelId: "3001",
        inherited: false,
        unsyncs: true,
        after: {
          allow: P.ViewChannel | P.ReadMessageHistory,
          deny: VOICE_DENY_MASK & ~P.ReadMessageHistory,
        },
        granted: P.ReadMessageHistory,
        cleared: P.ReadMessageHistory,
      },
    ]);
    // Unconfigured, it is simply visible and synced: nothing to do.
    expect(planOverrides(guild, nothing)).toEqual([]);
  });

  test("a child with its own TaruBot entry, or another difference, doesn't inherit", () => {
    const ownEntry = resumeWorld(E, [...DENY_EVERYONE, ow(BOT, 1, P.AttachFiles)]);
    expect(planOverrides(ownEntry, nothing)).toMatchObject([
      {
        channelId: "3001",
        inherited: false,
        after: { allow: P.ViewChannel | P.AttachFiles, deny: DENY_MASK },
      },
    ]);
    const differs = resumeWorld(E, [...DENY_EVERYONE, ow("500", 0, 0n, P.SendMessages)]);
    expect(planOverrides(differs, nothing)).toMatchObject([
      { channelId: "3001", inherited: false, after: { allow: P.ViewChannel, deny: DENY_MASK } },
    ]);
  });

  test("an admin's entry without the whole mask is never copied", () => {
    // View only: an admin wrote it, so the child gets its own masked write instead.
    const guild = resumeWorld(ow(BOT, 1, P.ViewChannel), DENY_EVERYONE);
    expect(resumeInherit(guild, categoryOf(guild), nothing)).toBeNull();
    expect(planOverrides(guild, nothing)).toMatchObject([
      {
        channelId: "3001",
        inherited: false,
        unsyncs: false,
        after: { allow: P.ViewChannel, deny: DENY_MASK },
      },
    ]);
    // Short of one mask bit (Connect), it is not a /setup overrides category write either.
    const partial = resumeWorld(ow(BOT, 1, P.ViewChannel, DENY_MASK), DENY_EVERYONE);
    expect(resumeInherit(partial, categoryOf(partial), nothing)).toBeNull();
  });

  test("a category hidden on purpose, or a channel that isn't a category, resumes nothing", () => {
    const hidden = resumeWorld(ow(BOT, 1, 0n, P.ViewChannel | VOICE_DENY_MASK), DENY_EVERYONE);
    expect(resumeInherit(hidden, categoryOf(hidden), nothing)).toBeNull();
    const guild = resumeWorld(E, DENY_EVERYONE);
    expect(resumeInherit(guild, { ...categoryOf(guild), type: T.GuildText }, nothing)).toBeNull();
  });
});

/** A small deterministic PRNG (mulberry32), so a failing seed reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (max: number) => Math.floor(next() * max),
    pick: <V>(values: readonly V[]): V => values[Math.floor(next() * values.length)] as V,
  };
}

/** Bits a generated TaruBot entry may carry. */
const ENTRY_BITS = [
  0n,
  P.ViewChannel,
  P.AttachFiles,
  P.ReadMessageHistory,
  P.Connect,
  P.CreateInstantInvite,
  P.ManageRoles,
  P.SendMessages,
];

/**
 * A category's overwrites with an empty @everyone entry taken away or added, which a synced child
 * may differ by (discord.js's permissionsLocked, and so sameOverwriteSet, still call it synced).
 */
function toggledEmpty(list: readonly ApiOverwrite[]): ApiOverwrite[] {
  const empty = list.find(
    (entry) => entry.id === GUILD && BigInt(entry.allow) === 0n && BigInt(entry.deny) === 0n,
  );
  if (empty) return list.filter((entry) => entry !== empty);
  return list.some((entry) => entry.id === GUILD) ? [...list] : [...list, ow(GUILD, 0)];
}

/** A generated server: categories with synced or own children, top-level channels, settings. */
function generated(seed: number) {
  const r = random(seed);
  let serial = 700;
  const channels: VisibilityChannel[] = [];
  const overwrites = (): ApiOverwrite[] => {
    const list: ApiOverwrite[] = [];
    // @everyone's entry: usually the private channel's View deny; without one, sometimes an entry
    // with no bits (which a synced child may lack, or add: toggledEmpty).
    if (r.chance(0.6))
      list.push(ow(GUILD, 0, 0n, r.pick([P.ViewChannel, P.ViewChannel, P.EmbedLinks])));
    else if (r.chance(0.2)) list.push(ow(GUILD, 0));
    if (r.chance(0.5)) list.push(ow("201", 0, P.ViewChannel));
    if (r.chance(0.2)) list.push(ow("500", 0, 0n, P.ViewChannel));
    if (r.chance(0.08)) list.push(ow(BOT_ROLE, 0, 0n, P.ViewChannel));
    if (r.chance(0.3))
      list.push(ow(BOT, 1, r.pick(ENTRY_BITS), r.pick(ENTRY_BITS) | r.pick(ENTRY_BITS)));
    return list;
  };
  const one = (options: Partial<VisibilityChannel>) => {
    const id = String(++serial);
    const obfuscated = r.chance(0.05);
    const channel = ch(id, { position: r.int(4), overwrites: overwrites(), ...options });
    // An obfuscated entry only ever carries the synthetic overwrite.
    if (obfuscated) Object.assign(channel, { obfuscated, overwrites: SYNTHETIC });
    channels.push(channel);
    return channel;
  };
  const types = [T.GuildText, T.GuildText, T.GuildVoice, T.GuildStageVoice, T.GuildForum];
  for (let index = r.int(3); index > 0; index--) one({ type: r.pick(types) });
  for (let index = r.int(4); index > 0; index--) {
    const category = one({ type: T.GuildCategory });
    for (let child = r.int(5); child > 0; child--)
      one({
        type: r.pick(types),
        parentId: category.id,
        ...(r.chance(0.6) && !category.obfuscated
          ? {
              overwrites: r.chance(0.2) ? toggledEmpty(category.overwrites) : category.overwrites,
            }
          : {}),
      });
  }
  // Sometimes a role-gated category: private through role 500's deny, which TaruBot then holds,
  // with or without an empty @everyone entry, its children synced to it or differing from it only
  // by that entry (still synced, as discord.js's permissionsLocked reads it).
  const gated = r.chance(0.4);
  if (gated) {
    const deny = ow("500", 0, 0n, P.ViewChannel);
    const category = one({
      type: T.GuildCategory,
      overwrites: r.chance(0.5) ? [ow(GUILD, 0), deny] : [deny],
    });
    for (let child = r.int(4) + 1; child > 0; child--)
      one({
        type: r.pick(types),
        parentId: category.id,
        ...(category.obfuscated
          ? {}
          : {
              overwrites: r.chance(0.5) ? toggledEmpty(category.overwrites) : category.overwrites,
            }),
      });
  }
  const ids = channels.filter((channel) => channel.type === T.GuildText).map((c) => c.id);
  // Each setting names a text channel about a third of the time: enough for private categories
  // to appear, while most categories hold no configured channel and are planned.
  const maybe = () => (ids.length > 0 && r.chance(0.35) ? r.pick(ids) : null);
  const config: VisibilityConfig = {
    ...CONFIG,
    ledger_channel_id: maybe(),
    officer_notifications_channel_id: maybe(),
    changelog_channel_id: maybe(),
    guest_application_channel_id: maybe(),
    guest_applications_enabled: r.chance(0.5),
  };
  const records: VisibilityRecords = {
    ...NO_RECORDS,
    pendingReviewChannels: r.chance(0.2) && ids.length > 0 ? [r.pick(ids)] : [],
    recordedHidden: channels.filter(() => r.chance(0.1)).map((channel) => channel.id),
  };
  const botRoles = gated || r.chance(0.3) ? [BOT_ROLE, "500"] : [BOT_ROLE];
  const admin = r.chance(0.5) ? P.Administrator : 0n;
  return {
    r,
    guild: world(channels, { roles: ROLES(CORE | admin), botRoles }),
    settings: visibilitySettings(config, records),
  };
}

/**
 * The invariant once every planned write has landed (§2): nothing masked, the deliberate denies
 * and private categories unchanged, only unreadable entries still missing, nothing left to plan,
 * and every synced child still synced unless it is configured and a run listed it as unsyncing,
 * or it is one of `excused` (see the interrupted-run property).
 */
function expectSettled(
  seed: number,
  original: VisibilityGuild,
  s: VisibilitySettings,
  result: VisibilityGuild,
  unsynced: ReadonlySet<string>,
  excused: ReadonlySet<string> = new Set(),
) {
  const before = analyseVisibility(original, s);
  const after = analyseVisibility(result, s);
  const context = { seed };
  expect({ ...context, masked: after.masked }).toEqual({ ...context, masked: [] });
  expect({ ...context, denied: after.denied }).toEqual({ ...context, denied: before.denied });
  expect({ ...context, private: after.privateCategories }).toEqual({
    ...context,
    private: before.privateCategories,
  });
  const missing = [...after.missing.categories, ...after.missing.inside, ...after.missing.channels];
  expect({ ...context, missing: missing.sort() }).toEqual({
    ...context,
    missing: [...after.missing.unreadable].sort(),
  });
  const held = after.privateCategories.reduce((sum, entry) => sum + 1 + entry.inside.length, 0);
  expect({ ...context, count: after.missingCount }).toEqual({
    ...context,
    count: after.missing.unreadable.length + after.denied.length + held,
  });
  expect({ ...context, again: planOverrides(result, s).length }).toEqual({ ...context, again: 0 });
  const now = (id: string) => result.channels.find((candidate) => candidate.id === id);
  for (const child of original.channels) {
    const parent = original.channels.find((candidate) => candidate.id === child.parentId);
    if (!parent || !sameOverwriteSet(child.overwrites, parent.overwrites, original.guildId))
      continue;
    if (excused.has(child.id)) continue;
    if (unsynced.has(child.id)) {
      // Only a configured channel is ever written apart from its category.
      expect({ ...context, child: child.id, configured: s.configured.includes(child.id) }).toEqual({
        ...context,
        child: child.id,
        configured: true,
      });
      continue;
    }
    expect({
      ...context,
      child: child.id,
      synced: sameOverwriteSet(
        now(child.id)?.overwrites ?? [],
        now(parent.id)?.overwrites ?? [],
        result.guildId,
      ),
    }).toEqual({ ...context, child: child.id, synced: true });
  }
}

/** The IDs a plan lists as unsyncing. */
const unsyncing = (plan: readonly OverrideTarget[]) =>
  plan.filter((target) => target.unsyncs).map((target) => target.channelId);

test("property: the plan leaves only unreadable entries, denies and private categories, and keeps sync", () => {
  let planned = 0;
  let inherited = 0;
  let privates = 0;
  // Inherited children that differ from their category by an empty @everyone entry: a strict
  // comparison (a guild ID matching no entry) calls them unsynced.
  let emptyOnly = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { guild, settings: s } = generated(seed);
    const plan = planOverrides(guild, s);
    planned += plan.length;
    inherited += plan.filter((target) => target.inherited).length;
    for (const target of plan.filter((entry) => entry.inherited)) {
      const child = guild.channels.find((channel) => channel.id === target.channelId);
      const parent = guild.channels.find((channel) => channel.id === child?.parentId);
      if (child && parent && !sameOverwriteSet(child.overwrites, parent.overwrites, "none"))
        emptyOnly += 1;
    }
    privates += analyseVisibility(guild, s).privateCategories.length;
    expectSettled(seed, guild, s, applied(guild, plan), new Set(unsyncing(plan)));
  }
  // The generator really exercises the planner, inheritance and private categories included.
  expect(planned).toBeGreaterThan(400);
  expect(inherited).toBeGreaterThan(20);
  expect(privates).toBeGreaterThan(10);
  expect(emptyOnly).toBeGreaterThan(10);
});

/**
 * An interrupted run (§2, r2-final): the plan is cut at a random write, the prefix lands without
 * propagation, and a rerun plans and finishes on the result. The resume rule lends a category's
 * /setup overrides entry E to a child that equals the category without E, so one exception is
 * left by design: a synced child of a category that already carried a TaruBot member entry of
 * its own before the first run. The child carries that entry too, so it equals the category
 * without E only if Discord propagated the write; the rerun can't tell its entry from one an
 * admin wrote, and the spec says a child with its own TaruBot entry never inherits. Only those
 * children, cut between their category's write and their own, are excused from the sync check,
 * and the test counts them to show the rule is narrow.
 */
test("property: a run stopped at any write and finished by a rerun settles the same way", () => {
  let between = 0;
  let excusedTotal = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const { r, guild, settings: s } = generated(seed);
    const first = planOverrides(guild, s);
    // Categories come first, so some cuts fall between a category's write and its children's.
    const cut = r.int(first.length + 1);
    const done = first.slice(0, cut);
    const written = new Set(
      done.filter((target) => target.kind === "category").map((target) => target.channelId),
    );
    const channel = (id: string) => guild.channels.find((c) => c.id === id);
    const pending = first
      .slice(cut)
      .filter((t) => written.has(channel(t.channelId)?.parentId ?? ""));
    if (pending.length > 0) between += 1;
    const excused = new Set(
      pending
        .filter((target) => target.inherited)
        .filter((target) => {
          const parent = channel(channel(target.channelId)?.parentId ?? "");
          return parent?.overwrites.some((entry) => entry.type === 1 && entry.id === BOT) ?? false;
        })
        .map((target) => target.channelId),
    );
    excusedTotal += excused.size;
    const stopped = applied(guild, done);
    const second = planOverrides(stopped, s);
    const result = applied(stopped, second);
    const unsynced = new Set([...unsyncing(first), ...unsyncing(second)]);
    expectSettled(seed, guild, s, result, unsynced, excused);
    expect({ seed, third: planOverrides(result, s).length }).toEqual({ seed, third: 0 });
  }
  expect(between).toBeGreaterThan(20);
  // The exception stays the rare one: most interrupted categories resume their children.
  expect(excusedTotal).toBeLessThan(between);
});
