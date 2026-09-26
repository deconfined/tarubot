/**
 * The documentation site (site/, Starlight on GitHub Pages) against the code it describes. The
 * site's own build checks its frontmatter and internal links; this test is the required gate for
 * what a build can't know: the hand-written command reference, settings, reply codes and bot
 * permissions must match the code, repository links must resolve, the site package must stay a
 * pnpm package, and the public pages must carry placeholders only, with no Discord invite or
 * authorization URL (each deployment builds its own for its own application).
 *
 * Site files are read as text and never imported, so neither CI's checks job nor the image build
 * needs the site's dependencies. Paths resolve against the working tree with existsSync, because
 * the Docker build context has no .git. The scan uses explicit roots, never site/**, so it never
 * walks site/node_modules or reads site/pnpm-lock.yaml (whose integrity hashes look like tokens).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ApplicationCommandOptionType, PermissionFlagsBits } from "discord.js";
import { loadCommands } from "../../src/bot/discovery.js";
import {
  commandPaths,
  inventoryDiff,
  requiredBotPermissions,
} from "../../src/discord/inspection.js";
import { EXAMPLES } from "../../src/discord/presenters/failure.js";
import { FAILURE_CATEGORY } from "../../src/domain/failures.js";

/** A repository path, resolved relative to this test (the same helper as deployment.test.ts). */
const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
/** Read a repository file as text. */
const read = (path: string) => Bun.file(root(path)).text();
/** The Markdown page for a site path such as "reference/commands". */
const page = (slug: string) => read(`site/src/content/docs/${slug}.md`);

/**
 * Every command-reference section: the path of each "### /path" heading, with the text up to the
 * next "##" or "###" heading. Headings inside fenced code blocks don't count.
 */
function commandSections(markdown: string): { path: string; text: string }[] {
  const sections: { path: string; text: string }[] = [];
  let current: { path: string; lines: string[] } | null = null;
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = fenced ? null : /^(#{2,3}) (.+)$/u.exec(line);
    if (heading) {
      if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
      const title = heading[2] ?? "";
      current =
        heading[1] === "###" && title.startsWith("/") ? { path: title.slice(1), lines: [] } : null;
      continue;
    }
    current?.lines.push(line);
  }
  if (current) sections.push({ path: current.path, text: current.lines.join("\n") });
  return sections;
}

/** A registered option a user types or picks: its command path without the slash, and its name. */
interface OptionRow {
  readonly path: string;
  readonly name: string;
}

/** Walk subcommand groups and subcommands down to their options (as failure-reply.test.ts does). */
const optionsOf = (
  path: string[],
  options: readonly { type: number; name: string; options?: unknown }[] | undefined,
): OptionRow[] =>
  (options ?? []).flatMap((option) =>
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
      ? optionsOf(
          [...path, option.name],
          option.options as readonly { type: number; name: string }[] | undefined,
        )
      : [{ path: path.join(" "), name: option.name }],
  );

/**
 * The files the site publishes or builds from, as repository paths: everything under site/src and
 * site/public, plus the site's config and package files. Never site/node_modules, site/dist or the
 * lockfile.
 */
async function siteFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const pattern of ["src/**/*", "public/**/*"])
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root("site") }))
      files.push(`site/${path}`);
  for (const path of ["site/astro.config.mjs", "site/package.json", "site/pnpm-workspace.yaml"])
    if (existsSync(root(path))) files.push(path);
  return files.sort();
}

/**
 * The name add-to-server.md's Permissions table gives each of the code's bot permissions (Discord's
 * name for it). Typed by the code's keys, so a permission added to requiredBotPermissions fails the
 * typecheck until it has a name here, and then the test below until the page lists it.
 */
const permissionNames: { readonly [key in keyof typeof requiredBotPermissions]: string } = {
  ManageRoles: "Manage Roles",
  ManageNicknames: "Manage Nicknames",
  ViewChannel: "View Channel",
  SendMessages: "Send Messages",
  EmbedLinks: "Embed Links",
  AttachFiles: "Attach Files",
  ReadMessageHistory: "Read Message History",
};

