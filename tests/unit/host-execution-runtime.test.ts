/** Native primitive fixtures are intercepted before a fresh private import. They never
 * expose a runtime issuer/subject/transport override to production callers. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  hostControllerPublicBlobRedirectData,
  hostExecutionAudienceUrlData,
  hostGitObjectData,
} from "../../scripts/host-execution-runtime.js";

const root = resolve(import.meta.dir, "../..");
/** The source copy is byte-identical. These early public-acquisition faults do not
 * establish GitHub origin, protected phase provenance or any usable controller capability. */
async function nativeProbe(mode: string): Promise<Record<string, number | boolean>> {
  const directory = mkdtempSync(join(tmpdir(), "tarubot-denial-native-"));
  try {
    cpSync(join(root, "scripts"), join(directory, "scripts"), { recursive: true });
    cpSync(join(root, "ops/host-controller"), join(directory, "ops/host-controller"), {
      recursive: true,
    });
    const path = join(directory, "scripts/host-execution-runtime.ts"),
      original = readFileSync(path, "utf8");
    expect(original).toBe(readFileSync(join(root, "scripts/host-execution-runtime.ts"), "utf8"));
    const script = `
import { spyOn } from "bun:test";
import * as https from "node:https";
import * as http from "node:http";
import { EventEmitter } from "node:events";
const mode=${JSON.stringify(mode)};
let wall=1800000000000, requests=0, ends=0, requestDestroyed=0, agentDestroyed=0, responseDestroyed=0, laterField=0, destroyGetter=0, sensitive=0, tls=true;
Date.now=()=>wall;
const spin=()=>{const end=performance.now()+60;while(performance.now()<end){}};
const env=mode==="inactive"?{PATH:"/usr/bin:/bin"}:{PATH:"/usr/bin:/bin",TB_HOST_TARGET:mode==="production"?"production":"staging",TB_HOST_ACTION:"deploy",TB_HOST_ACCEPT_RELEASE:"true"};
Object.defineProperty(process,"env",{value:new Proxy(env,{get(t,k){if(k==="GITHUB_TOKEN"||k==="ACTIONS_ID_TOKEN_REQUEST_TOKEN")sensitive++;if(mode==="stage-env-expired"){if(k==="TB_HOST_TARGET"){wall+=29980;spin();}if(k==="TB_HOST_ACTION"||k==="TB_HOST_ACCEPT_RELEASE")laterField++;}return Reflect.get(t,k);}})});
class FakeResponse extends EventEmitter {}
class FakeRequest extends EventEmitter {}
const originalAgent=https.Agent;
spyOn(originalAgent.prototype,"destroy").mockImplementation(function(){agentDestroyed++;});
spyOn(http.ClientRequest.prototype,"destroy").mockImplementation(function(){requestDestroyed++;return this;});
spyOn(http.IncomingMessage.prototype,"destroy").mockImplementation(function(){responseDestroyed++;return this;});
const agent=spyOn(https,"Agent").mockImplementation(function(options){tls&&=options.rejectUnauthorized===true;const owned=new originalAgent(options);if(mode==="agent-expired")wall+=240000;return owned;});
Object.defineProperty(agent,"prototype",{value:originalAgent.prototype});
const transport=spyOn(https,"request").mockImplementation((url,options,callback)=>{
 if(url.hostname!=="auth.docker.io"&&url.hostname!=="registry-1.docker.io")throw Error("unexpected-native-route");
 requests++;tls&&=options.rejectUnauthorized===true;
 const request=new FakeRequest();
 Object.defineProperty(request,"destroy",{get(){destroyGetter++;return()=>{};}});
 Object.defineProperty(request,"end",{get(){
  if(mode==="end-expired"){wall+=239980;spin();}
  return()=>{ends++;queueMicrotask(()=>{
   const response=new FakeResponse();response.statusCode=200;
   const body=Buffer.from(requests===1?'{"token":"invented-public-bearer"}':'{}');
   response.rawHeaders=["Content-Length",String(body.length)];
   if(mode==="duplicate")response.rawHeaders=["Content-Length",String(body.length),"content-length",String(body.length)];
   if(mode==="encoded")response.rawHeaders=["Content-Encoding","gzip"];
   if(mode==="length")response.rawHeaders=["Content-Length",String(body.length+1)];
   if(mode==="header-expired"){const raw=response.rawHeaders;response.rawHeaders=new Proxy(raw,{get(t,k){if(k==="0"){wall+=239980;spin();}if(k==="1")laterField++;return Reflect.get(t,k);}});}
   if(mode==="response-expired")wall+=240000;
   if(mode==="held"){const raw=response.rawHeaders;response.rawHeaders=new Proxy(raw,{get(t,k){if(k==="0")wall+=239980;return Reflect.get(t,k);}});}
   callback(response);
   if(mode!=="held")queueMicrotask(()=>{response.emit("data",body);response.emit("end");});
   if(mode==="response-expired")queueMicrotask(()=>response.emit("error",new Error("invented-private-response")));
  });};
 }});
 return request;
});
const installed=await import("node:https");if(installed.request!==transport||installed.Agent!==agent)throw Error("native-interception-missing");
let refused=false;
try{const runtime=await import(${JSON.stringify(path)});await runtime.prepareProtectedHostExecution();}catch(error){refused=error.message==="invalid-protected-host-execution";}
await new Promise(resolve=>setTimeout(resolve,5));
console.log(JSON.stringify({refused,requests,ends,requestDestroyed,agentDestroyed,responseDestroyed,laterField,destroyGetter,sensitive,tls}));
`;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: directory,
      env: { PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 3000,
    });
    const [output, diagnostic, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(diagnostic);
    expect(code).toBe(0);
    expect(diagnostic).toBe("");
    return JSON.parse(output) as Record<string, number | boolean>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("inactive context and production refuse before native acquisition or bearer capture", async () => {
  for (const mode of ["inactive", "production"]) {
    const result = await nativeProbe(mode);
    expect(result.refused).toBe(true);
    expect(result.requests).toBe(0);
    expect(result.agentDestroyed).toBe(0);
    expect(result.sensitive).toBe(0);
  }
});

test("a shortened target getter stops all later evaluated-input and bearer getters", async () => {
  const result = await nativeProbe("stage-env-expired");
  expect(result).toMatchObject({ refused: true, requests: 0, sensitive: 0, laterField: 0 });
});

test("every protected runtime field gets its own original post-capture barrier", () => {
  // Execute only the exact private environment DATA snapshot, never a context/grant
  // constructor. Native-shaped getters model a slow early field before sensitive values.
  const module = join(root, "scripts/host-execution-runtime.ts");
  const script = `
import {readFileSync} from "node:fs";
let wall=1800000000000;Date.now=()=>wall;const runtime=await import(${JSON.stringify(module)});
const source=readFileSync(${JSON.stringify(module)},"utf8"),begin=source.indexOf("  const names = [",source.indexOf("function runtimeCapture(")),end=source.indexOf("  requireNative(\\n    env.GITHUB_REPOSITORY",begin);
if(begin<0||end<0)throw Error("fixture-extraction-failed");
const fragment=source.slice(begin,end)+"return env;";let reads=0,sensitive=0;
const fake={env:new Proxy({}, {get(t,k){reads++;if(k==="GITHUB_TOKEN"||k==="ACTIONS_ID_TOKEN_REQUEST_TOKEN")sensitive++;if(k==="GITHUB_EVENT_PATH"){wall+=29980;const end=performance.now()+60;while(performance.now()<end){}}return "invented";}})};
const work=new Function("window","process","requireNative",new Bun.Transpiler({loader:"ts"}).transformSync(fragment));let refused=false;try{work(new runtime.HostExecutionWindow(30000),fake,value=>{if(!value)throw Error();});}catch{refused=true;}console.log(JSON.stringify({refused,reads,sensitive}));`;
  const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 2000,
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(JSON.parse(child.stdout)).toEqual({ refused: true, reads: 1, sensitive: 0 });
});

test("changed protected target, action or acceptance stops before later bearer capture", () => {
  const module = join(root, "scripts/host-execution-runtime.ts");
  for (const [name, value] of [
    ["TB_HOST_TARGET", "production"],
    ["TB_HOST_ACTION", "arbitrary"],
    ["TB_HOST_ACCEPT_RELEASE", "false"],
  ]) {
    const script = `import {readFileSync} from "node:fs";const runtime=await import(${JSON.stringify(module)}),source=readFileSync(${JSON.stringify(module)},"utf8");const begin=source.indexOf("  const names = [",source.indexOf("function runtimeCapture(")),end=source.indexOf("  requireNative(\\n    env.GITHUB_REPOSITORY",begin);if(begin<0||end<0)throw Error();const fragment=source.slice(begin,end)+"return env;";let sensitive=0,later=0,bad=false;const fake={env:new Proxy({TB_HOST_TARGET:"staging",TB_HOST_ACTION:"deploy",TB_HOST_ACCEPT_RELEASE:"true"},{get(target,key){if(bad)later++;if(key==="GITHUB_TOKEN"||key==="ACTIONS_ID_TOKEN_REQUEST_TOKEN")sensitive++;if(key===${JSON.stringify(name)}){bad=true;return ${JSON.stringify(value)};}return Reflect.get(target,key)??"invented";}})};const work=new Function("window","process","requireNative",new Bun.Transpiler({loader:"ts"}).transformSync(fragment));let refused=false;try{work(new runtime.HostExecutionWindow(30000),fake,value=>{if(!value)throw Error();});}catch{refused=true;}console.log(JSON.stringify({refused,sensitive,later}));`;
    const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 2000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(JSON.parse(child.stdout)).toEqual({ refused: true, sensitive: 0, later: 0 });
  }
});

test("accepted Agent and request cleanup survives original capture expiry", async () => {
  const agent = await nativeProbe("agent-expired");
  expect(agent.refused).toBe(true);
  expect(agent.requests).toBe(0);
  expect(agent.agentDestroyed).toBe(1);
  const request = await nativeProbe("end-expired");
  expect(request.refused).toBe(true);
  expect(request.requests).toBe(1);
  expect(request.ends).toBe(0);
  expect(request.requestDestroyed).toBe(1);
  expect(request.agentDestroyed).toBe(1);
  expect(request.destroyGetter).toBe(0);
});

test("accepted response owns passive sinks before refusal and stops later field offers", async () => {
  for (const mode of ["header-expired", "response-expired", "held"]) {
    const result = await nativeProbe(mode);
    expect(result.refused).toBe(true);
    expect(result.requests).toBe(1);
    expect(result.requestDestroyed).toBe(1);
    expect(result.agentDestroyed).toBe(1);
    expect(result.responseDestroyed).toBe(1);
    expect(result.laterField).toBe(0);
    expect(result.destroyGetter).toBe(0);
  }
});

test("native duplicate headers, encoded bytes and inconsistent lengths refuse", async () => {
  for (const mode of ["duplicate", "encoded", "length"]) {
    const result = await nativeProbe(mode);
    expect(result.refused).toBe(true);
    expect(result.requests).toBe(1);
    expect(result.tls).toBe(true);
  }
  const result = await nativeProbe("normal");
  // Genuine-shaped token DATA reaches the next fixed manifest read; no build/authority exists.
  expect(result.refused).toBe(true);
  expect(result.requests).toBe(2);
  expect(result.ends).toBe(2);
  expect(result.requestDestroyed).toBe(2);
  expect(result.tls).toBe(true);
});

test("authenticated raw Git objects reject wrong object type, digest and intrinsic bytes", () => {
  const payload = Buffer.from("invented immutable source\n"),
    sha = createHash("sha1").update(`blob ${payload.length}\0`).update(payload).digest("hex");
  const raw = Buffer.concat([
    Buffer.from(`${sha} blob ${payload.length}\n`),
    payload,
    Buffer.from("\n"),
  ]);
  expect(hostGitObjectData(raw, sha, "blob")).toEqual(payload);
  expect(() => hostGitObjectData(raw, sha, "tree")).toThrow("invalid-protected-host-execution");
  const changed = Buffer.from(raw);
  const at = changed.length - 2;
  changed[at] = (changed[at] ?? 0) ^ 1;
  expect(() => hostGitObjectData(changed, sha, "blob")).toThrow("invalid-protected-host-execution");
  const substituted = new Uint8Array([255]);
  Object.defineProperty(substituted, Symbol.iterator, {
    value: function* () {
      yield* raw;
    },
  });
  expect(() => hostGitObjectData(substituted, sha, "blob")).toThrow(
    "invalid-protected-host-execution",
  );
});

test("mint URL DATA admits one exact audience and denies namespace/route ambiguity", () => {
  const audience = `urn:tarubot:host-execution-denial:v1:${"a".repeat(64)}`;
  const raw = "https://pipelines.actions.githubusercontent.com/opaque?api-version=1";
  expect(new URL(hostExecutionAudienceUrlData(raw, audience)).searchParams.get("audience")).toBe(
    audience,
  );
  for (const input of [
    `${raw}&audience=other`,
    `${raw}&API-version=2`,
    "https://pipelines.actions.githubusercontent.com/opaque?",
    "https://actions.githubusercontent.com/opaque",
    "http://pipelines.actions.githubusercontent.com/opaque",
  ])
    expect(() => hostExecutionAudienceUrlData(input, audience)).toThrow(
      "invalid-protected-host-execution",
    );
  expect(() =>
    hostExecutionAudienceUrlData(raw, `urn:tarubot:host-execution-real:v1:${"a".repeat(64)}`),
  ).toThrow("invalid-protected-host-execution");
});

test("public blob redirect DATA is confined to exact reviewed hosts and pinned path", () => {
  const digest = "b".repeat(64),
    path = `/registry-v2/docker/registry/v2/blobs/sha256/bb/${digest}/data?Expires=1&Signature=invented`;
  for (const host of [
    "production.cloudfront.docker.com",
    "production.cloudflare.docker.com",
    "docker-images-prod.6aa30f8b08e16409b46e0173d6de2f56.r2.cloudflarestorage.com",
  ])
    expect(hostControllerPublicBlobRedirectData(`https://${host}${path}`, digest)).toBe(
      `https://${host}${path}`,
    );
  for (const host of [
    "production.cloudfront.docker.com.example.org",
    "other.r2.cloudflarestorage.com",
    "registry-1.docker.io",
  ])
    expect(() => hostControllerPublicBlobRedirectData(`https://${host}${path}`, digest)).toThrow(
      "invalid-protected-host-execution",
    );
});

test("private DATA persistence cleans only exact newly owned resources on unknown writes", () => {
  // Evaluate the exact private DATA writer in an isolated native-filesystem fixture. This
  // creates no context/proof/grant and never changes the production module's exports.
  const source = join(root, "scripts/host-execution-runtime.ts");
  for (const fault of ["mkdir-expired", "open-expired", "write-unknown", "existing"]) {
    const script = `
import * as fs from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
let wall=1800000000000;Date.now=()=>wall;
const runtime=await import(${JSON.stringify(source)}),text=fs.readFileSync(${JSON.stringify(source)},"utf8");
const read=text.slice(text.indexOf("function safePrivateRoot("),text.indexOf("function runtimeCapture("));
const write=text.slice(text.indexOf("function writePreparationRecord("),text.indexOf("function preparationStatement("));
const transpiler=new Bun.Transpiler({loader:"ts"});const js=transpiler.transformSync(read+write+";return writePreparationRecord;");
const temporary=fs.mkdtempSync(join(tmpdir(),"tarubot-private-data-"));const directory=join(temporary,"owned");const fault=${JSON.stringify(fault)};
let acceptedFd,closed=0;
if(fault==="existing"){fs.mkdirSync(directory,{mode:0o700});fs.writeFileSync(join(directory,"sentinel"),"invented-kept");}
const mkdir=(...args)=>{fs.mkdirSync(...args);if(fault==="mkdir-expired")wall+=30000;};
const open=(...args)=>{const fd=fs.openSync(...args);acceptedFd=fd;if(fault==="open-expired")wall+=30000;return fd;};
const writeBytes=(...args)=>{const count=fs.writeSync(...args);if(fault==="write-unknown")throw Error("invented-private-write");return count;};
const close=fd=>{closed++;fs.closeSync(fd);};
const fn=new Function("fsFlags","dirname","resolve","lstatSync","mkdirSync","openSync","closeSync","readSync","writeSync","fstatSync","fsyncSync","unlinkSync","rmdirSync","join","requireNative",js)(fs.constants,(await import("node:path")).dirname,(await import("node:path")).resolve,fs.lstatSync,mkdir,open,close,fs.readSync,writeBytes,fs.fstatSync,fs.fsyncSync,fs.unlinkSync,fs.rmdirSync,join,value=>{if(!value)throw Error("invalid-protected-host-execution");});
let refused=false;try{fn({private_directory:directory},{schema:1,statement:{purpose:"invented-data"},jwt:"invented-only"},new runtime.HostExecutionWindow(30000));}catch{refused=true;}
const kept=fault==="existing"&&fs.readFileSync(join(directory,"sentinel"),"utf8")==="invented-kept";const exists=fs.existsSync(directory);
fs.rmSync(temporary,{recursive:true,force:true});console.log(JSON.stringify({refused,kept,exists,closed,hadFd:acceptedFd!==undefined}));
`;
    const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 2000,
    });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const result = JSON.parse(child.stdout) as Record<string, number | boolean>;
    expect(result.refused).toBe(true);
    if (fault === "existing") expect(result).toMatchObject({ kept: true, exists: true, closed: 0 });
    else {
      expect(result.exists).toBe(false);
      expect(result.closed).toBe(fault === "mkdir-expired" ? 0 : 1);
    }
  }
});

