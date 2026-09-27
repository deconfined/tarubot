/**
 * The maintenance-tool deployment guard: profile inference, identity and test-scope rules, guild
 * ownership, database endpoints per profile, the env-file launch check, the staging profile (#50)
 * and the tracked production and staging env templates, and the file-delivered secrets (2.33.0).
 * Every refusal is checked to be a configuration Failure that never echoes a secret.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAuthenticatedApplication,
  assertToolScope,
  AUTOLOADED_ENV_FILES,
  databaseIdentity,
  deployments,
  type Environment,
  type Launch,
  localDatabaseHost,
  PRODUCTION_DATABASES,
  resolveDeployment,
  restoreCertificate,
  STAGING_DATABASE,
  type ToolScope,
} from "../../src/config/deployment.js";
import { Failure } from "../../src/domain/values.js";
import { SCHEMA_VERSION } from "../../src/infrastructure/postgres/database.js";
import { activateToolScope, parseActivateArguments } from "../../scripts/activate.js";
import { restoreArguments, restoreToolScope } from "../../scripts/check-restore.js";
import { migrateArguments, migrateToolScope } from "../../scripts/migrate.js";
import { parsePreviewArguments, previewToolScope } from "../../scripts/preview.js";
import { registerToolScope, registrationScope } from "../../scripts/register.js";

const PRODUCTION_APP = deployments.production.applicationId;
const PRODUCTION_GUILD = deployments.production.guilds[0];
const DEVBOT_APP = deployments.devbot.applicationId;
const DEV_GUILD = deployments.devbot.guilds[0];
/** Sentinels stand in for credentials; no refusal may contain them. */
const PASSWORD = "sentinel-password-5b0f";
const TOKEN = "sentinel-token-9c1e";
const CA = "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----";
/** Placeholder managed-cluster hosts (reserved .example names): the primary and a PITR fork. */
const MANAGED = "primary.managed-db.example";
const FORK = "fork.managed-db.example";
/** A managed-cluster URL, by default as production uses it: the direct port 27520 as tarubot. */
const managedUrl = (name: string, host = MANAGED, user = "tarubot", port = 27520) =>
  `postgresql://${user}:${PASSWORD}@${host}:${port}/${name}?sslmode=require`;
const localUrl = (name: string, host = "localhost") =>
  `postgresql://tarubot:${PASSWORD}@${host}:5432/${name}`;

/** The shape of DevBot's local .env once its DATABASE_URL names tarubot_dev. */
const devbotEnv = (overrides: Environment = {}): Environment => ({
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: DEVBOT_APP,
  TEST_GUILD_ID: DEV_GUILD,
  PUBLIC_TEST_RESPONSES: "true",
  DATABASE_URL: localUrl("tarubot_dev"),
  DATABASE_CA_CERT: "",
  ...overrides,
});
/** A filled-in production.env. */
const productionEnv = (overrides: Environment = {}): Environment => ({
  TARUBOT_ENVIRONMENT: "production",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: PRODUCTION_APP,
  TEST_GUILD_ID: "",
  PUBLIC_TEST_RESPONSES: "false",
  TEST_PLAN_CHANNEL_ID: "",
  DATABASE_URL: managedUrl("tarubot"),
  DATABASE_CA_CERT: CA,
  ...overrides,
});
/** The production file with the rehearsal overrides given on the command line. */
const rehearsalEnv = (overrides: Environment = {}): Environment =>
  productionEnv({
    TARUBOT_ENVIRONMENT: "rehearsal",
    DATABASE_URL: localUrl("tarubot_rehearsal"),
    DATABASE_CA_CERT: "",
    ...overrides,
  });

/**
 * The staging container's settings (#50): the host's .env (staging.env.example, filled in) with the
 * staging target's fixed values (ops/quadlet/staging/target.env): DevBot's application in its test
 * guild, public test replies, and staging's own database and role on the managed cluster.
 */
const stagingEnv = (overrides: Environment = {}): Environment => ({
  TARUBOT_ENVIRONMENT: "staging",
  DISCORD_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: DEVBOT_APP,
  TEST_GUILD_ID: DEV_GUILD,
  PUBLIC_TEST_RESPONSES: "true",
  TEST_PLAN_CHANNEL_ID: "",
  DATABASE_URL: managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE),
  DATABASE_CA_CERT: CA,
  ...overrides,
});

/** Launched as the runbook says: bun --env-file=PATH dist/scripts/<tool>.js, from a checkout. */
const direct: Launch = {
  execArgv: ["--env-file=/home/operator/production.env"],
  envFiles: [".env"],
};
/** Inside a bot container (staging's tools, a deploy's commands): no env file in its directory. */
const container: Launch = { execArgv: [], envFiles: [] };

/**
 * Each tool's scope exactly as the script declares it: its exported builder over its real argument
 * parser, so a drifting declaration (a dropped registerScope, a wrong Discord level, a missing
 * database) fails these tests. import.js runs its guard at top level and cannot be imported, so its
 * scope is the one copy kept by hand.
 */
const scope = {
  preview: (guild: string): ToolScope => previewToolScope(parsePreviewArguments([guild])),
  /** preview.js --late-joiners reads only PostgreSQL. */
  lateJoiners: (guild: string): ToolScope =>
    previewToolScope(parsePreviewArguments([guild, "--late-joiners"])),
  activate: (guild: string): ToolScope => activateToolScope(parseActivateArguments([guild])),
  import: (guild: string): ToolScope => ({
    tool: "import",
    guilds: [guild],
    discord: "none",
    databases: ["DATABASE_URL"],
  }),
  migrate: migrateToolScope(migrateArguments([])),
  /** migrate.js --restore-rehearsal. */
  rehearseMigration: migrateToolScope(migrateArguments(["--restore-rehearsal"])),
  /** register.js --guild GUILD or, without a guild, --global. */
  register: (guild?: string): ToolScope =>
    registerToolScope(registrationScope(guild ? ["--guild", guild] : ["--global"], {})),
  restore: restoreToolScope(),
} satisfies Record<string, ToolScope | ((guild: string) => ToolScope)>;

/** Assert a configuration refusal whose message contains `fragment` and no credential. */
function refused(action: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Failure);
  if (!(caught instanceof Failure)) return;
  expect(caught.code).toBe("configuration");
  expect(caught.message).toContain(fragment);
  expect(caught.message).not.toContain(PASSWORD);
  expect(caught.message).not.toContain(TOKEN);
  expect(caught.message).not.toContain("postgresql://");
}

