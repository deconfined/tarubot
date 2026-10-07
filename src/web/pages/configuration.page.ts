/** Read-only server configuration and live resource health, for this server's officers. */
import { applicationKey, gatewayKey } from "../../application/keys.js";
import type { Service } from "../../application/service.js";
import { authorize, type Actor } from "../../domain/policy.js";
import { guildNames } from "../mentions.js";
import { definePage } from "../page.js";
import { type CheckedConfiguration, renderConfiguration } from "../views/configuration.js";

const VALIDATION_TTL = 30_000;

interface ValidationEntry {
  readonly pending: Promise<CheckedConfiguration>;
  /** Null while validation is running; the 30-second lifetime starts when it completes. */
  expiresAt: number | null;
}

/** Service lifetime and server scope are both part of the key; never share across applications. */
const validationMemo = new WeakMap<Service, Map<string, ValidationEntry>>();

/** Reauthorize every read, including completed memo hits and joins to an in-flight check. */
export async function validateConfiguration(
  service: Service,
  actor: Actor,
  report: (error: unknown) => void,
): Promise<CheckedConfiguration> {
  const guildId = actor.guildId;
  authorize(actor, guildId, "officer");
  let servers = validationMemo.get(service);
  if (!servers) {
    servers = new Map();
    validationMemo.set(service, servers);
  }
  const cache = servers;
  const existing = cache.get(guildId);
  if (existing && (existing.expiresAt === null || Date.now() < existing.expiresAt))
    return existing.pending;

  // Deferring the call by one microtask installs the pending entry before any validation starts,
  // and also sends synchronous throws through the same error eviction as rejected promises.
  const entry: ValidationEntry = {
    expiresAt: null,
    pending: Promise.resolve()
      .then(() => service.validate(actor, report))
      .then(
        (result) => {
          const checkedAt = new Date(Date.now());
          entry.expiresAt = checkedAt.getTime() + VALIDATION_TTL;
          return { report: result, checkedAt };
        },
        (error: unknown) => {
          cache.delete(guildId);
          throw error;
        },
      ),
  };
  cache.set(guildId, entry);
  return entry.pending;
}

export default definePage({
  path: "/g/:guild/configuration",
  title: "Server configuration",
  access: ["officer"],
  requires: [applicationKey, gatewayKey],
  nav: "Server configuration",
  async get({ actor, guildId, services, report, ref }) {
    const checked = await validateConfiguration(services.get(applicationKey), actor, (error) =>
      report(error, ref, { scope: "web:/g/:guild/configuration" }),
    );
    return renderConfiguration({
      ...checked,
      names: guildNames(services.get(gatewayKey), guildId),
    });
  },
});
