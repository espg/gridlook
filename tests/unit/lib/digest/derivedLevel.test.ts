import { describe, expect, it } from "vitest";

import {
  createPooledDigests,
  derivedGroup,
  summedField,
} from "@/lib/digest/derivedLevel.ts";
import { digestCell, digestField } from "@/lib/digest/digestField.ts";
import {
  createDenseReader,
  createDigestReader,
} from "@/lib/digest/digestReader.ts";
import { digestQuantile, digestWeight } from "@/lib/digest/tdigest.ts";

const LEAF_ORDER = 19;
const CHUNK_CELLS = 4096;
const ORDERS = [14, 15, 16, 17, 18];
const PATH = "19/h_tdigest_signal";
const COUNT = "19/count";
const encoder = new TextEncoder();

/** A reproducible stream of numbers in [0, 1). */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** The photons of the leaf cells of one chunk; most cells have none. */
function photons(seed: number) {
  const next = random(seed);
  return Array.from({ length: CHUNK_CELLS }, () =>
    next() < 0.2
      ? Float32Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
          Math.fround(next() * 100)
        ).sort()
      : new Float32Array()
  );
}

/** A `vlen-bytes` chunk of weight-1 centroids, or of `weights[cell]`. */
function frame(cells: Float32Array[], weights?: Map<number, number[]>) {
  const total = cells.reduce((sum, cell) => sum + cell.length, 0);
  const bytes = new Uint8Array(4 + 4 * cells.length + 8 * total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, cells.length, true);
  let at = 4;
  cells.forEach((cell, index) => {
    view.setUint32(at, cell.length * 8, true);
    at += 4;
    cell.forEach((mean, k) => {
      view.setFloat32(at, mean, true);
      view.setFloat32(at + 4, weights?.get(index)?.[k] ?? 1, true);
      at += 8;
    });
  });
  return bytes;
}

const metadata = (codec: string, type: string) => ({
  shape: [1, 12 * 4 ** LEAF_ORDER],
  data_type: type, // eslint-disable-line camelcase
  chunk_grid: { configuration: { chunk_shape: [1, CHUNK_CELLS] } }, // eslint-disable-line camelcase
  codecs: [{ name: codec, configuration: {} }],
});

/** Leaf chunks 0 and 2 of a store; chunk 1 is outside its coverage. */
function leaves(weights?: Map<number, number[]>) {
  const cells = [photons(1), undefined, photons(2)];
  const requests: string[] = [];
  const store = {
    async get(key: string) {
      requests.push(key);
      if (key.endsWith("/zarr.json")) {
        return encoder.encode(
          JSON.stringify(
            key.includes("count")
              ? metadata("bytes", "int32")
              : metadata("vlen-bytes", "variable_length_bytes")
          )
        );
      }
      const chunk = cells[Number(key.split("/").at(-1))];
      if (!chunk) {
        return undefined;
      }
      return key.includes("count")
        ? new Uint8Array(Int32Array.from(chunk, (cell) => cell.length).buffer)
        : frame(chunk, weights);
    },
  };
  const digests = createDigestReader(store);
  return {
    cells,
    requests,
    pooled: createPooledDigests(digests),
    dense: createDenseReader(store),
  };
}

/** The photons below derived cell `cell` of chunk 0, ascending. */
function pooledPhotons(cells: Float32Array[], group: number, cell: number) {
  return Float32Array.from(
    cells.slice(cell * group, (cell + 1) * group).flatMap((leaf) => [...leaf])
  ).sort();
}

