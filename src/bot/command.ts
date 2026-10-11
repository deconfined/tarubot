/** A slash command owns its registration schema, execution, and private autocomplete. */
import type {
  ApplicationCommandOptionChoiceData,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  ModalBuilder,
  SlashCommandBuilder,
} from "discord.js";
import type { Viewer } from "../discord/presenters/audience.js";
import type { Presented } from "../discord/presenters/reply.js";
import type { Actor } from "../domain/policy.js";
import type { BotContext } from "./context.js";
import type { ServiceKey } from "./services.js";

/** Both command and autocomplete handlers receive an already authenticated guild actor. */
export interface CommandContext extends BotContext {
  readonly actor: Actor;
  /**
   * Who the reply is written for, derived once by the router from the same fresh actor the
   * services authorize against. Presenters choose wording and detail from it, never access.
   */
  readonly viewer: Viewer;
  readonly interaction: ChatInputCommandInteraction;
}

/** Autocomplete cannot defer, so its actor comes from Discord's permission-bearing payload. */
export interface AutocompleteContext extends BotContext {
  readonly actor: Actor;
  readonly interaction: AutocompleteInteraction;
}

/**
 * A pre-modal check runs before the form's acknowledgement, so it gets no actor: resolving one
 * needs Discord round trips that the three-second window cannot afford. The router has already
 * confirmed a human member of an allowed guild; `guildId` is that verified guild.
 */
export interface ModalGateContext extends BotContext {
  readonly guildId: string;
  readonly interaction: ChatInputCommandInteraction;
}

/** Metadata and handlers exported together prevent registration/runtime inventories drifting. */
interface CommandMetadata {
  readonly data: Pick<SlashCommandBuilder, "toJSON">;
  readonly access?: "user" | "officer";
  readonly ephemeral?: boolean;
  /**
   * Replies stay private even where DevBot's public-response override (PUBLIC_TEST_RESPONSES)
   * would make them public (2.43.0): for a command whose reply, even a refusal, would tell
   * onlookers something about the person (/modmail: that they opened a case).
   */
  readonly alwaysPrivate?: boolean;
  readonly requires?: readonly ServiceKey<unknown>[];
  readonly autocomplete?: (
    context: AutocompleteContext,
  ) =>
    | Promise<ApplicationCommandOptionChoiceData<string>[]>
    | ApplicationCommandOptionChoiceData<string>[];
}

/**
 * Modal opening is unprivileged. An optional pre-modal check may refuse it, and the submission
 * authenticates before any work.
 */
export type CommandOptions = CommandMetadata &
  (
    | {
        /**
         * Parse options, call one service method and return its presenter's reply. Only the
         * presenter builders in src/discord/presenters/reply.ts can create a Presented, so a
         * handler cannot send raw options, JSON or its own flags; failures are thrown, never
         * caught, and the router presents them.
         */
        readonly execute: (context: CommandContext) => Promise<Presented> | Presented;
        readonly modal?: never;
        readonly beforeModal?: never;
      }
    | {
        readonly access?: "user";
        readonly modal: (interaction: ChatInputCommandInteraction) => ModalBuilder;
        /**
         * Optional availability check before the form opens. Return a presenter reply to answer
         * with it instead of the form, or null to open the form. The router sends the refusal as
         * the only acknowledgement with the usual visibility; it is an expected state, so it is
         * not reported and carries no Code · Ref footer. Keep it to one fast local read: Discord
         * allows three seconds for the first acknowledgement, so the router opens the form anyway
         * if the check errors or overruns its budget. It is a courtesy, not authorization; the
         * submission still resolves a fresh actor and repeats every check.
         */
        readonly beforeModal?: (
          context: ModalGateContext,
        ) => Promise<Presented | null> | Presented | null;
        readonly execute?: never;
      }
  );

/** Nominal module type lets discovery validate unknown imports using instanceof. */
export class Command {
  private readonly definition: ReturnType<SlashCommandBuilder["toJSON"]>;
  readonly name: string;
  readonly access: "user" | "officer";
  readonly ephemeral: boolean;
  readonly alwaysPrivate: boolean;
  readonly requires: readonly ServiceKey<unknown>[];
  readonly execute: CommandOptions["execute"];
  readonly modal: CommandOptions["modal"];
  readonly beforeModal: CommandOptions["beforeModal"];
  readonly autocomplete: CommandOptions["autocomplete"];

  constructor(options: CommandOptions) {
    if (
      typeof options.data?.toJSON !== "function" ||
      !(
        (typeof options.execute === "function" && options.modal === undefined) ||
        (typeof options.modal === "function" && options.execute === undefined)
      )
    ) {
      throw new Error(
        "A command requires a Discord builder and exactly one execute or modal handler.",
      );
    }
    if (options.modal && options.access && options.access !== "user")
      throw new Error(
        "Immediate modal commands must be unprivileged; authorize submissions instead.",
      );
    // Discovered modules are untyped at runtime, so re-check what the option union promises.
    if (
      options.beforeModal !== undefined &&
      (typeof options.beforeModal !== "function" || typeof options.modal !== "function")
    )
      throw new Error("A pre-modal check must be a function on a modal command.");
    if (options.autocomplete !== undefined && typeof options.autocomplete !== "function") {
      throw new Error("Command autocomplete must be a function.");
    }
    // Discord.js validates names, option structure, and limits while serializing the builder.
    this.definition = options.data.toJSON();
    this.name = this.definition.name;
    this.access = options.access ?? "user";
    this.ephemeral = options.ephemeral ?? true;
    this.alwaysPrivate = options.alwaysPrivate === true;
    if (this.alwaysPrivate && !this.ephemeral)
      throw new Error("A command can't be both always private and public.");
    this.requires = options.requires ?? [];
    this.execute = options.execute;
    this.modal = options.modal;
    this.beforeModal = options.beforeModal;
    this.autocomplete = options.autocomplete;
  }

  /** Return a copy so deployment code cannot mutate the running command definition. */
  toJSON(): ReturnType<SlashCommandBuilder["toJSON"]> {
    return structuredClone(this.definition);
  }
}

/** Define a discoverable default export with handler parameters inferred from the contract. */
export const defineCommand = (options: CommandOptions): Command => new Command(options);
