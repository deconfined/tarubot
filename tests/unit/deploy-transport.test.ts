/**
 * Execute the runner transport (ops/deploy-ssh.sh) with invented privilege, package and SSH
 * stand-ins, to pin what it relays from the host entry: fixed step/result lines, `reason` lines of
 * one strict shape (2026-10-10), a plain-words cause and the entry identity comparison. The stand-ins
 * never touch the real resolver configuration, Unbound or a network.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(30_000);
const transport = fileURLToPath(new URL("../../ops/deploy-ssh.sh", import.meta.url));
const entry = fileURLToPath(new URL("../../ops/deploy.sh", import.meta.url));
const entrySha = createHash("sha256").update(readFileSync(entry)).digest("hex");
const scratch = mkdtempSync(join(tmpdir(), "deploy-transport-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const runId = "37000000001";
const workflowSha = "c".repeat(40);
// Assembled at runtime: the transport only checks that a private key was supplied.
const invent = (text: string) => [`-----BEGIN ${text}-----`, "invented", `-----END ${text}-----`];
const deliveryKey = invent(["OPENSSH", "PRIVATE", "KEY"].join(" ")).join("\n");

/** Every line the transport may print to the public log. */
const publicLine = new RegExp(
  [
    "^step (?:preflight|fetch|pull|stop|backup|migrate|register|start|observe|record)$",
    "^result (?:deployed|already-live|refused|needs-owner)$",
    "^Host diagnostics \\(reported by the host entry; its private log on the host has the detail\\):$",
    '^ {2}reason [a-z][a-z-]*( [A-Za-z][A-Za-z0-9_-]*=("[A-Za-z0-9 _.,:;!?()/+=<>\'-]{0,160}"|[A-Za-z0-9._-]{1,64}))*$',
    "^The host('s deploy entry| reports its deploy entry's sha256) [^:%]*$",
    "^::warning::The host reports its deploy entry's sha256 as [0-9a-f]{64}, which is not the workflow commit's ops/deploy\\.sh",
    "^::error::[^%]*$",
  ].join("|"),
);

type Host = { stdout: string[]; stderr?: string; exit?: number };
// Each suite runs with no LANG and under UTF-8 locales: glibc's [A-Za-z] matches letters such as é
// under en_US.UTF-8, so the transport's own C-locale matching must hold whatever the runner sets.
const availableLocales = Bun.spawnSync(["locale", "-a"]).stdout.toString().toLowerCase();
const locales = [undefined, "C.UTF-8", "en_US.UTF-8"].filter(
  (locale) =>
    locale === undefined || availableLocales.includes(locale.toLowerCase().replace("-", "")),
);
let activeLocale: string | undefined;

