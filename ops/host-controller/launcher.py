"""Measured PID1 broker: private native worker origins, then a paused driver.

There is deliberately no release/dispatch command. The only host transport sink refuses.
A later protected producer must bind a genuine execution grant before adding such a path.
pidfd proves process identity/liveness, not continued Python-code identity: the reviewed
no-exec worker path and native kernel/engine integrity remain explicit prerequisites.
"""
import array
import ctypes
import hashlib
import json
import os
import selectors
import signal
import socket
import stat
import struct
import sys
import time
from pathlib import Path

FAILURE = "host-controller-launch-failed"
ROOT = Path("/run/tarubot")
CONFIG_FILES = (
    "ops/ansible/site.yml", "ops/ansible/vars/layout.yml",
    "ops/ansible/templates/dnf-automatic.conf.j2",
    "ops/ansible/files/dnf-automatic-timer-production.conf",
    "ops/ansible/files/sysctl-tarubot.conf", "ops/ansible/files/journald-tarubot.conf",
    "ops/ansible/files/multi-user-network-online.conf", "ops/ansible/files/tarubot-ipv6-online",
    "ops/ansible/files/tarubot-ipv6-online.service", "ops/ansible/files/sshd-00-tarubot.conf",
    "ops/ansible/files/polkit-10-tarubot.rules",
)
RELEASE_FILES = (
    "ops/ansible/bot.yml", "ops/ansible/accept.yml", "ops/ansible/vars/bot.yml", "ops/ansible/vars/targets/staging.yml",
    "ops/ansible/templates/bot/tarubot.env.j2", "ops/ansible/templates/bot/tarubot.container.j2",
    "ops/ansible/files/bot/tarubot-tool", "ops/ansible/files/bot/tarubot-backup",
    "ops/ansible/files/bot/tarubot-backup.service", "ops/ansible/files/bot/tarubot-backup.timer",
    "ops/age-recipients.txt",
)


def require(value):
    if not value:
        raise RuntimeError(FAILURE)


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def literal_json(data):
    require(len(data) <= 32768)
    return json.loads(data.decode("utf-8"), object_pairs_hook=pairs)


def encode(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def private_process():
    # Same-UID descendants must not recover the broker/driver's private FDs through /proc.
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(4, 0, 0, 0, 0) == 0)  # PR_SET_DUMPABLE = 0
    require(libc.prctl(3, 0, 0, 0, 0) == 0)  # PR_GET_DUMPABLE must confirm the setting


def source_guard():
    require(sys.version_info[:3] == (3, 12, 14) and sys.flags.isolated == 1
            and sys.flags.no_site == 1 and sys.flags.dont_write_bytecode == 1 and os.getpid() == 1)
    sys.path[:] = ["/usr/local/lib/python3.12", "/usr/local/lib/python3.12/lib-dynload",
                   "/opt/tarubot/python", "/opt/tarubot/controller"]
    allowed = {"PATH", "LANG", "GPG_KEY", "PYTHON_VERSION", "PYTHON_SHA256", "HOSTNAME", "HOME"}
    require(set(os.environ) <= allowed and os.environ.get("HOSTNAME") == "tarubot-controller")
    # Core Ansible creates local temp during import. Keep every home/plugin/config root
    # measured and read-only; only this exact bounded tmpfs path can receive temp files.
    fixed = {"HOME": "/opt/tarubot/controller", "ANSIBLE_HOME": "/opt/tarubot/controller",
             "ANSIBLE_CONFIG": "/opt/tarubot/controller/ansible.cfg", "ANSIBLE_LOCAL_TEMP": "/run/tarubot/ansible-tmp"}
    os.environ.update(fixed)
    require(all(os.environ.get(key) == value for key, value in fixed.items()))
    os.mkdir("/run/tarubot/ansible-tmp", mode=0o700)
    pins = literal_json(Path("/opt/tarubot/controller/pins.json").read_bytes())
    for name in ("launcher.py", "tarubot_guarded.py", "_tarubot_frames.py"):
        directory = "controller" if name == "launcher.py" else "connection_plugins"
        data = (Path("/opt/tarubot") / directory / name).read_bytes()
        require(hashlib.sha256(data).hexdigest() == pins["sources"][name])
    # Phase directories never appear on sys.path or in environment-selected loader roots.
    for parent, dirs, files in os.walk("/opt/tarubot", followlinks=False):
        require(not any(name == "__pycache__" for name in dirs))
        require(not any(name.endswith((".pth", ".pyc", ".pyo")) or
                        name in ("sitecustomize.py", "usercustomize.py") for name in files))
    return pins


