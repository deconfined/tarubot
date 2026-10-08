import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

// Model the native Compose include/profile rules using the real YAML/dotenv parsers.
// No Docker or network I/O; config resolution itself must not fake guard success.
const [file, projectDirectory, ...explicitProfiles] = process.argv.slice(2);
if (!file || !projectDirectory) throw new Error("Missing manifest/project arguments");
function interpolate(value: unknown): unknown {
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
  if (Array.isArray(value)) return value.map(interpolate);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, setting]) => [key, interpolate(setting)]),
    );
  return value;
}
interface Service {
  profiles?: string[];
  volumes?: (string | { type: string; source: string; target: string })[];
}
interface Model {
  include?: string[];
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}
async function load(path: string, base: string): Promise<Model> {
  const config = interpolate(Bun.YAML.parse(await Bun.file(path).text())) as Model;
  for (const service of Object.values(config.services)) {
    if (!service.volumes) continue;
    service.volumes = service.volumes.map((mount) => {
      if (typeof mount !== "string") {
        if (mount.type === "bind" && !isAbsolute(mount.source))
          mount.source = resolvePath(base, mount.source);
        return mount;
      }
      if (mount.startsWith("./") || mount.startsWith("../")) {
        const [source, ...rest] = mount.split(":");
        if (!source) throw new Error("Missing bind source");
        return `${resolvePath(base, source)}:${rest.join(":")}`;
      }
      return mount;
    });
  }
  for (const include of config.include ?? []) {
    const includedPath = resolvePath(base, include);
    const included = await load(includedPath, dirname(includedPath));
    for (const [name, service] of Object.entries(included.services)) {
      if (config.services[name]) throw new Error(`Conflicting included service ${name}`);
      config.services[name] = service;
    }
    config.volumes = { ...config.volumes, ...included.volumes };
  }
  delete config.include;
  return config;
}
// Explicit --profile replaces COMPOSE_PROFILES, including dotenv-selected web.
const activeProfiles = new Set(
  explicitProfiles.length ? explicitProfiles : (process.env.COMPOSE_PROFILES ?? "").split(","),
);
const config = await load(file, projectDirectory);
for (const [name, service] of Object.entries(config.services))
  if (service.profiles?.length && !service.profiles.some((profile) => activeProfiles.has(profile)))
    delete config.services[name];
console.log(JSON.stringify(config));
