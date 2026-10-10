import { describe, expect, it } from "vitest";

import golden from "../../../data/tdigest_chunk_golden.json";

import { digestArrayFromMetadata } from "@/lib/digest/digestReader.ts";
import {
  digestCentroidCount,
  digestChunkFromVlen,
  digestCumulativeWeight,
  digestQuantile,
  digestQuantileRange,
  digestSeries,
  digestWeight,
  type TDigestChunk,
} from "@/lib/digest/tdigest.ts";
import { decodeVlenChunk } from "@/lib/digest/vlenChunk.ts";

const metadata = {
  shape: [1, 12 * 4 ** 12],
  chunk_grid: { configuration: { chunk_shape: [1, 256] } }, // eslint-disable-line camelcase
  codecs: [
    { name: "vlen-bytes", configuration: {} },
    { name: "zstd", configuration: { level: 3, checksum: false } },
  ],
};

async function goldenChunk() {
  const array = await digestArrayFromMetadata(metadata);
  return array.decode(
    Uint8Array.from(atob(golden.chunk), (c) => c.charCodeAt(0))
  );
}

function vlenFrame(items: Uint8Array[]) {
  const frame = new Uint8Array(
    4 + items.reduce((sum, item) => sum + 4 + item.length, 0)
  );
  const view = new DataView(frame.buffer);
  view.setUint32(0, items.length, true);
  let at = 4;
  for (const item of items) {
    view.setUint32(at, item.length, true);
    frame.set(item, at + 4);
    at += 4 + item.length;
  }
  return frame;
}

function digests(...cells: [mean: number, weight: number][][]): TDigestChunk {
  return digestChunkFromVlen(
    decodeVlenChunk(
      vlenFrame(
        cells.map(
          (cell) => new Uint8Array(new Float32Array(cell.flat()).buffer)
        )
      )
    )
  );
}

describe("decodeVlenChunk", () => {
  it("reads the item count, then a length and a payload per item", () => {
    const chunk = decodeVlenChunk(
      vlenFrame([Uint8Array.of(1, 2, 3), new Uint8Array(), Uint8Array.of(4)])
    );
    expect([...chunk.offsets]).toEqual([0, 3, 3, 4]);
    expect([...chunk.bytes]).toEqual([1, 2, 3, 4]);
  });

  it("reads a frame that does not start at its buffer's first byte", () => {
    const frame = vlenFrame([Uint8Array.of(7, 8)]);
    const padded = new Uint8Array(frame.length + 3);
    padded.set(frame, 3);
    expect([...decodeVlenChunk(padded.subarray(3)).bytes]).toEqual([7, 8]);
  });

  it("refuses a truncated chunk and one with trailing bytes", () => {
    const frame = vlenFrame([Uint8Array.of(1, 2, 3)]);
    expect(() => decodeVlenChunk(frame.subarray(0, 2))).toThrow(/shorter/);
    expect(() => decodeVlenChunk(frame.subarray(0, 9))).toThrow(/past/);
    expect(() => decodeVlenChunk(Uint8Array.of(...frame, 0))).toThrow(
      /after its last item/
    );
  });
});

describe("digestChunkFromVlen", () => {
  it("splits float32 (mean, weight) pairs per cell", () => {
    const chunk = digests(
      [
        [1.5, 2],
        [3, 4],
      ],
      [],
      [[-7, 1]]
    );
    expect([...chunk.offsets]).toEqual([0, 2, 2, 3]);
    expect([...chunk.means]).toEqual([1.5, 3, -7]);
    expect([...chunk.weights]).toEqual([2, 4, 1]);
    expect(digestCentroidCount(chunk, 1)).toBe(0);
  });

  it("refuses a payload that is not whole pairs", () => {
    expect(() =>
      digestChunkFromVlen(decodeVlenChunk(vlenFrame([new Uint8Array(12)])))
    ).toThrow(/pairs/);
  });
});

describe("the golden chunk (zstd, vlen-bytes) against zagg", () => {
  it("decodes every cell with its centroids and weight", async () => {
    const chunk = await goldenChunk();
    expect(chunk.offsets.length - 1).toBe(golden.cells.length);
    for (const [cell, expected] of golden.cells.entries()) {
      expect(digestCentroidCount(chunk, cell)).toBe(expected.centroids);
      expect(digestWeight(chunk, cell)).toBe(expected.weight);
    }
  });

  it("gives zagg's quantile_from_tdigest", async () => {
    const chunk = await goldenChunk();
    for (const [cell, expected] of golden.cells.entries()) {
      for (const [index, q] of golden.qs.entries()) {
        const value = digestQuantile(chunk, cell, q);
        const want = expected.quantiles[index];
        if (want === null) {
          expect(value).toBeNaN();
        } else {
          expect(value).toBeCloseTo(want, 9);
        }
      }
    }
  });

  it("gives zagg's cdf_from_tdigest", async () => {
    const chunk = await goldenChunk();
    for (const [cell, expected] of golden.cells.entries()) {
      const weights = digestCumulativeWeight(chunk, cell, expected.cdfX);
      for (const [index, want] of expected.cdf.entries()) {
        expect(weights[index]).toBeCloseTo(want, 6);
      }
    }
  });
});

describe("quantiles", () => {
  const chunk = digests(
    [],
    [[10, 1]],
    [
      [0, 5],
      [10, 5],
    ]
  );

  it("are NaN for a cell without data, never 0", () => {
    expect(digestQuantile(chunk, 0, 0.5)).toBeNaN();
    expect(digestQuantileRange(chunk, 0, 0.02, 0.98)).toBeNaN();
    expect(digestWeight(chunk, 0)).toBe(0);
    expect([...digestCumulativeWeight(chunk, 0, [1, 2])]).toEqual([NaN, NaN]);
    expect(digestSeries(chunk, 0, 0, 1, 8)).toBeUndefined();
  });

  it("are the mean of a single centroid", () => {
    expect(digestQuantile(chunk, 1, 0)).toBe(10);
    expect(digestQuantile(chunk, 1, 1)).toBe(10);
    expect(digestQuantileRange(chunk, 1, 0.02, 0.98)).toBe(0);
  });

  it("grow with q, and the range is their difference", () => {
    const low = digestQuantile(chunk, 2, 0.1);
    const high = digestQuantile(chunk, 2, 0.9);
    expect(low).toBeLessThan(high);
    expect(digestQuantileRange(chunk, 2, 0.1, 0.9)).toBe(high - low);
  });
});

describe("digestSeries", () => {
  it("is a cdf from 0 to 1 whose density integrates to the cdf", () => {
    const chunk = digests([
      [0, 2],
      [4, 2],
      [10, 4],
    ]);
    const series = digestSeries(chunk, 0, -1, 11, 25)!;
    expect(series.x[0]).toBe(-1);
    expect(series.x[24]).toBe(11);
    expect(series.cdf[0]).toBe(0);
    expect(series.cdf[24]).toBe(1);
    const step = series.x[1] - series.x[0];
    let area = 0;
    for (const [index, density] of series.density.entries()) {
      expect(density).toBeGreaterThanOrEqual(0);
      area += density * step;
      expect(area).toBeCloseTo(series.cdf[index + 1], 5);
    }
  });
});
