/**
 * Validate process configuration before startup creates any externally visible work. The six
 * secrets may arrive as files (NAME_FILE, 2.33.0): src/config/secrets.ts resolves them first, so
 * the schema below and the Configuration type only ever see the plain names.
 */
import { z } from "zod";
import { Failure, idSchema } from "../domain/values.js";
import { project } from "./project.js";
import { type Environment, resolveSettings } from "./secrets.js";

const schema = z.object({
  // Secrets are validated for presence/format but are never included in diagnostics.
  DATABASE_URL: z.string().url(),
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: idSchema,
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  ENABLE_EFFECTS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Empty means production scope; a value confines interaction/event adapters to a test guild.
  TEST_GUILD_ID: z.union([idSchema, z.literal("")]).default(""),
  // Development observers may see all new replies without changing other guilds' privacy defaults.
  PUBLIC_TEST_RESPONSES: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  ROSTER_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(21600),
  VERIFICATION_SECONDS: z.coerce.number().int().min(60).max(86400).default(1800),
  GUEST_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(86400),
  HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Issue reports (2.18.0): a fine-grained token limited to the reports repository's issues. Empty
  // keeps reports in the database, unsent, until a token is configured and the bot restarts.
  GITHUB_REPORTS_TOKEN: z.string().default(""),
  GITHUB_REPORTS_REPO: z
    .string()
    .regex(/^[A-Za-z\d-]+\/[A-Za-z\d._-]+$/u, "owner/repository")
    // Reports carry private diagnostics, so pointing them at TaruBot's public repository is a
    // loud startup failure (2.28.0), never a silent leak.
    .refine(
      (repository) => repository.toLowerCase() !== project.repository.toLowerCase(),
      "must be the private reports repository, not TaruBot's public one",
    )
    .default("deconfined/tarubot-reports"),
  // Public suggestions (2.28.0): the TaruBot GitHub App that opens /suggest issues in the public
  // repository. Production only (/suggest); DevBot ignores both and previews into the reports
  // repository. Either one empty switches /suggest off. The client ID isn't secret.
  GITHUB_APP_CLIENT_ID: z.string().default(""),
  // The app's private key: a PEM, quoted across lines like DATABASE_CA_CERT; production only. It
  // isn't parsed at startup, so a bad key fails only /suggest (with a private report), never boot.
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  // Heartbeat (2.22.0): a healthchecks.io ping URL, pinged every five minutes while the bot is ready
  // so an outside check alerts when the pings stop. Empty turns it off (DevBot, CI).
  HEALTHCHECKS_PING_URL: z
    .union([z.literal(""), z.string().url().startsWith("https://")])
    .default(""),
  // Web pages (#43): dormant until WEB_PUBLIC_ORIGIN is set. Plain optional strings with no default
  // or transform, because src/web/settings.ts parses them only when the web starts: a bad value
  // turns the web off with a report naming the setting, never stopping the bot. An empty string
  // (Compose's ${VAR:-}) means unset. DISCORD_CLIENT_SECRET is the bot application's OAuth secret.
  WEB_PUBLIC_ORIGIN: z.string().optional(),
  WEB_PORT: z.string().optional(),
  DISCORD_CLIENT_SECRET: z.string().optional(),
});
export type Configuration = z.infer<typeof schema>;

/**
 * The deployments whose bot must verify the managed cluster's certificate. Without a CA,
 * postgresConnection falls back to the URL's own SSL flags, which don't verify it; a CA lost on
 * the way (a missing DATABASE_CA_CERT_FILE line, say) must stop the start instead.
 */
const CA_REQUIRED = ["production", "staging"];

/**
 * Report setting names and expected formats while avoiding raw environment values. File-delivered
 * secrets are resolved into a new object; process.env itself is never written.
 */
export function configuration(env: Environment = process.env): Configuration {
  let resolved: Environment;
  try {
    resolved = resolveSettings(env);
  } catch (error) {
    // The resolver's messages name settings only.
    if (error instanceof Failure) throw new Error(`Invalid configuration: ${error.message}`);
    throw error;
  }
  const result = schema.safeParse(resolved);
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  const marker = env.TARUBOT_ENVIRONMENT ?? "";
  if (CA_REQUIRED.includes(marker) && !resolved.DATABASE_CA_CERT)
    throw new Error(
      `Invalid configuration: DATABASE_CA_CERT: required, directly or through DATABASE_CA_CERT_FILE, when TARUBOT_ENVIRONMENT is ${marker}`,
    );
  return result.data;
}