def phase_commitment(root, names):
    observed = []
    found = []
    for parent, directories, files in os.walk(root, followlinks=False):
        for name in directories:
            info = os.lstat(Path(parent) / name)
            require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                    and stat.S_IMODE(info.st_mode) == 0o555)
        for name in files:
            path = Path(parent) / name
            relative = str(path.relative_to(root))
            require(relative in names)
            info = os.lstat(path)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o444 and info.st_size <= 2 * 1024 * 1024)
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                before = os.fstat(fd)
                data = bytearray()
                while len(data) <= before.st_size:
                    part = os.read(fd, min(65536, before.st_size + 1 - len(data)))
                    if not part:
                        break
                    data.extend(part)
                after = os.fstat(fd)
                require(len(data) == before.st_size and before.st_ino == after.st_ino
                        and before.st_mtime_ns == after.st_mtime_ns and before.st_size == after.st_size)
                observed.append([relative, hashlib.sha256(data).hexdigest(), len(data)])
                found.append(relative)
            finally:
                os.close(fd)
    require(sorted(found) == sorted(names))
    observed.sort(key=lambda item: item[0].encode())
    return hashlib.sha256(encode(observed)).hexdigest()


class Window:
    def __init__(self, seconds):
        self.end = time.monotonic() + seconds
        first = time.time()
        self.wall = first + seconds
        self.last = first

    def check(self):
        before = time.monotonic()
        require(before < self.end)
        now = time.time()
        require(now >= self.last and now < self.wall)
        self.last = now
        self.end = min(self.end, before + self.wall - now)
        require(time.monotonic() < self.end)

    def timeout(self):
        self.check()
        return max(0.0, min(self.end - time.monotonic(), 0.1))


def frame(value):
    data = encode(value)
    require(len(data) <= 32768)
    return b"HCP1" + struct.pack(">I", len(data)) + data


def write_all(fd, data, window):
    offset = 0
    while offset < len(data):
        window.check()
        count = os.write(fd, data[offset:])
        require(count > 0)
        offset += count
        window.check()


def read_frame(fd, window):
    data = bytearray()
    size = 8
    while len(data) < size:
        window.check()
        ready = selectors.DefaultSelector()
        try:
            ready.register(fd, selectors.EVENT_READ)
            if not ready.select(window.timeout()):
                continue
        finally:
            ready.close()
        window.check()
        part = os.read(fd, size - len(data))
        require(part)
        data.extend(part)
        if len(data) == 8:
            require(data[:4] == b"HCP1")
            payload = struct.unpack(">I", data[4:8])[0]
            require(0 < payload <= 32768)
            size = 8 + payload
    window.check()
    return literal_json(data[8:])


def live_pidfd(fd):
    # Validate a real native pidfd. Its JSON label/claimed PID is never consulted.
    require(os.readlink(f"/proc/self/fd/{fd}") == "anon_inode:[pidfd]")
    signal.pidfd_send_signal(fd, 0)
    values = {}
    with open(f"/proc/self/fdinfo/{fd}", encoding="ascii") as source:
        for line in source:
            key, _, value = line.partition(":")
            values[key] = value.strip()
    require(values.get("Pid", "").isdigit())
    pid = int(values["Pid"])
    require(pid > 0)
    poller = selectors.DefaultSelector()
    try:
        poller.register(fd, selectors.EVENT_READ)
        require(not poller.select(0))
    finally:
        poller.close()
    return pid


def register_worker(channel, driver_pid, worker_number, window):
    window.check()
    data, ancillary, flags, _ = channel.recvmsg(4096, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(4),
                                               socket.MSG_CMSG_CLOEXEC)
    fds = []
    credentials = None
    try:
        require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC))
        for level, kind, value in ancillary:
            require(level == socket.SOL_SOCKET)
            if kind == socket.SCM_RIGHTS:
                received = array.array("i")
                received.frombytes(value)
                fds.extend(received)
            elif kind == socket.SCM_CREDENTIALS:
                require(credentials is None and len(value) == 12)
                credentials = struct.unpack("3i", value)
            else:
                require(False)
        require(credentials == (driver_pid, os.getuid(), os.getgid()) and len(fds) == 1)
        value = literal_json(data)
        exact(value, ("schema", "kind", "worker", "role"))
        require(value == {"schema": 1, "kind": "register", "worker": worker_number, "role": "probe"})
        pid = live_pidfd(fds[0])
        require(pid not in (os.getpid(), driver_pid))
        window.check()
        channel.send(encode({"schema": 1, "kind": "registered", "worker": worker_number}))
        window.check()
        fd = fds.pop()
        return fd, pid
    finally:
        for fd in fds:
            os.close(fd)


