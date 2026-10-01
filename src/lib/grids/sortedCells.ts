type TCellChunk = ArrayLike<number | bigint>;

/**
 * An ascending `cell` coordinate read chunk by chunk, so that a deep sparse
 * level is searched and sliced without holding its whole coordinate.
 */
// ponytail: decoded chunks are kept for as long as the reader lives. Give
// the map an LRU bound if coordinates with very many chunks get panned over.
// eslint-disable-next-line max-lines-per-function
export function createSortedCells(
  length: number,
  chunkLength: number,
  readChunk: (start: number, end: number) => Promise<TCellChunk>
) {
  const chunks = new Map<number, Promise<Float64Array>>();

  function chunk(index: number) {
    let loaded = chunks.get(index);
    if (!loaded) {
      const start = index * chunkLength;
      loaded = readChunk(start, Math.min(start + chunkLength, length)).then(
        (values) => Float64Array.from(values as ArrayLike<number>, Number)
      );
      chunks.set(index, loaded);
    }
    return loaded;
  }

  async function valueAt(index: number) {
    const values = await chunk(Math.floor(index / chunkLength));
    return values[index % chunkLength];
  }

  /** Index of the first cell with an id of at least `target`. */
  async function lowerBound(target: number) {
    let lo = 0;
    let hi = length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((await valueAt(mid)) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }

  /** The cell ids at indices `[start, end)`. */
  async function slice(start: number, end: number) {
    const cells: number[] = [];
    for (let index = start; index < end;) {
      const chunkIndex = Math.floor(index / chunkLength);
      const values = await chunk(chunkIndex);
      const stop = Math.min(end, (chunkIndex + 1) * chunkLength);
      for (; index < stop; index++) {
        cells.push(values[index % chunkLength]);
      }
    }
    return cells;
  }

  /** Whether the first and the last chunk are ascending, one after the other. */
  async function isAscending() {
    if (length === 0) {
      return true;
    }
    const first = await chunk(0);
    const last = await chunk(Math.floor((length - 1) / chunkLength));
    for (const values of [first, last]) {
      for (let index = 1; index < values.length; index++) {
        if (values[index] <= values[index - 1]) {
          return false;
        }
      }
    }
    return first[0] <= last[0];
  }

  return { lowerBound, slice, isAscending };
}
