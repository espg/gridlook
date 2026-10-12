import { describe, expect, it } from "vitest";

import {
  lowestValue,
  POINT_RANGE_PERCENTILES,
  POINT_RANGE_SAMPLE,
  pointRange,
} from "@/lib/points/pointRange.ts";

describe("pointRange", () => {
  it("spans the 2nd to the 98th percentile of the heights, over every chunk", () => {
    // 0..999 split unevenly over three chunks, shuffled within each
    const values = Array.from({ length: 1000 }, (_, i) => i);
    const chunks = [values.slice(0, 7), values.slice(7, 640), values.slice(640)]
      .map((chunk) => chunk.sort(() => Math.sin(chunk.length * 7919) - 0.5))
      .map((chunk) => Float32Array.from(chunk));
    const range = pointRange(chunks)!;
    expect(POINT_RANGE_PERCENTILES).toEqual([2, 98]);
    expect(range.low).toBe(20);
    expect(range.high).toBe(979);
    expect(range.sample.length).toBe(1000);
    expect(range.sample[0]).toBe(0);
    expect(range.sample[999]).toBe(999);
  });

  it("reads every k-th height when the drawn total is over the cap", () => {
    const chunks = [
      Float32Array.from({ length: 1000 }, (_, i) => i),
      Float32Array.from({ length: 1000 }, (_, i) => 1000 + i),
    ];
    const range = pointRange(chunks, POINT_RANGE_PERCENTILES, 300)!;
    // stride 7 over both chunks as one sequence: 0, 7, ..., 1995
    expect(range.sample.length).toBe(Math.ceil(2000 / 7));
    expect(range.sample[0]).toBe(0);
    expect(range.sample[1]).toBe(7);
    expect(range.sample[range.sample.length - 1]).toBe(1995);
    // the nearest ranks of 2% and 98% of the 286 sampled: 6 and 279
    expect(range.low).toBe(42);
    expect(range.high).toBe(1953);
    expect(POINT_RANGE_SAMPLE).toBe(65536);
  });

  it("skips what is not a height and gives nothing without one", () => {
    expect(pointRange([])).toBeUndefined();
    expect(pointRange([new Float32Array([NaN, Infinity])])).toBeUndefined();
    const range = pointRange([new Float32Array([NaN, 3, 1, 2])])!;
    expect(Array.from(range.sample)).toEqual([1, 2, 3]);
    expect(range.low).toBe(1);
    expect(range.high).toBe(3);
  });
});

describe("lowestValue", () => {
  it("is the lowest finite value over every chunk, the datum", () => {
    expect(
      lowestValue([
        new Float32Array([NaN, 320.5, 400]),
        new Float32Array([318.75, -Infinity, 500]),
      ])
    ).toBe(318.75);
    expect(lowestValue([])).toBeUndefined();
    expect(lowestValue([new Float32Array([NaN])])).toBeUndefined();
  });
});
