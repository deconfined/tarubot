"""Private TBH1 client codec. Local IPC is transport mechanics, never host authority.

The fixture launcher pins/copies this file beside its connection plugin. Every exchange
has independently allocated nonce/sequence space and no retry, pooling or fallback.
"""
from __future__ import annotations

import json
import os
import re
import selectors
import socket
import stat
import struct
import time

FAILURE = "tarubot-guarded-transport-uncertain"
DATA_LIMIT = 8 * 1024 * 1024
WIRE_LIMIT = 9 * 1024 * 1024
KINDS = {"exec": 1, "put": 2, "fetch": 3, "response": 4, "stdin": 5,
         "file": 6, "stdout": 7, "stderr": 8, "end": 9, "result": 10, "uncertain": 11}
BY_CODE = {value: key for key, value in KINDS.items()}
DATA = {"stdin", "file", "stdout", "stderr"}


def require(value):
    if not value:
        raise RuntimeError(FAILURE)


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def bounded_json(raw, maximum=16384):
    require(type(raw) is bytes and len(raw) <= maximum)
    value = json.loads(raw.decode("utf-8", "strict"), object_pairs_hook=pairs,
                       parse_constant=lambda _: require(False))
    nodes = 0
    size = 0

    def walk(item, depth=0):
        nonlocal nodes, size
        nodes += 1
        require(nodes <= 256 and depth <= 8)
        if type(item) is str:
            size += len(item.encode("utf-8"))
        elif type(item) is dict:
            require(len(item) <= 32)
            for key, field in item.items():
                size += len(key.encode("utf-8"))
                walk(field, depth + 1)
        elif type(item) is list:
            require(len(item) <= 32)
            for field in item:
                walk(field, depth + 1)
        else:
            require(item is None or type(item) in (bool, int, float))
        require(size <= maximum)
    walk(value)
    return value


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def private_directory(path):
    require(type(path) is str and os.path.isabs(path) and os.path.normpath(path) == path)
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700)
    # Refuse symlink ancestors too. Shared /tmp is allowed only as an ancestor,
    # never as the actual private bootstrap/socket directory.
    current = path
    while current != "/":
        require(not stat.S_ISLNK(os.lstat(current).st_mode))
        current = os.path.dirname(current)


def private_file(path, root):
    private_directory(root)
    require(os.path.dirname(path) == root)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    info = os.fstat(fd)
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1)
    return fd, info