describe("profiles", () => {
  test("(a) a DevBot .env infers devbot and may preview the dev guild", () => {
    expect(resolveDeployment(devbotEnv()).name).toBe("devbot");
    const deployment = assertToolScope(devbotEnv(), scope.preview(DEV_GUILD), direct);
    expect(deployment).toMatchObject({
      name: "devbot",
      applicationId: DEVBOT_APP,
      registrationScope: DEV_GUILD,
    });
  });

  test("(b) the DevBot .env cannot touch the production guild", () => {
    for (const tool of [
      scope.preview(PRODUCTION_GUILD),
      scope.lateJoiners(PRODUCTION_GUILD),
      scope.activate(PRODUCTION_GUILD),
      scope.import(PRODUCTION_GUILD),
    ])
      refused(() => assertToolScope(devbotEnv(), tool, direct), `guild ${PRODUCTION_GUILD}`);
  });

  test("(c) production credentials need an explicit marker", () => {
    const env = productionEnv({ TARUBOT_ENVIRONMENT: "" });
    refused(() => resolveDeployment(env), "TARUBOT_ENVIRONMENT=production or rehearsal");
    refused(() => assertToolScope(env, scope.migrate, direct), "TARUBOT_ENVIRONMENT");
    // The marker closes on unknown values; `staging` is a profile of its own (below).
    refused(
      () => resolveDeployment({ ...env, TARUBOT_ENVIRONMENT: "prod" }),
      "TARUBOT_ENVIRONMENT",
    );
  });

  test("(d) production refuses leaked development scoping", () => {
    for (const [key, value] of [
      ["TEST_GUILD_ID", DEV_GUILD],
      ["PUBLIC_TEST_RESPONSES", "true"],
      ["TEST_PLAN_CHANNEL_ID", "1040379370931507252"],
    ] as const)
      refused(() => assertToolScope(productionEnv({ [key]: value }), scope.migrate, direct), key);
    expect(assertToolScope(productionEnv(), scope.migrate, direct).name).toBe("production");
  });

  test("(f) crossed applications and guilds are refused in both directions", () => {
    refused(
      () =>
        assertToolScope(
          productionEnv({ DISCORD_APPLICATION_ID: DEVBOT_APP }),
          scope.migrate,
          direct,
        ),
      `production application ${PRODUCTION_APP}`,
    );
    refused(
      () => assertToolScope(productionEnv(), scope.preview(DEV_GUILD), direct),
      `guild ${DEV_GUILD}`,
    );
    refused(
      () =>
        assertToolScope(
          devbotEnv({ TARUBOT_ENVIRONMENT: "devbot", DISCORD_APPLICATION_ID: PRODUCTION_APP }),
          scope.preview(DEV_GUILD),
          direct,
        ),
      `DevBot's application ${DEVBOT_APP}`,
    );
    // Discord use under the production profile needs the application ID to be configured.
    refused(
      () =>
        assertToolScope(
          productionEnv({ DISCORD_APPLICATION_ID: "" }),
          scope.preview(PRODUCTION_GUILD),
          direct,
        ),
      "DISCORD_APPLICATION_ID",
    );
    refused(
      () => assertToolScope(devbotEnv({ TEST_GUILD_ID: "" }), scope.migrate, direct),
      "TEST_GUILD_ID",
    );
  });

  test("(j) unmanaged environments (CI, other developers) may not touch a known guild", () => {
    const env: Environment = {
      DISCORD_APPLICATION_ID: "123",
      DATABASE_URL: localUrl("tarubot"),
    };
    expect(resolveDeployment(env).name).toBe("unmanaged");
    for (const guild of [PRODUCTION_GUILD, DEV_GUILD])
      refused(() => assertToolScope(env, scope.preview(guild), direct), "managed deployment");
    expect(assertToolScope(env, scope.preview("4242"), direct).name).toBe("unmanaged");
    // A DB-only environment (no marker, no application ID) is unmanaged even against a managed URL.
    // The production host's container sets TARUBOT_ENVIRONMENT=production
    // (production-compose.test.ts), which selects the production profile instead.
    expect(
      assertToolScope({ DATABASE_URL: managedUrl("tarubot") }, scope.migrate, {
        execArgv: [],
        envFiles: [],
      }).name,
    ).toBe("unmanaged");
  });

  test("(k) DevBot never registers global commands", () => {
    refused(
      () => assertToolScope(devbotEnv(), scope.register(), direct),
      "global command registration",
    );
    expect(assertToolScope(devbotEnv(), scope.register(DEV_GUILD), direct).name).toBe("devbot");
  });

  test("(o) production registers only globally; unmanaged may register any unmanaged scope", () => {
    // A production guild-scope registration would show every command twice beside the global set.
    refused(
      () => assertToolScope(productionEnv(), scope.register(PRODUCTION_GUILD), direct),
      "only in the global scope (--global)",
    );
    expect(assertToolScope(productionEnv(), scope.register(), direct).name).toBe("production");
    const unmanaged: Environment = { DISCORD_APPLICATION_ID: "123" };
    expect(assertToolScope(unmanaged, scope.register("4242"), direct).name).toBe("unmanaged");
    expect(assertToolScope(unmanaged, scope.register(), direct).name).toBe("unmanaged");
  });
});