def driver(channel, pause_read, control_path):
    """Rehearse the exact pinned fork seam, then pause without parsing any phase content."""
    private_process()
    null = os.open(os.devnull, os.O_RDWR | os.O_CLOEXEC)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    os.close(null)
    # Fixed core-only imports; no PlaybookCLI, DataLoader or phase file is evaluated here.
    from ansible.executor.process.worker import WorkerProcess
    from types import SimpleNamespace

    original_start, original_run = WorkerProcess.start, WorkerProcess.run
    active = {}
    broker_pid = os.getppid()
    driver_pid = os.getpid()
    owned_pause_read = pause_read

    def after_fork():
        nonlocal owned_pause_read
        # This also applies to unrelated descendants: no inherited registration authority.
        channel.close()
        if owned_pause_read is not None:
            os.close(owned_pause_read)
            owned_pause_read = None

    os.register_at_fork(after_in_child=after_fork)

    def start(worker):
        require(type(worker) is WorkerProcess and not active)
        read_end, write_end = os.pipe2(os.O_CLOEXEC)
        active["read"] = read_end
        active["write"] = write_end
        active["object"] = worker
        fd = None
        try:
            original_start(worker)
            # Exact captured core start created this process; no public PID constructor.
            fd = os.pidfd_open(worker.pid, 0)
            rights = array.array("i", [fd])
            channel.sendmsg([encode({"schema": 1, "kind": "register", "worker": 1, "role": "probe"})],
                            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
            require(literal_json(channel.recv(4096)) == {"schema": 1, "kind": "registered", "worker": 1})
            os.write(write_end, b"P")
        finally:
            if fd is not None:
                os.close(fd)
            os.close(read_end)
            os.close(write_end)
            active.clear()

    def run(worker):
        require(active.get("object") is worker)
        os.close(active["write"])
        require(os.read(active["read"], 1) == b"P")
        os.close(active["read"])
        require(channel.fileno() == -1)

        def inaccessible():
            for parent in (broker_pid, driver_pid):
                try:
                    os.readlink(f"/proc/{parent}/fd/0")
                except PermissionError:
                    pass
                else:
                    require(False)
                try:
                    descriptor = os.open(f"/proc/{parent}/mem", os.O_RDONLY | os.O_CLOEXEC)
                except PermissionError:
                    pass
                else:
                    os.close(descriptor)
                    require(False)
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
            try:
                connection.settimeout(2)
                connection.connect(control_path)
                # Even a valid registered inert worker cannot allocate a host request. A
                # descendant additionally has no registration; peer PID alone grants nothing.
                require(connection.recv(512) == b'{"fenced":true}\n')
            finally:
                connection.close()

        descendant = os.fork()
        if descendant == 0:
            try:
                inaccessible()
                os._exit(0)
            except BaseException:
                os._exit(1)
        require(os.waitpid(descendant, 0)[1] == 0)
        inaccessible()
        # The rehearsal never calls TaskExecutor. Future task registration needs a genuine
        # protected phase grant, and its reviewed path must retain original_run unchanged.
        os._exit(0)

    WorkerProcess.start, WorkerProcess.run = start, run
    try:
        worker = WorkerProcess(final_q=None, task_vars={}, host=None, task=None, play_context=None,
                               loader=SimpleNamespace(), variable_manager=None,
                               shared_loader_obj=None, worker_id=0, cliargs=None)
        worker.start()
        worker.join(3)
        require(not worker.is_alive() and worker.exitcode == 0)
        worker.close()
        channel.send(encode({"schema": 1, "kind": "paused"}))
        # No byte can release this driver. EOF/anything terminates it; only a later reviewed
        # native grant integration may add a private continuation, never a boolean callback.
        os.read(pause_read, 1)
        os._exit(1)
    finally:
        WorkerProcess.start, WorkerProcess.run = original_start, original_run


def main():
    window = Window(60)
    private_process()
    source_guard()
    ROOT.mkdir(mode=0o700, exist_ok=True)
    os.chdir(ROOT)
    request = read_frame(0, window)
    exact(request, ("schema", "kind", "nonce", "recipe_sha256", "rootfs_sha256", "configuration_sha256", "release_sha256"))
    require(request["schema"] == 1 and request["kind"] == "prepare")
    for key in ("nonce", "recipe_sha256", "rootfs_sha256", "configuration_sha256", "release_sha256"):
        require(type(request[key]) is str and len(request[key]) == 64
                and all(char in "0123456789abcdef" for char in request[key]))
    require(phase_commitment(Path("/phase/config"), CONFIG_FILES) == request["configuration_sha256"])
    require(phase_commitment(Path("/phase/release"), RELEASE_FILES) == request["release_sha256"])
    # The existing plugin's fixture-named locator/target are local aliases, never host
    # identity. This real in-container broker owns the endpoint, but its only sink refuses.
    control_path = str(ROOT / "control.sock")
    control = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
    control.bind(control_path)
    os.chmod(control_path, 0o600)
    control.listen(4)
    bootstrap = {"schema": 1, "session_id": request["nonce"][:32],
                 "capability": os.urandom(32).hex(), "control": "control.sock", "local_root": str(ROOT)}
    descriptor = os.open(ROOT / "bootstrap.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    try:
        write_all(descriptor, encode(bootstrap), window)
    finally:
        os.close(descriptor)
    broker, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET | socket.SOCK_CLOEXEC)
    broker.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    broker.settimeout(5)
    read_end, write_end = os.pipe2(os.O_CLOEXEC)
    pid = os.fork()
    if pid == 0:
        broker.close()
        os.close(write_end)
        try:
            control.close()
            driver(child, read_end, control_path)
        except BaseException:
            os._exit(1)
    child.close()
    os.close(read_end)
    driver_fd = os.pidfd_open(pid, 0)
    worker_fd = None
    try:
        worker_fd, worker_pid = register_worker(broker, pid, 1, window)
        denied = 0
        while True:
            ready = selectors.DefaultSelector()
            try:
                ready.register(broker, selectors.EVENT_READ, "driver")
                ready.register(control, selectors.EVENT_READ, "control")
                events = ready.select(window.timeout())
            finally:
                ready.close()
            window.check()
            paused = False
            for key, _ in events:
                if key.data == "driver":
                    require(literal_json(broker.recv(4096)) == {"schema": 1, "kind": "paused"})
                    paused = True
                else:
                    window.check()
                    connection, _ = control.accept()
                    try:
                        peer_pid, peer_uid, peer_gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                        require(peer_pid > 0 and peer_uid == os.getuid() and peer_gid == os.getgid())
                        require(live_pidfd(worker_fd) == worker_pid)
                        if denied == 0:
                            require(peer_pid not in (worker_pid, pid, os.getpid()))
                            observed = Path(f"/proc/{peer_pid}/stat").read_text(encoding="ascii")
                            require(len(observed) <= 4096 and observed.split(" ", 1)[0] == str(peer_pid))
                            # The actual connector is the registered probe's direct child.
                            # This kernel observation only checks the negative rehearsal;
                            # no ancestry/JSON/PID observation grants an allocation.
                            require(int(observed[observed.rfind(")") + 2:].split()[1]) == worker_pid)
                        else:
                            require(denied == 1 and peer_pid == worker_pid)
                        connection.settimeout(1)
                        window.check()
                        connection.sendall(b'{"fenced":true}\n')
                        window.check()
                        denied += 1
                    finally:
                        connection.close()
            if paused:
                require(denied == 2)
                break
        # Retire the inert probe before publishing a prepared capability. A dead/reused PID
        # cannot retain a registration; real plugin connectors would need a live task origin.
        poller = selectors.DefaultSelector()
        try:
            poller.register(worker_fd, selectors.EVENT_READ)
            require(poller.select(3))
        finally:
            poller.close()
        os.close(worker_fd)
        worker_fd = None
        live_pidfd(driver_fd)
        window.check()
        write_all(1, frame({"schema": 1, "kind": "prepared", "nonce": request["nonce"],
                            "recipe_sha256": request["recipe_sha256"],
                            "configuration_sha256": request["configuration_sha256"],
                            "release_sha256": request["release_sha256"],
                            "worker_origin": "native-pidfd-scm-credentials", "descendant_isolation": True,
                            "paused": True}), window)
        command = read_frame(0, window)
        exact(command, ("schema", "kind", "nonce"))
        require(command == {"schema": 1, "kind": "stop", "nonce": request["nonce"]})
        write_all(1, frame({"schema": 1, "kind": "stopped", "nonce": request["nonce"]}), window)
    finally:
        # This is accepted-resource cleanup, not a renewed operation or a future host offer.
        if worker_fd is not None:
            os.close(worker_fd)
        os.close(write_end)
        try:
            signal.pidfd_send_signal(driver_fd, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        # PID1 owns orphan cleanup too. These PIDs come only from its kernel child list in
        # the fixed private PID namespace, never caller metadata or an ancestry assertion.
        cleanup_end = time.monotonic() + 3
        while time.monotonic() < cleanup_end:
            try:
                while os.waitpid(-1, os.WNOHANG)[0] != 0:
                    pass
            except ChildProcessError:
                break
            remaining = Path(f"/proc/self/task/{os.getpid()}/children").read_text(encoding="ascii").split()
            for child_pid in remaining:
                descriptor = None
                try:
                    descriptor = os.pidfd_open(int(child_pid), 0)
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                finally:
                    if descriptor is not None:
                        os.close(descriptor)
            time.sleep(0.01)
        os.close(driver_fd)
        broker.close()
        control.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No raw traceback, argv, mount path, phase content or child diagnostics escapes.
        raise SystemExit(1) from None
