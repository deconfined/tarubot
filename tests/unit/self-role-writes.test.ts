/**
 * The gateway's self-service role writes (2.40.0): one REST call per role through the member
 * manager, removes before adds, Discord's audit-log reason for each, and the per-role refusals
 * that never fail the whole write: a role deleted since the check (10011) is skipped and counted,
 * and so is one that moved above TaruBot (50013 while TaruBot still has Manage Roles); without
 * Manage Roles the write waits as blocked, with a message naming no role. Only counts come back.
 * The SDK's guild manager is stubbed, so no Discord credentials are needed. Invented IDs.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  Collection,
  DiscordAPIError,
  PermissionFlagsBits as P,
  PermissionsBitField,
} from "discord.js";
import { DiscordGateway } from "../../src/discord/gateway.js";
import { jobOutcome } from "../../src/jobs/queue.js";
import { Failure } from "../../src/domain/values.js";

const GUILD = "100000000000000001";
const USER = "200000000000000001";
const ROLE = {
  pronoun: "100000000000000021",
  game: "100000000000000023",
  deleted: "100000000000000026",
  moved: "100000000000000027",
} as const;

/** Discord's answer to PUT or DELETE /guilds/{g}/members/{u}/roles/{r}. */
const discordError = (code: number, status: number, roleId: string) =>
  new DiscordAPIError(
    { code, message: "Raw Discord text that must never be shown" },
    code,
    status,
    "PUT",
    `/guilds/${GUILD}/members/${USER}/roles/${roleId}`,
    { body: undefined, files: undefined },
  );

const created: DiscordGateway[] = [];
afterEach(async () => {
  for (const gateway of created.splice(0)) await gateway.client.destroy();
});

/**
 * A gateway whose guild records every role write as `add:<role>:<reason>` or
 * `remove:<role>:<reason>`, answering with `refusals[role]` when set; `manages` is whether
 * TaruBot's freshly read member still has Manage Roles.
 */
function gatewayWith(refusals: Record<string, Error> = {}, manages = true) {
  const gateway = new DiscordGateway();
  created.push(gateway);
  const writes: string[] = [];
  let botReads = 0;
  const write =
    (kind: string) =>
    async (options: { user: string; role: string; reason?: string }): Promise<string> => {
      if (options.user !== USER) throw new Error("Wrong member");
      writes.push(`${kind}:${options.role}:${options.reason}`);
      const refusal = refusals[options.role];
      if (refusal) throw refusal;
      return USER;
    };
  const guild = {
    id: GUILD,
    members: {
      addRole: write("add"),
      removeRole: write("remove"),
      fetchMe: async (options?: { force?: boolean }) => {
        if (!options?.force) throw new Error("TaruBot's member must be read fresh");
        botReads++;
        return { permissions: new PermissionsBitField(manages ? P.ManageRoles : 0n) };
      },
    },
  };
  spyOn(gateway.client.guilds, "fetch").mockImplementation(async () => guild as never);
  return { gateway, writes, botReads: () => botReads };
}

const CHOSEN = "Chosen by the member on TaruBot's My roles page";

test("removes, then adds, one role at a time, with the member's reason", async () => {
  const { gateway, writes } = gatewayWith();
  expect(await gateway.selfRoles(GUILD, USER, [ROLE.game], [ROLE.pronoun], "chosen")).toEqual({
    added: 1,
    removed: 1,
    skipped: 0,
  });
  expect(writes).toEqual([`remove:${ROLE.pronoun}:${CHOSEN}`, `add:${ROLE.game}:${CHOSEN}`]);
  // Reconciliation's removals (owner decision Q3 B) say why in Discord's audit log.
  const access = gatewayWith();
  await access.gateway.selfRoles(GUILD, USER, [], [ROLE.game], "access");
  expect(access.writes).toEqual([
    `remove:${ROLE.game}:TaruBot access reconciliation: no Member or Guest role, and this self-service role opens channels`,
  ]);
  // Nothing to write: not even the guild is read.
  const idle = gatewayWith();
  expect(await idle.gateway.selfRoles(GUILD, USER, [], [], "chosen")).toEqual({
    added: 0,
    removed: 0,
    skipped: 0,
  });
  expect(idle.writes).toEqual([]);
});

test("a role deleted since the check (10011) is skipped and counted; the rest still apply", async () => {
  const { gateway, writes, botReads } = gatewayWith({
    [ROLE.deleted]: discordError(10011, 404, ROLE.deleted),
  });
  expect(
    await gateway.selfRoles(GUILD, USER, [ROLE.deleted, ROLE.game], [ROLE.pronoun], "chosen"),
  ).toEqual({ added: 1, removed: 1, skipped: 1 });
  expect(writes.map((entry) => entry.split(":")[1])).toEqual([
    ROLE.pronoun,
    ROLE.deleted,
    ROLE.game,
  ]);
  expect(botReads()).toBe(0);
});

test("50013 with Manage Roles still held: the role moved above TaruBot, so it is skipped", async () => {
  const { gateway, botReads } = gatewayWith({
    [ROLE.moved]: discordError(50013, 403, ROLE.moved),
  });
  expect(await gateway.selfRoles(GUILD, USER, [ROLE.game], [ROLE.moved], "chosen")).toEqual({
    added: 1,
    removed: 0,
    skipped: 1,
  });
  expect(botReads()).toBe(1);
});

test("50013 without Manage Roles blocks the whole write, naming no role", async () => {
  const { gateway, writes } = gatewayWith(
    { [ROLE.pronoun]: discordError(50013, 403, ROLE.pronoun) },
    false,
  );
  const error = await gateway.selfRoles(GUILD, USER, [ROLE.game], [ROLE.pronoun], "chosen").then(
    () => new Error("Expected a refusal"),
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Failure);
  if (!(error instanceof Failure)) return;
  expect(error.code).toBe("blocked");
  expect(error.message).toBe(
    "TaruBot needs Manage Roles to change roles in this server. Check its role with /config validate.",
  );
  // The add never ran: the job waits like any server-wide problem, its diagnostic role-free.
  expect(writes).toHaveLength(1);
  const outcome = jobOutcome(error, 1);
  expect(outcome).toMatchObject({ status: "blocked", category: "blocked" });
  for (const roleId of Object.values(ROLE)) expect(outcome.diagnostic).not.toContain(roleId);
});

test("any other Discord refusal propagates for the queue to classify", async () => {
  const { gateway } = gatewayWith({ [ROLE.game]: discordError(50001, 403, ROLE.game) });
  const error = await gateway.selfRoles(GUILD, USER, [ROLE.game], [], "chosen").then(
    () => new Error("Expected a refusal"),
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DiscordAPIError);
  // The queue keeps only Discord's code: the request path, which names the role, is never stored.
  const outcome = jobOutcome(error, 1);
  expect(outcome.diagnostic).not.toContain(ROLE.game);
  expect(outcome.source).toBe("DiscordAPIError[50001]");
});

test("cachedRoles reads the gateway's member cache and never Discord", () => {
  const gateway = new DiscordGateway();
  created.push(gateway);
  const member = {
    roles: {
      cache: new Collection([
        [ROLE.game, {}],
        [GUILD, {}],
      ]),
    },
  };
  const guild = { members: { cache: new Collection([[USER, member]]) } };
  gateway.client.guilds.cache.set(GUILD, guild as never);
  expect(gateway.cachedRoles(GUILD, USER)).toEqual([ROLE.game, GUILD]);
  expect(gateway.cachedRoles(GUILD, "200000000000000002")).toBeNull();
  expect(gateway.cachedRoles("100000000000000002", USER)).toBeNull();
});
