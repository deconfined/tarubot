"""Measured PID1 broker: private native worker origins, then a paused driver.

The owned parent alone may release a matching protected phase into the fixed DENY sink.
Neither a phase declaration nor private framing supplies real host execution authority.
pidfd proves process identity/liveness, not continued Python-code identity: the reviewed
no-exec worker path and native kernel/engine integrity remain explicit prerequisites.
"""
import array
import ctypes
import hashlib
import base64
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
        self.guard = None

    def check(self):
        before = time.monotonic()
        require(before < self.end)
        now = time.time()
        require(now >= self.last and now < self.wall)
        self.last = now
        self.end = min(self.end, before + self.wall - now)
        if self.guard is not None:
            self.guard()
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


def register_worker(channel, driver_pid, worker_number, window, role="probe"):
    window.check()
    channel.settimeout(max(0.001, window.end - time.monotonic()))
    data, ancillary, flags, _ = channel.recvmsg(4096, socket.CMSG_SPACE(12) + socket.CMSG_SPACE(4),
                                               socket.MSG_CMSG_CLOEXEC)
    fds = []
    credentials = None
    try:
        # recvmsg installs received descriptors even when ancillary space is truncated.
        # Own every delivered right BEFORE any validation can throw.
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                received = array.array("i")
                received.frombytes(value)
                fds.extend(received)
        require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC))
        for level, kind, value in ancillary:
            require(level == socket.SOL_SOCKET)
            if kind == socket.SCM_RIGHTS:
                pass
            elif kind == socket.SCM_CREDENTIALS:
                require(credentials is None and len(value) == 12)
                credentials = struct.unpack("3i", value)
            else:
                require(False)
        require(credentials == (driver_pid, os.getuid(), os.getgid()) and len(fds) == 1)
        value = literal_json(data)
        exact(value, ("schema", "kind", "worker", "role"))
        require(value == {"schema": 1, "kind": "register", "worker": worker_number, "role": role})
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


def guarded_worker_connection(worker, phase_name):
    require(worker._host.name in ("target", "localhost"))
    require(not worker._task.delegate_to and not worker._task_vars.get("ansible_delegated_vars"))
    play = worker._task.get_play()
    require(play is not None)
    connection = "local" if worker._host.name == "localhost" else "tarubot_guarded"
    if connection == "local":
        # Hostname alone is never local execution authority. Only the two fixed
        # reviewed report plays and their bounded builtin tasks may use local.
        reports = {
            "bot": ("Write the result on the runner", {
                "Check that the result goes to an absolute path on the runner": "ansible.builtin.assert",
                "Assemble the result from public fields only": "ansible.builtin.set_fact",
                "Write the result": "ansible.builtin.copy",
                "Fail the run unless it deployed, was superseded, only configured or passed its preflight": "ansible.builtin.assert"}),
            "accept": ("Write only the bound public acceptance evidence", {
                "Require all target checks to have completed": "ansible.builtin.assert",
                "Write the public release result": "ansible.builtin.copy"}),
        }
        require(phase_name in reports)
        report_name, tasks = reports[phase_name]
        # Pinned core declares Play.hosts as a list, including a literal YAML scalar.
        require(play.name == report_name and play.hosts == ["localhost"] and play.connection == "local"
                and worker._task.get_path().rsplit(":", 1)[0] == "/phase/release/ops/ansible/" + phase_name + ".yml"
                and tasks.get(worker._task.name) == worker._task.action)
    return connection


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
    worker_number = 0
    role = "probe"
    phase_name = None

    def after_fork():
        nonlocal owned_pause_read
        # This also applies to unrelated descendants: no inherited registration authority.
        channel.close()
        if owned_pause_read is not None:
            os.close(owned_pause_read)
            owned_pause_read = None

    os.register_at_fork(after_in_child=after_fork)

    def start(worker):
        nonlocal worker_number
        require(type(worker) is WorkerProcess and not active)
        require(worker_number < 64)
        worker_number += 1
        if role == "task":
            # Source trees are separately authenticated by the protected parent. Fixed
            # highest-precedence host variables prevent a task/inventory from selecting
            # another transport; localhost report tasks stay explicitly local.
            connection = guarded_worker_connection(worker, phase_name)
            worker._task_vars["ansible_connection"] = connection
            worker._play_context.connection = connection
            if connection != "local":
                worker._task_vars.update({"ansible_host": "tarubot_fixture_target",
                                          "ansible_user": "root", "ansible_shell_executable": "/bin/sh",
                                          "ansible_python_interpreter": "/usr/bin/python3"})
                worker._play_context.remote_addr = "tarubot_fixture_target"
                worker._play_context.remote_user = "root"
                worker._play_context.executable = "/bin/sh"
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
            channel.sendmsg([encode({"schema": 1, "kind": "register", "worker": worker_number, "role": role})],
                            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, rights)])
            require(literal_json(channel.recv(4096)) == {"schema": 1, "kind": "registered", "worker": worker_number})
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
        active["read"] = None
        active["write"] = None
        require(channel.fileno() == -1)
        if role == "task":
            # Only the captured measured core method runs tasks. The worker has no
            # registration/parent channel and cannot construct another native origin.
            original_run(worker)
            os._exit(0)

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
        require(os.read(pause_read, 1) == b"R")
        os.close(pause_read)
        owned_pause_read = None
        release = literal_json(channel.recv(32768))
        exact(release, ("schema", "kind", "declaration"))
        require(release["schema"] == 1 and release["kind"] == "release-denial")
        role = "task"
        phase_name = release["declaration"]["phase"]
        run_phase(release["declaration"])
        # A denied task is never a successful deployment or acceptance result.
        os._exit(1)
    finally:
        WorkerProcess.start, WorkerProcess.run = original_start, original_run