describe("databases", () => {
  test("(e) production uses the managed cluster over verified TLS", () => {
    expect(assertToolScope(productionEnv(), scope.import(PRODUCTION_GUILD), direct).name).toBe(
      "production",
    );
    for (const [url, fragment] of [
      [localUrl("tarubot"), "is local"],
      [localUrl("tarubot", "127.0.0.1"), "is local"],
      [localUrl("tarubot", "postgres"), "is local"],
      [managedUrl("tarubot_dev"), "not a production database"],
      [managedUrl("tarubot_restore_test"), "not a production database"],
      [managedUrl("tarubot_rehearsal"), "not a production database"],
    ] as const)
      refused(
        () =>
          assertToolScope(
            productionEnv({ DATABASE_URL: url }),
            scope.import(PRODUCTION_GUILD),
            direct,
          ),
        fragment,
      );
    refused(
      () => assertToolScope(productionEnv({ DATABASE_CA_CERT: "" }), scope.migrate, direct),
      "DATABASE_CA_CERT",
    );
    refused(
      () => assertToolScope(productionEnv({ DATABASE_CA_CERT: "  " }), scope.migrate, direct),
      "DATABASE_CA_CERT",
    );
  });

  test("(C6b) managed endpoints need the direct port and the tarubot application user", () => {
    // Production runs on Linode managed PostgreSQL (direct port 27520) since 2026-09-24.
    expect(
      assertToolScope(
        productionEnv({ DATABASE_URL: managedUrl("tarubot", MANAGED, "tarubot", 27520) }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("production");
    // Every other port gets the same refusal, which names the one direct port and never assumes
    // the URL named a pool.
    const directPort =
      "must use the managed cluster's direct port 27520 (never its 27521 pool or any other port).";
    for (const [url, fragment] of [
      // The 27521 connection pool can't hold the writer lease; a URL without a port means 5432.
      [managedUrl("tarubot", MANAGED, "tarubot", 27521), directPort],
      [`postgresql://tarubot:${PASSWORD}@${MANAGED}/tarubot`, directPort],
      [managedUrl("tarubot", MANAGED, "akmadmin"), "not an administrator"],
      [managedUrl("tarubot", MANAGED, "someone"), "tarubot user"],
      [`postgresql://${MANAGED}:27520/tarubot`, "not an administrator"],
      // 2.30.1 dropped the deleted DigitalOcean cluster: its direct port 25060 and pool 25061 are
      // now refused like any other port.
      [managedUrl("tarubot", MANAGED, "tarubot", 25060), directPort],
      [managedUrl("tarubot", MANAGED, "tarubot", 25061), directPort],
    ] as const)
      refused(
        () => assertToolScope(productionEnv({ DATABASE_URL: url }), scope.migrate, direct),
        fragment,
      );
    // A rehearsal on the managed cluster: any application user, never akmadmin, direct port.
    expect(
      assertToolScope(
        rehearsalEnv({
          DATABASE_URL: managedUrl("tarubot_rehearsal", MANAGED, "rehearser"),
          DATABASE_CA_CERT: CA,
        }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("rehearsal");
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({
            DATABASE_URL: managedUrl("tarubot_rehearsal", MANAGED, "akmadmin"),
            DATABASE_CA_CERT: CA,
          }),
          scope.migrate,
          direct,
        ),
      "not an administrator",
    );
  });

  test("(g) a rehearsal uses a disposable *_rehearsal database and is read-only on Discord", () => {
    // Preview, the late-joiner report and activation only read Discord, so a rehearsal may run them.
    for (const tool of [
      scope.preview(PRODUCTION_GUILD),
      scope.lateJoiners(PRODUCTION_GUILD),
      scope.activate(PRODUCTION_GUILD),
    ])
      expect(assertToolScope(rehearsalEnv(), tool, direct).name).toBe("rehearsal");
    expect(
      assertToolScope(
        rehearsalEnv({ DATABASE_URL: managedUrl("tarubot_rehearsal"), DATABASE_CA_CERT: CA }),
        scope.preview(PRODUCTION_GUILD),
        direct,
      ).name,
    ).toBe("rehearsal");
    for (const [overrides, fragment] of [
      [{ DATABASE_URL: localUrl("tarubot_dev") }, "*_rehearsal"],
      [{ DATABASE_URL: managedUrl("tarubot"), DATABASE_CA_CERT: CA }, "*_rehearsal"],
      [{ DATABASE_URL: managedUrl("tarubot_rehearsal") }, "CA certificate"],
    ] as const)
      refused(
        () => assertToolScope(rehearsalEnv(overrides), scope.preview(PRODUCTION_GUILD), direct),
        fragment,
      );
    refused(
      () => assertToolScope(rehearsalEnv(), scope.register(), direct),
      "global command registration",
    );
    refused(
      () => assertToolScope(rehearsalEnv(), scope.register(PRODUCTION_GUILD), direct),
      "read-only on Discord",
    );
  });

  test("(C5) DevBot's tools use exactly tarubot_dev on this machine or the Compose service", () => {
    // The owner's current .env shape (…/tarubot) is refused until it names tarubot_dev.
    refused(
      () =>
        assertToolScope(devbotEnv({ DATABASE_URL: localUrl("tarubot") }), scope.migrate, direct),
      "tarubot_dev",
    );
    expect(assertToolScope(devbotEnv(), scope.migrate, direct).name).toBe("devbot");
    // docker-compose.devbot.yml's container environment.
    expect(
      assertToolScope(
        devbotEnv({ DATABASE_URL: localUrl("tarubot_dev", "postgres") }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("devbot");
    // The base Compose file (no DevBot overlay) with DevBot's credentials migrates `tarubot`.
    refused(
      () =>
        assertToolScope(
          devbotEnv({ DATABASE_URL: localUrl("tarubot", "postgres") }),
          scope.migrate,
          direct,
        ),
      "tarubot_dev",
    );
    refused(
      () =>
        assertToolScope(
          devbotEnv({ DATABASE_URL: managedUrl("tarubot_dev") }),
          scope.migrate,
          direct,
        ),
      "DevBot's local database",
    );
    refused(
      () => assertToolScope(devbotEnv({ DATABASE_CA_CERT: CA }), scope.migrate, direct),
      "must be empty",
    );
  });

  test("(C5) only migrate --restore-rehearsal may target DevBot's *_restore_test copy", () => {
    const copy = devbotEnv({ DATABASE_URL: localUrl("tarubot_dev_restore_test", "postgres") });
    // Without the flag, DevBot's primary is exactly tarubot_dev.
    refused(() => assertToolScope(copy, scope.migrate, direct), "tarubot_dev");
    expect(assertToolScope(copy, scope.rehearseMigration, direct).name).toBe("devbot");
    // The flag never reaches a live database, and guild tools still require tarubot_dev.
    for (const name of ["tarubot_dev", "tarubot"])
      refused(
        () =>
          assertToolScope(
            devbotEnv({ DATABASE_URL: localUrl(name, "postgres") }),
            scope.rehearseMigration,
            direct,
          ),
        "*_restore_test copy with --restore-rehearsal",
      );
    refused(() => assertToolScope(copy, scope.import(DEV_GUILD), direct), "tarubot_dev");
    // The production application rehearses migrations in *_rehearsal instead.
    for (const env of [
      productionEnv({ DATABASE_URL: managedUrl("tarubot_restore_test") }),
      rehearsalEnv({ DATABASE_URL: localUrl("tarubot_restore_test") }),
    ])
      refused(() => assertToolScope(env, scope.rehearseMigration, direct), "--restore-rehearsal");
    // migrate.js accepts only this one flag, before any I/O.
    expect(migrateArguments([])).toEqual({ restoreRehearsal: false });
    expect(migrateArguments(["--restore-rehearsal"])).toEqual({ restoreRehearsal: true });
    for (const argv of [["--restore-rehearsal", "--restore-rehearsal"], ["--global"], ["x"]])
      expect(() => migrateArguments(argv)).toThrow(Failure);
  });

  test("(i, C6c) check-restore validates both URLs and each profile's restore targets", () => {
    const production = (restore: string, overrides: Environment = {}) =>
      productionEnv({ RESTORE_DATABASE_URL: restore, ...overrides });
    // A PITR fork is another cluster holding `tarubot`; a same-cluster restore is tarubot_restore.
    expect(
      assertToolScope(production(managedUrl("tarubot", FORK)), scope.restore, direct).name,
    ).toBe("production");
    expect(
      assertToolScope(production(managedUrl("tarubot_restore")), scope.restore, direct).name,
    ).toBe("production");
    expect(
      assertToolScope(
        production(managedUrl("tarubot", FORK), { RESTORE_DATABASE_CA_CERT: "fork-ca" }),
        scope.restore,
        direct,
      ).name,
    ).toBe("production");
    for (const [restore, fragment] of [
      [managedUrl("tarubot"), "different database"],
      [managedUrl("tarubot_restore_test"), "tarubot_restore on the primary's host"],
      [managedUrl("tarubot_restore", FORK), "tarubot on a PITR fork"],
      [managedUrl("tarubot", FORK, "akmadmin"), "not an administrator"],
      [localUrl("tarubot_restore"), "is local"],
    ] as const)
      refused(() => assertToolScope(production(restore), scope.restore, direct), fragment);
    refused(() => assertToolScope(productionEnv(), scope.restore, direct), "RESTORE_DATABASE_URL");

    expect(
      assertToolScope(
        rehearsalEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_restore_test") }),
        scope.restore,
        direct,
      ).name,
    ).toBe("rehearsal");
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_restore") }),
          scope.restore,
          direct,
        ),
      "*_restore_test",
    );
    expect(
      assertToolScope(
        devbotEnv({ RESTORE_DATABASE_URL: localUrl("tarubot_dev_restore_test") }),
        scope.restore,
        direct,
      ).name,
    ).toBe("devbot");
    refused(
      () =>
        assertToolScope(
          devbotEnv({ RESTORE_DATABASE_URL: localUrl("tarubot") }),
          scope.restore,
          direct,
        ),
      "*_restore_test",
    );
  });

  test("(#50) production's primary is tarubot or tarubot_restore, so a restore can be repointed", () => {
    // docs/HOSTING.md "Restoring a dump": restore into tarubot_restore, check it, then point the
    // bot (and so every later deploy's migrate and register steps) at it.
    expect(
      assertToolScope(
        productionEnv({ RESTORE_DATABASE_URL: managedUrl("tarubot_restore") }),
        scope.restore,
        direct,
      ).name,
    ).toBe("production");
    const repointed = productionEnv({ DATABASE_URL: managedUrl("tarubot_restore") });
    for (const tool of [scope.migrate, scope.register(), scope.import(PRODUCTION_GUILD)])
      expect(assertToolScope(repointed, tool, container).name).toBe("production");
    // A repointed bot's own check against a PITR fork still expects tarubot on the fork.
    expect(
      assertToolScope(
        { ...repointed, RESTORE_DATABASE_URL: managedUrl("tarubot", FORK) },
        scope.restore,
        direct,
      ).name,
    ).toBe("production");
    // A PITR fork the bot was repointed at holds tarubot on another host.
    expect(
      assertToolScope(
        productionEnv({ DATABASE_URL: managedUrl("tarubot", FORK) }),
        scope.migrate,
        direct,
      ).name,
    ).toBe("production");
    expect(PRODUCTION_DATABASES).toEqual(["tarubot", "tarubot_restore"]);
    // Any other name on the cluster is refused, the provider's defaults included.
    for (const name of ["tarubot_old", "tarubot2", "defaultdb", "postgres", "tarubot_restore_2"])
      refused(
        () =>
          assertToolScope(productionEnv({ DATABASE_URL: managedUrl(name) }), scope.migrate, direct),
        "not a production database (tarubot or tarubot_restore)",
      );
  });

  test("(#50) the production application refuses every tarubot_staging database and user", () => {
    const belongs = "belongs to staging (tarubot_staging), never to production";
    // As the primary, by database or by user; the last two are staging's own URL, as a staging .env
    // on a host that linked production's target would give it. (register.js and commands.js use no
    // database; there the token check refuses DevBot's token against production's application.)
    for (const url of [
      managedUrl(STAGING_DATABASE),
      managedUrl(`${STAGING_DATABASE}_restore`),
      managedUrl("tarubot", MANAGED, STAGING_DATABASE),
      managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE),
      managedUrl(STAGING_DATABASE, FORK, STAGING_DATABASE),
    ])
      for (const tool of [scope.migrate, scope.import(PRODUCTION_GUILD)])
        refused(() => assertToolScope(productionEnv({ DATABASE_URL: url }), tool, direct), belongs);
    // As check-restore's target, on the primary's cluster or a fork.
    for (const restore of [managedUrl(STAGING_DATABASE), managedUrl(STAGING_DATABASE, FORK)])
      refused(
        () =>
          assertToolScope(productionEnv({ RESTORE_DATABASE_URL: restore }), scope.restore, direct),
        belongs,
      );
    // A rehearsal's disposable names can't borrow staging's prefix either.
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({
            DATABASE_URL: managedUrl(`${STAGING_DATABASE}_rehearsal`),
            DATABASE_CA_CERT: CA,
          }),
          scope.migrate,
          direct,
        ),
      belongs,
    );
    refused(
      () =>
        assertToolScope(
          rehearsalEnv({ RESTORE_DATABASE_URL: localUrl(`${STAGING_DATABASE}_restore_test`) }),
          scope.restore,
          direct,
        ),
      belongs,
    );
  });

  test("an empty restore CA line falls back to DATABASE_CA_CERT", () => {
    expect(restoreCertificate({ DATABASE_CA_CERT: CA })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: "" })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: " \n" })).toBe(CA);
    expect(restoreCertificate({ DATABASE_CA_CERT: CA, RESTORE_DATABASE_CA_CERT: "fork" })).toBe(
      "fork",
    );
    expect(restoreCertificate({})).toBeUndefined();
  });

  test("database identities never carry the password and refuse redirecting parameters", () => {
    expect(databaseIdentity(managedUrl("tarubot"))).toEqual({
      host: MANAGED,
      port: 27520,
      name: "tarubot",
      user: "tarubot",
    });
    expect(databaseIdentity("postgresql://u:p@LOCALHOST/tarubot_dev")).toMatchObject({
      host: "localhost",
      port: 5432,
    });
    expect(databaseIdentity("postgres://u@[::1]:5433/db").host).toBe("::1");
    for (const url of [
      `postgresql://tarubot:${PASSWORD}@[broken/tarubot`,
      `mysql://tarubot:${PASSWORD}@${MANAGED}:27520/tarubot`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:27520/`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:27520/tarubot?host=localhost`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:27520/tarubot?port=5432`,
      `postgresql://tarubot:${PASSWORD}@${MANAGED}:27520/tarubot?user=akmadmin`,
    ])
      refused(() => databaseIdentity(url), "DATABASE_URL");
    for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "postgres", "db.localhost"])
      expect(localDatabaseHost(host)).toBe(true);
    for (const host of [MANAGED, "10.0.0.5", "postgres.example"])
      expect(localDatabaseHost(host)).toBe(false);
  });
});

