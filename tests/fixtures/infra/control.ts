import { verifyInventedBaselineRun } from "./baseline-run.js";
/** Phase-test transport: invented encrypted objects on disk, injected through the internal API. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { controlPhase } from "../../../scripts/infra-control-cli.js";
import {
  InfrastructureJournal,
  RecordCodec,
  privateDigest,
  type ControlStore,
} from "../../../scripts/infra-control.js";

const [command, directory] = process.argv.slice(2);
const stub = process.env.STUB;
if (!command || !directory || !stub) throw new Error("missing-test-runner");
const objects = join(stub, "control-objects");
const store: ControlStore = {
  async read(key) {
    const path = join(objects, key);
    return existsSync(path) ? readFileSync(path) : null;
  },
  async write(key, bytes) {
    if (existsSync(join(stub, "fail-control-write"))) throw new Error("invented-write-failure");
    const path = join(objects, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode: 0o600 });
  },
};
const backend = readFileSync(join(directory, "backend.hcl"), "utf8");
const codec = new RecordCodec(
  process.env.TF_VAR_state_passphrase ?? "",
  privateDigest({ backend, key: "tarubot/infra.tfstate" }),
);
try {
  await controlPhase(
    command,
    directory,
    process.env,
    new InfrastructureJournal(store, codec, { verifyBaselineRun: verifyInventedBaselineRun }),
  );
} catch {
  process.exitCode = 1;
}
