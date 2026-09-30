/** Invented provider responses only. No credentials are loaded and no API request is performed. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CloudflareSshfpWriter,
  LinodeInstanceReader,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderTransport,
} from "../../scripts/trust-provider.js";
import type { PublicationRequest, SshfpRecord, TargetDescriptor } from "../../scripts/ssh-trust.js";

const instant = 1_800_000_000_000;
const credential = "invented_runtime_token_123456789";
const descriptor: TargetDescriptor = {
  schema: 1,
  target: "staging",
  provider: "linode",
  instance_id: "1234",
  fqdn: "host.example.org",
  addresses: { ipv4: "192.0.2.10", ipv6: "2001:db8::10" },
  dns_zone_id: "a".repeat(32),
  applied_generation: "11111111-1111-4111-8111-111111111111",
  state: { lineage: "22222222-2222-4222-8222-222222222222", serial: 1, digest: "b".repeat(64) },
};
const fresh = { algorithm: 4, digest_type: 2, fingerprint: "c".repeat(64) } as const;
const old = { algorithm: 4, digest_type: 2, fingerprint: "d".repeat(64) } as const;
const base = `https://api.cloudflare.com/client/v4/zones/${descriptor.dns_zone_id}/dns_records`;
const id = (number: number) => number.toString(16).padStart(32, "0");
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing-invented-provider-fixture");
  return value;
}
function response(request: ProviderRequest, value: unknown): ProviderResponse {
  return {
    status: 200,
    url: request.url,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(value)),
  };
}
function rawRecord(number = 1, fingerprint = old.fingerprint, algorithm = 4, digestType = 2) {
  return {
    id: id(number),
    name: descriptor.fqdn,
    type: "SSHFP",
    ttl: 600,
    data: { algorithm, type: digestType, fingerprint },
    content: `${algorithm} ${digestType} ${fingerprint}`,
    comment: "Invented existing note",
    tags: ["owner:invented"],
    settings: {},
    proxied: false,
  };
}
type RawRecord = ReturnType<typeof rawRecord>;
function normalized(raw: RawRecord): SshfpRecord {
  return {
    id: raw.id,
    zone_id: descriptor.dns_zone_id,
    name: descriptor.fqdn,
    type: "SSHFP",
    sshfp: { algorithm: 4, digest_type: 2, fingerprint: raw.data.fingerprint.toLowerCase() },
  };
}
function publication(previous: SshfpRecord | null = null): PublicationRequest {
  return {
    target: "staging",
    generation: "33333333-3333-4333-8333-333333333333",
    zone_id: descriptor.dns_zone_id,
    name: descriptor.fqdn,
    type: "SSHFP",
    record_id: previous?.id ?? null,
    previous,
    sshfp: { ...fresh },
  };
}
function cloudflare(initial: RawRecord[] = []) {
  const records = structuredClone(initial);
  const seen: ProviderRequest[] = [];
  const fences: PublicationRequest[] = [];
  const transport: ProviderTransport = async (request) => {
    seen.push(structuredClone(request));
    const url = new URL(request.url);
    if (!request.url.startsWith(base)) throw new Error("unexpected-invented-provider-url");
    const recordId = url.pathname.split("/")[6];
    if (request.method === "GET" && recordId === undefined) {
      expect(url.searchParams.get("type")).toBe("SSHFP");
      expect(url.searchParams.get("name.exact")).toBe(descriptor.fqdn);
      expect(url.searchParams.get("match")).toBe("all");
      expect(url.searchParams.get("per_page")).toBe("50");
      const page = Number(url.searchParams.get("page"));
      const selected = records.slice((page - 1) * 50, page * 50);
      return response(request, {
        success: true,
        errors: [],
        messages: [],
        result: selected,
        result_info: {
          page,
          per_page: 50,
          count: selected.length,
          total_count: records.length,
          total_pages: Math.ceil(records.length / 50),
        },
      });
    }
    if (request.method === "GET")
      return response(request, {
        success: true,
        errors: [],
        messages: [],
        result: records.find((r) => r.id === recordId),
      });
    const body = JSON.parse(request.body ?? "null") as RawRecord;
    let raw: RawRecord;
    if (request.method === "POST") {
      raw = { ...rawRecord(900, fresh.fingerprint), ...body };
      records.push(raw);
    } else {
      raw = present(records.find((r) => r.id === recordId));
      Object.assign(raw, body);
    }
    raw.content = `${raw.data.algorithm} ${raw.data.type} ${raw.data.fingerprint}`;
    return response(request, { success: true, errors: [], messages: [], result: raw });
  };
  const beforeWrite = async (request: PublicationRequest) => {
    fences.push(structuredClone(request));
  };
  const writer = (
    request: ProviderTransport = transport,
    now: () => number = () => instant,
    boundary = beforeWrite,
  ) =>
    new CloudflareSshfpWriter(
      {
        token: credential,
        target: "staging",
        zone_id: descriptor.dns_zone_id,
        name: descriptor.fqdn,
        beforeWrite: boundary,
      },
      { request, now },
    );
  return { records, seen, fences, transport, beforeWrite, writer };
}
async function refusal(action: Promise<unknown>): Promise<void> {
  await expect(action).rejects.toThrow("invalid-trust-provider");
}
function edited(
  result: ProviderResponse,
  edit: (value: Record<string, unknown>) => void,
): ProviderResponse {
  const value = JSON.parse(Buffer.from(result.body).toString("utf8")) as Record<string, unknown>;
  edit(value);
  result.body = Buffer.from(JSON.stringify(value));
  return result;
}

describe("scoped existing Linode identity read", () => {
  test("plain constructor inputs are captured once before getter-driven token substitution", async () => {
    let accesses = 0;
    const options = {
      get token() {
        return ++accesses === 1 ? credential : "invented-invalid\nshadow";
      },
      descriptor,
    };
    const seen: ProviderRequest[] = [];
    const reader = new LinodeInstanceReader(options, {
      now: () => instant,
      request: async (r) => {
        seen.push(structuredClone(r));
        return response(r, {
          id: 1234,
          status: "running",
          ipv4: ["192.0.2.10"],
          ipv6: "2001:db8::10/128",
        });
      },
    });
    expect(await reader.verify()).toEqual(descriptor);
    expect(accesses).toBe(1);
    expect(seen[0]?.headers.Authorization).toBe(`Bearer ${credential}`);
    expect(
      () =>
        new LinodeInstanceReader({
          get token(): string {
            throw new Error("invented-private-accessor-diagnostic");
          },
          descriptor,
        }),
    ).toThrow("invalid-trust-provider");
  });
  test("runtime-private diagnostics and external shadow properties preserve the bound pending read", async () => {
    const seen: ProviderRequest[] = [];
    let finish = () => {};
    const waiting = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reader = new LinodeInstanceReader(
      { token: credential, descriptor },
      {
        now: () => instant,
        request: async (request) => {
          seen.push(structuredClone(request));
          await waiting;
          return response(request, {
            id: 1234,
            status: "running",
            ipv4: ["192.0.2.10"],
            ipv6: "2001:db8::10/128",
          });
        },
      },
    );
    expect(Object.keys(reader)).toEqual([]);
    for (const diagnostic of [JSON.stringify(reader), Bun.inspect(reader)]) {
      expect(diagnostic).not.toContain(credential);
      expect(diagnostic).not.toContain(descriptor.fqdn);
      expect(diagnostic).not.toContain(descriptor.addresses.ipv4);
    }
    const reading = reader.verify();
    // These ordinary public properties cannot recover or replace any runtime-private field.
    for (const field of ["credential", "descriptor", "dependencies"])
      expect(Reflect.get(reader, field)).toBeUndefined();
    Object.assign(reader, {
      credential: "invented-shadow-token",
      descriptor: { ...descriptor, instance_id: "9999" },
      dependencies: {
        now: () => 0,
        request: () => {
          throw new Error("external-shadow-requester-used");
        },
      },
    });
    finish();
    expect(await reading).toEqual(descriptor);
    expect(await reader.verify()).toEqual(descriptor);
    expect(seen).toHaveLength(2);
    expect(seen.every((r) => r.url === "https://api.linode.com/v4/linode/instances/1234")).toBe(
      true,
    );
    expect(seen.every((r) => r.headers.Authorization === `Bearer ${credential}`)).toBe(true);
  });
  test("only GETs the exact instance and canonicalizes the provider IPv6 /128", async () => {
    const seen: ProviderRequest[] = [];
    const input = structuredClone(descriptor);
    const reader = new LinodeInstanceReader(
      { token: credential, descriptor: input },
      {
        now: () => instant,
        request: async (r) => {
          seen.push(structuredClone(r));
          return response(r, {
            id: 1234,
            status: "running",
            ipv4: ["192.0.2.10"],
            ipv6: "2001:DB8:0:0:0:0:0:10/128",
            label: "Invented mutable label",
          });
        },
      },
    );
    input.instance_id = "9999";
    const result = await reader.verify();
    expect(result).toEqual(descriptor);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "GET",
      url: "https://api.linode.com/v4/linode/instances/1234",
      body: null,
      redirect: "error",
      body_limit: 1048576,
      timeout_ms: 10000,
    });
    expect(seen[0]?.headers.Authorization).toBe(`Bearer ${credential}`);
    result.state.serial = 999;
    expect(await reader.verify()).toEqual(descriptor);
  });
  test("changed ID/status/addresses, extra private/secondary IPv4 or ambiguous numeric identity fail", async () => {
    for (const delta of [
      { id: 4321 },
      { id: "1234" },
      { status: "booting" },
      { status: "offline" },
      { ipv4: [] },
      { ipv4: ["192.0.2.11"] },
      { ipv4: ["192.0.2.10", "10.0.0.10"] },
      { ipv4: ["192.0.2.10", "192.0.2.11"] },
      { ipv6: "2001:db8::11/128" },
      { ipv6: "2001:db8::10/64" },
      { ipv6: "2001:db8::10" },
      { ipv6: null },
    ]) {
      await refusal(
        new LinodeInstanceReader(
          { token: credential, descriptor },
          {
            now: () => instant,
            request: async (r) =>
              response(r, {
                id: 1234,
                status: "running",
                ipv4: ["192.0.2.10"],
                ipv6: "2001:db8::10/128",
                ...delta,
              }),
          },
        ).verify(),
      );
    }
    expect(
      () =>
        new LinodeInstanceReader({
          token: credential,
          descriptor: { ...descriptor, instance_id: "9999999999999999" },
        }),
    ).toThrow("invalid-trust-provider");
  });
});

describe("Cloudflare SSHFP owner transport", () => {
  test("only plain write authority is snapshotted while the trusted callback remains callable", async () => {
    const f = cloudflare();
    let accesses = 0;
    let fences = 0;
    const writer = new CloudflareSshfpWriter(
      {
        get token() {
          return ++accesses === 1 ? credential : "invented-invalid\nshadow";
        },
        target: "staging",
        zone_id: descriptor.dns_zone_id,
        name: descriptor.fqdn,
        beforeWrite: async () => {
          fences++;
        },
      },
      { request: f.transport, now: () => instant },
    );
    expect((await writer.write(publication())).sshfp).toEqual(fresh);
    expect(accesses).toBe(1);
    expect(fences).toBe(1);
    expect(f.seen.every((r) => r.headers.Authorization === `Bearer ${credential}`)).toBe(true);
  });
  test("runtime-private diagnostics and external shadows cannot replace DNS scope or the live write fence", async () => {
    const f = cloudflare([rawRecord()]);
    const writer = f.writer();
    expect(Object.keys(writer)).toEqual([]);
    for (const diagnostic of [JSON.stringify(writer), Bun.inspect(writer)]) {
      expect(diagnostic).not.toContain(credential);
      expect(diagnostic).not.toContain(descriptor.fqdn);
      expect(diagnostic).not.toContain(descriptor.dns_zone_id);
    }
    const writing = writer.write(publication(normalized(rawRecord())));
    for (const field of ["scope", "credential", "dependencies", "beforeWrite", "records", "path"])
      expect(Reflect.get(writer, field)).toBeUndefined();
    Object.assign(writer, {
      scope: { target: "production", zone_id: "b".repeat(32), name: "other.example.org" },
      credential: "invented-shadow-token",
      dependencies: {
        now: () => 0,
        request: () => {
          throw new Error("external-shadow-requester-used");
        },
      },
      beforeWrite: async () => {
        throw new Error("external-shadow-fence-used");
      },
      records: async () => [],
      path: () => "/client/v4/zones/other/dns_records",
    });
    expect((await writing).sshfp).toEqual(fresh);
    expect(f.fences).toEqual([publication(normalized(rawRecord()))]);
    expect(f.seen.every((r) => r.url.startsWith(base))).toBe(true);
    expect(f.seen.every((r) => r.headers.Authorization === `Bearer ${credential}`)).toBe(true);
    const refused = cloudflare();
    const ownerFenced = refused.writer(
      refused.transport,
      () => instant,
      async () => {
        throw new Error("invented-real-owner-fence-refusal");
      },
    );
    Reflect.set(ownerFenced, "beforeWrite", async () => {});
    await refusal(ownerFenced.write(publication()));
    expect(refused.seen.map((r) => r.method)).toEqual(["GET"]);
  });
  test("lists every page and normalizes all 4/2 conflicts without hiding unowned IDs", async () => {
    const first = Array.from({ length: 50 }, (_, n) => rawRecord(n + 1, "e".repeat(64), 1));
    first[17] = rawRecord(18);
    const second = rawRecord(51, fresh.fingerprint.toUpperCase());
    second.name = descriptor.fqdn.toUpperCase();
    const f = cloudflare([...first, second]);
    const records = await f.writer().read(publication(normalized(first[17] as RawRecord)));
    expect(records).toEqual([normalized(first[17] as RawRecord), normalized(second)]);
    expect(f.seen).toHaveLength(2);
    expect(f.seen.every((r) => r.method === "GET" && r.body === null)).toBe(true);
    expect(f.fences).toHaveLength(0);
  });
  test("creates only with no predecessor/conflict, preserves other SSHFP algorithms and verifies exact readbacks", async () => {
    const other = rawRecord(1, "e".repeat(64), 1);
    const f = cloudflare([other]);
    const rr = await f.writer().write(publication());
    expect(rr).toEqual({ ...normalized(rawRecord(900, fresh.fingerprint)), sshfp: fresh });
    expect(f.records[0]).toEqual(other);
    const mutations = f.seen.filter((r) => r.method !== "GET");
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.method).toBe("POST");
    expect(mutations[0]?.url).toBe(base);
    expect(JSON.parse(mutations[0]?.body ?? "null")).toEqual({
      name: descriptor.fqdn,
      type: "SSHFP",
      ttl: 300,
      data: { algorithm: 4, type: 2, fingerprint: fresh.fingerprint },
    });
    expect(f.fences).toEqual([publication()]);
    expect(f.seen.map((r) => r.method)).toEqual(["GET", "POST", "GET", "GET"]);
  });
  test("patches only the exact owned predecessor after fresh GET and preserves TTL and metadata", async () => {
    const initial = rawRecord();
    const unrelated = rawRecord(2, "e".repeat(64), 1);
    const f = cloudflare([initial, unrelated]);
    const expected = publication(normalized(initial));
    await f.writer().write(expected);
    expect(f.seen.map((r) => r.method)).toEqual(["GET", "GET", "PATCH", "GET", "GET"]);
    const patch = present(f.seen.find((r) => r.method === "PATCH"));
    expect(patch.url).toBe(`${base}/${initial.id}`);
    expect(JSON.parse(patch.body ?? "null")).toEqual({
      name: descriptor.fqdn,
      type: "SSHFP",
      ttl: 600,
      data: { algorithm: 4, type: 2, fingerprint: fresh.fingerprint },
    });
    expect(f.records[0]).toMatchObject({
      id: initial.id,
      ttl: initial.ttl,
      comment: initial.comment,
      tags: initial.tags,
      settings: initial.settings,
      proxied: false,
    });
    expect(f.records[1]).toEqual(unrelated);
  });
  test("conflicts, missing ownership and changed predecessor readback refuse before any mutation", async () => {
    for (const initial of [[rawRecord()], [rawRecord(), rawRecord(2)], []]) {
      const f = cloudflare(initial);
      const request =
        initial.length === 0
          ? publication(normalized(rawRecord()))
          : initial.length === 1
            ? publication()
            : publication(normalized(rawRecord()));
      await refusal(f.writer().write(request));
      expect(f.seen.every((r) => r.method === "GET")).toBe(true);
      expect(f.fences).toHaveLength(0);
    }
    const f = cloudflare([rawRecord()]);
    await refusal(
      f
        .writer(async (r) => {
          const reply = await f.transport(r);
          if (!r.url.includes("?"))
            edited(reply, (e) => {
              (e.result as RawRecord).data.fingerprint = fresh.fingerprint;
            });
          return reply;
        })
        .write(publication(normalized(rawRecord()))),
    );
    expect(f.seen.every((r) => r.method === "GET")).toBe(true);
  });
  test("scope/unknown fields and malformed SSHFP are rejected, including unknown algorithms on later pages", async () => {
    const f = cloudflare();
    for (const delta of [
      { target: "production" },
      { zone_id: "b".repeat(32) },
      { name: "other.example.org" },
      { type: "A" },
      { record_id: id(1) },
      { generation: "main" },
      { extra: true },
      { sshfp: { ...fresh, fingerprint: "C".repeat(64) } },
      { sshfp: { ...fresh, algorithm: 1 } },
    ]) {
      await refusal(f.writer().write({ ...publication(), ...delta } as PublicationRequest));
      expect(f.seen).toHaveLength(0);
    }
    for (const delta of [
      { type: "A" },
      { name: "other.example.org" },
      { zone_id: "b".repeat(32) },
      { id: "../other" },
      { data: { algorithm: 1, type: 2, fingerprint: "e".repeat(64), unexpected: true } },
      { data: { algorithm: "4", type: 2, fingerprint: old.fingerprint } },
      { data: { algorithm: 4, type: 2, fingerprint: old.fingerprint.slice(0, 62) } },
      { data: { algorithm: 4, digest_type: 2, fingerprint: old.fingerprint } },
      { content: `4 2 ${fresh.fingerprint}` },
      { ttl: 0 },
      { ttl: 29 },
      { proxied: true },
    ]) {
      const bad = Object.assign(rawRecord(51), delta);
      const g = cloudflare([
        ...Array.from({ length: 50 }, (_, n) => rawRecord(n + 1, "e".repeat(64), 1)),
        bad,
      ]);
      await refusal(g.writer().read(publication()));
      expect(g.seen.every((r) => r.method === "GET")).toBe(true);
    }
  });
  test("incomplete, changing, duplicate or unbounded pages never permit a write", async () => {
    for (const fault of [
      "missing",
      "count",
      "pages",
      "per_page",
      "page",
      "growth",
      "duplicate",
      "too_many",
    ]) {
      const f = cloudflare(
        Array.from({ length: 51 }, (_, n) => rawRecord(n + 1, "e".repeat(64), 1)),
      );
      await refusal(
        f
          .writer(async (r) =>
            edited(await f.transport(r), (e) => {
              const info = e.result_info as Record<string, number>;
              if (fault === "missing") delete e.result_info;
              if (fault === "count") info.count = 0;
              if (fault === "pages") info.total_pages = 1;
              if (fault === "per_page") info.per_page = 100;
              if (fault === "page") info.page = 2;
              if (fault === "too_many") {
                info.total_count = 1001;
                info.total_pages = 21;
              }
              if (r.url.includes("page=2")) {
                if (fault === "growth") info.total_count = 52;
                if (fault === "duplicate")
                  (e.result as RawRecord[])[0] = rawRecord(1, "e".repeat(64), 1);
              }
            }),
          )
          .write(publication()),
      );
      expect(f.seen.every((r) => r.method === "GET")).toBe(true);
      expect(f.fences).toHaveLength(0);
    }
  });
  test("independent live grant is required after all reads and caller/callback mutations cannot rewrite the write", async () => {
    expect(
      () =>
        new CloudflareSshfpWriter({
          token: credential,
          target: "staging",
          zone_id: descriptor.dns_zone_id,
          name: descriptor.fqdn,
        } as ConstructorParameters<typeof CloudflareSshfpWriter>[0]),
    ).toThrow("invalid-trust-provider");
    const f = cloudflare([rawRecord()]);
    await refusal(
      f
        .writer(
          f.transport,
          () => instant,
          async () => {
            throw new Error("invented expired private grant");
          },
        )
        .write(publication(normalized(rawRecord()))),
    );
    expect(f.seen.map((r) => r.method)).toEqual(["GET", "GET"]);
    const booleanGate = cloudflare();
    await refusal(
      booleanGate
        .writer(
          booleanGate.transport,
          () => instant,
          (async () => true) as unknown as (request: PublicationRequest) => Promise<void>,
        )
        .write(publication()),
    );
    expect(booleanGate.seen.map((r) => r.method)).toEqual(["GET"]);
    const g = cloudflare([rawRecord()]);
    const request = publication(normalized(rawRecord()));
    await g
      .writer(
        async (r) => {
          const result = await g.transport(r);
          request.zone_id = "b".repeat(32);
          request.sshfp.fingerprint = "f".repeat(64);
          r.headers.Authorization = "changed";
          return result;
        },
        () => instant,
        async (bound) => {
          expect(g.seen.map((r) => r.method)).toEqual(["GET", "GET"]);
          bound.name = "other.example.org";
          bound.sshfp.fingerprint = "0".repeat(64);
        },
      )
      .write(request);
    expect(g.records[0]?.data.fingerprint).toBe(fresh.fingerprint);
    expect(g.seen.every((r) => r.headers.Authorization === `Bearer ${credential}`)).toBe(true);
  });
  test("mismatched acknowledgements/readbacks and late conflicts never retry an uncertain mutation", async () => {
    for (const fault of ["id", "name", "fingerprint", "ttl", "readback", "conflict", "throw"]) {
      const f = cloudflare([rawRecord()]);
      await refusal(
        f
          .writer(async (r) => {
            const result = await f.transport(r);
            if (r.method === "PATCH") {
              if (fault === "throw") throw new Error("invented lost mutation acknowledgement");
              if (fault === "conflict") f.records.push(rawRecord(2, fresh.fingerprint));
              if (fault === "id")
                edited(result, (e) => {
                  (e.result as RawRecord).id = id(2);
                });
              if (fault === "name")
                edited(result, (e) => {
                  (e.result as RawRecord).name = "other.example.org";
                });
              if (fault === "fingerprint")
                edited(result, (e) => {
                  (e.result as RawRecord).data.fingerprint = old.fingerprint;
                });
              if (fault === "ttl")
                edited(result, (e) => {
                  (e.result as RawRecord).ttl = 300;
                });
            }
            if (
              fault === "readback" &&
              f.seen.some((s) => s.method === "PATCH") &&
              r.method === "GET" &&
              !r.url.includes("?")
            )
              edited(result, (e) => {
                (e.result as RawRecord).content = `4 2 ${old.fingerprint}`;
              });
            return result;
          })
          .write(publication(normalized(rawRecord()))),
      );
      expect(f.seen.filter((r) => r.method !== "GET")).toHaveLength(1);
      expect(f.records[0]?.data.fingerprint).toBe(fresh.fingerprint);
    }
  });
});

describe("private bounded transport failures", () => {
  test("single JSON media type permits UTF-8 only and rejects joined duplicate headers", async () => {
    const accepted = [
      "application/json",
      "Application/JSON",
      "application/json; charset=utf-8",
      'application/json; charset="UTF-8"',
      ' \tAPPLICATION/JSON \t; \tCHARSET \t= \t"utf-8" \t',
    ];
    const rejected = [
      "application/json,application/json",
      "application/json; charset=utf-8,application/json",
      'application/json; charset="utf-8",application/json; charset="utf-8"',
      "application/json; charset=iso-8859-1",
      "application/json; charset=us-ascii",
      "application/json; charset=utf8",
      "application/json; nonsense",
      "application/json; profile=private",
      "application/json; charset=utf-8; profile=private",
      "application/json; charset=utf-8; charset=utf-8",
      "application/json;",
      "application/json\r\n",
    ];
    for (const [allowed, values] of [
      [true, accepted],
      [false, rejected],
    ] as const) {
      for (const contentType of values) {
        // Both providers share the same HTTP boundary; malformed input cannot permit DNS writes.
        const reader = new LinodeInstanceReader(
          { token: credential, descriptor },
          {
            now: () => instant,
            request: async (r) => {
              const result = response(r, {
                id: 1234,
                status: "running",
                ipv4: ["192.0.2.10"],
                ipv6: "2001:db8::10/128",
              });
              result.headers["content-type"] = contentType;
              return result;
            },
          },
        );
        const f = cloudflare();
        const readDns = () =>
          f
            .writer(async (r) => {
              const result = await f.transport(r);
              result.headers["content-type"] = contentType;
              return result;
            })
            .read(publication());
        if (allowed) {
          expect(await reader.verify()).toEqual(descriptor);
          expect(await readDns()).toEqual([]);
        } else {
          await refusal(reader.verify());
          await refusal(readDns());
        }
        expect(f.seen.map((r) => r.method)).toEqual(["GET"]);
      }
    }
  });
  test("duplicate JSON write acknowledgement leaves mutation uncertain without retry", async () => {
    const f = cloudflare();
    await refusal(
      f
        .writer(async (r) => {
          const result = await f.transport(r);
          if (r.method === "POST")
            result.headers["content-type"] = "application/json; charset=utf-8,application/json";
          return result;
        })
        .write(publication()),
    );
    expect(f.seen.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(f.records).toHaveLength(1);
    expect(f.fences).toHaveLength(1);
  });
  test("explicit credentials and fixed origins reject header injection or ambient configuration", () => {
    for (const token of [
      "",
      "short",
      `${credential}\nprivate`,
      `${credential}\rprivate`,
      "é".repeat(25),
    ])
      expect(() => new LinodeInstanceReader({ token, descriptor })).toThrow(
        "invalid-trust-provider",
      );
    const source = readFileSync(
      new URL("../../scripts/trust-provider.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("process.env");
    expect(source).not.toContain("import.meta.main");
    expect(source).not.toContain('method: "DELETE"');
    expect(source).not.toContain("readFile");
  });
  test("redirects, pagination headers, oversized/invalid payloads and provider diagnostics fail redacted", async () => {
    const faults: Array<(r: ProviderResponse) => void> = [
      (r) => {
        r.status = 302;
        r.headers.location = "https://example.org/private";
      },
      (r) => {
        r.status = 429;
      },
      (r) => {
        r.url = "https://example.org";
      },
      (r) => {
        r.headers.Link = '<https://example.org/private>; rel="next"';
      },
      (r) => {
        r.headers["Content-Type"] = "application/json";
      },
      (r) => {
        r.headers["content-type"] = "text/html";
      },
      (r) => {
        r.headers["content-encoding"] = "gzip";
      },
      (r) => {
        r.headers.other = "x".repeat(16385);
      },
      (r) => {
        r.body = new Uint8Array(1048577);
      },
      (r) => {
        r.body = Uint8Array.from([255]);
      },
      (r) => {
        r.body = Buffer.from("invented private malformed response");
      },
      (r) => {
        edited(r, (e) => {
          e.success = false;
        });
      },
      (r) => {
        edited(r, (e) => {
          e.errors = [{ code: 1000, message: "invented private token" }];
        });
      },
    ];
    for (const edit of faults) {
      const f = cloudflare();
      await refusal(
        f
          .writer(async (r) => {
            const result = await f.transport(r);
            edit(result);
            return result;
          })
          .write(publication()),
      );
      expect(f.seen.every((r) => r.method === "GET")).toBe(true);
    }
    const f = cloudflare();
    await refusal(
      f
        .writer(async () => {
          throw new Error("invented private network exception");
        })
        .read(publication()),
    );
  });
  test("expired session/fence, backwards clocks and late acknowledgements fail without retry", async () => {
    const expired = cloudflare();
    let clock = instant;
    await refusal(
      expired
        .writer(
          expired.transport,
          () => clock,
          async () => {
            clock += 60_001;
          },
        )
        .write(publication()),
    );
    expect(expired.seen.map((r) => r.method)).toEqual(["GET"]);
    const backwards = cloudflare();
    let ticks = 0;
    await refusal(
      backwards
        .writer(backwards.transport, () => instant + (++ticks < 3 ? 10 : 5))
        .read(publication()),
    );
    const late = cloudflare();
    let time = instant;
    await refusal(
      late
        .writer(
          async (r) => {
            const result = await late.transport(r);
            if (r.method === "POST") time += 60_001;
            return result;
          },
          () => time,
        )
        .write(publication()),
    );
    expect(late.seen.map((r) => r.method)).toEqual(["GET", "POST"]);
    expect(late.records).toHaveLength(1);
  });
});
