import { describe, expect, it } from "vitest";

import { digestCell, digestField } from "@/lib/digest/digestField.ts";
import { probePercentiles } from "@/lib/digest/digestProbe.ts";
import type { TDigestSource } from "@/lib/digest/digestReader.ts";
import { digestVariablesOf } from "@/lib/digest/digestVariables.ts";
import {
  createMergedDigests,
  DEFAULT_STRATUM,
  DIGEST_STRATA,
  duplicateStratumVariables,
  isStratumChoice,
  mergeDigestCells,
  mergedPath,
  NOISE_BYTES_RATIO,
  primaryStratum,
  strataArrays,
  strataBytesFactor,
} from "@/lib/digest/strata.ts";
import { digestQuantile, digestWeight } from "@/lib/digest/tdigest.ts";

type TCell = [mean: number, weight: number][];

/** A chunk of cells, each a list of `(mean, weight)` centroids. */
function chunk(cells: TCell[]) {
  const offsets = new Uint32Array(cells.length + 1);
  cells.forEach((cell, i) => (offsets[i + 1] = offsets[i] + cell.length));
  const flat = cells.flat();
  return {
    offsets,
    means: Float32Array.from(flat, ([mean]) => mean),
    weights: Float32Array.from(flat, ([, weight]) => weight),
  };
}

const SIGNAL = "19/h_tdigest_signal";
const NOISE = "19/h_tdigest_noise";
const BOTH = mergedPath([SIGNAL, NOISE]);

/** Two arrays of one chunk of three cells; `inMemory` is what `peek` sees. */
function source(inMemory = new Set<string>()) {
  const chunks: Record<string, ReturnType<typeof chunk>[]> = {
    [SIGNAL]: [
      chunk([
        [
          [10, 1],
          [30, 1],
        ],
        [[5, 2]],
        [],
      ]),
    ],
    [NOISE]: [
      chunk([
        [
          [20, 1],
          [40, 1],
        ],
        [],
        [],
      ]),
      chunk([[[1, 1]], [[2, 1]], [[3, 1]]]),
    ],
  };
  const reads: string[] = [];
  const stub: TDigestSource = {
    array: async () => ({
      cells: 6,
      chunkCells: 3,
      decode: async () => chunk([]),
    }),
    chunk: async (path, index) => {
      reads.push(`${path}/${index}`);
      return chunks[path]?.[index] ?? null;
    },
    peek: (path, index) =>
      inMemory.has(path) ? (chunks[path]?.[index] ?? null) : undefined,
  };
  return { reads, merged: createMergedDigests({ at: () => stub }).at(1) };
}

const attrs = { ragged: { element: { dtype: "float32", shape: [-1, 2] } } };
const vars = Object.fromEntries(
  ["h_tdigest_signal", "h_tdigest_noise"].flatMap((name) =>
    Object.entries(digestVariablesOf(name, attrs)).map(
      ([variable, { attributes }]) => [variable, { attrs: attributes }]
    )
  )
);
const signal = { array: "h_tdigest_signal", stratum: "signal" };

