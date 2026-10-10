/** What the fake container's observation probe meets: $SIM/observe.json, all healthy when absent. */
export interface ObserveScenario {
  /** package.json's version inside the container (written by the fake docker). */
  version?: string;
  /** The compiled SCHEMA_VERSION. */
  schemaVersion?: string;
  /** db.schema() throws this, as a pg or Failure error would. */
  schemaError?: { message: string; code?: unknown };
  /** fetch() throws this, as Bun's connection errors do. */
  fetchError?: { message: string; code?: unknown };
  /** The /health/ready answer. */
  readiness?: { status: number; body: unknown };
}

const file = Bun.file(`${process.env.SIM}/observe.json`);
export const scenario: ObserveScenario = (await file.exists()) ? await file.json() : {};
