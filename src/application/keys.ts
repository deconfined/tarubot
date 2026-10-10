/** Feature capability tokens. Add new services here or alongside a new feature package. */
import { ServiceKey } from "../bot/services.js";
import { DiscordGateway } from "../discord/gateway.js";
import { Database } from "../infrastructure/postgres/database.js";
import { GuildEvents } from "./guild-events.js";
import { IssueReports } from "./issue-reports.js";
import { ApplicationLifecycle } from "./lifecycle.js";
import { PublicStatus } from "./public-status.js";
import { Service } from "./service.js";
import { Synchronization } from "./synchronization.js";
import { RoleAdministration } from "./role-administration.js";
import { SelfRoles } from "./self-roles.js";
import { Suggestions } from "./suggestions.js";
import { VersionInformation } from "./version-information.js";

/** Runtime guards keep dependency retrieval safe even for dynamically imported modules. */
export const applicationKey = new ServiceKey(
  "tarubot application",
  (value): value is Service => value instanceof Service,
);
export const synchronizationKey = new ServiceKey(
  "membership synchronization",
  (value): value is Synchronization => value instanceof Synchronization,
);
export const guildEventsKey = new ServiceKey(
  "guild observations",
  (value): value is GuildEvents => value instanceof GuildEvents,
);
export const lifecycleKey = new ServiceKey(
  "application lifecycle",
  (value): value is ApplicationLifecycle => value instanceof ApplicationLifecycle,
);
export const databaseKey = new ServiceKey(
  "postgres database",
  (value): value is Database => value instanceof Database,
);
export const gatewayKey = new ServiceKey(
  "discord gateway",
  (value): value is DiscordGateway => value instanceof DiscordGateway,
);
/** Provisioning is independently injectable from normal Discord effect delivery. */
export const roleAdministrationKey = new ServiceKey(
  "role administration",
  (value): value is RoleAdministration => value instanceof RoleAdministration,
);
/** GitHub history is a read-only capability, independently replaceable in verification tools. */
export const versionInformationKey = new ServiceKey(
  "project version information",
  (value): value is VersionInformation => value instanceof VersionInformation,
);
/** Issue reports (2.18.0): /issue saves through it; automatic reports come from the root. */
export const issueReportsKey = new ServiceKey(
  "issue reports",
  (value): value is IssueReports => value instanceof IssueReports,
);
/** Public suggestions (2.28.0): /suggest posts through it to the public repository. */
export const suggestionsKey = new ServiceKey(
  "public suggestions",
  (value): value is Suggestions => value instanceof Suggestions,
);
/** The self-service role menu (2.39.0): the Role menu page reads and edits it through this. */
export const selfRolesKey = new ServiceKey(
  "self-service roles",
  (value): value is SelfRoles => value instanceof SelfRoles,
);
/**
 * The public status page's snapshot (2.41.0): /status reads it from memory, never the database.
 * src/web/server.ts requires it when the web starts.
 */
export const publicStatusKey = new ServiceKey(
  "public status",
  (value): value is PublicStatus => value instanceof PublicStatus,
);
