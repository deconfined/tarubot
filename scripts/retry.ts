/** Operator CLI: requeue failed/blocked delivery without repeating its committed decision. */
import { z } from "zod";
import { assertToolScope } from "../src/config/deployment.js";
import { secretSetting } from "../src/config/secrets.js";
import { id } from "../src/domain/values.js";
import { audit, Database } from "../src/infrastructure/postgres/database.js";
import { retryJob } from "../src/jobs/queue.js";
const guild = id(process.argv[2]);
const job = z.uuid().parse(process.argv[3]);
// The guild and database must belong to this env's deployment profile before any connection.
assertToolScope(process.env, {
  tool: "retry",
  guilds: [guild],
  discord: "none",
  databases: ["DATABASE_URL"],
});
// Resolve the direct setting or its private NAME_FILE counterpart.
const url = secretSetting(process.env, "DATABASE_URL");
if (!url) throw new Error("DATABASE_URL is required");
const db = new Database(url);
try {
  await db.schema();
  await db.transaction(async (client) => {
    // The supplied guild must own the job; completed effects cannot be replayed through this tool,
    // and a job whose work a newer active row already carries is refused with that row's ID.
    await retryJob(client, guild, job);
    await audit(client, guild, null, "job.retry", job);
  });
  console.log("Committed work queued for independent delivery retry.");
} finally {
  await db.close();
}
