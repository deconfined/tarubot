/** Pure route refusals and native one-use proof boundaries never touch a runner endpoint. */
import { afterAll, describe, expect, test } from "bun:test";
import {
  createTargetIssuanceMinter,
  targetIssuanceRequestUrl,
} from "../../scripts/target-issuance-mint.js";
import {
  assertCurrentTargetIssuerProof,
  reserveCurrentTargetIssuerMint,
  type CurrentTargetIssuerProof,
} from "../../scripts/target-issuer-run.js";
import type { TargetPublicationMintDestination } from "../../scripts/target-publication-v2.js";
import type { ContentReceiptV2 } from "../../scripts/target-issuance.js";
import { cleanupLiveIssuerFixtures, liveIssuerFixture } from "./target-issuer-run.test.js";
afterAll(cleanupLiveIssuerFixtures);
const audience = `urn:tarubot:applied-target-issuance:v2:${"a".repeat(64)}`;
const configuration = {
  request_url: "https://oidc.example.actions.githubusercontent.com/token?api-version=2.0",
  request_token: "opaque-runtime-bearer+/:=",
  subject: "repo:deconfined/tarubot:environment:target-seal",
};
describe("owned target issuance mint", () => {
  test("hosted runtime route remains opaque and adds exactly one encoded frozen audience", () => {
    const result = targetIssuanceRequestUrl(configuration.request_url, audience),
      url = new URL(result);
    expect(url.hostname).toBe("oidc.example.actions.githubusercontent.com");
    expect(url.pathname).toBe("/token");
    expect(url.searchParams.get("api-version")).toBe("2.0");
    expect(url.searchParams.getAll("audience")).toEqual([audience]);
    expect(result.endsWith(encodeURIComponent(audience))).toBe(true);
    expect(
      new URL(
        targetIssuanceRequestUrl("https://oidc.actions.githubusercontent.com:443/token", audience),
      ).searchParams.get("audience"),
    ).toBe(audience);
  });
  test("unsupported origins, routes, duplicate audience/query and ambiguous encodings refuse", () => {
    for (const url of [
      "http://oidc.example.actions.githubusercontent.com/token",
      "https://actions.githubusercontent.com/token",
      "https://oidc.actions.githubusercontent.com.example.org/token",
      "https://example.org/token",
      "https://user@oidc.actions.githubusercontent.com/token",
      "https://oidc.actions.githubusercontent.com:444/token",
      "https://oidc.actions.githubusercontent.com/token#fragment",
      "https://oidc.actions.githubusercontent.com/token?audience=x",
      "https://oidc.actions.githubusercontent.com/token?Audience=x",
      "https://oidc.actions.githubusercontent.com/token?a=1&a=2",
      "https://oidc.actions.githubusercontent.com/token?a=%41",
      "https://oidc.actions.githubusercontent.com/token?a=x+y",
      "https://oidc.actions.githubusercontent.com/a%2fb",
      "https://oidc.actions.githubusercontent.com/token?a=1&&b=2",
      "https://oidc.actions.githubusercontent.com/token?a=1&",
      "https://xn--fake.actions.githubusercontent.com/token",
      "https://oidc.actions.githubusercontent.com/token?a=%00",
      "https://oidc.actions.githubusercontent.com/token?",
      "https://oidc.actions.githubusercontent.com/%ZZ",
      "https://oidc.actions.githubusercontent.com/%41",
      "https://oidc.actions.githubusercontent.com/a%3fb",
      "https://oidc.actions.githubusercontent.com/a%3Fb",
    ])
      expect(() => targetIssuanceRequestUrl(url, audience)).toThrow("invalid-target-issuance-mint");
  });
  test("JSON proof or caller-paired preparation cannot offer a mint GET", async () => {
    let offers = 0;
    const minter = createTargetIssuanceMinter(configuration, {
      get: async () => {
        offers++;
        throw new Error("private-runtime-token");
      },
    });
    await expect(
      minter.mint(
        {} as CurrentTargetIssuerProof,
        {} as ContentReceiptV2,
        {} as TargetPublicationMintDestination,
      ),
    ).rejects.toThrow("invalid-target-issuance-mint");
    expect(offers).toBe(0);
  });
  test("one native current capability cannot mint through another factory after refused use", async () => {
    const f = await liveIssuerFixture(),
      proof = await f.read(f.request);
    let offers = 0;
    for (let attempt = 0; attempt < 2; attempt++) {
      const minter = createTargetIssuanceMinter(configuration, {
        now: () => f.clock.now,
        get: async () => {
          offers++;
          throw new Error("private-runtime-token");
        },
      });
      await expect(
        minter.mint(proof, {} as ContentReceiptV2, {} as TargetPublicationMintDestination),
      ).rejects.toThrow("invalid-target-issuance-mint");
    }
    expect(offers).toBe(0);
    expect(() => assertCurrentTargetIssuerProof(proof)).toThrow("invalid-target-issuer-run");
  });
  test("swallowed nested wrong/correct mint refusals fence the original native proof", async () => {
    for (const wrong of [false, true]) {
      const f = await liveIssuerFixture(),
        proof = await f.read(f.request);
      let nested = false,
        offers = 0;
      const config = new Proxy(configuration, {
        ownKeys(target) {
          if (!nested) {
            nested = true;
            void minter
              .mint(
                wrong ? ({} as CurrentTargetIssuerProof) : proof,
                {} as ContentReceiptV2,
                {} as TargetPublicationMintDestination,
              )
              .catch(() => {});
          }
          return Reflect.ownKeys(target);
        },
      });
      const minter = createTargetIssuanceMinter(config, {
        now: () => f.clock.now,
        get: async () => {
          offers++;
          throw new Error("private-mint");
        },
      });
      await expect(
        minter.mint(proof, {} as ContentReceiptV2, {} as TargetPublicationMintDestination),
      ).rejects.toThrow("invalid-target-issuance-mint");
      expect(nested).toBe(true);
      expect(offers).toBe(0);
      expect(() => assertCurrentTargetIssuerProof(proof)).toThrow("invalid-target-issuer-run");
    }
  });
  test("repeat native reservation permanently fences the first outstanding use", async () => {
    const f = await liveIssuerFixture(),
      proof = await f.read(f.request);
    reserveCurrentTargetIssuerMint(proof);
    expect(() => reserveCurrentTargetIssuerMint(proof)).toThrow("invalid-target-issuer-run");
    expect(() => assertCurrentTargetIssuerProof(proof)).toThrow("invalid-target-issuer-run");
  });
});
