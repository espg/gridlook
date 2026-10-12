import { describe, expect, it } from "vitest";

import {
  createByteLru,
  createDigestReader,
  digestArrayFromMetadata,
} from "@/lib/digest/digestReader.ts";

const encoder = new TextEncoder();
const metadata = (codecs: unknown[]) => ({
  shape: [1, 12],
  chunk_grid: { configuration: { chunk_shape: [1, 4] } }, // eslint-disable-line camelcase
  codecs,
});
const VLEN = { name: "vlen-bytes", configuration: {} };

/** A chunk of `cells` single-centroid digests `(mean, 1)`. */
function frame(means: number[]) {
  const bytes = new Uint8Array(4 + means.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, means.length, true);
  means.forEach((mean, cell) => {
    view.setUint32(4 + cell * 12, 8, true);
    view.setFloat32(8 + cell * 12, mean, true);
    view.setFloat32(12 + cell * 12, 1, true);
  });
  return bytes;
}

function fakeStore(chunks: Record<number, number[]>) {
  const requests: string[] = [];
  return {
    requests,
    async get(key: string) {
      requests.push(key);
      if (key === "/8/h/zarr.json") {
        return encoder.encode(JSON.stringify(metadata([VLEN])));
      }
      const match = /^\/8\/h\/c\/0\/(\d+)$/.exec(key);
      const means = match ? chunks[Number(match[1])] : undefined;
      return means && frame(means);
    },
  };
}

describe("digestArrayFromMetadata", () => {
  it("reads the level's cells and its chunk size", async () => {
    const array = await digestArrayFromMetadata(metadata([VLEN]));
    expect(array.cells).toBe(12);
    expect(array.chunkCells).toBe(4);
    expect([...(await array.decode(frame([3, 5]))).means]).toEqual([3, 5]);
  });

  it("refuses an array that is not vlen-bytes, and an unknown codec", async () => {
    await expect(
      digestArrayFromMetadata(metadata([{ name: "bytes" }]))
    ).rejects.toThrow(/vlen-bytes/);
    await expect(
      digestArrayFromMetadata(metadata([VLEN, { name: "no-such-codec" }]))
    ).rejects.toThrow(/no-such-codec/);
  });
});

describe("createDigestReader", () => {
  it("reads a chunk once, however often and however concurrently", async () => {
    const store = fakeStore({ 1: [1, 2, 3, 4] });
    const reader = createDigestReader(store);
    expect(reader.peek("8/h", 1)).toBeUndefined();
    const [first, second] = await Promise.all([
      reader.chunk("8/h", 1),
      reader.chunk("8/h", 1),
    ]);
    expect(first).toBe(second);
    expect([...first!.means]).toEqual([1, 2, 3, 4]);
    expect(reader.peek("8/h", 1)).toBe(first);
    await reader.chunk("8/h", 1);
    expect(store.requests).toEqual(["/8/h/zarr.json", "/8/h/c/0/1"]);
  });

  it("remembers a chunk the store does not have as null", async () => {
    const store = fakeStore({});
    const reader = createDigestReader(store);
    expect(await reader.chunk("8/h", 2)).toBeNull();
    expect(reader.peek("8/h", 2)).toBeNull();
    await reader.chunk("8/h", 2);
    expect(store.requests.filter((key) => key.endsWith("/c/0/2"))).toHaveLength(
      1
    );
  });

  it("drops the least recently used chunks beyond its byte bound", async () => {
    const store = fakeStore({
      0: [1, 2, 3, 4],
      1: [5, 6, 7, 8],
      2: [9, 9, 9, 9],
    });
    // one chunk: 5 offsets, 4 means, 4 weights, 4 bytes each
    const reader = createDigestReader(store, 2 * 52);
    await reader.chunk("8/h", 0);
    await reader.chunk("8/h", 1);
    expect(reader.cachedBytes).toBe(104);
    reader.peek("8/h", 0); // chunk 1 is now the oldest
    await reader.chunk("8/h", 2);
    expect(reader.cachedBytes).toBe(104);
    expect(reader.peek("8/h", 1)).toBeUndefined();
    expect(reader.peek("8/h", 0)).toBeDefined();
    expect(reader.peek("8/h", 2)).toBeDefined();
  });
});

describe("createByteLru", () => {
  it("keeps an entry larger than the bound until the next one arrives", () => {
    const lru = createByteLru<number>(10, (value) => value);
    lru.set("big", 50);
    expect(lru.get("big")).toBe(50);
    lru.set("small", 4);
    expect(lru.has("big")).toBe(false);
    expect(lru.bytes).toBe(4);
    lru.set("small", 6);
    expect(lru.bytes).toBe(6);
    expect(lru.size).toBe(1);
  });
});