/** The permission names in the first column of a page's "## Permissions" table, in page order. */
function permissionRows(markdown: string): string[] {
  const section = markdown.split(/^## /mu).find((part) => part.startsWith("Permissions\n")) ?? "";
  return [...section.matchAll(/^\| \*\*([^*|]+)\*\* \|/gmu)].map((match) => match[1] ?? "");
}

/** A pattern that must never appear on a public page, what it guards, and samples it must catch. */
interface Guard {
  readonly pattern: RegExp;
  readonly what: string;
  readonly bad: readonly string[];
}

/**
 * No invite template: each deployment runs its own application, and its owner builds the link
 * (add-to-server.md). Any authorization path counts, on either domain and API version. Kept apart
 * from the other guards because the README, public but not a site page, is held to these too.
 * Their host patterns end in `(?:$|.)` for the reason given in `forbidden` below.
 */
const inviteGuards: readonly Guard[] = [
  {
    pattern: /discord(?:app)?\.com\/(?:api\/(?:v\d+\/)?)?oauth2\/authorize(?:$|.)/imu,
    what: "a Discord authorization (bot invite) URL",
    bad: [
      "https://discord.com/oauth2/authorize?client_id=YOUR_APPLICATION_ID&scope=bot",
      "https://discord.com/api/oauth2/authorize?client_id=1&scope=bot",
      "https://discord.com/api/v10/oauth2/authorize?client_id=1",
      "https://canary.discord.com/oauth2/authorize?client_id=1",
      "https://discordapp.com/oauth2/authorize?client_id=1",
      "DISCORD.COM/OAUTH2/AUTHORIZE",
      "discord.com/oauth2/authorize",
    ],
  },
  {
    pattern: /discordapp\.com(?:$|.)/imu,
    what: "Discord's former domain (old invite, authorization or file links)",
    bad: [
      "https://discordapp.com/invite/abc",
      "discordapp.com",
      "cdn.discordapp.com/attachments/1",
    ],
  },
  {
    pattern: /discord\.gg\/(?:$|.)|discord\.com\/invite\/(?:$|.)/imu,
    what: "a Discord server invite link",
    bad: [
      "https://discord.gg/abc",
      "discord.gg/",
      "https://discord.com/invite/abc",
      "DISCORD.GG/X",
    ],
  },
];

/**
 * The fixed patterns. Samples shaped like secrets are built at run time with repeat(), so this file
 * never holds a literal that a secret scanner would take for a real token or key.
 */
const forbidden: readonly Guard[] = [
  {
    pattern: /hc-ping\.com\/(?!<)/iu,
    what: "a heartbeat ping URL (only hc-ping.com/<your-check-uuid>)",
    bad: ["https://hc-ping.com/0000", "hc-ping.com/abc"],
  },
  // Host patterns end in `(?:$|.)`, which matches whatever follows (the same text a bare pattern
  // matches, with the multiline flag). The `$` anchor keeps CodeQL's js/regex/missing-regexp-anchor
  // query, which flags an unanchored pattern holding `\.com`, from reading these as URL checks.
  {
    pattern: /discord\.com\/channels\/(?:$|.)/imu,
    what: "a Discord message or channel link",
    bad: ["https://discord.com/channels/1/2/3", "discord.com/channels/"],
  },
  {
    pattern: /deconfined\.com(?:$|.)/imu,
    what: "a host under the upstream operator's domain",
    // The pattern ignores what comes before the domain, so the samples use the bare domain and
    // cover every subdomain too. A period or hyphen after it (the end of a sentence, a DNS record)
    // must not let it through.
    bad: [
      "ssh to deconfined.com.",
      "deconfined.com. IN SSHFP 4 2 0",
      "see deconfined.com.\nnext",
      "deconfined.com-old",
      "host deconfined.com",
      "`tarubot@deconfined.com`",
      "https://deconfined.com/health",
    ],
  },
  {
    pattern: /linodeobjects/iu,
    what: "the upstream backup bucket's endpoint",
    bad: ["x.linodeobjects.com"],
  },
  { pattern: /us-iad/iu, what: "the upstream instance's region", bad: ["us-iad"] },
  { pattern: /tarubot-pg/iu, what: "an upstream database cluster name", bad: ["tarubot-pgsql"] },
  {
    pattern: /akmadmin|doadmin/iu,
    what: "a managed database admin login",
    bad: ["akmadmin", "doadmin"],
  },
  {
    pattern: /tarubot-cutover/iu,
    what: "the upstream operator's working directory",
    bad: ["~/tarubot-cutover/production.env"],
  },
  {
    pattern: /tarubot-backups\b|tarubot-backup-key|tarubot-backup\.log/iu,
    what: "upstream backup names",
    bad: ["tarubot-backups", "tarubot-backup-key", "tarubot-backup.log"],
  },
  {
    pattern: /\b2752[01]\b/u,
    what: "the upstream database's ports",
    bad: ["port 27520", ":27521"],
  },
  {
    pattern: /\bage1[0-9a-z]{20,}/u,
    what: "an age recipient key",
    bad: [`age1${"q".repeat(58)}`],
  },
  {
    pattern: /AGE-SECRET-KEY-1/u,
    what: "an age secret key",
    bad: [`AGE-SECRET-KEY-1${"Q".repeat(58)}`],
  },
  {
    pattern: /TaruBot (?:production|backups)\b/u,
    what: "an upstream healthchecks check name",
    bad: ["TaruBot production", "TaruBot backups"],
  },
  { pattern: /04:30 UTC/u, what: "the upstream backup schedule", bad: ["daily at 04:30 UTC"] },
  ...inviteGuards,
  {
    pattern: /Woven Souls|«Souls»|Fussy Bunbun/iu,
    what: "the upstream FC's name, tag or rank title",
    bad: ["Woven Souls", "«Souls»", "Fussy Bunbun"],
  },
  // Case-sensitive: the pages may name the lowercase `env:devbot` issue label, never the upstream
  // development deployment, its test server or the upstream settings-copy files.
  {
    pattern: /\bDevBot\b|TaruBot Development|tarubot-env-/u,
    what: "the upstream development deployment or settings copies",
    bad: ["on DevBot", "TaruBot Development", "tarubot-env-20260101.age"],
  },
  // Token shapes, as src/domain/reports.ts redacts them.
  {
    pattern: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/u,
    what: "a Discord token",
    bad: [`M${"A".repeat(25)}.${"B".repeat(6)}.${"C".repeat(30)}`],
  },
  {
    pattern: /\bgithub_pat_[A-Za-z\d_]{20,}\b/u,
    what: "a GitHub token",
    bad: [`github_pat_${"A".repeat(22)}`],
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z\d]{20,}\b/u,
    what: "a GitHub token",
    bad: [`ghp_${"A".repeat(36)}`],
  },
];

