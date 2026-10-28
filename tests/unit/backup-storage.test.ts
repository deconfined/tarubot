/**
 * The S3 adapter (src/infrastructure/backup/storage.ts) against a recording S3 double on loopback:
 * virtual-hosted requests with the key prefix, multipart uploads that complete only when the body
 * closes and are aborted when it errors (the contract a backup's integrity rests on), listing
 * across pages, and reading an object back. No network and no credentials leave the process.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { S3BackupStorage } from "../../src/infrastructure/backup/storage.js";
import { concat, fixtureBytes } from "../fixtures/backups.js";

const MiB = 1024 * 1024;

/** What the double received: method, path and query, and the signed region. */
const requests: { method: string; path: string; query: string; region: string }[] = [];
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const uploads = new Map<string, Map<number, Uint8Array>>();
let uploadCount = 0;
/** Page size for ListObjectsV2, small so pagination is exercised. */
const PAGE = 2;

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    headers: { "content-type": "application/xml" },
  });

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\//u.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];
    requests.push({
      method: request.method,
      path: decodeURIComponent(url.pathname),
      query: url.search,
      region: region ?? "",
    });
    const key = decodeURIComponent(url.pathname).slice(1);
    const upload = url.searchParams.get("uploadId") ?? "";
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = `upload-${++uploadCount}`;
      uploads.set(id, new Map());
      return xml(
        `<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === "PUT" && upload) {
      uploads.get(upload)?.set(Number(url.searchParams.get("partNumber")), body);
      return new Response(null, {
        headers: { etag: `"part-${url.searchParams.get("partNumber")}"` },
      });
    }
    if (request.method === "POST" && upload) {
      const parts = [...(uploads.get(upload) ?? new Map<number, Uint8Array>())]
        .sort(([a], [b]) => a - b)
        .map(([, part]) => part);
      objects.set(key, concat(parts));
      uploads.delete(upload);
      return xml(
        `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"done"</ETag></CompleteMultipartUploadResult>`,
      );
    }
    if (request.method === "DELETE" && upload) {
      uploads.delete(upload);
      return new Response(null, { status: 204 });
    }
    if (request.method === "PUT") {
      objects.set(key, body);
      return new Response(null, { headers: { etag: '"single"' } });
    }
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? 0);
      const page = keys.slice(start, start + PAGE);
      const more = start + PAGE < keys.length;
      return xml(
        `<ListBucketResult><Name>b</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${PAGE}</MaxKeys><IsTruncated>${more}</IsTruncated>${
          more ? `<NextContinuationToken>${start + PAGE}</NextContinuationToken>` : ""
        }${page.map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.length}</Size></Contents>`).join("")}</ListBucketResult>`,
      );
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      return object ? new Response(object) : new Response("missing", { status: 404 });
    }
    return new Response("unexpected", { status: 400 });
  },
});
afterAll(() => server.stop(true));

const storage = (prefix = "") =>
  new S3BackupStorage({
    // Loopback stands in for the bucket's own host (virtual-hosted style); production is https.
    endpoint: `http://127.0.0.1:${server.port}`,
    prefix,
    accessKey: "invented-access-key",
    secretKey: "invented-secret-key",
    region: "us-iad-10",
  });

/** A body of `size` bytes in 1 MiB chunks that errors instead of closing when `fail` is set. */
function body(size: number, fail = false): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      if (sent >= size) {
        if (fail) controller.error(new Error("The dump failed."));
        else controller.close();
        return;
      }
      const chunk = fixtureBytes(Math.min(MiB, size - sent), sent + 1);
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

beforeEach(() => {
  requests.length = 0;
  objects.clear();
  uploads.clear();
});

describe("S3 storage", () => {
  test("a streamed body is a multipart upload under the prefix, completed when it closes", async () => {
    const bytes = await storage("tarubot/").put("daily/a.dump.age", body(12 * MiB));
    expect(bytes).toBe(12 * MiB);
    expect(objects.get("tarubot/daily/a.dump.age")?.length).toBe(12 * MiB);
    expect(
      requests.map(({ method, query }) => `${method} ${query.replace(/=[^&]*/gu, "")}`),
    ).toEqual([
      "POST ?uploads",
      "PUT ?partNumber&uploadId&x-id",
      "PUT ?partNumber&uploadId&x-id",
      "PUT ?partNumber&uploadId&x-id",
      "POST ?uploadId",
    ]);
    // Signed for the configured region, with no hidden default.
    expect(new Set(requests.map((request) => request.region))).toEqual(new Set(["us-iad-10"]));
  });

  test("a body that errors aborts the upload and leaves no object, large or small", async () => {
    await expect(storage().put("daily/b.dump.age", body(7 * MiB, true))).rejects.toThrow();
    // put() rejects at once, and Bun never sends CompleteMultipartUpload: no object appears.
    // It then sends AbortMultipartUpload (DELETE ?uploadId), except that Bun 1.4.2 skips the
    // abort when the body errored before the upload's creation was answered (fixed by 1.4.4),
    // and a process killed in between can't send it either. Such an incomplete upload is not an
    // object, and the bucket's lifecycle rule for incomplete uploads removes it.
    await Bun.sleep(300);
    expect(requests.some((r) => r.method === "POST" && r.query.startsWith("?uploadId"))).toBe(
      false,
    );
    for (const request of requests.filter((r) => r.method === "DELETE"))
      expect(request).toMatchObject({
        path: "/daily/b.dump.age",
        query: expect.stringMatching(/^\?uploadId=upload-\d+$/u),
      });
    expect(objects.size).toBe(0);
    requests.length = 0;
    // Shorter than one part: the single PUT is never sent.
    await expect(storage().put("daily/c.dump.age", body(1000, true))).rejects.toThrow();
    await Bun.sleep(100);
    expect(objects.size).toBe(0);
    expect(requests.filter((request) => request.method === "PUT")).toEqual([]);
  });

  test("bytes are one PUT; listing follows every page and strips the prefix; get reads back", async () => {
    const store = storage("p/");
    for (const name of ["daily/1", "daily/2", "daily/3", "env/1", "monthly/1"])
      await store.put(name, new TextEncoder().encode(name));
    expect(objects.has("p/daily/1")).toBe(true);
    expect((await store.list("daily/")).map(({ key, size }) => [key, size])).toEqual([
      ["daily/1", 7],
      ["daily/2", 7],
      ["daily/3", 7],
    ]);
    expect(await new Response(store.get("env/1")).text()).toBe("env/1");
    // Without a prefix, keys are the bucket's own.
    expect((await storage().list("p/env/")).map(({ key }) => key)).toEqual(["p/env/1"]);
  });
});