test("the exact private RS256 DATA verifier rejects altered scope and expired preparation", () => {
  // This extraction returns only signed time DATA, never a native context, exchange,
  // authentication or grant. It exercises the unchanged verifier with real RSA bytes;
  // the genuine native-origin composition is separately rehearsed behind the opt-in.
  const module = join(root, "scripts/host-execution-runtime.ts");
  const script = `
import {readFileSync} from "node:fs";import {createPublicKey,constants,verify,generateKeyPairSync,sign} from "node:crypto";
import {controllerJson,controllerDigest} from ${JSON.stringify(join(root, "scripts/host-controller-closure.ts"))};
import {currentHostPhasePins} from ${JSON.stringify(join(root, "scripts/host-execution-run.ts"))};
let wall=1800000000500;Date.now=()=>wall;const runtime=await import(${JSON.stringify(module)}),source=readFileSync(${JSON.stringify(module)},"utf8");
const fragments=source.slice(source.indexOf("function object("),source.indexOf("export interface ProtectedHostExecutionBinding"))+source.slice(source.indexOf("function subject("),source.indexOf("function profileConfigured("))+source.slice(source.indexOf("const prepPurpose ="),source.indexOf("/** Pure routing DATA.",source.indexOf("const prepPurpose =")))+source.slice(source.indexOf("function statementAudience("),source.indexOf("async function mintToken("))+"return authenticateToken;";
const js=new Bun.Transpiler({loader:"ts"}).transformSync(fragments),requireNative=value=>{if(!value)throw Error("invalid-protected-host-execution");};
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048}),key={...publicKey.export({format:"jwk"}),kid:"invented-data-kid",use:"sig",alg:"RS256"};
const purpose="tarubot-host-execution-denial-v1",prep="tarubot-host-preparation-data-v1",issuer="https://token.actions.githubusercontent.com",jwks=issuer+"/.well-known/jwks";const sha="a".repeat(40);
const base={schema:1,purpose,grant_nonce:"1".repeat(64),job_id:600,check_run_id:700,issued_at:wall,expires_at:wall+30000,context:{producer_sha256:"2".repeat(64),scope:{owner_id:100,repository_id:200,environment_id:400,gate_policy_sha256:"3".repeat(64)}}};
const capture={declaration:{release:{commit:sha,config_commit:sha,publication_run:"500"}},configuration:{owner_id:100,repository_id:200}};
const origin={job_id:600,check_run_id:700,critical_started_at:wall-1000,preparation_started_at:wall-1000,preparation_completed_at:wall+1000};
const outputs=[];
for(const mode of ["denial","preparation","expired-preparation","future-nbf","wrong-check","wrong-environment","wrong-source","wrong-owner","wrong-repository","wrong-interval","legacy-subject","unknown-subject","changed-owner-scope","changed-repository-scope","changed-environment-scope","changed-policy","changed-producer","wrong-purpose","wrong-signature","short-expiry"]){
 wall=1800000000500;let reads=0,refused=false,shortened=false;
 const preparation=mode==="preparation"||mode==="expired-preparation",statement=structuredClone(base);if(preparation)statement.purpose=prep;
 const expected=structuredClone(statement),claims={iss:issuer,aud:(preparation?"urn:tarubot:host-preparation-data:v1:":"urn:tarubot:host-execution-denial:v1:")+controllerDigest(Buffer.from(JSON.stringify(statement))),sub:"repo:deconfined@100/tarubot@200:environment:staging",repository:"deconfined/tarubot",repository_owner:"deconfined",repository_id:"200",repository_owner_id:"100",ref:"refs/heads/main",ref_type:"branch",ref_protected:"true",event_name:"push",sha,run_id:"500",run_attempt:"1",workflow_ref:currentHostPhasePins.publication,workflow_sha:sha,job_workflow_ref:currentHostPhasePins.host,job_workflow_sha:sha,environment:"staging",check_run_id:"700",head_ref:"",base_ref:"",runner_environment:"github-hosted",jti:"invented",iat:1800000000,nbf:1800000000,exp:1800000300};
 if(mode==="expired-preparation")claims.exp=1800000000;if(mode==="future-nbf")claims.nbf=1800000001;if(mode==="wrong-check")claims.check_run_id="701";if(mode==="wrong-environment")claims.environment="production";if(mode==="wrong-source")claims.job_workflow_sha="b".repeat(40);if(mode==="wrong-owner")claims.repository_owner_id="101";if(mode==="wrong-repository")claims.repository_id="201";if(mode==="short-expiry")claims.exp=1800000001;
 if(mode==="legacy-subject")claims.sub="repo:deconfined/tarubot:environment:staging";if(mode==="unknown-subject")claims.sub="repo:unknown@100/tarubot@200:environment:staging";
 if(mode==="changed-owner-scope")expected.context.scope.owner_id=101;if(mode==="changed-repository-scope")expected.context.scope.repository_id=201;if(mode==="changed-environment-scope")expected.context.scope.environment_id=401;if(mode==="changed-policy")expected.context.scope.gate_policy_sha256="4".repeat(64);if(mode==="changed-producer")expected.context.producer_sha256="5".repeat(64);if(mode==="wrong-purpose")expected.purpose=prep;
 const observed=structuredClone(origin);if(mode==="wrong-interval")observed.critical_started_at=wall+5000;
 const input=Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT",kid:key.kid})).toString("base64url")+"."+Buffer.from(JSON.stringify(claims)).toString("base64url"),signature=sign("RSA-SHA256",Buffer.from(input),privateKey);if(mode==="wrong-signature")signature[0]^=1;const jwt=input+"."+signature.toString("base64url");
 const nativeRead=async(url,window)=>{requireNative(url===jwks);window.check();reads++;return {status:200,headers:{},body:Buffer.from(JSON.stringify({keys:[key]}))};};
 const authenticate=new Function("requireNative","controllerJson","controllerDigest","createPublicKey","constants","verify","reviewedSubjectProfile","currentHostPhasePins","issuer","jwks","nativeRead",js)(requireNative,controllerJson,controllerDigest,createPublicKey,constants,verify,"immutable",currentHostPhasePins,issuer,jwks,nativeRead);
 const window=new runtime.HostExecutionWindow(30000);try{const facts=await authenticate(jwt,expected,preparation?prep:purpose,capture,observed,window,preparation);if(mode==="short-expiry"){window.restrict(facts.expires_at);wall=facts.expires_at;try{window.check();}catch{shortened=true;}}}catch(error){refused=error.message==="invalid-protected-host-execution";}finally{window.stop();}
 outputs.push({mode,refused,reads,shortened});
}console.log(JSON.stringify(outputs));`;
  const child = spawnSync(process.execPath, ["--no-env-file", "--eval", script], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 4000,
  });
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  const cases = JSON.parse(child.stdout) as {
    mode: string;
    refused: boolean;
    reads: number;
    shortened: boolean;
  }[];
  for (const item of cases) {
    if (["denial", "preparation", "short-expiry"].includes(item.mode))
      expect(item).toMatchObject({
        refused: false,
        reads: 1,
        shortened: item.mode === "short-expiry",
      });
    else
      expect(item).toMatchObject({ refused: true, reads: item.mode === "wrong-signature" ? 1 : 0 });
  }
});
