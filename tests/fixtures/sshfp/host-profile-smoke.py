"""Offline native Ubuntu smoke; run as root in private network/mount namespaces."""

import json
import os
import pathlib
import pwd
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def main():
    if os.geteuid() != 0 or any(
        os.readlink(f"/proc/self/ns/{kind}") == os.readlink(f"/proc/1/ns/{kind}")
        for kind in ("net", "mnt")
    ):
        raise RuntimeError("this smoke requires root in private network and mount namespaces")
    username, helper_path, temporary_root = sys.argv[1:]
    user = pwd.getpwnam(username)
    if user.pw_uid == 0:
        raise RuntimeError("the transport must run as an unprivileged runner")
    helper_path = pathlib.Path(helper_path).resolve()
    with tempfile.TemporaryDirectory(prefix="sshfp-profile.", dir=temporary_root) as work:
        work = pathlib.Path(work)
        os.chown(work, user.pw_uid, user.pw_gid)
        runner_temp = work / "runner"
        runner_temp.mkdir(mode=0o700)
        os.chown(runner_temp, user.pw_uid, user.pw_gid)
        state = work / "state"
        state.mkdir(mode=0o700)
        hosts = work / "hosts"
        hosts.write_text("127.0.0.1 localhost smoke.example.org\n")
        resolver = work / "resolv.conf"
        original = b"nameserver 192.0.2.53\noptions edns0\n"
        resolver.write_bytes(original)
        # Bind mounts are confined to this mount namespace; no host DNS changes.
        for source, target in ((hosts, "/etc/hosts"), (resolver, "/etc/resolv.conf"), (state, "/var/lib/unbound")):
            run("mount", "--bind", str(source), target)
        run("ip", "link", "set", "lo", "up")

        # A valid runner-temp configuration is rejected under the stock profile.
        # This calibrates enforcement, rather than trusting a loaded-profile flag.
        blocked = work / "unbound.conf"
        blocked.write_text('server:\n  interface: 127.0.0.1\n  username: ""\n  chroot: ""\n')
        run("unbound-checkconf", str(blocked))
        denial = subprocess.Popen(["/usr/sbin/unbound", "-d", "-c", str(blocked)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            denial.communicate(timeout=2)
        except subprocess.TimeoutExpired:
            denial.terminate()
            denial.communicate(timeout=2)
            raise RuntimeError("stock profile allowed a runner-temp configuration")
        if denial.returncode == 0:
            raise RuntimeError("runner-temp configuration was not refused")

        # A silent local TCP peer holds native OpenSSH before authentication.
        # No host key, access key, real remote host or public network is involved.
        connected = threading.Event()
        release = threading.Event()
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 22))
        listener.listen(1)
        listener.settimeout(0.1)

        def hold_peer():
            while not release.is_set():
                try:
                    connection, _ = listener.accept()
                    with connection:
                        connected.set()
                        release.wait(15)
                    return
                except socket.timeout:
                    continue
                except OSError:
                    return

        peer = threading.Thread(target=hold_peer)
        peer.start()
        helper = subprocess.Popen([
            "runuser", "-u", username, "--", "env", "-i",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            f"HOME={user.pw_dir}", f"USER={username}", f"LOGNAME={username}",
            f"RUNNER_TEMP={runner_temp}", "TARGET=staging",
            "REPO_STAGING_DEPLOY_ENABLED=true", "REPO_PRODUCTION_DEPLOY_ENABLED=false",
            "VERSION=2.36.42", f"COMMIT={'a' * 40}", f"DIGEST=sha256:{'b' * 64}",
            "GITHUB_RUN_ID=1234567", "DEPLOY_HOST=smoke.example.org",
            "DEPLOY_SSH_KEY=PRIVATE KEY fixture-invalid-key-not-a-credential",
            "bash", "-c", 'exec bash "$1"', "--", str(helper_path),
        ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 12
            while not connected.is_set():
                if helper.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("transport did not reach the isolated TCP peer")
                connected.wait(0.02)
            directories = list(pathlib.Path("/var/lib/unbound").glob("deploy-ssh.*"))
            if len(directories) != 1:
                raise RuntimeError("expected one invocation-owned resolver directory")
            directory = directories[0]
            info = directory.stat()
            if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                raise RuntimeError("resolver state is not root-private")
            daemon_pid = int((directory / "unbound.pid").read_text())
            profile = pathlib.Path(f"/proc/{daemon_pid}/attr/current").read_text().strip()
            if profile != "unbound (enforce)":
                raise RuntimeError("native resolver is not under the stock enforcing profile")
            run("unbound-control", "-c", str(directory / "unbound.conf"), "status")
            if pathlib.Path("/etc/resolv.conf").read_bytes() != b"nameserver 127.0.0.1\noptions edns0 trust-ad\n":
                raise RuntimeError("transport did not activate its private resolver")
            children = pathlib.Path(f"/proc/{helper.pid}/task/{helper.pid}/children").read_text().split()
            if len(children) != 1:
                raise RuntimeError("expected the runuser-owned transport process")
            os.kill(int(children[0]), signal.SIGTERM)
            helper.communicate(timeout=2)
            if helper.returncode != 143:
                raise RuntimeError("transport did not preserve TERM status")
            if pathlib.Path(f"/proc/{daemon_pid}").exists():
                raise RuntimeError("native resolver survived transport cancellation")
            if pathlib.Path("/etc/resolv.conf").read_bytes() != original:
                raise RuntimeError("transport did not restore resolver contents")
            if list(runner_temp.iterdir()) or list(state.iterdir()):
                raise RuntimeError("transport left private state behind")
            print(json.dumps({
                "profile": profile, "runnerTempConfigurationRefused": True,
                "privateControlReady": True, "signalExit": helper.returncode,
                "resolverRestored": True, "privateStateRemoved": True,
            }), flush=True)
        finally:
            if helper.poll() is None:
                helper.terminate()
                try:
                    helper.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    helper.kill()
                    helper.communicate(timeout=2)
            release.set()
            listener.close()
            peer.join(timeout=2)


if __name__ == "__main__":
    main()
