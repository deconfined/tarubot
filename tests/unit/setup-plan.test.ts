/**
 * The pure pieces /setup onboarding's dry run is assembled from (2.35.0, #46): the role decisions
 * ensureRole would make, the distinctness refusal, the stand-ins for roles to be created, the
 * audience classification remember() would record, the channels onboarding's first pass would
 * change, and how refusals become blockers (every Failure collected, anything else thrown).
 */
import { describe, expect, test } from "bun:test";
import { ChannelType, OverwriteType, PermissionFlagsBits as P } from "discord.js";
import {
  addBlocker,
  blockerOf,
  collected,
  duplicateRoles,
  onboardingChanges,
  plannedAudiences,
  plannedBindings,
  roleAction,
  type SetupBlocker,
  type SetupRolePlan,
} from "../../src/application/setup-plan.js";
import {
  type AccessChannel,
  type AccessSnapshot,
  channelAccessOverwrites,
} from "../../src/domain/channel-access.js";
import { Failure } from "../../src/domain/values.js";

describe("role decisions", () => {
  const roles = [
    { id: "11", name: "EXFC Member" },
    { id: "12", name: "Guest" },
    { id: "13", name: "Officer" },
    { id: "14", name: "Officer" },
  ];

  test("reuse a configured or same-named role, rename a prefixed one, or create", () => {
    expect(roleAction(roles, "EXFC Member", "Member", null)).toEqual({ action: "reuse", id: "11" });
    // The canonical label under the new prefix: reused and renamed, as ensureRole does.
    expect(roleAction(roles, "EXFC Guest", "Guest", null)).toEqual({ action: "rename", id: "12" });
    expect(roleAction(roles, "EXFC FC Leader", "FC Leader", null)).toEqual({
      action: "create",
      id: null,
    });
    // A configured role is reused whatever its name.
    expect(roleAction(roles, "EXFC Officer", "Officer", "13")).toEqual({
      action: "rename",
      id: "13",
    });
  });

  test("two same-named roles are ambiguous, thrown for the caller to collect", () => {
    expect(() => roleAction(roles, "Officer", "Officer", null)).toThrow(
      "Several roles are named Officer. Choose the one to use with /config roles, then run /setup onboarding again.",
    );
  });

  test("two reused roles that are the same role are refused as the real run would", () => {
    const plan = (ids: (string | null)[]): SetupRolePlan[] =>
      (["member_role_id", "guest_role_id", "officer_role_id", "leader_role_id"] as const).map(
        (field, index) => ({
          field,
          name: field,
          action: ids[index] ? "reuse" : "create",
          id: ids[index] ?? null,
        }),
      );
    expect(duplicateRoles(plan(["1", "2", null, null]))).toBeNull();
    expect(duplicateRoles(plan(["1", "1", null, null]))?.message).toBe(
      "Member, Guest, Officer and FC Leader must be four different roles.",
    );
  });

  test("roles to be created get stand-ins that match no real role", () => {
    const bindings = plannedBindings([
      { field: "member_role_id", name: "Member", action: "reuse", id: "11" },
      { field: "officer_role_id", name: "Officer", action: "create", id: null },
    ]);
    expect(bindings.member).toBe("11");
    for (const id of [bindings.guest, bindings.officer, bindings.leader])
      expect(id).not.toMatch(/^\d+$/u);
    expect(new Set(Object.values(bindings)).size).toBe(4);
  });
});

/** A managed channel as the snapshot holds it. */
const channel = (id: string, overrides: Partial<AccessChannel> = {}): AccessChannel => ({
  id,
  name: id,
  type: ChannelType.GuildText,
  parentId: null,
  overwrites: [],
  everyoneVisible: true,
  memberVisible: true,
  guestVisible: true,
  ...overrides,
});

/** A snapshot of `channels`, with @everyone holding View Channel. */
const snapshot = (channels: AccessChannel[], preserve = false): AccessSnapshot => ({
  botId: "900",
  everyonePermissions: String(P.ViewChannel | P.SendMessages),
  excludedChannelIds: [],
  preserveEveryoneView: preserve,
  channels,
});

