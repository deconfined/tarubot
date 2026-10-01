/** The native driver refuses copied origins before any controller release/handler. */
import { expect, test } from "bun:test";
import { driveOwnedHostDenial } from "../../scripts/host-execution-driver.js";
import type { ProtectedHostExecutionContext } from "../../scripts/host-execution-runtime.js";
import type { PausedHostController } from "../../scripts/host-controller.js";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  lstatSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

test("paused inspection and phase declarations are DATA, not a private origin", async () => {
  const context = Object.freeze({
    declaration: { target: "staging", action: "deploy" },
    context_nonce: "a".repeat(64),
  }) as unknown as ProtectedHostExecutionContext;
  const paused = Object.freeze({ kind: "paused-host-controller" }) as PausedHostController;
  await expect(driveOwnedHostDenial(context, paused)).rejects.toThrow(
    "protected-host-execution-denied",
  );
});

/** Explicit opt-in local rehearsal only. Ordinary unit runs never allocate an engine image.
 * Root/peer must freeze launcher/pins and the independently PREderived expectation first.
 * Source bytes/modes are identical to the candidate and authenticated by a real local Git
 * object graph. HTTP/RSA identities are invented; image, kernel, workers and DENY stay native. */
if (process.env.TARUBOT_HOST_DENIAL_NATIVE_REHEARSAL === "1")
  test("conditional owned-source/Git/RSA real-worker DENY prerequisite", async () => {
    const root = resolve(import.meta.dir, "../..");
    // These are populated ONLY from the independently verified pre-build model after freeze.
    const expectedRootfs = "69046ac904c134b1798f799148aea914a671b5cf5f806d04846a17585fa8dda8",
      expectedRecipe = "e599e50b439d2fd112dfabc1cf5c68fbfeed5ec20316e0ff7bcb8b760d13e3e3";
    expect(/^[a-f0-9]{64}$/u.test(expectedRootfs) && /^[a-f0-9]{64}$/u.test(expectedRecipe)).toBe(
      true,
    );
    const directory = mkdtempSync(join(tmpdir(), "tarubot-denial-rehearsal-"));
    try {
      chmodSync(directory, 0o700);
      const gitEnv = {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_COUNT: "0",
        GIT_NO_LAZY_FETCH: "1",
      };
      // Git's canonical source list excludes ignored generated archives/trees. The
      // selected tracked/untracked source bytes still undergo exact path/mode checks.
      const listing = spawnSync(
        "/usr/bin/git",
        [
          "--no-lazy-fetch",
          "--no-replace-objects",
          "-C",
          root,
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          "scripts",
          "src",
          ".github",
          "ops/ansible",
          "ops/host-controller",
          "ops/age-recipients.txt",
          "package.json",
          "bun.lock",
          "tsconfig.json",
        ],
        { env: gitEnv, timeout: 10000, maxBuffer: 16 * 1024 * 1024 },
      );
      expect(listing.status).toBe(0);
      expect(listing.stderr.length).toBe(0);
      const listed = new TextDecoder("utf-8", { fatal: true }).decode(listing.stdout);
      expect(listed.endsWith("\0")).toBe(true);
      const pathsToCopy = listed.slice(0, -1).split("\0");
      expect(new Set(pathsToCopy).size).toBe(pathsToCopy.length);
      for (const path of pathsToCopy) {
        expect(
          path.length > 0 &&
            path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..") &&
            resolve(root, path) === join(root, path) &&
            resolve(root, path).startsWith(`${root}/`),
        ).toBe(true);
        const source = join(root, path),
          stat = lstatSync(source);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.isFile()).toBe(true);
        const target = join(directory, path);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, readFileSync(source), { flag: "wx", mode: stat.mode & 0o777 });
        chmodSync(target, stat.mode & 0o777);
      }
      const entries: { path: string; bytes: Buffer; mode: string }[] = [];
      for (const path of pathsToCopy) {
        const stat = lstatSync(join(directory, path)),
          bytes = readFileSync(join(directory, path));
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.isFile()).toBe(true);
        expect(bytes.equals(readFileSync(join(root, path)))).toBe(true);
        expect(stat.mode & 0o777).toBe(lstatSync(join(root, path)).mode & 0o777);
        entries.push({ path, bytes, mode: stat.mode & 0o111 ? "100755" : "100644" });
      }
      const initialized = spawnSync("/usr/bin/git", ["init", "--quiet", directory], {
        env: gitEnv,
        encoding: "utf8",
      });
      expect(initialized.status).toBe(0);
      const writeObject = (kind: string, bytes: Buffer) => {
        const expected = createHash("sha1")
          .update(`${kind} ${bytes.length}\0`)
          .update(bytes)
          .digest("hex");
        const result = spawnSync(
          "/usr/bin/git",
          ["-C", directory, "hash-object", "-w", "--stdin", "-t", kind],
          { env: gitEnv, input: bytes, encoding: "utf8" },
        );
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(expected);
        return expected;
      };
      const trees = new Map<string, { name: string; mode: string; sha: string }[]>();
      for (const entry of entries) {
        const path = dirname(entry.path),
          list = trees.get(path) ?? [];
        list.push({
          name: entry.path.slice(path === "." ? 0 : path.length + 1),
          mode: entry.mode,
          sha: writeObject("blob", entry.bytes),
        });
        trees.set(path, list);
      }
      const paths = new Set<string>(["."]);
      for (const entry of entries)
        for (let path = dirname(entry.path); path !== "."; path = dirname(path)) paths.add(path);
      for (const path of [...paths].sort(
        (a, b) =>
          b.split("/").length - a.split("/").length ||
          Buffer.compare(Buffer.from(b), Buffer.from(a)),
      )) {
        const list = trees.get(path) ?? [];
        list.sort((a, b) =>
          Buffer.compare(
            Buffer.from(`${a.name}${a.mode === "40000" ? "/" : ""}`),
            Buffer.from(`${b.name}${b.mode === "40000" ? "/" : ""}`),
          ),
        );
        const sha = writeObject(
          "tree",
          Buffer.concat(
            list.flatMap((row) => [
              Buffer.from(`${row.mode} ${row.name}\0`),
              Buffer.from(row.sha, "hex"),
            ]),
          ),
        );
        if (path === ".") trees.set("root", [{ name: "root", mode: "40000", sha }]);
        else {
          const parent = dirname(path),
            rows = trees.get(parent) ?? [];
          rows.push({
            name: path.slice(parent === "." ? 0 : parent.length + 1),
            mode: "40000",
            sha,
          });
          trees.set(parent, rows);
        }
      }
      const tree = trees.get("root")?.[0]?.sha;
      expect(tree).toBeDefined();
      const commit = writeObject(
        "commit",
        Buffer.from(
          `tree ${tree}\nauthor Fixture <fixture@example.org> 1800000000 +0000\ncommitter Fixture <fixture@example.org> 1800000000 +0000\n\nOwned fixture source\n`,
        ),
      );
      const temporary = join(directory, "private-runtime");
      cpSync(join(root, "ops/host-controller/pins.json"), join(directory, "fixture-pins.json"));
      const script = `
import {spyOn} from "bun:test";import * as https from "node:https";import * as http from "node:http";import * as childProcess from "node:child_process";
import {EventEmitter} from "node:events";import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,copyFileSync,chmodSync,existsSync,realpathSync,constants as fsConstants} from "node:fs";import {join} from "node:path";import {generateKeyPairSync,sign,createHash} from "node:crypto";
const source=${JSON.stringify(directory)},commit=${JSON.stringify(commit)},cache=${JSON.stringify(resolve(root, "../controller35-public"))};
const pins=JSON.parse(readFileSync(join(source,"fixture-pins.json"),"utf8"));
const evidenceDirectory=mkdtempSync("/tmp/controller39-native-evidence-");chmodSync(evidenceDirectory,0o700);
// Passive diagnostics only: return the actual original Error with unchanged constructor
// semantics. Retain fixed failure stacks privately, never capability/HTTP/mint arguments.
const failures=[],OriginalError=globalThis.Error,observerPhysical=performance.now.bind(performance),observerStarted=observerPhysical(),closedFailures=new Set(["invalid-protected-host-execution","invalid-denied-host-execution","host-controller-failed","host-controller-closure-failed","invalid-current-host-phase","protected-host-execution-denied"]);
const observeError=(value,args)=>{if(failures.length<32&&typeof args[0]==="string"&&closedFailures.has(args[0])){const stack=value.stack;if(typeof stack==="string")failures.push({message:args[0],elapsed_ms:observerPhysical()-observerStarted,stack:Buffer.from(stack).subarray(0,8192).toString("utf8")});}return value;};
globalThis.Error=new Proxy(OriginalError,{construct(target,args,newTarget){return observeError(Reflect.construct(target,args,newTarget),args);},apply(target,receiver,args){return observeError(Reflect.apply(target,receiver,args),args);}});
let wall=Date.now(),phase="preparation",apiGets=0,mints=0,jwksReads=0,actualChildren=0,exchanges=0,denied=0,worker=0,prepared=0,artifactMatch=true,inputComplete=false,requestComplete=false,observerValid=true;const frames=[],engineOffers=[],ownedTags=new Set(),ownedContainers=new Set(),ownedPaths=new Set(),archives=[];
const baseWall=wall;Date.now=()=>wall;
const {privateKey,publicKey}=generateKeyPairSync("rsa",{modulusLength:2048});const key={...publicKey.export({format:"jwk"}),kid:"invented-native-kid",use:"sig",alg:"RS256"};
const stamp=offset=>new Date(baseWall+offset).toISOString();const api="https://api.github.com/repos/deconfined/tarubot";
const repo={id:200,full_name:"deconfined/tarubot",fork:false,owner:{id:100,login:"deconfined"}};
const run={id:500,workflow_id:300,head_sha:commit,head_branch:"main",event:"push",run_attempt:1,status:"in_progress",conclusion:null,url:api+"/actions/runs/500",path:".github/workflows/publish.yml",repository:repo,head_repository:repo,referenced_workflows:[{path:"deconfined/tarubot/.github/workflows/release.yml@refs/heads/main",ref:"refs/heads/main",sha:commit},{path:"deconfined/tarubot/.github/workflows/host.yml@refs/heads/main",ref:"refs/heads/main",sha:commit}]};
const jobName="Replacement release orchestration / staging / Host";
const complete=(name,number,begin,end)=>({name,number,status:"completed",conclusion:"success",started_at:stamp(begin),completed_at:stamp(end)});
function data(url){const prep=phase==="preparation"?{name:"Prepare private host execution grant",number:3,status:"in_progress",conclusion:null,started_at:stamp(-500),completed_at:null}:complete("Prepare private host execution grant",3,-500,1000);
const execute={name:"Run protected host controller",number:4,status:phase==="preparation"?"queued":"in_progress",conclusion:null,started_at:phase==="preparation"?null:stamp(2000),completed_at:null};
const job={id:600,name:jobName,run_id:500,run_attempt:1,head_sha:commit,head_branch:"main",url:api+"/actions/jobs/600",run_url:run.url,check_run_url:api+"/check-runs/700",status:"in_progress",conclusion:null,started_at:stamp(-5000),completed_at:null,steps:[complete("Check the request",1,-4900,-4800),complete("Recheck automatic release freshness",2,-4700,-4600),prep,execute]};
const check={id:700,name:jobName,url:api+"/check-runs/700",head_sha:commit,status:"in_progress",conclusion:null,started_at:job.started_at,completed_at:null,app:{id:800,slug:"github-actions"},check_suite:{id:900}};
const routes={[api]:repo,[api+"/actions/runs/500"]:run,[api+"/branches/main"]:{name:"main",protected:true,commit:{sha:commit}},[api+"/environments/staging"]:{id:400,name:"staging",url:api+"/environments/staging",deployment_branch_policy:{protected_branches:false,custom_branch_policies:true},protection_rules:[]},[api+"/environments/staging/deployment-branch-policies?per_page=100&page=1"]:{total_count:1,branch_policies:[{id:401,name:"main",type:"branch"}]},[api+"/actions/runs/500/attempts/1/jobs?per_page=100&page=1"]:{total_count:1,jobs:[job]},[api+"/actions/jobs/600"]:job,[api+"/check-runs/700"]:check};if(!Object.hasOwn(routes,url))throw Error("unexpected-invented-api-route");return routes[url];}
const nativeSpawn=childProcess.spawn;const observedSpawn=spyOn(childProcess,"spawn").mockImplementation(function(...args){
const [file,argv,options]=args;engineOffers.push({file,argv:[...argv],cwd:options.cwd});if(options.cwd?.startsWith("/tmp/tarubot-controller-"))ownedPaths.add(options.cwd);
for(let at=0;at<argv.length;at++){if(argv[at]==="--tag")ownedTags.add(argv[at+1]);if(argv[at]==="--name")ownedContainers.add(argv[at+1]);if(typeof argv[at]==="string"&&["docker.io/library/tarubot-controller:","docker.io/library/tarubot-controller-base:"].some(prefix=>argv[at].startsWith(prefix)&&/^[a-f0-9]{32}$/.test(argv[at].slice(prefix.length))))ownedTags.add(argv[at]);}
const child=nativeSpawn(...args);
if(argv.includes("save")){const path=argv[argv.indexOf("--output")+1];EventEmitter.prototype.on.call(child,"close",code=>{if(code===0){try{const output=join(evidenceDirectory,"image-"+archives.length+".tar");copyFileSync(path,output,fsConstants.COPYFILE_EXCL);chmodSync(output,0o600);archives.push({path:output,native_image_id:argv.at(-1)});}catch{observerValid=false;}}});}
if(argv.includes("run")){actualChildren++;let pending=Buffer.alloc(0);EventEmitter.prototype.on.call(child.stdout,"data",chunk=>{try{pending=Buffer.concat([pending,chunk]);if(pending.length>12*1024*1024)throw Error();while(pending.length>=8){if(pending.subarray(0,4).toString()!=="HCP1")throw Error();const size=pending.readUInt32BE(4);if(size>32768)throw Error();if(pending.length<size+8)break;const value=JSON.parse(pending.subarray(8,8+size).toString());pending=pending.subarray(8+size);frames.push(value);if(value.kind==="prepared"){prepared++;artifactMatch&&=value.recipe_sha256===${JSON.stringify(expectedRecipe)};}if(value.kind==="exchange"){exchanges++;worker=value.worker;}if(value.kind==="exchange-end"){const header=frames.find(frame=>frame.kind==="exchange"),input=frames.filter(frame=>frame.kind==="input");const body=Buffer.concat(input.map(frame=>Buffer.from(frame.data,"base64")));inputComplete=input.length===value.chunks&&body.length===header.input_size&&createHash("sha256").update(body).digest("hex")===header.input_sha256;const request=Buffer.from(header.request_b64,"base64");requestComplete=createHash("sha256").update(request).digest("hex")===header.request_sha256;}if(value.kind==="denied")denied++;}}catch{observerValid=false;}});}return child;});
spyOn(http.ClientRequest.prototype,"destroy").mockImplementation(function(){return this;});spyOn(http.IncomingMessage.prototype,"destroy").mockImplementation(function(){return this;});
const transport=spyOn(https,"request").mockImplementation((url,options,callback)=>{let body;
if(url.hostname==="auth.docker.io")body=Buffer.from('{"token":"invented-public-token"}');
else if(url.hostname==="registry-1.docker.io"){if(url.pathname.includes("/manifests/"))body=readFileSync(join(cache,"python-amd64-manifest.json"));else {const sha=url.pathname.split(":").at(-1);if(sha===pins.base.config_sha256)body=readFileSync(join(cache,"python-amd64-config.json"));else{const at=pins.base.layers.findIndex(layer=>layer.sha256===sha);if(at<0)throw Error("unexpected-pinned-blob");body=readFileSync(join(cache,"python-layer-"+at+".tar.gz"));}}}
else if(url.hostname==="files.pythonhosted.org"){const pin=pins.wheels.find(wheel=>wheel.url===url.href);if(!pin)throw Error("unexpected-pinned-wheel");body=readFileSync(join(cache,pin.filename));}
else if(url.hostname==="api.github.com"){apiGets++;body=Buffer.from(JSON.stringify(data(url.href)));}
else if(url.href==="https://token.actions.githubusercontent.com/.well-known/jwks"){jwksReads++;body=Buffer.from(JSON.stringify({keys:[key]}));}
else if(url.hostname==="pipelines.actions.githubusercontent.com"){mints++;if(options.headers.Authorization!=="Bearer invented-runner-mint-bearer")throw Error("wrong-private-bearer");const claims={iss:"https://token.actions.githubusercontent.com",aud:url.searchParams.get("audience"),sub:"repo:deconfined@100/tarubot@200:environment:staging",repository:"deconfined/tarubot",repository_owner:"deconfined",repository_id:"200",repository_owner_id:"100",ref:"refs/heads/main",ref_type:"branch",ref_protected:"true",event_name:"push",sha:commit,run_id:"500",run_attempt:"1",workflow_ref:"deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",workflow_sha:commit,job_workflow_ref:"deconfined/tarubot/.github/workflows/host.yml@refs/heads/main",job_workflow_sha:commit,environment:"staging",check_run_id:"700",head_ref:"",base_ref:"",runner_environment:"github-hosted",jti:"invented-"+mints,iat:Math.floor(wall/1000),nbf:Math.floor(wall/1000),exp:Math.floor(wall/1000)+300};const input=Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT",kid:key.kid})).toString("base64url")+"."+Buffer.from(JSON.stringify(claims)).toString("base64url");body=Buffer.from(JSON.stringify({value:input+"."+sign("RSA-SHA256",Buffer.from(input),privateKey).toString("base64url")}));}
else throw Error("unexpected-native-route");
if(options.rejectUnauthorized!==true)throw Error("TLS-policy-refused");const request=new EventEmitter();request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;response.rawHeaders=["Content-Type","application/json","Content-Length",String(body.length)];callback(response);for(let at=0;at<body.length;at+=65536)response.emit("data",body.subarray(at,at+65536));response.emit("end");});return request;});
if((await import("node:https")).request!==transport||(await import("node:child_process")).spawn!==observedSpawn)throw Error("native-interception-missing");
const closure=await import(join(source,"scripts/host-controller-closure.ts"));const recipe={};for(const name of ["Containerfile","assemble.py","launcher.py","pins.json"])recipe[name]=readFileSync(join(source,"ops/host-controller",name));for(const name of ["tarubot_guarded.py","_tarubot_frames.py"])recipe[name]=readFileSync(join(source,"ops/ansible/connection_plugins",name));
const publicBytes={manifest:readFileSync(join(cache,"python-amd64-manifest.json")),config:readFileSync(join(cache,"python-amd64-config.json")),layers:pins.base.layers.map((_,at)=>readFileSync(join(cache,"python-layer-"+at+".tar.gz"))),wheels:Object.fromEntries(pins.wheels.map(pin=>[pin.filename,readFileSync(join(cache,pin.filename))]))};
const preexpected=closure.deriveControllerClosure(publicBytes,recipe);if(preexpected.rootfs_sha256!==${JSON.stringify(expectedRootfs)}||preexpected.recipe_sha256!==${JSON.stringify(expectedRecipe)})throw Error("prebuild-expectation-mismatch");writeFileSync(join(evidenceDirectory,"prebuild.json"),JSON.stringify({rootfs_sha256:preexpected.rootfs_sha256,recipe_sha256:preexpected.recipe_sha256,execution_config:preexpected.execution_config},null,2),{mode:0o600,flag:"wx"});
mkdirSync(${JSON.stringify(temporary)},{mode:0o700});const eventPath=join(source,"event.json");await Bun.write(eventPath,JSON.stringify({ref:"refs/heads/main",after:commit,deleted:false,forced:false,head_commit:{id:commit},repository:repo}));
Object.assign(process.env,{GITHUB_EVENT_PATH:eventPath,RUNNER_TEMP:${JSON.stringify(temporary)},GITHUB_RUN_ID:"500",GITHUB_RUN_ATTEMPT:"1",GITHUB_SHA:commit,GITHUB_REF:"refs/heads/main",GITHUB_REF_TYPE:"branch",GITHUB_EVENT_NAME:"push",GITHUB_REPOSITORY:"deconfined/tarubot",GITHUB_REPOSITORY_ID:"200",GITHUB_REPOSITORY_OWNER:"deconfined",GITHUB_REPOSITORY_OWNER_ID:"100",GITHUB_WORKFLOW_REF:"deconfined/tarubot/.github/workflows/publish.yml@refs/heads/main",GITHUB_WORKFLOW_SHA:commit,GITHUB_JOB:"host",TB_HOST_WORKFLOW_ID:"300",TB_HOST_ENVIRONMENT_ID:"400",TB_HOST_TARGET:"staging",TB_HOST_ACTION:"deploy",TB_HOST_ACCEPT_RELEASE:"true",TB_HOST_PHASE:"site",TB_RELEASE_VERSION:"2.36.39",TB_RELEASE_COMMIT:commit,TB_RELEASE_DIGEST:"sha256:"+"b".repeat(64),TB_RELEASE_CONFIG_COMMIT:commit,TB_RELEASE_PUBLICATION_RUN:"500",TB_RELEASE_SCHEMA_HEAD:"001_invented.sql",GITHUB_TOKEN:"invented_read_token_123456789",ACTIONS_ID_TOKEN_REQUEST_URL:"https://pipelines.actions.githubusercontent.com/opaque?api-version=1",ACTIONS_ID_TOKEN_REQUEST_TOKEN:"invented-runner-mint-bearer"});
const runtime=await import(join(source,"scripts/host-execution-runtime.ts"));const grant=await import(join(source,"scripts/host-execution-grant.ts"));const driver=await import(join(source,"scripts/host-execution-driver.ts"));const controller=await import(join(source,"scripts/host-controller.ts"));
const ownedModuleUrls=[];for(const path of ["host-execution-runtime.ts","host-execution-grant.ts","host-execution-driver.ts","host-controller.ts"]){const actual=realpathSync(join(source,"scripts",path));if(actual!==join(source,"scripts",path)||!readFileSync(actual).length)throw Error("owned-source-missing");ownedModuleUrls.push(import.meta.resolve(actual));}
let prepareFailed=false,refused=false;try{await runtime.prepareProtectedHostExecution();phase="execution";wall+=5000;try{await runtime.runProtectedHostExecutionDenial();}catch(error){refused=error.message==="invalid-protected-host-execution";}}catch{prepareFailed=true;}
if(!archives.length)artifactMatch=false;for(const archive of archives){try{const bytes=readFileSync(archive.path),checked=closure.verifyControllerImage(bytes,preexpected);artifactMatch&&=checked.rootfs_sha256===${JSON.stringify(expectedRootfs)}&&checked.native_image_ids.includes(archive.native_image_id);archive.archive_sha256=createHash("sha256").update(bytes).digest("hex");}catch{artifactMatch=false;}}
const config=join(source,"fixture-engine-config");mkdirSync(config,{mode:0o700});const verify=args=>{const result=childProcess.spawnSync("/usr/bin/docker",["--host","unix:///var/run/docker.sock","--config",config,...args],{env:{PATH:"/usr/bin:/bin"},encoding:"utf8",timeout:10000});return result.status===0&&result.stdout.trim()==="";};
const tagsAbsent=[...ownedTags].every(tag=>verify(["image","ls","--all","--filter","reference="+tag,"--format","{{.ID}}"]));
const containersAbsent=[...ownedContainers].every(name=>verify(["container","ls","--all","--filter","name=^/"+name+"$","--format","{{.ID}}"]));const pathsAbsent=[...ownedPaths].every(path=>!existsSync(path));
writeFileSync(join(evidenceDirectory,"evidence.json"),JSON.stringify({conditional_offline_only:true,source,commit,expectedRootfs:${JSON.stringify(expectedRootfs)},expectedRecipe:${JSON.stringify(expectedRecipe)},ownedModuleUrls,frames,engineOffers,archives,failures,tagsAbsent,containersAbsent,pathsAbsent,counts:{prepareFailed,refused,apiGets,mints,jwksReads,actualChildren,exchanges,denied,worker}},null,2),{mode:0o600,flag:"wx"});
console.log(JSON.stringify({prepareFailed,refused,apiGets,mints,jwksReads,actualChildren,exchanges,denied,worker,prepared,artifactMatch,inputComplete,requestComplete,observerValid,tagsAbsent,containersAbsent,pathsAbsent,ownedModules:ownedModuleUrls.length,evidence_directory:evidenceDirectory}));
`;
      // Parse the exact embedded child program before any candidate import, native engine
      // call or RSA fixture activity. A malformed observer cannot leave accepted resources.
      new Bun.Transpiler({ loader: "js" }).transformSync(script);
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
        cwd: directory,
        env: { PATH: "/usr/bin:/bin", TZ: "UTC" },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120000,
      });
      const [output, diagnostic, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, diagnostic }).toEqual({ code: 0, diagnostic: "" });
      const result = JSON.parse(output) as Record<string, number | boolean | string>;
      expect(result).toMatchObject({
        prepareFailed: false,
        refused: true,
        apiGets: 48,
        mints: 2,
        jwksReads: 3,
        actualChildren: 1,
        exchanges: 1,
        denied: 1,
        prepared: 1,
        artifactMatch: true,
        inputComplete: true,
        requestComplete: true,
        observerValid: true,
        tagsAbsent: true,
        containersAbsent: true,
        pathsAbsent: true,
        ownedModules: 4,
      });
      expect(result.worker).toBeGreaterThanOrEqual(2);
      expect(result.worker).toBeLessThanOrEqual(64);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120000);

test("fixed inactive CLI rejects wrong arguments and missing protected context in both modes", () => {
  const path = resolve(import.meta.dir, "../../scripts/host-execution-driver.ts");
  for (const args of [[], ["run"], ["prepare", "caller-command"], ["prepare"], ["deny"]]) {
    const child = spawnSync(process.execPath, [path, ...args], {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      timeout: 2000,
    });
    expect(child.status).toBe(1);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("protected-host-execution-denied\n");
  }
});
