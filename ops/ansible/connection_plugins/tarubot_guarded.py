"""First-party private framing plugin. It has no SSH/SCP/SFTP implementation or fallback.

Only the fixture launcher currently supplies its private local coordinator. These files
do not establish descriptor/owner/journal authority or an operational deployment path.
"""
from __future__ import annotations

import importlib.util
import os
import stat
import tempfile

from ansible.errors import AnsibleConnectionFailure
from ansible.plugins.connection import ConnectionBase, ensure_connect
from ansible.plugins.loader import become_loader

DOCUMENTATION = r"""
name: tarubot_guarded
short_description: Private bounded framed transport
description:
  - Fixture-only coordinator transport; no operational host transport is configured.
author: TaruBot maintainers
options: {}
"""

# The launcher separately pins and copies both first-party files into its private directory.
_helper_path = os.path.join(os.path.dirname(__file__), "_tarubot_frames.py")
_spec = importlib.util.spec_from_file_location("_tarubot_private_frames", _helper_path)
_frames = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_frames)
_builtin_sudo = become_loader.get("sudo", class_only=True)


class Connection(ConnectionBase):
    transport = "tarubot_guarded"
    supports_persistence = False
    force_persistence = False
    has_tty = False
    has_pipelining = True
    has_native_async = False
    always_pipeline_modules = False

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._bootstrap = None
        self._active = False
        self._failed = False
        try:
            # An inventory/task option cannot select this capability locator.
            self._bootstrap = _frames.read_bootstrap(os.environ["TARUBOT_FIXTURE_BOOTSTRAP"])
        except Exception:
            self._refuse()

    def _refuse(self):
        self._failed = True
        self._connected = False
        if self._bootstrap is not None:
            _frames.fence(self._bootstrap)
        raise AnsibleConnectionFailure(_frames.FAILURE) from None

    def _connect(self):
        try:
            _frames.require(not self._failed and not self._active)
            _frames.require(self._play_context.remote_addr == "tarubot_fixture_target")
            _frames.require(self._play_context.remote_user == "root")
            _frames.require(self._play_context.executable == "/bin/sh")
            self._connected = True
            return self
        except Exception:
            self._refuse()

    def is_pipelining_enabled(self, wrap_async=False):
        if wrap_async:
            self._refuse()
        return True

    def _marker(self, sudoable):
        if not sudoable or self.become is None:
            return None
        become = self.become
        try:
            _frames.require(type(become) is _builtin_sudo)
            password = become.get_option("become_pass")
            prompt = become.prompt
            executable = become.get_option("become_exe")
            flags = become.get_option("become_flags")
            user = become.get_option("become_user")
            success = become.success
            _frames.require(not password and not prompt)
            _frames.require(executable in ("sudo", "/usr/bin/sudo"))
            _frames.require(flags == "-H -S -n" and user in ("root", "tarubot"))
            return _frames.MarkerGate(success)
        except Exception:
            self._refuse()

    def _exchange(self, operation, request, data=b"", gate=None, destination=None, finalize=None):
        try:
            _frames.require(not self._failed and not self._active)
            self._active = True
            result = _frames.exchange(self._bootstrap, operation, request, data, gate, destination, finalize)
            self._active = False
            return result
        except Exception:
            self._refuse()

    @ensure_connect
    def exec_command(self, cmd, in_data=None, sudoable=True):
        try:
            _frames.require(isinstance(cmd, str) and (in_data is None or type(in_data) is bytes))
            # Pinned core wraps task strings with template tags. Copy the intrinsic Unicode
            # value without invoking a caller's overridden __str__/iteration hooks.
            cmd = str.__str__(cmd)
            marker = self._marker(sudoable)
            return self._exchange("exec", {"command": ["/bin/sh", "-c", cmd]},
                                  b"" if in_data is None else in_data, marker)
        except Exception:
            self._refuse()

    @ensure_connect
    def put_file(self, in_path, out_path):
        fd = None
        try:
            _frames.require(isinstance(in_path, str) and isinstance(out_path, str))
            in_path, out_path = str.__str__(in_path), str.__str__(out_path)
            root = self._bootstrap["local_root"]
            # Controller module files may live in an owned private subdirectory.
            parent = os.path.dirname(os.path.abspath(in_path))
            _frames.require(os.path.commonpath((root, parent)) == root)
            _frames.private_directory(parent)
            fd = os.open(in_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(fd)
            _frames.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                            and info.st_nlink == 1 and info.st_size <= _frames.DATA_LIMIT)
            data = b""
            while len(data) <= info.st_size:
                part = os.read(fd, min(65536, info.st_size + 1 - len(data)))
                if not part:
                    break
                data += part
            _frames.require(len(data) == info.st_size)
            code, _, _ = self._exchange("put", {"path": out_path}, data)
            _frames.require(code == 0)
        except Exception:
            self._refuse()
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except Exception:
                    self._refuse()

    @ensure_connect
    def fetch_file(self, in_path, out_path):
        temporary = None
        try:
            _frames.require(isinstance(in_path, str) and isinstance(out_path, str))
            in_path, out_path = str.__str__(in_path), str.__str__(out_path)
            root = self._bootstrap["local_root"]
            parent = os.path.dirname(os.path.abspath(out_path))
            _frames.require(os.path.commonpath((root, parent)) == root)
            _frames.private_directory(parent)
            if os.path.lexists(out_path):
                info = os.lstat(out_path)
                _frames.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                                and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600)
            fd, temporary = tempfile.mkstemp(prefix=".tarubot-fetch-", dir=parent)
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as sink:
                def commit(check):
                    nonlocal temporary
                    check()
                    sink.flush()
                    check()
                    os.fsync(sink.fileno())
                    check()
                    # Already-started filesystem side effects cannot be undone. In particular,
                    # a late flush/fsync may never authorize a subsequent atomic replacement.
                    os.replace(temporary, out_path)
                    temporary = None
                    check()
                    directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
                    try:
                        os.fsync(directory)
                        check()
                    finally:
                        os.close(directory)
                code, _, _ = self._exchange("fetch", {"path": in_path}, destination=sink,
                                           finalize=commit)
                _frames.require(code == 0)
        except Exception:
            self._refuse()
        finally:
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except Exception:
                    # Teardown diagnostics may contain private paths. Preserve fixed denial;
                    # failure to remove an owned partial never permits a successful result.
                    self._refuse()

    def close(self):
        if self._active:
            self._refuse()
        self._connected = False

    def reset(self):
        # Core reboot/reset never clears the parent's permanent uncertainty fence.
        self.close()