describe("launch and identity", () => {
  test("(h, C6a) production and rehearsal refuse auto-loaded env files without --env-file", () => {
    const plain = (envFiles: readonly string[]): Launch => ({ execArgv: [], envFiles });
    for (const file of AUTOLOADED_ENV_FILES)
      for (const env of [productionEnv(), rehearsalEnv()])
        refused(() => assertToolScope(env, scope.migrate, plain([file])), file);
    for (const execArgv of [["--env-file=/x"], ["--env-file", "/x"], ["--no-env-file"]])
      expect(
        assertToolScope(productionEnv(), scope.migrate, { execArgv, envFiles: [".env"] }).name,
      ).toBe("production");
    // Containers have no env files in their working directory.
    expect(assertToolScope(productionEnv(), scope.migrate, plain([])).name).toBe("production");
    // DevBot and unmanaged tools are expected to read the checkout's .env.
    expect(assertToolScope(devbotEnv(), scope.migrate, plain([".env"])).name).toBe("devbot");
  });

  test("(l) refusals name settings only, even for unparseable settings", () => {
    refused(
      () =>
        assertToolScope({ ...devbotEnv(), DISCORD_APPLICATION_ID: TOKEN }, scope.migrate, direct),
      "DISCORD_APPLICATION_ID",
    );
    refused(
      () =>
        assertToolScope(
          productionEnv({ DATABASE_URL: `postgresql://tarubot:${PASSWORD}@${MANAGED}:bad/x` }),
          scope.migrate,
          direct,
        ),
      "DATABASE_URL",
    );
  });

  test("(m) the authenticated application must be the profile's", () => {
    const production = assertToolScope(productionEnv(), scope.preview(PRODUCTION_GUILD), direct);
    expect(() => assertAuthenticatedApplication(production, PRODUCTION_APP)).not.toThrow();
    refused(() => assertAuthenticatedApplication(production, DEVBOT_APP), PRODUCTION_APP);
    refused(() => assertAuthenticatedApplication(production, undefined), "did not report");
    // An unmanaged env cannot use a managed deployment's token, even without an application ID.
    const unmanaged = resolveDeployment({});
    expect(() => assertAuthenticatedApplication(unmanaged, "4242")).not.toThrow();
    for (const known of [PRODUCTION_APP, DEVBOT_APP])
      refused(() => assertAuthenticatedApplication(unmanaged, known), "managed application");
  });

  test("(C7) command-scope clearing allows the application's guilds except its own registration", () => {
    const clear = (guild: string): ToolScope => ({
      tool: "commands clear-guild",
      guilds: [],
      commandGuilds: [guild],
      discord: "write",
      databases: [],
    });
    // Production's commands are global, so leftovers in DevBot's guild may be cleared.
    expect(assertToolScope(productionEnv(), clear(DEV_GUILD), direct).name).toBe("production");
    refused(
      () => assertToolScope(devbotEnv(), clear(DEV_GUILD), direct),
      "own command registration",
    );
    refused(() => assertToolScope(rehearsalEnv(), clear(DEV_GUILD), direct), "read-only");
    refused(
      () => assertToolScope({ DISCORD_APPLICATION_ID: "123" }, clear(PRODUCTION_GUILD), direct),
      "managed deployment",
    );
  });
});

