/**
 * /modmail's form and its submission (2.43.0, issue #60). The form is Discord's only part in mod
 * mail: its text reaches TaruBot with the interaction, so no message intent is needed, and TaruBot
 * never reads a channel or a DM. The form says plainly, above its fields, that all of the server's
 * officers can read what is sent (owner decision 6), as a text display: Discord's modals take one
 * since the label components (discord.js 14.27, the API's text display in modals).
 *
 * The custom ID binds the form to the server and member that opened it; the submission compares
 * both with the actor resolved for it, and the application checks everything else again.
 */
import {
  LabelBuilder,
  ModalBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { MODMAIL_LIMITS, VISIBILITY_NOTICE } from "../domain/modmail.js";
import type { Actor } from "../domain/policy.js";
import { Failure, idSchema } from "../domain/values.js";

/** The component namespace the form submits under. */
export const MODMAIL_PREFIX = "modmail";

/** The form's two fields. */
const TOPIC_FIELD = "topic";
const MESSAGE_FIELD = "message";

/** The form, built synchronously as the interaction's first acknowledgement (no I/O). */
export function modmailModal(interaction: ChatInputCommandInteraction): ModalBuilder {
  if (!interaction.guildId)
    throw new Failure(
      "forbidden",
      "TaruBot commands work only inside the server, for human members.",
      0,
      {
        kind: "scope",
        scope: "human",
      },
    );
  return new ModalBuilder()
    .setCustomId(`${MODMAIL_PREFIX}:${interaction.guildId}:${interaction.user.id}`)
    .setTitle("Message your officers")
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**${VISIBILITY_NOTICE}**`))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Topic")
        .setDescription("A few words about what this is about. Officers see it in their inbox.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(TOPIC_FIELD)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MODMAIL_LIMITS.topicChars),
        ),
      new LabelBuilder()
        .setLabel("Message")
        .setDescription("All of this server's officers can read it.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MESSAGE_FIELD)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(MODMAIL_LIMITS.messageChars),
        ),
    );
}

/**
 * The submission's text, once the form is shown to be this member's in this server. The custom ID
 * carries IDs, never authority; the text is handed straight to the application and is never
 * logged, echoed or put in an error.
 */
export function modmailSubmission(
  interaction: ModalSubmitInteraction,
  actor: Actor,
): { readonly topic: string; readonly body: string } {
  const match = /^modmail:([1-9][0-9]{0,19}):([1-9][0-9]{0,19})$/u.exec(interaction.customId);
  if (
    !match ||
    !idSchema.safeParse(match[1]).success ||
    !idSchema.safeParse(match[2]).success ||
    match[1] !== actor.guildId ||
    match[2] !== actor.userId ||
    interaction.guildId !== actor.guildId ||
    interaction.user.id !== actor.userId
  )
    throw new Failure(
      "stale",
      "This form belongs to someone else or to another server. Run /modmail yourself.",
      0,
      { kind: "stale", what: "form" },
    );
  return {
    topic: interaction.fields.getTextInputValue(TOPIC_FIELD),
    body: interaction.fields.getTextInputValue(MESSAGE_FIELD),
  };
}
