/** Transport-only interaction dispatch: lookup, acknowledgement, actor checks, and replies. */
import { DiscordAPIError, PermissionFlagsBits } from "discord.js";
import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  Interaction,
  InteractionEditReplyOptions,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";
import { viewerOf, type Viewer } from "../discord/presenters/audience.js";
import { failureReply, rendersInPlace } from "../discord/presenters/failure.js";
import { Presented } from "../discord/presenters/reply.js";
import { classifyFailure } from "../domain/failures.js";
import { authorize, type Actor } from "../domain/policy.js";
import { Failure } from "../domain/values.js";
import type { Command } from "./command.js";
import { rendersSourceInPlace, type AcknowledgeMode, type Component } from "./component.js";
import type { BotContext } from "./context.js";
import { ServiceKey } from "./services.js";
import { undeclaredShape } from "./shape.js";
import { replyAcknowledgement } from "./reply-visibility.js";

/**
 * Time allowed for a modal command's pre-modal check. Discord gives the first acknowledgement three
 * seconds from interaction creation, and gateway delivery plus the response request both use part
 * of that. After this budget the form opens anyway, which is what happened before the check existed.
 */
export const MODAL_GATE_BUDGET_MS = 1500;

/**
 * Discord errors after which no response can reach the user: Unknown Interaction (the three-second
 * window passed), Interaction Already Acknowledged, Invalid Webhook Token and Unknown Webhook (the
 * fifteen-minute token expired). They are reported at warn and never retried.
 */
const UNDELIVERABLE: ReadonlySet<number> = new Set([10062, 40060, 50027, 10015]);

/** Whether an error means the interaction can no longer be answered at all. */
const undeliverable = (error: unknown): boolean =>
  error instanceof DiscordAPIError && UNDELIVERABLE.has(Number(error.code));

/** Custom-ID prefixes are module names; anything else is logged as unknown, not echoed. */
const PREFIX = /^[a-z][a-z0-9_-]{0,31}$/u;

/** The interactions the router answers; autocomplete has its own path. */
type Answerable =
  | ChatInputCommandInteraction
  | MessageComponentInteraction
  | ModalSubmitInteraction;

/**
 * The interaction path, for logs and failure wording: '/ledger withdraw', '/config roles officer',
 * 'button ledger', 'modal guest-apply'. It names routes, never option values or payloads.
 */
export function interactionScope(interaction: Answerable): string {
  if (interaction.isChatInputCommand()) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);
    return [`/${interaction.commandName}`, group, subcommand].filter(Boolean).join(" ");
  }
  const prefix = interaction.customId.split(":")[0] ?? "";
  const kind = interaction.isModalSubmit()
    ? "modal"
    : interaction.isButton()
      ? "button"
      : "component";
  return `${kind} ${PREFIX.test(prefix) ? prefix : "unknown"}`;
}

/**
 * Whether a slash command ran with its boolean `confirm` option set to true (/setup's subcommands,
 * whose dry run is the default). Failure wording reads it; it is never logged or echoed.
 */
export function confirmedOption(interaction: Answerable): boolean {
  return interaction.isChatInputCommand() && interaction.options.get("confirm")?.value === true;
}

/**
 * A presenter reply's options with mentions forced off last, so no reply can re-enable pings. They
 * are valid for a first reply, a follow-up and an edit alike: handler results, failure cards and
 * pre-modal refusals are all presenter replies, which always carry content, embeds and components.
 */
function sendable(presented: Presented) {
  return { ...presented.options, allowedMentions: { parse: [] as [] } };
}

/**
 * Options for an in-place update. A presenter reply always carries content, embeds and components
 * (empty when unused), so the edit replaces the previous view's text, embeds and buttons, and a
 * result without controls removes the old ones instead of leaving them live. The empty attachments
 * list clears earlier files; it is a fresh array each time, because discord.js appends new files
 * to it.
 */
function replacing(presented: Presented): InteractionEditReplyOptions {
  return { attachments: [], ...sendable(presented) };
}