// eslint-disable-next-line max-lines-per-function
describe("a level derived from the leaf chunks", () => {
  it.each(ORDERS)("maps a chunk onto its cells of order %i", async (order) => {
    const { pooled, cells } = leaves();
    const group = derivedGroup(LEAF_ORDER - order);
    const source = pooled.at(group);
    const grid = await source.array(PATH);
    // chunk n holds the cells [n · 4^(k−13), (n + 1) · 4^(k−13))
    expect(grid.chunkCells).toBe(4 ** (order - 13));
    expect(grid.cells).toBe(12 * 4 ** order);
    const chunk = (await source.chunk(PATH, 0))!;
    expect(chunk.offsets).toHaveLength(grid.chunkCells + 1);
    // leaf cell j belongs to derived cell j >> 2 · (19 − k)
    for (const leaf of [0, 1, group - 1, group, CHUNK_CELLS - 1]) {
      const cell = leaf >> (2 * (LEAF_ORDER - order));
      expect(cell).toBe(Math.floor(leaf / group));
      const run = [
        ...chunk.means.subarray(chunk.offsets[cell], chunk.offsets[cell + 1]),
      ];
      for (const photon of cells[0]![leaf]) {
        expect(run).toContain(photon);
      }
    }
  });

  it.each(ORDERS)(
    "pools to the quantile of the concatenated photons at order %i",
    async (order) => {
      const { pooled, cells } = leaves();
      const group = derivedGroup(LEAF_ORDER - order);
      const chunk = (await pooled.at(group).chunk(PATH, 0))!;
      for (let cell = 0; cell < CHUNK_CELLS / group; cell++) {
        const sorted = pooledPhotons(cells[0]!, group, cell);
        expect(digestWeight(chunk, cell)).toBe(sorted.length);
        for (const q of [0, 0.02, 0.5, 0.98, 1]) {
          const expected = sorted.length
            ? sorted[Math.ceil(q * (sorted.length - 1))]
            : NaN;
          expect(digestQuantile(chunk, cell, q)).toBe(expected);
        }
      }
    }
  );

  it("pools order 18 down to order 14 to the same digests", async () => {
    const { pooled } = leaves();
    const fine = (await pooled.at(derivedGroup(1)).chunk(PATH, 0))!;
    const coarse = (await pooled.at(derivedGroup(5)).chunk(PATH, 0))!;
    for (let cell = 0; cell < 4; cell++) {
      // the order-18 cells below one order-14 cell, pooled again
      const members = fine.means
        .slice(fine.offsets[cell * 256], fine.offsets[(cell + 1) * 256])
        .sort();
      expect(
        coarse.means.subarray(coarse.offsets[cell], coarse.offsets[cell + 1])
      ).toEqual(members);
    }
  });

  it("keeps the weight of a lossy leaf centroid with its mean", async () => {
    const { pooled, cells } = leaves(new Map([[0, [7, 3]]]));
    cells[0]![0] = Float32Array.of(50, 60);
    const chunk = (await pooled.at(derivedGroup(5)).chunk(PATH, 0))!;
    // the same centroids as one digest, sorted with their weights
    const pairs = cells[0]!
      .slice(0, 1024)
      .flatMap((leaf, index) =>
        [...leaf].map((mean, k) => [mean, index === 0 ? [7, 3][k] : 1])
      )
      .sort((a, b) => a[0] - b[0]);
    const reference = {
      offsets: Uint32Array.of(0, pairs.length),
      means: Float32Array.from(pairs, ([mean]) => mean),
      weights: Float32Array.from(pairs, ([, weight]) => weight),
    };
    expect(digestWeight(chunk, 0)).toBe(pairs.length + 8);
    for (const q of [0, 0.1, 0.5, 0.9, 1]) {
      expect(digestQuantile(chunk, 0, q)).toBe(digestQuantile(reference, 0, q));
    }
  });

  it("sums the leaf counts, exactly", async () => {
    const { dense, cells } = leaves();
    const leafSum = cells[0]!.reduce((sum, cell) => sum + cell.length, 0);
    for (const order of ORDERS) {
      const group = derivedGroup(LEAF_ORDER - order);
      const field = await summedField(dense, COUNT, group, 0, 4096 / group);
      expect(field.reduce((sum, value) => sum + value, 0)).toBe(leafSum);
      expect(field[1]).toBe(pooledPhotons(cells[0]!, group, 1).length);
    }
  });

  it("is NaN without photons and outside the coverage, not an error", async () => {
    const { pooled, dense } = leaves();
    const group = derivedGroup(1);
    const perChunk = CHUNK_CELLS / group;
    const params = { percentile: 50, low: 2, high: 98 };
    const median = await digestField(
      pooled.at(group),
      PATH,
      { product: "percentile" },
      params,
      perChunk - 2,
      2 * perChunk + 2
    );
    expect(median).toHaveLength(perChunk + 4);
    // chunk 1 does not exist
    expect([...median.subarray(2, perChunk + 2)].every(Number.isNaN)).toBe(
      true
    );
    const chunk = (await pooled.at(group).chunk(PATH, 2))!;
    expect(median[perChunk + 2]).toBe(digestQuantile(chunk, 0, 0.5));
    expect(await pooled.at(group).chunk(PATH, 1)).toBeNull();
    const count = await summedField(dense, COUNT, group, 0, 3 * perChunk);
    expect(Number.isNaN(count[perChunk])).toBe(true);
    expect(Number.isNaN(count[0])).toBe(false);
    const empty = [...count.subarray(0, perChunk)].indexOf(0);
    expect(empty).toBeGreaterThanOrEqual(0);
    const field = await digestField(
      pooled.at(group),
      PATH,
      { product: "range" },
      params,
      empty,
      empty + 1
    );
    expect(field[0]).toBeNaN();
  });

  it("reads a leaf chunk once for every order and percentile", async () => {
    const { pooled, requests } = leaves();
    for (const order of ORDERS) {
      const source = pooled.at(derivedGroup(LEAF_ORDER - order));
      for (const percentile of [10, 50, 90]) {
        await digestField(
          source,
          PATH,
          { product: "percentile" },
          { percentile, low: 2, high: 98 },
          0,
          4
        );
      }
      // a hover reads nothing: the pooled cell comes from memory
      expect(await digestCell(source, PATH, 1, true)).toBeTruthy();
      expect(await digestCell(source, PATH, 4 ** (order - 13), true)).toBe(
        undefined
      );
    }
    expect(requests.filter((key) => key.includes("/c/"))).toEqual([
      `/${PATH}/c/0/0`,
    ]);
  });
});
