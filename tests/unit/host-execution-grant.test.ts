/** Copied declarations, preparation DATA and caller JWTs cannot mint denial authority. */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  beginDeniedHostExecutionGrant,
  assertDeniedHostExecutionPreparation,
  assertDeniedHostExecutionGrant,
  consumeDeniedHostExecutionGrant,
  finishDeniedHostExecutionGrant,
  hostExecutionDenialAudience,
  hostExecutionDenialPurpose,
  hostPreparationDataAudience,
  hostPreparationDataPurpose,
  type DeniedHostExecutionGrant,
  type DeniedHostExecutionPreparation,
} from "../../scripts/host-execution-grant.js";
import type { ProtectedHostExecutionContext } from "../../scripts/host-execution-runtime.js";
import type { OwnedControllerExchange } from "../../scripts/host-controller.js";

test("preparation DATA and permanent denial have distinct exact purposes", () => {
  expect(hostExecutionDenialPurpose).toBe("tarubot-host-execution-denial-v1");
  expect(hostExecutionDenialAudience).toBe("urn:tarubot:host-execution-denial:v1:");
  expect(hostPreparationDataPurpose).toBe("tarubot-host-preparation-data-v1");
  expect(hostPreparationDataAudience).toBe("urn:tarubot:host-preparation-data:v1:");
});

test("caller JSON, copied caps and signed-looking strings never issue a native grant", async () => {
  const context = Object.freeze({
    purpose: hostPreparationDataPurpose,
    jwt: "invented.signed.token",
  }) as unknown as ProtectedHostExecutionContext;
  const exchange = Object.freeze({
    purpose: hostExecutionDenialPurpose,
  }) as unknown as OwnedControllerExchange;
  const prep = Object.freeze({}) as DeniedHostExecutionPreparation,
    grant = Object.freeze({}) as DeniedHostExecutionGrant;
  expect(() => beginDeniedHostExecutionGrant(context)).toThrow("invalid-denied-host-execution");
  expect(() => assertDeniedHostExecutionPreparation(prep, context)).toThrow(
    "invalid-denied-host-execution",
  );
  expect(() => assertDeniedHostExecutionGrant(grant, exchange, context)).toThrow(
    "invalid-denied-host-execution",
  );
  expect(() => consumeDeniedHostExecutionGrant(grant, exchange, context)).toThrow(
    "invalid-denied-host-execution",
  );
  await expect(finishDeniedHostExecutionGrant(prep, context, exchange)).rejects.toThrow(
    "invalid-denied-host-execution",
  );
});

test("swallowed wrong-cap clock assertions and stop paths fence the original attempt", () => {
  const module = resolve(import.meta.dir, "../../scripts/host-execution-runtime.ts");
  const grant = resolve(import.meta.dir, "../../scripts/host-execution-grant.ts");
  for (const operation of ["assert", "context-stop", "preparation-stop"]) {
    const code = `let runtime,grant,enabled=false,offers=0,nested=0;Date.now=()=>{if(enabled){enabled=false;nested++;try{const cap=Object.freeze({});if(${JSON.stringify(operation)}==="assert")runtime.assertProtectedHostExecutionContextData(cap);else if(${JSON.stringify(operation)}==="context-stop")runtime.fenceProtectedHostExecutionContext(cap);else grant.fenceDeniedHostExecutionPreparation(cap);}catch{}}return 1800000000000;};runtime=await import(${JSON.stringify(module)});grant=await import(${JSON.stringify(grant)});const window=new runtime.HostExecutionWindow(30000);enabled=true;let denied=false;try{window.capture(()=>offers++);}catch{denied=true;}console.log(JSON.stringify({offers,nested,denied}));`;
    const result = spawnSync(process.execPath, ["--eval", code], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 2000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ offers: 0, nested: 1, denied: true });
  }
});

test("the same owned synchronous work cost cannot renew a shortened bound", () => {
  const module = resolve(import.meta.dir, "../../scripts/host-execution-runtime.ts");
  const code = `let wall=1800000000000;Date.now=()=>wall;const {HostExecutionWindow}=await import(${JSON.stringify(module)});const window=new HostExecutionWindow(30000);let offers=0,denied=false;try{window.capture(()=>{wall+=29980;const end=performance.now()+60;while(performance.now()<end){}window.check();offers++;});}catch{denied=true;}console.log(JSON.stringify({offers,denied}));`;
  const result = spawnSync(process.execPath, ["--eval", code], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ offers: 0, denied: true });
});
