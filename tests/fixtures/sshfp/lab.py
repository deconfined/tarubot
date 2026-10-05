"""Disposable authoritative DNSSEC/OpenSSH lab; production owns the validator.

Only the helper is mounted. The container has no network other than its own
loopback, no published ports, and only NET_ADMIN beyond Docker's default caps.
All keys generated here identify invented *servers* or sign invented DNS zones;
there is no client authentication key. Empty-password native none-auth makes
successful host authentication observable without granting any real access.
"""

import base64
import datetime
import hashlib
import json
import os
import pathlib
import pwd
import re
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path("/lab")
DNS = ROOT / "dns"
KEYS = DNS / "keys"
IDENTITIES = ROOT / "identities"
REMOTE = ROOT / "remote"
RUNNER_TEMP = ROOT / "runner-temp"
DNS_ADDRESS = "192.0.2.53"
SSH_ADDRESS = "192.0.2.10"
SENTINEL = "PRIVATE KEY fixture-sentinel-not-a-key-or-access-credential"
SCENARIOS = {"signed", "unsigned", "missing", "bogus", "mismatch", "rotation", "term", "occupied"}


def command(arguments, **options):
    result = subprocess.run(
        arguments, capture_output=True, text=True, timeout=20, **options
    )
    if result.returncode != 0:
        # Setup diagnostics contain only disposable fixture state. Keep them
        # separate from the helper's public-output privacy assertions.
        with (ROOT / "setup-errors").open("a") as log:
            log.write(result.stdout + result.stderr)
        raise RuntimeError(f"fixture setup command {arguments[0]} failed ({result.returncode})")
    return result.stdout.strip()


def owned_directory(path, account):
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    user = pwd.getpwnam(account)
    os.chown(path, user.pw_uid, user.pw_gid)


def server_identity(name):
    path = IDENTITIES / name
    command(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "fixture-server-only", "-f", str(path)])
    public = path.with_suffix(".pub").read_text().strip()
    wire = base64.b64decode(public.split()[1])
    return {
        "path": path,
        "public": public,
        "sha1": hashlib.sha1(wire).hexdigest(),
        "sha256": hashlib.sha256(wire).hexdigest(),
    }


def signing_key(zone):
    name = command([
        "dnssec-keygen", "-q", "-K", str(KEYS), "-a", "ECDSAP256SHA256",
        "-f", "KSK", "-n", "ZONE", zone,
    ])
    return KEYS / (name + ".key")


def ds_record(key):
    return command(["dnssec-dsfromkey", "-2", str(key)]) + "\n"


def zone_header(zone, serial):
    nameserver = {".": "ns.root.", "org.": "ns.org.", "example.org.": "ns.example.org."}[zone]
    return (
        f"$ORIGIN {zone}\n$TTL 60\n"
        f"@ IN SOA {nameserver} hostmaster.example.org. ({serial} 60 60 3600 60)\n"
        f"@ IN NS {nameserver}\n{nameserver} IN A {DNS_ADDRESS}\n"
    )


def sign_zone(zone, path):
    # One ephemeral combined signing key per zone. -z explicitly permits the
    # KSK to sign all RRsets; -O full keeps real signed records easy to mutate.
    now = datetime.datetime.now(datetime.timezone.utc)
    start = (now - datetime.timedelta(hours=1)).strftime("%Y%m%d%H%M%S")
    end = (now + datetime.timedelta(days=2)).strftime("%Y%m%d%H%M%S")
    signed = path.with_suffix(".signed")
    command([
        "dnssec-signzone", "-q", "-n", "1", "-S", "-z", "-K", str(KEYS),
        "-o", zone, "-O", "full", "-s", start, "-e", end,
        "-f", str(signed), str(path),
    ], cwd=DNS)
    return signed


