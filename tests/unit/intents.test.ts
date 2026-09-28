/**
 * The gateway intents are pinned to exactly Guilds and GuildMembers (bitfield 3, 2.35.0).
 *
 * Message intents are banned permanently (the no-message-intents trust rule): TaruBot never reads
 * members' messages. It asks for nothing beyond the two, so no message, reaction, typing, poll,
 * presence or voice-state events either (Presence isn't part of @deconfined's ban, but no feature
 * requests it, and this test keeps it that way until he decides). A feature that seems to need one
 * is built another way (a slash command, a modal), never by widening this list. The static scan keeps the one client in
 * src/discord/gateway.ts, so no script or module can open a second client with other intents.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { GatewayIntentBits, IntentsBitField } from "discord.js";
import { DiscordGateway } from "../../src/discord/gateway.js";

/** A repository path, resolved relative to this test (the same helper as deployment.test.ts). */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

/** Guilds (1) and GuildMembers (2): the whole of what TaruBot may ask Discord for. */
const ALLOWED_BITFIELD = 3;

/**
 * Intents that would deliver message content or activity TaruBot has no business seeing. The
 * bitfield check alone would catch them; naming them makes a failure say which one was added.
 */
const BANNED = [
  "GuildMessages",
  "MessageContent",
  "DirectMessages",
  "GuildMessageReactions",
  "DirectMessageReactions",
  "GuildMessageTyping",
  "DirectMessageTyping",
  "GuildMessagePolls",
  "DirectMessagePolls",
  "GuildPresences",
  "GuildVoiceStates",
] as const satisfies readonly (keyof typeof GatewayIntentBits)[];

/** The banned intents an intent set holds, by name; empty when it holds none. */
function bannedIntents(intents: IntentsBitField): string[] {
  return BANNED.filter((name) => intents.has(GatewayIntentBits[name]));
}

describe("the gateway client's intents", () => {
  // Built without logging in: the constructor opens no gateway session and sends no request.
  const gateway = new DiscordGateway();
  afterAll(async () => {
    await gateway.client.destroy();
  });

  test("are exactly Guilds and GuildMembers", () => {
    const intents = new IntentsBitField(gateway.client.options.intents);
    expect(intents.bitfield).toBe(ALLOWED_BITFIELD);
    expect(intents.toArray().sort()).toEqual(["GuildMembers", "Guilds"]);
  });

  test("hold no message, reaction, typing, poll, presence or voice-state intent", () => {
    expect(bannedIntents(new IntentsBitField(gateway.client.options.intents))).toEqual([]);
  });
});

test("the banned-intent check names an intent added to the allowed pair", () => {
  // The check itself must see a banned intent, or the test above would pass vacuously.
  const widened = new IntentsBitField([
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
  ]);
  expect(bannedIntents(widened)).toEqual(["MessageContent", "GuildPresences"]);
  expect(widened.bitfield).not.toBe(ALLOWED_BITFIELD);
});

/**
 * Tokens that choose intents or build a Discord client. They're matched instead of `intents:`,
 * because scripts/discord-inspect.ts prints an `intents:` report of the portal's settings.
 */
const CLIENT_TOKENS = [/\bGatewayIntentBits\b/u, /\bIntentsBitField\b/u, /\bnew\s+Client\s*\(/u];

/** The one file allowed to hold those tokens: the gateway adapter that owns the client. */
const GATEWAY = "src/discord/gateway.ts";

test("only the gateway adapter chooses intents or builds a Discord client", async () => {
  const offenders: string[] = [];
  for (const directory of ["src", "scripts"])
    for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: root(directory) })) {
      const file = `${directory}/${path}`;
      if (file === GATEWAY) continue;
      const text = await Bun.file(root(file)).text();
      for (const token of CLIENT_TOKENS) if (token.test(text)) offenders.push(`${file} ${token}`);
    }
  expect(offenders).toEqual([]);
  // The gateway builds exactly one client, the one whose intents are checked above.
  const gateway = await Bun.file(root(GATEWAY)).text();
  expect(gateway.match(/\bnew\s+Client\s*\(/gu)).toHaveLength(1);
});
