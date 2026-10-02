/** The official pinned OVH SDK owns API signing/time synchronization. No bespoke SigV4/OAuth. */
import { createRequire } from "node:module";

export interface OvhCredentials {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
}
interface OvhClient {
  requestPromised(method: "GET", path: string): Promise<unknown>;
}
export type OvhClientFactory = (
  options: OvhCredentials & {
    endpoint: "ovh-us";
    timeout: number;
    debug: false;
    warn: () => void;
  },
) => OvhClient;

/** Fix routing and suppress SDK diagnostics: upstream errors may quote paths or credentials. */
export async function readOvhInstance(
  projectId: string,
  instanceId: string,
  credentials: OvhCredentials,
  createClient: OvhClientFactory = createRequire(import.meta.url)(
    "@ovhcloud/node-ovh",
  ) as OvhClientFactory,
): Promise<unknown> {
  try {
    if (
      !/^[0-9a-f]{32}$/u.test(projectId) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(instanceId) ||
      Object.keys(credentials).sort().join(",") !==
        "applicationKey,applicationSecret,consumerKey" ||
      Object.values(credentials).some(
        (value) => typeof value !== "string" || !/^[!-~]+$/u.test(value),
      )
    )
      throw new Error();
    return await createClient({
      ...credentials,
      endpoint: "ovh-us",
      timeout: 15_000,
      debug: false,
      warn: () => {},
    }).requestPromised("GET", `/cloud/project/${projectId}/instance/${instanceId}`);
  } catch {
    throw new Error("host-enrollment-failed");
  }
}