def run_phase(declaration):
    exact(declaration, ("schema", "purpose", "target", "action", "phase", "phase_number",
                        "accept_release", "configuration", "release"))
    require(declaration["schema"] == 1 and declaration["purpose"] == "tarubot-host-controller-phase-v1"
            and declaration["target"] == "staging" and declaration["action"] == "deploy"
            and declaration["accept_release"] is True
            and (declaration["phase"], declaration["phase_number"]) in (("site", 0), ("bot", 1), ("accept", 2)))
    release = declaration["release"]
    exact(release, ("version", "commit", "digest", "config_commit", "publication_run", "schema_head"))
    exact(declaration["configuration"], ("commit",))
    require(declaration["configuration"]["commit"] == release["config_commit"] == release["commit"])
    # The fixed first remote task is denied before application settings could be used.
    # A future REAL-operation recipe needs a separate native grant/settings integration.
    os.environ.update({"TARUBOT_FIXTURE_BOOTSTRAP": str(ROOT / "bootstrap.json"),
                       "ANSIBLE_COLLECTIONS_PATH": "/dev/null", "ANSIBLE_COLLECTIONS_SCAN_SYS_PATH": "False",
                       "ANSIBLE_ROLES_PATH": "/dev/null", "ANSIBLE_INVENTORY_ENABLED": "yaml",
                       "ANSIBLE_RETRY_FILES_ENABLED": "False", "ANSIBLE_FORKS": "1",
                       "ANSIBLE_CONNECTION_PLUGINS": "/opt/tarubot/connection_plugins"})
    from ansible.cli.playbook import PlaybookCLI
    from ansible.plugins.loader import connection_loader
    connection_loader.add_directory("/opt/tarubot/connection_plugins")
    inventory = ROOT / "inventory.yml"
    content = b"all:\n  hosts:\n    target:\n      ansible_host: tarubot_fixture_target\n      ansible_connection: tarubot_guarded\n      ansible_user: root\n      ansible_shell_executable: /bin/sh\n"
    with inventory.open("xb") as output:
        output.write(content)
    inventory.chmod(0o600)
    selected = "/phase/config/ops/ansible/site.yml" if declaration["phase"] == "site" else "/phase/release/ops/ansible/" + declaration["phase"] + ".yml"
    variables = {"tarubot_role": "staging", "tarubot_target": "staging", "tarubot_action": "deploy",
                 "tarubot_version": release["version"], "tarubot_commit": release["commit"],
                 "tarubot_digest": release["digest"], "tarubot_publication_run": release["publication_run"],
                 "tarubot_schema_head": release["schema_head"], "tarubot_result": str(ROOT / "result.json"),
                 "tarubot_acceptance": str(ROOT / "acceptance.json")}
    cli = PlaybookCLI(["ansible-playbook", "--forks", "1", "--inventory", str(inventory),
                       "--extra-vars", encode(variables).decode("ascii"), selected])
    cli.parse()
    cli.run()


