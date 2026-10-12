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
 * The 2nd and 98th percentiles of the finite heights within `radius`
 * (scene units, a chord) of `centre` on the unit sphere, over chunks of
 * points kept relative to their origins: the datum and the relief around
 * the pivot. Percentiles, as for the colour range, so that a stray return
 * far below the ground or high in the air moves neither. The radius is the
 * view's own size, so the datum floats on the view's lowest heights
 * whichever way the camera looks: a tilted view sees far, and the far
 * ground must not pull the datum from under the cloud. Undefined without
 * a finite height within reach.
 */
export function neighbourhoodRange(
  chunks: {
    origin: [number, number, number];
    offsets: Float32Array;
    heights: ArrayLike<number>;
  }[],
  centre: [number, number, number],
  radius: number,
  percentiles = POINT_RANGE_PERCENTILES,
  cap = POINT_RANGE_SAMPLE
): { low: number; high: number } | undefined {
  let total = 0;
  for (const { heights } of chunks) {
    total += heights.length;
  }
  const near = new Float32Array(total);
  let kept = 0;
  const reach = radius * radius;
  for (const { origin, offsets, heights } of chunks) {
    const dx = origin[0] - centre[0];
    const dy = origin[1] - centre[1];
    const dz = origin[2] - centre[2];
    for (let i = 0; i < heights.length; i++) {
      const x = offsets[3 * i] + dx;
      const y = offsets[3 * i + 1] + dy;
      const z = offsets[3 * i + 2] + dz;
      if (x * x + y * y + z * z <= reach) {
        near[kept++] = heights[i];
      }
    }
  }
  const range = pointRange([near.subarray(0, kept)], percentiles, cap);
  return range && { low: range.low, high: range.high };
}
