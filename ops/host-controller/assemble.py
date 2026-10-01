"""Deterministic, offline wheel assembly; never a runtime expectation issuer.

The trusted parent's independent TS model derives the complete expected filesystem from
the reviewed base/wheel/source bytes BEFORE building. This program only applies that recipe.
The native engine and kernel remain separately trusted capabilities.
"""
import base64
import hashlib
import io
import json
import os
import shutil
import stat
import zipfile
from pathlib import Path


def require(value):
    if not value:
        raise RuntimeError("host-controller-assembly-failed")


def pairs(items):
    output = {}
    for key, value in items:
        require(key not in output)
        output[key] = value
    return output


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data, mode=0o644):
    path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    with path.open("xb") as output:
        output.write(data)
    path.chmod(mode)
    os.utime(path, (0, 0))


def main():
    # pathlib's intermediate parents use the process umask, not the leaf mode argument.
    # The independent model commits every generated directory as root-owned 0755.
    os.umask(0o022)
    root = Path("/build")
    pin_bytes = (root / "pins.json").read_bytes()
    pins = json.loads(pin_bytes, object_pairs_hook=pairs)
    require(pins["schema"] == 1 and pins["platform"] == "linux/amd64")
    # Static reviewed source expectations, never hashes adopted from the build's own output.
    for name, expected in pins["sources"].items():
        require(name in ("Containerfile", "assemble.py", "launcher.py", "tarubot_guarded.py", "_tarubot_frames.py"))
        require(digest((root / name).read_bytes()) == expected)
    require(len(pins["sources"]) == 5)
    require(sorted(path.name for path in (root / "wheels").iterdir()) ==
            sorted(item["filename"] for item in pins["wheels"]))
    for path in (Path("/usr/local/lib/python3.12/site-packages"),
                 Path("/usr/local/lib/python3.12/ensurepip")):
        if path.exists():
            shutil.rmtree(path)
    # -B also protects startup; pruning prevents loader selection of precompiled foreign code.
    for parent, dirs, files in os.walk("/usr/local", followlinks=False):
        for name in list(dirs):
            if name == "__pycache__":
                shutil.rmtree(Path(parent) / name)
                dirs.remove(name)
        for name in files:
            path = Path(parent) / name
            if name.endswith((".pyc", ".pyo")) or (parent == "/usr/local/bin" and name.startswith("pip")):
                path.unlink()
    destination = Path("/opt/tarubot/python")
    for wheel in pins["wheels"]:
        data = (root / "wheels" / wheel["filename"]).read_bytes()
        require(len(data) == wheel["size"] and digest(data) == wheel["sha256"])
        archive = zipfile.ZipFile(io.BytesIO(data))
        members = {}
        seen = set()
        total = 0
        for member in archive.infolist():
            name = member.filename
            directory = member.is_dir()
            path = name[:-1] if directory else name
            kind = stat.S_IFMT(member.external_attr >> 16)
            require(path not in seen and len(name) <= 4096 and not name.startswith("/")
                    and "\\" not in name and all(part not in ("", ".", "..") for part in path.split("/")))
            seen.add(path)
            require(kind in (0, stat.S_IFDIR if directory else stat.S_IFREG)
                    and not name.endswith((".pth", ".pyc", ".pyo")) and ".data/" not in name
                    and not any(part in ("__pycache__", "sitecustomize.py", "usercustomize.py") for part in name.split("/")))
            require(member.file_size <= 32 * 1024 * 1024 and member.compress_type in (0, 8)
                    and member.flag_bits == 0 and (not directory or member.file_size == 0))
            total += member.file_size
            require(total <= 64 * 1024 * 1024 and len(seen) <= 4096)
            content = archive.read(member)
            if not directory:
                members[name] = content
        records = [name for name in members if name.endswith(".dist-info/RECORD")]
        require(len(records) == 1)
        checked = set()
        record = members[records[0]].decode("utf-8", "strict").replace("\r\n", "\n")
        require(record.endswith("\n") and "\r" not in record)
        for line in record[:-1].split("\n"):
            parts = line.split(",")
            require(len(parts) == 3)
            name, checksum, size = parts
            require(name in members and name not in checked)
            checked.add(name)
            if name == records[0]:
                require(checksum == "" and size == "")
            else:
                encoded = base64.urlsafe_b64encode(hashlib.sha256(members[name]).digest()).decode().rstrip("=")
                require(checksum == "sha256=" + encoded and size == str(len(members[name])))
        require(checked == set(members))
        for name, content in members.items():
            write(destination / name, content)
    for name in ("launcher.py", "pins.json", "tarubot_guarded.py", "_tarubot_frames.py"):
        directory = "connection_plugins" if name in ("tarubot_guarded.py", "_tarubot_frames.py") else "controller"
        write(Path("/opt/tarubot") / directory / name, (root / name).read_bytes())
    # Ansible validates a .cfg/.ini extension before reading even an empty defaults file.
    # No input-selected settings or writable loader roots enter this fixed startup config.
    write(Path("/opt/tarubot/controller/ansible.cfg"), b"[defaults]\n", mode=0o444)
    shutil.rmtree(root)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        raise SystemExit("host-controller-assembly-failed") from None
