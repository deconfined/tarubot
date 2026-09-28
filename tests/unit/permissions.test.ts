/**
 * TaruBot's permission catalog (2.35.0, #46): every total is pinned, so a catalog edit that
 * changes what the add-to-server page recommends, what a posting channel needs or what the deny
 * mask writes fails here first. Also the labels replies use, catalog order, and that the
 * inspection module still hands out the same arithmetic it moved here.
 */
import { describe, expect, test } from "bun:test";
import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import * as inspection from "../../src/discord/inspection.js";
import {
  ascendingRoles,
  CORE_PERMISSIONS,
  channelPermissions,
  DENY_MASK,
  guildPermissions,
  LABELLED_PERMISSIONS,
  NEVER_NEEDED_PERMISSIONS,
  ONBOARDING_PERMISSIONS,
  POSTING_PERMISSIONS,
  type PermissionKey,
  permissionKeys,
  permissionLabel,
  RECOMMENDED_PERMISSIONS,
  VOICE_DENY_MASK,
  VOICE_MASK_TYPES,
} from "../../src/domain/permissions.js";

/** One mask from a catalog's bits. */
const total = (catalog: Readonly<Record<string, bigint>>): bigint =>
  Object.values(catalog).reduce((bits, bit) => bits | bit, 0n);

describe("totals", () => {
  test("each catalog's bits are pinned", () => {
    expect(total(CORE_PERMISSIONS)).toBe(402_770_944n);
    expect(total(ONBOARDING_PERMISSIONS)).toBe(105_227_747_344n);
    expect(total(NEVER_NEEDED_PERMISSIONS)).toBe(1_100_048_637_990n);
    expect(DENY_MASK).toBe(268_501_009n);
    expect(VOICE_DENY_MASK).toBe(269_549_585n);
  });

  test("posting includes View Channel: 84992, not the draft's 83968", () => {
    expect(total(POSTING_PERMISSIONS)).toBe(84_992n);
    expect(total(POSTING_PERMISSIONS) & P.ViewChannel).toBe(P.ViewChannel);
  });

  test("the recommended set is the core seven plus onboarding's five, which don't overlap", () => {
    expect(total(CORE_PERMISSIONS) & total(ONBOARDING_PERMISSIONS)).toBe(0n);
    expect(RECOMMENDED_PERMISSIONS).toBe(total(CORE_PERMISSIONS) | total(ONBOARDING_PERMISSIONS));
    expect(RECOMMENDED_PERMISSIONS).toBe(105_630_518_288n);
    // Administrator is only ever granted for the /setup overrides window, never recommended.
    expect(RECOMMENDED_PERMISSIONS & P.Administrator).toBe(0n);
    // Nothing TaruBot never needs is recommended.
    expect(RECOMMENDED_PERMISSIONS & total(NEVER_NEEDED_PERMISSIONS)).toBe(0n);
  });

  test("the deny mask never touches View Channel or the other posting permissions but History", () => {
    expect(DENY_MASK & P.ViewChannel).toBe(0n);
    expect(DENY_MASK & (P.SendMessages | P.EmbedLinks)).toBe(0n);
    expect(VOICE_DENY_MASK & ~DENY_MASK).toBe(P.Connect);
  });

  test("voice, stage and categories get the voice mask", () => {
    expect([...VOICE_MASK_TYPES].sort((a, b) => a - b)).toEqual([
      ChannelType.GuildVoice,
      ChannelType.GuildCategory,
      ChannelType.GuildStageVoice,
    ]);
  });

  test("every labelled permission carries its own Discord bit", () => {
    for (const [key, bit] of Object.entries(LABELLED_PERMISSIONS))
      expect(bit).toBe(P[key as keyof typeof P]);
    expect(Object.keys(LABELLED_PERMISSIONS)).toContain("Administrator");
    expect(Object.keys(LABELLED_PERMISSIONS)).toContain("CreateInstantInvite");
  });
});

describe("labels", () => {
  test("Manage Roles is Manage Permissions in a channel; the rest read the same everywhere", () => {
    expect(permissionLabel("ManageRoles", "server")).toBe("Manage Roles");
    expect(permissionLabel("ManageRoles", "channel")).toBe("Manage Permissions");
    const pinned: [PermissionKey, string][] = [
      ["ManageGuild", "Manage Server"],
      ["MentionEveryone", "Mention Everyone"],
      ["ModerateMembers", "Time Out Members"],
      ["CreateInstantInvite", "Create Invite"],
      ["UseApplicationCommands", "Use Application Commands"],
      ["CreatePublicThreads", "Create Public Threads"],
      ["CreatePrivateThreads", "Create Private Threads"],
      ["ViewChannel", "View Channel"],
      ["ReadMessageHistory", "Read Message History"],
      ["Administrator", "Administrator"],
    ];
    for (const [key, label] of pinned) {
      expect(permissionLabel(key, "server")).toBe(label);
      expect(permissionLabel(key, "channel")).toBe(label);
    }
  });

  test("every catalogued permission has a label", () => {
    for (const key of Object.keys(LABELLED_PERMISSIONS) as PermissionKey[])
      expect(permissionLabel(key, "server")).toMatch(/^[A-Z][A-Za-z ]+$/u);
  });
});

test("permissionKeys lists the set keys in catalog order, whatever the bit order", () => {
  expect(
    permissionKeys(P.ReadMessageHistory | P.ManageRoles | P.EmbedLinks, CORE_PERMISSIONS),
  ).toEqual(["ManageRoles", "EmbedLinks", "ReadMessageHistory"]);
  expect(permissionKeys(0n, CORE_PERMISSIONS)).toEqual([]);
  // A negated mask (what a caller passes for "missing") works like any other.
  expect(permissionKeys(~P.ViewChannel & total(POSTING_PERMISSIONS), POSTING_PERMISSIONS)).toEqual([
    "SendMessages",
    "EmbedLinks",
    "ReadMessageHistory",
  ]);
});

test("the inspection module re-exports the same arithmetic, and its maps are the catalogs", () => {
  expect(inspection.guildPermissions).toBe(guildPermissions);
  expect(inspection.channelPermissions).toBe(channelPermissions);
  expect(inspection.ascendingRoles).toBe(ascendingRoles);
  expect(inspection.requiredBotPermissions).toBe(CORE_PERMISSIONS);
  expect(inspection.destinationPermissions).toBe(POSTING_PERMISSIONS);
});
