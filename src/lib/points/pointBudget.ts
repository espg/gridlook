/**
 * What one window of the point tier may cost, and how it is cut down to
 * that (gridlook#21). Every number here is a tunable in one place.
 *
 * A window is the leaf chunks under the view plus a margin, the same chunks
 * a derived level reads (so a view that just left the finest level reuses
 * them). A chunk decodes whole, so bytes are only ever saved by the window;
 * points are saved by decimation, which is uniform over every chunk so the
 * cloud thins evenly and nothing is favoured by place.
 */

/** Points drawn at most, over the whole window. */
export const OBSERVATION_POINT_BUDGET = 300_000;

/** The points' opacity slider: its ends and step (the default is 1). */
export const POINT_OPACITY_RANGE = { min: 0.05, max: 1, step: 0.05 } as const;

/** The vertical exaggeration slider: its ends and step (the default is 1). */
export const POINT_EXAGGERATION_RANGE = { min: 1, max: 20, step: 1 } as const;

/**
 * Bytes one window may fetch at most. Over it, the window is cut down
 * around the point below the camera, as a level picked by hand is.
 */
export const OBSERVATION_FETCH_CAP = 24 * 2 ** 20;

/**
 * Bytes one leaf chunk costs the tier, at the California median: 34 KB of
 * signal digest and 40 KB of locations. The window is priced by this
 * before anything is read; a dense chunk runs about 1.7× it.
 */
export const OBSERVATION_CHUNK_BYTES = 74 * 1024;

/**
 * A window reaches this fraction of the view's size past every edge: the
 * margin a derived level's window has, so both read the same chunks.
 */
export const OBSERVATION_MARGIN = 0.5;

/** Leaf chunks one window holds at most under the fetch cap. */
export function maxWindowChunks(
  cap = OBSERVATION_FETCH_CAP,
  chunkBytes = OBSERVATION_CHUNK_BYTES
) {
  return Math.max(1, Math.floor(cap / chunkBytes));
}

/**
 * Every k-th point is drawn, with k the smallest stride that brings
 * `points` over `chunks` chunks within the budget: each chunk keeps
 * `ceil(n / k)` of its `n` points, so the drawn total is at most
 * `points / k + chunks`. 1 while the window fits as it is.
 */
export function decimationStride(
  points: number,
  chunks: number,
  budget = OBSERVATION_POINT_BUDGET
) {
  if (points <= budget) {
    return 1;
  }
  return Math.max(1, Math.ceil(points / Math.max(budget - chunks, 1)));
}

/** Points a chunk of `count` keeps at `stride`. */
export function decimatedCount(count: number, stride: number) {
  return Math.ceil(count / stride);
}

/**
 * Every `stride`-th group of `components` values, from the first: the
 * same array when nothing is dropped.
 */
export function decimate(
  values: Float32Array,
  stride: number,
  components = 1
): Float32Array {
  if (stride <= 1) {
    return values;
  }
  const count = decimatedCount(values.length / components, stride);
  const out = new Float32Array(count * components);
  for (let i = 0; i < count; i++) {
    const from = i * stride * components;
    for (let c = 0; c < components; c++) {
      out[i * components + c] = values[from + c];
    }
  }
  return out;
}