describe("onboarding's first pass", () => {
  const privateArea = [
    { id: "100", type: OverwriteType.Role, allow: "0", deny: String(P.ViewChannel) },
  ];

  test("audiences follow remember(): rooms by ID, stored policies, then privacy evidence", () => {
    const view = snapshot([
      channel("1"),
      channel("2", { everyoneVisible: false, memberVisible: false, guestVisible: false }),
      channel("3", {
        type: ChannelType.GuildCategory,
        everyoneVisible: false,
        memberVisible: false,
        guestVisible: false,
        overwrites: privateArea,
      }),
      channel("4", { parentId: "3" }),
      channel("5"),
    ]);
    const audiences = plannedAudiences(view, "1", "2", new Map([["5", true]]), false);
    expect(Object.fromEntries(audiences)).toEqual({
      "1": "lobby",
      "2": "officers",
      // A private category is staff-only, and so is a child of one.
      "3": "officers",
      "4": "officers",
      // A stored decision wins.
      "5": "officers",
    });
    // Already on: a newly seen public channel stays for members.
    expect(plannedAudiences(snapshot([channel("6")]), null, null, new Map(), true).get("6")).toBe(
      "members",
    );
  });

  test("roles to be created make every managed channel change; reused ones only where needed", () => {
    const bindings = { member: "11", guest: "12", officer: "13", leader: "14" };
    const settled = channel("7", {
      overwrites: channelAccessOverwrites([], "100", "900", bindings, "members"),
    });
    const view = snapshot([channel("1"), settled]);
    const audiences = new Map([
      ["1", "members" as const],
      ["7", "members" as const],
    ]);
    // With the real roles, the channel onboarding already wrote doesn't change.
    expect(onboardingChanges(view, bindings, audiences, "100").channels).toEqual(["1"]);
    // With a role still to be created, its entries are new everywhere.
    const planned = plannedBindings([
      { field: "member_role_id", name: "Member", action: "reuse", id: "11" },
      { field: "guest_role_id", name: "Guest", action: "reuse", id: "12" },
      { field: "officer_role_id", name: "Officer", action: "create", id: null },
      { field: "leader_role_id", name: "FC Leader", action: "reuse", id: "14" },
    ]);
    expect(onboardingChanges(view, planned, audiences, "100").channels).toEqual(["1", "7"]);
  });

  test("@everyone loses View Channel unless an excluded area keeps it", () => {
    const bindings = { member: "11", guest: "12", officer: "13", leader: "14" };
    expect(onboardingChanges(snapshot([]), bindings, new Map(), "100").everyoneLosesView).toBe(
      true,
    );
    expect(
      onboardingChanges(snapshot([], true), bindings, new Map(), "100").everyoneLosesView,
    ).toBe(false);
    const closed = { ...snapshot([]), everyonePermissions: String(P.SendMessages) };
    expect(onboardingChanges(closed, bindings, new Map(), "100").everyoneLosesView).toBe(false);
  });
});

describe("blockers", () => {
  test("a Failure becomes its code, message and detail", () => {
    const failure = new Failure("blocked", "No.", 0, {
      kind: "resource",
      resource: "channel",
      id: "1",
    });
    expect(blockerOf(failure)).toEqual({
      code: "blocked",
      message: "No.",
      detail: { kind: "resource", resource: "channel", id: "1" },
    });
    expect(blockerOf(new Failure("input", "Bad."))).toEqual({ code: "input", message: "Bad." });
  });

  test("the same refusal is listed once; different ones each", () => {
    const blockers: SetupBlocker[] = [];
    addBlocker(blockers, { code: "blocked", message: "A." });
    addBlocker(blockers, { code: "blocked", message: "A." });
    addBlocker(blockers, { code: "blocked", message: "B." });
    expect(blockers.map((blocker) => blocker.message)).toEqual(["A.", "B."]);
  });

  test("collected turns a Failure into a blocker and carries on; anything else is thrown", async () => {
    const blockers: SetupBlocker[] = [];
    expect(await collected(blockers, async () => 7)).toBe(7);
    expect(
      await collected(blockers, () => {
        throw new Failure("blocked", "Refused.");
      }),
    ).toBeUndefined();
    expect(blockers).toEqual([{ code: "blocked", message: "Refused." }]);
    const bug = new TypeError("bug");
    await expect(
      collected(blockers, () => {
        throw bug;
      }),
    ).rejects.toBe(bug);
  });
});
