import type { Grid } from "healpix-geo";

import {
  blocksByDistance,
  degreesApart,
  healpixBlockRanges,
} from "./healpixWindow.ts";

import type { TAxisRange } from "@/lib/data/viewWindow.ts";

/**
 * A run of cells of a view window read in one go, on one face, and the
 * centre of its nearest block (degrees): where it sits, to re-rank it against
 * a camera that has moved since the window was built.
 */
export type TBlockRange = TAxisRange & {
  face: number;
  lon: number;
  lat: number;
};

/** The cells of a range as read: their values and their ids. */
export type TRangeCells = { data: Float32Array; cells: number[] };

/**
 * Reads in flight at once over HTTP/1.1: a little over the ~6 connections a
 * browser opens to one host, so that its queue never runs dry while the
 * order (and `rank`) is kept.
 */
const FETCH_CONCURRENCY_HTTP1 = 8;

/**
 * Reads in flight at once over a multiplexed connection (HTTP/2, HTTP/3),
 * which has no per-host connection limit: a zoom on a zagg v4 store over
 * HTTP/3 spent 79% of its fetch time pinned at 8 in flight with ~150 ms to
 * first byte and the CPU idle, so the cap, not the network, was the limit.
 */
const FETCH_CONCURRENCY_MULTIPLEXED = 32;

