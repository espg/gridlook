import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { createHiveStore } from "@/lib/data/hiveStore.ts";
import { parseMortonDecimal } from "@/lib/morton/decimal.ts";
import { wordToNested } from "@/lib/morton/word.ts";

const SHARD = "4331422233";
const LEAF = "4/3/3/1/4/2/2/2/3/3/4331422233.zarr";
const COLUMN = "4/3/3/1/4/2/2/2/3/3/all.pyramid.zarr";
const OVERVIEW = "4/3/3/1/4/2/2/2/3/all.zarr";
const CELLS_PER_LEAF = 4 ** 10;
const INNER = 4096;
const CHUNKS = CELLS_PER_LEAF / INNER;
const ABSENT = 0xffffffffffffffffn;

const rank = (id: string) =>
  Number(wordToNested(parseMortonDecimal(id)).nested);
const r9 = rank(SHARD);
const r8 = rank(SHARD.slice(0, -1));

const manifest = {
  spec: "morton-hive/1",
  cell_order: 19, // eslint-disable-line camelcase
  shard_order: 9, // eslint-disable-line camelcase
  path_grouping: 1, // eslint-disable-line camelcase
  multiscales: [
    {
      spec: "zagg-multiscales/1",
      base: { order: 9, cells: [19] },
      datasets: [
        { order: 9, cells: [13], artifact: "column" },
        { order: 8, cells: [12], artifact: "overview" },
      ],
      fields: { count: "exact" },
    },
  ],
};
const coverage = {
  spec: "morton-moc/1",
  encoding: "ranges",
  order: 9,
  ranges: [[SHARD, SHARD]],
};
const group = (attributes: object) => ({
  zarr_format: 3, // eslint-disable-line camelcase
  node_type: "group", // eslint-disable-line camelcase
  attributes,
});
const array = (shape: number[], codecs: unknown[]) => ({
  zarr_format: 3, // eslint-disable-line camelcase
  node_type: "array", // eslint-disable-line camelcase
  shape,
  data_type: "int32", // eslint-disable-line camelcase
  chunk_grid: { name: "regular", configuration: { chunk_shape: shape } }, // eslint-disable-line camelcase
  chunk_key_encoding: { name: "default", configuration: { separator: "/" } }, // eslint-disable-line camelcase
  fill_value: 0, // eslint-disable-line camelcase
  codecs,
  dimension_names: ["cells"], // eslint-disable-line camelcase
  attributes: {},
});
const BYTES = { name: "bytes", configuration: { endian: "little" } };
const sharded = array(
  [CELLS_PER_LEAF],
  [
    {
      name: "sharding_indexed",
      configuration: {
        chunk_shape: [INNER], // eslint-disable-line camelcase
        codecs: [BYTES],
        index_codecs: [BYTES, { name: "crc32c" }], // eslint-disable-line camelcase
        index_location: "end", // eslint-disable-line camelcase
      },
    },
  ]
);

function int32s(count: number, offset = 0) {
  return new Uint8Array(
    Int32Array.from({ length: count }, (_, i) => i + offset).buffer
  );
}

/** A shard object holding the given inner chunks, index at the end. */
function shardObject(chunks: Map<number, Uint8Array>) {
  const index = new DataView(new ArrayBuffer(CHUNKS * 16 + 4));
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (let j = 0; j < CHUNKS; j++) {
    const chunk = chunks.get(j);
    index.setBigUint64(j * 16, chunk ? BigInt(offset) : ABSENT, true);
    index.setBigUint64(j * 16 + 8, chunk ? BigInt(chunk.length) : ABSENT, true);
    if (chunk) {
      parts.push(chunk);
      offset += chunk.length;
    }
  }
  parts.push(new Uint8Array(index.buffer));
  const object = new Uint8Array(offset + index.byteLength);
  let at = 0;
  for (const part of parts) {
    object.set(part, at);
    at += part.length;
  }
  return object;
}

