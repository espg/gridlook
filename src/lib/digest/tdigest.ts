import type { TVlenChunk } from "./vlenChunk.ts";

/**
 * The t-digests of one chunk, flat: cell `i` owns centroids
 * `offsets[i] .. offsets[i + 1]`, ascending by mean. A cell without
 * centroids has no data. Weights are observation counts.
 */
export type TDigestChunk = {
  /** `cells + 1` centroid offsets into `means` and `weights`. */
  offsets: Uint32Array;
  means: Float32Array;
  weights: Float32Array;
};

/** A plot of one digest: `points` values from `min` to `max`. */
export type TDigestSeries = {
  x: Float32Array;
  /** Fraction of the weight at or below `x`. */
  cdf: Float32Array;
  /** Fraction of the weight per unit of `x`, between `x[i]` and `x[i + 1]`. */
  density: Float32Array;
};

const CENTROID_BYTES = 8;

/** Split a chunk of little-endian float32 `(mean, weight)` pairs. */
export function digestChunkFromVlen(chunk: TVlenChunk): TDigestChunk {
  const cells = chunk.offsets.length - 1;
  const offsets = new Uint32Array(cells + 1);
  for (let cell = 0; cell <= cells; cell++) {
    if (chunk.offsets[cell] % CENTROID_BYTES !== 0) {
      throw new Error("t-digest payload is not float32 (mean, weight) pairs");
    }
    offsets[cell] = chunk.offsets[cell] / CENTROID_BYTES;
  }
  const centroids = offsets[cells];
  const means = new Float32Array(centroids);
  const weights = new Float32Array(centroids);
  const view = new DataView(
    chunk.bytes.buffer,
    chunk.bytes.byteOffset,
    chunk.bytes.byteLength
  );
  for (let index = 0; index < centroids; index++) {
    means[index] = view.getFloat32(index * CENTROID_BYTES, true);
    weights[index] = view.getFloat32(index * CENTROID_BYTES + 4, true);
  }
  return { offsets, means, weights };
}

export function digestCentroidCount(chunk: TDigestChunk, cell: number) {
  return chunk.offsets[cell + 1] - chunk.offsets[cell];
}

/** The observations a cell's digest stands for; 0 for a cell without data. */
export function digestWeight(chunk: TDigestChunk, cell: number) {
  let total = 0;
  for (let k = chunk.offsets[cell]; k < chunk.offsets[cell + 1]; k++) {
    total += chunk.weights[k];
  }
  return total;
}

/**
 * The value at quantile `q` (0..1) of a cell's digest; NaN for a cell
 * without data. This is zagg's `quantile_from_tdigest`, branch for branch,
 * so that a value shown here is the value its Python reader gives: centroid
 * `k` spans the ranks `[upper[k-1], upper[k] - 1]`, and the target rank
 * `q (n - 1)` is interpolated between the midpoints to the neighbouring
 * means (the mean itself at either end).
 */
export function digestQuantile(chunk: TDigestChunk, cell: number, q: number) {
  const start = chunk.offsets[cell];
  const end = chunk.offsets[cell + 1];
  if (start === end) {
    return NaN;
  }
  const { means, weights } = chunk;
  const target = q * (digestWeight(chunk, cell) - 1);
  let lo = 0;
  for (let k = start; k < end; k++) {
    const upper = lo + weights[k];
    const hi = upper - 1;
    if (target <= hi) {
      if (hi <= lo) {
        return means[k];
      }
      const loValue = k === start ? means[k] : (means[k - 1] + means[k]) / 2;
      const hiValue = k === end - 1 ? means[k] : (means[k] + means[k + 1]) / 2;
      return loValue + ((target - lo) / (hi - lo)) * (hiValue - loValue);
    }
    lo = upper;
  }
  return means[end - 1];
}

/** `quantile(qHigh) - quantile(qLow)`; NaN for a cell without data. */
export function digestQuantileRange(
  chunk: TDigestChunk,
  cell: number,
  qLow: number,
  qHigh: number
) {
  return digestQuantile(chunk, cell, qHigh) - digestQuantile(chunk, cell, qLow);
}

/**
 * The weight at or below each of `xs` (ascending), zagg's
 * `cdf_from_tdigest`: every centroid sits at the middle of its weight, the
 * weight is linear in value between two means and flat outside them (0
 * below the first mean, the total above the last). NaN for a cell without
 * data.
 */
export function digestCumulativeWeight(
  chunk: TDigestChunk,
  cell: number,
  xs: ArrayLike<number>
) {
  const out = new Float64Array(xs.length);
  const start = chunk.offsets[cell];
  const end = chunk.offsets[cell + 1];
  if (start === end) {
    return out.fill(NaN);
  }
  const { means, weights } = chunk;
  const total = digestWeight(chunk, cell);
  if (end - start === 1) {
    for (let i = 0; i < xs.length; i++) {
      out[i] = xs[i] >= means[start] ? total : 0;
    }
    return out;
  }
  // `k` is the first centroid with a mean above x; `below` the weight under
  // centroid `k - 1`.
  let k = start;
  let below = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    while (k < end && means[k] <= x) {
      if (k > start) {
        below += weights[k - 1];
      }
      k++;
    }
    if (k === start) {
      out[i] = 0;
    } else if (k === end) {
      out[i] = x > means[end - 1] ? total : total - weights[end - 1] / 2;
    } else {
      const left = below + weights[k - 1] / 2;
      const right = below + weights[k - 1] + weights[k] / 2;
      out[i] =
        left +
        ((x - means[k - 1]) / (means[k] - means[k - 1])) * (right - left);
    }
  }
  return out;
}

/**
 * A cell's distribution over `points` evenly spaced values from `min` to
 * `max`, as fractions of its weight; undefined for a cell without data.
 */
export function digestSeries(
  chunk: TDigestChunk,
  cell: number,
  min: number,
  max: number,
  points: number
): TDigestSeries | undefined {
  const total = digestWeight(chunk, cell);
  if (!(total > 0) || !(max > min) || points < 2) {
    return undefined;
  }
  const step = (max - min) / (points - 1);
  const x = Float32Array.from({ length: points }, (_, i) => min + i * step);
  const cumulative = digestCumulativeWeight(chunk, cell, x);
  const cdf = Float32Array.from(cumulative, (weight) => weight / total);
  const density = new Float32Array(points - 1);
  for (let i = 0; i < points - 1; i++) {
    density[i] = (cumulative[i + 1] - cumulative[i]) / total / step;
  }
  return { x, cdf, density };
}
