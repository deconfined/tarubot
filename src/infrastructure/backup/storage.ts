/**
 * Where backups go (2.46.0): an S3-compatible bucket through Bun's built-in S3 client, behind a
 * small interface so the backup and restore code can be tested against memory. The contract that
 * makes a backup trustworthy is put()'s: an object appears only once its whole body has arrived,
 * and a body that errors part-way (pg_dump failed, the dump was too small, shutdown began) aborts
 * the upload and leaves no object, half-written or otherwise.
 */

/** A stored object: its key (below the configured prefix) and its size in bytes. */
export interface StoredObject {
  readonly key: string;
  readonly size: number;
}

/** What backups and restore.js need from storage. Keys never include the configured prefix. */
export interface BackupStorage {
  /**
   * Store `body` under `key` and resolve with the bytes stored. The object becomes visible only
   * once the body has closed; a body that errors, or a failed request, rejects and leaves nothing.
   */
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<number>;
  /** Every object whose key starts with `prefix`, in no particular order. */
  list(prefix: string): Promise<StoredObject[]>;
  /** An object's bytes, streamed. */
  get(key: string): ReadableStream<Uint8Array>;
}

/** A bucket's address and credentials, as src/application/backups.ts validates them. */
export interface StorageSettings {
  /** The bucket's own origin (virtual-hosted style), such as https://bucket.region.example.org. */
  readonly endpoint: string;
  /** A key prefix from the endpoint's path: "" or "path/". */
  readonly prefix: string;
  readonly accessKey: string;
  readonly secretKey: string;
  readonly region: string;
}

const MiB = 1024 * 1024;

/**
 * Bun's S3 client over one bucket. A streamed body is sent as a multipart upload in 5 MiB parts
 * (two in flight), and Bun completes it only when the stream closes; when the stream errors it
 * never completes it and sends AbortMultipartUpload instead (a body shorter than one part is a
 * single PUT that is never sent). Bun 1.4.2 skips that abort when the body errors before the
 * upload's creation was answered, as a killed process does: the incomplete upload is no object,
 * and the bucket's lifecycle rule for incomplete uploads removes it. Verified against a recording
 * S3 double in tests/unit/backup-storage.test.ts.
 */
export class S3BackupStorage implements BackupStorage {
  private readonly client: Bun.S3Client;
  private readonly prefix: string;

  constructor(settings: StorageSettings) {
    this.client = new Bun.S3Client({
      endpoint: settings.endpoint,
      virtualHostedStyle: true,
      region: settings.region,
      accessKeyId: settings.accessKey,
      secretAccessKey: settings.secretKey,
    });
    this.prefix = settings.prefix;
  }

  async put(key: string, body: ReadableStream<Uint8Array> | Uint8Array): Promise<number> {
    const options = { type: "application/octet-stream", partSize: 5 * MiB, queueSize: 2, retry: 3 };
    return await this.client.write(
      this.prefix + key,
      body instanceof Uint8Array ? body : new Response(body),
      options,
    );
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.list({
        prefix: this.prefix + prefix,
        ...(continuationToken && { continuationToken }),
      });
      for (const { key, size } of page.contents ?? [])
        if (key.startsWith(this.prefix))
          objects.push({ key: key.slice(this.prefix.length), size: size ?? 0 });
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  get(key: string): ReadableStream<Uint8Array> {
    return this.client.file(this.prefix + key).stream();
  }
}