def peer_read(connection, count, worker_fd, worker_pid, window, eof=False):
    """Per-message kernel credentials reject a fork descendant inheriting a connected FD."""
    output = bytearray()
    while len(output) < count:
        window.check()
        require(live_pidfd(worker_fd) == worker_pid)
        connection.settimeout(max(0.001, window.end - time.monotonic()))
        data, ancillary, flags, _ = connection.recvmsg(min(65536, count - len(output)), socket.CMSG_SPACE(12) + socket.CMSG_SPACE(4), socket.MSG_CMSG_CLOEXEC)
        credentials = None
        received = []
        try:
            for level, kind, value in ancillary:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    rights = array.array("i")
                    rights.frombytes(value)
                    received.extend(rights)
            require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC))
            for level, kind, value in ancillary:
                require(level == socket.SOL_SOCKET)
                if kind == socket.SCM_RIGHTS:
                    pass
                else:
                    require(kind == socket.SCM_CREDENTIALS and credentials is None and len(value) == 12)
                    credentials = struct.unpack("3i", value)
            require(not received)
            if not data:
                require(eof and not output)
                return b""
            require(credentials == (worker_pid, os.getuid(), os.getgid()))
            output.extend(data)
        finally:
            for descriptor in received:
                os.close(descriptor)
        window.check()
    return bytes(output)


def capture_request(connection, operation, nonce, worker_fd, worker_pid, window):
    sequence = 0
    header = None
    body = bytearray()
    wire = 0
    while True:
        raw = peer_read(connection, 32, worker_fd, worker_pid, window)
        magic, code, observed, size, observed_nonce = struct.unpack("!4sB3xII16s", raw)
        require(magic == b"TBH1" and raw[5:8] == b"\0\0\0" and observed == sequence
                and observed_nonce == bytes.fromhex(nonce) and sequence < 4096)
        sequence += 1
        wire += 32 + size
        require(wire <= 9 * 1024 * 1024)
        if header is None:
            require(code == {"exec": 1, "put": 2, "fetch": 3}[operation] and 0 < size <= 16384)
            header = peer_read(connection, size, worker_fd, worker_pid, window)
            request = literal_json(header)
            exact(request, ("kind", "command") if operation == "exec" else ("kind", "path"))
            require(request["kind"] == operation)
            if operation == "exec":
                command = request["command"]
                require(type(command) is list and 1 <= len(command) <= 32 and command[0]
                        and all(type(part) is str and 0 < len(part.encode()) <= 4096
                                and all(ord(char) >= 32 and ord(char) != 127 for char in part) for part in command)
                        and sum(len(part.encode()) for part in command) <= 16384)
            else:
                path = request["path"]
                require(type(path) is str and path.startswith("/") and path != "/" and not path.endswith("/")
                        and len(path.encode()) <= 4096 and os.path.normpath(path) == path
                        and all(part and part not in (".", "..") and all(char.isascii() and (char.isalnum() or char in "_.-") for char in part) for part in path.split("/")[1:]))
        elif code == 9:
            require(size == 0 and peer_read(connection, 1, worker_fd, worker_pid, window, eof=True) == b"")
            return header, bytes(body)
        else:
            require(operation != "fetch" and code == (5 if operation == "exec" else 6) and 0 < size <= 65536)
            require(len(body) + size <= 8 * 1024 * 1024)
            body.extend(peer_read(connection, size, worker_fd, worker_pid, window))


def retained_request_origin(control, broker, driver_fd, worker_fd, worker_pid):
    # These are privately retained native descriptors, never labels returned by inspection.
    require(live_pidfd(worker_fd) == worker_pid)
    live_pidfd(driver_fd)
    ready = selectors.DefaultSelector()
    try:
        ready.register(broker, selectors.EVENT_READ)
        ready.register(control, selectors.EVENT_READ)
        require(not ready.select(0))
    finally:
        ready.close()


