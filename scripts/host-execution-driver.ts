/** Private one-shot measured child driver. No caller commands, channels, handlers or proofs. */
import {
  releaseOwnedControllerToDenial,
  fenceOwnedControllerExchange,
  stopOwnedHostController,
  type PausedHostController,
  type OwnedControllerExchange,
} from "./host-controller.js";
import {
  beginDeniedHostExecutionGrant,
  finishDeniedHostExecutionGrant,
  fenceDeniedHostExecutionPreparation,
  type DeniedHostExecutionPreparation,
} from "./host-execution-grant.js";
import {
  assertProtectedHostExecutionContext,
  fenceProtectedHostExecutionContext,
  prepareProtectedHostExecution,
  runProtectedHostExecutionDenial,
  type ProtectedHostExecutionContext,
} from "./host-execution-runtime.js";

/** Internal direct bridge: context constructor and caller-facing entrypoints remain runtime-owned. */
export async function driveOwnedHostDenial(
  context: ProtectedHostExecutionContext,
  paused: PausedHostController,
): Promise<void> {
  let preparation: DeniedHostExecutionPreparation | undefined,
    exchange: OwnedControllerExchange | undefined;
  try {
    assertProtectedHostExecutionContext(context);
    preparation = beginDeniedHostExecutionGrant(context);
    exchange = await releaseOwnedControllerToDenial(paused, context, preparation);
    await finishDeniedHostExecutionGrant(preparation, context, exchange);
    // A verified DENY is still a failed operation. No successful deployment/task result
    // can be inferred from completing this deliberately inactive transport rehearsal.
    throw new Error("protected-host-execution-denied");
  } catch {
    if (preparation) fenceDeniedHostExecutionPreparation(preparation);
    if (exchange) fenceOwnedControllerExchange(exchange);
    fenceProtectedHostExecutionContext(context);
    throw new Error("protected-host-execution-denied");
  } finally {
    try {
      await stopOwnedHostController(paused);
    } catch {
      /* Fixed denial cleanup never opens another delivery. */
    }
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || (args[0] !== "prepare" && args[0] !== "deny"))
      throw new Error("protected-host-execution-denied");
    if (args[0] === "prepare") await prepareProtectedHostExecution();
    else await runProtectedHostExecutionDenial();
  } catch {
    process.stderr.write("protected-host-execution-denied\n");
    process.exitCode = 1;
  }
}