/** A positive integer `::<name>=<n>` of the page hash, if any. */
function hashNumber(hash: string, name: string): number | undefined {
  const match = new RegExp(`(?:^|::)${name}=(\\d+)(?:::|$)`).exec(
    hash.replace(/^#/, "")
  );
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** `::fetch=<n>` in the page hash overrides the cap (to compare 32 and 64). */
export function fetchOverride(hash: string): number | undefined {
  return hashNumber(hash, "fetch");
}

/**
 * Chunks one window range may span (`::chunks=<n>`, default 1). Spans are
 * aligned groups of `n` neighbouring chunks, so the chunk reads of a range
 * start together and the store's range coalescer can serve the inner chunks
 * of one shard object in one request; a span past an object boundary still
 * costs one request per object.
 */
export function rangeChunks(hash: string): number {
  return hashNumber(hash, "chunks") ?? 1;
}

function pageHash() {
  return typeof location === "undefined" ? "" : location.hash;
}

/** The cap for a protocol (`nextHopProtocol`): 8 on HTTP/1.x, 32 otherwise. */
export function concurrencyFor(protocol?: string, override?: number) {
  if (override !== undefined) {
    return override;
  }
  return /^http\/1/.test(protocol ?? "")
    ? FETCH_CONCURRENCY_HTTP1
    : FETCH_CONCURRENCY_MULTIPLEXED;
}

/**
 * The cap now: the hash override, else by the protocol of the page's latest
 * fetch response (every data read is one; unknown counts as multiplexed).
 */
export function fetchConcurrency() {
  const hash = pageHash();
  const entries =
    typeof performance === "undefined" || !performance.getEntriesByType
      ? []
      : (performance.getEntriesByType(
          "resource"
        ) as PerformanceResourceTiming[]);
  const latest = entries
    .filter((entry) => entry.initiatorType === "fetch")
    .at(-1);
  return concurrencyFor(latest?.nextHopProtocol, fetchOverride(hash));
}

/**
 * The cell ranges of a window's blocks, the nearest to a point first. A
 * range is a run of neighbouring blocks within one chunk, placed by its
 * nearest block; read in this order, the cells under the camera land first.
 */
export function orderedBlockRanges(
  blockGrid: Grid,
  blocks: number[],
  cellsPerBlock: number,
  chunkCells: number,
  lon: number,
  lat: number
): TBlockRange[] {
  const rank = new Map(
    blocksByDistance(blockGrid, blocks, lon, lat).map((block, index) => [
      block,
      index,
    ])
  );
  const faceBlocks = 4 ** blockGrid.level;
  const ascending = [...blocks].sort((a, b) => a - b);
  const placed = healpixBlockRanges(
    ascending,
    cellsPerBlock,
    chunkCells * rangeChunks(pageHash())
  )
    .map((range) => {
      const first = range.start / cellsPerBlock;
      let [nearest, nearestBlock] = [Infinity, first];
      for (let block = first; block < range.end / cellsPerBlock; block++) {
        if (rank.get(block)! < nearest) {
          [nearest, nearestBlock] = [rank.get(block)!, block];
        }
      }
      return {
        range,
        face: Math.floor(first / faceBlocks),
        nearest,
        nearestBlock,
      };
    })
    .sort((a, b) => a.nearest - b.nearest);
  const centres = blockGrid.healpixToLonLat(
    BigUint64Array.from(placed, ({ nearestBlock }) => BigInt(nearestBlock))
  );
  return placed.map(({ range, face }, index) => ({
    ...range,
    face,
    lon: centres[2 * index],
    lat: centres[2 * index + 1],
  }));
}

/**
 * The rank of a block range against a camera centre (lower is read sooner):
 * its nearest block's great-circle distance from the point, in degrees.
 */
export function rangeDistance(
  range: TBlockRange,
  centre: { centreLon: number; centreLat: number }
) {
  return degreesApart(range.lon, range.lat, centre.centreLon, centre.centreLat);
}

/** How `fetchInOrder` paces and orders its fetches. */
type TFetchOptions<TItem> = {
  concurrency?: number;
  isCurrent?: () => boolean;
  rank?: (item: TItem) => number;
};

/** Remove and return the next item: the first, or the one `rank` puts lowest now. */
function takeNext<TItem>(
  remaining: TItem[],
  rank?: (item: TItem) => number
): TItem {
  if (!rank || remaining.length === 1) {
    return remaining.shift()!;
  }
  let [best, bestRank] = [0, rank(remaining[0])];
  for (let index = 1; index < remaining.length; index++) {
    const value = rank(remaining[index]);
    if (value < bestRank) {
      [best, bestRank] = [index, value];
    }
  }
  return remaining.splice(best, 1)[0];
}

/** Items still to start, handed out first-first or lowest-`rank`-now first. */
function rankedQueue<TItem>(items: TItem[], rank?: (item: TItem) => number) {
  const remaining = [...items];
  return {
    size: () => remaining.length,
    take: () => takeNext(remaining, rank),
  };
}

/**
 * Fetch `items` in order, at most `concurrency` at a time, and hand each
 * result over as it lands, in the order they land. `next` resolves with
 * undefined once nothing more will land; a fetch that fails makes it
 * throw. Once `isCurrent` is false nothing more is started.
 *
 * With `rank`, the order is re-taken every time a slot frees: the next item
 * started is the one `rank` puts lowest NOW, not where it sat when the list
 * was built. A window read ranks by distance from the current camera, so
 * the cells still to read follow a pan instead of finishing around where
 * the camera used to be. Nothing already in flight is abandoned.
 */
export function fetchInOrder<TItem, TResult>(
  items: TItem[],
  fetch: (item: TItem) => Promise<TResult>,
  options: TFetchOptions<TItem> = {}
) {
  const { concurrency = fetchConcurrency(), isCurrent = () => true } = options;
  const landed: { item: TItem; result: TResult }[] = [];
  let failure: { error: unknown } | undefined;
  const queue = rankedQueue(items, options.rank);
  let [inFlight, wake]: [number, (() => void) | undefined] = [0, undefined];
  async function run(item: TItem) {
    inFlight++;
    try {
      landed.push({ item, result: await fetch(item) });
    } catch (error) {
      failure ??= { error };
    } finally {
      inFlight--;
      start();
      wake?.();
      wake = undefined;
    }
  }
  function start() {
    while (
      inFlight < concurrency &&
      queue.size() > 0 &&
      !failure &&
      isCurrent()
    ) {
      void run(queue.take());
    }
  }
  start();

  async function next() {
    for (;;) {
      if (landed.length > 0) {
        return landed.shift();
      }
      if (failure) {
        throw failure.error;
      }
      if (inFlight === 0 && (queue.size() === 0 || !isCurrent())) {
        return undefined;
      }
      await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { next };
}

/** A run of cells of a face as read: its range, its values and their ids. */
export type TFacePart = { range: TAxisRange } & TRangeCells;

/**
 * The cells of one face as its ranges land, kept in ascending cell order
 * however they land: what the face is drawn from before every range is in.
 * A cell not yet landed is absent, as a cell outside the window is. `seed`
 * holds parts read before (the field kept from an earlier window).
 */
export function createFaceAssembly(seed: TFacePart[] = []) {
  const parts: TFacePart[] = [];
  let length = 0;
  const assembly = {
    add(range: TAxisRange, part: TRangeCells) {
      // the ranges are disjoint: keep them by start
      let at = parts.length;
      while (at > 0 && parts[at - 1].range.start > range.start) {
        at--;
      }
      parts.splice(at, 0, { range, data: part.data, cells: part.cells });
      length += part.data.length;
    },
    /** The parts as read, ascending: the face's field, to keep. */
    parts: () => parts.slice(),
    face(): TRangeCells & { ranges: TAxisRange[] } {
      const data = new Float32Array(length);
      const cells: number[] = [];
      for (const part of parts) {
        data.set(part.data, cells.length);
        for (const cell of part.cells) {
          cells.push(cell);
        }
      }
      return { data, cells, ranges: parts.map(({ range }) => range) };
    },
  };
  for (const part of seed) {
    assembly.add(part.range, part);
  }
  return assembly;
}

/**
 * Read every range of a face into one, ascending, a few at a time
 * (`fetchInOrder`): a face of a derived level is thousands of leaf chunks.
 * Once `isCurrent` is false nothing more is started.
 */
export async function readRanges(
  ranges: TAxisRange[],
  fetch: (range: TAxisRange) => Promise<TRangeCells>,
  isCurrent?: () => boolean
) {
  const assembly = createFaceAssembly();
  const landings = fetchInOrder(ranges, fetch, { isCurrent });
  for (let landing = await landings.next(); landing;) {
    assembly.add(landing.item, landing.result);
    landing = await landings.next();
  }
  return assembly.face();
}

/** The parts of a window's faces, by face: the field as read. */
export type TFaceParts = Map<number, TFacePart[]>;

/** A face loaded by view is redrawn with what has landed this often at most. */
const PROGRESSIVE_DRAW_MS = 150;

/** A window's reads in flight, and the faces assembled from what landed. */
export type TWindowRead = {
  landings: ReturnType<typeof fetchInOrder<TBlockRange, TRangeCells>>;
  assemblies: Map<number, ReturnType<typeof createFaceAssembly>>;
  /** Ranges still to land on each face. */
  pending: Map<number, number>;
};

/** The reads of a window's ranges, with the parts of `seed` already in. */
export function createWindowRead(
  landings: TWindowRead["landings"],
  ranges: TBlockRange[],
  seed: TFaceParts = new Map()
): TWindowRead {
  const pending = new Map<number, number>();
  for (const { face } of ranges) {
    pending.set(face, (pending.get(face) ?? 0) + 1);
  }
  const assemblies = new Map(
    [...seed].map(([face, parts]) => [face, createFaceAssembly(parts)])
  );
  return { landings, assemblies, pending };
}

/**
 * The cells of one face of the window, drawn with what has landed every
 * `PROGRESSIVE_DRAW_MS` until the whole face is in (not at all without
 * `draw`). Ranges of other faces that land meanwhile wait in their
 * assemblies for their turn.
 */
export async function readFaceProgressively(
  faceIndex: number,
  read: TWindowRead,
  draw:
    | ((face: TRangeCells & { ranges: TAxisRange[] }) => Promise<void>)
    | undefined,
  isCurrent: () => boolean
) {
  const assemblyOf = (face: number) => {
    let assembly = read.assemblies.get(face);
    if (!assembly) {
      assembly = createFaceAssembly();
      read.assemblies.set(face, assembly);
    }
    return assembly;
  };
  const assembly = assemblyOf(faceIndex);
  let drawnAt = Date.now();
  while ((read.pending.get(faceIndex) ?? 0) > 0) {
    const landing = await read.landings.next();
    if (!landing) {
      break;
    }
    const { face } = landing.item;
    assemblyOf(face).add(landing.item, landing.result);
    read.pending.set(face, read.pending.get(face)! - 1);
    if (
      draw &&
      face === faceIndex &&
      read.pending.get(faceIndex)! > 0 &&
      Date.now() - drawnAt >= PROGRESSIVE_DRAW_MS &&
      isCurrent()
    ) {
      await draw(assembly.face());
      drawnAt = Date.now();
    }
  }
  return assembly.face();
}

/**
 * Decoded bytes the block cache may hold, over every level: what a window
 * left behind costs in memory, not what it cost to fetch. Separate from
 * `DEFAULT_VIEW_BUDGET_BYTES`, which bounds one window's transfer: a digest
 * cell costs kilobytes to fetch and 12 bytes once decoded (a value and an id).
 */
export const DEFAULT_BLOCK_CACHE_BYTES = 512 * 2 ** 20;

/** Bytes a part holds in memory: its values, and its ids as numbers. */
export function partBytes(part: TRangeCells) {
  return part.data.byteLength + 8 * part.cells.length;
}

/** The first index of ascending `cells` at or past `cell`. */
function lowerBound(cells: number[], cell: number) {
  let [low, high] = [0, cells.length];
  while (low < high) {
    const middle = (low + high) >>> 1;
    [low, high] = cells[middle] < cell ? [middle + 1, high] : [low, middle];
  }
  return low;
}

/**
 * A part cut at its blocks' bounds, one part per block it covers (a range
 * is a run of whole blocks): what the cache holds, so that a block is kept
 * or let go on its own. A part of one block is handed back as it is.
 */
export function blockParts(part: TFacePart, cellsPerBlock: number) {
  const { start, end } = part.range;
  if (end - start === cellsPerBlock) {
    return [{ block: start / cellsPerBlock, part }];
  }
  const cut: { block: number; part: TFacePart }[] = [];
  for (let from = start; from < end; from += cellsPerBlock) {
    const [first, last] = [from, from + cellsPerBlock].map((cell) =>
      lowerBound(part.cells, cell)
    );
    cut.push({
      block: from / cellsPerBlock,
      part: {
        range: { start: from, end: from + cellsPerBlock },
        data: part.data.slice(first, last),
        cells: part.cells.slice(first, last),
      },
    });
  }
  return cut;
}

/** A block held by the cache: its part, its face and its centre (degrees). */
export type TCachedBlock = {
  face: number;
  part: TFacePart;
  lon: number;
  lat: number;
};

/** The blocks of a cache, by level: one field key per level. */
type TCacheLevels = Map<
  number,
  { key: string; blocks: Map<number, TCachedBlock & { bytes: number }> }
>;

/** The blocks `kept` does not protect, the farthest from a point first. */
function farthestFirst(
  levels: TCacheLevels,
  centre: { centreLon: number; centreLat: number },
  kept: (index: number, block: number) => boolean
) {
  const candidates: { index: number; block: number; distance: number }[] = [];
  for (const [index, level] of levels) {
    for (const [block, held] of level.blocks) {
      if (!kept(index, block)) {
        const distance = degreesApart(
          held.lon,
          held.lat,
          centre.centreLon,
          centre.centreLat
        );
        candidates.push({ index, block, distance });
      }
    }
  }
  return candidates.sort((a, b) => b.distance - a.distance);
}

/**
 * Decoded blocks kept across windows, by level and block, for one field key
 * per level (the variable, the indices and the digest choice): a block read
 * once is not read again while it is held. Bounded by decoded bytes; over
 * the bound, the blocks farthest from the camera go first, never those
 * `kept` protects (the windows on screen). A part handed out stays whole
 * when its block is let go: the cache only drops its reference.
 */
export function createBlockCache(maxBytes = DEFAULT_BLOCK_CACHE_BYTES) {
  const levels: TCacheLevels = new Map();
  let bytes = 0;
  const blocksOf = (index: number, key: string) => {
    const level = levels.get(index);
    return level?.key === key ? level.blocks : undefined;
  };
  function add(
    index: number,
    key: string,
    block: number,
    cached: TCachedBlock
  ) {
    let level = levels.get(index);
    if (level?.key !== key) {
      // another variable, slice or digest choice: what was held is stale
      for (const held of level?.blocks.values() ?? []) {
        bytes -= held.bytes;
      }
      level = { key, blocks: new Map() };
      levels.set(index, level);
    }
    bytes -= level.blocks.get(block)?.bytes ?? 0;
    const held = { ...cached, bytes: partBytes(cached.part) };
    level.blocks.set(block, held);
    bytes += held.bytes;
  }
  function evict(
    centre: { centreLon: number; centreLat: number },
    kept: (index: number, block: number) => boolean
  ) {
    if (bytes <= maxBytes) {
      return;
    }
    for (const { index, block } of farthestFirst(levels, centre, kept)) {
      if (bytes <= maxBytes) {
        break;
      }
      const blocks = levels.get(index)!.blocks;
      bytes -= blocks.get(block)!.bytes;
      blocks.delete(block);
    }
  }
  return {
    get: (index: number, key: string, block: number) =>
      blocksOf(index, key)?.get(block),
    add,
    evict,
    /** Decoded bytes held now. */
    bytes: () => bytes,
  };
}
