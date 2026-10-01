/** Validate target evidence before setting a reusable-workflow success output. No unchecked echo. */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseIdentity, requireStagingAcceptance } from "./release-policy.js";

if (import.meta.main) {
  try {
    const release = releaseIdentity({
      version: process.env.VERSION,
      commit: process.env.COMMIT,
      digest: process.env.DIGEST,
      config_commit: process.env.COMMIT,
      publication_run: process.env.PUBLICATION_RUN,
      schema_head: process.env.SCHEMA_HEAD,
    });
    if (!process.env.RUNNER_TEMP || !process.env.GITHUB_OUTPUT)
      throw new Error("invalid-acceptance-runner");
    const result = JSON.parse(
      readFileSync(join(process.env.RUNNER_TEMP, "acceptance.json"), "utf8"),
    );
    requireStagingAcceptance(result, release);
    appendFileSync(process.env.GITHUB_OUTPUT, "accepted=true\n");
  } catch {
    console.log(
      "::error::Staging has no complete acceptance evidence for this exact release; promotion is blocked.",
    );
    process.exitCode = 1;
  }
}
