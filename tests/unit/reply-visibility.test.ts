/** Public development output is a scoped acknowledgement policy, not a permission bypass. */
import { expect, test } from "bun:test";
import { InteractionResponseType, MessageFlags } from "discord.js";
import { defineComponent } from "../../src/bot/component.js";
import { replyAcknowledgement } from "../../src/bot/reply-visibility.js";
import { InteractionRouter } from "../../src/bot/router.js";
import { Services } from "../../src/bot/services.js";
import { reply } from "../../src/discord/presenters/reply.js";
import { interactionFixture } from "../fixtures/interactions.js";
import { NO_ACCESS } from "../../src/domain/policy.js";

test("the selected development guild overrides private command/component defaults", () => {
  expect(replyAcknowledgement("123", true, "123")).toEqual({});
  expect(replyAcknowledgement("123", false, "123")).toEqual({});
});
test("other guilds and unscoped interactions retain their declared visibility", () => {
  expect(replyAcknowledgement("456", true, "123")).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement(null, true, "123")).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement("123", true)).toEqual({ flags: MessageFlags.Ephemeral });
  expect(replyAcknowledgement("456", false, "123")).toEqual({});
});

test("an in-place update never sets or changes visibility, in or outside the test guild", async () => {
  const pager = defineComponent({
    prefix: "pager",
    acknowledge: "update",
    execute: () => reply({ tone: "info", title: "Next page" }),
  });
  for (const publicGuild of ["100", undefined]) {
    const fixture = interactionFixture();
    const router = new InteractionRouter(
      {
        client: fixture.client,
        services: new Services(),
        allowsGuild: () => true,
        isStopping: () => false,
        publicResponseGuildId: publicGuild,
        resolveActor: async (guildId, userId) => ({
          guildId,
          userId,
          manageRoles: false,
          access: NO_ACCESS,
        }),
        report: () => {},
      },
      new Map(),
      new Map([[pager.prefix, pager]]),
    );
    try {
      // A public message the presser opened, and a private one: both keep their visibility.
      await router.handle(fixture.button("pager:next", "1", { ownerId: "400" }));
      await router.handle(fixture.button("pager:next", "2", { ephemeral: true }));
      const acknowledgements = fixture.requests.filter((request) => request.method === "post");
      const edits = fixture.requests.filter((request) => request.method === "patch");
      expect(acknowledgements.map((request) => request.body)).toEqual([
        { type: InteractionResponseType.DeferredMessageUpdate },
        { type: InteractionResponseType.DeferredMessageUpdate },
      ]);
      for (const edit of edits) expect(edit.body).toMatchObject({ flags: undefined });
    } finally {
      await fixture.close();
    }
  }
});
