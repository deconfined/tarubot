#!/usr/bin/env python3
"""The templar check (2.37.0, the review's B2 and B10): ops/ansible/bot.yml's own expressions,
evaluated by ansible-core's templar, against the cases in tests/fixtures/bot-asserts.json.

tests/unit/bot-play.test.ts pins bot.yml's shape (names, order, conditions as text), but a
refusal's expression can be wrong while its text still looks right: a `>= 0` that never fails, a
readiness wait whose result nothing reads. This script loads bot.yml the way ansible-playbook does
(DataLoader, so every string in it is a trusted template under ansible-core 2.19+'s data tagging),
finds each case's task by its exact name, and evaluates one of its expressions with the Templar:

- "that": an assert's conditions, all of which must hold, as the assert module requires;
- "when", "failed_when", "until", "changed_when": a task's own conditional (a list is all of it);
- "fail_msg": an assert's message, templated;
- "stdin": a command's stdin, templated (with "json": true, parsed before the comparison);
- any other field: that key of the task's set_fact, templated.

The variables are vars/bot.yml's, overlaid with the case's "vars"; the environment, which
lookup('ansible.builtin.env', ...) reads, is exactly the case's "env" for every name any case or
vars/bot.yml mentions. Every value in the cases is invented. A case passes when the result equals
"expect", or, for strings, contains every "contains" and none of the "excludes".

Run it with the runner's pinned ansible-core (ops/ansible/requirements-lint.txt), under a UTF-8
locale, from anywhere:

    python tests/fixtures/bot-asserts.py

It prints one line per failing case, naming only the case and its task, never a value, and exits
1 when any case fails (2 when a case names no single task or field). BOT_ASSERTS_DEBUG=1 adds each
failing case's result, for local runs only: the values are the cases' own invented ones.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ANSIBLE_DIR = ROOT / "ops" / "ansible"
CASES = Path(__file__).resolve().with_name("bot-asserts.json")

# ansible.cfg's settings (ansible.builtin only, no collections), as the playbooks run with them.
# ansible-core reads its configuration when first imported, so this comes before the imports.
os.environ["ANSIBLE_CONFIG"] = str(ANSIBLE_DIR / "ansible.cfg")

from ansible.parsing.dataloader import DataLoader  # noqa: E402
from ansible.plugins.loader import init_plugin_loader  # noqa: E402
from ansible.template import Templar  # noqa: E402

CONDITIONALS = ("when", "failed_when", "until", "changed_when")
MODULES = ("ansible.builtin.assert", "ansible.builtin.command", "ansible.builtin.set_fact")


def tasks(nodes):
    """Every task in a list of tasks, blocks' own tasks included, in file order."""
    for task in nodes or []:
        yield task
        for key in ("block", "rescue", "always"):
            yield from tasks(task.get(key))


def plain(value):
    """A templated result as plain JSON-shaped Python, for comparison with the cases."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return str(value)
    if isinstance(value, dict):
        return {str(key): plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(item) for item in value]
    raise TypeError(type(value).__name__)


def module_args(task):
    """The task's module and its arguments, for the three modules the cases read."""
    for module in MODULES:
        if module in task:
            return module, task[module]
    return None, {}


def evaluate(templar, task, field):
    """One case's expression on its task, as ansible-core evaluates it."""
    module, args = module_args(task)
    if field in CONDITIONALS:
        conditions = task.get(field)
        conditions = conditions if isinstance(conditions, list) else [conditions]
        return all(templar.evaluate_conditional(condition) for condition in conditions)
    if field == "that" and module == "ansible.builtin.assert":
        that = args["that"] if isinstance(args["that"], list) else [args["that"]]
        return all(templar.evaluate_conditional(condition) for condition in that)
    if field == "fail_msg" and module == "ansible.builtin.assert":
        return templar.template(args["fail_msg"])
    if field == "stdin" and module == "ansible.builtin.command":
        return templar.template(args["stdin"])
    if module == "ansible.builtin.set_fact" and field in args:
        return templar.template(args[field])
    raise LookupError(field)


def passes(case, result):
    """Whether a result meets the case's expectations."""
    if case.get("json"):
        result = json.loads(result)
    if "expect" in case and result != case["expect"]:
        return False
    for text in case.get("contains", []):
        if not isinstance(result, str) or text not in result:
            return False
    for text in case.get("excludes", []):
        if not isinstance(result, str) or text in result:
            return False
    return True


def main():
    init_plugin_loader([])
    loader = DataLoader()
    loader.set_basedir(str(ANSIBLE_DIR))
    plays = loader.load_from_file(str(ANSIBLE_DIR / "bot.yml"), trusted_as_template=True)
    base = loader.load_from_file(str(ANSIBLE_DIR / "vars" / "bot.yml"), trusted_as_template=True)
    by_name = {}
    for play in plays:
        for task in tasks(play.get("tasks")):
            by_name.setdefault(str(task.get("name")), []).append(task)

    cases = json.loads(CASES.read_text(encoding="utf-8"))["cases"]
    # Every name any case sets, and every secret and setting bot.yml can read: each case sees
    # exactly its own values for these, and nothing left over from the runner or another case.
    names = set(base["tb_secret_env"]) | set(base["tb_setting_env"])
    for case in cases:
        names |= set(case.get("env", {}))
    debug = os.environ.get("BOT_ASSERTS_DEBUG") == "1"

    failed = 0
    for case in cases:
        found = by_name.get(case["task"], [])
        if len(found) != 1:
            print(f"BROKEN {case['name']}: {len(found)} tasks named {case['task']!r}")
            return 2
        for name in names:
            os.environ.pop(name, None)
        os.environ.update(case.get("env", {}))
        templar = Templar(loader=loader, variables={**base, **case.get("vars", {})})
        try:
            result = plain(evaluate(templar, found[0], case["field"]))
            ok = passes(case, result)
        except LookupError:
            print(f"BROKEN {case['name']}: {case['task']!r} has no {case['field']}")
            return 2
        except Exception as error:  # noqa: BLE001 - a raising expression is a failing case
            result = f"raised {type(error).__name__}"
            ok = False
        if not ok:
            failed += 1
            print(f"FAIL {case['name']} ({case['task']})")
            if debug:
                print(f"  got: {result!r}")
    for name in names:
        os.environ.pop(name, None)
    print(f"{len(cases) - failed} of {len(cases)} cases passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
