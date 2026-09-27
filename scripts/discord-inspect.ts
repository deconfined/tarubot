/**
 * Read-only live preflight over GET-only Discord REST (no gateway session, no database).
 *
 * The mode follows the deployment profile:
 * - devbot (inferred from DevBot's application ID) and staging (DevBot's application on the
 *   staging host, #50; only TARUBOT_ENVIRONMENT=staging selects it): verify DevBot identity and
 *   report the test guild's capabilities, as before.
 * - production / rehearsal: inspect the production application while the legacy bot still owns the
 *   gateway: intents, guilds, the target guild's permissions (also without Administrator), the
 *   managed-role hierarchy and destination-channel access.
 *     bun --env-file="$TARUBOT_PRODUCTION_ENV" dist/scripts/discord-inspect.js \
 *       --guild 1036062273631952955 --dump FINAL.sql      (or repeatable --role ID / --channel ID)
 *   Command scopes are read back separately with dist/scripts/commands.js list.
 * - unmanaged: refused.
 */
import { PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { z } from "zod";
import { configuration } from "../src/config/env.js";
import { secretSetting } from "../src/config/secrets.js";
import {
  assertAuthenticatedApplication,
  assertToolScope,
  deployments,
  resolveDeployment,
} from "../src/config/deployment.js";
import {
  type ChannelTarget,
  type ManagedRoleTarget,
  memberIntent,
  targetReport,
  type UnlistedState,
  unlistedState,
  unlistedTargets,
} from "../src/discord/inspection.js";
import { readDump } from "../src/import/dump.js";
import { id, idSchema, json } from "../src/domain/values.js";

/**
 * GET is the only verb this tool can send. The token and raw error bodies stay out of diagnostics.
 * Returns the status so probes can distinguish "forbidden" from failures.
 */
async function request(token: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method: "GET",
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: response.ok ? await response.json() : null };
}
/**
 * GET /channels/{id} for a destination the guild's channel list left out. Only Discord's JSON
 * error code and the channel's server are kept, never the raw body: from 2026-11-16 the list omits
 * channels TaruBot can't view (#47), and 50001 (hidden, or another server's) versus 10003
 * (deleted) tells them apart.
 */
async function probeChannel(token: string, channelId: string) {
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    method: "GET",
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = z
    .object({ code: z.number().optional(), guild_id: idSchema.optional() })
    .safeParse(await response.json().catch(() => null));
  return {
    ok: response.ok,
    code: body.success ? body.data.code : undefined,
    guildId: body.success ? (body.data.guild_id ?? null) : null,
  };
}
async function get(token: string, path: string): Promise<unknown> {
  const { status, body } = await request(token, path);
  if (status < 200 || status >= 300)
    throw new Error(`Discord inspection failed (${status}) for ${path}.`);
  return body;
}

const selfSchema = z.object({ id: idSchema, username: z.string(), bot: z.literal(true) });
const applicationSchema = z.object({
  id: idSchema,
  name: z.string(),
  flags: z.number().optional(),
});
const roleSchema = z.array(
  z.object({
    id: idSchema,
    name: z.string(),
    permissions: z.string(),
    position: z.number(),
    managed: z.boolean(),
    hoist: z.boolean(),
  }),
);

