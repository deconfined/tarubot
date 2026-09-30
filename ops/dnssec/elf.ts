/** Review every ELF dynamic dependency before execution so the private loader cannot fall back. */
import { Buffer } from "node:buffer";

function valid(value: unknown): asserts value {
  if (!value) throw new Error("invalid-local-dnssec");
}

/** ELF64 little-endian x86-64 only. The exact bytes are separately authenticated by owner pins. */
export function verifyElfClosure(bytes: Uint8Array, libraries: ReadonlySet<string>): void {
  const b = Buffer.from(bytes);
  valid(
    b.length >= 64 &&
      b.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) &&
      [2, 3].includes(b.readUInt16LE(16)) &&
      b.readUInt16LE(18) === 62 &&
      b.readUInt32LE(20) === 1 &&
      b.readUInt16LE(52) === 64 &&
      b.readUInt16LE(54) === 56,
  );
  const integer64 = (offset: number): number => {
    valid(offset >= 0 && offset + 8 <= b.length);
    const n = b.readBigUInt64LE(offset);
    valid(n <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(n);
  };
  const range = (offset: number, size: number): void => {
    valid(
      Number.isSafeInteger(offset) &&
        Number.isSafeInteger(size) &&
        offset >= 0 &&
        size >= 0 &&
        offset <= b.length &&
        size <= b.length - offset,
    );
  };
  const table = integer64(32);
  const count = b.readUInt16LE(56);
  valid(count >= 1 && count <= 256);
  range(table, count * 56);
  const segments: { type: number; offset: number; address: number; size: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 56;
    const type = b.readUInt32LE(at);
    const offset = integer64(at + 8);
    const address = integer64(at + 16);
    const size = integer64(at + 32);
    const memorySize = integer64(at + 40);
    range(offset, size);
    valid(memorySize >= size && Number.isSafeInteger(address + memorySize));
    segments.push({ type, offset, address, size });
  }
  const dynamic = segments.filter((segment) => segment.type === 2);
  valid(dynamic.length === 1);
  const d = dynamic[0];
  valid(d && d.size >= 16 && d.size <= 65536 && d.size % 16 === 0);
  const loads = segments.filter((segment) => segment.type === 1);
  valid(loads.length > 0);
  const location = (address: number, size: number): number => {
    const mappings = loads.filter(
      (segment) =>
        address >= segment.address &&
        address - segment.address <= segment.size &&
        size <= segment.size - (address - segment.address),
    );
    valid(mappings.length === 1);
    const mapping = mappings[0];
    valid(mapping);
    return mapping.offset + address - mapping.address;
  };
  valid(location(d.address, d.size) === d.offset);
  const values = new Map<number, number[]>();
  // GNU audit/filter tags can introduce executable dependencies outside DT_NEEDED.
  const forbidden = new Set([15, 29, 0x6ffffefb, 0x6ffffefc, 0x7ffffffd, 0x7fffffff]);
  let terminated = false;
  for (let offset = d.offset; offset < d.offset + d.size; offset += 16) {
    const tag = integer64(offset);
    const value = integer64(offset + 8);
    if (tag === 0) {
      terminated = true;
      break;
    }
    valid(!forbidden.has(tag));
    if ([1, 5, 10].includes(tag)) {
      const entries = values.get(tag) ?? [];
      entries.push(value);
      values.set(tag, entries);
    }
  }
  valid(terminated);
  const tables = values.get(5);
  const sizes = values.get(10);
  valid(tables?.length === 1 && sizes?.length === 1);
  const strings = tables[0];
  const size = sizes[0];
  valid(strings !== undefined && size !== undefined && size > 0 && size <= b.length);
  const stringsAt = location(strings, size);
  range(stringsAt, size);
  const seen = new Set<string>();
  const dependencies = values.get(1) ?? [];
  valid(dependencies.length <= libraries.size);
  for (const index of dependencies) {
    valid(index > 0 && index < size);
    const start = stringsAt + index;
    const end = b.indexOf(0, start);
    valid(end > start && end < stringsAt + size && end - start <= 128);
    const name = b.subarray(start, end).toString("ascii");
    valid(
      /^[a-zA-Z0-9_.-]+$/u.test(name) &&
        Buffer.from(name, "ascii").equals(b.subarray(start, end)) &&
        libraries.has(name) &&
        !seen.has(name),
    );
    seen.add(name);
  }
}