/**
 * A handler's result, checked at runtime because discovered modules are untyped JavaScript once
 * compiled. Anything but a presenter reply (legacy edit options, a JSON dump, undefined) is a
 * programming error: it is presented as an unexpected failure after the work ran, never sent.
 */
function presented(result: unknown, scope: string): Presented {
  if (result instanceof Presented) return result;
  throw new Error(`The ${scope} handler must return a presenter reply.`);
}

/** What the catch path needs to know about how far the interaction got. */
interface Progress {
  readonly scope: string;
  /** confirmedOption(interaction), for the failure card's no-change sentence. */
  readonly confirmed: boolean;
  readonly acknowledgement: ReturnType<typeof replyAcknowledgement>;
  /** Set once the actor is resolved; absent means member-safe wording. */
  viewer: Viewer | undefined;
  /** 'update' after a deferred in-place update of the source message. */
  mode: AcknowledgeMode;
  /** 'deliver' once execute returned and its result is being sent. */
  phase: "execute" | "deliver";
}

/** Feature behavior lives in discovered modules, so new routes never require a switch edit. */
export class InteractionRouter {
  constructor(
    private readonly context: BotContext,
    private readonly commands: ReadonlyMap<string, Command>,
    private readonly components: ReadonlyMap<string, Component>,
    /** Tests shorten this; production uses the default. */
    private readonly modalGateBudgetMs = MODAL_GATE_BUDGET_MS,
  ) {
    for (const module of [...commands.values(), ...components.values()])
      context.services.require(module.requires);
  }