def denial_phase(control, broker, driver_pid, driver_fd, request, bootstrap, window):
    worker_fd = None
    worker_pid = None
    worker_number = 1
    connection = None
    allocation_socket = None
    try:
        while connection is None:
            window.check()
            live_pidfd(driver_fd)
            ready = selectors.DefaultSelector()
            try:
                ready.register(broker, selectors.EVENT_READ, "register")
                ready.register(control, selectors.EVENT_READ, "control")
                if worker_fd is not None:
                    ready.register(worker_fd, selectors.EVENT_READ, "retired")
                events = ready.select(window.timeout())
            finally:
                ready.close()
            # Core's fixed forks=1 may run several builtin preflight/report tasks before
            # its first guarded request. Retire the old native worker before registering
            # the next one, including when both notifications were already queued.
            for key, _ in sorted(events, key=lambda item: {"retired": 0, "register": 1, "control": 2}[item[0].data]):
                if key.data == "retired":
                    os.close(worker_fd)
                    worker_fd, worker_pid = None, None
                elif key.data == "register":
                    if worker_fd is not None:
                        # A sequential core start may queue immediately after the previous
                        # worker exits; use the native pidfd rather than another PID label.
                        retired = selectors.DefaultSelector()
                        try:
                            retired.register(worker_fd, selectors.EVENT_READ)
                            require(retired.select(0))
                        finally:
                            retired.close()
                        os.close(worker_fd)
                        worker_fd, worker_pid = None, None
                    worker_number += 1
                    require(worker_number <= 64)
                    worker_fd, worker_pid = register_worker(broker, driver_pid, worker_number, window, "task")
                else:
                    require(worker_fd is not None and worker_pid is not None)
                    caller, _ = control.accept()
                    try:
                        caller.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                        require(struct.unpack("3i", caller.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) == (worker_pid, os.getuid(), os.getgid()))
                        size = struct.unpack("!I", peer_read(caller, 4, worker_fd, worker_pid, window))[0]
                        require(0 < size <= 512)
                        allocation = literal_json(peer_read(caller, size, worker_fd, worker_pid, window))
                        exact(allocation, ("schema", "session_id", "capability", "operation"))
                        require(allocation["schema"] == 1 and allocation["session_id"] == bootstrap["session_id"]
                                and allocation["capability"] == bootstrap["capability"] and allocation["operation"] in ("exec", "put", "fetch"))
                        require(peer_read(caller, 1, worker_fd, worker_pid, window, eof=True) == b"")
                        operation = allocation["operation"]
                        nonce = os.urandom(16).hex()
                        basename = os.urandom(16).hex() + ".sock"
                        allocation_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
                        allocation_socket.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                        allocation_socket.bind(str(ROOT / basename))
                        os.chmod(ROOT / basename, 0o600)
                        allocation_socket.listen(1)
                        reply = encode({"schema": 1, "session_id": bootstrap["session_id"], "operation": operation,
                                        "nonce": nonce, "socket": basename, "remaining_ms": max(1, int((window.end - time.monotonic()) * 1000))})
                        window.check()
                        caller.sendall(struct.pack("!I", len(reply)) + reply)
                        window.check()
                    finally:
                        caller.close()
                    allocation_socket.settimeout(max(0.001, window.end - time.monotonic()))
                    connection, _ = allocation_socket.accept()
                    connection.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                    require(struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)) == (worker_pid, os.getuid(), os.getgid()))
                    break
        header, body = capture_request(connection, operation, nonce, worker_fd, worker_pid, window)
        def retained_origin():
            retained_request_origin(control, broker, driver_fd, worker_fd, worker_pid)
        # No second registration/control allocation may hide while the original request
        # is withheld through parent crypto. Kernel liveness stays attached to this origin.
        window.guard = retained_origin
        request_sha = hashlib.sha256(header).hexdigest()
        input_sha = hashlib.sha256(body).hexdigest()
        write_all(1, frame({"schema": 1, "kind": "exchange", "nonce": request["nonce"], "worker": worker_number,
                            "sequence": 0, "operation": operation, "request_b64": base64.b64encode(header).decode("ascii"),
                            "request_sha256": request_sha, "input_size": len(body), "input_sha256": input_sha}), window)
        sequence = 0
        for offset in range(0, len(body), 12288):
            write_all(1, frame({"schema": 1, "kind": "input", "nonce": request["nonce"], "sequence": sequence,
                                "data": base64.b64encode(body[offset:offset + 12288]).decode("ascii")}), window)
            sequence += 1
        write_all(1, frame({"schema": 1, "kind": "exchange-end", "nonce": request["nonce"], "chunks": sequence}), window)
        command = read_frame(0, window)
        exact(command, ("schema", "kind", "nonce", "worker", "sequence", "request_sha256", "input_sha256"))
        require(command == {"schema": 1, "kind": "deny", "nonce": request["nonce"], "worker": worker_number,
                            "sequence": 0, "request_sha256": request_sha, "input_sha256": input_sha})
        require(live_pidfd(worker_fd) == worker_pid)
        # No success/marker/output is synthesized. This deliberately cannot reach a real
        # host sink or feed stdin to SSH; the plugin sees only explicit uncertainty.
        output = b""
        for number, (code, value) in enumerate(((4, {"kind": "response", "operation": operation}),
                                               (11, {"kind": "uncertain", "error": "host-bridge-uncertain"}))):
            payload = encode(value)
            output += struct.pack("!4sB3xII16s", b"TBH1", code, number, len(payload), bytes.fromhex(nonce)) + payload
        window.check()
        connection.sendall(output)
        connection.close()
        connection = None
        window.guard = None
        wait = selectors.DefaultSelector()
        try:
            wait.register(worker_fd, selectors.EVENT_READ)
            wait.register(control, selectors.EVENT_READ)
            retired = False
            while not retired:
                window.check()
                for key, _ in wait.select(window.timeout()):
                    if key.fileobj == worker_fd:
                        retired = True
                    else:
                        caller, _ = control.accept()
                        try:
                            caller.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
                            size = struct.unpack("!I", peer_read(caller, 4, worker_fd, worker_pid, window))[0]
                            require(0 < size <= 512)
                            value = literal_json(peer_read(caller, size, worker_fd, worker_pid, window))
                            exact(value, ("schema", "session_id", "capability", "operation"))
                            require(value == {"schema": 1, "session_id": bootstrap["session_id"], "capability": bootstrap["capability"], "operation": "fence"})
                            require(peer_read(caller, 1, worker_fd, worker_pid, window, eof=True) == b"")
                            reply = encode({"fenced": True})
                            window.check()
                            caller.sendall(struct.pack("!I", len(reply)) + reply)
                            window.check()
                        finally:
                            caller.close()
        finally:
            wait.close()
        window.check()
        write_all(1, frame({"schema": 1, "kind": "denied", "nonce": request["nonce"], "worker": worker_number, "sequence": 0}), window)
    finally:
        if connection is not None:
            connection.close()
        if allocation_socket is not None:
            allocation_socket.close()
        if worker_fd is not None:
            try:
                signal.pidfd_send_signal(worker_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(worker_fd)


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
    control_name = os.urandom(16).hex() + ".sock"
    control_path = str(ROOT / control_name)
    control = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM | socket.SOCK_CLOEXEC)
    control.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
    control.bind(control_path)
    os.chmod(control_path, 0o600)
    control.listen(4)
    bootstrap = {"schema": 1, "session_id": request["nonce"][:32],
                 "capability": os.urandom(32).hex(), "control": control_name, "local_root": str(ROOT)}
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
        if command.get("kind") == "stop":
            exact(command, ("schema", "kind", "nonce"))
            require(command == {"schema": 1, "kind": "stop", "nonce": request["nonce"]})
            write_all(1, frame({"schema": 1, "kind": "stopped", "nonce": request["nonce"]}), window)
        else:
            exact(command, ("schema", "kind", "nonce", "declaration", "data_valid_until", "remaining_ms"))
            require(command["schema"] == 1 and command["kind"] == "release-denial" and command["nonce"] == request["nonce"]
                    and type(command["data_valid_until"]) is int and 0 < command["data_valid_until"] / 1000 - time.time() <= 2400
                    and type(command["remaining_ms"]) is int and 0 < command["remaining_ms"] <= 30000)
            window.check()
            # This only replaces local construction ownership with an absolute DATA
            # lifecycle. The parent keeps its older grant epoch through every byte.
            phase_window = Window(min(command["remaining_ms"] / 1000,
                                      command["data_valid_until"] / 1000 - time.time()))
            phase_window.wall = min(phase_window.wall, command["data_valid_until"] / 1000)
            broker.send(encode({"schema": 1, "kind": "release-denial", "declaration": command["declaration"]}))
            write_all(write_end, b"R", phase_window)
            denial_phase(control, broker, pid, driver_fd, request, bootstrap, phase_window)
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
