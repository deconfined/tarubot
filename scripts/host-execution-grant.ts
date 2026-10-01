/** Permanent DENIAL-only producer/consumer. No public JWT/subject/command/transport inputs
 * and no preparation-data or denial brand can upgrade to an actual host operation. */
import {
  HostExecutionWindow,
  assertProtectedHostExecutionContext,
  assertProtectedHostExecutionContextData,
  remainingProtectedHostExecutionContext,
  protectedHostExecutionBinding,
  fenceProtectedHostExecutionContext,
  authenticateOwnedHostExecutionDenial,
  assertHostDenialAuthentication,
  remainingHostDenialAuthentication,
  rejectProtectedHostExecutionClockReentry,
  fenceActiveProtectedHostExecutionAttempt,
  type HostDenialAuthentication,
  type ProtectedHostExecutionContext,
} from "./host-execution-runtime.js";
import {
  assertOwnedControllerExchange,
  ownedControllerExchangeBinding,
  deliverOwnedControllerDenial,
  fenceOwnedControllerExchange,
  type OwnedControllerExchange,
} from "./host-controller.js";

const failure = "invalid-denied-host-execution";
export const hostExecutionDenialPurpose = "tarubot-host-execution-denial-v1" as const;
export const hostExecutionDenialAudience = "urn:tarubot:host-execution-denial:v1:" as const;
export const hostPreparationDataPurpose = "tarubot-host-preparation-data-v1" as const;
export const hostPreparationDataAudience = "urn:tarubot:host-preparation-data:v1:" as const;
declare const preparationBrand: unique symbol, grantBrand: unique symbol;
export type DeniedHostExecutionPreparation = Readonly<{ [preparationBrand]: true }>;
export type DeniedHostExecutionGrant = Readonly<{ [grantBrand]: true }>;
interface PreparationState {
  context: ProtectedHostExecutionContext;
  window: HostExecutionWindow;
  phase: "prepared" | "verifying" | "minting" | "issued" | "delivering" | "completed" | "fenced";
  exchange: OwnedControllerExchange | undefined;
  statement: Readonly<Record<string, unknown>> | undefined;
  checking: boolean;
}
interface GrantState {
  preparation: DeniedHostExecutionPreparation;
  context: ProtectedHostExecutionContext;
  exchange: OwnedControllerExchange;
  authentication: HostDenialAuthentication;
  phase: "issued" | "consumed" | "fenced";
  checking: boolean;
}
const preparations = new WeakMap<object, PreparationState>(),
  grants = new WeakMap<object, GrantState>();
