import { createDigestReader, type TDigestReader } from "./digestReader.ts";
import { DIGEST_PRODUCTS, type TDigestVariable } from "./digestVariables.ts";
import {
  digestQuantile,
  digestQuantileRange,
  type TDigestChunk,
} from "./tdigest.ts";

import { createHiveStore, isHiveStorePath } from "@/lib/data/hiveStore.ts";
import { parseStorePath } from "@/lib/data/icechunkStore.ts";

/** The percentiles (0..100) the derived variables are computed at. */
export type TDigestParams = {
  percentile: number;
  low: number;
  high: number;
};

/** One cell of a level: where its digest is. */
export type TDigestCell = {
  chunk: TDigestChunk;
  /** The cell's index in the chunk. */
  cell: number;
};

/** A derived variable's value for one cell; NaN for a cell without data. */
export function digestValue(
  variable: Pick<TDigestVariable, "product">,
  params: TDigestParams,
  chunk: TDigestChunk,
  cell: number
) {
  return variable.product === DIGEST_PRODUCTS.RANGE
    ? digestQuantileRange(chunk, cell, params.low / 100, params.high / 100)
    : digestQuantile(chunk, cell, params.percentile / 100);
}

/**
 * A derived variable over the cells `start .. end` of a level, as an
 * ordinary float32 field. `path` is the digest array's path in the store.
 * Chunks already decoded are not read again, whatever the percentiles.
 */
export async function digestField(
  reader: TDigestReader,
  path: string,
  variable: Pick<TDigestVariable, "product">,
  params: TDigestParams,
  start: number,
  end: number
) {
  const out = new Float32Array(Math.max(end - start, 0)).fill(NaN);
  if (out.length === 0) {
    return out;
  }
  const { chunkCells } = await reader.array(path);
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
    const origin = (first + index) * chunkCells;
    const from = Math.max(start, origin);
    const to = Math.min(end, origin + chunk.offsets.length - 1);
    for (let cell = from; cell < to; cell++) {
      out[cell - start] = digestValue(variable, params, chunk, cell - origin);
    }
  }
  return out;
}

/**
 * The digest of one cell of a level. With `cachedOnly`, nothing is read:
 * undefined when the cell's chunk is not in memory. Null where the store
 * has no chunk.
 */
export async function digestCell(
  reader: TDigestReader,
  path: string,
  cell: number,
  cachedOnly = false
): Promise<TDigestCell | null | undefined> {
  const { chunkCells } = await reader.array(path);
  const index = Math.floor(cell / chunkCells);
  const chunk = cachedOnly
    ? reader.peek(path, index)
    : await reader.chunk(path, index);
  return chunk && { chunk, cell: cell - index * chunkCells };
}

let current: { store: string; reader: Promise<TDigestReader> } | undefined;

/**
 * The digest reader of a store, one at a time (the decoded chunks of the
 * previous store are let go). Only a hive store serves ragged chunks.
 */
export function digestReaderFor(storePath: string) {
  if (!isHiveStorePath(storePath)) {
    return undefined;
  }
  if (current?.store !== storePath) {
    current = {
      store: storePath,
      reader: createHiveStore(parseStorePath(storePath).url).then((store) =>
        createDigestReader(store)
      ),
    };
  }
  return current.reader;
}
