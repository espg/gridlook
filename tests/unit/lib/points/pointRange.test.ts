import { describe, expect, it } from "vitest";

import {
  neighbourhoodRange,
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

describe("neighbourhoodRange", () => {
  it("is the range of the finite heights within reach of the centre", () => {
    // three points a metre apart along x from the origin, two chunks
    const origin: [number, number, number] = [1, 0, 0];
    const metre = 1 / 6378137;
    const near = {
      origin,
      offsets: new Float32Array([0, 0, 0, metre, 0, 0, 2 * metre, 0, 0]),
      heights: new Float32Array([320.5, NaN, 318.75]),
    };
    const far = {
      origin: [1, 10 * metre, 0] as [number, number, number],
      offsets: new Float32Array([0, 0, 0]),
      heights: new Float32Array([100]),
    };
    expect(neighbourhoodRange([near, far], origin, 2.5 * metre)).toEqual({
      low: 318.75,
      high: 320.5,
    });
    // the far point pulls the datum down only once it is within reach
    expect(neighbourhoodRange([near, far], origin, 11 * metre)).toEqual({
      low: 100,
      high: 320.5,
    });
    expect(neighbourhoodRange([near, far], origin, 0.5 * metre)).toEqual({
      low: 320.5,
      high: 320.5,
    });
    expect(neighbourhoodRange([far], origin, metre)).toBeUndefined();
    expect(neighbourhoodRange([], origin, metre)).toBeUndefined();
  });

  it("is not moved by a stray return below the ground or in the air", () => {
    const origin: [number, number, number] = [1, 0, 0];
    const heights = Float32Array.from({ length: 1002 }, (_, i) =>
      i < 1000 ? 300 + (200 * i) / 999 : i === 1000 ? -300 : 2000
    );
    const chunk = {
      origin,
      offsets: new Float32Array(3 * heights.length),
      heights,
    };
    const around = neighbourhoodRange([chunk], origin, 1e-6)!;
    expect(around.low).toBeGreaterThan(300);
    expect(around.low).toBeLessThan(305);
    expect(around.high).toBeGreaterThan(495);
    expect(around.high).toBeLessThan(500);
  });
});