/** DevBot mode, for the devbot and staging profiles: unchanged behavior, behind the deployment guard. */
async function devbot(): Promise<void> {
  const config = configuration();
  if (!config.TEST_GUILD_ID)
    throw new Error("TEST_GUILD_ID is required for live development checks.");
  assertToolScope(process.env, {
    tool: "discord-inspect",
    guilds: [config.TEST_GUILD_ID],
    discord: "read",
    databases: [],
  });
  const token = config.DISCORD_TOKEN;

  // Application identity is checked before guild inspection or any later deployment operation.
  const self = selfSchema.parse(await get(token, "/users/@me"));
  const application = applicationSchema.parse(await get(token, "/oauth2/applications/@me"));
  if (
    application.id !== config.DISCORD_APPLICATION_ID ||
    self.id !== config.DISCORD_APPLICATION_ID
  ) {
    throw new Error("The configured application ID does not match the authenticated bot.");
  }
  if (self.username.toLowerCase() !== "devbot" && application.name.toLowerCase() !== "devbot") {
    throw new Error(
      "The authenticated application is not named DevBot; check the development credentials.",
    );
  }

  const guildId = config.TEST_GUILD_ID;
  const guild = z
    .object({ id: idSchema, name: z.string(), owner_id: idSchema })
    .parse(await get(token, `/guilds/${guildId}`));
  const member = z
    .object({ roles: z.array(idSchema) })
    .parse(await get(token, `/guilds/${guildId}/members/${self.id}`));
  const roles = roleSchema.parse(await get(token, `/guilds/${guildId}/roles`));
  const channels = z
    .array(z.object({ id: idSchema, name: z.string().optional(), type: z.number() }))
    .parse(await get(token, `/guilds/${guildId}/channels`));

  // Guild-level permissions are useful preflight evidence; channel overwrites are validated later.
  const held = roles.filter((role) => role.id === guildId || member.roles.includes(role.id));
  const permissions = new PermissionsBitField(
    held.reduce((bits, role) => bits | BigInt(role.permissions), 0n),
  );
  const database = new URL(config.DATABASE_URL);
  console.log(
    json(
      {
        bot: self,
        application,
        guild: { id: guild.id, name: guild.name },
        permissions: permissions.toArray(),
        administrator: permissions.has(PermissionFlagsBits.Administrator, false),
        heldRoles: held.map(({ id, name, position, managed }) => ({ id, name, position, managed })),
        roles: roles.map(({ id, name, position, managed }) => ({ id, name, position, managed })),
        textChannels: channels.filter((channel) => channel.type === 0),
        configuration: {
          effectsEnabled: config.ENABLE_EFFECTS,
          databaseHost: database.hostname,
          databasePort: database.port,
          databaseName: database.pathname.slice(1),
        },
      },
      2,
    ),
  );
}

/** Production/rehearsal arguments: the target guild plus the IDs to inspect. */
function productionArguments(argv: readonly string[]) {
  let guild: string | null = null;
  let dump: string | null = null;
  const roles: string[] = [];
  const channels: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === "--guild" && guild === null) guild = id(value);
    else if (flag === "--dump" && dump === null) dump = value;
    else if (flag === "--role") roles.push(id(value));
    else if (flag === "--channel") channels.push(id(value));
    else throw new Error(`Unexpected argument ${flag}.`);
  }
  if (!guild)
    throw new Error(
      "Use --guild GUILD_ID with --dump FINAL.sql, or repeatable --role ID / --channel ID.",
    );
  return { guild, dump, roles, channels };
}