/**
 * Every run of seven or more digits a page may carry: the documented placeholders and constants.
 * Anything else that long could be a real Discord snowflake (17 to 20 digits), FC ID (19) or
 * character ID (up to 9), whatever surrounds it.
 */
const allowedNumbers = new Set([
  "123456789012345678", // the placeholder snowflake (EXAMPLES)
  "9230000000000000001", // the placeholder FC ID
  "99000001", // the placeholder character ID
  "10005000", // the ledger examples' gil amounts
  "2500000",
  "2000000", // LODESTONE_BODY_BYTES's default
  "20260101", // the date in the example backup file name
  "714882490", // the advisory lock keys (src/infrastructure/postgres/database.ts)
  "714882491",
  "714882492",
  "714882494",
]);
/** The only UUIDs a page may carry: the failure replies' job-ID examples (EXAMPLES). */
const allowedUuids = new Set([
  "3f2b8c1e-5d4a-4b3c-9e2f-1a0b9c8d7e6f",
  "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a",
]);
/** Components the bot no longer has; only the design record may name them. */
const retired = /nodestone|sidecar|app platform|PAGE_REGION/iu;
const record = "site/src/content/docs/architecture/decisions.md";

/** Everything on one public file that must not be there, each as "file: what". */
function publicProblems(file: string, text: string): string[] {
  const problems: string[] = [];
  for (const { pattern, what } of forbidden)
    if (pattern.test(text)) problems.push(`${file}: ${what}`);
  // Digit lookarounds, not \b, so an ID glued to a letter or `_` (guild_<id>) still counts.
  for (const match of text.matchAll(/(?<!\d)\d{7,}(?!\d)/gu))
    if (!allowedNumbers.has(match[0])) problems.push(`${file}: the number ${match[0]}`);
  // Character IDs can be shorter than seven digits, so their usual forms count at any length.
  for (const pattern of [/lodestone\/character\/(\d+)/giu, /\bcharacter(?:_id)?\s*[:=]\s*(\d+)/giu])
    for (const match of text.matchAll(pattern))
      if (match[1] !== "99000001") problems.push(`${file}: character ${match[1]}`);
  for (const match of text.matchAll(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu,
  ))
    if (!allowedUuids.has(match[0].toLowerCase())) problems.push(`${file}: the UUID ${match[0]}`);
  if (file !== record && retired.test(text)) problems.push(`${file}: a retired component`);
  return problems;
}