function memoryStore(objects: Record<string, Uint8Array | object>) {
  const log: string[] = [];
  const encoder = new TextEncoder();
  const bytes = (value: Uint8Array | object) =>
    value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value));
  const store: zarr.AsyncReadable & { log: string[] } = {
    log,
    async get(key) {
      log.push(`get ${key}`);
      const value = objects[key.slice(1)];
      return value === undefined ? undefined : bytes(value);
    },
    async getRange(key, range) {
      log.push(`range ${key} ${JSON.stringify(range)}`);
      const value = objects[key.slice(1)];
      if (value === undefined) {
        return undefined;
      }
      const all = bytes(value);
      return "suffixLength" in range
        ? all.slice(all.length - range.suffixLength)
        : all.slice(range.offset, range.offset + range.length);
    },
  };
  return store;
}

function hive(leafDir = LEAF, stamp: object = {}) {
  return memoryStore({
    "morton_hive.json": manifest,
    "coverage.moc": coverage,
    [`${LEAF}/zarr.json`]: group({ morton_hive_commit: stamp }), // eslint-disable-line camelcase
    [`${leafDir}/19/zarr.json`]: group({ dggs: { name: "morton" } }),
    [`${leafDir}/19/count/zarr.json`]: sharded,
    [`${leafDir}/19/count/c/0`]: shardObject(new Map([[1, int32s(INNER)]])),
    [`${COLUMN}/13/zarr.json`]: group({ role: "column" }),
    [`${COLUMN}/13/count/zarr.json`]: array([256], [BYTES]),
    [`${COLUMN}/13/count/c/0`]: int32s(256, 1000),
    [`${OVERVIEW}/12/zarr.json`]: group({ role: "overview" }),
    [`${OVERVIEW}/12/count/zarr.json`]: array([256], [BYTES]),
    [`${OVERVIEW}/12/count/c/0`]: int32s(256, 2000),
  });
}

const decode = (bytes: Uint8Array | undefined) =>
  JSON.parse(new TextDecoder().decode(bytes));

// the levels computed from the leaves, between the column and the leaves
const DERIVED = /^\/1[4-8](\/|$)/;

