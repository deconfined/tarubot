/** Inactive private-file-only composition. Candidate AEAD and public execution evidence require
 * the reviewed protected producer origin and serialized owner provisioned prefix policy; neither
 * proves private authorship by itself. No token, hash, store or publication handle is returned. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { releaseIdentity, type ReleaseIdentity } from "./release-policy.js";
import {
  openEncryptedTargetCandidate,
  targetCandidateFileName,
  type TargetCandidateContext,
} from "./target-candidate.js";
import {
  assertCurrentTargetIssuerProof,
  createCurrentTargetIssuerReader,
  fenceCurrentTargetIssuerProof,
  type CurrentReader,
  type CurrentTargetIssuerConfiguration,
  type CurrentTargetIssuerProof,
  withinCurrentTargetIssuerProof,
} from "./target-issuer-run.js";
import {
  createTargetIssuanceMinter,
  type TargetIssuanceMintConfiguration,
  type TargetMintReader,
} from "./target-issuance-mint.js";
import {
  createTargetContentV2Producer,
  type TargetContentV2Producer,
  type TargetContentV2Publication,
  type TargetContentV2StorageConfiguration,
} from "./target-storage-v2.js";
import {
  captureTargetIssuance,
  targetIssuancePins,
  type ContentReceiptV2,
  type TargetIssuanceStatementV2,
} from "./target-issuance.js";
const nativeThen = Promise.prototype.then;
/** Drain native rejected promises solely to keep refusal diagnostics private; never await them. */
function drainRejectedPromise(value: unknown): void {
  try {
    void Reflect.apply(nativeThen, value, [undefined, () => {}]);
  } catch {
    /* Non-native promises and ordinary values grant no authority. */
  }
}
function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-target-publication-v2");
}
function object(value: unknown): Record<string, unknown> {
  valid(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const data = object(value);
  valid(isDeepStrictEqual(Object.keys(data).sort(), [...keys].sort()));
  return data;
}
function integer(value: unknown): asserts value is number {
  valid(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}
export interface TargetPublicationV2Configuration {
  target: "staging" | "production";
  candidate_passphrase: string;
  issuer: CurrentTargetIssuerConfiguration;
  mint: TargetIssuanceMintConfiguration;
  storage: TargetContentV2StorageConfiguration;
}
type ClientFactory = NonNullable<
  Parameters<typeof createTargetContentV2Producer>[1]
>["createClient"];
export interface TargetPublicationV2Dependencies {
  now?: () => number;
  githubGet?: CurrentReader;
  oidcGet?: TargetMintReader;
  createClient?: ClientFactory;
}
export interface TargetPublicationV2Request {
  release: ReleaseIdentity;
  mode: "apply" | "no-changes";
  candidate_file: string;
}
declare const destinationBrand: unique symbol;
export type TargetPublicationMintDestination = Readonly<{ [destinationBrand]: true }>;
interface Destination {
  proof: CurrentTargetIssuerProof;
  receipt: ContentReceiptV2;
  producer: TargetContentV2Producer;
  publication: TargetContentV2Publication;
  authority: () => number;
  reopen: () => void;
  mintCheck?: () => void;
  phase: "ready" | "checking" | "sealing" | "finished" | "fenced";
  fence: () => void;
}
const destinations = new WeakMap<TargetPublicationMintDestination, Destination>();
/** Native destination identity supplies the private bootstrap sink; caller callbacks cannot receive JWTs. */
export function assertTargetPublicationMintDestination(
  value: TargetPublicationMintDestination,
  proof: CurrentTargetIssuerProof,
  receipt: ContentReceiptV2,
): void {
  const saved = destinations.get(value);
  let owned = false;
  try {
    valid(saved && saved.phase === "ready");
    saved.phase = "checking";
    owned = true;
    valid(saved.proof === proof);
    saved.authority();
    valid(
      isDeepStrictEqual(saved.receipt, captureTargetIssuance(receipt)) &&
        saved.phase === "checking",
    );
    saved.authority();
    valid(saved.phase === "checking");
  } catch {
    if (saved) {
      saved.phase = "fenced";
      saved.fence();
    }
    throw new Error("invalid-target-publication-v2");
  } finally {
    if (saved && owned && saved.phase === "checking") saved.phase = "ready";
  }
}
/** Internal one-use bridge, bound to the exact saved v23 publication and original native proof. */
export async function sealTargetPublicationBootstrap(
  value: TargetPublicationMintDestination,
  proof: CurrentTargetIssuerProof,
  statement: TargetIssuanceStatementV2,
  jwt: string,
  check: () => void,
): Promise<void> {
  const saved = destinations.get(value);
  try {
    valid(saved && saved.phase === "ready");
    saved.phase = "sealing";
    valid(saved.proof === proof && typeof check === "function");
    saved.mintCheck = check;
    check();
    saved.authority();
    valid(saved.phase === "sealing");
    valid(isDeepStrictEqual(statement.content_receipt, saved.receipt));
    saved.reopen();
    check();
    saved.authority();
    valid(saved.phase === "sealing");
    await saved.producer.sealBootstrap({ publication: saved.publication, statement, jwt });
    check();
    saved.authority();
    saved.reopen();
    check();
    saved.authority();
    valid(saved.phase === "sealing");
    saved.phase = "finished";
    delete saved.mintCheck;
  } catch {
    if (saved) {
      saved.phase = "fenced";
      saved.fence();
    }
    throw new Error("invalid-target-publication-v2");
  }
}
/** Every metadata/open/read offer uses the same denial-only original operation window. */
function privateFile(
  path: string,
  check: () => number,
): { bytes: Buffer; identity: { dev: number; ino: number; size: number } } {
  valid(isAbsolute(path) && path === resolve(path));
  const folder = dirname(path),
    parts: string[] = [];
  let parent = folder;
  while (true) {
    parts.unshift(parent);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  for (const part of parts) {
    check();
    const metadata = lstatSync(part);
    check();
    valid(metadata.isDirectory() && !metadata.isSymbolicLink());
    if (part === folder)
      valid(metadata.uid === process.getuid?.() && (metadata.mode & 0o777) === 0o700);
  }
  const owned = (metadata: Stats) => {
    valid(
      metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.nlink === 1 &&
        metadata.uid === process.getuid?.() &&
        (metadata.mode & 0o777) === 0o600 &&
        metadata.size >= 32 &&
        metadata.size <= 65568,
    );
  };
  check();
  const route = lstatSync(path);
  check();
  owned(route);
  check();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    check();
    const metadata = fstatSync(fd);
    check();
    owned(metadata);
    valid(route.dev === metadata.dev && route.ino === metadata.ino && route.size === metadata.size);
    check();
    const bytes = Buffer.alloc(metadata.size);
    check();
    let position = 0;
    while (position < bytes.length) {
      check();
      const count = readSync(fd, bytes, position, bytes.length - position, position);
      check();
      valid(count > 0);
      position += count;
    }
    check();
    const final = fstatSync(fd);
    check();
    owned(final);
    valid(metadata.dev === final.dev && metadata.ino === final.ino && metadata.size === final.size);
    return { bytes, identity: { dev: metadata.dev, ino: metadata.ino, size: metadata.size } };
  } finally {
    closeSync(fd);
  }
}
export interface TargetPublicationV2 {
  publish(request: TargetPublicationV2Request): Promise<void>;
}
export function createTargetPublicationV2(
  configuration: TargetPublicationV2Configuration,
  dependencies: TargetPublicationV2Dependencies = {},
): TargetPublicationV2 {
  let phase: "ready" | "publishing" | "finished" | "fenced" = "ready";
  let activeProof: CurrentTargetIssuerProof | undefined;
  const fence = () => {
    phase = "fenced";
    if (activeProof) fenceCurrentTargetIssuerProof(activeProof);
  };
  const publish = async (input: TargetPublicationV2Request): Promise<void> => {
    const physicalStart = performance.now();
    try {
      valid(phase === "ready");
      phase = "publishing";
      // This first physical guard covers dependency getters and private input capture too.
      const alive = () => {
        valid(phase === "publishing" && performance.now() < physicalStart + 60_000);
      };
      alive();
      const clock = dependencies.now ?? Date.now;
      alive();
      const get = dependencies.githubGet;
      alive();
      const oidcGet = dependencies.oidcGet;
      alive();
      const createClient = dependencies.createClient;
      alive();
      valid(
        typeof clock === "function" &&
          (get === undefined || typeof get === "function") &&
          (oidcGet === undefined || typeof oidcGet === "function") &&
          (createClient === undefined || typeof createClient === "function"),
      );
      let last = 0,
        wall = Infinity,
        physicalEnd = physicalStart + 60_000,
        checking = false;
      const tick = () => {
        let owned = false;
        try {
          valid(phase === "publishing" && !checking);
          checking = true;
          owned = true;
          alive();
          const at = clock();
          if (typeof at !== "number") {
            fence();
            drainRejectedPromise(at);
          }
          integer(at);
          alive();
          valid(at >= last && at < wall && performance.now() < physicalEnd);
          last = at;
          return at;
        } catch {
          fence();
          throw new Error("invalid-target-publication-v2");
        } finally {
          if (owned) checking = false;
        }
      };
      const started = tick();
      wall = started + 60_000;
      const config = exact(captureTargetIssuance(configuration), [
        "target",
        "candidate_passphrase",
        "issuer",
        "mint",
        "storage",
      ]);
      tick();
      valid(config.target === "staging" || config.target === "production");
      const issuer = config.issuer as CurrentTargetIssuerConfiguration,
        mint = config.mint as TargetIssuanceMintConfiguration,
        storage = config.storage as TargetContentV2StorageConfiguration;
      valid(
        issuer.target === config.target &&
          storage.target === config.target &&
          typeof config.candidate_passphrase === "string" &&
          config.candidate_passphrase !== storage.descriptor_v2_passphrase,
      );
      const request = exact(captureTargetIssuance(input), ["release", "mode", "candidate_file"]);
      tick();
      const release = releaseIdentity(request.release);
      valid(request.mode === "apply" || request.mode === "no-changes");
      valid(
        typeof request.candidate_file === "string" &&
          request.candidate_file ===
            join(dirname(request.candidate_file), targetCandidateFileName(config.target)),
      );
      const expected: TargetCandidateContext = {
        target: config.target,
        release,
        mode: request.mode,
        producer: {
          repository: "deconfined/tarubot",
          workflow_ref: targetIssuancePins.publication,
          ref: "refs/heads/main",
          event: "push",
          attempt: 1,
          commit: release.commit,
          run: release.publication_run,
        },
      };
      const original = privateFile(request.candidate_file, tick);
      tick();
      const candidate = openEncryptedTargetCandidate({
        bytes: original.bytes,
        candidate_passphrase: config.candidate_passphrase,
        expected,
      });
      tick();
      valid(candidate.issued_at <= started && started < candidate.expires_at);
      wall = Math.min(wall, candidate.expires_at);
      physicalEnd = physicalStart + Math.min(60_000, candidate.expires_at - started);
      tick();
      const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
        const remaining = Math.min(wall - tick(), physicalEnd - performance.now());
        valid(remaining > 0);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const value = await Promise.race([
            Promise.resolve().then(() => {
              tick();
              return work();
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                fence();
                reject(new Error("invalid-target-publication-v2"));
              }, remaining);
            }),
          ]);
          tick();
          return value;
        } catch {
          fence();
          throw new Error("invalid-target-publication-v2");
        } finally {
          clearTimeout(timer);
        }
      };
      // The baseline reader retains only tick; authority must stay separate to prevent recursion.
      const read = createCurrentTargetIssuerReader(issuer, { ...(get ? { get } : {}), now: tick });
      tick();
      activeProof = await bounded(() =>
        read({ candidate, expected }, () => {
          tick();
        }),
      );
      tick();
      let destinationState: Destination | undefined;
      const authority = () => {
        tick();
        valid(destinationState?.phase !== "fenced");
        destinationState?.mintCheck?.();
        assertCurrentTargetIssuerProof(activeProof as CurrentTargetIssuerProof);
        return tick();
      };
      const path = request.candidate_file;
      const reopen = () => {
        authority();
        const current = privateFile(path, authority);
        authority();
        valid(
          isDeepStrictEqual(current.identity, original.identity) &&
            current.bytes.equals(original.bytes),
        );
        authority();
      };
      await bounded(() =>
        withinCurrentTargetIssuerProof(activeProof as CurrentTargetIssuerProof, async () => {
          reopen();
          // Its saved clock guards all v23 native persistence offers under these same original proofs.
          const producer = createTargetContentV2Producer(storage, {
            ...(createClient ? { createClient } : {}),
            now: authority,
          });
          authority();
          const sealed = await producer.sealContent({
            envelope: candidate.envelope,
            expires_at: candidate.expires_at,
          });
          authority();
          const destination = Object.freeze({}) as TargetPublicationMintDestination;
          destinationState = {
            proof: activeProof as CurrentTargetIssuerProof,
            receipt: sealed.receipt,
            producer,
            publication: sealed.publication,
            authority,
            reopen,
            phase: "ready",
            fence,
          };
          destinations.set(destination, destinationState);
          const minter = createTargetIssuanceMinter(mint, {
            ...(oidcGet ? { get: oidcGet } : {}),
            now: tick,
          });
          authority();
          await minter.mint(activeProof as CurrentTargetIssuerProof, sealed.receipt, destination);
          authority();
          valid(destinationState.phase === "finished");
        }),
      );
      phase = "finished";
    } catch {
      fence();
      throw new Error("invalid-target-publication-v2");
    }
  };
  return Object.freeze({ publish });
}