describe("staging (#50)", () => {
  test("the staging marker selects DevBot's identity, checked before the application-ID inference", () => {
    expect(resolveDeployment(stagingEnv())).toEqual({
      name: "staging",
      applicationId: DEVBOT_APP,
      guilds: [DEV_GUILD],
      registrationScope: DEV_GUILD,
    });
    // Only the marker selects staging: DevBot's application alone still means the local profile.
    expect(resolveDeployment(stagingEnv({ TARUBOT_ENVIRONMENT: "" })).name).toBe("devbot");
    expect(resolveDeployment(stagingEnv({ TARUBOT_ENVIRONMENT: undefined })).name).toBe("devbot");
    expect(resolveDeployment(devbotEnv({ TARUBOT_ENVIRONMENT: "devbot" })).name).toBe("devbot");
    expect(assertToolScope(stagingEnv(), scope.migrate, container)).toMatchObject({
      name: "staging",
      applicationId: DEVBOT_APP,
    });
  });

  test("staging runs DevBot's application, scoped to its test guild", () => {
    const devbotApplication = `DevBot's application ${DEVBOT_APP}`;
    // The production application (a staging .env beside production's identity), none, or another.
    for (const application of [PRODUCTION_APP, "", "123"])
      refused(
        () =>
          assertToolScope(
            stagingEnv({ DISCORD_APPLICATION_ID: application }),
            scope.migrate,
            container,
          ),
        devbotApplication,
      );
    refused(
      () =>
        assertToolScope(
          productionEnv({ TARUBOT_ENVIRONMENT: "staging" }),
          scope.preview(PRODUCTION_GUILD),
          container,
        ),
      devbotApplication,
    );
    // Development scoping is required, and it is DevBot's test guild.
    for (const guild of ["", PRODUCTION_GUILD, "4242"])
      refused(
        () => assertToolScope(stagingEnv({ TEST_GUILD_ID: guild }), scope.migrate, container),
        `TEST_GUILD_ID must be DevBot's test guild ${DEV_GUILD}`,
      );
    // Public replies and a test-plan channel are allowed, as on DevBot.
    for (const overrides of [
      { PUBLIC_TEST_RESPONSES: "true" },
      { PUBLIC_TEST_RESPONSES: "false" },
      { TEST_PLAN_CHANNEL_ID: "1040379370931507252" },
    ])
      expect(assertToolScope(stagingEnv(overrides), scope.migrate, container).name).toBe("staging");
  });

  test("staging's tools touch only the test guild", () => {
    for (const tool of [
      scope.preview(DEV_GUILD),
      scope.lateJoiners(DEV_GUILD),
      scope.activate(DEV_GUILD),
      scope.import(DEV_GUILD),
    ])
      expect(assertToolScope(stagingEnv(), tool, container).name).toBe("staging");
    for (const guild of [PRODUCTION_GUILD, "4242"])
      for (const tool of [
        scope.preview(guild),
        scope.lateJoiners(guild),
        scope.activate(guild),
        scope.import(guild),
      ])
        refused(() => assertToolScope(stagingEnv(), tool, container), `guild ${guild}`);
  });

  test("staging registers only in the test guild and may write to Discord there", () => {
    expect(assertToolScope(stagingEnv(), scope.register(DEV_GUILD), container).name).toBe(
      "staging",
    );
    refused(
      () => assertToolScope(stagingEnv(), scope.register(), container),
      "global command registration belongs to the production profile",
    );
    refused(
      () => assertToolScope(stagingEnv(), scope.register(PRODUCTION_GUILD), container),
      `guild ${PRODUCTION_GUILD}`,
    );
    // A Discord write in the test guild, such as a probe message, is allowed (never for rehearsal).
    const write: ToolScope = {
      tool: "probe",
      guilds: [DEV_GUILD],
      discord: "write",
      databases: [],
    };
    expect(assertToolScope(stagingEnv(), write, container).name).toBe("staging");
    // Command-scope clearing: never the test guild's own registration; another guild the
    // application belongs to (confirmed by the tool after login) is allowed.
    const clear = (guild: string): ToolScope => ({
      tool: "commands clear-guild",
      guilds: [],
      commandGuilds: [guild],
      discord: "write",
      databases: [],
    });
    refused(
      () => assertToolScope(stagingEnv(), clear(DEV_GUILD), container),
      "own command registration",
    );
    expect(assertToolScope(stagingEnv(), clear("4242"), container).name).toBe("staging");
  });

  test("staging uses exactly tarubot_staging, as tarubot_staging, on the managed cluster", () => {
    for (const tool of [scope.migrate, scope.import(DEV_GUILD), scope.activate(DEV_GUILD)])
      expect(assertToolScope(stagingEnv(), tool, container).name).toBe("staging");
    const directPort =
      "must use the managed cluster's direct port 27520 (never its 27521 pool or any other port).";
    const database = `must be staging's database ${STAGING_DATABASE}`;
    for (const [url, fragment] of [
      // Never local: staging's database lives on the managed cluster.
      [localUrl(STAGING_DATABASE), "is local; staging uses the managed cluster"],
      [localUrl(STAGING_DATABASE, "postgres"), "is local; staging uses the managed cluster"],
      [localUrl(STAGING_DATABASE, "127.0.0.1"), "is local; staging uses the managed cluster"],
      // Never production's databases, whichever user, nor DevBot's or a disposable copy.
      [managedUrl("tarubot"), database],
      [managedUrl("tarubot", MANAGED, STAGING_DATABASE), database],
      [managedUrl("tarubot_restore", MANAGED, STAGING_DATABASE), database],
      [managedUrl("tarubot_dev", MANAGED, STAGING_DATABASE), database],
      [managedUrl(`${STAGING_DATABASE}_restore_test`, MANAGED, STAGING_DATABASE), database],
      [managedUrl("defaultdb", MANAGED, STAGING_DATABASE), database],
      // Only staging's own role: never production's tarubot user or the administrator.
      [managedUrl(STAGING_DATABASE, MANAGED, "tarubot"), `connect as the ${STAGING_DATABASE} user`],
      [managedUrl(STAGING_DATABASE, MANAGED, "akmadmin"), "not an administrator"],
      [`postgresql://${MANAGED}:27520/${STAGING_DATABASE}`, "not an administrator"],
      // The direct port only.
      [managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE, 27521), directPort],
      [`postgresql://${STAGING_DATABASE}:${PASSWORD}@${MANAGED}/${STAGING_DATABASE}`, directPort],
    ] as const)
      refused(
        () => assertToolScope(stagingEnv({ DATABASE_URL: url }), scope.migrate, container),
        fragment,
      );
    // Verified TLS: the cluster's CA is required.
    for (const ca of ["", "  ", undefined])
      refused(
        () => assertToolScope(stagingEnv({ DATABASE_CA_CERT: ca }), scope.migrate, container),
        "DATABASE_CA_CERT must hold the managed cluster's CA certificate",
      );
    refused(
      () => assertToolScope(stagingEnv({ DATABASE_URL: "" }), scope.migrate, container),
      "DATABASE_URL is required",
    );
  });

  test("staging has no restore target: no check-restore and no --restore-rehearsal", () => {
    for (const restore of [
      managedUrl(`${STAGING_DATABASE}_restore`, MANAGED, STAGING_DATABASE),
      managedUrl(STAGING_DATABASE, FORK, STAGING_DATABASE),
      managedUrl("tarubot_restore"),
    ])
      refused(
        () =>
          assertToolScope(stagingEnv({ RESTORE_DATABASE_URL: restore }), scope.restore, container),
        "RESTORE_DATABASE_URL has no staging procedure",
      );
    // Refused before any database setting is checked, so an unset restore URL gets the same answer.
    refused(
      () => assertToolScope(stagingEnv(), scope.restore, container),
      "RESTORE_DATABASE_URL has no staging procedure",
    );
    for (const name of [`${STAGING_DATABASE}_restore_test`, STAGING_DATABASE])
      refused(
        () =>
          assertToolScope(
            stagingEnv({ DATABASE_URL: managedUrl(name, MANAGED, STAGING_DATABASE) }),
            scope.rehearseMigration,
            container,
          ),
        "--restore-rehearsal has no staging procedure",
      );
    // A restore URL left in the settings doesn't matter to tools that don't use it.
    expect(
      assertToolScope(
        stagingEnv({ RESTORE_DATABASE_URL: managedUrl("tarubot_restore") }),
        scope.migrate,
        container,
      ).name,
    ).toBe("staging");
  });

  test("staging takes production's launch rule: no auto-loaded env file without --env-file", () => {
    for (const file of AUTOLOADED_ENV_FILES)
      refused(
        () => assertToolScope(stagingEnv(), scope.migrate, { execArgv: [], envFiles: [file] }),
        `${file} in the working directory would be merged into this run`,
      );
    expect(assertToolScope(stagingEnv(), scope.migrate, container).name).toBe("staging");
    expect(
      assertToolScope(stagingEnv(), scope.migrate, {
        execArgv: ["--env-file=/home/operator/staging.env"],
        envFiles: [".env"],
      }).name,
    ).toBe("staging");
    // The local devbot profile keeps reading the checkout's .env.
    expect(
      assertToolScope(devbotEnv(), scope.migrate, { execArgv: [], envFiles: [".env"] }).name,
    ).toBe("devbot");
  });

  test("the authenticated application must be DevBot's", () => {
    const staging = assertToolScope(stagingEnv(), scope.register(DEV_GUILD), container);
    expect(() => assertAuthenticatedApplication(staging, DEVBOT_APP)).not.toThrow();
    refused(() => assertAuthenticatedApplication(staging, PRODUCTION_APP), DEVBOT_APP);
    refused(() => assertAuthenticatedApplication(staging, undefined), "did not report");
  });

  test("the local devbot profile is unchanged beside staging", () => {
    // Staging's managed URL can't pass under the local profile, and DevBot's local database can't
    // pass under staging: the two never share a database.
    refused(
      () =>
        assertToolScope(
          devbotEnv({ DATABASE_URL: managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE) }),
          scope.migrate,
          direct,
        ),
      "DevBot's local database",
    );
    refused(
      () =>
        assertToolScope(
          stagingEnv({ DATABASE_URL: localUrl("tarubot_dev"), DATABASE_CA_CERT: "" }),
          scope.migrate,
          container,
        ),
      "is local; staging uses the managed cluster",
    );
    expect(assertToolScope(devbotEnv(), scope.register(DEV_GUILD), direct).name).toBe("devbot");
  });
});

