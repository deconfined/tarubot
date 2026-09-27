# Deploy run directories

`v1/` holds a finished run directory exactly as a v1 `ops/deploy.sh` worker leaves it under
`~/.local/state/tarubot-deploy/runs/<run id>/` on the production host (`lock` and `worker.log`
aside). `public.log` is stored as `public.log.fixture`, because `.gitignore` and `.dockerignore`
leave out `*.log`; the test copies it back to its real name. `tests/unit/deploy-script.test.ts` replays it through the current entry: the command
format and this layout are a versioned contract, because after a rollback an older script answers
the current workflow. A change to either raises `FLOOR` in `ops/deploy.sh` and adds a `v2/` here.

The Quadlet modes (2.33.0, `deploy.sh quadlet` and `deploy.sh quadlet staging`) keep the command
format and this layout, so the same `v1/` directory replays through their entry too; their own
contract is the word `quadlet` in `CAPABILITIES`, not `FLOOR`.