/** Known-bad text for the rules beyond the fixed patterns; each must produce a problem. */
const otherBadSamples = [
  "guild_123456789012345679", // a snowflake glued to `_`
  "the deleted 12345678", // an eight-digit character ID in prose
  "Name (`1234567`)",
  "fc 9230000000000000002",
  "https://na.finalfantasyxiv.com/lodestone/character/123456/",
  "character: 4242",
  "character_id=4242",
  "00000000-0000-4000-8000-000000000000", // a bare healthchecks-style UUID
  "the Nodestone sidecar",
];
/** The placeholders the pages use; none may produce a problem. */
const allowedSamples = [
  "hc-ping.com/<your-check-uuid>",
  "https://deconfined.github.io/tarubot/",
  "https://github.com/deconfined/tarubot",
  "env:devbot",
  "character:99000001",
  "/lodestone/character/99000001/",
  "<@123456789012345678>",
  "3F2B8C1E-5D4A-4B3C-9E2F-1A0B9C8D7E6F",
  "https://discord.com/developers/applications", // the Developer Portal link
  "`discord·gg`, `discord.gg∕x`", // the look-alike separators monitoring.md names
  "backups/tarubot-20260101T000000Z.dump",
];

describe("the command reference matches the registered commands", () => {
  test("one '### /path' section per invocable command path, and no others", async () => {
    const commands = [...(await loadCommands()).values()];
    const declared = commands.flatMap((command) =>
      commandPaths(command.name, command.toJSON().options),
    );
    const documented = commandSections(await page("reference/commands")).map(
      (section) => section.path,
    );
    expect(declared.length).toBeGreaterThan(40);
    // Each path is documented exactly once.
    expect(new Set(documented).size).toBe(documented.length);
    expect(inventoryDiff(declared, documented)).toEqual({ missing: [], unexpected: [] });
  });

  test("each section names every option of its path and says who can use it", async () => {
    const sections = new Map(
      commandSections(await page("reference/commands")).map((section) => [
        section.path,
        section.text,
      ]),
    );
    const rows = [...(await loadCommands()).values()].flatMap((command) =>
      optionsOf([command.name], command.toJSON().options),
    );
    expect(rows.length).toBeGreaterThan(50);
    const missing = rows.filter((row) => !sections.get(row.path)?.includes(`\`${row.name}\``));
    expect(missing).toEqual([]);
    const withoutAccess = [...sections].filter(([, text]) => !text.includes("**Who can use it:**"));
    expect(withoutAccess.map(([path]) => path)).toEqual([]);
  });

  test("each section shows every example the failure replies use, verbatim", async () => {
    const sections = new Map(
      commandSections(await page("reference/commands")).map((section) => [
        section.path,
        section.text,
      ]),
    );
    const missing = Object.entries(EXAMPLES).flatMap(([path, examples]) =>
      examples
        .filter((example) => !sections.get(path)?.includes(example))
        .map((example) => ({ path, example })),
    );
    expect(missing).toEqual([]);
  });
});