def socket_path(root, basename):
    private_directory(root)
    require(type(basename) is str and re.fullmatch(r"[a-f0-9]{32}\.sock", basename))
    path = os.path.join(root, basename)
    info = os.lstat(path)
    require(stat.S_ISSOCK(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o600)
    return path


def read_bootstrap(path):
    root = os.path.dirname(path)
    fd, info = private_file(path, root)
    try:
        require(info.st_size <= 512)
        raw = os.read(fd, 513)
        require(len(raw) == info.st_size)
    finally:
        os.close(fd)
    value = bounded_json(raw, 512)
    exact(value, ("schema", "session_id", "capability", "control", "local_root"))
    require(value["schema"] == 1 and type(value["schema"]) is int)
    require(re.fullmatch(r"[a-f0-9]{32}", value["session_id"]) is not None)
    require(re.fullmatch(r"[a-f0-9]{64}", value["capability"]) is not None)
    require(value["local_root"] == root)
    socket_path(root, value["control"])
    return value


def read_exact(sock, count, deadline):
    result = bytearray()
    while len(result) < count:
        require(time.monotonic() < deadline)
        sock.settimeout(max(0.000001, deadline - time.monotonic()))
        part = sock.recv(count - len(result))
        require(time.monotonic() < deadline)
        require(part)
        result.extend(part)
    return bytes(result)


def control(bootstrap, operation):
    deadline = time.monotonic() + 3
    raw = json.dumps({"schema": 1, "session_id": bootstrap["session_id"],
                      "capability": bootstrap["capability"], "operation": operation},
                     separators=(",", ":")).encode()
    require(len(raw) <= 512)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as channel:
        channel.settimeout(3)
        channel.connect(socket_path(bootstrap["local_root"], bootstrap["control"]))
        require(time.monotonic() < deadline)
        channel.settimeout(max(0.000001, deadline - time.monotonic()))
        channel.sendall(struct.pack("!I", len(raw)) + raw)
        require(time.monotonic() < deadline)
        channel.shutdown(socket.SHUT_WR)
        require(time.monotonic() < deadline)
        length = struct.unpack("!I", read_exact(channel, 4, deadline))[0]
        require(0 < length <= 512)
        value = bounded_json(read_exact(channel, length, deadline), 512)
        require(time.monotonic() < deadline)
        channel.settimeout(max(0.000001, deadline - time.monotonic()))
        require(channel.recv(1) == b"")
        require(time.monotonic() < deadline)
    if operation == "fence":
        exact(value, ("fenced",))
        require(value["fenced"] is True)
        return value
    exact(value, ("schema", "session_id", "operation", "nonce", "socket", "remaining_ms"))
    require(value["schema"] == 1 and type(value["schema"]) is int
            and value["session_id"] == bootstrap["session_id"]
            and value["operation"] == operation)
    require(type(value["nonce"]) is str and re.fullmatch(r"[a-f0-9]{32}", value["nonce"]))
    require(type(value["remaining_ms"]) is int and 0 < value["remaining_ms"] <= 60000)
    socket_path(bootstrap["local_root"], value["socket"])
    return value


class MarkerGate:
    """Exact per-channel line proof. Never combine stdout and stderr fragments."""
    def __init__(self, marker):
        require(type(marker) is str and re.fullmatch(r"BECOME-SUCCESS-[a-z]{32}", marker))
        self.marker = marker.encode()
        self.pending = {"stdout": bytearray(), "stderr": bytearray()}
        self.proven = False
        self.prefix_bytes = 0

    @property
    def ready(self):
        blocked = False
        tag = b"BECOME-SUCCESS-"
        prompts = (b"[sudo]", b"password:", b"password for ",
                   b"a terminal is required", b"must have a tty")
        for pending in self.pending.values():
            raw = bytes(pending)
            lower = raw.lower()
            for prompt in prompts:
                require(prompt not in lower)
                if any(lower.endswith(prompt[:length]) for length in range(1, len(prompt))):
                    blocked = True
            at = raw.find(tag)
            if at >= 0:
                candidate = raw[at:]
                require(not self.proven and self.marker.startswith(candidate.removesuffix(b"\r")))
                blocked = True
            if any(raw.endswith(tag[:length]) for length in range(1, len(tag))):
                blocked = True
        return self.proven and not blocked

    def consume(self, kind, chunk, final=False):
        pending = self.pending[kind]
        pending.extend(chunk)
        if not self.proven:
            self.prefix_bytes += len(chunk)
            require(self.prefix_bytes <= 16384)
        output = bytearray()
        while b"\n" in pending:
            line, _, rest = pending.partition(b"\n")
            pending[:] = rest
            stripped = bytes(line).removesuffix(b"\r")
            if stripped == self.marker:
                require(not self.proven)
                self.proven = True
            else:
                require(b"BECOME-SUCCESS-" not in stripped)
                lowered = stripped.lower()
                require(not any(prompt in lowered for prompt in
                                (b"[sudo]", b"password:", b"password for ",
                                 b"a terminal is required", b"must have a tty")))
                output.extend(line + b"\n")
        # A malformed marker/prompt may have no newline; do not offer any input first.
        if not self.proven:
            lowered = bytes(pending).lower()
            require(not any(prompt in lowered for prompt in
                            (b"[sudo]", b"password:", b"password for ")))
        if final:
            require(self.proven and b"BECOME-SUCCESS-" not in pending)
            output.extend(pending)
            pending.clear()
        # Validate every partial channel before any subsequent payload reservation/write.
        # A correct stdout marker cannot authorize input while stderr holds a malformed,
        # duplicate or unresolved marker/prompt candidate (and conversely).
        self.ready
        return bytes(output)


def remote_path(path):
    require(type(path) is str and len(path.encode()) <= 4096
            and re.fullmatch(r"/[A-Za-z0-9_./-]+", path) and path != "/"
            and not path.endswith("/") and os.path.normpath(path) == path
            and all(part not in (".", "..", "") for part in path.split("/")[1:]))


def exchange(bootstrap, operation, request, data=b"", gate=None, destination=None, finalize=None):
    """One nonblocking duplex exchange; result requires request flush and response EOF.

    Side effects already accepted by the peer cannot be undone. All local buffers and
    socket callbacks remain private to this one operation and failure fences its parent.
    """
    physical = time.monotonic()
    allocation = control(bootstrap, operation)
    # Subtract the entire handshake conservatively, including time before allocation.
    # The server's original deadline is independently enforced and never renewed.
    deadline = physical + allocation["remaining_ms"] / 1000
    require(time.monotonic() < deadline)
    nonce = bytes.fromhex(allocation["nonce"])
    require(type(data) is bytes and len(data) <= DATA_LIMIT)
    if operation in ("put", "fetch"):
        remote_path(request["path"])
    else:
        require(type(request.get("command")) is list)
        command = request["command"]
        require(1 <= len(command) <= 32 and command[0] and
                sum(len(part.encode()) for part in command) <= 16384)
        for part in command:
            require(type(part) is str and len(part.encode()) <= 4096
                    and all(ord(char) >= 32 and ord(char) != 127 for char in part))
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    selection = None
    try:
        require(time.monotonic() < deadline)
        sock.settimeout(max(0.000001, deadline - time.monotonic()))
        sock.connect(socket_path(bootstrap["local_root"], allocation["socket"]))
        require(time.monotonic() < deadline)
        sock.setblocking(False)
        selection = selectors.DefaultSelector()
        selection.register(sock, selectors.EVENT_READ | selectors.EVENT_WRITE)
    except Exception:
        for cleanup in (lambda: selection.close() if selection is not None else None,
                        sock.close):
            try:
                cleanup()
            except Exception:
                pass
        raise RuntimeError(FAILURE) from None
    queue = []
    pending_bytes = 0
    sequence = 0
    incoming_sequence = 0
    written = 0
    wire_read = 0
    received_bytes = 0
    frames_read = 0
    buffered = bytearray()
    output = {"stdout": bytearray(), "stderr": bytearray()}
    started = False
    offered_end = False
    sent_end = False
    offset = 0
    terminal = None

    def offer(kind, value):
        nonlocal pending_bytes, sequence, written
        payload = value if kind in DATA else (b"" if kind == "end" else
                  json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())
        require(len(payload) <= (65536 if kind in DATA else 16384))
        wire = struct.pack("!4sB3xII16s", b"TBH1", KINDS[kind], sequence, len(payload), nonce) + payload
        require(sequence < 4096 and len(queue) < 8 and pending_bytes + len(wire) <= 512 * 1024
                and written + len(wire) <= WIRE_LIMIT)
        sequence += 1
        written += len(wire)
        pending_bytes += len(wire)
        queue.append([wire, 0, kind])

    offer(operation, {"kind": operation, **request})
    try:
        while True:
            require(time.monotonic() < deadline)
            # Read all available complete frames before offering payload. A duplicate/wrong
            # marker in the same batch therefore cannot race the first input byte.
            while len(buffered) >= 32:
                require(time.monotonic() < deadline)
                magic, code, seq, length, observed = struct.unpack("!4sB3xII16s", buffered[:32])
                kind = BY_CODE.get(code)
                require(magic == b"TBH1" and buffered[5:8] == b"\0\0\0"
                        and seq == incoming_sequence and observed == nonce and kind is not None)
                require(0 < length <= (65536 if kind in DATA else 16384))
                if len(buffered) < 32 + length:
                    break
                require(terminal is None)
                payload = bytes(buffered[32:32 + length])
                del buffered[:32 + length]
                incoming_sequence += 1
                frames_read += 1
                require(frames_read <= 4096)
                if kind in DATA:
                    require(started and (kind in ("stdout", "stderr") or
                                         operation == "fetch" and kind == "file"))
                    received_bytes += length
                    require(received_bytes <= DATA_LIMIT)
                    if kind == "file":
                        require(destination is not None)
                        destination.write(payload)
                        require(time.monotonic() < deadline)
                    else:
                        output[kind].extend(gate.consume(kind, payload) if gate else payload)
                        require(time.monotonic() < deadline)
                else:
                    value = bounded_json(payload)
                    require(value.get("kind") == kind)
                    if kind == "response":
                        exact(value, ("kind", "operation"))
                        require(not started and value["operation"] == operation)
                        started = True
                    elif kind == "uncertain":
                        exact(value, ("kind", "error"))
                        require(started and value["error"] == "host-bridge-uncertain")
                        # No EOF/ack is needed to know uncertainty. Stop both directions now.
                        raise RuntimeError(FAILURE)
                    elif kind == "result":
                        exact(value, ("kind", "code"))
                        require(started and sent_end and type(value["code"]) is int
                                and 0 <= value["code"] <= 254)
                        terminal = value["code"]
                    else:
                        require(False)
            if not offered_end and (gate is None or gate.ready):
                # Bound pending reservations and stream large module input with backpressure.
                while offset < len(data) and len(queue) < 7 and pending_bytes < 400000:
                    chunk = data[offset:offset + 65536]
                    offer("stdin" if operation == "exec" else "file", chunk)
                    offset += len(chunk)
                if offset == len(data) and len(queue) < 8:
                    offer("end", {})
                    offered_end = True
            writable = queue and (queue[0][2] == operation or gate is None or gate.ready)
            events = selectors.EVENT_READ | (selectors.EVENT_WRITE if writable else 0)
            selection.modify(sock, events)
            ready = selection.select(max(0.001, deadline - time.monotonic()))
            require(ready and time.monotonic() < deadline)
            for _, event in ready:
                if event & selectors.EVENT_READ:
                    part = sock.recv(65536)
                    require(time.monotonic() < deadline)
                    if not part:
                        require(terminal is not None and not buffered and sent_end and not queue)
                        if gate:
                            for kind in output:
                                output[kind].extend(gate.consume(kind, b"", final=True))
                        require(time.monotonic() < deadline)
                        if finalize is not None and terminal == 0:
                            # Private plugin finalization retains the same original deadline.
                            # It receives denial only, not a renewable/raw deadline authority.
                            finalize(lambda: require(time.monotonic() < deadline))
                        result = (terminal, bytes(output["stdout"]), bytes(output["stderr"]))
                        require(time.monotonic() < deadline)
                        return result
                    wire_read += len(part)
                    require(wire_read <= WIRE_LIMIT and len(buffered) + len(part) <= 131072)
                    buffered.extend(part)
                    # Parse newly received bytes before writing any stdin in this iteration.
                    continue
                if event & selectors.EVENT_WRITE and queue:
                    require(time.monotonic() < deadline)
                    wire, consumed, kind = queue[0]
                    if kind != operation and gate is not None and not gate.ready:
                        continue
                    try:
                        size = sock.send(memoryview(wire)[consumed:])
                        require(time.monotonic() < deadline)
                    except BlockingIOError:
                        continue
                    require(size > 0)
                    queue[0][1] += size
                    if queue[0][1] == len(wire):
                        queue.pop(0)
                        pending_bytes -= len(wire)
                        if kind == "end":
                            require(not queue)
                            sock.shutdown(socket.SHUT_WR)
                            sent_end = True
    finally:
        failed = False
        for cleanup in (selection.close, sock.close):
            try:
                cleanup()
            except Exception:
                failed = True
        if failed or time.monotonic() >= deadline:
            raise RuntimeError(FAILURE) from None


def fence(bootstrap):
    try:
        control(bootstrap, "fence")
    except Exception:
        # An allocated/abandoned socket also fences by its original coordinator deadline.
        pass
