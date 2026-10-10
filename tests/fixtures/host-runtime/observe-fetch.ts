/**
 * Preloaded into the fake container's observation probe (tests/fixtures/host-runtime/docker): the
 * bot's /health/ready answer comes from the invented scenario in $SIM/observe.json, never a socket.
 */
import { scenario } from "./observe-scenario.js";

const healthy = { live: true, ready: true, database: true, writerLease: true, discord: true };
globalThis.fetch = Object.assign(
  async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== "http://localhost:3000/health/ready") throw new Error(`Unexpected fetch ${url}`);
    if (scenario.fetchError)
      throw Object.assign(new Error(scenario.fetchError.message), {
        code: scenario.fetchError.code,
      });
    const readiness = scenario.readiness ?? { status: 200, body: healthy };
    return new Response(JSON.stringify(readiness.body), { status: readiness.status });
  },
  { preconnect: globalThis.fetch.preconnect },
) as typeof fetch;
