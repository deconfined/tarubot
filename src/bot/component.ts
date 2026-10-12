/** Custom-ID namespaces let buttons, menus, and modals be extended without router edits. */
import { modulePermissions, type PermissionId } from "../domain/rbac.js";
import { MessageFlags } from "discord.js";
import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { Viewer } from "../discord/presenters/audience.js";
import type { Presented } from "../discord/presenters/reply.js";
import type { Actor } from "../domain/policy.js";
import type { BotContext } from "./context.js";
import type { ServiceKey } from "./services.js";

/** Modules narrow the specific component type they support before reading its fields. */
export interface ComponentContext extends BotContext {
  readonly actor: Actor;
  /** Who the reply is written for: the presser, derived from their freshly resolved actor. */
  readonly viewer: Viewer;
  readonly interaction: MessageComponentInteraction | ModalSubmitInteraction;
}

/**
 * How a click is acknowledged: 'reply' sends a new message (the default); 'update' re-renders the
 * message the button sits on, for views such as a pager or a re-check. The router still falls back
 * to a new reply unless the source is ephemeral or was created for the presser, so one tester's
 * click never rewrites another's public message, and modal submissions always reply.
 */
export type AcknowledgeMode = "reply" | "update";

/** A namespace owns all custom IDs beginning with prefix followed by a colon. */
export interface ComponentOptions {
  readonly prefix: string;
  /**
   * The permissions that admit this module at the router, any-of (2.44.0, RBAC); none means any
   * human member. A coarse first gate, also applied to autocomplete: each service still checks the
   * exact permission its operation needs.
   */
  readonly permissions?: readonly PermissionId[];
  readonly requires?: readonly ServiceKey<unknown>[];
  /**
   * Replies stay private even under DevBot's public-response override (2.43.0), as the command
   * option of the same name: /modmail's form receipt would otherwise say who opened a case.
   */
  readonly alwaysPrivate?: boolean;
  /**
   * The acknowledgement mode, or a function choosing it from the custom ID. It runs before
   * Discord's three-second acknowledgement, so it must be synchronous and do no I/O; if it throws,
   * the router replies instead and the handler's strict parser reports the out-of-date control.
   */
  readonly acknowledge?: AcknowledgeMode | ((customId: string) => AcknowledgeMode);
  /** Re-authorize the presser's payload and return a presenter reply, as a command does. */
  readonly execute: (context: ComponentContext) => Promise<Presented> | Presented;
}

/**
 * Whether a click on this message may re-render it: the message is ephemeral (only the presser can
 * see and click it) or was created for the presser. The router edits in place only then, and
 * handlers that keep state on their own card (the Check again throttle) apply it only then, so the
 * two can never disagree about whose card a click re-renders.
 */
export function rendersSourceInPlace(interaction: MessageComponentInteraction): boolean {
  const source = interaction.message;
  return (
    source.flags.has(MessageFlags.Ephemeral) ||
    source.interactionMetadata?.user.id === interaction.user.id
  );
}

/** An async function would resolve after the acknowledgement it is meant to choose. */
const isAsyncFunction = (value: unknown): boolean =>
  Object.prototype.toString.call(value) === "[object AsyncFunction]";

/** Validated component definition; payload-specific authorization stays in its handler. */
export class Component {
  readonly prefix: string;
  readonly permissions: readonly PermissionId[];
  readonly requires: readonly ServiceKey<unknown>[];
  readonly acknowledge: NonNullable<ComponentOptions["acknowledge"]>;
  readonly alwaysPrivate: boolean;
  readonly execute: ComponentOptions["execute"];

  constructor(options: ComponentOptions) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(options.prefix) || typeof options.execute !== "function") {
      throw new Error("A component requires a valid custom-ID prefix and an execute handler.");
    }
    // Discovered modules are untyped at runtime, so re-check what the option type promises.
    const acknowledge: unknown = options.acknowledge;
    if (
      acknowledge !== undefined &&
      acknowledge !== "reply" &&
      acknowledge !== "update" &&
      (typeof acknowledge !== "function" || isAsyncFunction(acknowledge))
    )
      throw new Error(
        "A component's acknowledge option must be 'reply', 'update' or a synchronous function.",
      );
    this.prefix = options.prefix;
    this.permissions = modulePermissions(options.permissions);
    this.requires = options.requires ?? [];
    this.acknowledge = options.acknowledge ?? "reply";
    this.alwaysPrivate = options.alwaysPrivate === true;
    this.execute = options.execute;
  }
}

/** Construct the default export consumed by component discovery. */
export const defineComponent = (options: ComponentOptions): Component => new Component(options);
