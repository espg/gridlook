import { registry } from "zarrita";

import { digestChunkFromVlen, type TDigestChunk } from "./tdigest.ts";
import { decodeVlenChunk } from "./vlenChunk.ts";

/**
 * Reads the t-digest chunks of a ragged zarr v3 array (`data_type`
 * `variable_length_bytes`, codecs `vlen-bytes` then bytes-to-bytes codecs),
 * which zarrita cannot open. The store only has to return an encoded chunk
 * for `{array}/c/{row}/{index}` and the array's `zarr.json`; the hive store
 * does for every tier (a leaf's inner chunk included).
 *
 * Chunks are decoded on the calling thread. Every read is asynchronous and
 * hands back plain typed arrays, so the decode can move to a worker without
 * changing a caller.
 */

export type TDigestStore = {
  get(key: `/${string}`): Promise<Uint8Array | undefined>;
};

type TBytesCodec = {
  decode(bytes: Uint8Array): Promise<Uint8Array> | Uint8Array;
};
type TCodecConfig = { name: string; configuration?: Record<string, unknown> };

export type TDigestArray = {
  /** Cells of the level, and cells per chunk. */
  cells: number;
  chunkCells: number;
  decode(bytes: Uint8Array): Promise<TDigestChunk>;
};

const VLEN_BYTES = "vlen-bytes";
/** Charged for a chunk that does not exist, so that it is remembered. */
const ABSENT_BYTES = 64;
const DEFAULT_DIGEST_CACHE_BYTES = 256 * 2 ** 20;

function chunkBytes(chunk: TDigestChunk | null) {
  return chunk
    ? chunk.offsets.byteLength +
        chunk.means.byteLength +
        chunk.weights.byteLength
    : ABSENT_BYTES;
}

/**
 * Least-recently-used chunks up to a number of bytes; the newest entry is
 * kept even when it alone is over the bound.
 */
export function createByteLru<T>(
  maxBytes: number,
  sizeOf: (value: T) => number
) {
  const entries = new Map<string, { value: T; bytes: number }>();
  let bytes = 0;
  return {
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      }
      return entry?.value;
    },
    has: (key: string) => entries.has(key),
    set(key: string, value: T) {
      bytes -= entries.get(key)?.bytes ?? 0;
      entries.delete(key);
      const entry = { value, bytes: sizeOf(value) };
      entries.set(key, entry);
      bytes += entry.bytes;
      for (const [oldest, old] of entries) {
        if (bytes <= maxBytes || oldest === key) {
          break;
        }
        entries.delete(oldest);
        bytes -= old.bytes;
      }
    },
    get bytes() {
      return bytes;
    },
    get size() {
      return entries.size;
    },
  };
}

/** The decoder of a ragged array, from its `zarr.json`. */
export async function digestArrayFromMetadata(
  metadata: Record<string, unknown>
): Promise<TDigestArray> {
  const codecs = (metadata.codecs ?? []) as TCodecConfig[];
  if (codecs[0]?.name !== VLEN_BYTES) {
    throw new Error(`not a ${VLEN_BYTES} array`);
  }
  // bytes-to-bytes codecs, undone last to first
  const bytesCodecs: TBytesCodec[] = [];
  for (const codec of codecs.slice(1)) {
    const entry = await registry.get(codec.name)?.();
    if (!entry) {
      throw new Error(`unknown codec ${codec.name}`);
    }
    bytesCodecs.unshift(
      (await entry.fromConfig(
        codec.configuration ?? {},
        metadata as never
      )) as TBytesCodec
    );
  }
  const shape = metadata.shape as number[];
  const grid = metadata.chunk_grid as {
    configuration: { chunk_shape: number[] };
  };
  return {
    cells: shape[shape.length - 1],
    chunkCells: grid.configuration.chunk_shape.at(-1)!,
    async decode(bytes) {
      let decoded = bytes;
      for (const codec of bytesCodecs) {
        decoded = await codec.decode(decoded);
      }
      return digestChunkFromVlen(decodeVlenChunk(decoded));
    },
  };
}

export type TDigestReader = ReturnType<typeof createDigestReader>;

/**
 * A reader with a cache of decoded chunks, keyed by array path and chunk and
 * bounded by bytes. `row` is the leading (window) index of the arrays.
 */
// eslint-disable-next-line max-lines-per-function
export function createDigestReader(
  store: TDigestStore,
  maxBytes = DEFAULT_DIGEST_CACHE_BYTES
) {
  const decoder = new TextDecoder();
  const arrays = new Map<string, Promise<TDigestArray>>();
  const cache = createByteLru<TDigestChunk | null>(maxBytes, chunkBytes);
  const pending = new Map<string, Promise<TDigestChunk | null>>();

  /** `path` is the array's path in the store, e.g. `8/h_tdigest_signal`. */
  function array(path: string) {
    let opened = arrays.get(path);
    if (!opened) {
      opened = store.get(`/${path}/zarr.json`).then((bytes) => {
        if (!bytes) {
          throw new Error(`no array at ${path}`);
        }
        return digestArrayFromMetadata(JSON.parse(decoder.decode(bytes)));
      });
      opened.catch(() => arrays.delete(path));
      arrays.set(path, opened);
    }
    return opened;
  }

  /** A decoded chunk already in memory; undefined when it has to be read. */
  function peek(path: string, index: number, row = 0) {
    return cache.get(`${path}/${row}/${index}`);
  }

  /** The digests of one chunk; null where the store has none. */
  function chunk(path: string, index: number, row = 0) {
    const key = `${path}/${row}/${index}`;
    if (cache.has(key)) {
      return Promise.resolve(cache.get(key) ?? null);
    }
    let reading = pending.get(key);
    if (!reading) {
      reading = (async () => {
        const [opened, bytes] = await Promise.all([
          array(path),
          store.get(`/${path}/c/${row}/${index}`),
        ]);
        const decoded = bytes ? await opened.decode(bytes) : null;
        cache.set(key, decoded);
        return decoded;
      })().finally(() => pending.delete(key));
      pending.set(key, reading);
    }
    return reading;
  }

  return {
    array,
    chunk,
    peek,
    get cachedBytes() {
      return cache.bytes;
    },
  };
}
