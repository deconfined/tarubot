/** Shared Discord infrastructure supplied to every module, independent of its feature. */
import type { Client } from "discord.js";
import type { ReportOptions } from "../domain/failures.js";
import type { Actor, ActorResolution } from "../domain/policy.js";
import type { Services } from "./services.js";

/** Handlers obtain optional feature capabilities through services rather than global imports. */
export interface BotContext {
  readonly client: Client;
  readonly services: Services;
  readonly allowsGuild: (guildId: string) => boolean;
  readonly isStopping: () => boolean;
  /** Optional guild-scoped visibility override for an observed development session. */
  readonly publicResponseGuildId?: string | undefined;
  /**
   * gateway.actor, then Service.enrichActor. Commands and buttons pass no mode, which is `full`;
   * the web asks for `light` on GETs and sign-in admission (ActorResolution).
   */
  readonly resolveActor: (
    guildId: string,
    userId: string,
    mode?: ActorResolution,
  ) => Promise<Actor>;
  /** Optional application authorization for payload-authenticated autocomplete actors. */
  readonly enrichActor?: (actor: Actor) => Promise<Actor>;
  /**
   * Log a caught error under an operation ID. The router passes the classified level (routine
   * refusals at info, dependency trouble at warn); other callers keep the error default.
   */
  readonly report: (error: unknown, operation: string, options?: ReportOptions) => void;
}
