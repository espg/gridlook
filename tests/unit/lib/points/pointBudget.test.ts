import { describe, expect, it } from "vitest";

import {
  decimate,
  decimatedCount,
  decimationStride,
  maxWindowChunks,
  OBSERVATION_CHUNK_BYTES,
  OBSERVATION_FETCH_CAP,
  OBSERVATION_POINT_BUDGET,
} from "@/lib/points/pointBudget.ts";

describe("decimationStride", () => {
  it("draws everything while the window fits the budget", () => {
    expect(decimationStride(0, 0)).toBe(1);
    expect(decimationStride(OBSERVATION_POINT_BUDGET, 50)).toBe(1);
    expect(decimationStride(1000, 3, 1000)).toBe(1);
  });

  it("keeps the drawn total within the budget, chunk by chunk", () => {
    // chunks of uneven size: the per-chunk rounding up is paid for
    const counts = [6000, 1, 5999, 20000, 7, 6000, 6000, 1234];
    for (const budget of [50, 500, 5000, 20000, 45000]) {
      const total = counts.reduce((sum, n) => sum + n, 0);
      const stride = decimationStride(total, counts.length, budget);
      const drawn = counts.reduce(
        (sum, n) => sum + decimatedCount(n, stride),
        0
      );
      expect(drawn).toBeLessThanOrEqual(budget);
      // and not thinned more than one step beyond what the budget needs
      if (stride > 1) {
        const looser = counts.reduce(
          (sum, n) => sum + decimatedCount(n, stride - 1),
          0
        );
        expect(looser + counts.length).toBeGreaterThan(budget);
      }
    }
  });
});

describe("decimate", () => {
  const values = Float32Array.from({ length: 23 }, (_, i) => i);

  it("keeps every k-th value from the first, the same array for k = 1", () => {
    expect(decimate(values, 1)).toBe(values);
    expect([...decimate(values, 5)]).toEqual([0, 5, 10, 15, 20]);
    expect([...decimate(values, 23)]).toEqual([0]);
    expect([...decimate(values, 100)]).toEqual([0]);
    expect(decimate(new Float32Array(), 3).length).toBe(0);
  });

  it("keeps vector components together and is deterministic", () => {
    const xyz = Float32Array.from({ length: 30 }, (_, i) => i);
    const once = decimate(xyz, 4, 3);
    expect([...once]).toEqual([0, 1, 2, 12, 13, 14, 24, 25, 26]);
    expect([...decimate(xyz, 4, 3)]).toEqual([...once]);
    expect(once.length).toBe(3 * decimatedCount(10, 4));
  });

  it("is uniform: every stretch of the input is kept in proportion", () => {
    const many = Float32Array.from({ length: 10_000 }, (_, i) => i);
    const kept = decimate(many, 7);
    const firstHalf = kept.filter((value) => value < 5000).length;
    const secondHalf = kept.length - firstHalf;
    expect(Math.abs(firstHalf - secondHalf)).toBeLessThanOrEqual(1);
  });
});

describe("maxWindowChunks", () => {
  it("prices the window by the median chunk under the fetch cap", () => {
    expect(maxWindowChunks()).toBe(
      Math.floor(OBSERVATION_FETCH_CAP / OBSERVATION_CHUNK_BYTES)
    );
    expect(maxWindowChunks(1, 1000)).toBe(1);
  });
});