def build_zones(scenario, published, signing, serial, occupy=False):
    root = DNS / "root.zone"
    root.write_text(zone_header(".", serial) + "org. IN NS ns.org.\nns.org. IN A " + DNS_ADDRESS + "\n" + ds_record(signing["org."]))
    parent = DNS / "org.zone"
    child_ds = "" if scenario == "unsigned" else ds_record(signing["example.org."])
    parent.write_text(
        zone_header("org.", serial)
        + f"example.org. IN NS ns.example.org.\nns.example.org. IN A {DNS_ADDRESS}\n"
        + child_ds
    )
    child = DNS / "example.zone"
    contents = zone_header("example.org.", serial)
    for host in ["staging.example.org.", "production.example.org."]:
        contents += f"{host} IN A {SSH_ADDRESS}\n"
        if scenario != "missing":
            for identity in published:
                contents += f"{host} IN SSHFP 4 1 {identity['sha1']}\n"
                contents += f"{host} IN SSHFP 4 2 {identity['sha256']}\n"
    child.write_text(contents)
    zones = [(".", sign_zone(".", root)), ("org.", sign_zone("org.", parent))]
    tampered = 0
    if scenario == "unsigned":
        zones.append(("example.org.", child))
    else:
        signed = sign_zone("example.org.", child)
        if scenario == "bogus":
            # Alter the authenticated SSHFP RRset *after* native signing. No
            # signature is regenerated and no response AD bit is fabricated.
            contents = signed.read_text()
            # BIND may split a digest into whitespace-separated hex chunks.
            # Corrupt the first RDATA nibble, leaving its signature unchanged.
            pattern = re.compile(r"(\bIN\s+SSHFP\s+4\s+2\s+)([0-9A-Fa-f])")
            contents, tampered = pattern.subn(
                lambda match: match[1] + ("0" if match[2] != "0" else "1"), contents
            )
            if tampered != 2:
                raise RuntimeError("expected exactly two signed SSHFP RRsets to corrupt")
            signed.write_text(contents)
        zones.append(("example.org.", signed))
    listen = DNS_ADDRESS + ("; 127.0.0.1" if occupy else "")
    config = (
        'options { directory "/lab/dns"; recursion no; dnssec-validation no;\n'
        f'listen-on port 53 {{ {listen}; }}; listen-on-v6 {{ none; }};\n'
        'allow-query { any; }; pid-file "/lab/named.pid";\n'
        'session-keyfile none; };\ncontrols {};\n'
    )
    for zone, path in zones:
        config += f'zone "{zone}" {{ type primary; file "{path}"; }};\n'
    (DNS / "named.conf").write_text(config)
    return tampered


class NativeServer:
    def __init__(self, name, arguments):
        self.log = (ROOT / (name + ".log")).open("ab")
        self.process = subprocess.Popen(arguments, stdout=self.log, stderr=self.log)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.log.close()


def wait_dns(server):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if server.process.poll() is not None:
            raise RuntimeError("native authoritative named exited before readiness")
        response = subprocess.run(
            ["dig", "@" + DNS_ADDRESS, ".", "SOA", "+norecurse", "+time=1", "+tries=1"],
            capture_output=True, text=True, timeout=2,
        )
        if "status: NOERROR" in response.stdout and re.search(r"ANSWER: [1-9]", response.stdout):
            return
        time.sleep(0.02)
    raise RuntimeError("native authoritative named did not become ready")


def start_sshd(identity):
    (ROOT / "server-public-identity").write_text(identity["public"] + "\n")
    (ROOT / "sshd.conf").write_text(
        f"Port 22\nListenAddress {SSH_ADDRESS}\nHostKey {identity['path']}\n"
        "HostKeyAlgorithms ssh-ed25519\nPidFile /lab/sshd.pid\n"
        "UsePAM no\nUseDNS no\nPermitRootLogin no\nAllowUsers tarubot\n"
        "PasswordAuthentication yes\nPermitEmptyPasswords yes\n"
        "PubkeyAuthentication no\nKbdInteractiveAuthentication no\n"
        "AuthenticationMethods any\nAllowAgentForwarding no\n"
        "AllowTcpForwarding no\nX11Forwarding no\nPermitTunnel no\n"
        "PrintMotd no\nLogLevel VERBOSE\n"
        "ForceCommand /usr/bin/python3 /fixture/remote-command.py\n"
    )
    server = NativeServer("sshd", ["/usr/sbin/sshd", "-D", "-e", "-f", str(ROOT / "sshd.conf")])
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if server.process.poll() is not None:
            server.stop()
            raise RuntimeError("native sshd exited before readiness")
        try:
            with socket.create_connection((SSH_ADDRESS, 22), timeout=0.1):
                return server
        except OSError:
            time.sleep(0.02)
    server.stop()
    raise RuntimeError("native sshd did not become ready")


