export {};
// Resolve the real host manifests with Bun's YAML/dotenv parsers; no Docker or I/O to services.
const file = process.argv[2];
if (!file) throw new Error("Missing manifest argument");
const manifest = Bun.YAML.parse(await Bun.file(file).text());
function resolve(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(
      /\$\$|\$\{([A-Z_][A-Z_0-9]*)(?:(:\?|:-)([^}]*))?\}/gu,
      (match, key, operator, fallback) => {
        if (match === "$$") return "$";
        const setting = process.env[key];
        if (setting) return setting;
        if (operator === ":?") throw new Error(`Missing ${key}`);
        return operator === ":-" ? fallback : (setting ?? "");
      },
    );
  if (Array.isArray(value)) return value.map(resolve);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, setting]) => [key, resolve(setting)]),
    );
  return value;
}
const activeProfiles = new Set(process.argv.slice(3));
const config = resolve(manifest) as {
  services: Record<string, { profiles?: string[] }>;
};
// Match native Compose: inactive services must not make validation pass only in tests.
for (const [name, service] of Object.entries(config.services))
  if (service.profiles?.length && !service.profiles.some((profile) => activeProfiles.has(profile)))
    delete config.services[name];
console.log(JSON.stringify(config));
