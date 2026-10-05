"""A bounded native-SSH command: publish invented release state, not a mock SSH client."""

import hashlib
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path("/lab")
command = os.environ.get("SSH_ORIGINAL_COMMAND", "")
expected = (ROOT / "expected-request").read_text().strip()
form = r"deploy (production|staging) ([0-9]+\.[0-9]+\.[0-9]+) ([0-9a-f]{40}) (sha256:[0-9a-f]{64}) ([1-9][0-9]*)"
match = re.fullmatch(form, command)
if match is None or command != expected:
    print("result refused", flush=True)
    sys.exit(64)

# Hold the authenticated session briefly until the root observer has sampled
# the *production helper's* live resolver and private work-directory lifecycle.
# Nothing mutation-capable runs until native OpenSSH has authenticated SSHFP.
remote = ROOT / "remote"
(remote / "entered").write_text("authenticated native ssh session\n")
deadline = time.monotonic() + 10
while not (ROOT / "release-command").exists():
    if time.monotonic() >= deadline:
        print("result refused", flush=True)
        sys.exit(70)
    time.sleep(0.01)

print("step preflight", flush=True)
identity = (ROOT / "server-public-identity").read_text().strip()
host = (ROOT / "deployment-host").read_text().strip()
diagnostic = f"fixture-private-diagnostic host={host} address=192.0.2.10 identity={identity} request={command}"
# Genuine output on both SSH channels must remain private in the transport.
print(diagnostic, flush=True)
print(diagnostic, file=sys.stderr, flush=True)
release = {
    "target": match[1],
    "version": match[2],
    "commit": match[3],
    "digest": match[4],
    "runId": match[5],
    "uid": os.getuid(),
    "request": command,
    "privateDiagnosticEmitted": True,
}
encoded = (json.dumps(release, sort_keys=True) + "\n").encode()
# Atomic publication is a real filesystem effect. The separate marker is
# written only after the remote state exists, by the synthetic tarubot user.
pending = remote / "release.pending"
pending.write_bytes(encoded)
pending.replace(remote / "release.json")
(remote / "execution-marker.json").write_text(
    json.dumps({**release, "stateSha256": hashlib.sha256(encoded).hexdigest()}) + "\n"
)
print("step record", flush=True)
print("result deployed", flush=True)
