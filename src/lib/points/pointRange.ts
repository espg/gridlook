/**
 * The colour range of the point tier (gridlook#21): the drawn heights'
 * 2nd and 98th percentiles, so a few outliers do not flatten the cloud's
 * colours, taken over a uniform sample of the drawn points so that a
 * window of the full budget is priced in milliseconds.
 */

/** The percentiles the range spans, in order. */
export const POINT_RANGE_PERCENTILES: readonly [number, number] = [2, 98];
/** Heights sampled at most, every k-th of the drawn. */
export const POINT_RANGE_SAMPLE = 2 ** 16;

export type TPointRange = {
  low: number;
  high: number;
  /** The sample the range was read from, sorted. */
  sample: Float32Array;
};

/** `value` of a sorted sample at a percentile, by the nearest rank. */
function percentileOf(sorted: Float32Array, percentile: number) {
  const rank = Math.round(((sorted.length - 1) * percentile) / 100);
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}

/**
 * The range of `heights` (the drawn heights of each chunk) between the
 * percentiles, from every k-th value with k the smallest stride that keeps
 * the sample within `cap`; undefined without a finite height.
 */
export function pointRange(
  heights: ArrayLike<number>[],
  percentiles = POINT_RANGE_PERCENTILES,
  cap = POINT_RANGE_SAMPLE
): TPointRange | undefined {
  let total = 0;
  for (const chunk of heights) {
    total += chunk.length;
  }
  const stride = Math.max(1, Math.ceil(total / cap));
  const sample = new Float32Array(Math.ceil(total / stride));
  let kept = 0;
  let next = 0;
  for (const chunk of heights) {
    for (; next < chunk.length; next += stride) {
      const value = chunk[next];
      if (Number.isFinite(value)) {
        sample[kept++] = value;
      }
    }
    next -= chunk.length;
  }
  if (kept === 0) {
    return undefined;
  }
  const sorted = sample.subarray(0, kept).sort();
  return {
    low: percentileOf(sorted, percentiles[0]),
    high: percentileOf(sorted, percentiles[1]),
    sample: sorted,
  };
}

/**
 * The lowest and highest finite height within `radius` (scene units, a
 * chord) of `centre` on the unit sphere, over chunks of points kept
 * relative to their origins: the datum and the relief around the pivot.
 * The radius is the view's own size, so the datum floats on the view's
 * lowest height whichever way the camera looks: a profile sees to the
 * horizon, and the far ground must not pull the datum from under the
 * cloud. Undefined without a finite height within reach.
 */
export function neighbourhoodRange(
  chunks: {
    origin: [number, number, number];
    offsets: Float32Array;
    heights: ArrayLike<number>;
  }[],
  centre: [number, number, number],
  radius: number
): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  const reach = radius * radius;
  for (const { origin, offsets, heights } of chunks) {
    const dx = origin[0] - centre[0];
    const dy = origin[1] - centre[1];
    const dz = origin[2] - centre[2];
    for (let i = 0; i < heights.length; i++) {
      const x = offsets[3 * i] + dx;
      const y = offsets[3 * i + 1] + dy;
      const z = offsets[3 * i + 2] + dz;
      if (x * x + y * y + z * z > reach) {
        continue;
      }
      const value = heights[i];
      if (Number.isFinite(value)) {
        min = value < min ? value : min;
        max = value > max ? value : max;
      }
    }
  }
  return min === Infinity ? undefined : { min, max };
}
