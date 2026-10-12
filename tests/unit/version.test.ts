/**
 * The installed version stays visible, and /version output follows the approved card (guests#54
 * with its gen.py rewrites): '· ✓ verified' replaces the ✅ emoji on verified commits, the footer
 * explains the marker or says when a failed read is retried, colors follow the state, and the
 * embed stays within Discord's bounds for ten hostile commit titles.
 */
import { expect, test } from "bun:test";
import { ApplicationCommandOptionType } from "discord.js";
import { VersionInformation } from "../../src/application/version-information.js";
import versionCommand from "../../src/commands/utility/version.command.js";
import { project } from "../../src/config/project.js";
import { versionReply } from "../../src/discord/presenters/version.js";
import { GitHubHistory } from "../../src/infrastructure/github/client.js";
import { expectHouseStyle, visibleText } from "../fixtures/replies.js";

/** Emoji Discord would render as pictures; the text markers never use one. */
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

test("version is available to ordinary users and offers a bounded optional commit count", () => {
  const definition = versionCommand.toJSON();
  // No router permission: any human member of the server (2.44.0).
  expect(versionCommand.permissions).toEqual([]);
  expect(definition.default_member_permissions).toBeUndefined();
  expect(definition.options).toEqual([
    expect.objectContaining({
      type: ApplicationCommandOptionType.Integer,
      name: "commits",
      min_value: 1,
      max_value: 10,
    }),
  ]);
  expect(definition.options?.[0]?.required).not.toBe(true);
  expect(project.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
});

test("version output links commit IDs, marks only verified signatures, and fits Discord limits", async () => {
  const source = new GitHubHistory(async () =>
    Response.json(
      Array.from({ length: 10 }, (_, index) => ({
        sha: String(index).repeat(40),
        commit: {
          message: "_*😀".repeat(1000),
          verification: {
            verified: index === 0,
            reason: index === 0 ? "valid" : "unsigned",
            signature: index === 0 ? "signature" : null,
          },
        },
      })),
    ),
  );
  const report = await new VersionInformation(source).get(10);
  const presented = versionReply(report);
  const embed = expectHouseStyle(presented, { tone: "info", timestamp: true });
  expect(embed.title).toBe(`TaruBot v${project.version}`);
  expect(embed.url).toBe(project.url);
  expect(embed.description).toContain(`[Source code](${project.url})`);
  expect(embed.description).toContain(`[${project.license}](${project.url}/blob/main/LICENSE)`);
  expect(embed.description).toStartWith(
    `Latest 10 commits on [${project.repository}](${project.url}) · \`main\``,
  );
  expect(embed.fields).toHaveLength(10);
  expect(embed.fields?.[0]?.value).toBe(
    `[0000000](${project.url}/commit/${"0".repeat(40)}) · ✓ verified`,
  );
  expect(embed.fields?.slice(1).every((field) => !field.value.includes("verified"))).toBe(true);
  expect(
    embed.fields?.every((field) => field.name.length <= 100 && field.value.length <= 1024),
  ).toBe(true);
  expect(embed.footer?.text).toBe(
    "✓ verified = GitHub-verified signature · History cached up to 5 minutes",
  );
  expect(embed.timestamp).toBe(new Date(report.checkedAt).toISOString());
  // The markers are plain text: only the commit titles themselves may carry emoji.
  expect(PICTOGRAPHIC.test(embed.footer?.text ?? "")).toBe(false);
  expect(embed.fields?.some((field) => PICTOGRAPHIC.test(field.value))).toBe(false);
  expect(visibleText(presented)).not.toContain("✅");
  expect(presented.options.allowedMentions).toEqual({ parse: [] });
});

test("GitHub outages leave the installed version visible, in warning, without inventing history", async () => {
  const service = new VersionInformation(
    new GitHubHistory(async () => {
      throw new Error("offline");
    }),
  );
  const embed = expectHouseStyle(versionReply(await service.get()), {
    tone: "warning",
    timestamp: true,
  });
  expect(embed.title).toBe(`TaruBot v${project.version}`);
  expect(embed.description).toStartWith(
    "GitHub commit history is temporarily unavailable. Please try again shortly.\n\n[Source code]",
  );
  expect(embed.fields ?? []).toEqual([]);
  expect(embed.footer?.text).toBe("History retried after 1 minute");
});

test("an empty history is neutral and drops the verified legend", async () => {
  const service = new VersionInformation(new GitHubHistory(async () => Response.json([])));
  const embed = expectHouseStyle(versionReply(await service.get()), {
    tone: "neutral",
    timestamp: true,
  });
  expect(embed.description).toStartWith("No commits are available from the GitHub repository.");
  expect(embed.footer?.text).toBe("History cached up to 5 minutes");
});