def unbound_processes():
    found = []
    for path in pathlib.Path("/proc").glob("[0-9]*/comm"):
        try:
            if path.read_text().strip() == "unbound":
                found.append(int(path.parent.name))
        except (FileNotFoundError, ProcessLookupError):
            pass
    return found


def resolver_port_free():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.bind(("127.0.0.1", 53))
        return True
    except OSError:
        return False


def inspect_dns(host):
    response = subprocess.run(
        ["dig", "@127.0.0.1", host, "SSHFP", "+dnssec", "+time=1", "+tries=1"],
        capture_output=True, text=True, timeout=2,
    )
    status = re.search(r"status: ([A-Z]+)", response.stdout)
    flags = re.search(r"flags: ([^;]+);", response.stdout)
    answers = re.search(r"ANSWER: ([0-9]+)", response.stdout)
    if status is None or flags is None or answers is None:
        return None
    sshfp_count = sum(
        1 for line in response.stdout.splitlines()
        if not line.startswith(";") and re.search(r"\sIN\s+SSHFP\s+", line)
    )
    return {
        "status": status[1], "authenticated": "ad" in flags[1].split(),
        "answerCount": int(answers[1]), "sshfpRecordCount": sshfp_count,
    }


def terminate_runner_bash(uid):
    # Select the real non-root Bash process by kernel identity, not command
    # arguments, a shell stand-in, or production source-text instrumentation.
    for path in pathlib.Path("/proc").glob("[0-9]*/comm"):
        try:
            if path.read_text().strip() != "bash":
                continue
            status = (path.parent / "status").read_text()
            owner = re.search(r"^Uid:\s+([0-9]+)", status, re.MULTILINE)
            if owner is not None and int(owner[1]) == uid:
                pid = int(path.parent.name)
                os.kill(pid, signal.SIGTERM)
                return pid
        except (FileNotFoundError, ProcessLookupError):
            pass
    return None