describe("the reference pages cover the code's settings, codes and permissions", () => {
  test("the configuration page documents every .env.example setting", async () => {
    const keys = [...(await read(".env.example")).matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map(
      (match) => match[1] ?? "",
    );
    expect(keys.length).toBeGreaterThan(20);
    const configuration = await page("deploy/configuration");
    expect(keys.filter((key) => !configuration.includes(`\`${key}\``))).toEqual([]);
  });

  test("the replies page lists every failure code a member can see, and unexpected", async () => {
    const codes = [
      ...Object.entries(FAILURE_CATEGORY)
        .filter(([, category]) => category !== "unexpected")
        .map(([code]) => code),
      "unexpected",
    ];
    const replies = await page("reference/replies");
    expect(codes.filter((code) => !replies.includes(`\`${code}\``))).toEqual([]);
  });

  test("add-to-server lists exactly the code's bot permissions plus Manage Channels", async () => {
    // Manage Channels is the /setup onboarding addition, not part of the launch set.
    expect(Object.values(requiredBotPermissions)).not.toContain(PermissionFlagsBits.ManageChannels);
    const listed = permissionRows(await page("admin/add-to-server"));
    const expected = [...Object.values(permissionNames), "Manage Channels"];
    // Each once, none missing and none extra, so the table can't drift from the code either way.
    expect([...listed].sort()).toEqual([...expected].sort());
  });

  test("add-to-server keeps what an owner adds the bot with, now that it has no link", async () => {
    // #54 dropped the invite template; the page must still name the scopes, the privileged intent,
    // the permission whoever adds the bot needs, and the Public Bot recommendation.
    const text = await page("admin/add-to-server");
    const needed = [
      "`bot`",
      "`applications.commands`",
      "**Server Members Intent**",
      "**Manage Server**",
      "**Public Bot**",
    ];
    expect(needed.filter((phrase) => !text.includes(phrase))).toEqual([]);
  });
});

describe("the site package", () => {
  test("is a pnpm package without its own SemVer, beside a Bun root", async () => {
    const manifest = JSON.parse(await read("site/package.json")) as Record<string, unknown>;
    // The root package.json is the only SemVer; the site is never released on its own.
    expect(manifest).not.toHaveProperty("version");
    expect(String(manifest.packageManager)).toStartWith("pnpm@");
    expect(existsSync(root("site/pnpm-lock.yaml"))).toBe(true);
    for (const stray of [
      "site/bun.lock",
      "site/bun.lockb",
      "site/package-lock.json",
      "site/yarn.lock",
    ])
      expect(existsSync(root(stray))).toBe(false);
    // The bot stays on Bun: no pnpm lockfile at the repository root.
    expect(existsSync(root("pnpm-lock.yaml"))).toBe(false);
  });
});

describe("the site's links and public content", () => {
  test("every GitHub blob/tree link on main names a file or directory that exists", async () => {
    const files = await siteFiles();
    expect(files).toContain("site/src/content/docs/reference/commands.md");
    const broken: string[] = [];
    for (const file of files)
      for (const match of (await read(file)).matchAll(
        /https:\/\/github\.com\/deconfined\/tarubot\/(?:blob|tree)\/main\/([^\s)#"'`<>]+)/gu,
      ))
        if (!existsSync(root(match[1] ?? ""))) broken.push(`${file}: ${match[1]}`);
    expect(broken).toEqual([]);
  });

  test("pages carry placeholders only: no real IDs, private hosts, secrets or retired names", async () => {
    const problems: string[] = [];
    for (const file of await siteFiles()) problems.push(...publicProblems(file, await read(file)));
    expect(problems).toEqual([]);
  });

  test("the README carries no Discord invite or authorization URL either", async () => {
    // The README is public too, and its "Run a server" line points at add-to-server.
    const readme = await read("README.md");
    expect(
      inviteGuards.filter(({ pattern }) => pattern.test(readme)).map(({ what }) => what),
    ).toEqual([]);
  });

  test("every public-content guard catches its known-bad samples", () => {
    // A later edit can't narrow a guard without failing here: each pattern must still match every
    // sample of what it guards, including the forms that slipped past earlier versions.
    const narrowed = forbidden.flatMap(({ pattern, what, bad }) =>
      bad.filter((sample) => !pattern.test(sample)).map((sample) => `${what}: ${sample}`),
    );
    expect(narrowed).toEqual([]);
    // The rules beyond the fixed patterns: long numbers, character IDs, UUIDs, retired names.
    const missed = [...forbidden.flatMap(({ bad }) => bad), ...otherBadSamples].filter(
      (sample) => publicProblems("sample", sample).length === 0,
    );
    expect(missed).toEqual([]);
    // The placeholders the pages use must pass.
    expect(publicProblems("placeholders", allowedSamples.join("\n"))).toEqual([]);
  });
});
