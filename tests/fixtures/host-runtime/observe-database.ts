/**
 * The fake container's dist/src/infrastructure/postgres/database.js for the observation probe:
 * invented schema state from $SIM/observe.json, and no connection to anything.
 */
import { scenario } from "./observe-scenario.js";

export const SCHEMA_VERSION = scenario.schemaVersion ?? "001_initial.sql";

export class Database {
  constructor(readonly url: string | undefined) {}

  async schema(version: string): Promise<void> {
    if (scenario.schemaError)
      throw Object.assign(new Error(scenario.schemaError.message), {
        code: scenario.schemaError.code,
      });
    if (version !== SCHEMA_VERSION) throw new Error("Schema version/checksum mismatch.");
  }

  async close(): Promise<void> {}
}