describe("createHiveStore", () => {
  it("lists one group per level with the leaf's arrays", async () => {
    const store = await createHiveStore("mem://hive", hive());
    expect(store.contents().filter(({ path }) => !DERIVED.test(path))).toEqual([
      { path: "/", kind: "group" },
      { path: "/19", kind: "group" },
      { path: "/19/count", kind: "array" },
      { path: "/13", kind: "group" },
      { path: "/13/count", kind: "array" },
      { path: "/12", kind: "group" },
      { path: "/12/count", kind: "array" },
    ]);
    expect(
      decode(await store.get("/zarr.json")).attributes.multiscales
    ).toEqual(manifest.multiscales);
    expect(decode(await store.get("/19/zarr.json")).attributes.dggs).toEqual({
      name: "morton",
    });
  });

  it("re-roots an array on the sphere behind a row axis", async () => {
    const store = await createHiveStore("mem://hive", hive());
    const leaf = decode(await store.get("/19/count/zarr.json"));
    expect(leaf.shape).toEqual([1, 12 * 4 ** 19]);
    expect(leaf.chunk_grid.configuration.chunk_shape).toEqual([1, INNER]);
    expect(leaf.codecs).toEqual([BYTES]);
    expect(leaf.dimension_names).toEqual(["window", "cells"]);
    const column = decode(await store.get("/13/count/zarr.json"));
    expect(column.shape).toEqual([1, 12 * 4 ** 13]);
    expect(column.chunk_grid.configuration.chunk_shape).toEqual([1, 256]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("createHiveStore with a t-digest field", () => {
  const digest = {
    ...array([256], [{ name: "vlen-bytes" }, { name: "zstd" }]),
    data_type: "variable_length_bytes", // eslint-disable-line camelcase
    fill_value: "", // eslint-disable-line camelcase
    attributes: {
      ragged: {
        spec: "zagg-ragged/1",
        element: { dtype: "float32", shape: [-1, 2] },
        locations: "h_tdigest_signal_locations",
      },
    },
  };
  const withDigest = () => {
    const inner = hive();
    const objects: Record<string, object | Uint8Array> = {
      "morton_hive.json": {
        ...manifest,
        multiscales: [
          {
            ...manifest.multiscales[0],
            fields: { count: "exact", h_tdigest_signal: "approximate" }, // eslint-disable-line camelcase
          },
        ],
      },
      [`${LEAF}/19/h_tdigest_signal/zarr.json`]: digest,
      [`${OVERVIEW}/12/h_tdigest_signal/zarr.json`]: digest,
      [`${OVERVIEW}/12/h_tdigest_signal/c/0`]: Uint8Array.of(1, 2, 3),
    };
    const encoder = new TextEncoder();
    return {
      ...inner,
      async get(key: zarr.AbsolutePath) {
        const value = objects[key.slice(1)];
        if (value === undefined) {
          return inner.get(key);
        }
        inner.log.push(`get ${key}`);
        return value instanceof Uint8Array
          ? value
          : encoder.encode(JSON.stringify(value));
      },
    };
  };

  it("lists the variables derived from it beside it", async () => {
    const store = await createHiveStore("mem://hive", withDigest());
    expect(
      store
        .contents()
        .filter(({ path }) => path.startsWith("/12/"))
        .map(({ path }) => path)
    ).toEqual([
      "/12/count",
      "/12/h_tdigest_signal",
      "/12/h_percentile_signal",
      "/12/h_range_signal",
      "/12/h_tdigest_signal_locations",
    ]);
    // a derived level: what sums exactly and the digest variables only
    expect(
      store
        .contents()
        .filter(({ path }) => path.startsWith("/16/"))
        .map(({ path }) => path)
    ).toEqual(["/16/count", "/16/h_percentile_signal", "/16/h_range_signal"]);
    const derived = decode(await store.get("/16/h_range_signal/zarr.json"));
    expect(derived.data_type).toBe("float32");
    expect(derived.shape).toEqual([1, 12 * 4 ** 16]);
    expect(derived.attributes.digest.array).toBe("h_tdigest_signal");
  });

  it("opens a derived variable as float32 on the digest's grid, without chunks", async () => {
    const inner = withDigest();
    const store = await createHiveStore("mem://hive", inner);
    const root = await zarr.open.v3(store, { kind: "group" });
    const percentile = await zarr.open.v3(
      root.resolve("/12/h_percentile_signal"),
      { kind: "array" }
    );
    expect(percentile.dtype).toBe("float32");
    expect(percentile.shape).toEqual([1, 12 * 4 ** 12]);
    expect(percentile.chunks).toEqual([1, 256]);
    expect(percentile.attrs).toMatchObject({
      long_name: "height percentile (signal)", // eslint-disable-line camelcase
      digest: { array: "h_tdigest_signal", product: "percentile" },
    });
    const before = inner.log.length;
    expect(
      await store.get(`/12/h_percentile_signal/c/0/${r8}`)
    ).toBeUndefined();
    expect(inner.log).toHaveLength(before);
    // zarrita cannot open the digest itself; its chunks are served as stored
    await expect(
      zarr.open.v3(root.resolve("/12/h_tdigest_signal"), { kind: "array" })
    ).rejects.toThrow();
    expect(await store.get(`/12/h_tdigest_signal/c/0/${r8}`)).toEqual(
      Uint8Array.of(1, 2, 3)
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("createHiveStore levels derived from the leaves", () => {
  it("lists the orders between the leaf chunk's and the leaves'", async () => {
    const store = await createHiveStore("mem://hive", hive());
    expect(
      store
        .contents()
        .filter(({ path }) => DERIVED.test(path))
        .map(({ path }) => path)
    ).toEqual(
      [18, 17, 16, 15, 14].flatMap((order) => [`/${order}`, `/${order}/count`])
    );
    expect(
      decode(await store.get("/zarr.json")).attributes.derived_levels
    ).toEqual({ dataset: "19", cells: [18, 17, 16, 15, 14] });
  });

  it("grids a derived array chunk for chunk on the leaves'", async () => {
    const store = await createHiveStore("mem://hive", hive());
    for (const order of [14, 15, 16, 17, 18]) {
      const count = decode(await store.get(`/${order}/count/zarr.json`));
      expect(count.shape).toEqual([1, 12 * 4 ** order]);
      // one chunk is one order-13 cell, as a leaf chunk is
      expect(count.chunk_grid.configuration.chunk_shape).toEqual([
        1,
        4 ** (order - 13),
      ]);
      expect(
        count.shape[1] / count.chunk_grid.configuration.chunk_shape[1]
      ).toBe((12 * 4 ** 19) / INNER);
    }
    expect(decode(await store.get("/15/zarr.json")).attributes.dggs).toEqual({
      name: "morton",
      refinement_level: 15, // eslint-disable-line camelcase
    });
    expect(await store.get("/15/morton/zarr.json")).toBeUndefined();
  });

  it("serves no chunk of a derived level and reads nothing for one", async () => {
    const inner = hive();
    const store = await createHiveStore("mem://hive", inner);
    const before = inner.log.length;
    expect(await store.get(`/15/count/c/0/${r9 * CHUNKS + 1}`)).toBeUndefined();
    expect(inner.log).toHaveLength(before);
  });

  it("derives nothing without a stored level beneath the leaves", async () => {
    const inner = hive();
    const leafOnly = {
      ...manifest,
      multiscales: [{ ...manifest.multiscales[0], datasets: [] }],
    };
    const store = await createHiveStore("mem://hive", {
      ...inner,
      get: async (key) =>
        key === "/morton_hive.json"
          ? new TextEncoder().encode(JSON.stringify(leafOnly))
          : inner.get(key),
    });
    expect(store.contents().map(({ path }) => path)).toEqual([
      "/",
      "/19",
      "/19/count",
    ]);
    expect(
      decode(await store.get("/zarr.json")).attributes.derived_levels
    ).toBeUndefined();
  });
});

describe("createHiveStore chunks", () => {
  it("reads a leaf's inner chunk as a range of its shard object", async () => {
    const inner = hive();
    const store = await createHiveStore("mem://hive", inner);
    const chunk = await store.get(`/19/count/c/0/${r9 * CHUNKS + 1}`);
    expect(chunk).toHaveLength(INNER * 4);
    expect(new Int32Array(chunk!.buffer, chunk!.byteOffset, 4)).toEqual(
      Int32Array.from([0, 1, 2, 3])
    );
    expect(inner.log).toContain(
      `range /${LEAF}/19/count/c/0 {"suffixLength":${CHUNKS * 16 + 4}}`
    );
    expect(inner.log).toContain(
      `range /${LEAF}/19/count/c/0 {"offset":0,"length":${INNER * 4}}`
    );
    // an absent inner chunk and an uncovered shard read as fill, unfetched
    expect(await store.get(`/19/count/c/0/${r9 * CHUNKS + 2}`)).toBeUndefined();
    const before = inner.log.length;
    expect(
      await store.get(`/19/count/c/0/${(r9 + 1) * CHUNKS}`)
    ).toBeUndefined();
    expect(inner.log).toHaveLength(before);
  });

  it("reads a column and an overview as whole node objects", async () => {
    const store = await createHiveStore("mem://hive", hive());
    const column = await store.get(`/13/count/c/0/${r9}`);
    expect(new Int32Array(column!.buffer, column!.byteOffset, 2)).toEqual(
      Int32Array.from([1000, 1001])
    );
    const overview = await store.get(`/12/count/c/0/${r8}`);
    expect(new Int32Array(overview!.buffer, overview!.byteOffset, 1)).toEqual(
      Int32Array.from([2000])
    );
    expect(await store.get(`/12/count/c/0/${r8 + 1}`)).toBeUndefined();
  });
});

describe("createHiveStore through zarrita", () => {
  it("follows a versioned leaf's current run", async () => {
    const store = await createHiveStore(
      "mem://hive",
      hive(`${LEAF}/run-abc-1`, { current: "run-abc-1" })
    );
    expect(await store.get(`/19/count/c/0/${r9 * CHUNKS + 1}`)).toHaveLength(
      INNER * 4
    );
  });

  it("decodes through zarrita", async () => {
    const root = await zarr.open.v3(
      await createHiveStore("mem://hive", hive()),
      { kind: "group" }
    );
    const count = await zarr.open.v3(root.resolve("/19/count"), {
      kind: "array",
    });
    const start = r9 * CELLS_PER_LEAF + INNER;
    const slab = await zarr.get(count, [0, zarr.slice(start - 2, start + 3)]);
    expect(Array.from(slab.data as Int32Array)).toEqual([0, 0, 0, 1, 2]);
  });

  it("refuses a windowed hive", async () => {
    const inner = memoryStore({
      "morton_hive.json": {
        ...manifest,
        spec: "morton-hive/2",
        temporal: { schedule: "yearly" },
      },
      "coverage.moc": coverage,
    });
    await expect(createHiveStore("mem://hive", inner)).rejects.toThrow(
      "not supported yet"
    );
  });
});