function run(host: Host, options: { transport?: string; env?: Record<string, string> } = {}) {
  const directory = mkdtempSync(join(scratch, "case-"));
  const bin = join(directory, "bin");
  const fake = join(directory, "fake");
  const runner = join(directory, "runner");
  for (const path of [bin, fake, runner]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(fake, "host-output"), host.stdout.map((line) => `${line}\n`).join(""));
  writeFileSync(join(fake, "host-stderr"), host.stderr ?? "");
  writeFileSync(join(fake, "host-exit"), String(host.exit ?? 0));
  const stub = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\nset -Eeuo pipefail\n${body}\n`, { mode: 0o700 });
  // Privileged operations stay inside this case's directory; anything unexpected fails.
  stub(
    "sudo",
    `[[ $1 == -n ]] || exit 70
shift
case $1 in
  mktemp) mkdir -p -- "$FAKE/unbound"; printf '%s\\n' "$FAKE/unbound" ;;
  tee) if [[ $2 == "$FAKE"/* ]]; then cat > "$2"; else cat > /dev/null; fi ;;
  unbound-checkconf | unbound-control) ;;
  sh) exec sleep 30 ;;
  kill) shift; kill "$@" ;;
  rm) [[ \${4:?} == "$FAKE"/* ]] && rm -rf -- "\${4:?}" ;;
  *) exit 70 ;;
esac`,
  );
  stub("dpkg-query", "printf '%s' '1:9.6p1-3ubuntu13.8'");
  stub("dpkg", "[[ $1 == --compare-versions ]]");
  stub(
    "ssh",
    `printf '%s\\n' "$*" > "$FAKE/ssh-args"
cat "$FAKE/host-output"
cat "$FAKE/host-stderr" >&2
exit "$(cat "$FAKE/host-exit")"`,
  );
  const result = Bun.spawnSync(
    ["/bin/bash", "--noprofile", "--norc", options.transport ?? transport],
    {
      cwd: directory,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: directory,
        FAKE: fake,
        RUNNER_TEMP: runner,
        TARGET: "production",
        REPO_PRODUCTION_DEPLOY_ENABLED: "true",
        VERSION: "2.41.0",
        COMMIT: "a".repeat(40),
        DIGEST: `sha256:${"b".repeat(64)}`,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: workflowSha,
        DEPLOY_HOST: "deploy.example.org",
        DEPLOY_SSH_KEY: deliveryKey,
        ...(activeLocale ? { LANG: activeLocale } : {}),
        ...options.env,
      },
      stdin: "ignore",
      timeout: 20_000,
      killSignal: "SIGKILL",
    },
  );
  const stdout = result.stdout.toString();
  expect(result.stderr.toString()).toBe("");
  // Nothing private, and nothing a runner could read as a workflow command but our own sentences.
  for (const line of stdout.split("\n").filter(Boolean)) expect(line).toMatch(publicLine);
  expect(stdout).not.toContain(directory);
  expect(stdout).not.toContain("invented");
  expect(stdout.match(/^::error::/gmu)?.length ?? 0).toBeLessThanOrEqual(1);
  return { code: result.exitCode, stdout, lines: stdout.split("\n") };
}

const steps = ["step preflight", "step fetch", "step pull", "step stop", "step backup"];
const allSteps = [...steps, "step migrate", "step register", "step start", "step observe"];
const entryLine = `reason entry sha256=${entrySha}`;
const logPath = `~/.local/state/tarubot-deploy/logs/${runId}001-*.log`;
const docs =
  "https://github.com/deconfined/tarubot/blob/main/docs/DEPLOYMENT.md#reading-a-failed-delivery";

for (const locale of locales) {
  describe(`with LANG ${locale ?? "unset"}`, () => {
    beforeAll(() => {
      activeLocale = locale;
    });
    describe("host entry identity", () => {
      test("a matching entry is reported as the host's claim, in one line", () => {
        const result = run({ stdout: [entryLine, ...allSteps, "step record", "result deployed"] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          `The host reports its deploy entry's sha256 as ${entrySha}, the same as the workflow commit's ops/deploy.sh; verify on the host if in doubt.\n`,
        );
        expect(result.stdout).not.toContain("Host diagnostics");
        expect(result.stdout).not.toContain("::");
      });

      test("a different entry only warns, naming both hashes and how to reinstall it", () => {
        const older = sha256("an older reviewed deploy entry");
        const result = run({
          stdout: [`reason entry sha256=${older}`, ...steps, "result deployed"],
        });
        expect(result.code).toBe(0);
        expect(result.lines).toContain(
          `::warning::The host reports its deploy entry's sha256 as ${older}, which is not the workflow commit's ops/deploy.sh (sha256 ${entrySha}). Reinstall it from that commit with \`git show ${workflowSha}:ops/deploy.sh\` if that wasn't intended.`,
        );
        expect(result.stdout).not.toContain("::error::");
      });

      test("an entry that predates the check says so without failing", () => {
        const result = run({ stdout: [...steps, "result already-live"] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          `The host's deploy entry didn't report its sha256, so it predates that check or isn't the reviewed entry; compare it on the host with the workflow commit's ops/deploy.sh (sha256 ${entrySha}).`,
        );
      });

      for (const [name, line] of [
        ["unreadable", "reason entry sha256=unavailable"],
        ["short", `reason entry sha256=${entrySha.slice(0, 40)}`],
      ] as const) {
        test(`an ${name} hash is reported as unusable, never compared or echoed`, () => {
          const result = run({ stdout: [line, ...steps, "result deployed"] });
          expect(result.code).toBe(0);
          expect(result.stdout).toContain(
            `The host's deploy entry didn't report a usable sha256, so it wasn't compared with the workflow commit's ops/deploy.sh (sha256 ${entrySha}).`,
          );
          expect(result.stdout).not.toContain(`${line.slice("reason entry sha256=".length)})`);
        });
      }

      test("a malformed hash line is dropped like any other malformed reason", () => {
        const result = run({
          stdout: [`reason entry sha256=${entrySha}::${entrySha}`, ...steps, "result deployed"],
        });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("The host's deploy entry didn't report its sha256");
      });

      test("without ops/deploy.sh beside the transport the reported hash is shown, not judged", () => {
        const lone = join(mkdtempSync(join(scratch, "lone-")), "deploy-ssh.sh");
        copyFileSync(transport, lone);
        const result = run(
          { stdout: [entryLine, ...steps, "result deployed"] },
          { transport: lone },
        );
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
          `The host reports its deploy entry's sha256 as ${entrySha}; there is no ops/deploy.sh beside this transport to compare it with.`,
        );
        // Without either hash there is nothing to say.
        expect(
          run({ stdout: [...steps, "result deployed"] }, { transport: lone }).stdout,
        ).not.toContain("deploy entry");
      });

      test("an entry that never answered gets no identity note", () => {
        const result = run({ stdout: [], stderr: "Permission denied (publickey).\n", exit: 255 });
        expect(result.code).not.toBe(0);
        expect(result.stdout).toBe(
          "::error::The host refused the delivery key; its deploy entry did not run.\n",
        );
      });
    });

    describe("host failure reasons", () => {
      test("needs-owner lists the reasons, then a plain cause, the private log and the guide", () => {
        const reasons = [
          "reason failed step=observe check=readiness status=1",
          "reason container exit=unknown oom=false restarts=0 health=healthy running=true uptime=52",
          "reason readiness identity=true schema=true http=503 live=true ready=false database=true writerLease=true discord=false",
          'reason bot-error msg="Operation failed; inspect scoped work status." code=TokenInvalid type=DiscordjsError op=startup',
          "reason fence writers=stopped",
        ];
        const result = run({
          stdout: [entryLine, ...allSteps, ...reasons, "result needs-owner"],
          exit: 1,
        });
        expect(result.code).not.toBe(0);
        const heading = result.lines.indexOf(
          "Host diagnostics (reported by the host entry; its private log on the host has the detail):",
        );
        expect(heading).toBeGreaterThan(result.lines.indexOf("result needs-owner"));
        expect(result.lines.slice(heading + 1, heading + 7)).toEqual(
          [entryLine, ...reasons].map((line) => `  ${line}`),
        );
        expect(result.lines).toContain(
          `::error::Likely cause: the new release didn't stay ready: Discord wasn't connected (the bot's last error code: TokenInvalid). The host stopped after the writer boundary and kept its pending marker; reconcile on the host before any new delivery. Its private log on the host is ${logPath}; see ${docs}.`,
        );
      });

      test("a damaged installed entry is named as the cause of a refusal", () => {
        const result = run({
          stdout: [
            `reason entry sha256=${sha256("a damaged copy")}`,
            "step preflight",
            "reason entry syntax=invalid line=314",
            "reason refused step=preflight code=entry-syntax",
            "result refused",
          ],
          exit: 1,
        });
        expect(result.lines).toContain(
          `::error::Likely cause: the host's installed deploy entry doesn't parse (a bash syntax error at line 314), so it isn't the reviewed ops/deploy.sh; reinstall it from a verified commit and check it with bash -n. The host refused this delivery before stopping the writer, so nothing changed. Its private log on the host, if this run wrote one, is ${logPath}; see ${docs}. Fix the cause, then re-run or dispatch again.`,
        );
        expect(result.stdout).toContain("::warning::The host reports its deploy entry's sha256");
      });

      for (const [name, reasons, cause] of [
        [
          "an out-of-memory exit",
          [
            "reason failed step=observe check=not-running status=1",
            "reason container exit=137 oom=true restarts=0 health=unhealthy running=false uptime=42",
          ],
          "the bot container exited with code 137 (out of memory: yes).",
        ],
        [
          "a start that never became healthy",
          [
            "reason failed step=start check=compose-up status=1",
            "reason container exit=0 oom=false restarts=0 health=starting running=true uptime=181",
          ],
          "the bot container didn't become healthy within the start wait.",
        ],
        [
          "a failed migration",
          [
            "reason failed step=migrate check=migrate status=1",
            'reason bot-error msg="uncaught error" code=28P01 type=Error',
          ],
          "the database migration failed (code 28P01).",
        ],
        [
          "a failed backup stage",
          [
            "reason failed step=backup check=backup status=124 timeout=true",
            "reason backup stage=upload",
          ],
          "the pre-migration backup failed at its upload stage (it timed out); nothing was migrated.",
        ],
        [
          "an unhealthy proxy",
          [
            "reason failed step=observe check=proxy-health status=1 health=unhealthy",
            "reason proxy exit=0 oom=false restarts=0 health=unhealthy running=true uptime=40",
          ],
          "bundled Caddy didn't stay running and healthy (health: unhealthy).",
        ],
      ] as const) {
        test(`${name} is summarised in plain words`, () => {
          const result = run({
            stdout: [entryLine, ...allSteps, ...reasons, "result needs-owner"],
            exit: 1,
          });
          expect(result.stdout).toContain(
            `::error::Likely cause: ${cause} The host stopped after the writer boundary`,
          );
        });
      }

      test("an unconfirmed fence asks the owner to check the host now", () => {
        const result = run({
          stdout: [
            entryLine,
            ...steps,
            "reason failed step=stop check=stop-writers status=1",
            "reason fence writers=unconfirmed",
            "result needs-owner",
          ],
          exit: 1,
        });
        expect(result.stdout).toContain(
          "::error::Likely cause: the running bot couldn't be confirmed stopped. The host stopped after the writer boundary and kept its pending marker; reconcile on the host before any new delivery. The entry couldn't confirm that every writer stopped: check the host now.",
        );
      });

      for (const [code, cause] of [
        ["lock-held", "another delivery or the scheduled backup held the host lock."],
        [
          "pending-present",
          "an earlier delivery's pending marker is still on the host; reconcile and clear it first.",
        ],
        ["downgrade", "the requested version is older than the one running."],
        ["target-mismatch", "the host's delivery key is bound to the other target."],
      ] as const) {
        test(`a ${code} refusal is summarised in plain words`, () => {
          const result = run({
            stdout: [
              entryLine,
              "step preflight",
              `reason refused step=preflight code=${code}`,
              "result refused",
            ],
            exit: 1,
          });
          expect(result.stdout).toContain(
            `::error::Likely cause: ${cause} The host refused this delivery`,
          );
        });
      }

      test("an unrecognised reason set keeps the plain result sentence", () => {
        const result = run({
          stdout: [
            entryLine,
            "step preflight",
            "reason failed step=preflight check=unlabelled status=1",
            "result refused",
          ],
          exit: 1,
        });
        expect(result.stdout).toContain(
          "::error::The host refused this delivery before stopping the writer, so nothing changed.",
        );
      });

      test("a key inside quoted text never stands in for the bare value", () => {
        const result = run({
          stdout: [
            entryLine,
            ...allSteps.slice(0, 6),
            "reason failed step=migrate check=migrate status=1",
            'reason bot-error msg="query failed code=<redacted>" code=28P01',
            'reason bot-error msg="startup code=EVIL check=readiness" type=Error',
            "result needs-owner",
          ],
          exit: 1,
        });
        expect(result.stdout).toContain(
          "::error::Likely cause: the database migration failed (code 28P01). The host stopped",
        );
        expect(result.stdout).not.toMatch(/::error::.*(EVIL|<redacted>|readiness)/u);
      });

      test("a bare value that doesn't fit its key's pattern reads as empty", () => {
        const cause = (reasons: string[], result = "result needs-owner") =>
          run({ stdout: [entryLine, ...allSteps, ...reasons, result], exit: 1 }).lines.find(
            (line) => line.startsWith("::error::"),
          );
        expect(
          cause(["reason failed step=observe check=health status=1 health=un-healthy"]),
        ).toContain("Likely cause: Docker's health check failed. The host");
        expect(
          cause([
            "reason failed step=observe check=not-running status=1",
            "reason container exit=99999 oom=maybe restarts=0 health=healthy running=false uptime=1",
          ]),
        ).toContain(
          "Likely cause: the bot container exited with code unknown (out of memory: no).",
        );
        expect(
          cause(
            [
              "reason entry syntax=invalid line=1234567",
              "reason refused step=preflight code=entry-syntax",
            ],
            "result refused",
          ),
        ).toContain("doesn't parse (a bash syntax error), so");
        expect(
          cause(["reason failed step=backup check=backup status=1", "reason backup stage=UPLOAD"]),
        ).toContain("Likely cause: the pre-migration backup failed; nothing was migrated.");
        expect(
          cause(["reason failed step=observe check=readiness status=143 signal=KILL"]),
        ).toContain("Likely cause: the new release didn't stay ready.");
        expect(cause(["reason refused step=preflight code=Lock_Held"], "result refused")).toContain(
          "::error::The host refused this delivery",
        );
      });

      test("a letter outside ASCII never passes, whatever the locale", () => {
        const result = run({
          stdout: [
            entryLine,
            "step preflight",
            "reason fine key=é",
            "reason fïne key=value",
            'reason fine msg="café"',
            "result refused",
          ],
          exit: 1,
        });
        // Only the entry's own hash survives, and alone it prints no diagnostics block.
        expect(result.lines.filter((line) => line.startsWith("  reason "))).toEqual([]);
        expect(result.stdout).not.toContain("Host diagnostics");
        expect(result.stdout).toContain(
          `The host reports its deploy entry's sha256 as ${entrySha}, the same`,
        );
      });

      test("malformed, hostile or surplus reason lines are dropped, never repaired", () => {
        const hostile = [
          'reason bot-error msg="::set-output name=leak::value"',
          'reason bot-error msg="::add-mask::"',
          "reason failed check=a::b",
          'reason failed msg="100%0A::error::injected"',
          'reason bot-error msg="has \\"quote"',
          'reason bot-error msg="##[group]grouped"',
          'reason bot-error msg="`backticks`"',
          'reason bot-error msg="officer@example.org"',
          "reason  doubled-space",
          `reason long key=${"a".repeat(65)}`,
          `reason long msg="${"x".repeat(161)}"`,
          "reason ünïcödé key=value",
          "reason fine key=value\r",
          "reason fine key=$(id)",
          "::error::raw-injected",
          "##[error]raw-legacy",
          "REASON upper key=value",
        ];
        const surplus = Array.from({ length: 25 }, (_, index) => `reason extra index=${index}`);
        const result = run({
          stdout: [entryLine, "step preflight", ...hostile, ...surplus, "result refused"],
          exit: 1,
        });
        for (const text of [
          "leak",
          "add-mask",
          "a::b",
          "injected",
          "quote",
          "grouped",
          "backticks",
          "@",
          "doubled",
          "a".repeat(65),
          "x".repeat(161),
          "ünïcödé",
          "$(id)",
          "raw-",
          "REASON",
        ])
          expect(result.stdout).not.toContain(text);
        const relayed = result.lines.filter((line) => line.startsWith("  reason "));
        // The entry line counts toward the cap of 20.
        expect(relayed).toEqual([
          `  ${entryLine}`,
          ...surplus.slice(0, 19).map((line) => `  ${line}`),
        ]);
      });
    });
  });
}