  /**
   * Defer before remote work, or open a synchronous form as the initial acknowledgement. Every
   * failure is answered with its approved card and reported; handle() itself never rejects.
   */
  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isAutocomplete()) {
      await this.autocomplete(interaction);
      return;
    }
    if (
      !interaction.isChatInputCommand() &&
      !interaction.isMessageComponent() &&
      !interaction.isModalSubmit()
    )
      return;
    const module = interaction.isChatInputCommand()
      ? this.commands.get(interaction.commandName)
      : this.components.get(interaction.customId.split(":")[0] ?? "");
    const ephemeral =
      !interaction.isChatInputCommand() ||
      this.commands.get(interaction.commandName)?.ephemeral !== false;
    const progress: Progress = {
      scope: interactionScope(interaction),
      confirmed: confirmedOption(interaction),
      acknowledgement: replyAcknowledgement(
        interaction.guildId,
        ephemeral,
        this.context.publicResponseGuildId,
      ),
      viewer: undefined,
      mode: "reply",
      phase: "execute",
    };
    try {
      // Pre-actor refusals: no viewer yet, so their cards are member-safe.
      if (!interaction.guildId || interaction.user.bot)
        throw new Failure(
          "forbidden",
          "TaruBot commands work only inside the server, for human members.",
          0,
          { kind: "scope", scope: "human" },
        );
      if (!this.context.allowsGuild(interaction.guildId))
        throw new Failure(
          "forbidden",
          "This copy of TaruBot is a test instance and only works in its test server.",
          0,
          { kind: "scope", scope: "test_guild" },
        );
      // A command or custom ID this release does not define comes from an older (or newer) one.
      if (!module)
        throw new Failure(
          "stale",
          "This button or command is from an older version of TaruBot. Use the current command. If it keeps happening, ask a server manager to redeploy the commands.",
          0,
          { kind: "stale", what: "control" },
        );
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        // A subcommand or option this release doesn't declare comes from another release's
        // registration; running the handler would make it guess, so refuse like an unknown command.
        if (command && undeclaredShape(command.toJSON().options, interaction.options.data) !== null)
          throw new Failure(
            "stale",
            "This command is from a different version of TaruBot. Run it again in a moment. If it keeps happening, ask a server manager to redeploy the commands.",
            0,
            { kind: "stale", what: "control" },
          );
        if (command?.modal) {
          // A pre-modal check can refuse a closed feature before the user writes answers that
          // cannot be submitted. The refusal is the interaction's only acknowledgement; the
          // acknowledgement is spread last so the default visibility (ephemeral unless the
          // observed test guild overrides it) can't be changed by the reply.
          const refusal = await this.modalRefusal(command, interaction, interaction.guildId);
          if (refusal !== null) {
            await interaction.reply({ ...sendable(refusal), ...progress.acknowledgement });
            return;
          }
          // No authority or state change is granted by opening a form. Its separate submission
          // follows the normal fresh-actor path below; Discord forbids showing a modal after defer.
          await interaction.showModal(command.modal(interaction));
          return;
        }
      }
      const component = interaction.isChatInputCommand()
        ? undefined
        : this.components.get(interaction.customId.split(":")[0] ?? "");
      if (interaction.isMessageComponent() && component && this.updates(interaction, component)) {
        // The click re-renders its own message; visibility can't change on an edit.
        progress.mode = "update";
        await interaction.deferUpdate();
      } else await interaction.deferReply(progress.acknowledgement);
      const actor = await this.context.resolveActor(interaction.guildId, interaction.user.id);
      // The viewer comes before authorization so a refused member still gets member wording.
      progress.viewer = viewerOf(actor, interaction.id);
      authorize(actor, interaction.guildId, module.access);
      // Separate lookups retain precise interaction types without casting a handler union.
      let result: unknown;
      if (interaction.isChatInputCommand()) {
        const command = this.commands.get(interaction.commandName);
        if (!command?.execute) throw new Error("Command disappeared from immutable registry");
        result = await command.execute({
          ...this.context,
          actor,
          viewer: progress.viewer,
          interaction,
        });
      } else {
        if (!component) throw new Error("Component disappeared from immutable registry");
        result = await component.execute({
          ...this.context,
          actor,
          viewer: progress.viewer,
          interaction,
        });
      }
      // From here the handler's work has run, so a failure may follow a saved change.
      progress.phase = "deliver";
      const reply = presented(result, progress.scope);
      await interaction.editReply(progress.mode === "update" ? replacing(reply) : sendable(reply));
    } catch (error) {
      await this.fail(interaction, error, progress);
    }
  }

  /**
   * Whether a click updates its source message in place. Only a component that asks for it, and
   * only when the source is ephemeral (just the presser can see and click it) or was created for
   * the presser; a public message someone else opened, or a channel post, gets a new reply. A
   * throwing or invalid acknowledge choice falls back to a reply, and the handler's strict parser
   * then reports the out-of-date control.
   */
  private updates(interaction: MessageComponentInteraction, component: Component): boolean {
    let mode: unknown;
    try {
      mode =
        typeof component.acknowledge === "function"
          ? component.acknowledge(interaction.customId)
          : component.acknowledge;
    } catch {
      return false;
    }
    return mode === "update" && rendersSourceInPlace(interaction);
  }

  /**
   * Answer a failure with its approved card and report it once, with the level its category sets
   * and the interaction scope. The footer's code and Ref match this report.
   * - An undeliverable interaction (expired token, already answered) is reported at warn and not
   *   retried.
   * - In update mode the card is a new private follow-up and the source view is kept, except for
   *   a card that re-renders that same screen (the pending-token card), which edits it in place.
   * - A deferred or answered interaction is edited; otherwise the card is the first reply.
   * - A failure while sending is reported at warn and swallowed, so handle() never rejects.
   */
  private async fail(interaction: Answerable, error: unknown, progress: Progress): Promise<void> {
    const report = { scope: progress.scope };
    if (undeliverable(error)) {
      this.context.report(error, interaction.id, { ...report, level: "warn" });
      return;
    }
    this.context.report(error, interaction.id, { ...report, level: classifyFailure(error).level });
    try {
      const card = failureReply(error, {
        ref: interaction.id,
        viewer: progress.viewer,
        scope: progress.scope,
        confirmed: progress.confirmed,
        phase: progress.phase,
      });
      if (progress.mode === "update" && interaction.deferred) {
        if (rendersInPlace(error)) await interaction.editReply(replacing(card));
        else await interaction.followUp({ ...sendable(card), ...progress.acknowledgement });
      } else if (interaction.deferred || interaction.replied)
        await interaction.editReply(sendable(card));
      else await interaction.reply({ ...sendable(card), ...progress.acknowledgement });
    } catch (sendError) {
      this.context.report(sendError, interaction.id, { ...report, level: "warn" });
    }
  }

  /**
   * Run a modal command's optional pre-modal check within the acknowledgement budget. It returns
   * the refusal reply, or null to open the form. It fails open: an error, an invalid result or a
   * slow read is reported at warn and the form opens as before, because opening a form grants
   * nothing and the submission path repeats the check authoritatively.
   */
  private async modalRefusal(
    command: Command,
    interaction: ChatInputCommandInteraction,
    guildId: string,
  ): Promise<Presented | null> {
    if (!command.beforeModal) return null;
    const report = { scope: interactionScope(interaction), level: "warn" } as const;
    // A private sentinel cannot collide with any result the check might return.
    const overrun = Symbol("pre-modal budget overrun");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const budget = new Promise<typeof overrun>((resolve) => {
        timer = setTimeout(() => resolve(overrun), this.modalGateBudgetMs);
      });
      // Promise.race also subscribes to the check, so a late rejection is never unhandled.
      const outcome: unknown = await Promise.race([
        Promise.resolve(command.beforeModal({ ...this.context, guildId, interaction })),
        budget,
      ]);
      if (outcome === null || outcome instanceof Presented) return outcome;
      if (outcome !== overrun)
        throw new Error("A pre-modal check must return a presenter reply or null.");
      const overran = new Failure(
        "unavailable",
        "The pre-form check overran its budget; the form opened.",
      );
      this.context.report(overran, interaction.id, report);
      return null;
    } catch (error) {
      this.context.report(error, interaction.id, report);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Use permission-bearing interaction data because Discord autocomplete cannot be deferred. */
  private async autocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (
        !interaction.guildId ||
        interaction.user.bot ||
        !this.context.allowsGuild(interaction.guildId)
      ) {
        await interaction.respond([]);
        return;
      }
      const module = this.commands.get(interaction.commandName);
      // No suggestions for a shape this release doesn't declare (another release's registration).
      if (
        !module?.autocomplete ||
        undeclaredShape(module.toJSON().options, interaction.options.data) !== null
      ) {
        await interaction.respond([]);
        return;
      }
      const base: Actor = {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        officer: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        manageRoles: interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles) ?? false,
        serverManager: interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false,
        roleIds: interaction.inCachedGuild()
          ? [...interaction.member.roles.cache.keys()]
          : interaction.inRawGuild()
            ? interaction.member.roles
            : [],
      };
      const actor = this.context.enrichActor ? await this.context.enrichActor(base) : base;
      authorize(actor, actor.guildId, module.access);
      await interaction.respond(
        (await module.autocomplete({ ...this.context, actor, interaction })).slice(0, 25),
      );
    } catch (error) {
      // Autocomplete has a hard three-second window and no defer, so a late respond() is its most
      // common failure; like handle(), an interaction that can't be answered any more is a warn.
      const gone = undeliverable(error);
      this.context.report(error, interaction.id, {
        level: gone ? "warn" : classifyFailure(error).level,
        scope: `autocomplete /${interaction.commandName}`,
      });
      // An expired or already-answered autocomplete cannot take a fallback response either.
      if (!gone) await interaction.respond([]).catch(() => {});
    }
  }
}

/** The gateway event module depends on a router capability, not a concrete main module. */
export const interactionRouterKey = new ServiceKey(
  "interaction router",
  (value): value is InteractionRouter => value instanceof InteractionRouter,
);