describe("file-delivered secrets (#50, 2.33.0)", () => {
  /**
   * Write the given settings as files, the way secrets.sh fills a Podman secret (the value and one
   * newline), run the check with their NAME_FILE paths, and clean up.
   */
  function withFiles<T>(
    values: Record<string, string>,
    check: (paths: Record<string, string>) => T,
  ) {
    const directory = mkdtempSync(join(tmpdir(), "tarubot-guard-secrets-"));
    try {
      const paths = Object.fromEntries(
        Object.entries(values).map(([name, value]) => {
          const path = join(directory, name.toLowerCase());
          writeFileSync(path, `${value}\n`);
          return [`${name}_FILE`, path];
        }),
      );
      return check(paths);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  /** Refused as `refused` checks, and without naming a file path either. */
  function refusedWithoutPath(action: () => unknown, fragment: string): void {
    refused(action, fragment);
    try {
      action();
    } catch (error) {
      expect(String(error)).not.toContain(tmpdir());
    }
  }

  test("staging's container reads its database URL and CA from files, as the bot does", () => {
    // In a Quadlet container the unit unsets the plain names and sets NAME_FILE instead.
    const url = managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE);
    withFiles({ DATABASE_URL: url, DATABASE_CA_CERT: CA }, (paths) => {
      const env = stagingEnv({ DATABASE_URL: undefined, DATABASE_CA_CERT: undefined, ...paths });
      for (const tool of [scope.migrate, scope.register(DEV_GUILD), scope.preview(DEV_GUILD)])
        expect(assertToolScope(env, tool, container).name).toBe("staging");
      // The file's database still has to be staging's own.
      withFiles({ DATABASE_URL: managedUrl("tarubot") }, (wrong) =>
        refused(
          () => assertToolScope({ ...env, ...wrong }, scope.migrate, container),
          `must be staging's database ${STAGING_DATABASE}`,
        ),
      );
    });
  });

  test("production reads them from files too, and restore checks fall back to the file's CA", () => {
    withFiles({ DATABASE_URL: managedUrl("tarubot"), DATABASE_CA_CERT: CA }, (paths) => {
      const env = productionEnv({ DATABASE_URL: undefined, DATABASE_CA_CERT: undefined, ...paths });
      expect(assertToolScope(env, scope.import(PRODUCTION_GUILD), direct).name).toBe("production");
      expect(restoreCertificate(env)).toBe(CA);
      expect(restoreCertificate({ ...env, RESTORE_DATABASE_CA_CERT: "" })).toBe(CA);
      expect(restoreCertificate({ ...env, RESTORE_DATABASE_CA_CERT: "fork" })).toBe("fork");
      // check-restore's second database uses the file's CA as its fallback.
      expect(
        assertToolScope(
          { ...env, RESTORE_DATABASE_URL: managedUrl("tarubot", FORK) },
          scope.restore,
          direct,
        ).name,
      ).toBe("production");
    });
  });

  test("a managed profile refuses an empty or unreadable CA file", () => {
    // secrets.sh writes an empty value as a lone newline, which reads back as empty.
    for (const [profile, build] of [
      ["staging", stagingEnv],
      ["production", productionEnv],
    ] as const)
      withFiles({ DATABASE_CA_CERT: "" }, (paths) => {
        const env = build({ DATABASE_CA_CERT: undefined, ...paths });
        refused(
          () => assertToolScope(env, scope.migrate, container),
          "DATABASE_CA_CERT must hold the managed cluster's CA certificate",
        );
        refusedWithoutPath(
          () =>
            assertToolScope(
              { ...env, DATABASE_CA_CERT_FILE: join(tmpdir(), `tarubot-no-such-${profile}`) },
              scope.migrate,
              container,
            ),
          "DATABASE_CA_CERT_FILE names a file that can't be read",
        );
      });
  });

  test("setting both forms of one secret is refused, naming both and no value", () => {
    withFiles(
      { DATABASE_URL: managedUrl(STAGING_DATABASE, MANAGED, STAGING_DATABASE) },
      (paths) => {
        refusedWithoutPath(
          () => assertToolScope(stagingEnv(paths), scope.migrate, container),
          "Set DATABASE_URL or DATABASE_URL_FILE, not both.",
        );
        // Even the token, which the guard itself doesn't read: every tool reads all six the same way.
        refusedWithoutPath(
          () =>
            assertToolScope(
              devbotEnv({ DISCORD_TOKEN_FILE: paths.DATABASE_URL_FILE ?? "" }),
              scope.migrate,
              direct,
            ),
          "Set DISCORD_TOKEN or DISCORD_TOKEN_FILE, not both.",
        );
      },
    );
    // An empty NAME_FILE counts as unset, so a plain value next to it is fine.
    expect(
      assertToolScope(
        stagingEnv({ DATABASE_URL_FILE: "", DATABASE_CA_CERT_FILE: "" }),
        scope.migrate,
        container,
      ).name,
    ).toBe("staging");
  });
});

describe("templates", () => {
  const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
  const keys = (text: string) =>
    [...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");
  /** Load an env file with Bun's own parser (multi-line PEMs included), as --env-file does. */
  const loadEnvFile = (path: string): Record<string, string> => {
    const child = Bun.spawnSync(
      [process.execPath, `--env-file=${path}`, "-e", "console.log(JSON.stringify(process.env))"],
      { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } },
    );
    expect(child.exitCode).toBe(0);
    return JSON.parse(child.stdout.toString());
  };
  /**
   * A Quadlet target list's fixed NAME=value lines (bare names copy from .env and are skipped). A
   * NAME_FILE line names a file that exists only inside the container, so it is skipped too; the
   * template's plain values stand in for those files here.
   */
  const fixedValues = async (path: string): Promise<Record<string, string>> =>
    Object.fromEntries(
      [...(await Bun.file(root(path)).text()).matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)]
        .filter((match) => !(match[1] ?? "").endsWith("_FILE"))
        .map((match) => [match[1] ?? "", match[2] ?? ""]),
    );

  test("(n) production.env.example lists every key and loads as a passing production env", async () => {
    const template = await Bun.file(root("production.env.example")).text();
    const developmentKeys = keys(await Bun.file(root(".env.example")).text());
    // .env.example is the reference: every key present means a stray .env can never fill a gap.
    expect(developmentKeys).toContain("TARUBOT_ENVIRONMENT");
    expect(developmentKeys).toContain("RESTORE_DATABASE_CA_CERT");
    for (const key of developmentKeys) expect(keys(template)).toContain(key);

    // Load it exactly as the runbook does, with Bun's own parser (multi-line PEM included).
    const env = loadEnvFile(root("production.env.example"));
    expect(env).toMatchObject({
      TARUBOT_ENVIRONMENT: "production",
      DISCORD_APPLICATION_ID: PRODUCTION_APP,
      TEST_GUILD_ID: "",
      PUBLIC_TEST_RESPONSES: "false",
      TEST_PLAN_CHANNEL_ID: "",
      ENABLE_EFFECTS: "false",
      DISCORD_TOKEN: "",
      RESTORE_DATABASE_CA_CERT: "",
    });
    // Placeholders only: no real password, CA or token is tracked.
    expect(env.DATABASE_URL).toContain("REPLACE_WITH_");
    expect(env.DATABASE_CA_CERT).toStartWith("-----BEGIN CERTIFICATE-----\nREPLACE_WITH_");
    expect(env.DATABASE_CA_CERT).toEndWith("\n-----END CERTIFICATE-----");
    // Production's Linode cluster, on its direct port rather than the 27521 pool.
    expect(databaseIdentity(env.DATABASE_URL ?? "")).toMatchObject({
      port: 27520,
      name: "tarubot",
      user: "tarubot",
    });
    const launch: Launch = { execArgv: ["--env-file=production.env"], envFiles: [".env"] };
    expect(assertToolScope(env, scope.import(PRODUCTION_GUILD), launch).name).toBe("production");
    expect(assertToolScope(env, scope.register(), launch).name).toBe("production");
  });

  test("(#50) staging.env.example is the staging host's .env: placeholders under the host's rules", async () => {
    const text = await Bun.file(root("staging.env.example")).text();
    const names = keys(text);
    // Each name once, and exactly one plain release pin, which deploy.sh and the playbook require.
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name === "TARUBOT_IMAGE_TAG")).toHaveLength(1);
    // The playbook refuses an image override, a digest before the first start, and on staging any
    // GitHub App value; the staging target fixes the identity and scoping; staging has no restore
    // target. None of them belongs in the template.
    for (const name of [
      "TARUBOT_IMAGE",
      "TARUBOT_IMAGE_DIGEST",
      "GITHUB_APP_CLIENT_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "TARUBOT_ENVIRONMENT",
      "DISCORD_APPLICATION_ID",
      "TEST_GUILD_ID",
      "PUBLIC_TEST_RESPONSES",
      "RESTORE_DATABASE_URL",
      "RESTORE_DATABASE_CA_CERT",
    ])
      expect(names).not.toContain(name);
    expect(names.filter((name) => name.startsWith("GITHUB_APP_"))).toEqual([]);
    // Placeholders only: no Discord ID, and every value that isn't empty is a REPLACE_ marker.
    expect(text).not.toMatch(/\b[1-9][0-9]{16,19}\b/);
    const env = loadEnvFile(root("staging.env.example"));
    const values = Object.fromEntries(names.map((name) => [name, env[name] ?? ""]));
    const filled = Object.entries(values).filter(([, value]) => value !== "");
    expect(filled.map(([name]) => name).sort()).toEqual(
      ["DATABASE_CA_CERT", "DATABASE_URL", "DISCORD_TOKEN", "TARUBOT_IMAGE_TAG"].sort(),
    );
    for (const [name, value] of filled) expect(value, name).toContain("REPLACE_");
    // The token stays an obvious placeholder until the DevBot move.
    expect(values.DISCORD_TOKEN).toMatch(/^REPLACE_[A-Z_]+$/);
    expect(values.DATABASE_CA_CERT).toStartWith("-----BEGIN CERTIFICATE-----\nREPLACE_WITH_");
    expect(values.DATABASE_CA_CERT).toEndWith("\n-----END CERTIFICATE-----");
    // Staging's own database and role on the cluster's direct port.
    expect(databaseIdentity(values.DATABASE_URL ?? "")).toMatchObject({
      port: 27520,
      name: STAGING_DATABASE,
      user: STAGING_DATABASE,
    });

    // The host's own checks accept it: check-env.sh reads each line the same way systemd and
    // Compose would, then checks the settings systemd read (with the digest a start would pin).
    const checkEnv = (args: string[], settings: Record<string, string>) =>
      Bun.spawnSync(["sh", root("ops/quadlet/check-env.sh"), ...args], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...settings },
        stdout: "pipe",
        stderr: "pipe",
      });
    const syntax = checkEnv(["--syntax", root("staging.env.example")], {});
    expect({ code: syntax.exitCode, err: syntax.stderr.toString() }).toEqual({ code: 0, err: "" });
    const settings = checkEnv([], { ...values, TARUBOT_IMAGE_DIGEST: `sha256:${"0".repeat(64)}` });
    expect({ code: settings.exitCode, err: settings.stderr.toString() }).toEqual({
      code: 0,
      err: "",
    });

    // Under the staging target's fixed settings, staging's tools resolve the staging profile in
    // the bot's container.
    const staging = { ...values, ...(await fixedValues("ops/quadlet/staging/target.env")) };
    for (const tool of [scope.migrate, scope.register(DEV_GUILD), scope.preview(DEV_GUILD)])
      expect(assertToolScope(staging, tool, container)).toMatchObject({
        name: "staging",
        applicationId: DEVBOT_APP,
        registrationScope: DEV_GUILD,
      });
    // A host that linked production's target by mistake is refused before any I/O: the
    // production profile never takes staging's database.
    const wrongTarget = { ...values, ...(await fixedValues("ops/quadlet/production/target.env")) };
    expect(wrongTarget.TARUBOT_ENVIRONMENT).toBe("production");
    for (const tool of [scope.migrate, scope.import(PRODUCTION_GUILD)])
      refused(() => assertToolScope(wrongTarget, tool, container), "belongs to staging");
  });

  test("(n, C4) operator env files stay out of Git and images; the templates stay in both", async () => {
    const gitignore = (await Bun.file(root(".gitignore")).text()).split("\n");
    const dockerignore = (await Bun.file(root(".dockerignore")).text()).split("\n");
    expect(gitignore).toContain("*.env");
    expect(gitignore).toContain("!.env.example");
    expect(dockerignore).toContain("*.env");
    // The build stage runs these unit tests, so the non-secret template must reach it.
    expect(dockerignore).toContain("!.env.example");
    expect(dockerignore.indexOf("!.env.example")).toBeGreaterThan(dockerignore.indexOf(".env.*"));
  });
});

describe("check-restore arguments (C13)", () => {
  test("the build's schema version is the default; --schema-version names an earlier one", () => {
    expect(restoreArguments([])).toEqual({ schemaVersion: SCHEMA_VERSION });
    expect(restoreArguments(["--schema-version", "004_guest_application_form.sql"])).toEqual({
      schemaVersion: "004_guest_application_form.sql",
    });
    for (const argv of [
      ["--schema-version"],
      ["--schema-version", "../004_guest_application_form.sql"],
      ["--schema-version", "004_guest_application_form"],
      ["--schema-version", "004_guest_application_form.sql", "extra"],
      ["--other", "004_guest_application_form.sql"],
    ])
      expect(() => restoreArguments(argv)).toThrow(Failure);
  });
});
