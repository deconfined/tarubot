/** Discord names come from this server's cache only; diagnostics never become HTML or links. */
import type { DiscordGateway } from "../discord/gateway.js";
import { cachedAsHidden, isObfuscated, OBFUSCATED_CHANNEL_NAME } from "../discord/obfuscation.js";
import { html, type SafeHtml, untrusted } from "./html.js";
import { time } from "./time.js";

export interface WebNames {
  readonly roles: ReadonlyMap<string, string>;
  /** null means the cached channel is hidden; its name must not be shown. */
  readonly channels: ReadonlyMap<string, string | null>;
  readonly users: ReadonlyMap<string, string>;
}

export const EMPTY_NAMES: WebNames = {
  roles: new Map(),
  channels: new Map(),
  users: new Map(),
};

/** No REST calls or persisted names. A snapshot keeps one render internally consistent. */
export function guildNames(gateway: DiscordGateway, guildId: string): WebNames {
  const guild = gateway.client.guilds.cache.get(guildId);
  if (!guild) return EMPTY_NAMES;
  const roles = new Map(guild.roles.cache.map((role) => [role.id, role.name] as const));
  const users = new Map(
    guild.members.cache.map((member) => [member.id, member.displayName] as const),
  );
  const channels = new Map<string, string | null>();
  const bot = guild.members.me;
  for (const channel of guild.channels.cache.values()) {
    if (!channel) continue;
    // An interaction can restore a name while the synthetic deny survives. Check both signals;
    // without the bot member there is no permission evidence, so don't assert channel visibility.
    const hidden =
      !bot ||
      isObfuscated(channel) ||
      channel.name === OBFUSCATED_CHANNEL_NAME ||
      (!channel.isThread() && cachedAsHidden(channel, bot)) ||
      (channel.isThread() && (!channel.parent || cachedAsHidden(channel.parent, bot)));
    channels.set(channel.id, hidden ? null : channel.name);
  }
  return { roles, channels, users };
}

export function roleName(id: string | null, names: WebNames): SafeHtml {
  if (id === null) return html`<span class="note">Not set</span>`;
  const name = names.roles.get(id);
  return name === undefined
    ? html`<code>${id}</code>`
    : html`<span class="mention">${untrusted(`@${name}`)}</span>`;
}

export function channelName(id: string | null, names: WebNames): SafeHtml {
  if (id === null) return html`<span class="note">Not set</span>`;
  const name = names.channels.get(id);
  if (name === null) return html`<span>a channel TaruBot can't see</span>`;
  return name === undefined
    ? html`<code>${id}</code>`
    : html`<span class="mention">${untrusted(`#${name}`)}</span>`;
}

export function userName(id: string, names: WebNames): SafeHtml {
  const name = names.users.get(id);
  return name === undefined ? html`<code>${id}</code>` : untrusted(name);
}

/** Only Discord's mention/timestamp grammar is interpreted; all other text remains escaped. */
const TOKENS =
  /<@([!&]?)([1-9][0-9]{16,19})>|<#([1-9][0-9]{16,19})>|\bchannel ([1-9][0-9]{16,19})\b|<t:(-?[0-9]{1,12})(?::[tTdDfFR])?>/gu;

export function mentionText(text: string, names: WebNames): SafeHtml {
  const parts: SafeHtml[] = [];
  let end = 0;
  for (const match of text.matchAll(TOKENS)) {
    parts.push(untrusted(text.slice(end, match.index)));
    const [, kind, userOrRole, channel, bareChannel, seconds] = match;
    if (userOrRole)
      parts.push(kind === "&" ? roleName(userOrRole, names) : userName(userOrRole, names));
    else if (channel) parts.push(channelName(channel, names));
    else if (bareChannel) parts.push(html`channel ${channelName(bareChannel, names)}`);
    else if (seconds) {
      const instant = new Date(Number(seconds) * 1000);
      const at = time(instant);
      parts.push(html`<time datetime="${at.iso}">${at.text}</time>`);
    }
    end = match.index + match[0].length;
  }
  parts.push(untrusted(text.slice(end)));
  return html`${parts}`;
}