/** Production/rehearsal mode: a GET-only inspection of the production application. */
async function production(): Promise<void> {
  const args = productionArguments(process.argv.slice(2));
  const deployment = assertToolScope(process.env, {
    tool: "discord-inspect",
    guilds: [args.guild],
    discord: "read",
    databases: [],
  });
  // DISCORD_TOKEN, or the file DISCORD_TOKEN_FILE names.
  const token = z.string().min(1).safeParse(secretSetting(process.env, "DISCORD_TOKEN"));
  if (!token.success) throw new Error("DISCORD_TOKEN is required.");
  const call = (path: string) => get(token.data, path);

  // Targets: the legacy guild row names the roles and channels the import will bind.
  const managedRoles: ManagedRoleTarget[] = args.roles.map((role) => ({ field: "role", id: role }));
  const channelTargets: ChannelTarget[] = args.channels.map((channel) => ({
    field: "channel",
    id: channel,
    imported: null,
  }));
  if (args.dump) {
    const legacy = readDump(await Bun.file(args.dump).text()).guilds.find(
      (row) => row.guild_id === args.guild,
    );
    if (!legacy) throw new Error(`Guild ${args.guild} is not in the dump.`);
    if (legacy.member_role_id) managedRoles.push({ field: "member", id: legacy.member_role_id });
    if (legacy.guest_role_id) managedRoles.push({ field: "guest", id: legacy.guest_role_id });
    for (const [field, value, imported] of [
      ["ledger", legacy.ledger_channel_id, true],
      ["officer_notifications", legacy.officer_notifications_channel_id, true],
      // Imports close guest applications: the legacy review channel is recorded, not applied.
      ["guest_applications", legacy.guest_application_channel_id, false],
    ] as const)
      if (value) channelTargets.push({ field, id: value, imported });
  }

  // Identity first: the token must be the production application before any guild is read.
  const self = selfSchema.parse(await call("/users/@me"));
  const application = applicationSchema.parse(await call("/oauth2/applications/@me"));
  assertAuthenticatedApplication(deployment, application.id);
  if (self.id !== application.id)
    throw new Error("The bot user does not belong to the authenticated application.");

  const guilds = z
    .array(z.object({ id: idSchema, name: z.string() }))
    .parse(await call("/users/@me/guilds"));
  const known = (guild: string) =>
    (deployments.production.guilds as readonly string[]).includes(guild)
      ? "production"
      : (deployments.devbot.guilds as readonly string[]).includes(guild)
        ? "devbot"
        : null;
  const guild = z
    .object({
      id: idSchema,
      name: z.string(),
      approximate_member_count: z.number().optional(),
    })
    .parse(await call(`/guilds/${args.guild}?with_counts=true`));
  const roles = roleSchema.parse(await call(`/guilds/${args.guild}/roles`));
  const channels = z
    .array(
      z.object({
        id: idSchema,
        name: z.string().optional(),
        type: z.number(),
        permission_overwrites: z
          .array(z.object({ id: idSchema, type: z.number(), allow: z.string(), deny: z.string() }))
          .optional(),
      }),
    )
    .parse(await call(`/guilds/${args.guild}/channels`));
  const member = z
    .object({ roles: z.array(idSchema) })
    .parse(await call(`/guilds/${args.guild}/members/${self.id}`));
  // A destination the list left out may be hidden or deleted; ask Discord, one GET each.
  const unlisted: Record<string, UnlistedState> = {};
  for (const channelId of unlistedTargets(channelTargets, channels)) {
    const state = unlistedState(await probeChannel(token.data, channelId), args.guild);
    if (state) unlisted[channelId] = state;
  }
  // Functional probe of the Server Members intent: listing members needs it.
  const probe = await request(token.data, `/guilds/${args.guild}/members?limit=1`);
  if (probe.status !== 200 && probe.status !== 403)
    throw new Error(`Discord inspection failed (${probe.status}) for the members probe.`);

  console.log(
    json(
      {
        mode: deployment.name,
        application: {
          id: application.id,
          name: application.name,
          intents: {
            guildMembers: memberIntent(application.flags),
            probe: probe.status === 200 ? "ok" : "forbidden",
          },
        },
        bot: { id: self.id, username: self.username },
        guilds: guilds.map(({ id, name }) => ({ id, name, known: known(id) })),
        target: {
          guild: {
            id: guild.id,
            name: guild.name,
            approximateMemberCount: guild.approximate_member_count ?? null,
          },
          ...targetReport({
            guildId: args.guild,
            roles,
            channels,
            bot: { id: self.id, roles: member.roles },
            managedRoles,
            channelTargets,
            unlisted,
          }),
        },
        commands: "Read back global and guild command scopes with dist/scripts/commands.js list.",
      },
      2,
    ),
  );
}

const profile = resolveDeployment(process.env).name;
// Staging runs DevBot's application in DevBot's test guild, so it gets DevBot's checks.
if (profile === "devbot" || profile === "staging") await devbot();
else if (profile === "production" || profile === "rehearsal") await production();
else
  throw new Error(
    "discord-inspect needs the devbot, staging, production or rehearsal profile; set TARUBOT_ENVIRONMENT to one of them.",
  );