def exercise(target, phase, identity, tampered, index):
    if unbound_processes() or (phase != "occupied" and not resolver_port_free()):
        raise RuntimeError("a previous production-helper resolver was not removed")
    for path in REMOTE.iterdir():
        path.unlink()
    (ROOT / "release-command").unlink(missing_ok=True)
    host = target + ".example.org"
    (ROOT / "deployment-host").write_text(host + "\n")
    run_id = str(1234 + index)
    request = f"deploy {target} 2.36.42 {'a' * 40} sha256:{'b' * 64} {run_id}"
    (ROOT / "expected-request").write_text(request + "\n")
    runner = pwd.getpwnam("runner")
    known_hosts = pathlib.Path("/home/runner/.ssh/known_hosts")
    seed = f"{host} {identity['public']}\n"
    known_hosts.write_text(seed)
    known_hosts.chmod(0o600)
    os.chown(known_hosts, runner.pw_uid, runner.pw_gid)
    # Also seed the ordinary system file; neither pin store is a trust source.
    pathlib.Path("/etc/ssh/ssh_known_hosts").write_text(seed)
    resolver = pathlib.Path("/etc/resolv.conf")
    original = resolver.read_bytes()
    topology = (resolver.is_symlink(), os.readlink(resolver) if resolver.is_symlink() else None, resolver.lstat().st_ino)
    observations = {
        "privateDirectoryObserved": False, "privateDirectoryModes": [],
        "nativeProbe": None, "termSentToPid": None,
        "resolverActiveWhenTermSent": None,
    }
    finished = threading.Event()

    def observe():
        while not finished.is_set():
            for directory in RUNNER_TEMP.iterdir():
                try:
                    if directory.is_dir():
                        observations["privateDirectoryObserved"] = True
                        mode = stat.S_IMODE(directory.stat().st_mode)
                        if mode not in observations["privateDirectoryModes"]:
                            observations["privateDirectoryModes"].append(mode)
                except FileNotFoundError:
                    pass
            if phase == "term" and observations["termSentToPid"] is None:
                if observations["privateDirectoryObserved"] and unbound_processes():
                    observations["resolverActiveWhenTermSent"] = (
                        b"nameserver 127.0.0.1\n" in resolver.read_bytes()
                    )
                    observations["termSentToPid"] = terminate_runner_bash(runner.pw_uid)
            try:
                active = b"nameserver 127.0.0.1\n" in resolver.read_bytes()
                if phase not in {"term", "occupied"} and active and observations["nativeProbe"] is None:
                    observations["nativeProbe"] = inspect_dns(host)
            except (OSError, subprocess.TimeoutExpired):
                pass
            if phase != "term" and (REMOTE / "entered").exists() and observations["nativeProbe"] is not None and observations["privateDirectoryObserved"]:
                (ROOT / "release-command").touch()
            finished.wait(0.001)

    observer = threading.Thread(target=observe, daemon=True)
    observer.start()
    environment = [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME=/home/runner", "USER=runner", "LOGNAME=runner",
        f"TARGET={target}", "VERSION=2.36.42", "COMMIT=" + "a" * 40,
        "DIGEST=sha256:" + "b" * 64, f"GITHUB_RUN_ID={run_id}",
        f"DEPLOY_HOST={host}", f"DEPLOY_SSH_KEY={SENTINEL}",
        f"RUNNER_TEMP={RUNNER_TEMP}",
        f"REPO_PRODUCTION_DEPLOY_ENABLED={'true' if target == 'production' else 'false'}",
        f"REPO_STAGING_DEPLOY_ENABLED={'true' if target == 'staging' else 'false'}",
    ]
    helper = subprocess.Popen(
        ["runuser", "-u", "runner", "--", "env", "-i", *environment, "bash", "/transport/deploy-ssh.sh"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
    )
    try:
        stdout, stderr = helper.communicate(timeout=45)
    except subprocess.TimeoutExpired:
        os.killpg(helper.pid, signal.SIGTERM)
        try:
            helper.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(helper.pid, signal.SIGKILL)
            helper.communicate(timeout=5)
        raise RuntimeError("production helper exceeded the bounded fixture invocation")
    finally:
        finished.set()
        observer.join(timeout=3)
    deadline = time.monotonic() + 2
    while unbound_processes() and time.monotonic() < deadline:
        time.sleep(0.01)
    restored_topology = (resolver.is_symlink(), os.readlink(resolver) if resolver.is_symlink() else None, resolver.lstat().st_ino)
    marker_path = REMOTE / "execution-marker.json"
    state_path = REMOTE / "release.json"
    marker = json.loads(marker_path.read_text()) if marker_path.exists() else None
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    return {
        "phase": phase, "target": target, "code": helper.returncode,
        "stdout": stdout, "stderr": stderr,
        "runnerUid": runner.pw_uid, "remoteUid": pwd.getpwnam("tarubot").pw_uid,
        "knownHostsMatchesCurrentServer": known_hosts.read_text() == seed,
        "resolverRestored": resolver.read_bytes() == original,
        "resolverTopologyRestored": restored_topology == topology,
        "resolverOriginalSha256": hashlib.sha256(original).hexdigest(),
        "resolverFinalSha256": hashlib.sha256(resolver.read_bytes()).hexdigest(),
        "privateWorkRemaining": sorted(path.name for path in RUNNER_TEMP.iterdir()),
        "unboundProcessesRemaining": unbound_processes(),
        "resolverPortFree": resolver_port_free(),
        "remoteCommandEntered": (REMOTE / "entered").exists(),
        "executionMarker": marker, "releaseState": state,
        "releaseStateSha256": hashlib.sha256(state_path.read_bytes()).hexdigest() if state_path.exists() else None,
        "tamperedRRsets": tampered,
        "privateValues": [
            "fixture-private-diagnostic", host, DNS_ADDRESS, SSH_ADDRESS,
            SENTINEL, str(RUNNER_TEMP), identity["public"],
            identity["sha1"], identity["sha256"], request,
        ],
        **observations,
    }


def main():
    scenario, target = sys.argv[1:]
    if scenario not in SCENARIOS or target not in {"staging", "production"}:
        raise RuntimeError("unknown fixture scenario or target")
    ROOT.mkdir(mode=0o755)
    DNS.mkdir(mode=0o700)
    KEYS.mkdir(mode=0o700)
    IDENTITIES.mkdir(mode=0o700)
    owned_directory(REMOTE, "tarubot")
    owned_directory(RUNNER_TEMP, "runner")
    owned_directory(pathlib.Path("/home/runner/.ssh"), "runner")
    command(["ip", "address", "add", DNS_ADDRESS + "/32", "dev", "lo"])
    command(["ip", "address", "add", SSH_ADDRESS + "/32", "dev", "lo"])
    command(["ip", "link", "set", "lo", "up"])
    # This is a real permissions probe, not a source/argv assertion.
    sudo_uid = command(["runuser", "-u", "runner", "--", "sudo", "-n", "id", "-u"])
    if sudo_uid != "0":
        raise RuntimeError("fixture runner does not have noninteractive sudo")
    identities = [server_identity("host-a"), server_identity("host-b")]
    signing = {zone: signing_key(zone) for zone in [".", "org.", "example.org."]}
    pathlib.Path("/usr/share/dns/root.key").write_text(signing["."].read_text())
    pathlib.Path("/usr/share/dns/root.hints").write_text(f". 60 IN NS ns.root.\nns.root. 60 IN A {DNS_ADDRESS}\n")
    # Distinctive original contents make a missing or partial restoration fail.
    pathlib.Path("/etc/resolv.conf").write_text(
        "# credential-free SSHFP fixture original resolver\n"
        "nameserver 192.0.2.254\nsearch fixture.example.org\noptions timeout:1 attempts:1\n"
    )
    dns_scenario = "signed" if scenario in {"term", "occupied"} else scenario
    phases = [(scenario, dns_scenario, 0, [identities[1] if scenario == "mismatch" else identities[0]])]
    if scenario == "rotation":
        phases = [
            ("overlap-old-host", "signed", 0, identities),
            ("overlap-new-host", "signed", 1, identities),
            ("stale-dns-new-host", "signed", 1, [identities[0]]),
            ("rotated-dns-new-host", "signed", 1, [identities[1]]),
        ]
    results = []
    for index, (phase, dns_scenario, active, published) in enumerate(phases):
        tampered = build_zones(
            dns_scenario, published, signing, index + 1,
            occupy=scenario == "occupied",
        )
        named = NativeServer("named", ["/usr/sbin/named", "-g", "-c", str(DNS / "named.conf"), "-u", "root", "-n", "1"])
        sshd = None
        try:
            wait_dns(named)
            sshd = start_sshd(identities[active])
            result = exercise(target, phase, identities[active], tampered, index)
            result["authoritativeServerSurvived"] = named.process.poll() is None
            if scenario == "occupied":
                answer = command([
                    "dig", "@127.0.0.1", ".", "SOA", "+norecurse", "+time=1", "+tries=1",
                ])
                result["occupiedResolverSurvived"] = (
                    named.process.poll() is None and "status: NOERROR" in answer
                    and re.search(r"ANSWER: [1-9]", answer) is not None
                )
            results.append(result)
        finally:
            if sshd is not None:
                sshd.stop()
            named.stop()
    print(json.dumps({"scenario": scenario, "target": target, "sudoUid": int(sudo_uid), "runs": results}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        diagnostics = {}
        for name in ["setup-errors", "named.log", "sshd.log"]:
            path = ROOT / name
            if path.exists():
                diagnostics[name] = path.read_text(errors="replace")
        print(json.dumps({"error": str(error), "diagnostics": diagnostics}), flush=True)
        sys.exit(1)