describe("the stratum choice", () => {
  it("names the arrays a choice reads, the signal first under both", () => {
    expect(DEFAULT_STRATUM).toBe(DIGEST_STRATA.SIGNAL);
    expect(strataArrays(signal, vars, DIGEST_STRATA.SIGNAL)).toEqual([signal]);
    expect(strataArrays(signal, vars, DIGEST_STRATA.NOISE)).toEqual([
      { array: "h_tdigest_noise", stratum: "noise" },
    ]);
    expect(strataArrays(signal, vars, DIGEST_STRATA.BOTH)).toEqual([
      signal,
      { array: "h_tdigest_noise", stratum: "noise" },
    ]);
    // a store with one stratum reads its own array whatever the choice
    const only = { h_percentile_signal: vars.h_percentile_signal }; // eslint-disable-line camelcase
    expect(strataArrays(signal, only, DIGEST_STRATA.BOTH)).toEqual([signal]);
    expect(strataArrays(signal, only, DIGEST_STRATA.NOISE)).toEqual([signal]);
    // another quantity's strata are not this one's
    const slope = { array: "slope_tdigest_signal", stratum: "signal" };
    expect(strataArrays(slope, vars, DIGEST_STRATA.NOISE)).toEqual([slope]);
  });

  it("validates a choice, draws the signal first and prices every stratum read", () => {
    expect(isStratumChoice("noise")).toBe(true);
    expect(isStratumChoice("all")).toBe(false);
    expect(primaryStratum(DIGEST_STRATA.BOTH)).toBe("signal");
    expect(primaryStratum(DIGEST_STRATA.NOISE)).toBe("noise");
    expect(strataBytesFactor(DIGEST_STRATA.SIGNAL)).toEqual({
      cell: 1,
      chunk: 1,
    });
    expect(strataBytesFactor(DIGEST_STRATA.NOISE)).toEqual(NOISE_BYTES_RATIO);
    expect(strataBytesFactor(DIGEST_STRATA.BOTH)).toEqual({
      cell: 1 + NOISE_BYTES_RATIO.cell,
      chunk: 1 + NOISE_BYTES_RATIO.chunk,
    });
    // the noise weighs more at the leaves, one centroid per photon
    expect(NOISE_BYTES_RATIO.chunk).toBeGreaterThan(NOISE_BYTES_RATIO.cell);
    expect(NOISE_BYTES_RATIO.cell).toBeGreaterThan(1);
  });

  it("leaves the noise variables out of the selector unless one is selected", () => {
    expect([...duplicateStratumVariables(vars)]).toEqual([
      "h_percentile_noise",
      "h_range_noise",
    ]);
    expect([...duplicateStratumVariables(vars, "h_range_noise")]).toEqual([
      "h_percentile_noise",
    ]);
    const only = { h_range_noise: vars.h_range_noise }; // eslint-disable-line camelcase
    expect(duplicateStratumVariables(only).size).toBe(0);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("the merged digests", () => {
  it("merges the strata cell by cell: centroids sorted by mean, weights kept, counts summed", async () => {
    const { merged, reads } = source();
    const both = (await merged.chunk(BOTH, 0))!;
    expect(reads).toEqual([`${SIGNAL}/0`, `${NOISE}/0`]);
    expect([...both.offsets]).toEqual([0, 4, 5, 5]);
    expect([...both.means]).toEqual([10, 20, 30, 40, 5]);
    expect([...both.weights]).toEqual([1, 1, 1, 1, 2]);
    expect(digestWeight(both, 0)).toBe(4);
    // a digest merged with an empty cell is itself
    expect(digestQuantile(both, 1, 0.5)).toBe(5);
    expect(digestWeight(both, 1)).toBe(2);
    // merged again: in memory, nothing read
    expect(await merged.chunk(BOTH, 0)).toBe(both);
    expect(reads).toHaveLength(2);
  });

  it("is the one stratum where the store has no chunk of the other, and null without either", async () => {
    const { merged } = source();
    const noise = (await merged.chunk(NOISE, 1))!;
    expect(await merged.chunk(BOTH, 1)).toBe(noise);
    expect(await merged.chunk(BOTH, 7)).toBeNull();
    // a single path passes through
    expect(await merged.chunk(SIGNAL, 0)).toEqual(
      chunk([
        [
          [10, 1],
          [30, 1],
        ],
        [[5, 2]],
        [],
      ])
    );
    expect((await merged.array(BOTH)).chunkCells).toBe(3);
  });

  it("takes the merged quantile of two single-centroid digests as their weighted order statistic", () => {
    const merged = mergeDigestCells([
      { chunk: chunk([[[100, 1]]]), cell: 0 },
      { chunk: chunk([[[0, 3]]]), cell: 0 },
    ])!;
    expect([...merged.chunk.means]).toEqual([0, 100]);
    expect([...merged.chunk.weights]).toEqual([3, 1]);
    expect(digestWeight(merged.chunk, 0)).toBe(4);
    // zagg's law over the weights: ranks 0..2 are the heavy centroid, rank
    // 3 the light one; the median, rank 1.5, interpolates from the heavy
    // mean towards the midpoint of the two, the top ranks are the light one
    expect(digestQuantile(merged.chunk, 0, 0)).toBe(0);
    expect(digestQuantile(merged.chunk, 0, 0.5)).toBeCloseTo(37.5);
    expect(digestQuantile(merged.chunk, 0, 0.75)).toBe(100);
    expect(digestQuantile(merged.chunk, 0, 1)).toBe(100);
    expect(mergeDigestCells([])).toBeNull();
  });

  it("peeks only when every stratum is in memory", async () => {
    const { merged } = source(new Set([SIGNAL]));
    expect(merged.peek(BOTH, 0)).toBeUndefined();
    expect(merged.peek(SIGNAL, 0)).toBeDefined();
    const { merged: all } = source(new Set([SIGNAL, NOISE]));
    expect([...all.peek(BOTH, 0)!.means]).toEqual([10, 20, 30, 40, 5]);
    expect(await digestCell(all, BOTH, 1, true)).toEqual({
      chunk: all.peek(BOTH, 0),
      cell: 1,
    });
  });

  it("serves a field and a probe under both", async () => {
    const { merged } = source();
    const params = { percentile: 50, low: 0, high: 100 };
    const field = await digestField(
      merged,
      BOTH,
      { product: "percentile" },
      params,
      0,
      3
    );
    // cell 0: ranks 0..3 over 10, 20, 30, 40, rank 1.5 within the third
    expect([...field]).toEqual([30, 5, NaN]);
    const probe = {
      lat: 0,
      lon: 0,
      cell: 0,
      order: 13,
      pinned: true,
      strata: [
        { name: "signal", digest: await digestCell(merged, SIGNAL, 0) },
        { name: "noise", digest: await digestCell(merged, NOISE, 0) },
      ],
    };
    expect(probePercentiles(probe, [50], DIGEST_STRATA.BOTH)).toEqual({
      stratum: "signal + noise",
      weight: 4,
      values: [{ percentile: 50, value: 30 }],
    });
    expect(probePercentiles(probe, [50], DIGEST_STRATA.NOISE)?.values).toEqual([
      { percentile: 50, value: 40 },
    ]);
  });
});
