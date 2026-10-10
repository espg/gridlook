import {
  chunkBytes,
  createByteLru,
  type TDenseReader,
  type TDigestReader,
  type TDigestSource,
} from "./digestReader.ts";
import type { TDigestChunk } from "./tdigest.ts";

/**
 * A level a store does not hold, computed from its leaves: the cells of an
 * order between the leaf chunk's (one chunk of `/19` is one order-13 cell)
 * and the leaves'. Leaf cells are stored in nested order, so the `group =
 * 4^(leaf order − order)` leaf cells below one derived cell are neighbours
 * in the chunk, and chunk `n` of the leaves is chunk `n` of every derived
 * level: its cells `[n · c, (n + 1) · c)` with `c = leaf chunk cells / group`.
 *
 * A derived cell's digest is the pooled centroids of its leaf cells, in
 * ascending order; nothing is compressed, so below the leaves' compression
 * limit (every centroid one observation) it is the exact sample. Its count
 * is the sum of theirs.
 */

const DEFAULT_POOLED_CACHE_BYTES = 128 * 2 ** 20;

/** Leaf cells below one cell `refinement` orders up. */
export function derivedGroup(refinement: number) {
  return 4 ** refinement;
}

/** Sort the centroids `start .. end` of one cell by mean, in place. */
function sortCentroids(
  means: Float32Array,
  weights: Float32Array,
  start: number,
  end: number
) {
  let uniform = true;
  for (let k = start + 1; k < end && uniform; k++) {
    uniform = weights[k] === weights[start];
  }
  if (uniform) {
    // the usual case: every centroid is one observation
    means.subarray(start, end).sort();
    return;
  }
  const order = Uint32Array.from({ length: end - start }, (_, i) => start + i);
  order.sort((a, b) => means[a] - means[b]);
  const sortedMeans = Float32Array.from(order, (k) => means[k]);
  const sortedWeights = Float32Array.from(order, (k) => weights[k]);
  means.set(sortedMeans, start);
  weights.set(sortedWeights, start);
}

/**
 * The digests of a leaf chunk pooled `group` cells at a time. The pooled
 * centroids of a derived cell are a run of the leaf chunk's, so only their
 * order changes.
 */
function poolDigestChunk(chunk: TDigestChunk, group: number): TDigestChunk {
  const cells = Math.floor((chunk.offsets.length - 1) / group);
  const offsets = new Uint32Array(cells + 1);
  const means = chunk.means.slice();
  const weights = chunk.weights.slice();
  for (let cell = 0; cell < cells; cell++) {
    offsets[cell + 1] = chunk.offsets[(cell + 1) * group];
    sortCentroids(means, weights, offsets[cell], offsets[cell + 1]);
  }
  return { offsets, means, weights };
}

/** A leaf chunk's values summed `group` cells at a time. */
function sumChunk(values: ArrayLike<number>, group: number) {
  const out = new Float32Array(Math.floor(values.length / group));
  for (let cell = 0; cell < out.length; cell++) {
    let total = 0;
    for (let k = cell * group; k < (cell + 1) * group; k++) {
      total += values[k];
    }
    out[cell] = total;
  }
  return out;
}

/**
 * The digests of the levels derived from a reader's arrays. `at(group)`
 * reads like the reader, with every chunk pooled `group` cells at a time:
 * `path` stays the leaf array's. Pooled chunks are kept, bounded by bytes;
 * one that was let go is pooled again from the leaf chunk in memory, so a
 * change of order reads nothing.
 */
export function createPooledDigests(
  reader: TDigestReader,
  maxBytes = DEFAULT_POOLED_CACHE_BYTES
) {
  const cache = createByteLru<TDigestChunk>(maxBytes, chunkBytes);

  function pooled(
    leaf: TDigestChunk | null | undefined,
    key: string,
    group: number
  ) {
    if (!leaf) {
      return leaf;
    }
    let chunk = cache.get(key);
    if (!chunk) {
      chunk = poolDigestChunk(leaf, group);
      cache.set(key, chunk);
    }
    return chunk;
  }

  function at(group: number): TDigestSource {
    if (group === 1) {
      return reader;
    }
    const key = (path: string, index: number, row: number) =>
      `${path}/${group}/${row}/${index}`;
    return {
      async array(path) {
        const leaf = await reader.array(path);
        return {
          ...leaf,
          cells: leaf.cells / group,
          chunkCells: leaf.chunkCells / group,
        };
      },
      chunk: async (path, index, row = 0) =>
        pooled(
          await reader.chunk(path, index, row),
          key(path, index, row),
          group
        ) ?? null,
      peek: (path, index, row = 0) =>
        pooled(reader.peek(path, index, row), key(path, index, row), group),
    };
  }

  return { at };
}

/**
 * A summed variable (a count) over the cells `start .. end` of a derived
 * level, from the leaf array at `path`: the sum of each cell's leaf cells,
 * NaN where the store has no chunk.
 */
export async function summedField(
  reader: TDenseReader,
  path: string,
  group: number,
  start: number,
  end: number
) {
  const out = new Float32Array(Math.max(end - start, 0)).fill(NaN);
  if (out.length === 0) {
    return out;
  }
  const chunkCells = (await reader.array(path)).chunkCells / group;
  const first = Math.floor(start / chunkCells);
  const last = Math.floor((end - 1) / chunkCells);
  const chunks = await Promise.all(
    Array.from({ length: last - first + 1 }, (_, index) =>
      reader.chunk(path, first + index)
    )
  );
  for (const [index, chunk] of chunks.entries()) {
    if (!chunk) {
      continue;
    }
    const sums = sumChunk(chunk, group);
    const origin = (first + index) * chunkCells;
    const from = Math.max(start, origin);
    const to = Math.min(end, origin + sums.length);
    out.set(sums.subarray(from - origin, to - origin), from - start);
  }
  return out;
}
