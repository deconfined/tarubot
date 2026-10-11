/** Exercise real Discord.js acknowledgements and modal parsing with a local REST recorder. */
import { spyOn } from "bun:test";
import {
  ApplicationCommandOptionType,
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ComponentType,
  InteractionType,
  MessageFlags,
  ModalSubmitInteraction,
} from "discord.js";
import type { RequestData } from "discord.js";

/** The message a button sits on: its visibility, who it was created for, and its last edit. */
export interface ButtonSource {
  /** An ephemeral message only its recipient can see (and click). */
  readonly ephemeral?: boolean;
  /** The user whose interaction created the message (interaction_metadata.user). */
  readonly ownerId?: string;
  /** When the message was last edited, for throttles that read the source's timestamps. */
  readonly editedAt?: string;
}

/** One recorded REST call: its route, JSON body, and the names of any uploaded files. */
export interface RecordedRequest {
  readonly method: string;
  readonly route: string;
  readonly body: unknown;
  readonly files?: readonly string[];
}

/** File names from a REST call's options; discord.js passes uploads beside the JSON body. */
function fileNames(options: RequestData | undefined) {
  return options?.files?.length ? { files: options.files.map((file) => file.name) } : {};
}

export function interactionFixture() {
  const client = new Client<true>({ intents: [] });
  const requests: RecordedRequest[] = [];
  const member = {
    guildId: "100",
    userId: "400",
    joinedAt: "2026-01-01T00:00:00.000Z",
    bot: false,
    /** The member's permission bitfield in the channel, as Discord sends it with the payload. */
    permissions: "0",
  };
  let serial = 10000;
  const user = () => ({
    id: member.userId,
    username: "visitor",
    discriminator: "0",
    avatar: null,
    bot: member.bot,
  });
  const message = (id = "123456789", source: ButtonSource = {}) => ({
    id,
    channel_id: "200",
    author: { id: "900", username: "bot", discriminator: "0", avatar: null, bot: true },
    content: "Review",
    timestamp: "2026-01-01T00:00:00.000Z",
    edited_timestamp: source.editedAt ?? null,
    flags: source.ephemeral ? MessageFlags.Ephemeral : 0,
    ...(source.ownerId && {
      interaction_metadata: {
        id: "600",
        type: InteractionType.ApplicationCommand,
        user: {
          id: source.ownerId,
          username: "owner",
          discriminator: "0",
          avatar: null,
        },
        authorizing_integration_owners: {},
      },
    }),
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
    pinned: false,
    type: 0,
  });
  const payload = () => ({
    id: String(++serial),
    application_id: "900",
    token: "fixture-interaction-token",
    version: 1,
    guild_id: member.guildId || undefined,
    channel: { id: "200", type: 0 },
    user: user(),
    member: member.guildId
      ? {
          user: user(),
          roles: [],
          joined_at: member.joinedAt,
          permissions: member.permissions,
          flags: 0,
        }
      : undefined,
    app_permissions: "0",
    locale: "en-US",
    guild_locale: "en-US",
    entitlements: [],
    authorizing_integration_owners: {},
    attachment_size_limit: 10000000,
  });
  // Errors the next matching REST call throws instead of answering, in order (not recorded).
  const rejections: { method: "post" | "patch"; error: unknown }[] = [];
  const reject = (method: "post" | "patch") => {
    const index = rejections.findIndex((rejection) => rejection.method === method);
    if (index >= 0) throw rejections.splice(index, 1)[0]?.error;
  };
  const post = spyOn(client.rest, "post").mockImplementation(async (route, options) => {
    reject("post");
    requests.push({
      method: "post",
      route,
      body: structuredClone(options?.body),
      ...fileNames(options),
    });
    // A follow-up executes the interaction webhook, which answers with the created message.
    return route.startsWith("/webhooks/") ? message(String(++serial)) : {};
  });
  const patch = spyOn(client.rest, "patch").mockImplementation(async (route, options) => {
    reject("patch");
    requests.push({
      method: "patch",
      route,
      body: structuredClone(options?.body),
      ...fileNames(options),
    });
    return message();
  });
  const get = spyOn(client.rest, "get").mockImplementation(async (route) => {
    if (route === `/guilds/${member.guildId}`)
      return {
        id: member.guildId,
        name: "Fixture",
        owner_id: "300",
        roles: [],
        unavailable: false,
      };
    throw new Error(`Unexpected interaction fixture read ${route}`);
  });
  return {
    client,
    requests,
    member,
    /**
     * Make the next POST (an acknowledgement or follow-up) or PATCH (an edit) throw `error`, as
     * Discord does for an expired interaction or an outage.
     */
    failNext(method: "post" | "patch", error: unknown) {
      rejections.push({ method, error });
    },
    /**
     * `options` and `resolved` are raw Discord payload shapes, so a test can exercise the real
     * option resolver (subcommand groups, booleans, resolved roles) of a command module.
     */
    slash(name = "apply", options: unknown[] = [], resolved?: unknown) {
      // SDK constructors are internal in the typings; runtime construction plus instanceof
      // keeps the fixture typed without substituting a hand-written interaction implementation.
      const value: unknown = Reflect.construct(ChatInputCommandInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.ApplicationCommand,
          data: { id: "700", name, type: 1, options, resolved },
        },
      ]);
      if (!(value instanceof ChatInputCommandInteraction)) throw new Error("Invalid slash fixture");
      return value;
    },
    /**
     * An autocomplete request for `name`, typing `value` into its focused string option. Its
     * respond() posts the interaction callback, so failNext("post", …) makes the answer fail.
     */
    autocomplete(name: string, option = "query", value = "") {
      const interaction: unknown = Reflect.construct(AutocompleteInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.ApplicationCommandAutocomplete,
          data: {
            id: "700",
            name,
            type: 1,
            options: [
              { type: ApplicationCommandOptionType.String, name: option, value, focused: true },
            ],
          },
        },
      ]);
      if (!(interaction instanceof AutocompleteInteraction))
        throw new Error("Invalid autocomplete fixture");
      return interaction;
    },
    /**
     * A modal submission by the fixture member: one text input per answer, in order (/apply's two
     * by default; any form's fields, such as /modmail's topic and message, when given).
     */
    submit(
      customId: string,
      answers: Readonly<Record<string, unknown>> = {
        introduction: "I enjoy playing games with friends.",
        interest: "A friend invited me to meet your community.",
      },
    ) {
      const value: unknown = Reflect.construct(ModalSubmitInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.ModalSubmit,
          data: {
            custom_id: customId,
            // Text answers only: a caller's extra non-text facts (a join time) aren't fields.
            components: Object.entries(answers)
              .filter((entry): entry is [string, string] => typeof entry[1] === "string")
              .map(([custom_id, value], index) => ({
                type: ComponentType.Label,
                id: index * 2 + 1,
                component: { type: ComponentType.TextInput, id: index * 2 + 2, custom_id, value },
              })),
          },
        },
      ]);
      if (!(value instanceof ModalSubmitInteraction)) throw new Error("Invalid modal fixture");
      return value;
    },
    /**
     * A button press by the fixture member. `source` describes the message it sits on: public and
     * without interaction metadata (a channel post) unless it says otherwise.
     */
    button(customId: string, messageId = "123456789", source: ButtonSource = {}) {
      const value: unknown = Reflect.construct(ButtonInteraction, [
        client,
        {
          ...payload(),
          type: InteractionType.MessageComponent,
          data: { custom_id: customId, component_type: ComponentType.Button },
          message: message(messageId, source),
        },
      ]);
      if (!(value instanceof ButtonInteraction)) throw new Error("Invalid button fixture");
      return value;
    },
    async close() {
      post.mockRestore();
      patch.mockRestore();
      get.mockRestore();
      await client.destroy();
    },
  };
}