const reserved = new WeakMap<object, DeniedHostExecutionPreparation>();
function fenceExchange(value: OwnedControllerExchange): void {
  try {
    fenceOwnedControllerExchange(value);
  } catch {
    /* Unknown origin still cannot approve. */
  }
}
function valid(value: unknown): asserts value {
  if (!value) {
    fenceActiveProtectedHostExecutionAttempt();
    throw new Error(failure);
  }
}
export function fenceDeniedHostExecutionPreparation(value: DeniedHostExecutionPreparation): void {
  fenceActiveProtectedHostExecutionAttempt();
  const state = preparations.get(value);
  if (state) {
    state.phase = "fenced";
    state.window.stop();
    fenceProtectedHostExecutionContext(state.context);
    if (state.exchange) fenceExchange(state.exchange);
  }
}
function saved(
  value: DeniedHostExecutionPreparation,
  context: ProtectedHostExecutionContext,
): PreparationState {
  rejectProtectedHostExecutionClockReentry();
  const state = preparations.get(value);
  valid(
    state && state.context === context && state.phase !== "fenced" && state.phase !== "completed",
  );
  return state;
}
export function beginDeniedHostExecutionGrant(
  context: ProtectedHostExecutionContext,
): DeniedHostExecutionPreparation {
  rejectProtectedHostExecutionClockReentry();
  valid(context !== null && typeof context === "object");
  const old = reserved.get(context);
  if (old) {
    fenceDeniedHostExecutionPreparation(old);
    fenceProtectedHostExecutionContext(context);
    throw new Error(failure);
  }
  const value = Object.freeze(Object.create(null)) as DeniedHostExecutionPreparation;
  reserved.set(context, value);
  let state: PreparationState | undefined;
  try {
    const window = new HostExecutionWindow(30_000, () => {
      assertProtectedHostExecutionContextData(context);
    });
    state = {
      context,
      window,
      phase: "prepared",
      exchange: undefined,
      statement: undefined,
      checking: false,
    };
    preparations.set(value, state);
    assertProtectedHostExecutionContext(context);
    window.restrict(window.now() + remainingProtectedHostExecutionContext(context));
    return value;
  } catch {
    if (state) fenceDeniedHostExecutionPreparation(value);
    else fenceProtectedHostExecutionContext(context);
    throw new Error(failure);
  }
}
/** Pure retained refusal continues through consumption until delivery completes. */
export function assertDeniedHostExecutionPreparation(
  value: DeniedHostExecutionPreparation,
  context: ProtectedHostExecutionContext,
): void {
  let state: PreparationState | undefined,
    owns = false;
  try {
    state = saved(value, context);
    valid(!state.checking);
    state.checking = true;
    owns = true;
    state.window.check();
    valid(state.phase !== "fenced" && state.phase !== "completed");
  } catch {
    fenceDeniedHostExecutionPreparation(value);
    fenceProtectedHostExecutionContext(context);
    throw new Error(failure);
  } finally {
    if (owns && state) state.checking = false;
  }
}
export function remainingDeniedHostExecutionPreparation(
  value: DeniedHostExecutionPreparation,
  context: ProtectedHostExecutionContext,
): number {
  try {
    assertDeniedHostExecutionPreparation(value, context);
    return saved(value, context).window.remaining();
  } catch {
    fenceDeniedHostExecutionPreparation(value);
    throw new Error(failure);
  }
}
export function assertDeniedHostExecutionGrant(
  value: DeniedHostExecutionGrant,
  exchange: OwnedControllerExchange,
  context: ProtectedHostExecutionContext,
): void {
  rejectProtectedHostExecutionClockReentry();
  const state = grants.get(value);
  let owns = false;
  try {
    valid(
      state && state.phase !== "fenced" && state.context === context && state.exchange === exchange,
    );
    valid(!state.checking);
    state.checking = true;
    owns = true;
    assertDeniedHostExecutionPreparation(state.preparation, context);
    assertProtectedHostExecutionContext(context);
    assertHostDenialAuthentication(state.authentication, context, state.preparation, exchange);
    assertOwnedControllerExchange(exchange, context);
    assertDeniedHostExecutionPreparation(state.preparation, context);
  } catch {
    if (state) {
      state.phase = "fenced";
      fenceDeniedHostExecutionPreparation(state.preparation);
    }
    fenceProtectedHostExecutionContext(context);
    fenceExchange(exchange);
    throw new Error(failure);
  } finally {
    if (owns && state) state.checking = false;
  }
}
export function remainingDeniedHostExecutionGrant(
  value: DeniedHostExecutionGrant,
  exchange: OwnedControllerExchange,
  context: ProtectedHostExecutionContext,
): number {
  assertDeniedHostExecutionGrant(value, exchange, context);
  const state = grants.get(value);
  valid(state);
  return remainingDeniedHostExecutionPreparation(state.preparation, context);
}
export function consumeDeniedHostExecutionGrant(
  value: DeniedHostExecutionGrant,
  exchange: OwnedControllerExchange,
  context: ProtectedHostExecutionContext,
): void {
  rejectProtectedHostExecutionClockReentry();
  const state = grants.get(value);
  try {
    valid(state && state.phase === "issued");
    state.phase = "consumed";
    saved(state.preparation, context).phase = "delivering";
    assertDeniedHostExecutionGrant(value, exchange, context);
  } catch {
    if (state) {
      state.phase = "fenced";
      fenceDeniedHostExecutionPreparation(state.preparation);
    }
    throw new Error(failure);
  }
}
export async function finishDeniedHostExecutionGrant(
  value: DeniedHostExecutionPreparation,
  context: ProtectedHostExecutionContext,
  exchange: OwnedControllerExchange,
): Promise<void> {
  try {
    const state = saved(value, context);
    valid(state.phase === "prepared");
    state.phase = "verifying";
    state.exchange = exchange;
    state.window.capture(() => {
      assertOwnedControllerExchange(exchange, context);
      protectedHostExecutionBinding(context);
      ownedControllerExchangeBinding(exchange, context);
    });
    state.phase = "minting";
    const authentication = await state.window.wait(() =>
      authenticateOwnedHostExecutionDenial(context, value, exchange),
    );
    assertDeniedHostExecutionPreparation(value, context);
    assertHostDenialAuthentication(authentication, context, value, exchange);
    state.window.restrict(
      state.window.now() +
        remainingHostDenialAuthentication(authentication, context, value, exchange),
    );
    const grant = Object.freeze(Object.create(null)) as DeniedHostExecutionGrant;
    grants.set(grant, {
      preparation: value,
      context,
      exchange,
      authentication,
      phase: "issued",
      checking: false,
    });
    state.phase = "issued";
    await state.window.wait(() => deliverOwnedControllerDenial(exchange, grant));
    valid(grants.get(grant)?.phase === "consumed" && (state.phase as string) === "delivering");
    assertDeniedHostExecutionPreparation(value, context);
    state.phase = "completed";
    state.window.stop();
  } catch {
    fenceDeniedHostExecutionPreparation(value);
    fenceExchange(exchange);
    throw new Error(failure);
  }
}
