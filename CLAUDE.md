# Working guide for Claude Code

@AGENTS.md

Use [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks and the change checklist, and [docs/README.md](docs/README.md) to find a task reference. Do not infer live deployment state from archived session notes.

The agent rule was confirmed by @deconfined on 2026-09-26 ([#41](https://github.com/deconfined/tarubot/issues/41#issuecomment-5846407419)) and widened to Infrastructure and every deployment environment on 2026-09-29. [AGENTS.md](AGENTS.md) carries the binding wording. Never approve, reject, bypass or re-run deployments, hold a host-access key or environment secret, or change deployment environments. Dispatch only at the owner's request in this session.

Local pitfalls:

- Bun automatically loads the checkout's `.env`; script children can reload it even when the parent used `--env-file`. Never run production/rehearsal tools through root `bun run` aliases. See [tool profiles](docs/CONFIGURATION.md#maintenance-tool-profiles).
- Use pnpm only from `site/`. Do not add root scripts for the site.
- The shell is zsh: a variable containing a command does not word-split; use a function. Brace variables before modifier-like suffixes, such as `${tag}:latest`.
- Offline Ansible commands need a UTF-8 locale and blocking streams; use `LC_ALL=C.UTF-8 … < /dev/null 2>&1 | cat`. Real-host runs are not authorized.
