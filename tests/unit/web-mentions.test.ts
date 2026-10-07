import { expect, test } from "bun:test";
import { PermissionsBitField } from "discord.js";
import { parseHTML } from "linkedom";
import { guildNames, mentionText, type WebNames } from "../../src/web/mentions.js";
import { CHANNEL, ROLE } from "../fixtures/replies/configuration.js";
import { HARNESS_GUILDS, harnessGateway } from "../fixtures/web-dev.js";

const USER = "200000000000000002";
const HOSTILE = "<img src=x onerror=alert(1)>‮role";

const documentOf = async (text: string, names: WebNames) =>
  parseHTML(`<html><body>${await mentionText(text, names)}</body></html>`).document;

test("mention grammar resolves names as isolated text, never active markup", async () => {
  const names: WebNames = {
    roles: new Map([[ROLE.guest, HOSTILE]]),
    channels: new Map([[CHANNEL.reviews, HOSTILE]]),
    users: new Map([[USER, HOSTILE]]),
  };
  const document = await documentOf(
    `<@${USER}> <@!${USER}> <@&${ROLE.guest}> <#${CHANNEL.reviews}> channel ${CHANNEL.reviews} <script>bad()</script> <t:1700000000:R>`,
    names,
  );
  expect(document.querySelectorAll("img, script, a")).toHaveLength(0);
  expect([...document.querySelectorAll("[dir=auto]")].map((node) => node.textContent)).toEqual(
    expect.arrayContaining([HOSTILE, `@${HOSTILE}`, `#${HOSTILE}`, " <script>bad()</script> "]),
  );
  expect(document.querySelector("time")?.getAttribute("datetime")).toBe("2023-11-14T22:13:20.000Z");
  expect(document.querySelector("time")?.textContent).toContain("UTC");
});

test("an interaction-restored name cannot expose a channel still denied to TaruBot", async () => {
  const gateway = harnessGateway();
  const guild = gateway.client.guilds.cache.get(HARNESS_GUILDS.example.id);
  const channel = guild?.channels.cache.get(CHANNEL.reviews);
  if (!channel || channel.isThread()) throw new Error("Missing invented review channel");
  // Discord can clear obfuscation while preserving the synthetic View Channel deny.
  Object.defineProperty(channel, "name", { value: "restored-but-hidden" });
  Object.defineProperty(channel, "permissionsFor", { value: () => new PermissionsBitField() });
  const names = guildNames(gateway, HARNESS_GUILDS.example.id);
  expect(names.channels.get(CHANNEL.reviews)).toBeNull();
  const document = await documentOf(`<#${CHANNEL.reviews}> channel ${CHANNEL.reviews}`, names);
  expect(document.body.textContent).not.toContain("restored-but-hidden");
  expect(document.body.textContent).not.toContain(CHANNEL.reviews);
  expect(document.querySelectorAll(".mention")).toHaveLength(0);
});

test("uncached server rendering does not borrow names from another server", async () => {
  const names = guildNames(harnessGateway(), HARNESS_GUILDS.second.id);
  const document = await documentOf(`<@&${ROLE.guest}> <#${CHANNEL.reviews}> <@${USER}>`, names);
  expect([...document.querySelectorAll("code")].map((node) => node.textContent)).toEqual([
    ROLE.guest,
    CHANNEL.reviews,
    USER,
  ]);
  expect(document.querySelectorAll(".mention")).toHaveLength(0);
});
