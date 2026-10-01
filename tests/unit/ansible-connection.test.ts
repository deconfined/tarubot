/** Native controller fixtures use only invented local files/actors; never SSH or a real host. */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  controllerPin,
  runHostControllerFixture,
  verifyFixtureController,
  type ControllerFixture,
  type FixtureController,
} from "../fixtures/host-controller/launcher.js";

const venv = resolve(import.meta.dir, "../../.cache/pipeline-checks/ansible");
const controller: FixtureController = Object.freeze({
  playbook: join(venv, "bin/ansible-playbook"),
  python: join(venv, "bin/python"),
  source: join(venv, "lib/python3.14/site-packages/ansible"),
});
// Fresh credential-free CI images may not contain this already-verified native capability.
// Pure Bun framing/adapter tests always run. Missing native runtime is explicit skipped evidence.
const native =
  existsSync(controller.playbook) && existsSync(controller.python) && existsSync(controller.source);
const nativeTest = native ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function pythonProbe(script: string): unknown {
  const root = mkdtempSync(join(tmpdir(), "tb-python-fixture-"));
  roots.push(root);
  const plugin = resolve(
    import.meta.dir,
    "../../ops/ansible/connection_plugins/tarubot_guarded.py",
  );
  const child = Bun.spawnSync([controller.python, "-I", "-B", "-c", script, plugin, root], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
    timeout: 4000,
    maxBuffer: 16384,
  });
  expect(child.exitCode).toBe(0);
  return JSON.parse(child.stdout.toString());
}
describe("first-party pinned Ansible connection fixture", () => {
  test("reviewed official wheel/core aggregate is fixed, not self-pinned from installed bytes", () => {
    expect(controllerPin.version).toBe("2.21.4");
    expect(controllerPin.wheel_sha256).toBe(
      "ebe74d9c8fadcb41ad2151e031bf1e785e3098aaa015019b4e19a0a96f0dcc4f",
    );
    expect(controllerPin.source_manifest_sha256).toBe(
      "fb06391038b33843a09651d29bc8f389bb80e24abf1f4229014fc2e2b3780087",
    );
  });
  test("fixture API rejects caller env/argv/playbook selectors before runtime/source access", async () => {
    const extra = { ...controller, env: { ANSIBLE_CONFIG: "invented-override" } };
    await expect(runHostControllerFixture(extra as FixtureController, "modules")).rejects.toThrow(
      "host-controller-fixture-failed",
    );
    await expect(
      runHostControllerFixture(controller, "arbitrary-playbook" as ControllerFixture),
    ).rejects.toThrow("host-controller-fixture-failed");
    const trapped = { ...controller };
    let calls = 0;
    Object.defineProperty(trapped, "playbook", {
      enumerable: true,
      get() {
        calls++;
        throw new Error("must not evaluate getter");
      },
    });
    await expect(runHostControllerFixture(trapped, "modules")).rejects.toThrow(
      "host-controller-fixture-failed",
    );
    expect(calls).toBe(0);
  });
  nativeTest("native runtime exactly matches the reviewed 801-member core manifest", () => {
    verifyFixtureController(controller);
  });
  for (const scenario of [
    "modules",
    "files",
    "sudo",
    "bad-marker",
    "overrides",
    "reset",
    "reboot",
    "abandoned",
  ] as ControllerFixture[]) {
    nativeTest(
      `actual pinned controller: ${scenario}`,
      async () => {
        const result = await runHostControllerFixture(controller, scenario);
        roots.push(result.directory);
        expect(result.status).toBe("passed");
        expect(result.trap_called).toBe(false);
        if (["modules", "files", "sudo", "overrides"].includes(scenario)) {
          expect(result.code).toBe(0);
          expect(result.completed).toBeGreaterThan(0);
          expect(result.fenced).toBe(false);
        } else {
          expect(result.fenced).toBe(true);
        }
        if (scenario === "sudo") expect(result.sudo_inputs).toBe(2);
        if (scenario === "bad-marker") {
          expect(result.sudo_inputs).toBe(0);
          expect(result.handlers).toBe(1);
          expect(result.completed).toBe(0);
        }
        if (scenario === "reset") {
          expect(result.handlers).toBe(1);
          expect(result.allocations).toBe(1);
        }
        if (scenario === "reboot") {
          expect(result.handlers).toBe(3);
          expect(result.completed).toBe(2);
        }
        if (scenario === "abandoned") {
          expect(result.handlers).toBe(0);
          expect(result.death_fenced).toBe(true);
        }
        if (scenario === "files")
          expect(readFileSync(join(result.directory, "fetched.bin"))).toEqual(
            readFileSync(join(result.directory, "source.bin")),
          );
      },
      70_000,
    );
  }
  nativeTest(
    "Python exact sudo gate refuses buffered cross-channel wrong/duplicate/prompt candidates before any payload",
    () => {
      const helper = resolve(
        import.meta.dir,
        "../../ops/ansible/connection_plugins/_tarubot_frames.py",
      );
      const script = String.raw`
import importlib.util, json, sys
spec=importlib.util.spec_from_file_location('frames',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
marker='BECOME-SUCCESS-'+'a'*32
cases=[('stderr',b'BECOME-SUCCESS-wrong','stdout'),('stdout',b'BECOME-SUCCESS-wrong','stderr'),('stderr',marker.encode(),'stdout'),('stderr',b'pass','stdout')]
results=[]
for first,part,second in cases:
    gate=m.MarkerGate(marker); offered=0
    try:
        gate.consume(first,part)
        gate.consume(second,(marker+'\n').encode())
        if gate.ready: offered+=1
    except Exception: pass
    results.append(offered==0)
valid=m.MarkerGate(marker); out=valid.consume('stdout',b'unrelated\n'+marker.encode()+b'\r'); blocked=not valid.ready; out+=valid.consume('stdout',b'\n')
results.extend([blocked,valid.ready,out==b'unrelated\n'])
print(json.dumps(results))
`;
      const child = Bun.spawnSync([controller.python, "-I", "-B", "-c", script, helper], {
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
        timeout: 3000,
        maxBuffer: 16384,
      });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(child.stdout.toString())).toEqual([
        true,
        true,
        true,
        true,
        true,
        true,
        true,
      ]);
    },
  );
  nativeTest(
    "Python client retains original allocation/control budgets through partial replies and late select/EOF",
    () => {
      const script = `
import importlib.util,json,selectors,struct,sys,time
spec=importlib.util.spec_from_file_location('plugin',sys.argv[1]); p=importlib.util.module_from_spec(spec); spec.loader.exec_module(p); m=p._frames
real=time.monotonic; real_sleep=time.sleep; root=sys.argv[2]; nonce='a'*32
bootstrap={'local_root':root,'session_id':'b'*32,'capability':'c'*64,'control':'d'*32+'.sock'}
original_control=m.control; original_socket=m.socket.socket; original_selector=m.selectors.DefaultSelector
clock=[100.0]; timeouts=[]; fragments=[]
class SlowControl:
    def __init__(self):self.offset=0;self.wire=struct.pack('!I',512)+b'{'*512
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def settimeout(self,value): timeouts.append(value)
    def connect(self,*args): pass
    def sendall(self,*args): pass
    def shutdown(self,*args): pass
    def recv(self,count):
        clock[0]+=.4; fragments.append(1);part=self.wire[self.offset:self.offset+1];self.offset+=1;return part
m.socket_path=lambda *args:'/unused-invented-socket'
m.socket.socket=lambda *args:SlowControl(); m.time.monotonic=lambda:clock[0]
try: original_control(bootstrap,'exec'); slow=False
except Exception: slow=len(fragments)<=8 and min(timeouts)<max(timeouts)
m.time.monotonic=real
sent=[]
def wire(kind,seq,value):
    payload=json.dumps(value,separators=(',',':')).encode()
    return struct.pack('!4sB3xII16s',b'TBH1',m.KINDS[kind],seq,len(payload),bytes.fromhex(nonce))+payload
response=wire('response',0,{'kind':'response','operation':'exec'})+wire('result',1,{'kind':'result','code':0})
class FakeSocket:
    def __init__(self): self.reads=0
    def settimeout(self,*args): pass
    def connect(self,*args): pass
    def setblocking(self,*args): pass
    def shutdown(self,*args): pass
    def close(self): pass
    def send(self,data): sent.append(data[4]); return len(data)
    def recv(self,count): self.reads+=1; return response if self.reads==1 else b''
class FakeSelect:
    def __init__(self): self.calls=0
    def register(self,*args): pass
    def modify(self,*args): pass
    def close(self): pass
    def select(self,*args):
        self.calls+=1
        if self.calls==4: real_sleep(.04)
        return [(None,selectors.EVENT_WRITE if self.calls<=2 else selectors.EVENT_READ)]
m.socket.socket=lambda *args:FakeSocket(); m.selectors.DefaultSelector=FakeSelect
m.control=lambda *args:{'nonce':nonce,'socket':'e'*32+'.sock','remaining_ms':30}
try: m.exchange(bootstrap,'exec',{'command':['invented']}); late=False
except Exception: late=sent==[1,9]
sent.clear()
def delayed(*args): real_sleep(.04); return {'nonce':nonce,'socket':'e'*32+'.sock','remaining_ms':20}
m.control=delayed
try: m.exchange(bootstrap,'exec',{'command':['invented']}); allocation=False
except Exception: allocation=sent==[]
print(json.dumps([slow,late,allocation]))
`;
      expect(pythonProbe(script)).toEqual([true, true, true]);
    },
  );
  nativeTest(
    "fetch refuses nonzero/partial results and late fsync without replacing the prior file",
    () => {
      const script = `
import importlib.util,json,os,selectors,struct,sys,time,types
spec=importlib.util.spec_from_file_location('plugin',sys.argv[1]); p=importlib.util.module_from_spec(spec); spec.loader.exec_module(p); m=p._frames
root=sys.argv[2]; os.chmod(root,0o700); nonce='a'*32; destination=os.path.join(root,'prior.bin'); original_fsync=os.fsync
def wire(kind,seq,value):
    payload=value if kind=='file' else json.dumps(value,separators=(',',':')).encode()
    return struct.pack('!4sB3xII16s',b'TBH1',m.KINDS[kind],seq,len(payload),bytes.fromhex(nonce))+payload
results=[];closed=[]
for mode in ('nonzero','partial','late','cleanup','success'):
    with open(destination,'wb') as f:f.write(b'prior-fixture')
    os.chmod(destination,0o600)
    response=wire('response',0,{'kind':'response','operation':'fetch'})+wire('file',1,b'new-fixture')
    if mode!='partial':response+=wire('result',2,{'kind':'result','code':17 if mode in ('nonzero','cleanup') else 0})
    class FakeSocket:
        def __init__(self):self.reads=0
        def settimeout(self,*args):pass
        def connect(self,*args):pass
        def setblocking(self,*args):pass
        def shutdown(self,*args):pass
        def close(self):
            if mode=='cleanup':closed.append('socket');raise OSError('invented-sensitive-socket-diagnostic')
        def send(self,data):return len(data)
        def recv(self,count):self.reads+=1;return response if self.reads==1 else b''
    class FakeSelect:
        def __init__(self):self.calls=0
        def register(self,*args):pass
        def modify(self,*args):pass
        def close(self):
            if mode=='cleanup':closed.append('selector');raise OSError('invented-sensitive-selector-diagnostic')
        def select(self,*args):self.calls+=1;return [(None,selectors.EVENT_WRITE if self.calls<=2 else selectors.EVENT_READ)]
    m.socket.socket=lambda *args:FakeSocket();m.socket_path=lambda *args:'/unused-invented-socket';m.selectors.DefaultSelector=FakeSelect
    # Ordinary fsync latency belongs to the positive control's budget; only the explicit
    # late-fsync case needs the short deadline that proves replacement is denied.
    m.control=lambda *args:{'nonce':nonce,'socket':'b'*32+'.sock','remaining_ms':2000 if mode=='success' else 80}
    m.fence=lambda *args:None
    def slow_fsync(fd):time.sleep(.12);original_fsync(fd)
    os.fsync=slow_fsync if mode=='late' else original_fsync
    connection=object.__new__(p.Connection);connection._bootstrap={'local_root':root};connection._failed=False;connection._active=False;connection._connected=True;connection.become=None
    connection._play_context=types.SimpleNamespace(remote_addr='tarubot_fixture_target',remote_user='root',executable='/bin/sh')
    try:connection.fetch_file('/tmp/invented.bin',destination);refused=False
    except Exception as error:refused=str(error)==m.FAILURE
    with open(destination,'rb') as f:kept=f.read()==(b'new-fixture' if mode=='success' else b'prior-fixture')
    clean=not any(name.startswith('.tarubot-fetch-') for name in os.listdir(root))
    results.append(kept and clean and refused==(mode!='success'))
os.fsync=original_fsync
results.append(closed==['selector','socket'])
print(json.dumps(results))
`;
      expect(pythonProbe(script)).toEqual([true, true, true, true, true, true]);
    },
  );
  nativeTest(
    "private cleanup failures preserve one fixed refusal and attempt independent teardown",
    () => {
      const script = `
import importlib.util,json,os,sys,types
spec=importlib.util.spec_from_file_location('plugin',sys.argv[1]);p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p);m=p._frames
root=sys.argv[2];os.chmod(root,0o700);m.fence=lambda *args:None
connection=object.__new__(p.Connection);connection._bootstrap={'local_root':root};connection._failed=False;connection._active=False;connection._connected=True;connection.become=None
connection._play_context=types.SimpleNamespace(remote_addr='tarubot_fixture_target',remote_user='root',executable='/bin/sh')
original_unlink=os.unlink
def failed_cleanup(*args):raise OSError('invented-sensitive-cleanup-diagnostic')
os.unlink=failed_cleanup
m.exchange=lambda *args,**kwargs:(17,b'',b'')
try:connection.fetch_file('/tmp/invented.bin',os.path.join(root,'destination.bin'));fixed=False
except Exception as error:fixed=str(error)==m.FAILURE
os.unlink=original_unlink
for name in os.listdir(root):
    if name.startswith('.tarubot-fetch-'):os.unlink(os.path.join(root,name))
print(json.dumps([fixed,connection._failed]))
`;
      expect(pythonProbe(script)).toEqual([true, true]);
    },
  );
});
